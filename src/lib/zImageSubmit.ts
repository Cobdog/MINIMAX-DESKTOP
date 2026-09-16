/** The shared Z-Image still-image submission core (canvas Phase 3, task
 *  j5sj28v — §5.4 engines-as-ops: "selection decides the surface", extended
 *  to the image engine: nothing-selected + image intent = a Z-Image still; a
 *  selected control image + image intent = the Fun ControlNet Union graph
 *  through the existing zImageControlnet machinery).
 *
 * The old ZImageWorkspace polls its prompt directly; the canvas rides the
 * SHARED queue (jobsStore) — a provider 'zimage' job with mediaType 'image'
 * completes through the queue's history poll (extractOutputFile with the
 * image kind), so the take lands on its chain exactly like an H3 render.
 * Everything arrives as data — the validation ladder and graph construction
 * are engine-free and VM-harness testable.
 */
import { createId } from './createId'
import { choices, type ObjectInfo } from './comfyInfo'
import { buildZImage, type ZImageVariant } from './zimage'
import { buildZImageControlnet, CONTROL_PREPROCESSORS, type ZImageControlMode } from './zImageControlnet'
import type { AppSettings, GenerationJob, MediaFile } from '../types'

export type ZImageSurface = 'plain' | 'control'

export type ZImageRequest = {
  prompt: string
  seed: number
  width: number
  height: number
  /** plain = text→still (turbo 8-step); control = structure-guided through the
   *  Fun ControlNet Union patch (needs a control image). */
  surface: ZImageSurface
  /** The control image (surface 'control' only) — the canvas output ref. */
  controlImage: MediaFile | null
  controlMode: ZImageControlMode
  filenamePrefix?: string
  /** Extra provenance merged into the persisted manifest (the canvas records
   *  the chain/project a run belongs to so a reload can relink). */
  manifestExtra?: Record<string, unknown>
}

export type ZImageSelection = { model: string; encoder: string; vae: string; controlnet: string }

export type ZImageFacts = {
  settings: AppSettings
  connected: boolean
  info: ObjectInfo
}

export type ZImageIo = {
  notify(tone: 'error' | 'success' | 'neutral', text: string): void
  setJobs(update: (current: GenerationJob[]) => GenerationJob[]): void
  onJobCreated?(jobId: string): void
}

const isZImageModel = (name: string) => /z[_\s-]?image/i.test(name)

/**
 * Resolves the Z-Image stack the same way ZImageWorkspace does: the engine's
 * loader combo lists are the source of truth (the scan does not cover these
 * folders). Empty strings = not installed.
 */
export function resolveZImageSelection(info: ObjectInfo): ZImageSelection {
  const unets = choices(info, 'UNETLoader', 'unet_name')
  const model = unets.find((name) => /z[_\s-]?image.*turbo/i.test(name)) ?? unets.find(isZImageModel) ?? ''
  const encoder = choices(info, 'CLIPLoader', 'clip_name').find((name) => /qwen[_\s-]?3/i.test(name)) ?? ''
  const vae = choices(info, 'VAELoader', 'vae_name').find((name) => /^(ae|vae[._-]?(auto)?encoder)/i.test(name) || /lumina/i.test(name)) ?? ''
  const controlnet = choices(info, 'ModelPatchLoader', 'model_name').find((name) => /fun.*controlnet.*union|controlnet.*union/i.test(name)) ?? ''
  return { model, encoder, vae, controlnet }
}

/** The preprocessor node each control mode needs (zImageControlnet's table). */
export function zImageControlNodesReady(info: ObjectInfo, mode: ZImageControlMode): boolean {
  return Boolean(info['QwenImageDiffsynthControlnet'] && info['ModelPatchLoader'] && info['GetImageSize'] && info[CONTROL_PREPROCESSORS[mode].node])
}

/** The validation ladder: prompt → connection → models → (control: nodes +
 *  image). Returns the refusal message, or null when the run may proceed. */
export function validateZImage(request: ZImageRequest, facts: Pick<ZImageFacts, 'connected' | 'info'>): string | null {
  if (!request.prompt.trim()) return 'Add a prompt before generating.'
  if (!facts.connected) return 'Start ComfyUI and verify the server connection in Settings.'
  const selection = resolveZImageSelection(facts.info)
  if (!selection.model || !selection.encoder || !selection.vae) {
    return 'Z-Image model components are missing — install the Z-Image Turbo diffusion model, its Qwen encoder, and the VAE, then refresh the engine.'
  }
  if (request.surface === 'control') {
    if (!zImageControlNodesReady(facts.info, request.controlMode)) {
      return `The ${CONTROL_PREPROCESSORS[request.controlMode].label} control path needs the Fun ControlNet Union nodes (${CONTROL_PREPROCESSORS[request.controlMode].node}) — install them, then refresh the engine.`
    }
    if (!selection.controlnet) return 'Install Z-Image-Turbo-Fun-Controlnet-Union.safetensors into models/model_patch, then refresh the engine.'
    if (!request.controlImage) return 'Choose a control image for the structure-guided still.'
  }
  return null
}

/** The engine-free graph plan (construction is pure — the tests and the
 *  canvas probe read this). Uploads are stubbed by NAME exactly like the H3
 *  plan: loader nodes appear when the mode's upload slots are occupied. */
export function planZImageGraph(request: ZImageRequest, selection: ZImageSelection, uploads: { controlImage?: string } = {}) {
  if (request.surface === 'control') {
    return buildZImageControlnet({
      prompt: request.prompt,
      seed: request.seed,
      controlImageName: uploads.controlImage ?? 'plan-control.png',
      mode: request.controlMode,
      filenamePrefix: request.filenamePrefix ?? 'MiniMax_first_frames/ZImageControl',
    }, selection)
  }
  return buildZImage(request.prompt, request.width, request.height, request.seed, selection.model, selection.encoder, selection.vae, 8, 1, 'turbo' satisfies ZImageVariant)
}

/**
 * Validates, uploads (control image only — the plain path is text→still),
 * builds, and submits one Z-Image still through the shared queue. The job
 * carries provider 'zimage' + mediaType 'image', so the queue's poll loop
 * completes it and the canvas's landing path appends the take (kind image).
 */
export async function submitZImage(
  request: ZImageRequest,
  facts: ZImageFacts,
  io: ZImageIo,
): Promise<{ ok: true; jobId: string } | { ok: false; message: string }> {
  const refusal = validateZImage(request, facts)
  if (refusal) {
    io.notify('error', refusal)
    return { ok: false, message: refusal }
  }
  const { settings } = facts
  const selection = resolveZImageSelection(facts.info)
  const localId = createId()
  const job: GenerationJob = {
    id: localId, provider: 'zimage', mode: 'text', mediaType: 'image', prompt: request.prompt,
    createdAt: Date.now(), status: 'queued', progress: 2, progressLabel: 'Preparing the Z-Image graph',
    width: request.width, height: request.height, duration: 0,
  }
  io.setJobs((current) => [job, ...current])
  io.onJobCreated?.(localId)
  try {
    let controlUploadName: string | undefined
    if (request.surface === 'control' && request.controlImage) {
      const uploaded = await window.minimax.uploadInput(settings.comfyUrl, request.controlImage.path)
      controlUploadName = uploaded.subfolder ? `${uploaded.subfolder.replace(/\\/g, '/')}/${uploaded.name}` : uploaded.name
    }
    const graph = planZImageGraph(request, selection, controlUploadName ? { controlImage: controlUploadName } : {})
    const response = await window.minimax.submitPrompt(settings.comfyUrl, graph)
    io.setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'running', progress: 4, progressLabel: 'Rendering the still in ComfyUI', ...(request.manifestExtra ? { manifest: request.manifestExtra } : {}) } : item))
    io.notify('success', 'Z-Image still added to the local ComfyUI queue.')
    return { ok: true, jobId: localId }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    io.setJobs((current) => current.map((item) => item.id === localId ? { ...item, status: 'failed', error: message } : item))
    io.notify('error', message)
    return { ok: false, message }
  }
}
