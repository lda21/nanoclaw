export const meta = {
  name: 'parity-wave',
  description: 'Ground-truth ADDITIVE build of the NanoDash dashboard-parity wave (Channels, Users, Messages, Agent-Group detail). Audits what actually exists on disk, builds only the missing artifacts in dependency order, integrates, and adversarially verifies the surfaces RENDER — never trusts an agent that claims "done" without files.',
  phases: [{ title: 'Audit' }, { title: 'Foundation' }, { title: 'Screens' }, { title: 'Integrate' }, { title: 'Verify' }],
}

const REPO = '/Users/danelmini/NanoDashRN'
const J = (x) => JSON.stringify(x)
const MAX = 4

async function commitStage(tag, note) {
  try {
    await agent(`In the git repo at ${REPO}: git add -A; git -c commit.gpgsign=false commit -m "wf(${tag}): ${note}" --no-verify; git push origin HEAD. If "nothing to commit", confirm. Only stage/commit/push — do not modify source. Report the commit hash or "nothing to commit".`, { label: `commit:${tag}`, phase: 'Integrate' })
  } catch (e) { log(`commit:${tag} failed: ${String((e && e.message) || e)}`) }
}

// An attempt that fails on throw OR empty output. Callers VERIFY artifacts on disk
// afterward (the build agent's word is never the source of truth).
async function attempt(label, phase, prompt) {
  let out = null
  try { out = await agent(prompt, { label, phase }) } catch (e) { return { ok: false, reason: String((e && e.message) || e).slice(0, 120) } }
  const t = typeof out === 'string' ? out : out == null ? '' : JSON.stringify(out)
  return t && t.trim().length >= 60 ? { ok: true, text: t.trim() } : { ok: false, reason: 'empty output' }
}
async function withRetry(label, phase, prompt, max) {
  let last = null
  for (let i = 1; i <= max; i++) { last = await attempt(i === 1 ? label : `${label}:r${i}`, phase, prompt); if (last.ok) return last; log(`${label} ${i}/${max} failed (${last.reason})`) }
  return { ok: false, reason: last ? last.reason : 'unknown' }
}

const CONV = `Match v1 conventions EXACTLY (study them first): app screens in app/src/features/<name>/<Name>Screen.tsx re-exported by thin route files under app/app/; reuse the NDColor theme + themed components + FlashList + skeleton/empty/error + pull-to-refresh + the existing api client/polling hooks + telemetry breadcrumbs. Backend routes in backend/src/http/app.ts + methods in backend/src/host/hostClient.ts, bearer-authed, 503-on-HostUnavailable like the v1 routes. Reuse/extend shared DTOs (keep types-drift CI green); NEVER reference DASHBOARD_SECRET in the app tree (token-isolation CI). HOST endpoints already exist at /Users/danelmini/nanoclaw-dashboard (router.ts: /api/channels, /api/users, /api/messages?agentGroupId&sessionId, /api/agent-groups/:id; types.ts: ChannelInfo/UserInfo/AgentGroupInfo). Do NOT break v1.`

// ── 1. AUDIT (ground truth: which parity artifacts already exist?) ───────────
phase('Audit')
const AUDIT = {
  type: 'object', additionalProperties: false,
  properties: {
    backend: { type: 'boolean' }, hooks: { type: 'boolean' },
    channels: { type: 'boolean' }, users: { type: 'boolean' }, messages: { type: 'boolean' }, agentGroupDetail: { type: 'boolean' },
    e2e: { type: 'boolean' }, gaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['backend', 'hooks', 'channels', 'users', 'messages', 'agentGroupDetail', 'e2e', 'gaps'],
}
const audit = await agent(
  `Audit the repo at ${REPO} on disk for the dashboard-parity wave. Report which of these GENUINELY exist as real code (not stubs):\n- backend: getChannels/getUsers/getAgentGroup/getMessages in hostClient.ts AND the 4 routes (/api/channels, /api/users, /api/agent-groups/:id, /api/messages) in app.ts\n- hooks: useChannels/useUsers/useAgentGroup/useMessages (+ qk keys) in app/src/api/queries.ts and exported from app/src/api\n- channels/users/messages/agentGroupDetail: each feature screen + its route file\n- e2e: specs covering the 4 new surfaces\nList concrete gaps.`,
  { label: 'audit', phase: 'Audit', schema: AUDIT })
log(`Audit: backend=${audit.backend} hooks=${audit.hooks} channels=${audit.channels} users=${audit.users} messages=${audit.messages} agentGroupDetail=${audit.agentGroupDetail} e2e=${audit.e2e}`)

// ── 2. FOUNDATION (backend routes + DTOs + app hooks — screens depend on it) ──
phase('Foundation')
if (!audit.backend || !audit.hooks) {
  await withRetry('foundation', 'Foundation',
    `Build the data FOUNDATION for the parity wave in ${REPO} (screens depend on it, so do this first):\n(a) shared DTOs for the 4 surfaces (MsgItem/MessagesResponse, ChannelsResponse, UsersResponse, AgentGroupDetailResponse) in shared/responses.ts, vendored to app + backend per the existing drift-guard.\n(b) backend: add getChannels/getUsers/getAgentGroup(id)/getMessages(agentGroupId,sessionId) to hostClient.ts (reuse its getJson timeout+backoff) and register GET /api/channels, /api/users, /api/agent-groups/:id, /api/messages in app.ts (bearer-authed, 503-on-HostUnavailable). /api/messages requires agentGroupId+sessionId → 400 if missing.\n(c) app: add useChannels/useUsers/useAgentGroup/useMessages query hooks + qk keys in app/src/api/queries.ts and export from app/src/api.\nRun typecheck for backend; make IT pass. ${CONV}`, MAX)
  await commitStage('parity-foundation', 'backend routes + DTOs + app hooks')
}

// ── 3. SCREENS (parallel — each writes its own disjoint feature folder) ──────
phase('Screens')
const SCREENS = [
  { key: 'channels', title: 'Channels', need: !audit.channels, desc: 'channel types with live/registered status, messaging groups per channel, unknown-sender policy badges. Add as a tab or a More-hub entry.' },
  { key: 'users', title: 'Users', need: !audit.users, desc: 'user list with privilege hierarchy (owner>global_admin>admin>member), roles, group memberships, DM channels. Tab or More-hub.' },
  { key: 'agent-groups', title: 'AgentGroupDetail', need: !audit.agentGroupDetail, desc: 'detail for one agent group: wirings, destinations, members, admins, its sessions, container config. Route app/app/agent-groups/[id].tsx; deep-linked from Overview + Sessions.' },
  { key: 'messages', title: 'Messages', need: !audit.messages, desc: 'per-session inbound/outbound messages; reachable from a Session (a "View messages" affordance on SessionDetail).' },
]
async function buildScreen(s) {
  const r = await withRetry(`screen:${s.key}`, 'Screens',
    `Implement ONLY the ${s.title} screen in ${REPO} using the foundation hooks already added. ${s.desc}\nWrite app/src/features/${s.key}/${s.title}Screen.tsx (+ its route file) and export it; use the matching query hook. Render skeleton/empty/error + pull-to-refresh + a track('${s.key}.view') breadcrumb.\nHARD RULES (other screen agents run concurrently): touch ONLY this screen's own files; do NOT edit shared barrels/_layout/package.json/tabs config — note nav wiring needed in your summary. Do NOT run install/git.\n${CONV}`, MAX)
  return { key: s.key, ok: r.ok, summary: r.ok ? r.text : r.reason }
}
const todo = SCREENS.filter((s) => s.need)
const built = (await parallel(todo.map((s) => () => buildScreen(s)))).filter(Boolean)
await commitStage('parity-screens', `${built.filter((b) => b.ok).length}/${todo.length} screens`)

// ── 4. INTEGRATE (wire nav + deep-links, install, make WHOLE thing green) ────
phase('Integrate')
await withRetry('integrate', 'Integrate',
  `Integrate the parity wave in ${REPO}: wire navigation (add Channels/Users to the tab bar or a More hub WITHOUT cluttering the 4 core tabs; register app/app/agent-groups/[id].tsx in the protected stack in _layout.tsx; add deep-links from Overview+Sessions to the agent-group detail; add the "View messages" affordance on SessionDetail), export all new screens/hooks from the barrels, add any missing deps. Then install and run typecheck+build+lint for the WHOLE project and FIX every error until clean. Commit+push (wf(integrate)). Report the commands + results.\nSCREEN SUMMARIES: ${J(built.map((b) => ({ key: b.key, ok: b.ok, summary: String(b.summary).slice(0, 300) })))}\n${CONV}`, MAX)
await commitStage('parity-integrate', 'nav wired + green build')

// ── 5. VERIFY LOOP (ground truth: artifacts exist + render + build; remediate) ─
phase('Verify')
const VSCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { passed: { type: 'boolean' }, gaps: { type: 'array', items: { type: 'string' } } },
  required: ['passed', 'gaps'],
}
let verdict = { passed: false, gaps: [] }
for (let r = 1; r <= 3; r++) {
  verdict = await agent(
    `Adversarially VERIFY the parity wave in ${REPO} ON DISK (do not trust prior claims). Confirm ALL exist as real, wired code AND the project builds: (1) backend has the 4 routes + hostClient methods; (2) app has Channels/Users/Messages/AgentGroupDetail screens + route files, exported, in nav/deep-links; (3) RUN typecheck+build+lint for app+backend — must be green; (4) add/extend e2e (e2e/) so AFTER login it navigates to each of the 4 surfaces and asserts each RENDERS real content + fails on console/page errors, on chromium AND mobile-safari, and RUN them green; (5) v1 e2e still green. Pass ONLY if every item holds. List concrete gaps.`,
    { label: `verify:r${r}`, phase: 'Verify', schema: VSCHEMA })
  if (verdict.passed) { log(`Verify r${r}: PASS`); break }
  log(`Verify r${r}: ${verdict.gaps.length} gap(s) — remediating`)
  await withRetry(`verify:fix:r${r}`, 'Verify',
    `Fix ALL these gaps in ${REPO} with real, wired code until app+backend build/typecheck/lint clean, the 4 parity surfaces render, and the new + v1 e2e pass on both engines. Commit+push (wf(verify): fix r${r}).\nGAPS:\n${J(verdict.gaps)}\n${CONV}`, MAX)
  await commitStage(`parity-verify-fix-r${r}`, 'resolved verify gaps')
}

return { repo: REPO, audit, screensBuilt: built.map((b) => ({ key: b.key, ok: b.ok })), verified: verdict.passed, remainingGaps: verdict.passed ? [] : verdict.gaps }
