import type { AccessoryProject, MediaFile } from '../types'
import { createId } from './createId'
import { persistToLocalStorage } from './libraryStorage'

const KEY = 'minimax.accessory-projects'
const MIGRATION_KEY = 'minimax.accessories-migrated-from-wardrobe-v1'
export const ACCESSORY_LIBRARY_EVENT = 'minimax-accessory-library-changed'

export function newAccessoryProject(index = 1): AccessoryProject {
  const now = Date.now()
  return { id: createId(), name: `Accessory ${index}`, category: 'other', description: '', materials: '', colors: '', visualStyle: 'cinematic product photography', referencePrompt: '', createdAt: now, updatedAt: now }
}

export function loadAccessoryProjects(): AccessoryProject[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Partial<AccessoryProject>[]
    const projects = raw.filter((item) => item.id).map((item, index) => ({ ...newAccessoryProject(index + 1), ...item }))
    if (localStorage.getItem(MIGRATION_KEY)) return projects
    const wardrobes = JSON.parse(localStorage.getItem('minimax.wardrobe-projects') ?? '[]') as Array<{ accessories?: string[]; visualStyle?: string }>
    const migrated = wardrobes.flatMap((wardrobe) => (wardrobe.accessories ?? []).map((description) => ({ description, visualStyle: wardrobe.visualStyle }))).map(({ description, visualStyle }, index) => ({ ...newAccessoryProject(projects.length + index + 1), name: description.slice(0, 48) || `Accessory ${projects.length + index + 1}`, description, visualStyle: visualStyle || 'cinematic product photography' }))
    const next = [...projects, ...migrated]
    if (persistToLocalStorage(KEY, next)) localStorage.setItem(MIGRATION_KEY, '1')
    return next
  } catch { return [] }
}

export function saveAccessoryProjects(projects: AccessoryProject[]) {
  if (!persistToLocalStorage(KEY, projects)) return
  window.dispatchEvent(new CustomEvent(ACCESSORY_LIBRARY_EVENT))
}

export function accessoryReference(project: AccessoryProject): MediaFile[] {
  return project.referenceImage ? [project.referenceImage] : []
}
