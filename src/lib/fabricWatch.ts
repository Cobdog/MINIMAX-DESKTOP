/**
 * The realtime fabric's recovery decisions as pure data (remediation Wave 1,
 * R-07 + R-08 — audit B P1-3 / P1-4). src/lib/useRealtime.ts owns the
 * sockets; these are the judgments, unit-testable without a server:
 *
 *   R-07 — SSE demotion is a FALLBACK, not a sentence: while demoted, a
 *   periodic WS re-probe (plus one on tab-visibility) tries the upgrade
 *   again, so an SSE-demoted session heals to WS (and LLM streaming with
 *   it) instead of losing it for the whole session.
 *
 *   R-08 — events missed DURING a reconnect are invisible to the seq-gap
 *   detector (the server restarts its per-client seq at 1): after a reopen
 *   every subscribed channel gets a synthetic resync so consumers
 *   re-fetch authoritative state — the reconnect window stops being the
 *   one drop window the fabric cannot see.
 */

/** WS re-probe cadence while demoted to SSE. */
export const WS_REPROBE_MS = 60_000

/** Whether a WS upgrade probe is due while demoted (R-07). A probe runs at
 *  most this often, and immediately when the tab becomes visible again. */
export function wsReprobeDue(demoted: boolean, lastProbeAt: number | null, now: number): boolean {
  if (!demoted) return false
  return lastProbeAt === null || now - lastProbeAt >= WS_REPROBE_MS
}

/** The channels to resynchronize after a transport reopen (R-08): every
 *  subscribed JSON channel (preview frames are fire-and-forget bytes with
 *  no authoritative state to re-fetch). The seq map is cleared on reopen,
 *  so these resyncs are the ONLY signal covering the disconnect window. */
export function channelsToResyncOnReopen(subscribedChannels: ReadonlySet<string>): string[] {
  return Array.from(subscribedChannels)
}
