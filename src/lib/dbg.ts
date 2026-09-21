/**
 * The junction logger (maintainer directive c250ab36, remediation A-DBG —
 * Wave 1's seam). One tagged call per DECISION POINT:
 *
 *   dbg('route', { picked: 'video', because: { mediaType, mode } })
 *
 * The console becomes a triage transcript — paste-and-diagnose, not
 * describe-and-guess. Junction ids are stable dotted tags so a session log
 * greps cleanly: route · family · override · preflight · submit · queue ·
 * landing · session · fabric.
 *
 * TOGGLEABLE with a true no-op when off (the hot path is one boolean check):
 *   - `?dbg=1` URL param          — enables and persists (localStorage)
 *   - localStorage 'minimax-dbg'  — the runtime flip; the maintainer's console
 *                                   can also call window.__minimaxDbg(true)
 *   - the launcher's dev settings — MINIMAX_DBG=1 makes the server inject
 *     <meta name="minimax-dbg"> into index.html, so a dev boot starts hot
 *
 * Payload discipline (the logSanitize doctrine, lighter): log the failure
 * PATH and REASON — ids, classes, modes, counts, filenames — never prompt
 * prose or media bytes. Keep payloads small and structured.
 */

const STORAGE_KEY = 'minimax-dbg'
const JUNCTION_TAG = /^[a-z][a-z0-9.]*$/

function readInitialEnabled(): boolean {
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.get('dbg') === '1') {
      try { window.localStorage.setItem(STORAGE_KEY, '1') } catch { /* private mode */ }
      return true
    }
    if (params.get('dbg') === '0') {
      try { window.localStorage.removeItem(STORAGE_KEY) } catch { /* see above */ }
      return false
    }
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (stored === '1') return true
    // The launcher channel: the server injects the meta tag only when
    // MINIMAX_DBG is set at boot (server/core.ts static serving).
    if (typeof document !== 'undefined' && document.querySelector('meta[name="minimax-dbg"]')) return true
  } catch { /* no DOM (SSR/tests) — off */ }
  return false
}

let enabled = readInitialEnabled()

export function dbgEnabled(): boolean { return enabled }

/** The runtime flip (window.__minimaxDbg wires here; persists). */
export function setDbgEnabled(next: boolean): void {
  enabled = next
  try {
    if (next) window.localStorage.setItem(STORAGE_KEY, '1')
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch { /* private mode — the in-memory flag still flips */ }
  if (next) console.log('[dbg] junction logging enabled')
}

/** One junction event. Off = a single boolean check, nothing else runs. */
export function dbg(junction: string, payload: Record<string, unknown>): void {
  if (!enabled) return
  const tag = JUNCTION_TAG.test(junction) ? junction : 'untagged'
  try {
    console.log(`[dbg:${tag}] ${JSON.stringify(payload)}`)
  } catch {
    console.log(`[dbg:${tag}] <unserializable payload>`)
  }
}

if (typeof window !== 'undefined') {
  // The maintainer's console + e2e hooks: flip without a reload.
  Object.defineProperty(window, '__minimaxDbg', {
    configurable: true,
    value: { enabled: () => enabled, set: setDbgEnabled },
  })
}
