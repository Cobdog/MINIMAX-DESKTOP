# 8189 testbed runbook + experiment conventions

> Trigger: read this BEFORE any engine-dependent test, measurement, or
> experiment. The safety RULES (8188 off-limits, teardown mandatory) are
> inline in `CLAUDE.md` — they are repeated here only as the checklist tail.

## The testbed

- **The maintainer's personal ComfyUI at `127.0.0.1:8188` is OFF LIMITS to
  all agents** — never submit prompts, experiments, jobs, or tests to it,
  never "just probe" it with a generation. The self-managed runtime's own
  instances allocate from 8191 up and must avoid BOTH ports.
- Engine-dependent work uses the **Kreatine testbed** at `127.0.0.1:8189`
  (testbed lives at `"/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI"` —
  gitignored, own uv venv, weights symlinked, ComfyUI 0.34.x). Probe first:
  it may be down; if down and you need it, ask — never fall back to 8188.
- GPU windows for experiment batches are **maintainer-authorized** ("gpu
  free"); work within the stated budget and say what you used.

## Bring-up

From the testbed dir:

```bash
./.venv/bin/python main.py --port 8189 --listen 127.0.0.1
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
  media) — committed.
- Testbed-only shims (t1/t2/t3a) are gitignored by design; describe them in
  the task comment so they're reproducible.
