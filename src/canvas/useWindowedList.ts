/**
 * Canvas perf wave 1 — windowed list mounting for the overlay projections
 * (timeline strip, library rows), from docs/research/app-performance-profile.md
 * rec 2: at 300 objects both overlays rendered every row in one React
 * commit (timeline open 453 ms with a 229 ms long task; library 228 ms).
 *
 * Same philosophy as the substrate's viewport culling, applied to a 1-D
 * uniform-cell list: mount only the window [start, end) around the scroll
 * position and carry the unmounted extent as spacer padding, so the
 * scrollbar geometry is preserved exactly. Cells are MEASURED at runtime
 * (outer pitch between probe siblings), never hard-coded — CSS changes
 * cannot silently desync the math.
 *
 * Until measurement lands (first open), a probe batch renders so the list
 * is usable and measurable; lists at or below the probe size render whole
 * and behave exactly like the unvirtualized list.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

export type WindowedRange = {
  start: number
  end: number
  padStartPx: number
  padEndPx: number
  /** False until a uniform pitch has been measured from real cells. */
  measured: boolean
}

export type WindowedList = {
  /** Attach to the scrolling container element. */
  containerRef: (node: HTMLElement | null) => void
  /** Attach to the rendered item batch (the probe or the live window). */
  itemsRef: (node: HTMLElement | null) => void
  onScroll: () => void
  range: WindowedRange
}

const DEFAULT_OVERSCAN_PX = 400

/** Windowed mounting for one uniform-cell list. `axis` picks the measured
 *  pitch dimension and the scroll offset used for the window math. */
export function useWindowedList(options: { count: number; axis: 'x' | 'y'; probeCount?: number; overscanPx?: number }): WindowedList {
  const { count, axis } = options
  const probeCount = Math.max(1, options.probeCount ?? 16)
  const overscanPx = options.overscanPx ?? DEFAULT_OVERSCAN_PX

  const containerNodeRef = useRef<HTMLElement | null>(null)
  const itemsNodeRef = useRef<HTMLElement | null>(null)
  const [cellPx, setCellPx] = useState(0)
  const [viewportPx, setViewportPx] = useState(0)
  const [scrollPx, setScrollPx] = useState(0)

  /** Measure the uniform cell pitch from the mounted batch. The FIRST PAIR
   *  of siblings is the measurement basis (their delta), not a
   *  batch-average: a list whose final cell legitimately differs (the
   *  timeline's last slot has no trailing gap) must not skew the pitch when
   *  the live window reaches the tail. A single mounted cell falls back to
   *  its own outer size. Margins collapse into the pitch. */
  const measure = useCallback(() => {
    const positionOf = (element: Element) => (axis === 'x' ? (element as HTMLElement).offsetLeft : (element as HTMLElement).offsetTop)
    const items = itemsNodeRef.current
    const mounted = items ? items.children.length : 0
    if (mounted >= 2 && items) {
      const delta = positionOf(items.children[1]) - positionOf(items.children[0])
      if (delta > 0 && Number.isFinite(delta)) setCellPx((current) => (Math.abs(current - delta) > 0.5 ? delta : current))
    } else if (mounted === 1 && items) {
      const only = items.children[0] as HTMLElement
      const size = axis === 'x' ? only.offsetWidth : only.offsetHeight
      if (size > 0) setCellPx((current) => (Math.abs(current - size) > 0.5 ? size : current))
    }
    const container = containerNodeRef.current
    if (container) {
      const size = axis === 'x' ? container.clientWidth : container.clientHeight
      setViewportPx((current) => (Math.abs(current - size) > 0.5 ? size : current))
    }
  }, [axis])

  const containerRef = useCallback((node: HTMLElement | null) => {
    containerNodeRef.current = node
    if (node) {
      // Re-attach (overlay reopened): the scroll offset resets with the
      // element — re-sync state so the window is computed from reality.
      const next = axis === 'x' ? node.scrollLeft : node.scrollTop
      setScrollPx(next)
      measure()
    }
  }, [axis, measure])

  const itemsRef = useCallback((node: HTMLElement | null) => {
    itemsNodeRef.current = node
    if (node) measure()
  }, [measure])

  const onScroll = useCallback(() => {
    const container = containerNodeRef.current
    if (!container) return
    const next = axis === 'x' ? container.scrollLeft : container.scrollTop
    setScrollPx(next)
  }, [axis])

  // Re-derive after count changes (filters, search): the browser clamps the
  // scroll offset to the shrunken content, so re-read it post-paint.
  useEffect(() => {
    const container = containerNodeRef.current
    if (!container) return
    const next = axis === 'x' ? container.scrollLeft : container.scrollTop
    setScrollPx((current) => (current === next ? current : next))
    measure()
  }, [count, axis, measure])

  const rangeFor = (cell: number, viewport: number, scroll: number): WindowedRange => {
    if (!cell || !viewport || count <= 0) {
      return { start: 0, end: Math.min(count, probeCount), padStartPx: 0, padEndPx: 0, measured: false }
    }
    const first = Math.floor(scroll / cell)
    const last = Math.ceil((scroll + viewport) / cell)
    const overscan = Math.ceil(overscanPx / cell)
    const end = Math.min(count, last + overscan)
    const start = Math.max(0, Math.min(first - overscan, end - 1))
    return {
      start,
      end,
      padStartPx: start * cell,
      padEndPx: (count - end) * cell,
      measured: true,
    }
  }

  const measuredRange = rangeFor(cellPx, viewportPx, scrollPx)
  // Unmeasured: the probe batch, unpadded — the list looks short for one
  // frame while measurement lands, then the window + spacers take over.
  const range = measuredRange.measured
    ? measuredRange
    : { start: 0, end: Math.min(count, probeCount), padStartPx: 0, padEndPx: 0, measured: false }

  return { containerRef, itemsRef, onScroll, range }
}
