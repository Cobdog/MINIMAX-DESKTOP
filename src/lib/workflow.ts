import type { GenerationOptions, ModelSelection, UploadedFile } from '../types'
import type { ObjectInfo } from './comfyInfo'
import { assertNoT1ImageVaeInVideoGraph, createGraphContext, findOptimization, FORM_ADAPTER_NODE, H3, resolveTurboPlan, upscaleEntryFor } from './graph'
import type { ComfyPrompt, Link, TransformOptions } from './graph'

// The graph data model + optimization registry live in ./graph; the type is
// re-exported here because every sibling builder imports it from this module.
export type { ComfyPrompt }

// The official ComfyUI MiniMax H3 templates use this pair for both the
// full-quality and distilled graphs. Turbo LoRAs are trained for it, so do not
// let a stale/custom UI choice silently change a turbo render. Registry
// entries may declare their own sampler pairing (e.g. a family's dedicated
// sampler node); everything else pins to this pair.
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
  info?: ObjectInfo,
): ComfyPrompt {
  const prompt: ComfyPrompt = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: options.mode === 'reference' ? models.ref2va : models.fl2va, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: models.textEncoder, type: 'minimax', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: models.videoVae } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: models.audioVae } },
  }

  const frames = frameCount(options.duration)
  // FACTORY GUARD (H3 Image Workbench spec AC8): the Mamad8 T=1 image VAE is
  // pinned to single-frame graphs. Any video-frame-count graph referencing it
  // is a factory validation error — the constraint is enforced here, at the
  // video factory, not documented away (multi-frame decode through it
  // regresses with patch-grid ghosting and cross-frame mixing).
  assertNoT1ImageVaeInVideoGraph(models.videoVae, frames)
  const ctx = createGraphContext(prompt, H3.unet, {
    previewVae: models.previewVae,
    frameCount: frames,
  })
  ctx.bind('unet', H3.unet)
  ctx.bind('clip', H3.clip)
  ctx.bind('videoVae', H3.videoVae)
  ctx.bind('audioVae', H3.audioVae)

  // The transform facts every registry entry may read. Turbulence-free by
  // construction: entries never see the raw options object.
  const transformOptions: TransformOptions = {
    mode: options.mode,
    width: options.width,
    height: options.height,
    duration: options.duration,
    filenamePrefix: options.filenamePrefix,
    turbo: options.turbo,
    steps: options.steps,
    frameCount: frames,
    loraStrength: options.loraStrength,
    upscale: options.upscale,
    previewOverride: options.previewOverride,
    experimentalSampling: options.experimentalSampling,
    info,
  }

  // Registry seam 1 — turbo loader (node '5'). The plan resolves the selected
  // LoRA's family, its step pairing, and whether the dedicated larryvrh
  // loader/sampler pair is available for it. With no turbo (or no LoRA file)
  // the plan is undefined and the entry stays inert — the graph is
  // deep-equal to the pre-registry base.
  const loraName = options.mode === 'reference' ? models.ref2vLora : models.fl2vLora
  const turboPlan = resolveTurboPlan({ turbo: options.turbo, loraName, strength: options.loraStrength ?? 1, loader: options.turboLoader, info })
  transformOptions.turboPlan = turboPlan
  if (turboPlan) {
    const turboEntry = findOptimization(turboPlan.entryId)
    turboEntry?.transform(prompt, ctx, transformOptions)
  }

  // The LoRA timeline's user stack (7twfk6o, nodes '8'/'9'): 0–2 user LoRAs
  // chained after the turbo seam — orthogonal to the tier (a quality-tier
  // render may carry style LoRAs). Slot 0 rides the first-party form
  // adapter (MiniMaxH3LoraFormLoader) when its pack is installed — always
  // first among the stack loaders, the image workbench's cross-form-safety
  // rule: a mismatched-form LoRA through the stock loader is a shape error,
  // never a silent no-op. Absent/empty stack = zero new nodes, the graph
  // stays byte-identical to the pre-seam factory output.
  const loraStack = (options.loraStack ?? []).filter((entry) => entry && typeof entry.name === 'string' && entry.name).slice(0, 2)
  loraStack.forEach((entry, index) => {
    const id = index === 0 ? H3.loraStack1 : H3.loraStack2
    const strength = Math.min(2, Math.max(0, Number.isFinite(entry.strength) ? entry.strength : 1))
    if (index === 0 && info && (info as Record<string, unknown>)[FORM_ADAPTER_NODE] !== undefined) {
      // low_vram is the adapter's REQUIRED second boolean (default false,
      // same widget family as the larryvrh TurboLoRA loader) — omitting it
      // is refused at prompt validation. Retired hybrid.form-adapter-low-vram.
      ctx.wrapModel('loraStack1', id, { class_type: FORM_ADAPTER_NODE, inputs: { lora_name: entry.name, strength, mode: 'projected (default)', egrid_path: '', low_vram: false } })
    } else {
      ctx.wrapModel(index === 0 ? 'loraStack1' : 'loraStack2', id, { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: entry.name, strength_model: strength } })
    }
  })

  let modelLink: Link = ctx.modelLink()
  if (options.sigmaShift) {
    prompt['6'] = {
      class_type: 'MiniMaxH3SigmaShift',
      inputs: { model: modelLink, shift_video: options.sigmaShift.video, shift_audio: options.sigmaShift.audio },
    }
    modelLink = ['6', 0]
  }

  // Registry seam 2 — live-preview override (node '7'), same model chain.
  if (options.previewOverride) {
    findOptimization('preview.h3-override')?.transform(prompt, ctx, transformOptions)
    modelLink = ctx.modelLink()
  }

  const conditioningInputs: Record<string, string | number | boolean | Link> = {
    clip: ['2', 0],
    vae: ['3', 0],
    prompt: options.prompt,
    width: options.width,
    height: options.height,
    length: frames,
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
  ctx.bind('conditioning', H3.conditioning)

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

  // Latent chaining (ComfyUI-H3-Motion-Context): segment N pins clip N-1's
  // tail as never-denoised conditioning rows feeding the guider, so motion
  // and audio continue from real sampled frames instead of a single still.
  if (options.chain && options.chain.index > 0) {
    // Phase-4 latent forks pin an explicit source clip (their own folder is a
    // fresh continuation); scene chains keep the previous-clip default.
    // The pack's indices are 1-BASED (clip 1 is the first; index 0 never
    // reads a file), while the app's chain index is 0-based — +1 on both
    // Load and Save below, or a fork silently renders without its source.
    prompt['24'] = { class_type: 'MiniMaxH3MotionContextLoadLatent', inputs: { latent_path: (options.chain.loadFrom?.folder ?? options.chain.folder).replace(/\/clip$/, ''), clip_index: (options.chain.loadFrom?.clipIndex ?? options.chain.index - 1) + 1 } }
    prompt['25'] = {
      class_type: 'MiniMaxH3MotionContext',
      inputs: {
        conditioning: conditioningSource,
        vae: ['3', 0],
        latent: ['24', 0],
        context_length: options.chain.contextLength ?? '22',
        audio_context_length: options.chain.audioContextLength ?? 24,
      },
    }
    conditioningSource = ['25', 0]
  }
  prompt['11'] = { class_type: 'RandomNoise', inputs: { noise_seed: options.seed } }
  prompt['12'] = { class_type: 'BasicGuider', inputs: { model: modelLink, conditioning: conditioningSource } }
  const sampler = options.experimentalSampling ? options.sampler : OFFICIAL_H3_SAMPLER
  const scheduler = options.experimentalSampling ? options.scheduler : OFFICIAL_H3_SCHEDULER
  // Pairing contract: a dedicated sampler node (from the entry's declared
  // pairing, e.g. larryvrh's MiniMaxH3TurboSampler) replaces KSamplerSelect —
  // it carries no widgets. The user's experimental-sampling opt-in still wins.
  const pairingSamplerNode = turboPlan?.samplerNode && !options.experimentalSampling ? turboPlan.samplerNode : undefined
  prompt['13'] = pairingSamplerNode
    ? { class_type: pairingSamplerNode, inputs: {} }
    : { class_type: 'KSamplerSelect', inputs: { sampler_name: sampler } }
  prompt['14'] = {
    class_type: 'BasicScheduler',
    inputs: { model: modelLink, scheduler, steps: turboPlan?.steps ?? (options.turbo === 'off' ? options.steps : Number(options.turbo)), denoise: 1 },
  }
  prompt['15'] = {
    class_type: 'SamplerCustomAdvanced',
    inputs: { noise: ['11', 0], guider: ['12', 0], sampler: ['13', 0], sigmas: ['14', 0], latent_image: ['10', 1] },
  }
  // Latent chaining (ComfyUI-H3-Motion-Context): every segment saves its
  // sampler latent into its fixed slot <prefix>_%05d.safetensors (1-based
  // clip index) under the output directory;
  // segment 0 is the chain start (LoadLatent with clip_index 0 never reads),
  // segment N pins clip N-1's tail as never-denoised conditioning rows and
  // trims the overlap from the delivered output so audio and motion stay
  // continuous across clips.
  if (options.chain) {
    prompt['28'] = { class_type: 'MiniMaxH3MotionContextSaveLatent', inputs: { latent: ['15', 0], filename_prefix: options.chain.folder, clip_index: options.chain.index + 1 } }
  }
  prompt['16'] = { class_type: 'VAEDecode', inputs: { samples: ['15', 0], vae: ['3', 0] } }
  prompt['17'] = { class_type: 'VAEDecodeAudio', inputs: { samples: ['15', 0], vae: ['4', 0] } }
  if (options.chain && options.chain.index > 0) {
    prompt['26'] = { class_type: 'MiniMaxH3MotionContextTrim', inputs: { images: ['16', 0], audio: ['17', 0], trim_frames: ['25', 1] } }
    prompt['27'] = { class_type: 'CreateVideo', inputs: { images: ['26', 0], audio: ['26', 1], fps: 24, bit_depth: 8, color_space: 'sRGB' } }
  } else {
    prompt['18'] = {
      class_type: 'CreateVideo',
      inputs: { images: ['16', 0], audio: ['17', 0], fps: 24, bit_depth: 8, color_space: 'sRGB' },
    }
  }
  const videoSource: Link = options.chain && options.chain.index > 0 ? ['27', 0] : ['18', 0]
  prompt['19'] = {
    class_type: 'SaveVideo',
    inputs: { video: videoSource, filename_prefix: options.filenamePrefix, format: 'auto', codec: 'auto' },
  }
  // Always publish one standard ComfyUI preview frame. This works even when the
  // server was launched without latent preview decoding enabled.
  prompt['71'] = { class_type: 'ImageFromBatch', inputs: { image: ['16', 0], batch_index: 0, length: 1 } }
  prompt['72'] = { class_type: 'PreviewImage', inputs: { images: ['71', 0] } }
  ctx.bind('noise', H3.noise)
  ctx.bind('guider', H3.guider)
  ctx.bind('samplerSelect', H3.samplerSelect)
  ctx.bind('scheduler', H3.scheduler)
  ctx.bind('sampler', H3.sampler)
  ctx.bind('decode', H3.decode)
  ctx.bind('audioDecode', H3.audioDecode)
  ctx.bind('saveVideo', H3.saveVideo)

  // Registry seam 3 — post-processing branches. Exactly one upscale entry can
  // be active; each transforms only its own id block (60s/70s, 80s, 90s) off
  // the factory's decode/audio/save roles. No upscale option: all inert.
  if (options.upscale) {
    upscaleEntryFor(options.upscale.type)?.transform(prompt, ctx, transformOptions)
  }
  return prompt
}

export type ComfyOutputFile = { filename: string; subfolder?: string; type?: string }

/** The exact output file ComfyUI reported for a finished prompt, preferring
 *  the RTX-upscale save node ('84'), then anything matching the media type.
 *  Callers use this descriptor to resolve the local output path — never a
 *  newest-file-on-disk guess. */
export function extractOutputFile(history: Record<string, unknown>, promptId: string, mediaType: 'video' | 'audio' | 'image' = 'video'): ComfyOutputFile | undefined {
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
  else visit(entry.outputs)
  const expected = mediaType === 'audio' ? /\.(flac|wav|mp3|ogg|m4a|aac|opus)$/i : mediaType === 'image' ? /\.(png|jpe?g|webp)$/i : /\.(mp4|webm|mov|mkv|gif)$/i
  return candidates.find((candidate) => expected.test(candidate.filename)) ?? candidates[0]
}

export function extractOutputUrl(history: Record<string, unknown>, promptId: string, comfyUrl: string, mediaType: 'video' | 'audio' | 'image' = 'video') {
  const file = extractOutputFile(history, promptId, mediaType)
  if (!file) return undefined
  const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? '', type: file.type ?? 'output' })
  const upstream = `${comfyUrl.replace(/\/+$/, '')}/view?${query.toString()}`
  return `minimax-media://comfy?url=${encodeURIComponent(upstream)}`
}

/** EVERY output file of one media type a finished prompt reported, ordered
 *  by node id then filename — the packet-frame attribution (the H3 image
 *  workbench's per-frame publish nodes each save one frame; landing collects
 *  them all, never just the first). */
export function extractAllOutputFiles(history: Record<string, unknown>, promptId: string, mediaType: 'video' | 'audio' | 'image' = 'image'): ComfyOutputFile[] {
  const entry = history[promptId] as { outputs?: Record<string, Record<string, unknown>> } | undefined
  if (!entry?.outputs) return []
  const expected = mediaType === 'audio' ? /\.(flac|wav|mp3|ogg|m4a|aac|opus)$/i : mediaType === 'image' ? /\.(png|jpe?g|webp)$/i : /\.(mp4|webm|mov|mkv|gif)$/i
  const files: Array<{ node: string; file: ComfyOutputFile }> = []
  for (const nodeId of Object.keys(entry.outputs).sort()) {
    const visit = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach(visit)
        return
      }
      if (!value || typeof value !== 'object') return
      const object = value as Record<string, unknown>
      if (typeof object.filename === 'string' && expected.test(object.filename)) {
        files.push({
          node: nodeId,
          file: {
            filename: object.filename,
            subfolder: typeof object.subfolder === 'string' ? object.subfolder : undefined,
            type: typeof object.type === 'string' ? object.type : undefined,
          },
        })
      }
      Object.values(object).forEach(visit)
    }
    visit(entry.outputs[nodeId])
  }
  return files
    .sort((a, b) => (a.node === b.node ? a.file.filename.localeCompare(b.file.filename) : a.node.localeCompare(b.node, undefined, { numeric: true })))
    .map((item) => item.file)
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
