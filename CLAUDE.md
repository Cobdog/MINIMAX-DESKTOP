<!-- FLUX:START -->
## Flux Task Management

This repo is tracked by Flux. Project: **MINIMAX-DESKTOP** (`r2lnrfw`).

**Rules:**
- All work MUST belong to exactly one project_id (`r2lnrfw` for this repo).
- Do NOT guess or invent a project_id.
- Track all work as tasks; update status as you progress.
- Close tasks immediately when complete.

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
