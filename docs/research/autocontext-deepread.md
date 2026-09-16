# AutoContext (supElement) — code deep-read, catalog entry, adoption notes

Task: AutoContext deep-read (Flux `lxmtgss`, epic `16jskz2`). Read 2026-09-16 against
upstream HEAD **`f1062d34e3c25ef421b2aadeb69f2d21831d1625`** (2026-09-15, "Add files
via upload", pyproject `version = "0.7.2"`), license **Apache-2.0** (LICENSE file
verified from a fresh fetch — template-only copyright line, no named holder).
Indexed via jcodemunch (14 files, 8 Python; every mechanism below was read in code,
not inferred from the README). Chinese README translated in full for the
prompt-discipline section (§5); line numbers are approximate where marked `≈`.

---

## 0. Verdict first

**AutoContext is the most complete open implementation of H3 segmented inference we
have read — and its four novel-to-us mechanisms are all adoptable independently of
whether we ever run their nodes.** It is not a new model or a fork: it is orchestration
around stock ComfyUI MiniMax-H3 nodes plus two monkey-patches (which upstream ComfyUI
has since absorbed natively — `h3_patches.py` auto-detects and skips). Its anchoring
is a **superset** of both reference implementations we already documented: loopforge's
latent handoff **and** Motion-Context-style clean-tail conditioning **and** an untagged
audio-continuation ref, all three at once, plus a per-region denoise dial we don't have.

| # | Mechanism | What it actually is (code) | Novel vs us? | Adopt? |
|---|-----------|---------------------------|--------------|--------|
| 1 | Timeline / Clip_Tag prompt parsing | Regex tag/range slicing → per-segment prompts with **chunk-relative** time re-rendering; segment lengths derived from the prompt itself | Yes — prompt-as-segmentation-source | Yes (rules + parser semantics) |
| 2 | Per-segment reference filtering | Only refs **mentioned in that segment's prompt** are passed; numbers re-compacted 1..k; no inheritance across segments | Yes — enforced identity discipline | **Yes — biggest adoption candidate** |
| 3 | Latent anchoring | 3 channels: (a) prev tail **copied into the initial latent** head with `noise_mask = video_context_denoise`, (b) prev tail frames injected as **cond-row keyframes** at segment-relative t, (c) prev tail audio as an **untagged ref** ("previous content"); output-side trim-splice | The dial and the audio ref are new; the splice matches our E5 raw-latent arm | Selectively (dial + audio ref) |
| 4 | Hash-based latent cache/resume | Per-segment `.pt` files keyed on prompt hash + conditions hash + sampler meta; first cache miss force-rebuilds everything downstream **in the run** | Yes — resume semantics for chain reruns | Yes (with one closing fix, §4.4) |

**Quality-claim verdict (vs our measured E5/E6 physics):** their seam-continuity claim
is *supported* (their vcd=0 splice is exactly our E5 raw-latent-handoff arm — invisible
seams, 39–42 dB pinned rows); their motion/identity continuity claims are *doubtful as
defaults* — E5 says strong pins drag content back to the source scene and identity dies
first in anchored chains (0.12 ArcFace) — **and their own README agrees**, which is why
they ship the temporal-exclusivity + per-segment-ref-declaration discipline (§5). The
mechanism and the discipline are one design; adopt both or neither.

---

## 1. Repo facts

- Upstream: <https://github.com/supElement/ComfyUI_MinimaxH3_AutoContext> — Apache-2.0,
  sha-pinned HEAD `f1062d34e3c25ef421b2aadeb69f2d21831d1625`, v0.7.2, Chinese README
  (an `README.en.md` translation workflow exists — `.github/workflows/translate.yml`).
- Files that matter: `nodes.py` (410 L, two nodes), `h3_sampler.py` (1 913 L, the
  engine), `h3_utils.py` (1 061 L, grid math + prompt parsing), `h3_conditioning.py`
  (268 L, payload builder), `latent_cache.py` (203 L), `seam_correction.py`
  (pixel-domain seam node, `_gpu_optical_flow` at L761), `h3_patches.py` (148 L,
  now-mostly-dead monkey-patches), `web/js/h3_auto_ui.js` (live "expected segments"
  preview, client-side), `workflows/*.json` (2_samplings, audioDrive reference graphs).
- Three nodes: `Minimax_H3_AutoContext_parameter` (prompt + all segmentation params →
  `parameter` dict), `Minimax_H3_AutoContext_Sampler` (first/second pass in one node),
  `Minimax_H3_Seam_Correction` (post-decode pixel fixer).

### Grid constants everything hangs on (h3_utils.py, h3_sampler.py)

Pixel frames live on the **17n+5 grid** (5, 22, 39, 56, 73, 90, …); latents on the
**5k+2 grid** via `video_latent_t(n) = ((n-5)//17)*5+2` (`≤5 → 2`). The
frames-per-token cycle is `(1,4,4,4,4)` — latent token *k* starts at pixel
`sum((1,4,4,4,4)[i%5] for i<k)` (`h3_conditioning._pixel_index_for_latent_frame`).
Because segment token counts ≡ 2 (mod 5) and context token counts ≡ 2 (mod 5), **head
trims conserve token phase** — token counts convert losslessly to pixel seam indices
(`compute_seam_boundaries`, h3_sampler.py ≈L76). This phase-conservation argument is
the load-bearing trick under every splice in the pack, and it is correct.

---

## 2. Mechanism 1 — timeline / Clip_Tag prompt parsing (exact semantics)

Four `clip_mode`s (`nodes.py` `H3ParameterNode`): `Clip_Tag` (default), `timeline`,
`sequential`, `global`. In `Clip_Tag` and `timeline` modes **`total_frames` and
`chunk_frames` are ignored as drivers** — segment count and lengths come from the
prompt; they survive only as fallback when parsing degrades.

### 2.1 Clip_Tag (`h3_utils.py` §Clip_Tag, ≈L780–1010)

- **Tag template** (`_parse_tag_pattern`): user supplies a template that **must end in
  digits**; scanned right-to-left into `(prefix, suffix)`. `段1 → ('段','')`,
  `A01 → ('A','')`, `[片段001] → ('[片段',']')`. Number width is not enforced — `段1`
  matches `段12` too.
- **Tag line matching** (`_split_by_tag`): `^[ \t]*prefix(\d+)suffix[ \t]*` + optional
  separators from `:：，,。；; \t—–-` + optional same-line rest, `re.MULTILINE`. The tag
  must be at line start (leading whitespace ok); a newline after the tag is
  recommended but not required — same-line rest after separators is kept as segment
  content. Text before the first tag becomes a **global prefix appended to the END of
  every rendered segment**.
- **Segment duration, three tiers** (`_parse_tag_line_duration` →
  `_compute_segment_duration`):
  1. duration on the tag line itself — a time *range* (`段1:0-5秒` → 5 s, `段1:3-8秒`
     → 5 s; range beats single value) or a *single* duration (`段1:3秒` → 3 s). The
     marker is stripped from the prompt.
  2. else the **max end of time markers inside the segment body** (`【0-2秒】+【2-5秒】`
     → 5 s). These markers are **relative, 0-based, per segment** — never absolute
     timeline times.
  3. else `total_frames / fps` fallback (call site in `run_auto_context_generation`,
     h3_sampler.py ≈L660: `build_tag_schedule(long_prompt, clip_tag,
     default_seconds=total_frames / fps)`). Note the README's prompt-example section
     says "`chunk_frames / fps` 兜底" — **stale**; the code and the README feature
     table both say `total_frames/fps` (single-tag case ⇒ whole video ≈ total_frames).
- **Time-marker regex** (`_TIME_PATTERN`, shared by everything):
  `(\d+(\.\d+)?)\s*[s秒]?\s*[-–—~至到]\s*(\d+(\.\d+)?)\s*[s秒]?` with a boundary
  character required before it — accepts `0-5s / 0-5秒 / 3至8s / 2–6秒` and
  Chinese/English dashes and 至/到.
- **Duration warning**: any segment > 15 s logs a warning (MiniMax official
  recommendation) but proceeds.
- **Frame accounting** (`compute_tag_chunks`): first segment length =
  `snap_to_grid_nearest(target)`; non-first segments: *new* content snapped to the
  **nearest multiple of 17** (`_snap_to_17_multiple_nearest`), actual generated length
  = new + `context_frames` (both 17n+5 ⇒ difference is a multiple of 17 — phase
  conserved). A compensation loop then distributes ±17-frame steps from the last
  segment backwards so Σnew ≈ Σtarget (README: "总时长自动对齐目标总帧数").
- **Rendering** (`render_tag_segment`): `raw` = strip tags, emit body verbatim
  (in-segment markers untouched — "for LLM-generated structured prompts");
  `legacy`/`official` = run `build_prompt_schedule(seg, seg_seconds, mode="timeline")`
  + `compose_window_prompt(0, seg_seconds)` — i.e. **in-segment time markers are
  re-rendered relative to the segment** (legacy: `X-Y秒` snapped to a 0.5 s grid;
  official: `[Shot 1] At 00:00.000` style, frame-exact, no snapping), then the global
  prefix is appended.
- **The tag itself is removed** before inference in every format.

### 2.2 timeline mode (`parse_prompt_with_globals` + branch at ≈L675)

Paragraph-level split: paragraphs containing a time range become **timeline items**
(duration = range × fps, snapped up via `snap_to_grid_up`); everything else is a
**global** paragraph that stays **in its original position** in each window's prompt
(README: "`【全局】` 段保留在原始位置，不会集中提取" — `【全局】/[global]` markers are
stripped, not sent). Each window's prompt = globals in original order + one shot line
for the selected interval (`official`: `integrated_multimodal_description: [Shot 1] At
00:00.000, …`; `legacy`: `[0.0-5.0s] text`). **Ignores `total_frames` and
`chunk_frames` entirely**; total = Σ segment durations. Degradation: no time markers
found ⇒ falls back to global mode + `compute_chunks` chunking.

### 2.3 sequential / global

`sequential` splits the prompt into clauses (`。；;！!？?\n`), spreads them **uniformly**
across the video timeline (clause midpoints), chunks still by `compute_chunks`
(`chunk_frames` lives here); `【全局】` paragraphs are exempt and appended to every
window. `global` = the whole prompt for every segment. In both, the window prompt is
`compose_window_prompt` over `[win_start_sec, win_end_sec)`:

- a timeline segment is included when its overlap with the window is **≥ 25 % of the
  window duration**; if nothing qualifies, the segment covering the window midpoint
  (else nearest) is taken — a window is never left empty;
- times are re-rendered **relative to the window**;
- **clause-level granularity**: a long segment body is split into clauses which are
  laid uniformly over the segment's own span; only clauses whose midpoint falls in the
  window survive (`_filter_clauses_for_window`) — so a 30 s prompt chunk crossing a
  chunk boundary is split between windows at clause granularity;
- `official` composer routes by block title keywords: blocks containing 音/sound →
  `overall_soundscape:`; 配乐/music → `non_diegetic_music:`; everything else →
  `integrated_multimodal_description:` as `[Shot N] At MM:SS.mmm` lines. Global
  paragraphs are appended as prefix (before first timeline para) / suffix (after).

**Chunk-relative vs absolute, stated once:** all times the model ever sees are
**per-segment relative** (each segment starts at 0 / `00:00.000`), regardless of how
absolute the user's timeline looked. The only absolute→relative conversion is at
window composition. This matches the official `[Shot N] At` format per clip.

---

## 3. Mechanism 2 — per-segment reference filtering (the "no inheritance" rule)

`_filter_refs_for_prompt` (h3_sampler.py ≈L380) runs **per segment**, on the composed
window prompt:

- **Mention grammar** (`_REF_MENTION_RE`): `image1 / image 1 / picture1 / 图像1 /
  图片1 / 视频1 / audio 1 / 音频1` and native `<Picture N> / <Video N> / <Audio N>`
  (case-insensitive), with word-boundary guards on both sides.
- **`raw` format: no filtering at all** — everything is passed, prompt untouched.
- **No-mention ⇒ pass NOTHING** (`_filter_pictures_simple`, `_filter_video_audio`,
  `_filter_refs_official`). The code contains the old behavior commented out
  (`# if not mentions: return all_imgs, prompt`) — they deliberately inverted it to
  the strict rule. This is the enforcement of the README's "不写则不传": a segment that
  fails to re-declare `image1` gets no reference images at all (their README says this
  causes identity inconsistency — §5.2).
- **Renumbering**: passed refs are re-compacted to contiguous 1..k and the prompt's
  mention numbers are rewritten in one position-sorted pass (`_render_all_mentions`)
  — `official` renders `<Picture N>` tags, `legacy` rewrites just the digits in the
  original spelling. So the model only ever sees a dense 1..k numbering.
- **Video ⇄ soundtrack binding** (`_filter_video_audio`): audio slots are counted in
  one unified `<Audio N>` space — paired soundtracks first (in video order), standalone
  audios after. Referencing a video keeps its soundtrack alive; referencing a video's
  soundtrack keeps the **video** alive (kept-videos set unions both directions); a
  soundtrack cannot travel without its video.
- **`<Subject N>` indirection** (`_filter_refs_official`): definition lines starting
  `<Subject N>` that contain `<Picture M>` tags build a Subject→Pictures map (no
  positional assumption — one subject may come from several pictures). Mentions in the
  body expand through the map; definition lines of unreferenced subjects are deleted
  from the prompt; referenced-but-missing indices log a warning.
- **Slot budget**: `MAX_REF_SLOTS = 9`; the context-audio ref (§4.2) consumes one slot
  before user refs (`build_conditioning_payload`).
- **`ref_sync_mode=segmented`** (default): before filtering, each ref video/audio is
  **time-sliced to the segment's share of the total** (`_slice_ref_videos_for_segment`
  — pixel ratio slice, re-snapped to 17k+5, re-encoded) — "replace the person while
  keeping lip-sync" territory. `global` passes full material to every segment.
- CLIP side: pictures go to Qwen3-VL as `minimax_ref_items` images; videos as frames
  sampled at **2 fps** with 0.5-s-spaced timestamps (`build_conditioning_payload`);
  audio refs contribute only a type marker (no waveform to the text encoder).

**Why this matters to us:** the filter makes identity discipline *structural* — the
model literally cannot see a reference the prompt didn't declare for that segment.
Combined with the temporal-exclusivity rules (§5) this is a prompt-compiler contract,
not a convention.

---

## 4. Mechanism 3 — anchoring math (and how it compares to Motion-Context / loopforge)

The previous segment's tail enters the current segment through **three independent
channels**, then the overlap is trimmed off the output. `context_frames` (17n+5,
default 22) is the width of all of them.

### 4.1 Channel A — initial-latent splice + the `video_context_denoise` dial

`_make_h3_empty_latent` (h3_sampler.py ≈L1449): the segment's zero-latent is built as
`video [1,24,v_t,h,w] + audio [1,32,2,a_t]` (NestedTensor). If a head overlap exists
(previous segment's `samples` video latent, unpacked at ≈L880; or the `pre_guide`
latent for segment 0; a tail overlap exists for `post_guide` on the last segment):

```
video_latent[:, :, :head_tokens] = head_overlap_video[:, :, -head_tokens:]
head_tokens = min(video_latent_frames(context_frames), v_t - 2)
```

and a **noise_mask** is attached: all-ones video mask with the head tokens set to
`video_context_denoise` (audio mask = 0 only when audio-drive locks the source audio).
Sampling runs through ComfyUI's `denoise_mask` semantics:

- `video_context_denoise = 0` → head tokens are **frozen exactly** (mask 0 = no noise
  added, latent passes through sampling untouched) — the head is a bit-identical
  replay of the previous tail;
- `= 1` → head tokens fully regenerated (old behavior; recommended for second pass +
  SplitSigmas to avoid boundary artifacts);
- between → soft regional blend.

Output-side, `_merge_segment_latents` (≈L1860) concatenates segments **after trimming
`min(ctx_v_tokens, seg_tokens-2)` head tokens** from every non-first segment (audio:
`ctx_a = context_frames/fps*40` head tokens trimmed). So at vcd=0 the frozen replay is
discarded and the seam is a **latent splice** — mathematically invisible by
construction (same numbers the trim accounted for; `compute_seam_boundaries` exports
the pixel indices for the seam-correction node).

### 4.2 Channel B — cond-row motion keyframes; Channel C — untagged context audio

`h3_conditioning.build_conditioning_payload` (with `prev_segment = prev_x0_dict`):

- **B**: the previous tail's last `_latent_frames_for_pixel_frames(context_frames)`
  latent frames each become an individual keyframe `{"resolved_frame_index": pixel_idx,
  "latent": <1-frame latent>}` with `pixel_idx = _pixel_index_for_latent_frame(i)` —
  i.e. anchored at the **current segment's own opening coordinates** (0, 1, 5, 9, 13,
  …). They ride as `minimax_keyframes` → `cond_video_latents` in the packed sequence:
  **cond rows are never denoised** — pure conditioning. `h3_patches._patch_packed_layout`
  documents the position math: `cond_t = video_t0 + FRAME_RESCALE * pixel_index`, with
  `video_t0` shifted past ref spans (the t-origin bug they had to fix). Upstream
  ComfyUI now supports arbitrary keyframe indices natively; the patch self-disables.
- **C**: the previous tail's last `context_frames/fps*40` **audio latent tokens** are
  appended to `refs` as `{"kind": "audio"}` with **no corresponding
  `ref_items_for_clip` entry** — Qwen3-VL therefore inserts **no `<Audio j>` token**
  for it; the DiT still receives the audio latent in the cond stream. Their design
  claim (module docstring): the model reads it as "previous content", not "reference
  material". This consumes 1 of the 9 ref slots.
- User refs (from §3) go through `minimax_refs` → the same `cond_video_latents` list,
  **concatenated after** the keyframes (`h3_patches._patch_extra_conds`: stock
  ComfyUI overwrote one with the other; patched/newer ComfyUI concatenates — "续接
  keyframes 走 cond 通道（不被去噪，模型延续）; 用户 refs 走 ref 通道（模型模仿）").

### 4.3 Second pass, video_guide, audio_drive

- **Second pass** (latent_input connected): the merged first-pass latent is split back
  into per-segment latents (`_split_first_pass_latent`, the exact inverse of merge —
  heads rebuilt from the previous merged tail; token-count accounting validated, else
  falls back to first-pass behavior). Then per segment: `_copy_overlap_tail`
  overwrites the overlap head with **this run's own previous segment's samples**
  (rationale in code: the upscaled input latent is structurally imperfect; the run's
  own denoised output is the correct anchor) and `_with_locked_audio` sets the masks
  (head = vcd, audio = 0 when `lock_audio` ⇒ first-pass audio reused verbatim).
  Resolution comes from the input latent (width/height ignored); odd latent dims are
  replicate-padded (H3 patch_size (1,2,2)).
- **video_guide** (`none` default; `pre_guide` = continuation, `post_guide` =
  extrapolation backwards, `pre_post_guide` = bridge between two videos): the guide
  video's `context_frames` head/tail is cut, VAE-encoded once, and used as the
  head/tail overlap latent for the first/last segment (channel A with `ctx_frames`
  width); the ref-video slot itself is replaced by the short clip ("强行剪切为
  context_frames") and **still subject to mention filtering** (README: "参考引用逻辑
  与普通参考相同（提示词中声明了，才会引用）" — you must declare `video1` in the
  relevant segment for the ref-channel part to attach; the latent-fill part happens
  regardless). The guide video's audio is **nulled** in code (`vid_entry["audio"] =
  None`) — despite a leftover log line about merging guide audio into refs,
  `extra_ref_audios` is never appended to in v0.7.2.
- **audio_drive**: the drive waveform is resampled to the audio-VAE rate, sliced per
  segment (accounting for the overlap head), encoded, and **locked into the audio
  latent with mask 0**; the node returns the source waveform as the output audio and
  the video generates against it. `drive_audio` connected but `audio_drive` off logs
  a hint (their own UX nudge).

### 4.4 Comparison against our two reference implementations

From our own harvest (docs/research/h3-transitions-and-latent-continuity.md §Strategy A
+ E5 addendum):

| | Motion-Context | loopforge `handoff_mode=latent` | **AutoContext** |
|---|---|---|---|
| Previous tail enters as | **non-denoised rows in the denoising sequence** (pinned tail; frames "bit for bit" identical; no decode/re-encode round trip) | handoff frames **cut from the prior sampled latent** (anchor fidelity 20.2 dB vs 18.7 dB pixel; identity unmoved 0.791 vs 0.813 ArcFace) | **both at once**: cond-row keyframes (B ≈ MC's clean-context idea, but conditioning-only rows at segment-relative t) **plus** initial-latent head splice with a per-region denoise dial (A ≈ loopforge's latent cut, but *masked*, not fixed) |
| Hard seam guarantee | pinned rows are preserved exactly | latent handoff preserves anchor exactly | at vcd=0 head tokens frozen by mask, then **trimmed on output** — the seam is a splice; the dial interpolates between splice and full regeneration |
| Audio continuity | — | — | **untagged context-audio ref** (C) — "previous content" without an `<Audio>` token; plus (library-only, see gap below) cosine crossfade |
| New-content risk | — | — | identical physics to our E5 raw-latent arm: pins drag content back to the source scene |

**Code-vs-README gap worth recording:** the README advertises "段间音频平滑淡化"
(inter-segment audio crossfade). It exists (`_crossfade_audio`, cosine 2 048-sample
overlap aligned to `context_frames`) **but runs only in the `decode_output=True` path,
which `nodes.py` hard-codes to `False`**. The shipped node returns the merged latent,
whose audio join is a **hard latent-domain concatenation** at the trim point — audio
continuity rests entirely on channel C conditioning. (Our E6 measured single-pass
multi-shot audio 4–20× smoother than hard-cut concat — the latent join here is
conditioned, not silent, but the advertised crossfade is unreachable from the node.)

Also note: channel A copies from the previous segment's `samples` (`all_segments`),
while the conditioning payload receives `prev_x0` (the x0 preview output) — the two
are the same generation but different tensors (x0 is `process_latent_out`-scaled);
harmless, but worth knowing when reading logs.

---

## 5. The temporal-exclusivity principle — verbatim rules (translated)

README §"提示词注意事项（节点的局限性）" — the prompt-discipline contract that feeds
our prompt assistant and Director Suite compiler. Translation is ours, faithful to the
original; the scope note first:

> The following caveats do NOT apply to simple, always-valid prompt scenarios (all
> segments share one prompt, `global` mode) — e.g. a talking digital human (lines
> still need segmenting), videos with little shot/composition change, or
> character-replacement videos where one prompt covers everything.

### 5.1 Core principle 1 — temporal exclusivity (时序排他性)

> When using segmented inference (chunking), strictly follow the **temporal
> exclusivity** principle — each segment's prompt may only describe what is
> "happening now" in that segment, as **new changes relative to the end of the
> previous segment**.
>
> - **Segmentation is a relay**: when segment N is generated, its starting visual
>   state (positions, pose, camera) is supplied entirely and implicitly by the
>   "anchor frames (Context Frames)" at the end of segment N−1. You do NOT repeat
>   that starting state in the prompt.
> - **No retelling, no overlap**: segment N's prompt must NEVER re-describe an action
>   or camera move already completed in segment N−1. If you do, the instruction
>   conflicts with what the anchor frames show (instruction conflict), causing
>   stuttering, broken motion logic, or repeated actions.
> - **Boundary zeroing**: when switching segments, zero out the previous segment's
>   "ongoing action". The new segment's prompt should read like "a new instruction
>   after pressing the shutter", covering only the displacement, actions, or new
>   elements inside the new time window.

**Their worked example (❌ conflict overlap):**

```text
段1：3秒
"物体 A 向位置 B 移动"            (Object A moves toward position B)
段2：3-6秒
"物体 A 移动到位置 B 后，正在位置 B 转身"   (After moving to B, object A turns around at B)
```

> Why it fails: at the end of segment 1 the anchor frame already shows A arrived at B
> and just settled. Segment 2's prompt demands "A moves to B" again — conflicting with
> the anchor's settled result; the model tries to "re-move", producing ghosting or
> frame skipping.

**✅ seamless progression:**

```text
段1：3秒
"物体 A 向位置 B 移动，并最终停在位置 B"   (Object A moves toward B and finally stops at B — close the action loop)
段2：3-6秒
"站稳后，物体 A 缓慢转动方向"          (Having settled, object A slowly turns — describe only the new action)
```

> Correct logic: segment 2 completely drops the "moving" process, treats "stopped at
> B" as an established fact, and describes only the new "turning" action — then the
> model can continue from the anchor frame perfectly.

> **One-line summary**: the previous segment's end is the *result*; the next segment's
> beginning is *the new action after that result*. Never write the process that led to
> the result into the next segment.

### 5.2 Core principle 2 — per-segment reference declaration (逐段引用声明)

> When using segmented inference with reference images/videos (image1, video1, …),
> strictly follow **per-segment reference declaration** — every segment's prompt must
> independently and completely declare ALL reference material that segment needs.
> References are NOT "remembered" or "inherited" into the next segment (only
> referenced material participates in the current segment's inference).
>
> - **No global memory**: the node parses the reference tags written inside the
>   current segment's prompt to decide exactly which material that segment needs.
>   Segment N−1 mentioning image1 only means segment N−1 used it; segment N is
>   re-scanned from scratch.
> - **Not written ⇒ not passed**: if segment N doesn't mention image1 again, that
>   reference image is not delivered to segment N — causing character/object
>   inconsistency.

**❌ implicit inheritance:** `段1: image1 是物体A，物体A正在向前移动。` /
`段2: 物体A停下，转身看向镜头。` (no image1 written)
**✅ explicit per segment:** identical, but 段2 reads `image1 是物体A，物体A停下，
转身看向镜头。`

### 5.3 What the code adds beyond the README

- The "not written ⇒ not passed" rule is **enforced**, not advisory (§3) — and since
  numbering is re-compacted 1..k per segment, a forgotten declaration fails loudly
  (identity drift), not subtly (wrong index).
- `raw` prompt_format **disables** filtering entirely — a footgun the assistant should
  warn about (declare refs, or accept全传).
- The ≥ 25 %-overlap / clause-midpoint windowing (§2.3) means a long narrative clause
  straddling a boundary gets **split mid-story** — the compiler should keep beat
  boundaries aligned with segment boundaries (Clip_Tag does this by construction).

---

## 6. Quality claims vs our measured physics

Their claims (README, translated) → our evidence (E5 handoff triangle + E6, tranche 2,
docs/research/h3-transitions-and-latent-continuity.md Addendum 2):

| Their claim | Our verdict |
|---|---|
| "非首段自动接力上一段结尾画面 … 消除接缝处的停顿或位置跳变" (non-first segments relay the previous ending; eliminates seam pauses/jumps) | **Supported.** At vcd=0 this is our E5 raw-latent-handoff arm: invisible seams, 39–42 dB pinned rows. The splice is exact by construction (mask freeze + trim). |
| "上一段结尾作为运动参考传给当前段，帮助延续运动方向与速度" (tail as motion reference continues direction/speed) | **Plausible, double-edged.** Cond keyframes give the model a true motion sequence (better than a single last frame). But E5: the stronger the pin, the more new content drags back to the source scene (the 39-frame pin lost the hallway beat entirely). Their own temporal-exclusivity rules (§5.1) are the prompt-side mitigation — content drag is the failure mode the rules exist for. Default `context_frames=22` matches our chain guidance (22f default, 39f only when audio phase-exactness matters). |
| Identity/character consistency across segments | **Doubtful as a mechanism, solved as a discipline.** E5/E6: identity dies first in anchored chains (ref_video arm 0.12 ArcFace; multi-shot identity weak in both regimes) — anchoring does NOT carry identity. AutoContext's per-segment ref re-declaration (§5.2) is exactly the E6 conclusion "identity payloads matter more, not less, in chains", made structural by the filter. |
| "上一段音频也作为'之前的内容'传入，帮助声音自然延续" (previous audio passed as prior content) | **Novel mechanism, untested by us.** The untagged context-audio ref (no `<Audio>` token) is a genuinely new lever vs MC/loopforge. Caveat: the advertised crossfade is unreachable from the node (§4.4 gap) — the latent join is conditioned-but-hard. |
| Seam-correction node fixes residual seams | Out of scope here (pixel domain: per-channel luma gain presets, MKL color transfer at `high`, whole-film normalization at `max`, GPU optical-flow warp+fusion presets, flash temporal fusion, PySceneDetect cut detection, 0–8-frame blend ramp). Treat as a **post tool**, not a continuity mechanism — their own README: "只做画面接缝修正，无法修复二采上游产生的伪影". |
| "段间音频平滑淡化" (audio crossfade between segments) | **Overstated for the shipped node** — see §4.4 gap. |

---

## 7. Catalog entry (proposed rows — lead to land them; this doc creates no code)

**`ENGINE_NODE_PACKS` (server/engineNodes.ts) — new row:**

```ts
{
  id: 'autocontext',
  name: 'ComfyUI_MinimaxH3_AutoContext',
  description: 'supElement’s one-click segmented-inference pack for MiniMax H3: '
    + 'prompt-timeline slicing (Clip_Tag/timeline/sequential/global), per-segment reference '
    + 'filtering (only prompt-declared refs are passed), 3-channel inter-segment anchoring '
    + '(initial-latent splice + video_context_denoise dial, cond-row motion keyframes, '
    + 'untagged context-audio ref), hash-keyed per-segment latent cache with resume, '
    + 'video_guide bridging, audio_drive, and a pixel-domain seam-correction node. '
    + 'Deep-read: docs/research/autocontext-deepread.md.',
  repoUrl: 'https://github.com/supElement/ComfyUI_MinimaxH3_AutoContext',
  pinnedRevision: 'f1062d34e3c25ef421b2aadeb69f2d21831d1625',
  licenseSpdx: 'Apache-2.0',
  licenseNote: 'Apache-2.0 (LICENSE file read from a fresh fetch, 2026-09-16; template '
    + 'copyright line only). Permissive: vendor-eligible, user-fetch until a vendoring '
    + 'increment is wanted.',
  installMode: 'user-fetch',
  homepage: 'https://github.com/supElement/ComfyUI_MinimaxH3_AutoContext',
}
```

plus `nodePackEntry('autocontext')` in `FETCH_CATALOG` (server/fetchCatalog.ts) — the
catalog row is single-sourced from the pack registry (the integrity test's invariant).

**LICENSES.md §3 row (if it stays user-fetch-only):**

| Component | Pin | SPDX | Why user-fetch | Obligations | Status |
| --- | --- | --- | --- | --- | --- |
| supElement/ComfyUI_MinimaxH3_AutoContext | `f1062d34e3c25ef421b2aadeb69f2d21831d1625` `[API-2026-09-16]` | **Apache-2.0** (LICENSE file, fresh fetch) | not a license reason — permissive, simply not vendored yet; segmented-inference pack, deep-read committed | notice when vendored | fetchable; **candidate for vendoring** (Apache-2.0, 14 files, no weights) |

Pin note: `pinnedRevision` is a 40-hex SHA ⇒ the fetch engine treats it as a fixed sha
(no branch resolution needed); repo history shows "Add files via upload" commits, so a
sha pin (not branch) is the right posture. Version at pin: 0.7.2.

**Benchmark candidacy (record only — drift/E5 comparison is queued separately):**
AutoContext is the natural *engine* arm for a long-horizon drift experiment: its
vcd dial (0 / 0.3–0.5 / 1.0) exposes exactly the E5 pin-strength axis on one knob,
per-segment, with hash-resume to make multi-condition ladders cheap to rerun. Candidate
suite: N-segment chain at vcd ∈ {0, 0.5, 1} × refs re-declared vs omitted, measuring
seam anchor dB (their `compute_seam_boundaries` gives the frame indices), ArcFace
identity per hop, and content-drag (does beat N survive). Not scheduled here.

---

## 8. Adoption notes — what our graph factory takes regardless

1. **Per-segment reference filtering with no inheritance (adopt as-is).** Make
   reference delivery a function of the *segment's* declared mentions: parse mentions
   from each segment prompt, pass only those, renumber 1..k, bind video⇄soundtrack,
   warn on missing indices. This turns our E6 finding ("identity payloads matter more
   in chains") into an enforced contract, and it composes with RefMod identity
   payloads (declare the persona per segment; the compiler attaches it). Keep a
   documented escape hatch (their `raw`) for power users.
2. **Temporal-exclusivity rules into the prompt assistant + Director Suite compiler
   (adopt verbatim).** (a) Lint: flag segment N prompts that re-describe actions the
   segment N−1 prompt already completed (retelling/overlap); suggest "closed-loop"
   phrasing for the earlier segment ("…and finally stops at B") and "new action after
   the result" phrasing for the next. (b) Compile: the Director Suite emits per-segment
   *deltas* over the previous segment's end state, never absolute restatements, and
   re-emits the full reference declaration block per segment. (c) UI affordance: show
   "anchor carries: position/pose/camera from previous end" so users stop writing it.
3. **Hash-based resume semantics for chain reruns (adopt with one closing fix).**
   Their scheme: per-segment artifact keyed on `(window_prompt_hash, conditions_hash,
   sampler meta, seg accounting)`; on any sensitive-key mismatch the stale artifact is
   deleted; the **first miss sets a run-local `force_regenerate` that rebuilds every
   later segment** ("prompt-change position determines reuse"); second-pass nodes
   inherit an `upstream_global_hash` + per-segment `segment_fingerprints` chain via the
   `info` output so downstream nodes invalidate when the first pass changed. Adopt the
   position-determined invalidation + the info-chain. **Fix before adopting:** the
   first-pass chain is *not* hash-chained across runs — a revert-style edit (segment 2
   prompt changed, later reverted) leaves later segments' meta identical, so a later
   run can load a cached segment anchored to the *other* branch of segment 2 (stale
   splice at the seam). Include each segment's predecessor fingerprint in the next
   segment's cache key and the gap closes. Also: their `conditions_hash` samples only
   the first 8×8 corner pixels of each ref (`pixel[0, :8, :8, :3]`) — cheap but
   false-negative on edits that miss the corner; sample several crops or hash the
   full (downsampled) tensor.
4. **The `video_context_denoise` dial (adopt the primitive).** A per-region noise mask
   on the anchor head is the cheap lever between "exact splice" and "free
   regeneration" — our E5 ran the endpoints; the dial gives the middle (their own
   second-pass guidance: 1.0 with SplitSigmas, 0.3–0.5 as compromise, 0 default for
   first pass). We already run the nested video+audio noise-mask shim from tranche 2 —
   expose it as a knob on our chain node, default 0, with the SplitSigmas caveat
   documented.
5. **Untagged context-audio ref (adopt; cheap).** Passing the previous tail's audio
   latent as a ref-slot entry *without* a corresponding `<Audio>` token ("previous
   content", not "reference material") is one line in our payload builder and the only
   audio-continuity lever that survives the latent-merge path. Keep 22f default / 39f
   when audio phase matters (our own E5 chain guidance).
6. **Phase-conserving trim accounting (we mostly have it; steal the boundary
   exporter).** `n_i = min(ctx_v_tokens, seg_tokens−2)` head-trim + the
   token→pixel seam-index export (`compute_seam_boundaries`) is exactly what our
   per-join QC (seam level step, correlation) needs as input — emit seam frame
   indices from the chain runner the same way.
7. **Do NOT adopt:** the pixel-path audio crossfade positioning (unreachable in their
   own node — if we crossfade audio, do it in the latent-merge or in our muxer where
   it actually runs); `raw`-format "no filtering" as a default anywhere; their
   dead `extra_ref_audios` guide-audio merge (v0.7.2 nulls guide audio instead).

---

## 9. Sources

- Upstream code @ `f1062d34e3c25ef421b2aadeb69f2d21831d1625`: `nodes.py`,
  `h3_sampler.py`, `h3_utils.py`, `h3_conditioning.py`, `latent_cache.py`,
  `h3_patches.py`, `seam_correction.py`, `pyproject.toml` (read in full or in
  targeted ranges via the code index; LICENSE fetched raw).
- Upstream README.md (Chinese, full) — prompt-discipline section translated in §5.
- Ours: docs/research/h3-transitions-and-latent-continuity.md (§Strategy A, Addendum 2
  = E5/E6 measured), docs/architecture.md §Third-party components & the user-fetch
  pattern, docs/LICENSES.md §3, server/engineNodes.ts + server/fetchCatalog.ts
  (registry/catalog row shapes).
