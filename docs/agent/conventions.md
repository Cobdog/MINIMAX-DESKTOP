# Conventions — commits, verification, licensing, research docs, Flux

> Trigger: read this BEFORE committing, porting/vendoring third-party code,
> writing a research doc, or closing Flux tasks. These are the established
> patterns this repo actually follows (each proven by landed work).

## Commits

- **Conventional commits**, scope optional, and the Flux task id in the
  subject trailer parenthetical: `feat(canvas): Phase 2 — generation arrives
  on canvas (flyuh6h)`, `docs(research): tranche-3b addenda — … (a80ekav)`.
  The id makes every commit traceable to its task and vice versa (add a
  `commit` ref on the task).
- End commit messages with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- Docs-only changes are their own commit; never mix docs with code.
- **Stage explicitly by path** (`git add docs/… src/…`) — other agents may
  have in-flight edits in the same tree; never `git add -A`, never stash.
- Push to `origin main` after both CI legs are queued; verify green before
  declaring done.

## Verification (what "landed" means)

1. The full gate passes locally (TMPDIR discipline — see
   [testing.md](testing.md)).
2. BOTH CI legs green (ubuntu + engine-windows); run links recorded.
3. The Flux task closes through the done-gate (`complete_task`) with an
  evidence summary citing commit(s), CI runs, and artifact paths — ACs
  checked via `toggle_acceptance` as they were verified, never hand-flipped.
4. Research verdicts/addenda land in `docs/research/*.md` with a dated
  commit; raw numbers stay in the task comments.

## Licensing / vendoring / ports

- **The license gate is absolute and machine-checked** (`pnpm
  license:audit` in the gate + CI): only permissive (Apache-2.0/MIT/ISC)
  code may be vendored, at a pinned revision, LICENSE shipped in-tree;
  NO-LICENSE and GPL-family are user-fetch only, never vendored.
- **Ports** (re-implementation, no upstream bytes): per-file provenance
  headers (repo + upstream commit), a `docs/PROVENANCE.md` vendored-table
  row, and a `docs/LICENSES.md` row. Precedent: the camera compiler port
  (`src/lib/camera/`, ace6c48).
- Every fetchable thing is catalog DATA (`server/fetchCatalog.ts`): source
  repo + path, sha/tag pin, size, SPDX verdict, destination; consent records
  must match the CURRENT license (a license change invalidates stale
  consent). Weights LINK, never copy (`linkNeverCopy()`; copy is never the
  fallback).
- **Research library** ([../library/](../library/)): full-copy captures of
  load-bearing external docs are INTERNAL REFERENCE COPIES ONLY — never
  shipped, never vendored into source; the license verdict is noted in each
  capture's header (GPL/NO-LICENSE sources readable here, never
  redistributed). Before relying on a captured fact for non-trivial work,
  run the library's SOURCE-OF-TRUTH CHECK (three questions; dated addenda,
  never silent rewrites).
- Full policy + rationale: `docs/LICENSES.md`, `docs/PROVENANCE.md`,
  architecture.md §Third-party components.

## Research docs (docs/research/)

- Header states the task id, date, and METHOD (what was code-read vs
  README-assessed vs measured). Claims carry evidence tags: **[DOC]**
  verified in shipped code / official source, **[COMM]** reputable community
  claim, **[SPEC]** plausible-unverified, **[UNK]** nobody knows.
- End with a verdict table; corrections arrive as DATED addenda (never
  silent rewrites — the addendum trail is the audit trail).
- Fresh-release assessments use the verdict menu: **ADOPT / ADJUST /
  CORRECT / CONFIRM** (see [../LEARNINGS.md](../LEARNINGS.md)); catalog rows
  for anything adopted (sha-pinned, user-fetch when non-permissive).
- Specs live in `docs/specs/` and carry a status line (DRAFTED → BLESSED);
  superseded working notes archive to `docs/archive/` (git mv, never delete)
  with the archive README explaining succession.

## Flux

- `project_id` is `r2lnrfw` — never guess or invent ids; every work item is
  a task; `agent_name="<agent_id from the identity hook>"` in every call
  that accepts it; `resume()` at session start.
- Task mentions in comments/replies are always "Task Name (id)".
- `depends_on` is the ONLY dependency edge (forward); `update_task` array
  fields REPLACE whole sets — use `task_set_tags`/`toggle_acceptance` for
  increments; `move_task_status` takes no agent_name.
- Ambiguous closures/splits surface as a maintainer-review list or a pinned
  directive — never unilateral judgment calls; dated notes are the
  established correction pattern.
- Stale docs are archived, not deleted; task refs pointing at moved docs get
  fixed in the same pass that moves them.

## The modularity test (every architectural decision)

The remediation program (epic 4lphxv8) settled the modularity contract:
**"pulling out and removing old tools should be as easy as buying a new one."**
Before landing any change that adds or couples surface area, answer: *could this
be pulled tomorrow without collateral?* If the change welds a surface, engine,
or model story to another, stop and decouple first. The removal-cost question
is part of every wave's acceptance and belongs in review comments when spotted.

## Session behavior (maintainer's standing expectation)

- Continuous autonomous work until explicitly told to stop; after a task,
  pick up the next backlog item; match the maintainer's energy.
- Deletion policy (global, absolute): destructive shell commands are blocked
  by the user's hook — a block is standing policy, never an obstacle to
  route around; if a deletion is genuinely necessary, stop and ask.
- After engine/GPU work, teardown + `nvidia-smi` verification, always
  ([runbook.md](runbook.md)).
