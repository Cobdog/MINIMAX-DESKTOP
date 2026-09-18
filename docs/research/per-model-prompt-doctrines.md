# Per-model prompt doctrines — inference contracts and the captioning rules they dictate

> Compiled 2026-09-18 (Flux task `6niii1p`, lane 2). Question: for each model family the harness will caption for — **Anima, FLUX.2 Klein, Krea 2, MiniMax-H3** — what is the inference-time prompt contract (structure, vocabulary, length/density norms, known failure phrasings), and what captioning doctrine does that contract dictate? The H3 doctrine in [h3-lora-training-guide.md](h3-lora-training-guide.md) §4 is the FORMAT PRECEDENT; this doc extends that pattern to the other three families and closes with the cross-model spine/extensions split that shapes the harness's pass taxonomy.
>
> Method: Anima + Klein harvested from the web (official model cards/docs, BFL's prompting guide, vendor blog posts, community model cards, HF discussion #96); Krea 2 harvested from the maintainer's local source of truth (`/home/agent/work/VS Proj/Kreatine` — the two-stage sampler node pack, its core encode/weighting code, and its reference docs — NOT the web); H3 GAP-CHECKED ONLY against the held library captures and the training guide (no re-research, per lane scope). Weight anchors verified on disk against `/home/agent/models/MANIFEST.md`. **Constraint disclosure:** the session's WebSearch budget was exhausted mid-harvest; all web facts below were obtained by direct-URL fetches of known sources (no search-result discovery), and anything unreachable is tagged honestly. Tags: **[DOC]** verified in shipped code / official source, **[COMM]** reputable community claim, **[SPEC]** plausible-unverified, **[UNK]** nobody knows.
>
> **DUAL-USE flag (applies to every doctrine section below):** these doctrines are consumed by (a) the captioning harness — the perceive-once VLM pass, ground-truth writing, and the per-model verification/scoring passes, and (b) the Studio's own prompt surfaces — `server/llm/fragments.ts` output_format rows and `server/llm/index.ts` `DEFAULT_CAPTION_INSTRUCTION`. Each section names its Studio consumers so both sides cite one source.

---

## 1. Anima — the one model where tag-pile captions are native

**Weight anchors (Studio-shipped variant):** `diffusion_models/anima-base-v1.0.safetensors` (4.18 GB, sha256 `bd43b7cf…`) + TE `text_encoders/qwen_3_06b_base.safetensors` (Qwen3-0.6B) + VAE `vae/qwen_image_vae.safetensors` (shared with Krea 2) [DOC — local MANIFEST]. These arrive as linked weights on disk, not `fetchCatalog.ts` entries — the registry must anchor them by manifest row, not catalog.

### 1.1 Inference-time prompt contract

- **Hybrid prompting is the native distribution.** Anima was trained on Danbooru-style tags, natural language, AND mixes of the two (random tag dropout during training) — the official card and community consensus agree that tags, prose, and interleaved mixes all work [DOC model card, COMM]. This is the structural opposite of the other three families.
- **Tag grammar:** lowercase tags separated by spaces (never underscores); conventional order `[quality/meta/safety] → [1girl/1boy subject count] → [character] → [series] → [artist] → [general descriptors]`; artist styles take an `@artist` prefix [DOC card + ComfyUI docs].
- **Quality/meta prefix:** `masterpiece, best quality, score_7, safe,` is the recommended default prefix; quality tags are effective but optional — omitting them risks style blending in small LoRAs but is survivable [COMM — HF discussion #96].
- **Natural-language mode:** "at least 2 sentences", up to ~300 words (~1k TE tokens), **English only** — beyond that, adherence degrades [DOC card].
- **Weighting:** `(term:weight)` syntax exists but needs **higher values than SDXL** (e.g. `(chibi:2)`) to have visible effect [DOC card].
- **Negative prompt is a first-class mechanism** (unlike H3/Krea-2-turbo): the shipped default is `worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration` [DOC card].
- **Sampling:** 512²–1536²; Base 30–50 steps @ CFG 4–5 with the `er_sde` sampler as default; Turbo CFG 1 @ 8–12 steps [DOC card + ComfyUI template defaults].
- **Known failure phrasings:** vague/short prompts produce undesired content (the card's own warning); photorealism requests fight the base (no realism capability); long text past ~300 words drops details; underscored tags are out-of-distribution [DOC card, COMM].

### 1.2 Derived captioning doctrine (DUAL-USE)

Format precedent: H3 guide §4.1 — "caption the way the model is prompted" — originated in the Anima community itself (discussion #96: *"In general, caption the way the model is prompted. Dan, natural, mixes of those all work."* [COMM]). For Anima that sentence inverts the other families' rule:

1. **Tag captions are correct here and only here.** Danbooru-order tag piles, lowercase, spaces, with the trigger/`@artist` token first, are the native caption format. The harness's "no tag soup" rule (correct for H3/Klein/Krea 2) MUST NOT be applied to Anima datasets.
2. **Mixed captions are equally valid** and arguably the best ground truth: NL sentence(s) carrying subject/action/setting + a tag tail for count/style/meta — mirrors the training mixture. Offer both presets; keep the choice consistent within one dataset.
3. **Length/density norm:** tag mode — a full danbooru-style tag set (tens of tags); NL mode — 2+ sentences, hard cap ~300 words, English. Over-long JoyCaption-style monologues are wrong for Anima twice over (TE cap + distribution mismatch).
4. **Trigger doctrine identical to H3 §4.3:** one stable token per repeating concept, prepended exactly once; character LoRAs get trigger + generic subject token (`<trigger>, 1girl`) — **appearance words never in captions** (they re-enter at inference). Community captioning practice on #96 matches the H3 character template to the letter [COMM].
5. **Positive-only phrasing:** although Anima HAS a real negative prompt at inference, captions still describe what IS present — the negative vocabulary (`worst quality, …`) belongs in the inference-side fragment, never in training captions.
6. **Fast-learner caution:** Anima LoRAs visibly improve within ~500 steps [COMM #96] — caption errors compound quickly; a caption QA pass matters more per-step here than on slower models.
7. **Community captioning-stack corroboration:** the working community flow is brief VLM prompt + image + tagger output fed to a mid-size LLM (Qwen3.5-35B-A3B/9B class) [COMM #92/#96] — structurally the same perceive-once → refine chain this harness formalizes. Anima captions conventionally blend tagger tags with VLM prose.

**Studio consumers:** `fragments.ts` has **no `anima` output_format row today** — the composer falls through to the generic prose row, which is wrong for tag-mode prompting. Gap flagged for the fragments registry: an `OF_ANIMA` row mirroring §1.1 (tags or tags+prose mix, danbooru order, quality prefix optional). `DEFAULT_CAPTION_INSTRUCTION` likewise needs the Anima branch of §1.2.

---

## 2. FLUX.2 Klein — BFL slot order, edit imperative, and the shipped "True" de-distill

**Weight anchors:** the Studio ships `diffusion_models/Flux2-Klein-9B-True-fp8.safetensors` (9,078,604,368 B, sha256 `4de8509e…`) with TE `text_encoders/qwen3-8b.safetensors` (16.4 GB) and the flux-family VAE [DOC — local MANIFEST]. **Provenance pinned this pass:** the file byte-matches `Flux2-Klein-9B-True-fp8.safetensors` in `wikeeyang/Flux2-Klein-9B-True-V1` on HF (checked V1/V2/V3 trees; only V1 carries that exact file) — i.e. a community **de-distilled full fine-tune** of the official klein-9B, NOT a BFL release. Its model card: cfg 1.0, 20–30 steps T2I / 10–25 steps edit-inpaint, euler/simple (or any), optional turbo/distill LoRA at 8–12 steps; "undistilled, clearer, more realistic, more precise editing"; FLUX Non-Commercial license inherited [COMM model card]. The registry must record it as wikeeyang-True-V1-fp8, not "official klein".

### 2.1 Inference-time prompt contract

- **Official family shape:** 4B/9B rectified-flow transformers, each as **base** (undistilled, 50 steps — the fine-tuning/LoRA variant) and **distilled** (4 steps, guidance 1.0, sub-second); T2I and single/multi-reference editing unified in one model [DOC BFL card + ComfyUI blog]. Official card's own limitation line: *"Prompt following is heavily influenced by the prompting style."* [DOC].
- **Text encoder:** Qwen3-family LLM — klein 4B uses Qwen3-4B (hidden states from layers 9/18/27 [COMM — geronimo7 medium, HF flux-2 blog]); **klein 9B uses Qwen3-8B** [DOC official card "8B Qwen3 text embedder"; COMM Comfy-Org `qwen_3_8b` packaging; disk anchor confirms]. NOT Mistral (that is FLUX.2 Dev/Max). *Correction vs [speed-quality-and-imagegen-paths.md](speed-quality-and-imagegen-paths.md) §3.3, which stated Qwen3-4B flatly — true only for the 4B.*
- **Style — BFL's official prompting guide [DOC]:** prompts "work best when your prompt reads like a clear description of the image"; full natural-language sentences; no keyword/booru guidance anywhere. The slot template, verbatim: `[SUBJECT], [LOCATION], [STYLE], [CAMERA SETTINGS], [LIGHTING], [COLORS], [EFFECT], [ADDITIONAL ELEMENTS]` — "a useful starting structure, not a strict formula". Examples lead with the subject or camera framing, then setting/style/lighting.
- **Length:** no hard limit; short prompts work ("a chromatic 3D rendition of a cursor, black background"); quality comes from iteration — "adjust one important detail at a time" [DOC guide].
- **Text rendering:** put exact wording in quotation marks so it renders as visible text rather than scene description [DOC guide]. Card limitation: rendered text "may be inaccurate or subject to distortion" [DOC].
- **Language:** multilingual accepted; English "tends to produce the most precise results" [DOC guide].
- **Edit prompting [DOC — BFL editing guide, verbatim examples]:** *"Be specific about what changes and explicit about what should stay the same."* Good: "Change the shirt color to red", "Add snow to the scene, keep everything else unchanged", "Replace the background with a sunset beach". Bad (vague quality requests): "Make it better", "Improve the lighting", "Fix the image". Both imperative ("Remove all of the sprinkles…") and declarative ("The butterfly is now made of shiny silver") work; retention clauses name what stays ("keeping the same pose", "Change nothing else"); region targeting is purely textual ("in the right-most jar", "on the top polaroid"); hex colors and material/fabric preservation clauses are used in rich prompts.
- **Multi-reference prompting [DOC]:** references addressed by index — "Use Image 2 as the location. Insert only the ice skates from Image 1…", with "only" constraining what is taken from a reference; klein supports up to 4 reference images.
- **Failure phrasings:** vague quality directives (the bad list above); style-mismatched prompting (the card's own warning); distorted rendered text; on the shipped True-V1: too-few steps (it is de-distilled — 4-step distilled-model defaults produce detail collapse; use the card's 20–30 steps) [COMM card].

### 2.2 Derived captioning doctrine (DUAL-USE)

1. **Caption in BFL slot order.** One English paragraph: subject first, then location, style, camera/lighting, colors/effects — the model's own prompt skeleton. Prose only; Qwen3 LLM encoder means tag piles are out-of-distribution (the Anima exception does not extend here).
2. **Length/density norm:** mid-density single paragraph (H3 §4.5's verdict carries over — caption tokens are a rounding error; quality/consistency is the constraint). Scale detail to what must be preserved vs. learned, mirroring the edit guide's rule.
3. **Quote visible text.** Any text rendered in the training image is captioned in quotation marks (the guide's text-rendering rule) — a concrete, checkable caption convention unique to this family so far.
4. **Edit-LoRA datasets caption in edit grammar.** Klein's distinctive duty is editing; a LoRA that teaches an edit concept should be trained on captions phrased like edit prompts — imperative naming the concrete change + explicit retention clause ("Add X, keep everything else unchanged"), never vague quality language. The negative-example list from §2.1 doubles as the harness's edit-caption lint.
5. **Multi-reference datasets use index phrasing.** Captions for reference-conditioned rows address references as `Image 1/2/3` in connection order with "only"-style constraints — matching the reference-encode convention (this is the Klein analogue of H3's `<Picture N>` labels and Krea 2's `Picture {i}:` markers; all three families independently converged on indexed references — a spine fact).
6. **Positive-only phrasing**, as everywhere: describe what is present; suppression belongs to inference-side tooling, not captions.
7. **Base/distilled split discipline:** LoRA training belongs on the undistilled base (or the shipped True de-distill, which restores the base regime at 20–30 steps); the 4-step distilled checkpoint is the inference accelerator — same TRAIN-on-base/RUN-on-distilled shape as Krea 2's Raw/Turbo rule.

**Studio consumers:** the existing `OF_FLUX_KLEIN` row ("masked edit… describe the intended result in natural language, focused on what the edited area should become") is consistent with §2.1's doctrine and can cite it; the row could gain the retention-clause + text-targeting hints. `DEFAULT_CAPTION_INSTRUCTION` needs the Klein branch of §2.2 (slot order, quoted text, edit grammar for edit datasets).

---

## 3. Krea 2 — the captioner-framed encoder and the two-stage contract

**Sources:** the maintainer's local truth (`/home/agent/work/VS Proj/Kreatine`: ComfyUI-Kreatine node pack README, `core/edit_encode.py`, `core/weighting.py`, `docs/reference/{prompt-routing,krea2-model,two-stage-sampling}.md`) — all [DOC-local]. Weight anchors: krea2 fp8/int8 DiT + `qwen3vl_4b` TE + `qwen_image_vae` [DOC local MANIFEST + comfy docs].

### 3.1 Inference-time prompt contract

- **The TE is literally prompted as a captioner.** ComfyUI core's `KREA2_TEMPLATE` (krea2.py:20) wraps every prompt in a system frame: *"Describe the image by detailing the color, shape, size, texture, quantity, text, spatial relationships of the objects and background:"* — the Qwen3-VL-4B encoder consumes image-description-shaped language by construction. Flowing descriptive prose at length is the native distribution (exactly what the Studio's `OF_KREA2` row already instructs).
- **Two-stage sampler (Kreatine):** stage 1 **Raw** (cfg 4.0–4.5 ↔ Krea guidance 3–3.5, classical negative-prompt authority, **weighting disabled** — the tokenizer runs `disable_weights=True`) decides composition, framing, subject count, and broad style in the top ~8% of sigma; stage 2 **turbo** (cfg exactly 1.0, no uncond branch) carries per-token weighting via `(term:-n)` sign-flip attention scaling. Negatives: **FLATTEN** (comma-merge, no syntax) stage 1, **SAFETYNET-wrap** stage 2.
- **Syntax rules:** `(term:weight)` parsed in stage 2 only; `#` starts a comment (stripped before encode) except `\#` escapes and `#rrggbb` hex colors; `#rrggbb` literals are meaningful color vocabulary.
- **Length norms:** Raw prompts ≤ ~1k tokens; Turbo 1k–2k.
- **Geometry/schedule:** dims multiples of 16; euler + `simple` IS the official schedule; turbo mu fixed at 1.15; ComfyUI cfg = Krea guidance + 1.
- **References:** encoded as `Picture {i}: <|vision_start|>…` marker blocks (VL budget 384×384 per image, reference latents ≤1024×1024); two incompatible encode recipes — `index_timestep_zero` (style-reference LoRA) vs `index` real-timestep (identity-edit LoRAs) — a per-LoRA property, never a global.
- **TRAIN on Raw, RUN on Turbo** (distilled checkpoints collapse seed diversity; Raw carries the real negative authority).
- **Failure phrasings:** expecting stage-1 to honor weights (it cannot — flatten your syntax or route to stage 2); negation phrased in the positive prompt instead of the negative channel; relying on `#` annotations surviving (they are stripped); oversized reference expectations beyond the 384²/1024² budgets.

### 3.2 Derived captioning doctrine (DUAL-USE)

1. **The TE's own system prompt is the caption skeleton.** The canonical Krea 2 caption enumerates exactly: **color, shape, size, texture, quantity, text (quoted), spatial relationships — of the objects and the background.** The harness's perceive-once VLM pass can mirror this list verbatim; it is the model's own asking. `OF_KREA2` ("subject, action, composition, environment, lighting, materials, and mood — at length") is the prose superset of it; both are held.
2. **Length/density norm:** flowing prose at length, ≤ ~1k tokens (the Raw prompt budget — captions longer than the model can be prompted with are wasted at best).
3. **Syntax scrubbing — unique to this family:** captions must never carry `(term:weight)` weighting or `#` comment syntax (both are inference-channel controls; `#` text would be silently stripped by the very encoder consuming the caption). A lint pass strips/dereferences both; hex colors ARE legitimate vocabulary.
4. **Reference rows use `Picture {i}:` phrasing** when captioning reference-conditioned pairs (the local convention, same spine as Klein's Image-N and H3's `<Picture N>`).
5. **Positive-only phrasing** (Krea 2 has a real negative channel at stage 1 — suppression vocabulary belongs there, not in captions).
6. **Two-stage asymmetry does NOT fork the caption format:** both stages share one prompt string; captions are stage-agnostic. But ground-truth writing should assume the Raw budget (≤1k) since that is the constraining channel.

**Studio consumers:** `OF_KREA2` already encodes §3.2's prose stance (this doc is its citable backing); `DEFAULT_CAPTION_INSTRUCTION` gets the Krea 2 branch (captioner-skeleton enumeration + syntax-scrub rule).

---

## 4. H3 — gap-check against the held doctrine (no re-research)

H3's doctrine stands as written in [h3-lora-training-guide.md](h3-lora-training-guide.md) §4 (format precedent for this whole doc), backed by the library captures ([../library/minimax-h3-prompt-guide-base.md](../library/minimax-h3-prompt-guide-base.md) style words + camera triplet; [-ref.md](../library/minimax-h3-prompt-guide-ref.md) six-section format). The gap-check against this pass's other three harvests found **two gaps worth recording and zero contradictions**:

- **GAP 1 — stills-vs-clips caption depth is thin in §4.** The §4.4 templates are clip-centric (motion phrase, camera verb triplet, soundscape clause). For the image-workbench's stills lane (one-frame training, musubi `--one_frame` / DiffSynX single-image rows), the doctrine needs the explicit per-sample rule: **motion and audio fields appear only when frames > 1 / audio is present; a still caption drops the motion phrase and soundscape clause and keeps style word, subject/action, setting, lighting, camera framing.** The §4.6 implications already hint at this (musubi's images-state-absence-of-sound rule); it should be stated as a caption-format branch, not a footnote.
- **GAP 2 — empty-negative training dictates positive-only phrasing, and §4 never says so explicitly.** DiffSynX trains with `negative_prompt=" "` [DOC]; captions therefore must phrase everything positively — describe what IS present, never "no X"/"without X" negation (a negated term in a caption teaches the term). This rule is load-bearing for the VLM caption prompt's negative-rules layer and for the harness's caption lint; it also generalizes — the other three families' doctrines in this doc adopt it (§1.2.5, §2.2.6, §3.2.5) because positive-only captions are harmless where negatives exist and mandatory where they don't.
- **Held, unchanged:** official style-word vocabulary (Cinematic, live-action, 2D-animated, 3D CG, claymation, watercolor, vintage film…), camera triplet (Motion Type + Amplitude + Speed), trigger-first doctrine, appearance-never-in-character-captions, ~1.4% caption token share, "caption pass sets peak quality", mid-density single paragraph as the LoRA caption format (six-section format only where the trainer wraps it). Cross-corroboration from this pass: Anima's community independently arrived at the same trigger/appearance rules; Klein and Krea 2 corroborate positive-only prose and indexed references.

**Studio consumers:** `OF_MINIMAX_H3` and the H3 role rows already implement the official contract; the two gaps above feed `DEFAULT_CAPTION_INSTRUCTION`'s H3 branch (positive-only + stills/clip branch).

---

## 5. Cross-model comparison — the spine and the extensions

### 5.1 Common spine (every family — these become the harness's model-agnostic passes)

| # | Spine rule | Grounding |
|---|---|---|
| 1 | **Caption the way the model is prompted** — caption format must match the inference-prompt distribution of the target model | all four lanes; phrase origin Anima #96 |
| 2 | **English** (most precise for every family; mandatory for Anima NL) | BFL guide, Anima card |
| 3 | **Trigger/token first, exactly once** for what repeats; describe what varies per-sample | H3 §4.3, Anima #96, universal |
| 4 | **Appearance never in character/identity captions** — identity flows through the trigger/reference; descriptors re-enter at inference | H3 subject-ref, Anima character practice, Klein/Krea 2 identity-reference recipes |
| 5 | **Positive-only phrasing** — describe what is present; negation teaches the negated term (mandatory for H3's empty-negative training; adopted universally) | H3 GAP 2; adopted §1–3 |
| 6 | **Caption quality/consistency sets peak quality**; token budget is a rounding error everywhere measured | H3 §4.5, Anima fast-learner note |
| 7 | **Every item captioned** — uncaptioned rows train against an empty prompt and weaken the run | H3 §4.6 (Inline); universal |
| 8 | **Indexed references** — multi-reference conditioning is addressed by index in all three families that have it (`Image N` / `Picture {i}:` / `<Picture N>`), in connection order | Klein guide, Kreatine encode, H3 ref guide |

### 5.2 Per-model extensions (these become per-model pass modules)

| Family | Format | Length/density norm | Distinctive extensions |
|---|---|---|---|
| **Anima** | tag pile / NL / **mix** (only tag-native family) | tens of tags; NL ≤300 words, ≥2 sentences | danbooru tag order; `@artist` trigger; quality-prefix (optional); underscore ban; real negative prompt lives inference-side; `(term:weight)` needs high values |
| **Klein** | BFL-slot prose (subject→location→style→camera→lighting→color→effect) | 1 sentence–~50+ words, scaled to preservation needs | **edit grammar** (imperative + retention clause; vague-quality blacklist); quoted visible text; `Image N` references (≤4); base/True trains, distilled runs |
| **Krea 2** | captioner-skeleton prose (color/shape/size/texture/quantity/text/spatial) | flowing prose ≤~1k tokens (Raw budget) | **syntax scrub** (`(term:weight)`, `#` comments stripped; hex colors kept); `Picture {i}:` references; two-stage asymmetry (flatten stage-1 negatives vs stage-2 weighting); Raw trains, Turbo runs |
| **H3** | mid-density single paragraph, official vocabulary | one paragraph; six-section only when trainer wraps | official style words + camera triplet; motion phrase + soundscape clause **only for clips with audio** (GAP 1 branch); trigger-first; empty-negative ⇒ positive-only (GAP 2) |

### 5.3 What this split feeds

The spine (§5.1) is what `DEFAULT_CAPTION_INSTRUCTION` should encode today — it is model-agnostic and every current branch of it is safe for all four families. The extensions (§5.2) are per-model pass modules in the harness's taxonomy: a **tag-grammar pass** (Anima only), a **slot-order + edit-instruction pass** (Klein), a **captioner-skeleton + syntax-scrub pass** (Krea 2), a **vocabulary/motion pass** (H3). Because ground truth is written once and refined by prose LLMs with the model's doctrine as the refinement contract, the spine belongs in the base writing prompt and exactly one extension module is bolted on per target model — that is also how the VLM scorer verifies: spine checks always run, extension checks run per family.

---

## 6. Verdict table

| Claim | Verdict | Tag |
|---|---|---|
| Anima is natively prompted (and therefore captioned) with tags, NL, or mixes; only family where tag piles are correct | Held | [DOC]+[COMM] |
| Shipped Klein weight = wikeeyang True-**V1** fp8, a de-distilled full FT of klein-9B (20–30 steps, cfg 1.0), NOT an official BFL release | Pinned this pass (byte-size match, V1 tree only) | [DOC-local]+[COMM] |
| Klein 9B TE = Qwen3-8B; 4B = Qwen3-4B (layers 9/18/27) — corrects speed-quality §3.3's flat "Qwen3-4B" | Corrected | [DOC]+[COMM] |
| BFL's slot template + specific-changes/explicit-retention edit doctrine is the Klein prompt contract ("prompt following heavily influenced by prompting style" — BFL's own words) | Held | [DOC] |
| Krea 2's TE is prompted as a captioner; its template enumerates the canonical caption skeleton; prose ≤~1k tokens; weighting/# syntax must be scrubbed from captions | Held (local source of truth) | [DOC-local] |
| H3 doctrine stands as written; two gaps recorded (stills-vs-clips branch; positive-only phrasing as an explicit rule) | Gap-check complete | [DOC] |
| The 8-rule spine + 4 extension modules is the right shape for the harness pass taxonomy and for DEFAULT_CAPTION_INSTRUCTION's upgrade path | Proposal (this doc) | [SPEC] |
| Exact quant lineage of the Anima checkpoint's community ecosystem, and any future True-V3 migration | Not researched (out of scope / budget) | [UNK] |

## 7. Sources

**Web (direct fetches — session search budget exhausted; URLs known from repo citations and HF navigation):**
1. BFL prompting guide — https://docs.bfl.ai/guides/prompting_unified_basics , /guides/prompting_editing_overview , /guides/prompting_editing_single_reference (fetched 2026-09-18) [DOC]
2. black-forest-labs/FLUX.2-klein-9B model card — https://huggingface.co/black-forest-labs/FLUX.2-klein-9B (fetched 2026-09-18) [DOC]
3. ComfyUI blog — FLUX.2 [klein] 4B & 9B: https://blog.comfy.org/p/flux2-klein-4b-fast-local-image-editing [DOC]
4. wikeeyang/Flux2-Klein-9B-True-V1 , -V2 , -V3 model cards + HF API file trees (variant pinning) — https://huggingface.co/wikeeyang/Flux2-Klein-9B-True-V1 et al. [COMM]
5. kohya-ss/musubi-tuner issue #886 (Klein TE packaging qwen_3_8b / qwen_3_4b) — https://github.com/kohya-ss/musubi-tuner/issues/886 [COMM]
6. Anima card/docs/discussion — circlestone-labs/Anima HF card + docs.comfy.org anima tutorial + HF discussion #96 (quotes: "caption the way the model is prompted…"; VLM+tagger captioning flow; ~500-step LoRA gains) — harvested earlier in this task, URLs in [h3-lora-training-guide.md](h3-lora-training-guide.md) §7.13 and [speed-quality-and-imagegen-paths.md](speed-quality-and-imagegen-paths.md) §3.2 [DOC]+[COMM]

**Local (code-level reads):**
7. `/home/agent/work/VS Proj/Kreatine` — ComfyUI-Kreatine README, `core/edit_encode.py` (KREA2_TEMPLATE, Picture markers, budgets), `core/weighting.py` (parse/SAFETYNET/comments), `docs/reference/prompt-routing.md`, `docs/reference/krea2-model.md`, `docs/reference/two-stage-sampling.md` [DOC-local]
8. `/home/agent/models/MANIFEST.md` — weight anchors (anima-base-v1.0 + qwen_3_06b_base; Flux2-Klein-9B-True-fp8 + qwen3-8b; krea2 set) [DOC-local]
9. This repo — `server/llm/fragments.ts` (output_format rows incl. OF_FLUX_KLEIN/OF_KREA2; NO anima row — gap), `server/llm/index.ts` (DEFAULT_CAPTION_INSTRUCTION), [docs/library/minimax-h3-prompt-guide-base.md](../library/minimax-h3-prompt-guide-base.md) + [-ref.md](../library/minimax-h3-prompt-guide-ref.md), [h3-lora-training-guide.md](h3-lora-training-guide.md) §4 (precedent), [speed-quality-and-imagegen-paths.md](speed-quality-and-imagegen-paths.md) §3 (prior path cards; §3.3 TE fact corrected herein) [DOC]
