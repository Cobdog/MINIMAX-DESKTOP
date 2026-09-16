# Archive — superseded and historical documents

> Created by hygiene pass 2 (2026-09-16, Flux zbn31xs). Items here are **never
> deleted** — they are moved out of the live tree with `git mv` (history
> preserved) when a successor document fully covers their live purpose. Each
> entry below states what it was, why it was archived, and where the successor
> lives. `docs/audit/` stays in the live tree on purpose: the audits are the
> canonical record of what was found and later fixed, and README links them.

| Item | What it was | Status / successor |
|---|---|---|
| `inventory.md` | The 2026-09-09 onboarding census of the **original Electron app** (IPC channel table, 96-file tree census, dependency inventory at `18fe989`). Factual foundation for the fork's first audits and the doc restructure. | **Superseded.** The Electron era ended 2026-09-10 (`docs/migration.md`); its "current state" claims (1961-line App.tsx, 30 IPC channels, Electron packaging) are historical only. Live architecture: [`docs/architecture.md`](../architecture.md). Live dependency/license truth: [`docs/LICENSES.md`](../LICENSES.md). Kept because the audits cite its §1.2 IPC enumeration and it is the only complete record of the upstream feature surface at fork time. |
| `plan-v0.md` | Upstream's root-level `plan.md` — an AI-assisted development log (18 numbered "feature passes") from the repo's first two days. | **Historical, unchanged.** Archived 2026-09-09 (moved here 2026-09-16 from `docs/history/` to consolidate the archive in one place). Contains design intent for Movie Planner / production libraries that survives nowhere else, plus the only recorded upstream roadmap (Pass 8 HTTPS, Pass 10 DaVinci/EDL export, Pass 11 automation controller — all still unimplemented). Do not treat its feature claims as current reality. |
| `ui-pre-brainstorm-session-notes.md` | The full canvas-UI pre-brainstorm working notes (2026-09-14, ~440 lines): conversational locks with rationale, the queue-tension synthesis, typed-holes authoring, Director Suite shaping, parked questions, session inspirations. | **Superseded by the BLESSED spec.** Everything decidable was encoded into [`docs/specs/canvas-ui-v1.md`](../specs/canvas-ui-v1.md) (§9 reconciles the parked-questions ledger); the document-model decisions went into [`docs/specs/canvas-document-model.md`](../specs/canvas-document-model.md). The live decision register with per-lock pointers is now [`docs/research/ui-pre-brainstorm.md`](../research/ui-pre-brainstorm.md). Kept verbatim as the richest record of *why* each lock exists (maintainer near-verbatim quotes, prior-art anchors, gauges). |
