/**
 * provisionAgent — the ATOMIC "new agent for this chat" primitive.
 *
 * One call creates everything a chat-dedicated agent needs to actually work.
 * Born from the Worksong incident (2026-06-06), where an agent existed but was
 * mute because provisioning is really six steps and every entry point (app,
 * ncl, agent-spawned) forgot a different one:
 *
 *   1. agent_groups row (Name + deduped folder slug)
 *   2. container_configs row with assistant_name = Name
 *      (else outbound messages sign as the host-default fossil)
 *   3. groups/<folder>/CLAUDE.local.md starter persona — including the
 *      "where to reply" rules (agent-spawned children otherwise reply to
 *      their parent instead of the chat)
 *   4. wiring to the messaging group, always-on (pattern '.')
 *   5. a 'chat' destination so the agent can INITIATE messages to the chat
 *      (plain replies only work for user-originated turns)
 *
 * Exposed via `ncl groups provision` so the host, the app backend, and agents
 * (e.g. Nano onboarding a new WhatsApp group) all share the same recipe.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { createAgentGroup, getAgentGroupByFolder } from './db/agent-groups.js';
import { getMessagingGroup, createMessagingGroupAgent, getMessagingGroupAgents } from './db/messaging-groups.js';
import { ensureContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { createDestination, getDestinationByTarget } from './modules/agent-to-agent/db/agent-destinations.js';
import { GROUPS_DIR } from './config.js';
import { log } from './log.js';

export interface ProvisionArgs {
  /** Display name for the agent (e.g. "Worksong"). */
  name: string;
  /** The chat this agent lives in — messaging_groups.id. */
  messagingGroupId: string;
  /** One-line purpose; becomes the heart of the starter persona. */
  purpose?: string;
}

export interface ProvisionResult {
  agentGroupId: string;
  folder: string;
  wiringId: string;
  personaCreated: boolean;
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'agent';
}

function starterPersona(
  name: string,
  purpose: string | undefined,
  chatName: string,
  chatDest: string,
): string {
  return `# ${name}

You are ${name}, a NanoClaw agent dedicated to the "${chatName}" chat.

## Purpose
${purpose?.trim() || 'Help the owner with whatever comes up in this chat. Ask what your focus should be, then record it here.'}

## Where to reply (IMPORTANT)
Messages from the "${chatName}" chat are the owner talking to you directly — answer with a PLAIN reply (no destination); it reaches the chat automatically. Use \`<message to="${chatDest}">\` only when YOU initiate a conversation. Use other destinations (e.g. \`parent\`) only for agent-to-agent coordination — never for answering the owner.

## Memory
This file is yours — record durable decisions, preferences, and context here as you learn them.
`;
}

export function provisionAgent(args: ProvisionArgs): ProvisionResult {
  const name = args.name?.trim();
  if (!name) throw new Error('name is required');
  const mg = getMessagingGroup(args.messagingGroupId);
  if (!mg) throw new Error(`unknown messaging group: ${args.messagingGroupId}`);

  // Refuse double-wiring the same chat to a same-named agent — re-running the
  // onboarding flow must not mint duplicates (the Dashboard/dashboard lesson).
  const existing = getMessagingGroupAgents(mg.id);
  if (existing.length > 0) {
    throw new Error(
      `messaging group "${mg.name ?? mg.id}" already has ${existing.length} wired agent(s) — use ncl wirings for additional agents`,
    );
  }

  // 1. Deduped folder slug.
  const base = slugify(name);
  let folder = base;
  for (let i = 2; getAgentGroupByFolder(folder); i++) folder = `${base}-${i}`;

  const agentGroupId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  createAgentGroup({
    id: agentGroupId,
    name,
    folder,
    agent_provider: null,
    created_at: now,
  });

  // 2. Container config with the signing name.
  ensureContainerConfig(agentGroupId);
  updateContainerConfigScalars(agentGroupId, { assistant_name: name });

  // 3. Always-on wiring — a dedicated chat should answer every message.
  //    createMessagingGroupAgent is the CANONICAL path: it also auto-creates
  //    the channel destination (named after the chat) — the step `ncl wirings
  //    create` bypasses (generic CRUD writes raw SQL; that's how Worksong
  //    ended up mute with a parent-only allow-list).
  const wiringId = crypto.randomUUID();
  createMessagingGroupAgent({
    id: wiringId,
    messaging_group_id: mg.id,
    agent_group_id: agentGroupId,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  } as Parameters<typeof createMessagingGroupAgent>[0]);

  // 4. Belt-and-suspenders: make sure a channel destination to the home chat
  //    exists (the auto-create above skips when the a2a module is absent).
  let chatDest = getDestinationByTarget(agentGroupId, 'channel', mg.id)?.local_name;
  if (!chatDest) {
    chatDest = 'chat';
    createDestination({
      agent_group_id: agentGroupId,
      local_name: chatDest,
      target_type: 'channel',
      target_id: mg.id,
      created_at: now,
    } as Parameters<typeof createDestination>[0]);
  }

  // 5. Starter persona referencing the REAL destination name (never clobber).
  const groupDir = path.resolve(GROUPS_DIR, folder);
  const personaPath = path.join(groupDir, 'CLAUDE.local.md');
  let personaCreated = false;
  fs.mkdirSync(groupDir, { recursive: true });
  if (!fs.existsSync(personaPath)) {
    fs.writeFileSync(personaPath, starterPersona(name, args.purpose, mg.name ?? mg.platform_id, chatDest));
    personaCreated = true;
  }

  log.info('Agent provisioned', { agentGroupId, name, folder, messagingGroupId: mg.id, wiringId, chatDest });
  return { agentGroupId, folder, wiringId, personaCreated };
}
