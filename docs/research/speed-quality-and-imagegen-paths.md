# Speed/quality levers and image-generation paths — grounded research

Compiled 2026-09-14 (Flux task `8y09lhg`). Scope: the maintainer's fixed machine — **24 GB VRAM, 112 GB system RAM, offloading acceptable, minimal block swapping, int8 convrot H3 models, NVFP4 excluded by policy** — plus the Krea 2 / Anima / FLUX.2 klein image-generation duty.

Method: primary sources only — official project pages and shipped code (including the maintainer's own local VDN 24 GB fork and Kreatine testbed, both read directly), ComfyUI official docs/blog/changelog/issues, and community-measured results where they are the only numbers that exist. Every claim carries a URL; claims are tagged **[DOC]** (official/authoritative, incl. shipped code), **[COMM]** (reputable community finding, ideally with evidence), **[SPEC]** (plausible, unverified), **[UNK]** (nobody documents it). Local-file citations are marked **[DOC-local]** (code we possess; path given).

Machine-specific numbers that came out of community measurements say so. Where a number matters and does not exist, it says **UNK** rather than guessing.

---

## 0. Verdict summary

1. **Lever verdict:** VDN (with its own turbo/DMD adapter at 8 steps) is the best single speed lever at acceptable quality for iteration AND final renders on this machine; community turbo LoRAs remain the right lever for graphs that must compose with the wider node ecosystem (Motion-Context chains, ControlNet stacks) — and drbaph's turbo LoRAs *are* VDN's distillation extracted, so the two families are converging, not competing. For **chain graphs with pinned rows, run VDN's architecture with the turbo adapter OFF (≈50 steps) or plain 20-step base**, because the pinned-row failure is caused by few-step distillation + step-skipping caches, not by VDN's attention change — and VDN's own LongCache is exactly a step-skipping cache (see §1.6).
2. **Biggest single performance win found:** **caching Qwen3-VL-32B conditioning to disk.** The H3 text encoder is a 26.4 GB int8-convrot file on this machine ([DOC-local](/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI)) and community-measured *evicted* reloads run **12.3 minutes**, with one un-evicted rerun killed after 90+ minutes ([COMM](https://comfy.icu/models/2834385/MiniMax-H3-Text-Encoder-GGUF-Qwen3-VL/3198647/v1-0)). Repeat regens with an unchanged prompt should never touch that file. This dwarfs any sampler-side speedup for iteration loops.
3. **ComfyUI config line (0.34/0.35-era, dynamic VRAM default):**
   `--cache-ram 24 96 --reserve-vram 1.5 --fast fp16_accumulation` (plus `--use-sage-attention` when SageAttention is importable). Rationale and alternatives in §2.3. Do **not** add `--cache-classic` on this box (it exists to un-break RAM-starved machines; we have 112 GB and the default RAM-pressure cache already pins inactive weights up to ~96 GB).
4. **Showstopper-level caveats found:** (a) ComfyUI issue [#14076](https://github.com/Comfy-Org/ComfyUI/issues/14076) — *open*, observed on 0.22.0: models evicted from VRAM are re-read from **disk** instead of RAM cache, which is precisely our reload-avoidance scenario; mitigation exists (§2.4). (b) The H3 `denoise_mask` path currently overlays a repeating grid artifact ([#15981](https://github.com/Comfy-Org/ComfyUI/issues/15981)) — affects any pinned-row/inpaint plan, VDN or not. (c) VDN's 24 GB LongCache requires a **one-file core patch** that is regex-coupled to the 0.33.x/0.34 block-loop layout; the pure-VDN part needs no patch at all (§1.2).

---

## 1. The lever question: turbo LoRAs vs VDN vs both

### 1.1 What VDN actually is (and isn't)

**Correction to our working assumption: VDN is NOT training-free.** [DOC](https://openvdn.github.io/)

- **Architecture change (trained):** VDN = *Video DeltaNet* — a hybrid attention rebuild of H3. Nearby frames keep exact softmax attention (sliding window of 5 latent-frame chunks, bidirectional, plus "4-way boundary anchors" — every frame attends to the first/last frames, adding only 3.57% attention density). Distant temporal context goes through a **frame-wise linear-attention branch ("Video Delta Attention")** with constant-cost recurrent forward/backward states; the text prompt is written into both states at init (`S₀→ = S₀← = ½S_text`). Softmax and linear branches each keep their own gate and output projection. Attention cost becomes linear in clip length instead of quadratic. [DOC](https://openvdn.github.io/)
- **The linear branch is trained in three stages** on top of the frozen H3 backbone: A1 per-layer alignment (200 steps) → A2 end-to-end branch adaptation (500) → B end-to-end LoRA co-adaptation on QKV/O + branch (2000). Backbone weights are untouched. [DOC](https://github.com/OpenVDN/vdn-minimax-h3)
- **Step reduction comes from DMD2 distillation, stage "dmd-step-250":** a data-free DMD2 (no GAN) training run initialized **from the community turbo LoRA** `larryvrh/MiniMax-H3-Turbo-Lora` (`v4_step600_ema`), producing VDN's own 8-step turbo adapter. They deliberately avoided 4-step distillation "to preserve quality." [DOC](https://github.com/OpenVDN/vdn-minimax-h3) — so "VDN vs turbo" is partly a false dichotomy: **VDN's speed mode literally contains a turbo LoRA**, descended from the same community checkpoint our registry already tracks.
- **Released checkpoints** (~82 GB total): `h3-base/` (stock H3, 72 GB), `stage-b-step-2000/` = "VDN-H3-50-step" (linear_branch + default adapter, 4.3 GB), `stage-dmd-step-250/` = "VDN-H3-8-step" (adds the turbo adapter, 5.1 GB). Weights under the MiniMax H3 Community License (territory excludes EU/UK/KR/US — maintainer is in Canada, region concern already resolved). [DOC](https://huggingface.co/OpenVDN/vdn-minimax-h3)

**So the maintainer's phrase "training-free dynamic-sequence acceleration" is wrong on both counts:** it is trained (branch + adapters), and it is not dynamic-sequence/token-pruning — it is a fixed hybrid architecture whose *cost* is linear in sequence length. The thing that IS training-free in this space is the step-skipping/cache family (Spectrum, EasyCache, TE-Speed-style block caching, PDD heads at inference time) — see §1.6–§1.8.

### 1.2 VDN's ComfyUI integration, precisely (delivery mechanism)

Three delivery layers exist today. This matters directly for our dual-mode architecture (managed vendored stack vs user's external install).

**(a) Mechanism inventory — what the "patch" actually touches.**

| Layer | What it is | What it touches | Source |
|---|---|---|---|
| Upstream research stack (Diffusers) | Not ComfyUI at all | Python 3.12, PyTorch 2.13+cu129, FlashAttention 4 + `nvidia-cutlass-dsl`, **a patched Diffusers**, Triton kernel compile on first run | [DOC](https://github.com/OpenVDN/vdn-minimax-h3) |
| **Community ComfyUI port** (Saganaki22/ComfyUI-VDN-H3) | Custom node pack; "a port, not a fork" | **Nothing outside `custom_nodes/`** — VDN is applied as *runtime model patches* on ComfyUI's native MiniMax-H3 ModelPatcher; re-keys diffusers-format tensors onto ComfyUI module paths in memory; swaps the official FP8/Triton/FA4 kernels for portable eager PyTorch ("zero new dependencies… no Triton or flash-attn"); disables the new Comfy Compiler around VDN sampling and restores it after each step | [DOC](https://github.com/Saganaki22/ComfyUI-VDN-H3), [COMM](https://comfyui-wiki.com/en/news/2026-09-04-vdn-h3) |
| **Maintainer's 24 GB fork** (`ComfyUI-VDN-H3-24GB`, local) | Adds AutoMemory (duration-aware residency), AutoLongCache, int8-convrot branch streaming, Ampere launch profile | Everything in-memory **except one file**: `comfy/ldm/minimax/model.py` gets a reversible "block-loop hook" needed *only by LongCache* | [DOC-local](/home/agent/work/scratchpad/ComfyUI-VDN-H3-24GB/README.md) |

The single core-file patch, read directly from the installer ([DOC-local](/home/agent/work/scratchpad/ComfyUI-VDN-H3-24GB/tools/install_minimax_block_loop_hook.py)): it inserts (1) a `_run_blocks(self, …, start, end)` helper — a verbatim copy of ComfyUI's block loop plus slicing — and (2) a dispatch in `_forward` honoring `blocks_replace[("block_loop", 0)]`, i.e. it *creates* a block-loop extension point that stock ComfyUI does not expose (stock exposes only per-block `("double_block", i)` replacement). **No compiled kernels, no build flags, nothing that loads before `custom_nodes/`** — pure Python, AST-validated. The fork's Triton module is explicitly diagnostic-only ("No Triton result is ever fed back into the model") [DOC-local](/home/agent/work/scratchpad/ComfyUI-VDN-H3-24GB/vdn_h3_24gb/triton_probe.py). VDN-proper (hybrid attention + adapters) rides the standard `patches_replace`/LoRA-adapter machinery — the same in-memory channel KJNodes' SageAttention patch uses.

**Why LongCache needs the hook:** it replaces the *whole* 50-block loop so that on selected NFEs (default 3, 5, 7) it can recompute only a leading fraction (default 40%) of blocks and add back a CPU-stored tail residual — "inspired by the public TE-Speed MiniMax-H3 block-loop cache idea," purpose-built for 24 GB cards [DOC-local](/home/agent/work/scratchpad/ComfyUI-VDN-H3-24GB/vdn_h3_24gb/longcache.py).

**(b) In-memory feasibility — yes, and it already ships that way.** Saganaki22/ComfyUI-VDN-H3 is precisely "VDN as a node instead of a patch": no core changes, no env vars, no build flags [DOC](https://github.com/Saganaki22/ComfyUI-VDN-H3). Verified on our own testbed: **stock ComfyUI 0.34.0's `comfy/ldm/minimax/model.py` contains no `block_loop` dispatch and its loop matches the fork's "current 0.33.x layout" regex exactly** [DOC-local: `/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI/comfy/ldm/minimax/model.py` lines 722–728] — so as of 0.34/0.35 the hook is still required *for LongCache only*, and the installer's strict regex still matches. The fork carries ~20 `VDN_H3_*` env vars, but they are lab/ablation toggles read at runtime by the node, not launch requirements [DOC-local, grep of `vdn_h3_24gb/`].

**(c) If file-patching is used (24 GB fork): version coupling and safety pattern.** The installer is a textbook consent-patch-manager: strict regex against two known loop layouts (current + one older `malloc_scope="block"` variant); **refuses with "no file was changed"** on an unrecognized layout (e.g. after a future ComfyUI refactor); `ast.parse()` validation before writing; atomic same-dir temp+rename; pristine backup `model.py.vdn_longcache.bak` refreshed whenever an unpatched target is seen (so a ComfyUI update that overwrites the file is auto-detected and re-patched from a fresh backup); `--check` and `--revert` modes; idempotent [DOC-local](/home/agent/work/scratchpad/ComfyUI-VDN-H3-24GB/tools/install_minimax_block_loop_hook.py). Community precedent for patch-managers: this pattern (backup + layout-detect + safe-refuse + revert) is the same discipline ComfyUI-Manager expects of anything touching core; the SageAttention integration is the contrasting in-memory precedent (a MODEL-patch node / `--use-sage-attention` flag, zero core edits) [DOC](https://docs.comfy.org/tutorials/video/minimax/minimax-h3). No upstream ComfyUI release mentions VDN in the changelog through v0.35.1 (2026-09-10) — **VDN is not core, and there is no PR making it core** [DOC](https://docs.comfy.org/changelog).

**(d) Delivery-strategy recommendation (extends the verdict table, §1.7):**

| Strategy | What we ship | Leans on | Verdict |
|---|---|---|---|
| **In-memory node (VDN-proper)** — preferred default for BOTH modes | Vendor Saganaki22/ComfyUI-VDN-H3 (+ the int8-convrot stage checkpoint from [speach1sdef178/VDN-H3-INT8-ConvRot-ComfyUI](https://huggingface.co/speach1sdef178/VDN-H3-INT8-ConvRot-ComfyUI)); node applies patches at runtime; uninstall = delete folder; update-proof against ComfyUI (it already self-manages the Comfy-Compiler interaction) | Vendored-node machinery; optimization registry (new kind: `architecture-patch`, separate from `lora`) | **Adopt.** Proven no-core-touch delivery; works identically managed and external |
| **Consent-patch-manager (LongCache tier)** — managed stack only | Ship the fork's installer pattern as a pre-launch hook: detect (hash the block-loop layout), patch with backup, `--check` on every boot, refuse + fall back to "VDN without LongCache" when the layout is unrecognized | Launch profiles (pre-launch hooks) + `testedComfyVersion` gate: only run the patcher when ComfyUI == a layout we've verified | **Adopt with gating.** The failure mode is graceful (VDN still works; you lose the tail cache) — availability-gated absence done right |
| Managed one-off fork | Vendor the whole 24 GB fork into our tree | Repo/vendor discipline | **Reject as primary** — forks drift; the two rows above capture 100% of its value with less coupling. Keep the maintainer's scratchpad fork as the *reference* for AutoMemory policy we may upstream |
| Availability-gated absence | VDN entry hidden when node/checkpoint absent | Existing registry capability pruning | **Adopt** for external-install mode where we can't vendor |

The maintainer's report "VDN is now available natively via a ComfyUI patch" maps to: *VDN runs against ComfyUI's native MiniMax-H3 implementation as runtime model patches* (the Saganaki22 port) — "native" = uses the native node, "patch" = runtime model patch, **not** a ComfyUI core patch/PR. Worth aligning terminology in-app.

### 1.3 The turbo-LoRA field for H3 (what our registry tracks, verified)

| Family | Checkpoint | Steps | Notes | Source |
|---|---|---|---|---|
| Official Lightning (Comfy-Org) | `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16` (T2V/I2V), `minimax_h3_ref2v_turbo_4step_v0.1` (R2V) | 8 / 4 | Shipped via the native node's `turbo_mode`; official tradeoff wording: "slightly lower audio and motion quality" | [DOC](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native) |
| larryvrh Turbo LoRA | `v4_step600_ema` (recommended), `v1_~850` | 6–8 (v4), 4 (v1 for heavy motion) | v4 = "strongest checkpoint so far"; 4-step + fast motion → smear/ghosting, largely gone at 6–8 steps; v1 over-sharpens at high steps. Loaded via the ComfyUI-MiniMax-H3-Turbo node (also provides the `h3_silu_temb_grid` fix for pruned bases) | [DOC](https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora), [DOC-local](/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI/custom_nodes/ComfyUI-MiniMax-H3-Turbo/README.md) |
| lightx2v / ModelTC | FL2V 8-step v1.0 768p; 4-step v1.2 768p | 8 / 4 | Official LightX2V Studio lineage; 8-step v1.0 explicitly "improved quality" over the earlier 4-step | [DOC](https://huggingface.co/lightx2v/Minimax-h3-Turbo), [COMM](https://comfyui-wiki.com/news/2026-08-07-minimax-h3-turbo-lightx2v) |
| **drbaph (ComfyUI conversions)** | Three LoRAs **extracted from VDN-H3's 8-step distillation** | 8 | Main LoRA works on both FL2VA and Ref2VA; pruned-base variants provided. This is the turbo×VDN bridge: VDN's DMD2 adapter, usable without VDN's architecture | [COMM](https://huggingface.co/drbaph/MiniMax-H3-Turbo-Lora-ComfyUI) (mirror: [AtomGit](https://ai.atomgit.com/hf_mirrors/drbaph/MiniMax-H3-Turbo-Lora-ComfyUI)) |
| PDD (Alibaba-PAI lineage) | rank-64 trunk LoRA + **32 per-interval PDD output heads** — *not loadable via the normal LoRA node* | 8→4 | Parallel Decoding Distillation; ComfyUI **v0.35.0 added native PDD LoRA support** ("faster H3 sampling"); community loader node exists (Deno loader) | [DOC](https://docs.comfy.org/changelog) (v0.35.0), [DOC](https://huggingface.co/aptech0081/MiniMax-H3-Acc-LoRAs-ComfyUI), [COMM](https://comfy.icu/node/DenoMiniMaxH3AccLoader) |
| Spectrum (step-skipper, not a LoRA) | ComfyUI-Spectrum-MiniMax-H3 | varies | The one our transitions research flagged: **mispredicts pinned rows**; keep off chain graphs | [COMM](https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context) |

Also in-tree: official template repo carries `api_minimax_h3_max_turbo_{t2v,i2v}` (H3-Max turbo variants, added 2026-09-04) — relevant later if H3-Max lands locally [DOC: Comfy-Org/workflow_templates, per our ecosystem-2026-09.md sweep].

### 1.4 Measured speed/quality on ~24 GB cards with int8 weights

**The maintainer's own validated runs (RTX 3090 24 GB, Windows, H3 FL2VA pruned INT8-ConvRot base + INT8-ConvRot VDN stage, 8-step DMD, `branch_weights=stream`, AutoMemory/AutoLongCache policy)** [DOC-local](/home/agent/work/scratchpad/ComfyUI-VDN-H3-24GB/VALIDATION_RESULTS.md):

| Duration | Res | Sampling wall | Mean/step |
|---|---|---|---|
| 5 s | 0.4 MP | 1:09 cold / 1:05 warm | 8.70 / 8.18 s |
| 10 s | 0.4 MP | 2:05 | 15.74 s |
| 15 s | 0.4 MP | 3:21 | 25.22 s |
| 20 s | 0.4 MP | 4:20 | 32.57 s |
| 10 s | 0.8 MP | 5:18 (one-off paging stall took 11:29 once; immediate repeat clean) | 39.84 s |
| 10 s + char/style LoRA | 0.4 MP | 2:11 | 16.38 s |

Full NFEs ≈ 48–50 s vs cached NFEs ≈ 25 s at 0.8 MP (LongCache contribution visible). A 15 s→5 s duration transition (LONG→SHORT residency) completed with no OOM/CUDA error/NaN. Version 1.1.0 A/B: restored token-refiner adapter mapping (`default=104, turbo=208`) cost ~4% speed and delivered "material prompt-adherence improvement" in paired reviews [DOC-local, same file].

**Community 24 GB-class measurements:**
- Saganaki22 port on **RTX 5090**: ~17 s/it at 1280×736 / 145 frames, 8 steps → ~2:15 sampling incl. audio; INT8-ConvRot VDN branch vs bf16 branch: identical output, branch matmuls **2.7× faster**, ~**1.2× end-to-end** (~95 s vs ~111 s), and 8.3 GB vs 3.6 GB VRAM free at 736p. "Realistic single-GPU gains track the ~2.6× architectural figure" [COMM/DOC-shipped](https://github.com/Saganaki22/ComfyUI-VDN-H3).
- Non-VDN turbo baseline for scale: loopforge timings — 4-step turbo ≈ 5 min per 4 s shot at 480×864 on a 3060-class card [COMM, already in our h3-transitions doc].
- Official VDN numbers (B200/H200 datacenter, not our tier, for context): 1×B200 dense 16.74 s/NFE vs VDN-FP8 6.41 s/NFE; 8×B200 + DMD = 11.23 s for a 14.4 s 768p clip ("faster than it plays", 74.5× vs dense-single-GPU) [DOC](https://openvdn.github.io/), [DOC](https://github.com/OpenVDN/vdn-minimax-h3).
- Quality: OpenVDN claims "visually nearly indistinguishable" from H3, deliberately no 4-step variant "to preserve quality", and claims better quality/instruction-following than MiniMax FastH3 [DOC](https://openvdn.github.io/). Independent community quality verdicts at our tier beyond the fork's own A/B: **UNK** — treat as maintainer-validated only.

### 1.5 Turbo × VDN interaction

- **Do not stack community turbo LoRAs with VDN's turbo adapter.** The port is explicit: the released 8-step turbo adapter *replaces* community turbo LoRAs, and `lora_mode: merge` is required for stage-dmd checkpoints (bypass → grainy output) [DOC](https://github.com/Saganaki22/ComfyUI-VDN-H3). Mechanistically obvious in hindsight: VDN's adapter was DMD2-trained *on top of* the hybrid architecture from larryvrh v4 — the distillation already includes it.
- **drbaph's extraction is the "both" answer for non-VDN graphs:** VDN's 8-step distillation as a standalone LoRA on the dense base (FL2VA + Ref2VA) [COMM](https://huggingface.co/drbaph/MiniMax-H3-Turbo-Lora-ComfyUI).
- **Stacking order rule for our registry:** `architecture-patch (VDN)` XOR `turbo-lora`, then attention/compile levers (SageAttention composes; scheduled Sol-Attn conflicts with VDN's attention path; general Sol-Attn FFN-chunking composes) [DOC](https://github.com/Saganaki22/ComfyUI-VDN-H3).
- Partial-strength idea (community suggestion for the OpenVDN LoRA: apply the speedup LoRA for only a quarter/half of the schedule) [COMM](https://www.reddit.com/r/StableDiffusion/comments/1w5sosg/openvdnvdnminimaxh3_hugging_face/) — interesting, untested; **SPEC** for us.

### 1.6 Pinned rows / chain graphs (the known wrinkle)

Re-verified from the source of our original claim, Motion Context's README [COMM](https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context):

- Pinned rows = slices of the previous clip's latent tail injected as **never-denoised conditioning rows** — "bit for bit" identical, coordinates rewritten onto the new timeline. The model *reads* them; they never change.
- The README attributes row **misprediction to step-skipping optimizers** (Spectrum class: "mispredict the pinned rows, which never change") and attributes **audio thickening + softening** to turbo LoRAs generally ("a turbo LoRA thickens the sound and softens the picture… fine detail is what those last steps were for"). Combining turbo + step-skipper "stacks" the damage. Recommended: "Keep Spectrum off for these graphs."
- Separate core bug while we're here: any `denoise_mask` passed to H3 currently overlays a repeating **grid artifact** (since commit ff6c8a8af, tracked as #15981) — pinned/inpaint work must re-check this per ComfyUI version [DOC](https://github.com/Comfy-Org/ComfyUI/issues/15981).

**Applying this to VDN, mechanistically (this part is our analysis — SPEC unless noted):**
1. VDN's *architecture* should be pinned-row-safe or better: boundary anchors mean every frame attends to first/last frames — pinned head/tail rows sit exactly where VDN adds global-consistency anchors [DOC](https://openvdn.github.io/). The port supports ref2va with `anchor_frames: both` as the trained spec [DOC](https://github.com/Saganaki22/ComfyUI-VDN-H3).
2. VDN's *turbo adapter* (8-step DMD2) is a turbo LoRA — the "thickens audio / softens picture" class risk transfers. Direct measurement of VDN+turbo on pinned rows: **UNK**. Nobody has published it.
3. VDN-24GB's **AutoLongCache IS a step-skipping cache** (recompute 40% of blocks on NFEs 3/5/7, replay stored tail residual) [DOC-local](/home/agent/work/scratchpad/ComfyUI-VDN-H3-24GB/vdn_h3_24gb/longcache.py) — same risk class as Spectrum for never-changing conditioning rows. Default `VDN_H3_LONG_CACHE_STEPS` should be empty (off) for chain graphs until tested.
4. **Test plan we already own:** our transitions-research harness conventions (anchor-fidelity dB on pinned region, seam column, ArcFace per hop) were explicitly designed with "turbo disqualified for pinned-row fidelity tests — run pinned-anchor experiments at 20 steps" [our h3-transitions doc]. Add one arm: VDN-arch + turbo ON/OFF × LongCache ON/OFF at matched seeds.

### 1.7 Verdict table — the speed lever by use-case

| Use-case | Recommended lever | Config | Why | Confidence |
|---|---|---|---|---|
| (a) Iteration / preview | **VDN (stage-dmd, turbo adapter ON, 8 steps)** + SageAttention + int8-convrot everywhere | `apply_turbo_adapter: true`, `lora_mode: merge`, `branch_weights: stream`, `attention_backend: grouped` | ~2.6× architectural + 8 vs 20 steps, maintainer-validated on the exact GPU/quant class; per-step cost *falls* with duration (linear attention) | HIGH (own validation) |
| (b) Final-quality renders | **VDN architecture, turbo OFF (≈50-step stage-b)** for hero shots; VDN+turbo 8-step acceptable per maintainer A/B for most work | Same, `apply_turbo_adapter: false`, 20–50 steps (taste vs wall-clock) | Recovers "the last steps" the README says fine detail lives in; still faster per step than dense | MED-HIGH |
| (c) Chain graphs (pinned rows) | **VDN arch ON, turbo OFF, LongCache OFF, 20–50 steps** — or plain base 20-step if the graph's other nodes assume dense attention | `VDN_H3_LONG_CACHE_STEPS=""`, turbo adapter off | Pinned-row failure = distilled few-step + step-skip caches; remove exactly those, keep the linear-attention win | MED (mechanism-backed, **measured: UNK**) |
| Chains, speed absolutely required | drbaph v4-600-style LoRA at 6–8 steps, Spectrum OFF, accept softening | Motion Context's own advice | Documented best-of-bad-options | MED [COMM] |
| Graphs needing PDD 4-step | PDD LoRA + heads (v0.35.0 native support), never combined with VDN | PDD loader path | Parallel decoding ≠ distillation quality curve, needs own A/B | LOW-MED, unmeasured at our tier |
| **Delivery strategy (both modes)** | In-memory VDN node vendored; LongCache = consent-patch-manager gated on `testedComfyVersion`; registry kinds `architecture-patch` vs `lora` kept separate (maintainer already confirmed complementarity) | §1.2(d) | Update-proof core, graceful degradation | HIGH (upstream proves the no-patch path) |

### 1.8 Secondary levers, in the same frame

| Lever | Measured effect | Composability | Source |
|---|---|---|---|
| **SageAttention** | "roughly double the generation speed" with minimal quality loss (official H3 tutorial); needs fp16/bf16 layers — affected layers fall back to SDPA with a console notice | Composes with VDN (the 24 GB launcher itself starts with `--use-sage-attention`); use the `Patch Sage Attention KJ` node or the global flag | [DOC](https://docs.comfy.org/tutorials/video/minimax/minimax-h3), [DOC-local launcher] |
| **res_multistep sampler** (RH pack) | 2.46× denoise speedup vs 50-step Euler at matched quality; 1.35× end-to-end (denoise ≈45% of wall clock) | Sampler-level; orthogonal to VDN's attention change in principle — **interaction UNK, test** | [COMM](https://github.com/HM-RunningHub/ComfyUI_RH_MinMaxH3) |
| **EasyCache / step-skip caches** | Stacks with Sage/Sol to ~70% cuts (community) | **Pinned-row hazard class** (§1.6); keep off chains | [COMM](https://www.reddit.com/r/StableDiffusion/comments/1vfannp/minimax_h3_add_these_nodes_for_faster_gen_time/) |
| **Sol-Attn (sparse attention)** | 15–20% | General variant composes with VDN; the *Scheduled* Sol Attention patch **conflicts** with VDN's attention path | [COMM](https://github.com/Saganaki22/ComfyUI-sol-attn), [DOC](https://github.com/Saganaki22/ComfyUI-VDN-H3) |
| **torch.compile / Comfy Compiler** | v0.35.0 shipped "Comfy Compiler (aimdo memory compiler + CUDA graphs) to cut allocation thrash" | VDN port disables it around VDN sampling and restores after each step (handled for us); dynamic VRAM was historically disabled under torch compiler (v0.15.1 note) — keep compile OFF for the VDN profile | [DOC](https://docs.comfy.org/changelog) |
| **`--fast fp16_accumulation`** | Official experimental perf flag family (`fp16_accumulation`, `fp8_matrix_mult`, `cublas_ops`, `autotune`) | Start with `fp16_accumulation` only; each later opt is a quality lever to A/B | [DOC](https://docs.comfy.org/development/comfyui-server/startup-flags) |
| **TeaCache-style (original TeaCache)** | No H3-specific TeaCache port found; the H3-native descendants are EasyCache/Spectrum/LongCache | — | UNK for direct TeaCache |
| **Quant tier** | int8-convrot is the correct floor for us (branch matmuls 2.7× vs bf16, identical output; NVFP4 excluded by policy) | Already our baseline | [DOC](https://github.com/Saganaki22/ComfyUI-VDN-H3) |

---

## 2. Memory + reload choreography on current ComfyUI (0.34/0.35, 2026-09)

### 2.1 The memory system we actually have

- **Dynamic VRAM ("aimdo") is the default** on Nvidia since v0.16.0 (Mar 2026); auto-enabled on Nvidia and ROCm 7.14+ [DOC](https://docs.comfy.org/changelog), [DOC](https://docs.comfy.org/development/comfyui-server/startup-flags). It is a custom PyTorch VRAM allocator: per-model **VBAR** (virtual address space, zero physical cost) + **`fault()`** just-in-time allocation; under pressure a layer's weight is copied into a temporary GPU tensor for that layer only, then freed; eviction uses watermark priorities to avoid thrashing [DOC](https://blog.comfy.org/p/dynamic-vram-in-comfyui-saving-local).
- **Models are no longer unloaded VRAM→RAM after use**; weights live in uncommitted file-backed memory (ComfyUI's own safetensors mmap loader assigns by pointer — loader nodes run "almost instantly") and persist across workflow runs, saving PCIe/DDR traffic. High apparent RAM use is instantly-reclaimable page cache [DOC](https://blog.comfy.org/p/dynamic-vram-in-comfyui-saving-local).
- **CUDA graphs + dynamic VRAM interoperate** since v0.33.1; v0.35.0 added the Comfy Compiler; container cgroup RAM respected since v0.35.0 [DOC](https://docs.comfy.org/changelog).
- **Known open bug that targets our exact pattern:** on evict-and-return, weights are re-read **from disk** instead of RAM (observed ComfyUI 0.22.0, PyTorch 2.12, 24 GB 3090 Ti, ~27 GB Wan DiT; status Open, assigned, no fix at research time) [DOC](https://github.com/Comfy-Org/ComfyUI/issues/14076). This is the failure behind the 12-minute text-encoder reloads below. Mitigation: keep everything we care about under the *inactive* (pinned) cache ceiling — see §2.3.

### 2.2 Flag reference (verbatim semantics from the official startup-flags page)

Cache modes (**mutually exclusive** — these cache *node execution results*, not weights):
- `--cache-ram [GB] [GB]` — default. RAM-pressure caching; first value = active-cache threshold (default: 10% of RAM, min 2 GB, max 10 GB), optional second = inactive/pin threshold (default 100% of RAM, max 96 GB).
- `--cache-classic` — "the old aggressive caching style," no hard upper limit.
- `--cache-lru N` — LRU with max N node results (default 0/off).
- `--cache-none` — re-executes every node each run.

VRAM modes: `--gpu-only` (store/run everything on GPU incl. text encoders), `--highvram` (keep models in GPU memory instead of unloading), `--lowvram` (**"No effect when dynamic VRAM is enabled"**; otherwise runs text encoders on CPU), `--novram`, `--cpu`.

Offload/memory: `--reserve-vram GB` (VRAM left for OS/other apps), `--async-offload [N]` (async weight offloading, **default 2 streams on Nvidia**; `--disable-async-offload`), `--disable-smart-memory` (aggressively offload to RAM), `--disable-pinned-memory`, `--fast-disk` (prefer disk-backed dynamic loading over unpinned RAM — "useful with fast NVMe"), `--disable-dynamic-vram`/`--enable-dynamic-vram`, `--mmap-torch-files`/`--disable-mmap`.
All: [DOC](https://docs.comfy.org/development/comfyui-server/startup-flags).

**What "minimal block swapping" maps to in 2026-09:** it is no longer a user knob in the old sense. With dynamic VRAM, per-layer fault-in/offload is automatic and stream-prefetched (`--async-offload`, default on); the fork's disk-backed branch streaming (`branch_weights=stream`) is the deliberate "never accumulate the stage in RAM" choice, and its code cites "the same disk-backed philosophy as comfy's `--fast-disk`" [DOC-local](/home/agent/work/scratchpad/ComfyUI-VDN-H3-24GB/vdn_h3_24gb/spec.py). Block-swap count is an emergent property of `--reserve-vram` + what else is resident; the way to minimize swapping is to minimize *co-residency pressure*, i.e. the llama.cpp pre-generate unload (already wired) + conditioning cache (§2.5), not a flag.

### 2.3 Recommended configuration for this machine (24 GB VRAM / 112 GB RAM, H3 33B int8 + TE + VAEs)

```
--cache-ram 24 96          # active node-result cache 24 GB; pin inactive up to 96 GB
                           # (default ceiling is capped at 96 GB anyway; being explicit
                           # documents intent and raises the ACTIVE tier well above the
                           # 10 GB default so node results of a big H3 graph stay cached)
--reserve-vram 1.5         # headroom for OS + the app's own surfaces; tune to taste
--fast fp16_accumulation   # cheap, official experimental opt; add fp8_matrix_mult only
                           # after an A/B (it is a quality lever)
--use-sage-attention       # only when SageAttention importable (launcher already probes)
```

Notes:
- **Do not set `--cache-classic`.** Its raison d'être is unbounded aggressive caching for machines starved of the new system's assumptions; our 112 GB with `--cache-ram`'s 96 GB inactive pin achieves the keep-everything-resident goal through the supported path, and node-result caching is where it operates — weight residency is dynamic VRAM's job. (`--cache-classic` reports of near-minute recoveries come from low-RAM boxes [COMM](https://github.com/Comfy-Org/ComfyUI/discussions/4457).)
- **Do not set `--gpu-only` or `--highvram`.** On a 24 GB card co-holding a 33B int8 DiT, forcing text encoders resident starves the DiT (the community "resident mode pins the encoder and never releases — DiT gets ~4.5 GB less every step" complaint) [COMM](https://www.reddit.com/r/StableDiffusion/comments/1vkk500/minimax_h3_with_a_4b_or_8b_text_encoder_instead/).
- `--fast-disk` is optional; on NVMe it trades unpinned RAM for disk-backed residency and would interact with bug #14076's failure mode — currently leave OFF and rely on 112 GB RAM.
- Keep torch compile / Comfy Compiler OFF for the VDN profile (it self-disables around VDN anyway) [DOC](https://github.com/Saganaki22/ComfyUI-VDN-H3).

### 2.4 Reload-avoidance choreography (H3 stack resident, brief image-model detours)

Design intent from the dynamic-VRAM system itself: weights stay in uncommitted file-backed RAM *persistently across runs*; a second model "loading" is mmap-pointer work; under VRAM pressure the aimdo watermark evicts the least-recently-prioritized VBAR without PCIe copy-out [DOC](https://blog.comfy.org/p/dynamic-vram-in-comfyui-saving-local). Choreography for our runtime:

1. **Pre-generation (already wired):** unload llama.cpp via its router endpoint before H3 sampling — protects the DiT's working set. (Existing `unload-before-generate` server hook.)
2. **Keep one ComfyUI process.** Two instances (e.g. VDN launcher's 8191 + main 8188) would double page-cache and split the allocator; the VDN launcher exists for *standalone* use — in our app, vendor the node into the single managed instance instead (§1.2).
3. **Image-model detour:** order the queue so the image job's weights fault in over the *inactive* H3 pages; on return, H3 pages fault back from page cache (RAM-speed) — this is the designed path. Expected switch cost: seconds. **Caveat [COMM]:** if #14076's disk-reread path triggers in the installed version, the switch degrades to disk-speed (minutes for 26 GB files). Runtime should *measure* the first H3→image→H3 cycle in the benchmark harness and alert if return-to-H3 exceeds ~30 s; that is the canary for #14076-class regressions.
4. **Prompt-cache (§2.5) removes the TE from the pressure equation entirely for repeat prompts** — the single biggest co-residency win: a 26.4 GB encoder that never faults in cannot evict anything.
5. `--reserve-vram` is the pressure knob if sampling-time OOMs appear while an image model is resident.

Switch-time expectations: within one healthy process, model-in → sample → model-back should cost single-digit seconds (mmap + fault-in of the image DiT ~12–20 GB from page cache at NVMe/RAM speed). Published per-event numbers for the 0.34 allocator on our exact pattern: **UNK**; the 5090 VDN-port timing (95–111 s full runs incl. loads) is the closest shipped evidence [DOC](https://github.com/Saganaki22/ComfyUI-VDN-H3). Our benchmark harness should own this number.

### 2.5 Text-encoder intelligence: conditioning cache (design sketch)

**The win, sized:** the H3 TE on this machine is `qwen3vl_32b_int8_convrot.safetensors` = **26.36 GB** [DOC-local: testbed `models/text_encoders/`]. Community-measured behavior: **12.3 minutes** to regenerate with the encoder evicted; an un-evicted rerun was killed after 90+ minutes [COMM](https://comfy.icu/models/2834385/MiniMax-H3-Text-Encoder-GGUF-Qwen3-VL/3198647/v1-0); "first run is always slowest — the 32B text encoder has to load" [COMM](https://localaimaster.com/blog/minimax-h3-local-setup-guide). Even ignoring eviction pathology, encoding with a 32B model costs real seconds per run. Repeat regens with unchanged prompts need **zero** of it.

**Feasibility in ComfyUI — yes, three ways, none H3-native today:**
- Precedent in core: the LTXV workflow ships Save/Load Conditioning nodes precisely to skip encoder reloads; the pattern is community-requested for other families (WanVideoWrapper [#1794](https://github.com/kijai/ComfyUI-WanVideoWrapper/issues/1794), city96/GGUF [#422](https://github.com/city96/ComfyUI-GGUF/issues/422)) [COMM].
- Existing half-solution: `CachingCLIPTextEncode` wraps encode with a cache but "regardless of whether a prompt is cached, it still loads the CLIP model" [COMM](https://comfy.icu/node/CachingCLIPTextEncode) — i.e. graph-level caching alone does not remove the load. We must bypass the encode node entirely on cache hit.
- **We already own the pattern:** the maintainer's own `krea2-lora-setup.sh` freezes Qwen3-VL-4B and caches its outputs to disk for training ("Text enc … FROZEN — cached to disk, never trained", musubi-tuner) [DOC-local](/home/agent/work/krea2-lora-setup.sh).

**Design (what we build):**
1. A tiny custom node pair, `MiniMax Studio: Load-or-Encode Conditioning`:
   - Inputs: prompt, reference images + roles (R2V `<Picture 1>`/`<Video 1>`/`<Audio 1>` tag order matters — it is connection order [DOC](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native)), TE checkpoint id, model-patch state id (turbo/VDN off — conditioning does not depend on DiT-side LoRAs, but *does* depend on the TE weights and prompt template).
   - Cache key: `sha256(prompt_text ‖ sorted(ref_image_hashes + roles) ‖ TE_checkpoint_id ‖ prompt_template_version ‖ resolution-critical encoder opts)`.
   - On hit: load serialized conditioning (safetensors on disk, ~tens of MB) → emit `CONDITIONING`; the CLIP/TE loader node is bypassed at graph-factory level (our deterministic graph generation makes this trivial — swap the encode subgraph for the loader node on hit, keep it on miss).
   - On miss: run the stock encode, then a `Save Conditioning` node writes the tensors.
2. Where it lives: our graph factory + optimization registry (`conditioning-cache` kind, off for chain graphs whose pinned-row latents are separate — cache only the *text/reference* conditioning, never latent context).
3. Sizing: hidden-states tensors for a few hundred prompt tokens ≈ MB-scale; 112 GB RAM/disk is a non-issue. Age policy: key already includes TE id; no invalidation problem.
4. Extra win: the cache makes the **bf16/larger TE affordable** — encode once at higher fidelity (or with the vision-capable encoder for image-heavy prompts), reuse the hidden states everywhere, never hold the big encoder resident. Also note the *official* Comfy-Org TE is NVFP4-AWQ (`qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors`, per the native tutorial) [DOC](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native) — with caching, we can decline that quant for encoding quality reasons without paying its load cost repeatedly.
5. Same mechanism serves the image models: Krea 2 and FLUX.2 klein share the Qwen3(-VL) encoder *family* (§3), and Anima's TE is 0.6 B — cache keys just name a different TE id.

---

## 3. Image generation & edit paths (Krea 2, Anima, FLUX.2 klein)

### 3.1 Path card — Krea 2 (primary edit/stills duty)

- **What:** 12 B T2I model, two checkpoints meant as a pair: **RAW** (52 steps, undistilled, "ideal for fine-tuning and LoRA training") and **Turbo** (8-step distilled; "LoRAs trained on RAW apply seamlessly to Turbo") [DOC](https://docs.comfy.org/tutorials/image/krea/krea-2), [COMM](https://www.youtube.com/watch?v=k8-9qGbPfpM).
- **Files (official):** `krea2_turbo_fp8_scaled.safetensors` (DiT ~12.5 GB) or `krea2_turbo_int8_convrot.safetensors` (official int8-convrot variant — our quant policy's native fit); TE `qwen3vl_4b_fp8_scaled.safetensors` (~5.2 GB); VAE `qwen_image_vae.safetensors`; 9 official style LoRAs at strength 1.0 + `krea2_style_reference.safetensors` [DOC](https://docs.comfy.org/tutorials/image/krea/krea-2).
- **2-stage sampling — what is actually done:** the official docs document Turbo single-pass (8 steps, "prompt enhancement enabled") and a style-reference workflow; no official base-then-refine doc. **The maintainer's own Kreatine node pack implements the real 2-stage**: "Two-stage sampling with an integrated stage-2 turbo LoRA and per-token prompt weighting, all driven from a single resident model so the base checkpoint stays in VRAM between prompts" — i.e. RAW-quality stage 1, turbo-LoRA refine stage 2, one resident model [DOC-local](/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI/custom_nodes/ComfyUI-Kreatine/README.md). That is the shape to expose in-app.
- **Edit path:** ostris edit LoRAs (ai-toolkit `model_kwargs.edit: true`) — `Text Encode Krea 2 Ostris Edit` runs prompt + reference images through the Qwen3-VL *vision* encoder with `Picture N:` placeholders (images downscaled to ≤384×384 total px for the TE; reference latents ≤1 MP), `Krea 2 Ostris Edit Model Patch` applies the model side [DOC](https://github.com/ostris/ComfyUI-Krea2-Ostris-Edit). A ControlNet pack (`comfyui-krea2-controlnet`) and the Krea2T prompt-adherence patcher (+ official Turbo sigma schedule builder) are installed in the maintainer's testbed [DOC-local inventory].
- **Recipe pitfall (measured in-house):** two incompatible reference recipes — `index_timestep_zero` (ostris/ai-toolkit t=0; the style-reference LoRA's recipe) vs `index` (core's real-timestep; identity-edit LoRAs' recipe). "identity LoRA + t=0 destroys the" result (A/B in Kreatine `docs/research/2026-09-14-core-ref-ab.md`) [DOC-local]. Expose recipe as a per-LoRA property in the registry, never a global.
- **VRAM at 24 GB:** measured on a 3060 12 GB (fp8): peak ~11.8 GB at 1920×1080/6 steps, 1280×720/6 steps = 28.4 s, 1920×1080/8 = 88 s, TE-swap overhead 3.5–4.5 s/sampler run, ComfyUI boot 49 s [COMM](https://games.mediapixel.kr/blog/krea2-turbo-comfyui-low-vram-guide). On 24 GB the whole fp8 stack (~18 GB weights) co-resides with headroom; "reasoning" prompt mode adds 30–50 s/run [COMM, same].
- **Templates:** `image_krea2_turbo_t2i`, `image_krea2_turbo_int8_image_style_reference` [DOC](https://docs.comfy.org/tutorials/image/krea/krea-2).
- **Quant policy:** fp8_scaled (recommended default) or int8_convrot; NVFP4/MXFP8 exist officially — excluded by policy [DOC](https://docs.comfy.org/tutorials/image/krea/krea-2).

### 3.2 Path card — Anima (lightweight anime stills)

- **What:** 2 B open-weights anime-focused T2I (Circlestone Labs), image-only ("generates images or video from text and image prompts" per the model page, but the ComfyUI tutorial is T2I-only; no photorealism, weak typography, "plainer compositions" in base) [DOC](https://comfy.org/p/supported-models/anima-base-v1-0/), [DOC](https://docs.comfy.org/tutorials/image/anima/anima), released ~Jan 2026, iterations Preview 2/3 → Base v1.0 [COMM](https://note.com/yoya48/n/n6cb08878780e?hl=en).
- **Files:** `anima-base-v1.0.safetensors` (or `anima-preview3-base.safetensors`), TE `qwen_3_06b_base.safetensors` (Qwen3-0.6 B), VAE `qwen_image_vae.safetensors` — **VAE shared with Krea 2** [DOC](https://docs.comfy.org/tutorials/image/anima/anima).
- **Sampling:** steps/CFG left to the template ("fine-tune with steps and CFG scale"); exact official numbers not published — **UNK** beyond template defaults [DOC](https://comfy.org/workflows/image_anima_preview-cc053bb55df6/).
- **2-stage:** no official two-stage; community pattern is base-gen + upscale (e.g. "Anima Base & Microsoft Lens" walkthrough incl. upscaling [COMM](https://www.youtube.com/watch?v=hX2Fl8GQqQw); low-VRAM Preview 2 guide [COMM](https://www.youtube.com/watch?v=6WJ-chD2QaM)). Treat as single-stage + our upscaler pass; specifics **UNK**.
- **Templates:** `image_anima_base_v1`, `image_anima_preview` (both use a Subgraph wrapper) [DOC](https://docs.comfy.org/tutorials/image/anima/anima).
- **Quants:** none documented — **UNK** (bf16 checkpoint only listed). 2 B is small enough that this is a non-problem on 24 GB.

### 3.3 Path card — FLUX.2 [klein] (fast edit/reference duty)

- **What:** BFL's klein line, 4 B and 9 B, each in **base** (undistilled, 50 steps, for fine-tuning/LoRA) and **distilled** (4 steps) variants; both sizes do T2I **and image editing incl. single/multi-reference and iterative multi-pass edits** (style transfer, semantic changes, object replace/remove, multi-angle composition) [DOC](https://blog.comfy.org/p/flux2-klein-4b-fast-local-image-editing).
- **Official RTX 5090 numbers:** 9B distilled: 4 steps, ~2 s, **19.6 GB VRAM**; 9B base: 50 steps, ~35 s, 21.7 GB; 4B distilled: 4 steps, ~1.2 s, 8.4 GB; 4B base: 50 steps, ~17 s, 9.2 GB [DOC](https://blog.comfy.org/p/flux2-klein-4b-fast-local-image-editing).
- **TE:** **Qwen3-4B** (hidden states from layers 9/18/27) — NOT the Mistral Small 24 B encoder (that belongs to FLUX.2 Dev/Max) [COMM](https://medium.com/@geronimo7/flux-2-klein-how-inference-works-05553fcdbe7e), [COMM](https://huggingface.co/blog/flux-2), [COMM](https://github.com/kohya-ss/musubi-tuner/issues/886).
- **Quants:** official bf16, **fp8** (NVIDIA+BFL co-engineered, ~40% VRAM cut, ~40% faster), nvfp4 (excluded by policy) [DOC](https://blog.comfy.org/p/flux2-klein-4b-fast-local-image-editing), [COMM](https://www.reddit.com/r/comfyui/comments/1p6jv7m/new_flux2_image_gen_models_optimized_for_rtx_gpus/). Community framing: 9B fp8 ≈ 14–16 GB total pipeline [COMM](https://willitrunai.com/blog/flux-2-klein-9b-vram-requirements).
- **Templates:** `image_flux2_klein_text_to_image`, `image_flux2_klein_image_edit_{4b,9b}_{base,distilled}` [DOC](https://blog.comfy.org/p/flux2-klein-4b-fast-local-image-editing).
- **2-stage:** not a documented pattern — klein's own base/distilled split plus 4-step distilled edit passes *are* the speed story; our 2-stage surface maps to "distilled for preview, base for hero" rather than base-then-refine.

### 3.4 Pipeline shape to expose in-app

- **Per-model card:** checkpoint (quant options filtered by the no-NVFP4 policy: bf16/fp8/int8-convrot where each exists), LoRA slots (Krea 2: 9 style + style-reference + identity-edit with recipe flag + ostris edit LoRAs; klein: community LoRAs; Anima: community), steps/CFG/guidance per variant (RAW 52 vs Turbo 8; base 50 vs distilled 4; Anima template defaults), sampler presets.
- **VLM-assisted prompting (where our LLM layer plugs in):** three of the four families officially expect a prompt-rewrite/refinement stage — OpenVDN *strongly recommends* rewriting prompts (H3-Context-IR or official prompt skills) before Qwen3-VL encoding [DOC](https://huggingface.co/OpenVDN/vdn-minimax-h3); Krea 2 Turbo's default is "prompt enhancement enabled" [DOC](https://docs.comfy.org/tutorials/image/krea/krea-2); Anima community flows use AI-assisted prompting (Gemma) [COMM](https://www.youtube.com/watch?v=hX2Fl8GQqQw). Our local LLM layer (llama.cpp router, DeepSeek V4 Flash system prompts, 8-layer composer, vision captioning) is the natural engine for all of them; the conditioning cache (§2.5) keys on the *post-refinement* prompt.
- **Deterministic graphs:** graph factory emits per-model graphs from these cards; entry-off graphs must deep-equal golden snapshots (existing discipline).

### 3.5 Hand-off into H3 flows

- First/last-frame: `MiniMaxH3ImageToVideo` takes optional `first_frame`/`last_frame` ("the model generates the motion between them"); R2V takes up to **9 reference images, 3 reference videos, 3 audios**, tagged `<Picture 1>`… in connection order with roles (identity/style/motion/camera/voice); `ref_image_size: match` (faster) vs `max` (2048 px short edge, better identity) [DOC](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native).
- The stills pipeline should emit: (1) the image, (2) its conditioning cache entry (if the same TE family), (3) a role-tagged manifest so the H3 graph factory can wire `Picture N` order deterministically.
- The testbed also holds a T=1 image VAE (`minimax_h3_t1_image_vae_step1597.safetensors`) for 1-frame H3-family image gen [DOC-local, Kreatine testbed inventory] — the maintainer's FL2VA/Ref2VA start-frame interest maps to first_frame + this path.
- Duration/resolution contract for H3 (for the hand-off UI): 32-px grid, native 768 short edge (1344×768 = 0.98 MP; avoid the 1.0 MP preset), durations snap to 17k+5 frames @ 24 fps (5, 22, 39…) [DOC](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native).

### 3.6 VRAM budget table — realistic session on 24 GB (dynamic VRAM; weights in file-backed RAM, faulted per layer)

File sizes are [DOC]/[COMM]/[DOC-local] as cited above; *co-residency* rows are our arithmetic on top (**SPEC** — our benchmark harness should own the measured numbers; peak working-set during sampling is smaller than file size because aimdo faults per layer).

| Component | File size | Notes |
|---|---|---|
| H3 DiT 33B int8-convrot (FL2VA) | ~21 GB [COMM](https://comfyui-wiki.com/news/2026-08-03-minimax-h3-community-quants) | pruned INT4 11.3 / mixed 15.5 / nvfp4 12.5 (excluded) |
| H3 TE Qwen3-VL-32B int8-convrot | 26.4 GB [DOC-local] | cacheable away entirely (§2.5) |
| H3 video VAE fp16 + audio VAE fp32 | small; exact sizes **UNK** [COMM quants guide] | |
| VDN stage (int8 convrot) | 2.2 GB (bf16: 4.3 GB) [DOC-local spec.py] | identical output either way |
| Krea 2 Turbo fp8 DiT + TE + VAE | 12.5 + 5.2 + ~1 GB [COMM](https://games.mediapixel.kr/blog/krea2-turbo-comfyui-low-vram-guide) | int8-convrot DiT exists officially |
| FLUX.2 klein 9B distilled (fp8) | ≈14–16 GB total pipeline [COMM](https://willitrunai.com/blog/flux-2-klein-9b-vram-requirements); peak 19.6 GB bf16-5090 [DOC](https://blog.comfy.org/p/flux2-klein-4b-fast-local-image-editing) | 4B distilled: 8.4 GB peak |
| Anima 2 B + Qwen3-0.6B TE + qwen VAE | ~4–5 GB total (**UNK** exact) | trivially co-resident |

| Session shape | Fits 24 GB VRAM simultaneously? | What swaps | Expected switch cost |
|---|---|---|---|
| H3 stack alone (DiT+VAEs+VDN, TE cached away) | Yes, comfortably — fork-validated at 0.4/0.8 MP | nothing during sampling | — |
| H3 stack + TE encode (uncached prompt) | No — TE streams over DiT pages | TE↔DiT ping-pong during encode, then TE drops | multi-minute worst case if #14076 bites; seconds when healthy [COMM] |
| H3 resident + Krea 2 Turbo detour | Weights: no (21+12.5 GB); working sets interleave via aimdo | image DiT faults in over inactive H3 pages | seconds (RAM-speed) healthy; canary threshold §2.4 |
| H3 resident + klein 4B distilled detour | Practically yes (8.4 GB peak) | minimal | ~1–2 s gen time itself [DOC] |
| H3 resident + Anima detour | Yes | none meaningful | negligible |
| Krea 2 + klein + Anima (image-only session) | Yes, all three | — | — |

---

## 4. Source list (tagged)

**VDN primary**
1. VideoDeltaNet project page (mechanism, benchmarks, training stages, boundary anchors) — https://openvdn.github.io/ [DOC]
2. OpenVDN/vdn-minimax-h3 (code; checkpoint layout; DMD2 from larryvrh v4; 24–32 GB block streaming, 345f ≈ 20 GB peak; license) — https://github.com/OpenVDN/vdn-minimax-h3 [DOC]
3. OpenVDN/vdn-minimax-h3 model card (82 GB layout, 8-NFE settings, Qwen3-VL encoding + prompt rewriting recommendation, license territories) — https://huggingface.co/OpenVDN/vdn-minimax-h3 [DOC]
4. Saganaki22/ComfyUI-VDN-H3 (the port: runtime model patches, no core changes, zero deps, turbo adapter REPLACES community LoRAs, 5090 int8 measurements, sol-attn conflict, compiler handling, v1.5.x fixes) — https://github.com/Saganaki22/ComfyUI-VDN-H3 [DOC/shipped code]
5. ComfyUI wiki VDN news — https://comfyui-wiki.com/en/news/2026-09-04-vdn-h3 [COMM]
6. Maintainer's 24 GB fork (README, CHANGELOG 1.1.0, VALIDATION_RESULTS 3090 table, spec.py sizes, longcache.py design, block-loop hook installer) — /home/agent/work/scratchpad/ComfyUI-VDN-H3-24GB/ [DOC-local]
7. VDN int8-convrot stage checkpoint — https://huggingface.co/speach1sdef178/VDN-H3-INT8-ConvRot-ComfyUI [DOC]

**Turbo/acceleration ecosystem**
8. larryvrh/MiniMax-H3-Turbo-Lora — https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora [DOC] + local ComfyUI-MiniMax-H3-Turbo node README (v4-600 vs v1-850 decision tree) [DOC-local]
9. lightx2v/Minimax-h3-Turbo — https://huggingface.co/lightx2v/Minimax-h3-Turbo [DOC]; wiki coverage https://comfyui-wiki.com/news/2026-08-07-minimax-h3-turbo-lightx2v [COMM]; 4-step v1.2 thread https://www.reddit.com/r/StableDiffusion/comments/1w700sm/ [COMM]
10. drbaph/MiniMax-H3-Turbo-Lora-ComfyUI (VDN-extracted LoRAs) — https://huggingface.co/drbaph/MiniMax-H3-Turbo-Lora-ComfyUI (mirror https://ai.atomgit.com/hf_mirrors/drbaph/MiniMax-H3-Turbo-Lora-ComfyUI) [COMM]
11. PDD: aptech0081/MiniMax-H3-Acc-LoRAs-ComfyUI — https://huggingface.co/aptech0081/MiniMax-H3-Acc-LoRAs-ComfyUI [DOC]; Deno loader https://comfy.icu/node/DenoMiniMaxH3AccLoader [COMM]; native support in v0.35.0 changelog [DOC]
12. Motion Context (pinned rows, turbo thickening, Spectrum misprediction, chain config) — https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context [COMM/shipped code]; v0.2.0 notes https://www.reddit.com/r/StableDiffusion/comments/1vjvx4l/ [COMM]
13. H3 speed stack community thread (res_multistep 2.46×, EasyCache stacking ~70%) — https://www.reddit.com/r/StableDiffusion/comments/1vfannp/ [COMM]; RH pack https://github.com/HM-RunningHub/ComfyUI_RH_MinMaxH3 [COMM]
14. OpenVDN community thread (partial speedup-LoRA idea) — https://www.reddit.com/r/StableDiffusion/comments/1w5sosg/ [COMM]

**ComfyUI memory system**
15. Startup flags (cache/VRAM/offload flag semantics) — https://docs.comfy.org/development/comfyui-server/startup-flags [DOC]
16. Dynamic VRAM blog (aimdo, VBAR/fault, no VRAM→RAM unload, mmap loader) — https://blog.comfy.org/p/dynamic-vram-in-comfyui-saving-local [DOC]
17. Changelog (dynamic VRAM default v0.16.0; CUDA graphs v0.33.1; Comfy Compiler + PDD + cgroup RAM v0.35.0; VDN absent from core) — https://docs.comfy.org/changelog [DOC]
18. Evicted-models-reload-from-disk bug — https://github.com/Comfy-Org/ComfyUI/issues/14076 [DOC/open]
19. H3 denoise_mask grid artifact — https://github.com/Comfy-Org/ComfyUI/issues/15981 [DOC]
20. TE eviction horror numbers — https://comfy.icu/models/2834385/MiniMax-H3-Text-Encoder-GGUF-Qwen3-VL/3198647/v1-0 [COMM]; resident-mode pinning https://www.reddit.com/r/StableDiffusion/comments/1vkk500/ [COMM]; TE guide https://www.instasd.com/post/minimax-h3-text-encoder-guide-comfyui [COMM]
21. Conditioning cache precedents: LTXV save/load conditioning; WanVideoWrapper #1794 https://github.com/kijai/ComfyUI-WanVideoWrapper/issues/1794 [COMM]; GGUF #422 https://github.com/city96/ComfyUI-GGUF/issues/422 [COMM]; CachingCLIPTextEncode https://comfy.icu/node/CachingCLIPTextEncode [COMM]; maintainer's musubi-tuner TE-cache precedent /home/agent/work/krea2-lora-setup.sh [DOC-local]

**H3 official docs**
22. MiniMax H3 native tutorial (turbo_mode files/steps, R2V refs/limits, AddGuide, denoise_mask, 17k+5 grid, 32-px grid) — https://docs.comfy.org/tutorials/video/minimax/minimax-h3-native [DOC]
23. MiniMax H3 tutorial (SageAttention ~2×, KJ patch node, --use-sage-attention, dtype fallback) — https://docs.comfy.org/tutorials/video/minimax/minimax-h3 [DOC]
24. Community quants (sizes/tiers/GPU fits) — https://comfyui-wiki.com/news/2026-08-03-minimax-h3-community-quants [COMM]

**Image models**
25. Krea 2 tutorial (RAW/Turbo, files, quants incl. official int8-convrot, style/reference LoRAs, templates) — https://docs.comfy.org/tutorials/image/krea/krea-2 [DOC]
26. Krea 2 low-VRAM measured numbers — https://games.mediapixel.kr/blog/krea2-turbo-comfyui-low-vram-guide [COMM]
27. Kreatine node pack (two-stage single-resident-model sampler, identity recipe switch, LoRA bridge) — local /home/agent/work/VS Proj/Kreatine/testbed/ComfyUI/custom_nodes/ComfyUI-Kreatine/ [DOC-local]
28. Krea 2 ostris edit nodes — https://github.com/ostris/ComfyUI-Krea2-Ostris-Edit [DOC]; Krea2T enhancer — https://github.com/capitan01R/ComfyUI-Krea2T-Enhancer [COMM]
29. Anima tutorial + model page + workflow — https://docs.comfy.org/tutorials/image/anima/anima ; https://comfy.org/p/supported-models/anima-base-v1-0/ ; https://comfy.org/workflows/image_anima_preview-cc053bb55df6/ [DOC]; release context https://note.com/yoya48/n/n6cb08878780e [COMM]
30. FLUX.2 klein blog (variant matrix, 5090 numbers, edit modes, templates, fp8/nvfp4) — https://blog.comfy.org/p/flux2-klein-4b-fast-local-image-editing [DOC]; klein TE = Qwen3-4B: https://medium.com/@geronimo7/flux-2-klein-how-inference-works-05553fcdbe7e , https://huggingface.co/blog/flux-2 , https://github.com/kohya-ss/musubi-tuner/issues/886 [COMM]
31. klein VRAM community framing — https://willitrunai.com/blog/flux-2-klein-9b-vram-requirements ; https://www.thundercompute.com/blog/flux-comfyui-ai-image-generation ; https://www.reddit.com/r/comfyui/comments/1p6jv7m/ [COMM]

**Internal priors (our own docs)**
32. h3-transitions-and-latent-continuity.md (turbo pinned-row disqualification, 20-step experiment discipline, loopforge timings) — docs/research/ in this repo [DOC-internal]
33. ecosystem-2026-09.md (template inventory incl. max_turbo, speed-stack consensus, Sol-Attn, quant guide) — same [DOC-internal]

---

### Open items this research could not close (UNK, worth targeted tests)

1. VDN+turbo on pinned rows: no published measurement — needs our harness (matched seeds, anchor-fidelity dB).
2. res_multistep × VDN interaction: unmeasured anywhere we found.
3. Anima quant options and official steps/CFG: not published.
4. Exact healthy-instance H3→image→H3 switch seconds on 0.34/0.35 with our file set: unmeasured — benchmark harness should own it (also the #14076 canary).
5. Whether ComfyUI core will add a block-loop extension point (would obsolete the LongCache hook) — watch changelog; not present through v0.35.1.

---

## ADDENDUM — tranche 3b measured (2026-09-16, Flux a80ekav): tier ladder at held seed + VDN first-hand + MATLOWAI fused-turbo

- **Held-seed tiers**: same seed across tiers = a SIBLING TAKE (pairwise 18.2–25.0 dB,
  motion lag 0, ArcFace flat 0.09–0.24). Two independent blind passes ranked
  **8-step turbo SHARPEST** (t8 > vdn20 > t25 > t20; t20 "waxy, no weave", t25
  "milky haze") — plain 20/25-step tiers buy NO visible still detail at 480p
  ref-mode; 25 costs +23% wall over 20. Tier value beyond turbo = motion/audio/
  pinned-row robustness, NOT sharpness. UI: "lock→rerun-at-hero" labeled SIBLING
  TAKE; preview tier is not a still-detail sacrifice; full tier stays at 20.
- **VDN-8 first-hand** (our staged config): 23.0 s/step exact ×8 = 189s sampling,
  270s wall-with-reload @10s/0.4MP. Gap to the maintainer's 15.74 = their
  int8-convrot STAGE + AutoLongCache (both identified upgrades; the LongCache
  hook is our consent-patch tier).
- **MATLOWAI fused-turbo**: ref2va-at-4-step VERIFIES decisively — blind
  clear-gap over larryvrh-v4@8, ArcFace 0.37–0.40 (highest identity band of any
  arm measured), 0.75× wall (87.9s vs 117.3s). Counters: Mystic v2.0 folded in
  (style-opinionated checkpoint); no VRAM saving at 480p. Mechanism:
  merged-then-quantized beats quantize-then-LoRA-merge on the shipped path.
  New Ref2VA fast-tier DEFAULT CANDIDATE — maintainer call: default vs
  labeled-option given the baked style.
