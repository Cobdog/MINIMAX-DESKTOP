# H3 Image Workbench v1 — spec (r2, post-blind-audit)

Status: **BLESSED + BUILT.** (Status corrected 2026-09-19, conformance audit u7rxi2e —
this line had read "DRAFT r2 … awaiting maintainer blessing" since the spec was written;
the blessing landed the same day: task jvcrud2 closed as "spec + blind audit + blessing
(the twelve decisions are locked)", and the build shipped as commit 028e392 / PR #12
"the blessed spec r2 complete", task k9vu6t0.) r2 = blind-audit findings applied
(comment 5s9qnjy on jvcrud2) + the decision-6 amendment. Written 2026-09-18 by the lead.
Inputs: the twelve locked decisions + the refine amendment (jvcrud2 record) ·
research (h3-image-workbench.md, burst-frame-enhancement.md, h3-instruction-based-editing.md
§4) · app assets (poserig, libraries, identity payloads, form-adapter, Krea 2 edit
families, ContactSheet/turnaround, takes). Where this doc and the Flux record disagree,
the Flux record wins.

## 0.1 Decision record (normative summary — full text on jvcrud2)

The twelve question-round decisions (2026-09-18) + one amendment, as implemented here:
(1) dedicated route + canvas handoffs; (2) packets default, T=1 Fast; (3) auto-per-role
transports + expert override; (4) 9 native slots, beyond-9 = RefMod bundling — the
maintainer: "2 refmods are likely the preferred route if more than 9 references are
needed, not sure how good semantic overflow even is" — semantic overflow demoted to
expert-experimental; (5) global Keep dial + per-picture overrides; (6)~~auto on T=1~~
**AMENDED: refine always opt-in, never automatic** ("sometimes it might be good enough
as is"); (7) takes + scored-best + manual override + directed 39f profiles in v1 + the
burst lane; (8) 2 LoRA slots + ceiling guidance, form-adapter first; (9) RefMod-shaped
slots now; (10) hybrid via runtime loader; (11) xlfl0iv absorbed; (12) E-IW1 deferred.

## 0. What this is

The image surface of the studio: **compose, edit, and refine images on H3**, then hand
them to video as start frames. One dedicated surface (the dataset-manager precedent),
both generation paths (frame-packets default, T=1 Fast), the full edit taxonomy,
refmod+LoRA stacking, candidate picking with burst enhancement, and an optional
refinement stage.

North star: **dial in a strong start frame** — remix, merge, and combine many images
into one; edit it (face, background, pose, outfit, lighting); sharpen it; send it to
video.

**Non-goals (v1):** pixel inpainting (edits are semantic regeneration); quadruped pose
mirroring (E-IW1 deferred); semantic-only ref overflow (expert-experimental); the RefMod
FACTORY (slots ready; creation is H8's task); video editing; **beyond-9 composition as a
working feature** — with the factory stubbed, v1 is honestly hard-9 with curation
guidance (the bundling path lands with H8).

## 1. The modes and their graph families

Five modes, one surface. **Every family is a small targeted graph** (Identity Edit
doctrine) pinned in the optimization-registry discipline (factory + golden snapshots +
availability gating with install guidance):

| Family | Graph shape (normative pins) |
|---|---|
| Generate-packet | Anchored 5/9/13-frame packet on the hybrid profile (runtime loader; else stock with the first-frame-or-refs limitation surfaced). Directed profiles: 39-frame settle, tail-frame preference 34–38 |
| Generate-T=1 (Fast) | Mamad8 image VAE (`minimax_h3_t1_image_vae_step1597`) + the researched recipe pins: hybrid b25-49, FL2VA 8-step turbo @0.75, detail adapter @0.5, er_sde/sgm_uniform 8 steps, shifts 12/3 |
| Compose | REF2VA ordered refs (≤9) with per-ref role+transport; preservation contracts generated per ref |
| Edit-* (identity / background / outfit / lighting / pose / freeform) | Per-family targeted graph: semantic pose-reference for pose (poserig renders as refs), native-transport subject anchoring for identity, per-family preservation-contract templates; Keep dial → contract text |
| Refine-Krea2 / Refine-klein | The Krea 2 edit-refine graph (measured 6× preservation) / klein fast tier; tone-lock frequency blend as a separate app-side op-stack op |
| Burst-fuse (gated) | App-side robust frequency merge (flow-gated drift, never-worse-than-target fallback); SeedVR2 3B path behind E-IW2 + freed-state residency |
| Exit | FL2VA frame-latent anchor into a chain (consent-gated seed) |

## 2. Surface, data flow, and object model

- Dedicated route (the `?datasets=1` precedent); canvas handoffs both ways
  (pin in media/library/takes; outputs land as canvas media objects + offerable chain
  inputs; all consent-gated).
- **Data flow:** workbench session (a document-store object) → generation job →
  **ONE take per generation whose artifacts are the N packet frames** (5–39 frames as
  frame artifacts inside a single take — NOT N takes: no canonical pollution, and the
  packet evicts/exports as one unit) → canonical pick (a pointer within the take) →
  optional Refine op (new take, provenance-linked) → optional burst-fuse op (same) →
  Exit handoff. Provenance at every hop: inputs, refs+roles+transports, LoRAs+strengths,
  path profile, seeds, scorer verdict.
- **Eviction/burst interplay:** the packet is one evictable unit; burst-fuse reads
  within its own take's artifacts (always resident while the take is canonical) — no
  cross-take residency dependency.
- **The pick surface is the TAKE STRIP** (the canvas's existing take strip renders the
  frame artifacts); ContactSheet remains what it is — the five-view turnaround generator
  — and is NOT the pick surface (audit correction).

## 3. The reference model

- **9 native slots** (REF2VA cap), ordered, each with a **role** (subject / pose /
  style / lighting / background / freeform — user-assigned, with smart defaults from the
  pin source: library kind, poserig output → pose, etc.) and a **transport**.
- **Transport = auto-per-role + expert per-slot override**: native for identity/subject;
  semantic for pose/style/lighting.
- **Slots are RefMod-shaped from day one:** `slot = raw image | RefMod file | poserig
  render`. Without H8 the RefMod slot type reads existing refmod FILES (community
  format) but cannot create them — honest labeling.
- **Beyond 9 in v1: not available** — the surface states "9 native refs; more requires
  RefMod bundling (coming with the RefMod factory)" and offers curation guidance.
  Semantic overflow stays an expert toggle, default off, labeled experimental.
- **2 RefMod slots pair with the 9 raw slots** when H8 lands (the maintainer's preferred
  shape, recorded verbatim in §0.1).

## 4. Path profiles + engine discipline

- **Packets default** (5/9/13 + directed 39); **T=1 Fast** (Mamad8 VAE, auto-labeled
  "fast, structurally soft").
- **The Mamad8 VAE is pinned to T=1 profiles at the graph-factory level**: any
  video-frame-count graph referencing it is a factory validation error (the
  never-in-video-graphs constraint is enforced, not documented).
- **Hybrid via runtime loader** (scottmudge-style; merge at load, one mmap, no
  duplicated files); availability-gated with install guidance when absent.
- **VRAM staging (24GB discipline):** stages never run concurrently — Generate →
  `/free` → (Refine | Burst-fuse) → `/free` → Exit; SeedVR2 loads only into a freed
  state (the burst research's own caveat); the hybrid profile + one refine engine fits;
  the residency matrix is part of each family's availability computation.

## 5. The Keep dial (preservation)

- One global **"Keep unspecified traits"** dial (source_fidelity semantics: 0.50–0.60
  for large pose/composition moves) + optional **per-picture overrides**.
- Preservation contract text is GENERATED from dial + assignments (the packs'
  `<Picture N>` scoping) — never hand-written.

## 6. LoRA + RefMod stacking

- **2 LoRA slots per family** with combined-strength guidance surfaced (≤ ~0.80–0.90
  healthy; ≥ ~1.05 collapse risk) — guidance, not enforcement.
- **Form-adapter always first** (cross-form safety).
- **RefMod strength** = blur-latent blend, order-invariant, per-slot dial.

## 7. Candidates, scoring, and burst enhancement

- A generation's frames land as ONE take's artifacts; **the take strip is the pick
  surface**; **scored-best becomes the canonical frame pointer automatically**.
- **The scorer is first-party and deterministic** (audit B1 fix): a candidate-scorer op
  ranking frames by Laplacian sharpness + CLIP similarity to the prompt/ref roles —
  the E-IW2 metric set, no new dependencies; heuristic, always overridable, verdict
  recorded in provenance. (ethanfel's decoder-scorer nodes may later ride the
  node-pack lane; not required.)
- **Burst lane** (research GO, **gated on E-IW2**): consensus fusion via the app-side
  frequency merge; SeedVR2 3B as the heavy arm (Apache-2.0, 4n+1 contract matches
  packet tiers). UI ships the lane behind availability+experiment flags; defaults only
  if E-IW2 proves them; **never-worse-than-target is the hard fallback** in every arm.

## 8. Refine (always opt-in)

- **Never automatic** (decision-6 amendment): every output stands as-is; T=1 outputs
  present a prominent one-tap Refine affordance; the user decides.
- **Engine pairing surfaced at the affordance:** klein = the fast tier (the one-tap
  default suggestion), Krea 2 = quality (measured 6× preservation). If the refine
  engine is unavailable, the affordance says so (availability gating) and silently
  disappears from chains — never a silent skip mid-flow.
- Qwen-IE 2511 watch-item (catalog-gated if ever).

## 9. Start-frame exit

- Any output → **FL2VA frame-latent anchoring** into a new/existing chain
  (consent-gated). The hybrid both-at-once profile makes first-frame+refs work
  simultaneously; its absence is named in the UI when relevant (gating with guidance).

## 10. Provisioning (weights AND nodes — audit fix)

Every dependency gets a lane: **first-party** (we implement: the scorer op, the
frequency-merge fuse, the tone-lock op, the runtime-loader profile), **vendored**
license-clean (form-adapter — already ours; numz SeedVR2 nodes — Apache-2.0, vendored
at E-IW2 GO), **user-fetch** (restrictive-or-unverified: any ethanfel-pack adoption,
SeedVR2 weights via the origin-gated catalog consent), **provisioned-on-box** (Mamad8
VAE → consolidate to the central home at build; hybrid stock weights already home).
The fetcher's node-packs catalog group is the delivery mechanism for fetch-lane nodes.

## 11. Acceptance criteria (build gates)

1. Both paths generate end-to-end (packets incl. directed profiles; T=1 Fast), one
   take per generation with N frame artifacts + full provenance.
2. Compose handles 9 ordered refs with roles+transports (auto-per-role + override);
   beyond-9 states the honest v1 limitation + guidance; semantic overflow expert-only.
3. Every edit family ships its targeted graph with the Keep dial + per-picture
   overrides; contracts generated, never hand-written.
4. 2 LoRA slots + guidance + form-adapter-first on every applicable graph.
5. Candidates: frame artifacts on one take, take-strip picking, first-party scorer
   auto-picks with recorded verdict + manual override; burst lane gated on E-IW2 with
   the never-worse fallback.
6. Refine always opt-in (one-tap affordance on T=1; klein suggested / Krea 2 quality;
   unavailable engines say so); tone-lock as an op.
7. The exit produces a real frame-latent-anchored chain continuation; hybrid gating
   honest.
8. The Mamad8 VAE cannot appear in any video graph (factory-level test); outputs never
   mutate inputs; all handoffs consent-gated.
9. VRAM staging proven: stage transitions free the previous engine (testable seam);
   no OOM in the family matrix at 24GB.
10. Full gate + e2e + vision + both CI legs, the house standard.

## 12. Open items

- **E-IW2** gates burst defaults (GPU-window queue); **E-IW1** deferred to v1.x.
- Mamad8 VAE consolidation to the central home; SeedVR2 catalog entry at E-IW2 GO.
- The semantic-overflow experimental toggle needs evidence before promotion.
- H8 (RefMod factory) unlocks beyond-9 bundling + the 2-RefMod-slot pairing.
