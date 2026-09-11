/** Dev-only Long Animation Frames (LoAF) observer — the first seam of the b7
 *  instrumentation plan. A `long-animation-frame` entry is a rendering frame
 *  over 50 ms; its scripts[] attribute names the exact culprit (source URL +
 *  invoker) that burned the time, which plain console timing cannot. Ships in
 *  no production bundle: the call site is `import.meta.env.DEV`-guarded and
 *  this module is side-effect free, so Rollup drops it entirely in builds. */
type LoafScript = {
  duration?: number
  invoker?: string
  invokerType?: string
  sourceURL?: string
  sourceFunctionName?: string
}
type LoafEntry = PerformanceEntry & { blockingDuration?: number; renderStart?: number; scripts?: LoafScript[]; styleAndLayoutStart?: number }

const describeScript = (script: LoafScript) => {
  const where = script.sourceURL ? `${script.sourceURL}${script.sourceFunctionName ? ` (${script.sourceFunctionName})` : ''}` : script.sourceFunctionName || 'inline'
  const invoker = script.invoker ? ` via ${script.invokerType ?? 'event'} "${script.invoker}"` : ''
  return `${where}${invoker}`
}

export function observeLongAnimationFrames() {
  if (!import.meta.env.DEV) return
  if (typeof PerformanceObserver === 'undefined') return
  if (!PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) return
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as LoafEntry[]) {
      // The slowest script is the actionable culprit; frames can also burn
      // their budget in style/layout with no script involved at all.
      const culprit = [...(entry.scripts ?? [])].sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))[0]
      const detail = culprit
        ? `culprit script ${describeScript(culprit)} (${Math.round(culprit.duration ?? 0)} ms)`
        : 'no script attributed (style/layout or painting)'
      console.warn(`[loaf] ${Math.round(entry.duration)} ms frame (blocking ${Math.round(entry.blockingDuration ?? 0)} ms) — ${detail}`)
    }
  })
  observer.observe({ type: 'long-animation-frame', buffered: true } as PerformanceObserverInit)
}
