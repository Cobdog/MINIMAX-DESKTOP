# Canvas UI v1 — specification (DRAFT v0.2)

**Status:** DRAFT — section-by-section review with the maintainer. Flux task
0rtwaj4. v0.2 = post blind-adversarial-audit revision (Flux m2sdz9r): all
findings applied — union ledger rebuilt, budget numbers marked PROPOSAL,
inheritance line corrected, structural homes reserved for previously unhoused
scope. Written against: the LOCK register in `docs/research/ui-pre-brainstorm.md`,
`docs/research/ui-inventory-and-migration-map.md`, Items 3–4 (forming), the
research corpus under `docs/research/`, and the Flux decision records. The
document-model schema (Flux o0xw49r) is co-designed with this spec.

---

## 1. Vision & north star (DRAFTED — for review)

The app is a **video canvas**: one infinite surface per project where media,
generations, and plans live as first-class objects, and **every edit is an op
in a stack** on the object it changes. There is no mode switching, no
navigation-to-capability, no document-type dialog — *the app is already the
app*, and the empty canvas is the launcher.

**North star (maintainer, verbatim, 2026-09-14):** "Iteration needs to be fast
and frictionless. Ideas need to be able to be worked on without bottlenecking
on UI and UX."

**Operationalized — the interaction budget.** The lock mandates that every
common action gets a budget from intent to running job; exceeding it is a
design bug. The NUMBERS below are assistant PROPOSALS, unblessed — each is
confirmed or amended when its section lands:

| Action | Proposed budget | Status |
|---|---|---|
| Empty canvas → first generation running | ≤ 3 interactions | PROPOSAL |
| Any selection → generate/refine on it | ≤ 2 | PROPOSAL |
| Open any tool/inspector | ≤ 2 | PROPOSAL |
| Find any object (palette/search) | ≤ 3 | PROPOSAL |
| Fork a chain | ≤ 2 | PROPOSAL |
| Rerun a stale chain | 1 | PROPOSAL |
| Summon queue index / any projection | ≤ 2 | PROPOSAL |

Note: rows 3, 4, 7 extend the north star's unit ("intent → running job") to
tool/inspection actions generally — itself a proposal requiring maintainer
confirmation.

**The inheritance line (corrected per audit):** clean slate means a new SHELL
— launcher, navigation model, attention surfaces, per-engine destination views
(§5.4, pending ledger closure) — while the app's capability survives via
absorb-or-keep: of the inventory's 72 rows, 28 re-home into the canvas model,
29 survive shell-free as infrastructure, and only 3 (the nav model itself) are
removed. Migration is **re-homing + unwinding singleton state**, not rewriting
capability. The spec's job: define the new shell precisely and name the
landing spot for every absorbed capability.

**Design principles (each traceable to a lock or recorded research finding):**
1. State lives with its objects; tools come to your attention. You never
   travel to state. (Spatial-queue lock; ComfyUI-pain elimination.)
2. Everything seen is a projection of the document (chains/forks/takes);
   edits are ops in stacks; sources are never silently altered. (Item 2 +
   takes/fork locks.)
3. Relationships are authored by selection, visualized for free — never
   hand-wired. (Item 2; binding-without-wiring proven in-app.)
4. **A queue that fails silently is worse than no queue** (the UX research's
   strongest rule). Failure contract: (a) failure state is durable ON the
   object until dismissed; (b) off-screen events ping the radar; (c) the
   empty-canvas seed tile carries first-generation state. The summonable
   index is the management layer, not part of the contract.
5. Iteration is consensual: locks gate propagation; staleness is visible;
   reruns are one gesture. (Fork-semantics lock; build-system-with-consent-
   gates framing.)
6. Everything saved, always. (Multi-canvas session lock.)
7. Curation is celebrated; takes are compared in context; operate→settings
   runs immediately and adjusts. (The two research steal patterns — Auditions
   and Operate→Settings — added per audit M9.)

---

## 2. Document model (CO-DRAFTING with schema spec o0xw49r — stub)

Covers: chains; forks as output→input references (incl. multi-ref, substrate
choice, lock state; multi-substrate-fork allowance = ledger row); append-only
takes with canonical-pointer supersession; op stacks with settings-results
separation; control tracks; persisted staleness; **plan documents** (Director
Suite §6); **keyframe guides as chain settings** (inventory Q7 — AddGuide
params with validation semantics must survive in the model); **asset
reference-sets vs takes alignment** (inventory Q8 — one model, not two);
**macro/chain-template records** (inventory Q6 — same machinery serves
Director-Suite shot emission); sessions (open canvases, camera positions,
always-autosave); blob discipline (media + latents on disk, references in
DB); FTS surfaces (palette, index).

## 3. Canvas surface architecture (stub)

Substrate: DOM + CSS transforms, d3-zoom camera applied via rAF (store
outside React), viewport+margin culling + content-visibility; semantic-zoom
bands (far → thumbnail + status ring; near → metadata, op chips, latent
blocks — visibility per ledger row); tile anatomy; derived SVG edges culled
to viewport; endpoint objects + typed-hole option menus (**availability-aware
option lists** — per-graph gating + install guidance per t8u00uu/ul1l4j7);
floating panels (react-rnd) + focus semantics.
**Navigation & auto-placement (per audit M7):** zoom-to-attention on every
needs-attention affordance; camera bookmarks; overview/minimap as the
far-zoom projection; zoom-to-fit; search; adjacency placement of new
artifacts near parents.

## 4. Entry moment & attention model (stub)

Empty-canvas launcher (prompt bar, drop-anything, minimal chips — set
confirmed against the proven intents per inventory Q10, resume cards →
multi-canvas session); spatial per-job state (failure contract §1.4, seed
tile); titlebar radar (aggregate; click = zoom-to-attention); summonable
index; contextual bottom-bar contexts (not "modes"); **notice-routing
policy** (inventory Q9: what is durable-on-object vs radar vs ambient toast
— absorbed flows must stop toast-spamming on-canvas state).

## 5. Tool families (stubs)

- **5.1 Modal editor + op stacks** (Item 2 v1: crop + rotate + brush mask +
  ctx.filter adjustments; ImageCrop data is the first op; live-update vs
  frozen = ledger row; inline chips vs modal-only = ledger row).
- **5.2 Control-input tool family** (epic 66xhflw): create control inputs
  (canny/depth/HED/MLSD/pose/mask) from media or scratch, all-or-selected;
  the **IK pose rig** (2.5D three.js viewport, palette-exact renderer);
  non-human skeletons pending E-FC1; trajectory-plan UI pending E-MD1.
- **5.3 Camera editor** (locked placement: canvas-phase component; compiler
  port is ecosystem work — Flux ving89w split question in the maintainer
  review list).
- **5.4 Engines-as-ops** (engines are op choices, not destinations —
  **pending ledger closure**, row L4).
- **5.5 Prompt surfaces**: SmartPromptEditor as the universal prompt field
  (seed node, ops, copilot); prompt-library placement = ledger row.

## 6. Director Suite (stub — Item 4)

Timeline as summonable projection over the chain DAG; plan documents (the
MoviePlanner inheritance); segments map to chains; gaps = transition seats
(model-generated = multi-input forks; NLE = export-time ops); references
handed per segment; camera editor as a segment tool (§5.3); **export/
assembly surface home** (inventory Q4 — project-level op vs summoned
assembly view = ledger row).

## 7. Keyboard map (stub — inventory Q2)

The full canvas shortcut map, written in-spec: prototypes' base (J/K cycle,
B branch, P pin, R rerun, V projection flip, Space play, ←/→ scrub, digits
jump-to-take, Escape deselect) + launcher focus, palette summon, camera
bookmarks; Blender's "shortcuts printed on affordances" rule (`Kbd` pattern
already prototyped). Gates the e2e rewrite.

## 8. Migration phases (stub — from inventory §3)

Six phases behind `?canvas=1` (the proven `?proto=` route pattern); hard
ordering dependencies (Settings-first-run, queue-synthesis-as-a-unit,
flows-before-CreateView-retires); e2e/vision coverage transitions per phase.

## 9. Parked-questions ledger — RECONCILED UNION (per audit L1)

Every known-open question from both sources, each tagged with its home
section. Closed when the maintainer decides; deferred rows need rationale.

| # | Question | Home | Recommendation (assistant, proposal only) | Status |
|---|---|---|---|---|
| L1 | Playback transport home | §3/§5 | playing = temporary tile state + contextual transport; program-monitor tile v1.5 (pooling exclusivity argues object-state — inventory Q3) | OPEN |
| L2 | Workspace presets | §3 | defer v1; saved layouts after multi-canvas session ships | OPEN |
| L3 | Modal live-update vs frozen tile | §5.1 | live-update (honest projection) | OPEN |
| L4 | **Engine views dissolve into generators-as-ops** | §5.4 | yes — selection decides engine surface (t2v/i2v/frames/ref2v already one flow in-app) | **OPEN — needs explicit closure** |
| L5 | Screen-size adaptation | §3 | desktop-first; collapse threshold TBD (not pre-decided) | OPEN |
| L6 | Command palette scope | §7 | actions + objects + ops; prompt-content search rides FTS but is not the palette's primary role | OPEN |
| L7 | Focus primitive (selection → named reusable conditioning target; may be subsumed by output-substrate selection) | §5.1 | defer decision until §5.1 + substrate-selector co-design | OPEN |
| L8 | Inline op-chip controls vs modal-only v1 | §5.1 | modal-only v1 | OPEN |
| L9 | Latent-block visibility in tiles | §3 | zoom-band-gated (semantic zoom answer); confirm | OPEN |
| L10 | Mobile companion fate | §8 | out of v1 scope; keep booting, mark unmaintained; thin-remote redesign later | OPEN |
| L11 | Prompt-library placement | §5.5 | both: launcher-adjacent browser + properties insert source; attribution footer follows | OPEN |
| L12 | Macro/chain-template concept naming + surface | §2/§6 | recorded chains, inspectable; same machinery as Director emission | OPEN |
| L13 | Asset reference-sets vs takes — one model | §2 | unify on takes (append-only + canonical pointer); curated sets become per-asset takes | OPEN |
| L14 | Notice-routing policy | §4 | durable-on-object for failures; radar for aggregates; toasts only for ambient | OPEN |
| L15 | Chip set confirmation (against proven intents + drop) | §4 | confirm against: image prompt / video prompt / noDialogue handoffs + drop-media | OPEN |
| L16 | Export/assembly surface home | §6 | project-level export op + summoned assembly projection (both, roles split) | OPEN |
| L17 | Multi-substrate forks allowed in v1 | §2 | yes (trivial in the model); confirm | OPEN |
| L18 | Seed input-node visibility once populated | §3 | stays visible as chain head (identity + "why this exists") | OPEN |
| L19 | Option-menu ranking (generation vs utility ops) | §3 | recency + type-naturalness, category visible | OPEN |
| L20 | Backwards-authoring v1 scope | §3 | "what can extend/produce this" only; target-seeking later | OPEN |
| L21 | Lock granularity confirmation | §2 | chain-level (assumed from maintainer phrasing; uncontradicted) | OPEN-confirm |
| L22 | "Decompose an output" v1 primitive | §5.1 | frame-extraction v1 (one candidate); shot-split/latent-split later | OPEN |
| L23 | Budget-unit extension (tool/find/summon rows) | §1 | extend as proposed | OPEN |
| L24 | Floating-inspector behavior | §3/§5 | floats freely, follows selection optionally | OPEN |

## 10. Acceptance (how this spec completes)

Every section individually blessed; **§9 ledger complete against BOTH sources
(the pre-brainstorm parked list and the inventory's ten) — verified by
enumeration, not assertion**; every row closed or explicitly deferred with
rationale; the interaction-budget table confirmed per section; migration
phases verified against the inventory's dependency register; the schema spec
(o0xw49r) reviewed in the same window so model and surface never contradict.
Build tasks are then cut from this spec under epic vbrstja.
