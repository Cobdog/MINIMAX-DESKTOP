/** The shared H3 diagnostic-pair core (canvas Phase 4, task 6rymbx3).
 *
 * Extracted verbatim from useGenerationFlows.runH3Diagnostics so the docked
 * Settings panel (canvas) and the old shell run the SAME fixed-seed Native +
 * Turbo-8 pair through one code path (spec §8 D1/D2).
 */
import { createId } from './createId'
import { buildMiniMaxWorkflow } from './workflow'
import { diagnosticPrompt } from './h3Stack'
import { inferSelections } from './modelSelection'
import type { ObjectInfo } from './comfyInfo'
import type { AppSettings, GenerationJob, ModelFile, ModelSelection } from '../types'

export type H3DiagnosticsFacts = {
  settings: AppSettings
  connected: boolean
  models: ModelFile[]
  info: ObjectInfo
  clientId?: string
}

export type H3DiagnosticsIo = {
  notify(tone: 'error' | 'success' | 'neutral', text: string): void
  setJobs(update: (current: GenerationJob[]) => GenerationJob[]): void
}

/** Queues the fixed-seed diagnostic pair (Native + Turbo 8). Returns the
 *  refusal message, or null when the pair went out. */
export async function submitH3DiagnosticPair(facts: H3DiagnosticsFacts, io: H3DiagnosticsIo): Promise<string | null> {
  if (!facts.connected) {
    io.notify('error', 'Connect ComfyUI before running the H3 diagnostic.')
    return 'Connect ComfyUI before running the H3 diagnostic.'
  }
  const qualityModels = inferSelections(facts.models, 'off')
  const turboModels = inferSelections(facts.models, '8')
  if (![qualityModels.fl2va, qualityModels.textEncoder, qualityModels.videoVae, qualityModels.audioVae, turboModels.fl2vLora].every(Boolean)) {
    const message = 'The FL2VA base stack and official 8-step Turbo LoRA are required for the diagnostic.'
    io.notify('error', message)
    return message
  }
  const tests = [
    { name: 'Native quality', turbo: 'off' as const, selection: qualityModels, filenamePrefix: 'video/MiniMax_DIAGNOSTIC_NATIVE' },
    { name: 'Official Turbo 8', turbo: '8' as const, selection: turboModels, filenamePrefix: 'video/MiniMax_DIAGNOSTIC_TURBO8' },
  ]
  io.notify('neutral', 'Queuing the fixed-seed Native and Turbo 8 diagnostic pair…')
  let queuedCount = 0
  for (const [index, test] of tests.entries()) {
    const id = createId()
    const job: GenerationJob = { id, provider: 'minimax', mode: 'text', prompt: `[H3 diagnostic · ${test.name}] ${diagnosticPrompt}`, createdAt: Date.now() + index, status: 'queued', progress: 2, progressLabel: 'Preparing diagnostic workflow', width: 1344, height: 768, duration: 5 }
    io.setJobs((current) => [job, ...current])
    try {
      const graph = buildMiniMaxWorkflow({ mode: 'text', prompt: diagnosticPrompt, width: 1344, height: 768, duration: 5, seed: 12345, steps: 20, turbo: test.turbo, sampler: 'res_multistep', scheduler: 'simple', refImageSize: 'match', filenamePrefix: test.filenamePrefix, referenceImages: [], referenceVideos: [], referenceAudios: [] }, test.selection, { images: [], videos: [], audios: [] }, facts.info)
      const response = await window.minimax.submitPrompt(facts.settings.comfyUrl, graph, facts.clientId)
      queuedCount += 1
      io.setJobs((current) => current.map((item) => item.id === id ? { ...item, promptId: response.prompt_id, status: 'running', progress: 4, progressLabel: index === 0 ? 'Native test queued' : 'Turbo 8 test queued behind Native' } : item))
    } catch (error) {
      io.setJobs((current) => current.map((item) => item.id === id ? { ...item, status: 'failed', error: error instanceof Error ? error.message : String(error) } : item))
    }
  }
  const message = queuedCount === tests.length
    ? 'H3 diagnostic pair queued with identical prompt, seed, resolution, duration, and official sampling.'
    : queuedCount
      ? 'Only one diagnostic render could be queued. Check the failed Queue entry.'
      : 'The diagnostic renders could not be queued. Check ComfyUI and try again.'
  io.notify(queuedCount === tests.length ? 'success' : 'error', message)
  return queuedCount === tests.length ? null : message
}

/** Selection helper re-export for callers computing readiness the same way. */
export function diagnosticSelectionsReady(models: ModelFile[]): { quality: ModelSelection; turbo: ModelSelection; ready: boolean } {
  const quality = inferSelections(models, 'off')
  const turbo = inferSelections(models, '8')
  return { quality, turbo, ready: Boolean(quality.fl2va && quality.textEncoder && quality.videoVae && quality.audioVae && turbo.fl2vLora) }
}
