export const meta = {
  name: 'sdlc-prod',
  description: 'Hardened SDLC build workflow (v3): spec-contract gate (criteria→task coverage matrix, script-enforced; deferral detection), parallel build with retry, a deterministic git-numstat GROUND-TRUTH gate (the SCRIPT parses the diff — a build that wrote no real files is re-run, never shipped, and forces deployReady=false), post-build adversarial refuter wave, per-stage commits, parallel render-asserting QA tiers, a lessons stage — and it drives the built system to embody 14 architecture principles.',
  whenToUse: 'Any substantial build/extend on a repo where you want production-grade orchestration AND a product that is observable, durable, resilient, idempotent, secure, auditable, testable. Detects greenfield vs existing repo (schema boolean) and plans the delta either way; never clobbers an existing tree. Pass {repo, brief} (NOT a prose string).',
  phases: [
    { title: 'Intake' },
    { title: 'PRD' },
    { title: 'Architecture' },
    { title: 'Plan' },
    { title: 'Build' },
    { title: 'Refute' },
    { title: 'Verify' },
    { title: 'QA' },
    { title: 'Acceptance' },
    { title: 'Manifest' },
  ],
}

/*
 * ── How this workflow covers the 14 architecture principles ──────────────────
 * [HARNESS] = how the WORKFLOW RUN itself honors it; [BUILT] = how it forces the
 * PRODUCT to honor it (injected into prompts + checked in Verify/QA/Acceptance).
 *
 * Observability  [HARNESS] log() per step + run journal + committed run manifest
 *                [BUILT]   structured logs, request IDs, metrics, error tracking
 * Scalability    [HARNESS] parallel() fan-out to the concurrency cap
 *                [BUILT]   stateless services + async/queue patterns
 * Durability     [HARNESS] git commit+push after EVERY stage + resume journal
 *                [BUILT]   persist state to a durable store after each step
 * Resilience     [HARNESS] per-step retry (empty/error = fail), bounded converge loops
 *                [BUILT]   retries/timeouts/circuit-breakers/DLQ in the product
 * Recoverability [HARNESS] resume via {scriptPath, resumeFromRunId} + git state
 *                [BUILT]   product resumes from last good checkpoint
 * Idempotency    [HARNESS] every stage re-runnable against GROUND TRUTH (audit-before-do; additive plans the delta)
 *                [BUILT]   each product step idempotent (idempotency keys/upserts)
 * Correctness    [HARNESS] git-numstat GROUND-TRUTH gate: the SCRIPT (not an agent) parses the diff; a task that
 *                          claims "done" but left no real file (>= MIN_ADDED lines at its declared path) is a GHOST
 *                          and is re-implemented; a still-hollow build after N rounds forces deployReady=false
 *                [BUILT]   (guards the harness against shipping a hollow/destructive build)
 * Security       [HARNESS] secrets never in args/logs/prompts; least privilege
 *                [BUILT]   per-action authz, secret protection, encryption, service isolation
 * Auditability   [HARNESS] git author+message trail + run manifest + approval gate
 *                [BUILT]   product audit log (actor, change, reason, prev/new state, approvals)
 * Consistency    [HARNESS] one logical change per stage; colliding tasks serialized, shared edits deferred to integrate
 *                [BUILT]   transactions per step; Saga/compensation across steps
 * Maintainability[HARNESS] small phases with schema'd input/output contracts
 *                [BUILT]   small, independent, versioned modules with clear contracts
 * Testability    [HARNESS] verify gate + tiered QA incl. FAILURE scenarios + render-assert
 *                [BUILT]   unit+integration+e2e, render-assert success surface, FAIL on console/page errors
 * Performance    [HARNESS] parallel where safe; cached design via resume; no busy-polling
 *                [BUILT]   async, caching, no blocking long-running steps
 * Extensibility  [HARNESS] config-driven — args control tasks/stopAfter/fanout
 *                [BUILT]   add/remove/reorder steps via config / workflow definition
 * Cost Efficiency[HARNESS] concurrency cap, ground-truth = no re-doing done work, budget-aware
 *                [BUILT]   scale workers to demand; avoid polling/duplicated jobs
 * ────────────────────────────────────────────────────────────────────────────
 */

// ---- args (STRUCTURED — never a prose string; that leaves repo null) --------
let A = args
if (typeof A === 'string') {
  const t = A.trim()
  try {
    A = t.startsWith('{') ? JSON.parse(t) : { brief: A }
  } catch (e) {
    A = { brief: A }
  }
}
if (!A || typeof A !== 'object' || Array.isArray(A)) A = {}
const cfg = A
const REPO = cfg.repo || cfg.path || null
const BRIEF = cfg.brief || cfg.discovery || ''
const J = (x) => JSON.stringify(x)
const MAX_RETRY = cfg.maxRetry ?? 4
const MAX_ROUNDS = cfg.maxRounds ?? 3
const MAX_GT = cfg.maxGroundTruth ?? 3
const MIN_ADDED = cfg.minAdded ?? 12 // a "landed" file must add at least this many lines (defeats empty stubs / route shims)
const STOP_AFTER = cfg.stopAfter || 'manifest'
const ORDER = ['intake', 'prd', 'architecture', 'plan', 'build', 'verify', 'qa', 'acceptance', 'manifest']
const willRun = (s) => ORDER.indexOf(s) <= ORDER.indexOf(ORDER.includes(STOP_AFTER) ? STOP_AFTER : 'manifest')

if (!REPO) return { error: 'sdlc-prod requires args.repo (a real repo path). Pass {repo, brief} as a STRUCTURED object, not a string.' }
if (!BRIEF || BRIEF.trim().length < 20) return { error: 'sdlc-prod requires args.brief (the settled discovery brief).' }

const PRINCIPLES = `NON-NEGOTIABLE ARCHITECTURE PRINCIPLES the built system MUST embody (and you must call out HOW each is met):
Observability (structured logs + request IDs + metrics + error tracking), Scalability (stateless + async),
Durability (persist state after each step), Resilience (retries/timeouts/circuit-breakers/DLQ),
Recoverability (resume from last good state), Idempotency (every step safe to retry, no dupes),
Security (per-action authz, protect/encrypt secrets, isolate services), Auditability (actor/change/reason/prev→new/approvals),
Consistency (txn per step; Saga/compensation across steps), Maintainability (small versioned modules, clear contracts),
Testability (unit+integration+e2e + failure scenarios), Performance (async/caching/no blocking),
Extensibility (config-driven steps), Cost-efficiency (scale to demand, no polling/dup work).`

// ── module state set during the run ───────────────────────────────────────────
let REPO_AUDIT = ''
let ADDITIVE = false
let GROUND_TRUTH = { clean: true, ghosts: [] } // build correctness verdict; honored by Verify/Acceptance/Manifest
let CRITERIA = [] // structured acceptance criteria from intake (the spec contract)
let UNCOVERED = [] // criteria no plan task claims — forced into acceptance as blockers
let REFUTE_GAPS = [] // surviving refuter evidence — seeds Verify's known-unresolved list
let DEFERRED_FLAGS = [] // build summaries that tried to defer scope (run wf_c6fc100f failure class)

// ── generic helpers ──────────────────────────────────────────────────────────

// Durability + Auditability: commit+push whatever is in the tree.
async function commitStage(tag, note) {
  try {
    await agent(
      `In the git repo at ${REPO}, persist progress so nothing is lost. Run: git add -A; git -c commit.gpgsign=false commit -m "wf(${tag}): ${note}" --no-verify; git push origin HEAD. If "nothing to commit", just confirm. Do NOT modify source — ONLY stage/commit/push. Report the commit hash or "nothing to commit".`,
      { label: `commit:${tag}`, phase: 'Build' }
    )
  } catch (e) {
    log(`commit:${tag} failed (non-fatal): ${String((e && e.message) || e)}`)
  }
}

// Resilience: one attempt that REPORTS FAILURE on throw OR empty/short output.
async function attempt(label, phase, prompt) {
  let out = null
  try {
    out = await agent(prompt, { label, phase })
  } catch (e) {
    return { ok: false, reason: `error: ${String((e && e.message) || e).slice(0, 140)}` }
  }
  const text = typeof out === 'string' ? out : out == null ? '' : JSON.stringify(out)
  if (!text || text.trim().length < 60) return { ok: false, reason: 'empty/zero-token output' }
  return { ok: true, text: text.trim() }
}

async function withRetry(label, phase, prompt, max) {
  let last = null
  for (let i = 1; i <= max; i++) {
    last = await attempt(i === 1 ? label : `${label}:r${i}`, phase, prompt)
    if (last.ok) return { ...last, attempts: i }
    log(`${label} attempt ${i}/${max} failed (${last.reason}) — ${i < max ? 'retrying' : 'giving up'}`)
  }
  return { ok: false, attempts: max, reason: last ? last.reason : 'unknown' }
}

const CRITIQUE = {
  type: 'object',
  additionalProperties: false,
  properties: { passed: { type: 'boolean' }, gaps: { type: 'array', items: { type: 'string' } } },
  required: ['passed', 'gaps'],
}

// Generic critique→remediate convergence loop (Resilience/Testability).
async function converge(label, phase, makeBuild, makeReview, rounds) {
  let prev = null
  for (let r = 1; r <= rounds; r++) {
    const built = await withRetry(`${label}:build:r${r}`, phase, makeBuild(r, prev))
    if (!built.ok) {
      prev = { artifact: prev ? prev.artifact : '', verdict: { passed: false, gaps: [built.reason] } }
      continue
    }
    const verdict = await agent(makeReview(built.text, r), { label: `${label}:review:r${r}`, phase, schema: CRITIQUE })
    prev = { artifact: built.text, verdict }
    if (verdict.passed) return { artifact: built.text, passed: true, rounds: r }
    log(`${label} review r${r}: ${verdict.gaps.length} gap(s)`)
  }
  return { artifact: prev ? prev.artifact : '', passed: false, rounds }
}

// ── GROUND TRUTH (deterministic — the SCRIPT is the judge, not an agent) ──────
// The agent is a DUMB TERMINAL: it runs git and pastes RAW output. The script
// parses `git diff --numstat <base> HEAD` itself, so an agent cannot "echo the
// plan" into a fake done-list — the line counts and paths come from git.
// RESIDUAL LIMITS (defense-in-depth, not absolutes): (1) the Workflow sandbox
// can't exec git, so the raw text is still agent-pasted — a determined fabricator
// could forge it; mitigated by head==baseRef detection + the independent
// render-assert QA/Acceptance gates. (2) This gate proves ">= MIN_ADDED real
// lines of non-stub code at the declared path" — it catches ZERO-file and
// wrong-path builds outright, but a substantive-looking stub that compiles is
// the render-asserting e2e's job to catch, not the script's.
const RAW_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    head: { type: 'string' },        // `git rev-parse HEAD`
    numstat: { type: 'string' },     // raw `git diff --numstat --no-renames <base> HEAD`
    porcelain: { type: 'string' },   // raw `git status --porcelain` (uncommitted leftovers)
    stubgrep: { type: 'string' },    // raw `git grep -nE <stub markers>` over the changed files
    ignored: { type: 'string' },     // raw `git check-ignore` over the declared task paths
    sizes: { type: 'string' },       // raw `wc -l` over the declared task paths (tree reconciliation)
  },
  required: ['head', 'numstat', 'porcelain'],
}
// FABRICATION TRIPWIRE: a single bare hash is trivially inventable (the "788"
// class). Two independent probes must AGREE on the hash; disagreement triggers
// a tiebreaker. Forging requires two agents inventing the SAME 40-hex string.
async function gitRefOnce(label) {
  const r = await agent(`In ${REPO}: run \`git rev-parse HEAD\` and return ONLY the 40-char hash as your entire output (no prose).`, { label, phase: 'Build' })
  return (String(typeof r === 'string' ? r : '').match(/\b[0-9a-f]{40}\b/i) || [''])[0]
}
async function gitRef(label) {
  const [a, b] = await parallel([() => gitRefOnce(`${label}:p1`), () => gitRefOnce(`${label}:p2`)])
  if (a && b && a === b) return a
  log(`⚠ ${label}: baseRef probes disagree (${String(a).slice(0, 8)} vs ${String(b).slice(0, 8)}) — tiebreaking`)
  const c = await gitRefOnce(`${label}:p3`)
  return c === a || c === b ? c : c || a || b || ''
}
const STUB_MARKERS = 'TODO|FIXME|coming soon|not implemented|unimplemented|placeholder|stub'
async function gitEvidence(baseRef, declaredPaths, label) {
  const dp = (declaredPaths || []).slice(0, 200).map((p) => `'${String(p).replace(/'/g, '')}'`).join(' ')
  const out = await agent(
    `In ${REPO}, gather GROUND-TRUTH git evidence — do NOT modify anything, do NOT summarize. Run and paste RAW verbatim output for each:\n1) \`git rev-parse HEAD\` -> head\n2) \`git diff --numstat --no-renames ${baseRef} HEAD\` -> numstat (one line per file: "<added>\\t<deleted>\\t<path>")\n3) \`git status --porcelain\` -> porcelain\n4) take the file paths from the numstat output and run \`git grep -nIE "${STUB_MARKERS}" -- <those paths>\` -> stubgrep (raw; empty if none match)\n5) \`git check-ignore ${dp || '/dev/null'}\` -> ignored (raw list of any of those paths git would ignore; empty if none)\n6) \`wc -l ${dp || '/dev/null'}\` -> sizes (raw "<lines> <path>" output; missing files may error — include whatever wc prints)\nPaste exact command output; no commentary.`,
    { label, phase: 'Build', schema: RAW_SCHEMA })
  return out && typeof out === 'object' ? out : { head: '', numstat: '', porcelain: '', stubgrep: '', ignored: '', sizes: '' }
}
const IGNORE_PATH = /(^|\/)(node_modules|dist|build|coverage|\.expo|\.next|\.turbo)\//
const LOCK_PATH = /(package-lock\.json|pnpm-lock\.yaml|bun\.lock(b)?|yarn\.lock)$/
// Defensive: if a rename form ("{old => new}" / "old => new") slips past
// --no-renames, keep the NEW path only.
function newPath(p) {
  let s = String(p).trim()
  const brace = s.match(/^(.*)\{.* => (.*)\}(.*)$/)
  if (brace) s = (brace[1] + brace[2] + brace[3]).replace(/\/{2,}/g, '/')
  else if (s.includes(' => ')) s = s.split(' => ').pop().trim()
  return s
}
// Parse numstat into real source-file changes with added-line counts.
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
// Marker DENSITY rule: one "placeholder"/"TODO" inside a substantial file (CSS
// placeholder:, env-example values, CI placeholder secrets) is NOT evidence of a
// hollow build — that false positive ghosted a real 140-line ci.yml for 3 straight
// rounds (T19, run wf_c6fc100f). A file is stub-flagged only when marker hits are
// dense (>=3) or the change itself is thin (< 2*MIN_ADDED added lines).
function toStubSet(stubgrep, files) {
  const hits = {}
  for (const l of String(stubgrep || '').split('\n')) {
    const p = norm(l.split(':')[0].trim())
    if (p) hits[p] = (hits[p] || 0) + 1
  }
  const added = {}
  for (const f of files || []) added[norm(f.path)] = f.added
  return new Set(Object.keys(hits).filter((p) => hits[p] >= 3 || (added[p] !== undefined && added[p] < MIN_ADDED * 2)))
}
function toIgnoredSet(ignored) {
  return new Set(String(ignored || '').split('\n').map((l) => norm(l.trim().split('\t').pop())).filter(Boolean))
}
// Parse raw `wc -l` output into a path -> line-count map (tree reconciliation).
function toSizeMap(sizes) {
  const m = {}
  for (const l of String(sizes || '').split('\n')) {
    const mm = l.trim().match(/^(\d+)\s+(.+)$/)
    if (mm && mm[2].trim() !== 'total') m[norm(mm[2])] = parseInt(mm[1], 10)
  }
  return m
}
// Suffix match only — the changed path equals the declared path or ENDS WITH it
// (declared is a suffix of changed). The reverse direction is dropped: a declared
// path being a suffix of a shorter changed path is never evidence. Requires
// >= MIN_ADDED added lines AND the file not flagged a stub by the marker scan.
// TREE RECONCILIATION fallback: a declared file absent from the diff window but
// already ON DISK with >= MIN_ADDED lines (landed in an earlier window, or
// pre-existing in an additive run) is not a ghost — re-implementing it burns
// rounds for nothing (T19, run wf_c6fc100f).
function fileLanded(declared, files, stubSet, sizeMap) {
  const nf = norm(declared)
  const inDiff = files.some((ch) => {
    if (ch.added < MIN_ADDED) return false
    const nc = norm(ch.path)
    if (stubSet && stubSet.has(nc)) return false
    return nc === nf || nc.endsWith('/' + nf)
  })
  if (inDiff) return true
  if (sizeMap) {
    for (const k of Object.keys(sizeMap)) {
      if ((k === nf || k.endsWith('/' + nf)) && sizeMap[k] >= MIN_ADDED && !(stubSet && stubSet.has(k))) return true
    }
  }
  return false
}
function taskLanded(task, files, stubSet, sizeMap) {
  if (!task || !task.files || !task.files.length) return false // unprovable ⇒ ghost (fail closed)
  return task.files.some((f) => fileLanded(f, files, stubSet, sizeMap))
}

// ── STAGE 1: Intake ──────────────────────────────────────────────────────────
phase('Intake')
const NORTH_STAR = `BRIEF:\n${BRIEF}\n\n${PRINCIPLES}\nImplementation target repo: ${REPO}.`
const intake = await withRetry('intake', 'Intake',
  `Read the repo at ${REPO} (its stack/conventions) and distill the brief into a crisp spec: problem, goals, constraints, and a numbered list of testable ACCEPTANCE CRITERIA. Fold the architecture principles in as explicit non-functional requirements with a concrete check for each.\n${NORTH_STAR}`, MAX_RETRY)
// SPEC CONTRACT: extract the criteria as structured data. Plan coverage, build
// prompts, and the acceptance gate all bind to THESE ids — a criterion that no
// task claims is surfaced by the SCRIPT, not left to an agent's judgment
// (run wf_c6fc100f shipped 4 unmet criteria a build agent quietly deferred).
const CRIT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { criteria: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    properties: { id: { type: 'string' }, check: { type: 'string' } },
    required: ['id', 'check'],
  } } },
  required: ['criteria'],
}
try {
  const c = await agent(
    `Extract EVERY acceptance criterion from this spec as structured data — functional AND non-functional. id = short stable slug (e.g. "AC1-routes", "NFR-security"); check = the testable statement VERBATIM enough to verify against. Do not merge, drop, or soften any criterion.\nSPEC:\n${intake.text}`,
    { label: 'intake:criteria', phase: 'Intake', schema: CRIT_SCHEMA })
  CRITERIA = (c.criteria || []).filter((x) => x && x.id && x.check)
} catch (e) { log(`intake:criteria extraction failed (${String((e && e.message) || e).slice(0, 80)}) — coverage gate degrades to prompt-only`) }
log(`Intake: ${CRITERIA.length} acceptance criteria extracted as the spec contract`)
await commitStage('intake', 'spec + acceptance criteria + principle NFRs')

// ── STAGE 2: PRD ──────────────────────────────────────────────────────────────
let prd = { artifact: '' }
if (willRun('prd')) {
  phase('PRD')
  prd = await converge('prd', 'PRD',
    (r, p) => r === 1
      ? `Write the PRD for this product: screens/endpoints, user flows, data model, and how EACH architecture principle is satisfied. Stay within the goals (no scope creep).\nSPEC:\n${intake.text}\n${PRINCIPLES}`
      : `Revise this PRD to resolve the gaps without dropping coverage.\nPRD:\n${p.artifact}\nGAPS:\n${J(p.verdict.gaps)}`,
    (draft) => `Critically review this PRD. Pass ONLY if every acceptance criterion is covered, every architecture principle has a concrete plan, and there is no scope creep.\nSPEC:\n${intake.text}\nPRD:\n${draft}`,
    MAX_ROUNDS)
  await commitStage('prd', 'product requirements + principle coverage')
}

// ── STAGE 3: Architecture ────────────────────────────────────────────────────
let arch = { artifact: '' }
if (willRun('architecture')) {
  phase('Architecture')
  arch = await converge('arch', 'Architecture',
    (r, p) => r === 1
      ? `Design the architecture for the repo at ${REPO} (consistent with its stack). Address EVERY principle explicitly: observability, scalability, durability, resilience, recoverability, idempotency, security, auditability, consistency (txn-per-step + Saga across steps), maintainability (small versioned modules w/ contracts), testability, performance, extensibility (config-driven), cost. Name the modules/files and their input/output contracts.\nPRD:\n${prd.artifact}\n${PRINCIPLES}`
      : `Revise the architecture to resolve the gaps.\nARCH:\n${p.artifact}\nGAPS:\n${J(p.verdict.gaps)}`,
    (draft) => `Review this architecture. Pass ONLY if every PRD requirement AND every architecture principle is concretely addressed with named modules/contracts and no unaddressed high risk.\nPRD:\n${prd.artifact}\nARCH:\n${draft}`,
    MAX_ROUNDS)
  await commitStage('architecture', 'architecture + principle mechanisms + module contracts')
}

// ── STAGE 4: Plan (additive-aware; every task MUST declare concrete files) ───
let tasks = []
if (willRun('plan')) {
  phase('Plan')
  // Greenfield vs existing is a SCHEMA'D BOOLEAN (never a prose-length heuristic).
  // Uncertain ⇒ treat as additive (the non-clobbering path).
  const RA_SCHEMA = {
    type: 'object', additionalProperties: false,
    properties: { greenfield: { type: 'boolean' }, conventions: { type: 'string' } },
    required: ['greenfield', 'conventions'],
  }
  let ra = null
  for (let i = 1; i <= MAX_RETRY && !ra; i++) {
    try { ra = await agent(`Audit the repo at ${REPO} ON DISK. Set greenfield=true ONLY if the tree is essentially empty (no package manifest, no real source tree). Otherwise greenfield=false and put in conventions the REAL structure + which capabilities already exist + where new features must live (real paths).`, { label: i === 1 ? 'plan:repo-audit' : `plan:repo-audit:r${i}`, phase: 'Plan', schema: RA_SCHEMA }) } catch (e) { log(`repo-audit attempt ${i} failed: ${String((e && e.message) || e).slice(0, 100)}`) }
  }
  ADDITIVE = ra ? !ra.greenfield : true
  REPO_AUDIT = ra ? String(ra.conventions || '') : ''
  // CLOBBER BACKSTOP (script-enforced, not prompt-only): a wrong greenfield=true
  // would route the destructive scaffold branch over an existing repo. Probe the
  // real tracked-file count; a non-trivial tree forces ADDITIVE (no-clobber).
  if (!ADDITIVE) {
    // SCRIPT counts path-shaped lines itself — a bare integer can be invented
    // without running anything (probe fabrication: run wf_c6fc100f returned "788"
    // against a 5-file tree, zero tool calls). A full path listing is checkable
    // evidence; an undercount is safe because only crossing the threshold flips.
    const P_SCHEMA = { type: 'object', additionalProperties: false, properties: { rawListing: { type: 'string' } }, required: ['rawListing'] }
    let probe = null
    try { probe = await agent(`In ${REPO}: run \`git ls-files\` and return rawListing = the COMPLETE raw output VERBATIM (one path per line, no commentary, no counts, no truncation). If the repo has no commits yet, return rawListing="".`, { label: 'plan:greenfield-probe', phase: 'Plan', schema: P_SCHEMA }) } catch (e) { log(`greenfield-probe failed (${String((e && e.message) || e).slice(0, 80)}) — keeping audit verdict`) }
    const n = String((probe && probe.rawListing) || '').split('\n').map((l) => l.trim()).filter((l) => l && !/\s/.test(l) && !/^\d+$/.test(l)).length
    if (n > 10) { ADDITIVE = true; log(`⚠ repo-audit said greenfield but ${n} tracked files exist — forcing ADDITIVE (no-clobber)`) }
  }
  log(`Plan: repo is ${ADDITIVE ? 'EXISTING → additive build (plan the delta; never clobber)' : 'greenfield'}`)
  const PLAN_SCHEMA = {
    type: 'object', additionalProperties: false,
    properties: { tasks: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      properties: { id: { type: 'string' }, title: { type: 'string' }, files: { type: 'array', items: { type: 'string' }, minItems: 1 }, contract: { type: 'string' }, covers: { type: 'array', items: { type: 'string' } } },
      required: ['id', 'title', 'files'],
    } } },
    required: ['tasks'],
  }
  const critList = CRITERIA.length ? `\nACCEPTANCE CRITERIA (the spec contract — EVERY id below MUST appear in some task's covers[]; criteria satisfied by existing code in an additive run still get a task that VERIFIES them):\n${J(CRITERIA)}` : ''
  const planPrompt = (gapNote) =>
    `Decompose the build into SMALL, INDEPENDENT, idempotent tasks. EACH task MUST list in files[] the concrete REAL repo-relative paths it will create/modify (at least one) — these are checked against the git diff later, so they must be the actual files. EACH task lists in covers[] the acceptance-criterion ids it satisfies. Prefer NEW files per task; put shared-file edits (barrels/routes/config) in their own dedicated task so they don't collide. Include observability/security/audit/test tasks. Return tasks[].${gapNote}${critList}\n${ADDITIVE ? `THIS IS AN EXISTING CODEBASE — plan ONLY the DELTA the spec requires; do NOT re-plan capabilities that already exist. Name the REAL existing files to create/extend, matching the conventions below.\nREPO CONVENTIONS (ground truth):\n${REPO_AUDIT}\n` : ''}ARCH:\n${arch.artifact}`
  // COVERAGE MATRIX (script-enforced): a plan that leaves a criterion unclaimed
  // is rejected and re-planned; still-uncovered criteria become forced
  // acceptance blockers — silent scope-cuts can't survive the plan stage.
  for (let pr = 1; pr <= 2; pr++) {
    const gapNote = UNCOVERED.length ? `\nPREVIOUS PLAN REJECTED — these criteria were covered by NO task; add or extend tasks to cover each: ${J(UNCOVERED)}` : ''
    const plan = await agent(planPrompt(gapNote), { label: pr === 1 ? 'plan' : `plan:coverage:r${pr}`, phase: 'Plan', schema: PLAN_SCHEMA })
    tasks = (plan.tasks || []).filter((t) => t && t.id && Array.isArray(t.files) && t.files.length).slice(0, cfg.maxTasks ?? 999)
    const claimed = new Set(tasks.flatMap((t) => (t.covers || []).map((c) => String(c).toLowerCase())))
    UNCOVERED = CRITERIA.filter((c) => !claimed.has(String(c.id).toLowerCase())).map((c) => c.id)
    if (!UNCOVERED.length) break
    log(`⛔ Plan coverage r${pr}: ${UNCOVERED.length} criteria claimed by NO task: ${UNCOVERED.join(', ')}${pr < 2 ? ' — re-planning' : ' — forcing into acceptance as blockers'}`)
  }
  log(`Plan: ${tasks.length} tasks (all with declared files; coverage ${CRITERIA.length - UNCOVERED.length}/${CRITERIA.length} criteria)`)
  await commitStage('plan', `${tasks.length} task contracts`)
}

// Partition tasks so concurrent agents never edit the same file: any file
// claimed by >1 task ⇒ those tasks are SERIAL; the rest run in parallel.
function partitionDisjoint(ts) {
  const owners = {}
  for (const t of ts) for (const f of (t.files || [])) { const k = norm(f); (owners[k] = owners[k] || []).push(t.id) }
  const collidingIds = new Set()
  for (const k of Object.keys(owners)) if (owners[k].length > 1) owners[k].forEach((id) => collidingIds.add(id))
  return { parallelTasks: ts.filter((t) => !collidingIds.has(t.id)), serialTasks: ts.filter((t) => collidingIds.has(t.id)) }
}

// ── STAGE 5: Build (parallel + deterministic ground-truth gate) ──────────────
const buildResults = []
async function buildTask(task) {
  const covered = CRITERIA.filter((c) => (task.covers || []).map((x) => String(x).toLowerCase()).includes(String(c.id).toLowerCase()))
  const critBlock = covered.length ? `\nACCEPTANCE CRITERIA THIS TASK MUST FULLY SATISFY (verbatim — deferring any of these to a later phase/milestone is a FAILURE):\n${covered.map((c) => `- [${c.id}] ${c.check}`).join('\n')}` : ''
  const prompt = `Implement ONLY task ${task.id} ("${task.title}") in the repo at ${REPO}${ADDITIVE ? ' — an EXISTING codebase: ADD to it following its conventions; do NOT recreate or overwrite what already exists' : ', on top of the scaffold'}, per the architecture. You MUST create/modify the REAL files for this task — returning a description WITHOUT changing files on disk is a FAILURE and a git-diff check will catch it. Embody the principles in YOUR code: structured logging, input validation + per-action authz where relevant, idempotency, no secrets in logs.${critBlock}\nHARD RULES (other agents work in this SAME tree concurrently): touch ONLY this task's files (${(task.files || []).join(', ')}); do NOT edit package.json/lockfiles/shared barrels/config; do NOT run install or git. It's OK if the whole project doesn't typecheck yet.\nCONTRACT: ${task.contract || '(see architecture)'}\n${ADDITIVE ? `REPO CONVENTIONS:\n${REPO_AUDIT}\n` : ''}ARCH:\n${arch.artifact}\nReturn the exact files you wrote/modified (with line counts).`
  const r = await withRetry(`build:${task.id}`, 'Build', prompt, MAX_RETRY)
  return { id: task.id, title: task.title, ok: r.ok, attempts: r.attempts, summary: r.ok ? r.text : r.reason }
}
async function runBuild() {
  phase('Build')
  // Scaffold (greenfield) OR baseline (additive: NEVER recreate the tree). Both
  // are guarded so a misclassification can neither clobber nor skip a skeleton.
  const sc = await withRetry('build:scaffold', 'Build',
    ADDITIVE
      ? `This is an EXISTING repo — do NOT scaffold or recreate structure, and NEVER overwrite an existing file. Just ensure dependencies are installed and the project currently typechecks/builds clean as a BASELINE (fix only what is already broken; implement NO new features here). EDGE CASE: if there is in fact NO package manifest / source tree, scaffold a MINIMAL skeleton + observability layer (structured logging + request IDs + error tracking) first. Commit+push only if something changed (wf(build): baseline). Report the build command + result.\nREPO CONVENTIONS:\n${REPO_AUDIT}`
      : `Scaffold the complete project skeleton in ${REPO} per the architecture: structure, package/config files, the cross-cutting OBSERVABILITY layer (structured logging + request IDs + error tracking), and install deps. GUARD: if a package manifest / source tree already exists, do NOT overwrite or recreate any existing file — only fill genuine gaps. Make typecheck/build pass on the skeleton, then commit+push (wf(build): scaffold).\nARCH:\n${arch.artifact}\nTASKS (for layout): ${J(tasks.map((t) => ({ id: t.id, title: t.title })))}`,
    MAX_RETRY)
  if (!sc.ok) log(`⚠ ${ADDITIVE ? 'baseline' : 'scaffold'} failed: ${sc.reason}`)
  await commitStage('build-scaffold', ADDITIVE ? 'baseline build' : 'skeleton + observability layer')

  // GROUND-TRUTH baseline: captured AFTER the baseline/scaffold commit so its
  // incidental churn (lockfiles/config/formatting) can NEVER mask a hollow
  // feature build. This value is memoized → stable across resume.
  const baseRef = await gitRef('gt:base')

  // Implement: parallel for disjoint-file tasks, serial for colliding ones.
  const { parallelTasks, serialTasks } = partitionDisjoint(tasks)
  if (serialTasks.length) log(`Build: ${parallelTasks.length} parallel + ${serialTasks.length} serial (shared-file) tasks`)
  else log(`Build: ${tasks.length} tasks in parallel (retry ${MAX_RETRY}x each)`)
  const impl = (await parallel(parallelTasks.map((t) => () => buildTask(t)))).filter(Boolean)
  for (const t of serialTasks) impl.push(await buildTask(t))
  const failed = impl.filter((r) => !r.ok)
  buildResults.push(...impl)
  if (failed.length) log(`⚠ ${failed.length}/${impl.length} tasks failed after retries: ${failed.map((f) => f.id).join(', ')} — integration backfills`)
  // DEFERRAL DETECTION (script-enforced): a build summary that punts scope to a
  // later phase is the exact failure class that left run wf_c6fc100f with 4
  // unmet criteria ("admin read side deferred to Phase 2"). Catch it from the
  // agent's OWN words and force a completion round before integration.
  const RE_DEFER = /\b(defer(red|ring)?|phase ?2|out of scope|later (milestone|phase|PR)|follow[- ]?up|post[- ]?launch|TODO later)\b/i
  const deferred = impl.filter((r) => r.ok && RE_DEFER.test(String(r.summary)))
  if (deferred.length) {
    DEFERRED_FLAGS = deferred.map((d) => d.id)
    log(`⛔ Deferral detected in ${deferred.length} task summary(ies): ${DEFERRED_FLAGS.join(', ')} — forcing completion now`)
    const detail = deferred.map((d) => ({ id: d.id, title: d.title, covers: (tasks.find((t) => t.id === d.id) || {}).covers || [], summary: String(d.summary).slice(0, 300) }))
    await withRetry('build:undefer', 'Build',
      `SCOPE-CUT DETECTED in ${REPO}: these tasks reported done but their own summaries defer part of the contract to a later phase — deferral is NOT allowed; the full acceptance criteria are v1 scope. Implement the deferred parts COMPLETELY now (real files, real behavior), then commit+push (wf(build): undefer). Tasks:\n${J(detail)}\nCRITERIA (verbatim):\n${J(CRITERIA.filter((c) => detail.some((d) => d.covers.map((x) => String(x).toLowerCase()).includes(String(c.id).toLowerCase()))))}\nARCH:\n${arch.artifact}`, MAX_RETRY)
    await commitStage('build-undefer', `completed deferred scope: ${DEFERRED_FLAGS.join(', ')}`)
  }
  await commitStage('build-parallel', `${impl.length - failed.length}/${impl.length} tasks`)

  // Integration: wire + make the whole thing green; backfill failures.
  await withRetry('build:integrate', 'Build',
    `Integrate the build in ${REPO}.${failed.length ? ` First IMPLEMENT these failed/missing tasks per the architecture: ${J(failed.map((f) => f.id))}.` : ''} Add missing deps + wiring (barrels, routes, imports), install, then run typecheck+build+lint for the WHOLE project and fix every error until clean. Commit+push (wf(build): integrate). Report the exact commands + results.\nARCH:\n${arch.artifact}\nTASK SUMMARIES: ${J(impl.map((r) => ({ id: r.id, ok: r.ok, summary: String(r.summary).slice(0, 400) })))}`, MAX_RETRY)
  await commitStage('build-integrate', 'integrated green build')

  // ── DETERMINISTIC GROUND-TRUTH GATE ───────────────────────────────────────
  // The build's word is NOT proof. Parse `git diff --numstat baseRef HEAD` in
  // the SCRIPT: a task whose declared files show no real (>= MIN_ADDED-line)
  // change is a GHOST → re-implement. Loops until every task lands or rounds
  // exhaust; on exhaustion sets GROUND_TRUTH.clean=false which FORCES
  // deployReady=false downstream (never a silent fall-through).
  const declaredPaths = [...new Set(tasks.flatMap((t) => t.files || []))]
  let lastGhosts = tasks.map((t) => t.id)
  for (let g = 1; g <= MAX_GT; g++) {
    const ev = await gitEvidence(baseRef, declaredPaths, `gt:evidence:r${g}`)
    const noCommit = !!(ev.head && baseRef && norm(ev.head).slice(0, 12) === norm(baseRef).slice(0, 12))
    const files = parseReal(ev.numstat)
    const stubSet = toStubSet(ev.stubgrep, files)
    const ignoredSet = toIgnoredSet(ev.ignored)
    const sizeMap = toSizeMap(ev.sizes)
    const ghosts = tasks.filter((t) => !taskLanded(t, files, stubSet, sizeMap))
    lastGhosts = ghosts.map((t) => t.id)
    // Tasks whose declared paths are ALL gitignored can never land — flag and stop
    // (don't burn rounds re-implementing an un-landable path).
    const ignoredTasks = tasks.filter((t) => (t.files || []).length && (t.files || []).every((f) => ignoredSet.has(norm(f)))).map((t) => t.id)
    if (!noCommit && ghosts.length === 0 && files.length > 0) { GROUND_TRUTH = { clean: true, ghosts: [] }; log(`Ground truth r${g}: all ${tasks.length} tasks landed real files (${files.length} changed)`); break }
    GROUND_TRUTH = { clean: false, ghosts: lastGhosts, ignored: ignoredTasks }
    if (ignoredTasks.length) { log(`⛔ Ground truth r${g}: tasks target .gitignored paths (un-landable): ${ignoredTasks.join(', ')} — FIX the planned file paths; not retrying. deployReady forced false.`); break }
    const note = [noCommit ? 'HEAD==baseRef: nothing committed' : '', String(ev.porcelain || '').trim() ? 'uncommitted changes present' : '', stubSet.size ? `${stubSet.size} stub-flagged file(s) excluded` : ''].filter(Boolean).join('; ')
    log(`⛔ Ground truth r${g}: ${ghosts.length}/${tasks.length} GHOST task(s) with no real file on disk: ${lastGhosts.join(', ')}${note ? ` (${note})` : ''} — re-implementing for real`)
    const ghostDetail = ghosts.map((t) => ({ id: t.id, title: t.title, files: t.files }))
    await withRetry(`build:ground-truth:r${g}`, 'Build',
      `GROUND-TRUTH FAILURE in ${REPO}: these planned tasks reported done but have NO real file change on disk (need >= ${MIN_ADDED} added lines of substantive code at the declared path — empty/placeholder/TODO stubs and pure re-export shims do NOT count): ${J(ghostDetail)}. This is${ADDITIVE ? ' an EXISTING repo' : ' a real project'} — you MUST create/modify the REAL files now with working code. Then install+wire+typecheck/build/lint green and COMMIT+push (wf(build): ground-truth backfill r${g}). Report each file written WITH line counts.\n${ADDITIVE ? `REPO CONVENTIONS:\n${REPO_AUDIT}\n` : ''}ARCH:\n${arch.artifact}`, MAX_RETRY)
    await commitStage(`build-ground-truth-r${g}`, 'reimplemented ghost tasks')
  }
  if (!GROUND_TRUTH.clean) log(`⛔ Ground truth NOT clean after ${MAX_GT} rounds — unresolved: ${lastGhosts.join(', ')}. deployReady will be forced false.`)

  // ── REFUTER WAVE (T1): the ground-truth gate proves files LANDED; this wave
  // adversarially probes whether they actually SATISFY their contracts+criteria.
  // One refuter per task cluster, default refuted=true; surviving refutations
  // get ONE fix round, and whatever remains seeds Verify's known-unresolved list.
  phase('Refute')
  const RSCHEMA = {
    type: 'object', additionalProperties: false,
    properties: { refuted: { type: 'boolean' }, evidence: { type: 'string' } },
    required: ['refuted', 'evidence'],
  }
  const clusters = []
  for (let i = 0; i < tasks.length; i += 3) clusters.push(tasks.slice(i, i + 3))
  const refClaim = (cl) => cl.map((t) => {
    const cov = CRITERIA.filter((c) => (t.covers || []).map((x) => String(x).toLowerCase()).includes(String(c.id).toLowerCase()))
    return `${t.id} "${t.title}" (files: ${(t.files || []).join(', ')}; contract: ${(t.contract || '').slice(0, 200)}${cov.length ? `; criteria: ${cov.map((c) => `[${c.id}] ${c.check}`).join(' | ').slice(0, 500)}` : ''})`
  }).join('\n')
  const verdicts = await parallel(clusters.map((cl, i) => () =>
    agent(`In ${REPO}, adversarially try to REFUTE this claim by reading the ACTUAL files and running cheap checks (grep/node/typecheck snippets): "Tasks below are FULLY implemented per their contracts and acceptance criteria — complete behavior, not stubs, no silently-missing pieces." Default refuted=true unless you find concrete file:line evidence each one holds. Tasks:\n${refClaim(cl)}`,
      { label: `refute:cluster${i + 1}`, phase: 'Refute', schema: RSCHEMA })))
  const standing = verdicts.map((v, i) => ({ v, cl: clusters[i] })).filter((x) => x.v)
  const refuted = standing.filter((x) => x.v.refuted)
  if (refuted.length) {
    log(`⛔ Refute: ${refuted.length}/${standing.length} cluster(s) refuted — one fix round`)
    await withRetry('refute:fix', 'Refute',
      `Adversarial review found these implementation gaps in ${REPO} — fix the ROOT CAUSES with real code (never weaken a check), then typecheck/build/lint green and commit+push (wf(refute): fixes).\nFINDINGS:\n${J(refuted.map((x) => ({ tasks: x.cl.map((t) => t.id), evidence: String(x.v.evidence).slice(0, 600) })))}\nARCH:\n${arch.artifact}`, MAX_RETRY)
    await commitStage('refute-fix', `${refuted.length} refuted cluster(s) remediated`)
    // re-probe ONLY the fixed clusters once; anything still refuted goes to Verify
    const recheck = await parallel(refuted.map((x, i) => () =>
      agent(`In ${REPO}, adversarially RE-CHECK after a fix round — try to REFUTE: "These tasks are now FULLY implemented per contract+criteria." Default refuted=true without file:line evidence. Tasks:\n${refClaim(x.cl)}`,
        { label: `refute:recheck${i + 1}`, phase: 'Refute', schema: RSCHEMA })))
    REFUTE_GAPS = recheck.map((v, i) => ({ v, cl: refuted[i].cl })).filter((x) => x.v && x.v.refuted)
      .map((x) => `Refuter evidence (tasks ${x.cl.map((t) => t.id).join(',')}): ${String(x.v.evidence).slice(0, 400)}`)
    if (REFUTE_GAPS.length) log(`⛔ Refute: ${REFUTE_GAPS.length} cluster(s) STILL refuted after fix — handing to Verify`)
    else log(`✓ Refute: all refuted clusters fixed and re-verified`)
  } else log(`✓ Refute: ${standing.length}/${clusters.length} clusters survived adversarial refutation`)
}
if (willRun('build')) await runBuild()

// ── STAGE 6: Verify (adversarial, ground-truth, bounded loop) ────────────────
let verify = { passed: true, gaps: [] }
if (willRun('verify')) {
  phase('Verify')
  const VSCHEMA = {
    type: 'object', additionalProperties: false,
    properties: {
      passed: { type: 'boolean' },
      buildGreen: { type: 'boolean' },
      evidence: { type: 'string' }, // pasted tail of the typecheck/build/lint output — a bare boolean is fabricatable
      filesPresent: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, present: { type: 'boolean' } }, required: ['id', 'present'] } },
      gaps: { type: 'array', items: { type: 'string' } },
    },
    required: ['passed', 'buildGreen', 'evidence', 'filesPresent', 'gaps'],
  }
  // Seed gaps with any unresolved ground-truth ghosts + surviving refuter
  // evidence so Verify MUST resolve them.
  const seedGaps = [
    ...(GROUND_TRUTH.clean ? [] : [`Ground-truth ghosts (claimed built, no real file): ${GROUND_TRUTH.ghosts.join(', ')}`]),
    ...REFUTE_GAPS,
  ]
  for (let r = 1; r <= MAX_ROUNDS; r++) {
    verify = await agent(
      `Adversarially VERIFY the repo at ${REPO} ON DISK — trust files, not prior claims. (0) For each EXPECTED task, confirm its declared files EXIST with real, non-stub content; return filesPresent[{id,present}]. (1) RUN typecheck+build+lint yourself for the whole project; set buildGreen and paste the LAST ~15 lines of real command output into evidence (a verdict without pasted output is rejected by the harness). (2) Scan EVERY source file for stubs/placeholders/TODOs/empty surfaces — none allowed for planned tasks. (3) Spot-check the principles in the actual code: structured logging present? secrets NOT logged/leaked? idempotency on retryable ops? input validation/authz on entry points? Pass ONLY if every expected file exists, buildGreen, no stubs remain, and these checks hold. List concrete gaps.\nKNOWN UNRESOLVED (must fix): ${J(seedGaps)}\nTasks expected: ${J(tasks.map((t) => ({ id: t.id, title: t.title, files: t.files })))}`,
      { label: `verify:r${r}`, phase: 'Verify', schema: VSCHEMA })
    const absent = (verify.filesPresent || []).filter((f) => !f.present).map((f) => f.id)
    // FABRICATION TRIPWIRE: buildGreen without pasted command output is unproven.
    if (verify.buildGreen && String(verify.evidence || '').trim().length < 40) {
      log(`⚠ Verify r${r}: buildGreen claimed with no pasted output — treating as unproven`)
      verify.buildGreen = false
    }
    const ok = verify.passed && verify.buildGreen && absent.length === 0
    if (ok) { log(`Verify r${r}: PASS (build green, all files present)`); verify.passed = true; break }
    const gaps = [...(verify.gaps || []), ...(absent.length ? [`Missing files for tasks: ${absent.join(', ')}`] : []), ...(verify.buildGreen ? [] : ['build/typecheck/lint not green'])]
    verify.passed = false
    log(`Verify r${r}: ${gaps.length} gap(s) — remediating`)
    await withRetry(`verify:fix:r${r}`, 'Verify',
      `Fix ALL of these gaps in ${REPO} with real code until the project builds/typechecks/lints clean and no stub remains, then commit+push (wf(verify): fix r${r}).\nGAPS:\n${J(gaps)}`, MAX_RETRY)
    await commitStage(`verify-fix-r${r}`, 'resolved verification gaps')
  }
}

// ── STAGE 7: QA (Testability incl. FAILURE scenarios + render-assert) ────────
let qa = { passed: true, tiers: [] }
if (willRun('qa')) {
  phase('QA')
  const QSCHEMA = {
    type: 'object', additionalProperties: false,
    properties: { passed: { type: 'boolean' }, command: { type: 'string' }, output: { type: 'string' }, surfacesCovered: { type: 'array', items: { type: 'string' } }, productDefects: { type: 'array', items: { type: 'string' } } },
    required: ['passed', 'command', 'output'],
  }
  const tiers = ['unit', 'integration', 'e2e']
  // PARALLEL TIERS (run wf_c6fc100f spent 61m serial; the two big tiers can run
  // concurrently). Safety: a SERIAL infra task owns every shared file first;
  // tier agents then touch ONLY their own test directory and never product
  // source — product defects funnel into ONE serial fix round after the barrier.
  await withRetry('qa:test-infra', 'QA',
    `Configure the TEST INFRASTRUCTURE ONLY in ${REPO}: test runners for unit + integration (and e2e incl. browser tooling if the product has a UI) per the repo's stack, package.json scripts, runner configs, and the per-tier test directory layout — but write NO actual tests. Install what's needed, prove each runner starts cleanly (empty/zero-test suite is fine), then commit+push (wf(qa): test infra). Report runners + commands configured.`, MAX_RETRY)
  await commitStage('qa-infra', 'test infrastructure (runners/configs/scripts)')
  const writeTier = (tier) => withRetry(`qa:${tier}`, 'QA',
    `Write and RUN ${tier.toUpperCase()} tests for the product in ${REPO} using the test infrastructure ALREADY configured (runners/scripts exist — do not reconfigure). Cover the acceptance criteria AND failure scenarios (errors/timeouts/retries/bad input/unauthorized). You MUST exercise the NEW surfaces/tasks (${J(tasks.map((t) => t.title))}), not only the pre-existing app. For UI e2e: navigate to each new surface, assert the SUCCESS SURFACE renders real content, and FAIL on any console/page error (a gone-loading-screen is NOT proof).\nHARD RULES (the other tier agents work in this SAME tree concurrently): create/edit files ONLY inside this tier's own test directory; do NOT touch package.json/lockfiles/runner configs or PRODUCT source. If a test exposes a real product defect, KEEP THE TEST FAILING and report the defect precisely (file, repro, expected vs actual) — a serial fix round handles product code after all tiers land. Report the command + a pasted tail of the test output + defects found.`, MAX_RETRY)
  const verifyTier = (tier) => agent(
    `Verify the ${tier} tier in ${REPO} is genuinely green and meaningfully exercises the acceptance criteria + a failure scenario + the NEW surfaces. RUN the tier's command yourself. Return passed, the command, a pasted output tail, surfacesCovered (which new surfaces/tasks the tier exercised), and productDefects (precise product-code defects this tier exposed; [] if none). FAIL (passed=false) if the suite is red or it only covers the pre-existing app.`,
    { label: `qa:${tier}:verify`, phase: 'QA', schema: QSCHEMA })
  await parallel(tiers.map((t) => () => writeTier(t)))
  let checks = (await parallel(tiers.map((t) => () => verifyTier(t).then((v) => ({ tier: t, v }))))).filter(Boolean)
  const failing = checks.filter((c) => !c.v || !c.v.passed || (c.v.productDefects || []).length)
  if (failing.length) {
    log(`QA barrier: ${failing.length} tier(s) red or exposing product defects — one serial fix round`)
    await withRetry('qa:product-fix', 'QA',
      `QA exposed product defects / red tiers in ${REPO}. Fix the PRODUCT root causes (NEVER weaken or delete a test), then re-run EACH failing tier's command until green and commit+push (wf(qa): product fixes).\nFAILING:\n${J(failing.map((f) => ({ tier: f.tier, defects: (f.v && f.v.productDefects) || [], output: f.v ? String(f.v.output).slice(0, 400) : 'no verdict' })))}`, MAX_RETRY)
    await commitStage('qa-product-fix', 'product defects exposed by QA')
    const recheck = (await parallel(failing.map((f) => () => verifyTier(f.tier).then((v) => ({ tier: f.tier, v }))))).filter(Boolean)
    checks = checks.map((c) => recheck.find((r) => r.tier === c.tier) || c)
  }
  const results = checks.map((c) => ({ tier: c.tier, passed: !!(c.v && c.v.passed), surfacesCovered: (c.v && c.v.surfacesCovered) || [] }))
  for (const r of results) log(`QA:${r.tier} — ${r.passed ? 'green' : 'NOT green'}`)
  qa = { tiers: results, passed: results.every((t) => t.passed) }
  await commitStage('qa', `tiers green=${qa.passed}`)
}

// ── STAGE 8: Acceptance (independent release gate + principle scorecard) ─────
let acceptance = null
if (willRun('acceptance')) {
  phase('Acceptance')
  const ASCHEMA = {
    type: 'object', additionalProperties: false,
    properties: {
      deployReady: { type: 'boolean' },
      criteria: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, met: { type: 'boolean' }, evidence: { type: 'string' } }, required: ['id', 'met'] } },
      principleScorecard: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { principle: { type: 'string' }, met: { type: 'boolean' }, note: { type: 'string' } }, required: ['principle', 'met'] } },
      blockers: { type: 'array', items: { type: 'string' } },
    },
    required: ['deployReady', 'blockers'],
  }
  acceptance = await agent(
    `You are the INDEPENDENT release gate. Be adversarial — inspect ${REPO} directly and RUN the build/tests. For EACH criterion in the structured CONTRACT below (use its exact ids) decide met/not-met with evidence (map each to a real file/test). Score each of the 14 architecture principles met/not-met with a note. Declare deployReady true ONLY if every criterion is met, the build is green, all QA tiers pass, AND the build ground-truth is clean. HARD RULE: if groundTruth.clean is false or verify.passed is false, deployReady MUST be false and list those as blockers.\nCONTRACT (criteria ids + checks):\n${J(CRITERIA)}\nSPEC:\n${intake.text}\ngroundTruth: ${J(GROUND_TRUTH)}\nverify.passed: ${J(!!verify.passed)}\nQA: ${J(qa)}\n${PRINCIPLES}`,
    { label: 'acceptance:gate', phase: 'Acceptance', schema: ASCHEMA })
  // Belt-and-suspenders: the script enforces the hard invariants regardless of the agent.
  const forcedBlockers = []
  if (!GROUND_TRUTH.clean) forcedBlockers.push(`Ground-truth ghosts unresolved: ${GROUND_TRUTH.ghosts.join(', ')}`)
  if (willRun('verify') && !verify.passed) forcedBlockers.push('Verify did not pass')
  if (willRun('qa') && !qa.passed) forcedBlockers.push('QA tiers not all green')
  if (UNCOVERED.length) forcedBlockers.push(`Spec-contract: criteria never covered by any plan task: ${UNCOVERED.join(', ')}`)
  if (REFUTE_GAPS.length && (!willRun('verify') || !verify.passed)) forcedBlockers.push(`Refuter findings unresolved: ${REFUTE_GAPS.length}`)
  // SPEC-CONTRACT completeness: the gate must have judged every contract id.
  const judged = new Set((acceptance.criteria || []).map((c) => String(c.id).toLowerCase()))
  const unjudged = CRITERIA.filter((c) => !judged.has(String(c.id).toLowerCase())).map((c) => c.id)
  if (unjudged.length) forcedBlockers.push(`Acceptance gate skipped contract criteria: ${unjudged.join(', ')}`)
  if (forcedBlockers.length) { acceptance.deployReady = false; acceptance.blockers = [...new Set([...(acceptance.blockers || []), ...forcedBlockers])] }
  log(`Acceptance: deployReady=${acceptance.deployReady}, blockers=${(acceptance.blockers || []).length}`)
}

// ── STAGE 9: Manifest + Lessons (Observability + Auditability + Learning) ────
if (willRun('manifest')) {
  phase('Manifest')
  const deployReady = acceptance ? (!!acceptance.deployReady && GROUND_TRUTH.clean && (!willRun('verify') || verify.passed)) : null
  const manifest = {
    repo: REPO,
    additive: ADDITIVE,
    stagesRun: ORDER.filter(willRun),
    specContract: { criteria: CRITERIA.length, uncovered: UNCOVERED, deferralFlags: DEFERRED_FLAGS },
    groundTruth: GROUND_TRUTH,
    refuteGapsRemaining: REFUTE_GAPS.length,
    build: buildResults.map((r) => ({ id: r.id, ok: r.ok, attempts: r.attempts })),
    verify: { passed: !!verify.passed },
    qa,
    acceptance,
    deployReady,
  }
  // LESSONS (Learning): convert this run's own failures into durable knowledge —
  // what broke, the root cause, and concrete harness-patch suggestions. The run
  // that only ships code learns nothing; the file is the compounding asset.
  await agent(
    `Write ${REPO}/docs/LESSONS.md (Markdown; OVERWRITE-SAFE: append a dated section if the file exists). From the run evidence below, document: (1) every failure/retry/ghost/refuted-claim/deferral with its ROOT CAUSE (read the repo/git history where needed); (2) what the harness caught vs what slipped to a later gate; (3) CONCRETE suggestions — for the BRIEF (what a better brief would have specified), for the WORKFLOW (gate/prompt changes, as patch-ready descriptions), and for the PRODUCT (follow-up work). No platitudes — every lesson must name evidence. Then commit+push (wf(manifest): lessons). Create/modify ONLY that file.\nRUN EVIDENCE:\n${J(manifest)}`,
    { label: 'manifest:lessons', phase: 'Manifest' })
  await agent(
    `Write a run report to ${REPO}/docs/RUN-REPORT.md (Markdown) capturing this build: additive vs greenfield, stages run, the spec-contract coverage (criteria count, uncovered ids, deferral flags), the ground-truth verdict (clean + any ghost task ids), refuter-wave outcome, per-task build status + retry counts, QA tier results, acceptance criteria results, the 14-principle scorecard, final deployReady, and any blockers. Then commit+push (wf(manifest): run report). Create/modify ONLY that file.\nMANIFEST DATA:\n${J(manifest)}`,
    { label: 'manifest:report', phase: 'Manifest' })
  return manifest
}

return { repo: REPO, stagesRun: ORDER.filter(willRun), groundTruth: GROUND_TRUTH, note: 'stopped before manifest' }
