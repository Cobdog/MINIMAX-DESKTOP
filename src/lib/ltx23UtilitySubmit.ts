/** The shared LTX-2.3 utility submission core (canvas Phase 3, task j5sj28v).
 *
 * Extracted verbatim from useGenerationFlows.generateLtxUtility so BOTH
 * surfaces submit through one code path (spec §8 D1/D2 — the same discipline
 * as lib/h3Submit.ts, extracted in Phase 2): the hook keeps its facades, the
 * canvas reads the session store through its engine host. Everything arrives
 * as data — validation, upload, official-template graph construction, and
 * job bookkeeping are testable without an engine.
 */
import { createId } from './createId'
import { buildLtx23UtilityGraph, findLtx23Utility, resolveLtx23Selection, type Ltx23UtilityKind } from './graph/ltx23'
import type { ComfyPrompt } from './graph'
import type { ObjectInfo } from './comfyInfo'
import type { AppSettings, GenerationJob, MediaFile, ModelFile } from '../types'

export type Ltx23UtilityRequest = {
  tool: Ltx23UtilityKind
  prompt?: string
  seed?: number
  /** Input video (every tool except ia2v). */
  video: MediaFile | null
  /** Input image + audio (ia2v). */
  image?: MediaFile | null
  audio?: MediaFile | null
  /** Extra provenance merged into the persisted manifest (the canvas records
   *  the chain/project a run belongs to so a reload can relink). */
  manifestExtra?: Record<string, unknown>
}

export type Ltx23UtilityFacts = {
  settings: AppSettings
  connected: boolean
  info: ObjectInfo | undefined
  models: ModelFile[]
  clientId?: string
}

export type Ltx23UtilityIo = {
  notify(tone: 'error' | 'success' | 'neutral', text: string): void
  setJobs(update: (current: GenerationJob[]) => GenerationJob[]): void
  /** The queue's cancellation-request set (cancel-before-submit races). */
  cancellationRequests?: { current: Set<string> }
  onJobCreated?(jobId: string): void
}

/** The availability ladder: settings → connection → registry → inputs.
 *  Returns the refusal message, or null when the run may proceed. Pure. */
export function validateLtx23Utility(request: Ltx23UtilityRequest, facts: Pick<Ltx23UtilityFacts, 'connected' | 'info' | 'models'>): string | null {
  if (!facts.connected) return 'Start ComfyUI and verify the server connection in Settings.'
  const utility = findLtx23Utility(`ltx23.${request.tool}`)
  if (!utility) return `Unknown LTX-2.3 utility '${request.tool}'.`
  const detection = utility.detect(facts.info, facts.models)
  if (!detection.available) {
    const missing = [...detection.missingNodes.map((nodeClass) => `node ${nodeClass}`), ...detection.missingModels]
    return `${utility.label} is not ready — missing: ${missing.join('; ')}. ${utility.ui.installHint ?? ''}`
  }
  const needsVideo = request.tool !== 'ia2v'
  if (needsVideo && !request.video) return `Choose an input video for ${utility.label} first.`
  if (request.tool === 'ia2v' && (!request.image || !request.audio)) return 'Image + audio → video needs both an input image and an audio file.'
  return null
}

/** The engine-free graph plan: the exact official-template graph this request
 *  builds with the resolved selection (the seam the canvas probe surface and
 *  the tests read — construction is pure). */
export function planLtx23UtilityGraph(request: Ltx23UtilityRequest, facts: Pick<Ltx23UtilityFacts, 'info' | 'models'>, uploads: { video?: string; image?: string; audio?: string }): { graph: ComfyPrompt; selection: ReturnType<typeof resolveLtx23Selection> } | { graph: null; refusal: string } {
  const utility = findLtx23Utility(`ltx23.${request.tool}`)
  if (!utility) return { graph: null, refusal: `Unknown LTX-2.3 utility '${request.tool}'.` }
  const selection = resolveLtx23Selection(facts.info, facts.models)
  const detection = utility.detect(facts.info, facts.models)
  if (!detection.available) {
    const missing = [...detection.missingNodes.map((nodeClass) => `node ${nodeClass}`), ...detection.missingModels]
    return { graph: null, refusal: `${utility.label} is not ready — missing: ${missing.join('; ')}` }
  }
  try {
    const graph = buildLtx23UtilityGraph({
      tool: request.tool,
      prompt: request.prompt,
      seed: request.seed ?? 1,
      filenamePrefix: 'video/LTX23_plan',
      video: uploads.video ? { name: uploads.video } : undefined,
      image: uploads.image ? { name: uploads.image } : undefined,
      audio: uploads.audio ? { name: uploads.audio } : undefined,
    }, selection)
    return { graph, selection }
  } catch (error) {
    return { graph: null, refusal: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Validates, uploads, builds, and submits one LTX-2.3 utility run through the
 * shared queue bookkeeping. Never parks a job when validation refuses. The
 * raw source files go up untouched — the official templates resize/preprocess
 * inside the graph (no H3 crop pipeline).
 */
export async function submitLtx23Utility(
  request: Ltx23UtilityRequest,
  facts: Ltx23UtilityFacts,
  io: Ltx23UtilityIo,
): Promise<{ ok: true; jobId: string } | { ok: false; message: string }> {
  const refusal = validateLtx23Utility(request, facts)
  if (refusal) {
    io.notify('error', refusal)
    return { ok: false, message: refusal }
  }
  const { settings } = facts
  const utility = findLtx23Utility(`ltx23.${request.tool}`)!
  const needsVideo = request.tool !== 'ia2v'
  const localId = createId()
  const job: GenerationJob = {
    id: localId, provider: 'ltx23', mode: 'text', prompt: request.prompt ?? utility.promptDefault,
    createdAt: Date.now(), status: 'queued', progress: 2, progressLabel: `Preparing ${utility.label}`,
    width: 0, height: 0, duration: 0,
  }
  io.setJobs((current) => [job, ...current])
  io.onJobCreated?.(localId)
  io.notify('neutral', `Preparing the official LTX-2.3 ${utility.label} template graph…`)
  try {
    const seed = request.seed ?? Math.floor(Math.random() * 1_000_000_000)
    // Raw uploads: the templates resize/preprocess inside the graph, so the
    // source files go up untouched (no H3 crop pipeline).
    const uploadedVideo = needsVideo && request.video ? await window.minimax.uploadInput(settings.comfyUrl, request.video.path) : undefined
    const uploadedImage = request.tool === 'ia2v' && request.image ? await window.minimax.uploadInput(settings.comfyUrl, request.image.path) : undefined
    const uploadedAudio = request.tool === 'ia2v' && request.audio ? await window.minimax.uploadInput(settings.comfyUrl, request.audio.path) : undefined
    if (io.cancellationRequests?.current.has(localId)) throw new Error('Generation cancelled before submission.')
    const graph = buildLtx23UtilityGraph({
      tool: request.tool,
      prompt: request.prompt,
      seed,
      filenamePrefix: `video/LTX23_${request.tool}_${Date.now()}`,
      video: uploadedVideo,
      image: uploadedImage,
      audio: uploadedAudio,
    }, resolveLtx23Selection(facts.info, facts.models))
    const response = await window.minimax.submitPrompt(settings.comfyUrl, graph, facts.clientId)
    if (io.cancellationRequests?.current.has(localId)) {
      await window.minimax.cancelPrompt(settings.comfyUrl, response.prompt_id)
      io.setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'cancelled', error: undefined } : item))
      io.notify('success', 'The LTX-2.3 utility run was cancelled before it started.')
      return { ok: false, message: 'The LTX-2.3 utility run was cancelled before it started.' }
    }
    io.setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'running', progress: 4, progressLabel: 'Waiting for ComfyUI to start', ...(request.manifestExtra ? { manifest: request.manifestExtra } : {}) } : item))
    io.notify('success', `${utility.label} added to the ComfyUI queue.`)
    return { ok: true, jobId: localId }
  } catch (error) {
    const cancelled = io.cancellationRequests?.current.has(localId) ?? false
    const message = cancelled ? 'LTX-2.3 utility cancelled.' : error instanceof Error ? error.message : String(error)
    io.setJobs((current) => current.map((item) => item.id === localId ? { ...item, status: cancelled ? 'cancelled' : 'failed', error: cancelled ? undefined : message } : item))
    io.notify(cancelled ? 'success' : 'error', message)
    return { ok: false, message }
  } finally {
    io.cancellationRequests?.current.delete(localId)
  }
}
