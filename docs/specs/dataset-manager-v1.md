# Dataset Manager v1 — spec

Status: DRAFT for blind audit → maintainer blessing. Written 2026-09-17 by the lead.
Inputs: maintainer locks (sv14rt0 directive aaee5e7c + comment 3d8jpxf) · research
(docs/research/video-dataset-prep-tools.md, 7drm5qt) · training guide
(docs/research/h3-lora-training-guide.md) · envelope (docs/research/h3-lora-training-envelope.md)
· maintainer signoff (sv14rt0 comment gb5y98t). Where this doc and the Flux record disagree,
the Flux record wins.

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

- **Source** — an imported file, immutable on disk. Owns its ffprobe facts (below),
  provenance fields, and every child derived from it.
- **Layer** — a derived view of a source: a crop rect, a trim window, or both (one source →
  N layers; every export item IS a layer). Layers carry their own captions, audit results,
  and bake settings.
- **Child artifacts attach visibly to their master.** The gallery shows sources as masters;
  layers and scene-splits hang off their source, visibly grouped (expand a master to see its
  children). Children never orphan: deleting a source (v1: removing it from the library —
  the file itself is never touched) removes its layers with an explicit confirm that names
  the blast radius (N layers, N captions).

Scene-split results (§6) are children too — the same attachment rule, the same visible
grouping. There is exactly one parent relation; no child-of-child in v1.

## 2. Import & library

- Folder/watch import of raw sources: video (mp4/mov/mkv/webm) and stills (png/jpg/webp).
  Video-first; stills are one bucket type among several.
- **ffprobe facts recorded at import, and the ones that lie are measured, not asked:**
  fps, container-claimed duration AND **decoded frame count** (the f56 trap — container
  metadata rounds; the trainer floors; a 56f clip silently trains as 39f), resolution,
  aspect, audio presence, dBFS.
- Provenance per source: free-text origin note, date, **AI-generated flag**, consent/license
  note (fields only — no workflow ceremony in v1).
- Browse: virtualized grid (5→1000 items), filmstrip poster per video source,
  representative frame per layer; filter by kind/class/caption-state/audit-flags.
- **Too-small refusal:** sources (or crops, §3) below the usable floor are refused at
  import with the measured reason. Floors from the envelope: hard refuse < 160×96 (the
  mechanical floor — conditioning rows dominate); warn-and-allow ≥ 160×96 < 320×192 (the
  measured practical motion floor); stills: hard refuse < 256², warn < 512² (the validated
  identity recipe). On-demand upscale-on-refuse is deferred — v1 just refuses, honestly.

## 3. The layer system (crop + trim)

- **Stamp crop tool**: drag places the crop stamp; **scroll-wheel resizes the crop**;
  **shift+scroll cycles useful aspect ratios** (16:9, 9:16, 1:1, 4:3, 3:4, 21:9, 9:21 —
  cycle set configurable in settings). Crops are **full-resolution aspect-ratio crops**:
  pixels outside the rect are trimmed at bake; **the video is never resized** (resize
  requires an explicit per-layer action, off by default, and marks the layer).
- Crop rects snap to the 32-px grid (the trainer's dimension grid) so a crop is always
  bakeable without silent re-rounding.
- Trim windows: frame-accurate in/out on the timeline; the grid target (§5) is chosen per
  layer at export, never baked into the trim.
- One source → N layers, each independently cropped/trimmed/captioned; the same scene may
  want multiple crops (a crop layer group: same source, same trim, different rects —
  export emits one item per layer).
- Layers preview their effective view (the crop applied, trim applied) without touching the
  source.

## 4. Captions

- **Captions attach to LAYERS, never sources** — you caption what the crop will show, not
  what the raw file contains. Caption after cropping.
- **Stale flag:** editing a layer's crop or trim after captioning flags the caption stale →
  the recaption queue. A stale caption is a visible state, exportable only past an explicit
  warning (never a silent mismatch).
- **Format: natural language only** (hard lock — no tag lists as primary form), per the
  guide §4: one flowing paragraph, trigger token first and exactly once, mid-density, H3
  vocabulary; soundscape clause when audio is real and described; per-class template
  presets (style / character / motion) seed the editor.
- **Authorship and history (N2):** every caption records author (hand or VLM+model) and a
  full edit history. **Batch VLM runs never silently overwrite hand-written captions** —
  hand-written items are skipped or queued for review, per run setting.
- **VLM captioning, from scratch on upstream llama.cpp (N1 superseded llama-video):**
  - Native `input_video` where available; **≤8 s chunks hard rule** (upstream hang,
    llama.cpp #27587); default frame strategy **~2 fps N-even client-side extraction**
    (dodges both hang classes and the qwen over-merge bug); token budget shown live.
  - **Automation spectrum:** interactive modal at one end — caption, recaption, and
    free-form discussion of the clip with the model — headless batch at the other, with
    user-provided instructions; every point between (e.g. batch-draft → per-clip review).
  - **Dense → condense two-pass:** pass 1 dense draft, pass 2 text-only condensation into
    the class template. Both passes local.
  - The VLM target set and router are the app's existing LLM layer (llama.cpp router);
    caption models are config, not code.
- **Trigger-token validation** runs live in the editor (format rules above) and as an
  export gate (§8).

## 5. The bake pipeline (export-time conform)

Exactly one pipeline, four stages, in order — the ONLY place source pixels are read and
rewritten, always to a new file:

1. **Trim window** → 2. **Crop rect** (full-res, 32-grid) → 3. **CFR 24.000 fps**
(retime first; then drop/dup; interpolation LAST — rife-ncnn-vulkan and/or ffmpeg
minterpolate, items interpolated are tagged; **NVIDIA OFSDK is license-barred** — A1,
pending the maintainer's explicit word but the AGPL conflict is not optional) →
4. **17n+5 grid conform** with trim-to-target **+2 frames** headroom (the runbook rule),
then the **decoded-frame-count assertion**: the baked file is re-probed and its decoded
count must equal the grid target exactly, or the item refuses to export with the delta.

Audio at bake (N8): clips without audio get a **silent wav muxed** (the trainers expect
audio rows); OR, per user preference, existing audio is **blank-replaced** (junk-audio
option). Both are per-layer settings with a dataset-level default. Uncaptioned-but-present
audio is a valid choice — see §10.

## 6. Curation

- **Near-dup, two tiers, detect-everything/kill-selectively (hard rule):** tier-1 videohash
  (ratio-robust, cheap); tier-2 aspect-normalized CLIP clusters. Results are **advisory
  views** — the cross-ratio cluster browser presents same-content-different-AR as **bucket
  diversity, a good thing** (maintainer's practitioner call; mixed-bucket training measured
  free). Nothing is ever auto-deleted; per-source cap WARNINGS fire at export-gate time.
- **Slow-mo audit:** ffprobe metadata + frame-diff energy + freezedetect/mpdecimate,
  composed; suspects get a **disposition menu** (N6): retime (with the retime baked and
  tagged) / caption-honestly (keep the slow motion, caption says so) / exclude.
- **Scene-split (N5, manual):** a user-invoked option per source from the gallery —
  PySceneDetect content detector proposes cut points; the user accepts/edits; accepted
  splits become **child artifacts visibly attached to the master** (§1). Non-destructive:
  the split is a layer-set, not a file operation. (Detector is imperfect — that's why it's
  a proposal UI, never automatic.)
- **CLIP reference-triage** ("find this character across the library") — N9, PENDING the
  maintainer's word; the embeddings exist for tier-2 regardless, so this is a UI decision,
  not an architecture one.

## 7. Balance & budget dashboard

- Distributions at a glance: aspect / duration / resolution / content-class /
  caption-coverage / staleness — the bucket-mix the maintainer asked for, with explicit
  "add more of X / less of Y" guidance derived from the dataset's own shape.
- **Per-bucket composition against the measured walls** (envelope): the budget formula
  (VRAM ≈ 5.1 GB fixed + ~2.6 GB per mega-token of px×frames, card wall ~23.5 GB) computes
  **projected peak VRAM for the dataset's worst item and its buckets**, BEFORE any run —
  the preflight verdict at dataset time, not at 2am trainer time.

## 8. QA gates (export-time, each mapped to a documented failure)

1. Empty caption 2. Trigger duplicated (baked + prepended) 3. fps ≠ 24.000 after bake
4. Slow-mo suspicion undispositioned 5. Duration truncation vs grid target (the f56 class)
6. Near-dup cluster over-cap per source (warning-tier) 7. Real-audio rows missing their
soundscape clause **when the dataset's audio policy expects one** (see §10) 8. Trigger
token format (obfuscated single token, one insertion path).

Gates refuse the export item-by-item with the reason; dataset-level export proceeds with
explicit accept-all for warning-tier gates only.

## 9. Export

- **Shapes:** musubi TOML (+ caption sidecars/JSONL, one_frame stills, wav sidecars) and
  DiffSynX stage-1 manifest (video/prompt/input_audio/frame_rate rows) — both emit from one
  dataset; per-trainer class-conditioned **recipe card** (N7): rank 16, LR band, steps
  band, de-distillation method per content class, surfaced as a card — a hint document,
  never a silent behavior.
- **External-trainer export (N7 extension):** the set exports standalone — correct folder
  structure, prefilled configs, captions in place — runnable by any trainer outside the
  app. Our trainers are OPTIONAL components: when absent, in-app training is disabled
  (availability gating, the optimization-registry pattern) but export is fully functional.
- Exports are immutable snapshots written to a user-chosen folder + recorded in the
  library with their recipe card and gate report.

## 10. Audio policy

Audio rows always train (measured: no droppable audio budget; real vs silence is
cost-identical). Therefore:
- **Absent audio** → silent wav (trainers expect the rows).
- **Junk audio** → optional blank-replace, per preference.
- **Real audio, uncaptioned** → VALID (maintainer's call): the audio distribution still
trains and video quality is unaffected; the cost is **promptability** — without a
soundscape clause the text pathway never learns to describe the sound, so audio at
generation time follows the scene's learned distribution but can't be steered by prompt.
The gate (§8.7) fires only when the dataset's audio-caption policy is set to expect
clauses — the policy is the user's, per dataset.

## 11. Interaction map (v1 surface)

A dedicated surface (not the canvas — this is a workbench, summoned from the app like
Settings/Diagnostics docks or its own route; final placement at build). Gallery of masters
(left/center), inspector per selection (facts, provenance, children), the stamp-crop editor
on the video viewer, caption editor with live trigger validation and the VLM modal, the
balance dashboard as a tab, export as a final-step wizard (shape → gates → bake → report).
Keyboard: the app's existing conventions; scroll/shift-scroll belong to the crop stamp
inside the crop editor.

## 12. Acceptance criteria (build gates)

1. Import refuses nothing silently: every source has decoded-frame-count facts; refusals
   name the measured reason.
2. A source file's bytes are never modified (verifiable: checksum before/after any
   operation, asserted in tests).
3. Crop/trim produce N layers per source; every export item is a layer; caption-stale
   flows visible and gate-enforced.
4. The bake pipeline order is fixed; the decoded-count assertion catches a crafted f56-class
   truncation in tests.
5. Batch VLM never overwrites hand-written captions (test-proven); authorship + history
   round-trips.
6. Dedup is advisory-only (no delete path exists outside explicit user action); cross-ratio
   clusters present as diversity.
7. The dashboard's predicted peak VRAM matches the envelope formula on crafted datasets
   (golden tests).
8. Both trainer shapes export; an external-trainer export runs without our trainers
   installed; in-app training is gated off when trainers are absent.
9. All 8 gates refuse with reasons; accept-all only for warning-tier.
10. Full gate + e2e + vision + both CI legs, the house standard.

## 13. Open items

- **A1** (NVIDIA OFSDK → rife/minterpolate): license-barred for AGPL; awaiting the
  maintainer's explicit yes.
- **N9** (CLIP reference-triage): awaiting the maintainer's word.
- Held-back features: the maintainer has more in mind for a later discussion — v1 scope
  is exactly this doc.
- N3 whisper lane and D1–D3 deferrals are recorded, not forgotten.
