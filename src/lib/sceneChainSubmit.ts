/** The shared latent scene-chain core (canvas Phase 5, task 7mcp11b).
 *
 * Extracted verbatim from useGenerationFlows.generateSceneChain so the canvas
 * Studios dock (MoviePlanner's host) runs the SAME Motion-Context chained
 * episode submission through one code path (the h3Submit discipline — the
 * hook died with the old shell). ComfyUI's own queue provides execution
 * order; every shot's graph saves its sampler latent and segment N continues
 * from N-1's tail with never-denoised conditioning.
 */
import { createId } from './createId'
import { buildMiniMaxWorkflow } from './workflow'
import { resolveMovieShot } from './promptComposer'
import { prepareImage } from './imageCrop'
import type { AppSettings, CharacterProject, GenerationJob, MediaFile, ModelSelection, MovieProject } from '../types'

export type SceneChainFacts = {
  settings: AppSettings
  connected: boolean
  modelReady: boolean
  selection: ModelSelection
  clientId?: string
}

export type SceneChainIo = {
  notify(tone: 'error' | 'success' | 'neutral', text: string): void
  setJobs(update: (current: GenerationJob[]) => GenerationJob[]): void
}

/** Renders a Movie Planner scene as one latent-chained episode. Returns the
 *  refusal message, or null when every segment queued. */
export async function submitSceneChain(
  project: MovieProject,
  scene: MovieProject['scenes'][number],
  library: CharacterProject[],
  motionContextReady: boolean,
  facts: SceneChainFacts,
  io: SceneChainIo,
): Promise<string | null> {
  if (!facts.connected) return 'Start ComfyUI and verify the server connection in Settings.'
  if (!facts.modelReady) return 'One or more required MiniMax H3 model components are missing.'
  if (!motionContextReady) return 'Install the ComfyUI-H3-Motion-Context custom nodes first, then refresh the engine.'
  const shots = scene.shots.filter((shot) => shot.prompt.trim())
  if (shots.length < 2) return 'A chain needs at least two shots with prompts.'
  const chainId = createId()
  const folder = `h3_context/${chainId}/clip`
  const [width, height] = project.aspectRatio === '9:16' ? [768, 1344] : project.aspectRatio === '1:1' ? [768, 768] : [1344, 768]
  const defaults = facts.settings.generationDefaults
  const chainJobs: GenerationJob[] = []
  for (const [index, shot] of shots.entries()) {
    const resolved = resolveMovieShot(project, scene, shot, library)
    if (resolved.references.length > 9) return `Shot ${index + 1} (${shot.title}) has ${resolved.references.length} references — chains are limited to 9 per segment.`
    const job: GenerationJob = {
      id: createId(), provider: 'minimax', mode: resolved.effectiveMode, prompt: resolved.compiledPrompt,
      createdAt: Date.now() + index, status: 'queued', progress: 2,
      progressLabel: `Chain ${index + 1}/${shots.length} · ${shot.title}`,
      width, height, duration: shot.duration,
      movieLink: { projectId: project.id, sceneId: scene.id, shotId: shot.id },
    }
    chainJobs.push(job)
  }
  io.setJobs((current) => [...chainJobs, ...current])
  io.notify('neutral', `Rendering ${shots.length}-shot continuous chain for “${scene.title}”…`)
  let queuedCount = 0
  for (const [index, shot] of shots.entries()) {
    const resolved = resolveMovieShot(project, scene, shot, library)
    const upload = async (file: MediaFile) => file.kind === 'image' && Boolean(file.crop)
      ? window.minimax.uploadImageData(facts.settings.comfyUrl, await prepareImage(file, width, height))
      : window.minimax.uploadInput(facts.settings.comfyUrl, file.path)
    try {
      const images = await Promise.all(resolved.effectiveMode === 'reference' ? resolved.references.map((binding) => upload(binding.file)) : [])
      const videos = await Promise.all(resolved.effectiveMode === 'reference' ? (shot.referenceVideos ?? []).map((file) => upload(file)) : [])
      const audios = await Promise.all(resolved.effectiveMode === 'reference' ? (shot.referenceAudios ?? []).map((file) => upload(file)) : [])
      const graph = buildMiniMaxWorkflow({
        mode: resolved.effectiveMode, prompt: resolved.compiledPrompt, width, height, duration: shot.duration,
        seed: Math.floor(Math.random() * 1_000_000_000), steps: defaults.steps, turbo: defaults.turbo,
        experimentalSampling: defaults.experimentalSampling, loraStrength: defaults.loraStrength,
        sampler: defaults.sampler, scheduler: defaults.scheduler, refImageSize: defaults.refImageSize,
        filenamePrefix: `video/Chain_${chainId}_${String(index + 1).padStart(2, '0')}`,
        referenceImages: resolved.effectiveMode === 'reference' ? resolved.references.map((binding) => binding.file.path) : [],
        referenceVideos: resolved.effectiveMode === 'reference' ? (shot.referenceVideos ?? []).map((file) => file.path) : [],
        referenceAudios: resolved.effectiveMode === 'reference' ? (shot.referenceAudios ?? []).map((file) => file.path) : [],
        chain: { index, folder },
      }, facts.selection, { images, videos, audios })
      const response = await window.minimax.submitPrompt(facts.settings.comfyUrl, graph, facts.clientId)
      queuedCount += 1
      io.setJobs((current) => current.map((item) => item.id === chainJobs[index].id ? { ...item, promptId: response.prompt_id, status: 'running', progress: 4 } : item))
    } catch (error) {
      io.setJobs((current) => current.map((item) => item.id === chainJobs[index].id ? { ...item, status: 'failed', error: error instanceof Error ? error.message : String(error) } : item))
    }
  }
  const message = queuedCount === shots.length
    ? `${shots.length}-shot chain queued — segments render in order with continuous latent motion and audio.`
    : `Only ${queuedCount} of ${shots.length} chain segments could be queued. Check the failed jobs in the queue index.`
  io.notify(queuedCount === shots.length ? 'success' : 'error', message)
  return queuedCount === shots.length ? null : message
}
