# Testing — the gate, the vision loop, CI

> Trigger: read this BEFORE running, extending, or debugging the test suites
> or CI. The user-facing summary lives in the README's Testing section; this
> is the operator's view with the gotchas.

## TMPDIR first

Any suite that writes real scratch (notably `test:llm`, `test:lora-form`
with its ~1 GB safetensors) can flake with `EDQUOT` when the box's /tmp
tmpfs is full — this is the machine's recurring failure mode. Run with
`TMPDIR=/home/agent/tmp-gpu` (any /home path) unless you have a reason not
to. CI runners have fresh /tmp; the flake is local-only and never caused by
your change (verify by looking at what the failing write was).

## Local-only e2e flakes from shared-home accumulation (learned 2026-09-18, fh94g76)

The e2e datasets tests are NOT idempotent against their own accumulation in
the shared `test-home`: every run of the caption-editor test seeds another
`e2e-clip` layer set on the same master, and once an OLD 4:3-aspect layer
becomes the list's `.first()`, the 4:3 chip is already-active (disabled) and
the click times out. Reproduces on `main`; passes on CI (fresh homes). If
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
`lint` → `license:audit` → unit suites (`test`, `test:registry`,
`test:h3img`, `test:storage`, `test:documents`, `test:realtime`,
`test:filmstrip`, `test:llm`, `test:engine`, `test:runtime`, `test:fetcher`,
`test:instance`, `test:lora-form`, `test:poserig`, `test:camera`,
`test:canvas`, `test:benchmarks`, `test:datasets`) → `build` → `smoke:server`
→ e2e → vision-capture — each in its own process, wall-clock timed,
known-benign output filtered (the filter tally prints so nothing disappears
silently), one summary table, non-zero exit on any failure. A failed
`build` skips only its dependents (smoke/e2e/vision). `pnpm test:all` is the
same chain without the harness niceties. Individual suites run directly
(`pnpm test:registry`, …) while iterating.

- `test:registry` proves the optimization-registry inertness contract
  against golden fixtures — regenerate deliberately
  (`node scripts/test-registry.cjs --update-golden`) and review the diff;
  the fixture IS the contract.
- `test:h3img` (k9vu6t0) proves the H3 image workbench families: golden
  snapshots (`node scripts/test-h3img.cjs --update-golden`), the
  research-pinned recipe table, the Mamad8 never-in-video-graphs factory
  guard (with the failing-without-it proof), the first-party scorer on
  crafted frames, the burst-fuse never-worse fallback + tone-lock DSP, VRAM
  staging plans, and the session model's packet-take projections.
- `test:lora-form` needs `python3` + `numpy` (skips loudly without python,
  fails loudly with python but no numpy).
- `test:datasets` (sv14rt0) boots the built server on a scratch home and
  drives the dataset manager with SYNTHETIC ffmpeg testsrc clips (never
  committed media); it needs ffmpeg on PATH and exercises ingest/health/
  layers/captions/bake/gates/exports/curation/FTS/scale end to end, plus
  pure-model units (grid math, floors, budget goldens vs the envelope
  table, trigger validation, aspect mirror/hard-stops) loaded straight from
  dist-server.
- `test:camera` needs no Python (goldens are committed).
- `test:instance` (9om4bi9) covers the external-instance integration:
  instance inventory parsing against crafted object_info + /models payloads,
  the external custom-nodes install target (path construction + foreign
  refusal), live pack detection, the app-relative io defaults through the
  real settings pipeline, and the routes against a local fake engine. The
  route sections self-skip without the web build (the Windows-leg NOTE
  pattern).

## VM-harness pitfalls (scripts/test-*.cjs)

The harness transpiles TS to an ES3-ish target: `matchAll` loops and
iterator spreads (`[...map.entries()]`, `[...new Set()]`) silently no-op —
use regex `exec` loops and `Array.from`. Cross-realm arrays fail
`deepEqual`; compare `.join('|')` strings. Relative-import modules need the
two-file loader pattern (see the promptLibraryStorage test block).

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

- **Ubuntu** (`.github/workflows/ci.yml`): typecheck, lint, license:audit,
  unit suites, build, smoke, e2e, vision-capture on every push/PR.
- **Windows Engine** (`.github/workflows/engine-windows.yml`): server build
  + the OS-sensitive suites (engine/runtime/fetcher — link placement and tar
  extraction; transport mocked).
- Verify BOTH legs before calling landed work done (run links go into the
  Flux closure comment). The e2e error guard filters engine-connectivity
  noise (`environmental` in e2e/app.spec.ts) — CI has no engine. To simulate
  CI locally: point test-home settings' comfyUrl at a dead port, restore
  after.
- **Benchmark harness (LANDED — cp96zdm/cq67hpj; note updated 2026-09-19,
  conformance audit u7rxi2e, per this paragraph's own instruction)**: the
  committed-suite + candidate-CLI harness ("the snake-oil detector") lives at
  `benchmarks/` + `scripts/test-benchmarks.cjs` and runs in the gate chain
  (`test:benchmarks`). It enforces the eol-pin invariant on byte-compared
  artifacts (no i/crlf in the index; LEADERBOARD.md pinned `eol=lf`).

## Scratch ports

Something on this box squats on port 4321 — always probe-and-verify free
ports (freePort pattern in test-storage/test-realtime).

## Windows-leg failure classes (learned 2026-09-16 — read before writing file-generating or file-importing code)

The Windows CI leg catches what a Linux checkout structurally cannot. Two classes so far; both have standing fixes — use them proactively:

1. **ESM `import()` of absolute paths** — Windows rejects `import('D:\...\x.mjs')` style absolute specifiers. Fix: `pathToFileURL(p).href` (committed pattern in benchmarks/run.mjs). Applies to ANY dynamic import built from `path.join`/`__dirname`.
2. **CRLF vs byte-identity** — git autocrlf converts text files on Windows checkout; any test asserting byte-identity of a *committed generated artifact* (leaderboards, goldens, fixtures) will pass on Linux and fail on Windows. Fix: pin the file in `.gitattributes` (`eol=lf`) when you commit generated artifacts; the repo currently has zero CRLF-exposed files — keep it that way. the invariant is the eol PIN on byte-compared artifacts plus a clean index — asserted in test:benchmarks as: no i/crlf in the index, and LEADERBOARD.md explicitly pinned eol=lf. (Working-tree w/crlf on ordinary text=auto files is the NORMAL benign Windows autocrlf condition — git normalizes back on commit — and is deliberately not checked.)

Rule of thumb: if your code builds a filesystem path dynamically and either imports it or byte-compares it, assume the Windows leg will treat it differently — fix preemptively, don't wait for the red.
