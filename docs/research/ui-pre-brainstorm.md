# UI pre-brainstorm — working notes (informal)

**Status:** living document. This is the loose-shape list that precedes the real
brainstorm. Process agreed with the maintainer (2026-09-14):

1. Conversational pass (this doc) — capture ideas that "sound good," keep them vague-shaped.
2. Per-item viability pass — prior art, reference code, libraries; verdict on
   possible / worthwhile / overly complicated / modular fit.
3. Only then: the proper brainstorm → real spec.

Nothing here is decided. Everything here is gauged.

---

## Item 1 — The entry moment (no File→New dialog)

**Shape so far.** The first ten seconds should resolve *intent*, not document
type: create an image from scratch, have a VLM describe an existing image into
a prompt, edit a video I already have, resume where I left off, remix past
work. A "new project / open project" modal is the wrong shape for this.

**Working direction.** The empty canvas IS the launcher. On boot with no
session: a prompt bar, a drop zone (drop anything — image/video/audio routes
itself), intent chips (Generate · Describe an image · Edit a video · Remix
from library), and resume cards for recent sessions. Every intent just *seeds
the canvas differently* — no modal, no mode switch; the app is already the app.

**Already built that feeds this.** Vision captioning (LLM layer, `0292ec7`) —
the "VLM describes an image into a prompt" path is live as a primitive.
Projects/workspace persistence (SQLite `projects`/`workspace_state`) — resume
has a store. Jobs/assets tables — the remix library. Video pooling +
filmstrips — dropped video renders as a live tile immediately.

**Prior art to study.** Blender splash (recent + templates, but document-
shaped); Figma's opening surface (recent files + drop-anywhere); tldraw /
Excalidraw empty-canvas affordances; Ableton's startup (session-centric, no
"document" concept); Notion's new-page intent gallery.

**Gauge.** Possible: trivially (it's an empty-canvas state, not a subsystem).
Worthwhile: highest first-impression leverage of anything on this list.
Complexity: low. Modular: each chip is an independent seeder.

**Open questions.** How many intents before paralysis (target ≤5)? Do resume
cards need scrubbing previews or is title+thumbnail enough? Does "remix" open
a library browser floating panel or filter the canvas?

---

## Item 2 — Media nodes, stacked ops, derived edges, context bar

**Shape so far.** The canvas is a node graph *inverted from ComfyUI*: nodes
are full representations of MEDIA, not settings. Each tile embodies the asset
(preview, filmstrip, latent blocks, metadata, op chips) and carries its full
control set. A hotkey slides a node into a popup modal — a Photoshop-like
editor (layers, masking, cropping) whose every effect **stacks non-destructively
on the source**; drop the modal and the node is now the cropped headshot.
Inputs/outputs are assigned from a properties panel; connectors may be DRAWN as
read-only visualization of what feeds what — **no hand wiring**. The bottom
bar is the context-sensitive frame of reference for the current selection.

**Why this is strong (and named precisely).** This is three proven ideas
composed, not one new one:
- **Blender modifier-stack semantics** — ops stack on a source; `Apply`/bake is
  explicit and rare; the source is never silently altered.
- **Photoshop smart-object feel** — the modal *feels* destructive (crop!
  paint!) but everything is an op in a stack; the "destructive" edit is just
  the top of the stack.
- **Graph as projection, not authoring surface** — relationships are authored
  by selection in a properties panel (exactly how today's Create view binds
  characters/locations — our own app already does binding-without-wiring), and
  the edge curves are *derived display*, never interaction.

The no-hand-wiring decision directly kills the #1 node-graph failure mode our
UX research found ("artists get lost in our own node setups" — Blender's own
workshop). The graph remains legible; it stops being a skill floor.

**Already built that feeds this.** Stage prototype (pan/zoom/select canvas
with object cards — the shell exists); op-stack + staleness chips (Bench
prototype); ImageCrop with non-destructive crop data (crop op exists); the
document/projection model + refmod-from-selection flows map 1:1 onto op stacks;
z-token ladder + Base UI panels (the floating/modal chrome); video pool +
filmstrip + OPFS cache (tiles render rich media cheaply).

**Prior art to study.** Blender modifier stack (semantics + Apply);
Photoshop/Krita adjustment layers & smart objects (the modal's UX); ComfyUI
(what we're inverting — thumbnail-in-node but settings-first); DaVinci Fusion
(wiring-heavy counterexample); tldraw selection toolbar + contextual handles;
Descript (proof that a non-standard projection of media beats the standard
one).

**Gauge.** Possible: yes, staged. Worthwhile: this IS the product thesis
(prep + generate + assemble in one surface). Complexity: the honest ramp —
  - Canvas of media tiles + contextual toolbar + derived-edge overlay: LOW
    (prototype exists; edges are an SVG overlay from properties data).
  - Properties-panel relationship authoring: LOW-MED (binding UI patterns exist).
  - Modal editor v1 — crop + rotate/flip + brush mask + canvas-filter
    adjustments (brightness/contrast/saturation via `ctx.filter`): MODERATE.
  - Full multi-layer stack with blend modes: LARGER — defer; v1 = source +
    mask + adjustments is enough for the RefMod prep flow (crop to the face).
Modular: cleanly — op-stack data model, tile component, modal editor, and
edge overlay are four independent modules.

**Open questions.** Where does the always-visible queue live if the bottom
bar is fully context-sensitive? (Our research rule: a queue that fails
silently is worse than no queue — candidates: persistent sliver in the bar,
floating queue panel, or queue-in-bar-when-generating.) Does transport
(playback) also live in the context bar, or in a program-monitor tile on
canvas? Do op chips on the tile open inline quick-controls, or is the modal
the only editor (v1: modal-only keeps it simple)? What happens to a node's
tile preview while its modal is open (live-update or frozen)?

---

## Parked (not yet discussed)

- Latent-truth legibility in tiles (context blocks under previews; when visible).
- Workspace preset set (Generate/Edit/Prep/Graph/Library?).
- Timeline: projection vs permanent resident.
- Engine views dissolving into generators-as-ops.
- One canvas per project vs regions.
- Screen-size adaptation for floating panels.
- Command palette scope.
- The "Focus" primitive (selection → named reusable conditioning target).
