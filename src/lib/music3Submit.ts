/** The shared MiniMax Music 3 submission core (canvas Phase 4, task 6rymbx3).
 *
 * Extracted verbatim from useGenerationFlows.generateMusic3 so BOTH surfaces
 * submit through one code path (spec §8 D1/D2 — the h3Submit discipline).
 * Music 3 arrives as a canvas engine-op (the audio dock); the old Music 3
 * workspace keeps its facades over this core.
 */
import { createId } from './createId'
import { buildMusic3Workflow, type Music3GenerationOptions, type Music3ModelSelection } from './music3Workflow'
import type { ObjectInfo } from './comfyInfo'
import type { AppSettings, GenerationJob } from '../types'

export type Music3Selection = Music3ModelSelection

export type Music3SubmitFacts = {
  settings: AppSettings
  connected: boolean
  info: ObjectInfo
  selection: Music3Selection
  clientId?: string
}

export type Music3SubmitIo = {
  notify(tone: 'error' | 'success' | 'neutral', text: string): void
  setJobs(update: (current: GenerationJob[]) => GenerationJob[]): void
  cancellationRequests?: { current: Set<string> }
  onJobCreated?(jobId: string): void
}

/** The availability ladder (same order + messages as the pre-extraction
 *  hook): connection → caption → models. Node availability is surfaced by the
 *  callers' pipeline gating, not the submit ladder. Pure. */
export function validateMusic3(options: Music3GenerationOptions, facts: Pick<Music3SubmitFacts, 'connected' | 'selection'>): string | null {
  if (!facts.connected) return 'Start ComfyUI and verify the server connection in Settings.'
  if (!options.caption.trim()) return 'Write at least one caption section before generating.'
  if (!facts.selection.diffusion || !facts.selection.textEncoder || !facts.selection.vae) return 'The Music 3 diffusion model, text encoder, and DAV VAE are required. Install them, then rescan in Settings.'
  return null
}

/** Validates, builds, and submits one Music 3 song through the shared queue
 *  bookkeeping. Never parks a job when validation refuses. */
export async function submitMusic3(
  options: Music3GenerationOptions,
  facts: Music3SubmitFacts,
  io: Music3SubmitIo,
): Promise<{ ok: true; jobId: string } | { ok: false; message: string }> {
  const refusal = validateMusic3(options, facts)
  if (refusal) {
    io.notify('error', refusal)
    return { ok: false, message: refusal }
  }
  const { settings } = facts
  const localId = createId()
  const job: GenerationJob = {
    id: localId, provider: 'music3', mediaType: 'audio', mode: 'text', prompt: options.caption,
    createdAt: Date.now(), status: 'queued', progress: 2, progressLabel: 'Preparing Music 3 workflow',
    width: 0, height: 0, duration: options.duration,
  }
  io.setJobs((current) => [job, ...current])
  io.onJobCreated?.(localId)
  io.notify('neutral', 'Preparing the official MiniMax Music 3 ComfyUI graph…')
  try {
    const graph = buildMusic3Workflow(options, facts.selection)
    const response = await window.minimax.submitPrompt(settings.comfyUrl, graph, facts.clientId)
    if (io.cancellationRequests?.current.has(localId)) {
      await window.minimax.cancelPrompt(settings.comfyUrl, response.prompt_id)
      io.setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'cancelled' } : item))
      io.notify('success', 'Music generation cancelled.')
      return { ok: false, message: 'Music generation cancelled.' }
    }
    io.setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'running', progress: 4, progressLabel: 'Composing locally' } : item))
    io.notify('success', 'MiniMax Music 3 song generation added to ComfyUI.')
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
