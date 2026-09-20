# CrossView-Warp — Ref2VA novel-view LoRA for MiniMax-H3 (fresh-release assessment)

> Maintainer-sent HuggingFace link, assessed 2026-09-20. No Flux task at capture
> time (maintainer places those); this note is the candidate record for the
> post-remediation arsenal pass. Sibling research:
> [h3-lora-form-compatibility.md](h3-lora-form-compatibility.md) (the
> Form-Adaptive node this must pass through),
> [h3-lora-training-envelope.md](h3-lora-training-envelope.md) (our own musubi
> measurements — cross-check in §5), [ltx-vs-h3-verdict.md](ltx-vs-h3-verdict.md)
> (LTX is removed; only the H3 side matters to us now).
>
> METHOD: lean fetches 2026-09-20 — HF model API (metadata, file tree + sizes),
> raw README, raw NOTICE/LICENSE head, plus the raw README of the sibling LTX v2
> repo the H3 card defers to for dataset details. Release is **hours old**
> (created 2026-09-20T11:10Z, lastModified 19:23Z, fetch same day) — per the
> purpose doctrine, zero community metrics are cited and none could exist.
> Claims tagged **[DOC]** (card/API/file-level verifiable), **[SPEC]** (our fit
> reasoning), **[UNK]** (not stated anywhere fetched). The 14 example videos
> were NOT watched (no engine work this session); quality claims are therefore
> unverified by us — that is the benchmark harness's job, not the card's.

## 0. What it is

A LoRA for the **MiniMax-H3 Ref2VA lane** that performs **novel-view synthesis
from video**: give it a source clip and a camera offset (azimuth / elevation —
the warp node also takes distance and keyframed orbits), and it regenerates the
same scene from the new viewpoint **[DOC]**.

Mechanism (two-channel conditioning) **[DOC]**:

1. **Geometry channel** — a *depth-warp* of the source clip into the target
   camera pose, produced by the third-party
   [ComfyUI-CrossViewWarp](https://github.com/cseti007/ComfyUI-CrossViewWarp)
   node running MoGe metric depth. Disocclusion holes (unseen geometry) render
   magenta; those regions are a **promptable surface**.
2. **Identity channel** — the original clip, carrying appearance.

The warp feeds **`MiniMax H3 Add Guide`** (`frame_idx = 0`); the source feeds
**`MiniMax H3 Reference To Video`**; warp and source resized to the same size
first **[DOC]**. The LoRA teaches the model to follow the warp's camera while
re-projecting identity from the reference and inpainting the magenta regions.
Warp and source are swappable producers — the LoRA is the engine, the warp is
just conditioning **[SPEC]**.

Critical precision, inherited from the LTX v2 sibling card whose node and
dataset this shares: **it steers the viewpoint, it does not reproject it** —
even fully visible parts come back *regenerated*, not copied; you often get
less rotation than requested; at large angles most of the frame is invented
**[DOC — LTX card, carries over as [SPEC] for the H3 port]**.

## 1. Training facts

| | |
| --- | --- |
| Base | **official `MiniMaxAI/MiniMax-H3`, ref2va strategy** — NOT a pruned/hybrid distill **[DOC]** |
| Base precision during training | **INT8 ConvRot** (quantized frozen base) **[DOC]** |
| Framework | `AkaneTendo25/musubi-tuner`, **branch `minimax-h3`** — a community branch, not the musubi dev our envelope doc measured **[DOC]** |
| Strategy | Ref2VA, `aligned_guide_indices = [0]` **[DOC]** |
| LoRA rank / alpha | **32 / 32** **[DOC]** |
| Target modules | **[UNK]** — the LTX v2 card lists attn + ff; the H3 card omits the row |
| Released checkpoint | **step 3,500 of 6,000** (deliberate early cut) **[DOC]** |
| Data | **719 self-rendered Blender scenes** (978 rendered → 772 passed gates → 719 capped 130/azimuth band); each sample = source view + target view from a second camera + MoGe-2 ViT-L metric-depth warp of source into target pose **[DOC — dataset facts on the LTX card, H3 card defers]** |
| Resolution | 512×512 × 73 frames (square, short) **[DOC]** |
| Schedule | 6,000 steps, batch 1, no grad accum, adamw8bit 1e-4 **[DOC]** |
| Measured | 20.35 s/step, 33 h 55 m, 38.4/95.6 GB peak on a 96 GB RTX PRO 6000 Blackwell **[DOC]** |

Form-Adaptive implication: trained against the full official ref2va form, so
it should load natively on our **ref2va** lane; the Form-Adaptive
full-width→curve-adaln projection engages only if we point it at a
pruned/hybrid checkpoint, same as any full-width-trained LoRA **[SPEC]**. The
INT8-ConvRot training base is the same quantized DiT family our own envelope
runs consumed — no new incompatibility signal **[SPEC]**.

## 2. Prompt contract

- **Trigger word: `crossview`** — the whole prompt is one word; optionally
  describe what should appear in the unseen (magenta) regions **[DOC]**.
- **Negative-prompt guidance: [UNK]** — not stated on the card.
- **LoRA strength: 0.8–1.0, 0.8 recommended** **[DOC]**. (The LTX sibling
  suggested pushing to 1.2–1.3 when weak; the H3 card does not repeat that.)
- Example-generation settings **[DOC]**: 124 frames; two-pass 0.5 MP → 1.5 MP,
  16:9; `res_multistep` 8 steps **with the DMD 8-step turbo LoRA stacked**;
  sigma shift 12 video / 3 audio; strength 0.8. It composes with the turbo
  stack out of the box — directly relevant to our fast stack.
- Ready-made ComfyUI workflow published in the author's dataset repo
  (`Cseti/ComfyUI-Workflows`, `minimax-h3/crossview-warp/`) **[DOC]**.

## 3. Files + license

| File | Size | Notes |
| --- | --- | --- |
| `MiniMax-H3_Ref2VA-LoRA-CrossView-Warp_v1_3500.safetensors` | **596,452,584 B (569 MiB)** | safetensors (not pickled .pt). `_3500` is the **training step**, not the rank. No sidecar alpha/config json — alpha lives on the card (32/32) |
| `README.md` | 6,303 B | the card |
| `ATTRIBUTION.md` | 30,505 B | CC-BY 3D models, CC0 HDRIs/textures, CMU mocap used in the renders |
| `LICENSE` | 17,604 B | full MiniMax H3 Community License Agreement text |
| `NOTICE` | 380 B | derivative + restriction-passing statement (§11, §V.2) |
| `assets/compare_00004–00017.mp4` | 14 videos, ~186 MB | side-by-side warp / original / result |

**License: `other` — MiniMax H3 Community License Agreement.** The LoRA is a
declared *Model Derivative*; Section V use restrictions pass to every
recipient. Notable terms: the license's **Applicable Territory excludes the
EU, UK, Republic of Korea, and the USA** **[DOC]**. Catalog treatment: this is
NOT a NO-LICENSE/GPL row, and it imposes **nothing beyond what running
MiniMax-H3 itself already imposes on us** — the flag worth recording is
`license: other` + territory carve-out, shown at the consent gate, weights
linked never copied **[SPEC]**. (Contrast: the LTX sibling is Apache-2.0 —
only because Lightricks' base allows it. Same author, different base, different
license — exactly why our consent records must match the CURRENT license.)

## 4. Claims vs mechanism

- The headline claim (video + camera offset → same scene, new viewpoint)
  follows from the mechanism: depth-warp conditioning is a sound way to
  specify target geometry, reference conditioning to carry identity **[SPEC]**.
  Honest markers on the card: releasing step 3,500 of 6,000 (admits
  non-final); compare videos show warp/original/result side by side
  (falsifiable format); strength recommended below 1.0 **[DOC]**.
- **Absence 1 — no Limitations section on the H3 card.** The LTX v2 card has
  an unusually honest one (steers-not-reprojects; distance barely represented
  in training; looking-up-from-below the starved axis at 3.1% of scenes;
  `pivot_z` must be found per clip; an azimuth/elevation trust-range table).
  Dataset and node are shared, so those limitations plausibly carry over —
  but the H3 port does not restate or re-verify them, and publishes **no
  angle-range table of its own [UNK]** **[DOC for the absence]**.
- **Absence 2 — no quantitative metrics** (no novel-view PSNR/SSIM/FVD, no
  identity-similarity numbers); quality rests on 14 self-selected compare
  videos **[DOC for the absence]**. Normal for a LoRA release — and exactly
  what our benchmark harness exists to settle.
- Train/inference envelope gap: trained at 512×512 × 73 f square; examples at
  16:9, 124 f, two-pass to 1.5 MP. The examples implicitly claim
  generalization beyond the training envelope; untested on the card
  **[SPEC]**.

## 5. Fit for us

- **Node surface: direct port.** The workflow wires `MiniMax H3 Add Guide` +
  `MiniMax H3 Reference To Video` — our graph builders already emit
  `MiniMaxH3AddGuide` / `MiniMaxH3ReferenceToVideo`
  (src/lib/workflow.ts:198–218, src/lib/graph/h3image.ts:883) **[DOC]**. The
  one new dependency is the third-party CrossViewWarp node (MoGe inference +
  warp + orbit picker); MoGe depth is core ComfyUI per the author's LTX
  instructions. Modularity check passes: the LoRA is usable **without** the
  node if we produce warps from our own camera compiler — the pattern, not
  the node, is load-bearing **[SPEC]**.
- **Lane fit: our ref2va lane is the exact training target**; per-chain LoRA
  stacking + painted timeline handles it, and it demonstrably stacks with the
  DMD turbo LoRA (our fast stack). The **merged** lane and any pruned/hybrid
  checkpoint go through Form-Adaptive like any external full-width LoRA
  **[SPEC]**.
- **Identity domain: yes** — this is ref2v identity under camera change, our
  reference lane's home turf. **Start-frame workflows: marginal [SPEC]** — a
  T=1 single frame could in principle be warped and guided (MoGe works on
  images), but training was video-pair only; outside the demonstrated
  envelope, needs its own test.
- **Camera editor: complementary, not competing.** Our bruxosdovfx-derived
  compiler shapes camera *during generation*; CrossView-Warp re-cameras *the
  input* geometrically and lets the LoRA steer to it. Composition is the
  interesting case: our compiler's paths feeding the warp channel
  **[SPEC]**.
- **Benchmark suite: prime candidate.** Golden domain: **ref2v identity ×
  camera fidelity** — fixed source clips + fixed azimuth/elevation offsets,
  blind judge scoring identity retention, delivered-vs-requested angle (the
  documented under-rotation tendency is a ready-made hypothesis), and
  magenta-region inpainting quality. Add angle-sweep arms: the trust-range
  table exists only for LTX; H3 ranges are **[UNK]** **[SPEC]**.
- **Patterns worth taking regardless of the weights:**
  1. Two-channel conditioning (geometry-warp guide + identity reference) with
     disocclusion holes as a promptable surface — reusable with our own warp
     producer.
  2. Another row for the training envelope: rank 32/32, 512×512 × 73 f,
     batch 1, INT8-ConvRot base, 20.35 s/step on a 96 GB card — consistent
     with our own "~14–19 s/step at any small geometry because the DiT
     streams" floor (envelope doc §), now with an independent 96 GB data
     point; the s/step did NOT collapse on a bigger card, reinforcing that
     the frozen-DiT streaming bound, not VRAM, sets the floor **[SPEC]**.
  3. Ecosystem pointer: `AkaneTendo25/musubi-tuner` branch `minimax-h3`
     carries H3 Ref2VA training (`aligned_guide_indices`) — a community
     trainer path distinct from the musubi dev + DiffSynX pair our envelope
     measured; worth a look when the training wave opens **[DOC]**.

## 6. Verdict

**ADOPT** (post-remediation) — a trained novel-view capability for the exact
lane (official-base ref2va) and exact node surface we already run, entering
the arsenal through the consent-gated catalog (license flagged: MiniMax H3
Community License, territory carve-outs) and earning its place via the
benchmark harness (ref2v identity × camera fidelity suite), with the
two-channel warp+reference conditioning pattern taken into our own camera
work whether or not the weights clear the bar.

## Sources (all fetched 2026-09-20)

- Model API: https://huggingface.co/api/models/Cseti/MiniMax-H3_Ref2VA-LoRA-CrossView-Warp_v1 (metadata, file tree + sizes, dates)
- Card: https://huggingface.co/Cseti/MiniMax-H3_Ref2VA-LoRA-CrossView-Warp_v1/raw/main/README.md (mechanism, usage, training table, dataset pointer)
- NOTICE + LICENSE head: same repo, raw (derivative status, territory terms)
- Sibling card (dataset + limitations detail): https://huggingface.co/Cseti/LTX2.3-22B_IC-LoRA-CrossView-Warp_v2/raw/main/README.md
