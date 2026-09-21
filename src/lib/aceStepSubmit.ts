/** The shared ACE-Step submission core (canvas Phase 4, task 6rymbx3).
 *
 * Extracted verbatim from useGenerationFlows.generateAceStep so BOTH surfaces
 * submit through one code path (spec §8 D1/D2 — the h3Submit discipline).
 * ACE-Step arrives as a canvas engine-op (the audio dock); the old workspace
 * keeps its facades over this core.
 */
import { createId } from './createId'
import { ACE_STEP_REQUIRED_NODES, buildAceStepWorkflow } from './aceStepWorkflow'
import { preflightOrFail } from './preflight'
import { dbg } from './dbg'
import type { ObjectInfo } from './comfyInfo'
import type { AppSettings, AceStepGenerationOptions, AceStepModelSelection, GenerationJob } from '../types'

export type AceStepSelection = AceStepModelSelection

export type AceStepSubmitFacts = {
  settings: AppSettings
  connected: boolean
  info: ObjectInfo
  selection: AceStepSelection
  clientId?: string
}

export type AceStepSubmitIo = {
  notify(tone: 'error' | 'success' | 'neutral', text: string): void
  setJobs(update: (current: GenerationJob[]) => GenerationJob[]): void
  cancellationRequests?: { current: Set<string> }
  onJobCreated?(jobId: string): void
}

/** The availability ladder (same order + messages as the pre-extraction
 *  hook): connection → models → nodes. Pure. */
export function validateAceStep(options: AceStepGenerationOptions, facts: Pick<AceStepSubmitFacts, 'connected' | 'info' | 'selection'>): string | null {
  if (!facts.connected) return 'Start ComfyUI and verify the server connection in Settings.'
  const selectedModel = options.model === 'sft' ? facts.selection.sft : facts.selection.base
  if (!selectedModel || !facts.selection.vae || !facts.selection.textEncoderSmall || !facts.selection.textEncoderLarge) {
    return `The ACE-Step ${options.model.toUpperCase()} model, audio VAE, and both Qwen ACE text encoders are required.`
  }
  const missingNodes = ACE_STEP_REQUIRED_NODES.filter((node) => !facts.info[node])
  if (missingNodes.length) return `Update ComfyUI before using ACE-Step 1.5. Missing core nodes: ${missingNodes.join(', ')}.`
  return null
}

/** Validates, builds, and submits one ACE-Step track through the shared
 *  queue bookkeeping. Never parks a job when validation refuses. The
 *  optional manifestExtra rides the job from CREATION (queued): the canvas
 *  link must be on the persisted record before the first debounced save, or
 *  a reload mid-render orphans the landing (M1). */
export async function submitAceStep(
  options: AceStepGenerationOptions,
  facts: AceStepSubmitFacts,
  io: AceStepSubmitIo,
  manifestExtra?: Record<string, unknown>,
): Promise<{ ok: true; jobId: string } | { ok: false; message: string }> {
  const refusal = validateAceStep(options, facts)
  if (refusal) {
    io.notify('error', refusal)
    return { ok: false, message: refusal }
  }
  const { settings } = facts
  const localId = createId()
  const job: GenerationJob = {
    id: localId, provider: 'acestep', mediaType: 'audio', mode: 'text', prompt: options.tags,
    createdAt: Date.now(), status: 'queued', progress: 2, progressLabel: 'Preparing ACE-Step workflow',
    width: 0, height: 0, duration: options.duration,
    ...(manifestExtra ? { manifest: manifestExtra } : {}),
  }
  io.setJobs((current) => [job, ...current])
  io.onJobCreated?.(localId)
  io.notify('neutral', `Preparing the official ACE-Step XL ${options.model.toUpperCase()} ComfyUI graph…`)
  try {
    const graph = buildAceStepWorkflow(options, facts.selection)
    // R-02 preflight (Wave 1): same seam as H3 video.
    const preflight = preflightOrFail(graph, facts.info, 'preflight.acestep')
    if (preflight) throw new Error(preflight)
    const response = await window.minimax.submitPrompt(settings.comfyUrl, graph, facts.clientId)
    if (io.cancellationRequests?.current.has(localId)) {
      await window.minimax.cancelPrompt(settings.comfyUrl, response.prompt_id)
      io.setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'cancelled' } : item))
      io.notify('success', 'Music generation cancelled.')
      return { ok: false, message: 'Music generation cancelled.' }
    }
    io.setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'running', progress: 4, progressLabel: 'Waiting for ComfyUI to start' } : item))
    io.notify('success', `ACE-Step XL ${options.model.toUpperCase()} music generation added to ComfyUI.`)
    dbg('submit', { verdict: 'submitted', family: 'acestep', jobId: localId, promptId: response.prompt_id })
    return { ok: true, jobId: localId }
  } catch (error) {
    const cancelled = io.cancellationRequests?.current.has(localId) ?? false
    const message = cancelled ? 'Music generation cancelled.' : error instanceof Error ? error.message : String(error)
    io.setJobs((current) => current.map((item) => item.id === localId ? { ...item, status: cancelled ? 'cancelled' : 'failed', error: cancelled ? undefined : message } : item))
    io.notify(cancelled ? 'success' : 'error', cancelled ? 'Music generation cancelled.' : message)
    return { ok: false, message }
  } finally {
    io.cancellationRequests?.current.delete(localId)
  }
}
