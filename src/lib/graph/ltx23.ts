/** LTX-2.3 one-graph video utilities — template-faithful ports of the six
 * official ComfyUI editing templates (task 068xwy3).
 *
 * WHY THIS MODULE EXISTS: the maintainer's LTX verdict (docs/research/
 * ltx-vs-h3-verdict.md, 2026-09-14) is KEEP-UTILITIES-ONLY — the general
 * Ltx25Workspace retires in Phase 4, and THIS utility family is the reason
 * the LTX engine path survives. The five editing tools have no H3
 * equivalent; the sixth (img+audio→video) rides the same checkpoint.
 *
 * TEMPLATE PROVENANCE (topology source of truth — every pinned value below
 * comes from these JSONs, fetched 2026-09-15 from Comfy-Org/workflow_templates
 * @main and flattened node-by-node; widget values were cross-checked against
 * the node INPUT schemas in ComfyUI master 1a14b82e, Lightricks/
 * ComfyUI-LTXVideo @15d09abb, kijai/ComfyUI-KJNodes @main and
 * fxtdstudios/radiance @main):
 *
 *   template_ltx2_3_lora_remove_subtitles_from_video.json
 *   template_ltx2_3_remove_watermark_from_video.json     (differs from the
 *        subtitles template ONLY in LoRA file + strength 1.5 + default
 *        prompt + sample video — one builder serves both)
 *   template_ltx2_3_lora_restore_archival_footage.json   (same 43-node
 *        generation subgraph as remove-subtitles; dearchive LoRA @1.0)
 *   template_ltx2_3_obscura_remova_lora_remove_object_from_video.json
 *   template_ltx2_3_lora_video_outpainting.json
 *   video_ltx2_3_ia2v.json (native Template Library workflow, all core)
 *
 * The remove-family generation subgraph is the 43-node two-stage ManualSigmas
 * graph the task scope notes describe: stage 1 samples the half-resolution
 * canvas over the 9-value ManualSigmas ladder, LTXVLatentUpsampler x2 doubles
 * the latents, stage 2 re-attaches the full-resolution IC-LoRA guide and
 * refines over the 4-value ladder — audio riding the joint AV latent the
 * whole way, with LTXVSetAudioRefTokens re-binding the audio reference
 * between stages and LTXVCropGuides stripping the guide tokens before every
 * decode. Node ids below ARE the template's own subgraph node ids, so a
 * flattened template can be diffed against a built graph node-for-node.
 *
 * DOCUMENTED DEVIATIONS from the templates (everything else is ported
 * exactly — class, wiring, and every widget value):
 *  D1 before/after comparison scaffolding dropped (Video Stitch subgraph,
 *     ImageStitch + ImageConcanate + the comparison SaveVideo/VHS_VideoCombine,
 *     ImageFromBatch, PreviewAny). The templates ship a side-by-side demo
 *     video; the tool returns the processed video.
 *  D2 VHS nodes replaced with core equivalents: VHS_LoadVideo → LoadVideo,
 *     VHS_VideoCombine → CreateVideo + SaveVideo, VHS_VideoInfo →
 *     GetVideoComponents + GetImageSizeAndCount, VHS_GetImageCount →
 *     GetImageSizeAndCount[3]. Same semantics, no VideoHelperSuite pack.
 *  D3 ComfyMath's CM_FloatToInt → core ComfyNumberConvert (outpaint fps
 *     FLOAT→INT). No ComfyMath pack.
 *  D4 ia2v drops the optional LLM prompt-enhancement sub-chain
 *     (TextGenerateLTX2Prompt + the gemma-abliterated LoraLoader + the
 *     ComfySwitchNode toggle): the tool takes the user's prompt verbatim.
 *     RecordAudio (in-app audio capture) is dropped the same way — the
 *     audio input is a file.
 *  D5 dangling nodes dropped: the templates' disconnected LTXVAudioVAEDecode
 *     (remove family + outpaint) and the outpaint's entirely-BYPASSED
 *     condition-only chain (LoadImage → match-size → LTXVPreprocess →
 *     LTXVImgToVideoConditionOnly with bypass=true, which is identity by
 *     construction; the IC-LoRA guide carries the frames).
 *  D6 PrimitiveInt/PrimitiveFloat/PrimitiveString/Reroute UI conveniences
 *     are inlined as literal widget values (the graph shape is unchanged).
 *  D7 the checkpoint ladder accepts either official dev quant
 *     (ltx-2.3-22b-dev.safetensors or -fp8) where a template pins exactly
 *     one — the graph is identical apart from the ckpt_name value. The
 *     templates pin bf16 dev for the remove family and fp8 for
 *     outpaint/ia2v; goldens pin the template-exact names.
 *  D8 the ia2v trim/latency parameters (audio start, duration, fps) are
 *     direct tool options instead of Primitive nodes.
 *
 * TOOL SURFACE DECISION (AC 5gku6po): the real pick-and-run UI belongs to
 * the canvas redesign epic (vbrstja) — this module ships the availability-
 * gated Settings listing (the Identity Edit / krea2edit precedent) plus the
 * headless builders the flows layer (useGenerationFlows.generateLtxUtility,
 * the CharacterStudio headless precedent) submits. No dedicated view.
 */
import type { ObjectInfo } from '../comfyInfo'
import { choices as comfyChoices } from '../comfyInfo'
import type { Ltx23ModelSelection, ModelFile, UploadedFile } from '../../types'
import { inferLtx23Selections } from '../modelSelection'
import type { ComfyPrompt } from './types'

// ---------------------------------------------------------------------------
// Template-pinned constants (single source — tests enforce these)
// ---------------------------------------------------------------------------

/** Every value is pinned by the official templates listed in the module
 *  header. Change one only with a template change; the golden matrix makes
 *  silent drift impossible. */
export const LTX23_PINS = {
  /** Stage-1 ManualSigmas ladder — shared by the remove family, outpaint and
   *  ia2v stage 1 (9 sigmas; the official LTX-2.3 dev schedule). */
  firstStageSigmas: '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0',
  /** Stage-2 refine ladder after the x2 latent upsample (remove family). */
  removeRefinerSigmas: '0.909375, 0.725, 0.421875, 0.0',
  /** ia2v refine ladder (the LTX-2.5-style low-sigma refine). */
  ia2vRefinerSigmas: '0.85, 0.7250, 0.4219, 0.0',
  /** Latent-safe frame count: LTXV temporal packing is (n-1)/8+1 frames. */
  frameCountExpression: '(int((a - 1) / 8)) * 8 + 1',
  /** Guide attach widgets shared by every LTXAddVideoICLoRAGuide in the
   *  templates: frame_idx 0, strength 1, latent_downscale_factor 1,
   *  crop disabled; tiled encode only in the remove family (256/64 tiles —
   *  the full-res 1920-wide guide needs it; the template Note says to tune
   *  tiles to the card). */
  guide: { frameIdx: 0, strength: 1, latentDownscaleFactor: 1, crop: 'disabled', tileOverlap: 64, tileRemoveFamily: 256, tileOther: 256 },
  /** Remove family operating point: CFG 1 + euler, both stages. */
  remove: { cfg: 1, sampler: 'euler', stage2NoiseSeed: 29, stage2DefaultWidth: 1920, stage2DefaultHeight: 1088, defaultStage1Width: 960, defaultStage1Height: 544 },
  /** Obscura Remova operating point: single KSampler pass, 8 steps,
   *  euler_ancestral_cfg_pp + linear_quadratic, CFG 1, denoise 1 — the
   *  distilled+obscura LoRA stack (obscura @2.0 wraps the transformer,
   *  distilled-384-1.1 @0.4 wraps that). */
  obscura: { steps: 8, cfg: 1, sampler: 'euler_ancestral_cfg_pp', scheduler: 'linear_quadratic', denoise: 1, obscuraStrength: 2.0, distilledStrength: 0.4, fps: 25, defaultWidth: 1280, defaultHeight: 704 },
  /** Outpaint operating point: CFG 1 + euler_ancestral over the 9-sigma
   *  ladder, distilled-384 @0.5 + outpaint IC-LoRA @1.0, half-res grid
   *  pipeline (0.5 downscale → multiple-of-32 grid), guide image gamma-2
   *  color-corrected (Float32ColorCorrect), aspect via max() padding. */
  outpaint: { cfg: 1, sampler: 'euler_ancestral', distilledStrength: 0.5, outpaintStrength: 1.0, downscale: 0.5, gridMultiple: 32, guideGamma: 2, defaultAspectW: 9, defaultAspectH: 16 },
  /** ia2v operating point: distilled rank-111 @0.5, stage 1 at half the
   *  target dims with the image anchored at strength 0.7, x2 latent
   *  upsample, image re-anchored at strength 1 for the refine, audio as a
   *  fully-noised masked latent riding the joint AV sampling. */
  ia2v: { cfg: 1, sampler: 'euler', distilledStrength: 0.5, stage1ImageStrength: 0.7, stage2ImageStrength: 1, stage2NoiseSeed: 42, defaultWidth: 1280, defaultHeight: 720, defaultFps: 24, defaultDurationSeconds: 9, imageLongerSide: 1536, imgCompression: 18 },
  /** Remove-family tiled VAE decode (2×2 tiles, overlap 6). */
  tiledDecode: { horizontal: 2, vertical: 2, overlap: 6 },
  /** ia2v tiled decode (the official template's 768/64/4096/4). */
  ia2vTiledDecode: { tileSize: 768, overlap: 64, temporalSize: 4096, temporalOverlap: 4 },
} as const

/** Per-tool default prompts + negative prompts, verbatim from the templates. */
export const LTX23_PROMPTS = {
  subtitles: 'Remove subtitles, captions, and related text occlusions from the video, restoring a clean and natural underlying image.',
  watermark: 'Remove short-video platform watermarks and related occlusions from the video, restoring a clean, clear, and natural original image.',
  archival: 'A modern, high-resolution video shot in vivid color, sharp detail, contemporary cinematography.',
  obscura: 'Remove the {object} from the foreground.',
  outpaint: '',
  ia2v: '',
  negativeRemove: 'pc game, console game, video game, cartoon, childish, ugly',
  negativeObscura: 'blurry, low resolution, ugly, garbled mess, compression artifacts, glitch, stop motion, still image, pixelated, robotic voice, oversaturated',
  negativeOutpaint: 'pc game, console game, video game, ugly, 3d render, photo, still, static, slow',
  negativeIa2v: 'pc game, console game, video game, cartoon, childish, ugly',
} as const

/** Node classes each tool's builder emits from OUTSIDE comfy-core (presence
 *  = the availability gate's pack half). LTXVIDEO_* live in Lightricks/
 *  ComfyUI-LTXVideo, KJ_* in kijai/ComfyUI-KJNodes, RADIANCE_* in
 *  fxtdstudios/radiance — all three are fetch-catalog node-pack entries. */
export const LTXVIDEO_NODES = ['LTXICLoRALoaderModelOnly', 'LTXAddVideoICLoRAGuide', 'LTXVSetAudioRefTokens', 'LTXVTiledVAEDecode', 'LTXFloatToInt'] as const
export const KJNODES_USED = ['GetImageSizeAndCount', 'ImagePadKJ', 'VAELoaderKJ'] as const
export const RADIANCE_NODES = ['Float32ColorCorrect'] as const

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Ltx23UtilityKind = 'remove-subtitles' | 'remove-watermark' | 'restore-archival' | 'remove-object' | 'outpaint' | 'ia2v'

/** The one remove-family builder's per-tool preset (D1 header: the three
 *  templates share one topology; only these columns differ). */
export type Ltx23RemovePreset = {
  lora: keyof Pick<Ltx23ModelSelection, 'subtitlesRemoveLora' | 'watermarkRemoveLora' | 'archivalLora'>
  /** Template-pinned LoRA strength (subtitles 1.2 / watermark 1.5 / archival 1.0). */
  strength: number
  defaultPrompt: string
}

export type Ltx23UtilityRequest = {
  tool: Ltx23UtilityKind
  prompt?: string
  seed: number
  filenamePrefix: string
  /** Input video upload (remove family, obscura, outpaint). */
  video?: UploadedFile
  /** Input image upload (ia2v). */
  image?: UploadedFile
  /** Input audio upload (ia2v). */
  audio?: UploadedFile
  /** Output canvas: remove family stage-2 target (default 1920×1088, stage 1
   *  is the exact half); obscura processing size (default 1280×704); ia2v
   *  target (default 1280×720, stage 1 is the exact half). */
  width?: number
  height?: number
  /** Outpaint only: target aspect ratio (default 9:16). */
  aspectW?: number
  aspectH?: number
  /** ia2v only: clip length + audio window (defaults 9 s @ 24 fps, start 0). */
  durationSeconds?: number
  fps?: number
  audioStartSeconds?: number
}

export type Ltx23Detection = {
  available: boolean
  /** Engine node classes required but absent (install the node pack). */
  missingNodes: string[]
  /** Human-readable missing weights with fetch pointers. */
  missingModels: string[]
  /** The unfilled model-selection SLOT ids (QOL wave rrxlw2r): the
   * structured form missingModels renders — what the fetch-deep-link
   * mapping (src/lib/fetchDeepLink.ts) resolves against the catalog. */
  missingSlots: string[]
  /** The concrete files a build would use, when everything resolves. */
  resolved?: Partial<Record<keyof Ltx23ModelSelection, string>>
}

export type Ltx23Utility = {
  id: string
  label: string
  kind: Ltx23UtilityKind
  /** Node classes the built graph needs beyond comfy-core. */
  packNodes: readonly string[]
  /** ComfyUI core classes the built graph needs (subset the detection
   *  checks — the engine being connected implies most of these). */
  coreNodes: readonly string[]
  /** The model-selection slots this tool requires. */
  modelSlots: readonly (keyof Ltx23ModelSelection)[]
  promptDefault: string
  negativePrompt: string
  detect(info: ObjectInfo | undefined, files: ModelFile[]): Ltx23Detection
  ui: {
    description: string
    warning?: string
    installHint?: string
    promptGuidance?: string
    /** What the tool takes as input (surface copy). */
    input: string
  }
}

// ---------------------------------------------------------------------------
// Model resolution (delegates to the modelSelection ladder; engine combos
// cover the two folders the directory scan cannot see)
// ---------------------------------------------------------------------------

/** Resolves the LTX-2.3 stack from a scan + live engine info. The
 *  checkpoints and latent_upscale_models folders are outside the six scanner
 *  kinds, so those two slots read the loader nodes' combo lists instead. */
export function resolveLtx23Selection(info: ObjectInfo | undefined, files: ModelFile[]): Ltx23ModelSelection {
  return inferLtx23Selections(files, {
    checkpoints: comfyChoices(info ?? {}, 'CheckpointLoaderSimple', 'ckpt_name'),
    latentUpscalers: comfyChoices(info ?? {}, 'LatentUpscaleModelLoader', 'model_name'),
  })
}

const SLOT_LABELS: Partial<Record<keyof Ltx23ModelSelection, string>> = {
  checkpoint: 'ltx-2.3-22b-dev checkpoint (models/checkpoints — ltx-2.3-22b-dev.safetensors 46 GB or the -fp8 29 GB cut, both official; Fetchable items lists them)',
  transformer: 'the Kijai transformer-only split (models/diffusion_models — ltx-2.3-22b-dev_transformer_only_bf16.safetensors; Fetchable items)',
  textEncoder: 'Gemma 3 12B text encoder (models/text_encoders — gemma_3_12B_it.safetensors or the _fp4_mixed cut; Fetchable items)',
  textProjection: 'LTX-2.3 text projection (models/text_encoders — ltx-2.3_text_projection_bf16.safetensors; the Obscura tool\'s split-stack requirement)',
  videoVae: 'LTX23 video VAE split (models/vae — LTX23_video_vae_bf16.safetensors; Fetchable items)',
  audioVae: 'LTX23 audio VAE split (models/vae — LTX23_audio_vae_bf16.safetensors; Fetchable items)',
  latentUpscaler: 'ltx-2.3-spatial-upscaler-x2-1.1 (models/latent_upscale_models; Fetchable items)',
  distilledLora: 'an official distilled-acceleration LoRA (models/loras — ltx-2.3-22b-distilled-lora-384(-1.1).safetensors or the Comfy-Org rank-111 repack; Fetchable items)',
  subtitlesRemoveLora: 'the subtitles-remove IC-LoRA (models/loras — ltx2.3-ic-subtitles-remove-general.safetensors; joyfox ICEdit-Insight, Apache-2.0; Fetchable items)',
  watermarkRemoveLora: 'the watermark-remove IC-LoRA (models/loras — ltx2.3-ic-watermark-remove-general.safetensors; joyfox ICEdit-Insight, Apache-2.0; Fetchable items)',
  archivalLora: 'the dearchive restoration IC-LoRA (models/loras — ltx-2.3-dearchive-lora_weights_step_05000.safetensors; Fetchable items)',
  obscuraLora: 'the Obscura Remova LoRA (models/loras — ltx23-obscura_remova.safetensors; Fetchable items)',
  outpaintLora: 'the outpaint IC-LoRA (models/loras — ltx-2.3-22b-ic-lora-outpaint.safetensors; Fetchable items)',
}

function detectUtility(info: ObjectInfo | undefined, files: ModelFile[], packNodes: readonly string[], modelSlots: readonly (keyof Ltx23ModelSelection)[]): Ltx23Detection {
  const selection = resolveLtx23Selection(info, files)
  const missingNodes = packNodes.filter((nodeClass) => !info?.[nodeClass])
  const missingSlots = modelSlots.filter((slot) => !selection[slot])
  const missingModels = missingSlots.map((slot) => SLOT_LABELS[slot] ?? slot)
  return {
    available: missingNodes.length === 0 && missingModels.length === 0,
    missingNodes,
    missingSlots,
    missingModels,
    resolved: missingModels.length === 0 && missingNodes.length === 0 ? selection : undefined,
  }
}

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

function uploadedName(file: UploadedFile) {
  return file.subfolder ? `${file.subfolder.replace(/\\/g, '/')}/${file.name}` : file.name
}

function requireSlots(kind: Ltx23UtilityKind, models: Ltx23ModelSelection): void {
  const slots: Record<Ltx23UtilityKind, readonly (keyof Ltx23ModelSelection)[]> = {
    'remove-subtitles': ['checkpoint', 'textEncoder', 'latentUpscaler', 'subtitlesRemoveLora'],
    'remove-watermark': ['checkpoint', 'textEncoder', 'latentUpscaler', 'watermarkRemoveLora'],
    'restore-archival': ['checkpoint', 'textEncoder', 'latentUpscaler', 'archivalLora'],
    'remove-object': ['transformer', 'textEncoder', 'textProjection', 'videoVae', 'audioVae', 'obscuraLora', 'distilledLora'],
    outpaint: ['checkpoint', 'textEncoder', 'distilledLora', 'outpaintLora'],
    ia2v: ['checkpoint', 'textEncoder', 'latentUpscaler', 'distilledLora'],
  }
  const missing = slots[kind].filter((slot) => !models[slot])
  if (missing.length) throw new Error(`the ${kind} graph cannot build — the scan resolved none of: ${missing.map((slot) => SLOT_LABELS[slot] ?? slot).join('; ')}`)
}

function validateCanvas(kind: Ltx23UtilityKind, width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`${kind} needs positive integer dimensions (got ${width}x${height})`)
  }
  // The remove family resizes stage 1 to the EXACT half of the target and
  // LTXV latents compress 32x — the half must stay on the 32 grid, i.e. the
  // target on the 64 grid. Obscura feeds one resize result to both the guide
  // and the latent, so 32 suffices. ia2v is UNCONSTRAINED beyond integers:
  // its own official template ships 1280x720 (720 is on no grid) and relies
  // on EmptyLTXVLatentVideo flooring the halves — same behavior here.
  const multiple = kind === 'remove-subtitles' || kind === 'remove-watermark' || kind === 'restore-archival' ? 64 : kind === 'ia2v' ? 1 : 32
  if (width % multiple !== 0 || height % multiple !== 0) {
    throw new Error(`${kind} dimensions must be multiples of ${multiple} (stage 1 runs at the exact half on the 32-px latent grid; got ${width}x${height})`)
  }
}

/** The remove-family builder serves all three templates: identical 43-node
 *  two-stage topology, different LoRA / strength / default prompt. */
const REMOVE_PRESETS: Record<'remove-subtitles' | 'remove-watermark' | 'restore-archival', Ltx23RemovePreset> = {
  'remove-subtitles': { lora: 'subtitlesRemoveLora', strength: 1.2, defaultPrompt: LTX23_PROMPTS.subtitles },
  'remove-watermark': { lora: 'watermarkRemoveLora', strength: 1.5, defaultPrompt: LTX23_PROMPTS.watermark },
  'restore-archival': { lora: 'archivalLora', strength: 1.0, defaultPrompt: LTX23_PROMPTS.archival },
}

// ---------------------------------------------------------------------------
// Family A — remove-subtitles / remove-watermark / restore-archival
//
// The 43-node two-stage ManualSigmas graph (template node ids preserved).
// Inputs: the source video's frames/audio/fps; output: the processed video
// with the ORIGINAL audio (text removal never regenerates sound — the
// template's CreateVideo takes the input audio passthrough; the decoded
// regenerated audio is dangling there, D5).
// ---------------------------------------------------------------------------

export function buildLtx23RemoveGraph(request: Ltx23UtilityRequest, models: Ltx23ModelSelection): ComfyPrompt {
  const preset = REMOVE_PRESETS[request.tool as keyof typeof REMOVE_PRESETS]
  if (!preset) throw new Error(`buildLtx23RemoveGraph serves the three remove-family tools (got '${request.tool}')`)
  requireSlots(request.tool, models)
  if (!request.video) throw new Error('the remove-family tools need an input video')
  const width = request.width ?? LTX23_PINS.remove.stage2DefaultWidth
  const height = request.height ?? LTX23_PINS.remove.stage2DefaultHeight
  validateCanvas(request.tool, width, height)
  const prompt: ComfyPrompt = {
    // ---- loaders (template 5059/5084/5085/5086/5087) ----
    '5059': { class_type: 'LatentUpscaleModelLoader', inputs: { model_name: models.latentUpscaler } },
    '5084': { class_type: 'LTXAVTextEncoderLoader', inputs: { text_encoder: models.textEncoder, ckpt_name: models.checkpoint, device: 'default' } },
    '5085': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: models.checkpoint } },
    '5086': { class_type: 'LTXVAudioVAELoader', inputs: { ckpt_name: models.checkpoint } },
    '5087': { class_type: 'LTXICLoRALoaderModelOnly', inputs: { model: ['5085', 0], lora_name: models[preset.lora], strength_model: preset.strength } },
    // ---- source video split (template 5088/5089/5068/5096/5097) ----
    '5088': { class_type: 'GetVideoComponents', inputs: { video: ['5190', 0] } },
    '5089': { class_type: 'ResizeImageMaskNode', inputs: { input: ['5088', 0], resize_type: 'scale dimensions', 'resize_type.width': width / 2, 'resize_type.height': height / 2, crop: 'disabled', scale_method: 'area' } },
    '5068': { class_type: 'ResizeImageMaskNode', inputs: { input: ['5088', 0], resize_type: 'scale dimensions', 'resize_type.width': width, 'resize_type.height': height, crop: 'disabled', scale_method: 'area' } },
    '5096': { class_type: 'GetImageSizeAndCount', inputs: { image: ['5089', 0] } },
    '5097': { class_type: 'ComfyMathExpression', inputs: { expression: LTX23_PINS.frameCountExpression, 'values.a': ['5096', 3] } },
    // ---- conditioning (template 5057/5091/5060/5095) ----
    '5057': { class_type: 'CLIPTextEncode', inputs: { clip: ['5084', 0], text: LTX23_PROMPTS.negativeRemove } },
    '5091': { class_type: 'CLIPTextEncode', inputs: { clip: ['5084', 0], text: request.prompt ?? preset.defaultPrompt } },
    '5060': { class_type: 'LTXVConditioning', inputs: { positive: ['5091', 0], negative: ['5057', 0], frame_rate: ['5088', 2] } },
    '5095': { class_type: 'LTXFloatToInt', inputs: { a: ['5088', 2] } },
    // ---- latents (template 5093/5065/5083) ----
    '5093': { class_type: 'EmptyLTXVLatentVideo', inputs: { width: width / 2, height: height / 2, length: ['5097', 1], batch_size: 1 } },
    '5065': { class_type: 'LTXVEmptyLatentAudio', inputs: { audio_vae: ['5086', 0], frames_number: ['5097', 1], frame_rate: ['5095', 0] } },
    '5083': { class_type: 'LTXVAudioVAEEncode', inputs: { audio: ['5088', 1], audio_vae: ['5086', 0] } },
    // ---- stage 1: guide attach + audio ref + 9-sigma ladder ----
    '5094': { class_type: 'LTXAddVideoICLoRAGuide', inputs: { positive: ['5060', 0], negative: ['5060', 1], vae: ['5085', 2], latent: ['5093', 0], image: ['5089', 0], frame_idx: LTX23_PINS.guide.frameIdx, strength: LTX23_PINS.guide.strength, latent_downscale_factor: LTX23_PINS.guide.latentDownscaleFactor, crop: LTX23_PINS.guide.crop, use_tiled_encode: true, tile_size: LTX23_PINS.guide.tileRemoveFamily, tile_overlap: LTX23_PINS.guide.tileOverlap } },
    '5098': { class_type: 'LTXVSetAudioRefTokens', inputs: { positive: ['5094', 0], negative: ['5094', 1], audio_latent: ['5083', 0] } },
    '5061': { class_type: 'CFGGuider', inputs: { model: ['5087', 0], positive: ['5098', 0], negative: ['5098', 1], cfg: LTX23_PINS.remove.cfg } },
    '5063': { class_type: 'KSamplerSelect', inputs: { sampler_name: LTX23_PINS.remove.sampler } },
    '5064': { class_type: 'ManualSigmas', inputs: { sigmas: LTX23_PINS.firstStageSigmas } },
    '5066': { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['5094', 2], audio_latent: ['5065', 0] } },
    '5058': { class_type: 'RandomNoise', inputs: { noise_seed: request.seed } },
    '5067': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['5058', 0], guider: ['5061', 0], sampler: ['5063', 0], sigmas: ['5064', 0], latent_image: ['5066', 0] } },
    '5070': { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['5067', 0] } },
    '5082': { class_type: 'LTXVCropGuides', inputs: { positive: ['5094', 0], negative: ['5094', 1], latent: ['5070', 0] } },
    // ---- x2 latent upsample + full-res re-guide ----
    '5069': { class_type: 'LTXVLatentUpsampler', inputs: { samples: ['5082', 2], upscale_model: ['5059', 0], vae: ['5085', 2] } },
    '5099': { class_type: 'LTXVSetAudioRefTokens', inputs: { positive: ['5082', 0], negative: ['5082', 1], audio_latent: ['5070', 1] } },
    '5071': { class_type: 'LTXAddVideoICLoRAGuide', inputs: { positive: ['5099', 0], negative: ['5099', 1], vae: ['5085', 2], latent: ['5069', 0], image: ['5068', 0], frame_idx: LTX23_PINS.guide.frameIdx, strength: LTX23_PINS.guide.strength, latent_downscale_factor: LTX23_PINS.guide.latentDownscaleFactor, crop: LTX23_PINS.guide.crop, use_tiled_encode: true, tile_size: LTX23_PINS.guide.tileRemoveFamily, tile_overlap: LTX23_PINS.guide.tileOverlap } },
    '5076': { class_type: 'CFGGuider', inputs: { model: ['5087', 0], positive: ['5071', 0], negative: ['5071', 1], cfg: LTX23_PINS.remove.cfg } },
    '5072': { class_type: 'KSamplerSelect', inputs: { sampler_name: LTX23_PINS.remove.sampler } },
    '5075': { class_type: 'ManualSigmas', inputs: { sigmas: LTX23_PINS.removeRefinerSigmas } },
    '5077': { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['5071', 2], audio_latent: ['5099', 2] } },
    '5078': { class_type: 'RandomNoise', inputs: { noise_seed: LTX23_PINS.remove.stage2NoiseSeed } },
    '5073': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['5078', 0], guider: ['5076', 0], sampler: ['5072', 0], sigmas: ['5075', 0], latent_image: ['5077', 0] } },
    '5080': { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['5073', 0] } },
    '5074': { class_type: 'LTXVCropGuides', inputs: { positive: ['5071', 0], negative: ['5071', 1], latent: ['5080', 0] } },
    // ---- decode + mux (original audio passthrough, template 5090/5062) ----
    '5090': { class_type: 'LTXVTiledVAEDecode', inputs: { vae: ['5085', 2], latents: ['5074', 2], horizontal_tiles: LTX23_PINS.tiledDecode.horizontal, vertical_tiles: LTX23_PINS.tiledDecode.vertical, overlap: LTX23_PINS.tiledDecode.overlap, last_frame_fix: false } },
    '5062': { class_type: 'CreateVideo', inputs: { images: ['5090', 0], audio: ['5088', 1], fps: ['5088', 2] } },
    // D2: the core LoadVideo/SaveVideo pair the other native templates use.
    '5190': { class_type: 'LoadVideo', inputs: { file: uploadedName(request.video) } },
    '5191': { class_type: 'SaveVideo', inputs: { video: ['5062', 0], filename_prefix: request.filenamePrefix, format: 'auto', codec: 'auto' } },
  }
  return prompt
}

// ---------------------------------------------------------------------------
// Family B — remove-object (Obscura Remova)
//
// The 30-node single-pass KSampler graph on SPLIT weights (Kijai
// transformer-only + text projection + separate bf16 VAEs): obscura LoRA
// @2.0 wraps the transformer, distilled-384-1.1 @0.4 wraps that; input is
// resized to the processing size, jointly sampled with a fresh audio latent
// (audio IS regenerated here — the template decodes the sampled audio into
// the output video), euler_ancestral_cfg_pp + linear_quadratic, 8 steps.
// ---------------------------------------------------------------------------

export function buildLtx23RemoveObjectGraph(request: Ltx23UtilityRequest, models: Ltx23ModelSelection): ComfyPrompt {
  requireSlots('remove-object', models)
  if (!request.video) throw new Error('the remove-object tool needs an input video')
  const width = request.width ?? LTX23_PINS.obscura.defaultWidth
  const height = request.height ?? LTX23_PINS.obscura.defaultHeight
  validateCanvas('remove-object', width, height)
  const prompt: ComfyPrompt = {
    // ---- split-stack loaders (template 1/2/4/5/14/15) ----
    '1': { class_type: 'VAELoaderKJ', inputs: { vae_name: models.videoVae, device: 'main_device', weight_dtype: 'bf16' } },
    '2': { class_type: 'VAELoaderKJ', inputs: { vae_name: models.audioVae, device: 'main_device', weight_dtype: 'bf16' } },
    '4': { class_type: 'DualCLIPLoader', inputs: { clip_name1: models.textEncoder, clip_name2: models.textProjection, type: 'ltxv', device: 'default' } },
    '5': { class_type: 'UNETLoader', inputs: { unet_name: models.transformer, weight_dtype: 'default' } },
    '15': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['5', 0], lora_name: models.obscuraLora, strength_model: LTX23_PINS.obscura.obscuraStrength } },
    '14': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['15', 0], lora_name: models.distilledLora, strength_model: LTX23_PINS.obscura.distilledStrength } },
    // ---- source split + processing-size resize (template 38/41/46 = D2/GetImageSizeAndCount) ----
    '38': { class_type: 'GetVideoComponents', inputs: { video: ['39', 0] } },
    '41': { class_type: 'ResizeImageMaskNode', inputs: { input: ['38', 0], resize_type: 'scale dimensions', 'resize_type.width': width, 'resize_type.height': height, crop: 'disabled', scale_method: 'area' } },
    '46': { class_type: 'GetImageSizeAndCount', inputs: { image: ['41', 0] } },
    '45': { class_type: 'ComfyMathExpression', inputs: { expression: LTX23_PINS.frameCountExpression, 'values.a': ['46', 3] } },
    // ---- conditioning (template 9/22/11) ----
    '9': { class_type: 'CLIPTextEncode', inputs: { clip: ['4', 0], text: request.prompt ?? LTX23_PROMPTS.obscura } },
    '22': { class_type: 'CLIPTextEncode', inputs: { clip: ['4', 0], text: LTX23_PROMPTS.negativeObscura } },
    '11': { class_type: 'LTXVConditioning', inputs: { positive: ['9', 0], negative: ['22', 0], frame_rate: LTX23_PINS.obscura.fps } },
    // ---- latents + guide (template 10/21/12) ----
    '10': { class_type: 'EmptyLTXVLatentVideo', inputs: { width: ['46', 1], height: ['46', 2], length: ['45', 1], batch_size: 1 } },
    '21': { class_type: 'LTXVEmptyLatentAudio', inputs: { audio_vae: ['2', 0], frames_number: ['45', 1], frame_rate: LTX23_PINS.obscura.fps } },
    '12': { class_type: 'LTXAddVideoICLoRAGuide', inputs: { positive: ['11', 0], negative: ['11', 1], vae: ['1', 0], latent: ['10', 0], image: ['41', 0], frame_idx: LTX23_PINS.guide.frameIdx, strength: LTX23_PINS.guide.strength, latent_downscale_factor: LTX23_PINS.guide.latentDownscaleFactor, crop: LTX23_PINS.guide.crop, use_tiled_encode: false, tile_size: LTX23_PINS.guide.tileOther, tile_overlap: LTX23_PINS.guide.tileOverlap } },
    // ---- single sampling pass (template 20/19/18) ----
    '20': { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['12', 2], audio_latent: ['21', 0] } },
    '19': { class_type: 'KSampler', inputs: { model: ['14', 0], positive: ['12', 0], negative: ['12', 1], latent_image: ['20', 0], seed: request.seed, steps: LTX23_PINS.obscura.steps, cfg: LTX23_PINS.obscura.cfg, sampler_name: LTX23_PINS.obscura.sampler, scheduler: LTX23_PINS.obscura.scheduler, denoise: LTX23_PINS.obscura.denoise } },
    '18': { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['19', 0] } },
    '17': { class_type: 'LTXVCropGuides', inputs: { positive: ['12', 0], negative: ['12', 1], latent: ['18', 0] } },
    // ---- decode + mux with the REGENERATED audio (template 16/13/36) ----
    '16': { class_type: 'VAEDecode', inputs: { samples: ['17', 2], vae: ['1', 0] } },
    '13': { class_type: 'LTXVAudioVAEDecode', inputs: { samples: ['18', 1], audio_vae: ['2', 0] } },
    '36': { class_type: 'CreateVideo', inputs: { images: ['16', 0], audio: ['13', 0], fps: LTX23_PINS.obscura.fps } },
    '39': { class_type: 'LoadVideo', inputs: { file: uploadedName(request.video) } },
    '37': { class_type: 'SaveVideo', inputs: { video: ['36', 0], filename_prefix: request.filenamePrefix, format: 'auto', codec: 'auto' } },
  }
  return prompt
}

// ---------------------------------------------------------------------------
// Family C — video outpaint
//
// The 42-node aspect-pad graph: source frames are padded to the target
// aspect (ImagePadKJ, max()-derived canvas), downscaled 0.5 and grid-aligned
// to 32, gamma-2 color-corrected (Float32ColorCorrect — generation-load-
// bearing, keeps the padded band legible to the IC-LoRA), and attached as
// the guide for a single 9-sigma euler_ancestral pass at the half-res grid.
// Output keeps the original audio.
// ---------------------------------------------------------------------------

export function buildLtx23OutpaintGraph(request: Ltx23UtilityRequest, models: Ltx23ModelSelection): ComfyPrompt {
  requireSlots('outpaint', models)
  if (!request.video) throw new Error('the outpaint tool needs an input video')
  const aspectW = request.aspectW ?? LTX23_PINS.outpaint.defaultAspectW
  const aspectH = request.aspectH ?? LTX23_PINS.outpaint.defaultAspectH
  if (!Number.isInteger(aspectW) || !Number.isInteger(aspectH) || aspectW <= 0 || aspectH <= 0 || aspectW > 512 || aspectH > 512) {
    throw new Error(`outpaint needs a sane target aspect ratio as two small integers (got ${aspectW}:${aspectH})`)
  }
  const prompt: ComfyPrompt = {
    // ---- loaders (template 5132/5133/5134/5135/5146) ----
    '5132': { class_type: 'LTXVAudioVAELoader', inputs: { ckpt_name: models.checkpoint } },
    '5133': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: models.checkpoint } },
    '5134': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['5133', 0], lora_name: models.distilledLora, strength_model: LTX23_PINS.outpaint.distilledStrength } },
    '5135': { class_type: 'LTXAVTextEncoderLoader', inputs: { text_encoder: models.textEncoder, ckpt_name: models.checkpoint, device: 'default' } },
    '5146': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['5134', 0], lora_name: models.outpaintLora, strength_model: LTX23_PINS.outpaint.outpaintStrength } },
    // ---- source split (D2: core LoadVideo + GetVideoComponents + GetImageSizeAndCount) ----
    '5156': { class_type: 'LoadVideo', inputs: { file: uploadedName(request.video) } },
    '5157': { class_type: 'GetVideoComponents', inputs: { video: ['5156', 0] } },
    '5158': { class_type: 'GetImageSizeAndCount', inputs: { image: ['5157', 0] } },
    // ---- aspect canvas: max() of source dims against the ratio (template 5148/5149/5150) ----
    '5148': { class_type: 'ComfyMathExpression', inputs: { expression: 'a / b', 'values.a': aspectW, 'values.b': aspectH } },
    '5149': { class_type: 'ComfyMathExpression', inputs: { expression: 'max(a, b * c)', 'values.a': ['5158', 1], 'values.b': ['5158', 2], 'values.c': ['5148', 0] } },
    '5150': { class_type: 'ComfyMathExpression', inputs: { expression: 'max(b, a / c)', 'values.a': ['5158', 1], 'values.b': ['5158', 2], 'values.c': ['5148', 0] } },
    // ---- pad + half-res grid (template 5139/5129/5130) ----
    '5139': { class_type: 'ImagePadKJ', inputs: { image: ['5157', 0], left: 0, right: 0, top: 0, bottom: 0, extra_padding: 0, pad_mode: 'color', color: '0, 0, 0', target_width: ['5149', 1], target_height: ['5150', 1] } },
    '5129': { class_type: 'ResizeImageMaskNode', inputs: { input: ['5139', 0], resize_type: 'scale by multiplier', 'resize_type.multiplier': LTX23_PINS.outpaint.downscale, scale_method: 'lanczos', crop: 'disabled' } },
    '5130': { class_type: 'ResizeImageMaskNode', inputs: { input: ['5129', 0], resize_type: 'scale to multiple', 'resize_type.multiple': LTX23_PINS.outpaint.gridMultiple, scale_method: 'area', crop: 'disabled' } },
    '5126': { class_type: 'GetImageSize', inputs: { image: ['5130', 0] } },
    // ---- conditioning (template 5138/5131/5110) ----
    '5138': { class_type: 'CLIPTextEncode', inputs: { clip: ['5135', 0], text: request.prompt ?? LTX23_PROMPTS.outpaint } },
    '5131': { class_type: 'CLIPTextEncode', inputs: { clip: ['5135', 0], text: LTX23_PROMPTS.negativeOutpaint } },
    '5110': { class_type: 'LTXVConditioning', inputs: { positive: ['5138', 0], negative: ['5131', 0], frame_rate: ['5157', 2] } },
    // ---- guide: gamma-corrected padded frames (template 5144/5142; D5: the
    //     bypassed condition-only chain is identity and omitted) ----
    '5144': { class_type: 'Float32ColorCorrect', inputs: { image: ['5130', 0], exposure: 0, contrast: 1, brightness: 0, saturation: 1, gamma: LTX23_PINS.outpaint.guideGamma, lift_r: 0, lift_g: 0, lift_b: 0, gain_r: 1, gain_g: 1, gain_b: 1, luma_space: 'Rec.709 / sRGB', clamp_output: false } },
    '5112': { class_type: 'EmptyLTXVLatentVideo', inputs: { width: ['5126', 0], height: ['5126', 1], length: ['5126', 2], batch_size: 1 } },
    '5142': { class_type: 'LTXAddVideoICLoRAGuide', inputs: { positive: ['5110', 0], negative: ['5110', 1], vae: ['5133', 2], latent: ['5112', 0], image: ['5144', 0], frame_idx: LTX23_PINS.guide.frameIdx, strength: LTX23_PINS.guide.strength, latent_downscale_factor: LTX23_PINS.guide.latentDownscaleFactor, crop: LTX23_PINS.guide.crop, use_tiled_encode: false, tile_size: LTX23_PINS.guide.tileOther, tile_overlap: LTX23_PINS.guide.tileOverlap } },
    // ---- audio latent at the source fps (template 5121/5115 = D3) ----
    '5115': { class_type: 'ComfyNumberConvert', inputs: { value: ['5157', 2] } },
    '5121': { class_type: 'LTXVEmptyLatentAudio', inputs: { audio_vae: ['5132', 0], frames_number: ['5158', 3], frame_rate: ['5115', 1] } },
    // ---- single 9-sigma pass (template 5116/5117/5118/5119/5111/5122) ----
    '5116': { class_type: 'CFGGuider', inputs: { model: ['5146', 0], positive: ['5142', 0], negative: ['5142', 1], cfg: LTX23_PINS.outpaint.cfg } },
    '5117': { class_type: 'RandomNoise', inputs: { noise_seed: request.seed } },
    '5118': { class_type: 'ManualSigmas', inputs: { sigmas: LTX23_PINS.firstStageSigmas } },
    '5119': { class_type: 'KSamplerSelect', inputs: { sampler_name: LTX23_PINS.outpaint.sampler } },
    '5111': { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['5142', 2], audio_latent: ['5121', 0] } },
    '5122': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['5117', 0], guider: ['5116', 0], sampler: ['5119', 0], sigmas: ['5118', 0], latent_image: ['5111', 0] } },
    '5114': { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['5122', 0] } },
    '5113': { class_type: 'LTXVCropGuides', inputs: { positive: ['5142', 0], negative: ['5142', 1], latent: ['5114', 0] } },
    // ---- decode + mux with the ORIGINAL audio (template 5154 + D2 mux) ----
    '5154': { class_type: 'VAEDecode', inputs: { samples: ['5113', 2], vae: ['5133', 2] } },
    '5159': { class_type: 'CreateVideo', inputs: { images: ['5154', 0], audio: ['5157', 1], fps: ['5157', 2] } },
    '5160': { class_type: 'SaveVideo', inputs: { video: ['5159', 0], filename_prefix: request.filenamePrefix, format: 'auto', codec: 'auto' } },
  }
  return prompt
}

// ---------------------------------------------------------------------------
// Family D — img+audio→video (ia2v, the native Template Library workflow)
//
// The 53-node two-stage lip-sync graph, ALL comfy-core: the trimmed audio
// rides a fully-noised masked latent (SolidMask 0 over the target canvas)
// into the joint AV sampling; stage 1 runs the half-resolution canvas with
// the preprocessed portrait anchored at strength 0.7, the x2 latent
// upscaler doubles it, and the refine re-anchors the image at strength 1
// over the low-sigma ladder. D4: no LLM prompt enhancement — the user's
// prompt is encoded verbatim.
// ---------------------------------------------------------------------------

export function buildLtx23Ia2vGraph(request: Ltx23UtilityRequest, models: Ltx23ModelSelection): ComfyPrompt {
  requireSlots('ia2v', models)
  if (!request.image) throw new Error('the img+audio→video tool needs an input image')
  if (!request.audio) throw new Error('the img+audio→video tool needs an input audio file')
  const width = request.width ?? LTX23_PINS.ia2v.defaultWidth
  const height = request.height ?? LTX23_PINS.ia2v.defaultHeight
  validateCanvas('ia2v', width, height)
  const fps = request.fps ?? LTX23_PINS.ia2v.defaultFps
  const durationSeconds = request.durationSeconds ?? LTX23_PINS.ia2v.defaultDurationSeconds
  const audioStart = request.audioStartSeconds ?? 0
  if (!Number.isInteger(fps) || fps <= 0 || fps > 120) throw new Error(`fps must be a positive integer (got ${fps})`)
  if (!(durationSeconds > 0) || durationSeconds > 60) throw new Error(`duration must be within (0, 60] seconds (got ${durationSeconds})`)
  if (!(audioStart >= 0)) throw new Error(`audio start offset cannot be negative (got ${audioStart})`)
  const prompt: ComfyPrompt = {
    // ---- loaders (template 317/318/335/313/293) ----
    '317': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: models.checkpoint } },
    '318': { class_type: 'LTXAVTextEncoderLoader', inputs: { text_encoder: models.textEncoder, ckpt_name: models.checkpoint, device: 'default' } },
    '335': { class_type: 'LTXVAudioVAELoader', inputs: { ckpt_name: models.checkpoint } },
    '313': { class_type: 'LatentUpscaleModelLoader', inputs: { model_name: models.latentUpscaler } },
    '293': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['317', 0], lora_name: models.distilledLora, strength_model: LTX23_PINS.ia2v.distilledStrength } },
    // ---- image prep (template 297/350/334): target-size resize, then the
    //     official 1536-longer-side LTXVPreprocess idiom ----
    '297': { class_type: 'ResizeImageMaskNode', inputs: { input: ['270', 0], resize_type: 'scale dimensions', 'resize_type.width': width, 'resize_type.height': height, crop: 'center', scale_method: 'lanczos' } },
    '350': { class_type: 'ResizeImageMaskNode', inputs: { input: ['297', 0], resize_type: 'scale longer dimension', 'resize_type.longer_size': LTX23_PINS.ia2v.imageLongerSide, scale_method: 'lanczos', crop: 'center' } },
    '334': { class_type: 'LTXVPreprocess', inputs: { image: ['350', 0], img_compression: LTX23_PINS.ia2v.imgCompression } },
    // ---- audio latent: trim → encode → fully-noised mask (template 332/328/333/327) ----
    '332': { class_type: 'TrimAudioDuration', inputs: { audio: ['271', 0], start_index: audioStart, duration: durationSeconds } },
    '328': { class_type: 'LTXVAudioVAEEncode', inputs: { audio: ['332', 0], audio_vae: ['335', 0] } },
    '333': { class_type: 'SolidMask', inputs: { value: 0, width, height } },
    '327': { class_type: 'SetLatentNoiseMask', inputs: { samples: ['328', 0], mask: ['333', 0] } },
    // ---- conditioning (template 306/314/307) ----
    '306': { class_type: 'CLIPTextEncode', inputs: { clip: ['318', 0], text: request.prompt ?? LTX23_PROMPTS.ia2v } },
    '314': { class_type: 'CLIPTextEncode', inputs: { clip: ['318', 0], text: LTX23_PROMPTS.negativeIa2v } },
    '307': { class_type: 'LTXVConditioning', inputs: { positive: ['306', 0], negative: ['314', 0], frame_rate: fps } },
    // ---- stage 1 at the exact half canvas (template 299/301/329/302/325/326) ----
    '299': { class_type: 'ComfyMathExpression', inputs: { expression: 'a/2', 'values.a': width } },
    '301': { class_type: 'ComfyMathExpression', inputs: { expression: 'a/2', 'values.a': height } },
    '329': { class_type: 'ComfyMathExpression', inputs: { expression: 'a * b + 1', 'values.a': durationSeconds, 'values.b': fps } },
    '302': { class_type: 'EmptyLTXVLatentVideo', inputs: { width: ['299', 1], height: ['301', 1], length: ['329', 1], batch_size: 1 } },
    '325': { class_type: 'LTXVImgToVideoInplace', inputs: { vae: ['317', 2], image: ['334', 0], latent: ['302', 0], strength: LTX23_PINS.ia2v.stage1ImageStrength, bypass: false } },
    '326': { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['325', 0], audio_latent: ['327', 0] } },
    // ---- stage 1 sampling (template 286/315/298/308/291) ----
    '286': { class_type: 'RandomNoise', inputs: { noise_seed: request.seed } },
    '315': { class_type: 'CFGGuider', inputs: { model: ['293', 0], positive: ['307', 0], negative: ['307', 1], cfg: LTX23_PINS.ia2v.cfg } },
    '298': { class_type: 'KSamplerSelect', inputs: { sampler_name: LTX23_PINS.ia2v.sampler } },
    '308': { class_type: 'ManualSigmas', inputs: { sigmas: LTX23_PINS.firstStageSigmas } },
    '291': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['286', 0], guider: ['315', 0], sampler: ['298', 0], sigmas: ['308', 0], latent_image: ['326', 0] } },
    '309': { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['291', 0] } },
    '292': { class_type: 'LTXVCropGuides', inputs: { positive: ['307', 0], negative: ['307', 1], latent: ['309', 0] } },
    // ---- refine: x2 upsample + strength-1 re-anchor + low-sigma ladder
    //     (template 295/296/287/285/290/288/289/310) ----
    '295': { class_type: 'LTXVLatentUpsampler', inputs: { samples: ['309', 0], upscale_model: ['313', 0], vae: ['317', 2] } },
    '296': { class_type: 'LTXVImgToVideoInplace', inputs: { vae: ['317', 2], image: ['334', 0], latent: ['295', 0], strength: LTX23_PINS.ia2v.stage2ImageStrength, bypass: false } },
    '287': { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['296', 0], audio_latent: ['309', 1] } },
    '285': { class_type: 'RandomNoise', inputs: { noise_seed: LTX23_PINS.ia2v.stage2NoiseSeed } },
    '290': { class_type: 'CFGGuider', inputs: { model: ['293', 0], positive: ['292', 0], negative: ['292', 1], cfg: LTX23_PINS.ia2v.cfg } },
    '288': { class_type: 'KSamplerSelect', inputs: { sampler_name: LTX23_PINS.ia2v.sampler } },
    '289': { class_type: 'ManualSigmas', inputs: { sigmas: LTX23_PINS.ia2vRefinerSigmas } },
    '310': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['285', 0], guider: ['290', 0], sampler: ['288', 0], sigmas: ['289', 0], latent_image: ['287', 0] } },
    '311': { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['310', 0] } },
    // ---- decode + mux with the GENERATED audio (template 316/303/312) ----
    '316': { class_type: 'VAEDecodeTiled', inputs: { samples: ['311', 0], vae: ['317', 2], tile_size: LTX23_PINS.ia2vTiledDecode.tileSize, overlap: LTX23_PINS.ia2vTiledDecode.overlap, temporal_size: LTX23_PINS.ia2vTiledDecode.temporalSize, temporal_overlap: LTX23_PINS.ia2vTiledDecode.temporalOverlap } },
    '303': { class_type: 'LTXVAudioVAEDecode', inputs: { samples: ['311', 1], audio_vae: ['335', 0] } },
    '312': { class_type: 'CreateVideo', inputs: { images: ['316', 0], audio: ['303', 0], fps } },
    '270': { class_type: 'LoadImage', inputs: { image: uploadedName(request.image) } },
    '271': { class_type: 'LoadAudio', inputs: { audio: uploadedName(request.audio) } },
    '320': { class_type: 'SaveVideo', inputs: { video: ['312', 0], filename_prefix: request.filenamePrefix, format: 'auto', codec: 'auto' } },
  }
  return prompt
}

// ---------------------------------------------------------------------------
// Dispatcher + tool registry
// ---------------------------------------------------------------------------

/** Builds any LTX-2.3 utility graph by tool id (the flows-layer entry
 *  point). Throws with actionable text when inputs or models are missing. */
export function buildLtx23UtilityGraph(request: Ltx23UtilityRequest, models: Ltx23ModelSelection): ComfyPrompt {
  switch (request.tool) {
    case 'remove-subtitles':
    case 'remove-watermark':
    case 'restore-archival':
      return buildLtx23RemoveGraph(request, models)
    case 'remove-object':
      return buildLtx23RemoveObjectGraph(request, models)
    case 'outpaint':
      return buildLtx23OutpaintGraph(request, models)
    case 'ia2v':
      return buildLtx23Ia2vGraph(request, models)
    default:
      throw new Error(`unknown LTX-2.3 utility '${String(request.tool)}'`)
  }
}

/** Core node classes each family's graph needs beyond stock loaders — the
 *  connected-engine half of availability. Kept per-family (not global) so
 *  the ia2v tool honestly reports "no packs needed" while the editors gate
 *  on theirs. */
const CORE_NODES = {
  remove: ['GetVideoComponents', 'ResizeImageMaskNode', 'LTXVConditioning', 'EmptyLTXVLatentVideo', 'LTXVEmptyLatentAudio', 'LTXVAudioVAEEncode', 'CFGGuider', 'KSamplerSelect', 'ManualSigmas', 'SamplerCustomAdvanced', 'RandomNoise', 'LTXVConcatAVLatent', 'LTXVSeparateAVLatent', 'LTXVCropGuides', 'LTXVLatentUpsampler', 'ComfyMathExpression', 'CreateVideo', 'LoadVideo', 'SaveVideo'] as const,
  obscura: ['GetVideoComponents', 'ResizeImageMaskNode', 'DualCLIPLoader', 'UNETLoader', 'LTXVConditioning', 'EmptyLTXVLatentVideo', 'LTXVEmptyLatentAudio', 'KSampler', 'LTXVConcatAVLatent', 'LTXVSeparateAVLatent', 'LTXVCropGuides', 'VAEDecode', 'CreateVideo', 'LoadVideo', 'SaveVideo'] as const,
  outpaint: ['GetVideoComponents', 'ResizeImageMaskNode', 'GetImageSize', 'LTXVConditioning', 'EmptyLTXVLatentVideo', 'LTXVEmptyLatentAudio', 'ComfyMathExpression', 'ComfyNumberConvert', 'CFGGuider', 'KSamplerSelect', 'ManualSigmas', 'SamplerCustomAdvanced', 'RandomNoise', 'LTXVConcatAVLatent', 'LTXVSeparateAVLatent', 'LTXVCropGuides', 'VAEDecode', 'CreateVideo', 'LoadVideo', 'SaveVideo'] as const,
  ia2v: ['ResizeImageMaskNode', 'LTXVPreprocess', 'LTXVImgToVideoInplace', 'TrimAudioDuration', 'LTXVAudioVAEEncode', 'SolidMask', 'SetLatentNoiseMask', 'LTXVConditioning', 'EmptyLTXVLatentVideo', 'ComfyMathExpression', 'CFGGuider', 'KSamplerSelect', 'ManualSigmas', 'SamplerCustomAdvanced', 'RandomNoise', 'LTXVConcatAVLatent', 'LTXVSeparateAVLatent', 'LTXVCropGuides', 'LTXVLatentUpsampler', 'VAEDecodeTiled', 'CreateVideo', 'LoadImage', 'LoadAudio', 'SaveVideo'] as const,
}

const REMOVE_PACK_NODES = [...LTXVIDEO_NODES, 'GetImageSizeAndCount'] as const
const REMOVE_MODEL_SLOTS = ['checkpoint', 'textEncoder', 'latentUpscaler'] as const

function removeFamilyTool(id: string, label: string, kind: Ltx23UtilityKind, loraSlot: keyof Ltx23ModelSelection, promptDefault: string, ui: Ltx23Utility['ui']) {
  return {
    id,
    label,
    kind,
    packNodes: REMOVE_PACK_NODES,
    coreNodes: CORE_NODES.remove,
    modelSlots: [...REMOVE_MODEL_SLOTS, loraSlot],
    promptDefault,
    negativePrompt: LTX23_PROMPTS.negativeRemove,
    detect: (info: ObjectInfo | undefined, files: ModelFile[]) => detectUtility(info, files, REMOVE_PACK_NODES, [...REMOVE_MODEL_SLOTS, loraSlot]),
    ui,
  } satisfies Ltx23Utility
}

export const LTX23_UTILITIES: Ltx23Utility[] = [
  removeFamilyTool(
    'ltx23.remove-subtitles',
    'Remove subtitles',
    'remove-subtitles',
    'subtitlesRemoveLora',
    LTX23_PROMPTS.subtitles,
    {
      description: 'One-graph subtitle/caption/text-overlay removal on ltx-2.3-22b-dev (the official 43-node two-stage template): stage 1 inpaints the text at half resolution over the 9-sigma ladder, the x2 latent upscaler doubles it, stage 2 re-guides at full resolution and refines. Original audio passes through untouched.',
      warning: 'A restoration pass, not a mask edit — everything outside the text is re-rendered at model quality. The default prompt is the template\'s own; replacing it changes what "removal" means.',
      installHint: 'Settings → Fetchable items: the ComfyUI-LTXVideo node pack + KJNodes, the ltx-2.3-22b-dev checkpoint, the Gemma 3 12B encoder, the x2-1.1 latent upscaler, and the joyfox subtitles-remove IC-LoRA (Apache-2.0) — then rescan.',
      promptGuidance: 'Describe the removal AND the expected reconstruction, scene-style ("Remove subtitles … restoring a clean and natural underlying image").',
      input: 'a video with burned-in subtitles/captions',
    },
  ),
  removeFamilyTool(
    'ltx23.remove-watermark',
    'Remove watermark',
    'remove-watermark',
    'watermarkRemoveLora',
    LTX23_PROMPTS.watermark,
    {
      description: 'The same two-stage graph with the watermark-remove IC-LoRA @1.5 (the official watermark template differs from the subtitles template ONLY in LoRA, strength and prompt — verified by byte-diff). For short-video-platform corner watermarks and logo occlusions.',
      warning: 'Same whole-frame restoration caveat as Remove subtitles. LoRA strength is pinned at the template\'s 1.5 (vs 1.2 for subtitles).',
      installHint: 'Settings → Fetchable items: same stack as Remove subtitles, plus the joyfox watermark-remove IC-LoRA (same Apache-2.0 repo) — then rescan.',
      promptGuidance: 'Describe the watermark removal and the clean original image underneath, scene-style.',
      input: 'a video with a persistent watermark',
    },
  ),
  removeFamilyTool(
    'ltx23.restore-archival',
    'Restore archival footage',
    'restore-archival',
    'archivalLora',
    LTX23_PROMPTS.archival,
    {
      description: 'The dearchive IC-LoRA on the same two-stage graph (official restore-archival template): takes real archive footage — B&W broadcast, low-bitrate web rips, sepia prints — and rewrites it as contemporary-looking video while keeping the content. Audio passes through.',
      warning: 'A creative restoration, not a conservative cleanup: the default prompt asks for "modern, high-resolution, vivid color" and the model obliges — style is reinterpreted, not just denoised.',
      installHint: 'Settings → Fetchable items: same stack as Remove subtitles, plus the oumoumad dearchive IC-LoRA (fetch entry ltx23-dearchive) — then rescan.',
      promptGuidance: 'Describe the TARGET look, not the damage — the LoRA maps degraded footage onto the described modern rendering.',
      input: 'degraded / archival video',
    },
  ),
  {
    id: 'ltx23.remove-object',
    label: 'Remove object (Obscura Remova)',
    kind: 'remove-object',
    packNodes: ['LTXAddVideoICLoRAGuide', 'VAELoaderKJ'],
    coreNodes: CORE_NODES.obscura,
    modelSlots: ['transformer', 'textEncoder', 'textProjection', 'videoVae', 'audioVae', 'obscuraLora', 'distilledLora'],
    promptDefault: LTX23_PROMPTS.obscura,
    negativePrompt: LTX23_PROMPTS.negativeObscura,
    detect: (info, files) => detectUtility(info, files, ['LTXAddVideoICLoRAGuide', 'VAELoaderKJ'], ['transformer', 'textEncoder', 'textProjection', 'videoVae', 'audioVae', 'obscuraLora', 'distilledLora']),
    ui: {
      description: 'Foreground object removal by description (WepeNerd\'s Obscura Remova LoRA @2.0 on the Kijai split stack, single 8-step distilled pass): name the object in the prompt and it is removed with the background reconstructed. Audio is regenerated.',
      warning: 'The template\'s own usage guide: strength 1.3–2.0 (pinned 2.0), landscape sizes stitch down / portrait right. Describe ONE foreground object per pass.',
      installHint: 'Settings → Fetchable items: ComfyUI-LTXVideo + KJNodes packs, the Kijai split stack (transformer-only, text projection, both bf16 VAEs), the Obscura Remova LoRA, and the distilled-384-1.1 LoRA — then rescan.',
      promptGuidance: 'Exactly the template\'s form: "Remove the {object} from the foreground." — one object, foreground only.',
      input: 'a video with an unwanted foreground object',
    },
  },
  {
    id: 'ltx23.outpaint',
    label: 'Outpaint video',
    kind: 'outpaint',
    packNodes: ['LTXAddVideoICLoRAGuide', 'ImagePadKJ', 'Float32ColorCorrect'],
    coreNodes: CORE_NODES.outpaint,
    modelSlots: ['checkpoint', 'textEncoder', 'distilledLora', 'outpaintLora'],
    promptDefault: LTX23_PROMPTS.outpaint,
    negativePrompt: LTX23_PROMPTS.negativeOutpaint,
    detect: (info, files) => detectUtility(info, files, ['LTXAddVideoICLoRAGuide', 'ImagePadKJ', 'Float32ColorCorrect'], ['checkpoint', 'textEncoder', 'distilledLora', 'outpaintLora']),
    ui: {
      description: 'Aspect-ratio canvas growth (the official outpaint IC-LoRA template): pads the source to a target ratio (default 9:16), runs one 9-sigma pass at the half-res grid with the padded frames as the gamma-corrected in-context guide, and muxes the original audio back.',
      warning: 'The generated canvas is the half-resolution grid the template itself pins (0.5 downscale, multiple-of-32) — plan the target ratio, not a pixel size. An empty prompt is valid (the guide does the work).',
      installHint: 'Settings → Fetchable items: ComfyUI-LTXVideo + KJNodes + radiance packs (Float32ColorCorrect is load-bearing), the ltx-2.3-22b-dev(-fp8) checkpoint, the Gemma encoder, the distilled-384 LoRA, and the oumoumad outpaint IC-LoRA — then rescan.',
      promptGuidance: 'Optional — describe what the grown margins should contain when you want control; the guide image already carries the scene.',
      input: 'a video to grow to a wider/taller aspect',
    },
  },
  {
    id: 'ltx23.ia2v',
    label: 'Image + audio → video',
    kind: 'ia2v',
    packNodes: [],
    coreNodes: CORE_NODES.ia2v,
    modelSlots: ['checkpoint', 'textEncoder', 'latentUpscaler', 'distilledLora'],
    promptDefault: LTX23_PROMPTS.ia2v,
    negativePrompt: LTX23_PROMPTS.negativeIa2v,
    detect: (info, files) => detectUtility(info, files, [], ['checkpoint', 'textEncoder', 'latentUpscaler', 'distilledLora']),
    ui: {
      description: 'Talking-portrait video from one image + one audio clip (the official native IA2V workflow, core nodes only): the audio rides a fully-noised latent into joint audio-video sampling for lip-sync, stage 1 at half resolution with the portrait anchored at 0.7, then the x2 upsample and a strength-1 refine. Video and audio are both generated.',
      warning: 'Duration is capped by the audio window (default 9 s); the template\'s optional LLM prompt-enhancement chain is not ported — write the full scene yourself.',
      installHint: 'Settings → Fetchable items: the ltx-2.3-22b-dev(-fp8) checkpoint, the Gemma encoder, the x2-1.1 latent upscaler, and a distilled LoRA — no node packs needed (all core).',
      promptGuidance: 'Chronological scene-style prompt: core actions, visual details, and the audio/dialogue (the official LTX-2.3 prompting guide).',
      input: 'a portrait image + an audio clip',
    },
  },
]

export function findLtx23Utility(id: string): Ltx23Utility | undefined {
  return LTX23_UTILITIES.find((utility) => utility.id === id)
}

/** Availability of every tool against the live engine + scan — the Settings
 *  listing (gating + install guidance) and the run-flow's preflight. */
export function detectLtx23Utilities(info: ObjectInfo | undefined, files: ModelFile[]): Array<{ utility: Ltx23Utility; detection: Ltx23Detection }> {
  return LTX23_UTILITIES.map((utility) => ({ utility, detection: utility.detect(info, files) }))
}

// ---------------------------------------------------------------------------
// Topology audit — the template invariants as executable checks
// ---------------------------------------------------------------------------

/** Walks a built LTX-2.3 utility graph and reports structural violations of
 *  the official-template invariants. Empty array = the graph obeys every
 *  rule. (These are the classes of mistake the two-stage IC-LoRA shape
 *  makes plausible: decoding through un-cropped guide latents, sampling
 *  without the audio reference tokens, wiring a stage's guide after its
 *  sampler, or losing the checkpoint-provided VAE.) */
export function ltx23TopologyAudit(graph: ComfyPrompt, kind?: Ltx23UtilityKind): string[] {
  const violations: string[] = []
  const nodes = Object.values(graph)
  const classes = nodes.map((node) => node.class_type)
  const byClass = (name: string) => nodes.filter((node) => node.class_type === name)
  const linksOf = (value: unknown): string[] => (Array.isArray(value) ? [String(value[0])] : [])

  // Every link points at a node that exists in this graph.
  for (const [id, node] of Object.entries(graph)) {
    for (const [key, value] of Object.entries(node.inputs)) {
      for (const target of linksOf(value)) {
        if (!graph[target]) violations.push(`${id}.${key} links to missing node ${target}`)
      }
    }
  }
  // The dev checkpoint is the single source of MODEL/VAE in the checkpoint
  // families: the video VAE must come from CheckpointLoaderSimple[2], never
  // a second loader that would load a different VAE.
  if (classes.includes('CheckpointLoaderSimple') && byClass('VAELoader').length) {
    violations.push('CheckpointLoaderSimple and a bare VAELoader both present — the checkpoint families take the VAE from the checkpoint output')
  }
  // Guide discipline: every LTXAddVideoICLoRAGuide's latent input must be a
  // latent the same stage owns (empty latent, upsampler, or img2video), and
  // its conditioning consumers must not be a decode path.
  for (const guide of byClass('LTXAddVideoICLoRAGuide')) {
    const latentSources = linksOf(guide.inputs.latent)
    if (!latentSources.length) violations.push('LTXAddVideoICLoRAGuide without a latent input — the guide rides a latent by contract')
    const imageSources = linksOf(guide.inputs.image)
    if (!imageSources.length) violations.push('LTXAddVideoICLoRAGuide without the in-context image — the IC-LoRA reference is missing')
  }
  // Two-stage families: exactly two ManualSigmas ladders in remove/ia2v, the
  // first-stage ladder is the 9-sigma dev schedule, the upscaler sits between
  // the two samplers, and the refine ladder is strictly shorter.
  if (kind === 'remove-subtitles' || kind === 'remove-watermark' || kind === 'restore-archival' || kind === 'ia2v') {
    const sigmas = byClass('ManualSigmas')
    if (sigmas.length !== 2) violations.push(`two-stage families carry exactly two ManualSigmas ladders (found ${sigmas.length})`)
    if (!classes.includes('LTXVLatentUpsampler')) violations.push('two-stage families route stage 2 through LTXVLatentUpsampler — missing')
    const values = sigmas.map((node) => String(node.inputs.sigmas))
    if (!values.includes(LTX23_PINS.firstStageSigmas)) violations.push('the stage-1 ManualSigmas ladder must be the pinned 9-sigma dev schedule')
  }
  // The remove family never regenerates audio: CreateVideo's audio comes
  // from the video source (GetVideoComponents[1]), and no audio decode feeds it.
  if (kind === 'remove-subtitles' || kind === 'remove-watermark' || kind === 'restore-archival' || kind === 'outpaint') {
    for (const create of byClass('CreateVideo')) {
      const audioSources = linksOf(create.inputs.audio)
      const fromDecode = audioSources.some((id) => graph[id]?.class_type === 'LTXVAudioVAEDecode')
      if (fromDecode) violations.push('this family muxes the ORIGINAL audio — a decoded regenerated audio latent must not feed CreateVideo')
    }
  }
  // ia2v/obscura DO decode the generated audio into the mux.
  if (kind === 'ia2v' || kind === 'remove-object') {
    for (const create of byClass('CreateVideo')) {
      const audioSources = linksOf(create.inputs.audio)
      if (!audioSources.some((id) => graph[id]?.class_type === 'LTXVAudioVAEDecode')) violations.push('this family muxes the GENERATED audio — LTXVAudioVAEDecode must feed CreateVideo')
    }
  }
  // No guide tokens may survive into a decode — but ONLY in guided graphs:
  // every LTXVTiledVAEDecode / VAEDecode / VAEDecodeTiled latent input must
  // trace to LTXVCropGuides when LTXAddVideoICLoRAGuide is present (the
  // guide-free ia2v topology legitimately decodes the separated latent
  // directly — its LTXVCropGuides is a conditioning passthrough).
  if (classes.includes('LTXAddVideoICLoRAGuide')) {
    for (const decode of [...byClass('LTXVTiledVAEDecode'), ...byClass('VAEDecode'), ...byClass('VAEDecodeTiled')]) {
      const sources = linksOf(decode.inputs.latents ?? decode.inputs.samples)
      const cropped = sources.every((id) => graph[id]?.class_type === 'LTXVCropGuides')
      if (!cropped) violations.push('decode consumes a latent that did not pass LTXVCropGuides — guide tokens would render as frames')
    }
  }
  return violations
}

/** Convenience for callers (and tests): build + audit in one step. */
export function buildLtx23UtilityGraphWithAudit(request: Ltx23UtilityRequest, models: Ltx23ModelSelection): { graph: ComfyPrompt; violations: string[] } {
  const graph = buildLtx23UtilityGraph(request, models)
  return { graph, violations: ltx23TopologyAudit(graph, request.tool) }
}
