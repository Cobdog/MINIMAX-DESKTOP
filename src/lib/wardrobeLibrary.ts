import type { MediaFile, WardrobeProject } from '../types'
import { createId } from './createId'
import { persistToLocalStorage } from './libraryStorage'

const KEY = 'minimax.wardrobe-projects'
export const WARDROBE_LIBRARY_EVENT = 'minimax-wardrobe-library-changed'

export function newWardrobeProject(index = 1): WardrobeProject {
  const now = Date.now()
  return { id: createId(), name: `Wardrobe ${index}`, description: '', accessories: [], materials: '', colors: '', visualStyle: 'cinematic photorealism', referencePrompt: '', referenceImages: [], createdAt: now, updatedAt: now }
}

export function loadWardrobeProjects(): WardrobeProject[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Partial<WardrobeProject>[]
    return raw.filter((item) => item.id).map((item, index) => ({ ...newWardrobeProject(index + 1), ...item, accessories: item.accessories ?? [], referenceImages: item.referenceImages ?? [] }))
  } catch { return [] }
}

export function saveWardrobeProjects(projects: WardrobeProject[]) {
  if (!persistToLocalStorage(KEY, projects)) return
  window.dispatchEvent(new CustomEvent(WARDROBE_LIBRARY_EVENT))
}

export function wardrobeReferences(project: WardrobeProject): MediaFile[] {
  return project.selectedReferencePaths === undefined ? project.referenceImages : project.referenceImages.filter((file) => project.selectedReferencePaths?.includes(file.path))
}
