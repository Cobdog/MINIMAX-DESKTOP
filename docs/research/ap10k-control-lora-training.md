# AP-10K control-branch LoRA/finetune — feasibility for closing the E-FC1 quadruped gap

> Compiled 2026-09-15 (Flux task `rl5foce`). Question: can we train an AP-10K-focused adapter on the Fun Control **control branch** (MiniMax-H3) to close the ~3× keypoint-error gap E-FC1 measured for quadruped skeletons (arm B: 40.7 mean / 73.8 max px vs human arm A: 13.9 / 26.0)? Everything needed for go/no-go on the maintainer's machine (RTX 3090 24 GB, 112 GB RAM, 229 GB free disk), dataset + licensing, the assembly pipeline, and a scoped first attempt.
>
> Method: the trainer's actual code was read from a shallow clone of aigc-apps/VideoX-Fun @ `968f0e2` (2026-09-04) — README claims were checked against the code, and one of them is wrong (§2.1). Checkpoint formats were verified by byte-range reads of safetensors headers on Hugging Face. Tags: **[DOC]** verified in shipped code / official source (incl. my code reads and header probes), **[COMM]** reputable community finding, **[SPEC]** plausible-unverified, **[UNK]** nobody documents it. Continues `docs/research/fun-control-input-surface.md` (input surface + E-FC1) and `docs/research/h3-lora-form-compatibility.md` (adaln forms + the M-projection); specs pinned there are not re-derived.

---

## 0. VERDICT: **GO-WITH-ADAPTATION** (as-shipped trainer on one 24 GB card: **NO-GO**)

- **The trainer cannot run as-shipped on a single 24 GB card.** The script's only whole-model residency moves (`transformer.to(device)` under `low_vram` juggling) require the 66 GB bf16 transformer to fit the GPU at once; the FSDP recipe assumes sharding across many GPUs; DeepSpeed-ZeRO-2 is explicitly called out as OOM in the trainer's own README; and the one flag the README advertises for small cards (`--offload_every_step`, "cards far below 62 GB") **is dead code** — accepted by argparse in all four H3 train scripts, referenced nowhere in any script body **[DOC, grep-verified]**.
- **A single 3090 attempt is viable after ~2 weeks-equivalent of plumbing** (mostly one code change): precompute text embeddings so the 62 GB Qwen3-VL conditioner never has to be resident, then run the shipped-but-unused `config/zero_stage3_config_cpu_offload.json` (DeepSpeed ZeRO-3, params + optimizer on CPU) or FSDP world=1 + `--fsdp_offload_params`, at small geometry, hot-started from the released union checkpoint. Expected **~2–6 min/step** at 10–20 k tokens; a 600-step first attempt ≈ **1–3 days continuous** on the 3090.
- **The same first attempt rented is ~$30–60 and under a day** (2×A100/H100 80 GB runs the stock FSDP recipe at our small geometry with optimizer offload). If the maintainer's time is worth more than the experiment's GPU bill, rent.
- **Biggest single blocker: system RAM, not VRAM.** 66 GB CPU-offloaded weights + 27 GB fp32 Adam states (3.402 B trainable) + 62 GB text encoder = 155 GB > 112 GB. Text-embedding precompute (a code change the trainer does not have) is mandatory for the single-card path; without it no backend choice saves you.
- The trained artifact needs a **format conversion to land in our ComfyUI stack** (trainer emits diffusers-layout full-width-adaln control weights; our staged base is curve-form pruned int8) — the conversion is 90% machinery we already own and NUM-verified for the adaln step (§1.5).
- Dataset: no usable video-native quadruped corpus is redistributable; the pipeline is **self-assembly from user-fetched video with the staged `rtmpose-m_ap10k` estimator producing the control renders** (§3–§4). AP-10K itself is CC-BY-4.0 but stills-only — bootstrap material, not trainer food.

---

## 1. Trainer requirements, verbatim (aigc-apps/VideoX-Fun, `scripts/minimax_h3_fun/`)

### 1.1 Data format — the triplet manifest [DOC]

`VideoSpeechControlDataset` (`videox_fun/data/dataset_video.py:725`) reads a JSON list; per sample:

```json
{
  "file_path": "train/clip0001.mp4",          // target video (relative to --train_data_dir or absolute)
  "control_file_path": "control/clip0001.mp4",// REQUIRED — the control-render video
  "audio_path": "wav/clip0001.wav",           // OPTIONAL — absent ⇒ audio decoded from the video container
  "text": "A brown dog trots across a lawn",  // English caption (10% random drop for CFG)
  "type": "video",
  "width": 832, "height": 480                 // recommended (bucketing; else read at train time)
}
```

Hard constraints the loader enforces (all raise → the sample is skipped and another is drawn) **[DOC, dataset_video.py:814-1088]**:

- **Frame alignment is by index**: the control video is read with the *same `frame_indices`* computed from the target video — control and target must have identical frame counts and fps on disk (assembly must cut them as exact pairs) **[DOC :941-957]**.
- **fps ≈ 24 required**: source fps/stride must land within 24 ± 0.5 fps (23.976 passes; 25 and 29.97/30 are rejected — resample at assembly time) **[DOC :842-862]**.
- **Audio span must match** the sampled clip's real-time span (`frame_periods / 24` s) within one frame period + 30 ms; a missing/short audio track raises "Audio file too short" **[DOC :998-1078]**. A video with **no audio track fails** (the container decode returns nothing to slice) — so silent sources must be muxed with a silent track. This is cheap: the released YAML pins `control_apply_audio: false` (§1.3), which zeroes the audio rows out of every control skip, so audio content only couples into the control branch via cross-row attention — **silent audio is an acceptable first-attempt substitute for real animal audio** (weak-coupling argument [SPEC]; verify in the first run's loss curves).
- Frame counts follow the **17n+5 grid** (5, 22, 39, …; ≤ 15 s @ 24 fps); clips yielding < 5 sampled frames are unusable **[DOC :1103-1119]**.
- Batch size is **pinned to 1** (packed-sequence layout is per-sample; `--train_batch_size != 1` raises) **[DOC train_control.py:1112-1116]**.

The official demo dataset (`modelscope PAI/X-Fun-Videos-Controls-Demo`) is the format reference: `metadata_add_width_height_add_wav.json` is the recommended manifest **[DOC README §2.1]**.

### 1.2 Model downloads and precision — what training actually needs [DOC]

- Base: `MiniMax-AI/MiniMax-H3` (HF; original FL2VA partition, 14-shard 62 GB text encoder + ~66 GB transformer + VAEs ≈ **130 GB download**; the loader converts original shards on the fly, no intermediate copy). Our staged int8-convrot ComfyUI weights are **unusable for training** — the trainer has no quantized-weight training path; training rides the bf16 full checkpoint **[DOC README §3.1]**. (Disk: 229 GB free today ⇒ fits once, but see the checkpoint-discipline note in §2.4.)
- Control hot start: `PAI/MiniMax-H3-Fun-Controlnet-Union` (ModelScope; same file on HF `alibaba-pai/…`) via `--transformer_path` (loaded `strict=False`) **[DOC train_control.py:867-878]**. Header-probed: **74 tensors, 6.81 GB, 3.402 B params, diffusers layout, full-width adaln `[96768, 2688]`** **[DOC, HF range-read]** — this is the *trainer-format* control-only file (keys `control_blocks.N.attn.to_q/to_k/to_v/to_out.0`, `attn.norm_q/norm_k`, `ff.net.0.proj`, `ff.net.2`, `adaln_proj.linear`, `before_proj/after_proj`, `control_proj_in`).
- Mixed precision: bf16 (`--mixed_precision bf16`); the model pins patch projections (incl. `control_proj_in`) and the two output heads in fp32 (`_keep_in_fp32_modules`), preserved at save **[DOC train_control.py:950-960]**.

### 1.3 Control-branch config — what `--trainable_modules control` trains [DOC]

- YAML `config/minimax_h3/minimax_h3_control.yaml` (inpaint/union layout): `control_blocks_places: [0,10,20,30,40]`, `control_in_dim: 49` (= control latent 24 + visibility 1 + masked-source 24, requires `--enable_inpaint`), **`control_apply_audio: false`**. The mask-less twin (`minimax_h3_control_only.yaml`) uses `control_in_dim: 24`. A checkpoint of one layout cannot load into the other; **our fine-tune must keep the 49/inpaint YAML to stay compatible with the released union checkpoint and our staged ComfyUI patch** **[DOC README §3.2]**.
- Trainable set = every parameter whose name contains the substring `control`: the 5 `control_blocks.*` (full copies of main blocks: attn + swiglu ff + adaln each ≈ 0.645 B), their zero-init `before_proj`/`after_proj` (5376×5376 linears), and `control_proj_in` (196→5376). **Exactly 3.402 B trainable params** (arch math matches the released file: 5×0.645B + 6×28.9M + 1.05M ≈ 3.40B) — 38% of it is adaln (5 × 260 M). The FSDP quirk: under FSDP the script sets `requires_grad=True` on *everything* (so frozen units reshard promptly) and the optimizer is matched **by name** — the trainable set stays the control branch **[DOC train_control.py:898-912, 1036-1070]**.
- **No LoRA option exists in the control trainer** — `scripts/minimax_h3_fun/train_control.py` has zero LoRA arguments; the repo's LoRA trainer (`scripts/minimax_h3/train_lora.py`) is base-model-only (no `control_file_path` support) **[DOC, grep]**. But `MiniMaxH3ControlTransformer3DModel` inherits `PeftAdapterMixin` and its forward already calls `scale_lora_layers` — attaching a PEFT LoRA to `control_blocks.*` targets is a natural ~100–200-line port with a dramatically better RAM profile (§2.3) **[SPEC]**.
- Recipe defaults worth keeping: lr 2e-5 constant-with-warmup (100), AdamW (wd 3e-2, eps 1e-10), max_grad_norm 0.05, **10% of batches zero the control latents** (keeps the unconditional path alive), uniform timestep sampling, gradient checkpointing + save-on-CPU, `VIDEOX_OFFLOAD_VACE_LATENTS=True` (the control-stream skip stack rides CPU between control blocks) **[DOC README §3.3 + train_control.py:1690-1700]**.
- CFG distillation (`train_control_distill.py`, lr 2e-6) is a **second stage we do not need for the first attempt** (the released branch is already guidance-distilled; the E-FC1 comparison runs at guidance 1.0) **[DOC README §3.9]**.

### 1.4 Trainer output and checkpointing [DOC]

- Checkpoints serialize the **whole 33 B transformer** (main + control) in diffusers layout: `<out>/checkpoint-N/transformer/diffusion_pytorch_model.safetensors` + `config.json` — **66 GB per checkpoint**. `checkpointing_steps=50` at face value fills the 229 GB free disk in three saves; the run must set `--checkpoints_total_limit 1` and/or export control-only immediately (§2.4) **[DOC train_control.py:925-964]**.
- `scripts/minimax_h3_fun/extract_control_weights.py` writes the control-only file (74 tensors, 6.8 GB) and stamps `control_blocks_places` / `control_in_dim` as safetensors metadata — this is byte-compatible with what `--transformer_path` expects and with the released union file's structure **[DOC]**.

### 1.5 Trainer-output → ComfyUI-loadable conversion (the last mile) [DOC]

ComfyUI's `ModelPatchLoader`/`MiniMaxH3FunControl` (`comfy/ldm/minimax/controlnet.py`, `comfy_extras/nodes_model_patch.py:272-313`) expects a *different* key set than the trainer emits. Verified against our staged patch (`models/model_patches/minimax_h3_fun_controlnet_union_pruned_int8_convrot.safetensors`, header-probed: 104 tensors, metadata `minimax_h3_fun_controlnet: adaln_basis`):

| Trainer / released-union key | ComfyUI key | Transform |
|---|---|---|
| `attn.to_q/.to_k/.to_v` (3× [7168,5376]) | `attn.qkv_proj.weight` [21504,5376] | concat dim 0 in q,k,v order (matches ComfyUI's `split(inner*3)`) |
| `attn.to_out.0.weight` | `attn.out_proj.weight` | rename |
| `attn.norm_q` / `attn.norm_k` | `attn.q_norm` / `attn.k_norm` | rename |
| `ff.net.0.proj` [28672,5376] | `mlp.fc1` | rename **+ verify gate/value half order** (diffusers↔ComfyUI H3 fc1 halves are documented swapped — matsuo-koya; must be settled with a tiny-tensor A/B, not assumed) |
| `ff.net.2` [5376,14336] | `mlp.fc2` | rename |
| `adaln_proj.linear.weight` [96768,2688] | [96768,8] (curve) | **centered `[C|1]` M-projection + bias delta — the exact math (and 0.2% NUM-verified residual) we shipped in `custom-nodes/minimax-lora-form-adapter`** (h3-lora-form-compatibility.md §4/§8); keep fp32 like the staged file |
| everything else (norms, before/after_proj, control_proj_in) | same names | cast bf16 (int8 convrot optional) |

Plus metadata: `minimax_h3_fun_controlnet: adaln_basis`, `control_blocks_places`, `control_in_dim`, `format: pt`. The adaln step is mandatory **because our base is curve-form** — `init_stream` hard-fails on a form mismatch ("the controlnet and base checkpoint use different adaln forms … convert the controlnet to match the base model") **[DOC controlnet.py:42-48]**. Escape hatch: ComfyUI also loads full-width control files (no `adaln_basis` metadata ⇒ `time_embed_dim=2688`) onto a **full-width base** (Comfy-Org 34 GB int8_convrot), skipping the projection — fine for a one-off E-FC1 rerun, wrong for shipping against our pruned stack.

---

## 2. Single-24 GB feasibility — the go/no-go core

### 2.1 What the trainer actually supports [DOC]

| Mechanism | Status in code |
|---|---|
| FSDP1 `FULL_SHARD` (the README recipe) | Works; assumes **multi-GPU sharding** (their context: 8×80 GB — 62 GB transformer + 62 GB conditioner "must be sharded across GPUs"). With world=1 it shards nothing. |
| FSDP2 | Same sharding assumption; accelerate upcasts to fp32 under mixed precision (**~2× sharded param memory**) — worse for us **[DOC README §3.6]** |
| `--low_vram` | Keeps VAEs + conditioner on CPU, **moves the whole 66 GB transformer `.to("cpu")` / back per step** — impossible on 24 GB (the `.to(device)` itself OOMs) **[DOC train_control.py:1615-1618]** |
| `--offload_every_step` ("cards far below 62 GB") | **DEAD CODE** — argparse entry only, zero references in any of the four H3 scripts' bodies **[DOC, repo-wide grep]**. The README row oversells it. |
| DeepSpeed ZeRO-2 | Explicitly documented as OOM for H3 (params not sharded) **[DOC README §3.7.1]** |
| DeepSpeed **ZeRO-3 + CPU offload** | **`config/zero_stage3_config_cpu_offload.json` ships in the repo** (offload_optimizer + offload_param → CPU, bf16, `stage3_max_live_parameters 1e9`) — unused by any H3 doc, but this is the designed sub-VRAM path and should drive on a single rank **[DOC file; single-rank ZeRO-3 = standard DeepSpeed behavior]** |
| FSDP world=1 + accelerate `--fsdp_offload_params` | Not in any shipped launch script; standard accelerate capability; per-block CPU↔GPU streaming via reshard hooks **[SPEC — not exercised by upstream]** |
| 8-bit Adam (`--use_8bit_adam`) | Present (bnb AdamW8bit) **[DOC train_control.py:1073-1080]**; compatibility with ZeRO-3 optimizer offload / FSDP CPU flat-params is **[UNK]** (DeepSpeed wants its own CPUAdam for offload; bnb states may not be CPU-tensor-friendly) |

**Community precedent, single-GPU H3 training:** musubi-tuner has full H3 **base-model** LoRA support (BF16, int8 pre-quant loading, adaln-pruned self-conversion, text-encoder streaming; roadmap issue #1029) and single-24 GB H3 LoRA runs are demonstrated (Inline Studio: **20.5 GB peak** during caption caching, training itself 11.7 GB, ~1.8 s/step stills on an L4; ai-toolkit trains H3 T2V/I2V on consumer cards) **[COMM]**. **No trainer but VideoX-Fun can train the control branch** — musubi's roadmap has no control/VACE item; ai-toolkit/Inline Studio document none **[DOC-by-absence, checked 2026-09-15]**. So the precedent de-risks "33 B model + CPU streaming on 24 GB" as a category, not our specific script.

### 2.2 VRAM/RAM budget — smallest viable single-card configuration

Assumed run: hot start from released union, ZeRO-3-CPU-offload (or FSDP1 world=1 + param offload), bf16, batch 1, gradient checkpointing + save-on-CPU, `VIDEOX_OFFLOAD_VACE_LATENTS=True`, geometry ≈ 352×640×22 f (≈19.4 k packed tokens) or 256×448×39 f (≈9.9 k) — both on the 17n+5 grid, below E-FC1's 480×832×39 (61 k tokens).

**GPU (fits 24 GB comfortably):**

| Item | @ ~10 k tokens | @ ~19 k tokens |
|---|---|---|
| Live gathered params (ZeRO-3 `max_live_parameters 1e9`) | ≤2 GB | ≤2 GB |
| Trainable grads, transient (3.402 B bf16, sharded/prefetched) | ~3.4 GB | ~3.4 GB |
| Per-block recompute transients (flash-attn, checkpointed) | ~1–2 GB | ~2–3 GB |
| VAEs during encode (`low_vram` session) | ~2–4 GB | ~2–4 GB |
| **Peak GPU** | **~9–12 GB** | **~10–14 GB** |

(Consistent with Inline Studio's 11.7 GB training-only figure for H3 LoRA **[COMM]**.)

**System RAM (the binding constraint — 112 GB):**

| Item | fp32 AdamW | w/ LoRA port (rank ~64) |
|---|---|---|
| Offloaded model params (33.1 B × 2 B bf16) | 66.2 GB | 66.2 GB |
| Optimizer states, 3.402 B trainable on CPU | **27.2 GB** (fp32 exp_avg+exp_avg_sq) | ~0.3–0.5 GB |
| Trainable param grads staged on CPU | ~3.4–6.8 GB | <0.1 GB |
| Saved activations (50 blocks × seq×5376×2 B, save-on-CPU) | 5.3 GB @10 k / 10.4 GB @19 k | same |
| VAEs + audio VAE + latents + 8 dataloader workers | ~4–6 GB | same |
| Qwen3-VL text encoder (62.1 GB) | **must be eliminated** (155 GB total if resident) | same |
| **Total** | **~101–110 GB — knife-edge** | **~77–84 GB — comfortable** |

Conclusions: (a) **text-embedding precompute is mandatory** (one-time 62 GB encoder load → encode all captions → free; a ~50–150-line patch: cache `prompt_embeds` keyed by text, bypass `_offload_scope(text_encoder)` in the step loop, skip loading the encoder at startup); (b) with full-branch training the fp32-Adam RAM total leaves < 10 GB headroom at 19 k tokens — run at ~10 k tokens, precompute **and cache target/control VAE latents** too if more headroom is needed, or take the LoRA port; (c) 8-bit Adam would save 20 GB if it proves compatible (UNK, test early).

### 2.3 Iteration time, honestly

Per step at 10–20 k tokens on a 3090: compute ≈ 3 × 2 × 33 B × tokens FLOPs = 2–4×10^15, at an effective 11–14 TFLOPS (bf16 small-batch) ≈ **150–350 s**, plus ~132 GB of PCIe param streaming (fwd + bwd regather) ≈ 10–15 s overlapped. **≈ 2–6 min/step → 10–30 steps/hour.** A 600-step first attempt ≈ **1–3 days continuous**. (For calibration: an 80 GB-class card at the same tokens is ~10–20 s/step; the stock 960×311 f recipe on 8×A100 is the only configuration Alibaba documents timings for, and none.) Sanity anchor for the whole approach: H3 base-LoRA trainers report 1.8 s/step for *stills* (~1 k tokens) on weaker-but-comparable hardware with full caching **[COMM Inline Studio]** — our 10–20 k-token clips are 10–20× that workload, matching the estimate's order of magnitude.

### 2.4 Operational discipline the trainer forces

- **Disk**: 130 GB weights + 66 GB per full checkpoint + dataset. Set `--checkpoints_total_limit 1`; after each keep, run `extract_control_weights.py` (6.8 GB) and delete the full save. Script it; 229 GB free leaves no room for accidents.
- **Validation off** for the first attempt (`--validation_steps` beyond the run length): `log_validation` builds and tears down a full pipeline mid-run.
- **Resume**: `--resume_from_checkpoint latest` works (sampler-position pickle included) — needed for a multi-day single-card run.
- **RAM pressure**: the machine currently shows ~60 GB available with the testbed stack running; training must be exclusive (stop ComfyUI/engine jobs first).

### 2.5 If single-card is rejected: the rented floor

2×A100/H100 80 GB runs the stock FSDP recipe at our small geometry directly (params 33 GB/GPU + sharded optimizer ≈ 60 GB/GPU): **600 steps ≈ 2–4 h**; at 2026 spot rates ($2–4/GPU-h) that is **≈ $10–30 of GPU time**, call it $30–60 with setup/retries/egress. Even 8×A100 for an 8 h block is ~$100–130. The rental path needs none of the §2.2 adaptations except checkpoint discipline — but note the trainer still wants ~120 GB host RAM for the text encoder at startup unless precompute is ported first; most rental nodes have ≥ 200 GB.

---

## 3. Dataset landscape + licensing

### 3.1 The candidates

| Dataset | What it is | Format | License | Usable for our trainer? |
|---|---|---|---|---|
| **AP-10K** (NeurIPS 2021; github.com/AlexTheBad/AP-10K) | 10,015 **stills**, 23 families / 54 species, **17-kp** COCO annotations (+~50 k label-only extras) | COCO JSON + images (GDrive/Baidu) | **CC-BY-4.0** (repo statement) **[DOC]** | **No** — `VideoSpeechControlDataset` is video-only (≥5 frames, 24 fps, audio track); stills cannot form a sample. Value: renderer-format validation, species checklist, and captions. Also the keypoint schema the staged estimator emits. |
| **JFoz/AP10K-poses-controlnet-dataset** (HF) | ~7 k rows × (original, conditioning pose render, overlay) 512×512 + caption — SD-era controlnet food | parquet triplets | **none stated on the card** **[DOC]** | No (stills; 512 px; unlicensed). User-fetch-only; do not mirror or one-click. |
| **APT-36K** (NeurIPS 2022; pandorgan/APT-36K) + **APTv2** (2,749 clips) | 2,400 **video clips**, 30 species, **15 annotated frames each** (36 k frames) | COCO frames + annotations (OneDrive); **no audio, no raw video** | repo claims **MIT** (code+data claim; frames are YouTube-sourced — murky underneath) **[DOC/COMM]** | Marginally — 15-frame clips only yield 5-frame samples on the 17n+5 grid; better as a species/behavior checklist than as training video. |
| **AnimalKingdom** (CVPR 2022) | 50 h behavior-annotated video; pose subset (AK-Pose) | clips + annotations | research-use (repository statement) **[COMM]** | Possible clip source if license-cleared; audio present in some clips; posture: user-fetch. |
| **Animal-in-Motion** (arXiv 2511.01169, 2025-11) | **~30 k YouTube quadruped videos**, per-frame auto-annotations (kp/masks/depth); **raw frames NOT redistributed** (YouTube ToS) | scripts + derived annotations | none for frames by design **[DOC paper]** | The **pipeline blueprint**, not a source: GPT query gen → yt-dlp → shot split → CLIP filter → Grounded-SAM2 track → crop. We replicate the shape of it (§4) with our own estimator. |
| **Self-assembled stock/CC video** (Pixabay, Pexels, YouTube CC-BY, user libraries) | unlimited quadruped clips, real audio | mp4 | per-clip licenses (CC-BY / CC0 / stock ToS) | **The primary source.** Users assemble locally with our scripts; we distribute zero bytes of video. |

### 3.2 Licensing verdicts per our standards (we ship a tool; users train locally)

- **We MAY assemble-and-distribute**: nothing video. We ship scripts + prompts + caption templates + QA thresholds + the metadata.json builder. The **trained adapter itself** is a different question (below).
- **AP-10K renders/dannotations**: CC-BY-4.0 permits redistribution with attribution — but the stills don't fit the trainer, so this only matters if we publish a mini pose-render corpus for *validation* (harmless, attributed).
- **JFoz dataset**: no license = all rights reserved. Never bundle, never auto-fetch silently; at most a documented manual link with the caveat.
- **YouTube-sourced anything**: Animal-in-Motion's own posture is the guide — distribute derived annotations/scripts, never frames. Our equivalent: distribute *code*, users keep the bytes.
- **The adapter we would produce**: trained on top of the released Fun-Controlnet-Union, which rides the **MiniMax H3 Community License** (read from the HF repo LICENSE: territory-restricted — **EU/UK/Korea/USA excluded**; distribution of Model Derivatives allowed inside the Applicable Territory with license-copy + modification notices). A control-branch adapter is plainly a Model Derivative. Community practice already publishes H3 LoRAs under these terms (Civitai/HF), so precedent exists, but: (a) if we ever host/serve from an excluded territory, that's a problem we can't fix downstream; (b) our own licensing pass (task 68rnn84) should own the final call. For the *first attempt* (local training, local E-FC1 eval) no distribution happens — the license question only gates publication.
- **The trainer code** (VideoX-Fun): Apache-2.0 — fine to fork/patch and even ship our patch.

### 3.3 Does the union's own training tell us audio must be real? 

No public statement of the union training mix exists beyond the trainer recipe (paired video+control+audio, 10% control dropout) **[UNK]**. Given `control_apply_audio: false` in the released config, real audio is not load-bearing for control learning (§1.1); treat silent-mux as acceptable for attempt 1 and prefer real ambient audio where the source has it.

---

## 4. Assembly pipeline design (clips → triplets)

```
source clips (user-fetched: stock/CC/personal)
  └─ 1. INGEST      ffmpeg: normalize to 24 fps, H.264, multiples-of-32 canvas (≤ target bucket),
                     cut to 39-frame (1.6 s) or 22-frame segments; dedup by perceptual hash;
                     reject: <5 frames post-normalization, hard cuts mid-segment (PySceneDetect),
                     multi-animal / occluded frames (see QA)
  └─ 2. CONTROL      per segment: run staged rtmpose-m_ap10k (AnimalPosePreprocessor /
                     hr16/DWPose-TorchScript-BatchSize5/rtmpose-m_ap10k_256_bs5.torchscript.pt)
                     → AP-10K 17-kp skeleton renders, palette-exact, black background,
                     at the segment's exact frame count (index-aligned by construction)
  └─ 3. QA FILTER    estimator-confidence thresholds per frame (E-FC1 used ap10k score 0.3);
                     drop segments with any-frame miss or mean score < threshold; drop
                     segments whose re-detection on renders disagrees (round-trip sanity);
                     species balance check against the AP-10K family list
  └─ 4. AUDIO        if source silent: mux stereo silence at 32 kHz spanning exactly frames/24 s
  └─ 5. CAPTION      one neutral sentence per segment (species + gait + setting);
                     10% drop happens in-trainer, no need to synthesize empty captions
  └─ 6. MANIFEST     metadata_add_width_height_add_wav.json in the trainer's exact schema (§1.1)
```

Operational notes: the estimator runs on our existing 8189 testbed (server-drivable via graph factory) or offline via controlnet_aux directly — **beware the documented estimator CUDA residue** (models load outside ComfyUI's management; restart the testbed before sampling phases) [internal doc, fun-control-input-surface addendum]. Estimate of effort: the ffmpeg/QA/manifest scaffolding is 2–4 days of work; the estimator render path already exists (E-FC1 used it). **Target first-attempt size: 400–800 quadruped segments** (~8–12 h of source clips winnowed down), mixed with **~20% human-pose triplets** (from stock or the demo dataset's pose class) as an anti-forgetting anchor — the smallest useful signal for a *hot-started* branch: the union already renders quadrupeds at 40 px error, so the finetune is a domain-shift correction, not from-scratch learning (from-scratch control training is the 8×A100/weeks regime Alibaba's recipe implies).

---

## 5. First attempt — scope and acceptance

### 5.1 Configuration (the cheapest run that can move E-FC1's number)

- Backend: 2×A100-80 rented (fast path), or the 3090 with §2.2 adaptations (slow path). Same flags either way.
- `--config_path config/minimax_h3/minimax_h3_control.yaml` (49/inpaint — unchanged), `--transformer_path` = released union safetensors (**hot start**), `--trainable_modules control`, `--enable_inpaint`, `--enable_bucket`, `--uniform_sampling`, gradient checkpointing + save-on-CPU, `VIDEOX_OFFLOAD_VACE_LATENTS=True`.
- Geometry: `--video_sample_size 384` (buckets below it), `--video_sample_n_frames 39`, stride 1, batch 1. lr **2e-5** constant-with-warmup 100 (recipe default — a hot-start finetune may prefer 5e-6..1e-5; if loss flat-lines high, drop, don't raise). `--checkpointing_steps 100`, `--checkpoints_total_limit 1`, validation off, ~**600–800 steps** (≈1 epoch over ~700 segments) with a mid-run extract at 300 for an early E-FC1 sniff.
- Single-card additions: ZeRO-3-CPU-offload config (or FSDP1+offload), text-embedding precompute patch, latent caching if RAM pinches, exclusive machine.

### 5.2 Acceptance = rerun E-FC1 arm B with the trained adapter

The harness exists (`test-results/experiments/efc1/scripts/{build,run,analyze}.py`, metrics in `efc1_metrics.json`). Exact procedure: (1) convert the extracted control-only file per §1.5 (key remap + fc1 half-order A/B + adaln `[C|1]` projection via the form-adapter math; write `adaln_basis` + `control_blocks_places` + `control_in_dim` metadata); (2) drop it next to the staged patch and point `FUN_PATCH` in `build.py:114` at it; (3) rerun arms A and B unchanged (same seeds 421337/421338, same neutral prompts, 39 f @ 480×832, guidance 1.0, 40 steps, strength 0.8–1.0, end 0.6); (4) compare `err_px_mean/median/max` via `analyze.py`.

- **GO for scale-up**: arm B mean 40.7 px → **≤ 28 px (−30%)** with arm A within noise of 13.9/26.0 px (±2 px) — quadruped fidelity moved toward human-skeleton fidelity without forgetting human pose.
- **Partial**: B improves 10–30% → extend steps/dataset (the union hot start was the right call; iterate).
- **NO-GO signal**: B flat at ≥600 steps with healthy loss decrease, or A degrades > 2 px (forgetting — fix with a stronger human-pose mix / lower lr before concluding anything about AP-10K).
- Also rerun arm D (sprite, 29.3/36.3 px) once: if the adapter closes past the sprite ceiling, the product story changes from "AP-10K unlocks as non-default" to "AP-10K first-class for quadrupeds".

---

## 6. Sources

**Trainer / official code [DOC]**
1. aigc-apps/VideoX-Fun @ commit `968f0e2` (2026-09-04), shallow clone read for this doc — `scripts/minimax_h3_fun/README_TRAIN.md` (data schema §2, recipe §3.3, backends §3.6–3.8, distill §3.9, extract §3.10, inference §4), `train_control.py` (trainable/optimizer/offload/loading logic lines 140-165, 300-330, 645-654, 855-912, 925-964, 1036-1119, 1590-1700), `train_control_distill.py`, `extract_control_weights.py`, `train_control.sh` / `train_control_distill.sh`, `config/minimax_h3/minimax_h3_control{,_only}.yaml`, `config/zero_stage3_config_cpu_offload.json`, `videox_fun/models/minimax_h3_transformer3d_control.py` (control architecture, `materialize_missing_control_params`, VIDEOX_OFFLOAD_VACE_LATENTS), `videox_fun/models/minimax_h3_transformer3d.py` (block/attention dims), `videox_fun/data/dataset_video.py:725-1088` (`VideoSpeechControlDataset`: index-aligned control reads, fps/audio-span gates) — https://github.com/aigc-apps/VideoX-Fun (Apache-2.0)
2. Released control checkpoint — alibaba-pai/MiniMax-H3-Fun-Controlnet-Union: LICENSE (MiniMax H3 Community License, 2026-08-02; EU/UK/KR/US excluded) + safetensors header range-read this investigation (74 tensors, 6.81 GB, 3.402 B params, diffusers keys, full-width adaln [96768, 2688]) — https://huggingface.co/alibaba-pai/MiniMax-H3-Fun-Controlnet-Union
3. Base model repo — MiniMaxAI/MiniMax-H3 (original FL2VA partition: 14-shard text encoder, transformer, VAEs) — https://huggingface.co/MiniMaxAI/MiniMax-H3
4. ComfyUI side, local testbed `/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI/` — `comfy/ldm/minimax/controlnet.py` (expected key set `is_minimax_h3_fun_state_dict`, adaln-form mismatch error at `init_stream`), `comfy/ldm/minimax/model.py` (fused `qkv_proj`, `q_norm/k_norm`, `out_proj`, `mlp.fc1/fc2`), `comfy_extras/nodes_model_patch.py:272-313` (adaln_basis detection, `control_blocks_places` metadata); staged patch header probe: `models/model_patches/minimax_h3_fun_controlnet_union_pruned_int8_convrot.safetensors` (104 tensors, adaln [96768,8] fp32, int8 convrot weights)
5. Adaln full↔curve conversion math, NUM-verified — this repo, `docs/research/h3-lora-form-compatibility.md` (§4 centered [C|1] fit, 0.196% residual; §8 implementation addendum, bias delta cos 1.0) + `custom-nodes/minimax-lora-form-adapter/`

**Community [COMM]**
6. musubi-tuner MiniMax-H3 support roadmap (no control-branch item) — https://github.com/kohya-ss/musubi-tuner/issues/1029 ; request thread #1017
7. Single-24 GB H3 LoRA precedent — Inline Studio H3 LoRA training page (20.5 GB peak caption pass, 11.7 GB training, 1.8 s/step stills on L4; no control branch) https://inlinestudio.art/lora-training/minimax-h3 ; Reddit r/StableDiffusion 1vfa048 (24 GB H3 LoRA, musubi GUI fork) and 1vhy5vl (short-video H3 LoRA locally, fetch-blocked, snippet-level); ai-toolkit H3 support https://comfyui-wiki.com/news/2026-08-03-ai-toolkit-minimax-h3-training
8. DiffSynth-Studio H3 full-training VRAM data point (~78 GB for 124-frame 480 p) — https://github.com/modelscope/DiffSynth-Studio/issues/1624

**Datasets [DOC/COMM]**
9. AP-10K — repo + README (10,015 images / 23 families / 54 species, 17 kp, COCO, CC-BY-4.0, GDrive/Baidu) https://github.com/AlexTheBad/AP-10K ; NeurIPS 2021 paper arXiv:2108.12617; MMPose ap10k integration
10. JFoz/AP10K-poses-controlnet-dataset — ~7 k still triplets, 512², **no license on card** — https://huggingface.co/datasets/JFoz/AP10K-poses-controlnet-dataset
11. APT-36K — https://github.com/pandorgan/APT-36K (2,400 clips / 30 species / 15 frames each; OneDrive frames+annotations; "MIT" claim; no audio/video); APTv2 — https://github.com/ViTAE-Transformer/APTv2 (2,749 clips, 41,235 frames) + arXiv:2206.05683 / 2312.15612
12. Animal Kingdom (CVPR 2022) — https://openaccess.thecvf.com/content/CVPR2022/html/Ng_Animal_Kingdom_A_Large_and_Diverse_Dataset_for_Animal_Behavior_CVPR_2022_paper.html
13. Animal-in-Motion / web-scale 4D animal data — arXiv:2511.01169 (~30 k YouTube videos; annotations released, raw frames withheld for ToS; GPT-query→yt-dlp→PySceneDetect→CLIP→Grounded-SAM2 pipeline) — https://arxiv.org/html/2511.01169v1 ; https://github.com/briannlongzhao/Animal-in-Motion
14. SuperAnimal-Quadruped-80K — https://zenodo.org/records/14016777 ; MMPose animal dataset zoo (licensing context) https://mmpose.readthedocs.io/en/latest/dataset_zoo/2d_animal_keypoint.html

**Internal**
15. `docs/research/fun-control-input-surface.md` — input surface, E-FC1 design + measured addendum (A 13.9/26.0, B 40.7/73.8, D 29.3/36.3 px), estimator CUDA-residue note, "AP-10K LoRA on the control branch = the documented path to parity"
16. E-FC1 harness + metrics — `test-results/experiments/efc1/` (scripts `build.py` FUN_PATCH:114, `run.py`, `analyze.py`, `efc1_metrics.json`; config 480×832×39, score thresholds dwpose flag>0 / ap10k 0.3)
17. Staged estimator — `…/custom_nodes/comfyui_controlnet_aux/ckpts/hr16/DWPose-TorchScript-BatchSize5/rtmpose-m_ap10k_256_bs5.torchscript.pt` (verified on disk this investigation)
18. Machine facts — RTX 3090 24 GB, 109 GB RAM (112 GB nominal, 60 GB available with testbed running), 229 GB free disk (measured 2026-09-15)
