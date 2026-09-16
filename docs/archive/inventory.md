# MINIMAX-DESKTOP — Repository Inventory

> Surveyed at `18fe989` (2026-09-09) by an automated inventory pass, as part of the Cobdog fork onboarding.
> Purpose: factual foundation for the documentation restructure and the strengths/weaknesses audit.

Repo root: `/home/agent/work/VS Proj/MINIMAX-DESKTOP`. Fork: `Cobdog/MINIMAX-DESKTOP` (origin), `jamesk9526/MINIMAX-DESKTOP` (upstream).

---

## 1. Architecture Map

### 1.1 Process boundaries

Three processes, plus one sidecar server:

| Process | Entry | Role |
|---|---|---|
| **Electron main** | `electron/main.ts` → compiled to `dist-electron/main.js` (via `tsconfig.electron.json`, `"main"` in package.json) | Window creation, settings persistence, model-folder scanning, **all** ComfyUI/Ollama REST calls, FFmpeg spawning, `nvidia-smi` GPU telemetry, the `minimax-media://` privileged protocol, and the **LAN HTTP server** (default port **4178**, binds `0.0.0.0`) |
| **Preload** | `electron/preload.ts` | `contextBridge.exposeInMainWorld('minimax', …)` — 30 `ipcRenderer.invoke` wrappers. `contextIsolation: true`, `nodeIntegration: false` (electron/main.ts:524-528) |
| **Renderer** | `src/main.tsx` → mounts `App` (desktop) or `MobileApp` (when `?mobile=1`) | React 18 SPA; decides route by query param, toggles a `mobile-route` class on `<html>` |

A single Vite bundle (`dist/`, `index.html` + one script) serves both desktop and LAN/mobile clients. `src/browserMock.ts` installs a fake `window.minimax` when the renderer runs in a plain browser (no preload), including elaborate canned Ollama structured-output mocks — the app is fully browsable without Electron.

### 1.2 IPC surface — complete list

All channels are `ipcMain.handle` (request/response). **There are no `ipcMain.on` listeners and no main→renderer `webContents.send`** — desktop progress comes from the renderer's own direct WebSocket to ComfyUI (§1.3).

| Channel (main) | Preload method | What it does |
|---|---|---|
| `settings:get` / `settings:save` | `getSettings` / `saveSettings` | Load/save `userData/settings.json` |
| `system:gpu-telemetry` | `getGpuTelemetry` | Spawns `nvidia-smi`, 1.8 s timeout |
| `dialog:directory` / `dialog:media` | `chooseDirectory` / `chooseMedia` | Native file/folder pickers (image/video/audio filters) |
| `models:scan` | `scanModels` | Recursive scan of 6 model-kind dirs for `.safetensors/.pt/.pth/.gguf/.onnx` |
| `comfy:status` | `getComfyStatus` | GET `/system_stats` + latency |
| `comfy:info` | `getObjectInfo` | GET `/object_info` (used for node-availability + combo choices) |
| `comfy:submit` | `submitPrompt` | POST `/prompt` with `{prompt, client_id}` |
| `comfy:queue` | `getQueue` | GET `/queue` |
| `comfy:history` | `getHistory` | GET `/history/{promptId}` |
| `comfy:cancel` | `cancelPrompt` | POST `/interrupt` (running) or POST `/queue {delete:[id]}` (pending); reports state |
| `comfy:upload` | `uploadInput` | POST `/upload/image` from a file path (subfolder `minimax-desktop`) |
| `comfy:upload-data` | `uploadImageData` | POST `/upload/image` from a base64 PNG (≤64 MB), subfolder `minimax-desktop` |
| `comfy:output-image` | `getOutputImage` | GET `/view` → returns data URL |
| `comfy:save-output-image` | `saveComfyOutputImage` | GET `/view` → writes into `<outputDir>/MiniMax Character References/`; **rejects any directory other than the configured output dir** |
| `ollama:list` | `listOllamaModels` | GET `/api/tags`; filters remote/cloud stubs (`remote_model`, size 342) |
| `ollama:generate` | `generateWithOllama` | POST `/api/generate` (`stream:false, think:false`, temp 0.65, 1200 tokens); strips `<think>`/`<analysis>` blocks |
| `ollama:structured` | `generateStructuredWithOllama` | POST `/api/chat` with `format: schema` (temp 0.2, 6000 tokens) — used only by MoviePlanner |
| `file:data-url` | `fileDataUrl` | Read image file → data URL |
| `file:media-url` | `mediaUrl` | Returns `minimax-media://selected?path=…` |
| `video:frame` | `extractVideoFrame` | FFmpeg single-frame extract (supports `'last'` via `-sseof -0.15`) |
| `video:frames` | `extractVideoFrames` | Batch extract, 1–100 positions (Frame Bookmarks) |
| `video:trim` | `trimVideo` | 2–15 s H.264/AAC re-encode → `MiniMax Studio Reference Clips/` |
| `video:join` | `joinVideos` | FFmpeg concat demuxer, stream copy → `<out>/video/MiniMax_Joined_<ts>.mp4` |
| `shell:show-output` | `showOutput` | `shell.showItemInFolder` |
| `outputs:latest` | `findLatestOutput` | Recursive mtime scan of output dir since job creation |
| `lan:status` | `getLanStatus` | Current LAN server state + share URLs |
| `lan:sync-characters` | `syncMobileCharacters` | Pushes character library (with hydrated previews) into main-process memory for `/api/lan/characters` |
| `lan:rotate-token` | `rotateLanToken` | New 32-hex token, persisted, share URLs rebuilt |

### 1.3 ComfyUI connectivity

- **REST from main process** (`comfyFetch`): `/system_stats`, `/object_info`, `/prompt`, `/queue` (GET + POST-delete), `/interrupt`, `/history/{id}`, `/view`, `/upload/image`.
- **WebSocket from the renderer directly** (`src/lib/useLivePreview.ts`): connects to `ws://<comfyUrl>/ws?clientId=<uuid>` with `binaryType: arraybuffer`, auto-reconnect every 3 s. Parses JSON events (`execution_start`, `executing`, `progress`, `executed`, `execution_cached`, `execution_success`) and binary preview frames (8-byte header; special-cases a 32-byte animated-H3 JPEG header). Also handles the custom `minimax_h3_preview_override` message type from the MiniMax H3 Preview Override custom node (animated WebP/MP4 preview). Note: this is a renderer-initiated socket — the renderer talks to ComfyUI directly for progress, while all REST goes through IPC.
- **WebSocket from main process** (`ws` dep): `streamLanEvents()` bridges ComfyUI `/ws` → SSE (`text/event-stream`) for mobile clients, with 15 s keepalive comments and the same binary-frame parsing.
- Job completion polling: desktop renderer polls `/history/{id}` every 1 s per pending job (App.tsx:574-613); Z-Image polls every 2 s; MobileApp polls every 1 s for up to 1800 iterations (30 min).
- **Hard coupling worth flagging:** `extractOutputUrl()` (workflow.ts:181) and `historyOutput()` (main.ts:325) prefer history outputs from node ids `'84'` (RTX upscale SaveVideo) then `'70'` (LTX upscale SaveVideo) — node-id literals that must stay in sync with the graph builders.

### 1.4 Ollama integration points

- Default `http://127.0.0.1:11434`, model `qwen3:latest`; all calls proxied by main (renderer never fetches Ollama on desktop).
- `/api/generate` — prompt Enhance / Shot timeline / Audio pass (App), Z-Image/Hair/Wardrobe/Location/ACE-Step prompt enhancement, AiChatHead copilot, MoviePlanner freeform assists.
- `/api/chat` + JSON schema — MoviePlanner structured planning & conversational project editing (scene/shot schemas, character/location schemas, and a large `movieChatSchema` patch format).
- Renderer filters out `nomic-bert` embedding families; LAN bootstrap repeats the filter.

### 1.5 Local media proxy (`minimax-media://`) and LAN/mobile server

**Protocol** (registered privileged: standard, secure, fetch API, CORS, stream):
- `minimax-media://comfy?url=<encoded ComfyUI /view URL>` — validates origin + pathname `/view` against the configured ComfyUI server, else 403; strips CSP/content-disposition, sets `access-control-allow-origin: *`.
- `minimax-media://local?path=…` — only paths under the configured **outputDirectory** (Windows-style backslash prefix compare at main.ts:564 — portability quirk).
- `minimax-media://selected?path=…` — any user-picked file with an allowed extension (video/audio/image). Full HTTP Range support for local files (206, suffix ranges, HEAD).

**LAN server** (`startLanServer`, main.ts:460):
- Port: `MINIMAX_LAN_PORT` env or **4178**; listens on `0.0.0.0`; HTTP only (README acknowledges PWA install needs HTTPS — not yet implemented).
- Best-address heuristics: prefers private IPv4, Wi-Fi/Ethernet adapter names, penalizes virtual adapters (virtual/wsl/docker/vmware/vpn/tailscale/hamachi).
- **Auth:** 32-hex token persisted at `userData/lan-access-token.txt`, checked on every `/api/lan/*` request via `x-minimax-token` header **or** `?token=` query. 401 with a friendly message when stale. Rotation regenerates + persists. ComfyUI/Ollama are never exposed to the LAN directly — everything is proxied.
- Routes (all token-gated): `GET /api/lan/bootstrap` (connectivity + models + upscalers + LTX readiness + Ollama models), `GET /api/lan/characters`, `POST /api/lan/upload` (PNG ≤35 MB), `POST /api/lan/upload-media` (any reference media ≤175 MB data-URL, MIME allowlist, filename sanitized), `POST /api/lan/prompt` (raw ComfyUI graph, clientId validated), `GET /api/lan/events` (SSE⇄WS bridge, clientId regex-validated), `POST /api/lan/ollama`, `POST /api/lan/cancel`, `GET /api/lan/history/{promptId}`, `GET /api/lan/media` (range-preserving proxy of ComfyUI `/view`, optional `download=1`).
- Everything else falls through to static serving of `dist/` with SPA fallback to `index.html` (path-traversal guard again uses a `\` separator — Windows-only assumption at main.ts:448).

---

## 2. Source Tree Census

96 files tracked in git. Line counts (from `wc -l`):

**Root/config**

| File | Lines | Responsibility |
|---|---|---|
| `package.json` | 92 | Manifest, scripts, electron-builder config |
| `pnpm-lock.yaml` / `pnpm-workspace.yaml` (6) | — | lockfile v9; workspace `.` + `onlyBuiltDependencies: electron, esbuild` |
| `vite.config.ts` | 10 | React plugin, `base: './'`, outDir `dist` |
| `tsconfig.json` | 20 | Renderer: ES2022, strict, Bundler resolution, `noEmit` |
| `tsconfig.electron.json` | 14 | Electron: NodeNext, emits to `dist-electron` |
| `eslint.config.mjs` | 27 | Flat config; TS/TSX with react-hooks + react-refresh; node globals for `scripts/*.cjs` |
| `index.html` | 17 | SPA shell + PWA meta (manifest, apple-touch-icon, theme color) |
| `.gitignore` (7) / `.gitattributes` (2) | | node_modules, dist*, release, logs, `.flux/`; `* text=auto` |
| `README.md` | 141 | See §7 |
| `plan.md` | 528 | See §7 |
| `CLAUDE.md` | 25 | Flux task-management agent guidance |

**`electron/`** (857 lines total — the entire main process)

| File | Lines | Responsibility |
|---|---|---|
| `electron/main.ts` | **823** | Everything in §1: window, settings, IPC handlers, ComfyUI/Ollama proxy, media protocol, LAN server, FFmpeg, GPU telemetry |
| `electron/preload.ts` | 34 | `window.minimax` bridge (30 methods) |

**`src/`** (renderer)

| File | Lines | Responsibility |
|---|---|---|
| `src/App.tsx` | **1,961** | Desktop shell: 14 views, all state, CreateView/SettingsView/Queue/Library/LAN dialog, generation orchestration, H3 diagnostics |
| `src/styles.css` | **2,201** | Main stylesheet (largest file in repo) |
| `src/MobileApp.tsx` | 401 | Mobile companion PWA UI (video/image/cast) |
| `src/types.ts` | 316 | Entire shared type system (§4) |
| `src/browserMock.ts` | 132 | Full `window.minimax` browser-preview stub with canned Ollama/structured outputs |
| `src/main.tsx` | 18 | Entry; desktop vs mobile route; CSS imports; browser mock install |
| `src/global.d.ts` | 9 | `Window.minimax: DesktopApi` declaration |
| `src/guided-studio.css` | 23 | Supplementary styles |

**`src/components/`** (19 files)

| File | Lines | Responsibility |
|---|---|---|
| `MoviePlanner.tsx` | **739** | 4-step movie wizard + Ollama copilot + review/undo + preview player |
| `CharacterStudio.tsx` | 277 | Character identity library; Z-Image refs; LTX turntable; 5-frame auto set |
| `ClipEditor.tsx` | 241 | Media bin + timeline, trim, frame extraction, concat export |
| `ZImageWorkspace.tsx` | 219 | Z-Image Turbo/base stills workspace |
| `LocationStudio.tsx` | 177 | Location library + walkthrough automation |
| `FrameBookmarkStudio.tsx` | 160 | Per-video time bookmarks + batch frame extraction |
| `Ltx25Workspace.tsx` | 124 | LTX-2.5 T2V/I2V workspace |
| `AceStepWorkspace.tsx` | 119 | ACE-Step 1.5 music workspace |
| `CharacterDialogueModal.tsx` | 111 | Ollama dialogue writer for a selected character |
| `SmartPromptEditor.tsx` | 87 | Textarea with `//` preset inserter + library asset options |
| `VideoReferenceClipper.tsx` | 86 | In/out trim UI for reference video clips |
| `HairStudio.tsx` | 79 | Hair library + Z-Image reference |
| `RenderSize.tsx` | 74 | Resolution picker (video orientations + image aspect ratios) |
| `WardrobeStudio.tsx` | 62 | Wardrobe library + Z-Image refs |
| `AiChatHead.tsx` | 62 | Floating copilot (prompt/image/video modes) |
| `AccessoryStudio.tsx` | 53 | Accessory library + Z-Image refs |
| `ImageCrop.tsx` | 34 | Interactive crop/zoom/fit canvas widget |
| `ReferenceApprovalModal.tsx` | 29 | Approve/retry a generated reference image |
| `RenderConstruction.tsx` | 8 | Loading animation |

**`src/lib/`** (19 files)

| File | Lines | Responsibility |
|---|---|---|
| `workflow.ts` | 212 | MiniMax H3 graph builder (T2V/I2V/Ref2V + preview + LTX/RTX upscale branches), `frameCount` (17k+5 grid), `extractOutputUrl` |
| `promptComposer.ts` | 172 | Reference-slot allocation (9-picture round-robin), prompt instruction composition, movie-shot resolution/compilation, Ollama assistant request builder |
| `promptPresets.ts` | 91 | ~190+ insertable cinematography presets in 12 categories + fuzzy search |
| `useLivePreview.ts` | 101 | Renderer WebSocket hook for progress/preview |
| `ltx25Workflow.ts` | 90 | LTX-2.5 official graph (quality two-stage / turbo) with fixed sigma schedules |
| `modelSelection.ts` | 43 | Regex model-file inference for H3 and LTX-2.5 |
| `imageCrop.ts` | 43 | Crop math + canvas prepare (contain/crop) → PNG data URL |
| `dialogPolicy.ts` | 37 | No-dialogue & natural-movement prompt suffixes; dialogue request builder |
| `characterLibrary.ts` | 45 | localStorage CRUD + change events |
| `locationLibrary.ts` | 32 | same pattern |
| `accessoryLibrary.ts` | 33 | same pattern + one-time wardrobe→accessory migration |
| `wardrobeLibrary.ts` | 26 / `hairLibrary.ts` | 26 | same pattern |
| `aceStepWorkflow.ts` | 54 | ACE-Step 1.5 graph builder + required-node list + model inference |
| `zimage.ts` | 22 | Z-Image turbo/base graph (from Comfy-Org templates) |
| `comfyInfo.ts` | 8 | `object_info` combo-choice extraction |
| `createId.ts` | 11 | UUID with fallback |

**`scripts/`** (6 files, ad-hoc Node tooling; only `smoke:lan` and `launch-electron` are wired into package.json)

| File | Lines | Responsibility |
|---|---|---|
| `test-workflows.cjs` | 157 | Pure unit-ish asserts: transpiles lib `.ts` in a VM sandbox, asserts frame-grid math, graph shapes, presets count (≥190) |
| `smoke-generation.cjs` | 63 | Live ComfyUI end-to-end run (WS progress, previews) |
| `smoke-lan.cjs` | 44 | Authenticated LAN HTTP smoke test (reads real token from APPDATA) |
| `smoke-renderer.cjs` | 28 | CDP (`:9231`) script driving the live renderer (references a hardcoded `ZImage_00002_.png`) |
| `probe-playback.cjs` | 18 | CDP media-decode diagnostic for a URL |
| `launch-electron.cjs` | 22 | Spawns Electron, strips `ELECTRON_RUN_AS_NODE` |

**`public/`**: `sw.js` (22 — cache-first-with-network PWA shell, skips `/api/` and tokenized URLs), `manifest.webmanifest` (14), `icons/mobile-192.png`, `icons/mobile-512.png` (444 KB total).
**`build/`**: `icon.png` only (1.4 MB — electron-builder buildResources).
**`Readmescreenshots/`**: **26 PNGs, 14 MB, all committed** (§7/§8).

**Biggest files to know:** `styles.css` 2,201 · `App.tsx` 1,961 · `electron/main.ts` 823 · `MoviePlanner.tsx` 739 · `plan.md` 528 · `MobileApp.tsx` 401 · `types.ts` 316.

---

## 3. Feature Inventory (verified from code)

Sidebar groups in App.tsx: **Generate** (Create, LTX 2.5, Music), **Plan** (Create Image, Characters, Hair, Wardrobe, Accessories, Locations), **Review** (Queue, Library, Clip editor), **Advanced tools** (Movie), plus Settings.

1. **Create — MiniMax H3** (`App.tsx` `CreateView`, view `create`). Four modes (`GenerationMode`): Text→Video, Image→Video (first frame), First+Last frames, and **Reference (Ref2V)** with up to 9 images / 3 videos / 3 audio refs (videos must be pre-trimmed to 2–15 s via `VideoReferenceClipper` → `video:trim`). Real behavior: composes an effective prompt (`composeH3Prompt` + dialogue/movement policies + clothing policy: assigned-wardrobe / underwear / unrestricted), uploads via `comfy:upload*`, builds the graph with `buildMiniMaxWorkflow` (official `res_multistep`+`simple` unless the experimental opt-in is set; turbo LoRAs; optional `MiniMaxH3SigmaShift`; optional `MiniMaxH3PreviewOverrideCS` animated preview), polls history, copies outputs into the local library, and supports frame-accurate "continue from last frame / at time X" chaining. Post-render upscale: LTX-2.5 latent 2× (padded to 8n+1, audio remuxed) or experimental RTX/CUDA frame 2×.
2. **LTX 2.5** (`Ltx25Workspace.tsx`, view `ltx25`). Independent T2V/I2V provider: Quality = official two-stage (8 steps at half-res → latent 2× → 3-step refine, fixed sigma strings), Turbo = single 8-step full-res. Own localStorage workspace (`ltx25.workspace`); completely separate state from MiniMax (verified — it never reads MiniMax prompt/turbo state).
3. **Music — ACE-Step 1.5** (`AceStepWorkspace.tsx`, view `music`). SFT vs Base XL checkpoints, tags/lyrics/instrumental, duration/BPM/time signature/language/key-scale/seed/audio-codes; FLAC output via `SaveAudioAdvanced`; appears in Queue with an audio player; excluded from video Library.
4. **Create Image — Z-Image** (`ZImageWorkspace.tsx`, view `zimage`). Turbo (8 steps, CFG 1, no negative) vs Original (40 steps, CFG 4, negative prompt); model/encoder/VAE combos validated against live `object_info`; polls history 2 s; saves via `comfy:save-output-image`; "Use in MiniMax I2V" handoff sets first frame + resolution + mode. Listens for the `minimax:load-image-prompt` custom event from AiChatHead.
5. **Character Studio** (`CharacterStudio.tsx`, view `characters`). CRUD character projects (description/voice notes/visual style/templates/skin tone); generates Z-Image identity references behind `ReferenceApprovalModal`; "turntable" = a 10 s 768×1024 LTX-2.5 I2V "identity coverage survey" with an extremely detailed hardcoded camera itinerary (App.tsx:1411); on completion auto-extracts 5 frames (0/25/50/75/95 %) as the reference set; links hair/wardrobe/accessory ids; emits library change events consumed by Create and MoviePlanner.
6. **Hair Studio** (`HairStudio.tsx`, 79 lines): hair-style projects + single Z-Image reference with approval.
7. **Wardrobe Studio** (`WardrobeStudio.tsx`): outfit sets, approved image subsets, Z-Image generation, `fitWholeCharacter` contain-crop on import.
8. **Accessories Studio** (`AccessoryStudio.tsx`): categorized accessories (jewelry/eyewear/watch/bag/headwear/prop); includes a one-shot migration that splits legacy wardrobe `accessories[]` strings into standalone projects.
9. **Location Studio** (`LocationStudio.tsx`): environments with `environmentMode` mixed/nature/built; Z-Image base image; "walkthrough" = 5–20 s LTX-2.5 I2V with distinct nature vs built prompt scripts (App.tsx:1416-1426); auto reference-set extraction like Character Studio.
10. **Movie Planner** (`MoviePlanner.tsx`, view `movie`). Four steps: setup → production bible → shots → preview. Ollama-structured planning (`plannerSchema`: up to 24 scenes × 16 shots), assisted treatments/characters/locations; a full-height **conversational copilot** whose JSON-patch responses (`movieChatSchema`: projectPatch + upserts/deletes for characters/locations/scenes/shots) pass through a **field-level diff review modal**, capped 10-snapshot undo history (`minimax.movie-undo-history`), stale-proposal rebasing, destructive-change confirmations; shots resolve through `resolveMovieShot` (auto reference-mode routing, 9-slot allocation, compiled prompts, continuity frame from the previous scene's final render); "open shot" hands off to Create with everything wired; **Movie preview** plays finished shots sequentially in story order without joining.
11. **Queue** (`JobsView` in App.tsx): all providers' jobs, live progress/labels, cancel (interrupt or dequeue), audio rows for ACE-Step.
12. **Library** (`LibraryView` in App.tsx): completed video renders, search/provider filter/sort, entry to Frame Bookmarks, "use as LTX start frame".
13. **Clip Editor** (`ClipEditor.tsx`, view `editor`): media bin (local files + completed jobs), draggable timeline with in/out trim, frame extraction to I2V/first/last/reference, FFmpeg concat export (`video:join`), persisted projects.
14. **Frame Bookmarks** (`FrameBookmarkStudio.tsx`): modal from Library cards; named time bookmarks per video, batch extraction (`video:frames`, 1–100), send to LTX; persisted `minimax.frame-bookmarks`.
15. **Mobile companion** (`MobileApp.tsx`, served at `/?mobile=1&token=…`): three tabs — Video (provider switch MiniMax/LTX with separate persisted state; T2V/I2V/Reference incl. clothing policy and fidelity controls), Image (Z-Image), Cast (synced desktop character library with data-URL previews); SSE live preview; 1 s history polling; cancel; download; Ollama enhance/timeline/audio/custom; PWA install prompt + service worker; `browser-preview` magic token renders a fully mocked demo.
16. **AiChatHead** (`AiChatHead.tsx`): floating copilot bubble with Prompt/Image/Video modes; dispatches image prompts into Z-Image via custom event and video prompts into Create.
17. **LAN sharing dialog** (`LanCompanionDialog` in App.tsx): QR (via `qrcode` lib) for mobile + full-Studio URLs, rotate-token with confirm.
18. **Settings** (`SettingsView` in App.tsx): engine URL/test, **validated H3 stack report** (exact expected filenames with regex fallbacks), fixed-seed H3 A/B diagnostic (Native vs Turbo 8, seed 12345), generation defaults + presets, experimental sampling disclosure, Ollama config, six model-path rows with counters, output dir + FFmpeg path.

Also notable: `SmartPromptEditor` `//` command palette fed by `promptPresets` (190+ entries across camera/shot/angle/lens/lighting/audio/style/movement/transition + live character/wardrobe/location options).

---

## 4. State & Data Model

**`src/types.ts` (316 lines)** defines the entire model: `View` (14 literals), `GenerationMode`, `ModelKind` (6), `MediaKind`, `UpscaleMode`, `ReferencePurpose` (10), prompt-preset types, `MovieReferenceBinding` / `ResolvedMovieShot`, `GenerationDefaults`, `AppSettings`, `ClipItem/ClipProject`, `CharacterProject`, `WardrobeProject`, `AccessoryProject`, `HairStyleProject`, `LocationProject`, the full movie object graph (`MovieCharacter/Location/ChatMessage/Shot/Scene/Project` incl. review gates, aspect ratio, chat messages), `ModelFile`, `MediaFile` (with `crop` and `clip` metadata), `ModelSelection`/`Ltx25…`/`AceStep…` selections & options, `GenerationOptions` (the graph-builder input), `ComfyStatus`, `OllamaModel`, `LanStatus`, `GpuTelemetry`, `GenerationJob`, `UploadedFile`, and the `DesktopApi` bridge interface (mirrors preload exactly).

**Persistence — two tiers, no electron-store:**

1. **Main process / disk (userData dir, e.g. `%APPDATA%\minimax-desktop\`)**
   - `settings.json` — hand-rolled JSON (`loadSettings`/`saveSettings`); merge-over-defaults; clamps steps 16–30 and force-migrates legacy `steps===20`.
   - `lan-access-token.txt` — 32-hex LAN token.
2. **Renderer localStorage (everything else).** Complete key census:
   `minimax.workspace` (full Create state incl. media paths, minus previews), `minimax.jobs` (last 100), `minimax.movie-projects`, `minimax.movie-undo-history`, `minimax.clip-projects`, `minimax.frame-bookmarks`, `minimax.zimage-workspace`, `ltx25.workspace`, `acestep.workspace`, `minimax.character-projects`, `minimax.wardrobe-projects`, `minimax.accessory-projects` (+ `minimax.accessories-migrated-from-wardrobe-v1` flag), `minimax.hair-style-projects`, `minimax.location-projects`, `minimax.mobile-workspace`, `ltx25.mobile-workspace`, `mobile.active-provider`, `minimax.lan-token` (mobile). Libraries signal changes via `window` CustomEvents.

**Other disk writes:** FFmpeg artifacts under the configured ComfyUI output dir — `MiniMax Studio Frames/`, `MiniMax Studio Reference Clips/`, `MiniMax Character References/`, `video/` (joins, and ComfyUI's own video subfolder), plus temp files (`minimax-clip-*.mp4`, `minimax-concat-*.txt`) in the OS temp dir. ComfyUI itself writes renders to its output dir with the app-chosen `filename_prefix`. The `accessoryLibrary` migration is the one place that *writes* localStorage during a read.

---

## 5. Dependency Inventory

**Runtime dependencies (5):**

| Package | Version | Purpose |
|---|---|---|
| `react` / `react-dom` | 18.3.1 | UI (React 18, not 19) |
| `lucide-react` | 0.468.0 | All icons (heavily used) |
| `qrcode` | 1.5.4 | LAN QR code data-URL |
| `ws` | 8.21.3 | Main-process ComfyUI WS→SSE bridge |

**Dev dependencies (20):** `electron ^34.0.0` (resolved 34.5.8), `electron-builder ^26.0.12`, `vite ^6.0.7` (resolved 6.4.3), `@vitejs/plugin-react ^4.3.4`, `typescript ^5.7.2`, `eslint ^9.17.0` + `typescript-eslint ^8.19.1` + `@eslint/js` + `eslint-plugin-react-hooks ^5.1.0` + `eslint-plugin-react-refresh ^0.4.16` + `globals ^15.14.0`, `concurrently ^9.1.2`, `cross-env ^7.0.3`, `wait-on ^8.0.1`, `@types/node`/`react`/`react-dom`/`ws`/`qrcode`, `@electron/rebuild 3.7.2` (exact-pinned), `@rollup/rollup-win32-x64-msvc 4.63.1` (exact-pinned Windows rollup native binary — unusual to pin in package.json but a known Windows-CI workaround).

**pnpm overrides:** `@electron/rebuild 3.7.2`, `electron-builder-squirrel-windows 26.0.12` (the override target is 26.0.12 while the resolved squirrel package is 26.15.3 per the lockfile — mildly inconsistent but presumably intentional to fix a breakage at the time).

**Observations:** no state library, no router, no test framework (no vitest/jest/playwright), no formatter — the dependency set is unusually lean and coherent for the feature count. Versions cluster in the late-2024/early-2025 era (React 18.3, Electron 34, Vite 6, ESLint 9); none are duplicated. The packaging toolchain is **electron-builder → NSIS x64 one-click per-user installer** (`MiniMax-Studio-Setup-0.1.0.exe`), asar on, buildResources `build/`, output `release/`, desktop+Start-menu shortcuts, `deleteAppDataOnUninstall: false`.

---

## 6. Scripts & Build

package.json scripts: `dev` (concurrently vite + wait-on + electron launcher with `VITE_DEV_SERVER_URL`), `dev:web`, `dev:electron`, `build` (typecheck → vite build → tsc electron), `build:web`, `build:electron`, `typecheck` (both tsconfigs, noEmit), `lint` (`eslint . --max-warnings 0`), `smoke:lan`, `start` (launch-electron only, expects `dist-electron` built), `package:win` (build + electron-builder NSIS x64, `npmRebuild=false`).

**Testing reality:** five hand-rolled Node `.cjs` checks in `scripts/` — but only `smoke:lan` is reachable from package.json. `test-workflows.cjs` (the only true assertion suite: frame-grid math, graph node shapes, preset count) must be run as `node scripts/test-workflows.cjs` manually. The two CDP scripts depend on a manually enabled remote-debugging port 9231, and `smoke-renderer.cjs` references a hardcoded output filename — these read like ad-hoc agent-driven verification, not a maintainable suite. Nothing runs in CI (no CI config exists at all).

`vite.config.ts` is minimal (react plugin, relative base for `file://` loading). ESLint flat config is sensible. `pnpm-workspace.yaml` exists solely to whitelist electron/esbuild postinstall builds.

---

## 7. Docs State

- **README.md (141 lines):** unusually detailed and, on spot-check against code, *accurate* — capabilities list, mobile companion instructions, local services (ports 8188/11434), workflow-compatibility notes (official sampler pair, turbo LoRA policy), build/package/development instructions, ACE-Step setup table with exact filenames + node requirements, and a "How generation works" section describing the bridge and the 17k+5 frame grid. One structural wart: three dangling bullets ("Independent model locations…", "ComfyUI connection health…", "Responsive layouts…") sit under the Build section where a features list clearly used to be.
- **plan.md (528 lines / 38.6 KB), "Automated Movie Pipeline Plan":** structure = Objective → Product principles → Guided production flow → 11 numbered design sections → **Feature-pass progress** (18 numbered "Feature Passes", each tagged *implemented / in progress / next*, with dense bullet lists and a recurring "**Next test gate:**" paragraph) → 4 implementation phases → Research references → Completion criteria. Assessment: it reads unmistakably as an **AI-assisted development log** — the pass numbering, the uniform "implemented/(next)" tags, "Next test gate" ritual, and phrasing like "you supplied" all point to iterative agent-driven development where plan.md was the running scratch memory. It covers far more than movies (passes 7–9, 12–13, 15–18 cover LAN mobile, LTX-2.5, upscaling, Character Studio, reference workspace). Several "next" passes (8, 10, 11: trusted HTTPS install, DaVinci timeline, automation controller) are unimplemented roadmap.
- **CLAUDE.md (25 lines):** Flux task-tracking onboarding — agent guidance, not user docs.
- **Other docs:** none. No LICENSE, CONTRIBUTING, CHANGELOG, `docs/` folder, or inline API docs.
- **`Readmescreenshots/`: 26 PNGs, 14 MB on disk, all committed** (step-0001…step-0026). README embeds only 6 of them. This is the single largest chunk of repo weight.

---

## 8. Git Hygiene

- **Branch:** `main` only, clean working tree. Remotes: `origin` = Cobdog fork, `upstream` = jamesk9526 (post-fork wiring).
- **History:** 11 commits, all 2026-09-07 → 2026-09-09 (entire project ≈ 3 days old). Messages, oldest→newest: `Initial commit`, `update`, `update`, `Add wardrobe references and structured prompt workflows`, `Improve desktop application UI and interactions`, `update`, `udpate` *(sic)*, `pupdate` *(sic)*, `update`, `update readme`, `chore: fork onboarding — Flux task tracking + agent guidance`. **Quality: poor** — 7 of 11 are content-free (including two typos).
- **.gitignore:** adequate — `node_modules/`, `dist/`, `dist-electron/`, `release/`, `*.log`, `.DS_Store`, `Thumbs.db`, `.flux/`. No build artifacts committed.
- **Committed-but-questionable:**
  - `Readmescreenshots/` — 14 MB of screenshots (6 used, 20 dead weight). Biggest hygiene liability; history bloat is permanent without a filter rewrite.
  - `pnpm-lock.yaml` — committed, which is the correct policy for pnpm apps.
- **Missing hygiene entirely:** no CI, no tests wired to scripts, no LICENSE, no `.editorconfig`/prettier, no PR template, no changelog.

---

## Uncertainties (explicit)

- The inventory pass did not run the app, build, or any script; all behavior claims are from reading code. The five `.cjs` scripts' runtime correctness is unverified.
- MoviePlanner lines ~260–739 were skimmed via targeted greps rather than read line-by-line; the copilot/undo/preview behaviors described are confirmed by code hits, but minor UI affordances may be undescribed.
- `Readmescreenshots` PNG contents were not visually inspected; the "browser capture sequence" characterization comes from naming, README text, and size profile.
