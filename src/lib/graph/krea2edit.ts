/** Krea 2 edit graph families — Identity Edit as a first-class feature.
 *
 * Five small, targeted, per-workflow graph families over ONE resident Krea 2
 * checkpoint pair (Turbo for everything, RAW for the removal variant), built
 * in the same factory style as the H3 optimization registry:
 *
 *   krea2edit.instruct  Identity Edit LoRA @1.0, Turbo 8 steps / CFG 1.0 /
 *                       Euler+simple, <=2MP, grounding_px 768 / ref_boost 1.0 /
 *                       fit geometry, dual conditioning (source as in-context
 *                       latents + grounded TE encode), empty-prompt negative
 *                       grounding when CFG>1.
 *   krea2edit.removal   Same dual conditioning on the RAW checkpoint at
 *                       CFG 3.0 / 20 steps (gated on RAW being present);
 *                       ref_boost capped — >10 breaks removals.
 *   krea2edit.refine    AnyPaint rank-32 @1.0, Turbo 8 steps / CFG 1.0, VLM
 *                       reference + K/V cache on, canvas multiples of 16,
 *                       white=generate / black=preserve, ZERO post-hoc
 *                       composite (the 32-px boundary band is the blend).
 *   krea2edit.outpaint  AnyPaint padding path (optionally + mask = mixed).
 *   krea2edit.two-ref   Person-into-scene: FIXED image order (scene=1,
 *                       person=2 — RoPE frames 1/2), 1–1.5MP band.
 *
 * Every recipe value below is RESEARCH-PINNED from docs/research/
 * krea2-edit-mode.md (its §2/§3 tables), cross-checked against the publishers'
 * own cards at pin time (conradlocke/krea2-identity-edit v1.2 card + the
 * comfyui-krea2edit node signatures; yijunwang2/krea2-anypaint card + the
 * krea2-anypaint node signatures — node input names below are the verified
 * INPUT_TYPES, not guesses). Deviating from a pinned value is a test failure
 * (the pinned-defaults table in scripts/test-registry.cjs).
 *
 * Two contracts carried over from the H3 registry discipline:
 *  1. INERTNESS — with no edit request, buildKrea2Graph output is deep-equal
 *     to the standalone base t2i graph (buildKrea2T2iGraph). Family
 *     registration can never perturb the base path.
 *  2. RECIPE TRIPLE — encode + transport + LoRA must match as a triple
 *     (the measured index-vs-t0 trap: the identity LoRA on a t=0 carrier
 *     silently destroys the reference region, meanAD 8.18 -> 50.06, with
 *     plausible-looking output; replicated on our int8 stack through core
 *     nodes as 5.30 -> 40.06 — E-K1, Flux 7ed5ewa). krea2RecipeAudit() walks
 *     a built graph and reports any mismatch — including the positive E-K1
 *     pairing rule: a ReferenceLatent carrier with the identity LoRA must
 *     carry Edit Model Reference Method 'index'; the two whole-pipeline
 *     forward patchers (Krea2EditModelPatch, Krea2AnyPaintModelPatch) are
 *     mutually exclusive.
 */
import type { ObjectInfo } from '../comfyInfo'
import type { ModelFile } from '../../types'
import { createGraphContext } from './types'
import type { ComfyPrompt, GraphContext, Link } from './types'

// ---------------------------------------------------------------------------
// Node-id policy (stable contract — mirrors the H3 block allocation idea)
// ---------------------------------------------------------------------------

/** Canonical node ids for the Krea 2 graph families. The base t2i skeleton
 * occupies 1–9; edit transforms insert only into their own id blocks and
 * re-point nothing but the factory's own sampler consumers. */
export const KREA2 = {
  unet: '1',
  clip: '2',
  vae: '3',
  positive: '4',
  negative: '5',
  emptyLatent: '6',
  sampler: '7',
  decode: '8',
  save: '9',
  editLora: '10',
  editPatch: '11',
  sourceLoader: '30',
  sourceEncode: '32',
  subjectLoader: '31',
  subjectEncode: '33',
  groundedPositive: '34',
  groundedNegative: '35',
  paintLoader: '40',
  paintPrepare: '41',
  paintEncode: '42',
  paintPatch: '43',
} as const

/** Node classes of the two edit node packs (presence = availability gate). */
export const KREA2EDIT_NODES = ['Krea2EditModelPatch', 'Krea2EditGroundedEncode'] as const
export const ANYPAINT_NODES = ['Krea2AnyPaintPrepare', 'Krea2AnyPaintEncode', 'Krea2AnyPaintModelPatch'] as const

// ---------------------------------------------------------------------------
// Research-pinned recipe constants (the single source — tests enforce these)
// ---------------------------------------------------------------------------

/** Every number here is pinned by docs/research/krea2-edit-mode.md and the
 * publisher cards. Change one only with a research-doc change; the
 * pinned-defaults test makes silent drift impossible. */
export const KREA2_RECIPE_PINS = {
  /** Turbo operating point (instruct / two-ref / refine / outpaint). */
  turbo: { steps: 8, cfg: 1.0, sampler: 'euler', scheduler: 'simple', denoise: 1, loraStrength: 1.0 },
  /** RAW removal recipe (the documented large-deletion path). */
  removal: { steps: 20, cfg: 3.0, sampler: 'euler', scheduler: 'simple', denoise: 1, loraStrength: 1.0 },
  /** grounding_px: edit-strength <-> identity dial, v1.2 trained range. */
  groundingPx: { default: 768, min: 384, max: 768 },
  /** ref_boost: likeness dial. UI caps at ~6; >10 breaks removals (hard cap). */
  refBoost: { default: 1.0, min: 0, max: 10, uiCap: 6, removalBreakAbove: 10 },
  /** fit geometry: v1.2 `fit` default, `crop (legacy)` for older weights. */
  fitMode: { default: 'fit', legacy: 'crop (legacy)' },
  /** Generation-size policy (MP = width*height/1e6). */
  megapixels: { instructMax: 2.0, twoRefMax: 1.5, twoRefPreferredMin: 1.0 },
  /** Step band for Turbo identity edits ("8 favor composition, 12 favor face
   * detail; ~10 balances" — the card's own band). */
  turboStepsBand: { min: 8, max: 12 },
  /** Canvas contract: Krea 2 dimensions are multiples of 16. */
  canvasMultiple: 16,
  /** AnyPaint operating point (ComfyUI form: the Diffusers-side "guidance
   * 0.0" of the HF card is CFG 1.0 in KSampler terms — the pack's own
   * shipped workflow pins 8 / 1.0 / euler / simple). */
  anypaint: {
    steps: 8,
    cfg: 1.0,
    sampler: 'euler',
    scheduler: 'simple',
    denoise: 1,
    loraStrength: 1.0,
    referenceMaxEdge: 384,
    boundaryRedrawPx: 32,
    vlmReference: true,
    kvCache: true,
    paddingStep: 16,
    paddingMax: 8192,
  },
} as const

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Krea2EditWorkflow = 'instruct' | 'removal' | 'refine' | 'outpaint' | 'two-ref'
export type Krea2CheckpointChoice = 'turbo' | 'raw'
export type Krea2FitMode = 'fit' | 'crop (legacy)'
export type Krea2LoraKind = 'identity-edit' | 'anypaint'

/** The encode/transport/LoRA recipe triple a family commits to. The transport
 * column is the carrier semantics — the Kreatine-measured trap is pairing the
 * identity LoRA with a t=0 carrier instead of the in-context frame-1 one. */
export type Krea2RecipeTriple = {
  loraKind: Krea2LoraKind
  /** Node class that grounds the prompt (semantic path). */
  encode: string
  /** Node class that carries the reference latents (transport path). */
  transport: string
  /** Carrier semantics, for humans and diagnostics. */
  carrier: string
}

export type Krea2EditDial =
  | 'groundingPx'
  | 'refBoost'
  | 'refBoostA'
  | 'fitMode'
  | 'steps'
  | 'cfg'
  | 'mask'
  | 'padding'

export type Krea2EditFamily = {
  id: string
  label: string
  workflow: Krea2EditWorkflow
  checkpoint: Krea2CheckpointChoice
  recipe: { steps: number; cfg: number; sampler: string; scheduler: string; denoise: number; loraStrength: number }
  /** Dials the workflow exposes (validated against the pins above). */
  dials: readonly Krea2EditDial[]
  recipeTriple: Krea2RecipeTriple
  requiredNodes: readonly string[]
  detect(info: ObjectInfo | undefined, files: ModelFile[]): Krea2EditDetection
  ui: {
    description: string
    warning?: string
    installHint?: string
    /** Prompt contract for the surface that shows prompt instructions
     * (E-K1: prompts are scene-style — describe the whole resulting
     * scene/image, never just the changed or masked object). */
    promptGuidance?: string
  }
}

export type Krea2EditDetection = {
  available: boolean
  /** Engine node classes required but absent (install the node pack). */
  missingNodes: string[]
  /** Human-readable missing weights with install pointers. */
  missingModels: string[]
  /** The concrete files a build would use, when everything resolves. */
  resolved?: { diffusion: string; textEncoder: string; vae: string; lora: string }
}

export type Krea2Padding = { left: number; top: number; right: number; bottom: number }

export type Krea2EditRequest = {
  family: string
  prompt: string
  /** Source image upload name (scene for two-ref). */
  source: string
  /** Second reference (the PERSON) — two-ref only, fixed order. */
  subject?: string
  /** The source upload carries a Mask-Editor mask (LoadImage MASK output).
   * Required for refine; optional for outpaint (mixed in+outpaint). */
  mask?: boolean
  width: number
  height: number
  seed: number
  filenamePrefix: string
  groundingPx?: number
  refBoost?: number
  refBoostA?: number
  fitMode?: Krea2FitMode
  padding?: Partial<Krea2Padding>
  steps?: number
  cfg?: number
}

export type Krea2ModelSelection = {
  turbo: string
  raw: string
  textEncoder: string
  vae: string
  identityEditLora: string
  anypaintLora: string
}

export type Krea2BaseOptions = {
  prompt: string
  width: number
  height: number
  seed: number
  filenamePrefix: string
  steps?: number
  cfg?: number
  negative?: string
}

export type Krea2BuildOptions = Krea2BaseOptions & { edit?: Krea2EditRequest }

/** What an edit transform hands back to the factory: the conditioning /
 * latent links the sampler consumes instead of the base skeleton's. */
type Krea2EditOverlay = { positive: Link; negative?: Link; latent?: Link }

// ---------------------------------------------------------------------------
// Base t2i graph — the inertness reference
// ---------------------------------------------------------------------------

/** The canonical Krea 2 Turbo t2i graph (official template shape):
 * loaders, stock text encodes, EmptySD3LatentImage canvas, KSampler at the
 * Turbo operating point, decode, save. Edit families compose FROM this
 * skeleton — with no edit request the output is exactly this graph. */
export function buildKrea2T2iGraph(options: Krea2BaseOptions, models: Pick<Krea2ModelSelection, 'turbo' | 'textEncoder' | 'vae'>): ComfyPrompt {
  const missingBase = [['Turbo checkpoint', models.turbo], ['text encoder', models.textEncoder], ['VAE', models.vae]].filter(([, name]) => !name).map(([label]) => label)
  if (missingBase.length) throw new Error(`the Krea 2 t2i graph is missing required files from the scan: ${missingBase.join(', ')} — build only from a resolved selection`)
  const steps = options.steps ?? KREA2_RECIPE_PINS.turbo.steps
  const cfg = options.cfg ?? KREA2_RECIPE_PINS.turbo.cfg
  validateKrea2Canvas(options.width, options.height)
  const prompt: ComfyPrompt = {
    [KREA2.unet]: { class_type: 'UNETLoader', inputs: { unet_name: models.turbo, weight_dtype: 'default' } },
    [KREA2.clip]: { class_type: 'CLIPLoader', inputs: { clip_name: models.textEncoder, type: 'krea2', device: 'default' } },
    [KREA2.vae]: { class_type: 'VAELoader', inputs: { vae_name: models.vae } },
    [KREA2.positive]: { class_type: 'CLIPTextEncode', inputs: { clip: [KREA2.clip, 0], text: options.prompt } },
    [KREA2.negative]: { class_type: 'CLIPTextEncode', inputs: { clip: [KREA2.clip, 0], text: options.negative ?? '' } },
    [KREA2.emptyLatent]: { class_type: 'EmptySD3LatentImage', inputs: { width: options.width, height: options.height, batch_size: 1 } },
    [KREA2.sampler]: {
      class_type: 'KSampler',
      inputs: {
        model: [KREA2.unet, 0],
        positive: [KREA2.positive, 0],
        negative: [KREA2.negative, 0],
        latent_image: [KREA2.emptyLatent, 0],
        seed: options.seed,
        steps,
        cfg,
        sampler_name: KREA2_RECIPE_PINS.turbo.sampler,
        scheduler: KREA2_RECIPE_PINS.turbo.scheduler,
        denoise: KREA2_RECIPE_PINS.turbo.denoise,
      },
    },
    [KREA2.decode]: { class_type: 'VAEDecode', inputs: { samples: [KREA2.sampler, 0], vae: [KREA2.vae, 0] } },
    [KREA2.save]: { class_type: 'SaveImage', inputs: { images: [KREA2.decode, 0], filename_prefix: options.filenamePrefix } },
  }
  return prompt
}

/** The full builder: base t2i skeleton + (optionally) one edit family's
 * insert-only transform. No `edit` → exactly buildKrea2T2iGraph output. */
export function buildKrea2Graph(options: Krea2BuildOptions, models: Krea2ModelSelection): ComfyPrompt {
  if (!options.edit) return buildKrea2T2iGraph(options, models)
  const family = findKrea2EditFamily(options.edit.family)
  if (!family) throw new Error(`unknown Krea 2 edit family '${options.edit.family}'`)
  validateKrea2EditRequest(family, options.edit)
  // Detection gates the UI, but the builder still refuses to emit a graph
  // with an empty filename — an un-gated caller gets a loud error, never a
  // silently-broken graph.
  const missingFiles: string[] = []
  if (family.checkpoint === 'raw' ? !models.raw : !models.turbo) missingFiles.push(`${family.checkpoint === 'raw' ? 'RAW' : 'Turbo'} Krea 2 checkpoint`)
  if (!models.textEncoder) missingFiles.push('Qwen3-VL 4B text encoder')
  if (!models.vae) missingFiles.push('VAE')
  if (family.recipeTriple.loraKind === 'identity-edit' ? !models.identityEditLora : !models.anypaintLora) missingFiles.push(family.recipeTriple.loraKind === 'identity-edit' ? 'Identity Edit LoRA' : 'AnyPaint LoRA')
  if (missingFiles.length) throw new Error(`${family.id} cannot build — the scan resolved none of: ${missingFiles.join(', ')}`)

  const prompt: ComfyPrompt = {
    [KREA2.unet]: { class_type: 'UNETLoader', inputs: { unet_name: family.checkpoint === 'raw' ? models.raw : models.turbo, weight_dtype: 'default' } },
    [KREA2.clip]: { class_type: 'CLIPLoader', inputs: { clip_name: models.textEncoder, type: 'krea2', device: 'default' } },
    [KREA2.vae]: { class_type: 'VAELoader', inputs: { vae_name: models.vae } },
    [KREA2.positive]: { class_type: 'CLIPTextEncode', inputs: { clip: [KREA2.clip, 0], text: options.edit.prompt } },
    [KREA2.negative]: { class_type: 'CLIPTextEncode', inputs: { clip: [KREA2.clip, 0], text: options.negative ?? '' } },
  }
  const ctx = createGraphContext(prompt, KREA2.unet, { workflow: family.workflow, checkpoint: family.checkpoint })
  ctx.bind('unet', KREA2.unet)
  ctx.bind('clip', KREA2.clip)
  ctx.bind('vae', KREA2.vae)
  ctx.bind('positive', KREA2.positive)
  ctx.bind('negative', KREA2.negative)

  // The empty canvas exists up-front when the family samples it (identity
  // families wire it into the patch's target_latent for the pre-encode path).
  const suppliesLatent = family.recipeTriple.loraKind === 'anypaint'
  if (!suppliesLatent) {
    prompt[KREA2.emptyLatent] = { class_type: 'EmptySD3LatentImage', inputs: { width: options.edit.width, height: options.edit.height, batch_size: 1 } }
    ctx.bind('emptyLatent', KREA2.emptyLatent)
  }

  const overlay = family.recipeTriple.loraKind === 'anypaint'
    ? anypaintTransform(prompt, ctx, family, options.edit, models)
    : identityEditTransform(prompt, ctx, family, options.edit, models)

  const latent = overlay.latent ?? ctx.link('emptyLatent')
  const steps = options.edit.steps ?? family.recipe.steps
  const cfg = options.edit.cfg ?? family.recipe.cfg
  prompt[KREA2.sampler] = {
    class_type: 'KSampler',
    inputs: {
      model: ctx.modelLink(),
      positive: overlay.positive,
      negative: overlay.negative ?? ctx.link('negative'),
      latent_image: latent,
      seed: options.edit.seed,
      steps,
      cfg,
      sampler_name: family.recipe.sampler,
      scheduler: family.recipe.scheduler,
      denoise: family.recipe.denoise,
    },
  }
  prompt[KREA2.decode] = { class_type: 'VAEDecode', inputs: { samples: [KREA2.sampler, 0], vae: [KREA2.vae, 0] } }
  // Masked families: the decode IS the output — no post-hoc source composite
  // ever follows (the AnyPaint encode owns preservation and the boundary
  // band; adding a composite is warned against upstream).
  prompt[KREA2.save] = { class_type: 'SaveImage', inputs: { images: [KREA2.decode, 0], filename_prefix: options.edit.filenamePrefix } }
  return prompt
}

// ---------------------------------------------------------------------------
// Family transforms (insert-only; re-point only the factory's own sampler)
// ---------------------------------------------------------------------------

/** Identity Edit dual conditioning: the source rides BOTH paths the LoRA was
 * trained with — VAE latent tokens prepended as clean in-context tokens at
 * RoPE frame 1 (Krea2EditModelPatch, with the vae+source_image pixel path and
 * target_latent pre-encode) AND the image-grounded Qwen3-VL encode
 * (Krea2EditGroundedEncode). At CFG>1 the negative is grounded too (empty
 * prompt + same image — the trained unconditional); at CFG<=1 the stock empty
 * encode is the unused-by-math negative. */
function identityEditTransform(prompt: ComfyPrompt, ctx: GraphContext, family: Krea2EditFamily, edit: Krea2EditRequest, models: Krea2ModelSelection): Krea2EditOverlay {
  const twoRef = family.workflow === 'two-ref'
  const groundingPx = edit.groundingPx ?? KREA2_RECIPE_PINS.groundingPx.default
  const refBoost = edit.refBoost ?? KREA2_RECIPE_PINS.refBoost.default
  const fitMode = edit.fitMode ?? KREA2_RECIPE_PINS.fitMode.default
  const cfg = edit.cfg ?? family.recipe.cfg

  prompt[KREA2.sourceLoader] = { class_type: 'LoadImage', inputs: { image: edit.source } }
  prompt[KREA2.sourceEncode] = { class_type: 'VAEEncode', inputs: { pixels: [KREA2.sourceLoader, 0], vae: ctx.link('vae') } }
  if (twoRef) {
    if (!edit.subject) throw new Error(`krea2edit.two-ref needs the person reference as 'subject' (fixed order: scene=1, person=2)`)
    prompt[KREA2.subjectLoader] = { class_type: 'LoadImage', inputs: { image: edit.subject } }
    prompt[KREA2.subjectEncode] = { class_type: 'VAEEncode', inputs: { pixels: [KREA2.subjectLoader, 0], vae: ctx.link('vae') } }
  }

  ctx.wrapModel('editLora', KREA2.editLora, {
    class_type: 'LoraLoaderModelOnly',
    inputs: { lora_name: models.identityEditLora, strength_model: family.recipe.loraStrength },
  })
  ctx.wrapModel('editPatch', KREA2.editPatch, {
    class_type: 'Krea2EditModelPatch',
    inputs: {
      source_latent: [KREA2.sourceEncode, 0],
      vae: ctx.link('vae'),
      source_image: [KREA2.sourceLoader, 0],
      target_latent: ctx.link('emptyLatent'),
      fit_mode: fitMode,
      ref_boost: refBoost,
      ...(twoRef
        ? {
            source_latent_b: [KREA2.subjectEncode, 0],
            source_image_b: [KREA2.subjectLoader, 0],
            ref_boost_a: edit.refBoostA ?? KREA2_RECIPE_PINS.refBoost.default,
          }
        : {}),
    },
  })

  prompt[KREA2.groundedPositive] = {
    class_type: 'Krea2EditGroundedEncode',
    inputs: {
      clip: ctx.link('clip'),
      prompt: edit.prompt,
      image: [KREA2.sourceLoader, 0],
      grounding_px: groundingPx,
      ...(twoRef ? { image_b: [KREA2.subjectLoader, 0] } : {}),
    },
  }
  let overlay: Krea2EditOverlay = { positive: [KREA2.groundedPositive, 0] }
  if (cfg > 1) {
    // Documented requirement: the trained unconditional is an empty-prompt
    // encode OF THE SAME IMAGE — a bare text-only negative silently changes
    // the edit at any CFG above 1.
    prompt[KREA2.groundedNegative] = {
      class_type: 'Krea2EditGroundedEncode',
      inputs: {
        clip: ctx.link('clip'),
        prompt: '',
        image: [KREA2.sourceLoader, 0],
        grounding_px: groundingPx,
        ...(twoRef ? { image_b: [KREA2.subjectLoader, 0] } : {}),
      },
    }
    overlay = { positive: overlay.positive, negative: [KREA2.groundedNegative, 0] }
  }
  return overlay
}

/** AnyPaint masked path: Prepare builds the padded canvas + masks + 384px
 * semantic reference; Encode produces the conditioning AND the latent (the
 * known image with a token-aligned noise_mask — the sampler's per-step
 * known-region restoration); ModelPatch registers the reference over the
 * target grid with its isolated K/V cache, after the LoRA, before KSampler.
 * White mask/padded pixels generate; black is preserved. */
function anypaintTransform(prompt: ComfyPrompt, ctx: GraphContext, family: Krea2EditFamily, edit: Krea2EditRequest, models: Krea2ModelSelection): Krea2EditOverlay {
  const pins = KREA2_RECIPE_PINS.anypaint
  const padding = resolveKrea2Padding(edit.padding, family.workflow === 'outpaint')
  const wireMask = family.workflow === 'refine' || (family.workflow === 'outpaint' && Boolean(edit.mask))
  prompt[KREA2.paintLoader] = { class_type: 'LoadImage', inputs: { image: edit.source } }
  prompt[KREA2.paintPrepare] = {
    class_type: 'Krea2AnyPaintPrepare',
    inputs: {
      source: [KREA2.paintLoader, 0],
      left: padding.left,
      top: padding.top,
      right: padding.right,
      bottom: padding.bottom,
      reference_max_edge: pins.referenceMaxEdge,
      boundary_redraw_px: pins.boundaryRedrawPx,
      ...(wireMask ? { generated_mask: [KREA2.paintLoader, 1] } : {}),
    },
  }
  prompt[KREA2.paintEncode] = {
    class_type: 'Krea2AnyPaintEncode',
    inputs: {
      clip: ctx.link('clip'),
      prompt: edit.prompt,
      vae: ctx.link('vae'),
      semantic_reference: [KREA2.paintPrepare, 0],
      known_image: [KREA2.paintPrepare, 1],
      keep_mask: [KREA2.paintPrepare, 3],
      vlm_reference: pins.vlmReference,
    },
  }
  ctx.wrapModel('editLora', KREA2.editLora, {
    class_type: 'LoraLoaderModelOnly',
    inputs: { lora_name: models.anypaintLora, strength_model: family.recipe.loraStrength },
  })
  ctx.wrapModel('paintPatch', KREA2.paintPatch, {
    class_type: 'Krea2AnyPaintModelPatch',
    inputs: { kv_cache: pins.kvCache },
  })
  return { positive: [KREA2.paintEncode, 0], latent: [KREA2.paintEncode, 1] }
}

function resolveKrea2Padding(padding: Partial<Krea2Padding> | undefined, outpaintDefaults: boolean): Krea2Padding {
  if (padding) return { left: padding.left ?? 0, top: padding.top ?? 0, right: padding.right ?? 0, bottom: padding.bottom ?? 0 }
  // Default padding is ours (the research pins no number): a symmetric
  // 256-px band on every side for the outpaint family, zero for refine.
  return outpaintDefaults ? { left: 256, top: 256, right: 256, bottom: 256 } : { left: 0, top: 0, right: 0, bottom: 0 }
}

// ---------------------------------------------------------------------------
// Validation — the research limits, enforced at the factory boundary
// ---------------------------------------------------------------------------

function megapixels(width: number, height: number): number {
  return (width * height) / 1_000_000
}

function validateKrea2Canvas(width: number, height: number): void {
  const multiple = KREA2_RECIPE_PINS.canvasMultiple
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Krea 2 canvas needs positive integer dimensions (got ${width}x${height})`)
  }
  if (width % multiple !== 0 || height % multiple !== 0) {
    throw new Error(`Krea 2 canvas dimensions must be multiples of ${multiple} (got ${width}x${height})`)
  }
}

function validateGroundingPx(value: number | undefined): void {
  if (value === undefined) return
  const { min, max } = KREA2_RECIPE_PINS.groundingPx
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`groundingPx must be an integer in the trained ${min}–${max} band (got ${value}; lower = stronger edits, higher = stronger identity — far above the band duplicates compositions)`)
  }
}

function validateRefBoost(name: string, value: number | undefined): void {
  if (value === undefined) return
  const { min, max } = KREA2_RECIPE_PINS.refBoost
  if (!(value > min) || value > max) {
    throw new Error(`${name} must be greater than ${min} and at most ${max} — the card documents that ref_boost above ${KREA2_RECIPE_PINS.refBoost.removalBreakAbove} breaks removals (got ${value})`)
  }
}

/** Validates one edit request against its family's pinned limits. Throws
 * with an actionable message; the thin UI surfaces it verbatim. */
export function validateKrea2EditRequest(family: Krea2EditFamily, edit: Krea2EditRequest): void {
  validateKrea2Canvas(edit.width, edit.height)
  const mp = megapixels(edit.width, edit.height)
  if (family.recipeTriple.loraKind === 'identity-edit') {
    validateGroundingPx(edit.groundingPx)
    validateRefBoost('refBoost', edit.refBoost)
    if (family.workflow === 'two-ref') {
      validateRefBoost('refBoostA', edit.refBoostA)
      if (mp > KREA2_RECIPE_PINS.megapixels.twoRefMax) {
        throw new Error(`two-reference edits run at ${KREA2_RECIPE_PINS.megapixels.twoRefPreferredMin}–${KREA2_RECIPE_PINS.megapixels.twoRefMax}MP — above that the two identities blend (got ${mp.toFixed(2)}MP; generate lower and upscale)`)
      }
      if (!edit.subject) throw new Error("krea2edit.two-ref needs 'subject' (the person; scene stays 'source' — the order is fixed by training)")
    } else if (mp > KREA2_RECIPE_PINS.megapixels.instructMax) {
      throw new Error(`identity edits generate at <=${KREA2_RECIPE_PINS.megapixels.instructMax}MP — above the trained range source content bleeds and subjects duplicate (got ${mp.toFixed(2)}MP)`)
    }
    if (edit.fitMode !== undefined && edit.fitMode !== KREA2_RECIPE_PINS.fitMode.default && edit.fitMode !== KREA2_RECIPE_PINS.fitMode.legacy) {
      throw new Error(`fitMode must be '${KREA2_RECIPE_PINS.fitMode.default}' or '${KREA2_RECIPE_PINS.fitMode.legacy}' (got '${edit.fitMode}')`)
    }
    if (edit.steps !== undefined) {
      const band = KREA2_RECIPE_PINS.turboStepsBand
      const within = edit.steps >= band.min && edit.steps <= band.max
      if (family.workflow === 'removal') {
        throw new Error(`the removal recipe pins ${family.recipe.steps} steps on RAW — the step dial belongs to the Turbo instruct families`)
      }
      if (!within) throw new Error(`Turbo identity-edit steps run in the ${band.min}–${band.max} band (8 favors composition, 12 favors face detail; got ${edit.steps})`)
    }
    if (edit.cfg !== undefined && !(edit.cfg > 0)) {
      throw new Error(`cfg must be positive (got ${edit.cfg}) — ComfyUI expresses the guidance-0 operating point as CFG 1.0`)
    }
  } else {
    if (edit.steps !== undefined || edit.cfg !== undefined) {
      throw new Error('AnyPaint is Turbo-locked: 8 steps / CFG 1.0 / Euler+simple — the adapter is trained for distilled inference, and the sampler dials are not exposed')
    }
    const pins = KREA2_RECIPE_PINS.anypaint
    const padding = resolveKrea2Padding(edit.padding, family.workflow === 'outpaint')
    const sides: Array<[string, number]> = [['left', padding.left], ['top', padding.top], ['right', padding.right], ['bottom', padding.bottom]]
    for (const [name, value] of sides) {
      if (!Number.isInteger(value) || value < 0 || value > pins.paddingMax) {
        throw new Error(`padding.${name} must be an integer in 0–${pins.paddingMax} (got ${value})`)
      }
      if (value % pins.paddingStep !== 0) {
        throw new Error(`padding.${name} must be a multiple of ${pins.paddingStep} like the node's own grid (got ${value})`)
      }
    }
    if (family.workflow === 'refine') {
      if (edit.mask === false) throw new Error('masked refinement needs the mask — use the outpaint family for padding-only canvas growth')
      if (padding.left || padding.top || padding.right || padding.bottom) {
        throw new Error('refine is zero-padding inpainting; padding + mask in one request belongs to the outpaint (mixed) family')
      }
    }
    if (family.workflow === 'outpaint' && !padding.left && !padding.top && !padding.right && !padding.bottom) {
      throw new Error('outpaint needs padding on at least one side — use the refine family for in-canvas masks')
    }
  }
}

// ---------------------------------------------------------------------------
// Model resolution from a scan (quant policy: int8-convrot > fp8_scaled >
// any non-NVFP4/MXFP8 official variant; the TE must be the VL 4B)
// ---------------------------------------------------------------------------

const EXCLUDED_QUANT = /(nvfp4|mxfp8)/i

function firstFileMatch(files: ModelFile[], kind: ModelFile['kind'], patterns: RegExp[]): string {
  const candidates = files.filter((file) => file.kind === kind && !EXCLUDED_QUANT.test(file.name))
  for (const pattern of patterns) {
    const match = candidates.find((file) => pattern.test(file.name))
    if (match) return match.name
  }
  return ''
}

/** Preference order per file family — first pattern that matches wins. */
const KREA2_FILE_PATTERNS = {
  turbo: [
    /^krea2_turbo_int8_convrot\.safetensors$/i,
    /^krea2_turbo_fp8_scaled\.safetensors$/i,
    /^krea2_turbo[a-z0-9_.]*\.safetensors$/i,
  ],
  raw: [
    /^krea2_raw_int8_convrot\.safetensors$/i,
    /^krea2_raw_fp8_scaled\.safetensors$/i,
    /^krea2_raw[a-z0-9_.]*\.safetensors$/i,
  ],
  /** The edit encode paths need the Qwen3-VL VISION tower — a text-only
   * Qwen3 encoder in this slot fails obscurely, so the gate is explicit. */
  textEncoder: [/^qwen3vl_4b[a-z0-9_.]*\.safetensors$/i],
  vae: [/^qwen_image_vae\.safetensors$/i],
  /** Full v1.2 first, then the SVD-reduced low-VRAM fallbacks (rank order:
   * full > r128 > r64 — >99% weight energy retained either way). */
  identityEditLora: [
    /^krea2_identity_edit_v1_2\.safetensors$/i,
    /^krea2_identity_edit_v1_2_r128\.safetensors$/i,
    /^krea2_identity_edit_v1_2_r64\.safetensors$/i,
  ],
  anypaintLora: [/^krea2_anypaint_rank32\.safetensors$/i],
} as const

/** Resolves the Krea 2 edit stack from a model scan. Empty strings mark
 * absences (detection turns them into install guidance). */
export function resolveKrea2EditModels(files: ModelFile[]): Krea2ModelSelection {
  return {
    turbo: firstFileMatch(files, 'diffusion_models', [...KREA2_FILE_PATTERNS.turbo]),
    raw: firstFileMatch(files, 'diffusion_models', [...KREA2_FILE_PATTERNS.raw]),
    textEncoder: firstFileMatch(files, 'text_encoders', [...KREA2_FILE_PATTERNS.textEncoder]),
    vae: firstFileMatch(files, 'vae', [...KREA2_FILE_PATTERNS.vae]),
    identityEditLora: firstFileMatch(files, 'loras', [...KREA2_FILE_PATTERNS.identityEditLora]),
    anypaintLora: firstFileMatch(files, 'loras', [...KREA2_FILE_PATTERNS.anypaintLora]),
  }
}

// ---------------------------------------------------------------------------
// The five families
// ---------------------------------------------------------------------------

function missingModelsFor(checkpoint: Krea2CheckpointChoice, loraKind: Krea2LoraKind, models: Krea2ModelSelection): { missing: string[]; resolved?: Krea2EditDetection['resolved'] } {
  const missing: string[] = []
  const diffusion = checkpoint === 'raw' ? models.raw : models.turbo
  if (!diffusion) missing.push(checkpoint === 'raw' ? 'Krea 2 RAW checkpoint (models/diffusion_models — krea2_raw_int8_convrot.safetensors)' : 'Krea 2 Turbo checkpoint (models/diffusion_models — krea2_turbo_int8_convrot.safetensors)')
  if (!models.textEncoder) missing.push('Qwen3-VL 4B text encoder with the vision tower (models/text_encoders — qwen3vl_4b_fp8_scaled.safetensors; the edit encodes need the VL weights)')
  if (!models.vae) missing.push('qwen_image_vae (models/vae — qwen_image_vae.safetensors)')
  const lora = loraKind === 'identity-edit' ? models.identityEditLora : models.anypaintLora
  if (!lora) missing.push(loraKind === 'identity-edit' ? 'Identity Edit v1.2 LoRA (models/loras — krea2_identity_edit_v1_2.safetensors, or the _r128/_r64 low-VRAM cuts)' : 'AnyPaint rank-32 LoRA (models/loras — krea2_anypaint_rank32.safetensors)')
  if (missing.length) return { missing }
  return { missing, resolved: { diffusion, textEncoder: models.textEncoder, vae: models.vae, lora } }
}

function familyDetect(checkpoint: Krea2CheckpointChoice, requiredNodes: readonly string[], loraKind: Krea2LoraKind) {
  return (info: ObjectInfo | undefined, files: ModelFile[]): Krea2EditDetection => {
    const models = resolveKrea2EditModels(files)
    const missingNodes = requiredNodes.filter((nodeClass) => !info?.[nodeClass])
    const { missing, resolved } = missingModelsFor(checkpoint, loraKind, models)
    return { available: missingNodes.length === 0 && missing.length === 0, missingNodes, missingModels: missing, resolved }
  }
}

const IDENTITY_TRIPLE: Krea2RecipeTriple = {
  loraKind: 'identity-edit',
  encode: 'Krea2EditGroundedEncode',
  transport: 'Krea2EditModelPatch',
  carrier: 'in-context source tokens at RoPE frame 1 (the `index` recipe — never the t=0 carrier)',
}

const ANYPAINT_TRIPLE: Krea2RecipeTriple = {
  loraKind: 'anypaint',
  encode: 'Krea2AnyPaintEncode',
  transport: 'Krea2AnyPaintModelPatch',
  carrier: 'reference latents in the conditioning + reference registered over the target grid (isolated K/V cache)',
}

export const KREA2_EDIT_FAMILIES: Krea2EditFamily[] = [
  {
    id: 'krea2edit.instruct',
    label: 'Instruct edit',
    workflow: 'instruct',
    checkpoint: 'turbo',
    recipe: { ...KREA2_RECIPE_PINS.turbo },
    dials: ['groundingPx', 'refBoost', 'fitMode', 'steps', 'cfg'],
    recipeTriple: IDENTITY_TRIPLE,
    requiredNodes: KREA2EDIT_NODES,
    detect: familyDetect('turbo', KREA2EDIT_NODES, 'identity-edit'),
    ui: {
      description: 'Plain-language instruction + source image → edited image with texture-faithful identity. The edit is a semantic regeneration of the whole frame, not a local patch — identity holds (measured 0.94–0.98 through the edit) while pixels everywhere are free to move. Dual conditioning on the resident Turbo checkpoint; most edits land in ~1 minute at 2MP.',
      warning: 'Identity-preserving (measured 0.94–0.98 through the edit), NOT region-preserving (E-K1, measured on int8): content outside the edit region drifted 26.5 dB — roughly 10× the VAE floor — because the whole frame regenerates. When untouched regions must stay pixel-exact, use Refine (masked), which measured at the VAE floor (40–47 dB) outside the mask. Weak classes (documented): semantic interaction edits, full background replacement, pose retention in clothes swaps.',
      installHint: 'Settings → Fetchable items: the comfyui-krea2edit node pack + the Identity Edit v1.2 LoRA (Krea 2 Community License), then rescan.',
      promptGuidance: 'Scene-style: describe the whole resulting scene, not just the changed object — the model regenerates the entire frame, so everything you want kept or changed belongs in the prompt ("the same kitchen counter, now with a copper kettle beside the lemons"). An object-local prompt leaves the regenerated rest of the frame under-specified.',
    },
  },
  {
    id: 'krea2edit.removal',
    label: 'Object removal',
    workflow: 'removal',
    checkpoint: 'raw',
    recipe: { ...KREA2_RECIPE_PINS.removal },
    dials: ['groundingPx', 'refBoost', 'fitMode', 'cfg'],
    recipeTriple: IDENTITY_TRIPLE,
    requiredNodes: KREA2EDIT_NODES,
    detect: familyDetect('raw', KREA2EDIT_NODES, 'identity-edit'),
    ui: {
      description: 'The documented removal recipe: Identity Edit on the RAW checkpoint at CFG 3.0 / 20 steps — Turbo CFG-1 re-renders instead of removing, so this variant pays the model swap.',
      warning: 'ref_boost stays modest here — the card documents that ref_boost above 10 breaks removals (the UI caps the dial at 6). Expect occasional re-renders instead of deletions.',
      installHint: 'Needs the Krea 2 RAW checkpoint (models/diffusion_models — krea2_raw_int8_convrot.safetensors) in addition to the Instruct stack; the swap cost is a one-time model load per session.',
    },
  },
  {
    id: 'krea2edit.refine',
    label: 'Refine (masked)',
    workflow: 'refine',
    checkpoint: 'turbo',
    recipe: { steps: KREA2_RECIPE_PINS.anypaint.steps, cfg: KREA2_RECIPE_PINS.anypaint.cfg, sampler: KREA2_RECIPE_PINS.anypaint.sampler, scheduler: KREA2_RECIPE_PINS.anypaint.scheduler, denoise: KREA2_RECIPE_PINS.anypaint.denoise, loraStrength: KREA2_RECIPE_PINS.anypaint.loraStrength },
    dials: ['mask', 'cfg'],
    recipeTriple: ANYPAINT_TRIPLE,
    requiredNodes: ANYPAINT_NODES,
    detect: familyDetect('turbo', ANYPAINT_NODES, 'anypaint'),
    ui: {
      description: 'Arbitrary-mask inpainting with per-step latent restoration: known tokens are restored at the matching noise level every step and a 32-px boundary band blends the seam. White mask pixels generate, black is preserved.',
      warning: 'The output is the raw decode — never add a source composite on top (the boundary blend is the encode\'s own property and does not survive one). Do not stack the identity-edit LoRA here; the untested combination is refused by the recipe audit.',
      installHint: 'Settings → Fetchable items: the krea2-anypaint node pack + the AnyPaint rank-32 LoRA (Krea 2 Community License), then rescan.',
      promptGuidance: 'Scene-style prompt required (E-K1, measured): describe the complete finished image — surroundings, lighting, and the masked content in place — never just the masked object. An object-local prompt ("a bowl of lemons") regenerates surface texture instead of inserting the object: the measurement painted plausible planks, no bowl.',
    },
  },
  {
    id: 'krea2edit.outpaint',
    label: 'Outpaint',
    workflow: 'outpaint',
    checkpoint: 'turbo',
    recipe: { steps: KREA2_RECIPE_PINS.anypaint.steps, cfg: KREA2_RECIPE_PINS.anypaint.cfg, sampler: KREA2_RECIPE_PINS.anypaint.sampler, scheduler: KREA2_RECIPE_PINS.anypaint.scheduler, denoise: KREA2_RECIPE_PINS.anypaint.denoise, loraStrength: KREA2_RECIPE_PINS.anypaint.loraStrength },
    dials: ['padding', 'mask', 'cfg'],
    recipeTriple: ANYPAINT_TRIPLE,
    requiredNodes: ANYPAINT_NODES,
    detect: familyDetect('turbo', ANYPAINT_NODES, 'anypaint'),
    ui: {
      description: 'Canvas growth on any side via AnyPaint padding; a mask plus padding in one request is mixed in+outpaint. Padding moves in 16-px steps like the node\'s own grid.',
      warning: 'Same no-composite rule as Refine — the padded boundary band is the blend mechanism.',
      installHint: 'Settings → Fetchable items: the krea2-anypaint node pack + the AnyPaint rank-32 LoRA (Krea 2 Community License), then rescan.',
      promptGuidance: 'Scene-style prompt (E-K1): describe the complete finished image across the grown canvas — the original content and the extension as one coherent scene — not just the new region.',
    },
  },
  {
    id: 'krea2edit.two-ref',
    label: 'Person into scene (two refs)',
    workflow: 'two-ref',
    checkpoint: 'turbo',
    recipe: { ...KREA2_RECIPE_PINS.turbo },
    dials: ['groundingPx', 'refBoost', 'refBoostA', 'fitMode', 'steps', 'cfg'],
    recipeTriple: IDENTITY_TRIPLE,
    requiredNodes: KREA2EDIT_NODES,
    detect: familyDetect('turbo', KREA2EDIT_NODES, 'identity-edit'),
    ui: {
      description: 'Scene + person as separate references in ONE simultaneous pass (more reliable than chaining): the scene rides image 1 / RoPE frame 1, the person image 2 / frame 2 — the order is fixed by training.',
      warning: 'Runs at 1–1.5MP — above that the two identities drift together. ref_boost boosts the person (last ref); ref_boost_a the scene.',
      installHint: 'Same stack as Instruct: the comfyui-krea2edit node pack + the Identity Edit v1.2 LoRA.',
    },
  },
]

export function findKrea2EditFamily(id: string): Krea2EditFamily | undefined {
  return KREA2_EDIT_FAMILIES.find((family) => family.id === id)
}

/** Availability of every family against the live engine + scan — the mode
 * picker surface (gating + install guidance). */
export function detectKrea2EditFamilies(info: ObjectInfo | undefined, files: ModelFile[]): Array<{ family: Krea2EditFamily; detection: Krea2EditDetection }> {
  return KREA2_EDIT_FAMILIES.map((family) => ({ family, detection: family.detect(info, files) }))
}

// ---------------------------------------------------------------------------
// Recipe audit — the Kreatine correctness rules as executable checks
// ---------------------------------------------------------------------------

/** Post-hoc composites are forbidden in the masked graphs (and meaningless in
 * the others): AnyPaint's per-step restoration plus its 32-px band IS the
 * preservation mechanism; a composite node after the decode undoes the
 * doctrine upstream warns against. */
export const KREA2_FORBIDDEN_COMPOSITE_NODES = ['ImageCompositeMasked', 'ImageComposite', 'MaskBlend', 'LanPaintMaskBlend', 'BlendLatents', 'ImageBlend', 'ImageCompositeMaskedByColor'] as const

/** Whole-pipeline forward patchers cannot compose (the D3 lesson): both edit
 * packs replace diffusion_model.forward wholesale, so a graph carrying both
 * is undefined — the factory never builds one and the audit proves it. */
export const KREA2_WHOLE_PIPELINE_PATCHERS = ['Krea2EditModelPatch', 'Krea2AnyPaintModelPatch'] as const

/** The core-native t=0 carrier pair (ReferenceLatent + Edit Model Reference
 * Method). Legitimate for ostris-recipe LoRAs, silent destruction for the
 * identity LoRA, and a ReferenceLatent WITHOUT a method node silently drops
 * references entirely (Krea 2 sets no default_ref_method). E-K1 replicated
 * the trap on our int8 stack through these core nodes: meanAD 5.30 at
 * 'index' (on-recipe) vs 40.06 at 'index_timestep_zero' — same ~8×
 * destruction class as Kreatine's 8.18 vs 50.06 — with plausible-looking
 * output, so only an audit catches it. */
const REFERENCE_CARRIER_NODES = { latent: 'ReferenceLatent', method: 'Edit Model Reference Method' } as const
const T0_METHOD_VALUE = 'index_timestep_zero'
/** The only reference-latent method that pairs with the identity-edit LoRA
 * (the E-K1-measured pairing: in-context source tokens at frame 1). */
const INDEX_METHOD_VALUE = 'index'

export function krea2LoraKindOfFilename(filename: string): Krea2LoraKind | undefined {
  if (KREA2_FILE_PATTERNS.identityEditLora.some((pattern) => pattern.test(filename))) return 'identity-edit'
  if (KREA2_FILE_PATTERNS.anypaintLora.some((pattern) => pattern.test(filename))) return 'anypaint'
  return undefined
}

/** Walks a built Krea 2 graph and reports every recipe-triple violation:
 * encode/transport/LoRA mismatches, the t=0 carrier trap, silent
 * reference-drop footguns, whole-patcher stacking, and post-hoc composites.
 * Empty array = the graph obeys every correctness rule. */
export function krea2RecipeAudit(graph: ComfyPrompt): string[] {
  const violations: string[] = []
  const nodes = Object.values(graph)
  const classes = nodes.map((node) => node.class_type)

  const loraKinds = new Set<Krea2LoraKind>()
  for (const node of nodes) {
    if (node.class_type !== 'LoraLoaderModelOnly') continue
    const name = typeof node.inputs.lora_name === 'string' ? node.inputs.lora_name : ''
    const kind = krea2LoraKindOfFilename(name)
    if (kind) loraKinds.add(kind)
  }

  const identityActive = loraKinds.has('identity-edit')
  const anypaintActive = loraKinds.has('anypaint')

  if (identityActive) {
    if (!classes.includes(IDENTITY_TRIPLE.encode)) violations.push(`identity-edit LoRA without its grounded encode ${IDENTITY_TRIPLE.encode} — the semantic half of the dual conditioning is missing`)
    if (!classes.includes(IDENTITY_TRIPLE.transport)) violations.push(`identity-edit LoRA without its transport ${IDENTITY_TRIPLE.transport} — ${IDENTITY_TRIPLE.carrier}`)
    const method = nodes.find((node) => node.class_type === REFERENCE_CARRIER_NODES.method)
    const methodValue = typeof method?.inputs.method === 'string' ? method.inputs.method : ''
    // Wrong method VALUE with the identity LoRA (t=0 is the measured trap;
    // any other off-recipe value is the same silent-destruction class).
    if (method && methodValue !== INDEX_METHOD_VALUE) {
      violations.push(
        methodValue === T0_METHOD_VALUE
          ? `identity-edit LoRA on the t=0 carrier (${REFERENCE_CARRIER_NODES.method} method '${T0_METHOD_VALUE}') — the measured recipe trap: the reference region is silently destroyed (meanAD 5.30 → 40.06 on our int8 stack; Kreatine's 8.18 → 50.06) with plausible-looking output`
          : `${REFERENCE_CARRIER_NODES.method} method '${methodValue}' does not pair with the identity-edit LoRA — the reference carrier must be '${INDEX_METHOD_VALUE}' (measured meanAD 5.30 at index vs 40.06 at ${T0_METHOD_VALUE}); the wrong graph still renders plausibly`,
      )
    }
    // The E-K1 pairing rule, stated positively: a ReferenceLatent carrier
    // with the identity LoRA MUST carry the method node pinned to 'index' —
    // a validation rule, not a convention (a missing node also trips the
    // generic silent-drop check below).
    if (classes.includes(REFERENCE_CARRIER_NODES.latent) && methodValue !== INDEX_METHOD_VALUE) {
      violations.push(`${REFERENCE_CARRIER_NODES.latent} with the identity-edit LoRA must carry ${REFERENCE_CARRIER_NODES.method} method '${INDEX_METHOD_VALUE}' (${methodValue === '' ? 'no method node present' : `got '${methodValue}'`}) — the E-K1-measured pairing: meanAD 5.30 at index vs 40.06 off-recipe on our int8 stack`)
    }
  }
  if (anypaintActive) {
    if (!classes.includes(ANYPAINT_TRIPLE.encode)) violations.push(`anypaint LoRA without its encode ${ANYPAINT_TRIPLE.encode} — the mask contract (token-aligned noise mask + known latent) is missing`)
    if (!classes.includes(ANYPAINT_TRIPLE.transport)) violations.push(`anypaint LoRA without its transport ${ANYPAINT_TRIPLE.transport} — the registered reference and its K/V cache are missing`)
  }
  if (classes.includes(IDENTITY_TRIPLE.transport) && !identityActive) violations.push(`${IDENTITY_TRIPLE.transport} present without the identity-edit LoRA — the encode/transport/LoRA triple must match`)
  if (classes.includes(ANYPAINT_TRIPLE.transport) && !anypaintActive) violations.push(`${ANYPAINT_TRIPLE.transport} present without the anypaint LoRA — the encode/transport/LoRA triple must match`)
  if (classes.includes(REFERENCE_CARRIER_NODES.latent) && !classes.includes(REFERENCE_CARRIER_NODES.method)) {
    violations.push(`${REFERENCE_CARRIER_NODES.latent} without ${REFERENCE_CARRIER_NODES.method} — Krea 2 sets no default reference method, so the references are silently dropped`)
  }
  const patchers = KREA2_WHOLE_PIPELINE_PATCHERS.filter((patcher) => classes.includes(patcher))
  if (patchers.length > 1) violations.push(`${patchers.join(' + ')} in one graph — whole-pipeline forward patchers do not compose; keep edit families mutually exclusive`)
  for (const forbidden of KREA2_FORBIDDEN_COMPOSITE_NODES) {
    if (classes.includes(forbidden)) violations.push(`${forbidden} present — no post-hoc composite: the masked encode owns preservation and the boundary band`)
  }
  return violations
}

/** Convenience for callers (and tests): build + audit in one step. Throws on
 * unknown family or invalid dials; returns violations for asserting. */
export function buildKrea2EditGraphWithAudit(options: Krea2BuildOptions, models: Krea2ModelSelection): { graph: ComfyPrompt; violations: string[] } {
  const graph = buildKrea2Graph(options, models)
  return { graph, violations: krea2RecipeAudit(graph) }
}
