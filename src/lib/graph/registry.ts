/** The optimization registry: every turbo / upscale / preview method the
 * factory can apply, as data. Adding a method = adding one entry (usually in
 * turbo.ts / upscale.ts / preview.ts) — the factory, builders and UI read the
 * registry; nothing else changes. The two contracts that make this safe:
 *
 *  1. INSERT-ONLY — a transform may append nodes at a declared factory seam
 *     and re-point only the factory's own chain consumers there. It never
 *     rewrites a node it did not create (GraphContext.wrapModel enforces the
 *     model chain; ids are allocated from the factory's table).
 *
 *  2. INERTNESS — when an entry is not selected, the produced graph must be
 *     deep-equal to the pre-registry graph. scripts/test-registry.cjs proves
 *     this per entry against golden snapshots, so a new optimization can
 *     never perturb the base path (Kreatine's "non-seamless inertness"
 *     probe discipline).
 */
import type { ObjectInfo } from '../comfyInfo'
import type { ModelFile } from '../../types'
import type { DetectionResult, OptimizationEntry, TurboLoaderChoice, TurboPlan } from './types'
import { GENERIC_TURBO_ENTRY, TURBO_ENTRIES, classifyTurboFamily as classifyInModule, larryvrhTurboPackPresent, resolveTurboPlan as resolveInModule, turboLoraPatterns as patternsInModule } from './turbo'
import { UPSCALE_ENTRIES, upscaleEntryFor } from './upscale'
import { PREVIEW_ENTRY } from './preview'

const entries: OptimizationEntry[] = []

function register(entry: OptimizationEntry): void {
  if (entries.some((existing) => existing.id === entry.id)) throw new Error(`optimization registry duplicate id '${entry.id}'`)
  entries.push(entry)
}

for (const entry of TURBO_ENTRIES) register(entry)
register(GENERIC_TURBO_ENTRY)
for (const entry of UPSCALE_ENTRIES) register(entry)
register(PREVIEW_ENTRY)

/** Snapshot of the registry at call time (callers that mutate via
 * registerOptimization keep their earlier reference). */
export function optimizationEntries(): readonly OptimizationEntry[] {
  return entries.slice()
}

export function findOptimization(id: string): OptimizationEntry | undefined {
  return entries.find((entry) => entry.id === id)
}

/** Runtime registration for NEW entries (the painless-expansion path). Used
 * by tests to prove a hypothetical family registers, detects, transforms and
 * goes inert with zero factory changes. Returns an unregister function so
 * test scopes stay isolated. */
export function registerOptimization(entry: OptimizationEntry): () => void {
  register(entry)
  return () => {
    const index = entries.indexOf(entry)
    if (index >= 0) entries.splice(index, 1)
  }
}

/** Runs every entry's detect against the live engine + scan — the UI
 * availability surface (gating + install guidance). */
export function detectOptimizations(info: ObjectInfo | undefined, files: ModelFile[]): Array<{ entry: OptimizationEntry; detection: DetectionResult }> {
  return entries
    .filter((entry) => entry.id !== GENERIC_TURBO_ENTRY.id)
    .map((entry) => ({ entry, detection: entry.detect(info, files) }))
}

/** Turbo provenance for a (selected or scanned) LoRA filename — powers the
 * "which family/steps is this LoRA" UI line. */
export function turboProvenance(filename: string): { entryId: string; label: string; steps: number; samplerNode?: string } | undefined {
  const family = classifyTurboFamily(filename)
  if (!family) return undefined
  return { entryId: family.id, label: family.label, steps: family.pairing?.steps ?? 0, samplerNode: family.pairing?.samplerNode }
}

/** Registry-scoped wrappers: classification, selection ranking and plan
 * resolution run against the LIVE registry so runtime-registered entries
 * (registerOptimization) participate without any factory change. */

export function classifyTurboFamily(filename: string): OptimizationEntry | undefined {
  return classifyInModule(filename, entries)
}

export function turboLoraPatterns(target: 'fl2v' | 'ref2v', turbo: 'off' | '4' | '8', family?: string): RegExp[] {
  return patternsInModule(target, turbo, family, entries)
}

export function resolveTurboPlan(input: {
  turbo: 'off' | '4' | '8'
  loraName: string
  strength?: number
  loader?: TurboLoaderChoice
  info?: ObjectInfo
}): TurboPlan | undefined {
  return resolveInModule(input, entries)
}

export { larryvrhTurboPackPresent, upscaleEntryFor }
export type { TurboLoaderChoice, TurboPlan }
