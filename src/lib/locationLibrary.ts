import type { LocationProject, MediaFile } from '../types'

const KEY = 'minimax.location-projects'
export const LOCATION_LIBRARY_EVENT = 'minimax-location-library-changed'

export function newLocationProject(index = 1): LocationProject {
  const now = Date.now()
  return { id: crypto.randomUUID(), name: `Location ${index}`, description: '', atmosphere: '', timeOfDay: '', visualStyle: 'cinematic photorealism', referencePrompt: '', createdAt: now, updatedAt: now, referenceMode: 'set', referenceImages: [] }
}

export function loadLocationProjects(): LocationProject[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Partial<LocationProject>[]
    return raw.filter((item) => item.id).map((item, index) => ({ ...newLocationProject(index + 1), ...item, referenceMode: item.referenceMode === 'single' ? 'single' : 'set', referenceImages: item.referenceImages ?? [] }))
  } catch { return [] }
}

export function saveLocationProjects(projects: LocationProject[]) {
  localStorage.setItem(KEY, JSON.stringify(projects))
  window.dispatchEvent(new CustomEvent(LOCATION_LIBRARY_EVENT))
}

export function updateLocationProject(id: string, change: Partial<LocationProject>) {
  saveLocationProjects(loadLocationProjects().map((project) => project.id === id ? { ...project, ...change, updatedAt: Date.now() } : project))
}

export function locationReferences(project: LocationProject): MediaFile[] {
  if (project.referenceMode === 'single') return project.baseImage ? [project.baseImage] : []
  if (!project.referenceImages.length) return project.baseImage ? [project.baseImage] : []
  return project.selectedReferencePaths === undefined ? project.referenceImages : project.referenceImages.filter((file) => project.selectedReferencePaths?.includes(file.path))
}
