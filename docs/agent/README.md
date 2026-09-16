# Agent docs — what lives where, and why

> Created by hygiene pass 2 (2026-09-16, Flux zbn31xs). The project
> `CLAUDE.md` is deliberately minimal: it carries only what every session
> needs at boot (Flux wiring, project id, the safety-critical engine rules,
> repo-map pointer). Everything deeper lives HERE and is **lazy-loaded on
> intent**: read the relevant file when you are about to do that kind of
> work, not at startup. Each file states its own trigger.

| File | Read it when… | What it holds |
|---|---|---|
| [`runbook.md`](runbook.md) | You are about to touch a GPU, the 8189 testbed, or run any engine-dependent test/experiment | The full bring-up/teardown runbook (launch line, health checks, `/free` conventions, the `--disable-dynamic-vram` history), GPU-window etiquette, experiment conventions (seeds, contention guard, teardown + VRAM verification), measurement-honesty pointers |
| [`testing.md`](testing.md) | You are about to run, extend, or debug the test suites / CI | The `pnpm gate` chain and its suites, the vision-in-the-loop pipeline (capture → judge → report) and its cache trap, system-Chromium rules, TMPDIR discipline for scratch-heavy suites, both CI legs, the in-flight benchmark harness |
| [`conventions.md`](conventions.md) | You are about to commit, review, vendor/port third-party code, or write a research doc | Commit + verification patterns (conventional commits with task ids, both-CI-legs proof), Flux conventions (agent_name, done-gates with evidence, references), licensing doctrine (provenance headers, LICENSES/PROVENANCE rows, the license gate), research-doc format (method header, evidence tags, verdict menus) |
| [`../library/`](../library/README.md) | You are about to rely on an external-doc fact (H3 prompting, ComfyUI node behavior, chaining) for non-trivial work | Full-copy captures of our most load-bearing external sources, each with source URL + fetch date + pinned revision + license note. Run the library's SOURCE-OF-TRUTH CHECK (three questions) before treating a captured fact as current — see THE FRESHNESS DOCTRINE in `CLAUDE.md` |

**Why lazy-load:** boot-time context is the scarcest resource an agent has.
The safety rules that must never be missed are inline in `CLAUDE.md` on
purpose; the depth behind them is one Read away, keyed to the task at hand.
If you find yourself re-deriving anything in these files, the fix is to
update the file, not to memorize it.

**Repo map (orientation, one line each):** `server/` the Node server
(core, runtime, fetcher, realtime, LLM layer) · `src/` the React SPA
(views/, hooks/, components/, lib/ incl. the graph factory + camera
compiler, canvas/ the in-flight new surface, prototypes/ the direction
references, poserig/ the IK rig) · `scripts/` the test harness suites and
fixtures · `docs/` everything documented (see README's Documentation table;
[../ROADMAP.md](../ROADMAP.md) for state of play,
[../LEARNINGS.md](../LEARNINGS.md) for operational lessons,
[../library/](../library/README.md) the external-source research library) ·
`benchmarks/` the in-flight benchmark-harness working tree (untracked) ·
`vendor/nodes/` permissively-licensed vendored node packs · `custom-nodes/`
first-party node packs · `e2e/` Playwright specs · `test-results/`
committed experiment/vision artifacts.
