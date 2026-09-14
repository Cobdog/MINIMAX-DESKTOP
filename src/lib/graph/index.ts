/** Graph factory + optimization registry (public surface).
 *
 * - types.ts   — ComfyPrompt/Link data model, OptimizationEntry schema,
 *                GraphContext (role-addressed node map + chain wraps)
 * - ids.ts     — the canonical H3 node-ID table (stable public contract)
 * - turbo.ts   — turbo LoRA families (official, lightx2v, drbaph, PDD) +
 *                plan resolution and selection ranking
 * - upscale.ts — LTX latent 2×, LBH 2D/3D hires-fix, RTX pixel 2×
 * - preview.ts — H3 live-preview override
 * - registry.ts— the entry list, registration, detection, provenance
 *
 * See docs/architecture.md → "Optimization registry" for how to add an entry. */
export type { ComfyNode, ComfyPrompt, DetectionResult, EngineId, GraphContext, Link, OptimizationEntry, TransformOptions, TurboLoaderChoice, TurboPlan, WrapPoint } from './types'
export { createGraphContext } from './types'
export { H3, LARRYVRH_TURBO_NODES } from './ids'
export { TURBO_ENTRIES, GENERIC_TURBO_ENTRY, larryvrhTurboPackPresent } from './turbo'
export { UPSCALE_ENTRIES } from './upscale'
export { PREVIEW_ENTRY } from './preview'
// Registry-scoped wrappers classify/resolve against the LIVE registry list,
// so runtime-registered entries participate with zero factory changes.
export { optimizationEntries, findOptimization, registerOptimization, detectOptimizations, turboProvenance, classifyTurboFamily, turboLoraPatterns, resolveTurboPlan, upscaleEntryFor } from './registry'
