import { characterReferences } from './characterLibrary'
import { fitWholeCharacter } from './imageCrop'
import { loadWardrobeProjects, wardrobeReferences } from './wardrobeLibrary'
import type { CharacterProject, GenerationMode, MediaFile, MovieProject, MovieReferenceBinding, MovieScene, MovieShot, ResolvedMovieShot } from '../types'

export type PromptAssistantTool = 'enhance' | 'timeline' | 'audio'

const uniqueBindings = (bindings: MovieReferenceBinding[]) => bindings.filter((binding, index) => bindings.findIndex((item) => item.file.path === binding.file.path) === index)
const sentenceKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9<>]+/g, ' ').trim()

export function resolveMovieShotReferences(project: MovieProject, scene: MovieScene, shot: MovieShot, library: CharacterProject[], continuityFrame?: MediaFile): MovieReferenceBinding[] {
  const bindings: MovieReferenceBinding[] = []
  const wardrobes = loadWardrobeProjects()
  for (const character of project.characters.filter((item) => shot.characterIds.includes(item.id))) {
    const source = character.libraryCharacterId ? library.find((item) => item.id === character.libraryCharacterId) : undefined
    const files = source ? characterReferences(source) : character.referenceImages
    files.forEach((file, index) => bindings.push({ file: fitWholeCharacter(file), purpose: index === 0 ? 'character' : 'character-angle', label: `Character: ${character.name} / ${index === 0 ? 'master' : `angle ${index + 1}`}`, characterId: character.id, source: source ? 'character-studio' : 'movie' }))
    source?.wardrobeIds.forEach((wardrobeId) => { const wardrobe = wardrobes.find((item) => item.id === wardrobeId); if (!wardrobe) return; wardrobeReferences(wardrobe).forEach((file) => bindings.push({ file: fitWholeCharacter(file), purpose: 'wardrobe', label: `Wardrobe: ${wardrobe.name} for ${character.name}`, characterId: character.id, wardrobeId: wardrobe.id, source: 'wardrobe-studio' })) })
  }
  const location = project.locations.find((item) => item.id === scene.locationId)
  location?.referenceImages.forEach((file) => bindings.push({ file, purpose: 'location', label: `Location: ${location.name}`, locationId: location.id, source: 'movie' }))
  shot.referenceImages?.forEach((file) => bindings.push({ file, purpose: 'generic', label: `Shot reference: ${file.name}`, source: 'shot' }))
  if (continuityFrame) bindings.push({ file: continuityFrame, purpose: 'continuity', label: 'Previous-shot continuity frame', source: 'continuity' })
  return uniqueBindings(bindings)
}

export function resolveMovieShotGenerationMode(shot: MovieShot, references: MovieReferenceBinding[]) {
  const preferredMode = shot.preferredMode ?? shot.mode
  const hasReferenceMedia = references.some((item) => item.purpose !== 'continuity') || Boolean(shot.referenceVideos?.length || shot.referenceAudios?.length)
  const continuationOnly = references.some((item) => item.purpose === 'continuity') && !hasReferenceMedia
  return { preferredMode, effectiveMode: (hasReferenceMedia || preferredMode === 'reference' ? 'reference' : continuationOnly ? 'image' : preferredMode) as GenerationMode }
}

export function composeReferenceInstructions(bindings: MovieReferenceBinding[]) {
  const numbered = bindings.map((binding, index) => ({ ...binding, number: index + 1 }))
  const groups = new Map<string, typeof numbered>()
  for (const binding of numbered.filter((item) => item.characterId && item.purpose !== 'wardrobe')) groups.set(binding.characterId!, [...(groups.get(binding.characterId!) ?? []), binding])
  const lines: string[] = []
  for (const group of groups.values()) {
    const name = group[0].label.replace(/^Character:\s*/, '').split(' / ')[0]
    const tags = group.map((item) => `<Picture ${item.number}>`).join(', ').replace(/, ([^,]+)$/, ' and $1')
    lines.push(`Preserve ${name}'s identity, face, hair, body proportions, and approved wardrobe from ${tags}.`)
  }
  const wardrobeGroups = new Map<string, typeof numbered>()
  for (const binding of numbered.filter((item) => item.purpose === 'wardrobe' && item.wardrobeId)) wardrobeGroups.set(`${binding.characterId}:${binding.wardrobeId}`, [...(wardrobeGroups.get(`${binding.characterId}:${binding.wardrobeId}`) ?? []), binding])
  for (const group of wardrobeGroups.values()) {
    const [wardrobeName, characterName] = group[0].label.replace(/^Wardrobe:\s*/, '').split(' for ')
    const tags = group.map((item) => `<Picture ${item.number}>`).join(', ').replace(/, ([^,]+)$/, ' and $1')
    lines.push(`Apply the approved ${wardrobeName} wardrobe to ${characterName} from ${tags}; use those pictures for clothing, materials, colors, fit, and accessories only.`)
  }
  for (const binding of numbered.filter((item) => item.purpose === 'location')) lines.push(`Preserve the location design and spatial layout from <Picture ${binding.number}>.`)
  for (const binding of numbered.filter((item) => item.purpose === 'continuity')) lines.push(`Continue the framing, lighting, pose, screen direction, and motion state shown in <Picture ${binding.number}>.`)
  for (const binding of numbered.filter((item) => item.purpose === 'generic')) lines.push(`Use <Picture ${binding.number}> as ${binding.label.replace(/^Shot reference:\s*/, 'the visual reference for ')}.`)
  return lines
}

export function compileMovieShotPrompt(project: MovieProject, scene: MovieScene, shot: MovieShot, bindings: MovieReferenceBinding[]) {
  const location = project.locations.find((item) => item.id === scene.locationId)
  const parts = [shot.prompt.trim()]
  if (location && !sentenceKey(shot.prompt).includes(sentenceKey(location.name))) parts.push(`Environment: ${location.name}. ${location.description}`)
  if (project.visualStyle) parts.push(`Visual treatment: ${project.visualStyle}`)
  if (project.visualRules) parts.push(`Continuity: ${project.visualRules}`)
  if (shot.dialogue && !shot.prompt.includes(shot.dialogue)) parts.push(`Dialogue: "${shot.dialogue}"`)
  parts.push(...composeReferenceInstructions(bindings))
  shot.referenceVideos?.forEach((file, index) => parts.push(`Use <Video ${index + 1}> (${file.name}) as the motion and temporal reference.`))
  shot.referenceAudios?.forEach((file, index) => parts.push(`Use <Audio ${index + 1}> (${file.name}) as the voice, performance, and sound reference.`))
  const seen = new Set<string>()
  return parts.filter(Boolean).filter((part) => { const key = sentenceKey(part); if (!key || seen.has(key)) return false; seen.add(key); return true }).join(' ')
}

export function buildPromptAssistantRequest(tool: PromptAssistantTool, draft: string, context: { duration: number; mode: GenerationMode; referenceMap?: string[] }) {
  const preservation = 'Preserve named characters, exact quoted dialogue, specified camera and lens choices, timing, negative constraints, continuity instructions, and every existing <Picture N>, <Video N>, and <Audio N> assignment. Never rename characters, invent replacement wardrobe, remove reference tags, add unnecessary cuts, or turn one continuous shot into a montage.'
  const order = 'Write natural production language in this order when relevant: subject/identity, starting state, environment, literal chronological action, shot size, camera angle, lens/depth of field, camera movement, lighting, visual treatment, continuity, dialogue, ambient sound/effects, and reference assignments.'
  const task = tool === 'enhance'
    ? `Rewrite the draft as one polished MiniMax H3 ${context.mode === 'reference' ? 'reference-to-video' : context.mode === 'image' ? 'image-to-video' : context.mode === 'frames' ? 'first/last-frame' : 'text-to-video'} prompt. ${order}`
    : tool === 'timeline'
      ? `Rewrite the draft as a readable chronological action plan lasting exactly ${context.duration} seconds. Use 0–2s style beats. For clips of 6 seconds or less, use only two or three meaningful beats and keep it one continuous shot. ${order}`
      : `Preserve the visual direction and strengthen synchronized dialogue/vocal intent, ambience, sound effects, spatial placement, timing, and clean transitions. State no music when a score is not requested. ${order}`
  return [task, preservation, `Effective duration: ${context.duration} seconds`, `Effective generation route: ${context.mode}`, context.referenceMap?.length ? `Reference map: ${context.referenceMap.join('; ')}` : '', 'Return only the finished prompt, with no analysis, preface, Markdown fence, or alternatives.', `DRAFT:\n${draft.trim()}`].filter(Boolean).join('\n\n')
}

export function resolveMovieShot(project: MovieProject, scene: MovieScene, shot: MovieShot, library: CharacterProject[], continuityFrame?: MediaFile): ResolvedMovieShot {
  const all = resolveMovieShotReferences(project, scene, shot, library, continuityFrame)
  const references = all.slice(0, 9)
  const route = resolveMovieShotGenerationMode(shot, references)
  const characterNames = [...new Set(references.filter((item) => item.characterId).map((item) => item.label.replace(/^Character:\s*/, '').split(' / ')[0]))]
  const routeReason = route.effectiveMode === 'reference' && characterNames.length ? `Reference mode selected automatically because ${characterNames.join(' and ')} ${characterNames.length === 1 ? 'has' : 'have'} approved references.` : route.effectiveMode === 'reference' ? 'Reference mode selected because this shot has reusable reference media.' : `Using the preferred ${route.effectiveMode} route.`
  const compiledBindings = route.effectiveMode === 'reference' ? references : references.filter((item) => item.purpose !== 'continuity')
  const continuationDirection = route.effectiveMode === 'image' && references.some((item) => item.purpose === 'continuity') ? ' Continue directly from the supplied first frame, preserving its framing, lighting, pose, screen direction, and motion state.' : ''
  return { ...route, references, omittedReferences: all.slice(9), compiledPrompt: `${compileMovieShotPrompt(project, scene, shot, compiledBindings)}${continuationDirection}`, routeReason }
}
