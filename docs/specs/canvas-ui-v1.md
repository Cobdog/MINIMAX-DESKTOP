# Canvas UI v1 — specification (BLESSED 2026-09-15)

**Status:** **BLESSED §1–§10 by the maintainer (2026-09-15, via structured
Q&A): both ledger bundles accepted wholesale (21 rows DECIDED as
recommended); build tasks are cut from this spec and Phases 0–2 begin.
Section-level amendment rights retained throughout the build — the blessing
starts the work, it does not freeze the doc.** Prior status: DRAFT v0.2.2
through three adversarial audits (m2sdz9r, 2zkir0u, 5hkenmv — all findings
applied). Companion: docs/specs/canvas-document-model.md. Flux: 0rtwaj4.

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

**The inheritance line (v0.2.1 — SEED class restored, L4-dependence made
explicit):** clean slate means a new SHELL — launcher, navigation model,
attention surfaces — replacing, among other things, the per-engine destination
views **if and only if ledger row L4 closes yes** (engines-as-ops). The app's
capability survives through three channels, closing the inventory's full 72
rows: **28 REFACTOR-ABSORB** (re-home into the canvas model), **29 KEEP**
(survive shell-free as infrastructure), **12 SEED** (become explicit inputs to
the new build — the substrate, op-stack chips, projection soul, crop data,
prompt editor, filmstrip layout), and **3 REMOVE** (the nav model itself).
(Counts as of the inventory; L4's dissolve decision reclassifies the
per-engine views at migration time — the inventory remains the row-level
source of truth.) Migration is **re-homing + unwinding singleton state**, not
rewriting capability. The spec's job: define the new shell precisely and name
the landing spot for every absorbed capability.

**Design principles (each traceable to a lock or recorded research finding):**
1. State lives with its objects; tools come to your attention. You never
   travel to state. (Spatial-queue lock; ComfyUI-pain elimination.)
2. Everything seen is a projection of the document (chains/forks/takes);
   edits are ops in stacks; sources are never silently altered. (Item 2 +
   takes/fork locks.)
3. Relationships are authored by selection, visualized for free — **no hand
   wiring in v1** (the lock names hand wiring a possible LATER feature, not a
   v1 one). (Item 2; binding-without-wiring proven in-app.)
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
   runs immediately and adjusts — **scoped to unlocked working contexts**:
   locked chains and downstream propagation remain consent-gated per
   principle 5. (The two research steal patterns — Auditions and
   Operate→Settings — added per first-audit M9; scoping per second-audit S6.)

---

## 2. Document model (DRAFTED — for review; co-designed with docs/specs/canvas-document-model.md)

The document IS the graph of chains; every view — canvas, timeline, library,
queue index — is a projection of it. The model below defines entities and
invariants; the schema spec defines tables, migrations, and FTS.

### 2.1 Entities

- **Project** (= one canvas): id, name, `schemaVersion`, camera state
  (position/zoom — autosaved always), `deletedAt` tombstone. Projects are the
  unit of open/close/sessions/export (L32).
- **Session**: the multi-canvas shell state — open project ids + order,
  active canvas. Survives restarts.
- **Chain**: id, projectId, input spec, op-stack reference, settings blob,
  lock state, `hopCount`, per-hop drift metrics (F1 decided: drift is a
  first-class column, not a UI guess). Kinds: media / generation / plan-emitted.
- **Input spec** (the Item-3 recursion): `fresh {prompt | media}` |
  `outputRef {outputId, substrate}` | `outputRefs[]` (multi — transitions,
  L17 open-confirmed). Substrate: latents | decoded | crop/mask projection |
  extracted frame | audio stem.
- **Output** (the fork take-off): id, chainId, available substrates.
- **Take**: append-only generation result (job ref, artifact paths, latent
  path, metrics, createdAt) + `supersededBy` pointer. Canonical take =
  pointer switch (F5/takes decision); nothing is ever overwritten; priors
  evictable-with-marker per retention tiers, GC liveness walks fork edges.
- **Op stack**: ordered ops on a chain's source (crop, mask, trim, adjust,
  control track, stabilize). Per-op undo + reorder; bake = explicit
  irreversible marker (S10). Settings live with the op; rendered results are
  takes — the separation the registry already proves.
- **Identity payload** (decided): reference set / RefMods + verbatim subject
  text + the user-driven strength dial; re-injected into every window;
  per-RefMod slot strength composes with the chain dial.
- **Control track**: one per shot + optional inpaint mask (research-pinned).
  Keyframe guides (AddGuide params, validation semantics — inventory Q7)
  persist as chain settings.
- **Asset (global store, F3 decided)**: characters/locations/wardrobes/
  refmods live ABOVE projects; projects hold fork-into-project records
  (consent-gated copies with lineage back to the global asset). Whether
  asset reference-sets unify on the takes semantics or stay curated sets
  is **L13 — proposal (unify on takes), OPEN**.
- **Plan document** (Director Suite): the MoviePlanner inheritance — brief,
  segments→chain refs, gap transitions, per-segment reference handoffs;
  emitted chains are ordinary chains (macro records L12 = inspectable
  chain templates).
- **Job**: existing jobs table, extended: `queued-for-GPU` as a first-class
  state (L26 decided — serialize by default, one active generation).
- **Trash**: tombstones + restore for chains/canvases/projects (F5 decided);
  session-scoped prune = bulk-evict non-canonical non-locked takes.

### 2.2 Invariants (schema-enforced)

1. Settings-results separation everywhere (reruns are settings-stable).
2. Takes append-only; one canonical pointer per output; supersession never
   deletes.
3. Locks gate propagation: upstream change marks downstream stale (persisted
   derived state); nothing auto-executes.
4. GC never evicts a live-referenced take's latents (fork-edge liveness).
5. Edits are ops; sources are never silently altered (bake is explicit).
6. Every write carries schemaVersion; unknown-newer fails loudly (F9).
7. Identity payloads ride every window; strength is chain settings.
8. Jobs serialize by default; queued-for-GPU is visible object state.
9. Blob references carry content hashes; missing blobs degrade to
   placeholder + re-link flow, never silent breakage (F8 open-shaped —
   mechanics land at schema review).
10. Everything autosaved, always — including camera positions (lock 6).

### 2.3 Companion spec

`docs/specs/canvas-document-model.md` (schema spec, Flux o0xw49r): tables,
foreign keys (incl. the global-asset fork records), migrations, retention/GC
mechanics, FTS surfaces (palette, queue index, library), and the
failure-propagation semantics table (F6 — open, shaped here).

## 3. Canvas surface architecture (DRAFTED — for review)

**Substrate** (lock): DOM tiles under one CSS-transform root; **d3-zoom**
camera feeding a store-outside-React camera applied via rAF (the proven
transient discipline — 60fps pan/zoom with zero React renders); viewport +
margin culling with `content-visibility`; SVG derived-edge layer culled to
the viewport; floating panels via **react-rnd** (Base UI dialog semantics
when modal); three.js reserved for the IK-rig viewport; PixiJS held in
reserve (flip only on a measured DOM bottleneck — see the rendering budget,
L26-adjacent open measurement).

**Semantic zoom** = content swap by zoom band (the culling and LOD are one
mechanism): far = thumbnail + status ring; mid = + metadata strip + op-chip
row; near = + latent blocks (L9: zoom-gated, confirm) + drift-budget readout
+ per-take strip. The overview/minimap IS the far-zoom projection — one
document, many renderings.

**Tile anatomy** (a media node): preview surface (filmstrip/poster via the
pool), status ring (idle/queued-for-GPU/running/stale/failed-durable), op
chips (stacked, per-op undo in the modal), take strip (canonical starred,
priors visible — Auditions pattern), endpoint affordances at head/tail (the
Item-3 typed holes: click = option-space menu in the working direction).

**Derived edges**: SVG paths from fork records; read-only; direction
rendered; multi-ref edges (transitions) fan from the gap.

**Option menus (typed holes)**: type-directed filter over the op/graph
registry — **availability-aware** (per-graph gating + install guidance per
the registry/fetch-catalog machinery; adaln-form gating included). Parameter-
directed constraints (17k+5 grids, 32px multiples, ≤15s, 39f phase-exact)
surface as affordance hints inside the menu (decisions-audit refinement).
Ranking per L19.

**Navigation & auto-placement**: zoom-to-attention on every needs-attention
affordance (radar, stale badges, search results); camera bookmarks (named,
in the palette); zoom-to-fit (selection/project); FTS search (palette —
scope L6, proposal: actions/objects/ops primary); adjacency placement of new
artifacts near parents (L25 proposal). Seed input nodes stay visible as
chain heads (L18 proposal). Backwards-authoring menus offer
"what can extend/produce this" only in v1 (L20 proposal). Floating
inspectors float freely, optionally follow selection (L24 proposal).
Screen-size adaptation threshold: L5 OPEN (collapse point TBD, not
pre-decided).

**Rendering budget (F4 restored, third-audit O2) — MEASURED (L33, Phase 1)**:
the measurement task ran against the shipped Phase-1 substrate (`?canvas=1`,
d3-zoom camera, viewport+600px-margin culling, `content-visibility`) staging
100/500/1000/2000 synthetic objects (harness `?canvas=1&bench=1`, driver
`node scripts/canvas-budget.cjs`, raw data
`docs/research/canvas-rendering-budget.json`). Headless system Chromium
1920×1080 on the dev VM (software rendering — absolute fps is a FLOOR; the
scaling behavior is the signal):

| staged objects | derived edges | idle fps | drift fps (renders) | fast-pan fps (jank, renders) | zoom-sweep fps (renders) | tiles in DOM |
|---|---|---|---|---|---|---|
| 100 | 32 | 61 | 52 (8) | 56 (27%, 69) | 49 (41) | 52 |
| 500 | 136 | 61 | 49 (4) | 51 (33%, 86) | 43 (37) | 60 |
| 1000 | 303 | 61 | 57 (4) | 54 (29%, 82) | 43 (36) | 58 |
| 2000 | 612 | 61 | 54 (4) | 47 (35%, 74) | 43 (36) | 55 |

Budget verdicts (data, not preference): (1) the transient discipline holds
at scale — idle renders are 0 at every N, gentle-pan renders ≈ 0 (the 4–8
are cull-boundary straddles), and pan/zoom renders are culling-membership
and band-crossing changes only, never per-frame (e2e-asserted separately in
`e2e/canvas.spec.ts`); (2) culling keeps the DOM flat — 52–60 tiles mounted
regardless of N; (3) interactive fps stays ≥ 43 at 2000 objects even on
software rendering, so **the PixiJS flip is NOT justified at v1 scale** —
re-run the harness on target hardware when tiles carry real filmstrip
media, and flip only on a measured breach.

## 4. Entry moment & attention model (DRAFTED — for review)

**Launcher** (lock): empty canvas = prompt bar + drop-anything zone (the
drop routes itself by media kind) + minimal chips (set confirmed against the
three proven intents + drop, L15) + resume cards (the multi-canvas session —
recent projects, camera state restored). First generation spawns the seed
tile at the prompt bar (spatial-queue contract c) — the launcher comes
alive, no mode switch.

**Spatial per-job state**: progress on the objects the job touches;
failure durable-on-object until dismissed, reason attached (contract a);
queued-for-GPU = first-class on-object state (L26) — a busy day shows the
queue stacked spatially, honestly parked on its chains.

**Titlebar radar**: aggregate "N running · M queued · K needs attention";
click = zoom-to-attention on the worst item; engine chip + GPU meter live
inside it (the one fixed-chrome survival).

**Summonable index** (⌘K-class): flat list across all jobs (retry/cancel/
rerun-stale), navigates-to-region on select. FTS-backed.

**Contextual bottom bar**: 100% contextual (lock) — contexts, not modes:
nothing-selected = launcher/generation surface; media selected = transport +
op controls + properties entry; multi-select = batch gestures; chain
selected = identity payload + drift budget + fork history. Program-monitor
question (L1) remains open with the playing-as-tile-state lean.

**Notice routing** (L14): failures → durable-on-object + radar ping;
aggregates → radar; ambient info only → toast. Absorbed flows stop
toast-spamming what is now on-canvas state.

**Projections inherit the contracts** (F7): timeline, library, and any
future projection render failure/staleness/queued states and navigate via
radar — the no-silent-failure rule applies everywhere work is visible.

## 5. Tool families (DRAFTED — for review)

- **5.1 Modal editor + op stacks** (Item 2 v1): crop + rotate + brush mask +
  ctx.filter adjustments; ImageCrop's non-destructive crop data is the first
  op; VideoReferenceClipper's trim becomes the video op; per-op undo +
  reorder; bake = explicit irreversible marker. Live-update vs frozen tile =
  L3 (proposal: live-update); inline chips vs modal-only = L8 (proposal:
  modal-only v1). "Decompose an output" v1 = frame extraction (L22
  proposal). The **Focus primitive** (L7) resolves here against the output-
  substrate selector — likely subsumed.
- **5.2 Control-input tool family** (epic 66xhflw, Fun Control first-class):
  create control inputs (canny/depth/HED/MLSD/pose/mask) from media
  (server-driven preprocessors — the extraction matrix is native-core
  verified) or from scratch, all-or-selected; the **IK pose rig** — 2.5D
  three.js viewport, analytic two-bone + FABRIK spine, palette-exact DWPose
  renderer (round-trip exact by construction; client-render default,
  `__value__` server bridge as version-pinned option per E-FC0.5), preset
  pose library first, webcam mocap later; skeleton templates pluggable —
  human-134 default, AP-10K if E-FC1's arm B wins, freeform if
  topology-agnostic. **Trajectory-plan UI builds on the measured AddGuide
  path** (E-MD1, tranche 3a: positional composites at frames 0/17/34 track
  plans at 0.0–1.7% error with zero extra weights — beating the Fun Control
  sprite ceiling, which scene-roulettes; the mask variant adds +1 dB with a
  clean grid check; guides survive VDN architecture intact).
- **5.3 Camera editor** (directive b309fad7): canvas-phase component; the
  compiler port is its own task (ving89w, split decided 2026-09-14).
- **5.4 Engines-as-ops** (L4 DECIDED — dissolve): selection decides the
  surface (t2v/i2v/frames/ref2v); LTX survives as the 2.3-dev utility family
  + transitional survey builder (keep-utilities-only verdict); the general
  Ltx25Workspace retires in Phase 4; LocationStudio migrates to H3 Ref2V.
- **5.5 Prompt surfaces**: SmartPromptEditor as the universal prompt field
  (seed node, ops, copilot) — its type-directed-insertion interaction is the
  same shape as typed-hole menus (inventory seed row). Prompt-library
  placement = L11 (rec: both launcher-adjacent + properties insert).

## 6. Director Suite (DRAFTED — for review)

Timeline = summonable projection over the chain DAG; plan documents (the
MoviePlanner inheritance: brief, segments→chain refs, gap definitions,
per-segment reference handoffs); segments execute one timescale at a time
(serialized per L26); **gap menu, measured** (tranche 1): hard cut / NLE
transition / FLF-continuation splice (36 dB class — the champion) /
dip-to-black (structural, audio-friendly) / diegetic bridge (opt-in).
Identity payloads hand off per segment (E2/E3-informed). Camera editor is a
segment tool (§5.3). Export/assembly surface = L16 (rec: project-level
export op + summoned assembly projection). Plan execution failure semantics
= F6 (schema spec §5).

## 7. Keyboard map (DRAFTED base — for review)

Prototypes' proven base: J/K cycle selection, B branch/fork, P pin
(lock/unlock), R rerun-stale, V projection flip (canvas↔timeline↔library),
Space play/pause (selected tile), ←/→ scrub, digits 1–9 jump-to-take,
Escape deselect. Plus: launcher focus (global `/` or click), palette ⌘K,
camera bookmarks (⇧1–9 set / 1–9 with modifier go), modal open on selection
(Enter), op modal undo (⌘Z per-op). **Shortcuts printed on affordances**
(the `Kbd` pattern, prototyped) — every discoverable surface shows its keys.
The full table lands with §10's blessing; it gates the e2e rewrite.

## 8. Migration phases (DRAFTED — from inventory §3, confirmed)

Phase 0 foundation (document store lands beside jobs/workspace) → Phase 1
substrate + launcher + spatial queue behind `?canvas=1` → Phase 2 generation
arrives on canvas (properties panel absorbs bindings; both surfaces share
stores) → Phase 3 ops/forks/takes (then CreateView/JobsView/ClipEditor/
FrameBookmark/Library views retire behind the flag) → Phase 4 engines-as-ops
+ libraries + Settings docked (LTX workspace retires; LocationStudio
migrates) → Phase 5 Director Suite + old shell deleted (`View` union dies).
Hard dependencies D1–D7 stand as written (inventory §3), with D3 the
cardinal one: radar + on-object state + summonable index ship as a unit
before JobsView retires. e2e/vision coverage rewrites per phase before each
retirement (D6).

**Phase 3 landed (task j5sj28v, 2026-09-16):** the op modal editor ships
(§5.1 — crop/rotate/brush-mask/adjust/trim/upscale/stabilize/color-grade,
per-op undo + reorder + bake, live-update tile preview per L3, modal-only
per L8); fork semantics complete (canonical-pointer switching on the take
strip, stale propagation respecting locks, per-chain rerun gesture); the
LTX-2.3 utility family + Z-Image stills arrive as canvas surface (§5.4 —
the utilities submit through the shared core extracted from the old hook;
image intent routes to Z-Image, control via a selected image); the pose rig
docks as the control-input panel (§5.2, export → control track); and the
FIRST VIEW RETIREMENT lands: ClipEditor + VideoReferenceClipper +
FrameBookmarkStudio grey out in the old shell with the canvas pointer —
still directly navigable (their D-dependencies hold until Phase 5);
CreateView stays (the D1 dependency, Phase 4). CreateView/JobsView/Library
full retirement follows their Phase-4 capability absorbments.

## 9. Parked-questions ledger — RECONCILED UNION (per audit L1)

**[BLESSED 2026-09-15 — maintainer accepted both bundles wholesale via
structured Q&A: Bundle A (interaction: L1, L3, L8, L9, L18, L19, L20, L24)
and Bundle B (surfaces/scope: L2, L5, L6, L10, L11, L12, L14, L15, L16, L17,
L22, L23, L25) — all DECIDED as recommended below. Remaining non-decided:
L7 (Focus — deferred to §5.1 co-design per its recorded disposition), L13
(asset reference-set unification — OPEN for schema review as recorded), L33
(rendering-budget measurement task — a task, not a decision). L21 previously
RESOLVED; L26–L29 previously DECIDED; L4/L27 previously DECIDED.]**

Every known-open question from both sources, each tagged with its home
section. Closed when the maintainer decides; deferred rows need rationale.

| # | Question | Home | Recommendation (assistant, proposal only) | Status |
|---|---|---|---|---|
| L1 | Playback transport home | §3/§5 | playing = temporary tile state + contextual transport; program-monitor tile v1.5 (pooling exclusivity argues object-state — inventory Q3) | OPEN |
| L2 | Workspace presets | §3 | defer v1; saved layouts after multi-canvas session ships | OPEN |
| L3 | Modal live-update vs frozen tile | §5.1 | live-update (honest projection) | OPEN |
| L4 | **Engine views dissolve into generators-as-ops** | §5.4 | yes — selection decides engine surface (t2v/i2v/frames/ref2v already one flow in-app) | **DECIDED (maintainer via Q&A, 2026-09-14, on the LTX-vs-H3 research verdict): YES — dissolve; LTX = keep-utilities-only** (2.3-dev utility family + transitional survey builder; general workspace retires; LocationStudio migration = §8 dependency) |
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
| L21 | Lock granularity | §2 | chain-level — **RESOLVED in the register (2026-09-14, twice: takes-model block + canvases resolution); recorded here for completeness** | RESOLVED |
| L22 | "Decompose an output" v1 primitive | §5.1 | frame-extraction v1 (one candidate); shot-split/latent-split later | OPEN |
| L23 | Budget-unit extension (tool/find/summon rows) | §1 | extend as proposed | OPEN |
| L24 | Floating-inspector behavior | §3/§5 | floats freely, follows selection optionally | OPEN |
| L33 | **Rendering-performance budget** (F4 restored — third-audit O2): Stage-seed measurement task (100/500/1000/2000 objects; fps, interaction latency, scroll budgets) → §3's budget table → DOM/Pixi flip decided by data | §3 | run at Phase 0/1; the substrate lock's escape hatch is untestable without it | **MEASURED (Phase 1, task jl4ye8x): §3 budget table landed from `?canvas=1&bench=1`; DOM holds (≥43fps interactive at 2000 objects, culling keeps 52–60 tiles mounted, idle renders 0) — no Pixi flip at v1 scale; re-measure when tiles carry real media** |
| L25 | **Placement policy for batch/new outputs** (adjacency default vs clusters vs grid; the direction doc's open placement question, inventory row 16) | §3 | adjacency-near-parent default + cluster-on-batch-completion; confirm | OPEN |
| L26 | **Concurrency / GPU-arbitration policy** (decisions audit F2 — most dangerous missing: serialize vs interleave, "queued-for-GPU" as on-object state + radar semantics, VRAM arbitration; the #14076 canary decides) | §4 | serialize generations by default (1 active), queued-for-GPU as first-class object state, interleave only after benchmark | **DECIDED (maintainer, 2026-09-14): assistant's pick approved** |
| L27 | **Cross-project asset scope** (audit F3: libraries are global today, one-canvas-per-project isolates — where do shared characters/locations live?) | §2 | global asset store above projects + explicit fork-into-project (consent-gate pattern) | **DECIDED (maintainer via Q&A, 2026-09-14): global store + fork-into-project** |
| L28 | **Drift-envelope counterpart for chains** (audit F1: measured ~0.06 ArcFace/hop, chains ≤4–6 windows — the UI must surface drift budgets; Item 4 gap default) | §3/§6 | chain hop-count + per-hop drift metrics in schema; drift-budget in a semantic-zoom band; reset-as-op (hard-cut + fresh refs = documented identity reset); Director gaps default hard-cut/NLE, bridges opt-in pending E1/E7 | **DECIDED (maintainer, 2026-09-14): assistant's pick approved** |
| L29 | **Retention tiers + document trash + session pruning** (audit F5: 20–40MB/take at working res; canonical+locked always-resident, priors evictable-with-marker, GC over fork edges; soft-delete tombstones for chains/canvases/projects; **maintainer addition: the ability to PRUNE everything attached to a session**) | §2 | as recommended + session-scoped prune affordance (bulk-evict a session's non-canonical, non-locked takes); GC liveness must respect live fork references; trash = soft-delete + restore | **DECIDED (maintainer, 2026-09-14): trash + session-prune required** |
| L30 | **Failure propagation / partial completion** (audit F6: plan executes 10 chains, shot 7 fails — spawn/block/skip; is a crashed generation's half-written latent a take or garbage?) | §2/§4 | semantics table + partial-take validation + rerun-storm serialization (ties to L26) | OPEN |
| L31 | **Blob durability / re-link** (audit F8: files move; detect→degrade→re-link flow, content-hash on ingest, placeholder failure state) | §2 | as recommended | OPEN |
| L32 | **Project import/export** (audit F11: DB rows + blob tree — cheap now, painful bolted on) | §8 | define the archive format early even if export UI is later | OPEN |

## 10. Acceptance (how this spec completes)

Every section individually blessed; **§9 ledger complete against BOTH sources,
demonstrated by enumeration** — pre-brainstorm parked list (10 items):
latent-blocks→L9, presets→L2, timeline→RESOLVED-in-register, engine-views→L4,
canvases→RESOLVED-in-register, screen-size→L5, palette→L6, Focus→L7,
modal-live→L3, inline-chips→L8, + the register's own open sub-questions
(lock-granularity→L21-RESOLVED, placement→L25, option-ranking→L19,
backwards-v1→L20, multi-substrate→L17, seed-visibility→L18); inventory's ten:
mobile→L10, keyboard→§7, playback→L1, export→L16, prompt-library→L11,
macros→L12, keyframe-guides→§2, ref-sets→L13, notice-routing→L14,
chips→L15; plus budget-unit→L23, decompose→L22, inspector→L24 = **25 rows +
2 sections, both sources fully mapped, zero orphans**; every OPEN row closed
or explicitly deferred with rationale; the interaction-budget table confirmed
per section; migration phases verified against the inventory's dependency
register; the schema spec (o0xw49r) reviewed in the same window so model and
surface never contradict. Build tasks are then cut from this spec under epic
vbrstja.
