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

## Renderer structure

`src/App.tsx` (~550 lines) is the composition shell — hook wiring, view routing, and handoffs between workspaces. The domain logic is layered so each feature lands in exactly one place:

| Layer | Modules | What lives there |
| --- | --- | --- |
| `src/views/` | `CreateView`, `LibraryView`, `JobsView`, `SettingsView` | One component per nav destination + its private helpers (reference pickers, strips, modals) |
| `src/hooks/` | `useStudioSession` | Settings load, model scanning, ComfyUI connection/object-info, Ollama list, GPU telemetry |
| | `useGenerationQueue` | Job persistence, guarded history polling, deadline sweep, cancellation |
| | `useCreateWorkspace` | Every persisted Create field, the character/wardrobe/location libraries, reference binding and ordering, media picking, reset |
| | `useGenerationFlows` | Submit-side generation for every provider (H3 + upscale validation, LTX 2.5, ACE-Step, the fixed-seed diagnostic pair) |
| `src/lib/` | `workspace`, `promptPolicies`, `h3Stack`, `jobRecords`, `format` (+ existing workflow builders) | Pure functions: persistence shapes, H3 prompt composition, validated-stack reporting, completion side effects |
| `src/components/` | `form`, `chrome`, `media` (+ one file per workspace/studio) | Labeled fields, titlebar/nav/notice/badges, video playback and drop widgets |

Adding a feature is a one-file change: a workspace field goes in `useCreateWorkspace` + `PersistedWorkspace`; a new generator goes in `useGenerationFlows` + a graph builder in `lib/`; a new view goes in `src/views/` plus a route in `App.tsx`.

## State & persistence

- **Server-side:** `~/.minimax-studio/settings.json` (atomic writes), LAN token file
- **Browser localStorage (per browser):** ~20 keys — workspace state, jobs (last 100), movie projects + undo history, clip projects, frame bookmarks, six library collections. Libraries signal changes via `window` CustomEvents; saves route through `persistToLocalStorage` (`src/lib/libraryStorage.ts`) which survives quota exhaustion by scrubbing inline previews
- **Disk (output directory):** FFmpeg artifacts (reference clips, extracted frames, joined videos, character references) in named subfolders

## Development

```bash
pnpm build          # typecheck + web build + server build
pnpm start:server   # run the app on :4178
pnpm dev            # vite HMR on :5173 (proxies /api to :4178)
pnpm test           # assertion suite (workflows, reducer, persistence, poll kernel)
pnpm smoke:server   # boots the built server on a scratch port; verifies routes + guards
pnpm test:e2e       # builds, then Playwright: 14-view render sweep at 1920x1080
                    # with console-error tracking + per-view vision screenshots
pnpm test:all       # unit + E2E + smoke
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, unit, build, smoke, and E2E on every push and PR.

## Known debts / follow-ups

- Desktop/mobile generation semantics share builders but duplicate orchestration with drift
- The Create view's primary Generate button and bottom controls are below the fold at 1080p, and six status signals contradict each other on first run — tracked as the UI polish wave (task ipmk4ci) with vision-inspection evidence
