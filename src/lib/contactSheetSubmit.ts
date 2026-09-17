/** The shared character contact-sheet core (canvas Phase 5, task 7mcp11b).
 *
 * Extracted verbatim from useGenerationFlows.generateCharacterSheet so the
 * canvas Studios dock and any future surface run the SAME five-view
 * ContactSheet submission through one code path (the h3Submit discipline —
 * the hook died with the old shell).
 *
 * Phase-4 cleanup applied at extraction (task 6rymbx3 inherited list): the
 * ContactSheet nodes + turnaround LoRA are now REQUIRED — when they are
 * absent the submission refuses honestly instead of falling back to the old
 * LTX identity-survey prompt (the transitional fallback died with the shell).
 */
import { createId } from './createId'
import { buildContactSheetWorkflow, inferContactSheetSelection } from './contactSheet'
import { prepareImage } from './imageCrop'
import type { AppSettings, GenerationJob, MediaFile, ModelFile, ModelSelection } from '../types'

export type ContactSheetFacts = {
  settings: AppSettings
  connected: boolean
  models: ModelFile[]
  /** The H3 base selection (ref2va / textEncoder / videoVae feed the sheet's own inference). */
  selection: ModelSelection
  clientId?: string
}

export type ContactSheetIo = {
  notify(tone: 'error' | 'success' | 'neutral', text: string): void
  setJobs(update: (current: GenerationJob[]) => GenerationJob[]): void
}

/** Renders the approved identity image as five coordinated views through the
 *  H3 DiT. Returns the refusal message, or null when the sheet went out. */
export async function submitCharacterContactSheet(
  project: { id: string; name: string; baseImage?: MediaFile },
  facts: ContactSheetFacts,
  io: ContactSheetIo,
): Promise<string | null> {
  if (!facts.connected) return 'Start ComfyUI and verify the server connection in Settings.'
  if (!project.baseImage) return 'Approve a character identity image first.'
  const selection3 = inferContactSheetSelection(facts.models, facts.selection.ref2va, facts.selection.textEncoder, facts.selection.videoVae)
  if (!selection3.turnaroundLora) return 'Install the ComfyUI-H3-ContactSheet nodes and the five-view turnaround LoRA (minimax_h3_five_view_*), then refresh the engine.'
  const localId = createId()
  const job: GenerationJob = {
    id: localId, provider: 'minimax', mediaType: 'image', mode: 'reference',
    prompt: `Five-view character sheet of ${project.name}`,
    createdAt: Date.now(), status: 'queued', progress: 2, progressLabel: 'Preparing contact sheet',
    width: 0, height: 0, duration: 0, characterProjectId: project.id,
  }
  io.setJobs((current) => [job, ...current])
  try {
    const base = { ...project.baseImage }
    delete base.preview
    const uploaded = await window.minimax.uploadImageData(facts.settings.comfyUrl, await prepareImage(project.baseImage, 1024, 1024))
    const graph = buildContactSheetWorkflow({
      prompt: 'the camera orbits the subject of <Picture 1> ninety degrees clockwise',
      size: 1024, steps: 28, seed: Math.floor(Math.random() * 1_000_000_000),
      referenceName: uploaded.name, filenamePrefix: `MiniMax_CharacterSheet_${project.id}`,
    }, selection3)
    const response = await window.minimax.submitPrompt(facts.settings.comfyUrl, graph, facts.clientId)
    io.setJobs((current) => current.map((item) => item.id === localId ? { ...item, promptId: response.prompt_id, status: 'running', progress: 4, progressLabel: 'Rendering five coordinated views' } : item))
    io.notify('success', `Contact sheet for ${project.name} queued — five coordinated views through the H3 model.`)
    return null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    io.setJobs((current) => current.map((item) => item.id === localId ? { ...item, status: 'failed', error: message } : item))
    io.notify('error', message)
    return message
  }
}
