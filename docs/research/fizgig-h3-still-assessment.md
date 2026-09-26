# ComfyUI-Fizgig-H3-Still — pack assessment (the "our T1 method is now obsolete" ruling)

> **Provenance.** Maintainer ruling 2026-09-25, verbatim: *"Our T1 method is now obsolete: https://github.com/shootthesound/ComfyUI-Fizgig-H3-Still."* Assessed same day.
> **Read at:** commit `f3252d2b6c94c2e34d71f583d5e1804b683afe06` (the initial publish — 8 commits, all the evening of 2026-09-25, last push 23:25 UTC; repo created 2026-09-25T22:01Z). Shallow-cloned to /tmp scratch, never inside this repo.
> **METHOD:** full code read — `__init__.py` (94 lines, the entire pack: 2 node classes), `pyproject.toml`, `.github/workflows/publish.yml`, `LICENSE`, both example workflows (node inventory + widget values extracted); trainer-side cross-read `shootthesound/Fizgig` → `src/fizgig/minimax/vae.py` (the provenance of the load-bearing measurement); ComfyUI core verified at the shared install `a87667f` (v0.34.0 — every API the pack calls grepped in-source) **and** upstream `master` (raw fetch 2026-09-25); our side read against `src/lib/graph/h3image.ts` (the T=1 emission, `H3IMG_RECIPE_PINS`, decode wiring), `src/lib/nodePackRegistry.ts`, `docs/licenses/registry.md`. No GPU, no engine, nothing installed or submitted.
> **Community metrics: DROPPED per the fresh-release doctrine** — the repo is hours old (3 stars at read); star/fork counts are time-gated noise at that age, and the maintainer's 1-day-old picks are the normal intake pattern. Comfy Registry: **published, v1.0.0** (publisher `shootthesound`, 2026-09-25T22:02Z) — Manager-installable.

---

## 1. WHAT IT IS

**Two nodes, category `Fizgig`, zero dependencies, MIT** (a real LICENSE file, Copyright 2026 Peter Neill — contrast this author's `ComfyUI-H3Studio`, which is badge-MIT-with-no-file). The whole pack is 94 lines. Both mechanisms are extracted from how the **Fizgig trainer** renders its H3 still previews (`src/fizgig/minimax/vae.py`, `single_frame_mode="group"` default).

| Node | What it does |
|---|---|
| `FizgigH3StillLatent` | A true one-frame packed AV latent: `NestedTensor(video[B,24,1,even(H/16),even(W/16)], audio[B,32,2,2])`, zeros; the even-grid clamp exists because the DiT patchifies 2×2 on the 16× latent grid (`__init__.py:32-39`). Widths/heights any multiple of 32, to 4096. |
| `FizgigH3StillDecode` | Clean decode of that lone latent through the **video VAE**: replicates it into a full 5-latent temporal group, decodes (spatially tiled), keeps **pixel frame 3** — past the decoder's causal lead-in. Anything longer than one latent frame, or a VAE without the H3 decode API, passes straight to stock decode (`__init__.py:42-89`). |

**The latent legality mechanism is the SAME CLASS as astropuzzo's** — a parallel latent construction where T=1 is legal (`_empty_h3_av_latent` at its T=1 point). But the surrounding strategy is different and leaner:

- **No conditioning reimplementation.** The stock `MiniMaxH3ImageToVideo` / `MiniMaxH3ReferenceToVideo` node stays in the graph for its conditioning; its LATENT output is simply left unconnected, and its length widget stays **legal** (5 in the shipped example — verified in the workflow JSON). The #15644 floor (`value_smaller_than_min` + the `max(5,·)` grid clamp) is sidestepped from the *submission* side — never send an illegal length — where astropuzzo sidesteps it from the *schema* side (own node, no min). One conditioning-implementation fewer to track against core drift.
- **The decode is the real divergence — and the direct challenge to us.** H3's ViT decoder is chunk-trained on complete 5-latent temporal groups `(1,4,4,4,4)` and its token t-coordinate is normalized over `latent_T`; a lone token sits at t=0, outside the training range. Core's own T=1 branch (v0.34.0 `comfy/ldm/minimax/vae.py:703`, same at master) decodes the lone token **as-is** — the banded/dark result. Fizgig replicates to a complete group (only interior frames are clean; boundary frames lose ~10 dB) and keeps frame 3.
- **Weights: the official stack only** — fl2va pruned, qwen3vl nvfp4, video VAE (int8 primary, fp16 explicitly fine — we stage fp16). Optional larryvrh v4-step-600-EMA turbo @ **0.38**, **20 steps**, `er_sde`/`simple` = the author's stills recipe. **No Mamad8 image VAE, no hybrid file, no new weights — the pack retires a dependency rather than adding one.** The README's direct shot at our lane's decode: the dedicated single-frame VAE is *"slower and softer, with less skin detail… there's no reason to use it with these nodes."*
- **Edit lane (hedged):** stock `ReferenceToVideo` conditioning + `<Picture 1>` prompts on the **fl2va** base — "the model already has some edit abilities", best ~2.5 MP. One example workflow, no validation.

**Why the maintainer's "obsolete" has substance:** our just-landed T=1 lane (afvlbk4) is Image-Studio-Prepare(latent_t=1) → 8-step hybrid recipe → **Mamad8 image-VAE decode**; fast-sharp's premise is "image-VAE sharpness with multi-frame context." Fizgig claims the same T=1 capability with 94 lines, zero extra weights, stock conditioning, and a decode that is *faster and sharper than the image VAE*. If that holds, both the machinery choice and the decode choice of our lane are superseded — and fast-sharp's premise with them.

## 2. QUALITY / EVIDENCE

- **Measured (self-reported, precisely provenanced) [COMM]:** round-trip fidelity **29.99 dB mean vs 16.96 dB** (group vs lone token, real photos, `tests/diag_frame_choice.py`), plus a dated self-correction in the trainer comments — the cheaper 2-latent "reference" scheme (what ai-toolkit does) was tried as default on 4 Aug and **reverted** (16.96 vs 16.64 dB; only a *complete* group restores the training regime). **The diag script is NOT in the public trainer tree** (no `tests/` at HEAD) — the number is exactly cited but not independently runnable.
- **Asserted with no artifacts [SPEC]:** the Mamad8 comparison ("slower and softer, less skin detail" — "in our tests", no sheet, no wall-times, which Mamad8 quantization unstated); the edit lane's quality; "any size" (the one comparison PNG is a single seed at 2144×1216 — itself off our native-area envelope for the DiT).
- **VRAM/speed on 24GB at our stills resolutions: nothing measured anywhere in the pack.** Trainer-side facts that bound it: group decode costs 2.5× the decode tokens ("small at preview size"); tiling is measured (512-px single-pass seam energy 2.31 vs ~1.1 tiled, 256-px tiles). Our only anchor is the afvlbk4 8189 probe: the Mamad8 lane end-to-end ~63 s incl. cold loads — no decode decomposition, no Fizgig-side number exists. **The bake-off owns the envelope.**
- **The author bar:** shootthesound's trainer work is measurement-heavy (the 2026-09-19 Fizgig assessment: block-role maps, quant calibration) and these 94 lines carry the same culture — exact numbers, dated reverts, boundary-frame dB. Against astropuzzo's bar (measured wall-times, unfiltered committed comparison sheets, published negative results): **below on artifacts** (one PNG, zero tests, the GH workflow is registry-publish only), **comparable on mechanism honesty.** Bus factor 1, again.

## 3. COMPATIBILITY

- **ComfyUI floor v0.34.0 (`a87667f`): every private API the pack calls verified in-source [DOC]** — `comfy.nested_tensor.NestedTensor` (`.is_nested`/`.unbind()`), `MiniMaxH3VideoVAE._adaptive_decode` / `_finalize_pixels` / `latents_mean`/`latents_std` (`comfy/ldm/minimax/vae.py:417/398/382-383`), the `VAE.memory_used_decode` lambda (`comfy/sd.py:498+`), `load_models_gpu(…, force_full_load=)`, `intermediate_device()`. **Upstream master (fetched 2026-09-25): same APIs present** (`vae.py:483/502`). Works on our floor and the maintainer's latest-master instance.
- **The silent-degradation seam:** `hasattr(fsm, "_adaptive_decode")` falls back to the *banded stock decode* on a core lacking the API — the node "succeeds" while producing exactly the artifact it exists to fix. Our adoption must contract-assert behavior (pinned rev + served-schema capture, the afvlbk4 method), not presence alone — the same lesson as the taeh3 spot-check.
- **Weights licensing:** adds nothing (official Comfy-Org stack, already cataloged; the larryvrh turbo is already a tracked turbo-registry entry). **Retires** the `mamad8-t1-image-vae` fetch-consent row if adopted. Pack code MIT → unconditionally vendor-eligible; fetch-consent matches current posture; a registry row is required at adoption (lockstep audit).
- **Composition with our runtime-merge hybrid loader + override lanes: clean.** The latent node is model-agnostic; the hybrid merge feeds the same sampler; the decode keys on latent shape + the VAE model's API, not filenames. The `imageVae` override slot simply goes unused on a Fizgig T=1 path; `assertNoT1ImageVaeInVideoGraph` semantics are unaffected (frames=1).

## 4. THE SUPERSESSION QUESTION

**The ruling decomposed against our lane's three legs:**

1. **Legal latent** — same mechanism class; Fizgig's T=1-only variant is arguably better engineering for that lane (no conditioning reimplementation, legal length submitted, 94 lines vs 2,389).
2. **Recipe** — different author pins (ours: hybrid b25-49 + turbo @0.75 + detail @0.5, 8 steps; theirs: plain fl2va + v4-600 @0.38, 20 steps). Neither measured against the other.
3. **Decode** — the contested leg. Ours routes T=1 (and fast-sharp's slice) through the Mamad8 image VAE; Fizgig claims the video VAE with group replication beats it on speed *and* detail, with zero extra weights.

**Verdict on the claim: PARTIAL OVERLAP, not outright replacement — and unproven today.** Fizgig covers exactly one lane, T=1 stills. It does **not** cover: the exact 9/13 packet ladder (its latent node is T=1-hardcoded), fast-sharp's multi-frame sampling context, or multi-ref edit conditioning quality (their edit lane is stock REF conditioning on fl2va, hedged by the author himself). So: the **T=1 profile's graph is a REPLACE-candidate** (pending the bake-off); **Image Studio stays load-bearing** for packets and — pending the context arm — sharp.

**What happens to the just-landed investment (afvlbk4):**
- **Exact 9/13 ladder: SURVIVES** — Image Studio's territory, untouched by this pack.
- **Fast-sharp slice decode: premise survives, decode leg challenged.** Whether multi-frame context still buys quality once decode is equalized is precisely bake-off Arm D. If group-decode wins, the slice leg migrates to an extract-slice→replicate compose (~30 lines, MIT-clean) — a follow-up, not shipped.
- **Carries over regardless:** the execution-probe methodology, the served-schema fixture discipline, the audits, the stock-length:1 negative proof.
- **Dies on full migration:** the T=1 branch's pack-conditioning emission, the Mamad8 dependency on that path, the T1-VAE factory guard's reason to exist there.

**Migration sketch under the modularity contract:** one `ENGINE_NODE_PACKS` row (`fizgig-h3-still`, MIT, pinned `f3252d2`, classes `[FizgigH3StillLatent, FizgigH3StillDecode]`) → the T=1 builder branch flips to the stock-conditioning emission (that code already exists — it is today's pack-absent packet path), inserts the two Fizgig nodes, decodes via the video VAE → `detect` swaps `t1StudioPack` for the Fizgig classes → fixture captures the 2 real schemas (--cpu boot) → goldens regenerate. One audit allowance to write explicitly: the T=1 graph now *contains* a stock conditioning node at length=5 whose latent dangles — the audit must key the frame count on the latent source (FizgigH3StillLatent), never on the conditioning node's length. **Swap cost: smaller than the afvlbk4 adoption itself** (2 tiny classes vs 5, stock emission reused, zero new weights); removal = drop the row + branch + fixture entries, nothing welds.

## 5. THE TEST (the epistemology applies to rulings too)

**E-FS0 — the cheap falsifier first:** replicate the round-trip measurement through OUR staged video VAE — encode real photos, decode lone-token vs group-replicate vs **Mamad8** (the arm the author didn't publish), PSNR. CPU-able or a five-minute 8189 arm; directly tests 29.99/16.96 dB and extends it to the claim that actually matters to us.

**E-FS1 — matched arms, golden domains, blind pairs, cost-scored:**

- **Arm A (incumbent):** our T=1 Fast as landed — Image Studio Prepare (latent_t=1), hybrid+turbo@0.75+detail@0.5, 8 steps, Mamad8 decode.
- **Arm B (swap-isolated):** the SAME model+recipe as A; latent+decode via the Fizgig nodes. Single variable: the machinery.
- **Arm B2 (challenger-full):** Fizgig's shipped recipe (fl2va + v4-600 @0.38, 20 steps, er_sde/simple) + Fizgig nodes.
- **Arm C (decode-isolated):** A's latent/conditioning, Fizgig decode instead of Mamad8 — the cleanest single test of "is Mamad8 obsolete."
- **Arm D (context axis):** fast-sharp (5-context + slice decode) vs B — does multi-frame sampling context still buy quality once decode is equalized.
- **Domains:** portrait/skin-detail (their claim is skin-flavored), texture/fine-detail, edit-fidelity on an edit golden, composition/seed-spread. Blind pairs per the assessment-workspace discipline; cost rows = end-to-end wall-clock, decode-segment wall-clock, VRAM peak — at 768×1344 and the ~2.5 MP edit size.

**STATUS: PROPOSED-PENDING-TEST.** Fallback ladder: B/C lose → **CONFIRM** the incumbent (ledger the negative — the ruling answered "no"); C wins, B loses → hybrid migration (keep the Image Studio latent, adopt group-decode via the MIT-clean port); B wins wholesale → T=1 migrates to Fizgig, Image Studio stays for packets/sharp, Mamad8 retires pending D. **The maintainer's lean is recorded verbatim at the top of this document.**

## 6. VERDICT

| Question | Answer |
|---|---|
| What is it | 94-line MIT pack, 2 nodes: a true T=1 latent (same mechanism class as astropuzzo's, minus the conditioning reimplementation) + a group-replicate video-VAE decode that replaces the Mamad8 image VAE — zero extra weights |
| vs our T=1 lane | Challenges the decode leg head-on ("no reason to use" Mamad8) and minimizes the machinery (stock conditioning kept, legal length submitted); covers ONLY the T=1 lane — no packets, no context, weak edit story |
| Evidence | Trainer-measured 29.99 vs 16.96 dB round-trip (precisely cited, script not shipped); Mamad8 comparison asserted with zero artifacts; nothing measured on VRAM/speed |
| Compatibility | Verified API-by-API at v0.34.0 floor AND master [DOC]; silent-fallback seam needs a behavior contract; MIT; composes with hybrid loader + override lanes; retires a weight dependency |
| Supersession | Partial: T=1 profile is a replace-candidate pending measurement; Image Studio stays load-bearing for 9/13 packets (+sharp context); exact ladder survives, fast-sharp's decode leg is challenged, Mamad8 retirement is the stake |
| Migration | One registry row + one builder branch flip (reusing today's stock-emission path) + fixture + goldens — smaller than the adoption it would succeed; removal stays trivial |
| **Verdict** | **ADJUST** — a credible, mechanism-grounded challenge to the just-landed lane's decode choice and a real machinery minimization, but "obsolete" is unproven at hours old with zero validation artifacts; the T=1 method adjusts pending E-FS0/E-FS1, with the maintainer's lean on the record |

**Corrections/decisions this feeds:** queue E-FS0/E-FS1 into the next GPU batch (alongside the Fizgig trainer try-out, rswg9db — same author, different artifact); soften the fast-sharp rationale's "video-VAE softness ceiling" framing (the trainer's measurements attribute stills softness to out-of-distribution lone-token decode, not the video VAE itself); a `fizgig-h3-still` registry row only at adoption; re-price nothing until the bake-off reports.

---

## Examined-ledger entries (for node-pack-registry §9 absorption)

- **ComfyUI-Fizgig-H3-Still** (shootthesound, MIT, `f3252d2`, 2026-09-25): examined this pass — verdict **ADJUST**; PROPOSED-PENDING-TEST as the T=1 challenge arm (E-FS0/E-FS1); alt-ladder position: decode-port-only hybrid if C wins alone. Fresh-release doctrine applied (metrics dropped, repo hours old).
- **astropuzzo Image Studio v23.0.0** — still latest (re-verified via API 2026-09-25); the 2026-09-21 assessment remains current; its 4-class adoption stays load-bearing for packets/sharp regardless of this outcome.
- **shootthesound author file** — now three public artifacts: the Fizgig trainer (Apache-2.0, measurement-heavy), ComfyUI-H3Studio (NO-LICENSE, watch), and this pack (MIT, real file). The trainer's `single_frame_mode="group"` decode is the third independently-useful mechanism harvested from that codebase (after the block-role map and quant calibration).

---

## ADDENDUM 2026-09-26 — the repo moved (demo artifacts, not measurements); the dB number's status unchanged (ratify-and-verify pass 2)

Three commits since this assessment's pinned `f3252d2` (2026-09-26T00:24–00:30Z): `c6a1d69` (an **8 MP no-Turbo example workflow** + sample still, metadata stripped — README: 3872×2176, 50 steps, `er_sde`), `54eaa31` + `10d5171` (README: recommended sizes; decode tooltip wording; the single-frame VAE now named precisely `minimax_h3_t1_image_vae_step1597_int8_convrot.safetensors`). Registry version still **1.0.0**; the trainer (`shootthesound/Fizgig`, pushed 2026-09-25T23:06Z) still ships **no `tests/` and no diag script** (289-file tree at HEAD, checked 2026-09-26).

**Verdict impact: none.** §2's classification of the 29.99 vs 16.96 dB round-trip as precisely-cited-but-not-independently-runnable **stands** — the new artifacts are demo/validation-adjacent (one sample still, one workflow), not the measurement. E-FS0 (replicate the round-trip through OUR staged video VAE, CPU-able) remains the settling test, and now also covers the README's new "recommended sizes" claim.
