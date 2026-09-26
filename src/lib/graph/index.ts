/** Graph factory + optimization registry (public surface).
 *
 * - types.ts   — ComfyPrompt/Link data model, OptimizationEntry schema,
 *                GraphContext (role-addressed node map + chain wraps)
 * - ids.ts     — the canonical H3 node-ID table (stable public contract)
 * - turbo.ts   — turbo LoRA families (official, lightx2v, drbaph, PDD) +
 *                plan resolution and selection ranking
 * - upscale.ts — LBH 2D/3D hires-fix, RTX pixel 2×
 * - preview.ts — H3 live-preview override
 * - registry.ts— the entry list, registration, detection, provenance
 * - krea2edit.ts — Krea 2 edit graph families (instruct / removal /
 *                refine-masked / outpaint / two-ref) + recipe audit
 * - h3image.ts — H3 image workbench families (generate packet/T=1/directed,
 *                compose, six edit families, refine engines, burst lane,
 *                exit) + the Mamad8 never-in-video-graphs factory guard
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
export { optimizationEntries, findOptimization, registerOptimization, detectOptimizations, turboProvenance, classifyTurboFamily, turboFetchPlan, turboLoraPatterns, resolveTurboPlan, upscaleEntryFor } from './registry'
// Krea 2 edit families (docs/research/krea2-edit-mode.md): five per-workflow
// graph builders + availability gating + the recipe-triple audit.
export {
  ANYPAINT_NODES, KREA2, KREA2_EDIT_FAMILIES, KREA2EDIT_NODES, KREA2_FORBIDDEN_COMPOSITE_NODES,
  KREA2_RECIPE_PINS, KREA2_WHOLE_PIPELINE_PATCHERS,
  buildKrea2EditGraphWithAudit, buildKrea2Graph, buildKrea2T2iGraph, detectKrea2EditFamilies,
  findKrea2EditFamily, krea2LoraKindOfFilename, krea2RecipeAudit, resolveKrea2EditModels,
  validateKrea2EditRequest,
} from './krea2edit'
export type {
  Krea2BaseOptions, Krea2BuildOptions, Krea2CheckpointChoice, Krea2EditDetection, Krea2EditDial,
  Krea2EditFamily, Krea2EditRequest, Krea2EditWorkflow, Krea2FitMode, Krea2LoraKind, Krea2ModelSelection,
  Krea2Padding, Krea2RecipeTriple,
} from './krea2edit'
// H3 image workbench families (task k9vu6t0, docs/specs/image-workbench-v1.md):
// the image surface's family registry — generate (packet/T=1/directed),
// compose, the six edit families, refine engines, the burst lane, the exit —
// plus the Mamad8 never-in-video-graphs factory guard.
export {
  FORM_ADAPTER_NODE, H3IMG, H3IMG_FAMILIES, H3IMG_FORBIDDEN_VIDEO_NODES, H3IMG_RECIPE_PINS,
  H3_IMAGE_STUDIO_DECODE_NODE, H3_IMAGE_STUDIO_FRAME_PRESETS, H3_IMAGE_STUDIO_PREPARE_NODES,
  HYBRID_LOADER_NODE, STAGE_ENGINE_OF_FAMILY, STOCK_SAMPLED_FRAMES,
  T1_IMAGE_VAE_PATTERN, TRANSPORT_FOR_ROLE,
  assertNoT1ImageVaeInVideoGraph, buildH3ImageGraph, buildKleinRefineGraph, detectH3ImgFamilies,
  findH3ImgFamily, framePublishIds, h3ImageStudioPackPresent, h3imgGraphAudit, inferH3ImgSelection,
  kleinResolved, packetTierLabel, seedvr2BatchCount,
} from './h3image'
export type {
  H3ImgDetection, H3ImgDial, H3ImgFamily, H3ImgFamilyKind, H3ImgLoraSlot, H3ImgModelSelection,
  H3ImgPathProfile, H3ImgRefRole, H3ImgRefSlot, H3ImgRequest, H3ImgTransport, StageEngine,
} from './h3image'
// Engine families (remediation A-3, directive c250ab36): every renderable
// engine as data — the selector, the panel-section gating, the image-engine
// choices, and the queued-slot refusals all read this registry.
export { engineFamilies, engineFamilyForChain, imageEngineChoices, registerEngineFamily } from './engineFamilies'
export type { EngineChainSettingsLike, EngineFamilyEntry, EnginePanelSections } from './engineFamilies'
