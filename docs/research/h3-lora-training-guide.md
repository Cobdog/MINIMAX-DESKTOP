# H3 LoRA training guide — optimal settings, dataset technicals, caption formats (24 GB envelope)

> Compiled 2026-09-16 (Flux task `mfdza7o`). Question: before the in-app training pipeline (dataset manager `sv14rt0` + sidecar + envelope ladder `1n3a4mi`) locks its defaults — what do the **official and community training sources** say about optimal training settings, dataset technicals, and caption formats for MiniMax-H3 LoRAs on a 24 GB card? This will shape the VLM captioning prompts and the in-app captioning feature.
>
> Method: trainer docs read at the code level from the on-disk clones — kohya-ss/**musubi-tuner** dev @ `70d42b8` (`docs/minimax_h3.md`, `docs/minimax_h3_advanced.md`, `docs/minimax_h3_1f.md`, `docs/dataset_config.md`) and modelscope/**DiffSynth-Studio** (DiffSynX) @ `c458cb4` (`examples/minimax_h3/model_training/lora/*.sh`, `train.py`, `diffsynth/diffusion/parsers.py`, `training_module.py`) — plus the official MiniMax-AI/MiniMax-H3 repo README, the fal.ai training guide, Inline Studio's published settings page, the sepiablue 12 GB character-LoRA walkthrough (note.com, full text), Civitai API probe of published H3 LoRAs, and community thread snippets (Reddit fetch-blocked; quoted at search-snippet level). Tags: **[DOC]** verified in shipped code / official source, **[COMM]** reputable community finding, **[SPEC]** plausible-unverified, **[UNK]** nobody documents it. **Extends, does not re-derive:** `ap10k-control-lora-training.md` (VideoX-Fun control-branch trainer verbatim), `ap10k-trainer-survey.md` (trainer landscape, DiffSynX memory machinery, de-distillation risk), `h3-lora-form-compatibility.md` (adaln forms, full↔pruned LoRA conversion). The envelope ladder's own measurements are quoted from task `1n3a4mi` comments as ground truth for *our* card.

---

## 1. VERDICT — recommended config per LoRA class at 24 GB (RTX 3090, 112 GB RAM)

The single fact that dominates every row: **the released H3 checkpoints are CFG-distilled, and plain flow-matching LoRA training de-distills them** — musubi's docs are explicit that video training "washes out and loses prompt adherence as it progresses" and image training "breaks structurally within about 50 steps"; musubi refuses to ship plain flow as a recipe at all [DOC]. DiffSynX ships the same machinery (DeCFG training adapter, `--training_cfg_scale`) [DOC]. Every real (multi-hundred-step) in-app run must pick one of the three countermeasures (§2.3) — the envelope's 3-step probe rungs cannot see this failure, which is why it could skip the adapter as a "quality knob".

| | **Style** | **Character / identity** | **Motion / camera** |
|---|---|---|---|
| **Trainer (24 GB)** | DiffSynX two-stage DiT-LoRA (the envelope's pivoted recipe: 34 G int8-convrot DiT disk-streamed via `--offload_models`) + **DeCFG preset adapter** or `--training_cfg_scale 4`; musubi guidance-loss arm as A/B | **musubi-tuner dev, teacher matching** (`subject_ref` teacher for stills, endpoint/reference teacher for clips) — the only purpose-built identity recipe; fallback: same trainer as style + trigger word | Same as style (DiffSynX DiT-LoRA + DeCFG/GL) |
| **Dataset** | **50–200 video clips** (best community result: 176/253 hand-reviewed), 3–10 s, one scene each, capped per source, real audio kept | **20–50 stills** (musubi validated on a 20-image set; sepiablue succeeded at 31 face close-ups) or 10–30 short clips; face fills frame, neutral backgrounds, varied angle | **20–100 short clips** (2–5 s), **one repeated movement each**, no cuts, stable frame rate |
| **Rank / alpha** | **16 / 16** (beat 32 and 64 head-to-head on fal's realism style [COMM]; 32 is DiffSynX's recipe default [DOC]) | **16 / 16** (musubi validated recipe [DOC]; sepiablue [COMM]) | **16–32 / =rank** (motion needs slightly more capacity [SPEC — no head-to-head published]) |
| **Learning rate** | **1e-4** ("slow-cook" for long runs; 2e-4 converges faster, fal default) | **3e-4** + warmup 50 (musubi subject-ref validated recipe — the teacher's target is a modest perturbation, 1e-4 "reaches only a weak equilibrium") or 1e-4 @ 800–1200 steps on the adapter path | **1e-4** |
| **Steps (batch 1)** | **1500 @ ~50 clips → 3000–5000 @ ~175 clips** (steps scale with dataset; 5000 overfit the small set but won at 176) | **≈500** (musubi: strongest checkpoints sit at/just after the teaching-band plateau, ~300–500 steps on small character sets; save intermediates) | **500–1500** (Inline's recommended band; clips are ~4.5× slower per step, so budgets stay small) |
| **Resolution × duration** | 480×832-class buckets @ 39–124 f (native 768×1344 @ 39 f *fits* the DiT-LoRA arm at 14.7 GB — but high training res "wasn't worth it for 768p inference" [COMM fal]) | 512² stills are sufficient and standard (face fills frame; 512→768 costs the same VRAM but adds nothing when the face dominates) | 480×832-class @ 22–90 f (motion lives in short clips; 124 f OOM'd even the controlnet arm at 480×832) |
| **Caption style** | One flowing paragraph: **trigger/style token first**, then subject, action, setting, lighting, camera (+ motion at natural speed); soundscape clause when audio is real | **Trigger word + generic subject token only** — appearance NEVER in captions (identity must flow through the trigger/teacher, not the text) | Trigger for the motion concept + concise motion/camera phrase; describe the varying subject, name the repeated movement precisely |
| **Audio** | Keep real audio (joint video+audio training; "silent or noisy audio teaches exactly that" [COMM fal]) | Stills: always `--video_only` | Real audio if the movement has signature sound, else `--video_only`; never leave noisy junk audio in |

Confidence note: the style row and character row are each backed by an official-source recipe plus at least one independent community replication; the motion row is the weakest (no published head-to-head; guidance is directional from Inline/fal/loraai + musubi's recipe table grouping motion with style/concept) — treat motion defaults as first-attempt values, not settled.

**Cross-cutting constants for every class on this card** (all [DOC] unless noted): batch size **1** (musubi rejects any other value; clips are per-sample packed sequences — use gradient accumulation for effective batch), optimizer **AdamW** (musubi/note.com use adamw8bit to save state memory; DiffSynX defaults to torch AdamW, wd 0.01), precision **bf16**, gradient checkpointing **on**, frame count on the **17n+5 grid at exactly 24.000 fps**, dims multiples of 32, LoRA targets `attn.qkv_proj, attn.out_proj, mlp.fc1, mlp.fc2` in the 50 main DiT blocks (identical target set in all three trainers [DOC]), **alpha = rank** everywhere (DiffSynX hard-defaults alpha to rank when unset; musubi recipe uses 16/16; community adapters ship without alpha = alpha:rank) [DOC].

---

## 2. The full hyperparameter space, documented

### 2.1 What the two usable trainers actually expose [DOC — code reads]

| Parameter | DiffSynX (`train.py` + `parsers.py`) | musubi-tuner dev (`minimax_h3_train_network.py` docs) |
|---|---|---|
| LoRA rank | `--lora_rank` (default 32; recipes use 32) | `--network_dim` (recipe example 16) |
| LoRA alpha | **no flag — hard-defaults to rank** (`training_module.py:93-99`) | `--network_alpha` (recipe 16) |
| Targets | `--lora_target_modules "attn.qkv_proj,attn.out_proj,mlp.fc1,mlp.fc2"` | same set, default of `networks.lora_minimax_h3` (50 main blocks; token refiner excluded by default) |
| LR | `--learning_rate` 1e-4 default; **no scheduler or warmup args exist** (constant LR) | `--learning_rate` + `--lr_warmup_steps` (subject-ref recipe: warmup 50), scheduler options exist in the shared kohya stack |
| Optimizer | default `torch.optim.AdamW`, wd `--weight_decay` 0.01; `--customized_optimizer bitsandbytes.optim.AdamW8bit` etc. by dotted path | `--optimizer_type adamw8bit` in the recipe; full kohya optimizer set |
| Steps/epochs | `--num_epochs` × `--dataset_repeat` (recipe: repeat 100 in cache stage, 5 epochs over the repeated set) × `--save_steps` | `--max_train_epochs 16` / `--max_train_steps`; `--save_every_n_epochs 1` |
| Batch | `--gradient_accumulation_steps` (batch is dataloader-bounded by packed layout) | **batch_size must be 1 in every H3 dataset** (trainer rejects the first non-1 batch); gradient accumulation for effective batch |
| Geometry | `--height/--width` (None ⇒ dynamic per-item buckets), `--max_pixels` (default 1 MP), `--num_frames` (**validated 17n+5 at launch — hard error otherwise**) | TOML `resolution`, `enable_bucket`, `target_frames = [124]`, `frame_extraction = "head"`; 32-px grid; released duration range gate 124–345 f (`--allow_experimental_duration` bypasses) |
| Precision | bf16 pipeline; `--fp8_models` for frozen units; `--quant_options ...:bitsandbytes_nf4` | bf16 `--mixed_precision`; ConvRot INT8 base (bit-identical to published); `--fp8_base` **rejected** |
| Memory | `--offload_models` (disk-streaming — the envelope's proven route), `--enable_model_cpu_offload` (+optimizer variant), GC + GC-offload | `--blocks_to_swap` ≤48, `--block_swap_h2d_only`, pruned base (66→40 G bf16 / 34→21 G int8), `--text_encoder_blocks_to_swap` ≤50, `expandable_segments` convention |
| Timestep/scheduler | internal FlowMatch loss (`FlowMatchSFTMiniMaxH3AudioVideoLoss`); **`--training_cfg_scale`** (default 1.0; >1 = CFG-aware training, "inverse-CFG scale for preserving guidance distillation"; uncond branch cached in stage 1, both stages must match) | `--timestep_sampling uniform`, `--weighting_scheme none`, `--discrete_flow_shift 1.0` are **the only accepted values** (H3 derives video/audio sigmas from one base draw with fixed shifts 12/3); `--min_timestep/--max_timestep` clip base space; `--num_timestep_buckets` stratification |
| Audio | `--audio_loss_weight` (default 1.0; 0 = video-only while audio still forwarded), `--silent_on_missing_audio` (mux-zero fallback) | `--audio_loss_weight`, `--video_only` (disables supervision; audio latents still attended as context) |
| Checkpointing | trainable-only export (LoRA ≈ 0.1–0.3 G files), `--save_steps` or per-epoch | LoRA file per epoch (`--save_every_n_epochs`) |
| De-distillation | `--preset_lora_path` DeCFG adapter (fused at train time only, "do not load at inference") **or** `--training_cfg_scale 4` | Table A (§2.3 below) |

Recipe scripts worth naming (all [DOC]): DiffSynX `MiniMax-H3-FL2VA.sh` / `MiniMax-H3-Int8-ConvRot-FL2VA.sh` — rank 32, lr 1e-4, 480×832×124 f, T2VA and FL2VA variants, `input_image`/`end_image` derived from each clip's own first/last frames, optional DeCFG adapter, optional `--training_cfg_scale 4`; the int8 recipe is the envelope's exact base (`Comfy-Org/MiniMax-H3` int8-convrot DiT + int8 TE). DiffSynX `MiniMax-H3-Fun-Controlnet-Union.sh` (LoRA rank 32 lr 1e-4 on the base DiT with controlnet frozen) is covered by the survey doc and not re-derived here.

### 2.2 Numbers with named sources (the consensus column)

| Knob | Official recipes | Community | Consensus for us |
|---|---|---|---|
| Rank | DiffSynX 32; musubi example 16; de-distill adapters 64 (circlestone, image-first) / 32 (ostris FL2VA) / 16 (ostris Ref2VA) | Inline default 16/16; fal "start at 16, rank 16 beat 32 and 64" (style); sepiablue 16; Civitai H3 LoRAs don't publish rank | **16 default, 32 ceiling** for style/character; 32 for motion; >32 only for de-distill adapters or full-domain shifts [COMM + DOC] |
| Alpha | = rank in every source (DiffSynX hard-codes it when unset; adapters ship alpha-less = alpha:rank) | Inline 16/16; sepiablue 16/16 | **alpha = rank, always**; do not expose a separate alpha knob in the UI without a reason [DOC] |
| LR | DiffSynX 1e-4; musubi 1e-4 (general) / 3e-4 (subject-ref teacher) | fal 2e-4 default / 1e-4 long runs; Inline 1e-4; sepiablue 1e-4 | **1e-4** general; **3e-4 + warmup 50** only on musubi subject-ref; 2e-4 acceptable for short hosted-style runs [DOC + COMM] |
| Steps | musubi 16 epochs (general) / ~500 steps (subject-ref, strongest-at-plateau); DiffSynX 5 epochs × repeat 100 (demo-sized set) | fal 1500 @ 53 clips → 3000+ @ 176, 5000 overfit @ ~50; Inline 500–1500; sepiablue 500 starts resembling / 800+ good / 1000 chosen | **Scale steps to dataset**: ~30 epochs-equivalent for small sets, absolute 1500–5000 for 50–200-clip sets; character ~500; always save intermediates (every 250 steps is Inline's default cadence) [COMM + DOC] |
| Batch | musubi hard-rejects batch ≠1 | Inline batch 1; sepiablue batch 1; fal per-step billing implies 1 | **1 + optional grad-accum 1–4** (accum is a quality/fairness knob, not memory) [DOC] |
| Resolution | DiffSynX recipe 480×832; musubi example 768×1344 (resolution array + buckets) | fal buckets 1280×704 / 1280×544 / 960×704 with "high not worth it for 768p inference"; Inline 512 ("512 and 768 cost the same — no reason to go higher for a first run"); sepiablue 512² | **480×832-class buckets** default; 512² for face-character stills; native 768×1344 only when the target content demands it (it fits the DiT-LoRA arm at 39 f: 14.7 GB measured) [DOC + COMM + envelope] |
| Duration | DiffSynX 124 f; musubi 124 f default target_frames; released inference range 5–15 s (124–345 f) | fal 73 f default, 3–15 s clips; Inline min 1 s (22-f grid snap), 1–5 s workable; envelope 22/39/90 f all clean | **39 f (1.6 s) default for style/motion, up to 90 f**; 124 f only at reduced res on 24 GB (controlnet arm OOM'd at 480×832×124 f; DiT arm roomier, rung queued) [DOC + COMM + envelope] |
| Optimizer | AdamW (DiffSynX) / adamw8bit (musubi recipe) | sepiablue adamw8bit wd 1e-4; Inline internal | **adamw8bit** on 24 GB (optimizer states are the cheapest big save); AdamW ifHosting [DOC + COMM] |
| Scheduler/timestep | fixed by architecture (shifts 12/3, uniform base draw — not tunable in musubi; DiffSynX hard-codes the flow loss) | nobody tunes this for H3 | **Expose nothing here**; the only sanctioned knobs are min/max_timestep and musubi's focus band [DOC] |
| Trigger/strength at inference | — | LoRA strength sweep 0.8–1.0 (sepiablue preferred 1.0 @ 1000 steps); fal same-seed scale-0-vs-1 A/B methodology | bake strength sweep into the validation flow [COMM] |

### 2.3 The H3-only hyperparameter: the de-distillation method [DOC — both trainers]

Plain flow-matching is **not a recipe** on H3. Three sanctioned methods (musubi Table A, all combinable with every memory option):

1. **Training adapter (de-distill LoRA)** — merge a third-party adapter into the base at load (`--base_weights` in musubi / `--preset_lora_path` in DiffSynX), train plain flow on the de-distilled model, run the trained LoRA on the plain base at inference. Zero per-step cost. Constraints: needs a BF16 source (pre-quantized int8 files can't be merged into — quantize at load instead), training-time samples show the de-distilled model, don't judge by them. Published adapters: circlestone-labs image-first rank 64 (10k images/10k steps), ostris v2 FL2VA rank 32, ostris Ref2VA rank 16.
2. **Guidance loss** — re-anchor the target in the guided space with the model's own no-grad uncond prediction: `--h3_guidance_loss_scale 4.0` (3–4; 4 more reliable for long runs) + `--h3_guidance_loss_sigma_min 0.15` (skips the low-signal ~15% of steps) + uncond cache (probe = single space — screened against the released checkpoint as the true distillation uncond). Cost ≈ +50% step time ungated, less gated. Works on int8 bases. DiffSynX's `--training_cfg_scale 4` is the same mechanism ("inverse-CFG", uncond embeddings cached in stage 1).
3. **Teacher matching** — train a text-only student against the frozen base's prediction under privileged conditions. Endpoint teacher (`first,last`): identity from video, base audio preserved. Reference teacher (`ref`): identity + voice from the clip itself (audio becomes a real teaching target; `sigma_max 0.75`). Subject-reference teacher (`subject_ref`): identity from *other* pictures of the subject — the identity recipe; validated recipe is rank 16, lr 3e-4 warmup 50, ~500 steps, `sigma_max 1.0` (identity decisions happen at base sigma 0.92–1.0 — gating there erases identity), `sigma_min 0.15`, mag_weight 0.25–0.5, dc_weight 0.3.

Loss-shape knobs that matter for class behavior: `--h3_teacher_loss_dc_weight` — keep **1.0 for style LoRAs** (the dataset palette *is* the signal), drop to **0.3 for character** (stop the palette leaking in as a style shift; measured ~7% of teaching-band residual energy but fully coherent). `--h3_timestep_focus_prob 0.5` roughly doubles convergence in the content-decision band (0.4–0.8 base). Monitor `teacher/*_norm_ratio` (drifting >1.05 = amplification burn) and the DC/AC residual split (DC shrinking = learning palette, not subjects).

**Notable negative result** [DOC]: a complete-information teacher leaves ~flow-level de-distillation pressure inside the teaching band — protection moves entirely to monitoring and the anchor band. There is no configuration of plain flow that is safe for long runs.

---

## 3. Dataset technicals

### 3.1 Size per class

| Class | Size | Evidence |
|---|---|---|
| Style | **50–200 clips** (min 10) | fal: 176/253 hand-reviewed clips won at rank 16/5000 steps; "cap clips from any single source — many near-identical clips teach that shoot, not your style" [COMM] |
| Character | **20–50 stills** (or 10–30 clips) | musubi validated the subject-ref recipe on a **20-image** set [DOC]; sepiablue: 31–32 images, and the *curation* (face-dominant, white background, unified art style, front + oblique angles) mattered more than count — the first 32-image mixed dataset failed, the 31-image face-only set succeeded [COMM] |
| Motion | **20–100 short clips** | loraai: "short clips with one repeated movement, stable frame rate, clear direction; avoid long edits, unrelated cuts, mixed camera behaviors" [COMM]; no published size study [UNK] |

### 3.2 Duration, fps, and the 17n+5 grid

- Frame counts must be **17n+5**: 22, 39, 56, 73, 90, 107, 124, … 243, 345. DiffSynX validates at launch; musubi gates the released 5–15 s range (124–345 f) but training at 22–90 f is legal and proven (envelope rungs all trained clean) [DOC + envelope].
- **Exactly 24.000 fps** — resample 23.976/25/29.97/30 at ingest (fal and both trainers' loaders enforce or assume it) [DOC + COMM].
- **Container-truncation trap (envelope harness finding #1, now runbook-grade):** mp4 stores duration truncated; a clip cut to exactly 56 f can decode as 55 f and the 17n+5 clamp then walks *down* to 39 f — one float-rounded frame silently costs 17 frames of clip. **Cut to grid_target+2 frames** so the clamp lands on target [envelope].
- **Slow-motion contamination:** fal's audit found ~2/3 of their people clips were retimed footage (shot 50–60 fps, played 25–30) — "teaches the model dreamy, floaty movement". Retime with `setpts`+`atempo` or caption it explicitly as slow motion [COMM]. This is a dataset-manager QA check our pipeline should run (fps metadata vs motion analysis).
- Clip duration distribution: style sets want variety (3–10 s; fal 3–15 s auto-split over 30 s); motion sets want **homogeneity** (one movement per clip, 2–5 s); released inference range tops out at 345 f / 15 s, and prompt adherence weakens toward the far end of stretched clips [DOC musubi 30-s probe].

### 3.3 Resolution and aspect

- Dims multiples of 32; bucket sets with **comparable areas** (fal: 1280×704, 1280×544, 960×704); scale-to-fill + center-crop, never stretch (trainers fit conditions to buckets exactly as inference does) [DOC + COMM].
- Official output aspect range 21:9–9:16; native bucket 768×1344 (short side 768) [DOC].
- On 24 GB the measured ceiling (DiT-LoRA arm): **native 768×1344×39 f fits with 9.9 GB spare** (14,658 MiB peak); s/it scales ~linearly with pixels (18 s @ 256×448 → 45 s @ 768×1344) [envelope]. But community verdict: high training resolution is not worth it when inference is 768p — spend the budget on clips and captions instead [COMM fal].

### 3.4 Repetition and step budgets

- Community counts **absolute steps**, not epochs: ~1500 steps at 53 clips (≈28 epochs) to 3000–5000 at 176 (≈17–28 epochs); Inline 500–1500; teacher-matching character ~500 with "strongest checkpoints at or just after the plateau" [COMM + DOC].
- Trainer-side repetition exists for cache economics, not learning: DiffSynX `--dataset_repeat` (recipe uses 100 in the cache stage), musubi TOML `num_repeats` (for balancing multiple sub-datasets) [DOC].
- **Always save intermediate checkpoints** (every 250 steps / every epoch) and pick by evaluation — the strongest checkpoint is routinely mid-run (musubi teacher docs; sepiablue's 800-step preference over the final 1000; fal's 5000-step winner only after the dataset tripled) [DOC + COMM].

### 3.5 Overfitting: signs and mitigations

- Classic overfit: rigid outputs, composition lock, loss-divergence from useful generation — fal: 5000 steps overfit a ~50-clip set (won after tripling data); sepiablue: resemblance emerges ~500 steps and saturates — more steps mostly raise LoRA strength needed, not fidelity [COMM].
- H3-specific pseudo-overfit: **washed-out color, prompt-adherence loss** — this is de-distillation drift, not overfitting; the fix is a loss method (§2.3) or lower LR, never more data [DOC musubi].
- Early de-amplification signature (teacher matching): per-sigma-bin student `norm_ratio` sinking toward 1.0 in the upper teaching band [DOC].
- Mitigations in order of cost: fewer steps → strength sweep at inference (0.8–1.0) → more/diverse clips → lower LR → higher rank only if underfitting (rare for style) [COMM + DOC].

---

## 4. Caption format deep-dive (the section that shapes the VLM prompts)

### 4.1 The principle: caption the way the model is prompted

Universal community doctrine, stated most crisply in the Anima captioning discussion: **"caption the way the model is prompted"** [COMM]. For H3 that means: inference prompts are natural-language English (the official contract below), the text encoder is a 32B vision-language LLM (Qwen3-VL, layer-50 hidden states) that has never seen Danbooru tag soup — so **tag-pile captions are strictly wrong for H3**; natural language is the native distribution [DOC + COMM]. The same conclusion holds for Wan 2.1/2.2 and HunyuanVideo (umt5/LLM encoders — natural language consensus, concise, identity/style + short motion phrase; very long JoyCaption-style captions reported as "impossible to memorize" and consolidated into short ones by practitioners) [COMM].

### 4.2 The official prompt contract vs training captions

The official contract (mirrored in `docs/library/minimax-h3-prompt-guide-base.md` and `-ref.md`; do not re-fetch) is:

- **Base modes (T2VA/I2VA/FL2VA/L2VA):** optional alignment instruction line + three fields — `integrated_multimodal_description` (per-`[Shot N]` timeline: style word, camera verbs with amplitude/speed, `(S1)` speaker IDs, `<d>[Language] …</d>` dialogue verbatim, on-screen text in quotes), `overall_soundscape` (1–4 sentences), `non_diegetic_music` (1–3 sentences or N/A).
- **Full-reference (Ref2VA):** six sections — `subject_definitions` / `summary` / `retention_analysis` / `detailed_description` (350–500 words for generation tasks) / `overall_soundscape` / `non_diegetic_music`, with `<Subject N>`/`<Picture N>`/`<Video N>`/`<Audio N>` labels and fixed relationship markers.
- The hosted pipeline generates this structure with **H3-Context-IR**; the model was trained on this distribution. Example T2VA IR outputs in the official repo run 200–400+ words per prompt [DOC].

**What trainers actually consume for training captions:**

- DiffSynX: one `prompt` string per row in metadata (JSON/CSV) — the shipped demo and our envelope manifests use **single-line natural-language captions** ("a fighter jet streaks low over a sun-bleached desert canyon at golden hour, contrail glowing") [DOC].
- musubi: `clip.txt` sidecar or JSONL `caption` field — example "A singer performs under stage lights." One line [DOC].
- fal: **one flowing paragraph per clip** covering subject, action, setting, lighting, camera, motion at natural speed [COMM].
- Inline: hand-written or auto-caption from the clip's **middle frame**; "every item needs a caption — uncaptioned items train against an empty prompt and weaken the run" [COMM].
- sepiablue's failed→fixed experiment: descriptive captions (hair/eye/outfit details) with mixed framing → character didn't resemble; captions reduced to **"(trigger), 1girl"** with face-only data → strong resemblance [COMM].

**Reconciliation — and it is not a contradiction:** the structured contract governs *inference-time presentation* and *reference-aware records*; musubi auto-wraps the plain caption into the official format only where the format carries conditioning information (teacher presentations get `subject_definitions`/`fully_preserved` boilerplate wrapped around the *shared* caption automatically; a `teacher_caption` field can override) [DOC]. The plain caption rides inside the structure. So the training-caption question decomposes:

1. **For the LoRA's own conditioning (T2VA/FL2VA style & motion):** a compact natural-language paragraph in the official *vocabulary* — style word from the official list (Cinematic, live-action, 2D-animated, 3D CG, claymation, watercolor, vintage film…), camera verbs with amplitude/speed when meaningful, subject/action/setting/lighting — is the sweet spot. Full multi-field scaffolding buys nothing for a 1-shot-per-clip LoRA target and every shipped recipe omits it; a bare one-liner under-describes motion/setting for style transfer. **Verdict: mid-density single paragraph, H3-native vocabulary, not the six-section format.**
2. **For Ref2VA / teacher-matching records:** the structure matters and is *generated* by the trainer's cache tooling from the plain caption + references — the dataset manager should store the plain caption plus references and let the trainer wrap, except when overriding `teacher_caption` (keep scene/pose/outfit identical to the student caption; change only the reference declaration and appearance) [DOC].

### 4.3 Trigger words

- **One stable token per concept that should repeat**; everything that varies gets described per-clip ("describe what changes; trigger-token what repeats") [COMM loraai + universal].
- Community H3 practice uses **unique/obfuscated tokens**: `r34l1sm` (fal realism), `ph0t0r34l` (Civitai photoreal LoRA), `perfe8ct`/`perfect hands`/`perfect skin`/`perfect eyes` (Civitai Polyhedron — one token per learnable concept) [COMM, Civitai API probe].
- **Prepend exactly once** — fal's `trigger_phrase` mechanism prepends to all captions; baking it into caption files *and* prepending "degrades prompt adherence" [COMM].
- For character LoRAs the trigger *is* the identity binding: musubi's subject-ref recipe notes the trigger can be the reference token itself (`<Subject 1>` in the student caption binds on the teacher side automatically) [DOC].
- At inference: trigger first + the class-descriptive terms that were deliberately left OUT of training captions (sepiablue: "(trigger), 1girl, black hair, black eyes, updo") [COMM].

### 4.4 Per-class caption templates (what the VLM prompt should produce)

| Class | Caption template | Rationale |
|---|---|---|
| **Style** | `<style_trigger>, <official style word(s)>, <subject doing action> in <setting>, <lighting>, <camera motion phrase>` — the *content* varies clip to clip; the consistent aesthetic rides on the trigger + style vocabulary. If no trigger: describe everything EXCEPT the style, so style is the only constant the LoRA can absorb. | fal's winning recipe; dc_weight 1.0 keeps palette learnable |
| **Character** | `<trigger>, <generic subject token>` for stills; `<trigger>, <person> <action/pose> in <setting>` for clips — **no hair/eye/outfit/face words ever**; those re-enter at inference | musubi doctrine (teacher sees appearance, student learns it into the trigger) + sepiablue's failed→fixed replication; dc_weight 0.3 keeps dataset palette out |
| **Motion** | `<motion_trigger>, <subject> <single repeated movement phrase with official camera verb + amplitude + speed>, <setting>` — precise motion language, minimal else | loraai (one movement per clip); official camera vocabulary is the model's native motion lexicon |
| **Audio-bearing rows (any class)** | append a short soundscape clause matching the real audio ("steady rain taps…; N/A music") — musubi requires images to *state the absence of sound* so text stays consistent with what the model sees; fal: "silent or noisy audio teaches exactly that" | single-stream model: audio latents are always present in training rows |

### 4.5 Length, cost, and the captioning pass

- **Token budget is a non-issue**: at 256×448×39 f the packed sequence is 1344 video rows + 130 audio rows vs **21 text rows** for a one-paragraph caption — the caption is ~1.4% of the sequence (envelope cache introspection). The constraint is caption *quality and consistency*, not tokens. Ref2VA presentations can reach the 32,768-row Qwen limit (~320 MiB bf16 per sample at the cap) only with many large references [DOC + envelope].
- Over-long captions (JoyCaption-length monologues) are reported to hurt memorability for video LoRAs; consolidating to a few short captions fixed a retrain [COMM]. Official IR outputs are long because they carry *generation* instructions (shots/cuts/dialogue), not because long is better for finetune targets.
- **The caption pass sets peak quality** — Inline's own discussion: resolution and clip length "barely affect" the outcome vs captioning quality [COMM]. Budget VLM effort accordingly: mid-frame captioning is the cheap default (Inline), but motion-relevant facts (camera movement, movement speed, slow-mo) need multi-frame evidence a single frame can't give — the VLM prompt should ask for motion/pace explicitly or the pipeline should feed first/mid/last frames.
- **Caption edits invalidate the text cache** (musubi text-cache fingerprints cover the presentation; re-caption ⇒ re-cache text, latents unaffected) — the dataset manager must treat caption mutation as a cache-invalidating operation, distinct from media edits which invalidate latent caches too [DOC].

### 4.6 Auto-captioning stack implications for our VLM prompts

1. Prompt for **one English paragraph**, H3-native vocabulary (style word list, camera verb triplet, lighting), trigger slot first — not tags, not the six-section format.
2. Per-class templates above differ enough to be **separate VLM prompt presets** (style/character/motion), selected by the LoRA class the user declares at dataset creation.
3. Enforce **negative rules** for character mode: never describe hair color/length, eye color, face shape, outfit identity — surface these as "re-enter at inference" hints.
4. QA hooks worth automating (each maps to a documented failure): empty captions (Inline's empty-prompt trap), trigger duplication (fal), fps≠24.000 & slow-mo suspicion (fal audit), duration truncation vs the 17n+5 target (envelope), near-duplicate clip clusters per source (fal's "teaches the shoot"), silent-audio rows without a soundscape clause (musubi consistency rule).

---

## 5. Common failure modes and mitigations

| # | Failure | Signature | Mitigation | Source |
|---|---|---|---|---|
| 1 | **De-distillation drift** | washed-out color, prompt adherence decays as training progresses; image training: wobbly lines/broken proportions within ~50 steps | one of the three loss methods (§2.3); for our DiffSynX runs: DeCFG preset or `--training_cfg_scale 4`; lower LR helps, more data does not | [DOC musubi/DiffSynX] |
| 2 | Overfitting (small set, many steps) | rigid compositions, style only renders training framings; 5000 steps @ ~50 clips | scale steps to dataset (§3.4); intermediate checkpoints; strength sweep | [COMM fal/sepiablue] |
| 3 | Character identity not learned | LoRA applies (same seed changes image) but face doesn't match | appearance out of captions + trigger-only captions; face-dominant crops; teacher matching (subject_ref) | [COMM sepiablue + DOC musubi] |
| 4 | Palette leaks into character LoRA | wrong color grade follows the character | `dc_weight 0.3`; keep 1.0 only for style | [DOC musubi, measured] |
| 5 | Slow-mo contamination | "dreamy, floaty movement" everywhere | retime at ingest or caption explicitly; audit fps metadata vs motion | [COMM fal] |
| 6 | Geometry rejection / silent down-training | samples skipped (fps ±0.5, non-17n+5); or clip trains at 39 f when you cut 56 f (container truncation) | normalize 24.000 fps at ingest; cut to grid_target+2 f; assert decoded frame counts | [DOC + envelope] |
| 7 | Uncaptioned items | train against empty prompt, weaken the whole run | caption-completeness gate in the dataset manager | [COMM Inline] |
| 8 | Trigger duplicated (prepended + baked) | degraded prompt adherence | one insertion path only | [COMM fal] |
| 9 | Audio drift from video-only training | LoRA output audio worse than base | real audio in dataset + `audio_loss_weight 1.0`; or accept and warn — single-stream weights mean video-only LoRAs leave audio unconstrained | [DOC musubi] |
| 10 | Teacher-matching LoRA "vanishes" after merge | fine in training samples, no effect at inference | small-equilibrium deltas round away below one BF16 mantissa step at merge; use runtime attach (`--lora_runtime_attach`) for eval | [DOC musubi] |
| 11 | Motion temporal collapse | jumpy/implausible motion in generations | one movement per clip; no mixed cuts; stable fps; short clips | [COMM loraai] |
| 12 | Caption/format mismatch on load | LoRA won't load / wrong form | our form-adapter machinery already owns this (full↔pruned adaln M-projection); Diffusers-format files load natively in musubi/ComfyUI paths | [DOC, h3-lora-form-compatibility] |

---

## 6. What the envelope test (1n3a4mi) should cross-check against this harvest

1. **Rank axis vs the consensus** — the ladder runs rank 32 (DiffSynX recipe default); community consensus is 16/16 for style/character with 16 beating 32 and 64 head-to-head. Add a rank-16 DiT-LoRA rung at the reference geometry (480×832×39 f) and compare loss/step-time/file size (310 MB @ r32 measured ⇒ ~155 MB @ r16). Rank is VRAM-nearly-free, so this is a quality A/B, not a memory one.
2. **Step-time economics sanity** — envelope steady-state 24 s/it @ 480×832×39 f (DiT arm) ⇒ 1500 steps ≈ 10 h, 5000 ≈ 33 h on the 3090. Cross-check against community anchors: Inline 3.26 s/it clips on an RTX PRO 4500 Blackwell with 20.4 GB peak (48 GB-class card, no disk-streaming), sepiablue ~22–25 s/it stills on a 12 GB 4070 with heavy CPU offload, fal hosted 2000 steps ≈ 1.5 h. Our number is in-family for single-card streaming; the *cache-once* two-stage discipline (stage-1 ≈ 12 min model-load-dominated, dynamic-res batch amortizes it — envelope finding #2) is the lever that makes multi-thousand-step runs tractable.
3. **Duration wall** — 480×832 wall measured between 90 f and 124 f on the controlnet arm (OOM at 124 f, 22.6 GB at 90 f); the DiT-LoRA arm at 39 f peaks at 8.1 GB, so 124 f should fit with ~6–8 GB spare — the queued f124/f243 DiT rungs will confirm; if f124 passes, style-LoRA datasets can include 5 s clips at 480×832 rather than dropping to 39 f.
4. **The de-distillation gap in the ladder** — the envelope deliberately skipped the DeCFG preset as "quality knob, not memory knob". Correct for VRAM mapping, but every 500+ step real run needs a loss method (§2.3) — and the guidance loss costs ~+50% step time ungated (~+40% with sigma_min 0.15 gating). The ladder's s/it tables should gain one guidance-loss rung (or a DeCFG-fused rung — zero step-time cost, but needs the BF16 DiT, not the pre-quantized int8 the disk-stream route currently uses — that's a real config fork worth one rung).
5. **Batch axis** — both trainers pin batch 1; grad-accum is the only effective-batch lever. The ladder's batch axis should test accumulation 1 vs 4 at fixed wall-clock, not physical batch.
6. **Audio A/B cross-references** — envelope axis 3 (audio rows ~80/s, duration-invariant ~2.7% share at 480×832) should cite fal's "keep the audio" verdict vs musubi's presence-gated supervision and `--video_only` policy; the generation-side sanity note musubi mandates (a no-audio-trained LoRA's behavior when audio IS requested) maps exactly to the envelope's planned generation-side check.
7. **Mixed-bucket axis** — fal's bucket sets (comparable areas, scale-to-fill) and the envelope's dynamic-res batchA cache are the same mechanic; the ladder's axis-5 result will validate the dataset manager's export (mixed-geometry TOML/manifest).
8. **TE-cache reuse** (envelope AC) — confirmed by design in both trainers (stage-1/musubi cache scripts); the runbook should add the *caption-edit ⇒ text-cache-only revalidation* rule from §4.5.

---

## 7. Sources

**Trainer docs, read at code level from the on-disk clones [DOC]**
1. kohya-ss/musubi-tuner dev @ `70d42b8` (clone at `/home/agent/work/scratchpad/musubi-tuner`) — `docs/minimax_h3.md` (Table A loss methods, Table B recipes-by-goal, dataset TOML examples, caption sidecar/JSONL conventions, training command, memory-options table, audio policy, limitations), `docs/minimax_h3_advanced.md` (CFG-distillation mechanism, guidance-loss internals + uncond probe screening, teacher matching: endpoint/reference/subject-ref recipes, sigma bands, loss-shape dc/mag weights, plateau behavior, cache internals incl. fingerprints, ConvRot INT8 scope, pruned adaln, TE streaming, temporal stretch, BF16-merge rounding), `docs/minimax_h3_1f.md` (one-frame image training), `docs/dataset_config.md` (TOML schema, `caption_extension`, `num_repeats`, JSONL caption field) — https://github.com/kohya-ss/musubi-tuner
2. modelscope/DiffSynth-Studio @ `c458cb4` (clone at `/home/agent/work/scratchpad/DiffSynth-Studio`) — `examples/minimax_h3/model_training/lora/MiniMax-H3-FL2VA.sh` + `MiniMax-H3-Int8-ConvRot-FL2VA.sh` (rank 32, lr 1e-4, 480×832×124 f, DeCFG preset, `--training_cfg_scale`), `model_training/train.py` (17n+5 validation, `prompt` field, `silent_on_missing_audio`, `training_cfg_scale`, `audio_loss_weight`, negative_prompt=" ", input_image/end_image derivation), `diffsynth/diffusion/parsers.py` (full arg space), `diffsynth/diffusion/training_module.py` (alpha=rank default) — https://github.com/modelscope/DiffSynth-Studio
3. De-distillation adapters (musubi doc table) — circlestone-labs/MiniMax-H3-Image-Training-Adapter (rank 64), ostris/minimax_h3_training_adapter v2 (rank 32, FL2VA), ref2va v1 (rank 16) — https://huggingface.co/circlestone-labs/MiniMax-H3-Image-Training-Adapter , https://huggingface.co/ostris/minimax_h3_training_adapter

**Official MiniMax [DOC]**
4. MiniMax-AI/MiniMax-H3 repo README (fetched 2026-09-16) — no fine-tuning/training guidance ships with the model (skills = prompt writing + 8 canvas style generators); weights released "to support further development, including fine-tuning"; CFG-distilled checkpoints; 33B dense single-stream, ~13B in AdaLN branches; Qwen3-VL-32B layer-50 states; VisualVAE f16t4d24 + 1×2×2 patchify (32×/4× effective), AudioVAE 32 kHz→40 Hz; output 4–15 s, 24 fps, short side 768; Context-IR + Regenerate-2K architecture; reproducible Context-IR outputs (structured caption examples) — https://github.com/MiniMax-AI/MiniMax-H3
5. Official prompt guides (library captures in this repo) — `docs/library/minimax-h3-prompt-guide-base.md` (VIDEO_PROMPT_WRITING_GUIDE_base_en.md) and `docs/library/minimax-h3-prompt-guide-ref.md` (ref_en.md), pinned at repo sha `42ed227e`
6. No H3 technical report published as of 2026-09-16 — MiniMax team (Reddit AMA): "we plan to publish a comprehensive technical report" (training-data composition therefore [UNK]) [COMM]

**Community guides / settings (primary fetches) [COMM]**
7. fal.ai — "How to Train a LoRA for MiniMax H3" (fetched in full): 50–200 clips, 3–15 s, exact 24 fps, slow-mo audit, bucket sets 1280×704/1280×544/960×704, one-paragraph caption recipe + trigger_phrase mechanics and duplication warning, rank 16 > 32/64 (style), lr 2e-4 default / 1e-4 long runs, steps-vs-dataset scaling (1500@53 / 3000+@176 / 5000 overfit@small), 73 f default, keep-audio guidance, same-seed scale-0/1 evaluation, winning recipe rank 16 / 5000 steps / 1e-4 / 176 clips — https://fal.ai/learn/devs/how-to-train-a-lora-for-minimax-h3 ; companion dataset fal/MiniMax-H3-Realism-People-LoRA (176 hand-curated clips) — https://huggingface.co/fal/MiniMax-H3-Realism-People-LoRA
8. Inline Studio — H3 LoRA training page (fetched in full): rank 16/alpha 16 default, lr 1e-4, batch 1, 500–1500 steps (checkpoints every 250), 512 px ("no reason to go higher for a first run"), clips min 1 s snap to 22-f grid, 4-bit-only (40 G factorised vs 11.7 G quantised), VRAM peaks 20.6/12.7 GB by phase, clip steps 4.5× slower, middle-frame auto-caption + "uncaptioned items weaken the run", stills-teach-appearance/clips-add-motion, 16 GB cards refused — https://inlinestudio.art/lora-training/minimax-h3 ; v1.2.64 clip-training discussion ("caption pass sets the peak") — https://github.com/orgs/inlineresearch/discussions/31
9. sepiablue (note.com, fetched in full, JA): RTX 4070 12 GB ai-toolkit character LoRA — 31–32 images 512², rank 16/alpha 16, lr 1e-4, adamw8bit wd 1e-4, 1000 steps ≈ 6–7 h, num_frames 1 + auto_frame_count false (stills trap), audio_loss_multiplier 0; failed descriptive-caption mixed dataset → succeeded with "(trigger), 1girl" face-only set; 500 steps start resembling / 800+ good; inference trigger + left-out attributes — https://note.com/sepiablue/n/nf0763f854580
10. loraai.me H3 LoRA guide (fetched): per-class dataset do/don'ts (character/style/product/motion), motion = "short clips with one repeated movement", trigger-token doctrine, no-universal-setting caveat — https://loraai.me/guides/minimax-h3-lora
11. Reddit threads (search-snippet level; direct fetches blocked by Reddit's network security): 1vhy5vl short-video local training 16 GB+ ("clips ~4× slower per step"); 1vfa048 24 GB musubi-GUI-fork image-only training; 1vge5hp image-LoRA tips thread; 1wdxfm8 style-LoRA workflow; 1w395r2 beginner character (5090); 1vzq3vd "good H3 LoRAs exist on Civitai despite distillation"; r/comfyui 1ue5v73 ($5–7 hosted character video LoRA) — https://www.reddit.com/r/StableDiffusion/comments/1vhy5vl/ et al.
12. Civitai public API probe (this investigation): published H3 LoRAs use obfuscated single trigger tokens (`ph0t0r34l`, `perfe8ct` + per-concept tokens "perfect hands/skin/eyes"); training rank/steps not exposed in API metadata — https://civitai.com/api/v1/models?query=minimax%20h3&types=LORA
13. Caption-format precedent (video-model ecosystem): HF malcolmrey/wan discussion #4; John6666 wan22_lora_training.md (natural-language captions, concise motion phrase for clips); Civitai article 11942 (Wan/Hunyuan the right way); r/SD Florence-2/JoyCaption threads; Facebook SD group consolidation of over-long captions; Anima discussion #96 ("caption the way the model is prompted") — https://huggingface.co/malcolmrey/wan/discussions/4 , https://civitai.com/articles/11942 , https://huggingface.co/circlestone-labs/Anima/discussions/96
14. RunComfy ai-toolkit H3 trainer notes (frame counts/audio defaults; auto frame count ON for natural clip duration) — https://www.runcomfy.com/trainer/ai-toolkit/minimax-h3-lora-training

**Internal (this repo / this machine)**
15. Envelope ladder task 1n3a4mi comments (measured ground truth: DiT-LoRA vs controlnet-LoRA VRAM table, 17n+5 container-truncation trap, dynamic-res stage-1 batching, audio-row quantification, stage-1 host-RAM ceiling, peft/disk-offload patches, musubi dev staged at `/home/agent/tmp-gpu/envelope/musubi`)
16. `docs/research/ap10k-control-lora-training.md` (VideoX-Fun trainer verbatim, 10% caption drop for CFG, dataset assembly pipeline, licensing) and `docs/research/ap10k-trainer-survey.md` (trainer landscape, DiffSynX two-stage machinery, musubi port verdict, Inline Studio precedent numbers)
17. `docs/research/h3-lora-form-compatibility.md` (full↔pruned adaln forms, LoRA conversion machinery) and `docs/research/speed-quality-and-imagegen-paths.md` §1.3 (turbo-LoRA registry — separate LoRA class, distillation not personalization)
18. Envelope manifest schema on disk (`/home/agent/tmp-gpu/envelope/data/a1_256.json`: `video`/`prompt`/`input_audio`/`frame_rate`) and smoke `training_args.json` — the exact DiffSynX field contract our dataset manager must export
