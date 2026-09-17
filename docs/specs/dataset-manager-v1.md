# Dataset Manager v1 — spec (r2, post-blind-audit)

Status: DRAFT r2 — blind-audit findings applied (audit comment imocltl on sv14rt0);
awaiting maintainer blessing. Written 2026-09-17 by the lead; r2 same day.
Inputs: maintainer locks (sv14rt0 directive aaee5e7c + comments 3d8jpxf, gb5y98t) ·
research (docs/research/video-dataset-prep-tools.md) · training guide · envelope ·
canvas spec (house conventions). Where this doc and the Flux record disagree, the
Flux record wins.

## 0. What this is

The in-app prep pipeline for H3 LoRA training datasets: import raw footage, crop and trim it
into dataset items, caption them (hand or local VLM), curate and balance the set, and export
it in a trainer-ready shape — for our trainers (musubi / DiffSynX) or any external one.

North star: **the source is sacred.** Nothing a user does in this tool ever modifies an
imported file. Every transformation is a layer; nothing is baked until export, and the bake
writes to a new location. The tool's job is judgment amplification — making a 5-clip or
1000-clip dataset fast to compose, honest about its balance, and impossible to export in a
shape the trainers will misread.

**Non-goals (v1):** cloud APIs (never — hard lock); upscaling on refuse (deferred);
whisper/audio-caption augmentation (deferred, N3); keyframe/adaptive frame sampling
(deferred, D1); deep QA measures beyond §8's gates (deferred, D2); token-dependency
analytics (deferred, D3); training itself (the sidecar's job — this tool ships datasets).

## 1. The object model (master/child)

Two persistent kinds, one attachment rule:

- **Source** — an imported file, immutable on disk, tracked **by reference** (§2.1). Owns
  its probe facts, provenance fields, and every child derived from it.
- **Layer** — a derived view of a source: a crop rect, a trim window, or both (one source →
  N layers; every export item IS a layer). Layers carry their own captions, audit results,
  and bake settings.
- **Child artifacts attach visibly to their master.** The gallery shows sources as masters;
  layers and scene-splits hang off their source, visibly grouped (expand a master to see
  its children). There is exactly one parent relation; no child-of-child in v1. A "crop
  layer group" (same source, same trim, multiple rects) is a UI grouping of layers, not a
  third kind. Two identical crops are two valid layers — the dedup view (§6) flags the
  redundancy; nothing forbids it.
- **Deletion is soft everywhere** (the house trash rule, canvas R29): removing a source or
  layer moves it to a restorable trash; removing a source names the blast radius
  (N layers, N captions) in the confirm. The file on disk is never touched by any deletion.

## 2. Import & library

### 2.1 Source tracking (by reference — the contract that makes non-destructive possible)

- A source is recorded as: absolute path + size + mtime + **content hash (xxhash128 —
  identity tracking, not security)**. Nothing is copied at import; the library references
  the file where it lives.
- **Re-import of the same content** (any path) resolves to the SAME source (hash match) —
  duplicate imports are deduplicated, never duplicated.
- **Health check on library open and pre-bake (stat + hash when size/mtime moved):**
  - path gone → source marked **MISSING** (visible state; children intact; bake refuses
    with reason; re-link offered via file picker, matched by hash);
  - same path, different content → **CHANGED** (children intact but crop/trim indices may
    no longer align — bake warns and requires explicit accept);
  - healthy → silent.
  No disk change ever strands a layer silently.

### 2.2 Facts at import

- ffprobe facts: fps, container-claimed duration, resolution, aspect, audio presence,
  dBFS — recorded immediately (cheap).
- **Decoded frame count** (the f56 trap's antidote) requires a full decode — it runs as a
  **background probe job per source**, arriving asynchronously with a visible "probing"
  state. Import of 1000 items never blocks on decode; the fact is required before a
  source's first bake and gates §8.5.
- Provenance per source: free-text origin note, date, **AI-generated flag**, consent/license
  note (fields only, no ceremony).

### 2.3 Browse & refusal floors

- Virtualized grid (5→1000 items), filmstrip poster per source, representative frame per
  layer; **FTS search over captions/provenance**; filter by kind/class/caption-state/
  audit-flags; hover-scrub playback in the gallery.
- **Too-small refusal, measured floors (video, from the envelope):** hard refuse
  < 160×96 (the mechanical floor); warn ≥ 160×96 and < 320×192 (the practical motion
  floor — below ~224 short-side, conditioning rows start dominating the sequence).
  Sources are refused at import; **crops are refused at crop-time** when the rect falls
  below the same floors.
- **Stills floors [SPEC-inferred, first-attempt — NOT measured]:** warn < 512² (the
  guide's validated character-recipe size), hard refuse < 256². Flagged for the
  maintainer's blessing; adjust freely.
- On-demand upscale-on-refuse is deferred — v1 refuses, honestly, with the measured reason.

## 3. The layer system (crop + trim)

- **Stamp crop tool**: drag places the crop stamp; **scroll-wheel resizes the crop**;
  **shift+scroll cycles useful aspect ratios** (default cycle: 16:9, 9:16, 1:1, 4:3, 3:4,
  21:9 — within the model's official 21:9–9:16 range; the cycle set is a setting).
  Crops are **full-resolution aspect-ratio crops**: pixels outside the rect are trimmed at
  bake; **the video is never resized** (resize requires an explicit per-layer action, off
  by default, and marks the layer).
- Crop rects snap to the 32-px grid so a crop is always bakeable without silent re-rounding.
- Trim windows: frame-accurate in/out; the grid target is chosen per layer at export, never
  baked into the trim.
- Layers preview their effective view (crop + trim applied) without touching the source.

## 4. Captions

- **Captions attach to LAYERS, never sources** — you caption what the crop will show.
  Caption after cropping.
- **Stale flag:** editing a layer's **crop or trim** after captioning flags the caption
  stale → the recaption queue. (The signed decision named crops; trim extends it by the
  same mechanism — content removed from view — **flagged for blessing**, not silent.) A
  stale caption exports only past an explicit warning.
- **Format: natural language only** (hard lock), per the guide §4: one flowing paragraph,
  trigger token first and exactly once, mid-density, H3 vocabulary; soundscape clause when
  audio is real and described. Per-class templates seed the editor, and the class rules
  carry: **character class — appearance NEVER in captions** (identity flows through the
  trigger); motion class — name the repeated movement precisely.
- **Trigger-token validation (the gate-8 definition):** the trigger must be a single token,
  rare (not a common dictionary word — checked against a frequency list), used exactly
  once, first. Live in the editor, enforced at export.
- **Authorship and history (N2):** every caption records author (hand or VLM+model) and
  full edit history. **Batch VLM never silently overwrites hand-written captions** —
  hand-written items are skipped or queued for review, per run setting.
- **VLM captioning, from scratch on upstream llama.cpp (N1):**
  - Native `input_video` where available; **≤8 s chunks hard rule** (upstream hang
    #27587); default frame strategy **~2 fps N-even client-side extraction** — this dodges
    the hang classes; it does **not** dodge the qwen frame-merge over-merge bug (#24303,
    which bites image-set sends on qwen-family models) — mitigation: non-qwen models for
    image-set passes until fixed upstream. Token budget shown live.
  - **Automation spectrum, concretely:** (a) headless batch with user instruction
    templates; (b) batch-draft → per-clip review queue; (c) per-clip caption/recaption
    modal; (d) free-form discussion of the clip with the model. These four modes ARE the
    spectrum — nothing vaguer.
  - **Dense → condense two-pass:** dense draft, then text-only condensation into the class
    template. Both local; models are router config, not code.

## 5. The bake pipeline (export-time conform)

Exactly one pipeline, four stages, in order — the ONLY place source pixels are read and
rewritten, always to a new file:

1. **Trim window** → 2. **Crop rect** (full-res, 32-grid) →
3. **CFR 24.000 fps**, speed-preserving by default: **retime only for near-24 corrections**
   (e.g. 23.976 → 24.000 — the research's condition; unconditional retiming would warp
   30fps content 1.25×); **drop/dup for integer-ratio downsampling** (30→24, 60→24 —
   speed preserved); **interpolation LAST and only for upsampling gaps**:
   **rife-ncnn-vulkan / ffmpeg minterpolate only** (A1 final, maintainer 2026-09-17 —
   NVIDIA OFSDK and other accelerator options are DEFERRED to the watchlist, not built,
   not wired; revisit only if batch-bake speed ever demands it). All interpolated items
   are tagged →
4. **17n+5 grid conform: bake to grid target +2 frames.** The trainer's own loader floors
   the container duration and clamps DOWN the 17n+5 grid; the +2 headroom is what makes
   the clamp land exactly on target instead of walking down 17 (the f56 mechanism,
   measured). **The decoded-frame-count assertion therefore accepts decoded ∈
   [target, target+2]** — an exact-equality assertion here would refuse every conforming
   export (audit blocker 1); decoded < target refuses with the delta (the f56 class
   caught at OUR door, before the trainer sees it).

Audio at bake (N8): clips without audio get silence in the form each trainer expects
(**musubi: wav sidecar; DiffSynX: its input_audio manifest rows**) — the bake emits the
trainer's shape, not a generic mux. Optionally, existing audio is **blank-replaced** per
user preference. Uncaptioned-but-present audio is valid — §10.

## 6. Curation

- **Near-dup, two tiers, detect-everything/kill-selectively (hard rule):** tier-1 videohash
  (ratio-robust, cheap); tier-2 aspect-normalized CLIP clusters. Advisory views — the
  cross-ratio cluster browser presents same-content-different-AR as **bucket diversity**
  (maintainer's call; mixed-bucket measured free). Nothing auto-deletes; per-source cap
  warnings fire at export-gate time (cap = dataset setting, default 3 per cluster per
  source, [SPEC-inferred first-attempt]).
- **Slow-mo audit:** ffprobe metadata + frame-diff energy + freezedetect/mpdecimate,
  composed; suspects get dispositions (N6): retime (baked, tagged) / caption-honestly /
  exclude.
- **Scene-split (N5, manual):** user-invoked per source; PySceneDetect proposes cut points;
  the user accepts/edits; accepted splits become child layers visibly attached to the
  master. Cut points are editable until children exist; re-running after children exist
  creates NEW children (never mutates old ones).
- **CLIP reference-triage (N9 — IN v1, maintainer 2026-09-17):** pick or paste any
  reference image (a character, an outfit, a location, or any layer's representative
  frame) and the tier-2 embedding index ranks the whole library by similarity — "find
  this character across hours of footage" as one query. Ranked results support bulk
  selection → assign content-class, batch-crop, or mark coverage. The same index powers
  find-similar-to-this-layer as a general library search.

## 7. Balance & budget dashboard

- Distributions: aspect / duration / resolution / content-class / caption-coverage /
  staleness — with "more of X / less of Y" guidance. **Honesty note: no canonical target
  distribution exists** — guidance is shape-based heuristics (outliers, holes, over-
  concentration) plus optional user-set targets; it never pretends to know the right mix.
- **Per-trainer VRAM preflight:** projected peak computed with EACH trainer's measured
  profile — DiffSynX (budget formula ≈ 5.1 GB + ~2.6 GB/Mtok) and musubi (its own measured
  peaks, e.g. 20,074 MiB at 480×832×124f vs DiffSynX's 17,286) — showing the worst case
  and labeling which trainer binds. A near-wall dataset must not pass preflight against
  the lenient profile and OOM on the stricter one (audit major).

## 8. QA gates (export-time; 1–4 and 8 are refusing, 6–7 and 9 warning-tier)

1. Empty caption 2. Trigger duplicated 3. fps ≠ 24.000 after bake 4. Slow-mo suspicion
   undispositioned 5. Decoded count outside [target, target+2] 6. Near-dup cluster over
   cap per source 7. Real-audio rows missing their soundscape clause **when the dataset's
   audio policy expects one** (§10) 8. Trigger-token format (single rare token, exactly
   once, first — per §4's definition) 9. Trim window crossing a detected internal cut
   (when scene data exists — one scene per clip, warning-tier).

Gates refuse item-by-item with reasons; warning-tier gates accept-all explicitly.

## 9. Export

- **Shapes:** musubi TOML (+ caption sidecars/JSONL, one_frame stills, wav sidecars) and
  DiffSynX stage-1 manifest rows — both from one dataset; per-trainer **class-conditioned
  recipe card** (N7): rank (16 for style/character; **16–32 band for motion** — the
   guide's class nuance, not a flat 16), LR band, steps band, de-distillation method. A
   hint document, never a silent behavior.
- **External-trainer export (N7 ext):** the set exports standalone — correct folder
  structure, prefilled configs, captions in place — runnable by any external trainer. Our
  trainers are OPTIONAL: in-app training is disabled when absent (availability gating);
  export is always fully functional. **Validation: the musubi shape must pass musubi's own
  dataset-config validation, and the DiffSynX shape must load in DiffSynX's stage-1 dry
  path — named checks at build (audit note).**
- Exports are immutable snapshots: written to a user-chosen folder, recorded with recipe
  card and gate report.
- **Operational contracts:** bakes run through the app's serialized job queue (no
  concurrent bakes of the same dataset; the queue is the arbiter); mid-bake cancel
  discards partial outputs and records no snapshot (sources untouched by definition);
  disk-full fails the item with a retryable error and no partial snapshot; watch-folder
  re-import resolves by hash (§2.1).

## 10. Audio policy

Audio rows always train (measured: no droppable budget; real vs silence cost-identical).
- **Absent audio** → silence in the trainer's expected form (§5).
- **Junk audio** → optional blank-replace, per preference.
- **Real audio, uncaptioned** → VALID: video quality unaffected; the cost is
  promptability — without a soundscape clause the text pathway never learns to describe
  the sound, so generated audio follows the scene's learned distribution but cannot be
  steered by prompt. Gate 7 fires only when the dataset's audio-caption policy expects
  clauses — the policy is the user's, per dataset.
- **musubi consistency rule:** still/one-frame rows and silent rows STATE sound absence in
  their captions (the trainer's documented convention — silence described, not implied).

## 11. Surfaces & the canvas bridge

- A dedicated workbench surface (placement decided at build — its own route vs a dock);
  gallery of masters, inspector, the crop editor on the video viewer, caption editor with
  live trigger validation and the VLM modal, dashboard tab, export wizard
  (shape → gates → bake → report). Scroll/shift-scroll belong to the crop stamp inside
  the crop editor only (the canvas's wheel-zoom semantics are untouched — audit clean).
- **Canvas bridge (task AC uddsvkv):** a canvas media object or completed take can be
  **sent to the dataset manager as a source** (consent-gated, the MoviePlanner-seeding
  pattern; the take's file becomes a referenced source like any import) — and dataset
  layers can be **pinned onto the canvas as reference assets** for op stacks. One bridge,
  two directions, both explicit user actions.
- Per-layer bucket badge (its res×duration class against §7's walls) visible in gallery
  and inspector.

## 12. Acceptance criteria (build gates)

1. Import refuses nothing silently; every source carries facts; refusals name the measured
   reason; decoded counts arrive async and are required pre-bake.
2. A source file's bytes are never modified (checksum before/after any operation,
   test-asserted); disk changes surface as MISSING/CHANGED, never silent strandings.
3. Crop/trim produce N layers per source; every export item is a layer; stale flows
   visible and gate-enforced; deletions are soft and restorable.
4. The bake order is fixed; the assertion range [target, target+2] catches a crafted
   f56-class truncation (decoded < target) in tests while passing conforming +2 bakes.
5. Batch VLM never overwrites hand-written captions (test-proven); authorship + history
   round-trip.
6. Dedup is advisory-only; cross-ratio clusters present as diversity.
7. Per-trainer preflight computes BOTH profiles on crafted datasets; golden tests against
   the envelope's measured numbers.
8. Both trainer shapes export; the musubi shape passes musubi's own config validation and
   the DiffSynX shape loads in its stage-1 dry path; an external export runs without our
   trainers installed; in-app training gated off when trainers absent.
9. All gates refuse/warn with reasons; accept-all only for warning-tier.
10. Scale gate: 1000-item library browses, searches, and opens the dashboard within the
    app's existing perf budgets (asserted in tests).
11. Full gate + e2e + vision + both CI legs, the house standard.

## 13. Open items (the blessing list)

- **A1 FINAL** (maintainer 2026-09-17): RIFE/minterpolate only. NVIDIA OFSDK and other
  accelerator options deferred to the watchlist entirely — not built, not wired; may
  return later via the user-fetch wrapper pattern if batch-bake speed ever demands it.
- **N9 RESOLVED — IN v1** (maintainer 2026-09-17): CLIP reference-triage on the tier-2
  embedding index (§6).
- **Blessing flags (r2 changes beyond the signed locks, each needs a nod):**
  (a) trim-stale extends the signed crop-stale decision (same mechanism, flagged);
  (b) stills floors are SPEC-inferred, not measured (§2.3);
  (c) soft-delete trash added per the house R29 convention;
  (d) per-source near-dup cap default 3 (inferred);
  (e) the aspect-ratio cycle defaults to the model's official 21:9–9:16 range.
- Held-back features: the maintainer has more in mind for a later discussion — v1 scope
  is exactly this doc. N3 whisper lane and D1–D3 deferrals recorded, not forgotten.
