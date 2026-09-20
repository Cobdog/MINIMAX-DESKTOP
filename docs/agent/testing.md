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

Any suite that writes real scratch (notably `test:llm`, `test:lora-form`
with its ~1 GB safetensors) can flake with `EDQUOT` when the box's /tmp
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
lora-form, poserig, camera, canvas, benchmarks, launcher, datasets) →
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
- `test:lora-form` needs `python3` + `numpy` (skips loudly without python,
  fails loudly with python but no numpy).
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

## CI (two legs)

- **Ubuntu** (`.github/workflows/ci.yml`): python+numpy + ffmpeg installs →
  typecheck, lint, license:audit, build, `pnpm test` (the ONE vitest unit
  run — every suite, including the ones the pre-migration ci.yml omitted),
  smoke, e2e, vision-capture on every push/PR.
- **Windows Engine** (`.github/workflows/engine-windows.yml`): server build
  + the OS-sensitive suites as vitest filters (`pnpm test:engine`,
  `test:runtime`, `test:fetcher`, `test:instance`, `test:lora-form`,
  `test:benchmarks` with BENCH_PYTHON=python — link placement and tar
  extraction; transport mocked).
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
