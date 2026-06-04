export const meta = {
  name: 'additive-wave',
  description: 'Reusable GROUND-TRUTH additive build: add feature "surfaces" to an EXISTING repo. Audits disk for what genuinely exists, builds only the missing surfaces in dependency order (foundation → screens in parallel → integrate), then a deterministic git-diff gate (the SCRIPT parses `git diff --numstat` + `git ls-files`) proves each surface left real files — built surfaces must appear in the diff, audit-skipped ones must exist on disk — re-implementing any that did not, with a hard-failure terminal state. Adversarial render-asserting verify on top. Never trusts an agent that claims "done" without files.',
  whenToUse: 'Adding screens/endpoints/features to an EXISTING app, where greenfield-scaffold framing mis-fits and a build can falsely report "done" without writing files. The ground truth is the disk (parsed git diff) + the build + render-asserting e2e — never an agent\'s self-report. Pass STRUCTURED args: {repo, conventions, surfaces:[{key,title,desc,route?}], foundation?, e2e?}.',
  phases: [{ title: 'Audit' }, { title: 'Foundation' }, { title: 'Screens' }, { title: 'Integrate' }, { title: 'Verify' }],
}

// ── args (STRUCTURED) ─────────────────────────────────────────────────────────
let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch (e) { A = {} } }
if (!A || typeof A !== 'object' || Array.isArray(A)) A = {}
const cfg = A
const REPO = cfg.repo || cfg.path || null
const CONV = cfg.conventions || cfg.conv || ''
const SURFACES = Array.isArray(cfg.surfaces) ? cfg.surfaces.filter((s) => s && s.key && s.title) : []
const FOUNDATION = cfg.foundation || null // { desc } — shared data layer the surfaces depend on (optional)
const E2E = cfg.e2e || null               // { desc } — bespoke e2e instructions (optional)
const MAX = cfg.maxRetry ?? 4
const ROUNDS = cfg.maxRounds ?? 3
const MIN_ADDED = cfg.minAdded ?? 12      // a "landed" file must add at least this many lines (defeats empty stubs/shims)
const J = (x) => JSON.stringify(x)

if (!REPO) return { error: 'additive-wave requires args.repo (a real repo path). Pass {repo, surfaces} as a STRUCTURED object.' }
if (!SURFACES.length) return { error: 'additive-wave requires args.surfaces:[{key,title,desc,route?}] (at least one).' }

const CONVBLOCK = `Match the repo's conventions EXACTLY (study them on disk first).${CONV ? ' ' + CONV : ''} Do NOT break existing features.`

// ── helpers (empty output = failure; commit every stage) ──────────────────────
async function commitStage(tag, note) {
  try {
    await agent(`In the git repo at ${REPO}: git add -A; git -c commit.gpgsign=false commit -m "wf(${tag}): ${note}" --no-verify; git push origin HEAD. If "nothing to commit", confirm. Only stage/commit/push — do not modify source. Report the commit hash or "nothing to commit".`, { label: `commit:${tag}`, phase: 'Integrate' })
  } catch (e) { log(`commit:${tag} failed: ${String((e && e.message) || e)}`) }
}
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

// ── deterministic ground-truth (the SCRIPT parses git; the agent is a terminal) ─
const IGNORE_PATH = /(^|\/)(node_modules|dist|build|coverage|\.expo|\.next|\.turbo)\//
const LOCK_PATH = /(package-lock\.json|pnpm-lock\.yaml|bun\.lock(b)?|yarn\.lock)$/
const NAVISH = /(^|\/)(index|route|routes|_layout|nav|navigation)\.[a-z0-9]+$/i // route/nav shim, not a screen
const STUB_MARKERS = 'TODO|FIXME|coming soon|not implemented|unimplemented|placeholder|stub'
const SUBSTANCE = cfg.minLines ?? 25 // an audit-skipped (pre-existing) surface file must have at least this many lines
// Defensive rename handling: keep the NEW path if a "{old => new}"/"old => new" slips through.
function newPath(p) {
  let s = String(p).trim()
  const brace = s.match(/^(.*)\{.* => (.*)\}(.*)$/)
  if (brace) s = (brace[1] + brace[2] + brace[3]).replace(/\/{2,}/g, '/')
  else if (s.includes(' => ')) s = s.split(' => ').pop().trim()
  return s
}
function parseReal(numstat) {
  const files = []
  for (const line of String(numstat || '').split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
    if (!m) continue
    const path = newPath(m[3])
    if (!path || IGNORE_PATH.test(path) || LOCK_PATH.test(path)) continue
    files.push({ path, added: m[1] === '-' ? 0 : parseInt(m[1], 10) })
  }
  return files
}
function norm(p) { return String(p).replace(/^\.?\/*/, '').toLowerCase() }
function keyToken(k) { return norm(k).replace(/[-_\s]/g, '') }
function toStubSet(stubgrep) {
  return new Set(String(stubgrep || '').split('\n').map((l) => norm(l.split(':')[0].trim())).filter(Boolean))
}
// A surface "landed in the diff" if some changed file (>= MIN_ADDED added lines,
// NOT a route/nav shim, NOT flagged a stub) is named/located for the surface:
// a path segment equal to the key/token (e.g. features/users/…) OR a file whose
// stem is the key or <key>screen/page/view/detail/list. No bare startsWith, so
// `usersettings`/`users-mock` no longer false-match `users`. The render-assert
// e2e in Verify is the substance backstop on top of this.
function surfaceInDiff(s, files, stubSet) {
  const k = norm(s.key); const tok = keyToken(s.key); const route = s.route ? norm(s.route) : ''
  const allow = new Set([tok, tok + 'screen', tok + 'page', tok + 'view', tok + 'detail', tok + 'list'])
  return files.some((ch) => {
    if (ch.added < MIN_ADDED) return false
    const nc = norm(ch.path)
    if ((stubSet && stubSet.has(nc)) || NAVISH.test(nc)) return false
    const segs = nc.split('/'); const baseStem = (segs[segs.length - 1] || '').replace(/\.[a-z0-9]+$/, '')
    if (segs.some((seg) => seg === k || keyToken(seg) === tok)) return true
    if (allow.has(keyToken(baseStem))) return true
    if (route && nc.includes(route)) return true
    return false
  })
}
async function gitRef(label) {
  const r = await agent(`In ${REPO}: run \`git rev-parse HEAD\` and return ONLY the 40-char hash as your entire output (no prose).`, { label, phase: 'Verify' })
  return String(typeof r === 'string' ? r : '').trim().split(/\s+/)[0] || ''
}
const GATE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    numstat: { type: 'string' },
    stubgrep: { type: 'string' },
    lsfiles: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { key: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } }, maxLines: { type: 'number' } }, required: ['key', 'paths'] } },
  },
  required: ['numstat', 'lsfiles'],
}
async function gateEvidence(baseRef, label) {
  const out = await agent(
    `In ${REPO}, gather GROUND-TRUTH evidence — do NOT modify anything, do NOT summarize. (1) Paste RAW \`git diff --numstat --no-renames ${baseRef} HEAD\` verbatim as numstat. (2) From those changed paths run \`git grep -nIE "${STUB_MARKERS}" -- <paths>\` -> stubgrep (raw; empty if none). (3) For EACH surface key [${SURFACES.map((s) => s.key).join(', ')}], run \`git ls-files\` and return lsfiles:[{key, paths:[tracked source files that actually implement that surface — screen + route + handler], maxLines:<the largest \`wc -l\` among those files, 0 if none>}]. Real paths only.`,
    { label, phase: 'Verify', schema: GATE_SCHEMA })
  return out && typeof out === 'object' ? out : { numstat: '', stubgrep: '', lsfiles: [] }
}

// ── 1. AUDIT (ground truth: which surfaces already exist as real code?) ───────
phase('Audit')
const auditProps = { foundation: { type: 'boolean' }, e2e: { type: 'boolean' }, gaps: { type: 'array', items: { type: 'string' } } }
for (const s of SURFACES) auditProps[s.key] = { type: 'boolean' }
const AUDIT = { type: 'object', additionalProperties: false, properties: auditProps, required: ['gaps', 'foundation', 'e2e', ...SURFACES.map((s) => s.key)] }
const auditList = SURFACES.map((s) => `- ${s.key}: a real, wired ${s.title} surface — ${s.desc}`).join('\n')
const audit = await agent(
  `Audit the repo at ${REPO} ON DISK for an ADDITIVE wave. Report which of these GENUINELY exist as real, wired code (NOT stubs/placeholders/empty surfaces):\n${FOUNDATION ? `- foundation: ${FOUNDATION.desc}\n` : '- foundation: any shared data layer (DTOs/routes/hooks) these surfaces depend on\n'}${auditList}\n- e2e: tests covering these surfaces\nList concrete gaps with real paths.`,
  { label: 'audit', phase: 'Audit', schema: AUDIT })
log(`Audit: ${SURFACES.map((s) => `${s.key}=${!!audit[s.key]}`).join(' ')} foundation=${audit.foundation} e2e=${audit.e2e}`)

// ── 2. FOUNDATION (data layer the surfaces depend on — build it first) ────────
phase('Foundation')
if (FOUNDATION && !audit.foundation) {
  await withRetry('foundation', 'Foundation',
    `Build the data FOUNDATION the surfaces depend on (screens depend on it, so do this first): ${FOUNDATION.desc}\nYou MUST write REAL files. Run the relevant typecheck/build and make it pass.\n${CONVBLOCK}`, MAX)
  await commitStage('aw-foundation', 'data foundation (DTOs/routes/hooks)')
}

// GROUND-TRUTH baseline: captured AFTER foundation so its churn can't mask a
// hollow screens build. Memoized → stable across resume.
const baseRef = await gitRef('aw:base')

// ── 3. SCREENS (parallel — each writes its own disjoint files) ────────────────
phase('Screens')
const todo = SURFACES.filter((s) => !audit[s.key])
async function buildSurface(s) {
  const r = await withRetry(`surface:${s.key}`, 'Screens',
    `Implement ONLY the ${s.title} surface in ${REPO}. ${s.desc}\n${s.route ? `Route/entry: ${s.route}. ` : ''}You MUST write REAL, substantive files for this surface — returning a description WITHOUT changing files is a FAILURE, and a git-diff check will catch an empty stub. Render loading/empty/error states + refresh, and a telemetry breadcrumb if the repo has one.\nHARD RULES (other surface agents run concurrently): touch ONLY this surface's OWN files; do NOT edit shared barrels/layout/config/package.json — note any nav wiring needed in your summary. Do NOT run install/git.\n${CONVBLOCK}`, MAX)
  return { key: s.key, ok: r.ok, summary: r.ok ? r.text : r.reason }
}
const built = (await parallel(todo.map((s) => () => buildSurface(s)))).filter(Boolean)
await commitStage('aw-screens', `${built.filter((b) => b.ok).length}/${todo.length} surfaces`)

// ── 4. INTEGRATE (wire nav/deep-links, install, whole-project green) ──────────
phase('Integrate')
await withRetry('integrate', 'Integrate',
  `Integrate the additive wave in ${REPO}: wire navigation/routes/deep-links for the new surfaces (without cluttering the core navigation), export them from the barrels, add any missing deps. Then install and run typecheck+build+lint for the WHOLE project and FIX every error until clean. Commit+push (wf(aw-integrate)). Report the exact commands + results.\nSURFACE SUMMARIES: ${J(built.map((b) => ({ key: b.key, ok: b.ok, summary: String(b.summary).slice(0, 300) })))}\n${CONVBLOCK}`, MAX)
await commitStage('aw-integrate', 'nav wired + green build')

// ── 5. GROUND-TRUTH GATE (deterministic: built ⇒ in diff, existing ⇒ on disk) ─
// The SCRIPT parses `git diff --numstat --no-renames` + `git ls-files` line
// counts; built surfaces must show real new code, audit-skipped ones must exist
// on disk with >= SUBSTANCE lines. RESIDUAL (defense-in-depth): git output is
// agent-pasted (sandbox can't exec git) and a compiling stub at a surface-named
// path is the render-asserting Verify e2e's job to catch, not this gate's. The
// gate's hard guarantee is: a surface with NO real file fails closed.
phase('Verify')
let GT = { clean: true, missing: [] }
for (let g = 1; g <= ROUNDS; g++) {
  const ev = await gateEvidence(baseRef, `aw:gate:r${g}`)
  const files = parseReal(ev.numstat)
  const stubSet = toStubSet(ev.stubgrep)
  const lsmap = {}
  for (const e of (ev.lsfiles || [])) lsmap[e.key] = { paths: (e.paths || []).filter(Boolean), maxLines: e.maxLines || 0 }
  const missing = SURFACES.filter((s) => {
    if (todo.find((t) => t.key === s.key)) return !surfaceInDiff(s, files, stubSet) // built this wave ⇒ must show real new code
    const m = lsmap[s.key] || { paths: [], maxLines: 0 }                            // audit-skipped ⇒ must exist on disk WITH substance
    return m.paths.length === 0 || m.maxLines < SUBSTANCE
  }).map((s) => s.key)
  GT = { clean: missing.length === 0, missing }
  if (GT.clean) { log(`Ground truth r${g}: all ${SURFACES.length} surfaces present (built in diff / existing on disk)`); break }
  log(`⛔ Ground truth r${g}: surfaces with NO real file: ${missing.join(', ')} — re-implementing for real`)
  const detail = SURFACES.filter((s) => missing.includes(s.key)).map((s) => ({ key: s.key, title: s.title, desc: s.desc, route: s.route || null }))
  await withRetry(`aw:gt:r${g}`, 'Verify',
    `GROUND-TRUTH FAILURE in ${REPO}: these surfaces were claimed built/existing but have NO real file on disk: ${J(detail)}. Implement them for real (substantive code — empty stubs do NOT count), wire navigation, make the whole project build green, commit+push (wf(aw-gt): r${g}).\n${CONVBLOCK}`, MAX)
  await commitStage(`aw-gt-r${g}`, 'reimplemented missing surfaces')
}
if (!GT.clean) log(`⛔ Ground truth NOT clean after ${ROUNDS} rounds — missing surfaces: ${GT.missing.join(', ')}. verified will be forced false.`)

// ── 6. VERIFY LOOP (render-asserting e2e + build; remediate) ───────────────────
const VSCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    passed: { type: 'boolean' }, buildGreen: { type: 'boolean' },
    surfacesPresent: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { key: { type: 'string' }, present: { type: 'boolean' } }, required: ['key', 'present'] } },
    gaps: { type: 'array', items: { type: 'string' } },
  },
  required: ['passed', 'buildGreen', 'surfacesPresent', 'gaps'],
}
const surfaceList = SURFACES.map((s) => s.title).join(', ')
let verdict = { passed: false, gaps: [] }
for (let r = 1; r <= ROUNDS; r++) {
  const seed = GT.clean ? [] : [`Ground-truth missing surfaces: ${GT.missing.join(', ')}`]
  verdict = await agent(
    `Adversarially VERIFY the additive wave in ${REPO} ON DISK (do NOT trust prior claims). For the surfaces [${surfaceList}]: (0) return surfacesPresent[{key,present}] — each must have its file(s) + route, exported, reachable in nav/deep-links, rendering real data. (a) RUN typecheck+build+lint for the whole project — set buildGreen. (b) ${E2E ? E2E.desc : `add/extend e2e so that AFTER the app's normal entry it navigates to EACH surface and asserts each RENDERS real content (a blank/stuck/error state does NOT count) and FAILS on any console/page error`}, and RUN them green. (c) pre-existing tests still green. Pass ONLY if every surface present, buildGreen, and tests green. List concrete gaps.\nKNOWN UNRESOLVED (must fix): ${J(seed)}`,
    { label: `verify:r${r}`, phase: 'Verify', schema: VSCHEMA })
  const absent = (verdict.surfacesPresent || []).filter((s) => !s.present).map((s) => s.key)
  if (verdict.passed && verdict.buildGreen && absent.length === 0) { log(`Verify r${r}: PASS`); verdict.passed = true; break }
  verdict.passed = false
  const gaps = [...(verdict.gaps || []), ...(absent.length ? [`Missing/blank surfaces: ${absent.join(', ')}`] : []), ...(verdict.buildGreen ? [] : ['build not green'])]
  log(`Verify r${r}: ${gaps.length} gap(s) — remediating`)
  await withRetry(`verify:fix:r${r}`, 'Verify',
    `Fix ALL these gaps in ${REPO} with real, wired code until the project builds clean, every surface renders, and new + existing tests pass. Commit+push (wf(aw-verify): fix r${r}).\nGAPS:\n${J(gaps)}\n${CONVBLOCK}`, MAX)
  await commitStage(`aw-verify-fix-r${r}`, 'resolved verify gaps')
}

const verified = !!verdict.passed && GT.clean
return { repo: REPO, audit, groundTruth: GT, surfacesBuilt: built.map((b) => ({ key: b.key, ok: b.ok })), verified, remainingGaps: verified ? [] : [...GT.missing.map((m) => `missing:${m}`), ...(verdict.gaps || [])] }
