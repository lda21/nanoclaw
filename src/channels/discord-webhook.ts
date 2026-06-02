/**
 * Per-agent Discord identity.
 *
 * The stock @chat-adapter/discord posts every agent's message under the single
 * bot user ("Agent Office"), so a multi-agent server reads as one voice. This
 * module posts an agent's reply through a per-CHANNEL Discord webhook with
 * `username` set to the agent's display name — the book's "webhooks per agent
 * per channel" approach — so each agent shows up as itself.
 *
 * Used by delivery.ts for normal Discord text messages only; edits/cards/
 * reactions fall back to the bot adapter.
 */
import { Buffer } from 'node:buffer';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';

const API = 'https://discord.com/api/v10';
const MAX = 2000; // Discord message length cap

// channelId -> { id, token }
const webhookCache = new Map<string, { id: string; token: string }>();
let cachedToken: string | null | undefined;

function botToken(): string | null {
  if (cachedToken === undefined) {
    cachedToken = readEnvFile(['DISCORD_BOT_TOKEN']).DISCORD_BOT_TOKEN || null;
  }
  return cachedToken;
}

/** True when a Discord bot token is configured (per-agent identity available). */
export function discordIdentityEnabled(): boolean {
  return botToken() !== null;
}

function channelIdFromPlatform(platformId: string): string | null {
  // "discord:<guildId>:<channelId>" or "discord:@me:<dmChannelId>"
  const parts = platformId.split(':');
  return parts.length >= 3 ? parts[parts.length - 1] : null;
}

async function getOrCreateWebhook(token: string, channelId: string): Promise<{ id: string; token: string }> {
  const cached = webhookCache.get(channelId);
  if (cached) return cached;
  const headers = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };

  const listRes = await fetch(`${API}/channels/${channelId}/webhooks`, { headers });
  if (listRes.ok) {
    const hooks = (await listRes.json()) as Array<{ id: string; token?: string; name: string }>;
    const mine = hooks.find((h) => h.name === 'AgentOffice' && h.token);
    if (mine?.token) {
      const wh = { id: mine.id, token: mine.token };
      webhookCache.set(channelId, wh);
      return wh;
    }
  }
  const createRes = await fetch(`${API}/channels/${channelId}/webhooks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'AgentOffice' }),
  });
  if (!createRes.ok) {
    throw new Error(`webhook create failed ${createRes.status}: ${await createRes.text()}`);
  }
  const h = (await createRes.json()) as { id: string; token: string };
  const wh = { id: h.id, token: h.token };
  webhookCache.set(channelId, wh);
  return wh;
}

function splitText(text: string): string[] {
  if (text.length <= MAX) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > MAX) {
    let cut = rest.lastIndexOf('\n', MAX);
    if (cut < MAX * 0.5) cut = MAX; // no good newline — hard split
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** A distinct, deterministic avatar per agent (DiceBear — no hosting needed).
 *  Discord fetches + caches it; if the service is unreachable the webhook just
 *  shows its default avatar. Override DICEBEAR_STYLE via env to restyle. */
function avatarFor(agentName: string): string {
  const style = readEnvFile(['AGENT_AVATAR_STYLE']).AGENT_AVATAR_STYLE || 'bottts-neutral';
  return `https://api.dicebear.com/9.x/${style}/png?seed=${encodeURIComponent(agentName)}&size=128`;
}

/** Drop a leading "**Name —**" / "**Name -**" the agent may have written, since
 *  the webhook already shows the name. */
function stripSelfPrefix(text: string, agentName: string): string {
  const esc = agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`^\\s*\\*\\*\\s*${esc}\\s*[—\\-:]+\\s*\\*\\*\\s*`, 'i'), '');
}

/**
 * Post `text` to a Discord channel as `agentName` via a cached channel webhook.
 * Returns the first message id, or throws so the caller can fall back to the bot.
 */
export async function postAsAgent(
  platformId: string,
  threadId: string | null,
  text: string,
  files: Array<{ data: Buffer; filename: string }> | undefined,
  agentName: string,
): Promise<string | undefined> {
  const token = botToken();
  if (!token) throw new Error('no discord bot token');
  const channelId = channelIdFromPlatform(platformId);
  if (!channelId) throw new Error(`cannot parse discord channel from "${platformId}"`);

  const wh = await getOrCreateWebhook(token, channelId);
  // A real sub-thread: a bare snowflake distinct from the channel id.
  const threadParam = threadId && /^\d+$/.test(threadId) && threadId !== channelId ? `&thread_id=${threadId}` : '';
  const url = `${API}/webhooks/${wh.id}/${wh.token}?wait=true${threadParam}`;

  const avatarUrl = avatarFor(agentName);
  const chunks = splitText(stripSelfPrefix(text, agentName));
  let firstId: string | undefined;
  for (let i = 0; i < chunks.length; i++) {
    const attachFiles = i === 0 && files && files.length > 0;
    let res: Response;
    if (attachFiles) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify({ content: chunks[i], username: agentName, avatar_url: avatarUrl }));
      files.forEach((f, idx) => form.append(`files[${idx}]`, new Blob([new Uint8Array(f.data)]), f.filename));
      res = await fetch(url, { method: 'POST', body: form });
    } else {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: chunks[i], username: agentName, avatar_url: avatarUrl }),
      });
    }
    if (!res.ok) {
      throw new Error(`webhook execute failed ${res.status}: ${await res.text()}`);
    }
    const j = (await res.json()) as { id?: string };
    if (i === 0) firstId = j.id;
  }
  log.debug('posted as agent via webhook', { agentName, channelId });
  return firstId;
}
