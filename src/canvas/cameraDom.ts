/**
 * Canvas Phase 1 — camera DOM wiring (§3 substrate).
 *
 * d3-zoom owns the gestures on the viewport element and is the ONLY writer
 * of camera state; one rAF-scheduled applier writes the world transform.
 * Nothing here touches React — attaching returns a detach and a `flyTo` the
 * attention model / index use for zoom-to-attention and navigate-to-region.
 *
 * The pan/zoom zero-render canary follows the transientProbe precedent: when
 * the URL carries ?probe=canvas, `window.__canvasDriveCamera` applies N
 * synthetic camera updates (each through the real store→rAF pipeline) so the
 * e2e suite can assert the world transform moved while the substrate's
 * render counter did not. Shipped but inert in every normal session.
 */
import { select } from 'd3-selection'
import 'd3-transition'
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom'
import { type CameraState, type CameraStore, CAMERA_MAX_K, CAMERA_MIN_K } from './camera'

export const probeEnabled = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('probe') === 'canvas'

export type CameraAttachment = {
  detach(): void
  /** Animated camera move (d3 transition → zoom events → store → rAF apply).
   *  Zero React renders by construction. */
  flyTo(target: CameraState, durationMs?: number): void
  /** Jump without animation (camera restore on open). */
  jumpTo(target: CameraState): void
  /** The number of rAF transform applications so far (canary metric). */
  appliedCount(): number
}

export function attachCamera(viewport: HTMLElement, world: HTMLElement, store: CameraStore): CameraAttachment {
  const selection = select(viewport)
  let behavior: ZoomBehavior<HTMLElement, unknown> | null = null
  let scheduled = false
  let pending: CameraState | null = null
  let applied = 0

  const apply = () => {
    scheduled = false
    const next = pending
    if (!next) return
    pending = null
    // will-change stays on for the element's life: the transform is the
    // hot path (60fps), and a one-time layer promotion beats per-frame
    // promotion churn during pan/zoom.
    world.style.transform = `translate(${next.x}px, ${next.y}px) scale(${next.k})`
    applied += 1
  }

  const unsubscribe = store.subscribe((state) => {
    pending = state
    if (!scheduled) {
      scheduled = true
      requestAnimationFrame(apply)
    }
  })

  const onZoom = (event: { transform: ZoomTransform }) => {
    store.set({ x: event.transform.x, y: event.transform.y, k: event.transform.k })
  }

  behavior = zoom<HTMLElement, unknown>()
    .scaleExtent([CAMERA_MIN_K, CAMERA_MAX_K])
    .on('zoom', onZoom as (event: unknown) => void)
  selection.call(behavior)

  // Jump-to on open (camera restore): rewrite the zoom behavior's transform
  // without a gesture, then apply once through the normal pipeline.
  const jumpTo = (target: CameraState) => {
    if (!behavior) return
    selection.call(behavior.transform, zoomIdentity.translate(target.x, target.y).scale(target.k))
  }

  const flyTo = (target: CameraState, durationMs = 450) => {
    if (!behavior) return
    select(viewport)
      .transition()
      .duration(durationMs)
      .call(behavior.transform, zoomIdentity.translate(target.x, target.y).scale(target.k))
  }

  const detach = () => {
    unsubscribe()
    if (behavior) selection.on('.zoom', null)
    behavior = null
  }

  if (probeEnabled) {
    const drive = (count: number) => {
      const current = store.get()
      const appliedBefore = applied
      for (let index = 1; index <= Math.max(0, count); index += 1) {
        store.set({ x: current.x + index * 3, y: current.y + index, k: current.k })
      }
      // The store notifies synchronously; the rAF applier lands after this
      // function returns — report the pending state honestly.
      return { appliedBefore, appliedAfter: applied, pending: pending !== null }
    }
    Object.defineProperty(window, '__canvasDriveCamera', { configurable: true, value: drive })
  }

  return { detach, flyTo, jumpTo, appliedCount: () => applied }
}
