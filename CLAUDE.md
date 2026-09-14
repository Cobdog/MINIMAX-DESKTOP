<!-- FLUX:START -->
## Flux Task Management

This repo is tracked by Flux. Project: **MINIMAX-DESKTOP** (`r2lnrfw`).

**Rules:**
- All work MUST belong to exactly one project_id (`r2lnrfw` for this repo).
- Do NOT guess or invent a project_id.
- Track all work as tasks; update status as you progress.
- Close tasks immediately when complete.
- **Engine usage (maintainer directive, 2026-09-14):** the maintainer's personal ComfyUI instance at `127.0.0.1:8188` is **OFF LIMITS** to all agents — never submit prompts, experiments, jobs, or tests to it. For engine-dependent tests and experiments, use the **Kreatine testbed at 8189** via the runbook below. The self-managed runtime's own instances use the 8191+ scan range and must continue to avoid BOTH ports.

  **8189 testbed runbook** (source: the Kreatine repo's CLAUDE.md; testbed lives at `"/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI"` — gitignored, own uv venv, weights symlinked, ComfyUI 0.34.x):
  - **Bring up:** from the testbed dir, `./.venv/bin/python main.py --port 8189 --listen 127.0.0.1 --disable-dynamic-vram` — launch in the background with a log file and RECORD THE PID.
  - **Before submitting:** health-check `curl -s http://127.0.0.1:8189/system_stats`, and check `nvidia-smi --query-gpu=memory.used --format=csv` — baseline VRAM and confirm the maintainer's own workload isn't mid-job on the GPU. **Their runs take priority; if the GPU is busy with their work, wait or ask.**
  - **Between test phases:** `POST /free` with `{"unload_models": true, "free_memory": true}` (the Kreatine A/B convention) so models unload before the next arm.
  - **ALWAYS tear down when tests complete:** `POST /free` first (release VRAM), then SIGINT the recorded PID, wait for exit, and **verify with `nvidia-smi` that VRAM returned to baseline**. Never leave the stack running after tests; never leave orphaned processes. If the maintainer needs the GPU mid-run, bring the testbed down immediately on request.

**Agent attribution (required for the live dashboard):**
In EVERY `mcp__flux__*` tool call, pass `agent_name="<your agent_id>"`. The SubagentStart identity hook (`~/.claude/hooks/flux-identity.sh`) injects your `agent_id` via additionalContext at launch — copy that exact value into `agent_name`.
- **Unique key** = your `agent_id` (the value the identity hook injected). One agent session = one stable key.
- **Role label** = your agent type / skill name (the hook also injects this as your "role label"). The dashboard composes a display name from project + role + focus task — you do not name yourself.
- Call `resume(project_id="r2lnrfw", agent_name?)` at the start of every session for orientation: active/interrupted sessions, focus task, stale/blocked/unchecked-AC tasks, **unacknowledged directives**, and suggested next work.

**Directives (pinned steering messages):**
`add_directive({ target_type: "task"|"epic"|"project", target_id, body, agent_name })` pins a "read this before proceeding" message on a Task / Epic / Project. A directive is distinct from a comment: it stays **unacknowledged** until cleared via `acknowledge_directive({ target_type, target_id, directive_id, agent_name })`, and `resume` surfaces unacked directives prominently so a cold-start agent cannot miss them. Use sparingly for nudges a downstream agent must not overlook.

**Board model:**
Columns / types / tags are **config-driven** (not hardcoded). Call `get_project_schema(project_id="r2lnrfw")` for this project's resolved columns/types/tags with descriptions. Status moves freely between any columns (no transition gates except the optional done-gate). Priority: `0` = P0 urgent, `1` = P1 normal, `2` = P2 low.

**If context is lost:** re-read this section; the project_id is `r2lnrfw`. Source-of-truth files: this section (committed) and `.flux/project-id` (read by the telemetry hook to attribute `SubagentStart`/`SubagentStop` when a tool call omits project_id).
<!-- FLUX:END -->
