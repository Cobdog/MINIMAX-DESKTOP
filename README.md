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

**Development:** `pnpm test` (workflows, contracts, manifests — VM-harness suite), `pnpm test:e2e` (Playwright: 14-view render sweep at 1920×1080 with console-error tracking and per-view vision screenshots), `pnpm smoke:server` (routes + security guards). CI runs all of it on every push.

Requirements: Node 20+, a local ComfyUI with the MiniMax H3 core nodes, and the H3 model components already on disk. FFmpeg for clip tools. Optional: local Ollama for prompt features; NVIDIA tooling for GPU telemetry.

Configuration lives in `~/.minimax-studio/` (override with `MINIMAX_STUDIO_HOME`): `settings.json` holds the ComfyUI/Ollama addresses, model folders, and defaults — also editable from the app's Settings page. Default port `4178` (override with `MINIMAX_LAN_PORT`).

**Security posture:** open on your LAN by default, exactly like ComfyUI itself — anyone on the same network can use the studio. For hostile networks (café Wi-Fi, shared offices), start with `--token` (or `MINIMAX_LAN_TOKEN=1`) and pass the token as `?token=…`.

`pnpm dev` runs vite HMR on 5173 with `/api` proxied to a server already running on 4178.

## Capabilities

**Video generation (MiniMax H3)**
- Text-to-video, image-to-video (first frame), first+last-frame, and mixed reference generation (up to 9 images / 3 videos / 3 audio) through the FL2VA/Ref2VA models
- Official ComfyUI H3 graph topology and sampling defaults (`res_multistep` + `simple`), with detected FL2V 4/8-step and Ref2V 4-step turbo LoRAs
- **Official MiniMax prompt contracts built in**: one-click scaffolds for the three-field base structure and the six-section Ref2VA format (`subject_definitions` … `non_diegetic_music`), timed `[Shot N] At MM:SS.mmm` cut insertions, inline negatives, identity-lock enumeration, and live slot-order warnings that keep `<Picture>/<Video>/<Audio>` mentions matching reference order
- **Multiframe timeline keyframes**: pin images at exact seconds through chained `MiniMaxH3AddGuide` (official multiframe topology), with frame readouts, in-duration validation, and mirroring guide images into prompt-visible Pictures
- Guided quality presets — Native Quality, official Turbo 8, Preview — with custom sampling isolated under an explicit Experimental disclosure
- A fixed-seed quality diagnostic that queues matching Native and Turbo 8 renders for direct A/B comparison
- **Reproducibility manifests** on every render (seed, model files + sizes, LoRA strength, sampler, graph-version hash) — downloadable per job or exported in bulk
- **Queue hygiene**: a failed render automatically soft-resets the engine (`/free`) and retries once with tiled VAE decoding before surfacing the error
- Optional verified LTX 2.5 latent 2× post-processing and explicitly experimental RTX/CUDA frame upscaling
- Non-destructive reference video clipping: preview a source, set in/out points, create a focused 2–15 s reference MP4

**Other providers (separate workspaces, separate state)**
- LTX-2.5 T2V/I2V with native synchronized audio, the official two-stage Quality preset and single-stage Turbo preset
- ACE-Step 1.5 music generation with XL SFT/Base checkpoint selection, lyric/instrumental modes, tempo/key/language controls, and FLAC output
- Z-Image Turbo first-frame and standalone still generation with direct I2V handoff

**Production libraries**
- Character Studio: Z-Image master references, I2V turntable generation, five-angle frame extraction, reference-set or single-image selection
- Hair, Wardrobe, Accessories, and Location studios with reusable references
- Movie Planner: Ollama-assisted scene/shot planning with a conversational copilot, field-level diff review, and undo history

**Prompt library**
- Search Civitai's public generation metadata through the local server (pinned-host proxy, scoped to the MiniMax H3 base model by default), study its settings, and save entries with attribution into a reusable local library
- Eight bundled technique starters distilled from fal's H3 prompting guide
- The ten official style embeddings (bullet_time, truman_show, …) as one-click `embedding:name` insertions

**Local integration**
- Local Ollama prompt enhancement, timed shot planning, and synchronized-audio rewriting — prompt text never leaves the workstation, and the planner instructs MiniMax's official structure and label discipline
- Live WebSocket render progress and previews; GPU/VRAM telemetry; job queue with cancellation and bounded failure detection
- Landscape/portrait/square output presets with automatic fitting and interactive crop preview

**Every device**
- The full Studio runs in any modern browser; `?mobile=1` serves the touch-first companion view; both are PWA-installable on phones
- Files arrive by drag-and-drop upload (or file picker) and generated outputs are browsable, previewable, and directly reusable as new inputs

## Local services

**Trust & setup**
- Setup doctor in Settings: verifies FFmpeg, HTTPS tooling, the engine device, and attention backends, with exact fixes
- GPU-tier guidance (8/16/24 GB, Blackwell) from the community quant tiers
- One-time model-license notice covering the MiniMax community license's reported region and commercial-use constraints

- ComfyUI defaults to `http://127.0.0.1:8188`
- Ollama defaults to `http://127.0.0.1:11434`; the app lists installed local text models and excludes embedding and cloud-backed entries

Both addresses, every model directory, and the ComfyUI output directory can be changed from Settings.

## Workflow compatibility

MiniMax generation is built from ComfyUI's official T2V/I2V/Ref2V core graph: native H3 conditioning, `RandomNoise`, `BasicGuider`, `res_multistep`, `simple`, joint video/audio latent decoding, and `CreateVideo`/`SaveVideo`. The app prefers the official pruned INT8 ConvRot diffusion safetensors, NVFP4-AWQ text encoder, FP16 video VAE, and FP32 audio VAE when multiple matching files exist. Live preview and LTX/RTX upscaling are separate output branches and do not alter the base H3 sampling path.

Turbo sampling uses the official sampler/scheduler pair unless custom sampling is explicitly enabled; custom combinations remain marked experimental because they are not equivalent to the published template.

The **LTX 2.5** workspace is a separate provider and never reads or changes MiniMax prompts, inputs, turbo LoRAs, samplers, sigma shifts, or upscale choices. Its Quality preset follows ComfyUI's official two-stage distilled workflow (8-step half-res pass → LTX latent 2× → 3-step refinement); Turbo uses the official fixed 8-step distilled schedule as a single full-resolution stage.

## How generation works

The renderer builds ComfyUI API-format graphs in the browser and submits them through the server's `/api` routes; the server proxies ComfyUI, runs FFmpeg for clip operations, and serves generated media with HTTP Range support. Progress arrives over WebSocket (same-machine) or the server's SSE bridge (remote devices).

- `MiniMaxH3ImageToVideo` or `MiniMaxH3ReferenceToVideo`
- `UNETLoader`, `CLIPLoader`, and separate video/audio `VAELoader` nodes
- `SamplerCustomAdvanced` with `res_multistep`
- `VAEDecode`, `VAEDecodeAudio`, `CreateVideo`, and `SaveVideo`

Durations convert to MiniMax H3's required `17k + 5` frame grid at 24 fps. Completed outputs are attributed by the exact filename ComfyUI reports — never by newest-file-on-disk.

For the process model, API surface, and persistence tiers, see [docs/architecture.md](docs/architecture.md).

## ACE-Step 1.5 setup

The Music workspace submits the native ComfyUI ACE-Step 1.5 graph; it does not call a hosted music service. Install the following files into the configured ComfyUI model folders, then use **Settings → Test connection** and rescan models:

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

| Doc | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Server + SPA process model, API surface, generation pipeline |
| [docs/inventory.md](docs/inventory.md) | Exhaustive file/feature/dependency census (pre-migration) |
| [docs/audit/code-quality-audit.md](docs/audit/code-quality-audit.md) | Adversarial review: P0–P3 findings, top-10 fixes |
| [docs/audit/security-audit.md](docs/audit/security-audit.md) | Threat model, findings, hardening priorities |
| [docs/migration.md](docs/migration.md) | The Electron → web migration record |
| [docs/research/ecosystem-2026-09.md](docs/research/ecosystem-2026-09.md) | H3/LTX/ACE/Z-Image ecosystem research driving the roadmap |
| [docs/history/plan-v0.md](docs/history/plan-v0.md) | Upstream's original planning document (historical) |

## License

None yet. Upstream carries no license, which means all-rights-reserved by default; treat this fork as private-use until licensing is clarified with upstream.
