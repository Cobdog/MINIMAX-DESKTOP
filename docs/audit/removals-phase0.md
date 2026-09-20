# Phase 0 removals — the manifest (task z8bc21p, 2026-09-20)

> What died, why (dated calls with usage evidence), and where each item lives
> in git history. **Restore point for everything in this file: the commit
> immediately before the Phase-0 removal commits** — `7ee1e3c` at authoring
> time (the worktree's fork base). "Fully removed" means the runtime app
> carries none of it: no imports, no menu rows, no settings surfaces, no
> engine paths, no CSS.

## 1. LTX — entirely removed (AC-1)

The keep-utilities-only verdict (docs/research/ltx-vs-h3-verdict.md) is
superseded by the maintainer's Phase-0 directive: LTX goes, git history is the
archive, and anything wanted back returns through a deliberate re-add.

| What | Restore path (at `7ee1e3c`) |
|---|---|
| LTX-2.3 one-graph utilities (six official-template tools) | `src/lib/graph/ltx23.ts` (840 lines) |
| LTX-2.3 submit core + validation | `src/lib/ltx23UtilitySubmit.ts` |
| LTX-2.5 general engine submit + node contract | `src/lib/ltx25Submit.ts` |
| LTX-2.5 workflow builder + sigma schedules | `src/lib/ltx25Workflow.ts` |
| The missing-deps → fetch-catalog deep link | `src/lib/fetchDeepLink.ts` (LTX-only mapping) |
| LTX-2.3 test matrix + goldens | `scripts/lib/ltx23-matrix.cjs`, `scripts/fixtures/ltx23-golden.json` |
| Canvas engine-op paths | store.ts's `engine: 'ltx25'` submit/validate branches, the `produce:ltx25` typed-hole row + `action.kind: 'ltx25'` chain creation (options.ts/store.ts), the ltx23 utility actions, the `__canvasUtilityPlan` probe |
| Settings surfaces | SettingsView's LTX-2.3 run row (detect + pick-input + run), SettingsDock's `runLtxUtility` wiring, the `ltx25`/`ltx23` model-override families (modelOverrides.ts), the Settings default-upscale LTX option |
| Upscale mode `'ltx'` | `UpscaleMode` union member; `upscale.ltx2x` registry entry + `applyLtx2x` + `ltxDetect` (graph/upscale.ts); graph ids 60–70 (ltxPadTail…ltxSaveVideo, graph/ids.ts); h3Submit validation branches; OpEditor option; ForkMenu preset (now `rtx`); ops default (now `rtx`); server core's `ltxUpscaleRequiredNodes`/`ltxNativeRequiredNodes` + bootstrap payload fields (`ltxModel`/`ltxVae`/`ltxUpscaleReady`/`ltxNativeReady`…) |
| Node packs | `ltxvideo` / `kjnodes` / `radiance` ENGINE_NODE_PACKS entries + their `nodePackEntry()` catalog rows (kjnodes/radiance were LTX-only by usage: KJNODES_USED/Float32ColorCorrect had no non-LTX importer) |
| Fetch catalog | the 14 `ltx23-*` weight entries stay in `server/fetchCatalog.ts` as HISTORY — each marked `removedAt: '2026-09-20'`, filtered from the served catalog (`catalogStatus`) and refused at fetch start; on-disk install records still resolve their entry ids |
| LLM fragments | `factory:output_format:family:ltx25` + `…:zimage` rows (server/llm/fragments.ts) |
| Types | `Ltx25ModelSelection`, `Ltx25GenerationOptions`, `Ltx23ModelSelection`, `inferLtx25Selections`, `inferLtx23Selections`, EngineId `'ltx25'`/`'zimage'` members, manifest provider `'ltx25'` |

Old persisted data is tolerated, never crashed on: chains with a stored
`upscaleMode: 'ltx'` coerce to `'off'` (generation.ts) / `'rtx'` (ops.ts),
stored `engine: 'ltx25'` coerces to `'h3'`, jobs carrying provider
`'ltx25'`/`'ltx23'`/`'zimage'` render their raw string.

## 2. Z-Image — entirely removed (AC-2)

`src/lib/zimage.ts` (the Comfy-Org Z-Image turbo/base graph builder) is
deleted. Its importers were exactly the five asset Studios and the mobile
companion (both removed below) — after the Phase-0 cuts the module had zero
importers. The earlier reroute (lib/zImageSubmit.ts, deleted 2026-09-19) had
already moved the image workbench to H3-1F/Krea 2; `RenderSize`'s `zimage`
provider arm and the `zimage` engine-union members went with it.

## 3. The original-build cruft survey (AC-3)

The map was the PROVENANCE final-diff statement (docs/PROVENANCE.md — the
~3.8% upstream residue). Dated call per item, with the usage evidence that
drove it:

### Removed — upstream surfaces the current app does not need

| Item | Evidence | Restore path |
|---|---|---|
| `src/MobileApp.tsx` — the `?mobile=1` companion route | The largest single inherited module (388 upstream-retained lines). Reachable ONLY via the lazy `?mobile=1` split in main.tsx; marked unmaintained (L10); the maintainer's day never touched it. Its only server surface (the `/api/lan/characters` sync + `syncCharacters` bridge) existed solely for it — both removed; the §6 legacy import's character arm stays reachable through `/api/lan/documents/import/legacy` (re-pointed documents test). | `src/MobileApp.tsx`, main.tsx route block |
| The five asset Studios (Characters/Hair/Wardrobe/Accessories/Locations) + `StudiosDock` + `ReferenceApprovalModal` + `contactSheetSubmit` + `locationWalkthrough` | Upstream original-build UIs (PROVENANCE residue item 2) whose authoring flows the maintainer never used. Their libraries remain readable (see the keep list) — assets are still creatable through the documents API (the e2e bind test posts one directly). The dock existed as a Phase-5 holding pen pending "Phase 6 macro work"; Phase 0 supersedes that plan. | the five `src/components/*Studio.tsx`, `src/canvas/StudiosDock.tsx`, `src/components/ReferenceApprovalModal.tsx`, `src/lib/contactSheetSubmit.ts`, `src/lib/locationWalkthrough.ts` |
| `RenderSize.tsx`, `ImageCrop.tsx`, `RenderConstruction.tsx` (the mobile/Studios modals) | Importer census after the cuts: RenderSize — MobileApp only; ImageCrop-the-component and RenderConstruction — MobileApp + the Studios only. (NOTE: `src/lib/imageCrop.ts` the LIBRARY stays — it is load-bearing for h3Submit/images-submit/promptComposer, and was restored when the typecheck caught the over-reach.) | `src/components/{RenderSize,ImageCrop,RenderConstruction}.tsx` |
| `src/guided-studio.css` | The five-Studios stylesheet (location-builder/character-candidate/wardrobe/accessory/character-survey class families) — zero class consumers after the Studios died. | `src/guided-studio.css` |
| `scripts/smoke-generation.cjs` | Upstream-verbatim (63 lines), drives `buildZImage` + buildMiniMaxWorkflow against `127.0.0.1:8188` — the MAINTAINER'S personal engine, off-limits by policy. Referenced by nothing in the gate (package.json's `smoke:server` is `smoke-server.cjs`, a different script). | `scripts/smoke-generation.cjs` |
| The dead-CSS stratum of `src/styles.css` | 273.8 KB → 59.8 KB: every rule whose selectors reference a class with no remaining consumer across src/server/e2e/tests/scripts/benchmarks/public (447 class families: the old shell's views, MoviePlanner, the mobile companion, the zimage workspace, the Studios, the ltx rows, the pre-canvas music3/ace surfaces…). Method: class-token census → postcss selector strip → stylelint. The live design language (root vars, shared controls, current surfaces' rules) is untouched; canvas.css/workbench.css were never touched. | `git show 7ee1e3c:src/styles.css` |

### Kept (dated calls — ambiguous stays; the remediation plan can kill them)

- **The five `*Library.ts` modules + the canvas asset spine** (`refreshLibraries`/`syncLibraryAssets`/`bindGlobalAsset`/`refreshAssets`, the `canvas_asset` + `canvas_asset_fork` tables, promptComposer's library arms, jobRecords' character/location write-backs, EngineHost's library events). Current-architecture canvas Phase-4 surface, spec'd in canvas-ui-v1 §2/§6, with its own API path (the e2e bind test drives it without any Studio). With the Studios gone nothing in the UI authors library content — the spine is the natural re-attachment point when asset authoring is redesigned; killing it is a product decision (and touches the document schema + archive machinery) beyond "remove what was inherited".
- **`imageCrop.ts`** — load-bearing for the CURRENT submit paths (prepareImage in h3Submit/images-submit, fitWholeCharacter in promptComposer).
- **The prompt machinery** (promptComposer/promptPresets/dialogPolicy/SmartPromptEditor/StructuredPromptEditor) — the canvas PropertiesPanel and generation.ts are live consumers.
- **`workflow.ts`/modelSelection/modelOverrides/useLivePreview/comfyInfo/createId/aceStepWorkflow** — aux builders with current importers (audio engines must keep working; the verification bar says so).

## 3b. Registry-only model source — surface removed, internals queued (directive 2987ef3e)

The maintainer's model-detection directive landed mid-flight and cascaded into
this survey. THIS pass removes the user surface; the internal scan/merge
simplification is queued for the remediation build (ripping the scan out
wholesale would break the vitest suites that boot scratch servers with local
homes — the registry-only inventory gets built and tested as one piece there).

Removed from the surface (restore at `7ee1e3c`):
- The six hand-typed model-path input rows — Settings' "Model locations"
  section is now a read-only **"Model inventory"** (per-kind file counts +
  a "Refresh from engine" button; the engine's own registry is the stated
  source of truth).
- The local-scan-first defaults: the six scanner paths now default to `''`
  (no app-internal `<documents>/ComfyUI/models/...` root nobody populated —
  Audit A's finding). `modelRoot` remains as the FETCH-DESTINATION root;
  `fetchModelRootPath` now treats an empty scanner path as unset (falls back
  to modelRoot — never resolves against the CWD).
- The first-run onboarding card's "point Settings at folders" copy and its
  "Open settings — model locations" deep link — now "No models visible…",
  deep-linking to the engine connection section.

Queued for the remediation build (surveyed, deliberately not ripped): the
local/both source tagging in the merged inventory, the scan-anchored
validation legs of the model-override layer (scan-anchoring exists to verify
picks against files the ENGINE must load — under registry-only it re-anchors
to the instance listing), the local scan in `/api/lan/bootstrap`, the
`extra_model_paths.yaml` mirror for managed engines, and the legacy
`instanceInventory` merge machinery.



- `tests/workflows.test.js`: the LTX-2.5 workflow matrix, the LTX-2.3 utility inference test, and the Z-Image graph test are gone; the H3-across-modes test's upscale arm switched ltx→rtx; override fixtures neutralized to non-LTX filenames (the generic machinery assertions kept verbatim).
- `tests/registry.test.js`: sections (g1)–(g6) (the LTX-2.3 registry shape/goldens/census/pins/wiring/validation/gating) gone; `upscale.ltx2x` dropped from the required-id list and detection probes; the golden fixture regenerated deliberately (`MINIMAX_UPDATE_GOLDEN=1 vitest run registry` — the 12 `ltx-*` matrix rows are now `upscale-*` RTX rows; reviewed: only the upscale block differs).
- `tests/canvas.test.js`: the (n2) fetch-deep-link mapping test, the (t) LTX-2.3 ladder, the (v) LocationStudio walkthrough, the (w) ltx25 ladder arm, and the (x) contact-sheet core test are gone (each module deleted).
- `tests/instance.test.js` / `tests/fetcher.test.js` / `tests/documents.test.js`: pack-id fixtures re-pointed to surviving packs (autocontext / krea2-controlnet / krea2-anypaint / h3-audio-t8); the ltx25/ltx23 legacy-normalization arms dropped; the catalog-count assertion now excludes `removedAt` history rows; the §6 character-import seeding re-pointed to the explicit documents import route (the auto-import no longer pre-runs for that route — a one-line ordering fix so the explicit non-force call is not a no-op).
- e2e: the LTX-2.3 utility probe test, both mobile companion tests, the Studios dock handoff test, and the app-level Studios/mobile capture steps are gone; the engines-as-ops test keeps the audio docks; node-pack badge fixtures re-pointed at surviving packs. 104 → 99 tests.
- Vision: rubrics amended (titlebar/chip/family lists, the dock cascade is two docks, the outdated-badge fixture moved from radiance to ComfyUI-MiniMax-H3-Turbo); scenario count unchanged.

## 5. Verification (AC-4)

All numbers are on the final merged tree (Phase-0 commits + main's tmz8vh7
critical fixes merged in — the merge resolution keeps the T=1 decoder-class
routing and drops its ltx25/ltx23 loop arms).

- `pnpm typecheck` / `pnpm lint` / `pnpm license:audit` / `pnpm build` — green.
- `pnpm test` — 19 files, 243 passed, 2 NOTE-skips.
- `pnpm smoke:server` — green.
- `pnpm test:e2e` — 101 passed (the merged tree carries main's two new
  tests), including the fake-engine end-to-end proofs: H3-1F renders through
  the fake engine and lands its take, image+control hands off to the
  workbench Edit surface, a structured submit lands a real job whose engine
  prompt is the composed bytes, audio docks gate honestly, F6 live progress
  surfaces on the generating tile. (The datasets caption-editor aspect-chip
  flake is the documented shared-home accumulation — testing.md — cleaned
  through the app's own trash API both times it surfaced locally; CI's fresh
  homes never see it.)
- `pnpm test:vision` — bundle `20260920-195058-621784-06dm`, judged 29/30
  PASS with one FAIL arbitrated as a judge misread: the timeline gap-menu's
  "Hard cut" verdict was read as "9.6 dB"; the code constant (plan.ts:55)
  says 9.8, no 9.6 exists anywhere in src, and an independent zoomed pixel
  re-read of the screenshot confirms 9.8 — the documented small-dark-text
  misread class (the same class that motivated the DOM-truth assertions in
  twmpu4m). Every Phase-0 surface change verified visually: no studios
  button/chip, no LTX override families, the registry-only inventory row
  with no path inputs, the two-dock cascade, the amended first-run card.
- CI (PR #33): Engine CI (Windows) green; the ubuntu leg green after the
  fixture-path follow-up (one missed readFileSync still naming the removed
  radiance pack folder).
