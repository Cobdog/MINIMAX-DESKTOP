import type { GenerationOptions, ModelSelection, UploadedFile } from '../types'

type Link = [string, number]
type ComfyNode = { class_type: string; inputs: Record<string, string | number | boolean | Link> }
export type ComfyPrompt = Record<string, ComfyNode>

// The official ComfyUI MiniMax H3 templates use this pair for both the
// full-quality and distilled graphs. Turbo LoRAs are trained for it, so do not
// let a stale/custom UI choice silently change a turbo render.
export const OFFICIAL_H3_SAMPLER = 'res_multistep'
export const OFFICIAL_H3_SCHEDULER = 'simple'

export function frameCount(seconds: number) {
  const base = Math.max(5, Math.round(seconds * 24))
  return base + ((5 - (base % 17) + 17) % 17)
}

/** Swaps the final video VAEDecode for the tiled variant — the standard
 *  fallback when a full-tensor decode exhausts VRAM. */
export function withTiledVideoDecode(graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>) {
  const next: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {}
  for (const [id, node] of Object.entries(graph)) {
    if (node.class_type === 'VAEDecode') {
      next[id] = { class_type: 'VAEDecodeTiled', inputs: { ...node.inputs, tile_size: 1024, overlap: 128, temporal_size: 64, temporal_overlap: 8 } }
    } else {
      next[id] = node
    }
  }
  return next
}

/** Official frame-index convention: round(seconds * 24); negative seconds
 *  count from the end of the video. */
export function frameIndexForSeconds(seconds: number) {
  return Math.round(seconds * 24)
}

/** A guide's frame index must land inside the generated clip (index plus the
 *  guide's own length stays within duration). Returns a warning or null. */
export function guideFrameWarning(seconds: number, duration: number): string | null {
  const index = frameIndexForSeconds(seconds)
  const total = frameCount(duration)
  if (index >= total) return `The ${seconds.toFixed(1)}s keyframe lands at or beyond the ${duration}s duration — move it earlier.`
  if (index <= -total) return `The ${seconds.toFixed(1)}s keyframe lands at or before the start of the clip.`
  return null
}

export function uploadedName(file: UploadedFile) {
  return file.subfolder ? `${file.subfolder.replace(/\\/g, '/')}/${file.name}` : file.name
}

function addLoader(prompt: ComfyPrompt, id: string, kind: 'image' | 'video' | 'audio', name: string): Link {
  if (kind === 'image') {
    prompt[id] = { class_type: 'LoadImage', inputs: { image: name } }
    return [id, 0]
  }
  if (kind === 'audio') {
    prompt[id] = { class_type: 'LoadAudio', inputs: { audio: name } }
    return [id, 0]
  }
  prompt[id] = { class_type: 'LoadVideo', inputs: { file: name } }
  prompt[`${id}1`] = { class_type: 'GetVideoComponents', inputs: { video: [id, 0] } }
  return [`${id}1`, 0]
}

export function buildMiniMaxWorkflow(
  options: GenerationOptions,
  models: ModelSelection,
  uploads: {
    first?: UploadedFile
    last?: UploadedFile
    images: UploadedFile[]
    videos: UploadedFile[]
    audios: UploadedFile[]
    guides?: UploadedFile[]
  },
): ComfyPrompt {
  const prompt: ComfyPrompt = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: options.mode === 'reference' ? models.ref2va : models.fl2va, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: models.textEncoder, type: 'minimax', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: models.videoVae } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: models.audioVae } },
  }

  let modelLink: Link = ['1', 0]
  const loraName = options.mode === 'reference' ? models.ref2vLora : models.fl2vLora
  if (options.turbo !== 'off' && loraName) {
    prompt['5'] = { class_type: 'LoraLoaderModelOnly', inputs: { model: modelLink, lora_name: loraName, strength_model: options.loraStrength ?? 1 } }
    modelLink = ['5', 0]
  }
  if (options.sigmaShift) {
    prompt['6'] = {
      class_type: 'MiniMaxH3SigmaShift',
      inputs: { model: modelLink, shift_video: options.sigmaShift.video, shift_audio: options.sigmaShift.audio },
    }
    modelLink = ['6', 0]
  }
  if (options.previewOverride) {
    prompt['7'] = {
      class_type: options.previewOverride.nodeType ?? 'MiniMaxH3PreviewOverride',
      inputs: {
        model: modelLink,
        max_resolution: 512,
        preview_frames: options.previewOverride.frames,
        preview_fps: options.previewOverride.fps,
        // This is the tiny per-step RGB decoder from models/vae_approx, not the
        // full MiniMax video VAE used by the final decode branch.
        vae_name: options.previewOverride.vaeName ?? models.previewVae,
        jpeg_quality: options.previewOverride.jpegQuality ?? 85,
        suppress_default_preview: true,
      },
    }
    modelLink = ['7', 0]
  }

  const conditioningInputs: Record<string, string | number | boolean | Link> = {
    clip: ['2', 0],
    vae: ['3', 0],
    prompt: options.prompt,
    width: options.width,
    height: options.height,
    length: frameCount(options.duration),
  }

  if (options.mode === 'reference') {
    conditioningInputs.audio_vae = ['4', 0]
    conditioningInputs.ref_image_size = options.refImageSize
    uploads.images.forEach((file, index) => {
      const link = addLoader(prompt, `30${index}`, 'image', uploadedName(file))
      conditioningInputs[`ref_images.ref_image_${index}`] = link
    })
    uploads.videos.forEach((file, index) => {
      const loaderId = `40${index}`
      const link = addLoader(prompt, loaderId, 'video', uploadedName(file))
      conditioningInputs[`ref_videos.ref_video_${index}`] = link
      conditioningInputs[`ref_video_audios.ref_video_audio_${index}`] = [`${loaderId}1`, 1]
    })
    uploads.audios.forEach((file, index) => {
      const link = addLoader(prompt, `50${index}`, 'audio', uploadedName(file))
      conditioningInputs[`ref_audios.ref_audio_${index}`] = link
    })
    prompt['10'] = { class_type: 'MiniMaxH3ReferenceToVideo', inputs: conditioningInputs }
  } else {
    if (uploads.first) conditioningInputs.first_frame = addLoader(prompt, '20', 'image', uploadedName(uploads.first))
    if (uploads.last) conditioningInputs.last_frame = addLoader(prompt, '21', 'image', uploadedName(uploads.last))
    prompt['10'] = { class_type: 'MiniMaxH3ImageToVideo', inputs: conditioningInputs }
  }

  // Official multiframe topology: R2V positive -> AddGuide -> AddGuide ->
  // ... -> BasicGuider, with every guide sharing the R2V latent and both
  // VAEs (verified against Comfy-Org's video_minimax_h3_multiframe_reference
  // template). Guide-only images stay out of the ref_images slots.
  let conditioningSource: Link = ['10', 0]
  if (options.mode === 'reference' && options.timelineGuides?.length) {
    options.timelineGuides.forEach((guide, index) => {
      const upload = uploads.guides?.[index]
      if (!upload) return
      const imageLink = addLoader(prompt, `60${index}`, 'image', uploadedName(upload))
      const guideId = `65${index}`
      prompt[guideId] = {
        class_type: 'MiniMaxH3AddGuide',
        inputs: {
          positive: conditioningSource,
          latent: ['10', 1],
          vae: ['3', 0],
          audio_vae: ['4', 0],
          image: imageLink,
          frame_idx: guide.frameIndex,
        },
      }
      conditioningSource = [guideId, 0]
    })
  }

  prompt['11'] = { class_type: 'RandomNoise', inputs: { noise_seed: options.seed } }
  prompt['12'] = { class_type: 'BasicGuider', inputs: { model: modelLink, conditioning: conditioningSource } }
  const sampler = options.experimentalSampling ? options.sampler : OFFICIAL_H3_SAMPLER
  const scheduler = options.experimentalSampling ? options.scheduler : OFFICIAL_H3_SCHEDULER
  prompt['13'] = { class_type: 'KSamplerSelect', inputs: { sampler_name: sampler } }
  prompt['14'] = {
    class_type: 'BasicScheduler',
    inputs: { model: modelLink, scheduler, steps: options.turbo === 'off' ? options.steps : Number(options.turbo), denoise: 1 },
  }
  prompt['15'] = {
    class_type: 'SamplerCustomAdvanced',
    inputs: { noise: ['11', 0], guider: ['12', 0], sampler: ['13', 0], sigmas: ['14', 0], latent_image: ['10', 1] },
  }
  prompt['16'] = { class_type: 'VAEDecode', inputs: { samples: ['15', 0], vae: ['3', 0] } }
  prompt['17'] = { class_type: 'VAEDecodeAudio', inputs: { samples: ['15', 0], vae: ['4', 0] } }
  prompt['18'] = {
    class_type: 'CreateVideo',
    inputs: { images: ['16', 0], audio: ['17', 0], fps: 24, bit_depth: 8, color_space: 'sRGB' },
  }
  prompt['19'] = {
    class_type: 'SaveVideo',
    inputs: { video: ['18', 0], filename_prefix: options.filenamePrefix, format: 'auto', codec: 'auto' },
  }
  // Always publish one standard ComfyUI preview frame. This works even when the
  // server was launched without latent preview decoding enabled.
  prompt['71'] = { class_type: 'ImageFromBatch', inputs: { image: ['16', 0], batch_index: 0, length: 1 } }
  prompt['72'] = { class_type: 'PreviewImage', inputs: { images: ['71', 0] } }
  if (options.upscale?.type === 'ltx') {
    // MiniMax post-processing intentionally remains non-generative: encode the
    // completed H3 frame sequence into the LTX video latent domain, apply the
    // learned spatial x2 node, decode, then remux the untouched H3 audio.
    // Padding to 8n+1 satisfies the LTX video VAE temporal layout and is removed
    // after decoding so clip duration cannot drift.
    let images: Link = ['16', 0]
    const frames = frameCount(options.duration)
    const pad = (8 - ((frames - 1) % 8)) % 8
    if (pad) {
      prompt['60'] = { class_type: 'ImageFromBatch', inputs: { image: images, batch_index: frames - 1, length: 1 } }
      prompt['61'] = { class_type: 'RepeatImageBatch', inputs: { image: ['60', 0], amount: pad } }
      prompt['62'] = { class_type: 'ImageBatch', inputs: { image1: images, image2: ['61', 0] } }
      images = ['62', 0]
    }
    prompt['63'] = { class_type: 'VAELoader', inputs: { vae_name: options.upscale.vae } }
    prompt['64'] = { class_type: 'VAEEncodeTiled', inputs: { pixels: images, vae: ['63', 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 } }
    prompt['65'] = { class_type: 'LatentUpscaleModelLoader', inputs: { model_name: options.upscale.model } }
    prompt['66'] = { class_type: 'LTXVLatentUpsampler', inputs: { samples: ['64', 0], upscale_model: ['65', 0], vae: ['63', 0] } }
    prompt['67'] = { class_type: 'VAEDecodeTiled', inputs: { samples: ['66', 0], vae: ['63', 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 } }
    prompt['68'] = { class_type: 'ImageFromBatch', inputs: { image: ['67', 0], batch_index: 0, length: frames } }
    prompt['69'] = { class_type: 'CreateVideo', inputs: { images: ['68', 0], audio: ['17', 0], fps: 24, bit_depth: 8, color_space: 'sRGB' } }
    prompt['70'] = { class_type: 'SaveVideo', inputs: { video: ['69', 0], filename_prefix: `${options.filenamePrefix}_LTX25_2x`, format: 'auto', codec: 'auto' } }
  } else if (options.upscale?.type === 'lbh2d' || options.upscale?.type === 'lbh3d') {
    // Community two-stage hires-fix (LBH-123-AI latent upscaler): the first
    // sampler runs a split sigma schedule at base resolution, the video
    // latent is separated and upscaled by the learned H3 upscaler, re-joined
    // with the untouched audio latent, then refined by a short manual sigma
    // pass. Topology and sigma schedules verified against the repo's example
    // workflow (SplitSigmas 4/8; refinement 0.9035…0.0000).
    const stageOneSteps = options.turbo === 'off' ? options.steps : Number(options.turbo)
    prompt['90'] = { class_type: 'SplitSigmas', inputs: { sigmas: ['14', 0], split_index: Math.max(1, Math.round(stageOneSteps / 2)) } }
    prompt['15'].inputs.sigmas = ['90', 0]
    prompt['91'] = { class_type: 'LTXVSeparateAVLatent', inputs: { av_latent: ['15', 0] } }
    prompt['92'] = options.upscale.type === 'lbh2d'
      ? { class_type: 'MinimaxH3LatentUpscalerNode2D', inputs: { latent: ['91', 0], model_name: options.upscale.model, scale: 2, device: 'cuda', precision: 'fp16' } }
      : { class_type: 'MinimaxH3LatentUpscaler3D', inputs: { latent: ['91', 0], model_name: options.upscale.model, mode: 'target dimensions', width: options.width * 2, height: options.height * 2, align: 32, enable_temporal_chunking: true, force_unload: true, device: 'cuda', precision: 'fp16' } }
    prompt['93'] = { class_type: 'LTXVConcatAVLatent', inputs: { video_latent: ['92', 0], audio_latent: ['91', 1] } }
    prompt['94'] = { class_type: 'ManualSigmas', inputs: { sigmas: '0.9035, 0.8000, 0.6316, 0.3158, 0.0000' } }
    prompt['95'] = { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['11', 0], guider: ['12', 0], sampler: ['13', 0], sigmas: ['94', 0], latent_image: ['93', 0] } }
    prompt['96'] = { class_type: 'VAEDecodeTiled', inputs: { samples: ['95', 0], vae: ['3', 0], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 } }
    prompt['97'] = { class_type: 'VAEDecodeAudio', inputs: { samples: ['95', 0], vae: ['4', 0] } }
    prompt['98'] = { class_type: 'CreateVideo', inputs: { images: ['96', 0], audio: ['97', 0], fps: 24, bit_depth: 8, color_space: 'sRGB' } }
    prompt['99'] = { class_type: 'SaveVideo', inputs: { video: ['98', 0], filename_prefix: `${options.filenamePrefix}_LBH_2x`, format: 'auto', codec: 'auto' } }
  } else if (options.upscale?.type === 'rtx') {
    // Frame-based AI upscaling runs through ComfyUI's CUDA/PyTorch device. It is
    // independent of LTX and is normalized to an exact 2x output even when the
    // selected ESRGAN model's native scale is larger.
    prompt['80'] = { class_type: 'UpscaleModelLoader', inputs: { model_name: options.upscale.model } }
    prompt['81'] = { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['80', 0], image: ['16', 0] } }
    prompt['82'] = { class_type: 'ImageScale', inputs: { image: ['81', 0], upscale_method: 'lanczos', width: options.width * 2, height: options.height * 2, crop: 'disabled' } }
    prompt['83'] = { class_type: 'CreateVideo', inputs: { images: ['82', 0], audio: ['17', 0], fps: 24, bit_depth: 8, color_space: 'sRGB' } }
    prompt['84'] = { class_type: 'SaveVideo', inputs: { video: ['83', 0], filename_prefix: `${options.filenamePrefix}_RTX_AI_2x`, format: 'auto', codec: 'auto' } }
  }
  return prompt
}

export type ComfyOutputFile = { filename: string; subfolder?: string; type?: string }

/** The exact output file ComfyUI reported for a finished prompt, preferring
 *  the RTX-upscale save node ('84'), then the LTX-upscale node ('70'), then
 *  anything matching the media type. Callers use this descriptor to resolve
 *  the local output path — never a newest-file-on-disk guess. */
export function extractOutputFile(history: Record<string, unknown>, promptId: string, mediaType: 'video' | 'audio' = 'video'): ComfyOutputFile | undefined {
  const entry = history[promptId] as { outputs?: Record<string, Record<string, unknown>> } | undefined
  if (!entry?.outputs) return undefined
  const candidates: ComfyOutputFile[] = []
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!value || typeof value !== 'object') return
    const object = value as Record<string, unknown>
    if (typeof object.filename === 'string') {
      candidates.push({
        filename: object.filename,
        subfolder: typeof object.subfolder === 'string' ? object.subfolder : undefined,
        type: typeof object.type === 'string' ? object.type : undefined,
      })
    }
    Object.values(object).forEach(visit)
  }
  if (entry.outputs['84']) visit(entry.outputs['84'])
  else if (entry.outputs['99']) visit(entry.outputs['99'])
  else if (entry.outputs['70']) visit(entry.outputs['70'])
  else visit(entry.outputs)
  const expected = mediaType === 'audio' ? /\.(flac|wav|mp3|ogg|m4a|aac|opus)$/i : /\.(mp4|webm|mov|mkv|gif)$/i
  return candidates.find((candidate) => expected.test(candidate.filename)) ?? candidates[0]
}

export function extractOutputUrl(history: Record<string, unknown>, promptId: string, comfyUrl: string, mediaType: 'video' | 'audio' = 'video') {
  const file = extractOutputFile(history, promptId, mediaType)
  if (!file) return undefined
  const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? '', type: file.type ?? 'output' })
  const upstream = `${comfyUrl.replace(/\/+$/, '')}/view?${query.toString()}`
  return `minimax-media://comfy?url=${encodeURIComponent(upstream)}`
}

/** Recovers the output descriptor encoded in a minimax-media://comfy URL that
 *  extractOutputUrl built, so a persisted job's exact output can be re-resolved
 *  on disk without touching ComfyUI again. */
export function outputFileFromUrl(url: string): ComfyOutputFile | undefined {
  if (!url.startsWith('minimax-media://comfy?')) return undefined
  const upstream = new URLSearchParams(url.slice('minimax-media://comfy?'.length)).get('url')
  if (!upstream) return undefined
  const params = new URL(upstream).searchParams
  const filename = params.get('filename')
  if (!filename) return undefined
  return { filename, subfolder: params.get('subfolder') || undefined, type: params.get('type') || undefined }
}
