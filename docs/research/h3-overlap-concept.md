# H3 overlap chaining — concept assessment (ComfyUI-H3-Overlap)

> Flux input: **Drift-envelope suite (5nfy24y)** — this assessment feeds the
> mitigation-matrix arms; no separate task. Date: **2026-09-25**. METHOD:
> full code-read of the pack at pinned revision + workflow-JSON dissection +
> our measured tranche addenda + literature verification (web); **no GPU, no
> engine, no installs**. Evidence tags: **[DOC]** verified in code/official
> source, **[COMM]** reputable community finding, **[SPEC]**
> plausible-unverified, **[UNK]** nobody knows.
>
> **Provenance:** [MisterAzor1/ComfyUI-H3-Overlap](https://github.com/MisterAzor1/ComfyUI-H3-Overlap),
> pinned revision `e2f2bc6fa8deb2947dd8a8b9e011db75afcca0f2` (repo HEAD at
> assessment time; author date 2026-09-26T00:29Z — the repo is ~1 day old, so
> the fresh-release doctrine applies throughout: mechanism-read only, no
> community-signal assessment). Files read: `nodes.py` (191 lines, the entire
> pack), `__init__.py`, `README.md`, `pyproject.toml`, `LICENSE`, both
> example workflow JSONs (node/link graph traced, not just opened).
>
> **Maintainer framing (2026-09-25):** "this is an idea I was envisioning
> earlier for long chains, and to try and avoid quality degradation for as
> long as possible. Not this node pack exactly, but the concept is sound."
> Two mid-assessment directives (same day), both folded in: **"do something
> like this using pixel space to preview, but work in latent space"** (→
> §0), and the **seam re-denoise proposal** — inject partial noise at the
> seams and re-denoise under references, the stitch as its own window with
> a blended transition prompt (→ §2.5). Each independently matches what the
> code reading and our tranche measurements produced.

---

## 0. The design directive: pixel space previews, latent space works

The maintainer's one-line architecture, made concrete by everything below:

- **The authoritative chain state is latents** — our latent-fork/LoadLatent
  doctrine (puy428n, live-verified; never re-encode across a chain). The
  overlap *joint* — the carried region between windows — is carried,
  conditioned, and reconciled in latent space, and the chain decodes **once**
  per committed window (LongMedia's `stitch_continuation` proves latent-space
  accumulation with a CPU-offloaded accumulator is shipped practice
  **[DOC]**).
- **Pixel space is the QC/preview surface** — the joint neighborhood is
  decoded at *preview* resolution (the PreviewOverride path, PR #48:
  taeh3/TAE-class decoder, never the 5B video VAE) to check seam visibility
  before a window commits. The pack's `H3OverlapStitch` pixel crossfade is
  exactly this surface, and *only* this surface, in our architecture: the
  human-facing / blind-read visualization of the joint, never the chain's
  truth.
- The pack inverts this: pixels are its *work* path (VAE re-encode of the
  tail every window) and it has no preview notion at all. Everything the
  pack must do in pixel space is precisely what our latent path exists to
  avoid — a **CONFIRM-by-counterexample** of the never-re-encode doctrine
  (third-party pixel carry at every seam = per-window re-encode, decode
  variance at every joint, audio permanently out of band).

### 0.1 The window-context invariant (maintainer, 2026-09-25)

> "The window always gets the right visual, textual, and temporal context."

This is the contract every window composition must satisfy — seam windows
included; a seam is a first-class window, not an afterthought stitch. What
"right" means per axis, on our stack:

- **Visual** — carried joint flanks as *latents* via the fork (never
  re-encoded), the identity payload (refs/RefMods) re-attached per window in
  correct wiring order, and the joint strip sourced from the previous
  generation's own tail. The pack gets visual context by pixel re-encode of
  a fixed source — legitimate for restyling, wrong for chains whose visual
  state is the evolving generation itself.
- **Textual** — the durable-state/action split (ecosystem sweep §3.12):
  identity/style/world text carried *verbatim* across windows; action text
  owned by the window's own timestamps and never replayed; seam windows get
  a blended or authored transition prompt. "Right" means *non-contradictory*
  composition — prompt contradictions render as unions (both contents
  appear), so naive concatenation of two windows' prompts is a defect, not a
  shortcut.
- **Temporal** — grid-valid window lengths (5+17g frames), joint widths on
  the audio phase grid (≡ 0 mod 3; 39 = phase-exact), AddGuide pins at the
  window's true frame indices, and the chain-manager records supplying
  upstream-locked / downstream-planned position so a window knows where it
  sits in the take.

For the drift-envelope, the invariant is also an experimental control: any
arm that fails it (stale refs, replayed action text, off-grid joints)
measures the *invariant violation*, not the mitigation.

### 0.2 The prompt timeline — layered, timestamped, embeddings precomputed (maintainer, 2026-09-25)

> "A prompt not just be a box, but timestamped on a timeline… elements
> present throughout get a large timerange… smaller 'beat'-level prompts…
> concated together, or layered… prompt context determined by position in
> real time; precompute the embeddings for the entire chain at every
> interval we know we are going to sample at and cache them ahead of time —
> no swapping between text encoder and generation pass; all deterministic."

This is the textual axis of §0.1 made structural — and it lands on shipped
prior art plus one new systems idea:

- **Chain-level prompt intervals are documented territory, in pieces.**
  H3's official base guide already timestamps *within* one generation
  (`[Shot N] At MM:SS.mmm`, strictly increasing cut times) **[DOC]**; FL
  PromptTimeline schedules prompt sections over video tokens in
  seconds/frames/beats via *temporal conditioning masks on the native grid*
  (token-level layering inside a window) **[DOC, ecosystem sweep]**;
  LongMedia's MultiClip planner + `continuity_policy` split prompt text into
  durable state vs action-owned-by-timestamps **[DOC, ecosystem sweep]**.
  The maintainer's formulation unifies these: durable elements get
  chain-long intervals, beats get narrow ones, and a window's text = the
  composition of layers active at its position. The two composition modes
  are complementary, not competing: **concat** (active layers joined into
  one encode per window — safe, respects the ≤7000-char limit and ordering
  discipline) vs **token-mask layering** (one window, spans placed at their
  exact time slices — the FL mechanism, sharper for beats that begin
  mid-window).
- **Embedding precompute is the new contribution — and it is feasible
  today.** The window grid of a chain is known before sampling starts
  (deterministic: window lengths, strides, joint positions are all decided
  at graph-compile time), therefore the per-window composed prompts are
  known too: encode them *all* in one pass, cache the COND tensors, index
  by window during the sampling loop. The pack's own workflow already
  caches one static conditioning via SetNode/GetNode across its batch loop
  — generalizing to a per-window conditioning list is a graph-factory
  concern we own, not a model capability gap **[DOC]**.
- **What it buys, concretely:** (a) *determinism* — fixed seeds + cached
  embeddings + latent-fork carry make a chain re-run bit-stable given
  unchanged weights, which is exactly the property the locked-chains /
  regenerate-downstream model needs (re-roll window N; downstream replays
  identically unless its conditioning or carried latents changed);
  (b) *bit-identical durable conditioning* — the byte-identical text
  discipline becomes embedding-identical by construction, closing the
  prompt-drift axis structurally rather than by discipline; (c) *VRAM and
  wall-clock* — the Qwen3-VL-32B encoder can unload before the sampling
  loop instead of swapping against the 33B DiT per window; (d) *cache
  invalidation is localized* — editing one beat re-encodes only windows
  whose active-layer composition changed, keyed by composed-text hash
  (the same hash-bound-binding doctrine as the latent manifest, applied to
  conditioning).
- **Honest caveats:** the ≤7000-char prompt ceiling applies per composed
  window (a dense beat stack plus full durable state can hit it — the
  compiler must budget layers); ordering discipline survives (ref/Picture
  numbering is wiring order, not prose order — unchanged); and
  precompute assumes the sampling schedule is frozen before generation —
  interactive mid-chain prompt edits re-open only the affected windows'
  encodes, not the whole pass.
- **Drift-envelope placement:** this is primarily an *architecture* input
  (the chain manager's conditioning model) rather than a new arm — but it
  hardens every arm's textual control: prompt-drift variance across hops
  goes to zero by construction, so any remaining drift in the arms is
  attributable to the visual/temporal axes where the mitigation questions
  actually live.

## 1. The mechanism, precisely — what the pack actually does

### 1.1 What it is (and is not)

The pack is **not** a text-to-video chain continuer. It is a
**VRAM-friendly long-video *re-render* chunker**: an existing source video
(tested to 643 frames, ~0.5 MP processing, 12 GB VRAM) is pushed through an
H3 Ref2VA restyle/enhancement pass in fixed 90-frame windows, and the windows
 are stitched back to the exact original frame count **[DOC, code-read]**.

Two nodes, 191 lines, zero dependencies beyond torch **[DOC]**:

- **`H3OverlapPrepare`** — converts a VHS batch stream into fixed-size
  overlapping windows. `window = previous_tail(8f) + new(82f)`, padded to
  `window_size` by repeating the last frame; the constraint is
  `source batch = window − overlap` (82 = 90 − 8). It tracks `real_new_frames`,
  `is_first_batch`, `is_last_batch`, and resets its cached tail on
  source-count/resolution change — within-run chain-identity hygiene of the
  same class as the hash-bound binding we adopted from wan2gp-h3-latent-continue
  (weaker: it cannot distinguish two same-length same-shape sources after an
  interrupted run; ComfyUI's instance-per-execution behavior is what actually
  saves it between runs) **[DOC]**.
- **`H3OverlapStitch`** — holds back each generation's last `overlap` frames,
  then linearly crossfades them against the next generation's re-rendered
  version of the same frames: `weights = linspace(0, 1, N+2)[1:-1]`,
  `blended = old·(1−w) + new·w`, emitting blend + new-only frames, padding
  stripped, total length preserved **[DOC]**.

### 1.2 The shipped pipeline (workflow traced)

Window → `CreateVideo` (with **EmptyAudio** — the reference video is silent)
→ `AIToolkitMiniMaxH3RefVideo` (ref-strength **0.59**) → `MiniMaxH3AddGuide`
(first frame pinned at 0) → `SamplerCustomAdvanced` (euler, `simple` 8 steps,
CFG 1, turbo-4step LoRA @ 0.5, **`RandomNoise` seed 42 fixed — every window
samples from the same initial noise**) → `LTXVSeparateAVLatent` (generated
audio **separated and discarded**) → optional 3D latent upscaler →
`VAEDecode` → stitch → `VHS_VideoCombine` with **the original source's audio
muxed back** **[DOC]**.

### 1.3 The seam, answered exactly

- **What carries across the seam:** 8 *pixel* frames of the previous batch's
  real tail. They are VAE re-encoded fresh each window as part of the
  reference-video conditioning. **No latent carries. No audio carries** —
  audio bypasses the entire H3 pass (source audio in, generated audio
  discarded) **[DOC]**.
- **How the seam is hidden:** three cooperating tricks, none of them latent
  blending — (a) the next window's *conditioning* includes the overlap
  content (content continuity), (b) identical fixed noise + identical prompt
  across windows (render correlation — a crude FreeNoise-class
  shared-noise trick), (c) an 8-frame linear pixel crossfade between the two
  renders of the shared frames **[DOC]**. There is **no co-denoising** —
  windows sample fully independently; reconciliation is entirely post-hoc.
- **Audio and OVERLAP:** the concept's load-bearing gap for us. H3 is joint
  AV, but this pack's overlap treats the audio track as *out of scope by
  construction* — fine for re-rendering an existing video (the source audio
  is the truth), meaningless for generation chains where window N+1's audio
  must join window N's audio. Additionally the default 8-frame overlap is
  **off the audio phase grid**: `audio_steps = frames × 5/3`, whole only for
  frame counts ≡ 0 (mod 3); 8 f → 13.33 steps — the exact off-grid condition
  Motion Context documents as producing ticks **[DOC]** (grid math ours,
  community-documented).

### 1.4 The overlap-family taxonomy (where this pack sits)

| Flavor | Carrier | Reconciliation | Prior art |
|---|---|---|---|
| Pinned context joint (hard) | tail latents as non-denoised rows | none needed (rows bit-exact); seam moves to pinned/free boundary | loopforge 22/39f, Motion Context, LongMedia `prepare_continuation` (constant denoise), our latent-fork **[DOC]** |
| Regenerate + **pixel** blend | tail pixels, re-encoded per window | post-hoc linear crossfade in pixel space | **this pack**; community stitchers' 4-frame crossfades **[DOC]** |
| Regenerate + **latent** blend | tail latents | post-hoc blend in latent space, single joint decode | LongMedia `stitch_continuation` (`blend_video_overlap`); our E4 latent crossfade (measured 29–36.6 dB decode-only) **[DOC]** |
| Co-denoising overlap | shared latent region *during* sampling | reconciled in denoising itself | Gen-L-Video temporal co-denoising; VidPanos' interpolated token distributions in overlap regions **[DOC, literature]** — *not possible with H3's sampler without graph surgery* |

The pack is flavor 2. The maintainer's directive moves us to flavor 3
(with flavor 1 already in hand), with flavor-2 machinery retained as the
preview surface.

## 2. The concept, stress-tested

### 2.1 The central honesty: overlap is a seam mechanism, not a drift-arrest mechanism

"Avoid quality degradation for as long as possible" is only partially served
by overlap. The decomposition:

- **Variance vs bias.** Blending two renders of the overlap averages
  *independent render variance* (burst-fusion condition — same content, two
  decodes, bounded by the ±0.039 ArcFace / ±0.38 dE noise floor). Averaging
  does nothing to *bias* — the systematic component that actually walks a
  chain **[COMM, loopforge: drift is directional relaxation, not a random
  walk]**.
- **Why bias persists:** every generation-chain window is conditioned on
  self-generated context regardless of overlap width. That is textbook
  exposure bias — FIFO-Diffusion names it as *the* infinite-generation
  failure and attacks it with drift correction (rescaling generated-frame
  statistics toward earlier frames) *on top of* its queue mechanism;
  Self-Forcing concedes the training-free world can only mitigate, not
  remove, it **[DOC, literature]**. Our own measurements agree: raw latent
  handoff is the continuity engine (39–42 dB anchors, invisible seams) and
  identity *still* dies first in ref_video chains; loopforge measured latent
  vs pixel handoff as identity-neutral (0.791 vs 0.813 ArcFace — within
  noise) **[COMM + our tranche 1/2]**. Wider/softer joints buy **local**
  runway (seam quality, motion continuity, variance), not **global** runway
  (identity, color walk). Global runway comes from the re-anchor / payload /
  stabilize axes the drift-envelope already arms.
- **Predicted consequence for the experiment:** overlap arms should extend
  the *motion/seam* axis runway substantially, the *identity* axis barely,
  and the *color* axis only if paired with per-join stabilization or
  FIFO-style mean reversion. This is falsifiable and belongs in the suite.

### 2.2 Where overlap-chaining still degrades (failure catalog)

1. **Drift in the overlap itself.** Hard-pinned joints *freeze* the prior
   window's drift and carry it forward bit-exact (accumulation unchanged);
   re-rendered joints inherit drift *and* add render variance before the
   blend. Either way the joint is a drift conveyor. LongMedia's shipped
   counter-finding belongs here: a *constant* overlap denoise preserves
   continuity better than a soft ramp in long-media use — the joint-schedule
   knob (constant vs feathered) is a real axis, not a detail **[DOC]**.
2. **Ghosting when renders decorrelate.** The crossfade assumes the two
   renders of the overlap are temporally aligned. Under strong processing
   (or motion), window N+1's re-render of the tail lands offset in time or
   detail → the blend region ghosts. The pack's own troubleshooting admits
   it: "Visible transition between windows → increase the overlap slightly
   or reduce the amount of visual change" — i.e., overlap length must scale
   with processing strength, and the failure mode of getting it wrong is
   *soft ghosting*, not a clean seam **[DOC]**.
3. **Motion drag / stagnation at hard joints.** Pinned context makes H3
   "reconstruct a plausible continuation rather than copying pixels"; our
   tranche-2 measured the 39f pin *losing the hallway beat entirely* — the
   wider the hard joint, the more new content is dragged back toward the
   source scene **[COMM + our tranche 2]**. Soft joints (ref-strength < 1)
   trade drag for alignment risk — this is the pack's 0.59 choice, and the
   dial it sits on (joint strength) is the concept's most interesting knob.
4. **Audio discontinuity.** Unhandled by the pack by design (§1.3). For
   generation chains: the joint's audio must be pinned/frozen or
   phase-aligned, and overlap length must be a multiple of 3 frames for
   whole audio steps (39 f = 65 steps is the phase-exact class). An
   8-frame-style default is structurally wrong for joint AV **[DOC]**.
5. **Redundant compute.** Every overlap frame is generated twice (or held
   pinned). Overhead vs unchunked generation = window/stride − 1: the pack's
   90/8 = **9%**; a 90/21 joint = **23%**; a 107/39 joint = **57%**
   **[DOC, arithmetic]**. Cost-per-delta discipline applies (§4).
6. **Identity accumulation** — untouched by any of the above; belongs to the
   payload/re-anchor axes (drift-envelope arms B/C) **[COMM + our tranche 2]**.

### 2.3 The pack's evidence: claims vs shows

README claims "seamless crossfade stitching"; the repo publishes **no
measurements** — no seam dB, no before/after frames, no drift numbers; the
example workflow's compare group shows the author validated visually
(side-by-side labeled GT vs processed). "Tested Configuration" is honest and
useful (12 GB VRAM, 643 frames, 0.5 MP, portrait/landscape) **[DOC]**. Per
the fresh-release doctrine: mechanism sound and carefully coded for its
purpose; quality claims unharness-verified. Nothing here is load-bearing for
us — our own tranche measurements are stronger evidence on every quality
question the pack touches.

### 2.4 The theoretical frame it ignores (and we shouldn't)

The pack cites no literature. The concept it re-implements has a
well-developed frame **[DOC, literature — verified 2026-09-25]**:

- **Gen-L-Video** (Wang et al., 2023): temporal *co-denoising* of
  overlapping short clips — overlapping regions reconciled **during**
  denoising, not post-hoc; multi-text conditioning per window. The
  quality ceiling of the overlap idea (unreachable with H3's stock sampler
  without graph surgery — our joints are necessarily post-hoc or pinned).
- **FreeNoise** (Qiu et al., ICLR 2024): consistency across windows via
  *correlated/rescheduled noise* + windowed temporal attention. The pack's
  fixed-seed-every-window is a one-line crude relative; deliberate noise
  correlation across chain windows is a cheap, unexplored dial for us.
- **FIFO-Diffusion** (Kim et al., NeurIPS 2024): queue/diagonal denoising
  for infinite video; names drift (exposure bias) explicitly and adds
  *drift correction* (statistical rescaling toward earlier frames) — the
  direct precedent for treating color/exposure walk as a correctable bias
  on top of any windowing scheme.
- **Self-Forcing** (Huang et al., 2025): the training-side concession —
  AR drift is a train/test distribution gap; training-free mitigation
  (everything available to us) can soften, not eliminate, accumulation.
- **VidPanos** (in our pan-stitch doc): the *spatial* cousin —
  sliding-window aggregation with interpolated distributions in overlap
  regions, plus merge-original-pixels-back anchor authority. Its
  overlap-agreement metric (SSIM/PSNR of the two renders of the shared
  region) is exactly the right *joint-quality* pre-commit gate for our
  chains.

**Net:** overlap-chaining is a rediscovery of sliding-window diffusion's
consensus trick, one flavor down (post-hoc pixel blend) from the literature's
best (co-denoising), and the literature's drift findings independently
predict §2.1's decomposition. The concept is sound *as a local-continuity
mechanism* and oversold *as a degradation stopper* — which is precisely the
split our drift-envelope axes measure.

### 2.5 The maintainer's seam re-denoise proposal — plausibility check (2026-09-25, mid-assessment)

> "Inject a bit of noise into the latents at the seams and then denoise them
> over again… slide the window, and denoise at the seams, using references
> to ensure consistency… the stitch can be its own context window and
> prompt… blending the tail end of a prompt from the first chain and the
> start of a prompt from a second chain."

**Verdict up front: mechanically fully supported by native H3 primitives,
theoretically the right attack on the drift component blending cannot touch —
with one boundary condition (it corrects only what it re-noises).** Detailed:

- **Every primitive exists natively [DOC]:** H3 ships per-token latent noise
  masks (`denoise_mask`, PR #15375: 0 = preserve, 1 = regenerate, video
  masks on the 2×2 latent grid, audio on whole latent frames), conditioning
  rows that are *re-injected every step and never denoised*, `AddGuide`
  any-frame pinning, and surfaced sigma scheduling
  (`MiniMaxH3SigmaShift`). "Seam strip mask=1, flanks mask=0, sampler
  started at an intermediate sigma" is a legal graph today — this is SDEdit
  (Meng et al., 2022 — partial re-noise then denoise back to the prior
  manifold) applied at an anchored joint.
- **Our stack already validated the load-bearing half [DOC, our tranche 1]:**
  E4's *sampled* arm preserved pinned **synthesized** latent rows at
  31.5–39.8 dB — sampling around pinned latent rows works here. Closest
  shipped prior art: FL-MiniMaxH3Transition's masked-latent bridge (pinned
  head/tail token rows, noise_mask=1 middle, optional feathered boundary
  ramp) — but the FL bridge *fully generates* the middle from two pinned
  stills; the maintainer's variant **partially re-noises the actual seam
  latents** and therefore starts from nearly-correct content. That is a
  strictly better-positioned variant than bridge-by-generation, which our
  E1 measured as the weak arm (19.1/15.9 dB vs FLF's 36.2/34.3) — untested
  but genuinely new as a *chain* mechanism.
- **Why it attacks the right component:** §2.1's split says blending
  averages *variance* while drift is *bias*. A flank-pinned partial
  re-denoise is a **re-projection toward the model prior under anchors** —
  each joint becomes a laundering point where off-manifold accumulation is
  pulled back toward in-distribution content, with references/RefMods
  enforcing identity during the pull (the E7 question — refs attach to any
  generation; mechanically trivial, value unmeasured). This is the same
  family as FIFO's past-correction insight: correct the bias at anchor
  points, on top of the windowing scheme. RePaint's resampling trick
  (repeated noise/denoise cycles at the masked region for flank harmony) is
  the known refinement if a single pass leaves the strip discordant with its
  flanks **[DOC, literature]**.
- **The boundary condition — it corrects only what it re-noises.** Seam
  strips correct joints; window *interiors* keep their accumulated drift
  untouched. Two consequences: (a) interior drift still needs the re-anchor
  axis (or payload) — seam re-denoise is a *joint* doctor, not a chain
  cure; (b) widening the strip toward "most of the window" turns the chain
  into a rolling refine (repeated SDEdit over most content — converging
  toward FIFO-style repeated projection), which is a legitimate but
  different (and pricier) regime, with its own failure mode: repeated
  low-level re-noising is a low-pass operation — **texture over-smoothing**
  (the detail-loss side of every img2img), the mirror image of the texture
  ratchet. Over-smoothing must be a measured axis, not an assumption.
- **Risk catalog:** (1) the re-noise level (starting sigma) is *the* dial —
  too low = no correction, too high = motion/identity re-roll at the seam;
  expect a motion-dependent sweet spot. (2) Motion stagnation: flanks
  dominate a narrow strip → averaged/frozen motion (same class as pin
  drag). (3) Audio: the seam's audio rows need flank pinning and
  phase-aligned strip length (multiple of 3 frames); partial audio
  re-noise risks cover-band joins **[SPEC]**. (4) The blended transition
  prompt is the right alternative to naive prompt concatenation — prompt
  contradictions render as *unions* (both contents appear) — but E6
  measured `<scenetrans>`/audio-clause prompt machinery buying nothing
  measurable, so the prompt-blend's value is **[UNK]** pending measurement;
  javawock's Bridge (LLM-authored bridge prompt) is the prior art for
  authoring it. (5) Fixed recipe hazard: sigma start must scale with
  content motion; a static value will over-correct static scenes and
  under-correct fast ones.
- **Plausibility answer to the maintainer:** plausible and buildable today
  with zero new model-side capability; it is the strongest single idea in
  this assessment because it is the only mechanism here that attacks drift
  *bias* rather than variance — with the honest scope: joints, not
  interiors, unless widened into a rolling refine.

## 3. Versus our existing mitigations — stackability

| Existing piece | Relation to overlap | Verdict |
|---|---|---|
| First-frame handoff chains (current default) | Overlap generalizes the single-frame joint to a k-frame region *with reconciliation*. Baseline A of the drift-envelope (22f continuation) is already a minimal hard-context joint — the new axes are **joint width**, **joint strength** (hard pin vs soft ref), and **reconciliation** (splice / latent blend / pixel-preview blend). | Complementary — overlap is the generalization |
| Latent-fork LoadLatent (puy428n, never-re-encode) | The *carrier* for any hard joint: tail rows fork as latents, pinned non-denoised into the next window. Overlap concept rides on top of the fork unchanged. The pack's pixel-carrier is the counterexample that justifies the fork. | Complementary — fork is the transport, overlap is the joint policy |
| Measured transitions / E4 latent crossfade (tranche 1) | The E4 machinery (decode-only ≡ pixel dissolve, 29–36.6 dB; sampled arm preserves pinned synthesized rows, 31.5–39.8 dB) *is* the latent-space reconciliation flavor, already validated on our stack. | Complementary — E4 is the reconciler |
| Measured-transition LoRA timeline (7twfk6o) | Orthogonal axis (content planning vs continuity plumbing). | Stackable |
| Chain manager (locked chains, regenerate-downstream, epic 4lphxv8) | The overlap joint is the natural **re-entry point** for regenerate-downstream: a k-frame joint is a wider, more robust re-entry than a single keyframe — the regenerated window re-anchors to k frames of locked context, and the pixel-space joint preview is the commit gate the manager shows before replacing downstream. | Complementary — joints become the manager's re-entry records |

**The combined mitigation recipe** (candidate for the drift-envelope's
combined-best): latent-fork carry (never re-encode) + soft-or-hard overlap
joint at grid-valid width (21/24 general, 39 audio-phase-exact) + latent
reconciliation at the joint (E4 blend, single decode) + identity payload +
periodic re-anchor from canonical take + per-join color stabilize
(FIFO-style mean reversion toward segment-1 statistics) + frozen-audio-prefix
on the joint's audio rows. Pixel space appears only as the preview/QC decode
(PreviewOverride path) of the joint neighborhood.

## 4. Drift-envelope experiment input (the deliverable for 5nfy24y)

### 4.1 Proposed arms (mapped onto the existing A/B/C/F lettering — new arms use O*/G to avoid collision)

Existing: **A** baseline plain 22f continuation · **B** +identity payload ·
**C** +payload +re-anchor@4 · **F** combined-best · 39f spot-check ·
frozen-audio-prefix audio arm (from the wan2gp addendum). Add:

| Arm | Design | Redundant compute | Isolates |
|---|---|---|---|
| **O-soft** | window 90 (grid-valid: 5+17×5), joint k=21 (audio-whole), prior tail as *ref-video conditioning at s<1* (pack's mechanism, latent-ized: tail carried by latent-fork, decoded-joint blend via E4), single decode | 23% | Soft joint vs A's hard context — the pack's actual contribution |
| **O-hard** | same window, joint rows *pinned non-denoised* (latent-fork), hard splice at pinned/free boundary | 23% | Wider hard joint vs A (context-width axis) |
| **O-39-audio** | window 107, joint k=39 phase-exact, **frozen-audio-prefix** rows on the joint | 57% | Audio-exact jointing (audio-axis arm; subsumes the queued frozen-prefix spot-check) |
| **O-blend-axis** (within O-soft/O-hard) | reconciliation variant: hard splice vs latent blend vs (preview-only) pixel blend — and joint schedule constant vs feathered (LongMedia's counter-finding) | ~0 | The reconciliation and schedule dials |
| **G** combined-best v2 | winner joint type + payload + re-anchor@4 + per-join stabilize + frozen audio | winner + stabilizer cost | The recipe (candidate F-successor) |
| **S** seam re-denoise (§2.5) | sliding-window chain; at each joint, seam strip k ∈ {17, 39} partially re-noised (sigma start ~20–35% of schedule, motion-scaled), flanks pinned (denoise_mask 0), refs/RefMod attached, blended or authored transition prompt; optionally RePaint-style 2–3 resample cycles at the strip | strip re-denoise ≈ strip/window of a *short* extra pass (a strip-window generation, not a full window) — cheapest arm per hop after A | The only bias-attacking mechanism in the matrix — does joint re-projection measurably extend runway vs O-arms' variance blending? |

Also carry one cheap non-generation dial: **correlated noise across windows**
(FreeNoise-class; the pack's fixed seed is the degenerate form) — arm it as a
toggle on O-soft, cost ~0.

### 4.2 Golden domains (what each arm is measured on)

- **Identity retention over N segments** — ArcFace vs canonical reference
  per hop; runway = first-crossing of 0.25 verification floor (existing
  threshold). Prediction to falsify: O-arms ≈ A on this axis (§2.1).
- **Seam visibility blind reads** — pixel-space joint-neighborhood previews
  (PreviewOverride decode) as forced-choice stimuli; plus the objective
  seam metric (frame-delta at joint ÷ median local motion) and VidPanos'
  overlap-agreement (PSNR/SSIM of the two renders of the joint region) as
  the pre-commit gate.
- **Motion continuity** — plan-following error + the *content-drag* check
  (does the joint region lose new beats — the tranche-2 hallway-beat
  metric); prediction: O-hard drags more as k grows, O-soft least.
- **Audio continuity** — join cross-correlation (0.95 target class), treble
  retention vs segment 1 (−6 dB threshold), tick check at joints
  (O-39-audio vs off-grid control).
- **Color walk** — L*/dE trajectory + joint-statistics mean drift (the
  FIFO drift-correction observable), per arm, with/without stabilize.
- **Joint-vs-interior drift split (S-arm critical)** — measure drift at
  joints and at window interiors separately; S predicts joints corrected,
  interiors accumulating. Plus **texture retention** (over-smoothing check
  for repeated SDEdit passes — the S-arm-specific failure mode) against the
  render-to-render noise floor.
- **Cost column (cost-per-delta)** — wall-clock and per-frame redundant
  fraction per arm (9% pack-class / 23% / 57%; S ≈ strip-length × short-pass
  overhead); report runway-per-axis ÷ cost. An arm that buys motion runway
  at 23% but no identity runway is a *chain-manager policy input* (soft
  joints for long takes; re-anchor for identity-critical chains), not a
  universal default.

## 5. The pack as artifact (brief — registry conventions, no adoption now)

- **License:** MIT (standard text, Copyright 2026 MisterAzor1) — permissive;
  vendor-eligible if ever adopted **[DOC]**. **Registry status:
  PROPOSED-PENDING-TEST** if adoption comes up; no row lands now (concept
  assessment only, nothing fetched or shipped).
- **Code quality:** careful for its size — stale-state guards, shape-change
  resets, padding accounting, duration preservation; edge cases (short final
  windows, interrupted runs) handled on the common path but unharness-tested
  **[DOC]**. 95 lines of load-bearing logic; if we ever want the pixel
  crossfade *as a preview utility*, porting with provenance headers beats
  vendoring (precedent: camera compiler port, ace6c48).
- **Compatibility:** zero pip deps; example workflows depend on
  VideoHelperSuite, KJNodes, rgthree, pysssss, ai-toolkit's
  `AIToolkitMiniMaxH3RefVideo`, Painter 3D latent upscaler — a heavy
  peripheral chain for two nodes we do not need (our graph factory owns the
  window arithmetic; the constraints to encode are: window ∈ {5+17g},
  `stride = window − joint`, joint ≡ 0 (mod 3) when audio joins at the
  joint) **[DOC]**.
- Community signals: none assessable (repo ~1 day old) — per doctrine,
  omitted.

## 6. Verdict

| Question | Verdict |
|---|---|
| The **concept** (overlap-chaining for long H3 chains) | **ADOPT** — as the drift-envelope's joint-family arms (O-soft/O-hard/O-39-audio) and as the chain manager's re-entry model; with the §2.1 correction welded on: overlap extends *local* runway (seam/motion/variance), global runway (identity/color) still belongs to re-anchor/payload/stabilize — the recipe is the product, not the joint alone. |
| The **maintainer's pixel-preview/latent-work split** | **CONFIRM** — matches both the code reading (pixel carry is the pack's weakness, not its strength) and our shipped stack (latent-fork + PreviewOverride already implement the two halves). |
| The **maintainer's seam re-denoise proposal** (§2.5) | **ADOPT-candidate** — buildable today on native primitives; the only bias-attacking mechanism in the matrix; enters the suite as arm S with the joint-vs-interior split and texture-retention domains as its falsifiers. |
| The **pack** | Not adopted; PROPOSED-PENDING-TEST only if a pixel-space preview utility is ever wanted verbatim. |

## Sources

**The pack (pinned `e2f2bc6`):**
1. MisterAzor1/ComfyUI-H3-Overlap — https://github.com/MisterAzor1/ComfyUI-H3-Overlap (nodes.py, README, both workflow JSONs read at revision)

**Internal (our measurements and prior assessments):**
2. `docs/research/h3-transitions-and-latent-continuity.md` — latent spec, grid math, drift numbers, tranche-1/2 addenda (E4 latent crossfade, E5 handoff triangle, content drag)
3. `docs/research/h3-node-ecosystem-sweep.md` — LongMedia `stitch_continuation`/`prepare_continuation`/`feather_continuation_overlap` (the latent-space overlap prior art), FL-MiniMaxH3 feathered bridges
4. `docs/research/pan-stitch-extension.md` — VidPanos overlap-aggregation, overlap-agreement metric, anchor-authority pattern
5. `docs/research/preview-override-assessment.md` — the preview-decode doctrine (taeh3/TAE-class, never the 5B VAE)
6. Drift-envelope suite task (5nfy24y) — current arms/thresholds; wan2gp addendum (frozen-audio-prefix, hash-bound binding)

**Literature (verified 2026-09-25):**
7. Gen-L-Video: Multi-Text to Long Video Generation with Temporal Coherence (Wang et al., 2023) — temporal co-denoising of overlapping clips — https://arxiv.org/abs/2305.18264
8. FreeNoise: Tuning-Free Longer Video Diffusion via Noise Rescheduling (Qiu et al., ICLR 2024) — https://arxiv.org/abs/2310.15169
9. FIFO-Diffusion: Generating Infinite Videos from Text without Training (Kim et al., NeurIPS 2024) — diagonal denoising, drift correction — https://arxiv.org/abs/2405.11473
10. Self-Forcing: Bridging the Train-Test Gap in Autoregressive Video Diffusion (Huang et al., 2025) — https://arxiv.org/abs/2504.01068
11. VidPanos: Generative Panoramic Videos from Casual Panning Videos (2024) — via pan-stitch doc (captured there) — https://arxiv.org/abs/2410.12455
12. SDEdit: Guided Image Synthesis and Editing with Stochastic Differential Equations (Meng et al., ICLR 2022) — partial re-noise + re-denoise = projection toward the prior — https://arxiv.org/abs/2108.01073
13. RePaint: Inpainting using Denoising Diffusion Probabilistic Models (Song et al., CVPR 2022) — resampling cycles for masked-region/flank harmony — https://arxiv.org/abs/2201.09865

## ADDENDUM 3 — correction: the pack's "0.59" is target_megapixels, not ref-strength (2026-09-25, v2v re-anchor research)

Direct dissection of the pinned workflow JSON (`e2f2bc6`, 2026-09-25)
shows `AIToolkitMiniMaxH3RefVideo`'s widgets are **`[target_megapixels=0.59,
max_length=0]`** — 0.59 is the megapixel bucket (res-768 class, consistent
with the README's "~0.5 MP processing"), and the node has **no strength
input at all** (schema: `video / target_megapixels 0.01–4.0 / max_length
0–3600`). §1.2's "ref-strength 0.59" reading and §2.2's "the pack's 0.59
choice" attribution are **withdrawn**. The soft-joint *dial* itself survives
with corrected provenance: the native `visual_cond_noise_aug` payload key
(default 0.999; `< 1.0` mixes seeded noise into never-denoised cond rows,
`comfy/ldm/minimax/model.py:525-538`) is the mechanism an O-soft joint
would actually turn. Full analysis and the R-arm family built on it:
`docs/research/h3-v2v-reanchor.md` (§2.3, §3).
