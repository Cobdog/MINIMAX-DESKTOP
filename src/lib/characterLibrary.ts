import type { CharacterProject, MediaFile } from '../types'

const KEY = 'minimax.character-projects'
export const CHARACTER_LIBRARY_EVENT = 'minimax-character-library-changed'

export function newCharacterProject(index = 1): CharacterProject {
  const now = Date.now()
  return { id: crypto.randomUUID(), name: `Character ${index}`, description: '', wardrobe: '', voiceNotes: '', visualStyle: 'cinematic photorealism', referencePrompt: '', createdAt: now, updatedAt: now, referenceMode: 'set', referenceImages: [] }
}

export function loadCharacterProjects(): CharacterProject[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Partial<CharacterProject>[]
    return raw.filter((item) => item.id).map((item, index) => ({ ...newCharacterProject(index + 1), ...item, referenceMode: item.referenceMode === 'single' ? 'single' : 'set', referenceImages: item.referenceImages ?? [] }))
  } catch { return [] }
}

export function saveCharacterProjects(projects: CharacterProject[]) {
  localStorage.setItem(KEY, JSON.stringify(projects))
  window.dispatchEvent(new CustomEvent(CHARACTER_LIBRARY_EVENT))
}

export function updateCharacterProject(id: string, change: Partial<CharacterProject>) {
  const projects = loadCharacterProjects().map((project) => project.id === id ? { ...project, ...change, updatedAt: Date.now() } : project)
  saveCharacterProjects(projects)
}

export function characterReferences(project: CharacterProject): MediaFile[] {
  if (project.referenceMode === 'single') return project.baseImage ? [project.baseImage] : []
  if (!project.referenceImages.length) return project.baseImage ? [project.baseImage] : []
  return project.selectedReferencePaths === undefined
    ? project.referenceImages
    : project.referenceImages.filter((file) => project.selectedReferencePaths?.includes(file.path))
}
