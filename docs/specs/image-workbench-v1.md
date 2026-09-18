# H3 Image Workbench v1 — spec

Status: DRAFT for blind audit → maintainer blessing. Written 2026-09-18 by the lead.
Inputs: the twelve locked decisions (jvcrud2 directive 67fb9dac, question round 2026-09-18) ·
research (docs/research/h3-image-workbench.md + burst-frame-enhancement.md) · the foundation
editing research (h3-instruction-based-editing.md §4) · app assets (poserig, libraries,
identity payloads, form-adapter, Krea 2 edit families, ContactSheet, takes). Where this doc
and the Flux record disagree, the Flux record wins.

## 0. What this is

The image surface of the studio: **compose, edit, and refine images on H3**, then hand them
to video as start frames. One dedicated surface (the dataset-manager precedent), both
generation paths (frame-packets default, T=1 Fast), the full edit taxonomy, refmod+LoRA
stacking, candidate picking with burst enhancement, and a refinement stage that answers
T=1's softness ceiling.

North star: **dial in a strong start frame** — remix, merge, and combine many images into
one; edit it (face, background, pose, outfit, lighting); sharpen it; send it to video.

**Non-goals (v1):** pixel inpainting (edits are semantic regeneration — the community's
line, adopted); quadruped pose mirroring (E-IW1 deferred); semantic-only ref overflow
(demoted to experimental per the maintainer's skepticism); the RefMod FACTORY (slots are
ready; creation is H8's own task); video editing of any kind.

## 1. The modes

Five modes, one surface, small targeted graphs per family (the Identity Edit doctrine):

1. **Generate** — text (+ optional refs) → image. Packets default; T=1 Fast. Absorbs the
   start-frame factory's core (xlfl0iv, closed).
2. **Compose** — many images → one. Up to 9 ordered native refs with per-ref roles; the
   consolidation patterns (research lane A): single-shot merge, iterative refine-merge,
   candidate-score-pick (takes + ContactSheet). The hybrid-face averaging trap is surfaced
   as guidance when merging toward one subject.
3. **Edit** — the taxonomy families, each a targeted graph: identity/face, background
   swap, outfit, lighting, pose (semantic pose-reference; the poserig's DWPose/AP-10K
   renders enter as refs), "you name it" (freeform instruction with preservation
   contracts). Preservation = the Keep dial.
4. **Refine** — the enhancement stage (§8).
5. **Start-frame exit** — hand any output to video (§9).

## 2. Surface + navigation

- A dedicated route (the `?datasets=1` precedent — `?images=1` class), full-surface
  workbench: big preview canvas, the ref strip, mode rail, candidate strip. NOT a dock or
  modal (decision 1).
- **Canvas handoffs both ways:** pin canvas media / library assets / takes into workbench
  slots; every workbench output lands as a canvas media object AND is offerable as a chain
  start frame / op-stack input. Consent-gated actions only (the MoviePlanner-seeding
  pattern).
- The workbench session is a document-store object; outputs are takes-shaped records with
  full provenance (inputs, refs+roles, LoRAs, path profile, seeds).

## 3. The reference model

- **9 native slots** (REF2VA cap), ordered, each with a **role** (subject / pose / style /
  lighting / background / freeform) and a **transport**.
- **Transport = auto-per-role with expert per-slot override** (decision 3): native for
  identity/subject refs; semantic for pose/style/lighting (the researched best per role).
- **Slots are RefMod-shaped from day one** (decision 9): `slot = raw image | RefMod file |
  poserig render`. The RefMod factory plugs in later without a slot-model refactor.
- **Beyond 9 → RefMod bundling** (decision 4): character sheets and big ref sets collapse
  into refmods (2 refmods the maintainer's preferred overflow route), NOT the unbounded
  semantic stack — that stays an expert/experimental toggle with honest labeling
  (unproven quality), off by default.
- Global ref budget surface: slots show their role+transport+origin at a glance.

## 4. Path profiles

- **Packets default everywhere** (decision 2): 5/9/13-frame anchored packets (+ **directed
  39-frame settle profiles in v1** for re-pose/character-swap — decision 7 — scoring tail
  frames 34–38). The packet is ONE generation; frames land as candidates (§7).
- **T=1 Fast profile**: the Mamad8 image VAE (on-box at the canonical install; consolidate
  to the central home at build) + auto-Refine (§8). Labeled honestly: fast, structurally
  soft.
- **Hybrid via runtime loader** (decision 10): the scottmudge-style loader profile merges
  FL2VA+REF2VA at load (one mmap, no duplicated multi-GB files) — required for the
  both-at-once start-frame exit (stock H3 silently drops first-frame-or-refs) and wired
  as an engine-profile option, availability-gated with install guidance.

## 5. The Keep dial (preservation)

- One **global "Keep unspecified traits" dial** per edit (source_fidelity semantics:
  0.50–0.60 for large pose/composition moves) — decision 5.
- Optional **per-picture overrides** on multi-ref compositions when precision matters.
- The preservation contract text is generated from the dial + per-picture assignments
  (the packs' `<Picture N>` scoping); never raw prompt text the user must hand-write.

## 6. LoRA + RefMod stacking

- **2 LoRA slots per family** (decision 8) with **combined-strength guidance surfaced**
  (healthy ≤ ~0.80–0.90 combined; collapse risk ≥ ~1.05) — guidance, not enforcement.
- **Form-adapter always applied first** (cross-form safety, the committed node).
- **RefMod strength** = the blur-latent blend, order-invariant, dialed per slot.

## 7. Candidates + burst enhancement

- Packet frames **land as takes** on the workbench output (5–39 per generation);
  **scored-best becomes canonical automatically**; **ContactSheet is the manual override**
  (decision 7). Directed profiles auto-prefer their scored tail frames.
- **Burst enhancement lane** (the maintainer's addition, research GO): the picked frame
  can be enhanced by fusing its packet neighbors — **consensus fusion** (borrow real
  detail from sharper frames; ceiling = the best frame in the packet; never-worse-than-
  target fallback). Two enhancers: the **app-side robust frequency merge** (flow-gated
  drift, fidelity-first, weightless) and **SeedVR2 3B** (Apache-2.0, official ComfyUI
  nodes, 3B FP16 fits 24GB, 4n+1 frame contract matching H3's packet tiers natively).
  **Gated on E-IW2** (the drift-census + 4-arm A/B, queued to the GPU window): the UI
  ships the lane behind availability+experiment flags; defaults land only if E-IW2
  proves them.

## 8. Refine

- **Auto-run on T=1 outputs; opt-in per chain on packets** (decision 6).
- **Default engine Krea 2** (measured 6× preservation on edits); **klein as the fast
  tier**; Qwen-IE 2511 a watch-item (catalog-gated if ever added).
- The **tone-lock frequency blend is an app-side op-stack op** (composable,
  engine-agnostic), not baked into refine graphs.
- Engine-pluggable: the refine stage is a registry entry (the optimization-registry
  pattern), so E-IW2 winners slot in without surface changes.

## 9. Start-frame exit

- Any output → **FL2VA frame-latent anchoring** into a new or existing chain
  (consent-gated seed, the established pattern).
- The **hybrid both-at-once profile** (§4) makes first-frame+refs work simultaneously —
  the stock-model silent drop is named in the UI when the hybrid profile is absent
  (availability gating with guidance).

## 10. Integration map

- **Libraries**: characters/wardrobe/locations pin into slots from their studios
  (StudiosDock data, same asset model).
- **Poserig**: AP-10K/DWPose renders are first-class pose-slot inputs (pose mirroring for
  humans; quadruped waits on E-IW1).
- **Identity payloads**: the strength-dial machinery rides into edit family defaults.
- **Form-adapter node**: applied first on every LoRA-bearing graph.
- **Canvas**: outputs land as media objects; op stacks can consume them; the exit seeds
  chains. **ContactSheet**: the candidate-pick surface.
- **Fetcher/consent**: every new weight (SeedVR2, hybrid-profile needs) resolves through
  the catalog with the origin-gated consent flow; availability guidance on every gated
  surface.

## 11. Acceptance criteria (build gates)

1. Both paths generate end-to-end through the app (packets incl. directed profiles; T=1
   Fast with the Mamad8 VAE), takes land with full provenance.
2. Compose handles 9 ordered refs with roles+transports (auto-per-role + override);
   beyond-9 routes to RefMod bundling (with the factory stubbed, the path is honest about
   what's possible today); semantic overflow stays expert-only.
3. Every edit family ships as its targeted graph with the Keep dial + per-picture
   overrides; preservation contracts are generated, never hand-written.
4. 2 LoRA slots + guidance + form-adapter-first on every applicable graph.
5. Candidates: takes land, scored-best canonical, ContactSheet override; the burst lane
   renders behind its gate with honest labels; the app-side fuse runs locally if E-IW2
   approves it.
6. Refine: auto-on-T=1 / opt-in-packets; Krea 2 default, klein tier; tone-lock as an op.
7. The start-frame exit produces a real chain continuation (frame-latent anchored), with
   the hybrid profile availability-gated.
8. Byte-level: workbench outputs never mutate inputs; all handoffs consent-gated.
9. Full gate + e2e + vision + both CI legs, the house standard.

## 12. Open items

- **E-IW2** (burst A/B) gates the enhancement defaults — queued to the GPU window.
- **E-IW1** (quadruped pose) deferred with the spec recording it as v1.x.
- Mamad8 T=1 VAE consolidation to the central home at build time.
- SeedVR2 catalog entry + consent flow at build time (if E-IW2 GO holds).
- The semantic-overflow experimental toggle needs its own evidence before promotion.
