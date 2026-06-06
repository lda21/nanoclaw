/**
 * Dashboard pusher — collects NanoClaw state and POSTs a JSON
 * snapshot to the dashboard's /api/ingest endpoint every interval.
 */
import fs from 'fs';
import path from 'path';
import http from 'http';
import Database from 'better-sqlite3';

import { getAllAgentGroups, getAgentGroup } from './db/agent-groups.js';
import { getSessionsByAgentGroup } from './db/sessions.js';
import { getContainerConfig } from './db/container-configs.js';
import { ONECLI_ACTION } from './modules/approvals/onecli-approvals.js';
import { getAllMessagingGroups, getMessagingGroupAgents } from './db/messaging-groups.js';
import { getDestinations } from './modules/agent-to-agent/db/agent-destinations.js';
import { getMembers } from './modules/permissions/db/agent-group-members.js';
import { getAllUsers, getUser } from './modules/permissions/db/users.js';
import { getUserRoles, getAdminsOfAgentGroup } from './modules/permissions/db/user-roles.js';
import { getUserDmsForUser } from './modules/permissions/db/user-dms.js';
import { getActiveAdapters, getRegisteredChannelNames } from './channels/channel-registry.js';
import { DATA_DIR, GROUPS_DIR, ASSISTANT_NAME } from './config.js';
import { getDb } from './db/connection.js';
import { log } from './log.js';

interface PusherConfig {
  port: number;
  secret: string;
  intervalMs?: number;
}

let timer: ReturnType<typeof setInterval> | null = null;
let logTimer: ReturnType<typeof setInterval> | null = null;
let approvalsTimer: ReturnType<typeof setInterval> | null = null;
let logOffset = 0;

// Approvals refresh on a tight loop, independent of the heavy 60s full
// snapshot — it's a single cheap query, so the dashboard can show new/resolved
// approvals within a few seconds.
const APPROVALS_INTERVAL_MS = 5000;

export function startDashboardPusher(config: PusherConfig): void {
  const interval = config.intervalMs || 60000;
  lastConfig = config;

  // Push immediately on start, then on interval
  push(config).catch((err) => log.error('Dashboard push failed', { err }));
  timer = setInterval(() => {
    push(config).catch((err) => log.error('Dashboard push failed', { err }));
  }, interval);

  // Fast approvals-only refresh (merges into the snapshot host-side).
  approvalsTimer = setInterval(() => pushApprovals(config), APPROVALS_INTERVAL_MS);

  // Start log file tailing
  startLogTail(config);

  log.info('Dashboard pusher started', { intervalMs: interval, approvalsMs: APPROVALS_INTERVAL_MS });
}

/**
 * Push a full snapshot immediately (out-of-band of the 60s interval). Used
 * after state-mutating admin actions (e.g. channel sync) so the dashboard and
 * the NanoDash app see the change right away. No-op when the pusher hasn't
 * been started (no config yet).
 */
export function pushSnapshotNow(): void {
  if (!lastConfig) return;
  push(lastConfig).catch((err) => log.error('Dashboard push failed', { err }));
}

let lastConfig: PusherConfig | null = null;

export function stopDashboardPusher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (approvalsTimer) {
    clearInterval(approvalsTimer);
    approvalsTimer = null;
  }
  if (logTimer) {
    clearInterval(logTimer);
    logTimer = null;
  }
}

/** Cheap approvals-only fast-path push (decoupled from the full snapshot). */
function pushApprovals(config: PusherConfig): void {
  try {
    postJson(config, '/api/approvals/push', { approvals: collectApprovals() });
  } catch (err) {
    log.error('Dashboard approvals push failed', { err });
  }
}

/** Fire-and-forget POST to the dashboard. */
function postJson(config: PusherConfig, urlPath: string, data: unknown): void {
  const body = JSON.stringify(data);
  const req = http.request({
    hostname: '127.0.0.1',
    port: config.port,
    path: urlPath,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Authorization: `Bearer ${config.secret}`,
    },
  });
  req.on('error', () => {});
  req.write(body);
  req.end();
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function startLogTail(config: PusherConfig): void {
  const logFile = path.resolve(process.cwd(), 'logs', 'nanoclaw.log');
  if (!fs.existsSync(logFile)) return;

  // Send last 200 lines as backfill
  try {
    const allLines = fs
      .readFileSync(logFile, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    logOffset = fs.statSync(logFile).size;
    const tail = allLines.slice(-200).map((l) => l.replace(ANSI_RE, ''));
    if (tail.length > 0) postJson(config, '/api/logs/push', { lines: tail });
  } catch {
    return;
  }

  // Poll every 2s for new lines
  logTimer = setInterval(() => {
    try {
      const stat = fs.statSync(logFile);
      if (stat.size <= logOffset) {
        logOffset = stat.size;
        return;
      }
      const buf = Buffer.alloc(stat.size - logOffset);
      const fd = fs.openSync(logFile, 'r');
      fs.readSync(fd, buf, 0, buf.length, logOffset);
      fs.closeSync(fd);
      logOffset = stat.size;
      const lines = buf
        .toString()
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => l.replace(ANSI_RE, ''));
      if (lines.length > 0) postJson(config, '/api/logs/push', { lines });
    } catch {
      /* ignore */
    }
  }, 2000);
}

async function push(config: PusherConfig): Promise<void> {
  const snapshot = collectSnapshot();
  postJson(config, '/api/ingest', snapshot);
  log.debug('Dashboard snapshot pushed');
}

function collectSnapshot(): Record<string, unknown> {
  return {
    timestamp: new Date().toISOString(),
    assistant_name: ASSISTANT_NAME,
    uptime: Math.floor(process.uptime()),
    host_version: readHostVersion(),
    shared_skills: collectSharedSkills(),
    // Built-in MCP tools, parsed from the agent-runner source (cached).
    agent_tools: collectAgentTools(),
    // Global shared memory (container/CLAUDE.md) — system-level, shown on the
    // System screen (the per-agent Brain shows only the agent's own delta).
    shared_md: readSharedMd(),
    agent_groups: collectAgentGroups(),
    sessions: collectSessions(),
    channels: collectChannels(),
    users: collectUsers(),
    tokens: collectTokens(),
    context_windows: collectContextWindows(),
    activity: collectActivity(),
    messages: collectMessages(),
    approvals: collectApprovals(),
  };
}

/** Pending (and recently-resolved) host-side approvals from the central DB. */
function collectApprovals() {
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT approval_id, action, title, status, session_id, agent_group_id, created_at, expires_at, payload
         FROM pending_approvals ORDER BY created_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    const nameMap = new Map(getAllAgentGroups().map((g) => [g.id, g.name]));
    return rows.map((r) => {
      const agentGroupId = (r.agent_group_id as string) || null;
      return {
        approval_id: r.approval_id as string,
        action: (r.action as string) ?? '',
        title: (r.title as string) || '',
        status: (r.status as string) ?? '',
        detail: summarizeApprovalPayload(r.payload as string | null),
        // Dashboard may resolve everything except OneCLI credential approvals,
        // which stay chat-only (identified admin). Mirrors the host-side gate
        // in src/index.ts onApprovalDecision.
        actionable: r.status === 'pending' && r.action !== ONECLI_ACTION,
        session_id: (r.session_id as string) || null,
        agent_group_id: agentGroupId,
        agent_group_name: agentGroupId ? (nameMap.get(agentGroupId) ?? null) : null,
        created_at: r.created_at as string,
        expires_at: (r.expires_at as string) || null,
      };
    });
  } catch {
    return [];
  }
}

/** Collapse an approval payload into a one-line human summary. */
function summarizeApprovalPayload(payload: string | null): string {
  if (!payload) return '';
  try {
    const p = JSON.parse(payload) as Record<string, unknown>;
    const frame = p.frame as { command?: string; args?: unknown } | undefined;
    if (frame) {
      const cmd = frame.command ?? '';
      const args = frame.args && Object.keys(frame.args).length ? JSON.stringify(frame.args) : '';
      return [cmd, args].filter(Boolean).join(' ');
    }
    if (p.packages) {
      return 'packages: ' + (Array.isArray(p.packages) ? p.packages.join(', ') : String(p.packages));
    }
    return JSON.stringify(p);
  } catch {
    return String(payload).slice(0, 200);
  }
}

/** Cap per personality file so a runaway CLAUDE.md can't bloat the snapshot. */
const BRAIN_FILE_CAP = 32 * 1024;

/**
 * The agent "brain" — the filesystem side of an agent group's identity, read
 * from groups/<folder>/: the composed CLAUDE.md, the self-customized
 * CLAUDE.local.md, and the .claude-fragments/ file names (skill-*.md are the
 * wired skills, module-*.md the instruction modules). Tools (MCP servers,
 * packages) already travel via container_config. Best-effort: any read error
 * degrades to null/[] — the snapshot must never fail on a missing folder.
 */
function collectBrain(
  folder: string,
  sharedMd: string | null,
  skillCatalog: Array<{ name: string; description: string | null }>,
  groupId?: string,
): {
  claude_md: string | null;
  claude_local_md: string | null;
  shared_md: string | null;
  fragments: string[];
  skills: Array<{ name: string; description: string | null }>;
  commands: Array<{ name: string; description: string | null }>;
} | null {
  const dir = path.join(GROUPS_DIR, folder);
  const readCapped = (file: string): string | null => {
    try {
      const text = fs.readFileSync(path.join(dir, file), 'utf-8');
      if (!text.trim()) return null;
      return text.length > BRAIN_FILE_CAP ? `${text.slice(0, BRAIN_FILE_CAP)}\n… (truncated)` : text;
    } catch {
      return null;
    }
  };
  try {
    if (!fs.existsSync(dir)) return null;
    let fragments: string[] = [];
    try {
      fragments = fs
        .readdirSync(path.join(dir, '.claude-fragments'))
        .filter((f) => f.endsWith('.md'))
        .sort();
    } catch {
      /* no fragments dir */
    }
    // Wired skills with descriptions: each skill-<name>.md fragment joined
    // against the shared catalog (per-group skills without a catalog entry
    // still appear, description null).
    const skills = fragments
      .filter((f) => f.startsWith('skill-'))
      .map((f) => {
        const name = f.replace(/^skill-/, '').replace(/\.md$/, '');
        return { name, description: skillCatalog.find((s) => s.name === name)?.description ?? null };
      });
    // Slash commands the agent ACTUALLY has at runtime — the skills installed
    // in its mounted Claude home (data/v2-sessions/<groupId>/.claude-shared/
    // skills/). This is the ground truth the agent itself reports when asked
    // "what commands do you support" (plus Claude Code's own bundled ones,
    // which ship inside the container image and aren't host-enumerable).
    const commands = groupId ? collectAgentCommands(groupId, skillCatalog) : [];
    return {
      claude_md: readCapped('CLAUDE.md'),
      claude_local_md: readCapped('CLAUDE.local.md'),
      shared_md: sharedMd,
      fragments,
      skills,
      commands,
    };
  } catch {
    return null;
  }
}

/** Skill-frontmatter description reader shared by the runtime-skills scan. */
function readSkillDescription(skillMdPath: string): string | null {
  try {
    const head = fs.readFileSync(skillMdPath, 'utf-8').slice(0, 2048);
    const m = /^description:[ \t]*(.*)$/m.exec(head);
    if (!m) return null;
    const inline = m[1].trim();
    if (inline && !/^[>|][+-]?$/.test(inline)) return inline;
    const after = head
      .slice(m.index + m[0].length)
      .split('\n')
      .slice(1);
    const block: string[] = [];
    for (const line of after) {
      if (/^\s+\S/.test(line)) block.push(line.trim());
      else break;
    }
    return block.join(' ') || null;
  } catch {
    return null;
  }
}

/**
 * Runtime skill/command list for one agent group, read from the agent's
 * mounted Claude home: data/v2-sessions/<groupId>/.claude-shared/skills/.
 * Falls back to the shared catalog for descriptions when the skill dir has
 * no SKILL.md frontmatter of its own. Best-effort — [] on any error.
 */
function collectAgentCommands(
  groupId: string,
  skillCatalog: Array<{ name: string; description: string | null }>,
): Array<{ name: string; description: string | null }> {
  try {
    const skillsDir = path.join(DATA_DIR, 'v2-sessions', groupId, '.claude-shared', 'skills');
    return (
      fs
        .readdirSync(skillsDir, { withFileTypes: true })
        // Shared skills are SYMLINKS to the container-internal path
        // (/app/skills/<name>) — dangling on the host, so isDirectory() is
        // false; accept them by name. Agent-installed skills are real dirs.
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => ({
          name: e.name,
          description:
            readSkillDescription(path.join(skillsDir, e.name, 'SKILL.md')) ??
            // Symlinked shared skill → its content lives in the host repo.
            readSkillDescription(path.join(process.cwd(), 'container', 'skills', e.name, 'SKILL.md')) ??
            skillCatalog.find((s) => s.name === e.name)?.description ??
            null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
  } catch {
    return [];
  }
}

/**
 * Built-in MCP tools, enumerated DYNAMICALLY from the agent-runner source
 * (container/agent-runner/src/mcp-tools/<module>.ts) — the literal
 * `tool: { name, description }` definitions the in-container MCP server
 * advertises. Parsed once per process (the source only changes with a host
 * deploy). This keeps the dashboard truthful instead of hand-maintaining a
 * catalog that drifts.
 */
let agentToolsCache: Array<{
  module: string;
  tools: Array<{ name: string; description: string | null }>;
}> | null = null;
function collectAgentTools(): Array<{
  module: string;
  tools: Array<{ name: string; description: string | null }>;
}> {
  if (agentToolsCache) return agentToolsCache;
  const out: Array<{ module: string; tools: Array<{ name: string; description: string | null }> }> = [];
  try {
    const dir = path.join(process.cwd(), 'container', 'agent-runner', 'src', 'mcp-tools');
    const moduleFiles = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !['index.ts', 'server.ts', 'types.ts'].includes(f))
      .sort();
    for (const file of moduleFiles) {
      const src = fs.readFileSync(path.join(dir, file), 'utf-8');
      const tools: Array<{ name: string; description: string | null }> = [];
      // Each tool literal: name: '<snake_case>' followed (within the same
      // object) by description: '...'. Tool names are snake_case — this
      // skips the MCP server name and other identifiers.
      const re =
        /name:\s*'([a-z][a-z0-9_]*)'\s*,\s*description:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const raw = m[2].slice(1, -1).replace(/\\(['"`n])/g, (_, c: string) => (c === 'n' ? ' ' : c));
        // First sentence is enough for the dashboard list.
        const firstSentence = raw.split(/(?<=\.)\s/)[0] ?? raw;
        tools.push({ name: m[1], description: firstSentence.slice(0, 200) || null });
      }
      if (tools.length > 0) out.push({ module: file.replace(/\.ts$/, ''), tools });
    }
  } catch {
    /* missing tree (slimmed install) — empty list, app falls back */
  }
  agentToolsCache = out;
  return out;
}

/**
 * Shared-skills catalog — container/skills/<name>/SKILL.md frontmatter
 * (name + description). Read once per snapshot; doubles as the lookup table
 * that enriches each group's skill fragments with descriptions.
 */
function collectSharedSkills(): Array<{ name: string; description: string | null }> {
  try {
    const skillsDir = path.join(process.cwd(), 'container', 'skills');
    return fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        let description: string | null = null;
        try {
          const head = fs.readFileSync(path.join(skillsDir, e.name, 'SKILL.md'), 'utf-8').slice(0, 2048);
          const m = /^description:[ \t]*(.*)$/m.exec(head);
          if (m) {
            const inline = m[1].trim();
            if (inline && !/^[>|][+-]?$/.test(inline)) {
              description = inline;
            } else {
              // YAML block scalar (description: >- / |) — join the following
              // indented lines until the first dedented one.
              const after = head
                .slice(m.index + m[0].length)
                .split('\n')
                .slice(1);
              const block: string[] = [];
              for (const line of after) {
                if (/^\s+\S/.test(line)) block.push(line.trim());
                else break;
              }
              description = block.join(' ') || null;
            }
          }
        } catch {
          /* no SKILL.md */
        }
        return { name: e.name, description };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** Host package version (package.json at the project root). */
function readHostVersion(): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8')) as {
      version?: string;
    };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Global shared memory — container/CLAUDE.md, the shared base every agent
 * imports via the `.claude-shared.md` symlink (the old groups/global/ dir was
 * cut over into this file; see claude-md-compose.ts). Same for all groups, so
 * read once per snapshot. Best-effort + capped like the per-group files.
 */
function readSharedMd(): string | null {
  try {
    const text = fs.readFileSync(path.join(process.cwd(), 'container', 'CLAUDE.md'), 'utf-8');
    if (!text.trim()) return null;
    return text.length > BRAIN_FILE_CAP ? `${text.slice(0, BRAIN_FILE_CAP)}\n… (truncated)` : text;
  } catch {
    return null;
  }
}

function collectAgentGroups() {
  const sharedMd = readSharedMd();
  const skillCatalog = collectSharedSkills();
  return getAllAgentGroups().map((g) => {
    const sessions = getSessionsByAgentGroup(g.id);
    const running = sessions.filter((s) => s.container_status === 'running' || s.container_status === 'idle');
    const destinations = getDestinations(g.id);
    const members = getMembers(g.id).map((m) => {
      const user = getUser(m.user_id);
      return { ...m, display_name: user?.display_name ?? null };
    });
    const admins = getAdminsOfAgentGroup(g.id).map((a) => {
      const user = getUser(a.user_id);
      return { ...a, display_name: user?.display_name ?? null };
    });

    // Wirings
    const db = getDb();
    const wirings = db
      .prepare(
        `SELECT mga.*, mg.channel_type, mg.platform_id, mg.name as mg_name, mg.is_group, mg.unknown_sender_policy
         FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
         WHERE mga.agent_group_id = ?`,
      )
      .all(g.id) as Array<Record<string, unknown>>;

    return {
      id: g.id,
      name: g.name,
      folder: g.folder,
      agent_provider: g.agent_provider,
      container_config: getContainerConfig(g.id) ?? null,
      brain: collectBrain(g.folder, sharedMd, skillCatalog, g.id),
      sessionCount: sessions.length,
      runningSessions: running.length,
      wirings,
      destinations,
      members,
      admins,
      created_at: g.created_at,
    };
  });
}

function collectSessions() {
  const db = getDb();
  return db
    .prepare(
      `SELECT s.*, ag.name as agent_group_name, ag.folder as agent_group_folder,
              mg.channel_type, mg.platform_id, mg.name as messaging_group_name
       FROM sessions s
       LEFT JOIN agent_groups ag ON ag.id = s.agent_group_id
       LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id
       ORDER BY s.last_active DESC NULLS LAST`,
    )
    .all() as Array<Record<string, unknown>>;
}

function collectChannels() {
  const messagingGroups = getAllMessagingGroups();
  const liveAdapters = getActiveAdapters().map((a) => a.channelType);
  const registeredChannels = getRegisteredChannelNames();

  const byType: Record<string, { channelType: string; isLive: boolean; isRegistered: boolean; groups: unknown[] }> = {};

  for (const mg of messagingGroups) {
    if (!byType[mg.channel_type]) {
      byType[mg.channel_type] = {
        channelType: mg.channel_type,
        isLive: liveAdapters.includes(mg.channel_type),
        isRegistered: registeredChannels.includes(mg.channel_type),
        groups: [],
      };
    }

    const agents = getMessagingGroupAgents(mg.id).map((a) => {
      const group = getAgentGroup(a.agent_group_id);
      return { agent_group_id: a.agent_group_id, agent_group_name: group?.name ?? null, priority: a.priority };
    });

    byType[mg.channel_type].groups.push({
      messagingGroup: {
        id: mg.id,
        platform_id: mg.platform_id,
        name: mg.name,
        is_group: mg.is_group,
        unknown_sender_policy: (mg as unknown as Record<string, unknown>).unknown_sender_policy ?? 'strict',
      },
      agents,
    });
  }

  // Include live adapters with no messaging groups
  for (const ct of liveAdapters) {
    if (!byType[ct]) {
      byType[ct] = { channelType: ct, isLive: true, isRegistered: true, groups: [] };
    }
  }

  return Object.values(byType).sort((a, b) => a.channelType.localeCompare(b.channelType));
}

function collectUsers() {
  return getAllUsers().map((u) => {
    const roles = getUserRoles(u.id);
    const dms = getUserDmsForUser(u.id);

    const db = getDb();
    const memberships = db
      .prepare(
        `SELECT agm.agent_group_id, ag.name as agent_group_name
         FROM agent_group_members agm
         JOIN agent_groups ag ON ag.id = agm.agent_group_id
         WHERE agm.user_id = ?`,
      )
      .all(u.id) as Array<Record<string, unknown>>;

    let privilege = 'none';
    if (roles.some((r) => r.role === 'owner')) privilege = 'owner';
    else if (roles.some((r) => r.role === 'admin' && !r.agent_group_id)) privilege = 'global_admin';
    else if (roles.some((r) => r.role === 'admin')) privilege = 'admin';
    else if (memberships.length > 0) privilege = 'member';

    return {
      id: u.id,
      kind: u.kind,
      display_name: u.display_name,
      privilege,
      roles,
      memberships,
      dmChannels: dms.map((d) => ({ channel_type: d.channel_type })),
      created_at: u.created_at,
    };
  });
}

function collectTokens() {
  const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
  const allEntries: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    agentGroupId: string;
  }> = [];
  const agentGroups = getAllAgentGroups();
  const nameMap = new Map(agentGroups.map((g) => [g.id, g.name]));

  if (fs.existsSync(sessionsDir)) {
    // ALL agent-group dirs — ids are 'ag-<ts>-<rand>' for host-created groups
    // but bare UUIDs for others (the Agent Office roster); the old 'ag-'
    // prefix filter silently dropped every UUID group's transcripts.
    for (const agDir of fs
      .readdirSync(sessionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)) {
      const entries = scanJsonlTokens(path.join(sessionsDir, agDir));
      allEntries.push(...entries.map((e) => ({ ...e, agentGroupId: agDir })));
    }
  }

  const byModel: Record<
    string,
    {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    }
  > = {};
  const byGroup: Record<
    string,
    {
      requests: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      name: string;
    }
  > = {};
  const totals = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };

  for (const e of allEntries) {
    if (!byModel[e.model])
      byModel[e.model] = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    byModel[e.model].requests++;
    byModel[e.model].inputTokens += e.inputTokens;
    byModel[e.model].outputTokens += e.outputTokens;
    byModel[e.model].cacheReadTokens += e.cacheReadTokens;
    byModel[e.model].cacheCreationTokens += e.cacheCreationTokens;

    if (!byGroup[e.agentGroupId])
      byGroup[e.agentGroupId] = {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        name: nameMap.get(e.agentGroupId) || e.agentGroupId,
      };
    byGroup[e.agentGroupId].requests++;
    byGroup[e.agentGroupId].inputTokens += e.inputTokens;
    byGroup[e.agentGroupId].outputTokens += e.outputTokens;
    byGroup[e.agentGroupId].cacheReadTokens += e.cacheReadTokens;
    byGroup[e.agentGroupId].cacheCreationTokens += e.cacheCreationTokens;

    totals.requests++;
    totals.inputTokens += e.inputTokens;
    totals.outputTokens += e.outputTokens;
    totals.cacheReadTokens += e.cacheReadTokens;
    totals.cacheCreationTokens += e.cacheCreationTokens;
  }

  return { totals, byModel, byGroup };
}

function scanJsonlTokens(agentDir: string) {
  const claudeDir = path.join(agentDir, '.claude-shared', 'projects');
  if (!fs.existsSync(claudeDir)) return [];

  const entries: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  }> = [];

  const walk = (dir: string): void => {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.jsonl')) {
          try {
            for (const line of fs.readFileSync(full, 'utf-8').split('\n')) {
              if (!line.trim()) continue;
              try {
                const r = JSON.parse(line);
                if (r.type === 'assistant' && r.message?.usage) {
                  const u = r.message.usage;
                  entries.push({
                    model: r.message.model || 'unknown',
                    inputTokens: u.input_tokens || 0,
                    outputTokens: u.output_tokens || 0,
                    cacheReadTokens: u.cache_read_input_tokens || 0,
                    cacheCreationTokens: u.cache_creation_input_tokens || 0,
                  });
                }
              } catch {
                /* skip line */
              }
            }
          } catch {
            /* skip file */
          }
        }
      }
    } catch {
      /* skip dir */
    }
  };
  walk(claudeDir);
  return entries;
}

function collectContextWindows() {
  const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
  if (!fs.existsSync(sessionsDir)) return [];

  const results: unknown[] = [];
  const agentGroups = getAllAgentGroups();
  const nameMap = new Map(agentGroups.map((g) => [g.id, g.name]));

  // Scan every dir that maps to a LIVE agent group. Keying on the DB roster
  // (not an 'ag-' prefix) both includes UUID-id groups — the prefix filter
  // hid the whole office roster from Context windows — and excludes leftover
  // dirs of deleted groups, which otherwise surface as a bare session UUID.
  for (const agDir of fs.readdirSync(sessionsDir).filter((d) => nameMap.has(d))) {
    const claudeDir = path.join(sessionsDir, agDir, '.claude-shared', 'projects');
    if (!fs.existsSync(claudeDir)) continue;

    // Find most recent JSONL
    const jsonlFiles: string[] = [];
    const walk = (dir: string): void => {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith('.jsonl')) jsonlFiles.push(full);
        }
      } catch {
        /* skip */
      }
    };
    walk(claudeDir);
    if (jsonlFiles.length === 0) continue;

    jsonlFiles.sort((a, b) => {
      try {
        return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });

    // Read last assistant turn from newest file
    const content = fs.readFileSync(jsonlFiles[0], 'utf-8');
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      try {
        const r = JSON.parse(lines[i]);
        if (r.type === 'assistant' && r.message?.usage) {
          const u = r.message.usage;
          const model = r.message.model || 'unknown';
          const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          const max = 200000;
          results.push({
            agentGroupId: agDir,
            agentGroupName: nameMap.get(agDir),
            sessionId: path.basename(jsonlFiles[0], '.jsonl'),
            model,
            contextTokens: ctx,
            outputTokens: u.output_tokens || 0,
            cacheReadTokens: u.cache_read_input_tokens || 0,
            cacheCreationTokens: u.cache_creation_input_tokens || 0,
            maxContext: max,
            usagePercent: max > 0 ? Math.round((ctx / max) * 100) : 0,
            timestamp: r.timestamp || '',
          });
          break;
        }
      } catch {
        /* skip */
      }
    }
  }

  return results;
}

function collectActivity() {
  const now = Date.now();
  const buckets: Record<string, { inbound: number; outbound: number }> = {};

  for (let i = 0; i < 24; i++) {
    const key = new Date(now - i * 3600000).toISOString().slice(0, 13);
    buckets[key] = { inbound: 0, outbound: 0 };
  }

  const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
  if (!fs.existsSync(sessionsDir)) return toBucketArray(buckets);

  const cutoff = new Date(now - 86400000).toISOString();

  try {
    // ALL agent-group dirs — ids are 'ag-<ts>-<rand>' for host-created groups
    // but bare UUIDs for others (the Agent Office roster); the old 'ag-'
    // prefix filter silently dropped every UUID group's transcripts.
    for (const agDir of fs
      .readdirSync(sessionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)) {
      const agPath = path.join(sessionsDir, agDir);
      for (const sessDir of fs.readdirSync(agPath).filter((d) => d.startsWith('sess-'))) {
        for (const [dbName, direction] of [
          ['outbound.db', 'outbound'],
          ['inbound.db', 'inbound'],
        ] as const) {
          const dbPath = path.join(agPath, sessDir, dbName);
          if (!fs.existsSync(dbPath)) continue;
          try {
            const db = new Database(dbPath, { readonly: true });
            const table = direction === 'outbound' ? 'messages_out' : 'messages_in';
            const rows = db.prepare(`SELECT timestamp FROM ${table} WHERE timestamp > ?`).all(cutoff) as {
              timestamp: string;
            }[];
            for (const row of rows) {
              const key = row.timestamp.slice(0, 13);
              if (buckets[key]) buckets[key][direction]++;
            }
            db.close();
          } catch {
            /* skip */
          }
        }
      }
    }
  } catch {
    /* skip */
  }

  return toBucketArray(buckets);
}

function toBucketArray(buckets: Record<string, { inbound: number; outbound: number }>) {
  return Object.entries(buckets)
    .map(([hour, counts]) => ({ hour, ...counts }))
    .sort((a, b) => a.hour.localeCompare(b.hour));
}

function collectMessages() {
  const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
  if (!fs.existsSync(sessionsDir)) return [];

  const results: Array<{ agentGroupId: string; sessionId: string; inbound: unknown[]; outbound: unknown[] }> = [];
  const limit = 50;
  // PER-CATEGORY caps: chat (human conversation) and internal plumbing (task
  // frames, system/cli rows) each get their own newest-N window. A recurring
  // per-minute task otherwise floods the single window and pushes every real
  // chat message out — "Nano's messages are not working". Categorized by
  // `kind`: scheduler writes 'task', host writes 'system'/cli kinds; chat is
  // everything else ('chat', 'chat-sdk', channel-specific kinds).
  const INTERNAL_KINDS = "('task','system')";
  const internalWhere = `(kind IN ${INTERNAL_KINDS} OR kind LIKE 'cli%')`;
  /** Newest `limit` rows of each category, merged back to chronological order. */
  const readSplit = (db: InstanceType<typeof Database>, table: string): unknown[] => {
    const chat = db.prepare(`SELECT * FROM ${table} WHERE NOT ${internalWhere} ORDER BY seq DESC LIMIT ?`).all(limit);
    const internal = db.prepare(`SELECT * FROM ${table} WHERE ${internalWhere} ORDER BY seq DESC LIMIT ?`).all(limit);
    return [...(chat as Array<{ seq: number }>), ...(internal as Array<{ seq: number }>)].sort((a, b) => a.seq - b.seq);
  };

  try {
    // ALL agent-group dirs — ids are 'ag-<ts>-<rand>' for host-created groups
    // but bare UUIDs for others (the Agent Office roster); the old 'ag-'
    // prefix filter silently dropped every UUID group's transcripts.
    for (const agDir of fs
      .readdirSync(sessionsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)) {
      const agPath = path.join(sessionsDir, agDir);
      for (const sessDir of fs.readdirSync(agPath).filter((d) => d.startsWith('sess-'))) {
        const inbound: unknown[] = [];
        const outbound: unknown[] = [];

        const inDbPath = path.join(agPath, sessDir, 'inbound.db');
        if (fs.existsSync(inDbPath)) {
          try {
            const db = new Database(inDbPath, { readonly: true });
            inbound.push(...readSplit(db, 'messages_in'));
            db.close();
          } catch {
            /* skip */
          }
        }

        const outDbPath = path.join(agPath, sessDir, 'outbound.db');
        if (fs.existsSync(outDbPath)) {
          try {
            const db = new Database(outDbPath, { readonly: true });
            outbound.push(...readSplit(db, 'messages_out'));
            db.close();
          } catch {
            /* skip */
          }
        }

        if (inbound.length > 0 || outbound.length > 0) {
          results.push({ agentGroupId: agDir, sessionId: sessDir, inbound, outbound });
        }
      }
    }
  } catch {
    /* skip */
  }

  return results;
}
