import type { GenerationJob } from '../types'

export type PollObservation =
  | { kind: 'executionError' }
  | { kind: 'completed'; outputUrl: string; localOutputPath?: string }
  | { kind: 'completedNoLocalOutput' }
  | { kind: 'incomplete' }
  | { kind: 'pollFailed' }

export type PollReduction = {
  job: GenerationJob
  /** Present only when this call moved the job into a terminal state. Callers
   *  gate completion side effects (library recording, frame extraction) on it
   *  so they fire exactly once even when poll responses arrive out of order. */
  transitionedTo?: 'completed' | 'failed'
}

/** A finished render whose output file has not appeared yet gets this many
 *  extra 1-second polls before the job fails. ComfyUI writes output files
 *  before marking history completed, so this only covers slow disks. */
export const NO_OUTPUT_POLL_CAP = 30

/** Wall-clock cap on any single queued/running job, checked on every poll
 *  tick. Guards against a dead ComfyUI leaving jobs "running" forever. */
export const RUNNING_DEADLINE_MS = 60 * 60 * 1000

const TERMINAL_STATUSES: ReadonlySet<GenerationJob['status']> = new Set(['completed', 'failed', 'cancelled'])

export function isTerminalStatus(status: GenerationJob['status']): boolean {
  return TERMINAL_STATUSES.has(status)
}

export function isPastRunningDeadline(job: GenerationJob, now: number): boolean {
  return !TERMINAL_STATUSES.has(job.status) && now - job.createdAt > RUNNING_DEADLINE_MS
}

/** Pure transition for one job given one poll observation. A stale in-flight
 *  response for a job that already reached a terminal state is a no-op — it
 *  must neither resurrect the job nor repeat its completion side effects. */
export function reduceJobPoll(job: GenerationJob, observation: PollObservation, now: number): PollReduction {
  if (TERMINAL_STATUSES.has(job.status)) return { job }
  if (isPastRunningDeadline(job, now)) {
    return {
      job: { ...job, status: 'failed', error: `Still rendering after ${Math.round(RUNNING_DEADLINE_MS / 60000)} minutes with no completion. ComfyUI may have stopped responding — check its queue before retrying.` },
      transitionedTo: 'failed',
    }
  }
  switch (observation.kind) {
    case 'executionError':
      return {
        job: { ...job, status: 'failed', error: 'ComfyUI reported an execution error. The original may still be saved if upscaling failed.' },
        transitionedTo: 'failed',
      }
    case 'completed':
      return {
        job: { ...job, status: 'completed', progress: 100, outputUrl: observation.outputUrl, localOutputPath: observation.localOutputPath ?? job.localOutputPath },
        transitionedTo: 'completed',
      }
    case 'completedNoLocalOutput': {
      const noOutputPolls = (job.noOutputPolls ?? 0) + 1
      if (noOutputPolls >= NO_OUTPUT_POLL_CAP) {
        return {
          job: { ...job, status: 'failed', error: 'The render finished, but its output file never appeared in the output directory.' },
          transitionedTo: 'failed',
        }
      }
      return { job: { ...job, status: 'running', progress: 98, noOutputPolls } }
    }
    case 'incomplete':
      // Same reference when nothing changes, so idle poll ticks do not churn state.
      return job.status === 'running' ? { job } : { job: { ...job, status: 'running' } }
    case 'pollFailed':
      return { job }
  }
}
