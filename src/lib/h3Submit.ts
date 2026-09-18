/** The shared MiniMax H3 render-submission core (canvas Phase 2, task flyuh6h).
 *
 * Extracted verbatim from useGenerationFlows.generate so BOTH surfaces submit
 * through one code path (spec §8 D1/D2: the old CreateView and the canvas
 * read the same underlying flows): the hook snapshots its workspace state
 * into an explicit H3RenderRequest, the canvas builds the request from
 * per-chain settings in the document store. Nothing here touches a store —
 * every fact arrives as data, which is what makes the validation ladder and
 * the graph construction testable without an engine.
 *
 * The request carries the EFFECTIVE prompt (composeH3Prompt output) and the
 * ORDERED render references (resolveRenderReferenceImages output) — surface
 * builders own composition; this module owns validation, upload, graph
 * submission, and job bookkeeping.
 */
import { createId } from './createId'
import { buildMiniMaxWorkflow, frameIndexForSeconds, guideFrameWarning } from './workflow'
import { prepareImage } from './imageCrop'
import { buildRenderManifest } from './manifest'
import type { ObjectInfo } from './comfyInfo'
import type { AppSettings, GenerationJob, GenerationMode, MediaFile, ModelFile, ModelSelection, UpscaleMode } from '../types'

export type H3RenderRequest = {
  mode: GenerationMode
  /** The composed prompt exactly as it will render. */
  prompt: string
  width: number
  height: number
  duration: number
  seed: number
  steps: number
  turbo: 'off' | '4' | '8'
  turboLoader: 'auto' | 'plain'
  experimentalSampling: boolean
  loraStrength: number
  sampler: string
  scheduler: string
  refImageSize: 'match' | 'max'
  sigmaShift?: { video: number; audio: number }
  upscale:
    | { mode: UpscaleMode; model: string; vae: string; lbhModel: string; missingNodes: readonly string[] }
  /** The chosen AI-upscale model (RTX path) — the old surface reads it from
   *  the workspace store, the canvas from chain settings. */
  rtxModel: string
  firstFrame: MediaFile | null
  lastFrame: MediaFile | null
  /** Ordered, policy-resolved reference images (≤9). */
  referenceImages: MediaFile[]
  referenceVideos: MediaFile[]
  referenceAudios: MediaFile[]
  timelineGuides: Array<{ file: MediaFile; seconds: number }>
  livePreview: { enabled: boolean; mode: 'standard' | 'h3-override' }
  /** Latent-chaining facts (canvas Phase 4): when present the graph saves its
   *  sampler latent (and loads + trims a continuation when index > 0) — the
   *  Motion-Context machinery. The manifest records the SAVED clip so the
   *  landed take can carry its forkable latent facts. */
  chain?: { index: number; folder: string; contextLength?: '5' | '22' | '39' | '56'; audioContextLength?: number; loadFrom?: { folder: string; clipIndex: number } }
  /** Extra provenance merged into the persisted manifest (the canvas records
   *  the chain/project a render belongs to so a reload can relink). */
  manifestExtra?: Record<string, unknown>
  filenamePrefix?: string
  movieLink?: GenerationJob['movieLink']
  characterProjectId?: string
  /** The location a render belongs to (the Phase-4 walkthrough migration —
   *  jobRecords' automation display keys on it, exactly like the LTX path
   *  did). */
  locationProjectId?: string
}

/** The engine/session facts a submission needs — supplied by whichever
 *  surface is submitting (the hook reads its facades; the canvas reads the
 *  session store through its engine host). */
export type H3SubmitFacts = {
  settings: AppSettings
  connected: boolean
  modelReady: boolean
  /** H3 component selection for the request's turbo tier (inferSelections). */
  selection: ModelSelection
  models: ModelFile[]
  info: ObjectInfo
  clientId?: string
  /** Detected H3 Preview Override node class, when installed. */
  h3PreviewOverrideNode?: string
}

export type H3SubmitIo = {
  notify(tone: 'error' | 'success' | 'neutral', text: string): void
  setJobs(update: (current: GenerationJob[]) => GenerationJob[]): void
  /** The queue's cancellation-request set (cancel-before-submit races). */
  cancellationRequests: { current: Set<string> }
  /** The old surface tracks its active job in the workspace store. */
  onJobCreated?(jobId: string): void
}

/**
 * The validation ladder, same order and same messages as the pre-extraction
 * hook: upscale readiness → prompt → connection → models → preview override →
 * per-mode media → reference limits → keyframe guides. Returns the refusal
 * message, or null when the request may proceed. Pure — VM-harness tested
 * without an engine.
 */
export function validateH3Render(request: H3RenderRequest, facts: Pick<H3SubmitFacts, 'connected' | 'modelReady' | 'selection' | 'h3PreviewOverrideNode'>): string | null {
  const { upscale } = request
  if (upscale.mode === 'ltx' && (!upscale.model || !upscale.vae)) {
    return 'LTX 2.5 spatial upscaler and video VAE must be available in ComfyUI.'
  }
  if (upscale.mode === 'ltx' && upscale.missingNodes.length) {
    return `Update ComfyUI before using LTX 2× upscale. Missing nodes: ${upscale.missingNodes.join(', ')}.`
  }
  if (upscale.mode === 'rtx' && !request.rtxModel) {
    return 'Choose an AI upscale model installed in ComfyUI first.'
  }
  if ((upscale.mode === 'lbh2d' || upscale.mode === 'lbh3d') && !upscale.lbhModel) {
    return 'Install an H3 latent upscaler model into ComfyUI/models/latent_upscale_models (LBH-123-AI release), then refresh the engine.'
  }
  if (!request.prompt.trim()) return 'Add a prompt before generating.'
  if (!facts.connected) return 'Start ComfyUI and verify the server connection in Settings.'
  if (!facts.modelReady) return 'One or more required MiniMax H3 model components are missing.'
  if (request.livePreview.enabled && request.livePreview.mode === 'h3-override' && !facts.h3PreviewOverrideNode) {
    return 'MiniMax H3 animated preview is selected, but its Preview Override node was not detected. Install or enable the custom node, restart ComfyUI, then click the Local engine status to refresh.'
  }
  if (request.livePreview.enabled && request.livePreview.mode === 'h3-override' && !facts.selection.previewVae) {
    return 'MiniMax H3 animated preview requires taeh3_decoder.safetensors in ComfyUI/models/vae_approx. Refresh the Local engine after adding it.'
  }
  if ((request.mode === 'image' || request.mode === 'frames') && !request.firstFrame) {
    return 'Choose a first frame for this mode.'
  }
  if (request.mode === 'frames' && !request.lastFrame) {
    return 'Choose a last frame for first-and-last-frame generation.'
  }
  if (request.mode === 'reference' && request.referenceImages.length + request.referenceVideos.length + request.referenceAudios.length === 0) {
    return 'Add at least one reference image, video, or audio file.'
  }
  if (request.mode === 'reference' && (request.referenceImages.length > 9 || request.referenceVideos.length > 3 || request.referenceAudios.length > 3)) {
    return 'Reference limits are 9 pictures, 3 videos, and 3 audio files. Remove extras before rendering.'
  }
  const invalidGuide = request.timelineGuides.find((guide) => guideFrameWarning(guide.seconds, request.duration))
  if (request.mode === 'reference' && invalidGuide) {
    return guideFrameWarning(invalidGuide.seconds, request.duration)!
  }
  return null
}

/**
 * Validates, uploads, builds, and submits one H3 render through the shared
 * queue bookkeeping. Never parks a job when validation refuses — the caller
 * surfaces the returned message (both surfaces route it through their notice
 * tier). On success the job is already in jobsStore with status running;
 * on submission failure the job record flips to failed with the reason.
 */
export async function submitH3Render(
  request: H3RenderRequest,
  facts: H3SubmitFacts,
  io: H3SubmitIo,
): Promise<{ ok: true; jobId: string } | { ok: false; message: string }> {
  const refusal = validateH3Render(request, facts)
  if (refusal) {
    io.notify('error', refusal)
    return { ok: false, message: refusal }
  }
  const { settings } = facts
  io.notify('neutral', 'Uploading inputs and preparing the ComfyUI graph…')
  const upscale = request.upscale
  const localId = createId()
  const job: GenerationJob = {
    id: localId,
    mode: request.mode,
    prompt: request.prompt,
    createdAt: Date.now(),
    status: 'queued',
    progress: 2,
    progressLabel: 'Preparing and uploading inputs',
    width: request.width * (upscale.mode === 'off' ? 1 : 2),
    height: request.height * (upscale.mode === 'off' ? 1 : 2),
    duration: request.duration,
    movieLink: request.movieLink,
    characterProjectId: request.characterProjectId,
    locationProjectId: request.locationProjectId,
  }
  io.setJobs((current) => [job, ...current])
  io.onJobCreated?.(localId)
  try {
    const upload = async (file: MediaFile, fitToOutput = false) => file.kind === 'image' && (fitToOutput || Boolean(file.crop))
      ? window.minimax.uploadImageData(settings.comfyUrl, await prepareImage(file, request.width, request.height))
      : window.minimax.uploadInput(settings.comfyUrl, file.path)
    const guides = request.mode === 'reference' ? request.timelineGuides : []
    const [first, last, images, videos, audios, guideUploads] = await Promise.all([
      request.firstFrame && (request.mode === 'image' || request.mode === 'frames') ? upload(request.firstFrame, true) : undefined,
      request.lastFrame && request.mode === 'frames' ? upload(request.lastFrame, true) : undefined,
      Promise.all(request.mode === 'reference' ? request.referenceImages.map((file) => upload(file)) : []),
      Promise.all(request.mode === 'reference' ? request.referenceVideos.map((file) => upload(file)) : []),
      Promise.all(request.mode === 'reference' ? request.referenceAudios.map((file) => upload(file)) : []),
      Promise.all(guides.map(({ file }) => upload(file))),
    ])
    if (io.cancellationRequests.current.has(localId)) throw new Error('Generation cancelled before submission.')
    const filenamePrefix = request.filenamePrefix ?? `video/MiniMax_H3_${Date.now()}`
    const graph = buildMiniMaxWorkflow({
      mode: request.mode,
      prompt: request.prompt,
      width: request.width,
      height: request.height,
      duration: request.duration,
      seed: request.seed,
      steps: request.steps,
      turbo: request.turbo,
      experimentalSampling: request.experimentalSampling,
      loraStrength: request.loraStrength,
      sampler: request.experimentalSampling ? request.sampler : 'res_multistep',
      scheduler: request.experimentalSampling ? request.scheduler : 'simple',
      upscale: upscale.mode === 'ltx' ? { type: 'ltx', model: upscale.model, vae: upscale.vae } : upscale.mode === 'rtx' ? { type: 'rtx', model: request.rtxModel } : upscale.mode === 'lbh2d' || upscale.mode === 'lbh3d' ? { type: upscale.mode, model: upscale.lbhModel } : undefined,
      refImageSize: request.refImageSize,
      sigmaShift: request.sigmaShift,
      previewOverride: request.livePreview.enabled && request.livePreview.mode === 'h3-override' && facts.h3PreviewOverrideNode ? { frames: 50, fps: 12, nodeType: facts.h3PreviewOverrideNode, vaeName: facts.selection.previewVae, jpegQuality: 85 } : undefined,
      filenamePrefix,
      firstFrame: request.firstFrame?.path,
      lastFrame: request.lastFrame?.path,
      referenceImages: request.referenceImages.map((item) => item.path),
      referenceVideos: request.referenceVideos.map((item) => item.path),
      referenceAudios: request.referenceAudios.map((item) => item.path),
      timelineGuides: guides.length ? guides.map((guide) => ({ frameIndex: frameIndexForSeconds(guide.seconds) })) : undefined,
      turboLoader: request.turboLoader,
      chain: request.chain,
    }, facts.selection, { first, last, images, videos, audios, guides: guideUploads }, facts.info)
    const manifest = buildRenderManifest({
      mode: request.mode, prompt: request.prompt, width: request.width, height: request.height, duration: request.duration,
      seed: request.seed, steps: request.steps, turbo: request.turbo, experimentalSampling: request.experimentalSampling,
      loraStrength: request.loraStrength,
      sampler: request.experimentalSampling ? request.sampler : 'res_multistep', scheduler: request.experimentalSampling ? request.scheduler : 'simple',
      refImageSize: request.refImageSize, sigmaShift: request.sigmaShift,
      upscale: upscale.mode === 'off' ? undefined : upscale.mode === 'ltx' ? { type: 'ltx', model: upscale.model, vae: upscale.vae } : { type: 'rtx', model: request.rtxModel },
      referenceImages: request.referenceImages.map((item) => item.path), referenceVideos: request.referenceVideos.map((item) => item.path), referenceAudios: request.referenceAudios.map((item) => item.path),
      timelineGuides: guides.length ? guides.map((guide) => ({ frameIndex: frameIndexForSeconds(guide.seconds) })) : undefined,
      filenamePrefix,
    }, facts.selection, facts.models, settings.comfyUrl, graph)
    // The saved-clip facts ride the manifest's motionContext record — the
    // take-landing path reads them to persist forkable latent provenance.
    if (request.chain) manifest.motionContext = { folder: request.chain.folder, clipIndex: request.chain.index }
    if (request.manifestExtra) Object.assign(manifest, request.manifestExtra)
    // livePreview rides the submission (the server asks the engine for
    // native sampler previews via extra_data.preview_method); clientId stays
    // for interface compatibility — the server pins its own session id.
    const response = await window.minimax.submitPrompt(settings.comfyUrl, graph, facts.clientId, request.livePreview.enabled)
    if (io.cancellationRequests.current.has(localId)) {
      await window.minimax.cancelPrompt(settings.comfyUrl, response.prompt_id)
      io.setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'cancelled', error: undefined } : item))
      io.notify('success', 'Generation cancelled.')
    } else {
      io.setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'running', progress: 4, progressLabel: 'Waiting for ComfyUI to start', manifest, graph } : item))
      io.notify('success', 'Generation added to the local ComfyUI queue.')
    }
    return { ok: true, jobId: localId }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const cancelled = io.cancellationRequests.current.has(localId)
    io.setJobs((current) => current.map((item) => item.id === localId ? cancelled ? { ...item, status: 'cancelled', error: undefined } : { ...item, status: 'failed', error: message } : item))
    io.notify(cancelled ? 'success' : 'error', cancelled ? 'Generation cancelled.' : message)
    return { ok: false, message }
  } finally {
    io.cancellationRequests.current.delete(localId)
  }
}
