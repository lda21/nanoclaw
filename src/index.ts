/**
 * NanoClaw — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 */
import path from 'path';

import { backfillContainerConfigs } from './backfill-container-configs.js';
import { DATA_DIR } from './config.js';
import { enforceStartupBackoff, resetCircuitBreaker } from './circuit-breaker.js';
import { migrateGroupsToClaudeLocal } from './claude-md-compose.js';
import { initDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { ensureContainerRuntimeRunning, cleanupOrphans } from './container-runtime.js';
import { startActiveDeliveryPoll, startSweepDeliveryPoll, setDeliveryAdapter, stopDeliveryPolls } from './delivery.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { routeInbound } from './router.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';

// Response + shutdown registries live in response-registry.ts to break the
// circular import cycle: src/index.ts imports src/modules/index.js for side
// effects, and the modules call registerResponseHandler/onShutdown at top
// level — which would hit a TDZ error if the arrays lived here. Re-exported
// here so existing callers see the same surface.
import {
  registerResponseHandler,
  getResponseHandlers,
  onShutdown,
  getShutdownCallbacks,
  type ResponsePayload,
  type ResponseHandler,
} from './response-registry.js';
export { registerResponseHandler, onShutdown };
export type { ResponsePayload, ResponseHandler };

async function dispatchResponse(payload: ResponsePayload): Promise<void> {
  for (const handler of getResponseHandlers()) {
    try {
      const claimed = await handler(payload);
      if (claimed) return;
    } catch (err) {
      log.error('Response handler threw', { questionId: payload.questionId, err });
    }
  }
  log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
}

// Channel barrel — each enabled channel self-registers on import.
// Channel skills uncomment lines in channels/index.ts to enable them.
import './channels/index.js';

// Modules barrel — default modules (typing, mount-security) ship here; skills
// append registry-based modules. Imported for side effects (registrations).
import './modules/index.js';

// CLI command barrel — populates the `ncl` registry before the CLI server
// accepts connections.
import './cli/commands/index.js';
import './cli/delivery-action.js';
import { startCliServer, stopCliServer } from './cli/socket-server.js';

import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import {
  initChannelAdapters,
  teardownChannelAdapters,
  getChannelAdapter,
  syncChannelConversations,
} from './channels/channel-registry.js';

async function main(): Promise<void> {
  log.info('NanoClaw starting');

  // 0. Circuit breaker — backoff on rapid restarts
  await enforceStartupBackoff();

  // 1. Init central DB
  const dbPath = path.join(DATA_DIR, 'v2.db');
  const db = initDb(dbPath);
  runMigrations(db);
  log.info('Central DB ready', { path: dbPath });

  // 1b. Backfill container_configs from legacy container.json files.
  // Idempotent — skips groups that already have a config row.
  backfillContainerConfigs();

  // 1c. One-time filesystem cutover — idempotent, no-op after first run.
  migrateGroupsToClaudeLocal();

  // 2. Container runtime
  ensureContainerRuntimeRunning();
  cleanupOrphans();

  // 3. Channel adapters
  await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
    return {
      onInbound(platformId, threadId, message) {
        routeInbound({
          channelType: adapter.channelType,
          platformId,
          threadId,
          message: {
            id: message.id,
            kind: message.kind,
            content: JSON.stringify(message.content),
            timestamp: message.timestamp,
            isMention: message.isMention,
            isGroup: message.isGroup,
          },
        }).catch((err) => {
          log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
        });
      },
      onInboundEvent(event) {
        routeInbound(event).catch((err) => {
          log.error('Failed to route inbound event', {
            sourceAdapter: adapter.channelType,
            targetChannelType: event.channelType,
            err,
          });
        });
      },
      onMetadata(platformId, name, isGroup) {
        log.info('Channel metadata discovered', {
          channelType: adapter.channelType,
          platformId,
          name,
          isGroup,
        });
      },
      onAction(questionId, selectedOption, userId) {
        dispatchResponse({
          questionId,
          value: selectedOption,
          userId,
          channelType: adapter.channelType,
          // platformId/threadId aren't surfaced by the current onAction
          // signature — registered handlers look them up from the
          // pending_question / pending_approval row.
          platformId: '',
          threadId: null,
        }).catch((err) => {
          log.error('Failed to handle question response', { questionId, err });
        });
      },
    };
  });

  // 4. Delivery adapter bridge — dispatches to channel adapters
  const deliveryAdapter = {
    async deliver(
      channelType: string,
      platformId: string,
      threadId: string | null,
      kind: string,
      content: string,
      files?: import('./channels/adapter.js').OutboundFile[],
    ): Promise<string | undefined> {
      const adapter = getChannelAdapter(channelType);
      if (!adapter) {
        log.warn('No adapter for channel type', { channelType });
        return;
      }
      return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
    },
    async setTyping(channelType: string, platformId: string, threadId: string | null): Promise<void> {
      const adapter = getChannelAdapter(channelType);
      await adapter?.setTyping?.(platformId, threadId);
    },
  };
  setDeliveryAdapter(deliveryAdapter);

  // 5. Start delivery polls
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  // 6. Start host sweep
  startHostSweep();
  log.info('Host sweep started');

  // 7. Start the `ncl` CLI socket server (data/ncl.sock).
  await startCliServer();

  // 8. Dashboard (optional)
  const dashboardEnv = readEnvFile(['DASHBOARD_SECRET', 'DASHBOARD_PORT']);
  const dashboardSecret = process.env.DASHBOARD_SECRET || dashboardEnv.DASHBOARD_SECRET;
  const dashboardPort = parseInt(process.env.DASHBOARD_PORT || dashboardEnv.DASHBOARD_PORT || '3100', 10);
  if (dashboardSecret) {
    const { startDashboard } = await import('@nanoco/nanoclaw-dashboard');
    const { startDashboardPusher, pushSnapshotNow } = await import('./dashboard-pusher.js');
    // Bind loopback only — external access is via Tailscale Serve on the same
    // port, which would otherwise collide with a 0.0.0.0 bind on the tailnet IP.
    const { getPendingApproval } = await import('./db/sessions.js');
    const { ONECLI_ACTION } = await import('./modules/approvals/onecli-approvals.js');
    startDashboard({
      port: dashboardPort,
      host: '127.0.0.1',
      secret: dashboardSecret,
      // Web-resolve policy: cli_command + self-mod are allowed; OneCLI
      // credential approvals stay chat-only (identified admin). Auth is the
      // shared DASHBOARD_SECRET — there is no per-user identity here, so the
      // approver is recorded synthetically. Mirror the `actionable` flag in
      // dashboard-pusher.ts if this gate changes.
      onApprovalDecision: async (id: string, decision: 'approve' | 'reject') => {
        const approval = getPendingApproval(id);
        if (!approval) return { ok: false, error: 'Approval not found (already resolved?)' };
        if (approval.action === ONECLI_ACTION) {
          return { ok: false, error: 'OneCLI credential approvals must be resolved from chat' };
        }
        await dispatchResponse({
          questionId: id,
          value: decision,
          userId: 'dashboard:web',
          channelType: 'dashboard',
          platformId: '',
          threadId: null,
        });
        return { ok: true };
      },
      // On-demand channel conversation sync (NanoDash app "Sync groups"):
      // registers newly created platform groups that the startup scan never
      // writes and the router only registers on DM/@-mention. On success,
      // push a fresh snapshot immediately so the app sees the new groups
      // without waiting for the 60s pusher tick.
      onChannelSync: async (channelType: string) => {
        const result = await syncChannelConversations(channelType);
        if (result.ok && (result.registered ?? 0) + (result.updated ?? 0) > 0) {
          pushSnapshotNow();
        }
        return result;
      },
      // Read-only workspace browsing for the app (Agent group → Workspace).
      // Path-safety + text/size policy live in group-files.ts.
      onGroupFileRead: async (groupId: string, relPath: string) => {
        const { readGroupFile } = await import('./group-files.js');
        return readGroupFile(groupId, relPath);
      },
    });
    startDashboardPusher({ port: dashboardPort, secret: dashboardSecret, intervalMs: 60000 });
  } else {
    log.info('Dashboard disabled (no DASHBOARD_SECRET)');
  }

  log.info('NanoClaw running');
}

/** Graceful shutdown. */
async function shutdown(signal: string): Promise<void> {
  log.info('Shutdown signal received', { signal });
  for (const cb of getShutdownCallbacks()) {
    try {
      await cb();
    } catch (err) {
      log.error('Shutdown callback threw', { err });
    }
  }
  stopDeliveryPolls();
  stopHostSweep();
  await stopCliServer();
  try {
    await teardownChannelAdapters();
  } finally {
    // Always reset on graceful shutdown — even if teardown threw, we got here
    // via SIGTERM/SIGINT, not a crash, so the next start shouldn't be counted
    // as one.
    resetCircuitBreaker();
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  log.fatal('Startup failed', { err });
  process.exit(1);
});
