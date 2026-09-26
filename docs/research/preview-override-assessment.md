# PreviewOverride pack assessment — the preview-decoding path (maintainer-endorsed)

> **Provenance.** Commissioned by the maintainer's 2026-09-22 ruling, issued after
> their session's preview crash: *"We likely need to use that node for the preview
> decoding, it's a fairly solid node."* The pack —
> [simsim9-stack/ComfyUI-MiniMaxH3-PreviewOverride](https://github.com/simsim9-stack/ComfyUI-MiniMaxH3-PreviewOverride)
> — is already installed and running on their real instance (8188, off-limits to
> agents; nothing was submitted anywhere for this assessment — no GPU, no engine).
> Flux task `t6vub9k`; this pass pulled the pack forward from the curation sweep's
> queue ([node-pack-registry.md](node-pack-registry.md) §3 WATCH tier, 2026-09-14 sweep).
> **Code read:** the repository at pinned revision `d1eb17b0e8591` (main HEAD
> 2026-09-25, last push 2026-08-05; 8 stars — context, never a verdict) —
> `__init__.py`, `preview_override.py` (697 lines, the whole pack), `README.md`,
> `LICENSE` (MIT, © 2026 InsanE_GeN), `web/js/`, `minivae/`, `examples/` listings.
> The decoder was downloaded from the pinned revision and hashed locally:
> `minivae/taeh3_decoder.safetensors`, **39,458,084 bytes, sha256
> `200b17f16fbdf2afbd4f5c70b8390d57225bd2671ec17dfe162ad0e866dff66c`** — first-party
> confirmation of the dated correction in `server/fetchCatalog.ts` (a DIFFERENT
> artifact from the Kijai row's 9,791,388 / `f0f60fa0…`).
> **Ground truth for the crash class:** the engine reference checkout at
> `/home/agent/comfyui` (v0.34.0) — `latent_preview.py` and
> `comfy/latent_formats.py` read line-by-line.
> **Evidence tags:** **[DOC]** verified in source read this pass · **[TEST]**
> asserted in the landed test suites · **[COMM]** the maintainer's/session's
> reported experience (not reproduced by us — the crash itself was never
> reproduced; its CLASS is what the analysis addresses).

## 1. What the pack is and how it hooks preview decoding **[DOC]**

A single node, `MiniMaxH3PreviewOverride` (new `comfy_api.latest` extension API,
`define_schema`, category `model/sampling/minimax`, `is_experimental=True`), wired
between the H3 model and the sampler (MODEL → MODEL). It does **not** patch
`latent_preview`, does not monkey-patch the sampler, and adds no nodes to the
sampling graph — it registers an `OUTER_SAMPLE` wrapper on the model
(`comfy.patcher_extension.WrappersMP.OUTER_SAMPLE`, keyed
`minimax_h3_preview_override`) and replaces the step *callback*:

1. **Per step**, it extracts the video stream from the packed H3 NestedTensor
   (`_video_part`: handles both the unpacked nested form and the flat-packed
   `[B, 1, N]` form via `comfy.utils.unpack_latents`).
2. **Decode ladder** (every level fails soft, one warning each):
   a. the configured **tiny VAE** — `comfy.sd.VAE(sd=…)` from a `vae_name` combo
      over `folder_paths` `vae_approx` (`_load_tiny_vae`; the expected
      `Missing VAE keys` warning for decoder-only files is filtered). Only
      `TAEHV`/`TAESD` first-stage classes are accepted — a full video VAE is
      IGNORED with a clear warning (per-step decode of the 5B VAE is the
      VRAM-killer the design refuses). A channel preflight disables a mismatched
      TAE (H3 needs 24) instead of failing every step.
   b. **animated Latent2RGB** — the format's own `latent_rgb_factors` (24ch),
      `preview_frames` temporal slices, played back as animated WebP (or
      fragmented NVENC H.264 MP4 when `av` + NVENC are available).
   c. **single-frame Latent2RGB** — one JPEG per step.
3. **Transport:** `PromptServer.instance.send_sync("minimax_h3_preview_override",
   payload, client_id)` — a JSON WS event per step: `node_id`, `image` (base64),
   `mime` (`image/jpeg` | `image/webp` | `video/mp4`), `w`/`h`, `step`, `total`,
   `sigma`, `delta`, `step_ms`, `avg_step_ms`, `fps`; plus a boundary-0 message
   carrying the sigma schedule and an initial-noise preview. Encoding runs on a
   bounded off-thread queue (max 2 in flight, drop-on-full) so the sampler never
   blocks on the encoder.
4. **`suppress_default_preview` (default true):** during sampling only, every
   concrete `LatentPreviewer.decode_latent_to_preview_image` (the class + all
   subclasses) is swapped for a returns-None stub and restored in a `finally` —
   the stock preview overlay stops decoding; the progress bar still advances.
5. **Widget:** `web/js/*.js` registers a DOM preview panel on the node in
   ComfyUI's own frontend (the KJNodes-style widget with σ/Δ graphs). OUR app
   does not need it — we consume the WS event directly (§3).

**What it needs present:** the decoder file in `vae_approx` (its own
`minivae/taeh3_decoder.safetensors`, copied per the README, or any taeh3* TAE) —
the vae_approx **file convention is still how the decoder reaches the node**; the
pack owns the decode *path*, not the file slot. Without any file it degrades to
Latent2RGB animated previews (colored noise, but functioning). Requires ComfyUI
with `comfy_api.latest` (2025+ cores; 0.34.0 qualifies). PyAV optional (NVENC MP4;
WebP fallback). No other dependencies.

## 2. The crash class, grounded **[DOC + COMM]**

The stock path (what F6 shipped, task `2hbv2ib`): the client asks for
`extra_data.preview_method: 'taesd'`; `latent_preview.get_previewer` (0.34.0,
lines 78–110) then picks **`next(fn for fn in vae_approx listing if
fn.startswith(latent_format.taesd_decoder_name))`** — for
`MiniMaxH3Video.taesd_decoder_name = "taeh3"` (latent_formats.py:627), ANY
`taeh3*` file wins the prefix match — and, because `"taeh3"` is in `VIDEO_TAES`,
loads it sight-unseen through `comfy.sd.VAE(...)` into a `TAEHVPreviewerImpl`.
The construction and decode of that previewer are only as good as the arbitrary
file that won the name sort. The maintainer's crash (null previewer deref, the
stock latent_preview × VideoHelperSuite interplay, a wrong-sized taeh3* file in
vae_approx) lives exactly in this seam — construction from an unnamed winner,
then a decode path whose failure mode depends on which artifact happened to be
at the slot. We did not reproduce the crash (no engine was touched); the class
is what the analysis and the fix address.

**Why the pack's approach is structurally robust against it:**
- it never requests `preview_method` — with no TAESD request, `get_previewer`
  never constructs the TAEHV previewer at all (line 95's branch is the only
  construction site);
- its own decoder load is **by explicit name** (`vae_name`), through the same
  `comfy.sd.VAE` + `throw_exception_if_invalid()` the engine uses, with a loud
  one-warning fallback to Latent2RGB on any failure — a bad file degrades the
  preview, never the render;
- `_get_core_previewer` walks past custom-node `__wrapped__` hooks on
  `get_previewer` (the VHS-style interplay surface) to the unwrapped core
  function — a broken third-party wrapper cannot poison the fallback previewer;
- `suppress_default_preview` disables the stock decode during sampling.

## 3. The client-side story: nothing new is required **[DOC + TEST]**

The pack changes **nothing** the client must request: no `preview_method`, no WS
feature flags, no new framing. Its `minimax_h3_preview_override` event is a
plain JSON WS message — and it is **the producer the 2026-09-21 registry pass
could not locate** (node-pack-registry.md §4.2 item 3: `realtime.ts`'s consumer
with no emitter). That flag is now closed by identification, not by new code:
`normalizeComfyEvent` (server/realtime.ts) already parses the full payload
shape — `preview_meta` (mime/fps/step/total) plus the base64 frame forwarded as
a binary fabric frame, with the mime gate `image/(jpeg|png|webp)|video/mp4`
matching the pack's three mimes exactly. The graph wiring already existed
(`graph/preview.ts`, node `'7'`); the missing piece was the ROUTE and the
server-side double-request, both landed in task `t6vub9k`:

- **Route (A-DBG junction):** `resolvePreviewOverride` (lib/h3Submit) — when the
  pack's node is served by object_info (detected by `findH3PreviewOverrideNode`'s
  signature: exact `MiniMaxH3PreviewOverrideCS` — a newer-core class name we keep
  matching defensively — then the pattern `/minimax.*h3.*preview.*override/i`,
  which the pack's `MiniMaxH3PreviewOverride` satisfies) AND a taeh3 decoder is
  present in vae_approx, the pack owns preview decoding for every live-preview
  render, both modes; otherwise the stock vae_approx file convention is the path.
  The explicit `'h3-override'` mode keeps its strict validation ladder.
- **Server:** `/api/lan/prompt` skips the `preview_method: 'taesd'` request when
  the submitted graph carries an override-class node (the same signature,
  mirrored server-side) — the pack graph previews itself; no stock TAEHV
  previewer is ever constructed for it.

## 4. THEORY + TEST (the epistemology)

**THEORY (testable claim):** pack-routed H3 previews are strictly more robust
than the stock vae_approx file convention, at equal-or-better quality —
(a) the null-previewer crash class cannot fire on a pack-routed render (no
preview_method request, no arbitrary-file previewer construction, name-pinned
decoder with loud fallback); (b) preview fidelity is ≥ stock (true-RGB per-step
decode via the maintainer-validated 39.4 MB TAEHV decoder, animated multi-frame,
vs the stock single-frame decode through whatever file won the prefix match).

**Verified now (cheap, no GPU) [TEST]:**
- fake-engine preview flow: a fabric client submitting a graph carrying
  `MiniMaxH3PreviewOverride` with `livePreview: true` produces **no**
  `extra_data.preview_method` at the engine (tests/realtime.test.js, F6 section);
  the pack's event shape normalizes to `preview_meta` + a binary frame
  (existing assertions, re-read against the pack's real payload fields).
- the route ladder: pack present + decoder → override wired for both modes;
  pack absent / decoder absent / live preview off → stock path
  (tests/canvas.test.js, `resolvePreviewOverride`).
- the registry seam: a missing override class maps to the `h3-preview-override`
  fetch row with the MIT verdict and the `pack:h3-preview-override` deep-link —
  the F6 remediation affordance (tests/enginewatch.test.js + instance + fetcher).
- the crash class, by construction: with no `preview_method` in the request,
  `get_previewer`'s TAESD branch (the only construction site for the TAEHV
  previewer from an arbitrary taeh3* file) is unreachable — verified against the
  0.34.0 source read, not just the pack's claims.

**Rides the next GPU window (named micro-checks, 8189 testbed per the runbook):**
1. *Robustness arm:* place a deliberately wrong-sized taeh3* file in vae_approx,
   run one pack-routed render — the render completes (warning in log, Latent2RGB
   or decoder output), where the stock path with `preview_method: 'taesd'` and
   the same file is the documented crash. One run each, same file, same seed.
2. *Quality arm:* same seed/prompt, pack-routed (39.4 MB decoder) vs stock
   (Kijai 9.3 MB file) — eyeball the mid-sampling frames on the canvas tile:
   true-RGB vs channel-soup is visible immediately; the maintainer has already
   validated the pack's decoder quality on their instance (their ruling is the
   prior; this arm is confirmation, not discovery).
3. *Interplay arm:* with VideoHelperSuite active, confirm the pack's suppressed
   stock preview produces no per-step warnings past the first (the suppress +
   restore cycle leaves no residue across two renders in one session).

## 5. Honest scope — what this pass did NOT do

- **The decoder fetch gap.** The fetch machinery cannot place a GitHub-hosted
  single weight into a model root (git sources place only into node-pack /
  engine-checkout destinations; the decoder lives in the pack's repo, not on
  HF). So the catalog row fetches the pack CODE, and the decoder reaches
  vae_approx either by the pack's own README step (cp `minivae/…` → vae_approx —
  how the maintainer's instance got it) or by the existing Kijai row (a
  24-channel TAE the node accepts identically; both artifacts share the
  `taeh3_decoder.safetensors` name, so only one occupies the slot — first
  placement wins, and the engine's prefix match accepts either). A git→model-root
  single-file fetch extension is the named follow-up if the pack's own decoder
  should become consent-fetchable; deliberately not half-wired here.
- **The crash was not reproduced** (no engine touched). The robustness claim's
  engine-side half is source-grounded; the GPU-window arm above closes it.
- **`preview_method` is still sent for pack-absent renders** — that is the
  intended fallback, with its documented fragility (our sha-pinned Kijai row is
  the mitigation: the file at the slot is at least known bytes). The fallback
  ladder is visible in the registry row, not hidden.
- **The pack's `is_experimental` flag** and its DOM widget are noted; the widget
  is inert for us (we never load the pack's web JS — our app is not ComfyUI's
  frontend; the WS event carries everything we consume).

## 6. Disposition

**ADOPT as the preferred preview-decoding path** (the maintainer's ruling; this
assessment supplies the mechanics and the guardrails). Registry row
`h3-preview-override` (MIT, user-fetch, pinned `d1eb17b0…`), fetch entry
`pack:h3-preview-override`, path preference + server-side skip landed with
tests; STATUS **PROPOSED-PENDING-TEST** per the standing epistemology — the
GPU-window micro-checks (§4) promote it to ADOPTED-TESTED. **ALTERNATIVES (the
fallback ladder):** the stock vae_approx file convention (kept, live); a
first-party port of the pack's ~700-line wrapper (MIT makes it license-clean;
not warranted while the pack is solo-maintained-but-tiny and pinned).
**RECHECK-ON:** symptom (any pack-routed render failing on preview decode, or
the override event shape drifting), event (an upstream release — the repo has
been quiet since 2026-08-05; a bus-factor-1 watch like Image Studio's), calendar
(the quarterly sweep).
