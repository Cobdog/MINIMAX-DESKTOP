/**
 * The engine re-check loop's decisions as pure data (remediation Wave 1,
 * R-01 — audits B P0-1 / C F3). useStudioSession wires the timers; WHAT to
 * do at each tick lives here so the boot/transition/loss matrix is
 * unit-testable without an engine:
 *
 *   - cadence: FAST while disconnected (the app notices an engine that
 *     starts by itself), SLOW while connected (liveness only)
 *   - connected-transition: re-pull object_info + the model inventory
 *     (the external restart-watch — no manual Test-connection, no restart
 *     dance)
 *   - loss: after a confirmed-offline grace, active jobs fail honestly
 *     "engine unreachable" instead of spinning to the 60-minute deadline
 *     (the Wave-4 R-26 sweep stays as the backstop)
 */
import { dbg } from './dbg'

/** Probe cadence while the engine is DOWN — fast enough that "start the
 *  engine and watch the app notice" feels immediate (the acceptance bar's
 *  step 2), slow enough not to spam a dead address. */
export const RECHECK_DOWN_MS = 5_000
/** Probe cadence while the engine is UP — liveness only; a mid-session
 *  engine death is noticed within this window (15 s keeps the loss→grace→
 *  honest-failure sequence inside a minute while staying a cheap
 *  /system_stats GET). */
export const RECHECK_UP_MS = 15_000

/** How long a CONFIRMED offline stretch must last before active jobs are
 *  failed honestly (a couple of probe cycles — short enough for the
 *  "seconds-to-minutes" bar, long enough that a transient blip during a
 *  healthy render does not fail work that is still running). */
export const ENGINE_LOST_JOB_GRACE_MS = 45_000

export type EngineTransition = 'steady' | 'recovered' | 'lost'

/** What changed between two probe results (the boot check passes the
 *  PREVIOUS state as unknown-connected=false, so a fresh boot that finds
 *  the engine up is 'steady' — no re-pull, no toast). */
export function engineTransition(wasConnected: boolean | undefined, nowConnected: boolean): EngineTransition {
  if (wasConnected === undefined || wasConnected === nowConnected) return 'steady'
  return nowConnected ? 'recovered' : 'lost'
}

/** The loop's next delay given the latest probe. A hidden tab gets the
 *  same cadence (browsers throttle background timers anyway; the
 *  visibilitychange handler fires an immediate probe on return). */
export function nextRecheckDelayMs(connected: boolean): number {
  return connected ? RECHECK_UP_MS : RECHECK_DOWN_MS
}

/** Whether the offline grace has elapsed for jobs to fail honestly.
 *  `lostAt` null = the engine was never seen connected this session (a
 *  boot-time-offline app has no running jobs to fail — nothing to do). */
export function shouldFailActiveJobs(lostAt: number | null, now: number): boolean {
  return lostAt !== null && now - lostAt >= ENGINE_LOST_JOB_GRACE_MS
}

/** The honest terminal message for jobs lost to a dead engine (worded so
 *  classifyFailure lands engine-unreachable — the taxonomy's own bucket). */
export function engineUnreachableFailure(): string {
  return 'The generation engine became unreachable mid-render (connection refused for the last 45 s) — the render did not complete. Verify ComfyUI is running, then re-run this chain when the engine is back.'
}

/** The honest terminal message for jobs orphaned by an engine RESTART: the
 *  engine is back, but the fresh instance has no history for the prompt —
 *  the queued work died with the old process. */
export function engineRestartFailure(): string {
  return 'The generation engine restarted mid-render and the fresh instance no longer knows this prompt (it was unreachable when the work was lost) — the render did not complete. Re-run this chain.'
}

/** The junction log for one probe's outcome — the triage transcript's
 *  session stream (R-01 + A-DBG). */
export function logEngineProbe(source: 'boot' | 'loop' | 'visibility' | 'manual', url: string, transition: EngineTransition, connected: boolean, latencyMs: number): void {
  dbg('session.engine', { source, transition, connected, latencyMs, url: url.replace(/^https?:\/\//, '') })
}
