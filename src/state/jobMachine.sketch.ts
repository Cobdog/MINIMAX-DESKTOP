/** SKETCH ONLY — wave 2a. The job lifecycle as an xstate v5 statechart, the
 *  pattern `useGenerationQueue` would migrate toward once the queue's poll
 *  loop is demoted to pure reconciliation. NOT WIRED: nothing imports this at
 *  runtime, no `xstate` dependency exists, and the live queue hook keeps its
 *  audited reducer + poll-loop implementation. This file exists so the state
 *  space is written down (and type-checked) before any migration touches the
 *  best-tested code in the app.
 *
 *  Mapping to today's code (src/lib/jobReducer.ts + hooks/useGenerationQueue.ts):
 *
 *    machine state      today's `job.status` + guards
 *    ----------------   ------------------------------------------------------
 *    queued             'queued' — local row created, prompt_id not yet known
 *    dispatched         (implicit) — submitPrompt returned, promptId stored
 *    running            'running' — history polls incomplete / progress events
 *    awaitingOutput     'running' + noOutputPolls 1..30 (completedNoLocalOutput)
 *    retrying           retriedOnce=false + executionError + graph present —
 *                       one engine-reset + tiled-VAE resubmit, then back to
 *                       dispatched with a NEW promptId (id-keyed, not status)
 *    completed          'completed' — reduction fired side effects once
 *    failed             'failed' — executionError, output cap, or the 60-min
 *                       RUNNING_DEADLINE_MS sweep (deadlineSweep event)
 *    cancelled          'cancelled' — user cancel (pending or running)
 *
 *  In xstate v5 the machine would be defined with `setup({ types: … })
 *    .createMachine({ … })`; below, the same contract as pure types plus a
 *  frozen transition table so the sketch is executable reasoning, not prose.
 *  Events `progress`, `previewMeta`, `resync`, and `deadlineSweep` are
 *  self-transitional (they update context, never the state value) — the
 *  fabric's per-channel seq-gap `resync` triggers an immediate history
 *  sweep (see useGenerationQueue), which the machine models as a
 *  `fetchHistory` invoke restarting. */
import type { GenerationJob, MediaFile } from '../types'

export type JobMachineStateValue =
  | 'queued'
  | 'dispatched'
  | 'running'
  | 'awaitingOutput'
  | 'retrying'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type JobMachineEvent =
  | { type: 'DISPATCHED'; promptId: string }
  | { type: 'PROGRESS'; progress: number; label: string; currentStep?: number; totalSteps?: number }
  | { type: 'HISTORY'; observation: 'executionError' | 'completed' | 'completedNoLocalOutput' | 'incomplete' | 'pollFailed'; outputUrl?: string; localOutputPath?: string }
  | { type: 'RESYNC' } // realtime fabric seq gap → immediate history sweep
  | { type: 'DEADLINE_SWEEP' } // 30 s interval: past RUNNING_DEADLINE_MS → failed
  | { type: 'CANCEL' }
  | { type: 'RETRY_DISALLOWED' }

export type JobMachineContext = Pick<GenerationJob, 'id' | 'provider' | 'createdAt' | 'promptId' | 'retriedOnce'> & {
  progress: number
  progressLabel: string
  outputUrl?: string
  /** Counts completedNoLocalOutput polls; fails the job at 30 (NO_OUTPUT_POLL_CAP). */
  noOutputPolls: number
  error?: string
}

/** Terminal guards mirror isTerminalStatus(): a stale in-flight observation
 *  for a terminal job is a no-op — it must neither resurrect the job nor
 *  repeat its completion side effects. */
export const JOB_MACHINE_TERMINAL: ReadonlySet<JobMachineStateValue> = new Set(['completed', 'failed', 'cancelled'])

/** The transition table. `null` = forbidden (swallowed, logged in dev) — in
 *  xstate these would be absent from the state's `on` block, which is
 *  precisely the guarantee the reducer currently implements by hand. */
export const JOB_MACHINE_TRANSITIONS: Readonly<Record<JobMachineStateValue, Partial<Record<JobMachineEvent['type'], JobMachineStateValue | null>>>> = Object.freeze({
  queued: { DISPATCHED: 'dispatched', HISTORY: null, PROGRESS: null, RESYNC: null, DEADLINE_SWEEP: 'failed', CANCEL: 'cancelled', RETRY_DISALLOWED: null },
  dispatched: { DISPATCHED: null, PROGRESS: 'running', HISTORY: 'running', RESYNC: null, DEADLINE_SWEEP: 'failed', CANCEL: 'cancelled', RETRY_DISALLOWED: null },
  running: { DISPATCHED: null, PROGRESS: null, HISTORY: 'awaitingOutput', RESYNC: null, DEADLINE_SWEEP: 'failed', CANCEL: 'cancelled', RETRY_DISALLOWED: null },
  awaitingOutput: {
    DISPATCHED: null,
    PROGRESS: null,
    // HISTORY resolves by observation: completed → completed, otherwise stays
    // awaitingOutput until the 30-poll cap fails it (guard on context).
    HISTORY: 'awaitingOutput',
    RESYNC: null,
    DEADLINE_SWEEP: 'failed',
    CANCEL: 'cancelled',
    RETRY_DISALLOWED: null,
  },
  retrying: { DISPATCHED: 'dispatched', PROGRESS: null, HISTORY: 'failed', RESYNC: null, DEADLINE_SWEEP: 'failed', CANCEL: 'cancelled', RETRY_DISALLOWED: 'failed' },
  completed: { DISPATCHED: null, HISTORY: null, PROGRESS: null, RESYNC: null, DEADLINE_SWEEP: null, CANCEL: null, RETRY_DISALLOWED: null },
  failed: { DISPATCHED: null, HISTORY: null, PROGRESS: null, RESYNC: null, DEADLINE_SWEEP: null, CANCEL: null, RETRY_DISALLOWED: null },
  cancelled: { DISPATCHED: null, HISTORY: null, PROGRESS: null, RESYNC: null, DEADLINE_SWEEP: null, CANCEL: null, RETRY_DISALLOWED: null },
})

/** Side-effect boundary the machine would own as invoke/invoke-like actors:
 *  exactly the actions the queue hook performs today on `transitionedTo`,
 *  gated to fire once per terminal entry. */
export type JobMachineEffects = {
  submitGraph(job: JobMachineContext): Promise<{ promptId: string }>
  fetchHistory(promptId: string): Promise<unknown>
  recordCompletion(job: GenerationJob, output: { url: string; localPath?: string }): Promise<void>
  cancelUpstream(promptId: string): Promise<{ cancelled: boolean }>
}

/** Kept honest: the sketch deliberately does NOT model per-frame preview
 *  painting — those bytes never enter job state at all (wave-1 fabric +
 *  wave-2a transient discipline), and a machine must not regress that. */
export type JobMachineSketchMarker = { readonly framesNeverEnterMachineState: MediaFile[] | null }
