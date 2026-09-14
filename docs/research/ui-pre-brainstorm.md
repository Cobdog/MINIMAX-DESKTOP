# UI pre-brainstorm — working notes (session handoff edition)

**Status:** LIVING DOCUMENT and the primary reorientation point for the canvas
UI work. Process agreed with the maintainer (2026-09-14):

1. Conversational pass (this doc) — capture ideas, keep them vague-shaped, gauge each.
2. Per-item viability pass — prior art, reference code, libraries; verdict on
   possible / worthwhile / overly complicated / modular fit.
3. Only then: the proper brainstorm → real spec → the Canvas UI epic.

Two items are now **LOCKED** (maintainer decisions, 2026-09-14). The rest are
parked or in tension. Nothing beyond the two locks is decided.

---

## LOCKED — Item 1: The entry moment (empty canvas IS the launcher)

**Decision.** No File→New dialog. The first ten seconds resolve *intent*, and
the empty canvas itself is the launcher: a prompt bar, a drop-anything zone
(image/video/audio — the drop routes itself), intent chips, resume cards for
recent sessions. Every intent seeds the canvas differently; no modal, no mode
switch — the app is already the app.

**Maintainer caveat (part of the lock):** start with the MINIMAL set of chips
that are really needed; add more as gaps are found. (Assistant's guard:
≤5 chips at first; the drop zone is the hero gesture.)

**Already built that feeds this.** Vision captioning (LLM layer `0292ec7`) —
"describe an image into a prompt" is a live primitive. Projects/workspace
persistence (SQLite) — resume has a store. Jobs/assets tables — the remix
library. Video pooling + filmstrips — dropped video renders as a live tile
immediately.

**Prior art anchors.** Blender splash (counterexample: document-shaped);
Figma opening surface (recent + drop-anywhere); tldraw/Excalidraw empty-canvas
affordances; Ableton startup (session-centric, no "document" concept).

**Gauge.** Possible: trivially. Worthwhile: highest first-impression leverage.
Complexity: low. Modular: each chip is an independent seeder.

---

## LOCKED — Item 2: Media nodes, stacked ops, derived edges, context bar

**Decision.** The canvas is a node graph *inverted from ComfyUI*: nodes are
full representations of MEDIA, not settings. Each tile embodies the asset
(preview, filmstrip, latent blocks, metadata, op chips) and carries its
controls. A hotkey slides a node into a popup modal — a Photoshop-like editor
(layers, masking, cropping) whose every effect **stacks non-destructively on
the source**; drop the modal and the node now *is* the cropped headshot.
Relationships are authored from a properties panel; connectors MAY be drawn as
read-only visualization of what feeds where — **no hand wiring** (maintainer:
"at least not as a feature I would start off with" — hand wiring is a
possible LATER feature, not a v1 one). The bottom bar is the context-sensitive
frame of reference for the current selection.

**Why this composition is strong (named precisely).** Three proven ideas
composed, not one novel gamble:
- **Blender modifier-stack semantics** — ops stack on a source; bake/Apply is
  explicit and rare; the source is never silently altered.
- **Photoshop smart-object feel** — the modal *feels* destructive but every
  edit is an op in a stack (the newest op on top).
- **Graph as projection, not authoring surface** — relationships authored by
  selection (today's Create view already binds characters/locations this way:
  our own app proves binding-without-wiring). Killing hand-wiring eliminates
  the #1 node-graph failure mode from the UX research ("artists get lost in
  our own node setups" — Blender's own workshop).

**Already built that feeds this.** Stage prototype (pan/zoom/select canvas —
the shell); op-stack + staleness chips (Bench prototype); ImageCrop with
non-destructive crop data; z-token ladder + Base UI panels; video pool +
filmstrip + OPFS cache (rich tiles); the fabric (context events streaming).

**Prior art anchors.** Blender modifier stack; Photoshop/Krita adjustment
layers & smart objects; ComfyUI (what we invert); Fusion (wiring-heavy
counterexample); tldraw selection toolbar; Descript (non-standard projection
beats the standard one).

**Viability (staged, agreed).**
| Piece | Complexity |
|---|---|
| Canvas of media tiles + contextual toolbar | LOW (Stage prototype is the shell) |
| Derived-edge overlay (SVG from properties data) | LOW |
| Properties-panel relationship authoring | LOW-MED |
| Modal editor v1: crop + rotate + brush mask + ctx.filter adjustments | MODERATE |
| Full multi-layer + blend modes | DEFER (v1 = source + mask + adjustments completes the RefMod prep flow) |

---

## ⚠ TENSION — RESOLVING (maintainer direction 2026-09-14; synthesis pending their blessing)

**The original tension.** Item 2 locks the bottom bar as context-sensitive.
But the UX research's strongest rule was: *a queue that fails silently is
worse than no queue* — editors' most-hated failure mode across every NLE
studied. If the bar is fully contextual, the queue needs a guaranteed home.
First-round candidates (persistent sliver at bar's end / floating queue
panel / queue-in-bar-when-generating) are now MOOTED by the maintainer's
reframe below.

**The maintainer's reframe (2026-09-14, near-verbatim):** the job queue is
represented RIGHT ON THE CANVAS — some indication of which canvas elements
are part of the current job, its progress, attached to its outputs. New
outputs get dumped onto the canvas as new artifacts to be worked on directly,
decomposed, edited, fed into another chain. The point is to represent
everything on canvas while eliminating ComfyUI's biggest pain (navigating
the canvas); tools/widgets/modals live anywhere on screen, floating or
taking focus, showing the output of the current target. **"We want to SOLVE
the ComfyUI and Blender tension, not do the same thing again."**

**Proposed synthesis (assistant, pending maintainer confirmation)** — three
layers, three jobs, which fully dissolves the tension (the bar can be 100%
contextual because queue status is no longer the bar's job):

| Layer | Home | Carries |
|---|---|---|
| Per-job state | ON CANVAS, attached to its input elements | progress, cancel, durable failure + reason |
| Aggregate attention | fixed chrome — extend the titlebar engine chip | "3 running · 1 needs attention"; click ZOOMS canvas to the troubled region (a radar, not a queue home) |
| Management | summonable index (⌘K / overlay) | flat list across everything: retry/cancel; each entry navigates to its region |

**Conditions for the spatial model to satisfy the no-silent-failure rule**
(three design contracts, not polish):
1. Failure state is DURABLE on the object — visibly marked until dismissed,
   reason attached. A flash-red-then-idle tile is silent failure with steps.
2. Off-screen events still ping — the aggregate attention indicator is the
   one fixed-chrome survival of the old "queue seat" idea (tiny, navigates).
3. The empty-canvas seed is designed: first-ever generation has no input
   node to attach to, so generation spawns a seed artifact (placeholder tile
   at the prompt bar, carrying progress, morphing into the output) — this
   makes the launcher come alive the first time it's used.

**The crisp formulation this implies:** you never travel to state — state
either lives where you're working or comes to you (job state on objects;
output inspection floats to attention — the fabric already streams preview
frames, so a floating panel can show a running job's live output anywhere).
Navigation then serves only AUTHORED movement (deliberately going to another
chain), which gets search / camera bookmarks / overview / zoom-to-fit.

**Stakes raised accordingly:** canvas substrate quality is now LOAD-BEARING,
not polish. Weapons, all consistent with "everything seen is a projection":
- **Semantic zoom** — far out a tile is thumbnail + status ring; zoom in and
  metadata / op chips / latent blocks resolve. The overview minimap IS the
  far-zoom projection (this also answers the parked latent-block question:
  they appear at a zoom level, not in a mode).
- **Auto-placement** — outputs land adjacent to their parent, edge drawn
  (derived read-only edges, per Item 2). The canvas grows where you work.
- **Zoom-to-attention** — every needs-attention affordance moves the camera.
- **Camera bookmarks / saved workspaces** — parked question promoted to
  navigation infrastructure.

**Prior art (piecewise only; the composition is ours):** TouchDesigner puts
errors/cook state on nodes (but state-without-comes-to-you still means
traveling); Krea dumps generations on canvas (image-first, no chain
semantics); tldraw is the substrate candidate; Blender's render queue and
Resolve's queue are docked-panel counterexamples.

**Open sub-questions (this section):**
- "Decompose an output" — which primitive is v1: shot-split into take-objects,
  frame extraction, or latent-block splitting into separately-extendable
  windows? (Maintainer used the word 2026-09-14; not yet pinned down.)
- Placement policy beyond adjacent-to-parent (clusters? grid? what on batch
  completion of e.g. a movie chain?).
- Does the floating output inspector float freely, dock-to-nearest-edge, or
  follow selection? (Maintainer: "floating or taking focus" — both allowed?)
- Summonable index scope (jobs only, or the ⌘K palette over everything?).

**Related unresolved: where does PLAYBACK live** (context-bar transport vs
program-monitor tile on canvas)? Still open; the spatial-queue direction
nudges toward playback-as-object-state (playing is a temporary state of a
tile) but nothing is decided.

---

## Parked questions (not yet discussed — take in maintainer's chosen order)

- Latent-truth legibility in tiles: context blocks under previews — always
  visible, or only during chain/extend actions?
- Workspace preset set (Generate/Edit/Prep/Graph/Library?) — Blender-style
  saved layouts + active projection.
- Timeline: summoned projection vs permanent bottom-bar resident.
- Engine views dissolving into generators-as-ops (select nothing + Generate =
  t2v; select image + Generate = i2v).
- One canvas per project vs one infinite canvas with project regions.
- Screen-size adaptation for floating panels (auto-collapse below width?).
- Command palette scope (⌘K over every action).
- The **Focus primitive**: selection → named reusable conditioning target
  (crop-to-face refmod, context-window extension, region inpainting = one
  gesture). Assistant's candidate for THE novel abstraction; not yet discussed.
- Modal open: tile preview live-updates or freezes? (Assistant's instinct:
  live-update — the honest-projection answer.)
- Do op chips on tiles open inline quick-controls, or is the modal the only
  editor in v1? (Assistant's instinct: modal-only v1.)

## Session inspirations inventory (what shaped this direction)

- The maintainer's latent-truth insight: "the VAE decoded video is just the
  preview and what I was actually selecting was the raw latents" — the
  DOCUMENT MODEL: chains of latents/assets; everything seen is a projection;
  preview quality is per-object. Trim = window; extend = continue chain from
  context window; quality degradation avoided by never re-encoding round trips.
- RefMod flow: paste image → crop to face/body/outfit → create refmod in-app.
- Blender as the creation-model north star (with its discoverability sins
  fixed by design: shortcuts printed on affordances).
- Research findings that bind us: editors' pain = flow interruption, not
  layout; Auditions (takes compared in context) and Operate→Settings (run
  immediately, adjust, re-runs — no dialogs) are the two steal patterns;
  curation celebrated over slot-machine.
- Prior-art list for the viability passes: tldraw, Natron/Fusion, Descript,
  Blender workspaces, Krita, Resolve Cut-vs-Edit, Runway (what they get
  wrong), Photopea. Libraries: tldraw SDK (evaluate as substrate), Konva,
  PixiJS v8 (when WebGL needed), react-rnd, Base UI (adopted), mediabunny +
  WebCodecs (planned in PreviewSource seam).

## Status of the three prototypes

Shot Bench / Stage / Score remain live at `/?proto=bench|stage|score`
(commit `71a6689`, 14/14 e2e) as interactive references. The locked
direction is effectively **Stage's shell + Score's document soul** — the
prototypes served their purpose (the conversation evolved past them); they
stay runnable for ground truth but do not need updating.

## Camera editor placement (locked earlier)

The bruxosdovfx camera compiler port (task ving89w, directive b309fad7):
compiler ports as a pure UI-free lib when needed; the EDITOR lands as a UI
component/module in the "video canvas" phase — i.e., inside THIS direction.

## Next steps

1. Queue tension: maintainer direction recorded (spatial — see § TENSION);
   confirm the three-layer synthesis + pin down "decompose" v1 semantics.
2. Continue parked questions in the maintainer's chosen order.
3. Viability passes per item as they firm up — the canvas substrate itself
   (semantic zoom, auto-placement, navigation) is now first among them.
4. Proper brainstorm → Canvas UI spec → build epic.
