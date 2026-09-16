# Benchmark leaderboard — GENERATED, do not edit

Regenerated from `benchmarks/results/registry.json` by `node benchmarks/run.mjs --regen-leaderboard`. Never hand-edit; the registry is append-only and this file is a view of it.

- Rows: **41** across **7** suites
- Baseline environment: `2026-09-rtx3090-testbed` (`2026-09-rtx3090-testbed`: NVIDIA GeForce RTX 3090, driver 615.71.09, ComfyUI 0.34.x (Kreatine testbed @8189; gpu/driver recorded at backfill time, 2026-09-16 — 24 GB card))


Baseline environment detail: NVIDIA GeForce RTX 3090, driver 615.71.09, ComfyUI 0.34.x (Kreatine testbed @8189; gpu/driver recorded at backfill time, 2026-09-16 — 24 GB card)
## hybrid-ab — adaln-hybrid vs stock model on instruction edits (E-ED1)

**Measures:** Instruction-edit adherence and preservation: whole + horizontal-thirds PSNR vs the source clip (where did the edit land), ArcFace identity-through-edit vs the source face, wall-clock; blind vision read for edit landing + text survival.

**Incumbents (golden baseline, env `2026-09-rtx3090-testbed`):** stock Ref2VA — wardrobe swap (`2026-09-16.hybrid-ab.stock-wardrobe`); FL2VA+Ref2VA-adaln b25-49 (HybridLoader) — wardrobe swap (`2026-09-16.hybrid-ab.hybrid-wardrobe`)

| row | candidate | incumbent | headline metrics | verdict |
|---|---|---|---|---|
| `2026-09-16.hybrid-ab.stock-wardrobe` | stock Ref2VA — wardrobe swap | YES | thirds_psnr_whole_mean: 10 | E-ED1: stock lands the edit but is a full semantic re-synthesis (10 dB whole = re-render class); identity-through-edit 0.12-0.25. |
| `2026-09-16.hybrid-ab.hybrid-wardrobe` | FL2VA+Ref2VA-adaln b25-49 (HybridLoader) — wardrobe swap | YES | thirds_psnr_whole_mean: 13.37 | E-ED1: hybrid WINS the subject-preserving edit on every pixel metric simultaneously (+3.4 dB whole, +1.3-3.5 dB every third, identity ~2.5x) at ZERO wall cost — the recommended reference-mode for identity work (direction |
| `2026-09-16.hybrid-ab.stock-vs-hybrid-background` | background swap: stock 10.16 vs hybrid 10.38 dB whole (tie) | no | stock_whole_mean: 10.16; hybrid_whole_mean: 10.38 | E-ED1: NO hybrid advantage on scene-replacing edits (tie; stock held framing/counter better) + the first measured edit A/B on H3; text through edits survived legibly in all four gens — counter-evidence to the 'small text |

**Known limits:**
- Both arms are semantic re-synthesis (10-13 dB whole-frame), never pixel preservation — PSNR here measures CHANGE LOCALIZATION, not fidelity quality.
- Single seed, one edit pair per class — directional, not conclusive (the measured verdict is explicitly scoped so).
- Subject-preserving (wardrobe) vs scene-replacing (background) edits behave differently: hybrid won only the former.
- TE must stay qwen3vl int8 convrot — the nvfp4 TE is a known-bad path.

## movement-md1 — positional-guide movement director vs control methods (E-MD1)

**Measures:** Trajectory adherence: ball-centroid x error vs the plan at the checkpoints (pixel HSV tracker, cross-checked against direct pixel measurement), backtrack/teleport event counts, background PSNR vs the base render (appearance lock), wall-clock.

**Incumbent (golden baseline, env `2026-09-rtx3090-testbed`):** AddGuide positional stills at 0/17/34 (25/50/75%) (`2026-09-16.movement-md1.B`)

| row | candidate | incumbent | headline metrics | verdict |
|---|---|---|---|---|
| `2026-09-16.movement-md1.A` | control — direction unstated | no | checkpoint_err_pct_width_max: 69; backtracks: 17; teleports: 2 | E-MD1: unguided = direction roulette (both seeds rolled the WRONG way) with path jitter and depth drift; re-renders the scene (unrelated-instance class). |
| `2026-09-16.movement-md1.B` | AddGuide positional stills at 0/17/34 (25/50/75%) | YES | checkpoint_err_pct_width_max: 1.65; backtracks: 0; teleports: 0 | E-MD1: the maintainer's idea is a MOVEMENT DIRECTOR, full stop — plan landed to 0.0-1.65% width at every checkpoint, zero events, near-linear between anchors; BEATS the Fun-Control ceiling on this test; the movement dire |
| `2026-09-16.movement-md1.C` | guides + spatial path-band mask (rows 14-22 feather 0.5) | no | — | E-MD1: path-band mask adds ~1 dB preservation with identical tracking and NO grid artifact (#15981 lattice check clean). |
| `2026-09-16.movement-md1.D` | Fun Control union over sprite control video | no | — | E-MD1: good trajectory, wrong movie — shapes the PATH but anchors nothing else (each seed invents its own scene; ball renders maroon). |
| `2026-09-16.movement-md1.E` | VDN-arch + guides (turbo adapter OFF, 20 steps) | no | checkpoint_err_pct_width_max: 1.56; backtracks: 0; teleports: 0 | E-MD1: boundary-anchor hypothesis HOLDS — AddGuide keyframes survive the VDN hybrid-attention patch intact (B-identical tracking). |

**Known limits:**
- The HSV tracker cannot follow arms that render the ball off-color (measured: arm D renders maroon) — those positions are vision-read from full-res frames and labeled as such; contact-sheet vision position estimates were measured ±16% wrong at 288px tiles (trust pixel metrics for positions, vision for semantics).
- Arm C depends on the t3a_shims (T3aEncodeH3AVLatent + T3aSetH3SpatialNoiseMask) living on the testbed (gitignored there).
- Trajectory quality is judged against a LINEAR plan; a candidate whose value is expressive non-linear motion needs a plan-aware metric before the verdict is meaningful.

## nonhuman-fc1 — Fun Control pose-surface topology generalization (E-FC1)

**Measures:** Estimator round-trip keypoint error vs each arm's control keypoints (mean/median px, % of frame diag, % of subject-bbox diag, p50/p90), detection counts, manual vision tags (quadruped rendered vs humanized vs envelope-only), wall-clock.

**Incumbents (golden baseline, env `2026-09-rtx3090-testbed`):** human baseline (DWPose render -> Fun Control) (`2026-09-16.nonhuman-fc1.A`); sprite/region composite (the shipped workaround) (`2026-09-16.nonhuman-fc1.D`)

| row | candidate | incumbent | headline metrics | verdict |
|---|---|---|---|---|
| `2026-09-16.nonhuman-fc1.A` | human baseline (DWPose render -> Fun Control) | YES | err_px_mean: ~19.95 (2 pts) | E-FC1: the human-path calibration floor — 13.9-26.0 px round-trip error. |
| `2026-09-16.nonhuman-fc1.B` | AP-10K quadruped skeleton -> Fun Control | no | err_px_mean: ~57.25 (2 pts) | E-FC1: the pose surface is topology-TOLERANT, not agnostic — a real articulated dog every time (NEVER humanized), at ~3x the human-skeleton error. |
| `2026-09-16.nonhuman-fc1.C` | authored humanoid riding dog torso trajectory | no | — | E-FC1: skeleton structure is followed as a loose envelope when topology and prompt disagree — zero human articulation. |
| `2026-09-16.nonhuman-fc1.D` | sprite/region composite (the shipped workaround) | YES | err_px_mean: ~32.80 (2 pts) | E-FC1: sprite/region stays the reliable non-human DEFAULT (1.4-2x tighter than the AP-10K skeleton); the AP-10K template unlocks as first-class NON-DEFAULT with the measured label. |

**Known limits:**
- Round-trip error conflates control adherence and estimator noise; the human baseline A calibrates the floor (measured: A 13.9-26.0 px).
- Estimator torchscripts load to CUDA outside ComfyUI management — the estimator-restart rule applies between phases (restart or free_verified slack 900 MiB before sampling).
- The resolution=480 trick (k=1 on 480x832) is what keeps AP-10K keypoint JSON in native pixel coordinates — do not change resolution without remapping.
- Single subject class (dog); AP-10K covers more, untested here.

## preservation-k1 — Krea 2 measured-preservation ladder on image edits (E-K1)

**Measures:** Outside-region PSNR + dE76 (32-px boundary band excluded then included — separates AnyPaint's blend band from true drift), meanAD, VAE round-trip floor as the measurement floor, ArcFace identity through edits.

**Incumbents (golden baseline, env `2026-09-rtx3090-testbed`):** Identity Edit v1_2 on Turbo — coat change (`2026-09-16.preservation-k1.ie_instruct`); AnyPaint masked inpaint — lemons bowl (`2026-09-16.preservation-k1.ap_inpaint`)

| row | candidate | incumbent | headline metrics | verdict |
|---|---|---|---|---|
| `2026-09-16.preservation-k1.vae_floor` | VAE round-trip floor | no | — | E-K1: the measurement floor — any outside-region number must be read against ~46 dB. |
| `2026-09-16.preservation-k1.ie_instruct` | Identity Edit v1_2 on Turbo — coat change | YES | outside_psnr_db: 26.45; outside_de76: 4.78; arcface: 0.94 | E-K1: instruction edits LEAK ~26 dB outside the edit region (identity holds at 0.9362) — regenerative, not localized. |
| `2026-09-16.preservation-k1.ie_removal` | Identity Edit on RAW — handbag removal | no | outside_psnr_db: 27.66; outside_de76: 1.95; arcface: 0.98 | E-K1: removal on RAW is the cleaner edit path (33.9 dB excl-ring, identity 0.976). |
| `2026-09-16.preservation-k1.ap_inpaint` | AnyPaint masked inpaint — lemons bowl | YES | outside_psnr_db: 40.25; outside_de76: 0.63 | E-K1: the measured preservation CEILING — outside the 32-px blend band the image is VAE-floor-class (47 dB). |
| `2026-09-16.preservation-k1.ap_outpaint` | AnyPaint outpaint pad-right 512 | no | orig_region_psnr_db: 43.09; orig_region_excl_ring_psnr_db: 45.58 | E-K1: outpaint preserves the original region at 43-45.6 dB — near-floor. |
| `2026-09-16.preservation-k1.recipe_t0` | ReferenceLatent index_timestep_zero (off-recipe) | no | meanad: 40.06; psnr_db: 12.89; recipe_index_meanad: 5.30 | E-K1: the ostris recipe is off-recipe for the identity LoRA — 40 meanAD vs 5.3 for the on-recipe index method. |

**Known limits:**
- 1024x1024 STILLS — video preservation is a different regime (see hybrid-ab for H3 video edits).
- Outside-region PSNR conflates edit leakage and compression; the 32-px ring exclusion separates AnyPaint's intentional blend band.
- The identity-edit v1_2 LoRA is a single version; a candidate version bump may also need its pack's node updates (record pack pins).
- dE76 via manual sRGB->Lab (D65) — accurate enough for drift comparison, not colorimetry.

## ref2va-bakeoff — Ref2VA-class speed/identity bake-off (turbo LoRAs and fused checkpoints)

**Measures:** ArcFace identity vs the reference still at f0/f62/f123 (buffalo_l), wall-clock per arm, and the blind pairwise vision read. Same reference scene, matched prompt+seed across all arms.

**Incumbents (golden baseline, env `2026-09-rtx3090-testbed`):** larryvrh v4_step600_ema @8-step MERGE (drbaph-main lineage) (`2026-09-16.ref2va-bakeoff.main8`); MATLOWAI fused-turbo @4-step (catalog matlowai-fused-turbo-int8, sha-verified fetch) (`2026-09-16.ref2va-bakeoff.fused4`)

| row | candidate | incumbent | headline metrics | verdict |
|---|---|---|---|---|
| `2026-09-16.ref2va-bakeoff.t4` | official ref2v 4-step (lightx2v publish), MERGE mode | no | arcface_mean: 0.21; wall_s: 78.60 | 3a bake-off: the official 4-step is NOT usable at 4 steps in merge mode — later overturned in general by fused4 (the failure was THAT checkpoint, not the step count). |
| `2026-09-16.ref2va-bakeoff.l8` | lightx2v Ref2VA 8-step v1.0 768p | no | arcface_mean: 0.28; wall_s: 115.20 | 3a bake-off: the close runner-up — legitimate option, darker/warmer out of the box. |
| `2026-09-16.ref2va-bakeoff.main8` | larryvrh v4_step600_ema @8-step MERGE (drbaph-main lineage) | YES | arcface_mean: 0.27; wall_s: 117.30 | 3a bake-off + maintainer steer: the DEFAULT OF THE FAST TIER ONLY (neutral look) — identity indistinguishable from l8 (inside seed spread 0.12-0.37); 0.53x the 20-step wall. Turbo costs NO identity on Ref2VA. |
| `2026-09-16.ref2va-bakeoff.pdd8` | alibaba-pai PDD Ref2VA-Acc-8Step | no | — | 3a bake-off: PDD/Acc is not currently a Ref2VA option for us — fails to load on the pruned base via the stock node, exactly as the compat doc predicts (needs a PDD head loader/sampler). |
| `2026-09-16.ref2va-bakeoff.ref20` | no turbo, euler/simple 20 steps (anchor) | no | arcface_mean: 0.15; wall_s: 220.60 | 3a bake-off: the quality/identity anchor — and the proof the reference-mode identity ceiling is set by pose/lighting/resolution, not step count (0.154 sits INSIDE the turbo band 0.12-0.37). |
| `2026-09-16.ref2va-bakeoff.fused4` | MATLOWAI fused-turbo @4-step (catalog matlowai-fused-turbo-int8, sha-verified fetch) | YES | wall_s: 87.90 | 3b: the ref2va-at-4-step claim VERIFIES decisively — highest identity band of ANY arm (0.37-0.40 vs 0.09-0.24 everywhere else), 0.75x wall vs main8, blind clear-gap. COUNTERS (honest): Mystic v2.0 @0.7 folded in = STYLE- |

**Known limits:**
- Identity scores ride the reference-mode ceiling (pose/lighting/resolution bound, not step count) — tranche 3a measured every option inside the 0.12-0.37 ArcFace band with seed spread exceeding between-option gaps; a single seed is directional only.
- turbo LoRA arms measure the MERGE path (low_vram=True, the 24GB constraint); a bypass-mode candidate would need the node's non-merge path — record which path a candidate used.
- fused checkpoints fold style opinions (e.g. Mystic v2.0 @0.7 in fused4) — a blind win does not mean 'neutral look'; check the style counter before shipping a default.
- Walls include per-run /free reload overhead.

## tier-ladder — speed/quality tier ordering at a held seed

**Measures:** Same-seed cross-tier divergence (pairwise PSNR at f0/f62/f123), ArcFace identity vs the reference still, motion-timing delta (Pearson r, best lag, peak-activity index), per-tier wall-clock, and the blind tier-quality rank (two independent passes: 288px contact sheets + full-res grid).

**Incumbents (golden baseline, env `2026-09-rtx3090-testbed`):** turbo tier (larryvrh v4 MERGE + TurboSampler, 8 steps) (`2026-09-16.tier-ladder.t8`); plain euler/simple 20 steps (`2026-09-16.tier-ladder.t20`); plain euler/simple 25 steps (`2026-09-16.tier-ladder.t25`); VDN-arch hero (stage-dmd-step-250, turbo adapter OFF, 20 steps) (`2026-09-16.tier-ladder.vdn20`)

| row | candidate | incumbent | headline metrics | verdict |
|---|---|---|---|---|
| `2026-09-16.tier-ladder.t8` | turbo tier (larryvrh v4 MERGE + TurboSampler, 8 steps) | YES | wall_s: 117.30 | 3b held-seed tier arm: the 8-step turbo tier is the SHARPEST at full-res (two independent blind passes: t8 > vdn20 > t25 > t20) — the 'quality tiers' buy NO visible still detail at 480p ref-mode; tier value beyond turbo  |
| `2026-09-16.tier-ladder.t20` | plain euler/simple 20 steps | YES | wall_s: 220.60 | 3b: read SOFTEST of all four tiers at full-res — keep the full tier at 20 steps only for the unmeasured robustness axes, never for sharpness. |
| `2026-09-16.tier-ladder.t25` | plain euler/simple 25 steps | YES | wall_s: 272.50 | 3b: 25-step costs +23% wall over 20-step for nothing blind-visible ('milky haze/bloom flattening micro-contrast'). |
| `2026-09-16.tier-ladder.vdn20` | VDN-arch hero (stage-dmd-step-250, turbo adapter OFF, 20 steps) | YES | wall_s: 279.50 | 3b: near-tie with turbo on stills at 2.4x its wall — the VDN tier's value is the 10s-class architecture claim, not this 5s scene. |
| `2026-09-16.tier-ladder.held-seed-divergence` | same-seed cross-tier divergence (the sibling-take measurement) | no | best_lag_frames: 0 | 3b (the maintainer's question answered): same seed across tiers = a SIBLING TAKE, not a refinement — 18-25 dB divergence with changed set dressing; motion timing unchanged (lag 0); identity flat across ALL tiers. UI cons |
| `2026-09-16.tier-ladder.vdn8-10s` | VDN-8 first-hand timing (10 s @ 0.4 MP, sanctioned recipe, int8 TE) | no | steady_step_s: 23; sampling_span_s: 189; wall_with_reload_s: 270.40 | 3b: first-party hero-tier number — 23.0 s/step steady x8; gap to the maintainer's 15.74 decomposes into their int8-convrot VDN stage + AutoLongCache policy (both staged upgrades, not bugs). ~4.5 min wall end-to-end for 1 |

**Known limits:**
- STILLS-SHARPNESS ONLY: the 2026-09-16 blind finding ranks still-frame detail; turbo's documented costs live on the motion/audio/pinned-row-robustness axes, which this suite does not measure (the robustness-axes caveat).
- Single scene, single seed — tranche 3a measured seed spread up to 0.12-0.37 ArcFace within one option, so tier ordering at other seeds may wobble.
- Walls include per-run /free reload overhead; contact-sheet pass downsamples to 288px tiles.
- t8/t20 rows are REUSED bit-identical artifacts from ref2va-bakeoff at the same seed (deterministic graph + fixed noise).

## transitions-e1e4 — transition battery: bridge vs cut vs FLF, black-frame boundary, audio pinning, latent crossfade (E1-E4) + the chaining arms E5/E6

**Measures:** Seam quality at splice boundaries (seam PSNR dB + seam ratio = frame-delta at splice / median local motion), anchor fidelity dB of pinned regions, audio join cross-correlation + RMS level step, ArcFace across boundaries, handoff-chain drift trajectories (E5), shot-boundary adherence + looping + audio continuity (E6).

**Incumbents (golden baseline, env `2026-09-rtx3090-testbed`):** FLF splice (last-of-A + first-of-B stills) (`2026-09-16.transitions-e1e4.e1-flf`); hard cut + post (ffmpeg concat) (`2026-09-16.transitions-e1e4.e1-cut`); synthetic latent crossfade (decode-only + sampled) (`2026-09-16.transitions-e1e4.e4-crossfade`); E6: single-pass multi-shot (timed shots, <scenetrans>) (`2026-09-16.transitions-e1e4.e6-singlepass`)

| row | candidate | incumbent | headline metrics | verdict |
|---|---|---|---|---|
| `2026-09-16.transitions-e1e4.e1-flf` | FLF splice (last-of-A + first-of-B stills) | YES | — | E1: FLF is the splice champion — no seamless model-generated joins exist (every Strategy-B arm renders a well-formed internal cut); FLF joins are timeline-invisible. |
| `2026-09-16.transitions-e1e4.e1-bridge` | AddGuide bridge (A-tail@0 + B-head@-22) | no | — | E1: bridge renders a well-formed INTERNAL CUT, not a seamless join — diegetic-only. Replay anchors 36.5/31.5 dB; hard cut 9.8 dB. |
| `2026-09-16.transitions-e1e4.e1-cut` | hard cut + post (ffmpeg concat) | YES | — | E1: the baseline — a hard cut measures ~13 dB class against unrelated spans 11-15 dB; the gap menu default. |
| `2026-09-16.transitions-e1e4.e2-flash` | black-frame boundary (prompt flash + guided black) | no | audio_boundary_step_guided: 0.20; audio_boundary_step_control: 0.42 | E2: validated as a dip-to-black transition — the ~0.7 s dip is STRUCTURAL (temporal-VAE grid), not a defect; guided black halves the audio boundary step; audio survives all black boundaries. |
| `2026-09-16.transitions-e1e4.e3-airlock` | airlock + audio pinning 2x2 | no | join_corr_unpinned: 0.04; join_corr_pinned: 0.87; min_airlock_mad: 1.10 | E3: Motion-Context audio-pinning replicated on our stack (published 0.45->0.95+); airlock is not a seam tool on ambient content; guided-boundary video seams invisible in all arms. |
| `2026-09-16.transitions-e1e4.e4-crossfade` | synthetic latent crossfade (decode-only + sampled) | YES | endpoint_psnr_db: 36.50 | E4: PRODUCT PATH — the zero-prior-art synthetic-latent transition works: decode-only == pixel dissolve (round-trip class at endpoints); the sampled arm preserves pinned synthesized rows. Open knob: back-loaded pacing (tr |
| `2026-09-16.transitions-e1e4.e5-ref-video` | E5 chain A22: ref_video continuation (ref2va) | no | anchor_db: 10; arcface_hop1: 0.12; wall_multiplier_vs_replay: 0.77 | E5: ref_video = the STORY engine — all beats on schedule, weakest anchors, identity dies first; not a continuity tool. |
| `2026-09-16.transitions-e1e4.e5-replay` | E5 chain B22: AddGuide pixel replay (fl2va) | no | wall_penalty_pct: 30 | E5: replay = the balanced default — strong anchors at +30% wall. |
| `2026-09-16.transitions-e1e4.e5-latent-handoff` | E5 chains C22/C39: raw latent handoff (nested noise-mask shim) | no | — | E5: latent handoff = the continuity engine (loopforge's latent>pixel ordering replicated) BUT pins DRAG content back to the source scene (the 39f pin lost the hallway beat entirely). Chain guidance: 22f default, 39f when |
| `2026-09-16.transitions-e1e4.e6-singlepass` | E6: single-pass multi-shot (timed shots, <scenetrans>) | YES | cost_vs_cut_together: 0.78 | E6: single-pass multi-shot WINS at our tier — cuts land within 1-4 frames of instruction, zero looping, audio 4-20x smoother than hard-cut concat; <scenetrans>+audio clauses bought NOTHING measurable; identity weak in BO |
| `2026-09-16.transitions-e1e4.cost-survey` | turbo-8 vs VDN-8 cost (survey-calibration rows) | no | turbo_step_s: 28.70; vdn_step_s: 15.70 | Tranche 1 cost row: turbo-8 dense MISSES the 2-3 min target (282-306 s/10 s @0.4MP); VDN-8 MEETS it (2:05). |

**Known limits:**
- Pinned-row arms must run turbo OFF at 20 steps (turbo mispredicts pinned rows — documented); unpinned arms run turbo-8.
- E4's crossfade window is 39 frames (phase-exact grid point); other windows are off-phase on audio.
- Seam ratio is content-relative (divided by median local motion) — compare only within the same scene.
- E5 chains condition on their OWN previous output (drift compounds); seg1 is the tranche-1 srcA latent by design.
- E6 arms measure PROMPT adherence (cut timing/looping), not seam quality.

