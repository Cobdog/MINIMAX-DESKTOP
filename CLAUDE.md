<!-- FLUX:START -->
## Flux Task Management

This repo is tracked by Flux. Project: **MINIMAX-DESKTOP** (`r2lnrfw`). All work MUST belong to exactly one project_id (`r2lnrfw`); do NOT guess or invent ids. Track all work as tasks; update status as you progress; close tasks immediately when complete — through the done-gate (`complete_task`) with an evidence summary citing commit(s)/CI/artifacts.

- **Agent attribution (required):** in EVERY `mcp__flux__*` call, pass `agent_name="<your agent_id>"` — the SubagentStart identity hook (`~/.claude/hooks/flux-identity.sh`) injects it at launch; copy that exact value. Call `resume(project_id="r2lnrfw", agent_name?)` at the start of every session: active/interrupted sessions, focus task, stale/blocked tasks, **unacknowledged directives**, suggested next work.
- Task mentions are always "Task Name (id)". Board columns/types/tags are config-driven — `get_project_schema(project_id="r2lnrfw")` on a cold start. Full Flux conventions: [docs/agent/conventions.md](docs/agent/conventions.md).
- **If context is lost:** re-read this file; the project_id is `r2lnrfw`. Source-of-truth files: this section (committed) and `.flux/project-id`.

**Engine usage (SAFETY-CRITICAL — complete, inline):** the maintainer's personal ComfyUI instance at `127.0.0.1:8188` is **OFF LIMITS** to all agents — never submit prompts, experiments, jobs, or tests to it. For engine-dependent tests and experiments, use the **Kreatine testbed at 8189** via the runbook below. The self-managed runtime's own instances use the 8191+ scan range and must continue to avoid BOTH ports.

**8189 testbed runbook** (testbed lives at `"/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI"` — gitignored, own uv venv, weights symlinked, ComfyUI 0.34.x):
- **Bring up:** from the testbed dir, `./.venv/bin/python main.py --port 8189 --listen 127.0.0.1` — launch in the background with a log file and RECORD THE PID. **Do NOT pass `--disable-dynamic-vram`: H3 requires dynamic VRAM (static residency destabilizes the 24GB stack; measured tranche 1 — dynamic ran 9/9 gens clean at ~2.4× faster per-step). The flag is confirmed removed going forward (maintainer, 2026-09-15).**
- **Before submitting:** health-check `curl -s http://127.0.0.1:8189/system_stats`, and check `nvidia-smi --query-gpu=memory.used --format=csv` — baseline VRAM and confirm the maintainer's own workload isn't mid-job on the GPU. **Their runs take priority; if the GPU is busy with their work, wait or ask.**
- **Between test phases:** `POST /free` with `{"unload_models": true, "free_memory": true}` (the Kreatine A/B convention) so models unload before the next arm.
- **ALWAYS tear down when tests complete:** `POST /free` first (release VRAM), then SIGINT the recorded PID, wait for exit, and **verify with `nvidia-smi` that VRAM returned to baseline**. Never leave the stack running after tests; never leave orphaned processes. If the maintainer needs the GPU mid-run, bring the testbed down immediately on request.
- Deeper discipline (OOM-then-restart, estimator restart, contention guard, tranche/experiment conventions): [docs/agent/runbook.md](docs/agent/runbook.md).
<!-- FLUX:END -->

## Deletion policy (absolute)

Destructive shell commands are blocked by the maintainer's global hook. A block is standing policy, NEVER an obstacle to route around — do not retry with a different tool, flag, or path (substituting one deletion method for another is exactly what the ban stops). If a deletion is genuinely necessary, stop and ask.

## THE FRESHNESS DOCTRINE

Before doing anything non-trivial (building, benchmarking, graph-writing), ask: **"Is this the right way to do this TODAY?"** This space changes daily; king today may be dead tomorrow. Default practice: research local docs AND the web; challenge assumptions whenever there is even slight reason — ambiguity, or a question that makes you doubt X. BALANCED: not everything through this lens — the trigger is ambiguity or doubt, not paranoia. Every important finding gets documented (`docs/research/` + `docs/library/` per protocol). Accuracy and truth over convenience.

Documenting important findings is an agent obligation, not an option.

## Lazy-load contract — read on intent, not at boot

When about to do X, read the matching file FIRST:

- **Touch the GPU / 8189 testbed / any engine-dependent test** → [docs/agent/runbook.md](docs/agent/runbook.md)
- **Run, extend, or debug the test suites / CI** → [docs/agent/testing.md](docs/agent/testing.md)
- **Commit, vendor/port third-party code, or write a research doc** → [docs/agent/conventions.md](docs/agent/conventions.md)
- **Rely on an external-doc fact (H3 prompting, ComfyUI node behavior, chaining) for non-trivial work** → the research library [docs/library/README.md](docs/library/README.md) — run its SOURCE-OF-TRUTH CHECK (three questions) before treating a captured fact as current

Orientation: repo map in [docs/agent/README.md](docs/agent/README.md); state of play in [docs/ROADMAP.md](docs/ROADMAP.md); operational lessons in [docs/LEARNINGS.md](docs/LEARNINGS.md); the full documentation table in the README.
