# Architecture

> Contributor-oriented overview of how MiniMax Studio is built. For the exhaustive file-by-file census, see [inventory.md](inventory.md). Last verified against `18fe989` (2026-09-09).

## What this is

An Electron desktop app (Windows-first) that provides a studio UI for local AI generation: MiniMax H3 video (T2V/I2V/Ref2V), LTX-2.5 video, ACE-Step 1.5 music, and Z-Image stills — all executed by a **local ComfyUI** instance the app does not own or manage. Local Ollama supplies prompt enhancement and structured planning. A LAN companion server lets a phone drive generation from the same Wi-Fi.

The app **indexes models from their existing locations** — it never downloads, copies, or reorganizes model files.

## Process model

```
┌─────────────────────────────┐        IPC (30 invoke channels)      ┌──────────────────────┐
│  Renderer (React 18 SPA)    │ ◄──────────────────────────────────► │  Electron main        │
│  src/App.tsx (desktop)      │      electron/preload.ts bridge      │  electron/main.ts     │
│  src/MobileApp.tsx (mobile) │                                      │  (823 lines, all of:  │
└──────┬──────────────────────┘                                      │   settings, model     │
       │                                                             │   scan, REST proxy,   │
       │ direct WebSocket                                            │   ffmpeg, LAN server, │
       ▼                                                             │   media protocol)     │
ws://<comfy>/ws?clientId=…                                           └──────┬───────────────┘
(progress + binary preview frames)                                          │ REST + WS bridge
                                                                            ▼
                                                                    ComfyUI  :8188 ──┐
                                                                    Ollama   :11434 ──┤ local services
                                                                    (render farm)     │
                                                                            ┌────────┘
                                                                            ▼
                                                              LAN HTTP :4178 (0.0.0.0, token)
                                                                            │
                                                                   phone / tablet (PWA)
```

Three processes plus one sidecar:

| Process | Entry | Responsibility |
|---|---|---|
| Electron main | `electron/main.ts` | Window, settings persistence (`userData/settings.json`), model-folder scanning, **all** ComfyUI/Ollama REST calls, FFmpeg spawning, `nvidia-smi` telemetry, the `minimax-media://` privileged protocol, the LAN server |
| Preload | `electron/preload.ts` | `contextBridge` exposing 30 `ipcRenderer.invoke` wrappers as `window.minimax` |
| Renderer | `src/main.tsx` | React SPA; `App` (desktop) or `MobileApp` (when `?mobile=1`) |

Design consequences worth knowing:

- **All REST is proxied through main; progress is not.** The renderer opens its own WebSocket directly to ComfyUI (`src/lib/useLivePreview.ts`) with auto-reconnect and binary preview-frame parsing. The main process separately bridges ComfyUI `/ws` → SSE for mobile clients.
- **No main→renderer push exists.** Desktop progress arrives via the renderer's WebSocket; everything else is request/response over IPC.
- **One bundle serves desktop and browser.** `src/browserMock.ts` installs a fake `window.minimax` when the preload is absent, so the LAN-served SPA runs — but against mock data (see [audit](audit/code-quality-audit.md), P1-4: the "full Studio" LAN link is a mock shell today).

## ComfyUI workflow layer

`src/lib/` contains the graph builders, which deliberately mirror ComfyUI's official templates:

- `workflow.ts` — MiniMax H3 T2V/I2V/Ref2V graphs with optional turbo LoRAs, sigma-shift node, animated-preview node, and post-render LTX/RTX upscale branches. `frameCount()` implements the 17k+5 latent grid arithmetic.
- `ltx25Workflow.ts` — LTX-2.5 official two-stage Quality (8 steps half-res → latent 2× → 3-step refine) and single-stage Turbo graphs, with fixed sigma schedules.
- `aceStepWorkflow.ts`, `zimage.ts` — ACE-Step 1.5 and Z-Image graphs.
- `modelSelection.ts` — regex inference mapping installed model files to graph inputs, preferring official precision variants.

⚠️ **Known coupling:** output extraction (`workflow.ts:181`, `main.ts:325`) prefers history outputs from hard-coded node ids `'84'` then `'70'`. These literals must stay in sync with the graph builders.

## Generation pipeline (and where it's fragile)

1. Compose effective prompt (`composeH3Prompt`, dialogue/movement/clothing policies)
2. Upload reference media (`comfy:upload*` → ComfyUI `input/minimax-desktop/`)
3. Build graph, submit (`comfy:submit` → `POST /prompt` with a client id)
4. Track: WebSocket progress events + 1 s history polling per pending job
5. On completion: read exact output from history (`extractOutputUrl`) for playback; a separate `outputs:latest` mtime-scan heuristic attempts to localize the file for library writes
6. Post-processing: optional LTX latent 2× upscale; library/queue persistence

Steps 4–6 are the fragile part — see the [code-quality audit](audit/code-quality-audit.md) (P0-1 output attribution, P1-1/P1-5/P1-6 polling robustness) before touching them.

## State & persistence

Two tiers, no state library:

- **Main process / disk:** `userData/settings.json` (hand-rolled JSON, merge-over-defaults), `lan-access-token.txt`
- **Renderer localStorage:** ~20 keys (`minimax.workspace`, `minimax.jobs` last-100, movie projects + undo history, clip projects, frame bookmarks, per-workspace state, six library collections). Libraries signal changes via `window` CustomEvents.

FFmpeg artifacts (reference clips, extracted frames, joined videos, character references) are written into subfolders of the configured ComfyUI output directory. Temp files go to the OS temp dir.

## LAN companion

`startLanServer()` (main.ts:460) binds `0.0.0.0:4178` (env `MINIMAX_LAN_PORT`), plaintext HTTP, gated by a persisted 128-bit token (`x-minimax-token` header or `?token=` query). All `/api/lan/*` routes proxy ComfyUI/Ollama — local services are never directly exposed. Static `dist/` serving with SPA fallback handles everything else. Security posture and known gaps: [security audit](audit/security-audit.md).

## Build & packaging

Vite 6 + TypeScript (two tsconfigs: renderer ES2022/strict, electron NodeNext). electron-builder → NSIS x64 per-user installer. Runtime deps are deliberately minimal: `react`, `react-dom`, `lucide-react`, `qrcode`, `ws`.

## Known structural debts

Maintained in the audits, not here, so this document stays evergreen-structural:

- `src/App.tsx` (1,961 lines) concentrates 31 `useState` and all desktop orchestration
- Desktop/mobile duplicate generation semantics with drift
- Main-process path guards use Windows-only separators (fail closed on POSIX)
- No test framework wired (one orphaned assertion suite in `scripts/test-workflows.cjs`)
