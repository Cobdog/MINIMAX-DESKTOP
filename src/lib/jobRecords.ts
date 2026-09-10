/** Side effects and hydration for completed generations: crediting movie
 *  shots, updating character/location libraries, and loading persisted jobs. */
import type { AppSettings, GenerationJob, MovieProject } from '../types'
import { webMediaUrl } from './mediaUrls'
import { updateCharacterProject } from './characterLibrary'
import { updateLocationProject } from './locationLibrary'
import type { MovieLink } from './workspace'

/** All playable media flows through the web server's media routes; legacy
 *  Electron-era minimax-media:// URLs and raw /view links are translated. */
export function playableOutputUrl(value?: string) {
  return webMediaUrl(value)
}

export const initialJobs = (): GenerationJob[] => {
  try {
    const stored = JSON.parse(localStorage.getItem('minimax.jobs') ?? '[]') as GenerationJob[]
    return stored.map((job) => ({ ...job, outputUrl: playableOutputUrl(job.outputUrl) }))
  } catch {
    return []
  }
}

export function recordMovieOutput(link: MovieLink | undefined, outputUrl: string) {
  if (!link) return
  try {
    const projects = JSON.parse(localStorage.getItem('minimax.movie-projects') ?? '[]') as MovieProject[]
    const next = projects.map((project) => project.id !== link.projectId ? project : { ...project, updatedAt: Date.now(), scenes: project.scenes.map((scene) => scene.id !== link.sceneId ? scene : { ...scene, shots: scene.shots.map((shot) => shot.id !== link.shotId ? shot : { ...shot, outputUrl, renderedAt: Date.now(), stage: 'rendered' as const }) }) })
    localStorage.setItem('minimax.movie-projects', JSON.stringify(next))
  } catch { /* Keep the completed generation even if legacy movie data cannot be updated. */ }
}

export function recordCharacterTurntable(characterProjectId: string | undefined, outputUrl: string) {
  if (!characterProjectId) return
  updateCharacterProject(characterProjectId, { turntableVideo: { path: outputUrl, name: 'Generated character turntable', kind: 'video', preview: outputUrl } })
}

export function recordLocationWalkthrough(locationProjectId: string | undefined, outputUrl: string) {
  if (!locationProjectId) return
  updateLocationProject(locationProjectId, { walkthroughVideo: { path: outputUrl, name: 'Generated location walkthrough', kind: 'video', preview: outputUrl } })
}

/** Extracts a five-frame reference set from a rendered turntable/walkthrough
 *  and stores it on the project. Returns an error message or null. */
export async function extractAutomatedReferenceSet(kind: 'character' | 'location', projectId: string | undefined, source: string, duration: number, settings: AppSettings) {
  if (!projectId || !source) return null
  try {
    const positions = [0.05, .25, .5, .75, .95].map((ratio) => Math.max(0, Math.min(duration - .04, duration * ratio)))
    const references = await Promise.all(positions.map(async (position) => {
      const result = await window.minimax.extractVideoFrame(source, position, settings.outputDirectory, settings.ffmpegPath)
      return { ...result, kind: 'image' as const, preview: await window.minimax.mediaUrl(result.path) }
    }))
    if (kind === 'character') updateCharacterProject(projectId, { referenceMode: 'set', referenceImages: references, selectedReferencePaths: undefined })
    else updateLocationProject(projectId, { referenceMode: 'set', referenceImages: references, selectedReferencePaths: undefined })
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
