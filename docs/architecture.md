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

**Managed engine runtime** (increment 1 of the self-managed ComfyUI work): `server/runtime.ts` (`RuntimeManager`) can launch and supervise the app's own ComfyUI from a checkout the user nominates, on top of the wave-2c `EngineProcess` supervision contract. Ports allocate from 8191 up, hard-clear of the user's live instances (8188/8189); `extra_model_paths.yaml` is generated into the checkout from the configured model roots (weights are never copied — the same indexing-in-place rule as the scanner); boot reconcile adopts a healthy recorded instance instead of double-spawning; a stop is graceful-then-tree-killed and always resolves. External mode (the default) is byte-for-byte the pre-runtime behavior — nothing spawns, polls, or re-points unless the user switches the mode in Settings.

## The renderer bridge

The SPA never talks to ComfyUI REST directly — it consumes the server's API through `src/lib/apiClient.ts`, which implements the `DesktopApi` interface (`src/types.ts`) over HTTP and installs as `window.minimax` at startup. The interface is the seam that made the Electron→web migration possible: the same 24-method contract the old preload exposed.

Media references flow as strings on `MediaFile.path`:
- `comfy-input:<subfolder>/<name>` — user-picked files, uploaded to ComfyUI's input tree at selection time
- output-contained paths — generated files, resolvable server-side (containment-checked)
- legacy `minimax-media://` URLs from the Electron era are translated by `src/lib/mediaUrls.ts` at playback

The server is authoritative for service URLs, the output directory, and the FFmpeg executable — those bridge arguments are accepted and ignored, so a compromised or buggy renderer cannot redirect them.

## API surface

All routes under `/api/lan/` (legacy prefix retained from the mobile-companion era). Representative routes: `bootstrap`, `settings` (GET/POST), `object-info`, `comfy-status` (SSRF-guarded), `prompt`, `history/{id}`, `cancel`, `events` (SSE⇄WS bridge), `ollama` + `ollama/structured`, `engine/{status,start,stop}` (the managed runtime; start is refused outside managed mode and is idempotent — a repeated start never double-spawns), `video/{frame,frames,trim,join}`, `outputs/{resolve,save-image}`, `upload` / `upload-media` / `upload-output`, `media` (ComfyUI proxy or output-contained local serving with Range), `telemetry`, `characters`. Full contract table in [migration.md](migration.md).

Security posture: **open on the LAN by default** (ComfyUI-consistent; a deliberate 2026-09-10 decision), token-gated via `--token` / `MINIMAX_LAN_TOKEN=1` for hostile networks. Input validation everywhere: path containment (`relative()`-based), numeric FFmpeg arguments (concat-directive injection guarded), MIME allowlists and size caps on uploads, SSRF guard on probe-able URLs.

## Generation pipeline

1. Compose effective prompt (`composeH3Prompt`, dialogue/movement/clothing policies)
2. Reference media already uploaded at selection time (`comfy-input:` refs) or resolved from outputs
3. Build the official ComfyUI graph (`src/lib/workflow.ts` et al.), submit via `prompt`
4. Track: WebSocket progress (same-machine) or SSE (remote) + history polling through the shared poll kernel (`src/lib/promptWatch.ts` — tolerance, deadline, cancellation)
5. On completion: attribute the output by the **exact filename ComfyUI reported** (`extractOutputFile` + `outputs/resolve`) — never newest-file-on-disk; resolve locally when possible, stream via the proxy otherwise
6. Post-processing: optional LTX latent 2× upscale; library/queue persistence

Job state transitions live in the pure reducer `src/lib/jobReducer.ts` (terminal-state guards, no-output cap, deadline), unit-tested in `scripts/test-workflows.cjs`.

## Optimization registry

`src/lib/graph/` formalizes the graph factory: the builders in `src/lib/workflow.ts` remain deterministic pure functions with stable numeric node ids (now centralized in `graph/ids.ts` as the `H3` table — the ids are public contract: tests, output attribution, and manifests reference them), while every optimization that can alter a graph became a registry ENTRY — data, not code paths. Today: the turbo LoRA loader (node '5'), the H3 live-preview override ('7'), and the post-process branches (LTX latent 2× at 60s–70s, RTX pixel 2× at 80s, LBH hires-fix at 90s).

**Entry schema** (`graph/types.ts`, `OptimizationEntry`): `{ id, label, kind: 'turbo' | 'acceleration' | 'upscale' | 'preview', appliesTo, wraps, patterns?, detect(info, files) → { available, model?, missingNodes?, packs? }, transform(graph, ctx, opts), pairing? { sampler, scheduler, samplerNode?, steps }, ui { description, warning?, installHint? } }`. Entries live in `graph/turbo.ts` (official 8/4, lightx2v 4/8-step FL2V + Ref2VA, drbaph 4-step, alibaba-pai PDD 8-step, plus the `turbo.generic` plain-loader fallback), `graph/upscale.ts`, `graph/preview.ts`; `graph/registry.ts` assembles, exposes detection/provenance/plan resolution, and `registerOptimization()` for runtime registration.

**Two contracts make this safe:**

1. **Insert-only.** Transforms append nodes at a declared factory seam (`wraps: 'modelChain' | 'output' | …`) through a `GraphContext` — a role-addressed node map (`ctx.link('samplerSelect')`, never the raw id `'13'`) with `wrapModel()` enforcing the model chain. A transform never rewrites a node it did not create.
2. **Inertness.** When an entry is not selected, the produced graph must be deep-equal to the pre-registry graph. `scripts/test-registry.cjs` proves this per build against `scripts/fixtures/registry-golden.json` — golden snapshots of `buildMiniMaxWorkflow` output over the matrix in `scripts/lib/registry-matrix.cjs` (captured from the pre-registry builder; regenerate deliberately with `node scripts/test-registry.cjs --update-golden` and review the diff, the fixture IS the contract). The same suite proves **painless expansion**: a hypothetical turbo family registered in test data detects, transforms, enforces its pairing, and stays inert — zero factory changes.

**Adding a method** (e.g. a new turbo family or SeedVR2 upscale): add one entry to the relevant `graph/*.ts` module — filename patterns for detection, the pairing contract (steps/sampler; `samplerNode` swaps KSamplerSelect for a dedicated pack node like larryvrh's `MiniMaxH3TurboSampler` when object_info shows it installed), and the transform. The UI surfaces detected families automatically (`detectOptimizations(info, models)` gates availability with the entry's `installHint`); model selection ranks through `turboLoraPatterns()` (official first, lightx2v newest-first, an explicit `turboFamily` workspace choice constrains to one entry). The loader choice (`auto` = dedicated pack nodes when installed / `plain` = stock `LoraLoaderModelOnly`) rides `GenerationOptions.turboLoader`.

`pnpm test:registry` runs the suite; it is part of `test:all`.

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
pnpm test:registry  # optimization registry: inertness goldens, transforms, detection, pairing, expansion
pnpm smoke:server   # boots the built server on a scratch port; verifies routes + guards
pnpm test:e2e       # builds, then Playwright: 14-view render sweep at 1920x1080
                    # with console-error tracking + per-view vision screenshots
pnpm test:vision    # vision phase 1 (capture): screenshot bundle + rubrics under
                    # test-results/vision/<run-id>/ — judging is a subagent step
                    # (scripts/vision-e2e/JUDGE.md), then `pnpm vision:report`
pnpm test:all       # unit + E2E + smoke + vision capture
pnpm gate           # the full chain through one harness: typecheck, lint, unit
                    # suites, build, smoke, e2e, vision capture — timed, noise-
                    # filtered, one summary table (see README → Testing)
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, unit, build, smoke, E2E
and the vision capture on every push and PR (no browser downloads — the
Playwright config launches the runner's system Chromium); the Windows Engine
CI leg covers the server build + engine/runtime suites.

## Known debts / follow-ups

- Desktop/mobile generation semantics share builders but duplicate orchestration with drift
- The Create view's primary Generate button and bottom controls are below the fold at 1080p, and six status signals contradict each other on first run — tracked as the UI polish wave (task ipmk4ci) with vision-inspection evidence
