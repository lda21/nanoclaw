#!/usr/bin/env node
/**
 * Upstream watcher — fires a WhatsApp DM through the running NanoClaw when
 * `upstream/main` (nanocoai/nanoclaw) moves ahead of the local fork `main`.
 *
 * Runs on the HOST (the agent container has no git repo mounted). Delivers via
 * writeOutboundDirect — the same host-side path router.ts uses for command-gate
 * denials — so no container is woken and no agent tokens are spent.
 *
 * State file records the last upstream HEAD we alerted on, so a standing
 * backlog notifies ONCE, not every run. `--test` forces one message and does
 * NOT touch state.
 *
 * Invoked by launchd: ~/Library/LaunchAgents/com.nanoclaw.upstream-watch.plist
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const REPO = '/Users/danelmini/nanoclaw-v2';
const GIT = '/opt/homebrew/bin/git';
const STATE = path.join(REPO, 'data', '.upstream-watch.json');
const LOG = path.join(REPO, 'logs', 'upstream-watch.log');
const MG = 'mg-1780301735799-iotd9w'; // WhatsApp DM messaging group ("Nano" — Danel's DM)
const TEST = process.argv.includes('--test');

function log(m) {
  const line = `[${new Date().toISOString()}] ${m}\n`;
  try { appendFileSync(LOG, line); } catch { /* logs dir may not exist yet */ }
  process.stdout.write(line);
}
function git(args) {
  return execFileSync(GIT, ['-C', REPO, ...args], { encoding: 'utf8' }).trim();
}

async function main() {
  try {
    git(['fetch', 'upstream', '--quiet']);
  } catch (e) {
    log('fetch failed (offline?): ' + e.message);
    return;
  }

  let n = 0, head = '', subject = '';
  try {
    head = git(['rev-parse', 'upstream/main']);
    n = parseInt(git(['rev-list', '--count', 'main..upstream/main']) || '0', 10);
    if (n > 0) subject = git(['log', '-1', '--format=%s', 'upstream/main']);
  } catch (e) {
    log('compare failed: ' + e.message);
    return;
  }

  let last = '';
  if (existsSync(STATE)) {
    try { last = JSON.parse(readFileSync(STATE, 'utf8')).head || ''; } catch { /* ignore */ }
  }

  if (!TEST) {
    if (n === 0) { log('upstream unchanged (N=0) — silent'); return; }
    if (head === last) { log(`already alerted for ${head.slice(0, 7)} (N=${n}) — silent`); return; }
  }

  const text = TEST
    ? "✅ NanoClaw upstream watcher is live. You'll only get a WhatsApp here when nanocoai/nanoclaw has new commits to sync. (test — nothing to do)"
    : `🔔 NanoClaw upstream moved: ${n} new commit${n > 1 ? 's' : ''}.\nLatest: ${subject}\nRun /update-nanoclaw to sync.`;

  // Resolve the live session + delivery address for the WhatsApp DM.
  const { default: Database } = await import('better-sqlite3');
  const cdb = new Database(path.join(REPO, 'data', 'v2.db'), { readonly: true });
  const row = cdb
    .prepare(
      `SELECT s.id AS sid, s.agent_group_id AS agid, s.thread_id AS tid,
              m.platform_id AS pid, m.channel_type AS ct
         FROM sessions s JOIN messaging_groups m ON m.id = s.messaging_group_id
        WHERE s.messaging_group_id = ? ORDER BY s.id DESC LIMIT 1`,
    )
    .get(MG);
  cdb.close();

  if (!row) { log(`no session found for messaging group ${MG} — cannot deliver`); return; }

  // Inbound is host-owned, so we inject a one-shot task. The host-sweep wakes
  // the container; the Nano agent emits the message verbatim, which the normal
  // delivery path sends to the WhatsApp DM. (Outbound.db is container-owned and
  // host-readonly, so we can't write it directly.)
  const prompt =
    `[Automated upstream watcher — not from a human] Send the message below to the user as your ENTIRE reply, ` +
    `verbatim, with no preamble, no commentary, no tool calls, and no memory updates:\n\n${text}`;

  const { openInboundDb } = await import(pathToFileURL(path.join(REPO, 'dist', 'session-manager.js')).href);
  const { insertTask } = await import(pathToFileURL(path.join(REPO, 'dist', 'modules', 'scheduling', 'db.js')).href);
  const inDb = openInboundDb(row.agid, row.sid);
  try {
    insertTask(inDb, {
      id: `upstream-watch-${Date.now()}`,
      processAfter: new Date().toISOString(),
      recurrence: null,
      platformId: row.pid,
      channelType: row.ct,
      threadId: row.tid || null,
      content: JSON.stringify({ prompt, script: null }),
    });
  } finally {
    inDb.close();
  }

  log(`queued WhatsApp alert task (test=${TEST}, n=${n}, head=${head.slice(0, 7)}) -> session ${row.sid}`);

  if (!TEST) {
    writeFileSync(STATE, JSON.stringify({ head, n, notifiedAt: new Date().toISOString() }, null, 2));
  }
}

main().catch((e) => { log('unexpected error: ' + (e && e.stack ? e.stack : e)); });
