export const meta = {
  name: 'review-hardening',
  description: 'ROUND 2 regression review of the rewritten sdlc-prod.js + additive-wave.js: confirm each of the 11 prior must-fix holes is now CLOSED with evidence from the new code, and hunt for anything the rewrite introduced. Synthesize a ship verdict.',
  phases: [{ title: 'Attack' }, { title: 'Synthesize' }],
}

const FILES = {
  sdlc: '/Users/danelmini/nanoclaw-v2/.claude/workflows/sdlc-prod.js',
  additive: '/Users/danelmini/nanoclaw-v2/.claude/workflows/additive-wave.js',
}
const PRIOR = `These two files were REWRITTEN to close holes a prior review found. The prior CRITICAL/HIGH holes you must now confirm CLOSED (cite the new code that closes each, or report still-open):
1. FILELESS-TASK BYPASS: plan files[] was optional; taskLanded returned set.length>0 for fileless tasks. (New: PLAN_SCHEMA requires files[] minItems:1; taskLanded returns false for no-files; tasks filtered to those with files.)
2. HOLLOW TRIPWIRE UNREACHABLE (baseRef before baseline commit): baseRef captured before baseline/integrate churn. (New: baseRef captured AFTER the build-scaffold commit; hollowness judged per-feature-task via parsed numstat, not global count.)
3. additive-wave HAD NO GIT GATE: (New: gateEvidence + parseReal + surfaceInDiff + git ls-files per surface; built⇒in diff, skipped⇒on disk; hard-failure terminal GT.clean.)
4. FALSE-GREENFIELD CLOBBER (prose-length classifier): (New: schema'd {greenfield,conventions} boolean with retry; uncertain⇒additive; scaffold prompt has a no-clobber guard; baseline branch handles the empty-repo edge.)
5. 2-ROUND LOOP, NO TERMINAL FAILURE, verify didn't gate QA/Acceptance: (New: GROUND_TRUTH.clean sentinel; Acceptance forced deployReady=false on !clean/!verify/!qa; Manifest deployReady ANDs all; VSCHEMA requires buildGreen+filesPresent; QSCHEMA requires command+output.)
6. FUZZY taskLanded SUBSTRING FALSE-POSITIVES: (New: fileLanded uses suffix-only match nc===nf || endsWith('/'+...) with added>=MIN_ADDED; no bidirectional substring; empties excluded by regex parse.)
7. DIFF-REPORTER AGENT COULD ECHO THE PLAN: (New: agent only pastes RAW numstat/porcelain; the SCRIPT parses it via parseReal; head==baseRef is flagged.)
8. RESUME/STALE-LABEL: constant gt labels across loop. (New: loop-indexed labels gt:evidence:r${'${g}'}, aw:gate:r${'${g}'}; baseRef is a memoized post-baseline value.)
9. QA 'BUILD GREEN' PROVES NOTHING for additive: (New: QA prompt+verify require exercising NEW surfaces, surfacesCovered, render-assert e2e.)
10. PARALLEL FILE-COLLISION: disjointness prose-only. (New: partitionDisjoint splits colliding tasks to run SERIAL; parallel only for disjoint files.)
11. GITIGNORED FEATURE PATH: (Partially addressed via IGNORE_PATH parse; confirm whether a planned feature path under .gitignore can still vanish — report if still open.)`

const FIND = {
  type: 'object', additionalProperties: false,
  properties: {
    lens: { type: 'string' },
    priorHolesStillOpen: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { num: { type: 'string' }, why: { type: 'string' } }, required: ['num', 'why'] } },
    newHoles: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { scenario: { type: 'string' }, severity: { type: 'string' }, file: { type: 'string' }, fix: { type: 'string' } }, required: ['scenario', 'severity', 'fix'] } },
    parserSafe: { type: 'boolean' }, resumeSafe: { type: 'boolean' }, greenfieldSafe: { type: 'boolean' }, closesHollowBuild: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['lens', 'priorHolesStillOpen', 'newHoles', 'closesHollowBuild'],
}

const LENSES = [
  { key: 'hollow-escape', q: `Try HARD to find ANY path where a build/wave that produced NO real feature files (or per-task/per-surface ghosts) still reaches a green/deployReady/verified verdict. Pay special attention to the new deterministic numstat gate: can the diff-reporter agent still defeat it? can incidental baseline churn still mask a hollow build now that baseRef is post-baseline? can a surface key false-match? Confirm prior holes 1,2,3,5,6,7 closed or report open.` },
  { key: 'js-logic', q: `Read both files as JavaScript and hunt for real bugs introduced by the rewrite: the parseReal numstat regex (tabs, binary "-" rows), fileLanded/surfaceInDiff matching, partitionDisjoint logic, the GROUND_TRUTH module var threading into Verify/Acceptance/Manifest, the forcedBlockers logic, schema validity (RAW_SCHEMA, PLAN_SCHEMA minItems, VSCHEMA/QSCHEMA required, additive-wave dynamic auditProps + GATE_SCHEMA). Report file:concept + fix.` },
  { key: 'greenfield-regression', q: `Confirm prior holes 4 closed: schema'd greenfield boolean, retry, uncertain⇒additive, scaffold no-clobber guard, baseline empty-repo edge. Can a greenfield project now end up with no scaffold/observability? Can an existing repo still be clobbered? Can the repo-audit failing leave ADDITIVE wrong? Report open/closed + fixes.` },
  { key: 'parser-resume-collision', q: `Confirm prior holes 8,10 closed. Check: loop-indexed gt labels; baseRef memoization stability across resume AND post-baseline positioning; partitionDisjoint correctly serializes colliding tasks; parallel() thunks have no chained .then().catch(); additive-wave gateEvidence/verify labels are loop-indexed. Also reassess gitignored-path hole 11. Report open/closed + fixes.` },
]
async function attack(l) {
  const r = await agent(
    `You are an adversarial ROUND-2 reviewer (lens: ${l.key}). Read these two files IN FULL on disk: ${FILES.sdlc} and ${FILES.additive}. ${PRIOR}\n\nTASK: ${l.q}\n\nBe concrete and skeptical. For each prior hole in your scope, decide CLOSED (cite the new line/mechanism) or STILL-OPEN (priorHolesStillOpen with num + why). Report any NEW hole the rewrite introduced. Set closesHollowBuild=false ONLY if you can show a concrete path where a hollow/incomplete build ships green. Do NOT edit any file.`,
    { label: `attack:${l.key}`, phase: 'Attack', schema: FIND })
  return r
}
phase('Attack')
const findings = (await parallel(LENSES.map((l) => () => attack(l)))).filter(Boolean)

phase('Synthesize')
const SYNTH = {
  type: 'object', additionalProperties: false,
  properties: {
    shipReady: { type: 'boolean' },
    closesHollowBuild: { type: 'boolean' },
    priorHolesStillOpen: { type: 'array', items: { type: 'string' } },
    mustFix: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { scenario: { type: 'string' }, file: { type: 'string' }, fix: { type: 'string' }, severity: { type: 'string' } }, required: ['scenario', 'fix', 'severity'] } },
    niceToHave: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
  required: ['shipReady', 'closesHollowBuild', 'mustFix', 'summary'],
}
const synth = await agent(
  `Synthesize these round-2 adversarial reviews. shipReady=true ONLY if (a) no prior CRITICAL/HIGH hole remains open, (b) no NEW critical/high hole was introduced, and (c) a build/wave that wrote zero real feature files cannot reach green/deployReady/verified. closesHollowBuild reflects (c). List any prior holes still open and only REAL must-fix items, ranked by severity.\nREVIEWS:\n${JSON.stringify(findings)}`,
  { label: 'synthesize', phase: 'Synthesize', schema: SYNTH })

return { findings, synth }
