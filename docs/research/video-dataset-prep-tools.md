# Video dataset prep tooling — survey, llama.cpp caption pipelines, curation techniques (the H3 dataset-manager research pass)

> Flux task `7drm5qt` (epic xng2pk8) · 2026-09-17. Feeds the dataset-manager build
> task `sv14rt0` (which now carries the maintainer's 13 product locks, 2026-09-17)
> and the few-shot sidecar `ehzagoc`.
>
> METHOD: web-verified survey (fetched pages = GitHub READMEs/docs, HF blog, llama.cpp
> issues/PRs/discussions, Civitai article, dev.to; Reddit is fetch-blocked here — Reddit
> findings are search-snippet-level and marked [COMM-snippet]) plus code-reads of the
> on-disk trainer clones ([DOC-local]: musubi-tuner dev @ `70d42b8`, DiffSynth-Studio @
> `c458cb8`, both under `/home/agent/work/scratchpad/`). Internal ground truth quoted
> from [h3-lora-training-guide.md](h3-lora-training-guide.md) (caption-format verdict,
> dataset technicals), [h3-lora-training-envelope.md](h3-lora-training-envelope.md)
> (bucket/VRAM map, 17n+5 grid, mixed-bucket findings — all `[envelope]` there), and the
> ROADMAP VLM-video line (llama.cpp `input_video` matrix, 2026-09). Tags: **[DOC]**
> verified in shipped code/official source (fetched this session), **[DOC-local]** read
> in an on-disk clone, **[COMM]** reputable community finding, **[COMM-snippet]** search
> snippet only, **[SPEC]** plausible-unverified, **[UNK]** nobody documents it.
> **[envelope]** = measured on this box (cited from the envelope doc, not re-measured).
> Freshness doctrine: every claim below was re-verified 2026-09-17; this space moves
> monthly — re-check the llama.cpp rows before relying on them past ~2026-10.

---

## 0. The shape we are shopping for

The manager being specced (`sv14rt0` + the 13 maintainer locks) is: **video-first,
raw-clip non-destructive** (trim/crop/CFR/grid are export-time layers), **natural-language
captions only**, **VLM captioning on llama.cpp locally, no cloud APIs (hard, indefinite)**,
5→1000 mixed-media items (long low-res motion clips + short high-res clips + one-frame
stills in one dataset — mixed-bucket training, measured free `[envelope]`), exporting to
musubi/DiffSynX. Question: what exists, what transfers, what's missing.

---

## 1. Survey — what exists for video-gen LoRA dataset prep (section A)

### 1.1 Purpose-built dataset managers / curation GUIs (the closest prior art)

| Tool | What it does | Video handling | Captioning | License | Local fit | Maintenance (2026-09-17) |
|---|---|---|---|---|---|---|
| **LoRA Dataset Studio V2** (perfectgf/lora-dataset-studio) | The most complete self-hosted LoRA workbench found: sourcing (drag-in/ZIP/gallery-dl scrapers/5 generation engines incl. local ComfyUI), one-pass curation scoring (aesthetic/NSFW/style, dup grouping, face clustering, framing/head-angle classification), keep/reject/shortlist triage, watermark masks + inpaint, training orchestration (ai-toolkit, cloud A/B), Test Studio with fixed-seed grids [DOC-README] | **Beta**: TransNetV2 shot detection; **target-aware cutting to exact frame counts per model — 8 targets incl. Wan 4n+1, LTX 8n+1, and MiniMax H3**; per-shot stillness/blur/freeze, silence/dBFS, camera-move pass, AI-clip flag, subtitle/letterbox detection, encode-damage sweep (dup frames, macroblocking, edge blur); near-dup grouping keeps sharpest; keyword scene search (Qwen3-VL); per-shot prose captions → .txt. Only Wan 2.2 14B has a completed verified training run [DOC-README] | Local VLMs via Ollama **or LM Studio**; JoyCaption (ai-toolkit); prose-or-booru per target family; per-trait appearance policy (omit/describe hair…); Concept-leak checks; Caption Lab (find/replace, tag frequencies, targeted re-caption); dual long+short captions; **every caption records authorship; re-caps preserve hand-written ones** [DOC-README] | **PolyForm Noncommercial 1.0.0** — features studyable, code NOT vendorable/usable in our AGPL app [DOC] | Self-hosted Flask + JS; deps: ai-toolkit, ComfyUI, Ollama/LM Studio; Python 3.10–3.12 [DOC-README] | Active: 2,943 commits, V2 current, 271★; solo maintainer [DOC-README]; announced r/StableDiffusion 1rd587k + earlier 1jzf1zu [COMM-snippet] |
| **Klippbok** (alvdansen/klippbok) | CLI toolkit: `scan`/`ingest`/`normalize` (scene split + fps/res normalization), **CLIP reference-image triage** ("place a reference image, find every scene containing that character" — 162/1,700 scenes on a test film), `score`/`audit` caption QC, 6 pipelines (triage-first, style LoRA, motion LoRA…), reference-frame extraction for I2V, dataset validation [DOC-README + Civitai 26494, 2026-02-24] | Scene-aware; normalizes to per-model specs (e.g. 720p/16fps, **4n+1 Wan-style grids — no H3 17n+5 target**) [DOC] | **Four caption templates encoding OMISSIONS per LoRA type** — character captions never describe appearance, style captions never describe aesthetics (same doctrine as our guide §4.4); backends Gemini / Replicate / **local Ollama**; `.txt` sidecars out [DOC] | **Apache-2.0** [DOC] | CLI + ffmpeg; cloud backends optional, Ollama path is local [DOC] | Early: 4 commits on main, pip-installable, extracted from the upcoming "Dimljus" video trainer; article updated ~5 months post [DOC] |
| **TagGUI Video 1M** (diodiogod/taggui-video, fork of StableLlama/taggui) | Desktop GUI to browse/tag/review very large image **and video** collections; batch captioning of selections; prompt history; text-transform utility; spatial phrase review [DOC docs/CAPTIONING_GUIDE.md] | Video-native models get real video paths with user-set `Video FPS` + `Max video frames` (0 = backend-controlled sampling); **frame-based models caption one representative frame (prefers the saved loop-start marker)**; **crop-limited captioning** (caption only what's inside a crop) — the only derived-view captioning found anywhere [DOC] | Local Transformers backends: CogVLM/2, Florence-2(+PromptGen), **Gemma 4 (video-native)**, JoyCaption, Kosmos-2, LLaVA, Moondream, Phi-3 Vision, **Qwen2.5-VL & Qwen3.5-VL (video-native)**, WD/Camie taggers; remote path extracts frames and sends as ordered image sequence (LM Studio JSON-schema mode); prose via VLMs, tags via taggers; `{tags}`/`{name}` template vars [DOC] | Not stated in guide; upstream StableLlama/taggui license unverified — **treat as unverified before any code reuse** [UNK] | Desktop, Transformers-based (not llama.cpp) [DOC] | Fork: 34★, 0 open issues/PRs, docs current; upstream may be the maintained line [DOC] |
| **DiffSynth-WebUI** (modelscope/DiffSynth-WebUI) | Official browser GUI over DiffSynth-Studio: create image/**video**/audio datasets, import files/archives (a `.txt` matching a media name imports as its prompt), maintain `metadata.jsonl` **with extra fields** (e.g. `edit_image`, files under `_fields/<sample>/<field>/`), start training tasks, watch loss [DOC-README] | Video is a dataset type only — **no cutting, frame-count, or fps tooling described** [DOC] | Bulk AI auto-caption via **any OpenAI-compatible multimodal endpoint** (configured in Settings) — API-shaped, no local model shipped [DOC] | **Apache-2.0** [DOC] | Embeds DiffSynth-Studio as submodule (pinned 84f93fc); training in separate process [DOC] | Very early: 12 commits, 44★, no releases — promising skeleton, not a product [DOC] |

**Read of the field:** the 2026 wave produced exactly two mature-ish video-side managers
(LoRA Dataset Studio's beta, Klippbok) and neither matches our shape — LDS is
image-born with a video beta riding on ai-toolkit (not musubi/DiffSynX), noncommercial,
and destructively edits inside its "Bank"; Klippbok is a normalize-then-caption CLI
(bakes transforms, Wan grids, cloud-first captioning). Neither is raw-clip/non-destructive;
neither targets H3's 17n+5 @ 24.000fps; neither captions video on llama.cpp.

### 1.2 Trainer-bundled dataset tooling (CLI form factor — feature prior art, not GUIs)

All four converge on the same data model: **media files + per-file caption sidecars or a
metadata manifest**; none ships a video captioner or a curation UI.

| Trainer | Dataset convention | Image+video mix | Frame-grid handling | License |
|---|---|---|---|---|
| **musubi-tuner** (kohya-ss) | TOML `[datasets]` → sub_dirs; captions as `.txt` sidecars (`caption_extension`) or JSONL `caption` field; `num_repeats` for balancing; `frame_extraction = "head"`; audio = sidecar wav [DOC-local, docs/dataset_config.md + minimax_h3.md] | Yes — `--one_frame` one-frame image items; envelope-validated `[envelope]` | `target_frames` list + `enable_bucket`; released 5–15 s gate (124–345 f), `--allow_experimental_duration` bypass; 32-px grid [DOC-local] | **Apache-2.0** ("Other code is under the Apache License 2.0"; `hunyuan_model`/`wan` subdirs follow upstream licenses) [DOC-local README] |
| musubi's captioner | `caption_images_by_qwen_vl.py` — local **Qwen2.5-VL via Transformers** (not llama.cpp), **images only**, default prompt demands "natural, descriptive text without structured formats", JSONL or .txt out, pixel-budget resize (max 1280, factor 28) [DOC-local] | — | — | The trainer-side captioner that exists is **image-only** — no trainer ships a video captioner [DOC-local] |
| **DiffSynth-Studio / DiffSynX** (modelscope) | Universal dataset format: `metadata.csv/json/jsonl` rows pairing file → `prompt` (+ optional fields); our envelope used `video`/`prompt`/`input_audio`/`frame_rate` JSONs [DOC + DOC-local] | Images + videos both consumed (one_frame) | **`--num_frames` validated 17n+5 at launch — hard error otherwise**; `--max_pixels`; dynamic per-item buckets [DOC-local, train.py] | **Apache-2.0** [DOC-local LICENSE] |
| **finetrainers** (huggingface) | `captions.txt`+`videos.txt` pairs, same-basename `.txt` sidecars, or `metadata.json/jsonl/csv`; `caption` is the required validation column; precomputed-embedding caching flags [DOC docs/dataset/README.md] | Images + videos, WebDataset, chained datasets round-robin (keep chained sets size-balanced) | num_frames/frame_rate are per-item validation fields | **Apache-2.0** [DOC] |
| **diffusion-pipe** (tdrussell) | Directories of media + same-basename `.txt` sidecars; `dataset.toml` with resolution, AR bucketing, frame bucketing; **images and videos mixed in one directory** [DOC-README] | Yes, first-class mixing | frame-bucket config; model-specific frame counts (Hunyuan/Wan/LTX) | **GPL-3.0** — feature prior art ONLY; GPL-family = never vendored here (license gate), user-fetch at most [DOC] |

### 1.3 Scale pipelines (million-clip class — wrong scale for 5→1000, right ideas)

- **video2dataset** (iejMac/LAION) — yt-dlp download + packaging at 10M-videos-in-12h
  scale; the architecture reference for parallel shards/subset workers [DOC]. Wrong
  scale, right skeleton for "import from URLs" if ever wanted.
- **HF video-dataset-scripts** (hlky/Sayak Paul, blog 2025-02-12) — the small-scale
  pipeline: yt-dlp → **Video-to-Scenes splitting** → per-frame filters (watermark
  probability, aesthetic score, NSFW) + **whole-video optical-flow motion scoring** →
  captioning (Florence-2 per-frame tasks, or Qwen2.5-VL whole-video) [DOC blog].
  Curation lessons worth keeping: require pwatermark < 0.1 on ALL frames but treat
  aesthetic scores as biased (use as bad-content floor ~4.25–4.5, or score only the
  first frame) [DOC blog]. Repo itself minimal (19 commits; openvid/ + video_processing/
  dirs; license not shown on repo page [UNK]); no H3 awareness.

### 1.4 ComfyUI-side captioning (nodes people actually run)

- **gokayfem/ComfyUI_VLM_nodes** — VLM node accepts a still or a **video-frame batch**,
  samples uniformly, resizes + JPEG-compresses, enforces per-image and total token
  limits [DOC-README]. Mostly cloud-API models — the token-limiting pattern transfers.
- **CC Llama Vision / LlamaServerVisionCaption** — captions images, batches, and video
  frames with a VLM via a **local llama.cpp server** [COMM-snippet, comfy.icu]. The
  closest existing "llama.cpp captioner as a node" — our manager replaces this with a
  first-class UI.
- **zsxkib/cog-comfyui-hunyuan-video** + **cog-create-video-dataset** — HunyuanVideo
  LoRA toolkit with Qwen-VL autocaptioning; the create-dataset cog "chops videos into
  clips with AI-generated captions" [DOC-README/COMM]. Replicate/cog form factor.

### 1.5 Image-side lineage — what transfers to video

- **kohya_ss GUI** (bmaltais) — Gradio over sd-scripts; dataset prep = folder of images
  + `.txt` sidecars + tag-focused captioning (WD14 etc.) [DOC-README]. The .txt-sidecar
  convention every video trainer inherited. Tag-centricity is what we explicitly DON'T
  take (H3 caption verdict is natural-language, guide §4.1).
- **Birme** — in-browser bulk resize/crop (auto-focus intelligent crop, batch convert)
  [DOC birme.net]. That's the whole job: aspect/bucket prep, no captions, no video,
  browser-local. Transfer: the "intelligent crop" idea only.
- **Cuppy** — could not be verified current in 2026 (no live result) — treat as stale
  [UNK]. Successors found instead: akalavol/LoRA-Dataset-Coach (wizard pipeline
  [COMM-snippet]), miroleon's LoRA Training Toolkit [COMM-snippet].
- **PhotomapAI** — tracks **token dependencies and component usage** across a dataset
  to optimize coverage [COMM-snippet, r/StableDiffusion 1pv6aok]. Image-side; the
  token/coverage-analytics idea transfers directly to our coverage dashboard.
- **Civitai on-site trainer** — offers JoyCaption natural-language label type for
  hosted training [DOC education.civitai.com]. Confirms the NL-caption default trend;
  cloud, so form factor irrelevant to us.
- **Civitai article 11942** (Wan/Hunyuan "the right way") — already harvested in guide
  §7; "caption your dataset as if the LoRA already works" [COMM, guide]. Still the
  canonical community captioning doctrine for Wan/Hunyuan-class models.

---

## 2. VLM captioning on llama.cpp (section B)

### 2.1 Capability matrix, verified 2026-09-17

| Capability | State | Evidence |
|---|---|---|
| Native video input | **Merged**: PR #24269 (ngxson) adds video to the mtmd subsystem via an **ffmpeg subprocess** (no library link); exposed in `llama-mtmd-cli --video` and **llama-server's OpenAI-compatible chat completions** (works "across vision models already supported") [DOC]. ROADMAP line: llama.cpp ≥ v0.4.0 `input_video` [DOC-internal]. Reddit thread 1u08j3q notes the old workaround (ffmpeg → 1 fps image sequence) still underlies it [COMM-snippet] | github.com/ggml-org/llama.cpp PR #24269, issue #18389 (plan), 2026-06-08 merge coverage |
| Temporal frame merging | **Upstream for qwen-vl-family**: commit/PR #21858 "frame merge" pairs adjacent frames into 6-channel super-frames processed Conv3D-style with temporal M-RoPE — mimics Qwen's native ViT video path; applies to qwen2vl/qwen3vl/qwen3.5 arch files [DOC]. **Known bug #24303**: it also merges consecutive *images* in one message when you didn't want that — relevant to any multi-frame-image workflow [DOC] | llama.cpp #21858, #24303 |
| Video-capable model families | **Qwen3-VL / Qwen3.5 / Qwen3.8-Flash-Next** (qwen-vl vision stack, mmproj GGUFs, frame-merge path) and **Gemma 4** (encoder-free native audio+video multimodal since April 2026 [DOC developers.googleblog.com]); **DeepSeek V4 Flash Vision = image-only; GLM 5.3 Flash = not yet in llama.cpp (issue #27922)** [DOC-internal, ROADMAP 2026-09-16] | ROADMAP + Google dev blog + HF model cards |
| Gemma 4 token budgets | Five fixed visual budgets **70/140/280/560/1120** via `--image-min-tokens`/`--image-max-tokens`; Unsloth guidance: **70/140 = classification, captioning, fast video understanding**; 280/560 = general chat; 1120 = OCR. Non-causal vision attention ⇒ all image tokens must fit one ubatch (raise `--ubatch-size` past budget) [DOC dev.to + Unsloth docs] | dev.to article 39ng |
| **The ≤10 s hang** | **Issue #27587: video input > ~10–13 s (≈300–400 frames) hangs llama-server forever** — no response, no error [DOC]. Separate Windows hang #24429 (MOOV-atom-dependent) [DOC]. **⇒ pipeline rule: chunk every video to ≤10 s before `input_video`; our clips are 0.9–15 s (22–345 f), so chunk at ~8 s max, or pre-extract frames ourselves** | llama.cpp #27587, #24429 |
| Qwen3-VL sizes | 2B→32B Instruct + Thinking merged (issue #16207 lineage); mmproj-F16 pairs fine with quantized mains [COMM-snippet]. Our AC names **Qwen3-VL-30B** — in-family | r/LocalLLaMA 1ok2lht |
| Qwen3.8-Flash-Next (quality target) | Multimodal MoE (180B total / ~6.8B active per Myric card); GGUF quants **bundled with mmproj vision projector**: ISTA-DASLab GSQ-RCO (3 sizes), pfeifferj 3.5-bit + BF16 mmproj, Myric APEX full-precision, **OrcaRouter "Uncensored" collection (13 quants + mmproj + MLX)** [DOC HF cards]. Runs ~75 GB RAM no-GPU per Unsloth; ROADMAP's Huihui Q4_K_XL 111G identification still pending llama.cpp arch verification + mmproj question [DOC-internal] | HF repos + unsloth.ai/docs/models/qwen3.8-next |

### 2.2 The maintainer's own prior art: llama-video (MIT)

`github.com/Cobdog/llama-video` (the maintainer's project, llama.cpp discussion #20965,
2026-03-24): ffmpeg frame extraction at configurable FPS (default 2.0, max 64 frames)
→ sequential pairing into 6-channel super-frames → temporal M-RoPE positions → patched
llama-server (`patches/video-support-20260424.patch`, pinned to llama.cpp `0adede8`;
VIDEO chunk type, Conv3D input, `mm_processor_kwargs` passthrough on
`/v1/chat/completions`) running Qwen3.5 vision GGUFs. Client surfaces: Python lib
(`Extractor`/`Preprocessor`/`LlamaServerClient`/`batch_caption`/`CaptionHistory`),
FastAPI service :9000, **Gradio WebUI with a live token-budget bar**. Six prompt
templates (`general/detailed/motion/composition/character/narrative`), `default` vs
`precise` presets, SQLite caption history. Limits: one server instance at a time
(VRAM), **uniform sampling only (keyframe/scene-change sampling declared but unwired)**,
no audio, thinking mode adds 30–120 s. Token cost scales steeply: ~200 tokens (4 frames
@ 280×280) → 200K+ (64 frames @ 1080p). **License: MIT** — clean to adopt/vendor under
our gate [DOC, all from the repo README + discussion].

**Strategic read:** the patch predates upstream `input_video` + frame-merge. Today the
upstream path (no patch to maintain) covers the same mechanism for the Qwen family;
the patch remains the fallback if upstream merging quality disappoints or the #24303
over-merge bug bites. What we should unconditionally adopt from llama-video is the
**client layer**: prompt-template + preset system, token-budget visualization, SQLite
caption history, batch-caption API. It is our own code lineage, MIT, and already
shaped for exactly this job.

### 2.3 Frame-sampling strategy verdict

| Strategy | Verdict for 0.9–15 s training clips | Evidence |
|---|---|---|
| Mid-frame single (Inline's default) | Cheap baseline; misses camera motion/pace — guide §4.5 already flags this [COMM guide] | guide §4.5 |
| First/mid/last triple | The minimum that can see motion + shot identity; what TagGUI's frame-based models approximate (loop-start marker frame) [DOC] | TagGUI guide |
| N-even at configurable FPS (`input_video` or client-side ffmpeg) | **Default.** llama-video default 2.0 fps (≈ 2 frames/s of clip); Gemma 4 at 70/140 budget = "fast video understanding" [DOC]; ComfyUI_VLM_nodes does exactly this + total-token cap [DOC] | llama.cpp PR #24269, llama-video, dev.to |
| Keyframe/scene-aware | Research says adaptive beats fixed for LONG video (PickNet ECCV'18, VideoTree, BOLT arXiv 2503.21483) [DOC-papers]; llama-video's is unwired [DOC]. **Overkill at ≤15 s — defer** | papers + llama-video README |
| Qwen frame-merge (temporal super-frames) | On by upstream for qwen-vl models; gives real motion perception at 2× temporal compression [DOC #21858]. Watch #24303 if we ever send image sequences as separate images | #21858/#24303 |

Practical envelope for OUR clips (22–345 f @ 24 fps = 0.9–14.4 s): at 2 fps a 345 f
clip = ~29 frames — safely under the 64-frame/`#27587` hang zone when sent as one
video, and ~“fast video understanding” token tier on Gemma. Token budgeting belongs in
the UI (llama-video's live bar is the pattern).

### 2.4 Chunking rule

≤10 s per `input_video` call, hard [DOC #27587]. Our grid tops out at 14.4 s (345 f) —
so: clips ≤ ~8 s go in whole; longer clips either get chunked (caption per chunk →
merge) or frame-extracted client-side at 2 fps and sent as an image set. Prefer
client-side extraction: it dodges both hang classes, works identically across model
families, and is what llama-video/TagGUI/ComfyUI_VLM_nodes all do anyway [DOC].

### 2.5 Multi-pass captioning (dense draft → condense)

No turnkey tool does this for training captions. Precedent: Wolf (arXiv 2407.18908)
chains multiple VLMs — dense per-segment captions → a summarization "world summary"
pass [DOC-paper]; Scale AI's production pipeline stages captioning similarly [DOC-blog].
Our shape: **pass 1 = dense factual capture per clip (detailed template)** → **pass 2 =
condense to the guide's mid-density single paragraph** with the per-class template
(guide §4.4) applied — pass 2 can run on the caption TEXT alone (cheap LLM pass, no
vision) since it's compression, not perception. Tag-replacement/templating from TagGUI's
Text Transform and LDS's Caption Lab cover the edit side [DOC].

### 2.6 Whisper / audio augmentation (H3 trains real audio)

No established community practice found for audio-transcript → video-gen caption
augmentation [UNK — nothing surfaced]. What we know that shapes it: H3's official prompt
contract carries `overall_soundscape` (1–4 sentences) + verbatim dialogue in
`<d>[Language] …</d>` [DOC, library captures]; musubi caches real audio natively and the
envelope measured real-vs-silent audio at identical cost `[envelope]`; guide §4.4
mandates a soundscape clause on audio-bearing rows; musubi requires images to STATE the
absence of sound [DOC-local]. **Verdict: run whisper.cpp (local, exists, mature [DOC])
per clip at import → (a) speech/no-speech flag + dBFS (LDS measures silence/dBFS per
shot [DOC-README]), (b) transcript when speech present → dialogue clause draft +
soundscape cue list for the VLM/human to fold in.** The exact merge format is [SPEC]
until the first judged A/B — flag it as an experiment, not a default.

### 2.7 Pipeline recommendation (B, synthesized)

1. Transport: **upstream llama.cpp `input_video`** on the studio's existing llama.cpp
   router (architecture.md LLM layer) for Qwen-family models; client-side ffmpeg
   extraction for Gemma 4 (image-set path) and as the universal fallback. No patch
   dependency unless quality forces the llama-video patch back in.
2. Chunk/frame discipline: ≤8 s per call or client-side 2 fps extraction, ≤~30 frames,
   token budget surfaced in UI (adopt llama-video's bar).
3. Models: Qwen3-VL-30B-class today (frame-merge path), Gemma 4 31B-IT as the
   alternate; Qwen3.8-Flash-Next as the quality target once arch + mmproj verified
   (ROADMAP pending item).
4. Prompts: per-class template presets from guide §4.4 (style/character/motion) as
   first-class presets alongside llama-video's six; character mode enforces the
   negative rules (no appearance words).
5. Two-pass: dense capture → condense (pass 2 text-only).
6. History/provenance: SQLite caption history with authorship (LDS does authorship
   [DOC]; llama-video does history [DOC]) — hand-written captions never silently
   overwritten by batch runs.

---

## 3. Curation techniques (section C)

### 3.1 Clip-level near-duplicate detection — ratio-INVARIANTLY (maintainer lock #6)

Constraint from the maintainer: cross-ratio variants of the same content are **bucket
diversity, not redundancy** — dedup must be ratio-invariant, surfaced as a view, killed
selectively.

| Approach | Ratio-invariance | Notes | Evidence |
|---|---|---|---|
| **videohash** (akamhy, Python) | Claims robust to resolution/watermark/frame-rate/bitrate changes | 64-bit perceptual video hash, Hamming distance ≤6 ≈ near-dup; whole-video signature | [DOC-README] github.com/akamhy/videohash |
| **vhash** (helloall1900, C++) | Same algorithm | Faster reimplementation for large libraries | [DOC-README] |
| **CLIP/open-CLIP embedding clustering** | **Not native** — CLIP's positional embeddings are aspect-sensitive; letterbox/cover-crop normalization is the standard workaround | Frame-embedding → video-level aggregation (mean/max pooling) → cosine clustering; also gives the semantic search Klippbok/LDS use | [DOC Medium/DZone pipeline guides + OpenAI community thread] |
| LDS near-dup grouping | Image-side | Keeps sharpest member — the "keep sharpest" resolution heuristic transfers | [DOC-README] |

**Verdict:** two-tier. **Tier 1 (exact/near-dup, any ratio):** videohash-style perceptual
hash — catches re-encodes, watermarks, and same-content-same-ratio dupes. **Tier 2
(same-content-cross-ratio, advisory):** aspect-normalized (center-cover-crop to a
canonical square) CLIP embeddings — after normalization, cross-ratio variants land in
the SAME cluster, which per the maintainer's call is a feature: the cluster view IS the
"bucket diversity" browser (see one source across ratios = confirm coverage, not
redundancy). Surface both tiers as views; never auto-delete. fal's per-source capping
(guide §3.1) rides on top: cluster by source + similarity → cap per source.
Cap-per-source is the harmful-dup killer; cross-ratio repeats are fine `[COMM guide +
maintainer call]`.

### 3.2 Slow-motion / interpolated-footage detection (fal's audit: ~2/3 of people clips retimed)

No ready-made "retimed footage detector" exists [UNK — nothing surfaced]. Compose one
from verified parts; every ingredient is local + license-clean (LGPL ffmpeg filters):

1. **Metadata pass** — ffprobe: container fps + any `camera_fps`/capture-rate tags vs
   24.000 target. 50/60 fps sources played at 24–30 are the classic retiming signature
   (fal audit [COMM guide]).
2. **Frame-diff energy** — mean/std of inter-frame differences (the freezedetect
   metric generalized): true 24 fps motion has natural energy variance; retimed
   (slowed) footage shows abnormally LOW energy at its playback rate; interpolated
   footage shows abnormally LOW energy VARIANCE (synthetic in-between frames are
   unnaturally smooth) [inferred from VFI mechanics — DOC-adjacent, tag [SPEC] until
   measured on known-retimed samples].
3. **ffmpeg filters** — `freezedetect` (freeze regions, noise floor + duration
   metadata keys [DOC FFmpeg source]), `mpdecimate` in detection/logging mode (counts
   near-duplicate frames without dropping [DOC superuser/ffmpeg threads]) — the dup
   frame count is LDS's "encode-damage sweep" dup-frame signal too [DOC-README].
4. **Disposition:** flag → human decides retime (`setpts`+`atempo` per fal [COMM
   guide]) vs caption-as-slow-motion vs drop. Matches the manager's review-queue shape.

### 3.3 Hard-cut detection (one scene per clip — guide §3.2/loraai doctrine)

Run a shot detector **intra-clip** (on each candidate clip, not just at source split
time): a clip containing an internal cut must be split at export or excluded.

| Tool | Type | Verdict |
|---|---|---|
| **PySceneDetect** | Rule-based (content/adaptive/threshold detectors), mature, BSD-2-Clause... license listed MIT on PyPI [DOC — verify before vendoring]; "completeness over efficiency" per maintainer | Default for intra-clip cut checks: deterministic, no model download, frame-accurate content detector |
| **TransNetV2** (2020) | Deep shot-boundary net; what LDS uses for shot detection [DOC-README]; pip `transnetv2-pytorch` | Heavier; better on dissolves/gradual transitions. Adopt only if PySceneDetect misses real-world cuts in our footage |
| AutoShot (2023) | NAS-based shot detector [DOC scenedetect.com/similar] | Watchlist only |

CineTrans (arXiv 2508.11484) uses both PySceneDetect AND TransNetV2 together — the
combination pattern has precedent [DOC-paper].

### 3.4 Coverage analytics

Prior art: LDS's "coverage advice" (what's missing: profile views, outfits) computed
from its classification pass [DOC-README]; PhotomapAI's token-dependency tracking
[COMM-snippet]; sv14rt0 AC 8idmlsh (aspect/duration/resolution/content-type
distribution + bias flags); fal's per-source capping [COMM guide]. Our differentiator:
coverage computed **against the bucket map** — the envelope's walls (345 f@≤544×320 ·
124 f@≤480×832 · 39 f@768×1344, budget rule VRAM ≈ 5.1 GB fixed + ~2.6 GB/Mtok(px×f)
`[envelope]`) make "what to add more of" a per-bucket VRAM-budget question, not just a
distribution histogram (lock #8).

### 3.5 fps normalization + frame interpolation (steer item; bake-time per lock #5)

CFR 24.000 is an export-time layer. When source fps ≠ 24, in order of preference:

1. **Speed retime** (`setpts` + `atempo`): lossless pixels, no synthetic frames;
   ≤±4.1% tempo error for 23.976/25 sources — fal's documented retime approach
   [COMM guide]. Default for near-24 sources.
2. **Drop/dup** (ffmpeg `fps=24`): no synthesis, small judder; fine for 30→24 on
   low-motion clips.
3. **Motion-compensated interpolation** — only for real gaps (e.g. 8–12 fps sources
   or grid top-ups where retiming is unacceptable):
   - **ffmpeg `minterpolate`** — built into the ffmpeg we already ship (LGPL tooling,
     already a catalog dependency); slow; known caveat: scene-change handling
     reintroduces duplicates at cuts [DOC ffmpeg-users].
   - **Practical-RIFE** (hzwer) — **MIT** [DOC]; v4.25 noted smoother on fast motion
     than v4.26 [COMM]; arbitrary-timestep interpolation; PyTorch.
   - **rife-ncnn-vulkan** (nihui) — **MIT**, portable, no CUDA/PyTorch; the
     subprocess-friendly pick for an AGPL app (link or spawn, never vendor weights)
     [DOC].
   - **Flowframes** (GUI) / SVP / Topaz — Windows-GUI/commercial; reference only [COMM].
   - **NVIDIA Optical Flow SDK** — free incl. commercial use BUT **explicitly
     proprietary**: "You may not use the SDK in any manner that would cause it to
     become subject to an open source software license" [DOC license page] —
     **incompatible with our AGPL distribution; hard NO for bundling; user-fetch-only
     if ever wanted at all** (and the hardware-OFA path buys little over RIFE for
     one-shot exports).
   - License note: interpolated frames are synthetic — the same "dreamy, floaty"
     signature fal attributes to retimed footage can apply to interpolated training
     data [inferred]; prefer retime; tag RIFE-filled items in metadata so a training
     run can exclude them.

---

## 4. Gap analysis (section D) — what NO existing tool gives us

Mapped to the maintainer's 13 locks (sv14rt0 directive, 2026-09-17). "No tool" claims
are against §1's survey; the closest partial is named.

| # | Our need (lock) | Closest existing | Why it's short |
|---|---|---|---|
| 1 | **Raw-clip non-destructive layers** (trim/crop/CFR/grid as export-time layers, source untouched — locks 1–3) | LDS "Bank reads in place, never modified" [DOC] — but its crop/upscale/delete mutate the bank; Klippbok `normalize` bakes new files; DiffSynth-WebUI doesn't transform at all | Nobody has source → N layers → per-layer export. NLE-style layer model with live view rendering is ours alone |
| 2 | **Caption attachment to the LAYER's effective view + stale-flagging on crop edits** (lock 7) | TagGUI's crop-limited captioning (caption what's in the crop) [DOC] — the only derived-view captioning found; LDS captions the file | Nobody tracks caption↔view coupling or invalidates captions when the view changes. Proposed stale→recaption-queue is novel |
| 3 | **Grid pre-conformity: 17n+5 @ exact 24.000 fps, trim-to-grid+2** (lock 2; envelope's container-truncation trap) | LDS's target-aware cutting has an H3 target in its list (8 targets, unverified for H3 runs) [DOC-README]; Klippbok does 4n+1 Wan grids only; trainers validate at launch (error, not fix) [DOC-local] | Nobody PRE-conforms at export with the +2 trim head-room rule or asserts decoded frame counts (the ffprobe-lied trap `[envelope]`) |
| 4 | **Bucket-mix composition + per-bucket VRAM preflight** (locks 8/10) | Nothing. LDS coverage advice is image-side; PhotomapAI token analytics image-side | Our budget formula (5.1 GB + 2.6 GB/Mtok, walls at 345f/124f/39f `[envelope]`) exists nowhere else; peak=max-of-buckets makes the dashboard a MAX-composition problem — trivial to compute, nobody does |
| 5 | **Trigger-token format validation** (lock 9; obfuscated single tokens, prepend-exactly-once, no duplication) | Nothing found in any manager [UNK] | Trivial rules (guide §4.3/§4.6 QA hooks) with zero prior art |
| 6 | **Per-trainer export presets (musubi TOML vs DiffSynX stage-1 manifest), researched per content class** (lock 10) | Klippbok exports musubi/ai-toolkit/kohya configs [DOC]; finetrainers/diffusion-pipe document their formats | No tool exports H3 to BOTH trainers with class-conditioned recipes (rank/steps/LR/de-distill method from guide §1) |
| 7 | **Hand+VLM review queue with authorship + free-form discussion of a clip** (lock 11) | LDS: authorship records, re-caps preserve hand-written [DOC]; TagGUI: prompt history; llama-video: A/B + templates | The interactive-spectrum (modal discussion → headless batch, all local llama.cpp) with review-queue state machine is unclaimed |
| 8 | **Video captioning on llama.cpp, no cloud** (lock 11) | llama-video (our own, MIT, patched-server) [DOC]; upstream `input_video` [DOC] | Every MANAGER uses Ollama/LM Studio/Transformers or cloud (LDS, Klippbok, TagGUI, DiffSynth-WebUI). No manager rides llama.cpp's native video path |
| 9 | **Ratio-invariant dedup as advisory view + per-source capping** (lock 6) | videohash (ratio-robust hash) [DOC]; CLIP clustering [DOC]; LDS keep-sharpest grouping [DOC] | Nobody composes the two tiers + cross-ratio-as-diversity semantics + source caps |
| 10 | **Slow-mo/interpolation audit, hard-cut check, encode-damage sweep as import gates** | LDS per-shot measures (freeze, dup-frames, macroblocking, camera-move) [DOC-README] — closest single source; ffmpeg filters exist [DOC] | LDS is image-born + noncommercial; composing the audit for H3 clip-shape rules (one scene, natural-speed) with retime/split dispositions is open |
| 11 | **Mixed-bucket dataset as a first-class object** (stills + short hi-res + long lo-res in ONE dataset, 5→1000) | diffusion-pipe/finetrainers mix images+videos in a dir [DOC]; trainers accept it; envelope proved it free `[envelope]` | No manager reasons ABOUT the mix (per-bucket counts, VRAM-preflight, coverage-per-bucket) |
| 12 | **Provenance/consent metadata per item** (source, license posture, AI-generated flag) | LDS: AI-clip flag [DOC]; our own licensing apparatus (fetchCatalog consent records, conventions) | No dataset manager carries per-item provenance/consent; for us it's a natural extension of the studio's existing catalog discipline |

---

## 5. Recommended feature set (feeds the maintainer's signoff round)

### 5.1 Adopt / adjust / reject per tool

| Tool | Verdict | What exactly |
|---|---|---|
| LoRA Dataset Studio V2 | **ADOPT (features only — license forbids code)** | Per-shot QA measure suite (freeze/blur/silence-dBFS/camera-move/AI-flag/subtitle/encode-damage); caption authorship + preserve-hand-written-on-recap; Caption Lab (find/replace, frequencies, targeted re-caption); coverage advice framing; near-dup keep-sharpest |
| Klippbok | **ADOPT (features; Apache code referenceable)** | Omission-encoded per-class caption templates (matches guide §4.4 — mutual confirmation); CLIP reference-triage ("find this character across footage"); per-trainer export-config generation; `score`/`audit` caption QC commands |
| TagGUI Video | **ADJUST** | Crop-limited captioning → generalize to layer-view captioning with stale-flagging; loop-start-marker "representative frame" for posters; text-transform utility; JSONL manifest export |
| DiffSynth-WebUI | **ADJUST** | metadata.jsonl + extra-fields model (`_fields/` pattern) for per-item provenance and per-layer data; OpenAI-compatible caption endpoint config (we point it at our own llama.cpp router) |
| musubi-tuner + DiffSynX dataset conventions | **ADOPT (they're the export targets)** | Sidecar .txt AND metadata-manifest both writable per trainer; 17n+5 launch validation exists trainer-side — our export asserts decoded counts BEFORE the trainer sees them |
| finetrainers / diffusion-pipe | **ADOPT (conventions)** | Frame/AR bucket config shapes; keep chained-subset size-balancing in mind if datasets grow sub-datasets |
| video-dataset-scripts (HF) | **ADJUST** | Filter-suite ideas (watermark all-frames rule, aesthetic-as-floor); motion scoring via optical flow; Video-to-Scenes splitting pattern |
| video2dataset | **REJECT** (wrong scale) | — |
| ComfyUI_VLM_nodes / CC Llama Vision | **ADJUST** | Token-capping pattern; "local llama.cpp server as captioner" wiring is already our server's LLM layer |
| kohya_ss GUI / Birme / Cuppy / PhotomapAI / Civitai trainer | **ADJUST/REJECT** | Take intelligent-crop idea (Birme), token-dependency analytics idea (PhotomapAI); reject tag-centricity (kohya) and cloud trainer; Cuppy stale |
| llama-video (ours, MIT) | **ADOPT (code + patterns)** | Client stack wholesale: templates+presets (add guide §4.4's three as first-class), token-budget bar, SQLite CaptionHistory, batch_caption API; keep the patch as fallback only |
| RIFE family / ffmpeg minterpolate | **ADOPT rife-ncnn-vulkan (MIT, subprocess) + built-in minterpolate** | Bake-time only; retime-first policy; tag interpolated items; NVIDIA OFSDK rejected (proprietary, AGPL-incompatible) |
| videohash / PySceneDetect / whisper.cpp | **ADOPT** | Tier-1 dedup; intra-clip hard-cut detection; speech flag + dialogue drafts. All local, all license-clean (verify each SPDX at vendor time per gate) |

### 5.2 The synthesized v1 feature list

1. **Import & library** — folder/watch import of raw sources (never modified); pooled
   video + filmstrip-poster browse; 5→1000 items (virtualized); ffprobe metadata
   (fps, frames-decoded-not-container-claimed, res, aspect, dBFS); AI-generated flag +
   provenance/consent fields per item.
2. **Layer model** — one source → N crop/trim layers (scroll-wheel crop size,
   shift+scroll aspect cycle; full-res AR crops, never resized); export item per layer;
   too-small sources refused (upscale deferred).
3. **Export-time conform** — 24.000 fps CFR (retime → drop/dup → RIFE-ncnn last
   resort, tagged); 17n+5 grid with trim-to-target+2; decoded-frame-count assertion;
   dims on 32-px grid; per-item silent-wav mux when audio absent (trainers expect rows).
4. **Caption system** — per-LAYER captions (stale-flag on view edit → recaption
   queue); hand-edit + VLM batch (llama.cpp `input_video`, ≤8 s chunks / 2 fps
   client-side extraction, token budget shown); per-class template presets (style/
   character/motion + llama-video's six); dense→condense two-pass; interactive modal
   with free-form discussion ↔ headless batch with user instructions; SQLite history +
   authorship; batch never silently overwrites hand-written.
5. **Audio lane** — whisper.cpp pass: speech flag, dBFS, dialogue draft + soundscape
   cues; musubi consistency rule enforced (still/image rows state sound absence;
   audio rows carry a soundscape clause).
6. **Curation views** — tier-1 videohash near-dup; tier-2 aspect-normalized CLIP
   same-content clusters presented as bucket-diversity browser (cross-ratio = good);
   per-source cap warnings; slow-mo/interpolation audit (metadata + frame-diff energy
   + freezedetect/mpdecimate) with retime/caption/exclude dispositions; intra-clip
   hard-cut check (PySceneDetect content detector) with split-at-export.
7. **Coverage + budget dashboard** — distribution across aspect/duration/resolution/
   content-class/caption-coverage; per-bucket composition against the envelope walls;
   projected peak VRAM via the measured budget formula; "add more of X" guidance.
8. **QA gates** (each maps to a documented failure, guide §5): empty captions; trigger
   duplicated (baked + prepended); fps≠24.000; slow-mo suspicion; duration truncation
   vs grid target; near-dup cluster over-cap per source; silent-audio rows missing
   soundscape clause; trigger-token format validation (obfuscated single token, one
   insertion path).
9. **Export presets** — musubi TOML (+ caption sidecars/JSONL, one_frame stills, wav
   sidecars) and DiffSynX stage-1 manifest (video/prompt/input_audio/frame_rate JSON
   rows) with class-conditioned recipe hints (rank 16, LR, steps band, de-distill
   method) surfaced — trainer runs stay in the sidecar's hands, the manager ships the
   dataset + a recipe card.

Deferred (watchlist): keyframe-aware sampling (unwire-later), TransNetV2 upgrade,
NVIDIA-OFSDK anything, upscale-on-refuse, cloud captioners (never — hard lock).

---

## 6. Sources (all fetched/verified 2026-09-17 unless dated)

**Managers/curation GUIs**
1. perfectgf/lora-dataset-studio README (V2) — github.com/perfectgf/lora-dataset-studio · announcements r/StableDiffusion 1rd587k, 1jzf1zu [snippet] · Pinokio listing
2. alvdansen/klippbok README + Civitai article 26494 (2026-02-24, updated ~5 mo) — github.com/alvdansen/klippbok, civitai.com/articles/26494
3. diodiogod/taggui-video docs/CAPTIONING_GUIDE.md — github.com/diodiogod/taggui-video (upstream StableLlama/taggui)
4. modelscope/DiffSynth-WebUI README — github.com/modelscope/DiffSynth-WebUI
5. PhotomapAI — r/StableDiffusion 1pv6aok [snippet]; akalavol/LoRA-Dataset-Coach, miroleon toolkit [snippet]; bmaltais/kohya_ss; birme.net; education.civitai.com on-site trainer (JoyCaption label type)

**Trainer dataset conventions**
6. musubi-tuner @ 70d42b8 [DOC-local]: README License section; src/musubi_tuner/caption_images_by_qwen_vl.py; docs/dataset_config.md, docs/minimax_h3*.md (via h3-lora-training-guide §7)
7. DiffSynth-Studio @ c458cb8 [DOC-local]: LICENSE (Apache-2.0); diffsynth-studio-doc.readthedocs.io Model_Training; examples (LongCat-Video.sh); AMD ROCm Wan2.2 finetune blog (metadata.csv)
8. huggingface/finetrainers docs/dataset/README.md (fetched); repo Apache-2.0
9. tdrussell/diffusion-pipe README + examples/dataset.toml (GPL-3.0)

**Scale pipelines**
10. iejMac/video2dataset + laion.ai/blog/video2dataset; huggingface/blog/vid_ds_scripts (2025-02-12) + huggingface/video-dataset-scripts repo

**llama.cpp / VLM**
11. ggml-org/llama.cpp: PR #24269 (mtmd video input, ngxson; merged — aiweekly coverage 2026-06-08); issue #18389 (plan); commit #21858 (frame merge, qwen-vl family); issue #24303 (over-merge bug); issue #27587 (**video >~10 s hangs llama-server**); issue #24429 (Windows MOOV hang); issue #17660 (Qwen2.5-VL video request); discussion #20965 (Qwen3.5 temporal captioning, 2026-03-24)
12. Cobdog/llama-video README — github.com/Cobdog/llama-video (MIT; patch pinned llama.cpp 0adede8, 2026-04-24)
13. Gemma 4: developers.googleblog.com Gemma 4 12B dev guide (encoder-free A/V); dev.to 39ng (token budgets 70–1120, --image-min/max-tokens, ubatch); unsloth docs
14. Qwen3.8-Flash-Next GGUF: HF ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF; pfeifferj 3.5-bit (BF16 mmproj); Myric APEX; OrcaRouter Uncensored collection (blog/runbook); unsloth.ai/docs/models/qwen3.8-next; r/LocalLLaMA 1we6tau, 1w42biu (MTP)
15. Qwen3-VL in llama.cpp: r/LocalLLaMA 1ok2lht [snippet]; GLM 5.3 Flash absent (issue #27922) + DeepSeek V4 Flash Vision image-only [DOC-internal ROADMAP 2026-09-16]
16. Frame-sampling research: arXiv 2503.21483 (BOLT); PickNet ECCV 2018; VideoTree (OpenReview LNL7zKvm7e); Moments Lab frame-sampling post; NVIDIA VLM prompt-engineering guide
17. Wolf dense-captioning framework arXiv 2407.18908; Scale AI "Path to Large Scale Dense Video Captioning"; whisper.cpp (pub.towardsai overview; byparker.com usage)

**Curation / detection / interpolation**
18. akamhy/videohash + docs; helloall1900/vhash; Medium/DZone CLIP video-dedup pipelines; OpenAI community CLIP similarity thread (letterboxing note)
19. FFmpeg: vf_freezedetect source + FFmpeg 8.0 filter docs; mpdecimate logging (superuser 1706239, SO 37088517); minterpolate caveats (ffmpeg-users 2021-01); freezedetect usage (superuser 1313070)
20. PySceneDetect (scenedetect.com/similar; issue #7); TransNetV2; AutoShot; CineTrans arXiv 2508.11484; transnetv2-pytorch
21. Interpolation: hzwer/Practical-RIFE (MIT; v4.25/4.26 notes); nihui/rife-ncnn-vulkan (MIT); Flowframes; SVP; NVIDIA Optical Flow SDK license page (docs.nvidia.com/video-technologies/optical-flow-sdk/license) — proprietary, no-OS-contamination clause

**Internal**
22. h3-lora-training-guide.md (§1 per-class recipes, §3 dataset technicals, §4 caption verdict, §5 failure modes) and h3-lora-training-envelope.md (budget rule, walls, mixed-bucket, truncation trap) — `[envelope]`/[DOC]/[COMM] tags therein
23. sv14rt0 directive — maintainer's 13 product locks (2026-09-17); architecture.md (llama.cpp router LLM layer, FFmpeg ops); ROADMAP VLM-video research line

---

## Verdict table

| question | verdict | confidence |
|---|---|---|
| Is there a ready video-first H3 dataset manager to adopt? | **No.** Closest: LoRA Dataset Studio V2 (feature-rich, PolyForm-NC, ai-toolkit-bound, video beta) and Klippbok (Apache, CLI, Wan grids, cloud-first captions) | measured against fetched READMEs [DOC] |
| Do any managers caption video on llama.cpp? | **No** — all use Ollama/LM Studio/Transformers or cloud; upstream llama.cpp `input_video` (PR #24269) + qwen frame-merge (#21858) make it possible; the maintainer's own llama-video (MIT) is the client-layer head start | [DOC] |
| Can llama.cpp caption our clips today? | **Yes, with discipline**: Qwen-family via native `input_video`; Gemma 4 31B-IT via image sets (70/140 budget); **chunk ≤8–10 s** (hang #27587); Qwen3-VL-30B-class now, Qwen3.8-Flash-Next the quality target pending arch/mmproj verification | [DOC] |
| Best frame sampling for ≤15 s clips | N-even at ~2 fps client-side extraction (universal, dodges hangs, family-agnostic); first/mid/last as the cheap baseline; keyframe/adaptive deferred | [DOC]+[COMM] synthesis |
| Multi-pass captioning worth it? | Yes as dense→condense; pass 2 is text-only compression into guide §4.4 templates | [DOC-papers] + [inferred] |
| Whisper augmentation | No established video-gen practice; adopt whisper.cpp for speech-flag + dialogue/soundscape DRAFTS; judged A/B before defaults | [UNK→SPEC] |
| Near-dup detection | Two tiers: videohash (ratio-robust, cheap) + aspect-normalized CLIP clusters as the cross-ratio diversity browser; advisory views + per-source caps, never auto-delete | [DOC] + maintainer lock #6 |
| Slow-mo/interpolation detection | Compose: ffprobe metadata + frame-diff energy + freezedetect/mpdecimate; dispositions retime/caption/exclude; no ready tool exists | [SPEC] composition of [DOC] parts |
| Hard-cut policy | PySceneDetect content detector intra-clip at import; split-at-export or exclude; TransNetV2 as upgrade path | [DOC] |
| fps normalization | retime (setpts+atempo) → drop/dup → minterpolate/rife-ncnn-vulkan (MIT) last, tagged; **NVIDIA OFSDK: license-rejected for us** | [DOC] + [COMM] |
| The manager's differentiators (gap list) | Raw-clip layers; per-layer captions + stale-flagging; 17n+5@24 pre-conformity (+2 headroom, decoded-count assert); bucket-mix VRAM preflight (budget formula); trigger validation; dual-trainer class-conditioned export presets; local-llama.cpp review queue incl. free-form discussion; provenance/consent per item | gap analysis vs §1 survey |
| Build posture | Adopt llama-video client stack + audit-suite FEATURES from LDS/Klippbok; the layer model, budget dashboard, and QA gates are greenfield | this doc §5 |
