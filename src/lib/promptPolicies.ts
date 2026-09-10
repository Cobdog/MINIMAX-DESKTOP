/** Prompt composition policies for the MiniMax Create workspace: how library
 *  bindings, clothing rules, dialogue/movement safeguards, and reference
 *  ordering combine into the final string sent to ComfyUI. */
import type { GenerationMode, MediaFile, MovieReferenceBinding } from '../types'
import { composeReferenceInstructions } from './promptComposer'
import { applyDialoguePolicy, applyNaturalMovementPolicy } from './dialogPolicy'

export type ClothingPolicy = 'wardrobe' | 'underwear' | 'unrestricted'

export function composeH3Prompt(input: {
  prompt: string
  mode: GenerationMode
  bindings: MovieReferenceBinding[]
  clothingPolicy: ClothingPolicy
  noDialogue: boolean
  naturalMovement: boolean
}) {
  const activeBindings = input.clothingPolicy === 'wardrobe' ? input.bindings : input.bindings.filter((binding) => binding.purpose !== 'wardrobe')
  const referenceDirection = composeReferenceInstructions(activeBindings).join(' ')
  const missingReferenceDirection = referenceDirection && !input.prompt.includes(referenceDirection) ? referenceDirection : ''
  const policyDirection = input.clothingPolicy === 'wardrobe'
    ? missingReferenceDirection
    : input.clothingPolicy === 'underwear'
      ? `${missingReferenceDirection} Clothing intent: keep only the underwear shown in each named adult character's own identity reference; do not add outer garments and ignore supplied wardrobe outfits.`
      : `${missingReferenceDirection} Clothing intent: adult fictional characters only; follow the scene prompt's explicit clothing or nudity direction. Clothing visible in identity references is not mandatory and must not override the scene prompt.`
  const composed = [input.prompt.trim(), input.mode === 'reference' && input.bindings.length ? policyDirection.trim() : ''].filter(Boolean).join(' ')
  return applyNaturalMovementPolicy(applyDialoguePolicy(composed, input.noDialogue), input.naturalMovement)
}

export function syncReferencePrompt(value: string, previous: MovieReferenceBinding[], next: MovieReferenceBinding[]) {
  let result = value
    // The automatic reference direction is one generated line. Remove it as a
    // unit so changed wardrobe/hair assignments cannot leave a stale block.
    .replace(/^References:[^\r\n]*(?:\r?\n\r?\n|$)/m, '')
    .replace(/Character:\s*([^—\n]+?)\s*—\s*(?=<Picture \d+>)[^\n]*?from another character\./g, (_match, name: string) => `Character: ${name.trim()}.`)
    .replace(/Location:\s*preserve the approved ([^;\n]+?) environment from [^;\n]+;\s*keep its architecture, layout, materials, lighting, landmarks, and geography consistent\./gi, (_match, name: string) => `Location: ${name.trim()}.`)
  const previousInstructions = composeReferenceInstructions(previous)
  const previousCharacters = [...new Set(previous.filter((binding) => binding.characterId).map((binding) => binding.label.replace(/^Character:\s*/, '').replace(/^Wardrobe:\s*/, '').split(' / ')[0].split(' for ').at(-1)!))]
  for (const name of previousCharacters) {
    const instructions = previousInstructions.filter((line) => line.includes(name)).join(' ')
    result = result.replace(`Character: ${name} — ${instructions}`, `Character: ${name}`)
  }
  for (const line of previousInstructions) result = result.replace(line, '')
  result = result.replace(/References:\s*(?=\n|$)/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  const nextInstructions = composeReferenceInstructions(next).join(' ')
  return [result, nextInstructions ? `References: ${nextInstructions}` : ''].filter(Boolean).join('\n\n')
}

/** Orders standalone and library-assigned images for render: assigned bindings
 *  first (in allocation order), then standalone files, capped at 9. */
export function resolveRenderReferenceImages(files: MediaFile[], bindings: MovieReferenceBinding[], clothingPolicy: ClothingPolicy) {
  if (!bindings.length) return files
  const activeBindings = clothingPolicy === 'wardrobe' ? bindings : bindings.filter((binding) => binding.purpose !== 'wardrobe')
  const libraryPaths = new Set(bindings.map((binding) => binding.file.path))
  const assigned = activeBindings.map((binding) => files.find((file) => file.path === binding.file.path) ?? binding.file)
  const standalone = files.filter((file) => !libraryPaths.has(file.path))
  return [...assigned, ...standalone].slice(0, 9)
}
