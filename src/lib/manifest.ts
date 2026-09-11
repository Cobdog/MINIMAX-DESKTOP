/** Reproducibility manifests: everything needed to re-run a render exactly —
 *  seed, model files with sizes, LoRA strength, sampler/scheduler/steps, the
 *  graph topology hash, and reference inventories. Attached to each job at
 *  submit time and exportable as JSON. */
import type { GenerationJob, ModelSelection } from '../types'
import type { GenerationOptions } from '../types'

/** Bumped whenever a graph family's topology changes intentionally; recorded
 *  on every render beside the structural hash so old jobs stay attributable. */
export const GRAPH_FAMILY_VERSION = 'studio-2026-09'

export type RenderManifest = {
  manifestVersion: 1
  graphFamily: string
  createdAt: number
  provider: 'minimax' | 'ltx25' | 'acestep'
  mode: string
  prompt: string
  seed: number
  steps: number
  turbo: string
  sampler: string
  scheduler: string
  resolution: string
  durationSeconds: number
  frameCount?: number
  loraStrength?: number
  refImageSize?: string
  sigmaShift?: { video: number; audio: number }
  upscale?: string
  models: Record<string, { name: string; bytes?: number } | undefined>
  referenceCounts: { images: number; videos: number; audios: number }
  timelineGuideFrames?: number[]
  graphVersion: string
  engine: { comfyUrl: string; app: string }
}

/** Stable FNV-1a over the graph's node-class sequence + structural inputs —
 *  changes to graph topology change the hash; prompt/seed do not (they are
 *  recorded as fields). */
export function graphVersionHash(graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>) {
  const structural = Object.keys(graph).sort().map((id) => {
    const node = graph[id]
    const linkKeys = Object.entries(node.inputs)
      .filter(([, value]) => Array.isArray(value))
      .map(([key, value]) => `${key}->${(value as unknown[]).join('.')}`)
      .sort()
    return `${id}:${node.class_type}(${linkKeys.join(',')})`
  }).join('|')
  let hash = 0x811c9dc5
  for (let index = 0; index < structural.length; index += 1) {
    hash ^= structural.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `fnv1a-${hash.toString(16).padStart(8, '0')}`
}

function modelBytes(models: ModelSelection, found: Array<{ name: string; kind: string; bytes: number }>, name: string) {
  if (!name) return { name, bytes: undefined }
  const match = found.find((file) => file.name === name)
  return { name, bytes: match?.bytes }
}

export function buildRenderManifest(options: GenerationOptions, models: ModelSelection, modelFiles: Array<{ name: string; kind: string; bytes: number }>, comfyUrl: string, graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>): RenderManifest {
  return {
    manifestVersion: 1,
    graphFamily: GRAPH_FAMILY_VERSION,
    createdAt: Date.now(),
    provider: 'minimax',
    mode: options.mode,
    prompt: options.prompt,
    seed: options.seed,
    steps: options.steps,
    turbo: options.turbo,
    sampler: options.experimentalSampling ? options.sampler : 'res_multistep',
    scheduler: options.experimentalSampling ? options.scheduler : 'simple',
    resolution: `${options.width}x${options.height}`,
    durationSeconds: options.duration,
    loraStrength: options.turbo === 'off' ? undefined : options.loraStrength,
    refImageSize: options.refImageSize,
    sigmaShift: options.sigmaShift,
    upscale: options.upscale?.type ?? 'off',
    models: {
      diffusion: modelBytes(models, modelFiles, options.mode === 'reference' ? models.ref2va : models.fl2va),
      textEncoder: modelBytes(models, modelFiles, models.textEncoder),
      videoVae: modelBytes(models, modelFiles, models.videoVae),
      audioVae: modelBytes(models, modelFiles, models.audioVae),
      turboLora: options.turbo === 'off' ? undefined : modelBytes(models, modelFiles, options.mode === 'reference' ? models.ref2vLora : models.fl2vLora),
    },
    referenceCounts: { images: options.referenceImages.length, videos: options.referenceVideos.length, audios: options.referenceAudios.length },
    timelineGuideFrames: options.timelineGuides?.map((guide) => guide.frameIndex),
    graphVersion: graphVersionHash(graph),
    engine: { comfyUrl, app: 'MiniMax Studio' },
  }
}

export function manifestFileName(job: GenerationJob) {
  const stamp = new Date(job.createdAt).toISOString().replace(/[:.]/g, '-')
  return `manifest-${job.provider ?? 'minimax'}-${stamp}.json`
}

/** Browser download of a manifest (or any JSON payload) without a server round
 *  trip. Returns false when the Blob URL could not be created. */
export function downloadJson(fileName: string, value: unknown): boolean {
  try {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
    return true
  } catch {
    return false
  }
}
