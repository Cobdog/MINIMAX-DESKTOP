# Architecture

> Contributor-oriented overview of MiniMax Studio as a web application. For the migration history, see [migration.md](migration.md). Last verified 2026-09-14 (managed runtime + launch profiles/vendoring/patch tier, optimization registry, LLM layer, QA gate).

## What this is

A standalone Node web server (`server/`) that serves a React SPA (`src/`) and a local API, fronting local services the app does not own: **ComfyUI** (rendering), the **LLM layer** — a llama.cpp server in router mode, with Ollama as the fallback provider when no router is configured (prompt assistance, planning, captioning), and **FFmpeg** (clip operations). Every browser on the network — workstation, phone, tablet — gets the full Studio.

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
   LLM: llama.cpp router          (frames/trim/join)
   or Ollama :11434

  any browser ── http://workstation:4178 ──► full Studio
                 ?mobile=1 ───────────────► touch companion
```

Two modules:

| Module | Role |
|---|---|
| `server/core.ts` | `createStudioServer(paths)` factory: settings persistence (atomic write-then-rename), model scanning, ComfyUI proxy, the LLM layer (llama.cpp router provider with Ollama fallback — model listing with family/vision detection, generation, fragment store, vision captioning, pre-generation unload choreography), GPU telemetry, FFmpeg operations, output resolution, the full route table, static hosting. Zero Electron imports; everything path-parameterized |
| `server/index.ts` | Standalone entry: resolves config home (`MINIMAX_STUDIO_HOME`, default `~/.minimax-studio`), serves `dist/`, listens on 4178 (`MINIMAX_LAN_PORT`) |

**Managed engine runtime** (increment 1 of the self-managed ComfyUI work): `server/runtime.ts` (`RuntimeManager`) can launch and supervise the app's own ComfyUI from a checkout the user nominates, on top of the wave-2c `EngineProcess` supervision contract. Ports allocate from 8191 up, hard-clear of the user's live instances (8188/8189); `extra_model_paths.yaml` is generated into the checkout from the configured model roots (weights are never copied — the same indexing-in-place rule as the scanner); boot reconcile adopts a healthy recorded instance instead of double-spawning; a stop is graceful-then-tree-killed and always resolves. External mode (the default) is byte-for-byte the pre-runtime behavior — nothing spawns, polls, or re-points unless the user switches the mode in Settings.

**Increment 2 adds the launch/extension machinery around that runtime:**

- **Launch profiles** (`server/engineProfiles.ts`, seeded `default` + `vdn`): a profile is pure data — `{ env, hooks, portPolicy }` — resolved at launch; its env is injected into the spawn, its reserved ports widen the allocator skip-list, and its pre-launch hook steps run before the port is taken. The vdn profile carries NO env by default: the upstream `VDN_H3_*` variables are lab/ablation toggles read at runtime by the node, so the profile exposes only the seam a user would set. The active profile is recorded in `runtime-state.json` (boot posture) and in the status payload; stored profiles are validated hard (env-name allowlist minus process-critical vars; unknown hook ids dropped).
- **Vendored node packs** (`server/engineNodes.ts`, payload under `vendor/nodes/`): the registry of custom-node packs the managed instance needs. Each entry carries repo URL + pinned revision + an SPDX license verdict and an install mode — `vendor` (shipped in our repo, license-verified permissive; install = code copied + weights LINKED + a studio marker; uninstall = delete folder; revision bump = delete + reinstall at the pin) or `user-fetch` (placed from a local copy the user nominates, for packs whose license forbids redistribution — a repo with no license file is recorded `NO-LICENSE` and can never be vendored). A foreign `custom_nodes/<name>` without our marker is refused, never replaced.
- **Consent patch tier** (`server/enginePatch.ts`): the LongCache-class core-file patcher for MANAGED mode, ported from the maintainer's fork installer discipline — strict-regex layout detect (refuses unrecognized layouts with no file changed), pristine backup refreshed from any unpatched target, same-dir temp+rename atomic writes, structural validation always + real `python ast.parse` when the launch command is python, revert mode, and a `testedComfyVersion` gate (only 0.33.x/0.34.x layouts verified). NO patch runs without an explicit consent record in settings; every refusal degrades (VDN still works — you lose the LongCache tail cache) and is surfaced, never silent.
- **Weight-symlinking invariant** (AC 35m2zvh): the managed instance LINKS weights, never copies them. `extra_model_paths.yaml` references the user's real model roots in place; `linkNeverCopy()` (symlink → junction → hardlink → refuse-with-reason, copy is never the fallback) is the rule for pack-carried weights and for any weight the studio places into a model root.

## The renderer bridge

The SPA never talks to ComfyUI REST directly — it consumes the server's API through `src/lib/apiClient.ts`, which implements the `DesktopApi` interface (`src/types.ts`) over HTTP and installs as `window.minimax` at startup. The interface is the seam that made the Electron→web migration possible: the same 24-method contract the old preload exposed.

Media references flow as strings on `MediaFile.path`:
- `comfy-input:<subfolder>/<name>` — user-picked files, uploaded to ComfyUI's input tree at selection time
- output-contained paths — generated files, resolvable server-side (containment-checked)
- legacy `minimax-media://` URLs from the Electron era are translated by `src/lib/mediaUrls.ts` at playback

The server is authoritative for service URLs, the output directory, and the FFmpeg executable — those bridge arguments are accepted and ignored, so a compromised or buggy renderer cannot redirect them.

## API surface

All routes under `/api/lan/` (legacy prefix retained from the mobile-companion era). Representative routes: `bootstrap`, `settings` (GET/POST), `object-info`, `comfy-status` (SSRF-guarded), `prompt`, `history/{id}`, `cancel`, `events` (SSE⇄WS bridge), `ollama` + `ollama/structured` (fallback provider), `llm/{models,generate,prepare,vision,fragments}` (the LLM layer: router-primary provider selection, model-family manifests, layered prompt fragments, vision captioning), `engine/{status,start,stop}` (the managed runtime; start is refused outside managed mode and is idempotent — a repeated start never double-spawns), `video/{frame,frames,trim,join}`, `outputs/{resolve,save-image}`, `upload` / `upload-media` / `upload-output`, `media` (ComfyUI proxy or output-contained local serving with Range), `telemetry`, `characters`. Full contract table in [migration.md](migration.md).

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

**Weights referenced by registry entries are LINKED, never copied (invariant, AC 35m2zvh):** the model files an entry detects or installs (turbo LoRAs, VDN branch checkpoints, pack-carried tensors like `h3_silu_temb_grid.safetensors`) exist exactly once on disk — in the user's real model roots or the vendored payload — and every other reference is a link (`server/engineNodes.ts` → `linkNeverCopy()`: symlink → junction → hardlink → refuse with a reason; a byte-for-byte copy is never the fallback). The scanner and `extra_model_paths.yaml` mirroring already index the user's roots in place; this extends the same no-duplicate-bytes rule to everything the studio itself places.

`pnpm test:registry` runs the suite; it is part of `test:all`.

## Renderer structure

`src/App.tsx` (~630 lines) is the composition shell — hook wiring, view routing, and handoffs between workspaces. The domain logic is layered so each feature lands in exactly one place:

| Layer | Modules | What lives there |
| --- | --- | --- |
| `src/views/` | `CreateView`, `LibraryView`, `JobsView`, `SettingsView` | One component per nav destination + its private helpers (reference pickers, strips, modals) |
| `src/hooks/` | `useStudioSession` | Settings load, model scanning, ComfyUI connection/object-info, LLM model list (router/Ollama), GPU telemetry |
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

## Third-party components & the user-fetch pattern

The full inventory (SPDX per component, consumption class, obligations) lives
in [LICENSES.md](LICENSES.md); the policy rationale and fork lineage in
[PROVENANCE.md](PROVENANCE.md). This section is the builder-facing rule: what
the pattern IS, because every future component integration must follow it.
Implementation: `server/engineNodes.ts` (registry + install machinery),
`server/enginePatch.ts` (consent patch tier), Settings → Node packs /
Managed engine (UI).

**The license gate (absolute, and machine-checked):**

- Only permissive-licensed code (Apache-2.0 / MIT / ISC-class) may be
  **vendored** into `vendor/nodes/`, at a pinned revision, with the LICENSE
  file shipped in the tree.
- **NO-LICENSE** (all-rights-reserved by default) and **GPL-family**
  components are **never vendored** — GPL-3.0 would be combining-compatible
  with our AGPLv3, but vendoring third-party GPL code couples our releases to
  contributor sets we don't control; policy is pattern-adopt / re-implement,
  install via user-fetch only. `pnpm license:audit` (gate + CI) fails the
  build if a non-permissive registry entry is `installMode: 'vendor'`.

**User-fetch flow (what a builder must preserve):**

1. **Registry entry first.** Every pack the managed runtime can install is a
   `NodePackDefinition` in `ENGINE_NODE_PACKS` with an explicit `licenseSpdx`
   verdict (recorded in the entry's comment when non-obvious), a pinned
   revision, and an `installMode`. No pack reaches an install path except
   through the registry.
2. **Consent.** Nothing is installed without the user acting: today the user
   nominates a local directory holding the pack (the network
   clone-on-consent fetcher is a later increment); then confirms. The
   Settings row shows the SPDX badge at consent time — NO-LICENSE renders
   with a warning class.
3. **Weights link, never copy.** Pack-carried weight files and any weight the
   studio places into a model root go through `linkNeverCopy()`
   (symlink → junction → hardlink → refuse with a reason). A copy is never
   the fallback; a refused link fails the install (staged-then-rename, so no
   half pack survives).
4. **Pin recording.** The install marker (`.studio-node.json`) records id +
   pinned revision; a registry pin bump is a delete-and-reinstall, never a
   merge. A foreign `custom_nodes/<name>` the studio did not place is
   refused, never silently replaced. (Known gap: the facok entry's pin is the
   `main` branch — the network fetcher must stamp the fetched HEAD SHA.)
5. **Uninstall = delete the folder.** Marker-only installs never touch
   anything outside `custom_nodes/<name>`; linked weights in model roots are
   links — removing the pack leaves the user's own files alone.

**Consent patches (core-file tier).** The one class of optimization that
cannot ride the `custom_nodes/` seam — a core-file hook — lives in
`server/enginePatch.ts` under stricter rules: nothing applies unless
`settings.engine.patches[id].consented` is true (the RuntimeManager hook
path is the only production caller); layout-detect refuses unknown layouts;
ast/structural validation before commit; atomic write; pristine backup with
revert. We never ship pre-applied patches — the patcher runs user-locally
only (distribution analysis in LICENSES.md §8).

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
pnpm gate           # the full chain through one harness: typecheck, lint,
                    # license:audit, unit suites, build, smoke, e2e, vision
                    # capture — timed, noise-filtered, one summary table
                    # (see README → Testing)
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, the license audit,
unit, build, smoke, E2E and the vision capture on every push and PR
(no browser downloads — the Playwright config launches the runner's system
Chromium); the Windows Engine CI leg covers the server build + engine/runtime
suites.

## Known debts / follow-ups

- Desktop/mobile generation semantics share builders but duplicate orchestration with drift
- ~~The Create view's primary Generate button and bottom controls are below the fold at 1080p, and six status signals contradict each other on first run — tracked as the UI polish wave (task ipmk4ci) with vision-inspection evidence~~ [Resolved 2026-09-11: UI polish waves 1 (ipmk4ci) and 2 (vuubsmh) shipped]
