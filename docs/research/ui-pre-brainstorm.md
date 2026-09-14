# UI pre-brainstorm — working notes (session handoff edition)

**Status:** LIVING DOCUMENT and the primary reorientation point for the canvas
UI work. Process agreed with the maintainer (2026-09-14):

1. Conversational pass (this doc) — capture ideas, keep them vague-shaped, gauge each.
2. Per-item viability pass — prior art, reference code, libraries; verdict on
   possible / worthwhile / overly complicated / modular fit.
3. Only then: the proper brainstorm → real spec → the Canvas UI epic.

Two items are now **LOCKED** (maintainer decisions, 2026-09-14). The rest are
parked or in tension. Nothing beyond the two locks is decided.

**[2026-09-14, later sessions — lock count superseded:]** beyond the original
two, the same day's conversations additionally locked: **canvas substrate**
(new section below), **queue synthesis** (§ TENSION — resolved), **fork
semantics + takes model** (Item 3), and **canvases** (one canvas per project +
multi-canvas session — see Parked questions). This paragraph is kept for the
record; the per-section dated notes are the running lock register.

**NORTH STAR (maintainer, 2026-09-14):** "Iteration needs to be fast and
frictionless. Ideas need to be able to be worked on without bottlenecking
on UI and UX." Testable at spec time: every common action gets an
interaction budget (keystrokes/clicks from intent → running job); any
action over budget is a design bug.

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

## LOCKED — Canvas substrate (2026-09-14, later session)

**Decision.** The substrate is **DOM + CSS transforms**, not a canvas engine:
media tiles are DOM elements moved by CSS transform; the camera is
**d3-zoom** (pan/zoom, and semantic-zoom behavior as data); derived edges
render as **SVG**; floating panels are **react-rnd**; the IK-rig viewport
(Control Surfaces epic) is **three.js**; **PixiJS is reserved but not
committed** (revisit only if a measured DOM bottleneck appears). Explicitly
rejected: **tldraw**, and canvas/WebGL-engine substrates generally.

**Why this composes with the locks above:** DOM tiles make the op-stack /
properties-panel / modal-editor model (Item 2) native — every tile is
inspectable, styleable, and accessible; d3-zoom gives semantic zoom without a
scene graph to fight; SVG edges are the derived-visualization layer for free.
The "everything seen is a projection" document model is unchanged — this is
the rendering substrate under it, not a model change.

---

## ⚠ TENSION — RESOLVING (maintainer direction 2026-09-14; synthesis pending their blessing)

> **RESOLVED (2026-09-14, later session):** the three-layer synthesis below
> was accepted — per-job state lives spatially ON canvas objects (durable
> failure state on the object; the empty-canvas seed tile spawns at the
> prompt bar), aggregate attention is the titlebar radar (click zooms the
> camera to the troubled region), management is the summonable index, and
> the bottom bar is 100% contextual. The REQUIRED-DISCUSSION directive on
> the tracking task (wquw2mu) is acknowledged and its AC checked. The
> section below is the reasoning that got there, kept for the record.

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
semantics); tldraw was the substrate candidate (superseded 2026-09-14 —
substrate locked to DOM+CSS transforms, see the substrate section; tldraw
explicitly rejected); Blender's render queue and
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

## Item 3 (forming): chain endpoints as canvas objects — connectors as typed holes

**Maintainer proposal (2026-09-14, near-verbatim):** input and output should
always live ON the canvas as their own objects; they can be clicked to start
selecting content for the chain; work forwards or backwards; see what
options you have available by clicking on a connector. "Simple and easy to
see at all times." Placement intuition: when a pipeline is framed, the I/O
nodes sit cleanly nearby. Concern raised: challenges + performance costs on
an infinite canvas.

**Sharpening (assistant):** this is SELECTION-AUTHORING, not wire-authoring —
the no-hand-wiring lock (Item 2) is INTACT and gains its best affordance.
Analogy: **typed holes** — put a hole in the pipeline, ask "what fits
here?", get every valid completion (type-directed filter over the op
registry: consumers when clicked forwards from a source, producers when
clicked backwards from a target). The edge is still created by choosing
content from a menu; drawn connectors remain derived visualization. The
properties panel and the connector-click are two doors into the same
relationship operation. This is also the strongest discoverability answer to
Blender's sin (options visible AT the affordance) and partially answers the
parked "engine views dissolve into generators-as-ops" question (the option
list IS the engine surface).

**Placement rule (proposed):** endpoints materialize only where a chain is
OPEN. Filled connection = derived edge, no endpoint object. Open input /
open output = loud clickable object adjacent to its chain (same
auto-placement-by-adjacency rule as the spatial queue outputs). Head/tail
tiles of an attached chain ARE its endpoints (click head → browse forwards;
click tail → browse backwards). No global placement problem; no
viewport-pinning; endpoints are never "somewhere else."

**Gauge (2026-09-14):** rendering cost of the objects trivial (few, only
when open); option-space query cheap (in-memory type filter, no engine
round-trip); adds NO new performance cost class — the real perf question
remains the substrate at scale (virtualization, semantic-zoom culling, edge
rendering strategy), already load-bearing. Complexity LOW-MED v1
(objects + menu + filter); backwards-authoring = same query mirrored.
Modular: fully (affordance layer over the relationship model, zero model
changes). Worthwhile: high.

**Prior art (piecewise):** Blender's node search-menu (add-by-search but
still wire-dragging); TouchDesigner/Houdini typed inputs (no query-at-hole);
typed holes in programming environments (Idris/Haskell — the conceptual
source); Krea canvas (no connectors at all — limitation). No mainstream
node editor does query-at-the-connector or goal-directed backwards
authoring.

**Refinement (maintainer, 2026-09-14 later): single-endpoint asymmetry.** You
always start with an INPUT node ("probably the smartest way instead of both
an input and output node") — the session seed. Populating the chain makes
content appear as tiles; when the chain reaches a node that "can really only
output," the output node "just appears." Few node TYPES are output-capable
(final artifacts, not intermediates). Purpose of the output node: take the
previous generation and chain it — extend, crop-then-new-generation,
mask-and-restart, edit, second pass, upscale. "Being able to choose what is
being outputted is likely an important consideration."

**Sharpening (assistant):**
- **THE RECURSION:** an input node is either FRESH (typed prompt, dropped
  media) or a REFERENCE to an output node. Every edge on the canvas is an
  output→input reference — that is the whole graph model, and it is WHY
  no-hand-wiring isn't a limitation: edges are chain relationships that
  exist the moment a fork references an output; drawn connectors are
  derived visualization for free. You cannot mis-wire what you never wire.
  The fresh-input node IS Item 1's launcher made literal.
- **Output node = substrate selector + take-off.** It chooses what the fork
  carries: raw latents (chain-true continuation, no re-encode) | decoded
  media | crop/mask projection | extracted frame | audio stem. This is
  where latent-truth becomes an explicit UI choice. Possible SUBSUMPTION:
  the parked Focus primitive may collapse into this ("crop-to-face as the
  output" feeding a new chain as a refmod = an output substrate choice).
- **Ops vs forks (answers the maintainer's "not sure all of those need
  explicit outputs"):** crop/mask/trim/adjust = OP STACK, same chain, no
  output node (Item 2 owns them). Extend = same-chain growth (latent
  continuation). Crop→new generation, mask→restart, second pass = FORKS
  (output node). Upscale is dual-mode: stack it (preview-quality op) or
  fork it (rendered second pass) — both should exist. Rule: ops stack
  in-chain; only forks need outputs.

**Fork semantics RESOLVED (maintainer, 2026-09-14): LOCKED (snapshot) by
default, LIVE reference as a per-fork toggle.** Rationale (maintainer's
workflow): locks pin a chain's chosen state so downstream forks rerun only
on consent; regenerating upstream marks downstream STALE (visible, not
auto-executed); rerun re-executes the fork's recorded settings against the
new upstream output "without having to do much of anything." Assistant
framing: a BUILD SYSTEM WITH CONSENT GATES — lock = pinned artifact, fork =
dependent stage with recorded settings, upstream change = dirty bit shown
as stale, rerun = targeted rebuild. Requires fork settings to persist
separately from fork results (already true: registry/op-stack configs vs.
job outputs). TAKES fall out naturally: generations within a chain are
takes; locking pins settings + selected take; rerun produces a NEW take
and preserves priors for comparison (the Auditions research pattern).

**Takes model (locked 2026-09-14, later session):** takes are APPEND-ONLY —
a new take never overwrites; it SUPERSEDES via a canonical-pointer switch
(the chain's "current take" pointer moves; priors stay browsable and
lockable). Latents are stored RAW ON DISK by default (the decoded video is
the preview — the document-model insight made a storage rule). Lock
granularity is CHAIN-LEVEL. These decisions are inputs to the canvas
document-model spec (o0xw49r), whose acceptance criteria already encode them
(append-only takes with immutable identity; atomic canonical switching;
media + latents stay files on disk).

**Open sub-questions:**
- Lock granularity: chain-level (maintainer's phrasing) vs per-fork-edge —
  **RESOLVED 2026-09-14: chain-level** (see the takes-model note above).
- Can one tail feed multiple forks with different substrates (video to one
  chain, latents to another) simultaneously?
- Does the seed input node stay visible as the chain's head once populated,
  or resolve into chain metadata?
- Option-menu contents: generation ops and utility ops together, ranked how?
- Backwards-authoring v1 scope: "what can extend/produce this" only, or
  fuller target-seeking?

## Item 4 (forming): the Director Suite — timeline as projection over the chain DAG

**Maintainer (2026-09-14, near-verbatim):** "a prompt timeline… keep track
of prompts over a very long duration, where you can run said chains on just
targeted portions. Plan out a 1 minute video, execute each shot one
timescale at a time 0-5, 10-20, 20-22, plan either model generated
transitions or create NLE effects/transitions, attach references that would
be handed off to each chain etc. A full director suite essentially, along
with the camera editor and other tools."

**Sharpening (assistant):**
- The timeline is a PROJECTION over the chain DAG (answers the parked
  "timeline-as-projection vs permanent" question: summonable view, not a
  permanent bottom-bar resident). Segments map to chains; the PLAN is what
  it projects.
- **In-app prior art:** the existing MoviePlanner already does
  shots/scenes/continuity handoffs form-based; the Director Suite is its
  canvas-native successor.
- **Gaps between segments (0-5, 10-20, 20-22) are the transition seats.**
  A model-generated transition = a MULTI-INPUT fork (last frame of A +
  first frame of B = our existing frames mode). Consequence: the input
  recursion extends to `input = fresh | output-ref | output-refs[]` (H3
  reference mode already accepts multiple references — engine side ready).
  NLE transitions (crossfades etc.) live in the same gaps as export-time
  ops the DAG doesn't need to own.
- Camera editor (locked placement, canvas phase) plugs in as a tool a
  segment's chain can carry.
- **Data-model requirements to honor NOW (cheap now, expensive later):
  multi-input forks, takes history, lock/stale/rerun semantics,
  settings-results separation.** The Director Suite itself is a later
  layer — but the DAG substrate must not preclude it.

**[2026-09-14, later sessions — inputs landed:]** the research this item
depends on has shipped: the transitions/latent-continuity harvest
(docs/research/h3-transitions-and-latent-continuity.md — 27 sources,
verdict table, E1–E8 experiment ladder) and the node-ecosystem sweep
(docs/research/h3-node-ecosystem-sweep.md), which found Director-Suite-
adjacent machinery already in the field to reference rather than reinvent
(AIMixer's in-node director with timeline + exchange format; Continuum's
takes/branch-provenance contract; FL-MiniMaxH3's PromptTimeline
shot-list→conditioning-mask compiler; GENKAIx's PromptSync
timed-prompt↔playback review view).

## Parked questions (not yet discussed — take in maintainer's chosen order)

- Latent-truth legibility in tiles: context blocks under previews — always
  visible, or only during chain/extend actions?
- Workspace preset set (Generate/Edit/Prep/Graph/Library?) — Blender-style
  saved layouts + active projection.
- Timeline: summoned projection vs permanent bottom-bar resident.
  **[Resolved 2026-09-14: summonable projection — Item 4's answer stands.]**
- Engine views dissolving into generators-as-ops (select nothing + Generate =
  t2v; select image + Generate = i2v).
- One canvas per project vs one infinite canvas with project regions.
  **[Resolved 2026-09-14: BOTH, layered — one canvas per project, plus a
  multi-canvas SESSION: several canvases open at once, ComfyUI-tab-style;
  they survive restarts and are closeable; autosave EVERYTHING always,
  including camera positions.]**
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
  wrong), Photopea. Libraries: tldraw SDK (was to be evaluated as substrate;
  rejected 2026-09-14 — substrate locked to DOM+CSS), Konva, PixiJS v8
  (reserved, not committed), react-rnd (adopted — floating panels), Base UI
  (adopted), mediabunny + WebCodecs (planned in PreviewSource seam).

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
   **[2026-09-14: synthesis CONFIRMED — see the RESOLVED note in § TENSION;
   still open: "decompose" v1 semantics.]**
2. Continue parked questions in the maintainer's chosen order.
3. Viability passes per item as they firm up — the canvas substrate itself
   (semantic zoom, auto-placement, navigation) is now first among them.
4. Proper brainstorm → Canvas UI spec → build epic.
