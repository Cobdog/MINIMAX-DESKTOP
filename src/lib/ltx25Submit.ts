/** The shared LTX-2.5 general submission core (canvas Phase 4, task 6rymbx3).
 *
 * Extracted verbatim from useGenerationFlows.generateLtx so BOTH surfaces
 * submit through one code path (spec §8 D1/D2 — the same discipline as
 * lib/h3Submit.ts Phase 2 and lib/ltx23UtilitySubmit.ts Phase 3): the hook
 * keeps its facades, the canvas's typed-hole produce row submits through
 * this core. The general Ltx25Workspace greyed out in Phase 4 (the
 * keep-utilities-only verdict); this path is what survives as the engine-op.
 */
import { createId } from './createId'
import { buildLtx25Workflow } from './ltx25Workflow'
import { prepareImage } from './imageCrop'
import type { ObjectInfo } from './comfyInfo'
import type { AppSettings, GenerationJob, Ltx25GenerationOptions, MediaFile } from '../types'

/** The node classes the native LTX-2.5 graph family needs (the same list the
 *  old workspace gates on — the graph-family contract per consumer). */
export const LTX25_NATIVE_REQUIRED_NODES = [
  'LTXVConditioning', 'LTXVEmptyLatentAudio', 'EmptyLTXVLatentVideo',
  'LTXVDualCFGGuider', 'LTXVSeparateAVLatent', 'LTXVConcatAVLatent',
  'LTXVLatentUpsampler', 'LTXVAudioVAEDecode', 'ManualSigmas',
  'VAEDecodeTiled', 'CLIPTextEncode', 'KSamplerSelect', 'SamplerCustomAdvanced',
] as const

export type Ltx25Selection = {
  diffusion: string
  textEncoder: string
  videoVae: string
  audioVae: string
  latentUpscaler: string
}

export type Ltx25SubmitFacts = {
  settings: AppSettings
  connected: boolean
  info: ObjectInfo
  selection: Ltx25Selection
  clientId?: string
}

export type Ltx25SubmitIo = {
  notify(tone: 'error' | 'success' | 'neutral', text: string): void
  setJobs(update: (current: GenerationJob[]) => GenerationJob[]): void
  cancellationRequests?: { current: Set<string> }
  onJobCreated?(jobId: string): void
  /** The old surface tracks its active job in the workspace store. */
  onSubmitted?(jobId: string): void
}

/** The availability ladder: prompt → connection → models → nodes → input.
 *  Returns the refusal message, or null when the run may proceed. Pure. */
export function validateLtx25(ltxOptions: Ltx25GenerationOptions, input: MediaFile | null, facts: Pick<Ltx25SubmitFacts, 'connected' | 'info' | 'selection'>): string | null {
  if (!ltxOptions.prompt) return 'Add an LTX prompt before generating.'
  if (!facts.connected) return 'Start ComfyUI and verify the server connection in Settings.'
  if (ltxOptions.mode === 'image' && !input) return 'Choose a first frame for LTX image-to-video.'
  if (!facts.selection.diffusion || !facts.selection.textEncoder || !facts.selection.videoVae || !facts.selection.audioVae || !facts.selection.latentUpscaler) {
    return 'The LTX‑2.5 distilled transformer, Gemma encoder, video/audio VAEs, or latent spatial upscaler is missing.'
  }
  const missingNodes = LTX25_NATIVE_REQUIRED_NODES.filter((node) => !facts.info[node])
  if (missingNodes.length) return `Update ComfyUI before using LTX‑2.5. Missing core nodes: ${missingNodes.join(', ')}.`
  return null
}

/** Validates, uploads, builds, and submits one LTX-2.5 general run through
 *  the shared queue bookkeeping. Never parks a job when validation refuses. */
export async function submitLtx25(
  ltxOptions: Ltx25GenerationOptions,
  input: MediaFile | null,
  facts: Ltx25SubmitFacts,
  io: Ltx25SubmitIo,
  handoff?: { characterProjectId?: string; locationProjectId?: string; manifestExtra?: Record<string, unknown> },
): Promise<{ ok: true; jobId: string } | { ok: false; message: string }> {
  const refusal = validateLtx25(ltxOptions, input, facts)
  if (refusal) {
    io.notify('error', refusal)
    return { ok: false, message: refusal }
  }
  const { settings } = facts
  const localId = createId()
  const job: GenerationJob = {
    id: localId, provider: 'ltx25', mode: ltxOptions.mode, prompt: ltxOptions.prompt,
    createdAt: Date.now(), status: 'queued', progress: 2, progressLabel: input ? 'Preparing first frame' : 'Preparing workflow',
    width: ltxOptions.width, height: ltxOptions.height, duration: ltxOptions.duration,
    characterProjectId: handoff?.characterProjectId, locationProjectId: handoff?.locationProjectId,
  }
  io.setJobs((current) => [job, ...current])
  io.onJobCreated?.(localId)
  io.notify('neutral', 'Preparing the official LTX-2.5 ComfyUI graph…')
  try {
    const uploaded = input ? await window.minimax.uploadImageData(settings.comfyUrl, await prepareImage(input, ltxOptions.width, ltxOptions.height)) : undefined
    if (io.cancellationRequests?.current.has(localId)) throw new Error('Generation cancelled before submission.')
    const graph = buildLtx25Workflow(ltxOptions, facts.selection, uploaded)
    const response = await window.minimax.submitPrompt(settings.comfyUrl, graph, facts.clientId)
    if (io.cancellationRequests?.current.has(localId)) {
      await window.minimax.cancelPrompt(settings.comfyUrl, response.prompt_id)
      io.setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'cancelled' } : item))
      io.notify('success', 'The LTX 2.5 survey was cancelled before it started.')
      return { ok: false, message: 'The LTX 2.5 survey was cancelled before it started.' }
    }
    io.setJobs((current) => current.map((item) => item.id === localId
      ? { ...item, promptId: response.prompt_id, status: 'running', progress: 4, progressLabel: 'Waiting for ComfyUI to start', ...(handoff?.manifestExtra ? { manifest: handoff.manifestExtra } : {}) }
      : item))
    io.onSubmitted?.(localId)
    io.notify('success', `${ltxOptions.preset === 'quality' ? 'Two-stage quality' : 'Single-stage Turbo'} LTX‑2.5 generation added to ComfyUI.`)
    return { ok: true, jobId: localId }
  } catch (error) {
    const cancelled = io.cancellationRequests?.current.has(localId) ?? false
    const message = cancelled ? 'LTX generation cancelled.' : error instanceof Error ? error.message : String(error)
    io.setJobs((current) => current.map((item) => item.id === localId ? { ...item, status: cancelled ? 'cancelled' : 'failed', error: cancelled ? undefined : message } : item))
    io.notify(cancelled ? 'success' : 'error', message)
    return { ok: false, message }
  } finally {
    io.cancellationRequests?.current.delete(localId)
  }
}
