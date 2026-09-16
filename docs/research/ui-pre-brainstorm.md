# Canvas UI — decision register (pre-brainstorm → spec index)

> **Condensed 2026-09-16 (hygiene pass 2, Flux zbn31xs).** This was the living
> pre-brainstorm working doc; its decidable content is now encoded in the
> **BLESSED spec** — [docs/specs/canvas-ui-v1.md](../specs/canvas-ui-v1.md)
> (BLESSED 2026-09-15, commit 8378214) — and the document-model decisions in
> [docs/specs/canvas-document-model.md](../specs/canvas-document-model.md).
> This file is now the **decision register**: each lock, where it lives in the
> spec, and what is still genuinely open. The full reasoning, maintainer
> near-verbatim quotes, prior-art anchors, and session inspirations remain in
> [docs/archive/ui-pre-brainstorm-session-notes.md](../archive/ui-pre-brainstorm-session-notes.md)
> (archived verbatim).

**North star (maintainer, 2026-09-14):** iteration must be fast and
frictionless — ideas worked on without bottlenecking on UI/UX. Testable at
spec time: every common action gets an interaction budget; over-budget is a
design bug. (Spec §1.)

## Locks (all dated 2026-09-14, all encoded in the spec)

| Lock | Decision | Spec home |
|---|---|---|
| Entry moment | The empty canvas IS the launcher — prompt bar, drop-anything zone, minimal intent chips (≤5 first), resume cards. No File→New, no modal. | §4 |
| Media nodes + op stacks | Nodes are full media representations; modal editor stacks ops non-destructively; relationships authored from a properties panel; derived edges are read-only visualization — **no hand wiring in v1**. | §2, §3 |
| Canvas substrate | DOM + CSS transforms; d3-zoom camera; SVG derived edges; react-rnd floating panels; three.js reserved for the IK-rig viewport; PixiJS reserved-not-committed; tldraw and canvas/WebGL engines rejected. | §3 |
| Queue synthesis (was the REQUIRED-DISCUSSION tension) | Per-job state lives ON canvas objects (durable failure state); aggregate attention = titlebar radar that zooms to trouble; management = summonable index; bottom bar 100% contextual. | §4 |
| Fork semantics + takes | Forks are LOCKED (snapshot) by default, LIVE-reference as per-fork toggle; upstream change marks downstream stale, rerun is consented targeted rebuild; takes are append-only with canonical-pointer switching; lock granularity is chain-level; latents stored raw on disk. | §2 (+ canvas-document-model.md) |
| Canvases | One canvas per project, plus a multi-canvas SESSION (several open at once, survive restarts, closeable); autosave everything always, including camera positions. | §2, §3 |
| Camera editor placement | The camera EDITOR lands as a canvas-phase UI component consuming the landed pure compiler (`src/lib/camera/`); never a standalone early feature. (Maintainer directive b309fad7; editor task y93rk61.) | §5 |

## Forming items (shaped in the notes, resolved by the spec)

- **Typed holes / endpoints as objects** (input node as session seed; output
  node = substrate selector + take-off; ops stack in-chain, only forks need
  outputs) — encoded in §2/§5.
- **Director Suite** (timeline as projection over the chain DAG; gaps between
  segments are transition seats; multi-input forks) — encoded in §6; measured
  grounding in
  [h3-transitions-and-latent-continuity.md](h3-transitions-and-latent-continuity.md)
  and the E-MD1 movement-director result
  ([h3-sampler-shaping-and-motion-control.md](h3-sampler-shaping-and-motion-control.md)):
  the AddGuide positional-guide path is the product path, zero extra weights.
- **Parked questions** — all reconciled into the spec's §9 ledger (audit L1:
  the union of every open question, each with its disposition).

## Still open after the spec

- "Decompose an output" v1 semantics (shot-split vs frame extraction vs
  latent-block splitting) — the one tension explicitly left open in the notes;
  see spec §9 for the current disposition.
- Anything the spec itself marks open (its §9 ledger and §10 acceptance are
  the authoritative open-items list — consult the spec, not this file).

## Prototypes

Shot Bench / Stage / Score remain runnable at `/?proto=bench|stage|score`
(commit 71a6689) as interactive references for the migration map
([ui-inventory-and-migration-map.md](ui-inventory-and-migration-map.md));
the locked direction is Stage's shell + Score's document soul. They do not
need updating.

## Process record

Conversation → per-item viability → brainstorm → spec → build was the
maintainer-set funnel (2026-09-14). The spec passed three adversarial audit
passes (tasks m2sdz9r, 2zkir0u, yhepvdi, 5hkenmv — all closed 2026-09-16 with
commit-evidence) and was blessed 2026-09-15. Build is tracked in the Canvas UI
epic (Flux vbrstja); Phase 1 (substrate + launcher + spatial queue) and
Phase 2 (generation on canvas) have landed behind `?canvas=1`.
