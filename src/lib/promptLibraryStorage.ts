/** The local reusable prompt library: entries saved from the community
 *  harvester plus a bundled starter corpus of prompting techniques distilled
 *  from fal's MiniMax H3 prompting guide (techniques paraphrased and
 *  self-authored; the guide itself is linked from the browser UI). */
import { persistToLocalStorage } from './libraryStorage'

export type SavedPromptEntry = {
  id: string
  label: string
  prompt: string
  negativePrompt?: string
  seed?: number
  sampler?: string
  steps?: number
  cfgScale?: number
  source?: { kind: 'civitai'; itemId: string; username?: string }
  technique?: boolean
  savedAt: number
}

const STORAGE_KEY = 'minimax.prompt-library'
export const PROMPT_LIBRARY_EVENT = 'minimax:prompt-library-changed'

const technique = (id: string, label: string, prompt: string): SavedPromptEntry => ({
  id: `technique.${id}`, label, prompt, technique: true, savedAt: 0,
})

/** Starter corpus: the fal guide's techniques, rewritten as fill-in frames. */
const TECHNIQUE_CORPUS: SavedPromptEntry[] = [
  technique('timed-beats', 'Timed shot blocks', '[Shot 1] <style and opening composition>. From 0–2s <action beat>. From 2–4s <next beat>. From 4–5s <resolution beat>. Keep cut times strictly increasing and inside the duration; every beat must be visible or audible.'),
  technique('reference-jobs', 'Assign every reference a job', 'For each reference, state what it controls: <Picture 1> supplies <character identity>; <Picture 2> supplies <garment>; <Video 1> supplies <motion timing>; <Audio 1> supplies <voice timbre>. Nothing referenced goes unused, and nothing unreferenced is described vaguely.'),
  technique('identity-lock', 'Identity lock by enumeration', 'Preserve <name>’s exact <face shape, skin, hairline, proportions, distinguishing marks>. Never exchange faces, bodies, garments, or accessories between characters. Wardrobe changes only where explicitly directed.'),
  technique('inline-negatives', 'Inline negative statements', 'No soft dissolves; no garbled text or watermarks; no captions or logos; do not introduce objects, people, or camera moves not described here. State absences as explicit negative sentences inside the prompt.'),
  technique('edit-pairs', 'Edits as change + constraint', 'Describe each edit as one change plus one constraint: “Change only <X>; keep <Y> exactly as referenced.” One edit pair per sentence; never bundle multiple changes into one instruction.'),
  technique('physical-transitions', 'Transitions as physical events', 'Describe every transition as a physical camera or scene event (a passing column wipes the frame; the car enters a tunnel; rain covers the lens) with its timing — never as an editorial abstraction.'),
  technique('audio-specificity', 'Direct audio like picture', 'Give sound the same specificity as image: name the source, material, and distance for each layer (rain ticking on glass near camera; distant train rhythm under dialogue). Timed instrumentation for music; ambience spans the full clip.'),
  technique('room-to-write', 'Use the character budget', 'Prompts up to roughly 7,000 characters are accepted. Prefer complete concrete sentences over keyword fragments; spend the length on composition, continuity, and sound instead of quality-word lists.'),
]

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
