# Web Migration Design — Stripping Electron

> Status: **approved direction, design reviewed 2026-09-10**. This document is the contract for the migration epic. The API gap table is verified against code at `a001153`.

## Goal

Retire the Electron shell. MiniMax Studio becomes a standalone Node web server that serves the SPA and a local API, talking to the same local services (ComfyUI `:8188`, Ollama `:11434`) it uses today. One codebase, every device with a browser — workstation, phone, tablet — the full Studio, not a companion.

The existing LAN companion server (formerly `electron/main.ts` → `startLanServer` + `/api/lan/*`) is the seed backend: extend it, don't reinvent it. The renderer keeps its `DesktopApi` interface (`src/types.ts`); a new HTTP client implements that exact interface, so the renderer swaps bridges with zero component changes.

## Decisions (locked 2026-09-10, with Cobdog)

| Decision | Choice | Notes |
|---|---|---|
| File access | **Uploads + server output library** | Drag-and-drop upload for user files; generated outputs browsable server-side and directly reusable as inputs (frame extraction, reference clips — all preserved) |
| Settings | **Server-side JSON** | One `settings.json` on the server; every device sees the same ComfyUI URL, model paths, defaults |
| Packaging | **npm package / `pnpm start`** | Node 20+ (already required for ComfyUI users); Docker single-image later if asked |
| Entry / auth | **No auth on LAN** (default) | ComfyUI-consistent posture. **Accepted trade-off:** anyone on the LAN can submit arbitrary workflow JSON and read outputs — same exposure as running ComfyUI's own UI. The existing token machinery stays available behind a `--token` flag for hostile environments (café Wi-Fi, shared offices); default bind remains `0.0.0.0` with `--host`/localhost override |

## Target architecture

```
┌────────────────────────────────────────────────┐
│ minimax-studio server (Node 20+, no Electron)  │
│                                                │
│  static: dist/ (SPA — App + MobileApp bundle)  │
│  /api/*: settings · comfy proxy · ollama ·     │
│          ffmpeg ops · uploads · media (range)  │
│          SSE progress bridge                   │
│  config: settings.json · outputs on disk       │
└──────┬───────────────────────────┬─────────────┘
       │ REST/WS                   │ spawns
       ▼                           ▼
   ComfyUI :8188                ffmpeg
   Ollama  :11434               (frames/trim/join)

  any browser ── http://workstation:4178 ──► full Studio
```

What replaces each Electron capability:

| Electron capability | Web replacement |
|---|---|
| IPC bridge (30 channels) | HTTP `/api/*` routes; renderer `apiClient` implements `DesktopApi` |
| `minimax-media://` protocol | `/api/media` route (already range-capable; add output-dir + selected-file variants with containment) |
| Native file dialogs | Drag-and-drop upload (`<input type=file>` + dropzones) + server output library browser |
| NSIS installer | `pnpm start` / `npx`; PWA installable on phones |
| `nvidia-smi` telemetry | Same spawn, server-side; exposed via `/api/telemetry` |
| userData settings.json | Server-side `settings.json` (unchanged code, new location) |

## API surface — verified gap table

Status legend: ✅ exists (may need shape adaptation in `apiClient`) · ➕ extend · 🆕 new · ❌ dropped (dead or Electron-only).

| `DesktopApi` method | LAN route today | Migration plan |
|---|---|---|
| `submitPrompt` | `POST /api/lan/prompt` | ✅ |
| `getHistory` | `GET /api/lan/history/{id}` | ✅ server returns `{finished, error, output}`; `apiClient` adapts (job poll uses raw history for `extractOutputFile` — either return raw history alongside, or move descriptor extraction server-side and return `output` + raw `outputs`) |
| `cancelPrompt` | `POST /api/lan/cancel` | ✅ |
| `uploadImageData` | `POST /api/lan/upload` (PNG ≤35 MB) | ✅ |
| `uploadInput` (path-based) | `POST /api/lan/upload-media` (data ≤175 MB) | ➕ renderer reads the picked file? — no: paths don't exist in browsers; callers switch to data uploads or reference server library files by id/path-under-output |
| `generateWithOllama` | `POST /api/lan/ollama` | ✅ |
| `generateStructuredWithOllama` | — | 🆕 `/api/lan/ollama/structured` (JSON-schema mode; MoviePlanner depends on it) |
| `listOllamaModels` | bootstrap | ✅ via bootstrap (cache in client) |
| `getObjectInfo` | bootstrap (summarized) | 🆕 `/api/lan/object-info` raw passthrough (Z-Image validation, LTX/ACE readiness lists) |
| `getComfyStatus` (per-URL test) | bootstrap (configured URL only) | 🆕 `/api/lan/comfy-status?url=` — needed by Settings "Test connection" with a *candidate* URL |
| `scanModels` | bootstrap | ✅ via bootstrap (full 6-kind scan already included) |
| `getSettings` / `saveSettings` | — | 🆕 `GET/POST /api/lan/settings` (the atomic write-then-rename code moves to the server) |
| `getGpuTelemetry` | — | 🆕 `/api/lan/telemetry` (nvidia-smi spawn, 1.8 s timeout) |
| `resolveOutput` | — | 🆕 `/api/lan/outputs/resolve` (containment-checked, from P0-1 fix) |
| `saveComfyOutputImage` | — | 🆕 `/api/lan/outputs/save-image` (Z-Image/Character approval flow) |
| `getOutputImage` | media route | ❌ dead since the P0-2 fix (data-URL previews removed) |
| `getQueue` | — | ❌ dead (no callers; audit P3) |
| `fileDataUrl` | — | ❌ replaced by `/api/media?path=` URLs (no data URLs in the web model) |
| `mediaUrl` | — | ➕ `/api/media` variants: `output` (output-dir contained), `library` (uploaded/selected files by server-side id) |
| `extractVideoFrame` | — | 🆕 `/api/lan/video/frame` |
| `extractVideoFrames` | — | 🆕 `/api/lan/video/frames` |
| `trimVideo` | — | 🆕 `/api/lan/video/trim` |
| `joinVideos` | — | 🆕 `/api/lan/video/join` (numeric clip validation from the security audit lands here) |
| `showOutput` | — | 🆕 best-effort: server logs the path; browser gets a "reveal copied path" toast (no shell access) |
| `syncMobileCharacters` | `GET /api/lan/characters` | ✅ (writer endpoint ➕ if Cast editing is wanted later) |
| `chooseDirectory` / `chooseMedia` | — | ❌ native dialogs gone; replaced by upload dropzones + server output browser |
| `getLanStatus` / `rotateLanToken` | — | ❌ default no-auth mode: status becomes `/api/lan/status` (bind info only); token routes compiled out unless `--token` |

**Media route unification:** today's three `minimax-media://` hosts (`comfy` origin-pinned proxy, `local` output-contained, `selected` any-dialog-file) become `/api/media?source=comfy|output|library&…` with the same validation per source. The `selected` host's any-file-on-disk behavior (security audit MEDIUM) is **not** carried forward — library files are tracked server-side from uploads and outputs only.

## Renderer changes

1. **`src/lib/apiClient.ts`** — implements `DesktopApi` over the routes above; selected in `src/main.tsx` when `window.minimax` is absent (replacing `browserMock` as the real browser bridge). Token (when enabled) bootstrapped from `?token=` and kept for fetches.
2. **Path-shaped state migration** — `MediaFile.path` semantics change from "arbitrary local path" to "server media reference" (upload id or output-contained path). Upload flows produce `MediaFile`s at drop time; output-derived files carry their contained path. `resolveVideoSource`-style acceptance moves server-side.
3. **Dialog replacement** — every `chooseMedia`/`chooseDirectory` call site becomes an upload dropzone or a settings text field (paths are server-side config now; the Settings view gains a "server-side path" hint and a validation button instead of a folder picker).
4. **MoviePlanner / libraries** — unchanged logic; their persisted `MediaFile`s must survive the path-semantics migration (localStorage data written by the Electron era is upgraded lazily: entries whose path doesn't resolve server-side get dropped with a notice, not silently — applying the P1-8 lesson).

## Phase B1 — landed contract (2026-09-10)

All 🆕 routes now exist in the LAN server (runtime-verified compile + contract; live smoke lands with B2/C when the server runs headless):

| Route | Method | Contract |
|---|---|---|
| `/api/lan/settings` | GET | `{ settings }` |
| `/api/lan/settings` | POST | `{ settings }` body (min. `comfyUrl`+`outputDirectory` strings); merged over defaults + clamped, atomic write; returns saved `{ settings }` |
| `/api/lan/object-info` | GET | raw ComfyUI `/object_info` from the configured server |
| `/api/lan/comfy-status?url=` | GET | SSRF-guarded (loopback/private-LAN only; defaults to configured URL) → `{ connected, latencyMs, stats?, error? }` |
| `/api/lan/ollama/structured` | POST | `{ prompt ≤50k, schema }` → JSON-schema chat → `{ result }` or 502 with parse error |
| `/api/lan/telemetry` | GET | `GpuTelemetry` (nvidia-smi, 1.8 s timeout) |
| `/api/lan/outputs/resolve` | GET | `filename`/`subfolder`/`type` query → `{ path, url }` or 404; containment-checked |
| `/api/lan/outputs/save-image` | POST | `{ filename, subfolder?, type? }` → saves into `outputDirectory/MiniMax Character References/` → `{ path, name }` |
| `/api/lan/video/frame` | POST | `{ source, position }` (`'last'` or seconds ≥0) → `{ path, name, url }` |
| `/api/lan/video/frames` | POST | `{ source, positions[1..100] }` → `{ frames: [{path,name,url}] }` |
| `/api/lan/video/trim` | POST | `{ source, start, end }` (2–15 s span) → `{ path, name, url }` |
| `/api/lan/video/join` | POST | `{ clips[2..100] }` — start/end validated numeric ≥0 (concat-injection fix) → `{ path, name, url }` |
| `/api/lan/media?source=output&path=` | GET | output-contained local file, Range/206 support |

Video-route `source` forms: `{ output: <contained path> }`, `{ comfy: { filename, subfolder?, type? } }` (downloaded to temp server-side), or a legacy `minimax-media://` URL. FFmpeg executable and output directory always come from server settings — never from the request. Auth: open by default; `--token` / `MINIMAX_LAN_TOKEN=1` restores token gating.

## Phases (mapped to Flux tasks)

- **B1 — API extension** (`sc1mlke`): add the 🆕 routes to the LAN server while it still lives in `electron/main.ts`; every route input-validated (containment, numeric ffmpeg args, MIME allowlists) per the security audit. Route contract = the table above.
- **B2 — bridge swap** (`11owa1a`): `apiClient.ts` + bridge selection; full app browsable against a live server with zero mock data. Electron bridge still works (both coexist).
- **C — server extraction** (`anbjnyu`): lift the server + routes into `server/` with zero electron imports; `pnpm start:server` runs the web app; Electron shell kept working during transition via shared modules (not copies).
- **D — decommission** (`wn77uo3`): delete `electron/`, `preload.ts`, `browserMock.ts`, `launch-electron.cjs`, NSIS config, `minimax-media://` protocol; PWA polish; README + architecture docs rewritten; CI green on the web-only tree.

## Deferred (explicit non-goals for this pass)

- HTTPS with self-signed cert + fingerprint QR (security audit's long pole) — revisit after migration; the `--token` flag covers hostile-LAN use meanwhile.
- Docker packaging.
- Remote (non-LAN) access of any kind — this remains a workstation app.

## Risks / open watch-items

- **Upload size**: reference videos up to 175 MB already flow through the LAN route; keep the cap and MIME allowlist on every new upload path.
- **Path semantics drift** (B2's real work): the biggest regression surface is persisted localStorage state referencing dead local paths; lazy upgrade + notice, never silent drop.
- **ffmpeg on the server** inherits the audit's injection findings — `video:join` clip validation must land with B1, not after.
