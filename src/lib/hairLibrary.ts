import type { HairStyleProject, MediaFile } from '../types'
import { createId } from './createId'
import { persistToLocalStorage } from './libraryStorage'

const KEY = 'minimax.hair-style-projects'
export const HAIR_LIBRARY_EVENT = 'minimax-hair-library-changed'

export function newHairStyleProject(index = 1): HairStyleProject {
  const now = Date.now()
  return { id: createId(), name: `Hair design ${index}`, description: '', texture: 'natural texture', length: 'medium length', color: '', hairline: 'natural hairline', finish: 'soft natural finish', visualStyle: 'high-end salon reference photography', referencePrompt: '', createdAt: now, updatedAt: now }
}

export function loadHairStyleProjects(): HairStyleProject[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Partial<HairStyleProject>[]
    return raw.filter((item) => item.id).map((item, index) => ({ ...newHairStyleProject(index + 1), ...item }))
  } catch { return [] }
}

export function saveHairStyleProjects(projects: HairStyleProject[]) {
  if (!persistToLocalStorage(KEY, projects)) return
  window.dispatchEvent(new CustomEvent(HAIR_LIBRARY_EVENT))
}

export function hairStyleReference(project: HairStyleProject): MediaFile[] {
  return project.referenceImage ? [project.referenceImage] : []
}
