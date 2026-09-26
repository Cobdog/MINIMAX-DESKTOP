# Viggle — the full surface re-verified: the gate, two new families, and the techniques

> Flux task: **ul1l4j7** (Viggle-Animate support — gate re-verification; the coordinator
> owns task placement for the new families this pass surfaces). Date: **2026-09-25**.
> Maintainer prompt: *"Viggle has some strong models and techniques that should likely be
> adopted by us as well."* (2026-09-25). Our prior record: task ul1l4j7's gating comment
> (lead-verified 2026-09-14), the watch-tier rows in
> [node-pack-registry.md](node-pack-registry.md) / [h3-node-ecosystem-sweep.md](h3-node-ecosystem-sweep.md)
> #6/#109, §4.2 of [h3-instruction-based-editing.md](h3-instruction-based-editing.md),
> §3 prior-art of [h3-v2v-reanchor.md](h3-v2v-reanchor.md) (yesterday).
>
> **METHOD:** web + API reading only — **no GPU, no engine, no installs, nothing
> downloaded.** HF model API (org listings, per-repo metadata with file sizes and commit
> history, raw READMEs/LICENSEs/MODIFICATIONS), GitHub API, viggle.ai pages, web search,
> and a full read of Viggle's own 205-line `inference/sample.py`. Evidence tags:
> **[DOC]** verified in shipped code/official source, **[COMM]** reputable community
> finding, **[SPEC]** plausible-unverified, **[UNK]** nobody knows. **[MAINTAINER]** =
> maintainer hands-on. Fresh-release doctrine applied: every release below is ≤ 4 weeks
> old, so community metrics are recorded as noise only.
>
> **Read at (2026-09-25):** `Viggle/Viggle-Animate` @ `9cd946f` (card lastMod 2026-09-18,
> created 2026-08-31) · `Viggle/Meridian` @ `9c57d46` (lastMod 2026-09-19, created
> 2026-09-14) · `Viggle/Qwen-Image-2.1-viggle-turbo` @ `bb26a0f` (lastMod 2026-09-25,
> created 2026-09-22; v0.2.1 dated 2026-09-24) · `drbaph/Viggle-Animate-ComfyUI` (last
> commit 2026-09-07 "Update README.md", full commit history read) ·
> `Abiray/Viggle-Animate-pruned-GGUF` (lastMod 2026-09-13) · `Abiray` org listing ·
> `facebookresearch/vggt-omega` (FAIR Noncommercial Research License v1) · Viggle
> research write-up + `viggle.ai/h3` (product surface). Reddit/X [COMM] links in Sources.

---

## 1. THE GATE (task ul1l4j7) — **OPEN**

The blocker was *"GATED on an int8 convrot checkpoint: none shipped, bf16 only ≥96GB,
producible locally via the community quant pipeline or wait for community quants."*
**That record is now CORRECTED on its central fact, and the task unblocks by fetch —
no local quant production needed.**

- **`drbaph/Viggle-Animate-ComfyUI` ships exactly the gated artifact** — commit-dated
  2026-09-05/07, i.e. **eight days before our 2026-09-14 "none shipped" record** [DOC —
  HF commit history]:
  - `minimax_h3_ref2va_viggle_int8_convrot.safetensors` — **47.03 GB** (the literal
    int8-convrot checkpoint the task waited for);
  - `minimax_h3_ref2va_viggle_pruned_int8_convrot.safetensors` — **21.03 GB** (the
    24 GB-class variant, drbaph's "VRAM-friendly option");
  - `viggle_animate_dmd_lora_r64.safetensors` — **0.94 GB** rank-64 cut of the DMD2
    LoRA ("recommended" over the 3.77 GB full-rank);
  - `fixed_embed_fwd_anyframe.safetensors` — the frozen text conditioning in
    Comfy-loadable form. 73.5k downloads today (noise per doctrine, but it is not an
    obscure artifact — the miss was ours).
- The official Viggle repo itself **still ships bf16 only** (14 shards, 61.7 GiB
  transformer, peak 80.1 GiB at 480×832/124f → "≥96 GB or `--offload`"; internal
  deployment is NVFP4 on a 5090, unshipped and NVFP4 is excluded by maintainer policy
  anyway) [DOC — card]. The gate record was right about the *card* and wrong about the
  *ecosystem*: drbaph's conversion landed 09-06.
- **What "pruned" means is undocumented by drbaph** [UNK in his README]. Arithmetic
  pins it: the card states **13.0 B of the 33.1 B parameters sit in `adaln_proj`**,
  which linear-layer quantizers do not touch [DOC] — 47.03 GB ≈ int8×20.1B + bf16×13.0B,
  and 21.03 GB ≈ int8×20.1B + *low-rank* `adaln_proj`. That is, "pruned" replicates
  Viggle's own published 5090 recipe (int8 + low-rank adaln_proj) [SPEC —
  arithmetic-consistent, unverified against tensors]. Quant/low-rank damage is exactly
  what VG-1's first arm measures before anything is wired into the app.
- **Native support is already ours:** ComfyUI has officially loaded convrot-int8
  models since v0.27.0 (we run 0.34.0) [COMM — release thread; consistent with our own
  record: the maintainer already runs int8-convrot VDN stages and the
  `matlowai-fused-turbo-int8-convrot` fetch row]. GGUF fallback also exists:
  `Abiray/Viggle-Animate-pruned-GGUF` Q3–Q6, 8.9–16.7 GB [DOC — repo; "TESTING"
  disclaimer].
- **One real gap for wiring:** the ComfyUI node pack both the Viggle card and drbaph
  link — `Saganaki22/ComfyUI-Viggle-Animate-H3` — is **404 at read time** (repo and
  user listing gone; the r/comfyui thread that announced it still stands) [DOC — 404s;
  COMM — thread]. The conditioning layout it provided is small enough to be ours:
  Viggle's own inference is stock diffusers `ref2va` plus two monkey-patches (§3.1,
  §3.5) — a graph-factory job, not a dependency. Per the modularity contract that is
  the preferred shape anyway.

**Bottom line: ul1l4j7's build condition ("int8 convrot lands — produce or fetch") is
met by fetch.** Remaining gate is ordinary: measured quality of the pruned artifact
(VG-1) and the "after the editing experiments establish where propagation beats
in-model R2V edits" sequencing already written into the task.

---

## 2. The full Viggle surface — three open families + a hosted H3 product

Viggle is simultaneously **MiniMax's customer and its most prolific H3 finetune shop**:
their hosted product (`viggle.ai/h3`) literally runs **MiniMax H3** as its engine
(model picker "MiniMax H3 — one model for every modality", 16:9 / 5 s / 768p / Flash
mode), while their research org ships open H3 derivatives [DOC — product page].

### 2.1 The open-weights lineup (whole org, HF API 2026-09-25)

| Model | Created | What it is | Weights form | License |
|---|---|---|---|---|
| **Viggle-Animate** | 2026-08-31 | Character replacement from a single repainted frame: driving video + one repainted frame → video; motion/camera/timing untouched. 33.1 B **full finetune** of H3 `transformer_ref` + rank-128 DMD2 LoRA (3 forward passes). No pose estimator, segmenter, face tracker, or text encoder. | 61.7 GiB bf16 transformer + 2.5 GB LoRA (frozen 362×5120 embed ships as an asset) | `minimax-h3-community-license` (weights) + Apache-2.0 (code). MODIFICATIONS.md is exemplary license hygiene. |
| **Meridian** | 2026-09-14 (same day as our Animate pass — missed then) | **Geometry-guided re-camera**: VGGT-Omega builds depth+poses → colored 3-D points → render the chosen camera path (grey holes) → H3 fills/refines. Space and time as *independent* axes (orbit/zoom/slide a held moment, retime then re-camera, single-image camera moves). | **Two LoRA adapters on the unmodified H3 transformer** (teacher 2.5 GiB + turbo 2.5 GiB, loaded together, never merged) + precomputed embeds; base fetched separately | `minimax-h3-community-license` (weights) — **but the VGGT-Omega geometry dependency is FAIR Noncommercial** [DOC — license text]. |
| **Qwen-Image-2.1-viggle-turbo** | 2026-09-22 (v0.2.1 2026-09-24) | DMD few-step student of **Qwen-Image-2.1** — our assessed image model: T2I + instruction edit with 1–3 refs in **6 passes instead of 40, no CFG**, ~5× end-to-end. Rank-256/128 LoRAs, sigma nodes shipped, ComfyUI workflows + node file shipped by the authors ("vibe-coded… expect rough edges"). | LoRA only (1.3 GB r256 / 680 MB r128) | **`qwen-research`** — same non-commercial class as the base family verdict already recorded in [qwen-image-2.1-assessment.md](qwen-image-2.1-assessment.md). |

### 2.2 What is new since our 2026-09-14 record

1. **Meridian** (09-14) — new family, §2.1 above; nothing of ours covers this cell.
2. **Qwen-Image-2.1-viggle-turbo** (09-22 → v0.2.1 09-24) — new family landing on an
   already-ADOPT-candidate lane of ours.
3. **Viggle-Animate card updates through 09-18** [DOC]: the *lip-sync weakness was
   retracted and fixed at inference time* — the `--audio` clean-row pin (§3.5, the
   most immediately transferable technique in this whole pass); an `anyframe` frozen
   embedding (`fixed_embed_fwd_anyframe.pt`) replacing the frame-count-fixed embed;
   community section (a 1.5M-view X post); demo assets.
4. **"We are training a substantially better model right now, aimed squarely at what
   is left"** (complex scenes, multi-character, re-entry identity) — an Animate v2 is
   coming; do not over-invest in v1-specific wiring [DOC — card].
5. The hosted surface wrapped H3 (`viggle.ai/h3`): Mix (free), Motion Control,
   Multi-Track, PINOC (capture motion), Character Refine, Real-Time Swap, hosted
   Animate (free), Video/Image Gen, Games, API. API docs 403'd to bots this pass —
   current API lineup [UNK]; hosted-only, so not adoption-relevant beyond one use:
   **the free hosted Animate is a zero-install oracle for VG-1 expectations** [COMM].

### 2.3 License posture, per family (the §4.3 registry rows when adopted)

- **Animate:** MiniMax H3 Community License — *same class as our base stack*,
  territory-resolved, with a consent/intended-use section that reads like our own
  consent surfaces ("identity comes from the frame you paint… cannot verify identity
  or consent… label output AI-generated") [DOC]. Code Apache-2.0. drbaph's
  conversions carry the same license forward explicitly [DOC — his README].
- **Meridian:** weights H3-community — but the pipeline *requires* VGGT-Omega
  (FAIR **noncommercial** research license) for the geometry stage. Personal/research
  use clean; **any commercial posture is gated on a separate VGGT-Omega replacement**
  (their own card says the code license "does not remove VGGT-Omega's noncommercial
  restrictions") [DOC].
- **Qwen-turbo:** Qwen RESEARCH LICENSE (read in full this pass): **non-commercial
  only** ("research or evaluation purposes only"; commercial requires a separate
  Tongyi license), "Built with Qwen" attribution duty for derivatives, no primary-name
  use. Same verdict class the Qwen-2.1 family row already carries; `flaggedLicense()`
  already handles the id.

---

## 3. The techniques — adoptable without any Viggle weights

Ordered by transfer cost (cheapest first). §3.1, §3.4, §3.5 run on our stack *today*.

### 3.1 Repainted-own-frame references (the conditioning geometry) — the R2 cell

Code-read of `inference/sample.py` [DOC]: the wiring is **stock ref2va** — driving
video enters as the `MiniMaxH3VideoReference` (structure/motion/camera/lighting rows),
the repainted still as the `MiniMaxH3ImageReference` (appearance rows), and the text
encoder is bypassed by replacing `MiniMaxH3Ref2VATextEncoderStep.__call__` with a
frozen 362×5120 tensor. Two inputs, zero extractors. The reference works *because it
is a frame of the clip* — pose, camera, framing, lighting already agree, "nothing
downstream has to align them again"; the still is passed **without a frame index** (no
temporal binding — pick whichever frame shows the character clearest, front-on,
unoccluded); "bind any new limb to a real one" and name what must not change [DOC —
card + code].

**Transfer to us:** our R2 refs-alongside arm
([h3-v2v-reanchor.md](h3-v2v-reanchor.md) §4) conditions identity with *standalone
character sheets*. Viggle's industrial form says **a repaint of a frame of the footage
is the stronger identity reference** — pre-aligned by construction. That is a one-line
change to the R2 arm design and it is testable this week with zero new weights (VG-2b).

### 3.2 Two-teacher noise-split DMD

The distillation is "joint, across two teachers split by noise level": the **task
finetune supervises the high-noise end** (where replacement is decided), the **base
model supervises the low-noise end** (where detail/texture are decided) — "distilling
each end against the teacher that owns it keeps both properties in one student,
instead of inheriting the finetune's visual regressions along with its replacement
ability" [DOC — card]. Relation to our stack: our turbo/VDN students distill *base*
models, so this bites the day we distill a task-finetuned H3 (an edit-tuned, hybrid,
or control-tuned teacher): one teacher throughout would bake the task model's texture
regressions into the student; the split keeps base-model texture. Same family as the
DMD/turbo lane, orthogonal to HyperFlow's flow-map axis (distribution matching vs
interval transition learning — the two axes can stack in principle) [SPEC].

### 3.3 Segment-cut sampling (from the Qwen turbo card)

The v0.2.1 student was **trained on a 4-step schedule but sampled at 6 by subdividing
the highest-noise segment into three** — same weights, "strictly better on every
metric we track" (removes the detail loss, ghosting, and composition drift of the
plain 4-step rollout); their measured honesty: diversity 0.98× base (v0.1 collapsed to
0.75×), composition drift 0.000, 0% layout-differs [DOC — card]. **Transfer:** a
schedule-side arm on our existing 4-step turbo/VDN LoRAs — subdivide the first segment
— costs nothing to try on hardware we already run (test folded into VG-3's lane).

### 3.4 Never-merge distillation LoRAs — third independent confirmation

Meridian: "merging is lossy in bf16, and for the turbo it is fatal — its update is ~2
orders of magnitude below bf16's rounding step"; Qwen-turbo: "the LoRA is never
merged… loading it at runtime is exact"; HyperFlow made `disable_hyperflow()` exact
for the same reason. Three independent teams, one doctrine [DOC ×3]. CONFIRMS the
posture our LoRA-form-compatibility work already holds: distillation deltas ride
unmerged.

### 3.5 Clean-row audio pinning (`--audio`) — the retraction's payload

The lip-sync "weakness" was a configuration artifact: the fixed prompt asks for
silence, so there was nothing to sync to. The fix is pure inference-time conditioning:
encode the driving clip's audio with the audio VAE and **hold it in the *target* audio
rows as a clean latent (t = 1.0 in H3's reversed flow convention) for the entire
denoise** — the audio rows stop being predicted and become conditioned-on; the mouth
tracks that speech; the output track is the input round-tripped (46 dB, peaks rounded
0.95→0.76 — that round trip is their pin-is-real evidence) [DOC — card]. In code it is
two monkey-patches: `build_row_timesteps` forced to 1.0 for the audio rows, and the
scheduler stepping only `latents[n:]` past the condition-video rows [DOC —
`sample.py`]. Explicitly an **untrained state that holds up** — same epistemic family
as our latent-fork/E4 findings. **Transfer:** our graph factory can pin Audio1 clean
in any V2V edit or chain link today — no Viggle weights. Complements (does not
duplicate) LongMedia's `audio_mode: preserve`, which *copies the track*; the pin makes
audio a conditioning input to joint video+audio generation, which is the stronger
lever precisely where lip-sync matters (VG-4).

### 3.6 Paint-then-propagate as the division of labor

"State-of-the-art image models have finished that job… this model is the second half
of that pipeline, not the whole of it": dedicate the video stage to propagation, keep
edits in the image editor upstream. This is the industrial form of our
frame-edit→propagate primitives (crop→refork/Focus, the E-ED ladder) — and of our
three-surface workshop split (edit surface / video surface). Also validates the
**no-text-encoder inference shape** (frozen embeds: one less 4B-class resident model,
faster loads — dovetails with our 4B-TE trap knowledge) [DOC — card; our priors].

### 3.7 Geometry-render conditioning (Meridian's method)

VGGT-Omega → colored 3-D points → render the requested camera path with grey holes →
video model inpaints/refines against input frames + render; **camera and time become
independent axes**; the render is fast enough to **preview the camera path before
spending video-model passes** [DOC — card]. For our camera-paths lane this is a
pattern adoption: explicit geometry + generative refinement beats camera-conditioning
tokens for *re-observing existing footage*, and the preview step is a UX worth
stealing whenever a slow generative pass consumes a cheap proxy (our PreviewOverride
pack is the same instinct).

---

## 4. Fit to our lanes

### 4.1 The motion-control map after this pass

| Lane | Input contract | Strengths | Gaps the others cover |
|---|---|---|---|
| **Fun Control (union)** — incumbent | Extracted signal videos (DWPose/depth/canny; RGB batch, 17n+5 grid, ≤15 s); strength windows | Authored/extracted control, partial strength, any H3 output | Pose data is **human-only** [DOC]; non-human generalization UNK pending E-FC1; identity comes from refs/prompt, not an edit |
| **IK rig** (planned, small) | Keypoints → skeleton render → Fun Control | Parametric authoring, no source footage needed | Human skeleton only |
| **Camera paths** | Prompt-level today; Meridian-shaped lane now visible | — | No geometry grounding yet; Meridian is the candidate pattern (§3.7) |
| **Viggle propagation** (this pass) | Driving video + repainted frame (of the clip) | Whole-scene motion+camera transfer; **identity via upstream image edit** (composes with our Krea/Qwen edit lanes); **non-human by construction** ("bounded by what you can paint"); 3 forwards; fast motion is its stated best case | No authoring (motion must exist as footage); no partial control (no masks/strength); complex scenes/multi-char/cuts are its stated weak spot; re-entry identity drift [COMM — drbaph]; specialized 33 B resident model |

**Call: complementary, not competing.** Propagation fills the one cell none of our
lanes touch — *recast existing footage with an edited identity, including non-humans*
— and it fills it by composing with surfaces we already have (image-edit surface
upstream, video engine downstream). It does not displace Fun Control (authored motion)
or the rig. The adoption shape is a fourth motion lane plus an R2 re-anchor model.

### 4.2 R2 identity re-anchor (yesterday's drift-envelope work)

h3-v2v-reanchor.md already lists Animate as "a 33B ref2va finetune for precisely this
geometry — the refs+video conditioning cell our R2 arm needs measured." This pass adds
the specifics: the identity-in mechanism is *the image-reference rows*, exactly our
refs-alongside lane; envelope compatibility is good (124 f / ~5.2 s default ≈ our
per-pass envelope; `anyframe` embed loosens the fixed-length constraint [SPEC — name +
asset]; 0.4–0.98 MP tested canvas [COMM — drbaph]). The retraction's lesson transfers
directly: the R2 falsifier (identity-in vs identity-out) should carry an **audio
sub-falsifier** — a re-anchored link must either pin or regenerate its audio
deliberately, never inherit the fixed-prompt silence path (§3.5).

### 4.3 What adoption requires per our conventions (when it lands — not in this docs commit)

- **Family-registry entries + fetch-consent rows** (weights never enter the repo; the
  license surfaces at consent time before any fetch): `viggle-animate` family —
  minimax-h3-community class, *same verdict as the base stack*, rows for the drbaph
  pruned-int8 transformer / r64 LoRA / frozen embed, plus the int8 video VAE (Kijai)
  it reuses; `meridian` family — same weights class **plus a separate FAIR-NC
  VGGT-Omega row flagged non-commercial**; `qwen-viggle-turbo` — `qwen-research`
  class, flagged, inheriting the Qwen-2.1 family gate. Per
  [licenses/policy.md](../licenses/policy.md) the rows land in the same commit as the
  wiring that first fetches them.
- **No node-pack dependency:** with Saganaki22 404, the conditioning layout is a thin
  graph-factory job on our existing ref2va nodes (Viggle's whole inference is stock
  diffusers + two monkey-patches, §3.1/§3.5) — modularity contract clean.

### 4.4 VRAM on 24 GB, post-quant

- **Animate:** pruned-int8 21.03 GB + r64 LoRA 0.94 GB + int8 video VAE 3.17 GB —
  the same class the maintainer already runs (int8-convrot VDN stages) [MAINTAINER];
  convrot-int8 loads natively in our 0.34.0 core. Peak with activations at 480×832/
  124f is [UNK] at our tier — VG-1 measures it; dynamic-VRAM doctrine covers the
  boundary. Ladder: pruned-int8 (21 GB) → int8-convrot (47 GB, block offload) →
  Abiray Q6 GGUF (16.7 GB). Reference point: 26 s/clip for 3 forwards on one B200
  [DOC]; expect minutes-class with offload [SPEC].
- **Meridian:** *adapters on the base we already host* — no second resident
  transformer, 2×2.5 GB LoRAs + VGGT-Omega checkpoint. But the reference impl is
  bf16-and-no-offload with **82–113 GiB peaks** and explicitly invites 4090-class
  adaptation ("integration targets, not supported configurations") [DOC]. A 24 GB run
  is a port job onto our quant stack, not a download — which is why Meridian's
  *method* adopts now (§3.7) and its *weights* stay watch-tier with concrete revisit
  triggers (community ComfyUI port or quants; VGGT-Omega relicensing; our camera-lane
  build starting).
- **Qwen-turbo:** 1.3 GB LoRA on the Qwen-2.1 stack already assessed
  (int8-convrot DiT+TE ~17.3 GB resident) — trivially inside budget.

---

## 5. THE TESTS — per the adoption epistemology (directive 426ab190)

**Status: PROPOSED-PENDING-TEST.** All arms run on the 8189 testbed per the runbook
when scheduled; suite candidates are new arm-sets on the existing benchmark harness
(`ref2va-bakeoff` / E-ED / tier-ladder families), not new machinery.

**VG-1 — Animate propagation vs the incumbent motion lanes.** *Theory, as a testable
claim:* at matched canvas (~0.45 MP, 480×832-class) and 124 f, fixed seeds, on a fixed
8-clip board (4 human incl. one fast-motion + one re-entry case, 2 non-human, 1
multi-character, 1 prop/scene swap), Viggle-Animate (pruned-int8 + r64 LoRA, 3
forwards, euler/shift 3.0 per drbaph's tested recipe) delivers higher motion fidelity
and equal-or-better identity-vs-reference than (A) Fun Control with DWPose extracted
from the same driving clips and (C) base-H3 R2V edit with character-sheet refs — while
(A) retains partial-strength control and (C) scene generality that (B) lacks. Metrics:
per-frame DWPose keypoint error vs the driving clip (human clips), character
similarity to the painted ref (ArcFace/DINO class, our E-series tooling), our
dB-quality class, peak VRAM, wall s/clip. The non-human clips double as **E-FC1's
adjacent evidence** (Fun Control pose is human-trained; its failure/hold there
settles both rows). *Fallback ladder:* pruned-int8 quality collapse → 47 GB int8
block-offload arm → Abiray Q6 → the lane stays Fun Control + R2V and Animate returns
to watch.

**VG-2 — the R2 identity falsifier, three reference geometries.** On a degraded chain
segment (the drift-envelope suite's material): (a) R2 refs-alongside with standalone
character sheet, (b) **R2 with a repainted frame of the footage as the reference**
(§3.1 — runs today, no Viggle weights), (c) Animate repaint-propagate. Measure
ArcFace-per-hop vs the chain head + structure hold. *Claim:* (b) ≥ (a) on identity
without losing structure; (c) ≥ (b) at the cost of a specialized resident model. If
(b) holds, the R2 arm ships improved regardless of Animate's own verdict.

**VG-3 — Qwen-turbo on our image lane.** Matched arms: Qwen-Image-2.1 base 40-step
vs viggle-turbo v0.2.1 6-step (r256 and r128 cuts) on the Workbench-candidate recipes
including the edit ladder; columns: identity/multi-ref fidelity, dense-text sharpness
(the authors' conceded gap), complicated-edit success (their stated limit — our
falsifier), wall s/image, VRAM delta. Cost-scored: a ~5× wall claim must survive our
end-to-end timing (their 5× includes prompt-enhancement removal). *Fallback:* edits
degrade → turbo pinned to T2I-only lanes; base stays for edits; r128-vs-r256 decides
the fetch row.

**VG-4 — clean-row audio pin on our stack (no new weights).** V2V edit arm with
Audio1 pinned clean at t=1.0 for the whole denoise (graph-factory change, §3.5) vs
LongMedia `audio_mode: preserve` vs default regenerate, on talking-head sources;
measure dialogue survival (round-trip dB, lip-sync on output, cover-band check at
link boundaries). *Claim:* the pin matches preserve on audio survival and beats it on
lip-sync, at zero extra cost. *Fallback:* untrained-state instability on our recipes →
keep preserve; the pin stays documented for chain links where preserve is unavailable.

---

## 6. Verdicts (fresh-release menu; models and techniques verdict separately)

| Thing | Verdict | One line |
|---|---|---|
| Gate record "no int8 convrot shipped" | **CORRECT** | drbaph shipped int8_convrot + pruned-int8 on 2026-09-05/07, eight days before the 2026-09-14 record; task ul1l4j7 unblocks by fetch |
| Viggle-Animate weights (via drbaph quants) | **ADOPT** | Gate open; the recast-footage/non-human motion cell no lane of ours covers; gated on VG-1 quality of the pruned artifact and the task's own "after E-ED" sequencing |
| Repainted-own-frame references | **ADJUST** | Changes the R2/E-ED reference-selection design today — test clip-derived repaints vs character sheets (VG-2b, no new weights) |
| Two-teacher noise-split DMD | **ADOPT** | The recipe for distilling task-finetuned H3s without inheriting their texture regressions — bank it for the first finetune we distill |
| Segment-cut sampling (4→6 via first-segment subdivision) | **ADOPT-candidate** | Zero-cost schedule arm on our existing 4-step turbo/VDN LoRas; folded into VG-3's lane |
| Never-merge distillation LoRAs | **CONFIRM** | Third independent confirmation (HyperFlow, Meridian, Viggle) of the unmerged-delta doctrine our LoRA-form work holds |
| Clean-row audio pin | **ADOPT** | Four lines of conditioning logic on our stack today; the strongest immediate transfer of the pass (VG-4) |
| Meridian method (geometry-render + preview; camera/time independence) | **ADJUST** | The camera-paths lane should be designed around explicit geometry + generative refinement, with cheap preview before expensive passes |
| Meridian weights | **NONE** (watch, triggers recorded) | Adapters-on-base is 24 GB-friendly in principle, but no ComfyUI path, 82–113 GiB reference impl, and a FAIR-NC geometry dependency gate commercial posture; revisit on community port / relicensing / camera-lane build |
| Qwen-Image-2.1-viggle-turbo | **ADOPT** | 5× on an already-adopt-candidate family, same license class, author-shipped ComfyUI path; gated on VG-3 (their own conceded limits are the falsifier) |
| Viggle hosted product / API | **NONE** | Hosted-only; one use — the free hosted Animate as a zero-install expectations oracle for VG-1 |

---

## Sources (retrieved 2026-09-25 unless noted)

1. [Viggle/Viggle-Animate](https://huggingface.co/Viggle/Viggle-Animate) — card @ `9cd946f`, README + MODIFICATIONS.md + `inference/sample.py` (full read) + file listing.
2. [Viggle/Meridian](https://huggingface.co/Viggle/Meridian) — card @ `9c57d46`, README + `docs/installation.md` (VRAM figures, license caveats).
3. [Viggle/Qwen-Image-2.1-viggle-turbo](https://huggingface.co/Viggle/Qwen-Image-2.1-viggle-turbo) — card @ `bb26a0f`, README full read + LICENSE (Qwen Research License, full text).
4. [drbaph/Viggle-Animate-ComfyUI](https://huggingface.co/drbaph/Viggle-Animate-ComfyUI) — README + file sizes + commit history (2026-09-05/07).
5. [Abiray/Viggle-Animate-pruned-GGUF](https://huggingface.co/Abiray/Viggle-Animate-pruned-GGUF) + Abiray org listing (the community quant shop behind our int8-convrot pipeline).
6. [facebookresearch/vggt-omega](https://github.com/facebookresearch/vggt-omega) — FAIR Noncommercial Research License v1 (CVPR 2026 Oral).
7. Viggle research write-up — [viggle-animate-character-replacement-from-a-repainted-frame](https://viggle.ai/research/viggle-animate-character-replacement-from-a-repainted-frame) (pre-retraction version — still lists lip-sync as a limit; the card is newer and authoritative).
8. Product surface — [viggle.ai/h3](https://viggle.ai/h3) (hosted MiniMax-H3 engine, mode lineup). API page 403 to bots this pass.
9. Community [COMM]: [r/comfyui Viggle-Animate ComfyUI thread + the now-404 Saganaki22 pack](https://www.reddit.com/r/comfyui/comments/1w9e5i4/viggleanimate_comfyui) · [ComfyUI v0.27.0 convrot-int8 support](https://www.reddit.com/r/comfyui/comments/1uk6q5m/comfyui_v0270_now_officially_supports_convrot) · [r/StableDiffusion int8-convrot thread](https://www.reddit.com/r/StableDiffusion/comments/1uimp1j/so_is_int8convrot_the_new_hot_thing) · [@cocktailpeanut's 1.5M-view Animate post](https://x.com/cocktailpeanut/status/2097332291844399514) (card-linked) · Meridian interactive-camera community work (Linoy Tsaban / @multimodalart, X, 2026-09-22 week).
10. Our record: task ul1l4j7 (Flux, 2026-09-14) · [h3-v2v-reanchor.md](h3-v2v-reanchor.md) (2026-09-25) · [fun-control-input-surface.md](fun-control-input-surface.md) · [hyperflow-assessment.md](hyperflow-assessment.md) · [qwen-image-2.1-assessment.md](qwen-image-2.1-assessment.md) · [licenses/policy.md](../licenses/policy.md) · licenses registry rows (`matlowai-fused-turbo-int8-convrot`, Viggle watch-tier row).
