/** Floating-dock default geometry (review M10/M11, 2026-09-19).
 *
 *  Clamp: the docks' hardcoded defaults (720–880 px wide at x≈96–160) sail
 *  past narrow viewports — at a 640 px window the close button landed 188 px
 *  off-screen and the dock could not be closed without dragging it into
 *  view first. Width clamps to the viewport minus a 24 px margin; x/y clamp
 *  so the dock's right/bottom edge (close button included) stays inside the
 *  window. (Together with canvas-root's `overflow: clip` — a programmatically
 *  scrolled hidden root used to slide the whole app sideways and hang the
 *  docks off the left edge even when their position was correct.)
 *
 *  Cascade contract: the three docks' preferred rectangles step by
 *  (+180, +48) — Settings (120,96), Studios (300,144), Diagnostics
 *  (480,192). The y step exceeds the ~40 px header height, so when the
 *  docks are opened in the natural order every dock's header band sits
 *  below every earlier dock's header and above every later dock's top:
 *  all three titles stay visible. A dock opened LATER covers earlier
 *  headers within its rectangle (standard window-manager cascade) —
 *  grabbing any exposed part raises it (store.raiseDock). Pure — called
 *  once per dock mount with that dock's preferred rectangle. */
export function dockDefaultGeometry(preferred: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } {
  const width = Math.min(preferred.width, Math.max(320, window.innerWidth - 24))
  const height = Math.min(preferred.height, Math.max(240, window.innerHeight - 24))
  const x = Math.max(0, Math.min(preferred.x, window.innerWidth - width - 12))
  const y = Math.max(0, Math.min(preferred.y, window.innerHeight - height - 12))
  return { x, y, width, height }
}
