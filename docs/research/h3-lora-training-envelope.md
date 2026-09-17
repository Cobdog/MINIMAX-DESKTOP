# H3 LoRA Training Envelope — the measured map (single RTX 3090, 24 GB)

> Flux task `1n3a4mi` (epic xng2pk8) · 2026-09-16 · agent af9caac56d0332654.
> METHOD: **all numbers in this doc were measured today on this box** (tagged
> **[envelope]**) — 60+ cache+train rungs on the Intern topgun clip, ffmpeg-laddered
> to the exact 17n+5 grid at 24.000 fps, 2–3 optimizer steps per rung, VRAM/RAM
> sampled at 2 s. Trainer code was READ at pin (DiffSynX `c458cb4` + tranche3b's
> 2-site disk-offload patch; musubi dev `70d42b8`). Where a claim is code-read
> rather than measured it is tagged [DOC]; community claims [COMM].
> Raw evidence: `test-results/experiments/envelope/RESULTS.md` (full tables),
> scripts in the same dir, per-rung logs + VRAM/RAM TSVs in `/home/agent/logs-gpu/env_*`,
> caches/adapters in `/home/agent/tmp-gpu/envelope/`, per-axis tables in the
> task-1n3a4mi Flux comments.

Context: the tranche-3b smoke (a80ekav, comment 4qy39cl) proved ONE rung executes
(LoRA-on-controlnet, 256×448×39 f, 18.2 s/step, 9.8 GiB). This envelope answers the
maintainer's directive: "I want to know my limits" — resolution × duration × audio ×
batch × mixed-data × sec/it, then base-model DiT LoRA after the mid-run pivot
(the maintainer's actual target: style/motion/character LoRAs ON the 33 B DiT).
Comparison column: the controlnet arm (the inherited smoke config), measured first.

## 1. The envelope map — base-model DiT-LoRA (primary target) [envelope]

### 1.1 Resolution @ 39 f / 1.6 s
| resolution | pixels | s/step | peak VRAM | spare | controlnet arm (s / VRAM) |
|---|---|---|---|---|---|
| 256×448 | 114K | 17.5 | 5,218 MiB | 19.3 GB | 18.0 / 9,826 |
| 384×672 | 258K | 20.0 | 6,892 MiB | 17.7 GB | 21.0 / 11,596 |
| 480×832 | 399K | 24.0 | 8,100 MiB | 16.5 GB | 24.0 / 14,138 |
| 576×992* | 571K | 28.5 | 10,254 MiB | 14.3 GB | 29.0 / 16,256 |
| **768×1344 (native)** | 1,032K | **45.0** | **14,658 MiB** | **9.9 GB** | 47.5 / 23,878 |

*576×992 stands in for the requested 576×1008 — the loader floors dims to /32 and
1008 % 32 ≠ 0 [DOC, operators.py]. Every rung fits; the controlnet arm's 6.8 GB
residency + optimizer states are the entire difference (DiT-LoRA ≈ half the VRAM
at every rung, same step time — the 34 GB frozen DiT stream dominates either way).

### 1.2 Duration @ 480×832
| frames | seconds | s/step | peak VRAM | controlnet arm |
|---|---|---|---|---|
| 22 | 0.92 | 20.0 | 6,528 MiB | 20.5 / 11,324 |
| 39 | 1.63 | 24.0 | 8,100 MiB | 24.0 / 14,138 |
| 90 | 3.75 | 40.0 | 13,960 MiB | 42.5 / 22,590 |
| 124 | 5.17 | 55.5 | 17,286 MiB **stock** | OOM (23,998 MiB; rescued to 58.0 s / 23,410 only by expandable_segments) |

**The max-frames answer** [envelope]: **345 f (the 15 s released maximum) trains —
the resolution ceiling at 345 f is 544×320** (23,446 MiB, 0.9 GB spare, adapter
saved; 60.1 s/step). Comfort tier 416×224×345 f = 15.0 GB / 35.3 s; 320×192×345 f =
11.7 GB / 28.8 s. Max-frames-by-resolution: **345 f @ ≤544×320 · 124 f @ ≤480×832
(243 f OOMs every tried config: musubi full-r32 / full-r16 / pruned-r16, DiffSynX
extrapolates ~26.6 GB) · 39 f @ native 768×1344**.

**Budget rule** [envelope]: VRAM ≈ **5.1 GB fixed + ~2.6 GB per mega-token of
(px × frames)**; the 3090 walls at ~23.5 GB. Iso-budget trade at the wall:
544×320×345 f ≈ 480×832×~150 f ≈ 768×1344×~58 f — motion buys duration, style/
identity keep resolution, and mixed-bucket datasets carry both arms for free (§1.5).

### 1.3 Audio A/B [envelope]
Real topgun audio latents vs injected silence: **byte-identical cost** (23.5 vs
24.0 s/step, both 8,100 MiB) — the audio token count is a pure function of clip
DURATION, not content. `--audio_loss_weight 0` changes nothing either (the audio
stream is still noised and forwarded). Audio rows cannot be dropped at this pin:
`model_fn_minimax_h3` takes `audio_latents` as a required positional and the rows
are baked into the cached packed positions [DOC, pipelines/minimax_h3_audio_video.py].
Audio = 8.7 % of the DiT sequence at 256×448, ~2.7 % at 480×832 (80 rows/s of
duration; share is duration-invariant per resolution). **There is no audio-free
VRAM/RAM budget to reclaim.** Generation-side note (AC, labeled honestly):
a silence-trained LoRA still trains the audio rows — it learns to predict
silent-audio latents; audio-conditioned inference from it should be expected to
lean silent. Untested with a real adapter + gens (see §6 open item).

### 1.4 Batch [envelope + DOC]
The stock trainer is **hard batch-1** — `DataLoader(collate_fn=lambda x: x[0])`,
runner.py:87 at c458cb4 [DOC]; musubi likewise rejects batch > 1 [DOC]. Measured:
8× duplicated clip = 23.6 s/item at identical 8,100 MiB; grad-accum 4/8 = VRAM-flat
(8,102 MiB), wall-linear. **No batch-OOM axis exists — the walls are per-item
geometry walls.** Effective batch = gradient accumulation, nothing else.

### 1.5 Mixed data [envelope]
- **Peak VRAM = MAX of the buckets that step through, never the sum.** Batch-1
  per-item packing rebuilds activations each step; with
  `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` there is no cross-bucket
  allocator residue. mixedtrade (320×192×124 f + 992×576×39 f) peaked at 11,264 MiB
  = the 992-item's own demand; photosmix (416×224×345 f + 320×192×39 f + 3
  one-frame stills) at 14,932 MiB = the 345 f item's solo 15,032.
- **Mixed image+video training works** (musubi `--one_frame`; its docs call it
  "expected to work but untested" — now tested [envelope]). One-frame items cost
  almost nothing (a few hundred sequence tokens).
- **Bucket transitions are free**: the 8-item DiffSynX mixed cache ran per-item
  costs identical to solo rungs (deltas map 1:1); the musubi 17-bucket dense run
  (140 samples: 2× 544×320×345 f, 124/90/39/22 f at three resolutions, portrait
  224×384 and 576×992, 992×576 hi-res, 50 stills incl. max-res/portrait/square)
  interleaved at 37.3 s/it average with zero transition penalty, loss 1.17→0.89,
  stopped by maintainer scope call at 61/140 (projection: full epoch ≈ 87 min,
  peak = 23.4 GB when a ceiling item steps).
- **The maintainer's mixed-training design — high-res stills + short high-res
  clips for acuity, long low-res clips for motion in ONE dataset — is validated
  as a MECHANISM** (all bucket classes train together, no penalty). The QUALITY
  at each mix ratio is unmeasured; the judged A/B remains open (§6).

### 1.6 sec/it [envelope]
| knob | verdict |
|---|---|
| LoRA rank | VRAM-only cost: r16 7,962 / r32 8,100 / r64 9,346 / r128 11,010 MiB — step time flat (23.5–24.0 s). r16 is also 138 MiB lighter and 0.5 s faster [envelope]; community says 16 beats 32/64 head-to-head [COMM] — **default 16**. |
| Gradient checkpointing | **MANDATORY.** Cache-patched GC-off OOMs at 256×448, 480×832, AND 124 f (23.9–24.1 GB) — activations alone exceed 24 GB [envelope]. |
| expandable_segments | Always on: rescued the controlnet arm's 124 f (fragmentation: 3.84 GB reserved-unallocated), saves ~0.5 GB on the DiT arm, no downside observed. |
| Step-time floor | **~18 s (DiffSynX) / ~14–19 s incl. load (musubi) at ANY small geometry** — resolution-flat below ~0.5 MP because the frozen 34 GB DiT streams through every optimizer step (fwd + bwd weight reads). **Under 10 s/step is NOT achievable on this card** with any int8-convrot recipe (pruned-DiT residency 21 GB still leaves no activation room; the CPU-offload-manager route host-OOMs, §4). |

### 1.7 Trainer pick [envelope + DOC]
| | DiffSynX @ c458cb4 (+patches) | musubi dev @ 70d42b8 |
|---|---|---|
| 480×832×124 f | 55.5 s / 17,286 MiB / 29–31 GB host | **34 s / 20,074 MiB / 60 GB host** |
| Duration acceptance | any 17n+5 incl. sub-5 s | released 5–15 s gate (`--allow_experimental_duration` bypasses) |
| Cache path (stage-1) | TE+VAE host-pinned, **needs ~105 GB free** — the box's blocker | VAE-only latents + streamed TE (`--text_encoder_blocks_to_swap 50`) — **fits today**, only path that cached 243/345 f here |
| Audio | loader broken at pin → silence/real injected post-hoc (injector in scripts/) | **real audio cached natively** (sidecar wav) |
| Base-model LoRA on int8 disk DiT | works with 2 new peft guards (§3) | works stock |
| Verdict | **default for the studio sidecar** (sub-5 s rungs, wider acceptance, patched path proven) | **speed arm for long rungs** (1.6× faster at 124 f) and the only cache route while host RAM is tight |

Both consume the same Comfy-Org int8-convrot DiT + int8 TE; musubi additionally
needs the Comfy-Org fp16/fp32 VAE repacks (the modelscope source VAEs lack the
`latents_mean`/`latents_std` buffers — [envelope], loud load error, no silent
mismatch).

### 1.8 Sidecar defaults (the recommendation)
480×832×39 f · rank 16 / alpha 16 · lr 1e-4 · GC on (mandatory) ·
`expandable_segments:True` always · real audio when a wav exists, silence otherwise
(same cost) · silence-fallback via injector on DiffSynX · warn past 768×1344×39 f
or 480×832×124 f · hard-stop at the §1.2 walls · dataset prep trims to
grid_target+2 frames (§5.1) · **DeCFG/de-distillation REQUIRED for any 500+ step
run** (DiffSynX `--preset_lora_path` adapter — needs a BF16 DiT, not the
pre-quantized int8 — or `--training_cfg_scale 4`, both stages matching; musubi
`--base_weights` or guidance-loss): plain flow-matching on the CFG-distilled base
washes out [DOC both trainers; not a memory cost — the envelope measured none].

## 2. Economics [envelope]
Per 100 optimizer steps (DiT-LoRA): 256×448×39 f 29 min · 480×832×39 f 40 min ·
768×1344×39 f 75 min · 480×832×124 f 93 min · 544×320×345 f ~100 min. A 50-clip ×
10-epoch motion LoRA at 480×832×39 f = 500 steps ≈ 3.3 h. Cache-once discipline:
stage-1 = ~10–12 min model load + 13 s/clip at 256×448×39 f; dynamic-resolution
batching (no --height/--width) caches the WHOLE dataset in ONE invocation at
per-item-identical cost (verified byte-identical on the 256×448 cross-check) [envelope].

## 3. The pivot patches (base-DiT LoRA on the disk-streamed DiT) [DOC + envelope]
1. **peft `get_device_map`** (`/home/agent/tmp-gpu/dsdeps/peft/tuners/tuners_utils.py`):
   disk-offloaded models have no materialized params at injection → `StopIteration`;
   patched to default fresh adapters to cuda.
2. **peft device dispatch** (same file + `tuners/lora/model.py`): disk linears carry
   `weight=None` → `AttributeError`; guarded to skip the `.to` (the trainer's
   `.to(device)` places adapters).
3. **Cache surgery**: controlnet-era caches carry `control_rows` which call the
   absent controlnet (`env_strip_control.py`).
Both peft guards live in the **dsdeps COPY** (not the DS checkout) — reproducible
from `test-results/experiments/envelope/scripts/` context; upstreamable alongside
tranche3b's 2-site patch. Also confirmed dead here: the CPU-offload-manager route
for DiT-LoRA (host SIGKILL at 109/109 GB — resident+pinned 34 GB DiT needs ~85–90 GB
the box no longer has; matches ds7).

## 4. Failure characterization (the OOM map) [envelope]
| failure point | signature | clean? |
|---|---|---|
| stage-2 VRAM (geometry) | torch.OutOfMemoryError, rc=1, VRAM back to 302 MiB ambient | clean, next rung unaffected |
| controlnet 124 f stock allocator | OOM w/ 3.84 GB reserved-unallocated (fragmentation) | clean; fixed by expandable_segments |
| stage-1 host RAM | kernel SIGKILL at 109/109 GB during load (3×) | GPU-clean; needs ~105 GB free |
| poisoned cache (audio-position mismatch) | IndexError in model_fn audio index_copy | clean + loud |
| LoRA on disk-offloaded model, stock peft | StopIteration / AttributeError at injection | clean + loud; §3 fixes |

## 5. Dataset-prep + harness traps (runbook-grade)
1. **mp4 duration float trap**: the container stores duration truncated (56/24 =
   2.333333 s); the loader computes floor(dur×24) = 55 and its 17n+5 clamp walks
   DOWN to 39 — one rounded frame silently costs 17 frames (a 56 f clip trained
   as 39 f; ffprobe said the file was perfect). **Trim to grid_target+2 frames.**
2. **Gradient-checkpointing flags are cache-baked**: stage-2 CLI
   `--use_gradient_checkpointing(_offload)` are IGNORED in cache mode (the flags
   live in the cached item from stage-1; the CLI-only "GC off" arms ran
   byte-identical to GC-on — proven no-ops). Flip via `env_patch_gc.py`.
3. **Dynamic-res batch economy**: one stage-1 load caches the whole ladder
   (9 items in 4:39) vs ~12 min per fixed-H/W rung — the mixed-bucket mechanic and
   the economical cache path are the same feature.
4. musubi duration gate: sub-124 f needs `--allow_experimental_duration` (DiffSynX
   accepts any grid value — a sidecar should warn that sub-5 s clips are outside
   the released training range).

## 6. Open items
- Judged quality A/B per mix ratio (high-res stills + long low-res motion in one
  LoRA) — mechanism proven, quality unmeasured.
- Generation-side audio sanity: train a real silence-only adapter, generate with
  audio conditioning, judge (AC audio-ab's only open half).
- DiffSynX stage-1 for f56/243/345 + T=1 stills: host-RAM-blocked (needs ~105 GB;
  the ~10 GB of stale /tmp tmpfs from the 09:2x battery is the addressable delta —
  maintainer's call; musubi paths bypass entirely).
- Guidance-loss / DeCFG-fused rung (step-time cost of the real de-distillation
  method) — deliberately out of the envelope's memory scope, in scope for the
  first real training run.

## Verdict table
| question | verdict | confidence |
|---|---|---|
| max resolution @ 1.6 s | native 768×1344, 14.7 GB | measured [envelope] |
| max duration @ 480×832 | 124 f stock (243 f OOM all configs) | measured [envelope] |
| max frames anywhere | 345 f up to 544×320 (23.4 GB ceiling) | measured [envelope] |
| min viable motion res | 320×192 practical (160×96 mechanical; below 224 the conditioning rows dominate) | measured + derived [envelope] |
| audio budget | none droppable; real vs silence identical cost | measured [envelope] |
| batch scaling | hard batch-1; accum = VRAM-flat, wall-linear | measured + code-read |
| rank | 16 default (lightest, community-preferred); VRAM-only cost | measured [envelope] |
| GC off | impossible (OOM at every rung) | measured [envelope] |
| sub-10 s/step | not on this card with int8-convrot streaming | measured [envelope] |
| mixed buckets / photos+video | free — peak = max of buckets | measured [envelope] |
| trainer | DiffSynX default (patched) / musubi speed+cache arm | measured [envelope] |
