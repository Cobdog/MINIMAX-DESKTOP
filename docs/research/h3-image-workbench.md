# H3 Image Workbench — compose/merge from many images, the edit taxonomy per path, refmod+LoRA stacking, refinement, and the start-frame handoff

> Compiled 2026-09-18 (Flux task `lrw11bb`). Research pass feeding the H3 Image Workbench spec round. The maintainer's binding vision (directive, 2026-09-18): **both paths go in** (frame-packet default + T=1 fast profile); the workbench's purpose is **dialing in ONE strong starting image** — remix/merge/combine a BUNCH of images; the edit taxonomy is broad ("faceswap, background swap, pose mirroring, outfit changes, lighting changes, you name it"); refmods and LoRAs combine onto the image path; output feeds video (start frames for FL2VA/Ref2VA chains).
>
> **METHOD:** app code read via the jcodemunch index (poserig, canvas store/ops, krea2edit.ts, form-adapter nodes, ContactSheet) at HEAD of `feat/design-decisions`; the three H3-image node-pack READMEs (ethanfel / thaakeno / astropuzzo) **re-read fresh today** — they have moved since the 2026-09-14 foundation doc; official Comfy.org multiframe tutorial fetched today; the malcolmrey RefMod stacking guide fetched today; community evidence via search + one full thread read (Reddit blocks direct fetch for most threads — noted inline where a claim rests on a search snippet rather than a full read). Tags: **[DOC]** verified in shipped code / official docs, **[COMM]** reputable community claim, **[MAINTAINER]** maintainer's own hands-on position, **[inferred]** plausible-unverified reasoning over verified facts (house synonym of [SPEC]), **[UNK]** nobody documents it.
>
> Relationship to prior docs (NOT re-researched here): `h3-instruction-based-editing.md` §4 (the two paths, the three packs as of 09-14, preservation contracts — THE foundation), `speed-quality-and-imagegen-paths.md` §3 (Krea 2 / Klein path cards + the §3.5 hand-off design), `fun-control-input-surface.md` (DWPose/AP-10K wire format, the poserig contract), `h3-transitions-and-latent-continuity.md` §4 (reference pipeline + RefMod prior art), `h3-node-ecosystem-sweep.md` (Luisacaotica RefMod pack, scottmudge hybrid loader, FL per-block LoRA), `h3-lora-form-compatibility.md` (the form-adapter), `krea2-edit-mode.md` (Krea 2 edit families + the small-targeted-graphs shape our `KREA2_EDIT_FAMILIES` implements).

---

## 0. Verdict summary

| # | Question | Best-evidence answer | Confidence |
|---|----------|----------------------|------------|
| A | **Many images → one strong start image — how, on H3?** | **Ordered multi-reference semantic composition is now a first-class, tooled surface — not a hack.** REF2VA takes ≤9 images (+3 videos +3 audios, 12 files) tagged `<Picture N>` by **wiring order**; all three image packs expose it for stills: thaakeno (`@Image1`–`@Image9` with per-ref roles: identity/pose/outfit/style/composition/lighting/environment + ownership instructions), astropuzzo (Reference Edit, 9 refs, per-ref roles in the prompt), ethanfel (**no fixed reference count** — chainable stack with per-ref transport: `native` Qwen+VAE vs `semantic` Qwen-only at a 256–3584 px budget). The merge recipe is an **ownership contract**: "Keep identity+pose from @Image1 / Transfer only the jacket from @Image2 / Use the lighting from @Image3." The known failure mode is **merge-to-one-SUBJECT** (blending refs of the same subject into a hybrid) — multi-subject/role-split merges are the demonstrated case. Consolidation from many candidates: **candidate generation + scoring** (sharpness/contrast/exposure/temporal stability), **contact-sheet-then-pick**, and **iterative one-change-per-pass** re-anchoring. | Mechanics: **high** [DOC]. Still-image merge quality: **medium-high** [COMM, multi-pack]. Same-subject merge: **real failure mode** [COMM]. |
| B | **The edit taxonomy — which path per edit?** | **All five families are demonstrated; each has a natural path and a preservation-contract shape.** Identity/faceswap → packet, 39-frame directed profile (ethanfel `character swap`: locks pose/scene/camera/lighting, changes identity) or identity LoRA/RefMod; background swap → REF2VA reference edit (composition-class change); pose → **reference-pose semantic transport** ("Use the body pose from `<Picture 2>`", ethanfel `re-pose` directed preset) or the **outpaint-geometry trick** (pose source composited in-canvas beside the outpainted target — works across body proportions); outfit → reference edit with native-transport wardrobe refs (ethanfel ships a clothing character-sheet workflow: Picture 1 identity + Picture 2 front outfit + Picture 3 rear construction); relighting → reference edit with a lighting ref ("Use the lighting from @Image3"). DWPose-render conditioning via Fun Control remains the **video** path — for stills the pose *render* rides as a reference image. | Per-family: see §3 table. Directed presets: **high** [DOC, shipped code]. Stills taxonomy at video-level breadth: **medium** (packs + demos; video edits officially documented, stills pack-level). |
| C | **RefMods + LoRAs on the image path?** | **Mechanically yes; measured evidence is video-only.** RefMods are pre-encoded identity latents riding the same native reference conditioning REF2VA still workflows use — injection is path-agnostic **[inferred]**; no still-path RefMod benchmark exists **[UNK]**. Stacking physics (fetched today): RefMod `strength` is a **blur-latent blend** (not noise), order-invariant, token-count gravity ("3 RefMods ≈ 3N tokens overpower aggressive concept LoRAs"); recipes 1.00/1.00/0.80 per persona, quad with body-shape. LoRA stacking on T=1 is **already the shipped default recipe** (astropuzzo: FL2VA turbo @0.75 + ThisIsFine detail adapter @0.5 — two LoRAs). Interference ceilings: 2-LoRA stacks start ≈0.80–0.90, collapse ≈1.05+; turbo adapters are distilled for video — compare against base 20-step when quality matters; never mix FL2VA/REF2VA adapters or their shifts. Our form-adapter patches at model level → applies to both paths **[inferred from nodes.py]**. | LoRA-on-T=1: **high** [DOC shipped recipe]. RefMod mechanics: **high** [COMM, single-author]. RefMod-on-stills: **UNK**. Ceilings: **medium** [COMM one practitioner]. |
| D | **T=1 softness — whose refinement stage?** | **Refinement is a second-engine stage, and the field agrees with our division of labor.** astropuzzo's own answer is **Qwen-Image-Edit 2511** (4-step Lightning, 2 MP) + **Detail Tone Lock** — frequency separation keeping H3 authoritative for lighting/color/dimensions (tone_lock 0.85 / refinement_strength 0.55 / detail_radius 32); thaakeno ships a crop-based **Face Refine** (FL2VA image-conditioning on the crop). **Our recommendation: engine-pluggable refine stage, default Krea 2** (measured 6× identity preservation on-recipe, in-app graph families already exist), klein distilled as the fast tier, Qwen-IE as a watch-item; tone-lock frequency blending is a cheap app-side compositing op worth owning regardless of engine. Face-crop refine maps to the existing FaceRefine task (krzunud). | Community refine stages: **high** [DOC shipped]. Krea 2 quality: **high (own measurement)**. Recommendation: **ours to make** — the engines are interchangeable behind one stage. |
| E | **Start-frame handoff — mechanics + the xlfl0iv call** | **The mechanics are solid and partially ours already:** FL2VA `first_frame` (frame-latent DiT conditioning — "much stronger concrete anchors" than Ref2VA refs, per the chain-suite measurements); stock H3 **silently drops one** when given a first frame AND references — the b25-49 hybrid merge is the community's both-at-once fix; Add-Guide frame latents go to the DiT only (not the text encoder). Workbench output contract: image on the 32-px grid @768 short edge + role-tagged manifest + one-click seed into FL2VA I2V / Ref2VA. **xlfl0iv call: ABSORB-AND-EXTEND** — its core (T=1 generation + VAE detection + frame-extraction fallback + handoff with prompt continuity) is a strict subset of the workbench's Generate mode + start-frame exit; two parallel T=1 pipelines would drift. | Handoff mechanics: **high** [DOC]. Hybrid both-at-once: **medium-high** [COMM multi-reporter]. xlfl0iv call: **[inferred]** recommendation, maintainer decides. |

---

## 1. What moved since the foundation doc (09-14 → 09-18)

The foundation doc (§4 of `h3-instruction-based-editing.md`) established the two paths and the three packs. Re-reading the packs today, four things changed that materially shape the workbench spec:

1. **ethanfel grew from "anchored one-image edits" into a full stills toolchain**: an unbounded ordered reference stack with per-reference transport (`semantic` Qwen-only / `native` Qwen+VAE / `none`), **directed edit presets** compiled into timed 39-frame wrappers (re-pose / character swap / new camera angle, each with an explicit allowed-change/locked list), **candidate scoring decoders** (one-image, character sheets 2×2–4×2, scene coverage 2–24 viewpoints), and `compiled_prompt` as an external-compiler input. **[DOC]** ([ethanfel README](https://github.com/ethanfel/ComfyUI-MiniMax-H3-Edit), read 2026-09-18)
2. **thaakeno's `adherence` knob is gone** — the current README exposes per-reference **roles + retention policies + ownership instructions** instead, with the honest caveat "cannot guarantee exact geometry." The foundation doc's `adherence` mention reflects an earlier README state; the workbench spec should model per-ref retention, not a single global knob. **[DOC-drift, verified today]**
3. **astropuzzo's T=1 recipe is now concrete and two-LoRA**: hybrid b25-49 int8 + `minimax_h3_t1_image_vae_step1597` + FL2VA turbo 8-step @0.75 + `MaxiMin-HHH-R2V-ThisIsFine` detail adapter @0.5 — and one-frame I2I **auto-switches to Picture-1 reference conditioning** (a frame-0 keyframe would fill the only output slot). Plus a shipped **Qwen-Image-Edit 2511 refinement stage** with frequency-separated Detail Tone Lock. **[DOC]** ([astropuzzo README](https://github.com/astropuzzo/ComfyUI-MiniMax-H3-Image-Studio), read 2026-09-18)
4. **The first-frame-plus-references conflict is now a named, solved problem**: on stock H3, "a first-frame image plus references does not error — it silently drops one of them" (AtlasCloud's R2V rules, via search snippet — full page not fetched) **[COMM]**; the community fix is the FL2VA+Ref2VA b25-49 hybrid merge (smhfacct merged checkpoints / scottmudge HybridLoader), with the `ComfyUi-MiniMax-H3-Image-And-Reference-To-Video` node noting that in Add-Guide mode **only the DiT receives the frame latents**. **[COMM/DOC]** ([smhfacct](https://huggingface.co/smhfacct/Minimax-H3-fl2va-ref2va-hybrid-models), [Image-And-Reference-To-Video](https://github.com/), [atlascloud](https://www.atlascloud.ai))

---

## 2. Lane A — many images → one strong start image

### 2.1 The reference semantics, precisely

| Surface | Count | Ordering | Per-ref control | Source |
|---|---|---|---|---|
| REF2VA (native, R2V) | **≤9 images + ≤3 videos + ≤3 audios (12 files)** | `<Picture N>` numbered by **wiring order**, not prompt text | role via prompt (`subject_definitions`); `ref_image_size: match` (fast) vs `max` (2048 px short edge, better identity) | [DOC] local transitions doc §4 + [awesome-minimax-h3-integration](https://github.com/MiniMax-AI/awesome-minimax-h3-integration) re-confirmed today |
| thaakeno Studio | 9 ordered `@Image1`–`@Image9` | compile to `<Picture N>` deterministically | **role per ref** (identity, pose, outfit, style, composition, lighting, environment) + retention policy + description; roles persist across reloads | [DOC] README today |
| astropuzzo Image Studio | 9 ordered refs (one per socket; batches take first image to keep numbering stable) | socket order | `reference_transport: native` (default) vs `semantic` (experimental — "may lose identity, exact layout, and small details"); "state the role of every connected picture explicitly" | [DOC] README today |
| ethanfel Edit | **no fixed count** — chainable `Add H3 Edit Reference` stack | source is always `<Picture 1>`, direct socket `<Picture 2>`, stack continues `<Picture 3+>` in chain order | **per-ref transport**: `semantic` (Qwen tokens only, 256–3584 px equivalent-square budget), `native` (Qwen + VAE latent), `none`; practical limits = "Qwen context length, conditioning time, RAM, and VRAM" | [DOC] README today |
| Comfy.org multiframe (Add Guide chain) | no stated max; template ships 4 | `<Picture 1>` = identity lock **and** first frame; guides pin compositions at frame indices (24 fps, negative = from end) | guide images **not visible to the text encoder** unless also wired into `ref_images`; "index + guide length must stay inside the duration" | [DOC] ([multiframe tutorial](https://docs.comfy.org/tutorials/video/minimax/minimax-h3-multiframe), fetched today) |

**The composition recipe shape** (all three packs converge): source/anchor as Picture 1 → one ref per *role* → an **ownership contract** in the prompt assigning what each ref contributes and what is preserved. thaakeno's verbatim example: *"Keep the identity and pose from @Image1. Transfer only the jacket from @Image2. Use the lighting from @Image3."* astropuzzo's: *"Keep the identity, face, hair, clothing, camera, and environment from `<Picture 1>`" / "Use the body pose and limb positions from `<Picture 2>`."* ethanfel's: *"Add the black acetate glasses from `<Picture 2>` to the woman… Change nothing else."* **[DOC×3]**

### 2.2 What actually works, and what breaks

- **Multi-ref composition into one image: demonstrated** at 8K (the 6-edits-in-one-shot post), in every pack's shipped workflows (ethanfel's Mixed References, Clothing 6-View, Art Room 5-ref hard cuts), and by RunComfy's "turn nine images into a cinematic shot" workflow. **[COMM/DOC]**
- **The named failure mode is merge-to-one-SUBJECT**: a linked Reddit thread "Minimax H3 — not able to combine multiple references to one subject" (title confirmed via search; body not fetched — Reddit blocks). Splitting roles across refs of *different* subjects/objects works; fusing several photos of the *same* subject into one idealized subject is where references bleed. The malcolmrey stacking guide's diagnosis transfers: generic prompts cause "feature averaging into hybrid faces"; the fix is contrasting anchors + explicit spatial/temporal assignment. **[COMM, partial-fetch caveat]**
- **Still-image batch quality variance is expected, not exceptional**: "generates a batch of 5 images (only one being good)" (r/StableDiffusion still-images thread). The frame-packet path literally hands you 5–20 candidate frames — **selection is part of the pipeline**, which is why every pack ships a scorer/picker. **[COMM]**

### 2.3 Many→one consolidation patterns (ranked for the workbench)

1. **Single-pass ownership merge** (default): refs with explicit roles + ownership contract. Cheapest, demonstrated, one generation. Best when roles partition cleanly (identity / outfit / lighting / background).
2. **Candidate generation + scoring, then pick**: generate a packet (5/9/13/20 frames — or 2–24 viewpoints via scene coverage), score (sharpness/contrast/exposure/temporal stability), pick one — ethanfel's `Decode H3 Edit to One Image` does exactly this; thaakeno auto-picks the best still; astropuzzo treats scoring as optional diagnostics and picks by `recommended_index`. Maps 1:1 onto our **takes model + ContactSheet** — the packet frames ARE takes. **[DOC]**
3. **Contact-sheet-then-pick** as a deliberate UX: ethanfel's character-sheet decoders stitch 2×2/3×2/4×2 grids of calibrated views; our existing ContactSheet asset (`src/lib/contactSheet.ts`) is the same move — offer "sheet of candidates → user picks → becomes canonical take."
4. **Iterative one-change-per-pass**: official edit guidance ("one change per call reads more cleanly") generalized to composition: when a single pass can't hold everything, chain passes, each re-anchoring the previous output as Picture 1. Cost: N generations + compounding regeneration drift (the ~0.06 ArcFace/hop class physics from the transitions doc). Use when single-pass merges bleed. **[DOC/COMM]**
5. **Directed settle for structural changes**: the 39-frame directed profile (change "complete by 65% of the sequence and held perfectly still," score frames 34–38) — the pack's own answer to re-pose/swap/camera edits that need the video model's temporal context to settle into the change. Stills-only workbench should expose this as a "directed edit" family rather than pretend 5 frames always suffice. **[DOC]**

---

## 3. Lane B — the edit taxonomy, per path

| Edit family | Recommended path | Mechanism + preservation-contract shape | Community/ship proof | Failure modes |
|---|---|---|---|---|
| **Faceswap / identity transfer** | **Frame-packet**, 39-frame directed profile; or identity LoRA / RefMod instead of per-call refs | Donor as `<Picture 2>` (semantic transport recommended); contract: **change** identity/face/hair/physique/wardrobe/accessories, **lock** source pose, scene, camera, lighting (ethanfel `character swap` preset, verbatim allowed/locked lists). `<Subject N>` description strength scales stability | ethanfel preset [DOC]; weshop v2v character-swap guide [COMM]; thaakeno identity role [DOC] | Identity bleed across multiple identity refs (hybrid faces); "cannot guarantee exact geometry"; faces mush at distance (official framing bug) — plan a face-crop refine pass |
| **Background swap** | **Either path**; REF2VA reference edit (astropuzzo `H3_IMAGE_EDIT`) — a composition-class change | Picture 1 = source (keep subject, pose, framing), Picture 2 = environment/location ref; explicit "replace the background/environment with `<Picture 2>`; keep the subject, pose, camera, and lighting on the subject unchanged" | astropuzzo: image edit "recommended for changes to objects, pose, color, or composition" [DOC]; Comfy.org restyle workflow (guided key art) at video level [COMM]; official video-edit docs list background replacement with worked examples [DOC, foundation doc §2] | Under-specification → full-shot redesign (the #1 documented edit failure); subject edges are regenerated, not pixel-locked |
| **Pose transfer / mirroring** | **Frame-packet** (5f reference-pose; 39f directed re-pose); T=1 works for light pose nudges | Route 1 — **reference-pose semantic transport**: pose source (photo OR our poserig's DWPose render) as `<Picture 2>` semantic: "Use the body pose and limb positions from `<Picture 2>`" [astropuzzo example]; ethanfel `re-pose` preset locks identity/wardrobe/scene/lighting/lens/framing, allows pose + requested expression. Route 2 — **outpaint-geometry trick**: paste the pose source into the canvas beside the target, outpaint the rest, "her pose and movements are the same as the man at left side" (bbaudio2024, `ComfyUI-MMH3-UltimateExtend`) — works even with very different body proportions; costs canvas width/VRAM. Route 3 — Fun Control DWPose conditioning: the **video** path (control video = any RGB incl. skeleton renders); for a still output it is off-path **[inferred]** — nobody documents fun-control stills **[UNK]** | ethanfel re-pose [DOC]; astropuzzo pose example [DOC]; outpaint trick with workflow + prompt, verified thread read today [COMM]; fun-control wire format [DOC, local] | "Merging/bleeding characters" (r/StableDiffusion 1w90ekp help thread — title confirmed); pose+identity confusion → keep identity native (Picture 1), pose ref semantic; DWPose conversion "struggles when body proportions are inconsistent" (the outpaint post's own motivation) |
| **Outfit / clothing change** | **Either path**; REF2VA reference edit, **native transport** for wardrobe refs | Picture 1 = identity, Picture 2 = front outfit, Picture 3 = rear construction (ethanfel clothing-sheet recipe, all native); thaakeno: "Transfer only the jacket from @Image2" | ethanfel `H3_Character_Clothing_6_View` workflow [DOC]; thaakeno recipe [DOC]; wardrobe-swaps demonstrated at video level (Patreon/Innovate Futures clothing-swap demo) [COMM] | Outfit identity bleeding into the identity ref → native transport + explicit "only the jacket"; fit/geometry approximated, not tailored |
| **Relighting** | **Frame-packet** (lighting is global — packet's temporal context helps) | Lighting ref as a role: "Use the lighting from @Image3"; contract locks subject/pose/scene, changes illumination; official video-edit relight (day→night, geometry fixed) is the documented ancestor | thaakeno lighting role [DOC]; official relight worked examples [DOC, foundation doc §2]; Comfy.org restyle-lighting workflow [COMM] | Color grading physics: references graded 16–21 L* too bright underperform — grade the ref toward what the model renders (transitions doc §4.6); global relights can shift skin tone → tone-lock/frequency blend after |

**Cross-cutting contract rules** (from the packs, converging): (a) state the role of **every** connected picture; (b) explicit assignments beat the global `source_fidelity` dial (astropuzzo: explicit wins, the dial only "changes preservation wording for traits the instruction does not mention… not denoise strength"; 0.50–0.60 start for large pose/framing/composition transfers); (c) close with a "change nothing else" clause; (d) edits are **semantic regeneration, not pixel inpainting** — where deterministic pixel preservation is the requirement, the mask path (Fun Control inpaint, video) is the honest tool. **[DOC×3 + local foundation doc]**

**DWPose/AP-10K on the image path (the poserig question):** nobody in the stills field conditions H3 on skeleton renders via a control channel — pose control on stills is done by **showing the pose as a reference image** (a photo, a skeleton render, or the outpaint geometry). Our poserig's renders (DWPose 134-kp whole-body, palette-exact; AP-10K animal 17-kp) are therefore *inputs* to Route 1 as semantic references. Human-skeleton renders as pose references: plausible by the pack examples (any image can carry the pose role) **[inferred]**; AP-10K animal renders as pose references: **[UNK]** — no test exists; the video-path E-FC1 finding (topology-tolerant, not topology-agnostic) suggests the model reads skeleton-ish images loosely, which is encouraging but unmeasured on stills. A one-arm experiment (E-IW1 in §8) settles it.

---

## 4. Lane C — RefMods + LoRAs on the image path

### 4.1 RefMods: create-and-use on stills

Mechanics (stacking guide fetched today; single-author, treat numbers as one practitioner's calibration):

- A RefMod is **pre-encoded visual memory**, not a weight modification: 8–20 source images (40/30/20/10% front/three-quarter/profile/body mix) → one ~1.1–1.6 MB `.safetensors` of conditioning latents (≤8192 tokens, 1024 px short edge), loaded into persona slots with `strength`/`copies`. **[COMM]**
- `strength` is a **blur-latent blend** (`z_eff = s·z_pristine + (1−s)·z_blurred`, 3D adaptive pooling + trilinear upsample) — 0.80 keeps macro geometry while softening fine texture; it does not add noise. **[COMM, code-quoted]**
- **Order-invariant** (attention is permutation-equivariant; each RefMod occupies its own RoPE grid segment); identity routes via cross-attention to `<Subject N>` descriptions — no `<Picture N>` boilerplate. **[COMM]**
- Stacking recipes: triple 1.00/1.00/0.80 per persona ("3N tokens… overpowers the LoRA's distorting forces"); quad = 3 persona + 1 body-shape; dual-persona 3+3. **[COMM]**
- **All verified samples are video.** The guide does not cover stills or mixing RefMods with raw refs. **[COMM-absence]**

**Stills applicability [inferred]:** RefMod injection rides the native reference-conditioning path (the Luisacaotica pack's loader "presents saved refs to the native encoder and reports their `<Picture n>` labels" — ecosystem sweep §2a). REF2VA still workflows (Reference Edit / H3_IMAGE_EDIT) use that same conditioning machinery, so a RefMod should slot into a stills graph mechanically. Quality on stills: **[UNK]** — worth one cheap A/B once the factory exists. Practical stakes for the workbench: a character RefMod replaces a multi-image character sheet with one slot-stable asset — directly the "characters library → one strong identity anchor" move, and it dodges the 9-image raw-ref budget.

### 4.2 LoRAs: stacking, dialing, interference

- **Two LoRAs on T=1 is the shipped default** (astropuzzo: turbo @0.75 + detail adapter @0.5) — multi-LoRA on the fast path is proven practice, not exotic. **[DOC]**
- **Strength semantics differ by adapter class** and the UI should say so: turbo LoRAs change the *operating point* (steps/CFG come along); detail/style/concept LoRAs scale a *concept force*; RefMod strength scales *visual-memory sharpness*. The malcolmrey working points: turbo @1.00 + concept LoRA @0.52–0.60; 2-LoRA stacks start ≈0.80–0.90, collapse ≈1.05+. **[COMM]**
- **Turbo adapters are distilled for video** — astropuzzo's warning to compare turbo results against the base 20-step profile when quality matters; and **never mix FL2VA/REF2VA adapters or their shifts** (8-step REF2VA uses video shift 12, not 6). Our recipe-audit discipline (the `krea2RecipeAudit` pattern) should grow H3 equivalents: adapter-family × checkpoint-family × shift consistency checks. **[DOC]**
- **Per-block LoRA loading exists** (FL-MiniMaxH3 `LoRA Block Loader`, `blocks.0-9=0.5` syntax — ecosystem sweep) — the fine-grained interference dial if global strength proves too blunt. Watch-tier, not v1. **[COMM]**
- **Our form-adapter** (`MiniMaxH3LoraFormLoader`): patches the MODEL (form projection of full-width↔pruned adaln weights) before sampling, so it is **latent-shape-agnostic — applicable to both the packet and T=1 paths** **[inferred from `custom-nodes/minimax-lora-form-adapter/minimax_lora_form_adapter/nodes.py`]**. It belongs in every workbench graph family's LoRA slot chain, ahead of plain `LoraLoader`, so arbitrary Civitai H3 LoRAs work regardless of the base checkpoint form.
- **RefMod × raw-ref interaction: [UNK]** — the guide is silent; if the workbench allows both, cap total visual-memory tokens and warn.

---

## 5. Lane D — the refinement story (recommendation)

**The problem, precisely:** the T=1 path's ceiling is softness — the Mamad8 VAE reconstructs at 30.4–33.4 dB PSNR and "outputs can stay soft and lose fine text, thin contours, hair, foliage, microtexture" (foundation doc §4.2); five-frame decode remains the reliability recommendation; packet-decoded stills carry video-VAE smoothing. Either way, the H3-image community treats a **detail stage as part of the pipeline**.

**The field's answers:**

- **astropuzzo `H3_DETAIL_REFINER`**: Qwen-Image-Edit 2511 (INT8 ConvRot + qwen2.5_vl_7b_fp8 + 4-step Lightning; 4 steps, CFG 1, shift 3.1, 2 MP working copy) + **Detail Tone Lock** — frequency separation, not masks: the refiner supplies fine detail, H3 stays authoritative for dimensions/lighting/color (tone_lock 0.85, refinement_strength 0.55, detail_radius 32). Honest risks: "can generate new detail, but may also change faces, objects, and lighting"; not an upscaler; prompt discipline = name a defect, don't re-describe the scene. **[DOC]**
- **thaakeno Face Refine**: crop-level — detect (YOLO `face_yolov8m`, optional SAM), refine the crop through H3's own FL2VA image-conditioning path at 512–1536 px (768 default), composite back with feather masks. Multi-face "Strong" mode. **[DOC]** — this is precisely our queued FaceRefine task (krzunud), now with a shipped reference implementation to steal specs from.
- **ethanfel**: no refinement stage — its answer is *selection* (scoring decoders), not enhancement.

**Our recommendation — engine-pluggable refine stage, default Krea 2:**

1. **Model the refine stage as a pluggable second engine**, not a property of the H3 graphs: `refineEngine: krea2 | klein | qwen-ie | none`. Small targeted graph families compose it after the H3 stage.
2. **Default = Krea 2** (instruct for global detail, the existing `refine` family (anypaint, masked) for targeted repair): measured 6× identity preservation on-recipe, graph families + detection + audits already shipped in `src/lib/graph/krea2edit.ts`, and the division of labor already blessed (foundation doc §6.1: "ceiling = softness, fixable by the Krea/Klein refine stage — the astropuzzo pattern in reverse").
3. **Fast tier = FLUX.2 klein distilled** (4-step ~2 s, multi-ref) when the session already stages it — model-swap economics per the speed doc's reload choreography, not a per-image default.
4. **Qwen-Image-Edit 2511 = watch-item**, not v1: it is the community's native choice for exactly this defect class and ships a frequency-separation recipe, but it adds a third model family (DiT + 7B TE + VAE) to stage. Revisit at the next ecosystem sweep.
5. **Own the tone-lock blend app-side regardless of engine**: frequency-separated blending (refiner detail + H3 low frequencies) is a cheap deterministic compositing op — an op-stack `refine-blend` op (radius/strength dials) that works with ANY refiner output, including manual re-upscales. This de-risks the engine choice: even a "wrong" refiner contributes only its high-frequency band.

---

## 6. Lane E — the start-frame handoff, and the xlfl0iv call

### 6.1 Frame-0 anchor mechanics (what the workbench must emit INTO)

- **FL2VA I2V**: `MiniMaxH3ImageToVideo` `first_frame`/`last_frame` — "the model generates the motion between them." FL2VA conditions the DiT on **frame latents** — the chain-suite measurements call these "much stronger concrete anchors" than Ref2VA references (Ref2VA chains "showed visible quality degradation after multiple clips, even when supplying start and end images"). For adherence-critical video, **the start frame should ride first_frame, not a reference slot**. **[DOC + COMM, local transitions doc §4.5]**
- **The both-at-once trap**: stock H3 given a first frame AND references **silently drops one** (AtlasCloud R2V rules) **[COMM, snippet]**. The fix the community standardized on is the b25-49 FL2VA+Ref2VA hybrid (the exact checkpoint the T=1 fast profile already uses) — one model, frame-latent anchoring AND reference conditioning. The workbench's start-frame exit should therefore target: FL2VA I2V (frame anchor) on stock, hybrid when refs must ride too. **[COMM multi-reporter + DOC tensor analysis]**
- **Contract numbers**: 32-px grid, native 768 short edge (1344×768 = 0.98 MP; avoid the 1.0 MP preset), durations snap to 17n+5 @ 24 fps (speed doc §3.5). `ref_image_size: max` (2048 short edge) when identity refs ride along.
- **The manifest matters more than the cache**: the stills pipeline should emit the image + a **role-tagged manifest** (which refs/libraries conditioned it, path, recipe) so the H3 video graph factory can wire `Picture N` order deterministically downstream (speed doc §3.5). Conditioning-cache reuse across engines is mostly moot — H3's 32B Qwen3-VL TE differs from the image engines' TEs (Krea 2 qwen3vl_4b, klein Qwen3-4B, Qwen-IE 2.5-VL).

### 6.2 The xlfl0iv relationship — recommend ABSORB-AND-EXTEND

xlfl0iv (Start-frame factory — H3 T=1 single-frame generation for FL2VA/Ref2VA) specifies: T=1 generation via Mamad8 VAE (fallback iamkaikai, fallback frame-extraction), text-prompt → still → one-click handoff into Create with prompt continuity + resolution matching, VAE availability detection + install guidance.

**Recommendation: absorb xlfl0iv's spec into the workbench as its "Generate" mode + start-frame exit, and keep at most the task as the first build slice.** Reasons:

1. **Strict subset**: everything xlfl0iv specifies (T=1 path, VAE detection, frame-extraction fallback, handoff) is one mode + one exit of the workbench; the workbench adds compose/edit/refine/consolidation around exactly that core.
2. **No duplicated pipelines**: two T=1 implementations (a factory and a workbench) would share the hybrid checkpoint, the VAE detection, the recipe pins, and the fallback ladder — guaranteed drift. One graph-family registry (`H3IMG.*` below) serves both.
3. **The task's own comment anticipated this**: its recipe notes ARE the T=1 fast profile the workbench inherits (hybrid b25-49 + Mamad8 VAE + turbo @0.75 + detail adapter @0.5, er_sde/sgm_uniform, 8 steps, shifts 12/3).
4. **Sequencing stays honest**: if the maintainer wants incremental delivery, build the absorbed core first (Generate + handoff = old xlfl0iv scope), then Compose/Edit/Refine — the spec just has to say the core is slice 1 of the workbench, not a separate surface.

This is a **[inferred]** recommendation on scope architecture; the disposition call (close-xlfl0iv-as-absorbed vs keep-as-slice-1-name) belongs to the maintainer in the spec round.

---

## 7. The recommended surface

### 7.1 Modes (four, one engine contract)

| Mode | What it does | Path policy |
|---|---|---|
| **Generate** | text → still (the absorbed xlfl0iv core) | T=1 fast profile default; packet for quality tiers |
| **Compose** | many refs → one image: ordered ref strip, per-ref role + transport + retention; ownership contract compiled by our prompt composer; consolidation via takes/ContactSheet pick, iterative chain on bleed | Frame-packet (5f default, 9/13/20 tiers); T=1 for fast drafts |
| **Edit** | the taxonomy families (identity-swap, background, pose, outfit, relight, generic instruct); each family pins its contract template + transports + dials | Packet default; **39f directed profile** for re-pose/character-swap/new-camera; T=1 for light nudges |
| **Refine** (optional stage) | engine-pluggable detail pass (default Krea 2; klein fast; Qwen-IE watch) + face-crop refine + app-side tone-lock blend | Runs after any of the above; per-chain opt-in |

Every mode shares the **start-frame exit**: image (32-px grid, 768 short edge) + role-tagged manifest + one-click seed into FL2VA I2V / Ref2VA (hybrid when both anchor and refs must ride).

### 7.2 Graph families (the small-targeted-graphs doctrine, `KREA2_EDIT_FAMILIES` shape)

Emit `H3IMG.*` families in `src/lib/graph/` (a sibling of `krea2edit.ts`), each a small targeted graph with:

- `recipe` pins (checkpoint family FL2VA/REF2VA/hybrid, steps, shifts — REF2VA 8-step = video shift 12, frames profile 5/9/13/20/39, T=1 recipe pins verbatim from astropuzzo/xlfl0iv);
- `dials` validated against pins (`source_fidelity` surfaced as the "keep unspecified traits" dial 0.50–0.60 band for large transfers; per-ref strength; LoRA strengths);
- `detect()` availability gating (required node classes + weights: hybrid checkpoint, T=1 VAE, turbo/detail LoRAs, Krea-2 refine models) with install guidance — the pattern `detectKrea2EditFamilies` already implements;
- `requiredNodes`/recipe audit (adapter-family × checkpoint × shift consistency; forbidden composite discipline where the packs warn);
- per-family `promptGuidance` (the E-K1 lesson: scene-style prompts + preservation contracts, never bare instructions).

Family list for v1: `h3img.generate.t1`, `h3img.generate.packet`, `h3img.compose.refs` (N-role strip), `h3img.edit.instruct`, `h3img.edit.identity-swap` (39f directed), `h3img.edit.pose` (semantic pose ref; outpaint-geometry variant `h3img.edit.pose-outpaint`), `h3img.edit.outfit`, `h3img.edit.background`, `h3img.edit.relight`, plus `refine.*` composites.

### 7.3 Integration map (existing assets → workbench surfaces)

| Asset | Integration |
|---|---|
| **StudiosDock libraries** (characters/hair/wardrobes/accessories/locations; `CanvasAssetEntry` curated sets; consent-gated `bindGlobalAsset` riding the ordered picture budget) | the Compose/Edit ref strip is fed from libraries: characters → identity role (RefMod when the factory ships), wardrobes → outfit refs (native transport), locations → background refs; the existing ordered-picture budget discipline carries over unchanged |
| **Identity payloads** (`setChainIdentity` subjectText + strength; `allocateCharacterReferences` → Picture N) | subjectText compiles into `subject_definitions`; the strength dial maps to `<Subject N>` description strength + `source_fidelity` — one "identity hold" dial, two knobs underneath |
| **Poserig** (`src/poserig/`, DWPose 134-kp + AP-10K renders, IK, templates) | pose renders as semantic pose references in `h3img.edit.pose` (and the outpaint variant); the same renders remain control videos for the Fun Control video path; AP-10K stills quality = E-IW1 |
| **Form-adapter** (`custom-nodes/minimax-lora-form-adapter/`) | first node in every family's LoRA slot chain — form-agnostic by construction; strength dial passes through |
| **Canvas** (chains/takes/op-stack; `seedChain`; endpoint actions; fork substrates) | workbench runs as a chain surface: outputs land as takes; the start-frame exit is an endpoint action seeding a video chain; tone-lock blend + face refine land as op-stack ops; ContactSheet is the many→one picker |
| **MoviePlanner / plan segments** (`seedSegmentChain`, FLF gaps) | segments seeded from workbench start frames consume the same manifest |
| **ContactSheet** (`src/lib/contactSheet.ts`) | candidate sheets for the consolidation pattern (§2.3) |
| **Krea 2 families** (`src/lib/graph/krea2edit.ts`) | the Refine stage's default engine — composed after H3 families |

---

## 8. Open design questions the spec must answer

1. **Surface placement**: the workbench as a canvas projection/dock (canvas is THE app post-Phase-5) vs a modal over the chain? What does the ref strip look like in the properties panel vs a dedicated surface?
2. **Path defaults per mode** (§7.1's proposal vs per-family overrides): is T=1 acceptable as Compose's draft tier given the softness ceiling, or does Compose start on packets?
3. **Transport policy**: native default (astropuzzo) vs semantic for pose/style/lighting refs (ethanfel's budgeted semantic stack)? Auto-per-role with expert override?
4. **Ref budget UX**: 9 raw slots (REF2VA cap) with semantic-only overflow (ethanfel-style unbounded stack), or hard 9? How do character sheets collapse (RefMod bundling when the factory lands)?
5. **`source_fidelity` exposure**: one global "keep" dial per edit + per-picture explicit assignments (astropuzzo semantics), or per-picture retention policies (thaakeno)? Naming for users ("keep unspecified traits"?).
6. **Refinement defaults**: does Refine auto-run on T=1 outputs (softness is structural) or stay opt-in per chain? Default engine Krea 2 confirmed? Where does the tone-lock blend op live (op-stack vs inside the refine graph)?
7. **Candidate UX**: packet frames as takes (5–20 per generation) — default pick = scored best with manual override via ContactSheet? Directed 39-frame profiles in v1 or deferred?
8. **LoRA slots per family**: how many, with the 0.80–0.90 stacking ceiling surfaced as guidance? Form-adapter always-first confirmed?
9. **RefMod timing**: build the workbench ref-slot abstraction RefMod-ready (slot = raw image | RefMod file) even though the factory (H8) is queued separately — or raw-only v1?
10. **Hybrid checkpoint strategy**: pre-merged b25-49 file vs scottmudge-style runtime loader profile (one mmap, merge at load)? Affects the both-at-once start-frame exit and the T=1 fast profile.
11. **xlfl0iv disposition**: absorb-and-extend confirmed (close as absorbed, or keep as slice-1 build task)?
12. **E-IW1 (new experiment)**: AP-10K animal-pose renders as semantic pose references on stills — one arm, poserig render vs photo pose ref, same seed; decides whether quadruped pose mirroring ships v1 or waits.

---

## 9. Sources (new this pass; prior-doc sources incorporated by reference)

**Official docs [DOC]:**
- Comfy.org MiniMax H3 multiframe tutorial — https://docs.comfy.org/tutorials/video/minimax/minimax-h3-multiframe (fetched 2026-09-18)
- Local: `docs/library/minimax-h3-prompt-guide-ref.md` (subject_definitions/Picture semantics), `docs/library/comfyui-minimax-h3-native.md` (I2V/R2V surface), via the docs index

**Node packs, READMEs read 2026-09-18 [DOC-shipped-code]:**
- ethanfel/ComfyUI-MiniMax-H3-Edit — https://github.com/ethanfel/ComfyUI-MiniMax-H3-Edit
- thaakeno/ComfyUI-MiniMax-H3-Studio — https://github.com/thaakeno/ComfyUI-MiniMax-H3-Studio
- astropuzzo/ComfyUI-MiniMax-H3-Image-Studio — https://github.com/astropuzzo/ComfyUI-MiniMax-H3-Image-Studio

**Community [COMM] (search-verified 2026-09-18; full-thread reads marked):**
- malcolmrey RefMod stacking guide — https://huggingface.co/datasets/malcolmrey/various/blob/main/h3-center/docs/MINIMAX_H3_REFMOD_STACKING_AND_MULTISUBJECT_GUIDE.md (fetched; single-author calibration)
- "An easier way to control pose in MiniMax H3" (bbaudio2024) — https://www.reddit.com/r/StableDiffusion/comments/1wh43wk/ (full thread read; outpaint-geometry pose trick + workflow)
- "MiniMax H3 as Image Editor, 6 edits at 7680×4320" — https://www.reddit.com/r/StableDiffusion/comments/1vr1i18/ (foundation doc)
- "Minimax H3 — Multiple Reference Images working through FL2VA" — https://www.reddit.com/r/StableDiffusion/comments/1vr5ezm/ (title/content via search; hybrid both-at-once node)
- "How to use a first image and reference images without losing I2V quality" — https://www.reddit.com/r/StableDiffusion/comments/1vq4m4b/ (172↑; title via search — hybrid merge + prompting; body blocked)
- "Minimax H3 Help with Pose transfer without merging/bleeding" — https://www.reddit.com/r/StableDiffusion/comments/1w90ekp/ (title via search — the pose failure mode)
- "You can use images specifically as references in MiniMax H3" — https://www.reddit.com/r/StableDiffusion/comments/1vfonwv/ (+ linked same-subject merge failure thread; titles via search)
- "MiniMax H3 still images" — https://www.reddit.com/r/StableDiffusion/comments/1vetary/ (batch variance)
- AtlasCloud "MiniMax H3 Reference to Video: the 6 rules" — https://www.atlascloud.ai (snippet: first-frame + refs silently drops one; page not fetched)
- smhfacct hybrid checkpoints — https://huggingface.co/smhfacct/Minimax-H3-fl2va-ref2va-hybrid-models
- MiniMax-AI/awesome-minimax-h3-integration — https://github.com/MiniMax-AI/awesome-minimax-h3-integration (Ref2VA 9/3/3 cap)
- RunComfy multi-reference workflow; weshop v2v character-swap guide; Comfy.org restyle workflow; domoai H3 guides (video-level taxonomy)

**App code [DOC-local], read via jcodemunch at `feat/design-decisions` HEAD:** `src/poserig/poseSpec.ts` (DWPose/AP-10K specs), `src/canvas/store.ts` + `src/canvas/ops.ts` (op-stack, StudiosDock tabs, setChainIdentity, seedChain), `src/lib/graph/krea2edit.ts` (family pattern), `custom-nodes/minimax-lora-form-adapter/minimax_lora_form_adapter/nodes.py`, `src/lib/contactSheet.ts`.

**Method caveats:** Reddit blocks direct fetches from this environment — claims marked "via search" rest on search-result excerpts (titles + content snippets), not full thread reads; the three pack READMEs and both official/guide pages were fetched in full. thaakeno's `adherence` knob (recorded in the 09-14 foundation doc) no longer exists in the current README — retention policies replaced it; treat the foundation doc's mention as historical.
