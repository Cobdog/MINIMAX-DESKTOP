# Burst-frame enhancement — using packet neighbors to deblur/denoise/sharpen the picked frame

> Compiled 2026-09-18 (Flux task `ucsnubx`). Research pass answering the maintainer's direction (2026-09-18): *"Look into things like burst deblurring/denoising. The idea: use surrounding frames to enhance the detail of the target frame. If this works it could be very helpful to clean up the image even more."* Feeds the H3 Image Workbench **Refine lane** ([h3-image-workbench.md](h3-image-workbench.md) §5/§7).
>
> **METHOD:** pure desktop research — no engine/GPU this pass. Web survey (searches 2026-09-18 + full fetches of the FlashVSR and numz/SeedVR2_comfyUI repos; everything else verified via search-result excerpts and tagged accordingly), layered on the local docs (workbench doc, `h3-instruction-based-editing.md` §4, `h3-transitions-and-latent-continuity.md` §4 — NOT re-researched here). Tags: **[DOC]** verified in shipped code / official source (incl. fetched pages), **[COMM]** reputable community claim (search-snippet unless "fetched"), **[inferred]** plausible-unverified reasoning over verified facts, **[UNK]** nobody documents it.

---

## 0. Verdict summary

| # | Question | Best-evidence answer | Confidence |
|---|----------|----------------------|------------|
| A | **Do classic burst-enhancement methods apply to H3 packet frames?** | **The statistics transfer; the off-the-shelf networks mostly don't.** Classic burst enhancement (HDR+ → burst SR) assumes *aligned temporal frames of a static scene with independent noise*. Packet frames violate all three, in specific ways (§1): the frames are one **joint** video generation (noise is correlated across frames, so the √N denoising law does NOT apply), they carry **semantic drift** (animation + settle motion, not subpixel hand tremor), and their defect class is **softness** (video-VAE smoothing + sampler softness), not sensor noise. No published method is trained on "generative packet frames of an anchored scene" — verified absence across burst-SR, RefSR, and VSR searches; the niche is unoccupied. The transferable core is the *idea*: align neighbors, fuse only where they agree, trust consensus over any single frame. | Input model: **high** [DOC-local + COMM]. Niche absence: **medium-high** (absence of search hits, not proof). |
| B | **Which method families tolerate the drift gap?** | Ranked most→least tolerant (§3): (1) **robust pixel/frequency fusion with explicit drift gating** (HDR+ lineage — frequency-domain tile merge designed for misalignment; we add a flow-magnitude gate); (2) **video-restoration on the packet as a pseudo-clip** — diffusion resto (SeedVR2, FlashVSR) is drift-tolerant via learned semantic priors but hallucinates by design; recurrent VSR (BasicVSR++/RVRT) uses flow-guided *deformable* alignment, explicitly built for misaligned frames, but is real-video-degradation-tuned; (3) **reference-based SR** (AdaRefSR "trust but verify", ReBaIR) — designed for imperfect references, but assumes an **HQ reference**; packet neighbors are as soft as the target, so RefSR fits the *source/anchor image* case, not neighbor fusion; (4) **strict burst-SR nets** (QMambaBSR, BurstMamba) — RAW-burst-trained, subpixel-motion assumptions, no ComfyUI path. | Family ranking: **[inferred]** over [DOC] facts. AdaRefSR/ReBaIR semantics: **high** [DOC/paper]. |
| C | **What gain is plausible, at what compute?** | **Honest bound: modest but real, and nearly free.** The gain mechanism is NOT noise averaging (correlated) — it is (a) borrowing real decoded detail from the *sharpest* frames in the packet (per-frame quality variance is expected — every pack ships a frame scorer for exactly this reason), (b) suppressing texture "boiling" (frame-inconsistent hallucinated microtexture — a documented flicker class), and (c) recovering structure the video VAE smoothed, wherever neighbors agree after alignment. Ceiling = the best frame in the packet; upside is concentrated on hair/foliage/contours class textures. Compute: the app-side fusion arm is <1 s/frame-class with **zero new weights**; the diffusion arm (SeedVR2 3B) is tens of seconds per packet on our 24GB card. Diffusion arms buy larger *apparent* sharpness with hallucination risk — that is the existing refine-lane trade-off, not a new one. | Mechanism: **[inferred]**. Boiling/quality-variance premises: **[COMM]/[DOC]**. Compute: **[SPEC]** estimates. |
| D | **Integration shape?** | Two shapes, both inside the blessed Refine lane (§4): (1) **app-side `burst-fuse` op** — target take + neighbor takes → robust frequency-domain merge (HDR+-style tile fusion + flow gating), an op-stack sibling of the already-committed tone-lock blend; fidelity-first: it cannot invent content, making it the only refine arm with no hallucination channel; (2) **`h3img.refine.burst-seedvr2` graph family** — the packet as an image batch through the official SeedVR2 ComfyUI nodes (Apache-2.0; 3B FP16 fits 24GB clean; the node's batch contract is **4n+1 frames — H3's 5/9/13 tiers match exactly**). Composes with the Krea-2 default as burst-fuse → Krea-2 (real-detail consensus first, generative detail second) or as a standalone fidelity tier. | Op shape: **[inferred]**, our design. SeedVR2 mechanics: **high** [DOC, fetched]. |
| E | **Verdict — GPU window?** | **GO on one cheap E-IW-style window (E-IW2, §5).** The drift gap does not kill it — it *shapes* it (gating, band-limited fusion, honest expectations), and the packet-path evidence (held-still 39f tails, scorer-shipped packs, 4n+1 coincidence) is favorable enough that a ~1-session experiment is clearly worth it. Part 0 measures inter-frame drift on real packets (nobody has — the load-bearing [UNK]); Part 1 is a 4-arm A/B with a no-new-weights arm and a fallback-preserving design (worst case = the picked frame unchanged). | Ours to make; premises verified enough to bet one session. |

---

## 1. The input model — what packet frames actually are

The burst-enhancement literature's input contract vs what the workbench actually produces:

| Property | Classic burst (HDR+/burst SR) | H3 frame packet | Consequence |
|---|---|---|---|
| Frame relationship | Same static scene, hand tremor → **subpixel shifts** | **Semantic variations around an anchored scene**: one joint video generation (5/9/13/20/39-frame tiers; durations 17n+5), animated by the video prior, plus edit-settle motion | Alignment is not subpixel refinement; it must reject or absorb content drift |
| Noise | **Independent** per frame (sensor read noise, shot noise) | **Correlated**: all frames decode from one latent through one video-VAE pass ("packet-decoded stills carry video-VAE smoothing"; the Mamad8 card's cross-frame-mixing warning is the same physics read in reverse) — plus frame-inconsistent *hallucinated* microtexture ("texture boiling", the documented flicker class in generated video) | No √N SNR gain. What IS quasi-independent across frames: which microtexture got hallucinated, and how sharp each decode landed |
| Defect class | Noise + blur from short exposure | **Softness**: T=1/packet ceiling ("outputs can stay soft and lose fine text, thin contours, hair, foliage, microtexture"; Mamad8 VAE 30.44 dB PSNR / 0.9393 SSIM class) | We want *detail synthesis from consensus*, not denoising per se |
| Frame count | 2–100+ | 5–20 usable (39f directed tails: 34–38) | Enough for fusion; nowhere near burst-SR training regimes |

**The packet-path facts that matter (all local-doc, [DOC/COMM]):**

- **Frames within a packet are close but not identical, and quality varies per frame** — this is why every stills pack ships candidate scoring (ethanfel: sharpness/contrast/exposure/**temporal stability**; thaakeno auto-picks; astropuzzo `recommended_index`) and why image-batch testimony says "a batch of 5 images (only one being good)". Per-frame sharpness variance within a packet is expected, not exceptional. **[DOC/COMM]**
- **The 39-frame directed profile's tail is near-static by design** — "change complete by 65% of the sequence and held perfectly still, score frames 34–38". A held-still tail is effectively a *static burst*: the classic burst assumption is closest to true exactly where directed edits land. **[DOC]**
- **A 5-frame packet spans ~0.2 s at 24 fps** — small-motion regime, but the first frames of an edit may still be settling (that is what the hidden temporal context is *for*); drift is front-loaded. **[inferred]**
- **Identity drift inside a segment is bounded by the render-to-render noise floor** (±0.039 ArcFace / ±0.38 face dE) with directional color relaxation (~2 L*) — chain-hop drift (~0.06 ArcFace/hop) is the *regeneration* problem, not the intra-packet one. **[COMM, loopforge numbers]**
- **Scope note:** the T=1 fast path has **no neighbors** — burst enhancement is a packet-path (and multi-take) feature. A separate axis exists — *same prompt, multiple seeds/packets* gives quasi-independent generations but a much larger semantic gap (independent renders of the same description); noted as an out-of-scope variant in §3.4. **[inferred]**
- **The measured gap is [UNK]:** nobody — including the H3 community — has published inter-frame motion/drift numbers for packet frames. This is the single load-bearing unknown, and it is cheap to measure (E-IW2 Part 0).

---

## 2. Lane 1 — method survey (web-verified 2026-09-18)

### 2.1 The four families at a glance

| Family | Exemplars (lineage → 2026) | Fusion where | Drift tolerance | License / code | Runs here (24GB, local-only) | ComfyUI |
|---|---|---|---|---|---|---|
| **Robust multi-frame fusion** (computational-photography lineage) | HDR+ (Hasinoff 2016) → IPOL analysis/implementation (2021) → Burst Photo app ports; Amped FIVE frame-integration (forensics practice) | **Frequency** (2D-DCT tile stacks, Wiener-style merge) + robust tile rejection | **Designed for misalignment** (frequency-dependent weighting downweights high frequencies where alignment is unreliable) — but assumes global scene identity | HDR+ patent status for *productization* unreviewed **[UNK]**; algorithm re-implementable from the open IPOL paper (port-with-provenance, no upstream bytes) | **Trivially** — it is classical DSP; no weights, <1 s per frame-class | No nodes exist (classical op) — hence an app-side op, §4 |
| **Burst SR / burst restoration nets** | DBSR (2021) → BIPNet → DeepRep (CVPR'24) → **Burstormer** (ICCV'23) → QMambaBSR (CVPR'25), BurstMamba (SIGGRAPH Asia'26), BurstGP (diffusion prior, 2025) | **Feature** (learned alignment + fusion; Burstormer: multi-scale local/non-local attention, no explicit flow) | Moderate (learned alignment beats flow) but trained on **RAW handheld bursts** with subpixel motion; semantic drift is out-of-distribution **[inferred]** | Burstormer **MIT, code+weights public** (akshaydudhane16); QMambaBSR/BurstMamba **no public code found**; BurstGP RAW-oriented | Burstormer runnable as research code (PyTorch); **not** turnkey, needs adaptation for sRGB soft-frame fusion | None |
| **Video restoration on short clips** | BasicVSR/++ (CVPR'22) → RVRT (NeurIPS'22) → real-world VSR (STAR, 2025) → **one-step diffusion resto: SeedVR2 (2025) / FlashVSR (CVPR'26)** | **Feature + temporal propagation** (flow-guided deformable alignment; diffusion resto = full re-generation with conditioning) | **Deformable alignment is explicitly built for misaligned frames** (BasicVSR++ paper); diffusion resto is drift-tolerant via semantic priors — but every diffusion resto **hallucinates by design** | BasicSR/BasicVSR++/mmagic **Apache-2.0**; SeedVR2 **Apache-2.0** (code + weights); FlashVSR **Apache-2.0** (verified in-repo; built on Wan2.1); STAR license **unverified** | BasicVSR++ tiny/fast (seconds); **SeedVR2 3B FP16 fits 24GB with no memory tricks** (24GB+ = FP16 tier per the node's own guidance); FlashVSR benchmarks on A100 (block-sparse kernels; RTX 40-series compat "currently unknown" — dense-attention fallback works, slower/heavier) **[DOC]** | **SeedVR2: official ComfyUI support + official numz node pack; FlashVSR: third-party nodes (README warns some omit the LCSA module → dense attention, degraded quality/VRAM); STAR: ComfyUI-STARWrapper; BasicVSR++: via BasicSR/mmagic, no first-class nodes |
| **Reference-based SR / restoration (RefSR)** | RefSR → MASA-SR → C2-Matching (CVPR'21) → DASR (ECCV'22) → ReF-LDM (NeurIPS'24) → **AdaRefSR** (ICLR'26, one-step, "trust but verify") → **ReBaIR** (ICCV'25 workshop, Disney/ETH) → RASR (2026, retrieval with imperfect refs) | **Semantic correspondence** (feature matching, aggregation; diffusion variants condition on the ref) | **Most tolerant by design** — the 2025-26 wave explicitly targets unreliable references (AdaRefSR conditions on the ref only when "verified" reliable; RASR's whole point is imperfect reference matches) | AdaRefSR: HF repo exists, license **unverified**; ReBaIR: **no official code** (first-author unofficial re-implementation exists); C2-Matching Apache-2.0-class academic code | AdaRefSR: 12.66 GB @ 512², **0.41 s** inference (one-step) — fits comfortably **[COMM]** | None first-class |

### 2.2 Shortlist cards (what we would actually touch)

- **HDR+ robust merge (the algorithm, not a model).** Align tiles (integer + subpixel), merge per-tile 2D-DFT stacks with a Wiener-style filter that shifts trust toward low frequencies where alignment is unreliable; robust to hand tremor by construction. The IPOL 2021 analysis is an open peer-reviewed implementation reference; the Burst Photo app and Amped FIVE's frame-integration are practice proofs that tile/frequency fusion works on real (non-lab) inputs — Amped FIVE's license-plate-from-CCTV use is the closest *practitioner* precedent for "integrate several imperfect frames of the same scene into one better frame." **[DOC]**
- **SeedVR2 3B (ByteDance, Apache-2.0) — the strongest model arm.** One-step diffusion video restoration; **official ComfyUI documentation + official numz node pack**; input contract is literally "input video frames as image batch (RGB or RGBA)"; **batch_size must follow 4n+1 (1, 5, 9, 13, …), minimum 5 for temporal consistency** — H3's 5/9/13 packet tiers slot in natively (20/39 trims to 17/21/37); VRAM tiers say 24GB+ runs 3B FP16 with no memory optimizations; GGUF/FP8/BlockSwap ladders exist below that. It restores/upscayles with a generative prior — strong apparent detail, hallucination channel open (same caveat class as astropuzzo's Qwen-IE refiner warning). **[DOC, repo fetched 2026-09-18]**
- **FlashVSR (CVPR 2026, OpenImagingLab, Apache-2.0).** First one-step *streaming* diffusion VSR — ~17 FPS at 768×1408 on A100; built on Wan2.1; designed for 4×. The speed makes it the "every packet" tier *if* it behaves on our card: the block-sparse-attention backend is A100-tuned, RTX 40/50 compatibility "currently unknown," and third-party ComfyUI ports that drop the LCSA module degrade quality/VRAM. Watch-item, not v1. **[DOC, repo fetched 2026-09-18]**
- **BasicVSR++ (Apache-2.0 via BasicSR/mmagic).** Flow-guided deformable alignment — second-order grid propagation explicitly motivated by misaligned-frame robustness (the paper's own framing); near-zero VRAM, seconds per clip. But it is tuned for real-camera degradation (×4 SR of compressed video); on soft AI frames expect mild sharpening at best — worth one arm only because it is nearly free. **[DOC]**
- **AdaRefSR (ICLR 2026).** One-step diffusion RefSR that conditions on the reference only when verified reliable — the exact drift-tolerance philosophy we need — at 12.66 GB / 0.41 s @ 512². Caveat: RefSR's contract is **LQ input + HQ reference**. Packet neighbors are not HQ. Where AdaRefSR-shaped methods genuinely fit us: the *anchor* case — fusing detail from a high-quality source/Picture-1 image into its packet output (§3.3). License unverified → user-fetch tier at best. **[COMM]**
- **Burstormer (MIT).** The one burst net with clean permissive code — but RAW-burst-trained, burst-SR task; adopting it for sRGB soft-frame fusion is a research project, not an integration. Cite as lineage head, not a candidate. **[DOC]**
- **Latent-space precedent (for honesty about what fusion pre-decode could mean):** Text2Video-Zero's "temporal ensemble" (averaging latents across overlapping generation windows) is the known generative-latent fusion trick — it exists to suppress flicker, not to add detail; and the H3 video VAE *already* temporally integrates the packet at decode (that smoothing is part of our softness). Post-hoc pixel/frequency fusion after decode is the honest, controllable point to intervene. **[COMM]**

---

## 3. Lane 2 — applicability: the alignment/drift gap, method by method

### 3.1 The gap, precisely

Frame-to-frame differences inside a packet decompose into: (i) **animation/settle motion** — real geometric displacement, flow-estimable; (ii) **semantic drift** — content changes the prompt didn't ask for (shape wobble, boiling texture, settle-phase geometry), *not* flow-estimable in any fidelity-preserving way; (iii) **decode/sampler variance** — which microtexture got rendered and how sharp it landed, quasi-independent across frames. Classic burst methods handle (i) only. The design requirement our fusion must add: **a drift gate** — estimate per-region flow magnitude/quality, and fuse a neighbor only where it aligns (small residual after warp); everywhere else it contributes nothing. This is the single biggest departure from off-the-shelf burst pipelines and the reason an app-side op (where we own the gate) beats repurposing a research net (where the gate is implicit and RAW-trained).

### 3.2 Method-by-method failure analysis on semantic-variation inputs

| Method | Failure mode on our inputs | Verdict |
|---|---|---|
| Naive frame averaging | Averages *different hallucinations* → blur where they differ; drift regions ghost; identity-relevant microstructure (faces) smears | **Reject** — the straw-man everyone pictures; not what HDR+-style merge does |
| HDR+-style robust frequency merge + our drift gate | Occlusion/disocclusion edges ghost if the gate is loose; boiling suppression can also damp genuinely animated micro-detail (sparkle, water); strictly band-limited (high-frequency-only) contribution keeps identity/color authority with the target — the tone-lock pattern already blessed for the refine lane | **Primary candidate** — fidelity-first, tunable, weightless |
| Burst-SR nets (Burstormer/QMambaBSR) | Semantic drift is out of their RAW/subpixel training distribution → alignment module confidently mis-fuses; sRGB softness is not their degradation model | **Not v1** |
| Recurrent VSR (BasicVSR++/RVRT) | Deformable alignment tolerates motion but presumes a *coherent video* of one world; on 5-frame pseudo-clips with drift, expect warping shimmer; degradation mismatch (real-camera, not AI-soft) | **One cheap arm only** (near-free to try) |
| Diffusion video resto (SeedVR2 3B / FlashVSR) | Does not "fuse" neighbors — it *re-generates* from the clip (temporal-consistency prior + LQ conditioning); detail gains are generative → hallucination risk (faces/objects/text can change — the astropuzzo Qwen-IE caveat verbatim class); also a resolution/staging dependency (3B FP16 ≈ fits; watch VRAM headroom vs the H3 stack on the same box) | **Strong model arm, second stage** — pairs naturally AFTER the fidelity arm, or as the Krea-2-alternative engine |
| RefSR (AdaRefSR/ReBaIR) | Contract mismatch: needs an **HQ ref**; neighbors are equally soft. Feed a soft ref and "trust but verify" will (correctly) distrust it | **Different lane: anchor-image fusion (§3.3)** |

### 3.3 The anchor-image insight (a bonus lane the survey surfaced)

RefSR's HQ-reference assumption *is* satisfied elsewhere in the workbench: an **Edit packet's source image (Picture 1 anchor)** is usually higher-quality than the packet output (it is the user's chosen input). "Target frame + source anchor → restored frame" is textbook RefSR/AdaRefSR territory, one-step and license-plausible — a genuinely new refine sub-lane (detail *repatriation* from the source) that neither Krea-2 instruct-refine nor burst fusion covers. Flagged for the spec round; not part of E-IW2.

### 3.4 Out-of-scope variant, noted for the record

Multi-seed packets (same prompt, N independent generations) invert the trade: hallucination noise becomes quasi-independent (better fusion statistics) but the semantic gap becomes scene-level (independent renders) — alignment gates would reject almost everything. Only a *semantic*-space fuser (attention/RefSR-class) could exploit it, at which point identity drift is the dominant risk. Park it.

---

## 4. Lane 3 — integration shape (Refine-stage enhancer)

**Contract:** input = target take + K neighbor takes from the same packet (default K = all packet frames; adjacency-ranked, scorer-weighted); output = one enhanced frame; never worse than the target (fallback = return target when fusion coverage is low).

### 4.1 Shape A — app-side `burst-fuse` op (primary recommendation)

- An **op-stack op** (sibling of the committed tone-lock blend; deterministic compositing, no models): optical-flow align neighbors → target (RAFT-small or Farnebäback class backend), **per-region drift gate** (reject where residual-after-warp exceeds threshold), per-tile frequency merge (HDR+-style: neighbors contribute only high-frequency bands, target keeps low frequencies — the tone-lock kinship is exact: radius/strength dials, band-limited authority).
- **Cost:** <1 s per frame-class on GPU, no new weights, no fetchCatalog rows, no license surface (our own implementation from the open IPOL description; port-with-provenance per conventions if we mirror IPOL structure).
- **Placement:** after packet pick; composes as `burst-fuse → Krea-2 refine` (real-detail consensus first, generative polish second) or standalone as the **fidelity tier** — the only refine arm with no hallucination channel. Surfaces as "sharpen from packet" toggle + advanced dials (K, gate threshold, band radius/strength).
- **Detect/availability:** always available (no nodes/weights) — the honest default for v1.

### 4.2 Shape B — `h3img.refine.burst-seedvr2` graph family (model arm)

- Packet frames (5/9/13 as-is; 20/39 → trim to 17/21/37) → LoadImage batch → official SeedVR2 nodes (`seedvr2_videoupscaler` via the numz pack / native support) at 3B FP16 → take the enhanced target position → optional tone-lock blend against the original target to cap drift.
- **Cost:** tens of seconds per packet on the 24GB card **[SPEC]**; Apache-2.0 code+weights → license-clean, fetchCatalog rows + consent + sha pins required (weights LINK per policy).
- **detect():** node pack + 3B FP16 DiT + `ema_vae_fp16` present; VRAM headroom check against the staged H3 stack (run in a freed state — `/free` discipline applies).
- **Placement:** Refine-lane engine option alongside `krea2 | klein | qwen-ie`: `refineEngine: burst | krea2 | klein | qwen-ie | none` — burst = this family (or A), keeping the engine-pluggable contract from the workbench doc §5 intact.

### 4.3 Composition with the blessed defaults

The workbench doc's refine recommendation (default Krea 2, klein fast tier, Qwen-IE watch-item, tone-lock owned app-side) is unchanged; burst fusion slots in as (a) the cheap pre-pass under any engine, and (b) the fidelity-first alternative engine. Qwen-IE stays a watch-item; FlashVSR becomes the new watch-item for the fast diffusion tier (speed is right; card-compat and LCSA-integrity of ComfyUI ports must be verified first).

---

## 5. Verdict + E-IW2 experiment spec

**GO.** One cheap window on the 8189 testbed (runbook discipline: health-check, `/free` between arms, teardown + `nvidia-smi` verify). Two parts; Part 0 gates Part 1's neighbor count.

### Part 0 — packet drift census (the [UNK] that everything hinges on)

On 3–6 existing or freshly generated packets (mix: one 5f edit, one 5f compose, one 39f directed tail): per adjacent pair, measure optical-flow magnitude distribution (median/p95 residual), per-frame Laplacian sharpness, ArcFace frame-to-frame (same subject frames), and color dE. **Deliverable:** the drift profile per tier — decides default K, the gate threshold prior, and whether 39f tails are as static as the pack READMEs imply.

### Part 1 — 4-arm A/B on the same targets (fixed seed, `/free` between arms)

| Arm | Input | Method | What it isolates |
|---|---|---|---|
| **1. baseline** | target frame | as picked | the thing to beat |
| **2. burst-fuse (Shape A)** | target + neighbors | app-side robust frequency merge + drift gate (prototype in scripts, same algorithm the op will ship) | the weightless consensus gain, exactly as it would run in-app |
| **3. burst-fuse + Krea-2** | arm-2 output → existing `refine` family | composition order test | does consensus-first help or fight the generative pass |
| **4. SeedVR2 3B** | packet as image batch | official nodes, FP16, tone-lock blend vs original target | the model arm's ceiling and its drift behavior on 5-frame pseudo-clips |

**Metrics (harness conventions per E-ED/loopforge):** Laplacian variance (sharpness), no-reference IQ (pyiqa: NIQE + MUSIQ), ArcFace vs target (identity fidelity — fusion must not move it beyond the ±0.039 noise floor), CLIP similarity target↔output (content preservation), manual eyeball (maintainer); wall-clock + VRAM per arm. **Decision rule:** ship Shape A as the default op if arm 2 beats arm 1 on sharpness + NR-IQ with ArcFace inside the noise floor on ≥⅔ of packets; promote Shape B to a graph family if arm 4 clearly beats arm 3; park everything if Part 0 shows p95 flow residual beyond gate-able range (report says so honestly).

**Cost estimate:** one session — Part 0 minutes (CPU/GPU trivial), arms 2–3 seconds-class each, arm 4 the bulk (model fetch + tens of seconds per packet × 6). **[SPEC]**

---

## 6. Sources (all accessed 2026-09-18)

**Fetched in full [DOC]:** OpenImagingLab/FlashVSR GitHub (Apache-2.0; A100 benchmark, RTX-compat caveat, LCSA warning) — https://github.com/OpenImagingLab/FlashVSR · numz/SeedVR2_comfyUI HF repo (node inputs, 4n+1 batch contract, VRAM tiers) — https://huggingface.co/numz/SeedVR2_comfyUI

**Verified via search excerpts [COMM/DOC-snippet] (full fetch blocked or deferred):** HDR+ paper + IPOL analysis (Hasinoff et al. 2016; Monod 2021, ipol.im) and hdrplusdata.org · Burstormer MIT + code (github.com/akshaydudhane16/Burstormer) · DeepRep (github.com/goutamgmb/deep-rep) · QMambaBSR (CVPR'25, no code found) · BurstMamba (arXiv 2503.19634, no code found) · BurstGP (diffusion burst SR, 2025) · BasicSR Apache-2.0 (github.com/XPixelGroup/BasicSR) · BasicVSR++ (arXiv 2104.13371) + "Understanding Deformable Alignment in VSR" (AAAI'21) · RVRT (NeurIPS'22, github.com/JingyunLiang/RVRT) · STAR (NJU-PCALab; license unverified; ComfyUI-STARWrapper) · SeedVR2 license Apache-2.0 + official ComfyUI docs page (docs.comfy.org "SeedVR2: Image and video upscaling in ComfyUI") + numz/ComfyUI-SeedVR2_VideoUpscaler · AdaRefSR (ICLR'26 "trust but verify"; 12.66 GB / 0.41 s @ 512²; hangfrieddays/AdaRefSR HF; license unverified) · ReBaIR (ICCV'25 AIM workshop, Disney/ETH; no official code; MichaelBernasconi/RIVER unofficial) · RASR (arXiv 2026-05, RASR-Flickr30 imperfect-reference benchmark) · ReF-LDM (NeurIPS'24) · C2-Matching (CVPR'21) · Amped FIVE frame-averaging (forensics practice) · LTX/industry write-ups on texture boiling/flicker as the frame-consistency failure class.

**Local docs [DOC-local], incorporated not re-researched:** `h3-image-workbench.md` (packet tiers, scorer decoders, refine-lane decision, tone-lock commitment) · `h3-instruction-based-editing.md` §4 (Mamad8 T=1 VAE numbers, five-frame reliability, video-VAE smoothing) · `h3-transitions-and-latent-continuity.md` §4/§6 (drift numbers, noise floor, harness conventions).

**Method caveats:** no engine/GPU ran this pass — every "runs here" claim is documentation-based, not measured; compute figures marked [SPEC] are estimates. VAPT (named in the task brief) could not be found in the literature — the lineage reads VRT → RVRT; treated as a brief-side misremembering rather than a method. STAR/AdaRefSR licenses unverified → both user-fetch tier at best, vendoring forbidden until checked.
