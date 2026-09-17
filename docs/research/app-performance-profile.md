# App performance profile — density stress, SPA + server (2026-09-17)

> Task: App performance profile (eebh7ah). Epic: the studio core (xng2pk8).
> Method: **MEASURED** end to end against the production build at HEAD
> `d06cc82` (isolated worktree). SPA numbers are real Chrome (chrome-devtools
> MCP, 1920×1080, untraced unless noted) driving the built app at
> `http://127.0.0.1:5301/?canvas=1&probe=canvas`; server numbers are the same
> scenarios against `node --cpu-prof --heap-prof` instances on ports
> 5301/5302 with a scratch `MINIMAX_STUDIO_HOME` (settings.comfyUrl pinned to
> a dead port — zero engine/GPU contact, per the safety contract). All media
> is synthetic ffmpeg (`testsrc2`/`gradients`/`smptehdbars`): 170 distinct
> clips (640×360 … 1344×768 and 768×1344 portrait, 2–6 s, H.264 CRF 30,
> +faststart, 31 MB) + 140 stills (2.7 MB). Every canvas object was authored
> through the REAL documents API (chain → output → `blobs/ingest` → take),
> with take metrics mirroring `store.ts ingestDrop` (`sourcePath` +
> `blobPath`) so tiles, posters, and the library projection behave exactly as
> real drops do. Evidence tags: **[MEAS]** measured here, **[DOC]** verified
> in shipped code. Raw numbers: `test-results/perf-profile/artifacts/
> matrix-summary.json` (gitignored scratch); the reusable harness is
> committed under `scripts/perf-profile/`.

A first seeding pass omitted `metrics.sourcePath`; the library projection
resolves rows through `mediaForOutput` (`src/canvas/generation.ts:238`) which
requires it. That pass was discarded and all tiers re-seeded (v2) — every
number below is a v2 run.

## The hostile-density answer, up front

**What binds first at 300 mixed objects: nothing on the media path — the
canvas degrades gracefully.** The measured binding order:

1. **Main-thread cull-set churn while panning a dense field** — the only
   metric that scales with density on the interaction path (substrate renders
   during a 2 s pan: 3 → 10 → 22 → 37 across tiers; pan FPS 61 → 44). Still
   zero React renders per frame and zero >50 ms tasks at any tier **[MEAS]**.
2. **Server document-read concurrency** — the first *hard* cliff anywhere:
   `GET /api/lan/documents/project` at 300 objects collapses under load
   (p50 176 ms, p99 ~400 ms at 16× concurrency, ~78 rps) because hydration is
   synchronous and single-threaded **[MEAS + CPU profile]**.
3. **Unvirtualized overlay opens** — the timeline projection at 300 objects
   costs a 229 ms long task inside a 453 ms open **[MEAS]**.

**Explicitly NOT binding** (each measured, see "came up clean"): simultaneous
video decode (93 paused `<video>` elements, all `readyState 4`, 0 dropped
frames), DOM node count (≤1,199 at the worst state), document size on the
wire (382 KiB parses in ~15 ms single-shot), WS fan-out (document CRUD
publishes **nothing** to the realtime fabric — there is no document channel
**[DOC]** `server/realtime.ts:9`), filmstrip generation (lazy, ETag-cached,
and canvas blob tiles never request it **[DOC]** `Tile.tsx:63-70`).

**Where the cliffs are:**

| Metric | 10 | 50 | 150 | 300 | Cliff shape |
|---|---|---|---|---|---|
| pan FPS at zoom-to-fit (untraced) | 61 | 57 | 50.5 | 44 | soft slope; 150→300 is where >25 ms frames double (13→34) |
| substrate renders / 2 s pan | 3 | 10 | 22 | 37 | linear in density — every frame changes the culled set |
| timeline open (V) | 49 ms | 75 ms | 201 ms | 453 ms | super-linear after 150 (229 ms of it one long task) |
| library open (V×2) | 41 ms | 45 ms | 87 ms | 228 ms | same shape |
| project GET, single | 3 ms | 4 ms | 9 ms | 15 ms | linear in objects (13→382 KiB) |
| project GET, 16× burst | — | — | — | p50 176 ms, p99 400 ms | wall at every tier; absolute cost ∝ document size |

## Environment

- HEAD `d06cc82`, worktree `…/.claude/worktrees/agent-a7fe313c4fcca5531`,
  `pnpm build` green (web + server), plain-HTTP server instances on ports
  5301 (driven by Chrome) and 5302 (profiler instance), scratch studio homes.
- Chrome 152 (system Chromium via the DevTools MCP), window 1920×1080.
- Document authoring: `scripts/perf-profile/seed-docs.mjs` — 510 objects
  (all four tiers) seeded through the public API in ~2.2 s at concurrency 8.
- Pan/zoom drove the REAL store→rAF pipeline: `__canvasDriveCamera` (the
  `?probe=canvas` seam, 6 camera sets per frame for 2 s) and synthetic
  wheel events on the viewport (the d3-zoom gesture path, 2 notches/frame
  for 2 s, band-crossing sweeps). FPS = delivered rAF frames; long tasks via
  `PerformanceObserver('longtask')` installed before app scripts.

## Cold boot (empty canvas)

Cache-cold navigation to the launcher: **LCP 625 ms, CLS 0.00, TTFB 5 ms**;
DCL 79 ms, FCP 144 ms; no render-blocking findings; a boot-time
forced-reflow insight exists but with 0 ms estimated savings. Warm boot LCP
633 ms. Empty-canvas DOM is 229 nodes, JS heap ~5 MB **[MEAS]**. The app
boot spends its LCP render-delay budget (~620 ms) on JS evaluation of the
609 KB (185 KB gzip) CanvasApp chunk — flagged by Vite as >500 kB, worth a
lazy-import pass someday but not a density concern.

## The density matrix (v2 runs, untraced, 1920×1080)

Boot camera is the default (k=0.9); "fit" is zoom-to-fit (clamps at
CAMERA_MIN_K=0.18 **[DOC]** `camera.ts:19`). At 300 objects the 4-row grid is
75 columns wide — wider than the screen even at minimum zoom — so culling
holds the mounted set at ~156: *the "everything visible at once" state is
unreachable at 300 by design*, which is what actually protects the DOM.

| Tier | boot→ready (ms) | tiles mounted default / fit | videos+images mounted at fit | DOM nodes at fit | JS heap used (MB) | pan FPS @ fit | frames >25 ms | renders/pan | zoom FPS | click→select (ms) | fork menu (ms) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 10 | 550 | 10 / 10 | 6 + 4 | 219 | 20 | 61 | 0 | 3 | 57 | 10.4 | 33.7 |
| 50 | 497 | 24 / 50 | 28 + 22 | 409 | 5 | 57 | 5 | 10 | 49.5 | 12.9 | 33.3 |
| 150 | 540 | 24 / 150 | 83 + 67 | 1009 | 6 | 50.5 | 13 | 22 | 45.5 | 12.4 | 38.0 |
| 300 | 554 | 24 / 156 | 93 + 63 | 1045 | 7 | 44 | 34 | 37 | 49.5 | 15.0 | 32.3 |

Observations that matter:

- **Boot-to-ready is density-flat** (497–554 ms across all tiers): the
  document GET + `deriveTiles` + first culling of a 300-object document add
  <60 ms over the empty case; the default camera mounts the same 24 tiles at
  every tier. The O(N) projection cost is real but tiny at these N **[MEAS]**.
- **Decode behavior — the foundation pass's density test:** every mounted
  video tile is its own unpooled `<video preload="metadata">` whose `src` is
  the content-addressed blob route (served `application/octet-stream`;
  Chrome sniffs the container and plays fine — 24-frame first-frame decode
  everywhere). All mounted videos reach `readyState 4`, paused, 0 dropped
  frames, at every tier up to 93 simultaneous elements **[MEAS]**. Two
  caveats: (a) metadata loads queue on Chrome's 6-connections-per-origin
  pool — right after a fit that mounts 93 videos, most sit at `readyState 0`
  and resolve over the following seconds (visible as slow poster fill-in);
  (b) the pooling/PreviewSource machinery (`PooledVideoCard`,
  `FilmstripPoster`) serves the *filmstrip* path only — blob-backed tiles
  never go through it **[DOC]** `Tile.tsx:60-70`. At today's scale that's
  fine; it is the seam to revisit if tiles ever *play* at density.
- **No >50 ms long task during pan or zoom at any tier.** The only 50–230 ms
  tasks in the whole matrix are overlay opens (timeline/library at 150/300)
  and the media-load burst right after fit **[MEAS]**.
- **The transient discipline holds at density**: pan renders counted 3–37 per
  2 s — all cull-set changes, never per-frame. Zoom sweeps across all three
  semantic bands cost 7–15 renders total (band swap = one render by design).
- **JS heap is small and stable** (5–7 MB used steady-state; total spikes to
  ~80 MB during video-load bursts then settles). Heap snapshot at 300-fit:
  12.5 MiB self across 534 K nodes — largest single class is
  `ExternalStringData` 1.76 MiB; each `<video>` carries a shadow
  media-controls DOM tree (small, but present per element). Media bytes live
  in the browser's media cache, outside JS heap **[MEAS]**.
- **Instrumentation honesty**: the same 300-tier pan under an active DevTools
  trace runs 21.7 FPS vs 42.5 untraced — tracing roughly halves this
  workload's FPS, so untraced numbers are the real ones. The trace file
  confirmed the story qualitatively (long tasks only in overlay opens) but
  raw-trace flame graphs were not persisted by the MCP; the recorded
  evidence is the inline summaries + the in-page observers.

## Overlays and interactions at density

| Surface | 10 | 150 | 300 |
|---|---|---|---|
| Timeline (V) open | 49 ms / 10 items | 201 ms / 150 | 453 ms / 300 (229 ms = one long task) |
| Library (V×2) open | 41 ms / 10 rows | 87 ms / 150 rows | 228 ms / 300 rows |
| Library search settle | 24 ms | 50 ms (150→83 rows) | 128 ms (300→165 rows) |
| ⌘K index open + search | — | — | 51 ms open, 29 ms search |

The library/timeline/index overlays render **unvirtualized lists**; at 300
items the open cost crosses the long-task line (50–229 ms). Search itself is
cheap (client filter + 200 ms-debounced FTS widen). Click→tile-select stays
10–15 ms and the fork menu (B) 32–40 ms at every tier — selection latency is
density-immune **[MEAS]**.

## Server side (CPU/heap profile + bursts)

CRUD throughput at density (concurrency 8, 510 objects): blob ingest (hash +
content-addressed copy) p50 12.4 / p95 32.7 ms; chain create 4.2/14.1;
output create 3.4/9.4; take append 3.8/11.8 ms **[MEAS]**. Autosave churn
(session + camera-view writes, the persistView path) p50 1.4 ms. FTS search
on the 300-object DB: p50 1.6–1.9 ms, p95 ≤2.9 ms over 150 queries.
Filmstrip sheet generation: 90 ms first-hit for a 2 s clip (76 KB PNG), 82 ms
cached re-fetch (ETag + 24 h) — and the canvas never requests one for
blob-backed tiles.

- **Blob serving scales**: 480 requests at 16× concurrency → 1182–1226 rps,
  p50 ~11 ms, p99 42–57 ms. Streaming file reads are effectively free of the
  document-path contention **[MEAS]**.
- **Project document reads don't** (the finding of the run): 240 GETs of the
  300-object document at 16× → 78 rps, p50 176–178 ms, p99 389–402 ms,
  reproduced twice. The CPU profile names the cost precisely: of ~3.7 s busy
  main-thread time during the burst, 1.43 s self in the anonymous row
  hydrator at `dist-server/server/documents.js:1284` (the
  `getProjectDocument` fold), 641 ms in `hydrateOutput`, 288 ms `parseJson`,
  162 ms `getProjectDocument`, plus 365 ms `sendJson` serializing the 382 KiB
  payload — synchronous, single-threaded, serialized per request
  **[MEAS + profile]**. The heap profile shows no runaway allocation (8.6 MiB
  sampled across the whole run — the server holds steady; this is a CPU
  shape problem, not a memory problem).
- **WS fan-out on batch takes: zero messages.** Eight `/ws` clients received
  exactly the fabric hello; 50 take appends published nothing. This is by
  design — the fabric's channels are `job | telemetry | llm | engine |
  system`; there is no document channel **[DOC]** `server/realtime.ts:9`.
  Consequence: connected clients cost nothing on document writes today, and
  the canvas learns about takes through job lifecycle events + reloads. The
  fan-out bill arrives with generation traffic (job channel), which is
  engine work and out of this profile's scope.

## What came up clean (measured, not assumed)

- **Viewport culling + `content-visibility` hold at every tier**: worst
  mounted state is 156 tiles / 1,199 DOM nodes; the default camera mounts 24
  regardless of document size.
- **Zero React renders per pan frame** at any density (the `data-canvas-
  renders` canary moved only on cull-set changes) — the Phase-1 transient
  discipline survives contact with real media at 300 objects.
- **No >50 ms long task during pan/zoom at any tier** — the surface stays
  responsive even where FPS softens.
- **Selection and menu interactions are density-flat** (10–15 ms click,
  32–40 ms fork menu).
- **Blob serving, FTS, autosave, filmstrip: all cheap or scalable** as
  measured above.
- **JS heap: no leak signal** within a session (settles back after bursts).

## Ranked improvement list

Each item: measured cost → root cause (evidence) → estimated win → risk.

1. **Serve the hydrated project document without re-hydrating per request**
   (server). Cost: p50 176 ms / p99 402 ms at 16× on 300 objects; 78 rps
   ceiling. Cause: synchronous `parseJson` + `hydrateOutput` per GET
   (CPU profile: `documents.js:1284` + `hydrateOutput` ≈ 2.2 s of a 3.7 s
   burst). Win: an order of magnitude under concurrency (cache the hydrated
   JSON keyed on a write sequence, or add ETag/304 so unchanged polls are
   free — the SPA re-fetches the full document on every op edit/landing).
   Risk: low — read-path only; invalidate on any write to the project.
2. **Virtualize the timeline and library overlays** (SPA). Cost: 453 ms open
   + a 229 ms long task (timeline), 228 ms (library) at 300. Cause:
   unvirtualized list render of all items in one commit. Win: opens back
   under ~100 ms, long task gone. Risk: low — both lists already key rows
   and navigate by id.
3. **Throttle the cull-set recompute to one per frame** (SPA). Cost: pan
   renders grow linearly with density (37 per 2 s at 300) because
   `recomputeView` runs per `camera.set` — the pan drive issues 6 sets per
   frame, so up to 6 O(N) recomputes + signature joins per frame
   (`Substrate.tsx:75-92` **[DOC]**). Win: fewer mid-pan React commits —
   the >25 ms frames at 300 (34/2 s) should drop several-fold. Risk:
   medium — culling must never lag a frame or tiles pop in at pan edges;
   coalesce to the rAF applier, not to a timer.
4. **Poster-first video tiles** (SPA). Cost: after a fit that mounts ~93
   videos, metadata loads queue 6-at-a-time on the origin's connection
   budget; posters fill in over seconds. Cause: `<video preload="metadata">`
   per tile with no poster attribute (`Tile.tsx:69`). Win: instant visual
   completeness after zoom-outs (serve a poster frame — the filmstrip
   machinery can make one — and demote video elements to the near band or
   an intersection gate). Risk: low; keeps decode count bounded if tiles
   ever start playing.
5. **Cut the per-edit full-document reload** (SPA+server). Cost: every op
   edit / take landing re-GETs the whole document (382 KiB at 300; measured
   cheap single-shot at 15 ms but it multiplies with edit bursts and is the
   same serialized path as item 1). Win: with item 1's ETag/cache this
   becomes nearly free; a delta API is the bigger step. Risk: medium —
   correctness depends on consistent versioning; ship after item 1.
6. **Lazy-import the CanvasApp chunk** (SPA). Cost: 609 KB (185 KB gzip)
   evaluated before first paint (LCP render-delay dominated). Win: modest
   boot win (tens of ms locally; more on slow links). Risk: low.

## Verdict table

| Claim | Verdict | Evidence |
|---|---|---|
| Dense video/image canvas (≤300 objects) is usable — pan stays ≥44 FPS, no >50 ms tasks during navigation | **CONFIRM** | density matrix, untraced, real media |
| Simultaneous decode is the first binder at density | **REFUTE** | 93 paused videos, all readyState 4, 0 dropped frames |
| The culling + transient-discipline design holds at 300 real media objects | **CONFIRM** | ≤156 mounted tiles; zero per-frame renders |
| The server document-read path is the first hard cliff | **CONFIRM (new)** | 78 rps / p99 400 ms at 16×; CPU profile hotspot |
| Overlay surfaces need virtualization before 300+ objects | **CONFIRM (new)** | timeline 453 ms / 229 ms long task |
| WS fan-out is a density risk for document writes | **REFUTE (by design)** | no document channel on the fabric; zero messages |

Corrections arrive as dated addenda — never silent rewrites. Re-run this
profile (harness: `scripts/perf-profile/`) whenever the substrate, tile
anatomy, or document hydration path changes materially.

## Addendum 2026-09-17 — improvement wave 1 landed (task pq7d48a)

**MEASURED** before/after with this same harness, same box, same seeded data
(the 300-tier home was copied byte-for-byte between arms; 240-GET bursts at
16× concurrency, V/V×2 overlay opens via real keydowns, untraced pan drives
at zoom-to-fit). The three top recommendations shipped:

| Metric (300 objects) | Before | After | Verdict |
|---|---|---|---|
| Project GET burst p99 / p50 / rps | 439 / 193 ms / 71 | **31 / 16 ms / 894** | rec 1 **landed** (target was <100 ms p99) |
| Timeline (V) open / max long task | 330/328/195 ms / 99–147 ms | **24–63 ms / 0 ms** | rec 2 **landed** (6 slots mounted, scroll-windowed) |
| Library (V×2) open / max long task | 111–158 ms / 83–131 ms | **28–48 ms / 0 ms** | rec 2 **landed** (28 rows mounted, scroll-windowed) |
| Pan renders / 2 s | 26–28 | 27–30 | rec 3 landed; see honest note |
| Pan fps / >25 ms frames | 30.5–51 / 47,17 | 31.5–60.5 / 44,9,0 | rec 3 landed; directionally better, not several-fold |

How (all **[DOC]** in shipped code, tests in `scripts/test-documents.cjs` §j):

1. **Document-read cache + ETag** (`server/documents.ts`
   `getProjectDocumentCached`, `server/core.ts` route, `src/canvas/api.ts`
   conditional re-fetch): the hydrated document is folded once per
   write-generation and served as a pre-serialized body with a content-hash
   ETag; unchanged re-reads hit the cache and matching `If-None-Match`
   answers 304. Invalidation is FAIL-CLOSED, not seam-enumerated: the
   freshness stamp is (PRAGMA data_version, total_changes()) — own-connection
   writes bump the latter, any other connection's commits bump the former,
   so NO write path can serve a stale document (the test walks every
   mutation route + an external-connection write). The price — a rebuild
   after unrelated-table writes — equals the old uncached behavior.
2. **Overlay windowing** (`src/canvas/useWindowedList.ts` + the two
   overlays): uniform-cell scroll windows with runtime-measured pitch and
   spacer padding, the substrate-culling philosophy applied to 1-D lists.
   Lists at or below the probe size (16) render whole — small-fixture
   e2e/vision behavior unchanged.
3. **Cull-recompute coalescing** (`src/canvas/Substrate.tsx`): the O(N)
   cull recompute runs once per frame on the rAF applier (latest-state-wins,
   never a timer) instead of once per camera.set (up to 6×/frame).
   **Honest correction of rec 3's estimate:** the predicted several-fold
   drop in >25 ms frames did not materialize — React already batched the
   per-set state updates, and the surviving >25 ms frames are dominated by
   the commit + video-element work of GENUINE cull-set changes (each a real
   membership change; suppressing them would pop tiles at pan edges). The
   correctness property is proven: after motion stops the mounted set is
   already final.

Also fixed here: `scripts/perf-profile/gen-media.sh` shipped with an
unbalanced quote in its `cd` line (never ran as committed); the timeline
projection at this tier counts **250** items, not 300 — the load driver's
phase-5 fanout-probe takes (empty artifacts) auto-become canonical on the
first 50 chains and drop out of the chronology projection while the library
keeps them as priors (300 rows). Both arms of every comparison above share
that state.
