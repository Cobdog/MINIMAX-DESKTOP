/**
 * Canvas Phase 1 — the camera (§3 substrate).
 *
 * A plain observable store that lives OUTSIDE React, plus the pure math the
 * substrate runs on it (semantic-zoom bands, viewport culling, coordinate
 * transforms). d3-zoom (cameraDom.ts) is the only writer of camera state; the
 * only reader that runs per-frame is the rAF transform applier. React may
 * subscribe ONLY through band/culled-set transitions (Substrate.tsx) — a raw
 * per-frame subscription would reintroduce renders into the pan/zoom path and
 * void the transient discipline the spec locks.
 *
 * Pure module by design: no React, no DOM — covered by scripts/test-canvas.cjs
 * through the VM harness.
 */

/** translate + uniform scale; world = screen → (screen - t) / k. */
export type CameraState = { x: number; y: number; k: number }

export const CAMERA_MIN_K = 0.18
export const CAMERA_MAX_K = 4

/** World-space rectangle. */
export type WorldRect = { x: number; y: number; w: number; h: number }

/**
 * Semantic-zoom bands AS DATA (§3: "content swap by zoom band — the culling
 * and LOD are one mechanism"). `upTo` is exclusive on k. Far = thumbnail +
 * status ring; mid = + metadata strip + op chips; near = + latent blocks +
 * take strip. The ids and thresholds are consumed verbatim by Tile.tsx and
 * the unit tests; changing a threshold is a data change, not a code change.
 */
export const ZOOM_BANDS: ReadonlyArray<{ id: ZoomBand; upTo: number }> = [
  { id: 'far', upTo: 0.45 },
  { id: 'mid', upTo: 1.05 },
  { id: 'near', upTo: Number.POSITIVE_INFINITY },
]

export type ZoomBand = 'far' | 'mid' | 'near'

export function bandFor(k: number): ZoomBand {
  for (const band of ZOOM_BANDS) {
    if (k < band.upTo) return band.id
  }
  return 'near'
}

export function clampK(k: number): number {
  return Math.min(CAMERA_MAX_K, Math.max(CAMERA_MIN_K, k))
}

// ---- coordinate transforms -------------------------------------------------

export function screenToWorld(sx: number, sy: number, camera: CameraState): { x: number; y: number } {
  return { x: (sx - camera.x) / camera.k, y: (sy - camera.y) / camera.k }
}

export function worldToScreen(wx: number, wy: number, camera: CameraState): { x: number; y: number } {
  return { x: wx * camera.k + camera.x, y: wy * camera.k + camera.y }
}

/**
 * The visible world rectangle for a camera over a `width × height` viewport,
 * expanded by `marginPx` SCREEN pixels on every side (the screen→world
 * conversion applies the 1/k exactly once, so the margin is what the user
 * perceives — tiles enter the DOM before they are on screen at every zoom).
 */
export function visibleWorldRect(camera: CameraState, width: number, height: number, marginPx: number): WorldRect {
  const min = screenToWorld(-marginPx, -marginPx, camera)
  const max = screenToWorld(width + marginPx, height + marginPx, camera)
  return { x: min.x, y: min.y, w: max.x - min.x, h: max.y - min.y }
}

export function rectsIntersect(a: WorldRect, b: WorldRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

export function rectCenterPoint(rect: WorldRect): { x: number; y: number; h: number } {
  return { x: rect.x, y: rect.y, h: rect.h }
}

/** Culling set: the ids of tiles whose rects intersect the visible rect.
 *  Order follows the input (stable — React reconciliation keys stay put). */
export function visibleTileIds(
  tiles: ReadonlyArray<{ id: string; x: number; y: number; w: number; h: number }>,
  camera: CameraState,
  width: number,
  height: number,
  marginPx: number,
): string[] {
  const rect = visibleWorldRect(camera, width, height, marginPx)
  const ids: string[] = []
  for (const tile of tiles) {
    if (rectsIntersect(rect, { x: tile.x, y: tile.y, w: tile.w, h: tile.h })) ids.push(tile.id)
  }
  return ids
}

/**
 * A camera that centers `worldRect` at zoom k (zoom-to-attention /
 * navigate-to-region / zoom-to-fit share this). The rect is fitted with
 * padding when `fit` — the returned k never leaves the clamp.
 */
export function cameraForRect(rect: WorldRect, width: number, height: number, opts?: { fit?: boolean; paddingPx?: number; k?: number }): CameraState {
  const padding = opts?.paddingPx ?? 160
  if (opts?.fit) {
    const k = clampK(Math.min((width - padding) / Math.max(1, rect.w), (height - padding) / Math.max(1, rect.h)))
    return { k, x: width / 2 - (rect.x + rect.w / 2) * k, y: height / 2 - (rect.y + rect.h / 2) * k }
  }
  const k = clampK(opts?.k ?? 1)
  return { k, x: width / 2 - (rect.x + rect.w / 2) * k, y: height / 2 - (rect.y + rect.h / 2) * k }
}

/** Zoom by `factor` about a screen point (buttons and cursor zoom share it). */
export function zoomAbout(current: CameraState, factor: number, cx: number, cy: number): CameraState {
  const k = clampK(current.k * factor)
  const ratio = k / current.k
  return { k, x: cx - (cx - current.x) * ratio, y: cy - (cy - current.y) * ratio }
}

// ---- the store --------------------------------------------------------------

export type Unsubscribe = () => void

/** Minimal observable: get/set/subscribe. `set` notifies synchronously (the
 *  per-frame subscribers are exactly one rAF applier plus O(1) signature
 *  checkers); a batched `set` is offered for programmatic sweeps. */
export type CameraStore = {
  get(): CameraState
  set(next: CameraState): void
  subscribe(listener: (state: CameraState) => void): Unsubscribe
  /** Notify once after applying `mutate` — programmatic multi-field moves. */
  batch(mutate: (current: CameraState) => CameraState): void
}

export function createCamera(initial?: Partial<CameraState>): CameraStore {
  let state: CameraState = { x: initial?.x ?? 60, y: initial?.y ?? 40, k: clampK(initial?.k ?? 0.9) }
  const listeners = new Set<(state: CameraState) => void>()
  const notify = () => {
    // forEach, not for…of/spread: the VM test harness transpiles to an ES3
    // target where iterator spreads lose their helpers (harness rule).
    listeners.forEach((listener) => listener(state))
  }
  return {
    get: () => state,
    set: (next) => {
      const k = clampK(next.k)
      const merged = { x: next.x, y: next.y, k }
      if (merged.x === state.x && merged.y === state.y && merged.k === state.k) return
      state = merged
      notify()
    },
    batch: (mutate) => {
      const next = mutate(state)
      if (next.x === state.x && next.y === state.y && next.k === state.k) return
      state = { x: next.x, y: next.y, k: clampK(next.k) }
      notify()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/** Parses a persisted project view blob (`camera_json`) tolerantly — a
 *  missing/corrupt blob yields the default camera and no layout (a blob is
 *  view state, never worth a crash). */
export type ViewBlob = { camera?: Partial<CameraState>; layout?: Record<string, { x: number; y: number; w?: number }> }

export function parseViewBlob(raw: unknown): { camera: CameraState; layout: ViewBlob['layout'] } {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const cameraRaw = source.camera && typeof source.camera === 'object' ? (source.camera as Record<string, unknown>) : source
  const numOr = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
  const layout: ViewBlob['layout'] = {}
  if (source.layout && typeof source.layout === 'object' && !Array.isArray(source.layout)) {
    for (const [id, place] of Object.entries(source.layout as Record<string, unknown>)) {
      if (!place || typeof place !== 'object' || Array.isArray(place)) continue
      const record = place as Record<string, unknown>
      const x = numOr(record.x, Number.NaN)
      const y = numOr(record.y, Number.NaN)
      if (Number.isFinite(x) && Number.isFinite(y)) layout[id] = { x, y, w: typeof record.w === 'number' && record.w > 0 ? record.w : undefined }
    }
  }
  return {
    camera: { x: numOr(cameraRaw.x, 60), y: numOr(cameraRaw.y, 40), k: clampK(numOr(cameraRaw.k, 0.9)) },
    layout: Object.keys(layout).length ? layout : undefined,
  }
}
