# Canvas high-zoom fidelity — the max-zoom tile-blur diagnosis and fix

Task 1gpydky (epic 4lphxv8) · 2026-09-22 · METHOD: code-read of the substrate
and tile media path (Substrate.tsx, cameraDom.ts, camera.ts, canvas.css,
Tile.tsx, PooledVideoCard.tsx, PreviewSource.ts, filmstripLayout.ts,
derive.ts), Chromium raster behavior checked against Chrome Developers
documentation (not memory), and measured — e2e DOM-truth on the promotion
lifecycle, the render canary before/after, and a vision A/B pair of
zoom-sweep bundles (min 0.18 / 0.5 / 1 / 2 / max 4) judged by a scoped
sonnet judge per scripts/vision-e2e/JUDGE.md.

## The symptom

Maintainer, live session 2026-09-22: "zooming into a node at max zoom makes
it quite blurry." Whole-tile blur at high k — chrome included, worst at the
CAMERA_MAX_K = 4 extreme.

## The differential (three classic sources, each checked)

1. **Composited-layer rasterization — CONFIRMED, primary.** `.canvas-world`
   carried `will-change: transform` for the element's life (canvas.css, plus
   an explanatory comment in cameraDom.ts) [DOC]. Chromium re-rasters a
   composited layer when its transform scale changes **only when it does not
   have `will-change: transform`** — the property is an explicit promise
   that the transform will animate, so the compositor keeps one cached raster
   and GPU-scales it instead of re-rastering mid-animation [DOC: Chrome
   Developers, "Rasterization & will-change: transform" sample; the
   "Rationalizing composited content raster behavior" design doc]. A world
   promoted at k≈0.9 therefore rasterized once and was then stretched to 4×:
   every DOM pixel on every tile — text, borders, chips — rendered from a
   ~4.4×-upscaled texture. This alone explains "quite blurry at max zoom".
2. **Tile media resolution — SECONDARY, bounded, mostly already right.**
   Landed takes render their FULL-resolution blob artifact directly
   (`<img>`, or a paused `<video>` frame 0) [DOC: Tile.tsx `TilePreview`];
   dropped files render the dropped bytes (object URL). The only low-res
   path is the filmstrip sprite fallback — 160px cells
   (`FILMSTRIP_CELL_WIDTH`) [DOC: filmstripLayout.ts] — shown only
   pre-artifact (no blob yet). At k=4 a 320-world-px card is 1280 screen px:
   full-res sources are mildly upscaled (source-limited), the 160px cell
   fallback is ~7.5× upscaled (visibly soft).
3. **Rasterized text under transform — NOT PRESENT on tiles.** Tile text is
   live DOM; edges are SVG vector; the radar lives in the titlebar
   (screen-space, never zoomed); no canvas-drawn text exists on tiles [DOC].

## The fix — gesture-scoped layer promotion

`will-change: transform` is now owned by the rAF applier in cameraDom.ts,
not the stylesheet: **on** while the camera moves (pan/zoom stays a pure
compositor operation — the 60fps path is unchanged), **dropped ~200ms after
the last applied transform** (`PROMOTION_SETTLE_MS`), which is the signal
Chromium needs to re-raster the world at the settled scale. Chrome and text
render pixel-crisp at every k including 4×; the re-raster cost is one
repaint of the mounted (culled) set per gesture end — the same repaint class
as a band-swap render, per-gesture, never per-frame. The idle state is
unpromoted (crisp at rest), and `detach` clears the settle timer.

The original permanent promotion was a deliberate jank choice ("one-time
layer promotion beats per-frame promotion churn") [DOC: prior cameraDom.ts
comment] — correct about per-FRAME churn, wrong about permanence: the
per-GESTURE scope keeps the win and gives up the stale raster.

## The trade, named honestly

Media may soften at extreme zoom when its source resolution is the limit —
that is inherent to the bytes, not the camera. No per-band source ladder was
added: the common case (a landed take) already serves the full-resolution
artifact, and the 160px filmstrip cell is a transient pre-landing state;
welding a srcset/band ladder for it would violate the modularity contract
for a state the user passes through. If crisper pre-landing thumbs at high k
are ever wanted, the cheap levers are a larger `FILMSTRIP_CELL_WIDTH` or a
near-band swap to the artifact once it exists — recorded here as the future
option, deliberately not built.

## Verification

- e2e (canvas.spec.ts): a new lifecycle test asserts the contract as DOM
  truth — idle `willChange === ''`, during synthetic AND real wheel motion
  `=== 'transform'`, settled `=== ''` again — with the render canary FLAT
  across the whole promote/demote cycle (zero React renders).
- The pre-existing zero-render canary passes before AND after the change.
- Vision A/B: the `canvas-high-zoom-sweep` scenario captures one tile
  centered at k = 0.18 / 0.5 / 1 / 2 / 4; the rubrics make chrome crispness
  (titlebar-comparable sharpness) the contract and bless media softness.
  Bundles: before `20260922-094933-3342439-tjvl`, after
  `20260922-095335-3348112-7ov4` (scoped judge verdicts in-bundle;
  per-checkpoint tables in the Flux task).
- camera/canvas unit suites, typecheck, eslint, stylelint: green.

## Verdict table

| Claim | Verdict | Evidence |
| --- | --- | --- |
| Permanent `will-change: transform` on the world was the blur | **CONFIRMED** | [DOC] CSS + cameraDom before/after; [DOC] Chrome re-raster rule; A/B vision bundles |
| Gesture-scoped promotion keeps pan/zoom compositor-fast | **CONFIRMED** (local) | zero-render canary + lifecycle test; no jank telemetry exists to measure farther — [SPEC] that 200ms feels immediate |
| Landed-take media is full-resolution by construction | **CONFIRMED** | [DOC] Tile.tsx artifact paths |
| Filmstrip fallback (160px cells) is the only soft media | **CONFIRMED** | [DOC] filmstripLayout.ts + Tile.tsx fallback order |
| No rasterized text on tiles | **CONFIRMED** | [DOC] component scan |
| The running-status pulse ring keeps its own animating layer while generating | observed design note — a 2px decorative border on running tiles only; re-rasters with the world at settle once the animation ends | [COMM]/[SPEC] |

Corrections arrive as dated addenda below — never silent rewrites.
