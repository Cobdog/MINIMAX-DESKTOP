# 8189 testbed runbook + experiment conventions

> Trigger: read this BEFORE any engine-dependent test, measurement, or
> experiment. The safety RULES (8188 off-limits, teardown mandatory) are
> inline in `CLAUDE.md` — they are repeated here only as the checklist tail.

## The testbed

- **The maintainer's personal ComfyUI at `127.0.0.1:8188` is OFF LIMITS to
  all agents** — never submit prompts, experiments, jobs, or tests to it,
  never "just probe" it with a generation. The self-managed runtime's own
  instances allocate from 8191 up and must avoid BOTH ports.
- Engine-dependent work uses the **canonical shared install** at
  `127.0.0.1:8189` (relocated 2026-09-16 from the Kreatine testbed to
  `/home/agent/comfyui` — one uv venv, unified custom nodes, models
  symlinked from `/home/agent/models/`; its root CLAUDE.md is the
  shared-instance coordination protocol). Probe first:
  it may be down; if down and you need it, ask — never fall back to 8188.
- GPU windows for experiment batches are **maintainer-authorized** ("gpu
  free"); work within the stated budget and say what you used.

## Bring-up

From the canonical install dir:

```bash
cd /home/agent/comfyui && ./.venv/bin/python main.py --port 8189 --listen 127.0.0.1
```

- Launch in the background WITH A LOG FILE and **record the PID**.
- **Never pass `--disable-dynamic-vram`**: H3 requires dynamic VRAM on the
  24 GB stack — static residency destabilized it while dynamic ran 9/9 gens
  clean at ~2.4× per-step speed (tranche 1, measured). The flag was
  Kreatine/Krea-2-era advice, correct for that model only; confirmed removed
  going forward (maintainer, 2026-09-15).
- Before submitting: health-check `curl -s http://127.0.0.1:8189/system_stats`
  and check `nvidia-smi --query-gpu=memory.used --format=csv` — baseline VRAM
  and confirm the maintainer's own workload isn't mid-job. **Their runs take
  priority; if the GPU is busy with their work, wait or ask.**

## During a run

- **Between test phases/arms:** `POST /free` with
  `{"unload_models": true, "free_memory": true}` (the Kreatine A/B
  convention) so models unload before the next arm.
- **Contention guard:** poll the maintainer's instance state between
  generations; if their window opens, pause (the guard fired zero pauses in
  tranche 3a while doing exactly this).
- **After an engine OOM:** restart the testbed before the next measurement —
  post-OOM numbers are garbage. Same for a wedged VRAM estimator: restart
  before sampling.
- Kill by the recorded PID — never `pkill -f "main.py --port 8189"` (it
  matches your own launcher's command line; proven footgun).

## Teardown (ALWAYS — no exceptions)

1. `POST /free` first (release VRAM),
2. SIGINT the recorded PID, wait for exit,
3. **verify with `nvidia-smi` that VRAM returned to baseline.**

Never leave the stack running after tests; never leave orphaned processes.
If the maintainer needs the GPU mid-run, bring the testbed down immediately.

## Experiment conventions (the tranche discipline)

- Fixed, recorded seeds (per-arm + per-seed tables); matched seeds across
  comparison arms; held seed when comparing quality tiers (doubles as the
  divergence measurement).
- Every arm per design; deviations recorded in the task comment ("task text
  wins, recorded").
- No curiosity generations; stay inside the authorized window; report GPU
  minutes used.
- Raw numbers land in Flux task comments; verdicts + addenda land in the
  relevant `docs/research/*.md` with a dated commit.
- Measurement honesty: pixel metrics for positions (vision estimates ±16% at
  288 px tiles), vision-read positions labeled as such, untested caveats
  recorded, fresh-release verdicts from the ADOPT/ADJUST/CORRECT/CONFIRM
  menu — see [../LEARNINGS.md](../LEARNINGS.md).
- Turbo LoRAs run MERGE mode on the quantized base (the 24 GB tranche rule);
  judge candidates on the shipping path.
- Artifacts under `test-results/experiments/<tranche>/` (scripts, JSONs,
  media). NOTE (2026-09-16, envelope): `test-results/` is GITIGNORED (`.gitignore`
  line 11) — artifacts there persist on disk only, not in git. Findings that must
  survive go in the `docs/research/*.md` dated doc (raw tables in the task
  comments); force-adding test-results is a maintainer decision, not an agent
  default.
- Testbed-only shims (t1/t2/t3a) are gitignored by design; describe them in
  the task comment so they're reproducible.

## Training-run conventions (H3 LoRA envelope, task 1n3a4mi, 2026-09-16)

- **Grid trim +2 rule**: every training clip is cut to grid_target+2 frames.
  mp4 containers store duration TRUNCATED (56/24 = 2.333333 s); the loader's
  floor(duration×24) drops a frame and its 17n+5 clamp then walks DOWN to the
  next grid point — a 56 f clip silently trains as 39 f. ffprobe says the file
  is perfect; only the latent geometry exposes it.
- **Stage-1 host-RAM ceiling (DiffSynX)**: the TE+VAE cache pass pins
  ~104–108 GB host RAM during load — it dies by kernel SIGKILL if the box has
  less than ~105 GB available (tmpfs counts: ~10 GB of /tmp artifacts closed
  the window on 2026-09-16). Check `free -g` BEFORE launching stage-1; musubi's
  cache path (VAE-only + streamed TE) is the fallback that fits a busy box.
- **Dynamic-resolution batch economy**: run stage-1 WITHOUT --height/--width so
  one model load caches the whole dataset at each item's own geometry
  (~12 min load amortized; per-item cost identical to fixed-H/W — verified
  byte-identical). Fixed-H/W stage-1 is only for single-geometry datasets.
- **Gradient-checkpointing flags are cache-baked**: in cache mode the stage-2
  CLI `--use_gradient_checkpointing(_offload)` are IGNORED (flags live in the
  cached item from stage-1). Flip them in the cache, not the CLI.
- **`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` always** for training:
  it rescued an entire VRAM tier lost to allocator fragmentation (3.84 GB
  reserved-unallocated at the wall) with no observed downside.
- Kill drivers by process group or explicit PIDs — killing a shell driver
  orphans its accelerate children (proven: two stage-1 loads then overlapped
  and host-OOM'd each other).
