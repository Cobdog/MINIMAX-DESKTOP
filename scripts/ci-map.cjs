#!/usr/bin/env node
'use strict'

/**
 * THE CI MANIFEST — path globs → affected vitest suites (task eg6l3v5,
 * remediation-plan §6 A-CI; directive 96e1fe5b + the maintainer's ruling:
 * "Testing should be fast but also accurate — not all or nothing … CI
 * should be for obvious things." → local = depth, CI = breadth + speed).
 *
 * This file is REVIEWED DATA, not logic: the rules below are the contract
 * the fast PR leg executes. It is greppable on purpose — to answer "what
 * does CI run when X changes", grep the path here.
 *
 * HOW IT RESOLVES — first-match-wins per changed file, rules in order:
 *   1. every rule whose glob set contains the file, in array order, FIRST
 *      hit owns the file (one rule per file keeps fan-out deterministic
 *      and this file honest — seam files get their own early rules);
 *   2. a file matching NO rule falls back to the FULL run and is reported
 *      as `unmatched` — never a silent under-run;
 *   3. `src/lib/**` and `server/**` have their own loud catch-alls (see
 *      reasons there) instead of relying on the global fallback.
 *
 * HONEST FAN-OUT: seam files (src/lib/workflow.ts, server/core.ts, …)
 * legitimately map to near-full runs and SAY so below. Nothing silently
 * under-runs: suites' build needs (dist-booting suites force build-first —
 * the stale-dist rule), python/ffmpeg needs, and the e2e escalation all
 * ride the same data.
 *
 * SELF-TEST: tests/ci-map.test.js walks this manifest — every catalog
 * suite exists on disk, every tests/*.test.js is catalogued and reachable
 * from at least one glob, seam fan-outs match their declared sets, and the
 * fallback fires for unmapped src/lib files. Adding a suite without
 * mapping it FAILS CI (the ci-map suite runs on every PR by its own rule).
 *
 * Local gate semantics are UNCHANGED (scripts/run-gate.cjs stays the full
 * depth chain); only CI is path-scoped.
 */

const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..')

/**
 * Suite catalog — every tests/*.test.js file. Fields:
 *   build   — what must be built BEFORE the suite runs (stale-dist rule):
 *             'server' = build:server, 'full' = web + server, null = none.
 *   windows — runs on the Engine CI (Windows) leg. DORMANT since the
 *             2026-09-21 demotion (scheduled-only leg): the flag stays as
 *             data for the weekly sweep + any future PR-path re-wiring.
 *   python  — needs python3 + numpy (benchmarks).
 *   ffmpeg  — needs ffmpeg on PATH (filmstrip, datasets synthetic ingest).
 * The ci-map self-test enforces this stays in lockstep with tests/.
 */
const SUITES = {
  benchmarks: { build: 'server', windows: true, python: true, ffmpeg: false },
  camera: { build: null, windows: false, python: false, ffmpeg: false },
  canvas: { build: null, windows: false, python: false, ffmpeg: false },
  'ci-map': { build: null, windows: false, python: false, ffmpeg: false },
  datasets: { build: 'server', windows: false, python: false, ffmpeg: true },
  documents: { build: 'server', windows: false, python: false, ffmpeg: false },
  'engine-process': { build: 'server', windows: true, python: false, ffmpeg: false },
  enginewatch: { build: null, windows: false, python: false, ffmpeg: false },
  fetcher: { build: 'server', windows: true, python: false, ffmpeg: false },
  filmstrip: { build: 'server', windows: false, python: false, ffmpeg: true },
  h3img: { build: null, windows: false, python: false, ffmpeg: false },
  instance: { build: 'full', windows: true, python: false, ffmpeg: false },
  launcher: { build: 'full', windows: false, python: false, ffmpeg: false },
  llm: { build: 'server', windows: false, python: false, ffmpeg: false },
  poserig: { build: null, windows: false, python: false, ffmpeg: false },
  realtime: { build: 'server', windows: false, python: false, ffmpeg: false },
  registry: { build: null, windows: false, python: false, ffmpeg: false },
  runtime: { build: 'server', windows: true, python: false, ffmpeg: false },
  storage: { build: 'server', windows: false, python: false, ffmpeg: false },
  workflows: { build: null, windows: false, python: false, ffmpeg: false },
}

/** Every suite that boots dist-server/server/index.js directly (route-level
 *  integration): the honest fan-out for the server seams. */
const BOOTING = ['datasets', 'documents', 'fetcher', 'filmstrip', 'instance', 'llm', 'realtime', 'runtime', 'storage']

/** Every suite drawing scratch ports through tests/lib/ports.cjs. */
const PORT_USERS = ['datasets', 'documents', 'engine-process', 'fetcher', 'filmstrip', 'instance', 'launcher', 'llm', 'realtime', 'runtime', 'storage']

/** The suites that load client TS through the VM harness (scripts/lib/ts-vm.cjs). */
const VM_SUITES = ['camera', 'canvas', 'enginewatch', 'h3img', 'poserig', 'registry', 'workflows']

/** Every vitest suite — the FULL fallback set. */
const ALL_SUITES = Object.keys(SUITES).sort()

/**
 * RULES — ordered, first-match-wins. Each: { match: [globs], suites, reason }.
 * Optional flags: forceE2e (run the Playwright e2e project on the PR leg
 * too), forceWindows (run the Windows leg's FULL set on PRs — the leg
 * verifying itself), lintAll (run the FULL lint instead of
 * changed-files-only).
 */
const RULES = [
  // ---------- CI + test infrastructure ---------------------------------
  {
    match: ['.github/workflows/engine-windows.yml'],
    suites: ['ci-map'],
    forceWindows: true,
    reason: 'DEMOTED TO SCHEDULED-ONLY (maintainer 2026-09-21: "Windows tests take the back seat … very low priority") — the leg no longer runs on PRs/main, so this escalation is DORMANT DATA: the windows flags + forceWindows machinery stay so the leg can be re-wired into the PR path without redesign if the posture reverses.',
  },
  {
    match: ['.github/**', 'scripts/ci-map.cjs', 'scripts/check-registry-append.cjs', 'tests/ci-map.test.js'],
    suites: ['ci-map'],
    reason: 'the CI contract tests itself — every PR touching CI or the manifest runs the manifest walk.',
  },
  {
    match: ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.server.json', 'vite.config.ts', 'vitest.config.ts'],
    suites: ALL_SUITES,
    reason: 'dependency / build / test infrastructure: anything can shift — full run (also on the Windows leg).',
  },
  {
    match: ['eslint.config.mjs', 'stylelint.config.mjs', '.gitattributes', '.gitignore'],
    suites: [],
    lintAll: true,
    reason: 'lint/config only — no unit suite, but the full lint runs.',
  },
  {
    match: ['playwright.config.ts', 'e2e/**'],
    suites: [],
    forceE2e: true,
    reason: 'browser suites own their own verification — run e2e when they change (vision stays main-only).',
  },
  {
    match: ['start.sh'],
    suites: ['launcher'],
    reason: 'start.sh is the launcher suite\'s subject.',
  },
  {
    match: ['scripts/lib/ts-vm.cjs'],
    suites: VM_SUITES,
    reason: 'the VM harness executes inside every client-module suite.',
  },
  {
    match: ['scripts/lib/registry-matrix.cjs', 'scripts/lib/krea2edit-matrix.cjs', 'scripts/fixtures/registry-golden.json', 'scripts/fixtures/krea2edit-golden.json'],
    suites: ['registry'],
    reason: 'registry golden machinery + fixtures.',
  },
  {
    match: ['scripts/lib/h3img-matrix.cjs', 'scripts/fixtures/h3img-golden.json'],
    suites: ['h3img'],
    reason: 'h3img golden machinery + fixture.',
  },
  {
    match: ['scripts/fixtures/camera-goldens.json', 'scripts/fixtures/camera-goldens.py'],
    suites: ['camera'],
    reason: 'camera golden fixture (+ its generator).',
  },
  {
    match: ['scripts/fixtures/poserig-goldens.json'],
    suites: ['poserig'],
    reason: 'poserig pose fingerprints.',
  },
  {
    match: ['scripts/fixtures/engine-child.cjs', 'scripts/fixtures/engine-child.py'],
    suites: ['engine-process'],
    reason: 'the supervised child the engine-process suite spawns.',
  },
  {
    match: ['scripts/fixtures/runtime-stub.cjs', 'scripts/fixtures/runtime-stub-crash.cjs'],
    suites: ['runtime'],
    reason: 'managed-runtime stub checkouts.',
  },
  {
    match: ['tests/lib/ports.cjs'],
    suites: PORT_USERS,
    reason: 'the port allocator draws ranges for every server-booting suite.',
  },
  {
    match: ['scripts/copy-llm-families.cjs'],
    suites: ['llm'],
    reason: 'copies the LLM family manifests the llm suite infers against (into dist-server).',
  },
  {
    match: ['vendor/**'],
    suites: ['fetcher', 'instance', 'runtime'],
    reason: 'vendored node packs: every install/link flow + the license audit (inputs tracked separately).',
  },
  {
    match: ['custom-nodes/**'],
    suites: [],
    reason: 'first-party node-pack payloads (the form adapter): install flows exercise them via engineNodes/fetcher; the lora-form suite that tested them directly died with the local scan (Wave 2 R-12).',
  },
  {
    match: ['benchmarks/**'],
    suites: ['benchmarks'],
    reason: 'the benchmark harness tree.',
  },
  {
    match: ['scripts/run-gate.cjs', 'scripts/smoke-server.cjs', 'scripts/compress-dist.cjs', 'scripts/vision-e2e/**', 'scripts/css-shot-diff.cjs', 'scripts/css-token-audit.cjs', 'scripts/css-token-codemod.cjs', 'scripts/stylelint-raw-color-allowlist.json', 'scripts/perf-profile/**'],
    suites: [],
    reason: 'local-only tooling (gate chain, vision driver, css audits): exercised by the main gate, not unit suites.',
  },
  {
    match: ['scripts/**'],
    suites: [],
    reason: 'one-off scripts/codemods — no unit suite; add a precise rule above if a suite starts depending on one.',
  },

  // ---------- server (behavioral map from each suite's imports) --------
  {
    match: ['server/index.ts', 'server/core.ts'],
    suites: BOOTING,
    reason: 'SEAM — the server composition root: every booting suite executes it. Near-full by design; do not narrow.',
  },
  {
    match: ['server/logger.ts', 'server/logSanitize.ts', 'server/requestGuard.ts', 'server/repo.ts'],
    suites: BOOTING,
    reason: 'shared server utilities in the index/core import closure — every booting suite loads them.',
  },
  { match: ['server/db.ts'], suites: ['datasets', 'documents', 'storage'], reason: 'the sqlite layer: migrations (documents), dataset tables (datasets), jobs/library (storage).' },
  { match: ['server/documents.ts', 'server/documentArchive.ts'], suites: ['documents'], reason: 'document store + zip archive.' },
  { match: ['server/realtime.ts'], suites: ['realtime'], reason: 'WS realtime framing/delivery.' },
  { match: ['server/llm/**'], suites: ['llm'], reason: 'LLM family registry + providers.' },
  { match: ['server/datasets/**'], suites: ['datasets'], reason: 'dataset manager domain.' },
  { match: ['server/engineProcess.ts'], suites: ['engine-process', 'runtime'], reason: 'process supervision — its own suite + the runtime manager.' },
  { match: ['server/engineProfiles.ts'], suites: ['runtime'], reason: 'engine profile merge/resolve.' },
  { match: ['server/enginePatch.ts'], suites: ['runtime'], reason: 'engine patch application.' },
  { match: ['server/engineNodes.ts'], suites: ['fetcher', 'instance', 'runtime'], reason: 'the node-pack registry: every install/pack flow (also a license-audit input).' },
  { match: ['server/fetchCatalog.ts'], suites: ['benchmarks', 'fetcher'], reason: 'fetch catalog: the fetcher consumer + the benchmarks catalog bridge.' },
  { match: ['server/fetcher.ts'], suites: ['fetcher'], reason: 'fetch transport + tar extraction.' },
  { match: ['server/instanceInventory.ts', 'server/packVersioning.ts'], suites: ['instance'], reason: 'external-instance inventory + pack versioning.' },
  { match: ['server/objectInfoProbe.ts'], suites: ['fetcher', 'instance'], reason: 'the targeted object_info presence probe (Wave 2 A-8): executes on the engine/nodes + bootstrap routes the instance suite drives; fetcher exercises the pack-board flows that consume it.' },
  { match: ['server/runtime.ts'], suites: ['runtime'], reason: 'managed ComfyUI runtime.' },
  {
    match: ['server/**'],
    suites: BOOTING,
    reason: 'LOUD CATCH-ALL — an unmapped server module is conservatively the booting closure (a new server file imported by core.ts executes in every booting suite). Map it precisely instead.',
  },

  // ---------- tests themselves ------------------------------------------
  {
    match: ['tests/*.test.js'],
    suites: null, // special: the file's own suite (basename minus .test.js)
    suiteFromFile: true,
    reason: 'a suite file always runs itself.',
  },
  {
    match: ['tests/**'],
    suites: [],
    reason: 'test helpers/fixtures — the load-bearing ones (ports.cjs, ci-map) have their own rules above.',
  },

  // ---------- src client (VM-harness module map) ------------------------
  {
    match: ['src/lib/workflow.ts'],
    suites: ['canvas', 'h3img', 'poserig', 'registry', 'workflows'],
    reason: 'SEAM — the graph builder every client suite loads. Near-full client fan-out by design; do not narrow.',
  },
  {
    match: ['src/canvas/store.ts'],
    suites: ['canvas'],
    forceE2e: true,
    reason: 'SEAM — the app kernel. HONEST LIMIT: no unit suite executes store.ts directly (the canvas VM modules are its projections); the PR leg forces e2e as the behavioral net, local depth + the main gate own the rest.',
  },
  {
    match: ['src/canvas/camera.ts', 'src/canvas/derive.ts', 'src/canvas/generation.ts', 'src/canvas/loraTimeline.ts', 'src/canvas/ops.ts', 'src/canvas/options.ts', 'src/canvas/plan.ts', 'src/canvas/stillIntent.ts'],
    suites: ['canvas'],
    reason: 'the canvas logic modules the canvas suite loads through the VM harness.',
  },
  { match: ['src/lib/camera/**'], suites: ['camera'], reason: 'camera path model + parity goldens.' },
  { match: ['src/poserig/**'], suites: ['poserig'], reason: 'pose rig domain (logic modules; PoseRigApp.tsx rides the dir).' },
  { match: ['src/lib/graph/h3image.ts'], suites: ['canvas', 'h3img', 'registry', 'workflows'], reason: 'the H3 image graph factory — loaded by four suites.' },
  { match: ['src/lib/graph/krea2edit.ts'], suites: ['h3img', 'registry'], reason: 'Krea-2 edit families (h3img directly; registry via graph/index re-export + golden).' },
  { match: ['src/lib/graph/**'], suites: ['registry'], reason: 'the optimization registry surface (graph/index re-exports the tree; the registry golden is the contract).' },
  { match: ['src/lib/serverStorage.ts'], suites: ['storage'], reason: 'the client storage layer the storage suite transpiles + drives against the server.' },
  { match: ['src/lib/workspace.ts'], suites: ['registry'], reason: 'workspace selection resolution.' },
  { match: ['src/lib/h3imageContract.ts', 'src/lib/h3imageOps.ts', 'src/lib/h3imageScorer.ts', 'src/lib/h3imageStaging.ts'], suites: ['h3img'], reason: 'H3 image contract/ops/scorer/staging.' },
  {
    match: ['src/lib/engineWatch.ts', 'src/lib/fabricWatch.ts', 'src/lib/dbg.ts', 'src/lib/preflight.ts'],
    suites: ['enginewatch'],
    reason: 'Wave-1 pure decision modules (jpc96dp: re-check cadence, WS re-probe/resync, the A-DBG tagged logger, submit preflight) — the enginewatch suite drives them through the VM harness.',
  },
  {
    match: ['src/lib/nodePackRegistry.ts'],
    suites: ['enginewatch', 'fetcher', 'instance', 'runtime'],
    reason: 'the node-pack registry DATA (extracted from server/engineNodes, Wave 1 R-02 — one source of truth): every pack flow asserts it, preflight (enginewatch) reads it; also a license-audit input.',
  },
  {
    match: ['src/lib/promptError.ts'],
    suites: ['workflows'],
    reason: 'structural prompt-error classification — extracted pure (Wave 1) so the workflows suite drives it; server/core re-imports it.',
  },
  { match: ['src/lib/aceStepSubmit.ts', 'src/lib/cameraPath.ts', 'src/lib/h3Submit.ts', 'src/lib/music3Submit.ts', 'src/lib/structuredPrompt.ts'], suites: ['canvas'], reason: 'submit/structured-prompt modules the canvas suite loads.' },
  { match: ['src/images/submit.ts'], suites: ['canvas'], reason: 'image submit flow (canvas suite).' },
  { match: ['src/images/session.ts'], suites: ['h3img'], reason: 'image session model (h3img suite).' },
  {
    match: ['src/lib/modelSelection.ts'],
    suites: ['registry', 'workflows'],
    reason: 'selection inference — loaded directly by both suites.',
  },
  {
    match: [
      'src/lib/imageCrop.ts', 'src/lib/promptPresets.ts', 'src/lib/modelOverrides.ts',
      'src/lib/h3Stack.ts', 'src/lib/manifest.ts', 'src/lib/music3Workflow.ts', 'src/lib/aceStepWorkflow.ts',
      'src/lib/jobReducer.ts', 'src/lib/logSanitize.ts', 'src/lib/libraryStorage.ts', 'src/lib/promptContracts.ts',
      'src/lib/promptComposer.ts', 'src/lib/promptPolicies.ts', 'src/lib/dialogPolicy.ts', 'src/lib/promptCorpus.ts',
      'src/lib/promptLibraryStorage.ts', 'src/lib/contactSheet.ts', 'src/lib/failureTaxonomy.ts',
      'src/lib/diagnosticReport.ts', 'src/lib/promptWatch.ts',
    ],
    suites: ['workflows'],
    reason: 'the workflows suite\'s module list (loaded through the VM harness).',
  },
  {
    match: [
      'src/lib/accessoryLibrary.ts', 'src/lib/apiClient.ts', 'src/lib/characterLibrary.ts', 'src/lib/comfyInfo.ts',
      'src/lib/createId.ts', 'src/lib/doctor.ts', 'src/lib/format.ts', 'src/lib/h3Diagnostics.ts',
      'src/lib/hairLibrary.ts', 'src/lib/jobRecords.ts', 'src/lib/loafObserver.ts', 'src/lib/locationLibrary.ts',
      'src/lib/mediaUrls.ts', 'src/lib/useLivePreview.ts', 'src/lib/useLlmStream.ts', 'src/lib/useRealtime.ts',
      'src/lib/wardrobeLibrary.ts',
    ],
    suites: [],
    reason: 'UNTESTED CLIENT LIBS (explicit, reviewed 2026-09-20 walk): consumed only by UI code — typecheck + scoped lint on PRs, e2e/vision on the main gate. A NEW src/lib file must NOT silently land here: it hits the loud full-run rule below until mapped or added to this list by review.',
  },
  {
    match: ['src/lib/**'],
    suites: ALL_SUITES,
    reason: 'LOUD CATCH-ALL — an unmapped src/lib module is suspicious (this is the tested tree): full run until it gets a precise rule. Deliberately not silent.',
  },

  // ---------- UI surface (deliberately no unit coverage) ----------------
  {
    match: ['src/canvas/**', 'src/components/**', 'src/hooks/**', 'src/images/**', 'src/media/**', 'src/prototypes/**', 'src/state/**', 'src/surfaces/**', 'src/ui/**', 'src/views/**', 'src/datasets/**', 'src/*.tsx', 'src/*.ts', 'src/*.css', 'src/**/*.css', 'index.html', 'public/**'],
    suites: [],
    reason: 'UI surface — no unit suite executes components/views/state (deliberate: typecheck + scoped lint on PRs, e2e + vision on the main gate, local depth via pnpm gate).',
  },

  // ---------- docs / meta ------------------------------------------------
  {
    match: ['docs/**', '*.md', 'LICENSE', 'Readmescreenshots/**', '.flux/**', '.claude/**'],
    suites: [],
    reason: 'docs/meta only — nothing to run (the pre-A-CI gate ran 8 minutes on these diffs; that is dead).',
  },
]

/** License-audit inputs, evaluated independently of the rules (the audit is
 *  cheap but its inputs are exactly these — deps, vendored packs, the
 *  node-pack registry, the recorded decisions). */
const LICENSE_INPUTS = ['package.json', 'pnpm-lock.yaml', 'vendor/**', 'server/engineNodes.ts', 'src/lib/nodePackRegistry.ts', 'docs/LICENSES.md', 'scripts/audit-licenses.cjs']

/** Extensions eslint lints (flat config lints js/ts across the repo). */
const ESLINT_EXT = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx'])
const STYLELINT_EXT = new Set(['.css'])

// ---------------------------------------------------------------- helper

/** Minimal glob → RegExp: '**' segment = anything (with /), '*' inside a
 *  segment = no /, everything else literal. Covers every shape this
 *  manifest uses; no deps on purpose. */
function globToRegExp(glob) {
  const escaped = glob.split('/').map((segment) => {
    if (segment === '**') return '(?:[^/]+/)*[^/]+'
    return segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')
  })
  return new RegExp(`^${escaped.join('/')}$`)
}

const COMPILED = RULES.map((rule) => ({ ...rule, regexes: rule.match.map(globToRegExp) }))
const LICENSE_REGEXES = LICENSE_INPUTS.map(globToRegExp)

function suiteFromFile(testPath) {
  const base = path.basename(testPath)
  const m = /^(.+)\.test\.js$/.exec(base)
  return m ? m[1] : null
}

// --------------------------------------------------------------- resolve

/**
 * resolve(changedPaths) → the fast-leg plan. Pure data in, plan out:
 *   suites         sorted vitest filter args (empty = nothing to run)
 *   fullRun        true when a rule (or the fallback) selected everything
 *   buildTier      null | 'server' | 'full' — max of selected suites' needs
 *   runE2e         Playwright e2e on the PR leg (forced files or fullRun)
 *   lintFiles      changed files eslint should lint (existing files only)
 *   stylelintFiles changed css files
 *   lintAll        run the FULL lint (config-file changes)
 *   licenseAudit   any license-audit input changed
 *   python/ffmpeg  selected suites need python3+numpy / ffmpeg
 *   windowsSuites  resolved ∩ the Windows leg's set (all of it on fullRun
 *                  or when the Windows workflow itself changed)
 *   windowsPython  the Windows leg needs python+numpy (from ITS suites)
 *   matched        [{ file, suites, reason }] per changed file (audit trail)
 *   unmatched      files that hit the global fallback (loud in CI logs)
 */
function resolve(changed) {
  const suites = new Set()
  const matched = []
  const unmatched = []
  let fullRun = false
  let runE2e = false
  let forceWindows = false
  let lintAll = false
  const lintFiles = []
  const stylelintFiles = []

  for (const file of changed) {
    const clean = String(file).replace(/\\/g, '/').trim()
    if (!clean) continue
    let hit = null
    let ruleSuites = null
    for (const rule of COMPILED) {
      if (rule.regexes.some((re) => re.test(clean))) {
        hit = rule
        ruleSuites = rule.suiteFromFile ? [suiteFromFile(clean)] : rule.suites
        break
      }
    }
    if (!hit) {
      unmatched.push(clean)
      fullRun = true
      matched.push({ file: clean, suites: ALL_SUITES, reason: 'NO RULE MATCHED — global fallback: full run. Map the file in scripts/ci-map.cjs.' })
      continue
    }
    if (hit.suiteFromFile && !SUITES[ruleSuites[0]]) {
      // tests/<name>.test.js whose name is not a catalogued suite — the
      // self-test forbids this state; resolve defensively to full.
      fullRun = true
      matched.push({ file: clean, suites: ALL_SUITES, reason: `test file "${clean}" is not in the ci-map catalog — catalog it in scripts/ci-map.cjs SUITES (tests/ci-map.test.js enforces this).` })
      continue
    }
    matched.push({ file: clean, suites: ruleSuites, reason: hit.reason })
    if (hit.forceE2e) runE2e = true
    if (hit.forceWindows) forceWindows = true
    if (hit.lintAll) lintAll = true
    if (ruleSuites === ALL_SUITES || (ruleSuites.length === ALL_SUITES.length && ruleSuites.every((s) => ALL_SUITES.includes(s)))) fullRun = true
    for (const s of ruleSuites) suites.add(s)
  }

  if (fullRun) for (const s of ALL_SUITES) suites.add(s)
  if (fullRun) runE2e = true

  const selected = [...suites].filter((s) => SUITES[s]).sort()
  const buildTier = selected.reduce((tier, s) => {
    const need = SUITES[s].build
    if (need === 'full') return 'full'
    if (need === 'server' && tier !== 'full') return 'server'
    return tier
  }, null)
  const windowsSuites = forceWindows
    ? Object.keys(SUITES).filter((s) => SUITES[s].windows).sort()
    : selected.filter((s) => SUITES[s].windows).sort()
  // The Windows leg's OWN tool flags — derived from its suite set, not from
  // the ubuntu selection (forceWindows can escalate one without the other).
  const windowsPython = windowsSuites.some((s) => SUITES[s].python)

  for (const file of changed) {
    const clean = String(file).replace(/\\/g, '/').trim()
    if (!clean) continue
    const ext = path.posix.extname(clean)
    if (!fs.existsSync(path.join(REPO, clean))) continue // deleted files have nothing to lint
    if (ESLINT_EXT.has(ext)) lintFiles.push(clean)
    if (STYLELINT_EXT.has(ext)) stylelintFiles.push(clean)
  }

  const licenseAudit = changed.some((file) => {
    const clean = String(file).replace(/\\/g, '/').trim()
    return LICENSE_REGEXES.some((re) => re.test(clean))
  })

  return {
    suites: selected,
    fullRun,
    buildTier,
    runE2e,
    lintFiles,
    stylelintFiles,
    lintAll,
    licenseAudit,
    python: selected.some((s) => SUITES[s].python),
    ffmpeg: selected.some((s) => SUITES[s].ffmpeg),
    windowsSuites,
    windowsPython,
    matched,
    unmatched,
  }
}

// ------------------------------------------------------------------ CLI

function printHuman(plan) {
  console.log(`CI-MAP — ${plan.matched.length} changed file(s)`)
  for (const m of plan.matched) {
    console.log(`  ${m.file}`)
    console.log(`      → ${m.suites.length ? m.suites.join(' ') : '(no unit suites)'}${m.reason ? ` — ${m.reason}` : ''}`)
  }
  if (plan.unmatched.length) console.log(`  UNMATCHED (full-run fallback): ${plan.unmatched.join(', ')}`)
  console.log('')
  console.log(`  suites:        ${plan.suites.length ? plan.suites.join(' ') : '(none)'}`)
  console.log(`  build:         ${plan.buildTier ?? 'none'}`)
  console.log(`  e2e on PR leg: ${plan.runE2e}`)
  console.log(`  lint:          ${plan.lintAll ? 'FULL' : plan.lintFiles.length ? plan.lintFiles.join(' ') : '(no lintable changes)'}`)
  console.log(`  stylelint:     ${plan.stylelintFiles.length ? plan.stylelintFiles.join(' ') : '(none)'}`)
  console.log(`  license:audit: ${plan.licenseAudit}`)
  console.log(`  python/numpy:  ${plan.python}   ffmpeg: ${plan.ffmpeg}`)
  console.log(`  windows leg:   ${plan.windowsSuites.length ? plan.windowsSuites.join(' ') : '(skipped — no OS-sensitive surface touched)'}`)
}

/** --gha: emit the plan as GitHub Actions outputs (multi-line safe). */
function writeGha(plan) {
  const out = process.env.GITHUB_OUTPUT
  const pairs = [
    ['suites', plan.suites.join(' ')],
    ['suites_json', JSON.stringify(plan.suites)],
    ['full_run', String(plan.fullRun)],
    ['build_tier', plan.buildTier ?? 'none'],
    ['run_e2e', String(plan.runE2e)],
    ['lint_all', String(plan.lintAll)],
    ['lint_files', plan.lintFiles.join(' ')],
    ['stylelint_files', plan.stylelintFiles.join(' ')],
    ['license_audit', String(plan.licenseAudit)],
    ['python', String(plan.python)],
    ['ffmpeg', String(plan.ffmpeg)],
    ['windows_suites', plan.windowsSuites.join(' ')],
    ['windows_python', String(plan.windowsPython)],
    ['unmatched', plan.unmatched.join(' ')],
  ]
  const body = pairs.map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
  if (out) fs.appendFileSync(out, body)
  else process.stdout.write(body)
}

function main() {
  const argv = process.argv.slice(2)
  const gha = argv.includes('--gha')
  const json = argv.includes('--json')
  const files = argv.filter((a) => !a.startsWith('--'))
  let changed = files
  if (files.length === 0 && !process.stdin.isTTY) {
    changed = fs.readFileSync(0, 'utf8').split(/\r?\n/).filter(Boolean)
  }
  if (changed.length === 0) {
    console.error('usage: node scripts/ci-map.cjs [--gha|--json] [file ...]  (or file list on stdin)')
    process.exit(2)
  }
  const plan = resolve(changed)
  if (json) console.log(JSON.stringify(plan, null, 2))
  else if (gha) writeGha(plan)
  else printHuman(plan)
}

if (require.main === module) main()

module.exports = { SUITES, RULES, LICENSE_INPUTS, ALL_SUITES, BOOTING, PORT_USERS, VM_SUITES, resolve, globToRegExp, suiteFromFile }
