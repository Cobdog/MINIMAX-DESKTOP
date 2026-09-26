# The node-pack registry — per-family curation (the standing document)

> **Provenance.** Commissioned by maintainer directive `519ffa6c` (epic 4lphxv8, 2026-09-21): *"make sure the comfyUI tools we chose is correct… we have the best nodes for the job selected. H3 is the focus here… figure out what is worth working around."* Sharpened mid-flight by the challenge-everything extension (*"this is also considering superceding and removing… what worked yesterday might have a better solution today"*) and the epistemology directive `426ab190` (*"these decisions require testing to finalize… we never add or remove blindly, but we also need a good starting point"*). Flux task `pqz9efh`.
> **Method.** Local code reads: `src/lib/nodePackRegistry.ts` + `server/engineNodes.ts` (the 9 `ENGINE_NODE_PACKS` rows), `src/lib/modelOverrides.ts` (`MODEL_FAMILIES`), `src/lib/graph/{registry,turbo,upscale,krea2edit,h3image}.ts`, `src/lib/workflow.ts`, `src/lib/music3Workflow.ts` + `src/lib/aceStepWorkflow.ts`, `src/lib/engineSemantics.ts`, `server/{core,realtime,objectInfoProbe}.ts`, `docs/devdocs/comfyui-api/` + `comfyui-manager-api/` captures. Read-only inventory of the shared install `/home/agent/comfyui/custom_nodes/` (28 dirs — nothing run, nothing modified, 8188 untouched). The maintainer's own `ComfyUI-Kreatine` read at `/home/agent/work/VS Proj/Kreatine/vendor/ComfyUI-Kreatine` (README, ARCHITECTURE.md, `nodes/two_stage.py`, `core/schedules.py`). Web: Acly/krita-ai-diffusion + `backend/comfy_client.py` (raw fetch 2026-09-21), Acly/comfyui-tooling-nodes, astropuzzo Image Studio releases, circlestone-labs/Anima (all 2026-09-21). No GPU, no installs, nothing submitted.
> **Evidence tags:** **[DOC]** verified in code/source read this pass · **[CAP]** verified in a dated devdocs capture · **[COMM]** reputable community claim · **[SPEC]** plausible, unverified. No community-metric worship: stars are context, never verdicts.

---

## 0. How to read this document — the row schema and the standing discipline

Every registry row carries the epistemology shape (directive `426ab190`). **No row is final on research alone.**

| Field | Meaning |
|---|---|
| **THEORY** | Why this pick should win, stated as a *testable claim* — not a preference |
| **TEST PLAN** | What the benchmark harness measures to finalize: matched arms + which golden domains + which metric rows |
| **STATUS** | `PROPOSED-PENDING-TEST` (the neutral baseline — the maintainer has generated nothing yet; every initial pick is the *starting arm* of a future A/B, explicitly NOT a commitment) · `ADOPTED-TESTED` · `SUPERSEDED-BY <row>` · `REMOVED` |
| **ALTERNATIVES** | The logged runners-up — the fallback ladder. If testing comes up short, the next candidate is already known |
| **LAST-VERIFIED / RECHECK-ON** | Date of this pass + what fires a re-check (symptom: misbehavior against a captured contract · event: new-family arrival or notable ecosystem release · calendar: quarterly) |

**This is a standing document, not a one-off.** Re-curation fires: (1) before any spec round that depends on a family's node surface; (2) on every new-family arrival; (3) quarterly; (4) on symptom. Every re-run **re-challenges incumbents — yesterday's winner defends its slot** against what shipped since. The examined-ledger (§9) is the memory: future passes never rediscover what this one found.

---

## 1. THE REGISTRY — per family

The current code truth: 11 pack rows in `ENGINE_NODE_PACKS` (GAP-1/GAP-2 closed 2026-09-21, task 06jr4eh — see §1.1), 3 model families in `MODEL_FAMILIES` (`minimax`, `h3image`, `music3` — `acestep` removed 2026-09-21, nn5ld47), plus lanes that live in graph builders without a family row yet (Krea 2 edits, Klein refine, chains). **[DOC]**

### 1.1 H3 video (`minimax`) — the focus family

The lane is mostly **stock core** (`MiniMaxH3ImageToVideo`/`ReferenceToVideo`, `EmptyMiniMaxH3LatentAV`, `MiniMaxH3SigmaShift` — ComfyUI 0.34.0 native) plus four adopted packs and two **registry gaps found this pass**.

| Pack | Load-bearing classes | What for | Why / THEORY | STATUS |
|---|---|---|---|---|
| *(stock core)* | the conditioning/latent/VAE node set | the whole video lane | MiniMax H3 is a first-class citizen of core ≥0.30; official template parity | PROPOSED-PENDING-TEST (the incumbent arm) |
| **ComfyUI-MiniMax-H3-Turbo** (Larryvrh, Apache-2.0, user-fetch, pinned `4274783`) | `MiniMaxH3TurboLoRA`, `MiniMaxH3TurboSampler` + the `h3_silu_temb_grid` fix for pruned bases | Turbo adapter loading + paired sampler for the speed stack (`turbo.ts`: drbaph-4, lightx2v-fl2v-4 pairings route through `MiniMaxH3TurboSampler`) | Speed lane: 4/8-step adapters with a loader that applies the pruned-base grid fix the stock `LoraLoader` lacks | PROPOSED-PENDING-TEST · ALT: stock `LoraLoader` + official adapters (works, loses the grid fix + sampler pairing) |
| **ComfyUI-VDN-H3** (Saganaki22, Apache-2.0, **vendored**, pinned `3eb6349`) | `ApplyVDNH3`, `ApplyVDNH3Advanced` | VDN delta-attention acceleration as runtime model patches — no core fork | Trained efficiency branch, different class from LoRA distills; vendored because license-clean and small | PROPOSED-PENDING-TEST · ALT: plain turbo stack; the **24GB variant** (installed as `ComfyUI-VDN-H3-24GB`, `*_24GB`-suffixed classes) is its own chain option — task `9up52mj`, planning |
| **ComfyUI-H3-Motion-Context** (NikoDemon80, GPL-3.0-only, user-fetch, pinned `5335715` / v0.6.2 — the rev installed on the shared instance) | `MiniMaxH3MotionContext`, `…LoadLatent`, `…SaveLatent`, `…Trim` | **The chain lane.** `src/lib/workflow.ts:241-286` emits exactly these four classes for canvas chain continuation (context frames + audio carry, latent save/load between clips) | Chaining is the Director Suite's engine side; this pack is the shipped machinery our chain builder already speaks | PROPOSED-PENDING-TEST — **row added 2026-09-21 (task 06jr4eh): GAP-1 closed**; license verified at row time (plain v3 LICENSE, no or-later grant, read from the installed copy) |
| **ComfyUI_MinimaxH3_AutoContext** (supElement, Apache-2.0, user-fetch, pinned `f1062d3`) | `Minimax_H3_AutoContext_parameter/_Sampler`, `Minimax_H3_Seam_Correction` | Segmented inference: prompt-timeline slicing, per-segment reference filtering, 3-channel anchoring, hash-keyed latent cache with resume | Long-form without chain drift; deep-read `autocontext-deepread.md` | PROPOSED-PENDING-TEST · ALT: Motion-Context chaining (installed, simpler, no per-segment prompting) — **the two overlap; TS test decides which is the default long-form lane** |
| **minimax-lora-form-adapter** (OURS, first-party MIT, `custom-nodes/`) | `MiniMaxH3LoraFormLoader` | Form-adaptive LoRA loading: detects curve(pruned) vs full-width adaln forms, projects full-width onto curve bases at load | Community LoRAs ship both forms; the stock loader silently mis-pairs them. Golden-tested against kijai's conversion | PROPOSED-PENDING-TEST (weakest uncertainty: how often the projection path is hit in practice) |
| **LBH latent upscalers** (LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler, MIT, user-fetch, pinned `40316cf` — the commit that added the upstream LICENSE) | `MinimaxH3LatentUpscalerNode2D`, `MinimaxH3LatentUpscaler3D` (verified verbatim from the pinned rev's `nodes/minimax_h3_latent_upscaler_{2d,3d}.py`) | `upscale.ts` emits them for `upscale.lbh2d`/`lbh3d` (2× latent, then sigma-refine pass) | Latent-space 2× preserves audio path (RTX pixel path drops it) | PROPOSED-PENDING-TEST — **row added 2026-09-21 (task 06jr4eh): GAP-2 closed** (origin repo pinned, license verified, fetch affordance wired) |
| **ComfyUI-MiniMaxH3-PreviewOverride** (simsim9-stack, MIT, user-fetch, pinned `d1eb17b`) | `MiniMaxH3PreviewOverride` (the one class; verified from the pinned rev's `preview_override.py`) | **The preview-decoding path.** `graph/preview.ts` wires it as node `'7'` on every live-preview render when served — the maintainer-endorsed route (2026-09-22 ruling, after their preview crash) | The pack's OUTER_SAMPLE wrapper decodes the H3 video latent itself (name-pinned tiny TAE from vae_approx, channel-checked, Latent2RGB fallback at every level) and emits the `minimax_h3_preview_override` WS stream `realtime.ts` already consumes — structurally immune to the stock path's null-previewer crash class (arbitrary taeh3* file wins the engine's prefix match → sight-unseen TAEHV construction). Deep-read: [preview-override-assessment.md](preview-override-assessment.md) | PROPOSED-PENDING-TEST — **row added 2026-09-22 (task t6vub9k, pulled forward from the curation queue by the maintainer's ruling)** · ALT: the stock vae_approx file convention (`preview_method 'taesd'` + the Kijai taeh3 fetch row — the live pack-absent fallback) |

**GAP-1 (Motion Context) and GAP-2 (LBH) were the pass's headline corrections — CLOSED 2026-09-21 (task 06jr4eh):** both were *load-bearing dependencies of shipping graph builders* with **no `ENGINE_NODE_PACKS` row** — no object_info detection mapping, no F6 preflight remediation offer, no license/pin record. Under the registry-only directive (`ffcff765`) the render attempt diffs required classes against object_info and offers remediation — these classes fell through that seam. **Both rows now exist** (`h3-motion-context`: GPL-3.0-only, fetch-consent, pinned at the installed rev `5335715`; `lbh-latent-upscaler`: MIT, pinned at `40316cf` — the commit that added the upstream LICENSE) with fetch-catalog entries, preflight class→pack mapping (asserted in the enginewatch + instance + fetcher suites), and registry.md license rows.

### 1.2 H3 image (`h3image`, post-Image-Studio-adoption)

| Pack | Load-bearing classes | What for | Why / THEORY | STATUS |
|---|---|---|---|---|
| *(stock core)* | conditioning trio, VAELoader pair, KSampler path | the base still lane | same core; the T=1 floor (#15644) is the known break — see next row | incumbent arm |
| **ComfyUI-MiniMax-H3-Image-Studio** (astropuzzo, The Unlicense; v23.0.0 `47dea30`, still latest — verified 2026-09-21) | **only 4 of 12**: `H3ImagePrepare` (+T2I/I2I/RefEdit wrappers), `H3ImageDecode` | Legal T=1 latents, exact 9/13 packets, `single_latent_slice` fast-sharp decode | The one thing our stack provably cannot do on stock nodes (double server-side clamp, `execution.py:1020` + `temporal_shape` — devdocs ADDENDUM 2026-09-21); adoption task `afvlbk4` in flight with the pack-vs-~150-line-port decision flagged for the maintainer | PROPOSED-PENDING-TEST · ALT: first-party port of the 4 classes (bus-factor-1 mitigation; Unlicense makes it license-clean) |
| **ComfyUI_MinimaxH3HybridLoader** (scottmudge, MIT, user-fetch, pinned `a44c69b`) | `MiniMaxH3HybridLoader` | b25-49 fl2va+ref2va runtime merge at load — one mmap per checkpoint | Ref2VA reference capability at FL2VA quality without a duplicate multi-GB artifact (the >97%-identical-weights finding) | PROPOSED-PENDING-TEST (single-author quality claim — the cheap A/B the sweep named) |
| **Klein trio** (stock nodes only — no pack) | `UNETLoader`/`DualCLIPLoader`/`VAELoader` + `CFGGuider` | the fast-tier refine engine (`h3img.refine.klein`, official `image_flux2_klein_image_edit_{4b,9b}_distilled` templates) | Different engine, self-contained; **but two schema divergences already filed** (`engineSemantics.ts`: `CFGGuider` misnamed inputs → `required_input_missing` ×2; `ImageScaleToTotalPixels` now wants `resolution_steps`) — the klein lane fix owns these; the trio has never been staged on the testbed, so the lane is untested end-to-end | PROPOSED-PENDING-TEST (and currently BROKEN-UNTIL-FIXED at validation) |
| *(refine engines)* | Krea 2 lane (below) + klein + app-side tone-lock | the two measured refine engines | ours | incumbent |

**Krea 2 turbo** (the image model) appears here as a refine engine and in §1.3 as its own seam.

### 1.3 Krea 2 (+ KREATINE) — the seam with the maintainer's own sampler

Two generations of tooling coexist: the **studio-side builder lane** (`krea2edit.ts`: identity-edit + anypaint families over stock loaders/KSampler) and **Kreatine** — the maintainer's own ComfyUI pack (GPLv3, installed on the shared instance) built for the Krita-side daily driver. The charter makes Kreatine "the intended KREA path."

| Pack | Load-bearing classes | What for | Why / THEORY | STATUS |
|---|---|---|---|---|
| **ComfyUI-Kreatine** (OURS — the maintainer's own, GPLv3; NOT yet in `ENGINE_NODE_PACKS`) | `KreatineTwoStageSampler`, `KreatineLoraBridge`, `KreatineReferenceEncode`/`Patch`, `KreatineControlEncode`/`Loader`, `KreatineAnyPaintPrepare`/`Encode`, `KreatineMaskTrim`, `KreatineContextCrop`, `KreatineCanvasMath`, `KreatineModeDecode`, `KreatinePanelConfigDecode` | **§5 records the two-stage design verbatim.** The all-in-one Krea lane: two-stage sampling, prompt weighting, reference recipes, depth control, anypaint — single resident model | The maintainer designed and measured it; it supersedes *parts* of three other packs on this lane (see CUT list) | PROPOSED-PENDING-TEST (TS-1, §6, is its gate) · **registry row needed when the Krea lane lands** — license decision point in §5 |
| **comfyui-krea2edit** (lbouaraba, Apache-2.0, user-fetch, pinned `86f886d`) | `Krea2EditModelPatch`, `Krea2EditGroundedEncode` | dual-conditioning carrier for the identity-edit v1.2 LoRA — powers Instruct/removal/two-reference edit families in `krea2edit.ts` | Only shipped implementation of the image-grounded Qwen3-VL encode pairing | PROPOSED-PENDING-TEST · ALT on the Kreatine lane: Kreatine's reference recipes cover the identity LoRA case (its README documents the `index` recipe = what identity LoRAs are trained with) — overlap to resolve at the Krea lane design |
| **krea2-anypaint** (alexw5702-afk, MIT, user-fetch, pinned `675be5a`) | `Krea2AnyPaintPrepare`/`Encode`/`ModelPatch` | arbitrary-mask inpaint/outpaint via the rank32 functional adapter | per-step latent restoration machinery | PROPOSED-PENDING-TEST · **on the Kreatine lane this is superseded** — Kreatine vendors the prepare/encode pair byte-faithfully (its `core/anypaint.py`, MIT notices kept) and replaces the ModelPatch with its own patched forward |
| **comfyui-krea2-controlnet** (facok, NO-LICENSE, user-fetch) | `Krea2ControlLoRALoader`/`Apply`/`ImageEncode` | depth structure lock | the depth-control LoRA carrier | **SUPERSEDED-BY (Kreatine) on the Kreatine lane** — `KreatineControlLoader` loads the same weights from the documented mechanism *without facok's unlicensed code* (THIRD_PARTY_NOTICES). Keep the row only while the non-Kreatine lane exists; candidate full CUT |
| **comfyui-krea2-ostris-edit** (installed on shared instance; not in registry) | `TextEncodeKrea2OstrisEdit`, `Krea2OstrisEditModelPatch` | the ostris/ai-toolkit t=0 edit-LoRA recipe runner | — | **CUT candidate (redundant)** — Kreatine's `KreatineReferencePatch` implements the t=0 recipe natively and defers `index`-recipe conds to core's `ReferenceLatent`; the README's recipe-switch section covers both |
| **krea2t-enhancer** (capitan01r; installed on shared instance; not in registry) | `Krea2TurboReferenceSigmaSchedulerFromLatent`, `ComfyUIKrea2TEnhancer` | prompt-adherence enhancement for Krea2 turbo | — | WATCH/PENDING-TEST — not examined deeply this pass; candidate quality arm for the Krea lane's TS run |

### 1.4 Klein — a family, barely

Klein = **Flux.2 Klein image-edit** (4b/9b distilled; `flux-2-klein-9b-fp8` trio auto-detect in `h3image.ts`). **Stock nodes only** — no pack row needed; the open items are the two `engineSemantics` schema fixes and first execution on the testbed. THEORY: distilled edit models at 4 steps are the right fast-tier refine under H3 stills. TEST: matched arms vs the Krea 2 refine engine on the refine golden domains (fidelity-to-source + instruction-following), wall-clock as the tiebreak. STATUS: PROPOSED-PENDING-TEST. ALT: Qwen-Edit lane (the Image Studio DETAIL_REFINER recipe) — logged, not staged.

### 1.5 Anima — future arrival (the naming flag)

"Anima" in the charter = **circlestone-labs/Anima**, a 2B text-to-image model for anime/illustration concepts **[COMM]** (Hugging Face; Krita AI Diffusion v1.53.0 ships segmentation control for it — fetched 2026-09-21). Slot: the Workbench's character/reference-sheet lane (the asset-authoring use case). Expected surface: stock loaders (2B single-file) — **verify at arrival**; no pack anticipated beyond core. **Registry flag: the name collides** with the Intern pack's `Anima*` node prefix (§4.3) — when the family lands, rename one side to keep `class_type` greppability clean.

### 1.6 Audio (`music3`, `acestep`) — the clean one

**Stock core only** **[DOC]**: `MiniMaxMusic3TextEncode`, `EmptyMiniMaxMusic3LatentAudio`, `ModelSamplingAuraFlow`, `VAEDecodeAudio(Tiled)`, `SaveAudioAdvanced`, stock loaders. Zero custom packs — and that is the correct shape: the engine is a first-class core citizen. **ACE-Step was REMOVED 2026-09-21 (nn5ld47, the audio-lane ruling — nearly a year old; music3 stays for MiniMax family cohesion; restore map at docs/audit/removals-acestep.md); its classes left preflight's stock list and contract scope with the lane.** The one registry row, **comfyui-minimax-h3-audio-T8** (GPL-3.0, user-fetch, `MiniMaxH3AudioConditioningT8`), is H3-*video* audio editing (the sidecar), not these families — it stays with §1.1's orbit, node names in-flux upstream (registry comment already says so). STATUS: PROPOSED-PENDING-TEST for T8 (pattern-adopted ideas, fetchable-flagged posture unchanged).

### 1.7 Cross-family utilities

| Thing | Role | STATUS |
|---|---|---|
| **turbo stack** (`turbo.ts` registry: official fl2v-8/ref2v-4, lightx2v ×3, drbaph-4, larryvrh-v4-8, PDD ×2, generic) | speed adapters as *data* — detection by filename pattern, pairing contracts pinned per entry | sound design; the Larryvrh **pack** is only required when an entry declares `samplerNode: MiniMaxH3TurboSampler` — keep as-is |
| **VDN** | §1.1 | — |
| **form-adapter** | §1.1 | — |
| **comfyui-tooling-nodes (ETN, Acly)** — GPL-3.0, installed (symlink from Kreatine vendor) | the external-tooling transport: base64 load, in-RAM image cache (`PUT/GET /api/etn/image/{id}`), `SendImageWebSocket`, regions, tiling, `model_info` classification | **BRING-IN (bridge lane)** — see §4.3; runtime dependency only, never vendored (GPL) |
| **ComfyUI-Lora-Manager** (willmiao; installed) | LoRA browsing/management; Kreatine's `KreatineLoraBridge` optionally persists sets through it | WATCH — optional accelerator, never a requirement (Kreatine's Native+ rule) |
| Inpaint cluster on the shared instance (`comfyui-inpaint-nodes`, `LanPaint`, `ComfyUI-Inpaint-CropAndStitch` + `comfyui-crop-and-stitch`) | workbench-utility class: Fooocus/LaMa/MAT heads, universal sampler, crop-and-stitch | Workbench bring-in candidates at its spec round; note the **duplicate crop-and-stitch install** (the Kreatine-vendored subset + the full repo) — one should go |
| `comfyui_controlnet_aux`, `ComfyUI-KJNodes`, `rgthree-comfy`, `crystools`, `basic_data_handling` | instance utilities (preprocessors, QoL, monitoring) | environment, not product dependencies — no registry rows; the studio never requires them |
| `dlss5-nr`, `ComfyUI-llamaPrompt`, `intern_nodes`, trial shims (`t1/t2/t3/t3a/exp`) | maintainer's own experiments + LLM prompt prototype + the Intern contract seam (§4.3); shims are testbed-only, gitignored, never ship **[DOC]** | context, not registry rows |

---

## 2. THE CUT LIST (redundant across current choices — evidence per row)

1. **facok `comfyui-krea2-controlnet` on the Kreatine lane — SUPERSEDED.** Kreatine's own `control_loader.py` loads the same depth-control weights from the documented mechanism, license-clean, with the depth-conflict guard the facok pack lacks **[DOC: Kreatine ARCHITECTURE.md + THIRD_PARTY_NOTICES.md]**. Cut when the Krea lane adopts Kreatine; the row survives only for a non-Kreatine fallback arm.
2. **`comfyui-krea2-ostris-edit` — REDUNDANT where Kreatine runs.** The t=0 recipe is `KreatineReferencePatch`; the `index` recipe defers to core `ReferenceLatent` — the ostris pack's two classes duplicate both **[DOC: Kreatine README recipe-switch section]**. It is not in `ENGINE_NODE_PACKS` (correctly); it should not be added.
3. **`krea2-anypaint` standalone on the Kreatine lane — REDUNDANT.** Kreatine vendors prepare/encode byte-faithfully and replaces ModelPatch with its own forward **[DOC]**. Keep the upstream row only while `krea2edit.ts` emits the upstream classes.
4. **Image Studio's other 8 classes — DO NOT CALL.** Sampler/resolution presets duplicate core `MiniMaxH3SigmaShift`+`BasicScheduler`+our canvas math; `H3ImageFrameSelector` duplicates our app-side scorer; `H3WorkflowNote` is canvas docs **[DOC: h3-image-studio-pack-assessment.md §4]**. Adoption (`afvlbk4`) is scoped to the 4 load-bearing classes — hold that line.
5. **Duplicate crop-and-stitch on the shared instance.** `ComfyUI-Inpaint-CropAndStitch` (full repo) AND `comfyui-crop-and-stitch` (Kreatine-vendored subset, same author) are both installed **[DOC: ls + READMEs]** — one instance-level cleanup, the maintainer's call (8188 is his; we only note it).
6. **Nothing in the 9 current rows is cut outright this pass.** Challenge-everything was run: each row either carries a load-bearing class we emit (turbo, VDN, hybrid, krea2edit, anypaint, autocontext, form-adapter) or a charter-mandated seam (T8 audio, controlnet — superseded only on the Kreatine lane). The genuinely dead weight is the *missing* rows' inverse — see GAP-1/GAP-2 — not over-selection.

---

## 3. THE BRING-IN LIST (worth working around — cost named)

| # | Pack | Why | Working-around cost | STATUS |
|---|---|---|---|---|
| 1 | **astropuzzo Image Studio** (Unlicense) | T=1 legality, exact 9/13, slice decode — the only shipped fix for the stock floor (#15644) | Bus factor 1 (solo, fast cadence — v14→v23 in 4 weeks, quiet since 09-12); mitigations: pin + the ~150-line first-party port alternative | in flight (`afvlbk4`) |
| 2 | **Acly comfyui-tooling-nodes** (GPL-3.0) | the bridge transport + `model_info` model classification + regions/tiling machinery | GPL = runtime dependency only, never vendored; one more pack on the instance (already installed) | PROPOSED-PENDING-TEST (bridge lane, §4.3) |
| 3 | **VDN-H3-24GB** (installed) | 24GB-stack acceleration with validated AutoMemory policy | `*_24GB`-suffixed classes = separate detection anchors; launch-posture detection (`Start_VDN_H3_24GB.sh`) | task `9up52mj`, planning |
| 4 | **Motion Context + LBH rows** (not new packs — *registry rows for classes we already emit*) | close GAP-1/GAP-2 | license/pin verification at row time | **DONE 2026-09-21 (06jr4eh)** |
| 5 | **krea2t-enhancer** | Krea2 turbo prompt adherence | unverified quality, another pack | WATCH/PENDING-TEST |
| 6 | **Intern's contract-seam pattern** (our own code) | the Workbench↔editor bridge vocabulary (§4.3) | maintaining the param-node vocabulary; rename the `Anima*` prefix collision | note, not commitment |

Held at WATCH from the 2026-09-14 sweep (unchanged this pass, not re-litigated here): LongMedia latent-ops library, FL-MiniMaxH3 transitions machinery, Continuum N2B takes contract, MiniMaxH3Mod RefMod plumbing — the transitions/experiment lanes own those adoptions; this registry defers to `h3-node-ecosystem-sweep.md` §4 and will absorb them as rows when those lanes become product.

---

## 4. THE COMMUNICATION AUDIT — are we talking to Comfy the right way?

Ground truth: the two devdocs captures (comfyui-api @ `a87667f`/0.34.0, manager-api @ 4.2.2, both 2026-09-20) **[CAP]** + code reads of `server/core.ts`, `server/realtime.ts`, `server/objectInfoProbe.ts` **[DOC]**.

### 4.1 Confirmations (our patterns vs the contract)

| Our pattern | Verdict |
|---|---|
| `POST /prompt` always carries `client_id` = the hub's stable server-side id (`core.ts:2314-2336`; the hub registers the same id on `/ws?clientId=` and keeps it across reconnects) | **CORRECT and stronger than the ecosystem norm** — per-prompt events are dropped entirely for submitters that omit it (`execution.py:677-684`) **[CAP]**; a stable id also survives prompts submitted before a reconnect |
| Terminal-signal derivation: `job_done` from `execution_success`/`execution_error`/`execution_interrupted`, never from a null-node `executing` | **CORRECT at 0.34.0** — re-verified this pass at the shared install: the only `executing` emissions are per-node starts (`execution.py:496`) and the reconnect catch-up (`server.py:290`); `execution_success` is the completion signal (`execution.py:824`) **[DOC]**. Notably Krita's client still treats `executing node=None` as completion — the classic-era pattern; harmless where it still works, stale here. Ours is the contract-correct form |
| Targeted `/object_info/{node}` probes with TTL cache, absence = key-miss on HTTP 200 `{}` (`objectInfoProbe.ts`) | **CORRECT** (`server.py:813-819`) **[CAP]** — and the polite form (batch ≤6, off the main loop) |
| Best-effort `POST /refresh` + mandatory `/models`+object_info re-fetch | **CORRECT** — there is no `/refresh` route at this revision; the re-fetch *is* the semantics (devdocs addendum, Wave 2 R-12) **[CAP]** |
| Interrupt: `POST /interrupt {prompt_id}` (only-if-running) + `POST /queue {delete:[id]}` for pending (`core.ts:1219-1227`) | **CORRECT and more precise than Krita** (which sends a global interrupt + queue delete) |
| `/free {unload_models, free_memory}` between phases; `/system_stats` health/adopt probe; `/upload/image` multipart; `/view` pinned to the configured origin; server-side funnel with SSRF/local-only guard | **CORRECT** per capture §0/§4/§8 **[CAP]** |
| History: WS `executed` events land images in-app (bridge extracts filename/subfolder/type, `realtime.ts:150-163`) with the `useGenerationQueue` history poll as backstop | **CORRECT (WS-first)**; the backstop must stay prompt — history evicts oldest past `MAXIMUM_HISTORY_SIZE` **[CAP §3]**, so long jobs land via WS, never via a late poll |
| Realtime hub engineering: per-client backpressure outbox (JSON FIFO + drop-count overflow notices; previews newest-wins per job hash; seq numbers → resync), 30s ping, upstream reconnect with backoff while interest remains | **GOOD — exceeds ecosystem practice** (Krita reconnects but has no backpressure story) |

### 4.2 Corrections / named divergences

1. **The Manager-first install path is NOT BUILT.** Directive `ffcff765` makes Manager the preferred installer; grep confirms zero Manager API calls in `server/`+`src/` — today everything is our consent-gated fetch-and-place (`fetcher.ts`) **[DOC]**. The v4 task-queue recipe is captured and ready (`POST /v2/manager/queue/task`, presence probe = `/features → extension.manager`) **[CAP manager §5]**. Two build notes: the shared instance has Manager **absent** (pip package not installed, no `--enable-manager`) so the probe will honestly answer "fall back" there; and Manager installs are eventually-consistent (queue → WS `cm-queue-status` → restart → re-probe object_info) — the pack board must model that intermediate state. Manager 4.3 (tag 2026-09-18) remains undiffed — the capture's verify-on trigger stands; noisy web search this pass produced nothing trustworthy on it.
2. **We never send the WS `feature_flags` first message**, so upstream preview frames arrive as the metadata-less binary form (event 1) — preview-to-job attribution is inferred from `activePromptId` rather than carried per-frame. Declaring `supports_preview_metadata` (event 4: `node_id`/`prompt_id` per preview) is a cheap, named improvement for multi-job preview routing **[CAP §7]**.
3. **`minimax_h3_preview_override` — producer IDENTIFIED (closed 2026-09-22, task t6vub9k).** `realtime.ts`'s consumer was built for the **simsim9-stack PreviewOverride pack** (§1.1 row): its OUTER_SAMPLE wrapper is the emitter (`PromptServer.instance.send_sync("minimax_h3_preview_override", …)` per step — the payload fields match the consumer's parse exactly, including the three mimes). The pack was absent from the shared install at the 2026-09-21 pass (it lives on the maintainer's own instance) — hence "no locatable producer." With the pack row + path preference landed, the consumer is fed; the debug-suite flag retires.
4. **Client-minted `prompt_id` is now honored by core** (validated UUID ⇒ used) **[CAP §1]** — we let the server mint. Fine today (our job records key the correlation); minting client-side would let the UI track a job before the POST returns. Optional, logged.
5. **Jobs API unused.** `GET /api/jobs`, per-job cancel (`POST /api/jobs/{id}/cancel` — idempotent running⇒interrupt/pending⇒dequeue) exist at this revision **[CAP §6]** and model our interrupt+delete pair as one verb. Adoption optional — our two-call form is correct; the jobs API is the cleaner surface if we ever paginate server-side job history.

### 4.3 Acly's Krita plugin as prior art (the named study)

Fetched from source 2026-09-21 (`backend/comfy_client.py`, v1.53.0 line; 10.6k★, GPL-3.0, active) **[DOC]**. What it teaches about "talking to Comfy the right way":

- **Client-side orchestration:** ONE active job slot (max parallel = 1) gating the server queue; a priority client queue with front-jump; `execution_start` promotes waiting→active; progress weighting `0.2·node + 0.8·sample` so the bar never reads 100% before images. *Lesson:* single-in-flight is the discipline a 24GB-shared-GPU shop actually wants — matches our queue model and the runbook's contention guard.
- **Transport split:** control+results over HTTP, previews over the WS binary stream — but **images never touch multipart `/upload/image`**: inputs go `PUT /api/etn/image/{id}` (in-RAM cache, often faster for large images), results come back `GET` on the same cache when `executed` lists `source=="http"` entries. **No `/history` use at all.** *Lesson:* for editor-size payloads the ETN cache beats stock upload/view; worth a latency test before our Workbench moves big canvases.
- **Resource detection = the instance registry:** required custom-node packages checked class-by-class against `object_info`, failures reported with the package URL; models discovered from loader-node combo enums. *Lesson:* independently converges on our registry-only directives (`2987ef3e`/`ffcff765`) — the pattern is validated by the most-deployed external client in the ecosystem.
- **Document-state sync:** the Krita document is the source of truth (layers→regions, selections→masks); the plugin compiles it into graphs at dispatch. The `api/etn/workflow/subscribe` pub/sub pushes shared workflows to subscribed editors.
- **Its stale edge:** completion via `executing node=None` (classic-era; not emitted at 0.34.0) — a caution that even flagship clients drift against core; our capture-pinned bridge is the discipline that avoids this class.

**The Monoka bridge idea — viability read (a note, not a commitment).** VIABLE and already three-times-proven in material we control or run: (1) Krita's client orchestration (above); (2) Acly's ETN transport pack — GPL-3.0, installed on the shared instance, provides the in-memory image path both directions; (3) **the maintainer's own `intern_nodes`** — the *contract seam* pattern: a workflow authored in ComfyUI as data, the editor reads the contract keyed on `class_type` (`AnimaParam`/`Image`/`Mask`/`Context`/`Output`), auto-builds typed UI, substitutes values + base64 at dispatch, drops the seam nodes, and runs standalone with declared defaults **[DOC: intern README + §1.7]**. A Monoka bridge would ride on exactly what we already have: our HTTP/WS hub (§4.1) + ETN endpoints + the Intern vocabulary (or a Monoka-flavored rename). What it buys: the Workbench's both-directions data flow (directive `56cfded0` — pull-from/push-to workbench) extended to *external* editors without per-editor app code. Costs: GPL boundary (runtime dep only — fine), a maintained param-node vocabulary, and dispatch-time injection hardening (we already gate uploads). **Recommendation: fold a bridge-seam study into the Workbench spec round; do not build ahead of it.**

---

## 5. KREATINE — the maintainer's two-stage sampler

**Design intent, verbatim from directive `519ffa6c`:** *"KREATINE — the maintainer's own two-stage sampler ('Early steps run on raw, for seed diversity and better composition. Later steps and convergence runs with turbo injected, and a proper sigma handoff… I designed it to support things like prompt weighting — true negative on the first stage, and prompt weighting that takes those negatives and positives and makes them work for turbo'). It is the intended KREA path."*

**Code reality** (read at `vendor/ComfyUI-Kreatine`, 2026-09-21) **[DOC]**: `KreatineTwoStageSampler` — model/clip in, canvas size (sets the stage-1 **raw shift**: token-count-linear 0.5–1.15, `_krea2_raw_shift`), weighted positive/negative text (`weight_strength` 0–4 global multiplier; per-token parsing from Kijai lineage), `turbo_lora` **applied to stage 2 only**, loaded once and cached, `turbo_strength` (−10..10), `handoff_percent` (default **16.67** — "0% = stage 2 only; 100% = stage 1 only"). The handoff is sigma-exact: `_nearest_schedule_index` aligns the stage boundary to a real schedule grid point; `_force_full_denoise_handoff` ends stage 1 at σ=0 with fresh stage-2 noise whenever a `noise_mask` is live (measured: the carry handoff corrupts the known region, rel-err 9.6; forced full denoise = 7.2e-08 — phase-0 numbers in `core/schedules.py`); i2img truncation is grid-native (deliberate divergence from stock re-spacing). **Single-model residency** — the base checkpoint stays in VRAM between prompts (original; avoids per-prompt clone-detach reload). Provenance headers: schedule math from Auryg's Krea-2-Two-Stage-Sampler (MIT), per-token weighting from Kijai (GPLv3), residency original.

**Slot:** the KREA path — composes with the Krea-2-stills lane (the charter's `mf3wfq2` "Krea 2 stills + Kreatine two-stage"; id unresolvable in Flux at capture time — re-verify at dispatch). The bridge into Monoka: a `ENGINE_NODE_PACKS` row when the lane lands + a `krea2` `MODEL_FAMILIES` entry (its slots: base/turbo checkpoints, Qwen TE, image VAE, the anypaint/control adapters).

**License decision point:** Kreatine is GPLv3 and **the maintainer's own copyright** — the "never vendor GPL" discipline exists to avoid coupling releases to third-party contributor sets; here the contributor set is us. Options at row time: (a) user-fetch like T8mars (uniform, no special case), (b) first-party install from the Kreatine repo payload (it is effectively first-party code), (c) dual-license the pack for Monoka's use. Maintainer's call; the registry row should record which and why.

---

## 6. THE TWO-STAGE BENCHMARK HYPOTHESIS — tested, never assumed

The maintainer's explicit framing: the two-stage pattern *"is likely a pattern we can replicate with other models, even H3. The quality and speed difference from this approach will likely need to be TESTED RATHER THAN ASSUMED."*

**Experiment: `TS-1 — two-stage turbo handoff vs plain turbo`** (benchmark-harness suite candidate). Matched arms, one variable (the schedule):

- **Arm A (incumbent / neutral baseline):** plain turbo — adapter on from step 0, N steps (Krea: 8-step turbo; H3: the lane's current 4/8-step pairing).
- **Arm B:** two-stage — raw stage 1 to handoff *h* (default 16.67%), turbo injected at the sigma-aligned handoff, stage-2 fresh-noise rules per `core/schedules.py`.
- **Arm C (reference ceiling):** raw full run, no adapter (quality anchor, not a candidate).
- **Axis D (follow-up):** handoff sweep *h* ∈ {10, 16.67, 25, 33, 50}% — only if B beats or ties A.

**Measures — which golden domains own which axis:** composition/seed-diversity (fixed prompt set × K seeds; cross-seed structural spread — pose/layout clustering) on the composition domains; convergence quality (scorer/sharpness/texture rows + fidelity-to-source where applicable) on the refine/detail domains; wall-clock + NFE always. Every metric row ships with its known-limits label (§7).

**Order of operations:** Krea first (the machinery exists — zero build, direct TS-1), H3 second (needs stage-2-only adapter injection on H3: the larryvrh `MiniMaxH3TurboSampler` path or a first-party H3 two-stage node pattern-copied from the maintainer's own GPLv3 code — license-clean, he owns it; the LBH upscale path already exercises `SplitSigmas`+refine-sigma machinery on H3, so the graph grammar exists). **STATUS: hypothesis, PROPOSED-PENDING-TEST.** If B loses on both quality axes and wins nothing on wall-clock, the pattern stays Krea-only and the H3 port is never built.

---

## 7. What the assessment workspace must show (requirements input for `txv4fqv`)

From the registry side, the maintainer's verify step needs on screen — per experiment, per run:

1. **The arms side-by-side, seed-matched.** Arm A/B/C grids where each column is one arm and rows are matched seeds/prompts — never "open example, switch, remember."
2. **Metric rows with known-limits printed.** Every metric label carries what it *cannot* see (e.g., "sharpness: blind to composition; scorer: calibrated on H3 stills only") — the direction-audit verdict-card discipline.
3. **The verdict card, one screen:** the claim under test (the row's THEORY verbatim), the result rows, **what was NOT tested**, and the adopt/reject ask — so the decision is a click on a stated question.
4. **Blind-pair mode** for calibration rounds: arms presented unlabeled, reveal after the pick.
5. **Past-run comparison:** the append-only results registry as browsable history — this run vs the last run of the same suite, same arms, drift visible.
6. **The fallback ladder visible:** for any PROPOSED-PENDING-TEST row, its VIABLE-ALTERNATIVES list sits next to the verdict — "reject B, try the next one" is one click of intent, not a new research pass.
7. **Provenance on every artifact:** which commit, which engine revision, which pack pins produced a given arm — the recheck-on story depends on it.

(UI design is `txv4fqv`'s job; the above is the experiment-side requirement set.)

---

## 8. THE A-3 JOIN — the family-entry data shape

So Wave 3's family registry absorbs this document **as data** — a new family arrival ("where it lives, what it is for, why, what nodes belong to it") is one entry:

```ts
type FamilyEntry = {
  id: string                      // 'minimax' | 'h3image' | 'krea2' | 'klein' | 'anima' | 'music3' | 'acestep' | <future>
  label: string
  status: 'active' | 'planned' | 'retired'
  purpose: string                 // what it is FOR
  why: string                     // why this family exists here
  workspaces: ('wiring' | 'control' | 'workbench')[]   // the three-surface map
  slots: ModelOverrideSlotName[]  // the existing MODEL_FAMILIES shape — unchanged
  stockSurface: string[]          // core node classes the builders emit (no pack owns these)
  packs: Array<{
    packId: string                // ENGINE_NODE_PACKS id — one source of truth
    role: string                  // 'engine-side machinery' | 'loader' | 'adapter' | 'sampler' | 'transport' | ...
    nodeClasses: string[]         // the load-bearing subset actually called
    theory: string                // testable claim
    testPlan?: string             // suite id + arms (e.g. 'TS-1')
    status: 'PROPOSED-PENDING-TEST' | 'ADOPTED-TESTED' | 'SUPERSEDED-BY' | 'REMOVED'
    alternatives: string[]        // the fallback ladder (pack ids or 'first-party port')
    lastVerified: string          // ISO date
    supersededBy?: string         // packId when status says so
    recheckOn: string[]           // symptom | event | calendar triggers
  }>
}
```

Join rules: `packs[].packId` must resolve in `ENGINE_NODE_PACKS` (the install machinery never duplicates); `slots` stays the `modelOverrides.ts` contract; the graph builders' emitted classes = the union of `stockSurface` + every active `packs[].nodeClasses` — which makes **GAP-class errors (emitted-but-unrowed classes) mechanically detectable** by a test that diffs builder output against the registry. That test is this document's best defense against rotting.

---

## 9. EXAMINED LEDGER (everything this pass looked at — so the next pass doesn't rediscover)

**Our registry rows (9/9 re-challenged + 2 gap rows added):** vdn-h3 · lora-form-adapter · minimax-h3-turbo · h3-hybrid-loader · krea2-controlnet · h3-audio-t8 · krea2edit · krea2-anypaint · autocontext — verdicts in §1; none cut outright; two superseded-on-a-lane. **h3-motion-context · lbh-latent-upscaler added 2026-09-21 (06jr4eh). h3-preview-override added 2026-09-22 (t6vub9k — the maintainer-endorsed preview-decoding path, pulled forward from the curation queue; deep-read preview-override-assessment.md; §4.2 item 3's producer hunt closed by the same pack).**
**Gaps found:** Motion Context (no row, chain lane) · LBH upscaler (no row, no pin) — **both closed 2026-09-21 (06jr4eh)** · Kreatine (no row, pending lane) — §1.1/§1.3/§5.
**Shared-instance inventory (28 dirs, read-only):** the 9-row overlap above + ComfyUI-VDN-H3-24GB · ComfyUI-H3-Motion-Context · comfyui-krea2-ostris-edit · krea2t-enhancer · ComfyUI-Kreatine · anypaint · comfyui-krea2-controlnet · comfyui-krea2edit · ComfyUI_MinimaxH3HybridLoader · ComfyUI-MiniMax-H3-Turbo · intern_nodes · ComfyUI-llamaPrompt · comfyui-tooling-nodes · lora-manager · ComfyUI-KJNodes · rgthree-comfy · crystools · dlss5-nr · basic_data_handling · comfyui_controlnet_aux · LanPaint · comfyui-inpaint-nodes · ComfyUI-Inpaint-CropAndStitch · comfyui-crop-and-stitch · trial shims ×5 (testbed-only) — dispositions in §1.7/§2.
**Ecosystem (via the 2026-09-14 sweep + freshness checks this pass):** Image Studio v23.0.0 still latest (2026-09-21) — assessment current; the sweep's WATCH tier unchanged (LongMedia, FL-MiniMaxH3, Continuum, MiniMaxH3Mod, GENKAIx, SingleFrame, AIMixer, Director-Cut-Studio, TaoMate, Viggle, VDN/FastH3/Tutu speed packs, prompt-rewriter cluster); passed: jajos12 metrics pack (no license, generic, stale).
**External clients/transport studied:** Acly/krita-ai-diffusion (v1.53.0, 2026-08-22; 10.6k★, GPL-3.0, active) · Acly/comfyui-tooling-nodes (672★, GPL-3.0) · Intern `intern_nodes` (ours). 
**Communication surfaces:** ComfyUI core `a87667f`/0.34.0 + Manager 4.2.2 captures **[CAP]**; Manager 4.3 tag exists (2026-09-18), undiffed — web search 2026-09-21 produced nothing trustworthy; treat the capture's verify-on trigger as standing.
**Not examined this pass (owned elsewhere):** the trainers (Fizgig/Musubi/Ostris — Workbench LoRA lane), SeedVR2 burst (E-IW2), NLE (skipped verdict stands), Klein/Qwen model quality (untested on testbed).

---

## 10. RECURRENCE — when this document re-runs

| Trigger | What re-runs |
|---|---|
| **Pre-spec-round** (Workbench / Control Center / any family-touching design) | the affected families' rows re-challenge incumbents; new alternatives logged |
| **New-family arrival** | one `FamilyEntry` (§8) + the §0 row schema for every pack it brings; the builders-vs-registry diff test extends |
| **Quarterly** | full pass: ecosystem freshness (the sweep's method), license/pin re-verification, superseded rows closed |
| **Symptom** (a pack misbehaving against its captured contract; an engine version bump; a validation refusal) | the row's `recheckOn` fires; devdocs captures re-verified first, then the affected rows |
| **Negative-availability claim** (any "none shipped / not available / not yet in X / no community Z" recorded in our docs) — *added 2026-09-26, the Viggle-gate lesson* | the claim's **ecosystem-scope check** re-runs and its evidence line updates: community quant/conversion repos (the family's known converter orgs + an HF model-name search), the docs.comfy.org changelog delta + the ComfyUI-Manager index, the upstream repo's file tree **and open PRs** (half-shipped = "closer", recorded as such), top pack authors' releases — sources + date recorded beside the claim. Canonical rule text: assumption-register pass 2 §P2.6 |

Every re-run updates `lastVerified`, closes what died, and **appends to the examined ledger** — the registry is the memory of what we have already looked at.

---

### Corrections/decisions this feeds

1. **Two missing pack rows** (Motion Context, LBH upscaler) — load-bearing builder dependencies with no detection/install/license record; fix is two `ENGINE_NODE_PACKS` rows.
2. **`minimax_h3_preview_override` producer hunt — CLOSED 2026-09-22 (t6vub9k):** the simsim9-stack PreviewOverride pack is the emitter; row + path preference landed (§1.1, §4.2 item 3).
3. **Manager-first install build** — the named gap vs directive `ffcff765`; recipe captured, shared instance will probe "absent" (no Manager there).
4. **Kreatine license decision** (§5) + its registry row when the Krea lane lands; **facok controlnet + ostris-edit + standalone anypaint** supersede/cut on that lane.
5. **TS-1 suite candidate** (§6) — Krea first, H3 port only if the hypothesis survives; the assessment workspace (§7 → `txv4fqv`) is the verify surface.
6. **The §8 builder-vs-registry diff test** — the mechanical guard against the next GAP-class error.

---

## 11. ADDENDUM 2026-09-26 — the maintainer's instance packs: the examined-ledger gap closed (task `pbs36kv`)

> **Provenance.** The 2026-09-25 reality audit + environment-mirror session established that the maintainer's real instance runs **five foreign packs**: PreviewOverride (examined 2026-09-22, task `t6vub9k`) plus four this registry had never examined — **comfyui-lora-manager**, **comfyui-h3-multishot**, **one-node-minimax-h3**, and **comfyui-videohelpersuite** (VHS). Two of the maintainer's crash traces put three of them on the radar by name (lora-manager's metadata hook in both traces; VHS's latent-preview wrapper in the null-deref class). This addendum closes the gap. **Method:** local code read of the vendored lora-manager (GPL-3.0 verified; pinned `77109b3c`, the Kreatine vendor checkout symlinked into the shared install — the only pinned copy we hold; their instance's own revision is unrecorded, pin at the next mirror pass); GitHub reads at pinned revisions — multishot `d7d1977` (2026-08-27, v2.7.2), one-node `2ba3a2e` (2026-08-18), VHS `4d907be` (2026-09-02); the mirror capture (`e2e/mirror/profiles/maintainer-instance.json` — five `customNodeDirs`; foreign class names there are explicitly *approximations*); our stack reads (`h3Submit.ts`, `server/core.ts:2446`, `graph/h3image.ts:1281`, the landed preview route). No GPU, no engine, no installs; 8188 untouched. The crash traces themselves were not re-read this pass — trace-derived premises carry **[COMM]**; everything else is **[DOC]** at the pinned revs. No row above changes; this section is append-only.

### 11.0 The epistemic correction, stated first

**Crash-trace presence ≠ causation.** Two of the four packs were implicated *by visibility*: lora-manager's hook wraps **every node execution** (§11.1), so its frames sit on any stack trace that instance can produce; VHS's wrapper sits on every preview-construction call (§11.4). The one *verified* defect class — the null-deref preview crash — lives in the **stock `latent_preview` construction seam** (arbitrary `taeh3*` prefix-match winner → sight-unseen TAEHV construction → decode against whatever bytes won the slot), already analyzed at [preview-override-assessment.md](preview-override-assessment.md) §2 with VHS's wrapper as the interplay *surface*, not the cause. Future traces from that instance get read hook-aware.

### 11.1 ComfyUI-Lora-Manager (willmiao) — **GPL-3.0**, examined at `77109b3c`

| Field | Finding |
|---|---|
| What it is | LoRA browser/manager suite: ~20 `*LM` node classes (`LoraLoaderLM`, `LoraStackerLM`, `SaveImageLM`, … — the mirror's `LoraManagerList`/`LoraManagerLoader` approximate this surface), PromptServer HTTP routes registered at import (`LoraManager.add_routes()`), Vue widgets. On the shared instance it is a symlink into the maintainer's own Kreatine vendor tree |
| **The load-bearing part** | `py/metadata_collector/metadata_hook.py`: at engine import it monkey-patches `execution._map_node_over_list` (or `_async_map_node_over_list`, detected by coroutine check) — the wrapper records every node's inputs before and outputs after the main `FUNCTION` call into a singleton `MetadataRegistry` (3-prompt history), recovering node ids by walking `inspect.currentframe()`. Consumers: `SaveImageLM` (civitai-compatible generation params embedded in PNG/EXIF), `MetadataOverwriteLM`, the recipes/routes API |
| Observe or mutate | **Observe-only** — values pass through untouched, every collection step try/except-swallowed (logged, execution proceeds). It cannot alter results; it adds frames, per-node overhead, and retention |
| Removal blast radius (their instance) | The engine starts fine without it (the hook fails soft when core's private function names change — a core refactor silently disables collection with a warning). Costs of removal: Kreatine's `KreatineLoraBridge` persistence degrades (by design — the Native+ rule never requires it); `SaveImageLM` workflows lose embedded metadata |
| Interaction with OUR stack | None on the wire — we emit no `*LM` classes (zero registry rows, zero builder emissions). The hook does ride OUR jobs on a carrying engine: per-node overhead (frame-walk + dict copies) and a bounded memory hold — the registry retains the last 3 prompts' records **including at least one decoded image tensor by reference** (`get_first_decoded_image` returns tensors as-is); latent tensors are recorded by shape only (`BaseSamplerExtractor`). A real, bounded retention surface on a 24GB-shared-GPU box |
| Verdict | **WATCH — environment, not product dependency.** §1.7's row stands, now with the mechanics examined. GPL-3.0 → runtime-only forever, never vendored by us. No `ENGINE_NODE_PACKS` row, no registry.md row (policy.md: rows ride *our* adds/fetches — this is neither) |

### 11.2 ComfyUI-H3-Multishot (jlucasmcrell) — **MIT**, examined at `d7d1977` (v2.7.2, 2026-08-27; 65★ — context)

| Field | Finding |
|---|---|
| What it is | Seamless multishot chaining ("no visible cuts, no colour shift, unbroken audio"): `H3MultishotSampler`, `H3MultishotMemorySampler`, `H3Retake`, `H3AutoRefs`, `H3ExtendTake`, `H3ChainNormalize`, `H3KeyframeInject`, Rift prompt source/picker + a bundled-**modified** JoyEcho LLM writer, a GGUF arch patch, a dual-format loader. (The mirror's `MiniMaxH3MultishotSampler`/`…RefSelect` are approximations; these are the real names.) |
| **`h3_avbank_probe.py`** — the named wrapper | Monkey-patches `comfy.model_base.MiniMaxH3.extra_conds`: calls the original, then **merges** keyframe latents + reference latents into the `minimax_payload` conditioning entry's `cond_video_latents` (stock `extra_conds` **overwrites** — refs silently lost whenever keyframes are present), forwarding `cond_audio_latents` and `frame_count`. **Pass-through for stock conds** — no `minimax_keyframes`/`minimax_refs` in the conditioning ⇒ the original's output returns unchanged |
| Ownership coordination | Sets/reads the `_h3_motion_context_payload_patch` marker and **stands down if a Motion-Context-compatible patch already owns the method** (self-flag `_h3_avbank_merge`). Whoever imports first owns the patch; cohabitation with MC-MultiRef is by design, not luck |
| Removal blast radius (their instance) | It is currently the **sole owner** of the extra_conds merge there (no Motion-Context flavor installed — §11.5): removal breaks every `H3KeyframeInject` chaining workflow and restores the stock overwrite bug |
| Version sensitivities | Its own preflight pins **base** Motion-Context at 0.3.1 and refuses 0.4.0+ — directly at odds with one-node's preference for MC-**MultiRef** and its warning on base MC (§11.3). Neither flavor is on the mirrored instance |
| Interaction with OUR stack | The patch is process-global on the model class — every H3 generation on a carrying instance passes through it; ours are pass-through **[DOC]**. Our chain lane runs on the shared instance, where **nothing** patches extra_conds (base MC v0.6.2/`5335715` does not — verified: only its test stubs reference the method) |
| Verdict | **environment / WATCH.** The multishot *capability* (native H3 multi-shot prompting — `ecosystem-2026-09.md`) is a Workbench-lane question that does not need this pack's chaining machinery. If a lane ever adopts keyframe+ref merge machinery, the **ownership-marker pattern** is the pattern-adopt, and the row goes PROPOSED-PENDING-TEST at that point |

### 11.3 one-node-minimax-h3 — **GPL-3.0**, examined at `2ba3a2e` (AIFSH/OneNode-MinimaxH3, 2026-08-18)

- **Identification:** dir name + one-node premise + class `H3OneNode` (the mirror's `MiniMaxH3OneNode` ≈) → **AIFSH/OneNode-MinimaxH3**, a fork of LeonQ8/ComfyUI-ALLinONE-MinimaxH3 (upstream active 2026-09-25, 333★ — context). **Not byte-confirmed against their checkout** — the mirror's five-dir inventory is session evidence, not an `ls`. Pin at the next mirror pass.
- **Classes:** `H3OneNode`, `H3CacheBust`, `H3IdentityAnchor`, `H3AudioTrim`, `H3AudioSlice`, `H3OneSigmaRefiner`, `H3NestedLatentUpscaler` — one node = the whole pipeline (Chain/T2V/I2V/R2V/Keyframes/Extend, Audio Lock lip-sync, latent-upscaler panel, sigma refiner, two-pass refine).
- **The "wraps extra_conds" premise, CORRECTED** — it does **not** patch extra_conds itself. At import it path-joins into the **sibling pack dir** `ComfyUI-H3-Motion-Context-MultiRef/patch_payload.py` and calls `apply_patch(require_merge=True)`. MultiRef is **absent** from the mirrored inventory → the repair prints "keyframe+ref payload repair unavailable" and stands down. **Today, on their instance, one-node wraps nothing** — the wrapper exists only when MultiRef is installed. Every failure path degrades (try/except + prints); the import never crashes.
- Runtime cross-imports: `H3NestedLatentUpscaler` hard-imports **our GAP-2 pack** (LBH upscaler, pinned `40316cf`) inside `run`; VHS is an optional ffmpeg-locating probe only.
- **Removal blast radius:** its own all-in-one workflows; nothing of ours. **Interaction with our stack:** none on the wire. **Verdict: environment / WATCH**, identification caveat recorded.

### 11.4 ComfyUI-VideoHelperSuite (Kosinkadink — note the spelling) — **GPL-3.0**, examined at `4d907be` (2026-09-02; 1.85k★ — context)

- **What:** video I/O (`VHS_LoadVideo`, `VHS_VideoCombine`, the `VHS_FILENAMES` output type), batch ops, ffmpeg-based advanced previews.
- **The preview wrapper** (`videohelpersuite/latent_preview.py` + `utils.hook`): at import, `@hook(latent_preview, 'get_previewer')` setattr-replaces core's `get_previewer` (`functools.update_wrapper` preserves the original at `__wrapped__`). Per call it (1) **invokes the original first** — the stock construction site (including the arbitrary `taeh3*` prefix-match winner) still executes *under* the wrapper, which is why VHS frames appear in preview-crash traces; (2) returns the original previewer **unchanged** unless the *workflow's own extra info* sets `VHS_latentpreview: true` — an opt-in **we never send** **[DOC: our `extra_data` carries only `preview_method`; zero `VHS_latentpreview` anywhere in the repo]**. When active, `WrappedPreviewer` decodes on an async thread and **returns `None` from `decode_latent_to_preview_image` by design** (frames travel via `send_sync`) — any consumer assuming a synchronous non-None preview image breaks; its `rates_table` has no MiniMaxH3 entry (default 8); unsupported previewer types raise in `__init__`.
- **Double-wrap fragility:** `hook` has no chain guard, and `update_wrapper`'s `__dict__` copy can clobber a prior wrapper's `__wrapped__` — exactly the seam the PreviewOverride pack's `_get_core_previewer` walk (to the unwrapped core function) defends against **[DOC: preview-override-assessment §2]**.
- **Interaction with our stack:** the stills lane already forbids `VHS_VideoCombine` in workbench graphs (`H3IMG_FORBIDDEN_VIDEO_NODES`, `graph/h3image.ts:1281`); the override-first preview route landed in `t6vub9k` (with `preview_method` suppressed for override graphs) is the structural immunization; stock-path renders on a wrapper-carrying instance remain the fragile arm — the sha-pinned Kijai decoder row is that arm's mitigation.
- **Removal blast radius (their instance):** multishot/one-node export steps that call `VHS_VideoCombine`; one-node's ffmpeg probe degrades. Nothing of ours. **Verdict: environment / WATCH.** GPL-3.0 → runtime-only; no row.

### 11.5 The ownership map (what owns what, per pack set)

| Instance / pack set | `MiniMaxH3.extra_conds` owner | `get_previewer` | Execution wrapper |
|---|---|---|---|
| **Maintainer's (the mirrored five):** PreviewOverride + one-node + multishot + lora-manager + VHS | **avbank probe** (multishot) — sole owner; one-node stood down (MultiRef absent) | VHS wrapper installed, **inert for our graphs** (opt-in flag never sent); PreviewOverride graphs carry their own decode | lora-manager hook on every node |
| Same + Motion-Context-MultiRef installed (one-node's full recipe) | MultiRef's `patch_payload` (marker wins; avbank stands down — compatible by design) | same | same |
| **Our shared instance** (`/home/agent/comfyui`): base MC v0.6.2, no VHS/multishot/one-node, lora-manager symlinked | **nothing** (base MC does not patch — verified) | nothing (no VHS) | lora-manager hook (the symlink) |

Two instances, two regimes — and our emitted graphs are pass-through/inert in both. That is the load-bearing conclusion of this addendum.

### 11.6 Rows this pass does and does not create

**None.** All four are environment, not product dependencies: no `ENGINE_NODE_PACKS` rows, no `docs/licenses/registry.md` rows — policy.md requires rows to ride *our* adds/fetches, and we add and fetch none of these (two GPL-3.0 runtime-only by rule; two MIT — if a lane ever adopts one, the row + fetch-consent machinery lands with that decision). §1.7's lora-manager WATCH row is thereby promoted from "not examined" to examined.

### 11.7 UNEXAMINED-NEXT (the co-install surface — none of these are on the mirrored five-dir inventory; all would ride a fuller multishot/one-node install)

From **multishot's** README: `ComfyUI_JoyAI_Echo_GGUF_Nodes` (bundled **modified** in its release zip — license unread), base Motion-Context pinned 0.3.1 by its preflight (conflicts with one-node's MultiRef preference), `RES4LYF` (beta57), `ComfyUI-sol-attn`, `comfyui-minimax-h3-blockcache-T8` (T8mars — same author as our h3-audio-T8 row), `ComfyUI-Custom-Scripts`, `comfyui-inspire-pack`. From **one-node's** README: `ComfyUI-H3-Motion-Context-MultiRef` (seitanism, GPL-3.0 — **the actual extra_conds patch owner in its recipe**; pin `0719855` on core 0.32), `comfyui-vrgamedevgirl` (Audio Lock), upstream `LeonQ8/ComfyUI-ALLinONE-MinimaxH3`. **Caveat:** the five-dir mirror inventory is assembled from session evidence — if their real instance carries more, this list is the likely residue; the next mirror pass reconciles.

**Examined this pass (ledger extension):** lora-manager @`77109b3c` (local, GPL-3.0) · ComfyUI-H3-Multishot @`d7d1977` (web, MIT) · OneNode-MinimaxH3 @`2ba3a2e` (web, GPL-3.0, identification caveated) · ComfyUI-VideoHelperSuite @`4d907be` (web, GPL-3.0) · base Motion-Context v0.6.2 extra_conds negative check (local) · VHS `utils.hook` chain semantics (web). Crash traces: **[COMM]** summaries only, not re-read.
