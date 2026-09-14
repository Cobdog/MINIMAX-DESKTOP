/** Upscale/post-process registry entries. These migrated verbatim from the
 * pre-registry buildMiniMaxWorkflow branches — the topology, node ids and
 * widget values are the stable contract scripts/test-workflows.cjs already
 * asserts; the registry just moved them behind the entry seam so future
 * methods (SeedVR2, FaceRefine, …) join as data. */
import { choices, type ObjectInfo } from '../comfyInfo'
import type { ComfyPrompt, GraphContext, OptimizationEntry, TransformOptions } from './types'
import { H3 } from './ids'

const LTX_UPSCALE_REQUIRED_NODES = [
  'VAEEncodeTiled', 'LatentUpscaleModelLoader', 'LTXVLatentUpsampler',
  'VAEDecodeTiled', 'ImageFromBatch', 'RepeatImageBatch', 'ImageBatch',
] as const

const LBH_REQUIRED_NODES_2D = ['MinimaxH3LatentUpscalerNode2D'] as const
const LBH_REQUIRED_NODES_3D = ['MinimaxH3LatentUpscaler3D'] as const

function upscaleTransform(apply: (graph: ComfyPrompt, ctx: GraphContext, opts: TransformOptions) => void) {
  return (graph: ComfyPrompt, ctx: GraphContext, opts: TransformOptions) => {
    if (!opts.upscale) return
    apply(graph, ctx, opts)
  }
}

/** LTX-2.5 latent spatial 2×: encode the finished H3 frames into the LTX
 * video latent domain, apply the learned x2 upscaler, decode, remux the
 * untouched H3 audio. Padding to 8n+1 satisfies the LTX VAE temporal layout
 * and is trimmed after decoding so duration cannot drift. */
function applyLtx2x(graph: ComfyPrompt, ctx: GraphContext, opts: TransformOptions): void {
  const upscale = opts.upscale
  if (!upscale || upscale.type !== 'ltx') return
  let images = ctx.link('decode')
  const frames = opts.frameCount
  const pad = (8 - ((frames - 1) % 8)) % 8
  if (pad) {
    graph[H3.ltxPadTail] = { class_type: 'ImageFromBatch', inputs: { image: images, batch_index: frames - 1, length: 1 } }
    graph[H3.ltxPadRepeat] = { class_type: 'RepeatImageBatch', inputs: { image: [H3.ltxPadTail, 0], amount: pad } }
    graph[H3.ltxPadBatch] = { class_type: 'ImageBatch', inputs: { image1: images, image2: [H3.ltxPadRepeat, 0] } }
    images = [H3.ltxPadBatch, 0]
  }
  graph[H3.ltxVae] = { class_type: 'VAELoader', inputs: { vae_name: upscale.vae } }
  graph[H3.ltxEncode] = { class_type: 'VAEEncodeTiled', inputs: { pixels: images, vae: [H3.ltxVae, 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 } }
  graph[H3.ltxUpscaleModel] = { class_type: 'LatentUpscaleModelLoader', inputs: { model_name: upscale.model } }
  graph[H3.ltxLatentUpscale] = { class_type: 'LTXVLatentUpsampler', inputs: { samples: [H3.ltxEncode, 0], upscale_model: [H3.ltxUpscaleModel, 0], vae: [H3.ltxVae, 0] } }
  graph[H3.ltxDecode] = { class_type: 'VAEDecodeTiled', inputs: { samples: [H3.ltxLatentUpscale, 0], vae: [H3.ltxVae, 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 } }
  graph[H3.ltxTrim] = { class_type: 'ImageFromBatch', inputs: { image: [H3.ltxDecode, 0], batch_index: 0, length: frames } }
  graph[H3.ltxCreateVideo] = { class_type: 'CreateVideo', inputs: { images: [H3.ltxTrim, 0], audio: ctx.link('audioDecode'), fps: 24, bit_depth: 8, color_space: 'sRGB' } }
  graph[H3.ltxSaveVideo] = { class_type: 'SaveVideo', inputs: { video: [H3.ltxCreateVideo, 0], filename_prefix: `${opts.filenamePrefix}_LTX25_2x`, format: 'auto', codec: 'auto' } }
  ctx.bind('ltxSaveVideo', H3.ltxSaveVideo)
}

/** LBH-123-AI community two-stage hires-fix: the first sampler runs a split
 * sigma schedule at base resolution, the video latent is separated and
 * upscaled by the learned H3 upscaler, re-joined with the untouched audio
 * latent, then refined by a short manual sigma pass (0.9035…0.0000). */
function applyLbh(kind: 'lbh2d' | 'lbh3d') {
  return (graph: ComfyPrompt, ctx: GraphContext, opts: TransformOptions): void => {
    const upscale = opts.upscale
    if (!upscale || upscale.type !== kind) return
    const stageOneSteps = opts.turboPlan?.steps ?? (opts.turbo === 'off' ? opts.steps : Number(opts.turbo))
    graph[H3.lbhSplitSigmas] = { class_type: 'SplitSigmas', inputs: { sigmas: ctx.link('scheduler'), split_index: Math.max(1, Math.round(stageOneSteps / 2)) } }
    graph[ctx.id('sampler')!].inputs.sigmas = [H3.lbhSplitSigmas, 0]
    graph[H3.lbhSeparate] = { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ctx.link('sampler') } }
    graph[H3.lbhUpscale] = kind === 'lbh2d'
      ? { class_type: 'MinimaxH3LatentUpscalerNode2D', inputs: { latent: [H3.lbhSeparate, 0], model_name: upscale.model, scale: 2, device: 'cuda', precision: 'fp16' } }
      : { class_type: 'MinimaxH3LatentUpscaler3D', inputs: { latent: [H3.lbhSeparate, 0], model_name: upscale.model, mode: 'target dimensions', width: opts.width * 2, height: opts.height * 2, align: 32, enable_temporal_chunking: true, force_unload: true, device: 'cuda', precision: 'fp16' } }
    graph[H3.lbhJoin] = { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: [H3.lbhUpscale, 0], audio_latent: [H3.lbhSeparate, 1] } }
    graph[H3.lbhRefineSigmas] = { class_type: 'ManualSigmas', inputs: { sigmas: '0.9035, 0.8000, 0.6316, 0.3158, 0.0000' } }
    graph[H3.lbhRefineSampler] = { class_type: 'SamplerCustomAdvanced', inputs: { noise: ctx.link('noise'), guider: ctx.link('guider'), sampler: ctx.link('samplerSelect'), sigmas: [H3.lbhRefineSigmas, 0], latent_image: [H3.lbhJoin, 0] } }
    graph[H3.lbhDecode] = { class_type: 'VAEDecodeTiled', inputs: { samples: [H3.lbhRefineSampler, 0], vae: ctx.link('videoVae'), tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 } }
    graph[H3.lbhAudioDecode] = { class_type: 'VAEDecodeAudio', inputs: { samples: [H3.lbhRefineSampler, 0], vae: ctx.link('audioVae') } }
    graph[H3.lbhCreateVideo] = { class_type: 'CreateVideo', inputs: { images: [H3.lbhDecode, 0], audio: [H3.lbhAudioDecode, 0], fps: 24, bit_depth: 8, color_space: 'sRGB' } }
    graph[H3.lbhSaveVideo] = { class_type: 'SaveVideo', inputs: { video: [H3.lbhCreateVideo, 0], filename_prefix: `${opts.filenamePrefix}_LBH_2x`, format: 'auto', codec: 'auto' } }
    ctx.bind('lbhSaveVideo', H3.lbhSaveVideo)
  }
}

/** RTX/CUDA pixel-space 2×: frame-based AI upscaling normalized to an exact
 * 2× output even when the ESRGAN model's native scale is larger. */
function applyRtx(graph: ComfyPrompt, ctx: GraphContext, opts: TransformOptions): void {
  const upscale = opts.upscale
  if (!upscale || upscale.type !== 'rtx') return
  graph[H3.rtxModel] = { class_type: 'UpscaleModelLoader', inputs: { model_name: upscale.model } }
  graph[H3.rtxUpscale] = { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: [H3.rtxModel, 0], image: ctx.link('decode') } }
  graph[H3.rtxScale] = { class_type: 'ImageScale', inputs: { image: [H3.rtxUpscale, 0], upscale_method: 'lanczos', width: opts.width * 2, height: opts.height * 2, crop: 'disabled' } }
  graph[H3.rtxCreateVideo] = { class_type: 'CreateVideo', inputs: { images: [H3.rtxScale, 0], audio: ctx.link('audioDecode'), fps: 24, bit_depth: 8, color_space: 'sRGB' } }
  graph[H3.rtxSaveVideo] = { class_type: 'SaveVideo', inputs: { video: [H3.rtxCreateVideo, 0], filename_prefix: `${opts.filenamePrefix}_RTX_AI_2x`, format: 'auto', codec: 'auto' } }
  ctx.bind('rtxSaveVideo', H3.rtxSaveVideo)
}

function ltxDetect(info: ObjectInfo | undefined) {
  const missingNodes = info ? LTX_UPSCALE_REQUIRED_NODES.filter((node) => !info[node]) : Array.from(LTX_UPSCALE_REQUIRED_NODES)
  const model = info ? choices(info, 'LatentUpscaleModelLoader', 'model_name').find((name) => /ltx-2\.5.*spatial.*x2/i.test(name)) : undefined
  return { available: Boolean(info) && missingNodes.length === 0 && Boolean(model), model, missingNodes }
}

function lbhDetect(nodeClass: 'MinimaxH3LatentUpscalerNode2D' | 'MinimaxH3LatentUpscaler3D', required: readonly string[]) {
  return (info: ObjectInfo | undefined) => {
    const missingNodes = info ? required.filter((node) => !info[node]) : Array.from(required)
    const found = info ? choices(info, nodeClass, 'model_name').find((name) => !name.startsWith('(')) : undefined
    return { available: Boolean(info) && missingNodes.length === 0 && Boolean(found), model: found, missingNodes }
  }
}

function rtxDetect(info: ObjectInfo | undefined) {
  const found = info ? choices(info, 'UpscaleModelLoader', 'model_name').find((name) => !name.startsWith('(')) : undefined
  return { available: Boolean(found), model: found, missingNodes: [] }
}

export const UPSCALE_ENTRIES: OptimizationEntry[] = [
  {
    id: 'upscale.ltx2x',
    label: 'LTX-2.5 latent 2×',
    kind: 'upscale',
    appliesTo: ['minimax'],
    wraps: 'output',
    detect: ltxDetect,
    transform: upscaleTransform(applyLtx2x),
    ui: {
      description: 'Non-generative: re-encodes into the LTX latent domain, applies the learned spatial x2 upscaler, remuxes H3 audio.',
      installHint: 'LTX-2.5 video VAE + ltx-2.5-latent-spatial-upscaler-x2 from the LTX-2.5 ComfyUI models.',
    },
  },
  {
    id: 'upscale.lbh2d',
    label: 'LBH latent 2D 2×',
    kind: 'upscale',
    appliesTo: ['minimax'],
    wraps: 'output',
    detect: lbhDetect('MinimaxH3LatentUpscalerNode2D', LBH_REQUIRED_NODES_2D),
    transform: upscaleTransform(applyLbh('lbh2d')),
    ui: {
      description: 'Fast two-stage hires-fix through the LBH-123-AI 2D latent upscaler.',
      installHint: 'github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler + its 2D model.',
    },
  },
  {
    id: 'upscale.lbh3d',
    label: 'LBH latent 3D 2×',
    kind: 'upscale',
    appliesTo: ['minimax'],
    wraps: 'output',
    detect: lbhDetect('MinimaxH3LatentUpscaler3D', LBH_REQUIRED_NODES_3D),
    transform: upscaleTransform(applyLbh('lbh3d')),
    ui: {
      description: 'Temporally-coherent two-stage hires-fix through the LBH-123-AI 3D latent upscaler.',
      installHint: 'github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler + its 3D model.',
    },
  },
  {
    id: 'upscale.rtx',
    label: 'RTX/CUDA pixel 2×',
    kind: 'upscale',
    appliesTo: ['minimax'],
    wraps: 'output',
    detect: rtxDetect,
    transform: upscaleTransform(applyRtx),
    ui: {
      description: 'Frame-based ESRGAN-style upscaling through ComfyUI\'s CUDA path, normalized to exact 2×.',
      installHint: 'Any UpscaleModelLoader model (e.g. RealESRGAN_x2.pth) in ComfyUI/models/upscale_models.',
    },
  },
]

export function upscaleEntryFor(type: 'ltx' | 'lbh2d' | 'lbh3d' | 'rtx'): OptimizationEntry | undefined {
  const id = type === 'ltx' ? 'upscale.ltx2x' : type === 'rtx' ? 'upscale.rtx' : `upscale.${type}`
  return UPSCALE_ENTRIES.find((entry) => entry.id === id)
}
