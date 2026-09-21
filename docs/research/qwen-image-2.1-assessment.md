# Qwen Image 2.1 — unified t2i+edit model (fresh-release assessment)

> Maintainer-requested look, assessed 2026-09-20 (release day — GitHub news
> line "2026.09.20: We released Qwen-Image-2.1!"). No Flux task at capture
> time (maintainer places those). This is the candidate record for the
> Workbench edit lane named in the Workbench directive ("qwen edit, flux,
> klein, krea, anima"). Sibling research:
> [h3-image-workbench.md](h3-image-workbench.md) (the edit taxonomy +
> engine-pluggable refine stage where this would slot),
> [krea2-edit-mode.md](krea2-edit-mode.md) (the image-only alternative
> path, mf3wfq6),
> [h3-instruction-based-editing.md](h3-instruction-based-editing.md)
> (Qwen-IE-2511 as the community's refine-engine watch-item),
> [ecosystem-2026-09.md](ecosystem-2026-09.md).
>
> METHOD: lean fetches 2026-09-20 (US time; some HF `lastModified` stamps
> read 09-21 — CN timezone) — HF model API (org listing, per-repo metadata
> with file sizes, raw READMEs, raw LICENSE), the
> [QwenLM/Qwen-Image-2.1](https://github.com/QwenLM/Qwen-Image-2.1) GitHub
> README, ComfyUI master **code** (`nodes_qwen.py`, `sd.py`,
> `text_encoders/qwen_image21.py`, tree + commit history + v0.36.0 tag),
> the two official workflow templates, and commit histories of
> city96/ComfyUI-GGUF and ostris/ai-toolkit. Release is **hours old** — per
> the purpose doctrine, zero community metrics are cited and none could
> exist; quality claims are unverified by us (no engine work this session)
> and belong to our benchmark harness. Tags: **[DOC]** card/API/code-level
> verifiable, **[SPEC]** our fit reasoning, **[UNK]** not stated anywhere
> fetched. The qwen.ai blog is client-rendered and unscrapeable today — its
> benchmark tables were NOT captured; every quantitative-quality claim
> below is card/code-level only.

## 0. What it is

A **unified text-to-image + image-editing model** — the first open checkpoint
in the family that folds the previously separate Edit line into the base
model **[DOC]**. One 7.1B diffusion transformer does t2i, instruction
editing, multi-reference composition, transparent (RGBA) generation/editing,
and subject extraction.

| | |
| --- | --- |
| Repos (HF, all official `Qwen` org) | `Qwen/Qwen-Image-2.1` (base, unified t2i+edit), `Qwen/Qwen-Image-2.1-PE-T2I` + `Qwen/Qwen-Image-2.1-PE-I2I` (prompt-rewriting companions) **[DOC]** |
| DiT | **7.115B params, 32 layers, single-stream**, hidden 4096, patch 1, `causal_condition: true`, block-causal attention (`q_idx >= kv_idx or same_image_block`; text token-causal, images chunk-bidirectional) **[DOC]** |
| Text encoder | **Qwen3-VL 8B** (36L, GQA 32/8, interleaved mrope) — encodes the text AND all condition images **[DOC]** |
| VAE | **64-channel RGBA autoencoder, 16× spatial** — native transparency (the Dec-2025 Qwen-Image-Layered lineage, productized) **[DOC]** |
| Scheduler | Flow matching, Euler, dynamic shifting; official templates run cfg 1 **[DOC]** |
| Native resolution | 2K class: 2048², up to 2752×1536 / 1536×2752 (7 ratios); diffusers default 40 steps **[DOC]** |
| Efficiency mechanism | **Prefix KV cache reuse**: text + condition-image prefix computed once at step 1 and reused across all denoising steps (enabled by the causal attention) **[DOC]** |

**Lineage correction (the family's own 2512 card timeline + HF API
timestamps) [DOC]:** generation line = Qwen-Image (2025-08-04) →
Qwen-Image-2512 (2025-12-31, t2i-only refresh); edit line = Qwen-Image-Edit
(2025-08-18) → **Edit-2509** (2025-09-22) → Qwen-Image-Layered (2025-12-19)
→ Edit-2511 (2025-12-23). All 20.4B MMDiT + Qwen2.5-VL-7B TE, all
**Apache-2.0**. 2.1 replaces BOTH lines with one 7.1B model. A "Qwen-Image
3.0 / 3.0 Pro" exists as a hosted/API line (ComfyUI partner nodes since
v0.32.0, PR #15327) — the open-weights line is 2.x. No
`Qwen/Qwen-Image-2.0` HF repo exists (the "2.0" of the arxiv paper /
wavespeed mentions is not an open release) **[DOC — absence verified via HF
API]**.

**Variants shipped today:** base + the two PE rewriters. **No** turbo /
Lightning / Edit-refresh / separate edit checkpoint **[DOC — absence]**. The
PE pair ("Prompt Enhancement") are fine-tuned **Qwen3.5-VL 9B** models
(9.4B params each): T2I turns a short any-language request into a detailed
English prompt + recommended `wh_ratio`; I2I turns a vague edit instruction
+ input images into a precise edit prompt + `wh_ratio`/`ratio_follow` (aspect
inherit), after a `<think>` block (max 24k new tokens, temp 1.0) **[DOC]**.
They are optional — the base model takes plain prompts directly.

## 1. Edit capabilities (and what's new vs Edit-2509/2511)

Card claims **[DOC]**, all mechanism-backed in ComfyUI/Diffusers code except
where tagged:

- **Instruction editing** — plain-language edit on one input image
  (Diffusers: `pipe(prompt="Change the background to a sunset beach",
  image=input_image)`).
- **Multi-reference composition — up to 10 reference images** (the ComfyUI
  node exposes 16 slots), each entering BOTH as Qwen3-VL vision tokens AND
  as VAE `reference_latents` spliced into the sequence (the 2509/2511
  dual-path mechanism, extended from 1/3 fixed slots to N) **[DOC — node
  code]**. Showcase: group photo from six portrait refs; full outfit from
  five refs (model, clothing, shoes, bag, hat) **[DOC — card images, not
  watched]**.
- **Local edits via circles, painted annotations, or separate masks** —
  i.e. the region spec is drawn INTO an input image (annotated image as
  reference), not a latent-mask channel; the ComfyUI day-one node has no
  mask input, and true latent-noise-mask inpaint on 2.1 is untested
  **[DOC card wording + node code; UNK for latent-mask inpaint]**.
- **Identity preservation** for people and products — card claim
  **[DOC]**; unmeasured by anyone day-one **[UNK]**.
- **Text rendering** — Qwen's signature, "improved typography" over a line
  already known for it **[DOC]**; benchmark tables live in the
  unscrapeable blog **[UNK]**.
- **Native RGBA** — generate/edit transparent layers, extract subjects
  from photographs; VAE keeps all 4 channels, the vision tower sees alpha
  composited over white **[DOC — node code]**.
- **Native 2K**, panorama-from-selfie, storyboard-from-3-view-sheet
  showcases **[DOC]**.

**New vs Edit-2509 (the prior edit model):** unification (t2i+edit+RGBA in
one checkpoint), 2.9× smaller DiT (20.4B→7.1B), refs 1→10 (16 in ComfyUI),
Qwen2.5-VL-7B→Qwen3-VL-8B TE, first-class negative prompt (2509 had none in
its Comfy node), no user-facing "Picture N" placeholder syntax, reference
resolution dial, prefix-KV reuse, native 2K, official prompt-rewriter pair —
and **a non-commercial license where every predecessor was Apache-2.0**
(§5).

## 2. The 24GB question

File-level facts (HF API blobs, 2026-09-20) **[DOC]**:

| Component | bf16 | int8-convrot (official) | other |
| --- | --- | --- | --- |
| DiT `qwen_image_2.1` | 14.23 GB | **7.26 GB** | — |
| TE `qwen3vl_8b` | 17.53 GB | **9.35 GB** | W4A8 **6.31 GB** |
| VAE | 0.68 GB (bf16) | — | — |
| **Resident total (our convrot class)** | 32.4 GB — no | **~17.3 GB** | ~14.3 GB w/ W4A8 TE |

Comfy-Org ships the int8-convrot pair for BOTH DiT and TE day-one — exactly
our quant class, official, no third-party dependency **[DOC]**. ~6.7 GB
headroom on 24GB for latents/KV/activations at the template's 1024² edit
resolution; the prefix KV cache is separately controllable
(`QwenImage21Cache`: device auto/gpu/cpu/off × dtype default/int8/int4 —
int8 "halves the cache at about bf16 accuracy", int4 "quarters it but
roughly doubles per-step error" **[DOC — node tooltip, experimental]**).
**Measured VRAM at native 2K on a 24GB card: unknown day-one** **[UNK]** —
no independent measurements can exist yet; treat 2K-on-24GB as unproven
until our testbed measures it. PE rewriters are optional +9.47 GB (int8)
each — we would NOT stage them (our prompt-doctrine lane owns expansion;
see §4). Community GGUFs of all sizes shipped within hours, but
city96/ComfyUI-GGUF has **no 2.1 loader support as of today** (last commit
2026-01-12) **[DOC — verified negative]**; irrelevant to our convrot lane.

## 3. ComfyUI integration (day-one state)

**Native, day-0, in core** — no custom pack needed **[DOC]**:

- Support landed on master **2026-09-19** (PR #16400, CORE-423) — **not in
  the v0.36.0 tag** (verified: tag's `nodes_qwen.py` has zero QwenImage21
  classes); requires master/nightly or the next tagged release **[DOC]**.
  Three same-day stabilization commits followed (per-block attention
  selection #16419, transformer block compile #16430, KV-cache placement
  #16429) — expect first-weeks churn **[DOC]**.
- **Nodes:** `TextEncodeQwenImage21` (prompt, negative_prompt, optional
  vae, `resolution` dial for ref resize — 0 keeps native size, autogrow
  `image_1..image_16`; outputs positive + negative conditioning AND a
  64ch latent sized off the FIRST reference: "any other size shifts the
  edit") and `QwenImage21Cache` (experimental KV-cache device/dtype
  control). Loaders are stock: `UNETLoader` + `CLIPLoader` type
  **`qwen_image`** (existing CLIPType 18; TE auto-detected as
  QWEN3VL_8B) + `VAELoader` **[DOC — code]**.
- **Graph shape** (official `image_qwen_image_2_1_image_edit.json`
  template): LoadImage(s) → TextEncodeQwenImage21 (+QwenImage21Cache) →
  KSampler (cfg 1, 25 steps) → VAEDecode. Multi-ref = more image inputs
  on the same node; no separate Invoke/reference node chain like the
  2509/2511 era **[DOC]**.
- **Weights:** `Comfy-Org/Qwen-Image-2.1` (bf16/int8-convrot/W4A8/bf16-VAE
  files, created 09-15 — ComfyUI had pre-release coordination) **[DOC]**.
- **LoRA training day-0 in ostris/ai-toolkit** (2026-09-20 commits: "Add
  support for Qwen Image 2.1", alpha-channel training, new LoKR format,
  default guidance 3) **[DOC]** — refmod/LoRA stacking, our workbench
  staple, is already trainable.

## 4. Prompt contract

**[DOC — card + TE code unless noted]**

- Edit = plain instruction text (`"Change the background to a sunset
  beach"`). References are **auto-spliced** as
  `<|vision_start|><|image_pad|><|vision_end|>` blocks BEFORE the user
  turn in a chat template (system: "Comprehend and analyze the provided
  prompt."). **No user-facing "Picture N" placeholder syntax** — a real
  delta from Edit-2511 (`Picture N:` in prompt text) and from our H3
  `<Picture N>` ownership contracts. Ref-role steering ("keep identity
  from ref 1, jacket from ref 2") must be expressed in the instruction
  prose since there is no slot syntax **[SPEC — inference from template
  mechanics; untested]**.
- **First-class negative prompt** (encoded against the same refs) — new
  for the family; our per-model doctrine needs a negative-policy entry.
- RGBA formula (recommended verbatim): `"This is an RGBA image with
  transparency. <desc>. The image has alpha channel and the background is
  transparent."`
- Defaults: cfg 1 (template) / 40 steps (Diffusers) / 25 steps (ComfyUI
  template); ai-toolkit trains at guidance 3 **[DOC]**.
- The PE rewriters are Qwen shipping a Context-IR-style app-side contract
  model-side (vague instruction → precise prompt + aspect JSON). We
  already own this lane (Ollama planner); if we adopt the family we keep
  OUR expansion layer and skip staging two extra 9B models **[SPEC]**.

## 5. License — the day-one surprise

**NOT Apache-2.0.** All three repos ship the **Qwen RESEARCH LICENSE
AGREEMENT** (release date September 20, 2026; `license: other`,
`license_name: qwen-research`) **[DOC]**. Key terms, full text read:

- "Non-Commercial" = **"for research or evaluation purposes only"**;
  commercial use requires a separate license
  (model-business@notice.qwencloud.com) **[DOC]**.
- Outputs used to train/improve distributed AI models require "Built with
  Qwen" documentation attribution; "Qwen" cannot be a derivative product's
  primary name; redistribution requires license copy + change notices
  **[DOC]**.
- Chinese law, Hangzhou courts, termination-on-breach **[DOC]**.
- Not gated (open download, no HF auth wall) **[DOC]**.

Every predecessor in the family was Apache-2.0; this is a licensing
regime change for the Qwen image line. For the maintainer's personal
studio it reads as usable (non-commercial personal research/creation —
borderline but the ordinary reading of a hobbyist desktop tool); for any
commercial output or shipped product it is a hard gate. Our conventions
already handle this shape: consent/catalog rows must match the CURRENT
license, weights link-never-copy, non-permissive = user-fetch rows
**[DOC — conventions]**. This CORRECTS the "expected Apache-2.0"
assumption in the assessment brief.

## 6. Fit — what it adds over H3-1F + Krea 2, and risks

**Adds over H3-1F edit lanes** **[SPEC throughout]**: a dedicated-image-model
edit path without the video-model wrapper (no 39-frame settle, no hidden
temporal context — the ethanfel H3-edit pack's core cost); native ≤10-ref
multi-subject composition vs H3's REF2VA ≤9 (comparable counts, but image-native
mechanics vs video-packet transport); **RGBA/subject-extraction lane with no H3
equivalent** (sticker/asset workflows, transparent-layer editing — also a
clean handoff surface INTO H3 two-ref/start-frame); signature text rendering;
native 2K output. Refine-lane note: the H3 community's own refine choice was
Qwen-IE-2511 (Lightning 4-step) — 2.1 has **no distilled/Lightning variant
day-one** **[DOC — absence]**, so as a refine engine it is 25-40 full steps
until a turbo exists.

**Adds over Krea 2 stills mode:** 10 refs vs 2-3 grounded; unified t2i in the
same checkpoint; transparency. Krea 2 keeps: our measured identity-on-recipe
record, existing in-app graph families, and a community license that permits
small-scale commercial — **2.1 does not** (§5).

**Risks:** research license (the gating one); hours-old core code with three
same-day churn commits; blog benchmarks uncaptured; zero community evidence
possible (doctrine: harness must judge quality — identity/multi-ref/text axes
are exactly our A/B rubric's lanes); multi-ref merge-to-one-subject failure
mode (the known H3 REF2VA hazard) uncharacterized on 2.1 **[UNK]**; mask/
circle local-edit ergonomics in ComfyUI are "annotate the image," not our
mask-canvas UX — app-side translation needed **[SPEC]**.

**Where it slots:** a family entry on the A-3 registry when the Workbench
spec round happens (Wave-3 shape) — `family: qwen-image-2.1`, engines =
instruct-edit / multi-ref compose / RGBA lanes; fetch-catalog candidate
rows (sha-pinned, linked-not-copied, license verdict `qwen-research`
non-commercial); graph factory per lane on the two native nodes. **Not an
immediate build** — the workbench doesn't exist yet, and license posture
should be settled first.

## 7. Verdict

| Axis | Call |
| --- | --- |
| **Verdict** | **ADOPT** — as a Workbench family-registry candidate (fetch-catalog rows + lane graph factories when the workbench spec round happens), not an immediate build |
| Why | It is the edit option the Workbench directive already named, with the cheapest integration surface we've seen for a fresh family: day-0 ComfyUI **native** nodes, official int8-convrot DiT+TE (our exact quant class, ~17.3 GB resident on 24GB), day-0 ai-toolkit LoRA training, and a ≤10-ref + RGBA + text-rendering surface our H3/Krea lanes don't cover |
| The gate | The **Qwen Research License (non-commercial)** — recorded as the family entry's license verdict; any commercial posture flips this to NONE. It also CORRECTS our standing Apache-2.0 expectation for this family |
| Revisit trigger | First tagged ComfyUI release carrying #16400; a Lightning/turbo distill (refine-lane viability); our harness measuring identity/multi-ref/text vs Krea 2 on-recipe; any license change (conventions: license change invalidates stale consent) |

Sources (all retrieved 2026-09-20): HF API `models?author=Qwen`,
`models?search=qwen-image`, per-repo metadata+files (`Qwen/Qwen-Image-2.1`,
`...-PE-T2I`, `...-PE-I2I`, `Comfy-Org/Qwen-Image-2.1`,
`Qwen/Qwen-Image-2512`, `Qwen/Qwen-Image-Edit-2509`, `Qwen/Qwen-Image-Edit-2511`);
raw READMEs + LICENSE of the three official repos;
raw.githubusercontent.com `QwenLM/Qwen-Image-2.1/main/README.md`;
Comfy-Org/ComfyUI master `comfy_extras/nodes_qwen.py`, `comfy/sd.py`,
`comfy/text_encoders/qwen_image21.py`, tree + v0.36.0 tag + commit history
(PR #16400, #16419, #16429, #16430); Comfy-Org/workflow_templates
`image_qwen_image_2_1_t2i.json` + `image_qwen_image_2_1_image_edit.json`;
api.github.com commits for city96/ComfyUI-GGUF and ostris/ai-toolkit;
qwen.ai blog `?id=qwen-image-2.1` (client-rendered, content NOT captured).
