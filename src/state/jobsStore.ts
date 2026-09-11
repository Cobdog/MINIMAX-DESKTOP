/** The generation-job store (wave 2a): the job list and the in-flight
 *  cancellation id set — the React state `useGenerationQueue` held. The poll
 *  loop, deadline sweep, retry, and persistence logic stay in the hook; every
 *  `setJobs` call site kept its exact value/updater form. */
import { create } from 'zustand'
import type { GenerationJob } from '../types'
import { initialJobs } from '../lib/jobRecords'

type Updater<T> = T | ((current: T) => T)

const applied = <T>(next: Updater<T>, current: T): T => (typeof next === 'function' ? (next as (current: T) => T)(current) : next)

export type JobsState = {
  jobs: GenerationJob[]
  cancellingIds: Set<string>
  setJobs(jobs: Updater<GenerationJob[]>): void
  setCancellingIds(cancellingIds: Updater<Set<string>>): void
}

export const useJobsStore = create<JobsState>()((set) => ({
  jobs: initialJobs(),
  cancellingIds: new Set<string>(),
  setJobs: (jobs) => set((state) => ({ jobs: applied(jobs, state.jobs) })),
  setCancellingIds: (cancellingIds) => set((state) => ({ cancellingIds: applied(cancellingIds, state.cancellingIds) })),
}))
