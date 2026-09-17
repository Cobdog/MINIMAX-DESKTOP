/** The wave-2a transient-update probe pair, mounted in the app root
 *  (CanvasApp — the Create view carried it until Phase 5 deleted that shell)
 *  when `?probe=transient` is present (see transientProbe.ts for the discipline
 *  and the driver). A "mover" element whose transform is written directly
 *  from the probe store's subscription (never React), beside a sibling that
 *  renders `data-render-count` — a canary for any re-render of the
 *  surrounding tree. */
import { useRef } from 'react'
// Side-effect import: binds window.__studioDriveTransient when (and only
// when) the URL carries ?probe=transient — the e2e driver. Carried by the
// old Create view's own import until Phase 5; the probe pair is its home now.
import './transientProbe'

/** Module-scoped so StrictMode's double render is visible but harmless — the
 *  assertion that matters is before/after equality around a drive, not the
 *  absolute count. */
let transientProbeRenders = 0

/** Not memoized ON PURPOSE: any re-render of an ancestor re-renders this
 *  component and bumps the counter — that is the signal. */
export function TransientProbe() {
  transientProbeRenders += 1
  const moverRef = useRef<HTMLDivElement | null>(null)
  return (
    <div data-transient-probe="root" hidden aria-hidden="true">
      <div ref={moverRef} data-transient-probe="mover" style={{ transform: 'translateX(0px)', width: '8px', height: '8px' }} />
      <div data-transient-probe="counter" data-render-count={transientProbeRenders} />
    </div>
  )
}
