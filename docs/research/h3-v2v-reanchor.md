# V2V re-anchor — regenerating degraded chains through ref2va (the R-arms of the drift-envelope)

> Flux input: **Drift-envelope suite (5nfy24y)** — this assessment supplies the
> R-arm family; no separate task. Date: **2026-09-25**. METHOD: read-only
> code-read of the shared install (ComfyUI `comfy_extras/nodes_minimax_h3.py`
> and `comfy/ldm/minimax/model.py` — the ref2va conditioning's frame handling,
> verbatim); our library captures + tranche/E-series measurements; pinned-
> revision workflow-JSON dissection of ComfyUI-H3-Overlap (`e2f2bc6`) and
> ostris/ComfyUI-AIToolkit-MiniMaxH3 (raw fetches, widgets read directly);
> live upstream verification (Runware editing guide re-fetched 2026-09-25 —
> fresh under the freshness doctrine). **No GPU, no engine, no installs.**
> Evidence tags: **[DOC]** verified in code/official source, **[COMM]**
> reputable community finding, **[SPEC]** plausible-unverified, **[UNK]**
> nobody knows. **[MAINTAINER]** = maintainer hands-on.
>
> **The hypothesis under test (maintainer, 2026-09-25):** "using a
> long-chained video that has some degradation as the source for a V2V full
> regeneration following the same prompt — it isn't a one-shot solution, but
> V2V does not suffer the same time constraints ref/fl2va routes do, so
> theoretically a degraded video doesn't matter as a draft."

---

## 1. The hypothesis, decomposed

Three claims, each independently checkable, each load-bearing for the arm
designs:

- **C1 (length premise):** the ref2va video-reference route lacks the
  time/context constraints of the first-frame / image-ref chaining routes —
  a degraded *long* video is acceptable as conditioning.
- **C2 (inheritance):** a V2V re-generation inherits *structure* from its
  source but *re-samples* quality — degradation does not (fully) pass through.
- **C3 (refs-alongside):** the strongest form attaches the ORIGINAL character
  reference images in the same conditioning — identity re-anchored from
  ground truth while structure comes from the draft.

## 2. Fact verdict 1 — the length premise: **CONFIRM with the constraint renamed**

The maintainer is right about the mechanism and needs one correction about
which constraint actually binds. The ref2va route has no *context bottleneck*
— but it has a **per-pass duration envelope plus packed-sequence compute**,
and that is the real ceiling to design against.

### 2.1 What the conditioning actually is (code-read, verbatim)

`MiniMaxH3ReferenceToVideo` (`comfy_extras/nodes_minimax_h3.py:241-357`) and
the DiT (`comfy/ldm/minimax/model.py`):

- The whole reference video is VAE-encoded once and rides the packed sequence
  as **`ref_img` token rows that are never denoised** (`img_update` all-false
  for ref segments, `PackedLayout`, model.py:401-403/426-431) — "keyframe /
  reference condition latents, re-injected every step (never denoised)"
  (file docstring). Every generated frame **attends to every reference
  frame** through full self-attention over the packed sequence **[DOC]**.
- Refs occupy **their own temporal RoPE span ahead of the target timeline**
  (`cursor += _ref_t_span(blk)` before the target streams, model.py:361-364,
  432) — the model reads the reference as "a video that happened before the
  target," on continuous float positions with no embedding-table bound. There
  is **no architectural frame cap** in this code path **[DOC]**.
- The text encoder sees the reference video **at 2 fps with timestamps**
  (`sample_idx = range(0, n, 12)`, nodes_minimax_h3.py:337-341) — the Qwen
  side of the conditioning is cheap and length-tolerant; the *latent* side
  carries the full frame rate **[DOC]**.
- Up to **3 reference videos** (each may carry its own soundtrack via
  `ref_video_audio_N`, which gets its own `<Audio j>` label), plus 9 images
  and 3 audios, in one conditioning **[DOC]** (node autogrow inputs,
  nodes_minimax_h3.py:267-282).

### 2.2 The constraints, named precisely

1. **The trained per-pass envelope, not context length.** Target `length`
   slider: 5–3600, tooltip "trained range is ~124-362, longer is untested"
   (≈5–15 s); reference-video tooltip: "Reference video frames at 24 fps
   **(2-15s)**" (nodes_minimax_h3.py:264, 273). Official capability: output
   "about 15 seconds" (overview capture; upstream reviews concur) **[DOC]**.
   A single V2V pass is trained on both sides (source and target) to ~15 s.
2. **Ref truncation to target length.** `if frames.shape[0] > frame_count:
   frames = frames[:frame_count]` (nodes_minimax_h3.py:323-324) — **the
   reference can never be longer than the generation it conditions**. A
   one-shot re-gen of a 60 s chain in a 15 s generation is not expressible;
   the code silently truncates the ref (a silent-drop hazard for the graph
   factory to guard). Frame count then snaps down to the 17k+5 grid **[DOC]**.
3. **Packed-sequence compute.** Token math at our canvas (1344×768 → 1008
   rows per latent-frame; `FRAME_PER_TOKEN (1,4,4,4,4)` → 17 pixel frames per
   5 latent tokens): a 362 f target ≈ 108 k video rows; a same-length ref at
   the 0.59 MP bucket (864×672) adds ≈ 61 k more; packed seq ≈ 170 k rows vs
   ≈ 108 k for a plain generation — roughly **+56 % context** at matched
   duration, quadratic attention on top (VDN's sparse attention changes the
   constant, not the token count) **[DOC, arithmetic]**. This is why the
   H3-Overlap pack processed at ~0.5 MP / 12 GB, and it is the honest VRAM
   line for the R-arms at hero resolution.
4. **Edit fidelity decays with source length (quality, not mechanics).**
   Runware's editing guide (re-verified live 2026-09-25): "a shorter source
   gives the model less to preserve"; "small on-screen text, exact logos, or
   a busy crowd that must stay frame-for-frame identical can drift"; "one
   change per call reads more cleanly than five" **[DOC]**. Long sources are
   *mechanically* accepted and *qualitatively* worse to preserve.

### 2.3 The 90-frame question, and a correction to our own overlap doc

- **Was 90 a VRAM choice or an architecture limit? VRAM/compute — a window
  size, not a conditioning ceiling.** The pack's *source* is documented
  tested to 643 frames; 90 f (17×5+5, grid-valid) is the generation window
  it re-renders in, chosen for 12 GB at ~0.5 MP. The ref conditioning itself
  accepts any 17k+5 length up to the target-length truncation; nothing in
  the model privileges 90 **[DOC: pack README + our code-read]**.
- **Correction (landed as Addendum 3 in h3-overlap-concept.md):** our
  overlap doc read the pack's workflow as "`AIToolkitMiniMaxH3RefVideo`
  (ref-strength 0.59)". Direct dissection of the pinned workflow JSON
  (2026-09-25) shows the node's widgets are **`[target_megapixels=0.59,
  max_length=0]`** — 0.59 is the megapixel bucket (res-768 class, matching
  the README's "0.5 MP processing"), and **the node has no strength input at
  all** (its full schema: `video`, `target_megapixels` 0.01–4.0,
  `max_length` 0–3600). The "ref-strength 0.59 soft joint" attribution is
  withdrawn; the soft-joint *dial* remains buildable on the native
  `visual_cond_noise_aug` payload key (below), so arm O-soft stands with
  corrected provenance **[DOC]**.

### 2.4 The contrast with the chaining routes — the deep property

The fl2va first-frame chain hop gives the model a **single-frame (or 22/39 f
pinned-tail) context** — a bottleneck the whole chain must squeeze through,
and drift accumulates per hop (~0.06 ArcFace/hop, directional; the vendor's
own AMA: "continuing a shot via reference drifts and shows seams… training on
long sequences is the fix, but that's a future model") **[DOC/COMM]**. The
ref2va V2V pass gives the model the **entire source in-context** and samples
**fresh**: drift does not compound *within* the pass, because the pass is one
generation conditioned on fixed (degraded-but-fixed) structure.

Windowed over a long chain, this generalizes: every window conditions on the
**draft** (fixed), never on another window's *output*. The R-family
**converts the chain's sequential exposure-bias problem into a parallel
re-render problem** — intra-pass accumulation is eliminated by construction;
the only remaining coupling is at re-join seams (§5). That is the precise
sense in which the maintainer is right **[DOC-mechanism; the quality
consequence is what the arms measure]**.

### 2.5 Verdict C1

**CONFIRM (mechanism) with the binding constraint renamed:** the route lacks
the *context bottleneck and per-hop accumulation* of the chaining routes;
its real constraints are (a) the ~5–15 s trained envelope on both source and
target per pass, (b) ref-truncation-to-target-length (forces windowing above
15 s — R3-style segmentation is not optional for long chains, it is
architecture-forced), (c) packed-sequence compute (+~56 % tokens at matched
length, quadratic attention), and (d) preservation fidelity decaying with
source length. "No time constraint" is true **per pass**, not per take.

## 3. Fact verdict 2 — inheritance: **structure passes through; quality re-samples; color and identity partially bleed — per-axis**

There is no V2V pipeline separate from editing: V2V **is** reference-mode
generation with a preservation-shaped prompt. The inheritance profile is
therefore the edit-contract profile, and we hold measured evidence on it:

| Axis | Inherited or re-sampled | Evidence |
|---|---|---|
| Structure (pose, motion, timing, camera, composition) | **Inherited** — this is the route's product; "camera paths and motion hold well since it works from a real clip" (Runware); H3 sits #2 (Elo 1129) on the AA video-editing arena doing exactly this **[DOC/COMM]** |
| Pixel texture / detail | **Re-sampled** — "edits are a semantic regeneration of the source, not pixel inpainting" (ALLinONE pack); "everything else left alone" = *re-rendered faithfully*, not bit-preserved; our E-ED1 measured 10–13 dB vs source = semantic re-synthesis class on every arm **[COMM + our E-ED1]** |
| Color / exposure statistics | **Partially inherited** — "grade the reference toward what the model renders (a 16–21 L* too-bright reference underperforms)" (loopforge): the model reproduces the reference's global statistics; a drift-darkened draft pulls the re-gen dark unless the prompt/stabilize counters **[COMM]** |
| Identity | **Not self-healed** — ref_video continuation measured identity dying first (E5: ArcFace 0.12 class); identity-through-edit with refs 0.12–0.25 stock / 0.31–0.35 hybrid (E-ED1); identity "is not gradeable" (loopforge) — walking identity needs ground-truth re-anchoring, i.e. C3 **[our tranche 2 + E-ED1]** |
| Quality ceiling of the refresh | **Capped at R2V-class softness** — official AMA: "R2V renders softer than I2V… feed it the highest-quality reference material you have" — the refresh output is *softer-class*, and *reference quality is officially load-bearing*; the b25-49 hybrid checkpoint is the measured mitigation (E-ED1: +3.4 dB, ~2.5× identity-through-edit, zero wall cost) **[DOC + our E-ED1]** |
| Audio | **Regenerated by default** (native audio is re-sampled; cover-band risk) — or **reused** by attaching the draft's soundtrack via `ref_video_audio_N` + `<Audio j>: fully_copy` (LongMedia `audio_mode: preserve` precedent) **[DOC]** |

**The stress-test verdict on "a degraded video doesn't matter as a draft":**
true for structure; true for texture *up to the R2V-soft ceiling*; **not
free** for color (statistics transfer) and **not true at all for identity**
without refs. The draft's degradation profile matters per-axis — which is
exactly what the R-arm golden domains measure.

**The strength-regime reality (correction-adjacent):** no ref-strength dial
ships anywhere in the stack — not the native node (its only ref knob is
`ref_image_size: match|max`), not ai-toolkit's helper (§2.3). Reference
influence is controlled by: (a) **prompt discipline** — subject_definitions
strength ("the stronger you describe `<Subject N>` the more stable the
reference" [COMM]), retention markers (`fully_preserved` vs
`weak_reference`); (b) the **native `visual_cond_noise_aug` payload key**
(default `VISUAL_COND_TIMESTEP = 0.999`; `< 1.0` mixes seeded noise into
cond rows, model.py:525-538) — a real, unexposed conditioning-strength dial
the graph factory could surface for the O-soft joint and R-arm dosage; (c)
third-party prompt-rewrite "fidelity" knobs (astropuzzo `source_fidelity` —
"not denoise strength", start 0.50–0.60 for large transfers) **[COMM]**.
Any "ref-strength" language in our arm designs must name which of these it
means.

## 4. Fact verdict 3 — refs-alongside: **the lane exists natively, is documented official practice, and is unmeasured exactly where we need it**

- **Official combined-asset pattern:** the reference-mode prompt guide's own
  example — "`<Subject 1>` is the woman whose appearance comes from
  `<Picture 1>` and whose walking motion comes from `<Video 1>`" — is
  precisely the R2 geometry: identity from images, structure from video, in
  one conditioning (ref-guide capture §2.1) **[DOC]**.
- **Shipped mode:** LongMedia's `video_ref_edit` — `video_1` = source
  performance/motion/camera/composition, `image_1` = replacement identity,
  `audio_1` = source soundtrack or dub ("typical source-character
  replacement") **[DOC]**. Industrial certification of the geometry:
  Viggle-Animate, a 33.1 B full finetune of H3-ref2va whose only job is
  driving-video + identity **[COMM]**.
- **Practice precedent:** the First Date project attached turnaround sheet +
  room layout + voice sample per generation with identity held by citing
  images inside `subject_definitions` **[COMM]**.
- **Our builder already wires it:** `src/lib/workflow.ts:184-201` —
  `ref_images.ref_image_N` (≤9), `ref_videos.ref_video_N` +
  `ref_video_audios.ref_video_audio_N` (≤3), `ref_audios.ref_audio_N` (≤3)
  all land on one `MiniMaxH3ReferenceToVideo` node in reference mode; guide
  images ride `MiniMaxH3AddGuide` separately (lines 214-232). Presentation
  order is fixed by the node: images, then videos, then audios; ordinals are
  wiring order, not prose order **[DOC-local]**.
- **Interference catalog (what is known):** (a) R2V-softness compounds with
  reference count/class — mitigate with the hybrid (E-ED1); (b) the ordering
  trap (wiring order governs `<Picture i>`/`<Video k>` numbering); (c)
  standalone `<Picture N>` lines lose attributes — cite inside
  `subject_definitions` (First Date's "lost the coat" failure); (d)
  compound-task interference — "one change per call reads more cleanly"; a
  re-gen asks for two jobs at once (quality refresh + identity-from-elsewhere),
  which is exactly the R1-vs-R2 comparison; (e) audio must be explicitly
  re-attached or it is re-invented. **No documented refs×video interference
  beyond these** — and the degradation-source cell is unmeasured anywhere:
  E7 (identity value of refs alongside generated content) was designed in
  the transitions doc, never run (tranche-1 ops note: insightface absent —
  install before any identity-metric arm). **R2 absorbs E7's question**
  **[DOC/COMM + our gap]**.

## 5. The R-arms (drift-envelope input)

Design constraints inherited from §2-4: windowing above 15 s is forced
(ref≤target truncation); the hybrid checkpoint is the default base (E-ED1);
every window re-attaches the full conditioning contract (window-context
invariant, overlap doc §0.1 — stale refs or replayed action text measure the
invariant violation, not the arm).

| Arm | Design | Redundant compute | Isolates |
|---|---|---|---|
| **R1** plain V2V re-gen (the maintainer's form) | per-window (≤15 s, grid-valid) re-render: draft segment as `<Video 1>`, same durable prompt (`[video editing]` / `+ audio reuse`), retention: structure `fully_preserved`, instruction = "re-render at full quality, no content change"; windows independent (each conditioned on the draft, never on each other) | ≈ 1× the chain's own generation cost + ref-token overhead (+~56 % tokens at matched length) | Quality refresh with structure inherited and identity *left to the draft* — the falsifying control for R2 |
| **R2** V2V + original refs (the hypothesized strongest) | R1 + canonical character sheet in `ref_images` (wired first), `subject_definitions`: identity always from the Pictures, structure from `<Video 1>`; draft audio attached `fully_copy` or regenerated (sub-arm) | same as R1 + image-ref tokens (negligible: ~1 k rows/image at `match`) | **Identity re-anchor from ground truth** — the C3 claim |
| **R3** segmented re-gen (per-beat) | beats re-genned independently in per-beat windows (39/56 f class — the "shorter source" regime), composed per-window prompts from the layered timeline (durable layers verbatim + beat layer), **per-window embeddings precomputed and cached** (overlap doc §0.2 — all compositions known at compile time; R1's identical-prompt case caches once for the whole pass); beats decoupled by construction → beat re-rolls don't propagate downstream (locked-chains synergy); joins re-made by existing machinery (cut / FLF splice / S) | same total frames as R1; smaller packed seq per pass; parallelizable; per-window fixed overhead (TE/VAE/ref encode) amortized by the embedding cache | Window-length axis (shorter-sources-preserve-better) + beat granularity + the prompt-timeline interplay |
| **R+S** combined-best candidate | R3 (or R1-windowed) for global refresh + **S** seam re-denoise at the re-join joints (R's only created defect) | R cost + S strip cost | Global bias-attack (R reaches window *interiors*, S's explicit blind spot) + local joint doctor — the two compose because they own disjoint surfaces (§6) |

### 5.1 Golden domains (added to the suite's axes)

- **THE falsifier — identity-in vs identity-out over segment count.** Per
  window/beat *k*: `identity-in(k) = ArcFace(re-gen_k frames, canonical ref
  sheet)`; `identity-out(k) = ArcFace(re-gen_k, draft_k)`. **R2's claim**
  (C3): identity-in ≥ 0.25 (verification floor) for all k, flat in k, and
  identity-in > identity-out — identity comes from the refs, not the draft.
  **Falsified** if identity-in tracks the draft's own decay curve (walks
  with k in lockstep) or sits below floor — the re-anchor does not happen
  and R2 collapses to R1. **R1's prediction** (from E5/E-ED1): identity-out
  > identity-in, identity-in walking with k; if R1 unexpectedly passes,
  refs are redundant for identity and the simpler arm wins. Either outcome
  is a decision, which is what makes this the suite's cheapest
  high-information readout.
- **Quality refresh:** high-frequency energy / sharpness of re-gen vs draft
  and vs a fresh same-prompt render (noise floor ±0.039 ArcFace / ±0.38 dE
  render-to-render); **over-smoothing check** if R is iterated (each pass is
  one SDEdit-class projection; repeated low re-noise is a low-pass — measure
  texture vs floor before ever re-gen-ing a re-gen).
- **Color re-anchor:** L*/dE trajectory of re-gen vs draft (does the
  drift-darkened draft pull the output dark?) and vs segment-1 statistics —
  the loopforge grading-transfer prediction, per arm.
- **Structure retention:** motion plan-following error vs the draft + the
  content-drag check (does the re-gen lose the draft's beats — the E5
  hallway-beat metric; re-gen must be structure-*faithful*, not
  structure-*inspired*).
- **Audio:** treble retention + join correlation for the reused
  (`fully_copy`) vs regenerated sub-arms; cover-band check at reuse.
- **Seam visibility** where windows re-join: existing blind-read + objective
  joint-metric domains (R's created surface).
- **Cost column:** per-arm wall-clock and runway-per-axis ÷ cost; honest
  floor below.

### 5.2 Cost model (honest numbers, our resolutions)

Maintainer-validated RTX 3090 24 GB table (VDN 8-step, speed doc §1.4):
15 s @ 0.4 MP ≈ 3:21 sampling; 10 s @ 0.8 MP ≈ 5:18 (→ 15 s @ 0.8 MP ≈ 8:00
by per-step interpolation, 39.84 s/step). These are **FL2VA-route numbers
with no video ref**; a same-length ref adds ~56 % packed tokens at matched
resolution (§2.2), so treat them as a **floor** — step-time multiplier
≥ 1.5× linear-token bound under dense attention, less under VDN sparse;
**unmeasured, the R-probe measures it** **[DOC-measured floor + SPEC bound]**.

Per-pass overheads: one VAE encode of the draft window (ref encode); TE
encodes = one per *distinct composed prompt* (R1: one total — identical
prompt every window; R3: one per beat composition, precomputable in one
pass before sampling, then the 32 B encoder unloads — the §0.2 win).

Worked example, a 60 s chain (4× 15 s windows): floor ≈ 4 × 3:21 ≈
**13.5 min @ 0.4 MP**, ≈ 32 min @ 0.8 MP, before ref-token overhead —
realistically ~20–35 min @ 0.4 MP **[SPEC-bound]**. Context: one chain hop
is ~1–2 min; an S strip pass is a fraction of one window. **R is a global
second pass at ~1× the chain's original generation cost — the priciest
mitigation in the matrix, justified only if it buys what nothing else does:
window-interior re-projection.**

### 5.3 Falsifier-first cheap probe (existing machinery, before the matrix)

1. **Source:** one degraded 124 f segment from the suite's own baseline arm
   (arm-A chain output at hop ≥4 — already scheduled) or the tranche-2 E5
   ref_video chain tail; zero extra gens for the source.
2. **Arms:** R1 vs R2, one window, one seed, hybrid base (E-ED1), 0.4 MP.
   **2 gens total.**
3. **Readout (all CPU):** identity-in / identity-out, dE/L* re-anchor,
   HF-energy refresh vs floor.
4. **Decision:** R2 fails to re-anchor → the C3 strong form dies cheap, R1's
   value question remains (quality refresh alone); R1 unexpectedly re-anchors
   identity → refs redundant, R1 wins on simplicity; both behave → full
   matrix proceeds with R3's window-length axis as the next cheap split.
   **Prerequisite flag (tranche-1 ops):** insightface is absent on the
   testbed — install before any identity-metric arm; run under the 8189
   runbook when the GPU window opens.

## 6. Interplay with the matrix

- **S is local, R is global — disjoint surfaces, stackable.** S (seam
  re-denoise) explicitly "corrects only what it re-noises": joints, not
  interiors. R re-projects *entire windows* through the trained conditional
  prior (the rolling-refine regime the overlap doc §2.5 named — R is that
  regime with a *reference* prior instead of partial noise, and it is the
  only mechanism in the matrix that reaches interiors). R's one created
  defect — re-join seams between independent re-renders — is exactly S's
  surface: **R+S is the combined-best candidate** (arm G v2: winner R + S at
  joins + payload + per-join stabilize + frozen audio).
- **R3 × prompt timeline:** the precomputed per-window embedding cache is
  R3's enabling machinery (all beat compositions known at compile time; beat
  re-rolls re-encode only changed compositions). R3 is also the natural
  first customer of the chain manager's regenerate-downstream model: beats
  are independent re-gens of a fixed draft, so a beat re-roll replays
  everything else bit-stably (cached embeddings + fixed seeds) — cleaner
  than chain re-rolls, which propagate.
- **Versus arms B/C (payload/re-anchor@4):** B/C mitigate *during* chain
  growth; R repairs *after the fact*. If R2 measures well, the product
  policy becomes: generate cheap long (B/C), finish with one R pass — the
  "render draft, re-anchor final" pipeline the maintainer's hypothesis
  describes. If R2 measures poorly, chain-side re-anchor (C) keeps the job.
- **Honest ceiling:** R output is R2V-class soft (AMA) even at best — the
  finish pass buys *identity re-anchor + drift reset + texture refresh*,
  not I2V crispness; hybrid + (optionally) a stills-model detail stage are
  the known ladder above it.

## 7. Verdict table

| Question | Verdict |
|---|---|
| **C1 — length premise** | **CONFIRM (mechanism), constraint renamed.** No context bottleneck, no per-hop accumulation: the whole source rides as never-denoised, fully-attended rows; windowed re-gens are independent by construction (sequential exposure bias → parallel re-render). The binding constraints are per-pass: ~5–15 s trained envelope on source *and* target, ref-truncation-to-target (segmentation above 15 s is architecture-forced), +~56 % packed tokens at matched length (quadratic attention), and preservation fidelity decaying with source length (Runware, verified live). "No time constraint" is true per pass, not per take. |
| **C2 — inheritance** | **Per-axis.** Structure: inherited (the route's product). Texture: re-sampled (semantic regeneration; E-ED1 10–13 dB class) but capped at R2V-soft (AMA; hybrid mitigates, E-ED1 measured). Color/exposure: partially inherited (reference-statistics transfer, loopforge). Identity: not self-healed (E5 0.12; identity not gradeable) — needs C3. Audio: regenerated or reused by explicit wiring. No ref-strength dial ships anywhere — influence = prompt discipline + native `visual_cond_noise_aug` (0.999 default, unexposed). |
| **C3 — refs-alongside** | **Lane confirmed:** official combined-asset pattern, shipped LongMedia mode, First Date practice, Viggle industrial form; our builder wires images+videos+audio in one conditioning today (workflow.ts:184-201). Interference catalog: softness compounding, ordering trap, standalone-Picture loss, compound-task risk (measured by R1-vs-R2), audio re-attach. The degradation-source cell is unmeasured anywhere (E7 never ran) — R2 absorbs it. |
| **The R-arms** | **ADOPT into the matrix:** R1 (control + quality refresh), R2 (the C3 claim), R3 (segmented — the only legal form above 15 s and the prompt-timeline's first customer), R+S combined-best candidate. 2-gen falsifier-first probe before the matrix. |
| **Correction landed** | Overlap doc's "ref-strength 0.59" was `target_megapixels=0.59`; the pack has no strength input. O-soft's dial survives on `visual_cond_noise_aug`. (Addendum 3 there; §2.3 here.) |

## Sources

**Code (shared install, read-only, 2026-09-25):**
1. `comfy_extras/nodes_minimax_h3.py` — MiniMaxH3ReferenceToVideo (limits, truncation, 2 fps Qwen view, audio pairing), tooltips ("2-15s", "trained range ~124-362"), AddGuide
2. `comfy/ldm/minimax/model.py` — PackedLayout (ref rows never denoised, own temporal span), FRAME_PER_TOKEN, VISUAL_COND_TIMESTEP, `_cond_video_rows` (visual_cond_noise_aug)
3. `src/lib/workflow.ts:184-232` — our reference-lane and guide wiring

**Pinned workflow dissections (2026-09-25):**
4. MisterAzor1/ComfyUI-H3-Overlap @ `e2f2bc6` — example workflow JSON: `AIToolkitMiniMaxH3RefVideo` widgets `[0.59, 0]`, `MiniMaxH3ReferenceToVideo` `['', 672, 384, 107, 'match']`
5. ostris/ComfyUI-AIToolkit-MiniMaxH3 — nodes.py: schema is `video / target_megapixels 0.01-4.0 / max_length 0-3600`; no strength input

**Internal (our measurements and captures):**
6. `docs/research/h3-instruction-based-editing.md` — the edit contract (semantic regeneration, preservation-clause gating, shorter-sources, E-ED1 hybrid measured)
7. `docs/research/h3-transitions-and-latent-continuity.md` — E5 handoff triangle (ref_video identity 0.12), loopforge grading-transfer, AMA admissions, E7 designed-not-run
8. `docs/research/h3-sampler-shaping-and-motion-control.md` — HF #65 low-res→Ref2VA re-render workaround (the degraded-draft-as-ref precedent)
9. `docs/research/speed-quality-and-imagegen-paths.md` §1.4 — the measured 3090 wall table (cost floors)
10. `docs/research/h3-overlap-concept.md` — the O/S/G arm frame, window-context invariant, prompt-timeline precompute (this doc's R-arms extend it)
11. `docs/library/minimax-h3-prompt-guide-ref.md` — combined-asset subject pattern, retention markers, video-editing task types
12. `docs/library/comfyui-minimax-h3-native.md` + `comfyui-minimax-h3-overview.md` — R2V limits (9/3/3), ~15 s output, ref2va vs fl2va weights

**Upstream (live-verified 2026-09-25):**
13. Runware MiniMax H3 editing guide — "a shorter source gives the model less to preserve"; text/logos/crowds drift; one change per call — https://runware.ai/docs/models/minimax-h3/guides/editing-video
14. MiniMax H3 team AMA summary — R2V softer than I2V; reference-continuation drift admission — https://www.reddit.com/r/StableDiffusion/comments/1vkplzt/
15. HF discussion #65 — adherence collapse above ~576p; low-res draft → reference re-render — https://huggingface.co/MiniMaxAI/MiniMax-H3/discussions/65
16. Viggle-Animate (H3-ref2va full finetune for driving-video + identity) — https://huggingface.co/Viggle/Viggle-Animate
