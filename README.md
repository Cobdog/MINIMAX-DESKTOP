# MiniMax Studio

A local-first **web app** for MiniMax H3 generation through ComfyUI: one small Node server on your workstation, the full Studio in any browser on your network — desktop, phone, or tablet. Models are indexed and used from their existing locations; the app never downloads, copies, or reorganizes model files.

> Fork of [jamesk9526/MINIMAX-DESKTOP](https://github.com/jamesk9526/MINIMAX-DESKTOP), restructured and hardened. The Electron shell was removed in favor of this standalone server + SPA architecture (see [docs/migration.md](docs/migration.md)). Known issues and their status live in the [audits](docs/audit/).

## Quick start

```bash
pnpm install
pnpm build
pnpm start:server
# → http://127.0.0.1:4178  (LAN address printed on startup)
```

**Development:** `pnpm gate` runs the full verification chain (see [Testing](#testing) below). CI runs typecheck/lint/unit/build/smoke/e2e/vision-capture on every push, plus an Engine CI leg on Windows.

Requirements: Node 20+, a local ComfyUI with the MiniMax H3 core nodes, and the H3 model components already on disk. FFmpeg for clip tools. Optional: a local [llama.cpp server in router mode](https://github.com/ggml-org/llama.cpp) for the LLM layer (prompt tailoring, planning, caption rewriting, vision captioning), with local Ollama as the fallback when no router is configured; NVIDIA tooling for GPU telemetry.

Configuration lives in `~/.minimax-studio/` (override with `MINIMAX_STUDIO_HOME`): `settings.json` holds the ComfyUI/Ollama addresses, model folders, and defaults — also editable from the app's Settings page. Default port `4178` (override with `MINIMAX_LAN_PORT`).

**Security posture:** open on your LAN by default, exactly like ComfyUI itself — anyone on the same network can use the studio. For hostile networks (café Wi-Fi, shared offices), start with `--token` (or `MINIMAX_LAN_TOKEN=1`) and pass the token as `?token=…`.

`pnpm dev` runs vite HMR on 5173 with `/api` proxied to a server already running on 4178.

## Testing

### The gate

```bash
pnpm gate
```

Runs the entire verification chain in canonical order, each suite in its own
process with wall-clock timing, known-benign output filtered (pino logs,
chunk-size advisories, pnpm bookkeeping — the tally is printed so nothing
disappears silently), and a final summary table. Non-zero exit on any
failure; a failed `build` skips only its dependents (smoke/e2e/vision).

Order: `typecheck` → `lint` → `license:audit` → `test` → `test:registry` →
`test:h3img` → `test:storage` → `test:documents` → `test:realtime` →
`test:filmstrip` → `test:llm` → `test:engine` → `test:runtime` →
`test:fetcher` → `test:lora-form` → `test:poserig` → `test:camera` →
`test:canvas` → `test:benchmarks` → `test:datasets` →
`build` → `smoke:server` →
e2e (Playwright) → vision-capture (Playwright). `pnpm test:all` is the same
chain without the harness niceties. `license:audit` classifies every direct
dependency's SPDX against the AGPLv3 allowlist and enforces the
never-vendor-what-we-can't-ship registry invariant (see
[docs/LICENSES.md](docs/LICENSES.md)). `test:fetcher` covers the local-first
fetcher with the transport mocked throughout — consent gating, catalog
integrity, sha/size verification, pin stamping, link placement and the
fetch routes; no test ever touches the network. `test:lora-form` runs the
first-party form-adapter node's python suite (the full-width→pruned adaln
projection: centered-fit math with both traps as tests, the kijai golden,
form detection; needs `python3` + `numpy` — skips loudly without python,
fails loudly with python but no numpy) plus the server-side form detection,
compat/guidance, first-party pack install and consent-gated local-install
tests. `test:poserig` runs the IK pose rig's pure client modules through
the VM harness — analytic two-bone + FABRIK solver contracts, the §3
palette-exact draw-op goldens, the OpenPose-134 JSON round-trip and 17n+5
grid snapping (the three.js/React shell is covered by the e2e suite).
`test:datasets` runs the dataset manager (training-set prep, sv14rt0)
against the built server with synthetic ffmpeg clips: ingest both paths
(content-hash identity, refusal floors with measured reasons), MISSING/
CHANGED health flows with hash re-link, checksum-asserted byte-immortality
of referenced sources, the layer lifecycle (32-grid crops, crop-time floor
refusal, stale captions on crop/trim edits), the bake pipeline's decoded ∈
[target, target+2] assertion (a crafted f56-class truncation refuses), all
nine QA gates, the musubi/DiffSynX/external export shapes with named
validations, curation (advisory clusters, reference-triage, scene-split),
and the 1000-item scale gate. `test:camera` runs the camera-path compiler
port (`src/lib/camera/`, from
bruxosdovfx Camera H3 v19.1, Apache-2.0) through the VM harness — compiled
prompts, options and storyboards byte-compared against goldens generated
by the upstream Python itself (`scripts/fixtures/camera-goldens.json`; the
generator is committed beside it), monotone-PCHIP interpolation parity,
the validation error taxonomy and the 17k+5 resampling math. No Python
needed at test time.

### System Chromium (no bundled browser)

The Playwright suites **never download a browser**. The config
(`playwright.config.ts`) resolves your machine's own Chromium/Google Chrome:
first `MINIMAX_TEST_BROWSER` (explicit executable path), then common install
paths on Linux and Windows, then a `$PATH` scan. If nothing is found the
config **throws with a one-line reason** — a missing system browser is a
setup error to fix on the machine, not a silent skip. GitHub's ubuntu
runners ship Chrome/Chromium, so CI needs no install step. The viewport is
pinned to 1920×1080 at `deviceScaleFactor: 1`; failures keep a trace and
screenshot, green runs write nothing per-test.

### Vision-in-the-loop QA — capture → judge → report

A three-phase pipeline for having a vision-capable model judge the real UI
against written contracts. No test code calls any model or external API —
the only vision consumer is a judge subagent reading screenshots.

1. **Capture** — `pnpm test:vision` (run `pnpm build` first, or use the
   gate). Drives the scenarios in `scripts/vision-e2e/scenarios.ts` at the
   pinned viewport and writes a self-describing bundle to
   `test-results/vision/<run-id>/`: full-page PNG per checkpoint (filenames
   prefixed with the run id so every read is fresh — image-upload caches
   dedupe by filename), plus `manifest.json` mapping each image to its
   rubric. Capture never judges and exits 0 when the bundle is complete.
2. **Judge** — a Sonnet-tier subagent executes
   [`scripts/vision-e2e/JUDGE.md`](scripts/vision-e2e/JUDGE.md) against the
   bundle: it reads every screenshot, applies the rubric plus the general
   bug taxonomy (overlap / clipping / misalignment / contrast / truncated
   text), applies the two-pass rule (a fail gets exactly one re-look before
   becoming final — vision judgments are noisy), and writes `verdicts.json`
   into the bundle. Dispatch line is in the file. This step does not run in
   CI; it is an orchestrator/local step.
3. **Report** — `pnpm vision:report [bundle-dir]` (defaults to the newest
   bundle). Validates `verdicts.json` against the manifest (shape, every
   checkpoint covered, run id match), prints PASS/FAIL per checkpoint with
   issue lists and artifact paths, and exits non-zero on any final fail. A
   bundle without `verdicts.json` is a loud "not yet judged" error — never
   a silent pass.

**Adding a scenario/checkpoint:** append to
`scripts/vision-e2e/scenarios.ts` (driver + rubric as data), re-capture,
judge, report. Rubrics encode the *current intended design* — verify claims
against a real capture before committing them; explicitly bless intended
design choices (dimmed disabled controls offline, dense sub-labels) so the
judge doesn't flag the design language as defects.

### Lint stack

`pnpm lint` = eslint (`--max-warnings 0`) + stylelint over
`src/**/*.css`. Stylelint layers `stylelint-config-standard` (syntax) with a
custom `minimax/no-raw-colors` rule enforcing the wave-2b design tokens:
color values must go through `var(--token)`; raw literals are only allowed
in token definitions and on the documented allowlist
(`scripts/stylelint-raw-color-allowlist.json` — every entry states its
reason). Rules that only fought house style (single-line rule format,
legacy `rgba()` notation, cascade-order overrides) are disabled with
comments in `stylelint.config.mjs`; two behavior-sensitive spots in
`styles.css` carry inline suppressions with reasons. Typechecking stays
separate: `pnpm typecheck`.

## Capabilities

**Surfaces.** The app boots to the **canvas** — one infinite surface per project
where media, generations, and plans live as first-class objects, every edit an op
in a stack, takes compared on a strip, and a timeline projection over the chain
graph (the Director Suite: plan documents with measured gap transitions). Two more
surfaces ride beside it in the titlebar switcher (Alt+1..n): the **dataset
manager** (`?datasets=1`, LoRA training-set prep) and the **H3 image workbench**
(`?images=1`, multi-image compose/edit/refine). `?canvas=1` is a harmless alias;
`?mobile=1` still boots the touch companion (unmaintained); dev surfaces live at
`?proto=` and `?poserig=1`.

**Video generation (MiniMax H3)**
- Text-to-video, image-to-video (first frame), first+last-frame, and mixed reference generation (up to 9 images / 3 videos / 3 audio) through the FL2VA/Ref2VA models
- Official ComfyUI H3 graph topology and sampling defaults (`res_multistep` + `simple`), with detected FL2V 4/8-step and Ref2V 4-step turbo LoRAs
- **Official MiniMax prompt contracts built in**: one-click scaffolds for the three-field base structure and the six-section Ref2VA format (`subject_definitions` … `non_diegetic_music`), timed `[Shot N] At MM:SS.mmm` cut insertions, inline negatives, identity-lock enumeration, and live slot-order warnings that keep `<Picture>/<Video>/<Audio>` mentions matching reference order
- **Multiframe timeline keyframes**: pin images at exact seconds through chained `MiniMaxH3AddGuide` (official multiframe topology), with frame readouts, in-duration validation, and mirroring guide images into prompt-visible Pictures
- Guided quality tiers on the canvas — Quality (full-step native) / Fast · 4-step / Fast · 8-step — pinned to the official sampler/scheduler pair; the custom-sampling seam exists in code but has no UI toggle (custom combinations are not equivalent to the published template)
- A fixed-seed quality diagnostic that queues matching Native and Turbo 8 renders for direct A/B comparison
- **Character sheets in-model**: the studios' sheet generation runs the H3 ContactSheet + Turnaround LoRA path (five coordinated views in one pass, saved straight into the reference set; required — the old LTX turntable fallback was retired with the survey engine)
- **Graph compatibility**: renders record a graph-family version, and Settings tracks the ComfyUI version the graphs were verified against — warning when the engine updates past it (with the H3 Quality Test as the re-verification path); director's-looseness presets counter H3's strong prompt adherence
- **Latent scene chaining (the Director Suite)**: plan a multi-segment sequence as a plan document on the timeline — segments can render as ONE Motion-Context latent episode, each segment pinning the previous clip's tail as never-denoised conditioning so motion and audio carry across at the latent level. Segment frames ride the 17n+5 grid (max 345 f ≈ 15 s); the measured gap menu offers hard cut (default), NLE handoff, and the FLF continuation splice that executes offline; guided dip-to-black and diegetic bridges are labeled honestly as queued engine work. Chain plans can also be seeded segment-by-segment, consent-gated
- **Reproducibility manifests** on every render (seed, model files + sizes, LoRA strength, sampler, graph-version hash) — recorded on each job and take
- **Queue hygiene**: a failed render automatically soft-resets the engine (`/free`) and retries once with tiled VAE decoding before surfacing the error
- Optional verified LTX 2.5 latent 2× post-processing, the LBH 2D/3D latent upscalers, and RTX/CUDA frame upscaling as canvas ops
- Non-destructive trim/clip ops in the canvas op stack (frame-accurate in/out; the destructive "focused reference MP4" export of the old clipper is retired)

**Other engines (canvas ops and audio docks — the old per-engine workspaces were retired with the canvas)**
- LTX-2.5 T2V/I2V as a canvas produce op, with native synchronized audio, the official two-stage Quality preset and single-stage Turbo preset; LTX 2.3 one-graph utility tools (remove subtitles/watermark/object, outpaint, img+audio→video)
- ACE-Step 1.5 music generation through the audio dock, with XL SFT/Base checkpoint selection, lyric/instrumental modes, tempo/key/language controls, and FLAC output
- **MiniMax Music 3** through the audio dock: complete songs up to five minutes, lyrics with `[Intro]…[Outro]` structure tags, tiled low-VRAM audio decode, mp3 V0 output (the old three-section caption builder + LLM rewriter were retired with the Music workspace — captions are freeform on the dock)
- Stills: the image intent renders **H3-1F** (the T=1 Fast profile through the image workbench core), with a Krea 2 stills engine queued; Z-Image Turbo survives inside the asset studios for master references

**Production libraries (the five asset studios, docked on canvas)**
- Character Studio: Z-Image master references, ContactSheet five-view sheet generation, five-angle frame extraction, reference-set or single-image selection
- Hair, Wardrobe, Accessories, and Location studios with reusable references; libraries project into the canvas global asset store (copy-never-destroy) and bind onto chains with consent-gated forks

**Prompt library**
- Search Civitai's public generation metadata through the local server (pinned-host proxy, scoped to the MiniMax H3 base model by default), study its settings, and save entries with attribution into a reusable local library
- Eight bundled technique starters distilled from fal's H3 prompting guide
- The ten official style embeddings (bullet_time, truman_show, …) as one-click `embedding:name` insertions

**Local integration**
- LLM-layer prompt enhancement, timed shot planning, synchronized-audio rewriting, and image captioning — served by a llama.cpp router (one endpoint for every local text model, with model-family detection, sticky-model keep-alive, and pre-generation unload choreography for VRAM hygiene) or local Ollama as fallback. Prompt text never leaves the workstation, and the planner instructs MiniMax's official structure and label discipline
- Live WebSocket render progress and previews; GPU/VRAM telemetry; job queue with cancellation and bounded failure detection
- Landscape/portrait/square output presets with automatic fitting and interactive crop preview

**Every device**
- The full Studio runs in any modern browser; `?mobile=1` serves the touch-first companion view (unmaintained; the mobile manifest makes it PWA-installable on phones)
- Files arrive by drag-and-drop upload (or file picker) and generated outputs are browsable, previewable, and directly reusable as new inputs

## Local services

**Trust & setup**
- Setup doctor in Settings: verifies FFmpeg, HTTPS tooling, the engine device, and attention backends, with exact fixes
- GPU-tier guidance (8/16/24 GB, Blackwell) from the community quant tiers
- The server serves HTTPS with a self-signed certificate by default when OpenSSL is available (fingerprint printed at startup; `--no-https` opts out); the model-license notice component from the pre-canvas shell is currently unrouted (tracked for re-mounting on the canvas first run)

- ComfyUI defaults to `http://127.0.0.1:8188`
- The LLM layer's llama.cpp router address is set in Settings (router mode; leaving it empty keeps the Ollama fallback at `http://127.0.0.1:11434`); the app lists the served text models with family and vision-capability detection and excludes embedding and cloud-backed entries

Both engine addresses, every model directory, and the ComfyUI output directory can be changed from Settings.

## Workflow compatibility

MiniMax generation is built from ComfyUI's official T2V/I2V/Ref2V core graph: native H3 conditioning, `RandomNoise`, `BasicGuider`, `res_multistep`, `simple`, joint video/audio latent decoding, and `CreateVideo`/`SaveVideo`. The app prefers the official pruned INT8 ConvRot diffusion safetensors, NVFP4-AWQ text encoder, FP16 video VAE, and FP32 audio VAE when multiple matching files exist. Live preview and LTX/RTX upscaling are separate output branches and do not alter the base H3 sampling path.

Turbo sampling uses the official sampler/scheduler pair unless custom sampling is explicitly enabled; custom combinations remain marked experimental because they are not equivalent to the published template.

The **LTX 2.5** engine is a separate provider (a canvas produce op since the workspace retired) and never reads or changes MiniMax prompts, inputs, turbo LoRAs, samplers, sigma shifts, or upscale choices. Its Quality preset follows ComfyUI's official two-stage distilled workflow (8-step half-res pass → LTX latent 2× → 3-step refinement); Turbo uses the official fixed 8-step distilled schedule as a single full-resolution stage.

## How generation works

The renderer builds ComfyUI API-format graphs in the browser and submits them through the server's `/api` routes; the server proxies ComfyUI, runs FFmpeg for clip operations, and serves generated media with HTTP Range support. Progress arrives over WebSocket (same-machine) or the server's SSE bridge (remote devices).

- `MiniMaxH3ImageToVideo` or `MiniMaxH3ReferenceToVideo`
- `UNETLoader`, `CLIPLoader`, and separate video/audio `VAELoader` nodes
- `SamplerCustomAdvanced` with `res_multistep`
- `VAEDecode`, `VAEDecodeAudio`, `CreateVideo`, and `SaveVideo`

Durations convert to MiniMax H3's required `17k + 5` frame grid at 24 fps. Completed outputs are attributed by the exact filename ComfyUI reports — never by newest-file-on-disk.

For the process model, API surface, and persistence tiers, see [docs/architecture.md](docs/architecture.md).

## ACE-Step 1.5 setup

The audio dock submits the native ComfyUI ACE-Step 1.5 graph; it does not call a hosted music service. Install the following files into the configured ComfyUI model folders, then use **Settings → Test connection** and rescan models:

| ComfyUI folder | Required file |
| --- | --- |
| `models/diffusion_models` | `acestep_v1.5_xl_sft_bf16.safetensors` |
| `models/diffusion_models` | `acestep_v1.5_xl_base_bf16.safetensors` |
| `models/vae` | `ace_1.5_vae.safetensors` |
| `models/text_encoders` | `qwen_0.6b_ace15.safetensors` |
| `models/text_encoders` | `qwen_4b_ace15.safetensors` |

The app detects either XL checkpoint independently, so an installation with only Base or only SFT remains usable. A current ComfyUI build must expose `TextEncodeAceStepAudio1.5`, `EmptyAceStep1.5LatentAudio`, `ModelSamplingAuraFlow`, `VAEDecodeAudio`, and `SaveAudioAdvanced` in its object info. The generated graph follows Comfy-Org's published ACE-Step 1.5 templates: 50 Euler/simple diffusion steps, AuraFlow shift 3, and the published per-checkpoint CFG defaults (SFT 7, Base 6).

Reference downloads and node documentation are maintained by [Comfy-Org's ACE-Step 1.5 workflow templates](https://github.com/Comfy-Org/workflow_templates/tree/main/templates) and [the TextEncodeAceStepAudio1.5 embedded docs](https://github.com/Comfy-Org/embedded-docs/blob/main/comfyui_embedded_docs/docs/TextEncodeAceStepAudio1.5/en.md).

## Documentation

**Orientation:** [docs/ROADMAP.md](docs/ROADMAP.md) is the state of play (shipped / building / queued / awaiting-maintainer, sourced from the task board); [docs/LEARNINGS.md](docs/LEARNINGS.md) holds the operational and engineering lessons; [docs/agent/README.md](docs/agent/README.md) indexes the agent runbook tree (read on intent, not at boot).

| Doc | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Server + SPA process model, API surface, generation pipeline, registry/fetcher/runtime internals |
| [docs/ROADMAP.md](docs/ROADMAP.md) | State of play: shipped / building / queued / awaiting-maintainer |
| [docs/LEARNINGS.md](docs/LEARNINGS.md) | Operational + engineering lessons (testbed ops, measurement doctrine, harness gotchas) |
| [docs/agent/README.md](docs/agent/README.md) | Agent runbook tree index — runbook / testing / conventions, read on intent |
| [docs/library/README.md](docs/library/README.md) | Research library — full-copy captures of load-bearing external docs (H3 prompt guides, ComfyUI H3 pages, Motion-Context README) with the source-of-truth check protocol |
| [docs/specs/canvas-ui-v1.md](docs/specs/canvas-ui-v1.md) | **BLESSED** Canvas UI v1 spec — the authoritative UI direction (phase addenda through 5b + the image-pathway reroute) |
| [docs/specs/canvas-document-model.md](docs/specs/canvas-document-model.md) | Canvas document model: chains/forks/takes schema spec (shipped with Phase 0; extended since) |
| [docs/specs/dataset-manager-v1.md](docs/specs/dataset-manager-v1.md) | **BLESSED** Dataset Manager v1 spec — import/layers/captions/curation/bake/export (the `?datasets=1` surface) |
| [docs/specs/image-workbench-v1.md](docs/specs/image-workbench-v1.md) | **BLESSED + BUILT** H3 Image Workbench v1 spec — compose/edit/refine images on H3 (the `?images=1` surface) |
| [docs/specs/structured-prompt-editor.md](docs/specs/structured-prompt-editor.md) | Structured H3 prompt editor spec — boxes per prompt part, Flow list, concat at submit (shipped) |
| [docs/research/h3-lora-training-guide.md](docs/research/h3-lora-training-guide.md) | H3 LoRA training guide — per-class recipes, dataset technicals, caption formats |
| [docs/research/h3-lora-training-envelope.md](docs/research/h3-lora-training-envelope.md) | Measured 24 GB training envelope — walls, budget rule, trainer picks, sidecar defaults |
| [docs/research/per-model-prompt-doctrines.md](docs/research/per-model-prompt-doctrines.md) | Per-model inference-prompt + captioning doctrines (Anima, Klein, Krea 2, H3) |
| [docs/PROVENANCE.md](docs/PROVENANCE.md) | Fork lineage, AGPLv3 rationale, vendored-ports provenance |
| [docs/LICENSES.md](docs/LICENSES.md) | Third-party license inventory (deps, vendored, user-fetch, weights), AGPL mechanics, headers policy |
| [docs/migration.md](docs/migration.md) | The Electron → web migration record (complete) |
| [docs/audit/code-quality-audit.md](docs/audit/code-quality-audit.md) | Adversarial review: P0–P3 findings + resolution status |
| [docs/audit/security-audit.md](docs/audit/security-audit.md) | Threat model, findings + resolution status |
| [docs/research/ui-pre-brainstorm.md](docs/research/ui-pre-brainstorm.md) | Canvas UI decision register — locks and spec pointers (bulk archived) |
| [docs/research/ui-inventory-and-migration-map.md](docs/research/ui-inventory-and-migration-map.md) | Every legacy view/component classified: remove / refactor-absorb / keep / seed |
| [docs/research/ecosystem-2026-09.md](docs/research/ecosystem-2026-09.md) | H3/LTX/ACE/Z-Image ecosystem research driving the roadmap |
| [docs/research/h3-transitions-and-latent-continuity.md](docs/research/h3-transitions-and-latent-continuity.md) | Transitions & latent continuity: verdict table, three strategies, E1–E8 experiment ladder |
| [docs/research/h3-node-ecosystem-sweep.md](docs/research/h3-node-ecosystem-sweep.md) | Custom-node field sweep: code-read verdicts, new methods, adopt shortlist |
| [docs/research/h3-sampler-shaping-and-motion-control.md](docs/research/h3-sampler-shaping-and-motion-control.md) | Sampler/sigma/guidance recipe, adherence levers, movement-director lineage, E-MD1 |
| [docs/research/speed-quality-and-imagegen-paths.md](docs/research/speed-quality-and-imagegen-paths.md) | Speed/quality levers (VDN vs turbo, TE caching), memory choreography, Krea 2 / Klein image paths |
| [docs/research/h3-instruction-based-editing.md](docs/research/h3-instruction-based-editing.md) | H3 as instruction-based editor: arena rank, adaln-hybrid gap, T=1/frame-packet, model division of labor |
| [docs/research/h3-lora-form-compatibility.md](docs/research/h3-lora-form-compatibility.md) | Full-width↔pruned LoRA form compatibility: mechanism, math, load-time patch architecture |
| [docs/research/fun-control-input-surface.md](docs/research/fun-control-input-surface.md) | Fun Control wire format, DWPose render spec, extraction matrix, IK-rig architecture, E-FC1 verdict |
| [docs/research/krea2-edit-mode.md](docs/research/krea2-edit-mode.md) | Krea 2 edit mode: instruction editing, masked refine, preservation ladder (E-K1) |
| [docs/research/h3-image-workbench.md](docs/research/h3-image-workbench.md) | H3 Image Workbench: multi-image compose/merge, edit taxonomy per path, refmod+LoRA stacking, refinement story, start-frame handoff + xlfl0iv call |
| [docs/research/ap10k-control-lora-training.md](docs/research/ap10k-control-lora-training.md) | AP-10K control-branch LoRA feasibility: GO-WITH-ADAPTATION |
| [docs/research/ap10k-trainer-survey.md](docs/research/ap10k-trainer-survey.md) | Trainer comparison for the control-branch finetune (DiffSynX, musubi, ai-toolkit, …) |
| [docs/research/autocontext-deepread.md](docs/research/autocontext-deepread.md) | AutoContext mechanism deep-read: anchoring math, ref filtering, temporal-exclusivity rules |
| [docs/research/ltx-vs-h3-verdict.md](docs/research/ltx-vs-h3-verdict.md) | LTX 2.5 verdict: keep-utilities-only |
| [docs/archive/README.md](docs/archive/README.md) | Archive index — superseded/historical documents and their successors |

## License

**GNU AGPLv3** — see [LICENSE](LICENSE). Copyleft in both directions: use it, host it, build on it, but share your source. The fork lineage and licensing rationale are documented in [docs/PROVENANCE.md](docs/PROVENANCE.md), and the complete third-party inventory (dependencies, vendored packs, user-fetch components, model-weight licenses) lives in [docs/LICENSES.md](docs/LICENSES.md). Content-neutral by design: no filters, no gating, no telemetry — what people create is their business, not the tool's.

**Source offer (AGPL §13).** The server serves the web app over HTTP, so network-interaction terms apply. The canonical source is this repository — <https://github.com/Cobdog/MINIMAX-DESKTOP>. If you run a modified copy for others over a network, offer them your Corresponding Source (a link to your fork satisfies this); the in-app notice in Settings → License & source carries the same link.
