/** Wave-2a transient-update discipline, made provable: 60fps-class data
 *  (playhead position, scrub, preview pixels) must NEVER enter React state.
 *  This module is the measurement harness —
 *
 *   - a tiny zustand store whose `position` slice is the transient value;
 *   - `window.__studioDriveTransient(count)` (mirroring how the realtime
 *     fabric exposes `window.__minimaxRealtime` diagnostics): applies `count`
 *     store updates; a subscription installed for the duration of the drive
 *     paints each one DIRECTLY onto the probe element's transform (see
 *     TransientProbe.tsx), bypassing React entirely. The e2e suite drives
 *     ~120 updates and asserts the element moved while the sibling's
 *     `data-render-count` did not budge — the automated form of the AC's
 *     "60fps spike, LoAF-verified" claim.
 *
 *  Gating: the driver binds only when the URL carries `?probe=transient`.
 *  Ideally this would be `import.meta.env.DEV`-guarded and tree-shaken from
 *  production like the LoAF observer — but the e2e runs against the
 *  PRODUCTION build (`pnpm build` + the standalone server), so a dev-only
 *  mechanism could never be proven there. The query flag is the compromise:
 *  shipped but inert in every normal session, zero cost when absent. */
import { create } from 'zustand'

export const transientProbeEnabled =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('probe') === 'transient'

/** The transient channel: updated at whatever rate the driver wants; nothing
 *  subscribes to it with a React hook, so updates cannot cause renders. */
const useTransientProbeStore = create<{ position: number }>()(() => ({ position: 0 }))

export type TransientDriveReport = {
  mounted: boolean
  /** Subscriber→DOM writes that landed. */
  applied: number
  from: number
  to: number
}

/** Applies `count` high-frequency store updates; the subscription installed
 *  for the duration of the drive paints each one straight onto the mover's
 *  transform. React is not involved at any point in the pipeline. */
export function driveTransientUpdates(count: number): TransientDriveReport {
  const mover = document.querySelector<HTMLElement>('[data-transient-probe="mover"]')
  if (!mover) return { mounted: false, applied: 0, from: 0, to: useTransientProbeStore.getState().position }
  const from = useTransientProbeStore.getState().position
  let applied = 0
  const unsubscribe = useTransientProbeStore.subscribe((state) => {
    // Direct DOM write — the entire point: no setState, no render, no diff.
    mover.style.transform = `translateX(${state.position}px)`
    applied += 1
  })
  for (let index = 1; index <= Math.max(0, count); index += 1) {
    useTransientProbeStore.setState({ position: from + index })
  }
  unsubscribe()
  return { mounted: true, applied, from, to: useTransientProbeStore.getState().position }
}

if (typeof window !== 'undefined' && transientProbeEnabled) {
  // Diagnostics/tests only — never used for control flow.
  Object.defineProperty(window, '__studioDriveTransient', { configurable: true, value: driveTransientUpdates })
}
