import { registerResource } from '../crud.js';
import { getSession } from '../../db/sessions.js';

/**
 * Inject a runner slash-command into a session and wake its container.
 * The agent-runner natively handles '/clear' (drops the SDK continuation →
 * fresh context) and passes '/compact' through to the SDK as a first-input
 * slash command — so context management needs NO container changes, just a
 * kickoff-style chat row (same shape provision uses).
 */
async function injectCommand(sessionId: string, command: '/compact' | '/clear'): Promise<Record<string, string>> {
  const session = getSession(sessionId);
  if (!session) throw new Error(`No session ${sessionId}`);
  const { writeSessionMessage } = await import('../../session-manager.js');
  const { wakeContainer } = await import('../../container-runner.js');
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `ctx-${command.slice(1)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: 'system',
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text: command, sender: 'system', senderId: 'system' }),
    trigger: 1,
  });
  void wakeContainer(session).catch(() => {
    /* host-sweep retries due messages */
  });
  return { session_id: session.id, command, status: 'sent' };
}

registerResource({
  name: 'session',
  plural: 'sessions',
  table: 'sessions',
  description:
    'Session — the runtime unit. Maps one (agent_group, messaging_group, thread) combination to a container with its own inbound.db and outbound.db. Created automatically by the router when a message arrives.',
  idColumn: 'id',
  scopeField: 'agent_group_id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    { name: 'agent_group_id', type: 'string', description: 'Agent group this session runs.' },
    {
      name: 'messaging_group_id',
      type: 'string',
      description: 'Messaging group this session serves. Null for agent-shared sessions.',
    },
    {
      name: 'thread_id',
      type: 'string',
      description: 'Thread ID. Only set for per-thread session mode.',
    },
    {
      name: 'agent_provider',
      type: 'string',
      description: 'Provider override. Null means inherit from agent group.',
    },
    {
      name: 'status',
      type: 'string',
      description: '"active" receives messages. "closed" is archived.',
      enum: ['active', 'closed'],
    },
    {
      name: 'container_status',
      type: 'string',
      description:
        '"running" — container alive and polling. "stopped" — container exited; the sweep will restart it automatically when due messages arrive. "idle" — reserved, currently unused.',
      enum: ['running', 'idle', 'stopped'],
    },
    { name: 'last_active', type: 'string', description: 'Last message or heartbeat. Used for stale detection.' },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: { list: 'open', get: 'open' },
  customOperations: {
    compact: {
      access: 'approval',
      description:
        'Compact the session context: injects /compact and wakes the container — the SDK summarizes ' +
        'the conversation in place. Use --id <session-id>.',
      handler: async (args) => {
        const id = args.id as string | undefined;
        if (!id) throw new Error('--id is required');
        return injectCommand(id, '/compact');
      },
    },
    'clear-context': {
      access: 'approval',
      description:
        'Clear the session context: injects /clear and wakes the container — the runner drops the ' +
        'provider continuation and the next turn starts FRESH (conversation memory gone; ' +
        'CLAUDE.local.md survives). Use --id <session-id>.',
      handler: async (args) => {
        const id = args.id as string | undefined;
        if (!id) throw new Error('--id is required');
        return injectCommand(id, '/clear');
      },
    },
  },
});
