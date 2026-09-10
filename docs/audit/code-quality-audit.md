# Code-Quality Audit — MINIMAX-DESKTOP (Cobdog fork)

> Automated adversarial review, 2026-09-09, at `18fe989`. Full read of all 43 TS/TSX files (~7,490 lines), electron main/preload, scripts, configs. Read-only. Verification gap: `node_modules` not installed in the audit environment, so `pnpm typecheck`/`pnpm lint` were not executed; type-safety claims are from reading tsconfigs and source, not a compiler run.

---

## Verdict

This is a **serious hobby project with unusually good hygiene on the cold paths and genuinely dangerous behavior on the warm ones**. The parts that are easiest to get wrong — TypeScript strictness (zero `any`, zero `@ts-ignore` across 7.5K lines), Electron hardening (contextIsolation, protocol confinement, token-gated LAN, upload caps), defensive normalization of external ComfyUI/Ollama/LLM data, and the MoviePlanner's AI-revision review flow with optimistic concurrency and undo — are done better than most professional codebases manage. The parts that are hard to get right — the generate→poll→attribute→download pipeline, library persistence, and failure surfacing — are held together by heuristics and swallowed errors. The single deepest flaw is that **completed outputs are attributed to jobs by filesystem timestamp rather than by the exact filename ComfyUI already reports**, and that heuristic feeds a path that *destructively overwrites user-curated character reference sets*. Combined with a localStorage quota bomb in the marquee Character Studio flow and a 1,961-line App.tsx that concentrates 31 `useState` hooks and all orchestration, the app is reliable exactly until a user runs two things at once or approves a few images. It is a prototype in the places a prototype can't afford to be one.

---

## Strengths (genuine, verified)

1. **Type discipline is real.** `strict: true` in both `/tsconfig.json:10` and `/tsconfig.electron.json`; grep found **zero** `any`, `as any`, `@ts-ignore`, or `@ts-expect-error`. Non-null assertions are rare and guarded (e.g. `wardrobe!` behind a `wardrobeCount > 0` check, App.tsx:1829). External responses are not trusted: `extractOutputUrl` (workflow.ts:181-212) and `historyOutput` (main.ts:325-339) walk history with `typeof` checks; `normalizePlan`/`applyMovieChatOperations` (MoviePlanner.tsx:507-583) validate every LLM-produced field with `text()`/`clamp`/enum membership before use.
2. **A real unit test exists** — `scripts/test-workflows.cjs` (157 lines) asserts graph shape for all three providers, verifies **every node link resolves to a defined node** (a broken workflow edit fails CI-style), and tests frame-count modular arithmetic and crop-rect bounds. It is, however, wired to nothing (see Weaknesses).
3. **Workflow builders mirror official ComfyUI templates with load-bearing comments** — the dotted-key `ResizeImageMaskNode` gotcha (ltx25Workflow.ts:21-24), the 8n+1 LTX VAE padding math (workflow.ts:148-153), forced-official sampler with legacy migration (workflow.ts:7-11, App.tsx:173-180).
4. **MoviePlanner's copilot revision flow is the best-engineered code in the repo**: stale-proposal detection via `baseUpdatedAt` (MoviePlanner.tsx:302-307), field-level diffs, destructive-change confirmation gating, structuredClone undo snapshots with an explicit quota-failure notice (149-153). This is the exact discipline missing from the generation pipeline.
5. **Cancellation is handled through race windows**, not just happy paths: checked after upload, after submit, and post-submit with a follow-up `/interrupt` (App.tsx:1004-1010, 1160, 1186-1189).
6. **Electron/LAN security posture above hobby norm**: contextIsolation + no nodeIntegration (main.ts:524-528), `minimax-media://comfy` confined to the configured origin and `/view` path (main.ts:545-547), token-gated LAN API with rotation, 36-180MB body caps, MIME allowlists, filename traversal rejection (main.ts:343), Range-request support in the media proxy.

---

## Weaknesses, ranked

### P0 — correctness / data loss

**P0-1. Completed outputs are attributed by filesystem timestamp, and the wrong file destructively overwrites character/location libraries.**
`findLatestMedia` (main.ts:223-245) scans the entire output tree for *any* video with `mtime >= since - 5000`, newest wins. `App.tsx:587` calls it with `job.createdAt` — **not** the exact filename ComfyUI history already provided (which `extractOutputUrl` uses correctly for playback). The heuristic result is then *preferred* over the exact URL for library writes: `recordCharacterTurntable(job.characterProjectId, localOutput ?? outputUrl)` (App.tsx:590, 593).
*Failure scenario:* queue a character turntable and any second render (the H3 diagnostic explicitly queues two back-to-back, App.tsx:1216-1219). When job A completes, the newest file in the tree is job B's output → B's video becomes A's turntable → "Split into 5 angles" (CharacterStudio.tsx:207-220) extracts frames of the *wrong subject* and `patch({ referenceImages: extracted })` **replaces the character's curated identity reference set** — persisted, silent, and poisoning every subsequent Reference render. Any unrelated mp4 saved into the output folder during the job window has the same effect. Fix is cheap: history already contains the exact `filename`; resolve `localOutputPath` from it.

**P0-2. Character identity approval persists multi-megabyte data-URL previews into localStorage; quota exhaustion throws inside a setState updater and crashes the whole app.**
`getOutputImage` returns a full-resolution base64 PNG (main.ts:634). Identity candidates carry it as `.preview` (CharacterStudio.tsx:166, 198), and approval merges those files straight into the library: `patchProject(active.id, { baseImage: chosen[0], referenceImages: references ... })` (CharacterStudio.tsx:239-240; single-master path equally, :230). `saveCharacterProjects` has **no try/catch** (characterLibrary.ts:26), and it is called *inside* the `setProjects` updater (CharacterStudio.tsx:70-74). A 768×1024 PNG is typically 1-2MB → ~1.3-2.7MB of base64; approving the flagship "Generate 4 candidates" set writes 4+ of them. Chromium's ~10MB quota (UTF-16 accounting makes it worse) is realistically exceeded on the first or second approval.
*Failure scenario:* when quota is hit, `setItem` throws during React's render phase; there is no error boundary anywhere in `src` → React 18 unmounts the entire root → **white screen, approval lost, nothing saved**. The workspace persistence path strips previews via `withoutPreview` (App.tsx:190-195) — the character library path simply forgot. (Bonus: the updater side effect also double-fires under StrictMode dev.)

### P1 — robustness

**P1-1. The desktop poll loop swallows all errors and has no timeout, so a dead ComfyUI leaves jobs "running" forever.** `getHistory(...).catch(() => undefined)` (App.tsx:609), interval every 1s with no attempt cap or staleness detection; no fetch timeout in `comfyFetch` (main.ts:251-259; undici's ~300s default is the only bound, while new polls keep stacking). *When ComfyUI is killed mid-render, the Queue shows "Rendering locally" indefinitely and the only hint is the preview label flipping to "Connecting to ComfyUI…".* Inverted flaw in the Z-Image/Character polls: **one** transient `getHistory` failure aborts the watch entirely (ZImageWorkspace.tsx:111-114, CharacterStudio.tsx:175-178, 202) — *a single network hiccup marks a still-rendering image as failed*. Two polling implementations, both fragile in opposite directions.

**P1-2. One unreadable file kills the entire model scan, silently.** In `scanDirectory`, `await stat(fullPath)` sits *outside* the try that guards `readdir` (main.ts:215; same in `findLatestMedia`, :239). *When any file in a model folder returns EACCES, `models:scan` rejects → unhandled rejection → `models` stays `[]` → "Models incomplete", generation blocked, zero user-visible error.*

**P1-3. Settings writes are non-atomic.** `saveSettings` writes JSON directly to `settings.json` (main.ts:192-196); `loadSettings` catches parse failure by silently returning defaults (187-189). *A crash or power loss mid-write wipes every configured path, URL, and default on next launch — with no message.* Same pattern for the LAN token (harmless there).

**P1-4. The LAN "Full Studio address" is a mock-data shell.** The LAN server serves the same SPA bundle (main.ts:445-454); in any browser `window.minimax` is absent so `installBrowserMock()` (main.tsx:9) installs a fake bridge with hardcoded `C:\Users\James\...` settings, fake GPU telemetry, and a fake model list (browserMock.ts:3-24, 71-77). `App` has no LAN API awareness whatsoever. *When a tablet user opens the advertised "complete Studio interface" (App.tsx:1485), they see a studio that looks populated but can never generate — `submitPrompt` throws "Desktop bridge is unavailable in browser preview."* `smoke:lan` only asserts the HTML shell returns 200, so this is invisible to the smoke test.

**P1-5. Stale poll responses resurrect terminal jobs.** The poll's else-branch sets `status: 'running'` with no current-status guard (App.tsx:606-608). *When a slow in-flight history response resolves after a faster one completed the job, the completed (or failed) job flips back to "running," polling resumes, side effects (`findLatestOutput`, reference extraction) re-fire, and if ComfyUI's history was cleared in between, the job polls forever.* One-line fix: only mutate jobs still in `['queued','running']`.

**P1-6. "Completed but no output" jobs spin at 98% forever** (App.tsx:598-605), calling `findLatestOutput` every second with no cap — *when the output node id or extension doesn't match expectations, the job never terminates and the user is never told why.*

**P1-7. `Ltx25Workspace.refine` has try/finally with no catch** (Ltx25Workspace.tsx:80-88), invoked as `void refine()` (:106). *When Ollama errors, the spinner stops and nothing happens — no notice, no message; unhandled rejection in console.* Every sibling (ZImageWorkspace.enhance:165-174, CharacterStudio.enhance:101-110) catches and surfaces; this one was missed.

**P1-8. Standalone reference images can be silently dropped.** The "library assets authoritative" effect rebuilds `referenceImages` from bindings only and replaces the array wholesale (App.tsx:703-709); the either-or invariant (library vs standalone files) is enforced only at UI entry points (chooseMany clears selections, App.tsx:648). *When a persisted workspace contains both (restored by `readWorkspace`), the next library change event deletes the standalone pictures without a word.*

### P2 — maintainability / latent correctness

- **App.tsx is a genuine God component**: `App()` alone holds **31 `useState`**, 22 `useEffect` lines, 19 useCallback/useMemo/useRef lines and ~20 handlers (lines 340-1476, ~1,136 lines); the file additionally contains CreateView (227 lines with its own logic), SettingsView, LibraryView, JobsView, and ~15 helpers. The 33-item dependency array on the workspace-persistence effect (App.tsx:554) is a change-detector in itself.
- **The lib/components boundary is real but leaky.** `src/lib` legitimately holds the pure, testable domain core (workflow builders, prompt composition) — but App.tsx keeps real domain logic (`composeH3Prompt`, `syncReferencePrompt`, `recordMovieOutput`, `h3StackReport`, `extractAutomatedReferenceSet`, App.tsx:213-338), while `lib` reaches into localStorage and dispatches window events (`promptComposer.ts` calls `loadAccessoryProjects`/`loadHairStyleProjects` — synchronously, from render paths: CreateView invokes `allocateWorkspaceReferences` in render body, App.tsx:1573, and per smart-option, :1620-1627).
- **MobileApp duplicates desktop generation semantics with drift**: shares the workflow builders (good) but re-implements orchestration, model-inference wiring, and prompt policy — mobile never applies `applyNaturalMovementPolicy` (desktop default-on), and clothing policy uses a parallel enum (`'assigned'` vs `'wardrobe'`) maintained by hand (MobileApp.tsx:289-293 vs App.tsx:311-329). Notably the mobile poll is *more correct* than desktop (exact history filename, no timestamp heuristic).
- **Regex surgery on user prompts**: `syncReferencePrompt` (App.tsx:292-309) machine-edits prompts with English-only regexes (`from another character\.`, `References:[^\r\n]*`). *When phrasing drifts, instructions duplicate or get mangled silently.*
- **~90% duplication** of `allocateCharacterReferences` / `allocateWorkspaceReferences` (promptComposer.ts); Ollama "local model" filter duplicated with the magic sentinel `item.size !== 342` in two places (main.ts:377, 697); `AppSettings`/`GenerationDefaults` types duplicated between main.ts:14-40 and types.ts:12-38 (identical today, drift inevitable).
- **Windows-only separators inside path guards**: the LAN static-file check `filePath.startsWith(distRoot + '\\')` (main.ts:448) and output-directory confinement `candidate.startsWith(configured + '\\')` (main.ts:564) are always false on POSIX — every asset request serves index.html and all local media 403s. Latent only because packaging is Windows-only.
- **Mobile watch dies on first transient failure** during its up-to-30-minute poll (MobileApp.tsx:301-309) while the desktop keeps rendering; fixed 1800-iteration cap regardless of progress.
- **`streamLanEvents` has no WebSocket 'close' handler** (main.ts:284-311): *when ComfyUI restarts, the mobile SSE stays open but events stop forever — progress freezes with no reconnect.*
- **`app.whenReady().then(async …)` with no catch** (main.ts:536): a throw in `startLanServer` (e.g. token-file write failure) leaves the app running with no window.

### P3 — style / cruft

- `comfy:queue` IPC handler + preload wrapper + type + mock entry have **no caller** anywhere (main.ts:618, preload.ts:16, types.ts:298); `hairStyleReference`/`accessoryReference` are exported and unused; `naturalMovementDirection` exported for internal use only.
- `browserMock.ts` hardcodes `C:\Users\James\...` paths and a canned MoviePlanner conversation, and ships in the production bundle (imported unconditionally, main.tsx:9).
- Z-Image outputs are saved into a folder named **"MiniMax Character References"** (main.ts:646) while the UI claims "Saved to ComfyUI · MiniMax_first_frames" (ZImageWorkspace.tsx:215) — duplicate copies, misleading name.
- `jobs` persisted to localStorage on *every* progress tick — `JSON.stringify` of up to 100 jobs per sampler step (App.tsx:502-504).
- MoviePlanner has an effect with **no dependency array** (MoviePlanner.tsx:236-243) — re-subscribes every render (correct only because of cleanup).
- Library/Movie `<video>` elements without `onError` (App.tsx:1887, MoviePlanner.tsx:480) render silent black tiles for dead output URLs; LAN token persisted in browser localStorage (MobileApp.tsx:34); `plan.md` (528-line historical planning doc) sits at repo root.

---

## Testing

Confirmed: **no test framework, no `test` script in package.json, no CI** (no `.github`). The one genuine asset, `scripts/test-workflows.cjs`, is orphaned — not referenced by any script. Five highest-value targets if tests existed:

1. `syncReferencePrompt` (App.tsx:292) — pure, regression-prone, currently protected by nothing.
2. Job-status reducer extracted from the poll effect — would have caught P1-5/P1-6 as failing tests (stale response, no-output completion).
3. `applyMovieChatOperations` + `normalizePlan` — complex invariants (dangling references, temp-id aliasing) with only mock-script coverage.
4. `allocateWorkspaceReferences` — the 9-picture budget/dedupe invariants.
5. `findLatestMedia`/`scanDirectory` against fixture directories (a fake EACCES file) — would have caught P1-2 and P0-1's attribution ambiguity.

---

## Top 10 fixes by value/effort

1. **Attribute outputs by history filename, not mtime** — thread `filename`/`subfolder` from `extractOutputUrl` into a `outputs:latest` lookup; delete the timestamp heuristic. Kills P0-1. (~1-2h)
2. **Strip data-URL previews before saving any library** — a shared `withoutPreview` in `saveCharacterProjects`/`updateCharacterProject`, plus wrap those `setItem`s in try/catch with an `onNotice` error. Kills P0-2 and its white-screen mode. (<1h)
3. **Guard the poll's else-branch with `['queued','running'].includes(item.status)`** and add a max-poll/staleness deadline with a user-visible failure. Kills P1-5, most of P1-1/P1-6. (~30m)
4. **Wrap `stat()` in scanDirectory/findLatestMedia's existing try** and surface scan failures via notice. Kills P1-2. (10m)
5. **Atomic settings writes** — write `settings.json.tmp`, `rename` into place. Kills P1-3. (~20m)
6. **Move `saveCharacterProjects` out of the setState updater** (and stop dispatching events from updaters). (~30m)
7. **Add `.catch` to `refine`** and the remaining `void`-ed async handlers; adopt one shared "poll with tolerance + deadline" helper for Z-Image/Character/LAN watches. Kills P1-7, unifies P1-1. (~2h)
8. **Wire `test-workflows.cjs` into package.json (`pnpm test`) and extract+test the job reducer** — the harness already exists. (~1h)
9. **Make the LAN full-studio link honest** — either route the desktop bundle's Comfy calls through `/api/lan/*` when a token is present, or relabel the QR dialog. Kills P1-4's lie. (label: 10m; bridge: ~1d)
10. **Extract `useGenerationQueue` (jobs, polling, cancellation) and `useCreateWorkspace` (the 31 states + persistence effect) out of App.tsx** — the seams already exist (`jobsRef`, `PersistedWorkspace`); the CreateView/SettingsView splits are mechanical. (~2-3d, medium risk from effect-dep subtleties, but it's what makes every other fix safer.)

**Decomposition cost, honestly:** the state *is* entangled — one persistence effect spans ~25 states, and `jobs`/`activeJobId`/`movieHandoff` cross-link — but nothing outside App.tsx reads those states except through props, so the refactor is a contained 2-3 day job, not a rewrite. The cost of *not* doing it is already visible: three of the P1s live in effects that only exist because orchestration and UI share one component.
