# Benchmarks — the snake-oil detector

> Maintainer directive (2026-09-16): *"use this testing apparatus and ensure as
> new methods and models come out that we can measure those the same way — so
> we can tell if new tech is actually better or snake oil."*
> The experiment tranches (1, 2, 3a, E-FC1, 3b) proved the methods; this
> directory turns them into a PERMANENT capability: committed suites, a
> candidate-driven CLI, an append-only results registry, and a blind-judge arm.

**Why a top-level `benchmarks/` dir** (not under `scripts/`): the suites are
first-class repo assets with committed fixture data (`suites/*/SUITE.json`),
and the registry + leaderboard are user-facing artifacts — same tier as
`docs/` and `e2e/`. Raw run artifacts stay gitignored under
`test-results/benchmarks/`.

## Layout

```
benchmarks/
  run.mjs                  the CLI (below)
  lib/                     registry, leaderboard, environment policy, blind-judge,
                           fetch-catalog bridge, exec (TMPDIR discipline)
  shared/                  python harness pieces: driver.py (testbed bring-up/
                           teardown, contention guard, estimator-restart rule,
                           free-verified + restart-on-poison), metrics.py (seam
                           column / anchor dB / PSNR grids / ArcFace / centroid /
                           contact sheets), suiteconfig.py, vram_sampler.sh
  suites/<name>/           one dir per experiment family:
                           SUITE.json (pinned fixtures + incumbents + rubric +
                           limits) + build*.py + run*.py + analyze*.py
  results/registry.json    APPEND-ONLY results registry (committed)
  LEADERBOARD.md           human view — REGENERATED from the registry, never
                           hand-edited (node benchmarks/run.mjs --regen-leaderboard)
  data/                    backfill dataset + fetch-catalog snapshot
  tools/                   backfill.mjs, sync-catalog.mjs
```

## The suites (and what each actually measures)

| suite | family | measures | known limits |
|---|---|---|---|
| `ref2va-bakeoff` | Ref2VA-class speed/identity bake-off | ArcFace vs ref at f0/f62/f123, wall, blind pair | reference-mode identity ceiling (0.12-0.37 band swamps option gaps); MERGE path; fused files fold style opinions |
| `tier-ladder` | speed/quality tiers at a held seed | same-seed pairwise PSNR, motion-timing delta, blind tier rank | **stills sharpness only** — turbo's costs live on motion/audio/pinned-row axes this suite cannot see (2026-09-16 finding); single scene+seed |
| `hybrid-ab` | adaln-hybrid vs stock on instruction edits | whole+thirds PSNR vs source, identity-through-edit, blind edit read | re-synthesis class (10-13 dB) — PSNR measures change localization, not quality; 1 seed 1 pair = directional |
| `movement-md1` | positional-guide movement director vs control methods | centroid error vs plan, backtrack/teleport events, bg PSNR | HSV tracker can't follow off-color balls (vision-read, labeled); linear-plan bias |
| `nonhuman-fc1` | Fun Control pose topology generalization | estimator round-trip keypoint error (3 normalizations), vision tags | round-trip conflates adherence + estimator noise (arm A calibrates); estimator-restart rule applies |
| `preservation-k1` | Krea 2 image-edit preservation ladder | outside-region PSNR/dE76 (+32px ring excl/incl), VAE floor, ArcFace | stills only; single LoRA version; dE76 via manual Lab |
| `transitions-e1e4` | transition battery (E1-E4 + E5/E6 chaining) | seam dB + seam ratio, anchor fidelity, audio join corr/step, drift/hop, cut adherence | turbo OFF for pinned arms (mispredicts pinned rows); seam ratio is scene-relative |

Pinned incumbents (golden baselines — verdicts are deltas vs these, per suite
`SUITE.json`): `main8` (larryvrh v4, neutral fast-tier) and `fused4`
(MATLOWAI, styled entry) for ref2va-bakeoff; the t8/t20/t25/vdn20 grid for
tier-ladder; stock+hybrid for hybrid-ab; arm B (AddGuide director) for
movement-md1; arms A+D for nonhuman-fc1; AnyPaint ceiling + VAE floor for
preservation-k1; FLF champion + single-pass multi-shot for transitions.

## Benchmarking a new candidate end-to-end

A candidate is a new checkpoint / LoRA / method that claims to be better at
something a suite measures. Same pinned scenes + seeds, same metrics, verdict
as a delta vs the incumbents.

1. **Describe the candidate.** Write a small JSON (fields per the suite's
   `SUITE.json` `candidateSlot`), e.g. for ref2va-bakeoff:

   ```json
   { "id": "acme-turbo-6", "label": "ACME 6-step turbo",
     "slot": { "kind": "turbo-lora", "file": "acme_turbo_6.safetensors", "steps": 6 } }
   ```

   Stage the model file into the testbed models tree (or use a catalog id —
   step 1b).

2. **(Optional) fetch-catalog candidates.** `--candidate <catalogId>` resolves
   through the REAL fetch catalog (`dist-server` build or the committed
   `data/catalog-snapshot.json`), prints the license banner at run start, and
   with `--fetch` downloads through the real `FetchManager` — consent is
   pre-recorded for `experimentPrerequisite` entries (the MATLOWAI/E-FC1
   pattern, now encoded). Non-prerequisite entries are refused: acknowledge
   the license in the app first.

3. **Plan (offline, no GPU).**

   ```bash
   node benchmarks/run.mjs --suite ref2va-bakeoff --candidate cand.json --dry-run
   ```

   Validates the slot, lists incumbent arms, pins, metrics, and the
   environment gate. `--list` shows every suite + slot.

4. **Run (GPU — the 8189 testbed runbook binds).**

   ```bash
   node benchmarks/run.mjs --suite ref2va-bakeoff --candidate cand.json --execute
   ```

   The runner drives the suite's `run*.py` through `shared/driver.py`:
   contention guard (the maintainer's 8188 workload takes priority — it PAUSES
   if the GPU is theirs), `/free` before/after with ambient-baseline
   verification, patient SIGINT teardown + nvidia-smi check, restart-on-OOM
   (a poisoned memory state only recovers via process restart). Every spawned
   process inherits `TMPDIR=/home/agent/tmp-gpu` (/tmp is an
   exhaustion-prone tmpfs — the runbook rule).

5. **Analyze** (suite `analyze*.py`, testbed venv): metrics.json + per-arm
   contacts + blind artifacts into the run dir.

6. **Blind-judge arm** (optional but the standard for quality claims):

   ```bash
   node benchmarks/run.mjs --suite ref2va-bakeoff --emit-blind <runId>
   ```

   Emits a vision bundle (`test-results/benchmarks/vision-bundles/<id>/`) with
   LETTERED candidates, the suite rubric, and a SEALED mapping. Dispatch a
   judge per the bundle's `JUDGE-INSTRUCTIONS.md` (the repo
   `scripts/vision-e2e/JUDGE.md` protocol + benchmark honesty rules); gate
   with `pnpm vision:report <bundle>`; then
   `node benchmarks/run.mjs --unblind <bundle>` prints the perceptual row for
   the registry. Blindness discipline: the mapping is opened only AFTER
   verdicts are recorded (measured: judges' confident inferences about
   methods/steps have been wrong while blind reads held).

7. **Record + decide.** Append the row (the CLI prints the pending row;
   verdict = delta vs incumbents) and regenerate the leaderboard:

   ```bash
   node benchmarks/run.mjs --regen-leaderboard
   ```

   Product decision: the leaderboard row + verdict text is the artifact; the
   registry row cites its Flux task/provenance.

## The intake workflow (fetch-catalog → benchmark → registry → product)

1. A new method/model appears → add/verify a sha-pinned fetch-catalog entry
   (`server/fetchCatalog.ts`; mark it `experimentPrerequisite: true` with the
   license note — that is the pre-recorded consent for benchmark fetches).
2. Rebuild the server + refresh the snapshot:
   `pnpm build:server && node benchmarks/tools/sync-catalog.mjs`.
3. Benchmark it (above). GPU work goes through the Flux GPU-window pattern
   (one runner, runbook rules, contention guard).
4. The registry row + leaderboard verdict drive the product decision (adopt /
   non-default with a measured label / reject) — every shipped measured label
   in the app (e.g. the AP-10K rig template's) traces to a registry row.
5. The winning candidate becomes the suite's next pinned incumbent (edit
   `SUITE.json` arms: move `incumbent: true`; the registry is append-only so
   history keeps the dethroned baseline).

## Environment-change policy (recorded, not guessed)

Every row carries an `environmentId` into `registry.environments` (GPU,
driver, ComfyUI version, quant forms, adapter versions). `run.mjs --execute`
captures the live environment (nvidia-smi + the testbed `/system_stats`) and
gates on the KEY AXES (gpu / driver / comfyui / quant): if any moved vs
`baselineEnvironmentId`, the run REFUSES and says what to do —

```bash
# 1. re-run each suite's incumbents under the new environment (plain GPU runs)
# 2. appoint the new baseline:
node benchmarks/run.mjs --rebaseline [env-id]
```

Unknown axes never trigger the gate (a capture that could not see the driver
cannot rebaseline on it). Environments are immutable like rows: a changed GPU
is a new environment id, not an edit.

## Runbook + contention rules (binding for every run this harness enables)

From the repo `CLAUDE.md` (source of truth — summarized here, not replaced):

- Engine: the **Kreatine testbed at 127.0.0.1:8189**
  (`"/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI"`). The maintainer's
  instance at **8188 is OFF LIMITS** to all agents.
- Bring-up: `./.venv/bin/python main.py --port 8189 --listen 127.0.0.1` in the
  background with a log + recorded PID. **Never `--disable-dynamic-vram`**
  (H3 requires dynamic VRAM on 24 GB; measured 9/9 gens clean at ~2.4x faster
  per step).
- Before submitting: health-check `/system_stats` + `nvidia-smi`; if the
  maintainer's own workload is mid-job, WAIT — their runs take priority (the
  contention guard enforces this).
- Between phases: `POST /free` `{"unload_models": true, "free_memory": true}`.
- **Estimator-restart rule**: controlnet_aux annotators (DWPose/AP-10K) load
  to CUDA outside ComfyUI's management — `/free` cannot unload them; after an
  estimator phase, restart the server (or pass a wide VRAM slack) before
  sampling.
- Teardown ALWAYS: `/free` → SIGINT the recorded PID (patient: up to 90 s) →
  verify with `nvidia-smi` that VRAM returned to the ambient baseline. Never
  leave the stack running; if the maintainer needs the GPU mid-run, bring the
  testbed down immediately.
- `TMPDIR=/home/agent/tmp-gpu` on every spawned process (the harness encodes
  this in `lib/exec.mjs` and `shared/driver.py`).

## Offline tests

`pnpm test:benchmarks` (scripts/test-benchmarks.cjs): registry
append/immutability, leaderboard regeneration determinism, CLI argument
handling + dry-run plans, the fetch-catalog bridge against a fixture
transport (zero network), candidate parameterization (a mock candidate
exercises EVERY suite's build path — no GPU), and the pure metric math
(PSNR / seam ratio / motion pair / thirds) against fixed arrays. GPU
validation of the suites themselves is the staged follow-up (below).

## Staged GPU validation (deferred, post-DiffSynX window)

When the next GPU window opens: run each suite's runner ONCE on the testbed
against already-present incumbents (no new methods) — one generation per
suite's cheapest arm where feasible — verifying: the shared driver's
bring-up/teardown, the run-dir plumbing (results.json paths, output prefixes),
each analyzer's metric emission, and the blind-bundle emission + unblind round
trip. The tranche originals these suites were ported from all executed
measured-clean on this exact stack, so the validation is plumbing-level, not
hypothesis-level. Budget: well under one GPU window.
