# MiniMax Studio

A local-first Windows desktop interface for MiniMax H3 generation through ComfyUI. Models are indexed and used from their existing locations; the application does not download, copy, or reorganize model files.

## Current capabilities

- Text-to-video, image-to-video, and first/last-frame generation through the FL2VA model
- A separate LTX‑2.5 T2V/I2V workspace with native synchronized audio, live ComfyUI previews, an official two-stage quality preset, and a distilled single-stage Turbo preset
- Mixed image, video, and audio references through the Ref2VA model
- Native synchronized video and stereo-audio decoding
- Official ComfyUI H3 graph topology and sampling defaults, with detected FL2V 4/8-step and Ref2V 4-step turbo LoRAs
- Local Ollama prompt enhancement, timed shot planning, and synchronized-audio rewriting
- In-app playback through a range-aware local media proxy, using either ComfyUI history or the configured output directory
- Z-Image Turbo first-frame generation using locally installed ComfyUI models
- Landscape, portrait, and square output presets with automatic image fitting and an interactive crop preview
- Official `res_multistep` + `simple` sampling by default, an explicit full-quality experimental override, and WebSocket render progress/previews
- Persistent generation defaults with official quality, official 8-step Turbo, and experimental Euler/Beta Turbo presets
- Optional LTX 2.5 2× spatial post-processing for every MiniMax video mode; saves both original and upscaled video while retaining MiniMax audio
- A one-click, per-user NSIS Windows installer with desktop and Start menu shortcuts
- A same-network mobile companion for focused T2V and I2V creation, automatic crop controls, video preview, and download
- A dedicated Z-Image Turbo first-frame workspace with persistent controls, local Ollama enhancement, cancellation, and direct I2V handoff
- Mobile ComfyUI progress/live previews, Ollama prompt revision, cancellation, and optional LTX 2.5 or RTX/CUDA 2× upscaling

## Mobile companion

Launch MiniMax Studio, select **Mobile** in the top bar, and scan the QR code from a phone connected to the same trusted Wi-Fi or LAN. The private access token persists across desktop restarts, so saved phone links keep working. Use **Rotate access link** in the QR dialog whenever you want to invalidate every previously scanned link. Windows Firewall may ask whether the app can accept private-network connections the first time.

The phone uses the model folders, ComfyUI address, and output settings configured on the desktop. The first pass is served over local HTTP for simple LAN access. Browsers require a trusted HTTPS origin for verified PWA installation and service-worker caching, so the HTTP version should be used in the browser or saved as a home-screen shortcut until the guided HTTPS pass is complete.

## Local services

- ComfyUI defaults to `http://127.0.0.1:8188`.
- Ollama defaults to `http://127.0.0.1:11434`. The app lists installed local text models and deliberately excludes embedding and cloud-backed entries. Prompt text never needs to leave the workstation.

Both addresses, every model directory, and the ComfyUI output directory can be changed from Settings.

## Workflow compatibility

MiniMax generation is built from ComfyUI's official T2V/I2V/Ref2V core graph: native H3 conditioning, `RandomNoise`, `BasicGuider`, `res_multistep`, `simple`, joint video/audio latent decoding, and `CreateVideo`/`SaveVideo`. The app prefers the official pruned INT8 ConvRot diffusion safetensors, NVFP4-AWQ text encoder, FP16 video VAE, and FP32 audio VAE when multiple matching files exist. Live preview and LTX/RTX upscaling are separate output branches and do not alter the base H3 sampling path.

Turbo sampling uses the official sampler/scheduler pair unless the user explicitly enables custom sampling. Custom combinations remain clearly marked experimental because they are not equivalent to the published template and can produce unusual motion or composition.

The Settings workspace can save and apply resolution, duration, quality mode, full-quality steps, LoRA strength, reference-image fidelity, live preview, sampler/scheduler, and sigma-shift defaults. Native H3 behavior leaves shifts on the model baseline (video 12, audio 3). Enabling custom shifts inserts ComfyUI's core `MiniMaxH3SigmaShift` node; the Euler/Beta preset is intentionally labeled experimental because it targets converted Turbo LoRA compatibility rather than the published template.

The **LTX 2.5** navigation entry is a separate provider workspace and never reads or changes MiniMax prompts, inputs, Turbo LoRAs, samplers, sigma shifts, or post-render upscale choices. Its Quality preset follows ComfyUI's official two-stage distilled workflow: an 8-step half-resolution pass, LTX latent spatial 2× upscaling, and a 3-step refinement pass. Its Turbo preset uses the official fixed 8-step distilled schedule as a single full-resolution stage. Both use Euler ancestral, CFG 1, 24 fps, the LTX Gemma encoder, separate LTX video/audio VAEs, and native synchronized audio.

## Build and package

```powershell
pnpm install
pnpm build
pnpm package:win
```

The installer is written to `release\MiniMax-Studio-Setup-0.1.0.exe`.
- Independent model locations for diffusion models, text encoders, VAEs, LoRAs, preview VAEs, and vision encoders
- ComfyUI connection health, GPU/VRAM display, job status, cancellation, history, and output playback
- Responsive layouts for compact and large desktop windows

## Requirements

- Node.js 20+
- pnpm 10+
- A current local ComfyUI instance with MiniMax H3 core nodes (and current LTX‑2.5 core nodes when using the LTX workspace)
- The MiniMax H3 model components already present on disk

The default model root is `%USERPROFILE%\Documents\ComfyUI\models`, but every category can be changed in **Settings → Model locations**.

## Development

```powershell
pnpm install
pnpm build
pnpm dev
```

If the development environment sets `ELECTRON_RUN_AS_NODE=1`, clear it before launching Electron:

```powershell
$env:ELECTRON_RUN_AS_NODE=$null
pnpm start
```

Start ComfyUI separately, then use **Settings → Test connection**. The default server is `http://127.0.0.1:8188`.

## How generation works

The renderer sends media paths through a context-isolated Electron bridge. Electron uploads selected inputs to the configured local ComfyUI server and submits a native API-format graph using these core nodes:

- `MiniMaxH3ImageToVideo` or `MiniMaxH3ReferenceToVideo`
- `UNETLoader`, `CLIPLoader`, and separate video/audio `VAELoader` nodes
- `SamplerCustomAdvanced` with `res_multistep`
- `VAEDecode`, `VAEDecodeAudio`, `CreateVideo`, and `SaveVideo`

Durations are converted to MiniMax H3's required `17k + 5` frame grid at 24 fps. Reference autogrow inputs use ComfyUI's required dotted API keys, such as `ref_images.ref_image_0`.
