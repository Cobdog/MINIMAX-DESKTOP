# AP-10K control-branch trainer survey — is there a better trainer than VideoX-Fun?

> Compiled 2026-09-15 (Flux task `aahc40w`). Question: does a trainer exist that handles the AP-10K control-branch finetune's memory/optimization better than the VideoX-Fun baseline of `docs/research/ap10k-control-lora-training.md` (mandatory TE-precompute patch + ZeRO-3-CPU-offload, ~2–6 min/step on a 3090, RAM-knife-edge 101–110 GB with 3.402 B trainable)?
>
> Method: shallow clones read at the code level — modelscope/**DiffSynth-Studio** (package `diffsynth`, a.k.a. DiffSynX) @ `c458cb42` (2026-09-14, history deepened to date the controlnet landing), kohya-ss/**musubi-tuner** main @ `e0cbd8f3` (2026-08-13) and dev @ `03f2ceaa` (2026-09-15), ostris/**ai-toolkit** @ `426ccb4` (2026-09-15), a-r-r-o-w/**finetrainers** @ `7e9257a` (2026-04-08; huggingface/finetrainers main is the identical SHA), inlineresearch/**Inline-Studio** @ HEAD (2026-09-15) — plus web search for the remaining ecosystem (FastVideo, fal.ai, ComfyIT). Tags: **[DOC]** verified in shipped code / official source, **[COMM]** reputable community finding, **[SPEC]** plausible-unverified, **[UNK]** nobody documents it. Continues `ap10k-control-lora-training.md` (baseline) and `fun-control-input-surface.md`; specs pinned there are not re-derived.

---

## 0. VERDICT: **YES — DiffSynX already trains the control branch natively; it beats the baseline on every axis the baseline had to patch**

**Recommendation: switch the first AP-10K attempt from "VideoX-Fun + hand-written TE-precompute patch + ZeRO-3-CPU-offload" to DiffSynX's shipped MiniMax-H3-Fun-Controlnet-Union recipe** (repo `modelscope/DiffSynth-Studio`, Apache-2.0), with a 1–2 h smoke test first because the support is two weeks old. Total-effort comparison line:

| | VideoX-Fun (baseline) | **DiffSynX (recommended)** | musubi-tuner port | ai-toolkit port |
|---|---|---|---|---|
| Architecture port | none (origin trainer) | **none — controlnet model + full & LoRA recipes shipped** | ~1,000–1,800 LOC / 2–4 weeks | ~300–700 LOC / ~1–2 weeks |
| TE-precompute (the mandatory patch) | **write it yourself (~50–150 LOC)** | **native two-stage split training; TE never loads at train time** | native (cache scripts) | native (quantized TE + cache) |
| Sub-24GB machinery | ZeRO-3-CPU-offload config (shipped but unused) | per-module CPU↔GPU streaming + optional NF4/int8 frozen base, purpose-built | blocks_to_swap ≤48, pruned/int8 base | int8-convrot base + layer offload |
| Checkpoints written | 66 GB whole-model per save + extract script | **trainable-only: 6.8 GB (full) or ~0.1 GB (LoRA)** | LoRA file only | LoRA file only |
| Trained-output → ComfyUI | §1.5 machinery (owned) | same machinery, qkv-reshape variant (owned math) | §1.5 machinery + musubi layout | needs ai-toolkit→diffusers export first |
| RAM @ 112 GB (10 k tokens) | 101–110 GB knife-edge (full) | ~75–80 GB LoRA / ~100–105 GB full / ~50–60 GB w/ quantized frozen base | ~72–78 GB (LoRA-only path) | [UNK] |
| License | Apache-2.0 | **Apache-2.0** | Apache-2.0 | MIT |

The one-sentence why: **DiffSynX eliminated both halves of the baseline's adaptation cost — the control branch and the TE-precompute patch are already in the repo, and its checkpoint/save + offload machinery is designed for exactly our one-big-card situation.**

**The baseline doc's core claim is now false, and was false when written.** `ap10k-control-lora-training.md` §2.1 states "No trainer but VideoX-Fun can train the control branch … checked 2026-09-15". DiffSynX merged "Support Minimax-H3-ControlNet (#1659)" on **2026-09-01** — two weeks earlier — including `MiniMaxH3ControlNet` (the exact union architecture: `control_layers (0,10,20,30,40)`, `control_in_dim 49`, `control_apply_audio False`, hidden 5376 / heads 56×128 / ffn 14336), a state-dict converter that hot-loads the released `PAI/MiniMax-H3-Fun-Controlnet-Union` file by hash, pipeline integration, and **training recipes for both full controlnet finetune and LoRA** (`examples/minimax_h3/model_training/{full,lora}/MiniMax-H3-Fun-Controlnet-Union.sh`) **[DOC, git history + file reads]**. The miss is understandable — the repo is namespaced "DiffSynth-Studio" while everyone says "DiffSynX", and the support landed two weeks before the check — but the survey's answer changes because of it.

Honest caveats on the winner: the controlnet trainer has **no public community finetune report found** (the example dataset is the official demo triplets; nothing on issues/reddit as of 2026-09-15 [DOC-by-absence]); the shipped LoRA recipe targets the *base DiT* with the controlnet frozen — LoRA-on-controlnet is a one-flag change that the generic trainer machinery supports but no shipped example exercises **[DOC generic / SPEC for the combination]**; and step time on our 3090 stays in the same compute-bound 2–6 min/step class — **no trainer fixes that**; what changes is RAM/VRAM headroom, disk behavior, and above all engineering time. If the smoke test fails, the baseline's VideoX-Fun+patch plan remains fully valid and is not degraded by this survey.

---

## 1. DiffSynX (modelscope/DiffSynth-Studio) — the trainer that ended the monopoly

Clone @ `c458cb42` (2026-09-14); Apache-2.0. H3 stack: `diffsynth/models/minimax_h3_dit.py` (+ `_comfy.py` variants that load Comfy-style/pruned/int8 checkpoints), `minimax_h3_controlnet.py`, `pipelines/minimax_h3_audio_video.py`, `examples/minimax_h3/` with `model_inference{,_low_vram}/` and `model_training/`.

### 1.1 Native H3 control-branch support (a) — YES, full [DOC]

- `MiniMaxH3ControlNet` (`diffsynth/models/minimax_h3_controlnet.py`): `control_layers=(0,10,20,30,40)` with the same must-start-at-0 validation as our ComfyUI class, `control_in_dim=49` (the inpaint/union layout), `control_apply_audio=False` — the released union config verbatim, registered in `configs/model_configs.py` with `model_hash 91179e6f…` so `--model_id_with_origin_paths "PAI/MiniMax-H3-Fun-Controlnet-Union:…"` hot-loads the same checkpoint the baseline hot-starts from. Control blocks subclass the DiT block and add `before_proj` (block 0) / `after_proj` per block; the control stream is carried between injection points as a stacked state — same architecture as `comfy/ldm/minimax/controlnet.py` and VideoX-Fun's model **[DOC]**.
- The state-dict converter (`utils/state_dict_converters/minimax_h3_controlnet.py`) accepts **VideoX-Fun/FSDP-wrapped diffusers keys** (`control_blocks.N.attn.to_q/…`, unwrapping `_fsdp_wrapped_module.` prefixes) — i.e. it was written against the same trainer format our baseline produces; checkpoints remain interchangeable in that direction **[DOC]**.
- Training recipes shipped **[DOC]**:
  - `model_training/full/MiniMax-H3-Fun-Controlnet-Union.sh` — `--trainable_models "controlnet"`, lr 1e-5, hot start from the PAI union file, 480×832×124f, `--use_gradient_checkpointing --find_unused_parameters`, `--remove_prefix_in_ckpt "pipe.controlnet."`. This is the baseline's `--trainable_modules control` equivalent, 3.402 B trainable.
  - `model_training/lora/MiniMax-H3-Fun-Controlnet-Union.sh` — same data, `--lora_base_model "dit"` + `--lora_target_modules "attn.qkv_proj,attn.out_proj,mlp.fc1,mlp.fc2"`, rank 32, lr 1e-4. Note the shipped example LoRAs the **base DiT** (controlnet frozen) — that trains the *consumer* of control features, not the branch. For our goal, `--lora_base_model "controlnet"` with the same target-module string is mechanically supported — the trainer resolves the name with `getattr(pipe, lora_base_model)` (`diffusion/training_module.py:329-353`) and the controlnet's blocks carry the **same module names as the DiT** (`blocks.N.attn.qkv_proj…`, per the converter's target naming) — but no shipped example or test exercises that combination **[DOC generic / SPEC specific]**. This is the one-line experiment the smoke test should cover.
- The script comments also recommend optionally fusing their **DeCFG training adapter** (`DiffSynth-Studio/MiniMax-H3-TrainingAdapter`, merged #1678 2026-09-08) via `--preset_lora_path … --preset_lora_model dit` "for a better optimization landscape on this CFG-distilled base. Training only — do not load it at inference" **[DOC]**. This matters beyond convenience: it is machinery for exactly the distillation-drift risk (§1.4) that VideoX-Fun's control trainer does not address at all (its answer is a separate distill stage we ruled out).

### 1.2 Memory/optimization on 24 GB / 112 GB (c) — the two-stage split is the headline [DOC]

- **Two-stage split training** (their term): stage 1 (`--task sft:data_process`) loads **text encoder + VAEs only** — the model list in the controlnet script names no transformer — and caches latents, text embeddings, and control latents to disk; stage 2 (`--task sft:train`) loads **transformer + controlnet only** and trains purely from cache. The 62 GB Qwen3-VL encoder therefore *never* exists during training. This is the baseline's mandatory hand-written TE-precompute patch, already productized — plus target/control latent caching, which the baseline listed as an optional further patch **[DOC]**.
- **Per-module CPU↔GPU streaming during training**: `diffsynth/core/offload_training/manager.py` (`OffloadTrainingManager`, wired by `--enable_model_cpu_offload`) registers forward/backward hooks per module: frozen params stream CPU→GPU→CPU (pinned arena buffers, `PinnedArenaPool`), with correct handling of non-reentrant checkpoint recompute; trainable params are either GPU-resident (`AlwaysOnGPUParamOffloader`) or offloaded **with their gradients and optimizer states** (`TrainableParamOffloader` under `--enable_optimizer_cpu_offload`) **[DOC]**. This is a purpose-built ZeRO-lite — no DeepSpeed dependency, works with plain accelerate on one process.
- **Quantization of the frozen base**: `--quant_options <model>:bitsandbytes_nf4[/<exclude_modules>]` dynamically quantizes loaded models, and the training runner explicitly handles quantized frozen weights (DDP buckets skip them; `exclude_quantized_params_from_ddp_sync`) **[DOC runner.py]**. Community prequant H3 DiTs also load through `model_configs` (e.g. a pruned int8 "Singularity" Ref2VA DiT is registered as a training-legal `minimax_h3_dit`) **[DOC]**. Quantizing the frozen 66 GB DiT to NF4 (~17 GB) while the controlnet stays bf16-trainable is the pattern the machinery describes **[SPEC — no shipped controlnet example combines them; smoke-test it]**.
- Also present: `--use_gradient_checkpointing_offload` (activations to RAM), `--fp8_models` (fp8 for non-updated modules), DeepSpeed/FSDP via accelerate config, `--customized_optimizer` dotted-path (so `bitsandbytes.optim.AdamW8bit` is one flag) **[DOC]**.
- **RAM budget at our geometry** (baseline §2.2 math, DiffSynX terms): frozen DiT 66 GB (or ~17 GB NF4) + controlnet 6.8 GB + optimizer 27.2 GB fp32-AdamW (full) or ~0.3–0.5 GB (LoRA rank 32–64) + activations ~5–10 GB. Full ≈ 100–110 GB (same knife-edge as baseline); **LoRA-on-controlnet ≈ 75–80 GB (comfortable)**; quantized-frozen-base full ≈ 50–60 GB **[SPEC arithmetic on [DOC] mechanisms]**.

### 1.3 Step time (d), checkpoints (new win), conversion (e)

- **Step time**: compute-bound; the same 3×2×33B×tokens estimate applies → **2–6 min/step at 10–20 k tokens on the 3090**; per-module streaming moves a comparable PCIe volume to ZeRO-3 offload (~10–15 s overlapped). An NF4 frozen base cuts streaming 2–4× but adds dequant compute — expect the same order, not a category change **[SPEC]**. Their example geometry (480×832×124f) is ~5× our tokens; we run below it.
- **Checkpointing**: `save_model` exports **trainable parameters only** (`export_trainable_state_dict`, `diffusion/training_module.py:119-132`) — 6.8 GB controlnet files for the full path, ~100 MB for LoRA, saved straight through the state-dict converter hook. No 66 GB whole-model saves, no `extract_control_weights.py` dance, no `checkpoints_total_limit` tightrope — the baseline's entire §2.4 disk-discipline burden disappears **[DOC]**.
- **Conversion to our ComfyUI stack**: DiffSynX's controlnet naming is fused-layout and *nearly* ours (`blocks.N.attn.qkv_proj`, `attn.q_norm/k_norm`, `attn.out_proj`, `mlp.fc1/fc2`, `before_proj/after_proj`, `control_patch_proj` — the converter's own target names) but with two layout deltas: its `qkv_proj` is **per-head interleaved** `[h0:q k v, h1:q k v, …]` while ComfyUI splits plain `[q|k|v]` (`comfy/ldm/minimax/model.py:171`), and its fc1 is stored `[gate; up]` where the diffusers↔ComfyUI half order still needs the baseline's tiny-tensor A/B **[DOC, both sides read]**. So: inverse-interleave reshape (~15 LOC, the exact inverse of their published `interleave_qkv`), fc1 half A/B, then the same adaln `[C|1]` M-projection + metadata stamping we already ship in `custom-nodes/minimax-lora-form-adapter`. Comparable effort to the baseline's §1.5 path — the win is that the output is controlnet-only to begin with.
- **Data contract**: same 24 fps / 17n+5 grid (constants pinned in their `train.py`), `control_video` as an `extra_input` carried through `ControlNetInput` **[DOC]**; the official demo dataset (`DiffSynth-Studio/diffsynth_example_dataset`, minimax_h3/MiniMax-H3-Fun-Controlnet-Union subset) is the format reference our §4 assembly pipeline targets — one manifest field-name remap at most.

### 1.4 A risk both trainers share, only DiffSynX has tooling for

musubi's H3 docs and DiffSynX's adapter both document that **the released H3 checkpoints are CFG-distilled and plain flow-matching training degrades them** (musubi: "video training washes out… image training breaks within about 50 steps"; DiffSynX ships a DeCFG adapter and recommends it *in the controlnet script itself*) **[DOC both]**. The released Fun-Controlnet-Union is likewise guidance-distilled, and the baseline's 600–800-step plain-flow finetune plan inherits this exposure (its own text notes the branch "is already guidance-distilled"). Whether 600 steps of low-lr control finetuning drifts enough to matter at guidance 1.0 is **[UNK]** — but if E-FC1 shows prompt-adherence loss after training, the first knob is now DiffSynX's `--preset_lora_path` adapter (train-time only), not a redesign. VideoX-Fun's answer (a second distill stage, `train_control_distill.py`) is the expensive one we already ruled out.

### 1.5 Risks / unknowns

- Controlnet support is **two weeks old** (#1659 2026-09-01, adapter #1678 2026-09-08); no third-party controlnet finetune found in the wild **[DOC-by-absence]**. Mitigation: the 1–2 h smoke test (§3).
- `--lora_base_model controlnet` unexercised upstream **[SPEC]**.
- The ~78 GB "H3 training VRAM" community data point the baseline attributed to DiffSynth-Studio issue #1624 is weaker than it read: the issue is a *question* about minimum LoRA VRAM, closed with no visible answer **[DOC, fetched 2026-09-15]** — treat DiffSynX training VRAM at our geometry as governed by the streaming/quantization machinery above, not by that number.
- `--find_unused_parameters` in their recipe hints DDP wrapping; on a single process this is inert.

---

## 2. musubi-tuner (kohya-ss) — the familiar runner-up that would need a real port

Clone main @ `e0cbd8f3` (2026-08-13) — **no H3 code on main** — and dev @ `03f2ceaa` (2026-09-15) where H3 landed 2026-08-06..09 (#1018 BF16 training → #1024 INT8 ConvRot → #1028 cleanup), release to main pending (roadmap #1029 open, PR #1030 draft) **[DOC]**. Apache-2.0 (with per-directory upstream-attribution notes).

- **H3 support (base model only)**: T2VA/FL2VA/Ref2VA LoRA + generation, one-frame image mode; `docs/minimax_h3{,_advanced,_1f}.md`; ~6 k LOC package (`minimax_h3/model.py` 1,298 + packing 711 + TE 712 + VAEs + media + cache/train/generate entrypoints) with an unusually deep test suite (packing, TE streaming, convrot int8 runtime, cache contracts…) **[DOC]**.
- **Memory machinery — best-in-class kit, all native**: latent + text-encoder **cache scripts** (the exact `01_cache_latents → 02_cache_te → 03_train` discipline the maintainer already runs for Krea 2 via `/home/agent/work/krea2-lora-setup.sh`), pruned-adaln conversion (66→40 GB bf16 / 34→21 GB int8), ConvRot INT8 on-the-fly, `--blocks_to_swap` ≤48 (+ h2d-only fast path), quantized TEs for caching (int8 convrot / NVFP4+AWQ), adamw8bit, `PYTORCH_CUDA_ALLOC_CONF=expandable_segments` convention **[DOC]**. The "~20.5 GB peak / 24 GB card" figure in the ecosystem belongs to Inline Studio's musubi-lineage stack (§5); musubi's own H3 docs publish no single-card peak number **[UNK exact figure]**.
- **LoRA + externally-defined module sets**: `networks/lora_minimax_h3.py` is 99 lines driven by a target regex (`blocks\.\d+\.(attn\.(qkv_proj|out_proj)|mlp\.(fc1|fc2))`) — pointing a LoRA at a *new* module set is a regex argument, so control-block targeting would be trivial **if the modules existed** **[DOC]**. musubi is a LoRA-only trainer (NetworkTrainer base; no full-finetune path) — a musubi port gives up the baseline's full-branch option by design **[DOC-by-absence]**.
- **Control-branch support: none, and none planned** — issue #1029 (the roadmap the baseline cited) has no ControlNet/VACE item; under-consideration items are I2VA/L2VA, multi-frame one-frame targets, keyframe anchors, temporal stretch **[DOC, fetched 2026-09-15]**. The baseline's musubi claim still holds.
- **Port estimate (b)**: add control blocks to `minimax_h3/model.py`; interleave the control stream into the packed VSA row layout (`packing.py` — the hard part: control rows at exact token positions across the 5 injection points, the skip-stack handoff VideoX-Fun implements with `VIDEOX_OFFLOAD_VACE_LATENTS`); dataset + `minimax_h3_cache_latents.py` changes to VAE-encode control renders and build the 49-dim inpaint features; generation-script wiring; checkpoint IO; LoRA regex. Calibrated against DiffSynX's landed controlnet implementation (~600–900 LOC of model+converter+pipeline wiring on a *simpler* integration), a tighter-layout port is realistically **~1,000–1,800 LOC and 2–4 weeks of careful work**, on an unreleased branch **[SPEC]**. For zero capability the baseline doesn't already give us. Verdict: **do not port; file an issue requesting control-branch support instead** (kohya's H3 issue cadence is fast — #1018→#1028 in four days — and the DiffSynX implementation is now a reference to point at).

---

## 3. ai-toolkit (ostris) — healthy arch-plugin trainer, but strictly dominated for this task

Clone @ `426ccb4` (2026-09-15 — commits the day of this survey); **MIT** (Ostris LLC) **[DOC]**.

- **H3 support: base LoRA only.** `extensions_built_in/diffusion_models/minimax_h3/` (~2.2 k LOC): their own transformer implementation (`src/transformer.py`, 588 LOC), Qwen3-VL TE loader, VAEs, packing, `ref_video_cache.py`. Default training bases are the **pruned int8-convrot** FL2VA/Ref2VA files; TE is kept quantized (convrot8 / NVFP4+AWQ via their Ostris quantization backends, with dequant-matmul fallbacks); "quantize + offload + placement, all driven by model_config" **[DOC]**. Community/services run H3 LoRAs on consumer cards (comfyui-wiki 2026-08-03 announcement; RunComfy trainer page; Fal.ai hosted guide) **[COMM]**. Ref2VA LoRA tutorials exist **[COMM]**.
- No controlnet concept anywhere in the extension (grep-verified: zero `control*` hits); no blocks_to_swap-style streaming — the memory story is quantized residency + layer offload + caching **[DOC]**.
- **Arch-plugin extensibility is real** (it gained krea2, edit modes, and H3 inside months; the v2 `models/resolver.py` + PLANNING.md describe the extension seam), and ostris is the author of the H3 *training adapters* (`ostris/minimax_h3_training_adapter`) that musubi's docs recommend — the ecosystem's de-distillation knowledge lives here too **[DOC musubi docs / COMM]**.
- **Control-branch port (b)**: new extension — ControlNet block subclass + injection into their transformer forward + control-video caching after the `ref_video_cache` pattern + config/UI wiring. The block classes to subclass are 588 lines away in the same repo: **~300–700 LOC, ~1–2 weeks [SPEC]**. Plausible to upstream (MIT, active). But every outcome it could produce, DiffSynX produces today with zero port. **Runner-up only if DiffSynX's smoke test fails** *and* the maintainer prefers ai-toolkit's job/UI ergonomics for the long run.

## 4. finetrainers (a-r-r-o-w / huggingface) — no H3, dormant

Clone @ `7e9257a` (2026-04-08); huggingface/finetrainers main is the same SHA — the canonical repo has been quiet ~5 months **[DOC]**. Supported models: cogvideox, cogview4, flux, hunyuan_video, ltx_video, wan — **no MiniMax H3**, and H3 postdates the last commit by four months **[DOC]**. Memory features in this snapshot: `--enable_model_cpu_offload` (documented for *validation* in `docs/args.md`), gradient checkpointing, DeepSpeed/FSDP via accelerate, 8-bit optimizers (`docs/optimizer.md`); no block-swap streaming flag found in `args.py` **[DOC]**. Reaching our goal means porting the entire 33 B arch first (weeks), then the control branch — dominated on every axis. License Apache-2.0.

## 5. Inline Studio — precedent, not a path

Open-source (GPL-3.0) local filmmaking app (`inlineresearch/Inline-Studio`, commits the day of this survey) with a built-in GUI LoRA trainer for Z-Image, Krea 2, FLUX.2, MiniMax H3 — the source of the **24 GB H3 LoRA precedent** (20.6 GB peak on 24 GB; 12.7 GB mode for 16 GB; stills and short clips; v1.2.64 added clip training) **[DOC repo + COMM site/reddit]**. Its trainer is an app-internal, musubi-lineage engine with a **curated arch registry** (env-var resolved models, training-adapter de-distillation pattern baked in — its H3 entry even ships a train-adapter slot) — a generalization *model*, not a trainer we can extend without forking a GPL-3 app (license-hostile for our distribution). No controlnet (grep-verified). Keep it as the de-risking precedent for "33 B H3 LoRA on one 24 GB card" and the 1.8 s/step stills anchor the baseline already cites; do not consider it a candidate.

## 6. Everything else that touches H3 training (2026-09)

- **FastVideo / FastH3** (hao-ai-lab): 4-step sparse-distilled H3, open weights + inference; training code "coming soon" per their X announcement — **no finetune training today** **[DOC blog/X]**. (ai-toolkit already repacks FastH3 for inference — a sign the ecosystem treats it as an artifact, not a trainer.)
- **fal.ai** hosted H3 LoRA training (learn/guide) — cloud, base-model LoRAs, no controlnet, contradicts our local-training premise **[COMM]**.
- **ComfyIT "LoRA训练大师"** (Chinese GUI): H3 I2V effect LoRAs demonstrated — GUI-wrapper class, no control-branch evidence **[COMM]**.
- **VideoX-Fun** itself: unchanged role — the origin trainer of the released union, still the only *other* codebase with control-branch training, and the baseline's fallback.

---

## 7. Comparison table (frame a–f)

| Candidate | (a) native H3 control-branch | (b) port effort to add/keep control branch | (c) memory/optimization on 24 GB / 112 GB | (d) expected step time @10–20 k tok (3090) | (e) output → our ComfyUI stack | (f) license |
|---|---|---|---|---|---|---|
| **VideoX-Fun** (baseline) | YES (origin) | 0 port + **~50–150 LOC TE patch required** + ZeRO-3-CPU config | ZeRO-3 offload (shipped-unused); dead `--offload_every_step`; 8-bit Adam UNK w/ offload; RAM 101–110 GB full | 2–6 min (baseline §2.3) | §1.5 machinery (owned): concat+rename+half-A/B+adaln | Apache-2.0 |
| **DiffSynX** ★ | **YES since 2026-09-01 (full + LoRA recipes)** | **0 (LoRA-on-controlnet = 1 flag, unexercised)** | **native 2-stage cache (no TE at train)**; per-module streaming; optional NF4/int8 frozen base; ckpt-offload; 8-bit optim via flag | same class, 2–6 min [SPEC] | fused-layout variant of §1.5 (interleave inverse + half A/B + adaln); output already controlnet-only | Apache-2.0 |
| **musubi-tuner** (dev) | NO (roadmap has no item) | ~1,000–1,800 LOC / 2–4 wks [SPEC]; LoRA-only outcome | best kit (cache scripts, pruned/int8 base, blocks_to_swap ≤48, adamw8bit); maintainer-familiar workflow | LoRA ≈ same class (trainable compute tiny; streaming dominates) [SPEC] | §1.5 machinery + musubi LoRA layout | Apache-2.0 |
| **ai-toolkit** | NO | ~300–700 LOC / 1–2 wks [SPEC] | int8-convrot base + quantized TE + layer offload (no block streaming) [DOC]; single-card H3 precedent [COMM] | same class [SPEC] | needs ai-toolkit→diffusers export, then §1.5 | MIT |
| **finetrainers** | NO (no H3 at all; dormant) | weeks (arch first, then control) | n/a for H3 | n/a | n/a | Apache-2.0 |
| **Inline Studio** | NO | fork a GPL-3 app | 20.6 GB peak H3 LoRA precedent [COMM] | 1.8 s/step stills anchor [COMM] | n/a | **GPL-3.0** |
| FastVideo / fal / ComfyIT | NO | — | — | — | — | various |

**(a) verification of the baseline's claim**: overturned for DiffSynX (support predates the baseline's check by two weeks); still true for musubi (roadmap re-fetched, no controlnet item), ai-toolkit, Inline Studio, finetrainers, FastVideo.

---

## 8. Recommendation and first-attempt deltas

1. **Adopt DiffSynX as the AP-10K control-branch trainer.** Concretely: shallow-clone `modelscope/DiffSynth-Studio`, run their `model_training/full/MiniMax-H3-Fun-Controlnet-Union.sh` flow against a 4-clip smoke manifest at the baseline's small geometry (≤256×448×39 f), `--enable_model_cpu_offload`, 20 steps — budget 1–2 h including cache stage. Success criterion: loss decreases, peak VRAM < 20 GB, RAM < 100 GB, saved checkpoint loads through our converter path.
2. **Choose the training mode by RAM appetite**: full controlnet (max fidelity, ~100–105 GB RAM, 27 GB optimizer — knife-edge again, but with no TE to eliminate there is no next lever) vs **LoRA-on-controlnet `--lora_base_model controlnet` rank 64–128** (comfortable ~75–80 GB, the E-FC1 gap is a domain-shift correction where LoRA plausibly suffices — the same argument the baseline made for its own PEFT idea). The smoke test runs both modes; pick per measured RAM.
3. **Keep the baseline's plan otherwise intact**: same dataset/assembly (§3–§4 of the baseline — manifest field remap only), same hot start, same 600–800 steps, same E-FC1 acceptance rerun (§5.2), same conversion math (§1.5) with the DiffSynX interleave-inverse added. VideoX-Fun+patch remains the documented fallback if the smoke test fails on either mode.
4. **Watch the distillation-drift knob**: if prompt adherence degrades post-training at guidance 1.0, reach for DiffSynX's DeCFG `--preset_lora_path` (train-time-only adapter) before touching anything else — machinery VideoX-Fun lacks entirely.
5. **musubi**: no port. File (or have the maintainer file) a control-branch request on #1029 pointing at DiffSynX's landed implementation; the maintainer's musubi familiarity then becomes relevant again for free if kohya lands it. ai-toolkit stays the secondary fallback (§3) if DiffSynX disappoints and a port becomes unavoidable.

---

## 9. Sources

**Code reads (shallow clones, this investigation) [DOC]**
1. modelscope/DiffSynth-Studio (package `diffsynth`, "DiffSynX") @ `c458cb42` (2026-09-14), history deepened — controlnet landing `013296e` (#1659, 2026-09-01), training adapter `ce9f454` (#1678, 2026-09-08); `diffsynth/models/minimax_h3_controlnet.py`, `utils/state_dict_converters/minimax_h3_controlnet.py`, `pipelines/minimax_h3_audio_video.py` (`pipe.controlnet`, `model_fn_minimax_h3_controlnet`), `diffusion/training_module.py` (`switch_pipe_to_training_mode` :306-353, `export_trainable_state_dict` :119-132, `ControlNetInput` :385-399), `diffusion/runner.py` (`OffloadTrainingManager`, quantized-DDP guard, `customized_optimizer`), `core/offload_training/manager.py` (per-module hook streaming, `PinnedArenaPool`), `configs/model_configs.py` (union `model_hash 91179e6f…`, controlnet kwargs; Singularity int8 DiT), `examples/minimax_h3/model_training/{full,lora,validate_full,validate_lora}/MiniMax-H3-Fun-Controlnet-Union.{sh,py}`, `examples/minimax_h3/model_training/train.py` (17n+5 constants, two-stage tasks), LICENSE (Apache-2.0) — https://github.com/modelscope/DiffSynth-Studio
2. kohya-ss/musubi-tuner main @ `e0cbd8f3` (2026-08-13; no H3) and dev @ `03f2ceaa` (2026-09-15; H3 landed `684a858` #1018 → `33a6226` #1028, 2026-08-06..09) — `docs/minimax_h3.md` (recipes, de-distillation Table A, memory-options table, blocks_to_swap ≤48), `docs/minimax_h3_advanced.md`, `src/musubi_tuner/minimax_h3/` (model.py 1,298; packing.py 711; cache scripts), `src/musubi_tuner/networks/lora_minimax_h3.py` (target regex), README License section (Apache-2.0) — https://github.com/kohya-ss/musubi-tuner
3. ostris/ai-toolkit @ `426ccb4` (2026-09-15) — `extensions_built_in/diffusion_models/minimax_h3/` (own transformer, int8-convrot default bases, quantized TE backends, `ref_video_cache`; zero control hits), `toolkit/models/v2/resolver.py`, LICENSE (MIT, Ostris LLC) — https://github.com/ostris/ai-toolkit
4. a-r-r-o-w/finetrainers @ `7e9257a` (2026-04-08); huggingface/finetrainers main = same SHA — `finetrainers/models/` (no H3), `docs/args.md` (`enable_model_cpu_offload` validation-scoped), `docs/optimizer.md` — https://github.com/a-r-r-o-w/finetrainers
5. inlineresearch/Inline-Studio @ HEAD (2026-09-15) — `core/src/inline_core/training/models.py` (curated arch registry, training-adapter slots, musubi-lineage), TRAINING.md, LICENSE (GPL-3.0), no controlnet — https://github.com/inlineresearch/Inline-Studio
6. ComfyUI side (local) — `/home/agent/work/VS Proj/Kreatine/testbed/ComfyUI/comfy/ldm/minimax/model.py:164-199` (plain-split qkv, swiglu fc1) and `comfy/ldm/minimax/controlnet.py` (injection contract) — layout deltas of §1.3 verified against both.
7. Maintainer's musubi workflow — `/home/agent/work/krea2-lora-setup.sh` (cache-then-train discipline, fp8_base, adamw8bit, blocks_to_swap awareness) — the familiarity factor of §8.5.

**Official docs / repos [DOC]**
8. DiffSynth-Studio training docs (framework: trainable/LoRA/combined "text_encoder,controlnet", VRAM-reduction list incl. `--quant_options`, `--fp8_models`, two-stage split, CPU offload) — https://diffsynth-studio-doc.readthedocs.io/en/latest/Pipeline_Usage/Model_Training.html
9. musubi-tuner H3 roadmap issue #1029 (H3 merged to dev, PR #1030 pending; no ControlNet/VACE item — fetched 2026-09-15) — https://github.com/kohya-ss/musubi-tuner/issues/1029
10. DiffSynth-Studio issue #1624 (a *question* on minimum H3 LoRA VRAM, closed, no visible answer — weakens the "~78 GB" data point) — https://github.com/modelscope/DiffSynth-Studio/issues/1624

**Community [COMM]**
11. Inline Studio H3 LoRA page (24 GB training, 20.6 GB peak / 12.7 GB low mode) — https://inlinestudio.art/lora-training/minimax-h3 ; v1.2.64 clip-training discussion — https://github.com/orgs/inlineresearch/discussions/31
12. FastVideo FastH3 V1 (4-step distill; training code "coming soon") — https://haoailab.com/blogs/fasth3-preview/ and https://huggingface.co/FastVideo/FastVideo-FastH3-4-step-Preview-v1-VSA-DataFree
13. ai-toolkit H3 on consumer cards — https://comfyui-wiki.com/news/2026-08-03-ai-toolkit-minimax-h3-training ; Ref2VA tutorial https://www.youtube.com/watch?v=8Ug0dA4jXyY ; hosted https://fal.ai/learn/devs/how-to-train-a-lora-for-minimax-h3 ; https://www.runcomfy.com/trainer/ai-toolkit/minimax-h3-lora-training
14. ComfyIT LoRA训练大师 H3 support (GUI; no controlnet evidence) — https://comfyit.cn/blog/375/
15. MiniMax-H3-Fun-Controlnet-Union model card (trained with the VideoX-Fun pipeline; CAICT hub description) — https://huggingface.co/alibaba-pai/MiniMax-H3-Fun-Controlnet-Union

**Internal**
16. Baseline — this repo, `docs/research/ap10k-control-lora-training.md` (§1.5 conversion, §2.2 RAM math, §2.3 step time, §5 first attempt; its §2.1 "no other trainer" claim corrected by §0 above)
17. Machine facts — RTX 3090 24 GB, 112 GB RAM, 229 GB free disk (baseline §6.18)
