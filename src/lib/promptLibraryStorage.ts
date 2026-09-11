/** The local reusable prompt library: entries saved from the community
 *  harvester plus a bundled starter corpus of prompting techniques distilled
 *  from fal's MiniMax H3 prompting guide (techniques paraphrased and
 *  self-authored; the guide itself is linked from the browser UI).
 *
 *  Wave 1: the SERVER store (SQLite saved_prompts + FTS5) is the primary
 *  library; this localStorage layer remains the offline fallback and the
 *  migration source (see src/lib/serverStorage.ts). The originals are never
 *  deleted. */
import { persistToLocalStorage } from './libraryStorage'
import { TECHNIQUE_CORPUS, type SavedPromptEntry } from './promptCorpus'

export type { SavedPromptEntry } from './promptCorpus'

const STORAGE_KEY = 'minimax.prompt-library'
export const PROMPT_LIBRARY_EVENT = 'minimax:prompt-library-changed'

export function loadPromptLibrary(): SavedPromptEntry[] {
  let saved: SavedPromptEntry[] = []
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as SavedPromptEntry[]
    if (Array.isArray(stored)) saved = stored.filter((entry) => entry && typeof entry.prompt === 'string' && entry.prompt.length > 8)
  } catch { /* Fresh or unreadable library: fall back to the bundled corpus. */ }
  // Techniques always ship with the app and are re-merged (not user-editable).
  return [...TECHNIQUE_CORPUS, ...saved.filter((entry) => !entry.technique)]
}

export function savePromptEntry(entry: Omit<SavedPromptEntry, 'savedAt'>) {
  const current = loadPromptLibrary().filter((existing) => existing.id !== entry.id && !existing.technique)
  persistToLocalStorage(STORAGE_KEY, [...current, { ...entry, savedAt: Date.now() }])
  window.dispatchEvent(new CustomEvent(PROMPT_LIBRARY_EVENT))
}

export function deletePromptEntry(id: string) {
  persistToLocalStorage(STORAGE_KEY, loadPromptLibrary().filter((entry) => entry.id !== id && !entry.technique))
  window.dispatchEvent(new CustomEvent(PROMPT_LIBRARY_EVENT))
}
