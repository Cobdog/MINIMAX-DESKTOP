# Testing — the gate, the vitest unit phase, the vision loop, CI

> Trigger: read this BEFORE running, extending, or debugging the test suites
> or CI. The user-facing summary lives in the README's Testing section; this
> is the operator's view with the gotchas.
>
> **Vitest migration (task z7ogmig, 2026-09-20):** the unit suites moved from
> 19 serially-chained `scripts/test-*.cjs` scripts to `tests/*.test.js` under
> ONE vitest invocation with parallel worker processes. Assertion bodies
> carried over verbatim (node:assert + the suites' own ok()/check() helpers —
> deliberately NOT rewritten to expect(); zero-drift by construction). The
> VM harness (scripts/lib/ts-vm.cjs) is kept as the environment for the pure
> client modules. Playwright e2e + vision are untouched.

## TMPDIR first

Any suite that writes real scratch (notably `test:llm`) can flake with `EDQUOT` when the box's /tmp
tmpfs is full — this is the machine's recurring failure mode. Run with
`TMPDIR=/home/agent/tmp-gpu` (any /home path) unless you have a reason not
to. CI runners have fresh /tmp; the flake is local-only and never caused by
your change (verify by looking at what the failing write was).

## The dev loop — vitest watch (the point of the migration)

```bash
pnpm test:watch        # vitest watch: re-runs the files you touch, instantly
pnpm test:registry     # one suite (alias = vitest filter) while iterating
pnpm test              # all unit suites, one vitest run, parallel workers
```

Tests within a file run SEQUENTIALLY (a suite's sections share state by
design); files run in PARALLEL fork processes (process-per-file — same
isolation the old per-script node processes had, and process.env mutations
like runtime's NODE_TLS_REJECT_UNAUTHORIZED stay contained). `vitest.config.ts`
pins the shape: forks pool, maxForks 8 (the shared dev box is polite; CI
runners use their natural core count), 20-minute test ceiling.

## Local-only e2e flakes from shared-home accumulation (learned 2026-09-18, fh94g76)

The e2e datasets tests are NOT idempotent against their own accumulation in
the shared `test-home`: every run of the caption-editor test seeds another
`e2e-clip` layer set on the same master, and once an OLD 4:3-aspect layer
becomes the list's `.first()`, the 4:3 chip is already-active (disabled)
and the click times out. Reproduces on `main`; passes on CI (fresh homes). If
`datasets.spec.ts` fails locally on an aspect-chip click, clean the
synthetic fixtures through the app's own API — boot a scratch server on
`test-home`, `POST /api/lan/datasets/sources/trash` for each `e2e-clip` /
`vision-clip` source, then `POST /api/lan/datasets/trash/empty` — and
re-run. Never delete files by hand (the deletion policy). The same class of
problem applies to ANY e2e test that matches `.first()` over accumulating
state: suspect the shared home before the diff.

## The gate

```bash
TMPDIR=/home/agent/tmp-gpu pnpm gate
```

Runs the entire verification chain in canonical order — `typecheck` →
`lint` → `license:audit` → `build` → `unit` (ONE `vitest run` covering every
`tests/*.test.js` suite: workflows, registry, h3img, storage, documents,
realtime, filmstrip, llm, engine-process, runtime, fetcher, instance,
poserig, camera, canvas, benchmarks, launcher, datasets) →
`smoke:server` → e2e → vision-capture — each gate step in its own process,
wall-clock timed, known-benign output filtered (the filter tally prints so
nothing disappears silently), one summary table, non-zero exit on any
failure. A failed `build` skips only its dependents (unit/smoke/e2e/vision).

- **Build runs BEFORE the unit phase** (dated z7ogmig, 2026-09-20): the
  old order ran the dist-server-booting suites against whatever dist was
  lying around — a stale-dist false-green hazard. A fresh build now always
  precedes them. The launcher suite (which needs dist for its real-boot
  leg) rides inside the unit phase for the same reason.
- `test:registry` proves the optimization-registry inertness contract
  against golden fixtures — regenerate deliberately
  (`pnpm test:registry:update` = `MINIMAX_UPDATE_GOLDEN=1 vitest run
  registry`; on PowerShell set the env var first) and review the diff; the
  fixture IS the contract. Same pattern for `pnpm test:h3img:update`.
  (Vitest swallows forwarded CLI flags, so the env VAR is the mechanism —
  the `--` passthrough does not reach process.argv.)
- (The `test:lora-form` suite was removed with the local model scan —
  Wave 2 R-12, 2026-09-20: modelForms.ts and its tests died together; git
  history is the archive. The python3+numpy requirement lives on for the
  benchmarks suite only.)
- `test:datasets` (sv14rt0) boots the built server on a scratch home and
  drives the dataset manager with SYNTHETIC ffmpeg testsrc clips (never
  committed media); it needs ffmpeg on PATH.
- `test:instance` (9om4bi9) covers the external-instance integration: the
  route sections self-skip without the web build (the Windows-leg NOTE
  pattern — runtime/fetcher share it).
- `test:launcher` (ukyxwfa) drives the real `start.sh` under `sh` with
  hermetic scratch configs and probed 7000–7099 ports; NOTE-skips on win32.
  Every section pins a probed MINIMAX_VITE_PORT (dated z7ogmig fix —
  main's sections (b)/(c)/(e)/(f) probed the default 5173, which a foreign
  listener squats on this box; never assume 4178/5173 are free).

## Writing / porting unit suites (tests/*.test.js)

- ESM header with a `createRequire` shim so ported `require()` lines and
  `__dirname`/REPO anchors keep working; see any existing port
  (`tests/filmstrip.test.js` is the smallest server-suite example,
  `tests/h3img.test.js` the VM-harness example).
- **Ports, not fixtures**: every server-booting suite draws ports from
  `tests/lib/ports.cjs` (`makePortAllocator('<suite>')`) — DISJOINT
  per-suite ranges, each allocation probe-verified (something on this box
  squats on 4321) and never reused within a process. The old random
  ranges OVERLAPPED (storage∩filmstrip∩realtime∩documents, llm∩datasets),
  which was only safe under the serial gate. Register a new suite's range
  in that file; never assume 4178/5173/4199 are free (shared box).
- Homes are `mkdtemp` per file (TMPDIR discipline above); suites must never
  share scratch state across files.
- Skip patterns are conditional test registration (`const maybe = cond ?
  test : test.skip`) with the NOTE console.log preserved — never
  `process.exit`.
- The VM-harness pitfalls still apply to anything loaded through
  `scripts/lib/ts-vm.cjs`: the harness transpiles TS to an ES3-ish target —
  `matchAll` loops and iterator spreads (`[...map.entries()]`,
  `[...new Set()]`) silently no-op — use regex `exec` loops and
  `Array.from`. Cross-realm arrays fail `deepEqual`; compare `.join('|')`
  strings. Relative-import modules need the two-file loader pattern (see
  the promptLibraryStorage test block in tests/workflows.test.js).

## The truth ladder — wiring-truth vs execution-truth vs contract-truth (8dga2dy, 2026-09-21)

Three different claims a test can make about a graph, in increasing order of
strength — KNOW which one a suite proves before calling something verified:

1. **WIRING-TRUTH** — the graph has the shape you intended: right nodes, right
   links, canonical serialization. Goldens and fake-engine e2e prove THIS and
   ONLY this. A synthetic object_info stub (`KSamplerSelect: {input: ...}`
   hand-written in the test) cannot know the real engine's constraints, so it
   blesses anything shape-correct.
2. **EXECUTION-TRUTH** — the engine actually ran the graph and rendered. Only
   a real submission proves it (the 8189 testbed, GPU, runbook discipline);
   expensive, not CI-able, and the only truth that covers model-side
   behavior (decode quality, VRAM, latency).
3. **CONTRACT-TRUTH** — the graph passes the engine's own acceptance GATE:
   every input the engine would check at `POST /prompt` validation (types,
   enums, mins/maxs, link arity, socket compatibility) plus the engine's
   documented reinterpretation rules. CI-able, no GPU, and it is the ONLY
   layer that catches values the engine refuses or silently reinterprets.

**The rule: capability claims never ride on synthetic evidence.** A new route,
family, or builder is not "verified" against a fake engine serving stub
schemas — synthetic object_info may only ever prove wiring. The T=1 lesson
(named, 2026-09-21): the `h3img.generate.t1` family shipped emitting
`length: 1` into `MiniMaxH3ImageToVideo`; every golden and fake-engine e2e
passed; the engine refuses it at validation (`value_smaller_than_min`, min 5
— `execution.py`'s schema-min enforcement) and the tier menu's 9/13 values
silently snap to 22 frames (`temporal_shape` → `align_frame_count`, the 17k+5
grid). Graph-shape verification could not see any of it.

**The engine-contract layer** (`tests/engine-contract.test.js` +
`scripts/fixtures/engine-object-info.json` + `src/lib/engineContract.ts` +
`src/lib/engineSemantics.ts`):

- **The fixture is a REAL capture** — `GET /object_info` from the canonical
  shared install (revision `a87667f`, v0.34.0), schema-only `--cpu` boot, no
  prompts, teardown verified per the runbook. Provenance + normalization
  rules are recorded INSIDE the fixture; regenerate via the header of
  `scripts/capture-engine-schemas.cjs` (a reviewed contract change like any
  golden diff). File-listing combos are emptied (environment-enumerated —
  membership is skipped); every real enum keeps its captured options. The
  first-party form adapter's entry is source-derived from our own pack.
- **The validator mirrors the engine's gate** (`execution.py` validate_inputs
  at the pinned revision): the engine's own error vocabulary, including the
  deliberate non-mirrors (custom VALIDATE_INPUTS bodies, dynamic v3 combos)
  documented in the module header.
- **The semantic-rules ledger** (`src/lib/engineSemantics.ts`) records the
  reinterpretation rules we've verified (the 17k+5 grid, `video_latent_t`
  slice counts, the max(5,·) promotion, audio-context widening) and the
  KNOWN-DIVERGENCES registry — our emissions the engine refuses or
  reinterprets, dated and owned, exact-match enforced: a NEW divergence fails
  CI, a fix must retire its entry visibly. The first pass found five beyond
  T=1: packet tiers 9/13 (snap to 22), the form adapter's missing required
  `low_vram`, the klein `CFGGuider` input names + `resolution_steps` schema
  drift, acestep's `timesignature`/`keyscale` enum formats, music3's dead
  `bitrate` key. None had ever executed against a real engine.
- **The fake engine graduated** (`e2e/fakeEngineInfo.ts`): stock classes are
  served with the REAL captured schemas (extras still win; pack classes stay
  extras-driven), so e2e inherits contract truth — a schema-refusing graph
  fails CI, not the maintainer's evening.
- Adding a builder: run its graphs through
  `validateGraphAgainstSchemas(graph, REAL_INFO)` in the contract suite, and
  ledger-or-fix whatever falls out. Adding an emitted node class: add it to
  the capture script's class list (and preflight's STOCK list if stock), re-capture,
  re-run — the fixture-integrity walk fails loudly until you do.

## Vision-in-the-loop QA (three phases; no test code calls any model)

1. **Capture** — `pnpm test:vision` (build first, or ride the gate) drives
   `scripts/vision-e2e/scenarios.ts` at 1920×1080 and writes a bundle to
   `test-results/vision/<run-id>/`: run-id-prefixed PNGs (fresh filenames
   because image-upload caches dedupe by filename — the cache trap) +
   `manifest.json` mapping images to rubrics. Capture never judges.
2. **Judge** — a Sonnet-tier SUBAGENT (Agent tool, model "sonnet" — API-side,
   NOT the local /api/lan/llm/vision endpoint) executes
   `scripts/vision-e2e/JUDGE.md` against the bundle: reads every screenshot,
   applies rubric + bug taxonomy, two-pass rule on fails (one re-look, then
   final), writes `verdicts.json`. This step does not run in CI.
3. **Report** — `pnpm vision:report [bundle-dir]` (defaults to newest)
   validates verdicts against the manifest, prints PASS/FAIL per checkpoint,
   exits non-zero on any final fail; an unjudged bundle is a LOUD error.

Adding a scenario: append to `scenarios.ts` (driver + rubric as data),
re-capture, judge, report. Bless intended design choices in the rubric so
the judge doesn't flag the design language. Known scenario quirks: Settings
LLM needs `scrollIntoViewIfNeeded` (the page scrolls internally);
Library-empty determinism needs `DELETE FROM jobs`.

## Playwright = system Chromium, never a download

The config resolves the machine's own Chromium/Chrome: `MINIMAX_TEST_BROWSER`
(explicit path) → common Linux/Windows install paths → `$PATH` scan; throws
a one-line reason if none found. Gotchas proven on CI: `executablePath`
must sit under `use.launchOptions` (a bare `use` key is silently ignored →
registry fallback → passes locally, fails on CI); probe order prefers
google-chrome over chromium because Debian/Ubuntu chromium lacks H.264
(filmstrip playback e2e carries a canPlayType skip guard as the honest
fallback).

## CI (the path-scoped ubuntu leg + the scheduled Windows sweep — eg6l3v5 / A-CI)

**Local = depth, CI = breadth + speed** (the maintainer's ruling): `pnpm gate`
stays the full-depth chain; CI runs the FULL suite only on merge-to-main.

- **The manifest is the contract**: `scripts/ci-map.cjs` maps path globs →
  affected vitest suites (+ build tier, python/ffmpeg needs, e2e
  escalation). It is reviewed DATA — grep a path there to see what CI runs
  when it changes. Seam files honestly fan wide (`server/core.ts` → every
  booting suite; `src/lib/workflow.ts` → every client suite;
  `src/canvas/store.ts` → canvas + forced e2e — no unit suite executes the
  kernel). Unmapped `src/lib`/unknown paths fall back to the FULL run,
  loudly. `tests/ci-map.test.js` walks the manifest on every PR: suite
  catalog ↔ `tests/*.test.js` lockstep, seam fan-outs as declared, and a
  completeness walk — a new unmapped `src/lib` or `server` module FAILS it.
  Adding a suite = add the file + catalog it in `SUITES` (+ rules), or CI
  reds.
- **PRs (fast leg)**: changed files → manifest → full `typecheck` (the
  structural safety net that licenses suite-scoping) + lint scoped to the
  changed files + license:audit only when its inputs changed + the tiered
  build (stale-dist rule holds wherever dist-booting suites run) + ONLY the
  mapped suites (`vitest run <suites>`). e2e runs on PRs only when forced
  (browser suites, playwright config, the canvas kernel). Docs-only diffs
  run nothing but the cheap floor. The PR's "select" job prints the plan
  into the run summary — the "what did CI run for this diff" evidence.
- **Merge to main / dispatch (full leg)**: the complete chain, unchanged
  (typecheck → lint → license:audit → build → `pnpm test` → smoke → e2e →
  vision), plus a parallel **contracts** job, MAIN merges only: golden-
  fixture regeneration drift (`MINIMAX_UPDATE_GOLDEN=1` + `UPDATE=1`
  re-snapshot, then `git diff --exit-code` — the fixture IS the contract)
  and registry-append verification (`scripts/check-registry-append.cjs` —
  golden registry entry sets are append-only across a merge).
- **Windows Engine** (`.github/workflows/engine-windows.yml`) — **demoted
  to scheduled-only** (maintainer ruling, 2026-09-21: "Windows tests take
  the back seat too, I am in a linux environment, I think windows testing
  can get pushed to very low priority"): weekly cron + workflow_dispatch,
  NOT on PRs or merge-to-main. It runs the leg's full OS-sensitive set
  (`engine-process`, `runtime`, `fetcher`, `instance`,
  `benchmarks` with BENCH_PYTHON=python — link placement and tar
  extraction; transport mocked) so OS-difference coverage survives at
  near-zero standing cost. The manifest's windows flags stay as data for
  the scheduled leg and any future re-wiring into the PR path; nothing was
  deleted. Consequence: PRs and main merges are all-Linux — a Windows-only
  breakage surfaces at the weekly sweep (or a manual dispatch), not on the
  PR that caused it.
- Verify BOTH legs before calling landed work done (run links go into the
  Flux closure comment). The e2e error guard filters engine-connectivity
  noise (`environmental` in e2e/app.spec.ts) — CI has no engine. To simulate
  CI locally: point test-home settings' comfyUrl at a dead port, restore
  after.
- **Benchmark harness (LANDED — cp96zdm/cq67hpj)**: the committed-suite +
  candidate-CLI harness ("the snake-oil detector") lives at `benchmarks/` +
  `tests/benchmarks.test.js` and runs in the gate chain. It enforces the
  eol-pin invariant on byte-compared artifacts (no i/crlf in the index;
  LEADERBOARD.md pinned `eol=lf`).

## Scratch ports

Something on this box squats on port 4321 AND (2026-09-20, z7ogmig) on 5173 —
always draw suite ports through `tests/lib/ports.cjs` (probe-verified,
per-suite disjoint ranges) and never assume 4178/5173/4199 are free: other
agents and the maintainer's own studio live on this box.

## Windows-leg failure classes (learned 2026-09-16 — read before writing file-generating or file-importing code)

The Windows CI leg catches what a Linux checkout structurally cannot. Two classes so far; both have standing fixes — use them proactively:

1. **ESM `import()` of absolute paths** — Windows rejects `import('D:\...\x.mjs')` style absolute specifiers. Fix: `pathToFileURL(p).href` (committed pattern in benchmarks/run.mjs and tests/benchmarks.test.js). Applies to ANY dynamic import built from `path.join`/`__dirname`.
2. **CRLF vs byte-identity** — git autocrlf converts text files on Windows checkout; any test asserting byte-identity of a *committed generated artifact* (leaderboards, goldens, fixtures) will pass on Linux and fail on Windows. Fix: pin the file in `.gitattributes` (`eol=lf`) when you commit generated artifacts; the repo currently has zero CRLF-exposed files — keep it that way. the invariant is the eol PIN on byte-compared artifacts plus a clean index — asserted in the benchmarks suite as: no i/crlf in the index, and LEADERBOARD.md explicitly pinned eol=lf. (Working-tree w/crlf on ordinary text=auto files is the NORMAL benign Windows autocrlf condition — git normalizes back on commit — and is deliberately not checked.)

Rule of thumb: if your code builds a filesystem path dynamically and either imports it or byte-compares it, assume the Windows leg will treat it differently — fix preemptively, don't wait for the red.
