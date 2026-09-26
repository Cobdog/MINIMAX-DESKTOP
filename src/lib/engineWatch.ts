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
import type { ModelFile } from '../types'

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

// ---------------------------------------------------------------------------
// The inventory re-sync decisions (truth-surface sweep #2, task 68e9k17 —
// audit M1/C1, 2026-09-26). The empirical root this sweep established
// against the environment mirror: the server's bootstrap serves FRESH
// listings across a restart and the OBSERVED down→up transition re-pulls —
// but a restart that completes BETWEEN two probes (the fake-engine class:
// ~1 s; the audit's own mirror walk) is INVISIBLE: no down-tick, no
// transition, no re-pull, and the studio keeps the old registry while the
// pack board (its own TTL-probed object_info pull) flips. Three decisions
// below close the lie:
//   1. every re-sync carries REFRESH semantics (the engine is asked to
//      re-scan its own folders — never a cached listing);
//   2. every connected tick compares a LIGHT models-only listing (no
//      object_info — A-8's megabytes stay out) and re-syncs on drift, so
//      the invisible restart is caught within one cadence;
//   3. the resync OUTCOME is recorded — the toast speaks only after the
//      inventory actually landed (or names the failure), never before.
// ---------------------------------------------------------------------------

/** What a re-sync (recovery or drift) passes to scanModels: refresh
 *  semantics — POST /refresh reaches the engine through the server's
 *  bootstrap?refresh=1 arm before the listing re-pull. */
export const RECOVERY_RESYNC_OPTIONS = { refresh: true } as const

/** Why an inventory re-sync ran. 'recovery' — the observed down→up
 *  transition (the restart-watch arc). 'drift' — the registry changed with
 *  connectivity never dropping (the invisible restart, or models added to a
 *  running engine). */
export type InventoryResyncCause = 'recovery' | 'drift'

/** The resync bookkeeping the surfaces toast from: WHAT happened, WHEN, and
 *  whether the fresh listing actually landed (files carries the count when
 *  ok; the failure never claims otherwise). */
export type InventoryResyncRecord = { at: number; ok: boolean; files: number; cause: InventoryResyncCause }

/** The light-listing shape the drift check compares against: the models the
 *  engine's /models routes serve RIGHT NOW, plus the kinds those routes
 *  ANSWER (a kind the engine does not serve cannot be judged — leaner
 *  instances fall back to object_info enums the light pull never sees). */
export type LightInventory = { models: ModelFile[]; servedKinds: string[] }

/** Per served kind, name-set equality between the store's inventory and the
 *  live light listing. A kind the light pull serves with ZERO rows while
 *  the store holds files IS drift (the folder emptied); a null light answer
 *  (route absent, engine flapped) never drifts. Byte sizes are registry-
 *  honest zeros and deliberately not compared — membership is the truth
 *  here. */
export function inventoryDrifted(current: ModelFile[], light: LightInventory | null): boolean {
  if (!light || !Array.isArray(light.models) || !Array.isArray(light.servedKinds)) return false
  const kinds: string[] = []
  for (const kind of light.servedKinds) if (kinds.indexOf(kind) === -1) kinds.push(kind)
  for (const kind of kinds) {
    const names = (files: ModelFile[]) => files.filter((file) => file.kind === kind).map((file) => file.name).sort().join('|')
    if (names(current) !== names(light.models)) return true
  }
  return false
}

/** The toast words for a resync that followed the observed recovery arc —
 *  spoken only once the inventory landed (the record's ok gate). */
export function engineResyncedNotice(files: number): string {
  return `Engine connected — node registry and model inventory re-synced (${files} files on the engine).`
}

/** The honest partial: the engine is back and the node registry re-pulled,
 *  but the inventory read failed — say THAT, never "re-synced". */
export function engineResyncFailedNotice(): string {
  return 'Engine connected — the node registry re-synced, but the model inventory could not be re-read from the engine. Open Settings and use Refresh from engine.'
}

/** The drift toast: connectivity never dropped — an invisible restart or a
 *  models-folder change, not a recovery arc. */
export function inventoryDriftNotice(files: number): string {
  return `Model inventory re-synced — the engine restarted or its models changed (${files} files on the engine).`
}
