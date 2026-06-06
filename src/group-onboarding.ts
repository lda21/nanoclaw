/**
 * Group onboarding — "add the bot to a group, get an agent" (chat-first UX).
 *
 * The WhatsApp adapter (and any adapter that emits onMetadata) surfaces every
 * conversation it can see. When a GROUP appears that isn't registered yet,
 * this module:
 *   1. registers it quietly (strict policy, NO wiring — nothing engages, the
 *      privacy posture is unchanged), and
 *   2. notifies the owner's DM agent (e.g. Nano) with a system message asking
 *      it to offer onboarding: "want an agent for this group?" → on yes, the
 *      agent runs `ncl groups provision` (the atomic primitive).
 *
 * Re-ask protection is structural: once registered, the group is never "new"
 * again. Declining simply leaves it registered-but-unwired (visible in the
 * app's Channels list, inert otherwise).
 */
import { getMessagingGroupByPlatform, createMessagingGroup, getMessagingGroupAgents } from './db/messaging-groups.js';
import { getOwners } from './modules/permissions/db/user-roles.js';
import { getUserDmsForUser } from './modules/permissions/db/user-dms.js';
import { getSessionsByAgentGroup } from './db/sessions.js';
import { writeSessionMessage } from './session-manager.js';
import { wakeContainer } from './container-runner.js';
import { log } from './log.js';

/** In-flight guard — onMetadata fires on every message; don't double-handle
 *  the same platform id while the first registration is still writing. */
const inFlight = new Set<string>();

export function handleDiscoveredGroup(channelType: string, platformId: string, name?: string | null): void {
  const key = `${channelType}:${platformId}`;
  if (inFlight.has(key)) return;
  if (getMessagingGroupByPlatform(channelType, platformId)) return; // known — the common, free path

  inFlight.add(key);
  try {
    const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    createMessagingGroup({
      id: mgId,
      channel_type: channelType,
      platform_id: platformId,
      name: name ?? null,
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    } as Parameters<typeof createMessagingGroup>[0]);
    log.info('New group auto-registered (unwired)', { channelType, platformId, name: name ?? null, mgId });
    offerAgentForGroup(mgId, channelType, name ?? null, platformId);
  } catch (err) {
    // Unique-constraint race (two metadata events) or notify failure — never
    // let onboarding break the adapter's event path.
    log.warn('Group onboarding failed', { channelType, platformId, err: String(err) });
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Ask the owner's DM agent to offer onboarding for a freshly-registered group.
 * Called from BOTH discovery paths: the metadata hook above AND
 * syncChannelConversations (app "Sync groups" / admin sync) — whichever
 * registers the group first owns the offer.
 */
export function offerAgentForGroup(mgId: string, channelType: string, name: string | null, platformId: string): void {
  notifyOwnerDmAgent(
    `📥 New ${channelType} group detected: "${name ?? platformId}" (messaging group ${mgId}). ` +
      `I was added to it but no agent is wired. DM the owner: ask whether they want a dedicated agent for this group, ` +
      `and if yes ask for a one-line purpose, then run: ` +
      `ncl groups provision --messaging-group-id ${mgId} --name "<AgentName>" --purpose "<one line>". ` +
      `The new agent introduces itself in the group immediately after provisioning. If the owner declines, do nothing — ` +
      `the group stays registered but inert.`,
  );
}

/**
 * Drop a wake message into the owner's DM agent session (the agent wired to
 * the owner's direct-message chat — Nano on this install). Resolution is
 * data-driven: owner role → user_dms → that DM's wired agent → its session.
 */
function notifyOwnerDmAgent(text: string): void {
  const owner = getOwners()[0];
  if (!owner) {
    log.warn('Group onboarding: no owner role — cannot notify');
    return;
  }
  for (const dm of getUserDmsForUser(owner.user_id)) {
    const wirings = getMessagingGroupAgents(dm.messaging_group_id);
    const agentGroupId = wirings[0]?.agent_group_id;
    if (!agentGroupId) continue;

    // The DM session for (agent group × the owner's DM chat).
    const session = getSessionsByAgentGroup(agentGroupId).find(
      (s) => s.messaging_group_id === dm.messaging_group_id && s.status === 'active',
    );
    if (!session) continue;

    writeSessionMessage(agentGroupId, session.id, {
      id: `onboard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: 'system',
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
      trigger: 1,
    });
    void wakeContainer(session).catch((err) =>
      log.warn('Group onboarding: wake failed — host-sweep will retry', { err: String(err) }),
    );
    log.info('Group onboarding: owner DM agent notified', { agentGroupId, sessionId: session.id });
    return; // one notification is enough
  }
  log.warn('Group onboarding: no owner DM agent session found — group registered silently');
}
