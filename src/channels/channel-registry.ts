/**
 * Channel adapter registry.
 *
 * Channels self-register on import. The host calls initChannelAdapters() at startup
 * to instantiate and set up all registered adapters.
 */
import type { ChannelAdapter, ChannelRegistration, ChannelSetup } from './adapter.js';
import {
  createMessagingGroup,
  getMessagingGroupByPlatform,
  updateMessagingGroup,
} from '../db/messaging-groups.js';
import { log } from '../log.js';

const SETUP_RETRY_DELAYS_MS = [2000, 5000, 10000];

/** Duck-type check — adapters that throw an Error with `name === 'NetworkError'`
 * (Chat SDK's `@chat-adapter/shared.NetworkError` and similar) get a retry on
 * setup. Avoids depending on `@chat-adapter/shared` at trunk level. */
function isNetworkError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'NetworkError';
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const registry = new Map<string, ChannelRegistration>();
const activeAdapters = new Map<string, ChannelAdapter>();

/** Register a channel adapter factory. Called by channel modules on import. */
export function registerChannelAdapter(name: string, registration: ChannelRegistration): void {
  registry.set(name, registration);
}

/** Get a live adapter by channel type. */
export function getChannelAdapter(channelType: string): ChannelAdapter | undefined {
  return activeAdapters.get(channelType);
}

/** Get all active adapters. */
export function getActiveAdapters(): ChannelAdapter[] {
  return [...activeAdapters.values()];
}

/** Get all registered channel names. */
export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}

/** Get container config for a channel (used by container-runner for additional mounts/env). */
export function getChannelContainerConfig(name: string): ChannelRegistration['containerConfig'] {
  return registry.get(name)?.containerConfig;
}

/**
 * Instantiate and set up all registered channel adapters.
 * Skips adapters that return null (missing credentials).
 */
export async function initChannelAdapters(setupFn: (adapter: ChannelAdapter) => ChannelSetup): Promise<void> {
  for (const [name, registration] of registry) {
    try {
      const adapter = await registration.factory();
      if (!adapter) {
        log.warn('Channel credentials missing, skipping', { channel: name });
        continue;
      }

      const setup = setupFn(adapter);
      // Transient network failures during adapter init (e.g. Telegram deleteWebhook
      // hitting a DNS hiccup at boot) would otherwise leave the channel permanently
      // dead until manual restart. Retry only on NetworkError so misconfigs (bad
      // tokens, etc.) still fail fast.
      let attempt = 0;
      while (true) {
        try {
          await adapter.setup(setup);
          break;
        } catch (err) {
          if (isNetworkError(err) && attempt < SETUP_RETRY_DELAYS_MS.length) {
            const delay = SETUP_RETRY_DELAYS_MS[attempt]!;
            log.warn('Channel adapter setup failed with network error, retrying', {
              channel: name,
              attempt: attempt + 1,
              delayMs: delay,
              err: err.message,
            });
            await sleep(delay);
            attempt += 1;
            continue;
          }
          throw err;
        }
      }
      activeAdapters.set(adapter.channelType, adapter);
      log.info('Channel adapter started', { channel: name, type: adapter.channelType });
    } catch (err) {
      log.error('Failed to start channel adapter', { channel: name, err });
    }
  }
}

/**
 * On-demand conversation sync for one channel (triggered from the dashboard /
 * NanoDash app). Calls the adapter's optional `syncConversations()` and
 * registers every NEWLY discovered conversation as a messaging group —
 * `unknown_sender_policy: 'strict'` so a sync-registered group is visible and
 * wireable but inert until an admin engages it (mention-auto-create keeps its
 * own 'request_approval' default; this path is deliberately more conservative).
 * Existing rows get their name refreshed when the platform name changed.
 *
 * This closes the "group created after startup is invisible" gap: the startup
 * metadata scan only logs, and the router only auto-registers on DM/@-mention.
 */
export async function syncChannelConversations(
  channelType: string,
): Promise<{ ok: boolean; registered?: number; updated?: number; error?: string }> {
  const adapter = activeAdapters.get(channelType);
  if (!adapter) {
    return { ok: false, error: `No live adapter for channel '${channelType}'` };
  }
  if (!adapter.syncConversations) {
    return { ok: false, error: `Channel '${channelType}' does not support conversation sync` };
  }

  const conversations = await adapter.syncConversations();
  let registered = 0;
  let updated = 0;
  for (const conv of conversations) {
    if (!conv.platformId) continue;
    const existing = getMessagingGroupByPlatform(channelType, conv.platformId);
    if (!existing) {
      createMessagingGroup({
        id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        channel_type: channelType,
        platform_id: conv.platformId,
        name: conv.name || null,
        is_group: conv.isGroup ? 1 : 0,
        unknown_sender_policy: 'strict',
        denied_at: null,
        created_at: new Date().toISOString(),
      });
      registered++;
    } else if (conv.name && conv.name !== existing.name) {
      updateMessagingGroup(existing.id, { name: conv.name });
      updated++;
    }
  }
  log.info('Channel conversation sync complete', { channelType, found: conversations.length, registered, updated });
  return { ok: true, registered, updated };
}

/** Tear down all active adapters. */
export async function teardownChannelAdapters(): Promise<void> {
  for (const [name, adapter] of activeAdapters) {
    try {
      await adapter.teardown();
      log.info('Channel adapter stopped', { channel: name });
    } catch (err) {
      log.error('Failed to stop channel adapter', { channel: name, err });
    }
  }
  activeAdapters.clear();
}
