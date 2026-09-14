# UI inventory & migration map — the original UI vs. the locked canvas direction

**Status:** input document for the Canvas UI spec (task ou0lb2z, 2026-09-14).
**Method:** full read of the live code (`src/App.tsx`, all of `src/views/`,
`src/components/`, `src/hooks/`, `src/state/`, `src/media/`, UI-relevant
`src/lib/`, `src/ui/`, `src/prototypes/`, `src/MobileApp.tsx`, the CSS token
surface, and the three e2e specs) classified against the LOCK register in
`docs/research/ui-pre-brainstorm.md` (empty-canvas launcher; media nodes + op
stacks + no hand wiring; DOM/d3-zoom/SVG-edges/react-rnd substrate; spatial
queue + titlebar radar + summonable index + 100% contextual bottom bar;
fork/takes semantics; one-canvas-per-project + multi-canvas session +
always-autosave; north star + interaction budgets; Items 3–4 forming).

**Classes.** REMOVE = superseded by the canvas model. REFACTOR-ABSORB = the
capability survives and re-homes (landing spot named). KEEP = infrastructure
that survives any shell. SEED = explicitly becomes part of the new build.

---

## 1. Summary counts

| Class | Rows | What it means |
|---|---|---|
| **REMOVE** | **3** | The navigation model itself: two-sidebar shell, sidebar nav buttons, view-switching `View` union. Nothing else is a pure delete. |
| **REFACTOR-ABSORB** | **28** | Every capability the current app has re-homes into the canvas model (jobs → summonable index, references → properties bindings, engines → ops, planner → Director Suite…). |
| **KEEP** | **29** | Infrastructure that survives any shell: fabric, stores, media seam, sanitizer, Base UI wrappers, form primitives, engine-param inference. |
| **SEED** | **12** | Explicit new-build inputs: Stage substrate, Bench op-stack/takes, Score document soul, protoStore, ImageCrop data, filmstrip layout, prompt editor/library/approval-gate patterns. |

(72 classified rows across ten sections; counts are computed from the table
below.)

**The headline finding:** the original UI is ~5% chrome and ~95% capability.
The clean slate is real for the *shell* (launcher, navigation, queue seat,
per-engine views) but the inventory shows the app's value is already shaped
like the target model's internals — binding-without-wiring (CreateView's
reference allocation), settings-results separation (registry configs vs job
outputs), append-only takes history in the job list, non-destructive crop and
clip data, latent-chain rendering (MoviePlanner's scene chain), and a real
document-projection prototype (Score). Migration is therefore mostly
**re-homing + unwinding singleton state**, not rewriting capability.

---

## 2. The classified inventory

### 2.1 Shell & chrome

| # | Item | What it does today | Class | Rationale / landing spot |
|---|---|---|---|---|
| 1 | `src/App.tsx` (shell) | Titlebar + collapsible left sidebar (Generate/Plan/Review nav groups) + main-area view switching over a 15-value `View` union; hosts session/queue/workspace/flows wiring, notices, AiChatHead, VideoReferenceClipper. | **REMOVE** | Superseded by the empty-canvas launcher (Lock 1: "the app is already the app — no mode switch") and one-canvas-per-project + multi-canvas session. The *wiring* it hosts (flows, session, queue) is KEEP infrastructure that moves to the canvas root; the *shell geometry and nav* die. |
| 2 | `src/components/chrome.tsx` → `NavButton` + sidebar markup | Sidebar nav buttons with pending-count badge, model-health footer, mobile drawer behavior. | **REMOVE** | Navigation-by-view-switching is the model the maintainer rejected; nothing selected + Generate covers t2v (parked "engine views dissolve" answer). Count badge dissolves into the radar. |
| 3 | `chrome.tsx` → `GpuMeter` + titlebar engine/connection chips (`App.tsx` titlebar) | Fixed titlebar: brand, GPU/VRAM meter, external/managed engine status chip with degraded states, per-view workspace reset. | **REFACTOR-ABSORB** | Queue-synthesis lock names the titlebar engine chip as THE one fixed-chrome survival — extended into the aggregate-attention radar ("3 running · 1 needs attention"; click zooms camera to the troubled region). GpuMeter and engine state render inside it. |
| 4 | `chrome.tsx` → `Notice` | Auto-dismissing toast strip (error/success/neutral) driven by `notify()` from every flow. | **REFACTOR-ABSORB** | Toasts survive as a layer but re-home to the attention model: durable failure goes ON the object (spatial-queue contract 1), aggregate pings ride the radar, and only true ambient info stays a toast. The `notify` seam itself is KEEP — every absorbed flow keeps calling it. |
| 5 | `src/styles.css` (`:root` tokens, semantic color layer, type scale, `--space-*`, `--z-*` ladder) + `src/guided-studio.css` | 2,452-line hand-CSS visual layer: design tokens, the 10-step z-ladder (sticky→dropdown→modal→raised→overlay→toast→dialog-top→max), all view styling. | **KEEP** (tokens + z-ladder; view selectors decay with their views) | Pre-brainstorm names "z-token ladder + Base UI panels" as already-built feed for Item 2. The canvas needs exactly this ladder for floating panels (react-rnd) over the substrate. Per-view blocks (`.create-page`, `.movie-*`, …) retire with their views. |
| 6 | `src/types.ts` → `View` union | `'create' \| 'ltx25' \| 'music' \| 'music3' \| 'zimage' \| 'characters' \| …` — the nav model's data type. | **REMOVE** | Replaced by canvas/project/session documents (multi-canvas session = open canvases, not views). Retiring it is the compile-time proof the nav model is gone. |

### 2.2 Views

| # | Item | What it does today | Class | Rationale / landing spot |
|---|---|---|---|---|
| 7 | `src/views/CreateView.tsx` (656 ln) | The H3 workspace: mode tabs (text/image/frames/reference), SmartPromptEditor with `//` palette and smart library options, automatic composed-prompt preview, source-media modal (libraries, clothing policy, files & crops, timeline keyframe guides), reference strip, prompt tools (enhance/timeline/audio/dialogue), output/quality panel (presets, turbo families, upscale modes incl. LBH 2D/3D, advanced sampling), live preview painter, generate bar, continuation controls. | **REFACTOR-ABSORB** | The single biggest absorption job. Mode tabs → generators-as-ops (selection decides t2v/i2v/frames/ref2v); prompt builder → the seed input node / prompt bar + properties panel; source-media modal → properties-panel relationship authoring (Lock 2: "relationships are authored from a properties panel"); output/quality panel → contextual bottom bar (100% contextual lock); LivePreviewFigure → floating output inspector ("the fabric already streams preview frames"); continuation → fork with extracted-frame substrate. The binding logic it renders is useCreateWorkspace's (row 45). |
| 8 | `src/views/JobsView.tsx` | Queue list: every job with status badge, filmstrip poster, live progress bar, error line, manifest download, cancel. | **REFACTOR-ABSORB** | Management layer of the resolved queue synthesis → the summonable index (⌘K/overlay): flat list across everything, retry/cancel, each entry navigates (zooms) to its region. Per-job state itself moves onto canvas objects. |
| 9 | `src/views/LibraryView.tsx` | Completed-video grid: search/filter/sort, PooledVideoCard playback, manifest export, frame-bookmark entry, "use in LTX" handoff. | **REFACTOR-ABSORB** | Library projection over the document (Item 4's "timeline is a projection" generalized): completed outputs are canvas objects already; the Library becomes a summonable projection + drop-back-onto-canvas source. Bookmark/LTX handoffs become ops (rows 16–17). |
| 10 | `src/views/SettingsView.tsx` (217 ln) | Engine connection, managed-engine runtime (start/stop/log tail), validated H3 stack report + turbo families, setup doctor, graph-compat guard, GPU tiers, generation defaults, LLM router (model list, sticky models, unload-on-generate, content level), Ollama fallback, model locations, output/ffmpeg paths. | **REFACTOR-ABSORB** | Survives as a docked/summonable tool surface (react-rnd panel). Nothing in the canvas model replaces engine config — it is the first-run dependency (risk R1). Generation-defaults section re-homes into op defaults; diagnostics (H3 quality test, doctor) ride the radar/engine chip. |

### 2.3 Engine workspaces (the "Plan/Generate" views)

| # | Item | What it does today | Class | Rationale / landing spot |
|---|---|---|---|---|
| 11 | `src/components/ZImageWorkspace.tsx` (+ `lib/zImageControlnet.ts`) | Z-Image Turbo/Base/Control-sketch stills workspace: variant picker, control image + structure type, seed/steps/guidance, model-component pickers, poll loop, "Use in MiniMax I2V" handoff. | **REFACTOR-ABSORB** | Engines-as-ops: image generation becomes an op/generator invokable from canvas (drop nothing + image intent, or select an image + extend). Control-sketch mode is an op input (sketch/edge/depth/pose — feeds the modal editor's brush/structure ops). The localStorage workspace state becomes chain settings. |
| 12 | `src/components/Ltx25Workspace.tsx` | LTX-2.5 t2v/i2v with audio: separate prompt/preset/seed/live-preview, 32px-aligned resolutions, quality two-stage vs turbo. | **REFACTOR-ABSORB** | Engines-as-ops (video): LTX is an engine choice on a generation op, not a destination. Already used headlessly by CharacterStudio/LocationStudio flows — the workspace is just its manual surface. |
| 13 | `src/components/AceStepWorkspace.tsx` | ACE-Step 1.5 songs: tags/lyrics/instrumental, key/BPM/language, SFT vs Base. | **REFACTOR-ABSORB** | Engines-as-ops (audio): music generation op; audio-stem output tiles onto canvas (drop-anything routes audio — Lock 1). |
| 14 | `src/components/Music3Workspace.tsx` | Music 3 three-section caption builder, lyric structure tags, local caption rewriter (streamed), tiled decode. | **REFACTOR-ABSORB** | Engines-as-ops (audio); its caption builder is a properties-panel form for the op. The streamed rewriter is a KEEP-class llm pattern re-used in place. |
| 15 | `src/components/AiChatHead.tsx` | Floating Studio-copilot bubble: prompt/image/video chat modes over useLlmStream, "use in Create Image / Create Video" handoffs. | **REFACTOR-ABSORB** | Its conversational soul becomes the launcher prompt bar (Lock 1's prompt bar resolves intent); the chat surface survives as a floating panel (react-rnd). The handoff pattern ("use this prompt as…") is exactly typed-hole option-picking (Item 3). |

### 2.4 Studios (asset libraries)

| # | Item | What it does today | Class | Rationale / landing spot |
|---|---|---|---|---|
| 16 | `src/components/CharacterStudio.tsx` (293 ln) | Character identity projects: profile fields, hair/wardrobe/accessory assignment, Z-Image candidate batches (4-up approval), 4-view sheet, LTX turntable/identity survey flow, turntable→5-angles extraction, approved-reference curation. | **REFACTOR-ABSORB** | Two re-homes: (a) Z-Image candidate/sheet generation → generators-as-ops; the identity *flow* (batch → approve → survey → extract) is a recorded chain/macro on canvas (batch completion placement is the direction doc's open placement question); (b) the library + approved-reference curation → properties-panel bindings (CreateView's pickers already consume it). ReferenceApprovalModal gates become takes/lock consent gates. |
| 17 | `src/components/HairStudio.tsx` | Hair design library: texture/length/color/hairline profile → Z-Image 3-view mannequin board → approval → assign in CharacterStudio. | **REFACTOR-ABSORB** | Same pattern as 16, smaller: library + one generation op. Hair-on-master baking ("render with hair") is a fork with recorded settings. |
| 18 | `src/components/WardrobeStudio.tsx` | Wardrobe library: garment profile → Z-Image 3-view outfit sheet → approval → allocation after character identity pictures. | **REFACTOR-ABSORB** | Same as 17. The allocation-order rule (identity first, wardrobe after) lives in promptComposer and survives as binding semantics. |
| 19 | `src/components/AccessoryStudio.tsx` | Accessory library: one isolated item image per watch/glasses/prop → approval → assignment. | **REFACTOR-ABSORB** | Same as 17; the "exactly one authoritative image per item" rule becomes a property of the asset object. |
| 20 | `src/components/LocationStudio.tsx` (177 ln) | Location library: nature/built/mixed profiles with nature-only enforcement, Z-Image master, LTX walkthrough/landscape survey with camera-language presets, guided 3-step builder, walkthrough→5-views extraction. | **REFACTOR-ABSORB** | Same as 16; the guided LTX builder is the best existing template for a canvas-recorded multi-step chain (image → survey video → frame extraction → reference set), i.e. a macro the Director Suite can also emit. |

### 2.5 Editors & media tools

| # | Item | What it does today | Class | Rationale / landing spot |
|---|---|---|---|---|
| 21 | `src/components/MoviePlanner.tsx` (767 ln) | Movie projects: creative brief, production bible (characters/locations with library import + refresh), LLM shot-plan builder, scene/shot editor with continuity (connected-transition last-frame blocking), route resolution, "Open in Create" handoff, latent scene-chain rendering, movie copilot (structured chat revisions with diff review, destructive-change confirmation, undo snapshots), story-order preview. | **REFACTOR-ABSORB** | Named in the direction doc as "the Director Suite's canvas-native successor… ancestor". The PLAN (its project document) is what Item 4's timeline projects; connected-transitions become multi-input forks at segment gaps; scene-chain rendering is already latent-continuous execution; the copilot's reviewed-diff/undo discipline is the consent-gate pattern for chain-level edits; preview = timeline projection playback. |
| 22 | `src/components/ClipEditor.tsx` (269 ln) | Timeline NLE: media bin (jobs + imports), magnetic timeline, drag reorder, trim modal (start/end), frame grab with 4-way handoff (I2V/first/last/reference), ffmpeg join/export. | **REFACTOR-ABSORB** | Trim/join become ops: trim = in-chain window op (the document model's "trim = window"), join/export = export-time assembly the DAG doesn't own (Item 4: NLE transitions "live in the same gaps as export-time ops"). The program monitor is the existing evidence for the open playback-home question (context-bar transport vs monitor tile). |
| 23 | `src/components/VideoReferenceClipper.tsx` | Modal in/out trimmer for reference videos (2–15 s window) producing a clipped MP4 with non-destructive `file.clip` metadata. | **REFACTOR-ABSORB** | Becomes the video-trim op on a media node's op stack — its data model is already op-shaped (`clip: {sourcePath, start, end}` referencing the untouched source). |
| 24 | `src/components/FrameBookmarkStudio.tsx` | Bookmark moments on any video, extract frames (single/all), persistent frame shelf, "use in LTX" handoff. | **REFACTOR-ABSORB** | Frame extraction is one of the candidate "decompose an output" v1 primitives (open sub-question in § TENSION). Bookmarks become markers on a video node; the extracted frame is an output-substrate choice ("extracted frame" in Item 3's output-node list). |
| 25 | `src/components/ImageCrop.tsx` + `src/lib/imageCrop.ts` | Non-destructive crop UI (fit/x/y/zoom stored on `MediaFile.crop`) + pure canvas preparation math (`cropRect`, `drawPreparedImage`, `fitWholeCharacter`). | **SEED** | Named by the direction doc as already-built feed for Item 2's modal editor v1 ("crop + rotate + brush mask + adjustments"). The crop DATA is the op-stack's first op; `drawPreparedImage` is the op's render. |
| 26 | `src/components/SmartPromptEditor.tsx` | Textarea + `//` command palette: category-filtered presets, dynamic library options with thumbnails, keyboard-complete listbox, insert-at-cursor, smart label replacement. | **SEED** | The prompt surface every canvas prompt field needs (seed input node, op prompts, copilot). Its "options = type-directed insertions" shape is the same interaction as typed-hole option menus (Item 3) — one component serves both. |
| 27 | `src/components/PromptLibraryBrowser.tsx` | Community (Civitai proxy) + saved prompt library dialog with study/save, settings metadata, technique starters. | **SEED** | Dialog component + store survive as the prompt-library summonable panel; Civitai attribution footer is a legal keep. Where it lives in the canvas model is spec-open (see §7). |
| 28 | `src/components/ReferenceApprovalModal.tsx` | Generic approve/retry gate for generated references ("approval starts generation" flag, next-step explainer). | **SEED** | The consent-gate visual pattern for takes/forks: "approve this take → downstream proceeds" is Lock 3's rerun-on-consent made visible. Reused wherever generation precedes commitment. |
| 29 | `src/components/CharacterDialogueModal.tsx` | Performable-dialogue drafter (intent/words/delivery/length/language) over the local LLM for a selected character; inserts into prompt + unsets noDialogue. | **REFACTOR-ABSORB** | Dialogue tooling becomes an op/property on a shot chain (an LLM op whose output is prompt text); policy plumbing (dialogPolicy) is KEEP. |

### 2.6 Shared UI primitives

| # | Item | What it does today | Class | Rationale / landing spot |
|---|---|---|---|---|
| 30 | `src/components/media.tsx` → `VideoPlayer` | Autoplay-looping output player with decode-failure recovery. | **KEEP** | Any canvas tile's playback element; failure recovery matters on codec-limited hosts (e2e guards this). |
| 31 | `src/components/media.tsx` → `VideoContinuationControls` | "Extend this shot": extract frame at N or last → load as I2V first frame. | **REFACTOR-ABSORB** | The fork gesture: becomes "fork from frame" on a video node with an extracted-frame output substrate (Item 3). Its UX copy ("this clip is not rendered again") already states fork-not-edit semantics. |
| 32 | `src/components/media.tsx` → `MediaDrop` | File drop/choose card with preview + remove. | **KEEP** | The launcher's drop-anything zone and every media-node empty state are this component. |
| 33 | `src/components/PooledVideoCard.tsx` (`FilmstripPoster` + card) | Static filmstrip poster (sprite-sheet CSS) + click-to-lease pooled playback with click-away release. | **SEED** | The canvas tile's media renderer: far-zoom thumbnail = poster, interaction = pooled lease. Semantic zoom swaps poster modes (`frame` ↔ `sheet`) for free. |
| 34 | `src/components/RenderSize.tsx` | Orientation/resolution picker matrix per provider. | **KEEP** | Re-used verbatim in the properties panel / bottom bar for resolution ops. |
| 35 | `src/components/RenderConstruction.tsx` | The "constructing" render-state animation. | **KEEP** | The spatial-queue tile's rendering visual (progress-on-object). |
| 36 | `src/components/form.tsx` (`SelectField`/`NumberField`) | Labeled form primitives. | **KEEP** | Properties-panel/bottom-bar form atoms. |
| 37 | `src/ui/StudioDialog.tsx` | Base UI Dialog wrapper (focus trap/restore, Escape, aria, scroll lock) keeping hand CSS. | **KEEP** | Named in the direction doc ("Base UI panels" feed Item 2). Every canvas modal (the modal editor!) builds on it. |
| 38 | `src/ui/StudioTabs.tsx` | Base UI Tabs wrapper (arrow/Home/End, roving tabindex). | **KEEP** | Survives for any remaining tab strips (properties-panel sections, engine pickers). |
| 39 | `src/components/ErrorBoundary.tsx` | Per-view error boundary with PII-scrubbed fallback + reload. | **KEEP** | Mandated by the direction doc's keeps list; on canvas, boundaries wrap tiles/panels/chains, not views. |
| 40 | `src/components/LicenseNotice.tsx` | One-time dismissible MiniMax H3 community-license notice. | **KEEP** | Legal surface; must survive any shell (first-run risk R1 companion). |
| 41 | `src/state/TransientProbe.tsx` + `transientProbe.ts` | `?probe=transient` dev probe proving store-driven paints cause zero React renders. | **KEEP** | Dev instrumentation that guards the transient-update discipline the canvas depends on (rAF/DOM painting). |

### 2.7 Hooks & state

| # | Item | What it does today | Class | Rationale / landing spot |
|---|---|---|---|---|
| 42 | `src/hooks/useStudioSession.ts` + `state/sessionStore.ts` | Settings load, model scan, ComfyUI connection/object-info, Ollama/LLM provider resolution, GPU telemetry (fabric + degraded poll), managed-engine runtime poll. | **KEEP** | Session facts are shell-independent; the radar and every op read them. |
| 43 | `src/hooks/useGenerationQueue.ts` + `state/jobsStore.ts` | Job persistence (SQLite + degraded localStorage), 1 s history poll with terminal guards, auto-retry (engine reset + tiled VAE), deadline sweep, fabric-resync sweep, cancellation, completion side effects (output attribution, filmstrip warm-start, character/location auto-extraction). | **KEEP** | The queue's engine is exactly what the spatial queue renders. Its per-job reduction states are the on-object states; the poll loop stays as reconciliation (its own header says demoting it is a later decision). Completion side effects become "outputs land on canvas" hooks. |
| 44 | `src/state/jobMachine.sketch.ts` | Unwired xstate-shaped sketch of the job lifecycle (incl. awaitingOutput, retrying). | **KEEP** | Design note that informs the on-object state machine; already type-checked, not runtime code. |
| 45 | `src/hooks/useCreateWorkspace.ts` | Workspace facade: library event syncs, server-workspace boot/persist, media hydration, reference binding/allocation (the binding-without-wiring core), choose/edit media, atomic reset. | **REFACTOR-ABSORB** | The binding logic (allocation, prompt sync, wardrobe-fit) survives as chain/properties semantics; the SINGLETON workspace (one global create state) dissolves into per-chain settings + per-project documents. Its server persistence pattern seeds the document store's. |
| 46 | `src/state/workspaceStore.ts` | Zustand store of every persisted creation field + libraries + handoffs; narrow selectors; persisted-key gating; snapshot builder. | **REFACTOR-ABSORB** | Fields become fork settings (Lock 3: "fork settings persist separately from fork results — already true: registry/op-stack configs vs job outputs"). The store's selector discipline is the template for the canvas document store. Singleton shape does not survive one-canvas-per-project. |
| 47 | `src/hooks/useGenerationFlows.ts` | Submission flows for all providers: validation ladders, uploads (crop-aware), graph build + manifest, cancel-aware bookkeeping, diagnostics pair, scene-chain latent continuation, character contact-sheet. | **REFACTOR-ABSORB** | These become the op registry's RUN implementations (engines-as-ops): each flow = one op's execute(). The validation ladders become op-input type checks (typed holes' filter predicates). Nothing about them is view-bound. |
| 48 | `src/hooks/useDebouncedPersist.ts` | Trailing-debounce persist with pagehide/beforeunload flush. | **KEEP** | Always-autosave lock needs exactly this flush discipline for camera positions and documents. |

### 2.8 Media seam

| # | Item | What it does today | Class | Rationale / landing spot |
|---|---|---|---|---|
| 49 | `src/media/PreviewSource.ts` | The preview seam: filmstrip sheets, pooled playback, future `getFrame` (v2 WebCodecs). | **KEEP** | The direction doc lists "video pool + filmstrip + OPFS cache (rich tiles)" as already-built feed. v2's frame-accurate `getFrame` is the modal editor's and frame-extraction op's future backing. |
| 50 | `src/media/httpPreview.ts` | v1 implementation: server filmstrip route + OPFS cache-first fetch + output-asset registration/warm-start. | **KEEP** | Tiles fetch thumbnails through it unchanged. |
| 51 | `src/media/videoPool.ts` | ≤4 exclusive `<video>` leases with idle auto-release and preemption — the HTTP/1.1 connection-ceiling fix. | **KEEP** | Canvas will show MANY video tiles; without the pool it recreates the 100-card starvation bug on day one (risk R6). |
| 52 | `src/media/blobCache.ts` | OPFS blob cache, graceful no-op failure model. | **KEEP** | Thumbnail persistence across sessions. |
| 53 | `src/media/filmstripLayout.ts` | Pure layout math shared client+server (cols/rows/frameCount, 12–30 samples). | **SEED** | Named in the keeps list; also the far-zoom tile projection's grid. |
| 54 | `src/media/useFilmstrip.ts` / `usePooledVideo.ts` | React hooks binding the seam to components. | **KEEP** | Tile components consume them directly. |

### 2.9 Lib (UI-relevant)

| # | Item | What it does today | Class | Rationale / landing spot |
|---|---|---|---|---|
| 55 | `src/lib/useRealtime.ts` | The fabric: one WS (SSE fallback), typed channels, seq-gap resync, binary preview frames, LLM streaming, `__minimaxRealtime` diagnostics. | **KEEP** | Named twice in the direction doc as feed ("the fabric (context events streaming)", "a floating panel can show a running job's live output anywhere"). The floating inspector is literally `onPreviewFrame` + a panel. |
| 56 | `src/lib/useLlmStream.ts` | Token-streaming UX over the fabric with server-composed system messages; zero-render painting into a target element. | **KEEP** | Every absorbed assistant (launcher, copilot, caption rewriter, dialogue) keeps it. |
| 57 | `src/lib/useLivePreview.ts` | Live-preview adapter over the fabric (job channel + frames) with rAF-coalesced compat feed. | **KEEP** | Canvas tiles' live-progress feed; compat feed retires when LTX-style consumers rewire (its own TODO). |
| 58 | `src/lib/logSanitize.ts` | PII-scrubbing shared by client boundary + server. | **KEEP** | Mandated keeps list; protects prompt text in every future surface. |
| 59 | `src/lib/promptComposer.ts` + `promptPolicies.ts` + `promptContracts.ts` | Reference allocation into 9-picture budget, composed H3 prompt (bindings/clothing/dialogue/movement rules), six-section contract drafts, order warnings, cut-time scaffolds. | **REFACTOR-ABSORB** | The compilation layer: bindings → properties-panel relationship model; `composeH3Prompt` becomes the chain→prompt compiler an op runs; contract drafts become prompt-tool insertions in the seed node. The "binding-without-wiring proof" the direction doc cites lives here. |
| 60 | `src/lib/{character,wardrobe,hair,accessory,location}Library.ts` + `libraryStorage.ts` | Five localStorage-backed asset libraries with change events and approved-reference projection. | **REFACTOR-ABSORB** | Libraries become canvas-visible assets / project documents (library projection); storage layer survives through the SQLite migration (serverStorage already mirrors). Cross-view event sync dies with the views. |
| 61 | `src/lib/serverStorage.ts` | SQLite jobs/workspace/prompts API + one-time localStorage migration (copy-verify-mark). | **KEEP** | The persistence backbone; the canvas document store extends it (and owes its users a no-loss migration — risk R3). |
| 62 | `src/lib/workflow.ts` + `src/lib/graph/*` (optimization registry: turbo/upscale/preview entries, insert-only + inertness contracts) | Graph factory for every engine family; optimization methods as data. | **KEEP** | Engine layer, shell-free. The registry's "method = data entry" shape is the ancestor of the op registry the canvas needs (typed-hole option lists read it). |
| 63 | Engine-param inference set: `modelSelection`, `comfyInfo`, `h3Stack`, `ltx25Workflow`, `aceStepWorkflow`, `music3Workflow`, `zimage`, `zImageControlnet`, `contactSheet`, `dialogPolicy`, `promptWatch` | Model/node availability inference, graph builders, poll-loop helper, dialogue/noDialogue policies. | **KEEP** | Pure engine knowledge; ops wrap them unchanged. |
| 64 | `src/lib/manifest.ts` + `jobRecords.ts` + `jobReducer.ts` | Reproducibility manifests (seed/models/sampler/graph version), job record side effects (movie/character/location attribution, auto reference-set extraction), terminal-guarded poll reduction. | **KEEP** | Manifests are the takes model's recorded-settings artifacts; jobRecords' attribution rules are how outputs find their chain/object. |
| 65 | `src/lib/promptPresets.ts` + `promptCorpus.ts` + `promptLibraryStorage.ts` | The `//` preset corpus (categories, searchable), community-library storage events. | **SEED** | Feeds SmartPromptEditor's palette and the prompt-library panel directly. |
| 66 | Utilities: `format`, `createId`, `mediaUrls`, `apiClient` (web bridge), `doctor`, `loafObserver`, `workspace.ts` (normalize/defaults) | Small shared helpers. | **KEEP** | Unconditional. |

### 2.10 Mobile & prototypes

| # | Item | What it does today | Class | Rationale / landing spot |
|---|---|---|---|---|
| 67 | `src/MobileApp.tsx` (409 ln, `?mobile=1` lazy route) | Phone companion: LAN-token bootstrap, video/image/characters views, reference picking with crop, generation with progress, PWA install, character sync from desktop. | **REFACTOR-ABSORB** | Not covered by any lock — spec must decide (see §7 Q1). The companion's *capability* (remote submit + watch) re-homes naturally onto the radar + summonable index on a responsive canvas, but "companion as first-class surface vs thin remote" is open. Untouched by the canvas cutover until decided. |
| 68 | `src/prototypes/Stage.tsx` | DOM+transform infinite canvas: non-passive wheel zoom about cursor, pan-on-empty, click-select / click-again-cycles-takes, selection-follows properties panel, per-object render overlay, J/K/B/P/R keys. | **SEED** | THE substrate seed ("Stage prototype is the shell" — direction doc). Promotes to the real canvas with d3-zoom swapped in for the hand-rolled camera and react-rnd panels for the fixed aside. |
| 69 | `src/prototypes/ShotBench.tsx` | Outliner + take-family audition stack + param-diff gutter + modifier stack with staleness + always-live queue strip. | **SEED** | Op-stack + staleness chips + takes audition (J/K/P/B, digit-jump) — the interaction vocabulary for op stacks and the takes model. Param-diff gutter is the fork-rerun review view. |
| 70 | `src/prototypes/Score.tsx` | Document tree + timeline ⇄ node-graph projections of one document; rAF/DOM playhead; upstream-edit marks ONLY downstream stale; continuity edges drawn on hover. | **SEED** | "Score's document soul" — the projection model (Item 4's timeline is a projection) and the staleness-propagation semantics for Lock 3's dirty-bit rule. |
| 71 | `src/prototypes/protoStore.ts` | Shared mock document (shots own ordered op stacks; takes are immutable records; dependency edges drive staleness; queue walks states incl. honest failure). | **SEED** | The reference document-shape for the real store (the document-model spec o0xw49r encodes the same locks); its reducer logic is a starting skeleton, its DATA is mock. |
| 72 | `src/prototypes/PrototypeShell.tsx` + `protoKeys.ts` + `proto.css` + `posters.ts` | `?proto=` lazy shell with A/B/C switcher, shared queue strip, keyboard plumbing, generated posters. | **SEED** (stays runnable) | Direction doc: prototypes "stay runnable for ground truth but do not need updating" — 3 proto e2e tests depend on them. protoKeys (input-capture-aware handler) promotes to the real shortcut layer. |

---

## 3. Migration order proposal (phased cutover, not delete-now)

Principle: **the canvas becomes the primary surface behind a flag/route while
the original stays reachable; each capability migrates, then its old home is
removed.** The `?proto=` route pattern (main.tsx lazy route split) is the
proven mechanism — `?canvas=1` (or `/canvas`) costs the old shell nothing.

**Phase 0 — foundation (no UI change).**
Document-model spec (o0xw49r) lands; keeps list confirmed (tokens, fabric,
stores, PreviewSource seam are already shell-free — verified by this
inventory). Extend serverStorage with the canvas/project document tables
alongside jobs/workspace (no migration of old data yet).

**Phase 1 — substrate + launcher + spatial queue skeleton (`?canvas=1`).**
Stage's pan/zoom/select promotes to a real substrate (d3-zoom, DOM tiles,
SVG edge layer, react-rnd panels). Empty-canvas launcher v1: prompt bar +
drop-anything zone (MediaDrop) + minimal intent chips (≤5) + resume cards
(projects store exists). Spatial queue v1: job state rendered on objects
(jobsStore is already global), titlebar radar replaces the sidebar count
badge, summonable index v1 over the job list. Old shell untouched and
default.

**Phase 2 — generation arrives on canvas (the CreateView dependency).**
First generators-as-ops wrap useGenerationFlows' `generate` (H3 four modes by
selection). Properties panel v1 absorbs the binding model
(allocateWorkspaceReferences + prompt sync from useCreateWorkspace /
promptComposer). Old CreateView still reachable; both surfaces share the
stores (they already do — no fork of state, only of view).

**Phase 3 — ops, forks, takes.**
Op stack v1 (crop/rotate/adjustments modal over ImageCrop data;
VideoReferenceClipper's trim as video op; upscale as dual-mode
stack-or-fork). Fork semantics + append-only takes (Bench/protoStore
patterns over jobs + manifests). Output-substrate choices (decoded media /
extracted frame / latents-on-disk) on the fork gesture. After this phase
CreateView, JobsView, ClipEditor, VideoReferenceClipper, FrameBookmarkStudio
and the Library *view* are redundant in capability — retire behind the flag.

**Phase 4 — engines-as-ops + libraries + tool surfaces.**
Z-Image/LTX/ACE/Music3 flows become invokable ops (their flows are already
headless-capable — CharacterStudio drives LTX without its view). Studios'
generation re-homes as recorded chains; the five libraries become canvas
assets + properties bindings. SettingsView becomes the docked tool surface.
Mobile decision (Q1) resolves.

**Phase 5 — Director Suite + retirement.**
MoviePlanner's plan document becomes the timeline projection (Item 4);
scene-chain rendering already exists in flows. Old shell deleted; `View`
union deleted; per-view CSS and e2e rewritten (§6); localStorage libraries
finalize their SQLite migration with the copy-verify-mark pattern.

**Hard ordering dependencies (why this order):**
- D1: Fabric + jobsStore + flows must power canvas generation before
  CreateView retires (else the app loses its only submit path).
- D2: Properties-panel binding must exist before the source-media modal
  retires (reference mode is the deepest capability in the app).
- D3: Radar + on-object state + summonable index must ALL exist before
  JobsView retires (silent-failure regression is the cardinal sin per the UX
  research; the three-layer synthesis is a package deal).
- D4: Settings/first-run must stay reachable in every phase (engine config
  gates everything; LicenseNotice too).
- D5: Persistence continuity — the server workspace/jobs tables are the old
  surface's state; the document store must import, not orphan, them.
- D6: e2e per view must be rewritten before its view is deleted (CI blind
  spots otherwise).
- D7: Mobile companion depends only on the LAN bootstrap API — safe to defer,
  but its character-sync consumes useCreateWorkspace's sync effect, which
  changes shape in Phase 2/4 (coordinate or consciously drop).

---

## 4. The "clean slate keeps" list — what the new build starts from

1. **Substrate seed:** Stage's camera/selection mechanics (swap in d3-zoom +
   react-rnd per the substrate lock); protoKeys for shortcuts.
2. **Interaction seeds:** Bench's op-stack/staleness/audition/param-diff;
   Score's projection + downstream-staleness; protoStore's document shape.
3. **Tokens & chrome atoms:** styles.css `:root` tokens + the `--z-*` ladder;
   StudioDialog/StudioTabs (Base UI); form.tsx; ErrorBoundary; LicenseNotice;
   RenderConstruction; RenderSize; MediaDrop; VideoPlayer.
4. **The fabric:** useRealtime (WS/SSE, preview frames, LLM streaming),
   useLivePreview, useLlmStream — unchanged.
5. **Stores & queue engine:** sessionStore, jobsStore, useStudioSession,
   useGenerationQueue (poll = reconciliation), useDebouncedPersist;
   jobMachine.sketch as the state-space note; TransientProbe discipline.
6. **Media seam:** PreviewSource interface + httpPreview v1 + videoPool +
   blobCache + useFilmstrip/usePooledVideo + filmstripLayout; FilmstripPoster
   as the tile renderer.
7. **Engine layer:** workflow/graph registry (+ inertness contracts),
   modelSelection/comfyInfo/h3Stack/per-provider builders, dialogPolicy,
   promptWatch, manifest/jobRecords/jobReducer.
8. **Data seeds:** ImageCrop's crop data + math; SmartPromptEditor;
   promptPresets corpus; PromptLibraryBrowser; ReferenceApprovalModal;
   serverStorage migration pattern.
9. **Capability reference implementations:** useGenerationFlows (the ops'
   execute() bodies), promptComposer's allocation (the binding semantics),
   MoviePlanner (the plan document + consent-gate UX), LocationStudio's
   guided chain (the macro template).

---

## 5. Risk register — what breaks if removed prematurely

| ID | Risk | Trigger | Blast radius | Mitigation |
|---|---|---|---|---|
| R1 | **First-run / engine setup unreachable** | Shell or SettingsView removed before canvas has an engine-config + license surface | App cannot connect to ComfyUI at all; new users dead in the water; LicenseNotice unshown (legal) | Keep Settings reachable in every phase (summonable panel from the radar chip); LicenseNotice mounts in the canvas root from Phase 1 |
| R2 | **Silent queue failure** | JobsView removed before on-object state + radar + index all exist | The UX research's most-hated failure mode returns: failed renders nobody sees; auto-retry/cancel paths lose their only surface | Ship the three-layer synthesis as one unit (D3); e2e asserts a failed job is visible from any canvas state |
| R3 | **Workspace/job data orphaned** | workspaceStore singleton dissolved without a document-store import | In-flight prompts, references, job history, five asset libraries lose their writer; SQLite rows unread | Copy-verify-mark migration (serverStorage pattern) from workspace/jobs/libraries into the document store before Phase 3 retirement |
| R4 | **Generation capability loss** | CreateView retired before canvas ops wrap all four H3 modes + reference binding | The core product verb disappears; studios' automation (turntable/survey/walkthrough) and Movie handoffs break — they route THROUGH Create/workspace | D1/D2 ordering; keep the shared stores single-source so both surfaces stay in sync while both exist |
| R5 | **e2e / vision coverage collapse** | Any view deleted before its spec is rewritten | CI green-lies; regressions in kept infrastructure ship unnoticed | Rewrite per retiring view in the same change (§6 mapping); the 3 proto specs port to the real canvas in Phase 1 |
| R6 | **Perf regression on canvas** | Tiles mount raw `<video>`/`<img>` instead of the seam | The 6-connection starvation bug reborn at canvas scale; substrate blamed wrongly | FilmstripPoster + pool mandatory in the tile component contract; TransientProbe discipline for progress/live frames |
| R7 | **Mobile companion breakage** | useCreateWorkspace's syncMobileCharacters effect reshaped in Phase 2/4 | Phone users lose character references silently | Decide Q1 first; if kept, sync from the document store with the same data-url projection |
| R8 | **Library event spaghetti cut live** | Cross-view CustomEvent syncs (5 libraries) removed while old views still mounted | Double-mount transition period sees stale libraries in old views | Events stay until the last old consumer is deleted (they're cheap); document store becomes the single notify source |
| R9 | **Engine-managed runtime observability lost** | Titlebar chip redesigned before radar carries engine state | Managed-mode failures (port conflicts, adoption) invisible; SettingsView log tail is the only diagnostic | Radar chip must carry degraded/managed states from Phase 1 (copy the chip's existing states verbatim) |

---

## 6. E2E / test impact

**The 15 e2e tests** = 12 in `e2e/app.spec.ts` + 3 in `e2e/prototypes.spec.ts`
(plus the separate 4-scenario vision-capture suite). The app-spec twelve,
mapped:

| Test | Classification | What happens |
|---|---|---|
| boots to the Create view with the studio shell | REMOVE-dependent | Rewrites to "boots to the empty canvas launcher" in Phase 1 (becomes the launcher's first e2e) |
| every view renders without renderer errors (15-view loop) | REMOVE-dependent | The loop dies with the `View` union; replaced per-phase by "every canvas surface renders" + per-op smoke tests; error-boundary containment test below survives targeting tiles/panels |
| captures a 1920x1080 screenshot of every view | REMOVE-dependent | Recomposed per phase into canvas-state captures (empty, populated, running, failed) for the vision pipeline |
| Create view keeps Generate + controls visible at 1080p | REFACTOR-ABSORB | Becomes "contextual bottom bar exposes Generate for the current selection at 1080p" (interaction-budget assertion) |
| settings round-trips through the server API | KEEP | Unchanged (Settings surface moves, the API test doesn't care) |
| Settings renders LLM router fallback | KEEP | Follows the Settings surface wherever it docks |
| mobile companion boots | REFACTOR-ABSORB | Holds until Q1 is decided; then either unchanged or rewritten against the responsive canvas |
| realtime fabric connects + telemetry flows | KEEP | Unchanged — fabric is keeps-list |
| crashing view contained by boundary without leaking prompt text | KEEP | Retargeted from views to canvas regions (tile/panel boundary mounts) |
| transient updates paint via store.subscribe with zero re-renders | KEEP | Unchanged — the discipline is load-bearing on canvas; probe stays |
| Create view core flow fully keyboard-operable | REFACTOR-ABSORB | Becomes the canvas keyboard contract test; the shortcut MAP itself must be specified first (§7 Q2) |
| library cards render filmstrip posters + pooled playback | KEEP (assertions) | The assertion ports to canvas tiles nearly verbatim — same seam, same components |

**`e2e/prototypes.spec.ts` — 3 tests** (bench/stage/score): SEED — stay green
as long as the prototypes stay runnable (direction doc's stated intent), then
each is ported to the real canvas in the phase that implements its direction
(Stage → Phase 1, Bench → Phase 3, Score → Phase 5 timeline). The
staleness-flows-downstream-only assertion is the single most valuable test to
carry forward — it encodes Lock 3.

**`e2e/vision-capture.spec.ts` — 4 scenarios** (`scripts/vision-e2e/
scenarios.ts`): create-composer@1080p (absorbed — becomes launcher/selection
composition), settings-llm-fallback (keeps following Settings),
library-empty (absorbed — becomes empty-projection state), create-keyboard-
dialog (absorbed — keyboard-opened panel with focus ring becomes the
summonable-index/properties test). The capture/judge pipeline itself is
KEEP-class infrastructure — scenarios are data.

---

## 7. Open questions for the spec (things the code reveals that the design docs don't cover)

1. **The mobile companion** (`?mobile=1`, 409 lines, PWA install, LAN token)
   is a whole second client the direction doc never mentions. Keep as a thin
   remote (radar + index + submit) over the canvas model, keep as its own
   guided client, or park? Its bootstrap API is server-side and
   canvas-independent — the decision is product, not technical.
2. **Keyboard-shortcut inventory.** The current app has essentially NO global
   shortcuts (Escape in dialogs; `//` palette; tab arrows) — discoverability
   was mouse-first. The prototypes define the real map: J/K cycle, B branch,
   P pin, R rerun, V projection flip, Space play, ←/→ scrub, digits
   jump-to-take, Escape deselect. The spec must write the full canvas map
   (incl. launcher focus, palette summon, camera bookmarks) — Blender's
   "shortcuts printed on affordances" rule is already prototyped via `Kbd`.
3. **Playback home.** ClipEditor's program monitor (pooled lease, in/out
   behavior) vs VideoPlayer tiles vs the context bar — the direction doc
   leaves "where does PLAYBACK live" open; the code shows both patterns
   working and pooling forces exclusivity, which argues for
   playback-as-object-state.
4. **Export/assembly surface.** `joinVideos` (ffmpeg) + ClipEditor timeline
   is the only "make one file" path. Item 4 says NLE transitions are
   export-time ops in segment gaps — but where does export live in the
   canvas model (a project-level op? a summoned assembly view?) is unspec'd.
5. **Community prompt library placement.** Civitai proxy + saved prompts +
   technique starters survive — as a launcher-adjacent browser, a properties
   insert source, or both? (Attribution footer must follow.)
6. **Guided multi-step flows as macros.** CharacterStudio's identity flow
   (batch→approve→survey→extract) and LocationStudio's guided builder are
   hand-coded pipelines today. On canvas they should be *recorded chains* the
   user can inspect/re-run — which implies a macro/chain-template concept the
   locks don't name. Same machinery would serve Director-Suite shot emission.
7. **Timeline keyframe guides** (`MiniMaxH3AddGuide`, ≤6 per shot, negative
   seconds, prompt-visibility mirror rule) are per-shot params with real
   validation semantics — they must survive as chain settings in the
   document model, or reference-mode loses a capability silently.
8. **Per-studio "approved references" curation** (single-vs-set modes,
   per-image checkboxes) is amini takes model per asset. Decide whether
   asset-level reference sets become takes (append-only + canonical
   pointer) or stay curated sets — the two models shouldn't diverge.
9. **The notice seam.** Every flow calls `notify()`; the attention model
   (object + radar + toast) needs a routing policy (what is durable-on-
   object vs ambient) so absorbed flows don't spam toasts for what is now
   on-canvas state.
10. **`AiChatHead`'s mode-specific handoffs** ("use as image prompt" /
    "use as video prompt with noDialogue") are the only existing
    intent-routing UI; the launcher's chips + typed holes generalize it —
    the spec should confirm the chip set against these three proven intents
    plus drop-media (Lock 1's "drop routes itself").

---

## Appendix: what NOT to rebuild (verified already shell-free)

The following were checked and are already independent of the view system —
the canvas can import them on day one with zero changes: `useRealtime`,
`useLlmStream`, `useLivePreview`, `sessionStore`/`jobsStore` + their hooks,
`useDebouncedPersist`, the entire `src/media/` seam, `logSanitize`,
`serverStorage`, `workflow`/`graph`, the per-provider graph builders and
inference helpers, `manifest`/`jobRecords`/`jobReducer`, `StudioDialog`,
`StudioTabs`, `form.tsx`, `ErrorBoundary`, `RenderConstruction`, `RenderSize`,
`MediaDrop`, `VideoPlayer`. The only stateful things that must be *reshaped*
(not deleted) are `workspaceStore`/`useCreateWorkspace` (singleton →
per-chain/per-project) and the five library stores (events → documents).
