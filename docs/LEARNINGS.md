# Learnings — operational and engineering lessons

> Consolidated 2026-09-16 (hygiene pass 2, zbn31xs) from Flux task comments
> and session records — lessons that were living in chat logs now live here.
> Each is proven by a real incident or measurement on this project. Add new
> lessons at the bottom of their section, dated, with the task/commit that
> proved them.

## GPU / testbed operations (8189 testbed; 8188 is ALWAYS off-limits to agents)

- **`/tmp` tmpfs exhaustion is this box's recurring failure mode.** Long-lived
  agent sessions fill it; symptom class is weird (test flakes with `EDQUOT` on
  scratch writes, e.g. `test:llm`/`test:lora-form` writing ~1 GB safetensors).
  **Discipline: `TMPDIR=/home/agent/tmp-gpu` (or any /home path) on any
  command that writes scratch.** Proven: camera-port gate flake (ving89w),
  repeated since. Do not "clean up" /tmp beyond your own footprint — ask.
- **After an engine OOM, restart the testbed before the next measurement.**
  A post-OOM ComfyUI serves from a degraded state; numbers taken before the
  restart are garbage. (Tranche ops, 2026-09-15.)
- **If ComfyUI's VRAM estimator got it wrong once, restart the testbed before
  sampling** — a wedged estimator under-allocates the next run into another
  OOM. (Experiment ladder ops.)
- **Never launch the testbed with `--disable-dynamic-vram`** — H3 needs
  dynamic VRAM on the 24 GB stack; static residency destabilized it while
  dynamic ran 9/9 gens clean at ~2.4× per-step speed (tranche 1). The flag was
  Kreatine-era advice, correct for that model only. Confirmed removed
  (maintainer, 2026-09-15).
- **VDN adapter layout quirk:** ComfyUI-VDN-H3-24GB expects
  `adapters/*/adapter_config.json`; the OpenVDN pin ships `adapter_spec.json`
  (same content). One symlink per adapter dir unblocks ApplyVDNH3_24GB.
  (Tranche 3a, one wasted 15 s attempt before the fix.)
- **Turbo LoRAs run in MERGE mode on the quantized base** (the tranche rule
  for 24 GB): merge is measurably softer on quantized bases — part of the
  delta is rounded away. Judge turbo candidates on the path we actually ship;
  a bypass-mode retest is a different experiment (official ref2v 4-step caveat,
  tranche 3a).
- **`pkill -f "main.py --port 8189"` matches the invoking shell's own
  command line** — you kill your own launcher. Match on the recorded PID
  instead. (Self-inflicted, tranche 3a.)

## Measurement honesty (the experiment-ladder doctrine)

- **Pixel metrics for positions, vision for semantics.** Contact-sheet vision
  position estimates were ±16% wrong at 288 px tiles; the HSV/pixel tracker
  agreed with direct measurement to 0.1%. Never quote vision-derived positions
  without pixel verification; vision-read positions must be labeled as such.
  (E-MD1 / bake-off, tranche 3a.)
- **Hold the seed when comparing quality tiers** — same seed doubles as the
  same-seed cross-tier divergence measurement, answering "if I find a seed at
  turbo, what do I get at 25 steps?" (Design note, maintainer question
  2026-09-15; measured in tranche 3b: same seed = a SIBLING take, 18–25 dB
  first-frame divergence.)
- **Fresh-release assessment doctrine — every verdict comes from this menu:**
  - **ADOPT** — take it as-is into our stack (with catalog/licensing rows).
  - **ADJUST** — the idea survives, our measurement changed the parameters.
  - **CORRECT** — their claim is wrong; our measurement says what's actually
    true (e.g. held-seed tiers: extra steps buy motion/audio, not still
    detail).
  - **CONFIRM** — their claim held under our first-hand measurement (e.g.
    MATLOWAI's fused-turbo 4-step ref2va; PDD unloadability predicted by the
    compat doc and then hit first-hand).
  Applied to wan2gp-h3-latent-continue, fasth3-live, MATLOWAI, AutoContext,
  etc. Never adopt an author claim without one of these four.
- **Record honestly what was NOT tested** (the bypass-mode retest, 20-vs-50
  step VDN visual quality, W4A8 VAE decode fidelity) — open caveats travel
  with the verdict, or they are lost.

## Harness / toolchain gotchas (proven on this repo)

- **VM test harness transpile target is ES3-ish:** `matchAll` loops and
  iterator spreads (`[...map.entries()]`, `[...new Set()]`) silently no-op;
  use regex `exec` loops and `Array.from`. Cross-realm arrays fail
  `deepEqual` — compare `.join('|')` strings. Relative-import modules need
  the two-file loader pattern. (VM harness; vitest-era suites in
  `tests/*.test.js`.)
- **Vision judgment cache trap:** the Read tool's image→CDN upload dedupes by
  filename — re-reading a regenerated screenshot returns the CACHED first
  upload. Hence run-id-prefixed screenshot filenames (fresh names = fresh
  reads); for local re-inspection use the ZAI MCP local-path image source.
- **Playwright system-Chromium rules:** `executablePath` must sit under
  `use.launchOptions` (a bare `use` key is silently ignored → registry
  fallback → CI-only failure); probe order prefers google-chrome over
  chromium because Debian/Ubuntu chromium ships without H.264 (filmstrip e2e
  has a canPlayType skip guard as the honest fallback).
- **CPython↔JS decimal parity:** JS `toFixed`/`toPrecision` break exact ties
  upward, CPython rounds half-even; reachable through ordinary inputs. The
  camera port solves it with exact BigInt decimals + half-even +
  `%g`-convention formatting (`src/lib/camera/` pyFixed/pyFormatG) — reuse
  those helpers for any future Python-parity output.
- **CI Node vs local Node float drift:** VM-transpiled `**`→`Math.pow` can
  diverge by ulps against CPython libm across engines — write Hermite-basis
  math with explicit `Math.pow` and compare samples at 1e-12 (dc27f8d).
- **Stylelint/postcss:** `!important` is parsed OUT of `Declaration#value` —
  allowlist matchers must exclude it (scripts/stylelint-raw-color-allowlist).
- **pnpm 11:** overrides live in `pnpm-workspace.yaml`; `allowBuilds` map
  required for postinstall-building deps.
- **Scratch ports:** something on this box squats 4321 — always probe-and-
  verify a free port (freePort pattern in test-storage/test-realtime).
- **zsh + the repo path contains a space** — always quote
  `"/home/agent/work/VS Proj/MINIMAX-DESKTOP"`.

## Vendor / licensing doctrine (short form; full policy in LICENSES.md)

- Only permissive (Apache-2.0/MIT/ISC-class) code is vendored, pinned, with
  its LICENSE shipped; NO-LICENSE and GPL are user-fetch only, never
  vendored; `pnpm license:audit` enforces it in the gate.
- Ports carry per-file provenance headers (repo + upstream commit) and get
  PROVENANCE.md + LICENSES.md rows — no upstream bytes ship (camera-port
  precedent).
- Every fetchable thing is catalog DATA with sha/size pins; consent records
  match the CURRENT license and stale consent invalidates.
