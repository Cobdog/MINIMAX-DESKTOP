# Architecture

> Contributor-oriented overview of MiniMax Studio as a web application. For the migration history, see [migration.md](migration.md). Last verified at the Electron decommission (2026-09-10).

## What this is

A standalone Node web server (`server/`) that serves a React SPA (`src/`) and a local API, fronting local services the app does not own: **ComfyUI** (rendering), **Ollama** (prompt assistance), **FFmpeg** (clip operations). Every browser on the network — workstation, phone, tablet — gets the full Studio.

The app **indexes models from their existing locations** — it never downloads, copies, or reorganizes model files.

## Process model

```
┌──────────────────────────────────────────────────────┐
│  minimax-studio server (server/index.ts, Node 20+)   │
│                                                      │
│  static:  dist/ — the SPA (full Studio + mobile view)│
│  /api/*:  settings · comfy proxy · ollama · ffmpeg   │
│           ops · uploads · media (Range) · SSE bridge │
│  config:  ~/.minimax-studio/settings.json            │
└──────┬────────────────────────────┬──────────────────┘
       │ REST + WS                  │ spawns
       ▼                            ▼
   ComfyUI :8188                  ffmpeg
   Ollama  :11434                 (frames/trim/join)

  any browser ── http://workstation:4178 ──► full Studio
                 ?mobile=1 ───────────────► touch companion
```

Two modules:

| Module | Role |
|---|---|
| `server/core.ts` | `createStudioServer(paths)` factory: settings persistence (atomic write-then-rename), model scanning, ComfyUI/Ollama proxy, GPU telemetry, FFmpeg operations, output resolution, the full route table, static hosting. Zero Electron imports; everything path-parameterized |
| `server/index.ts` | Standalone entry: resolves config home (`MINIMAX_STUDIO_HOME`, default `~/.minimax-studio`), serves `dist/`, listens on 4178 (`MINIMAX_LAN_PORT`) |

## The renderer bridge

The SPA never talks to ComfyUI REST directly — it consumes the server's API through `src/lib/apiClient.ts`, which implements the `DesktopApi` interface (`src/types.ts`) over HTTP and installs as `window.minimax` at startup. The interface is the seam that made the Electron→web migration possible: the same 24-method contract the old preload exposed.

Media references flow as strings on `MediaFile.path`:
- `comfy-input:<subfolder>/<name>` — user-picked files, uploaded to ComfyUI's input tree at selection time
- output-contained paths — generated files, resolvable server-side (containment-checked)
- legacy `minimax-media://` URLs from the Electron era are translated by `src/lib/mediaUrls.ts` at playback

The server is authoritative for service URLs, the output directory, and the FFmpeg executable — those bridge arguments are accepted and ignored, so a compromised or buggy renderer cannot redirect them.

## API surface

All routes under `/api/lan/` (legacy prefix retained from the mobile-companion era). Representative routes: `bootstrap`, `settings` (GET/POST), `object-info`, `comfy-status` (SSRF-guarded), `prompt`, `history/{id}`, `cancel`, `events` (SSE⇄WS bridge), `ollama` + `ollama/structured`, `video/{frame,frames,trim,join}`, `outputs/{resolve,save-image}`, `upload` / `upload-media` / `upload-output`, `media` (ComfyUI proxy or output-contained local serving with Range), `telemetry`, `characters`. Full contract table in [migration.md](migration.md).

Security posture: **open on the LAN by default** (ComfyUI-consistent; a deliberate 2026-09-10 decision), token-gated via `--token` / `MINIMAX_LAN_TOKEN=1` for hostile networks. Input validation everywhere: path containment (`relative()`-based), numeric FFmpeg arguments (concat-directive injection guarded), MIME allowlists and size caps on uploads, SSRF guard on probe-able URLs.

## Generation pipeline

1. Compose effective prompt (`composeH3Prompt`, dialogue/movement/clothing policies)
2. Reference media already uploaded at selection time (`comfy-input:` refs) or resolved from outputs
3. Build the official ComfyUI graph (`src/lib/workflow.ts` et al.), submit via `prompt`
4. Track: WebSocket progress (same-machine) or SSE (remote) + history polling through the shared poll kernel (`src/lib/promptWatch.ts` — tolerance, deadline, cancellation)
5. On completion: attribute the output by the **exact filename ComfyUI reported** (`extractOutputFile` + `outputs/resolve`) — never newest-file-on-disk; resolve locally when possible, stream via the proxy otherwise
6. Post-processing: optional LTX latent 2× upscale; library/queue persistence

Job state transitions live in the pure reducer `src/lib/jobReducer.ts` (terminal-state guards, no-output cap, deadline), unit-tested in `scripts/test-workflows.cjs`.

## State & persistence

- **Server-side:** `~/.minimax-studio/settings.json` (atomic writes), LAN token file
- **Browser localStorage (per browser):** ~20 keys — workspace state, jobs (last 100), movie projects + undo history, clip projects, frame bookmarks, six library collections. Libraries signal changes via `window` CustomEvents; saves route through `persistToLocalStorage` (`src/lib/libraryStorage.ts`) which survives quota exhaustion by scrubbing inline previews
- **Disk (output directory):** FFmpeg artifacts (reference clips, extracted frames, joined videos, character references) in named subfolders

## Development

```bash
pnpm build          # typecheck + web build + server build
pnpm start:server   # run the app on :4178
pnpm dev            # vite HMR on :5173 (proxies /api to :4178)
pnpm test           # assertion suite
pnpm smoke:server   # boots the built server on a scratch port; verifies routes + guards
```

## Known debts / follow-ups

- Remote browsers opening the full Studio get degraded live preview (direct WebSocket to ComfyUI assumes same-machine); the SSE bridge should become the fallback
- `App.tsx` remains a 1,900-line God component — decomposition tracked on the board
- Desktop/mobile generation semantics share builders but duplicate orchestration with drift
- No CI yet; the assertion suite is wired (`pnpm test`) but nothing runs it on push
