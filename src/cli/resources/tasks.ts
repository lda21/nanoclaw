/**
 * `ncl tasks` — fleet-wide view + control of scheduled/recurring agent tasks.
 *
 * Tasks are NOT a central-DB table: they are `messages_in` rows with
 * kind='task' living in each session's inbound.db (the host is that file's
 * sole writer, so host-side cancel is safe). Both verbs are therefore
 * customOperations that fan out over active sessions and open each inbound.db
 * read/write briefly — the same per-session pattern host-sweep uses.
 *
 * `list` mirrors the container's own list_tasks semantics: one row per
 * series — the live (pending or paused) occurrence, identified by series_id.
 * `cancel` mirrors the agent's cancel_task exactly (cancelTask: status →
 * 'completed' + recurrence → NULL, matching id OR series_id).
 */

import fs from 'fs';

import { registerResource } from '../crud.js';
import { getActiveSessions, getSessionsByAgentGroup } from '../../db/sessions.js';
import { openInboundDb, inboundDbPath } from '../../session-manager.js';
import { cancelTask } from '../../modules/scheduling/db.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import type { Session } from '../../types.js';

/** One row per live series in this session's inbound.db. */
const LIVE_TASKS_SQL = `
  SELECT series_id AS id, status, process_after, recurrence, content, MAX(seq) AS _seq
  FROM messages_in
  WHERE kind = 'task' AND status IN ('pending', 'paused')
  GROUP BY series_id
  ORDER BY process_after ASC`;

function sessionsFor(agentGroupId: string | undefined): Session[] {
  return agentGroupId ? getSessionsByAgentGroup(agentGroupId) : getActiveSessions();
}

registerResource({
  name: 'task',
  plural: 'tasks',
  table: 'messages_in',
  description:
    'Scheduled/recurring agent tasks — messages_in rows (kind=task) in each session inbound.db. ' +
    'One row per series: the live (pending or paused) occurrence. ' +
    '`list` shows the whole fleet (or --agent-group-id <id>); `cancel --id <task-or-series-id>` ' +
    'stops a task permanently with the same semantics as the agent-side cancel_task.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'Series id (stable task handle).' },
    { name: 'agent_group_id', type: 'string', description: 'Owning agent group.' },
    { name: 'agent_group_name', type: 'string', description: 'Owning agent group name.' },
    { name: 'session_id', type: 'string', description: 'Owning session.' },
    { name: 'status', type: 'string', description: 'pending (live) or paused.', enum: ['pending', 'paused'] },
    { name: 'process_after', type: 'string', description: 'Next run (UTC ISO).' },
    { name: 'recurrence', type: 'string', description: 'Cron string for recurring tasks, null for one-shot.' },
    { name: 'prompt', type: 'string', description: 'The task prompt (from the content JSON).' },
  ],
  operations: {}, // generic SQL handlers can't reach per-session inbound.db
  customOperations: {
    list: {
      access: 'open',
      description:
        'List live (pending/paused) tasks across all active sessions, one row per series. ' +
        'Optional --agent-group-id <id> to filter to one agent.',
      handler: async (args) => {
        const out: Array<Record<string, unknown>> = [];
        for (const s of sessionsFor(args['agent-group-id'] as string | undefined)) {
          if (!fs.existsSync(inboundDbPath(s.agent_group_id, s.id))) continue;
          const db = openInboundDb(s.agent_group_id, s.id);
          try {
            const rows = db.prepare(LIVE_TASKS_SQL).all() as Array<Record<string, unknown>>;
            if (rows.length === 0) continue;
            const groupName = getAgentGroup(s.agent_group_id)?.name ?? s.agent_group_id;
            for (const r of rows) {
              let prompt: string | null = null;
              try {
                prompt = ((JSON.parse(r.content as string) as { prompt?: string }).prompt ?? '').slice(0, 500) || null;
              } catch {
                /* malformed content — leave prompt null */
              }
              out.push({
                id: r.id,
                agent_group_id: s.agent_group_id,
                agent_group_name: groupName,
                session_id: s.id,
                status: r.status,
                process_after: r.process_after,
                recurrence: r.recurrence,
                prompt,
              });
            }
          } finally {
            db.close();
          }
        }
        return out;
      },
    },
    cancel: {
      access: 'approval', // host/app-bridge callers skip approval; agents have their own cancel_task
      description:
        'Cancel a task permanently by task/series id: --id <id> [--agent-group-id <id> to narrow the scan]. ' +
        'Same semantics as the agent-side cancel_task (status → completed, recurrence cleared).',
      handler: async (args) => {
        const taskId = (args.id as string | undefined) ?? undefined;
        if (!taskId) throw new Error('--id is required');
        for (const s of sessionsFor(args['agent-group-id'] as string | undefined)) {
          if (!fs.existsSync(inboundDbPath(s.agent_group_id, s.id))) continue;
          const db = openInboundDb(s.agent_group_id, s.id);
          try {
            const live = db
              .prepare(
                `SELECT COUNT(*) AS n FROM messages_in
                 WHERE (id = ? OR series_id = ?) AND kind = 'task' AND status IN ('pending', 'paused')`,
              )
              .get(taskId, taskId) as { n: number };
            if (live.n === 0) continue;
            cancelTask(db, taskId);
            return { cancelled: taskId, agent_group_id: s.agent_group_id, session_id: s.id };
          } finally {
            db.close();
          }
        }
        throw new Error(`No live task found with id ${taskId}`);
      },
    },
  },
});
