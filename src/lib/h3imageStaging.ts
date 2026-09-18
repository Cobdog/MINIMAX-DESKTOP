/** Workbench VRAM staging discipline (task k9vu6t0, spec §4 — the 24 GB
 * rule, audit M3): stages NEVER run concurrently. Generate → /free →
 * (Refine | Burst-fuse) → /free → Exit; SeedVR2 loads only into a FREED
 * state (the burst research's own caveat); the hybrid profile + one refine
 * engine fits.
 *
 * The PLAN is pure data (testable without an engine); the EXECUTOR is the
 * injectable seam — the surface passes its own `free` (the existing
 * freeComfyMemory API call) and the tests pass a recorder. A stage whose
 * engine differs from the previous stage's always transitions through a
 * free; every stage after the first frees (the conservative reading of the
 * spec's own sequence — an unload is cheap next to a model reload).
 */
import { STAGE_ENGINE_OF_FAMILY, type StageEngine } from './graph/h3image'

export type WorkbenchStage = {
  familyId: string
  /** The stage's label for notices/telemetry. */
  label?: string
}

export type PlannedStep = {
  stage: WorkbenchStage
  engine: StageEngine
  /** True when /free runs before this stage (never before the first). */
  freeBefore: boolean
  /** Why the transition frees (surfaced when a stage is refused). */
  reason: string
}

/** The engines that may only ever start from a freed state. */
export const FREED_STATE_ENGINES: readonly StageEngine[] = ['seedvr2']

export function engineOfStage(stage: WorkbenchStage): StageEngine {
  return STAGE_ENGINE_OF_FAMILY[stage.familyId] ?? 'h3'
}

/**
 * The staging plan for a stage sequence: free between every engine-bearing
 * stage; app-side stages (the DSP fuse) never need the free themselves but
 * never block one either. Deterministic over the input order.
 */
export function stagePlan(stages: WorkbenchStage[]): PlannedStep[] {
  return stages.map((stage, index) => {
    const engine = engineOfStage(stage)
    const previous = index > 0 ? engineOfStage(stages[index - 1]) : null
    if (index === 0) {
      return { stage, engine, freeBefore: false, reason: 'first stage — the queue starts from whatever state the engine is in' }
    }
    if (engine === 'app') {
      return { stage, engine, freeBefore: false, reason: 'app-side op — no engine residency involved' }
    }
    if (FREED_STATE_ENGINES.includes(engine)) {
      return { stage, engine, freeBefore: true, reason: `${engine} loads only into a freed state (24 GB discipline)` }
    }
    if (previous !== engine) {
      return { stage, engine, freeBefore: true, reason: `engine change ${previous} → ${engine} frees the previous stage first` }
    }
    return { stage, engine, freeBefore: true, reason: 'stage transition — the previous engine unloads before this stage runs' }
  })
}

export type StageExecutor = {
  /** Runs the planned sequence; each stage callback runs between the
   * planned frees. Returns per-stage results; a thrown stage error stops
   * the sequence (the frees already issued stay issued — safety over
   * tidiness). */
  run<T>(stages: WorkbenchStage[], step: (stage: WorkbenchStage, index: number) => Promise<T>): Promise<Array<T | { stagedError: string }>>
}

/** Builds an executor over the injectable free seam. The recorder in the
 * tests asserts the free-before discipline without an engine; the surface
 * passes `(url) => window.minimax.freeComfyMemory(url)`. */
export function createStageExecutor(free: () => Promise<unknown>): StageExecutor {
  return {
    async run<T>(stages: WorkbenchStage[], step: (stage: WorkbenchStage, index: number) => Promise<T>): Promise<Array<T | { stagedError: string }>> {
      const plan = stagePlan(stages)
      const results: Array<T | { stagedError: string }> = []
      for (let index = 0; index < plan.length; index += 1) {
        const planned = plan[index]
        if (planned.freeBefore) await free()
        try {
          results.push(await step(planned.stage, index))
        } catch (error) {
          results.push({ stagedError: error instanceof Error ? error.message : String(error) })
          break
        }
      }
      return results
    },
  }
}
