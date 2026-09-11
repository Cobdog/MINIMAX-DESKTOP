/** MiniMax's official H3 prompt contracts, encoded from the primary source
 *  (MiniMax-AI/MiniMax-H3 skills/h3-prompt-writing: SKILL.md,
 *  references/base-en.txt, references/ref-en.txt).
 *
 *  Base modes (T2VA/I2VA/FL2VA/L2VA) emit three labeled fields.
 *  Reference mode (Ref2VA) emits six labeled sections in a fixed order, and
 *  uses <Subject N> for reusable visible content — the file tags
 *  (<Picture>/<Video>/<Audio>) appear only as sources inside definitions or
 *  as whole-asset relationships. These builders scaffold that exact shape
 *  from live workspace state; the validators catch drift. */
import type { GenerationMode, MediaFile, MovieReferenceBinding } from '../types'

export type ContractSection = { key: string; guidance: string }

export const BASE_CONTRACT_SECTIONS: ContractSection[] = [
  { key: 'integrated_multimodal_description', guidance: 'Main body. Style sentence first ([Shot 1] opens with overall style + initial composition; no timestamp on Shot 1). Later shots: [Shot 2] At MM:SS.mmm, … with strictly increasing cut times inside the duration. Every detail must be visible or audible. Dialogue uses stable speaker IDs (S1, S2) with verbatim content in <d>[Language] …</d>; identity, action, and delivery stay outside <d>. On-screen text in double quotes, verbatim.' },
  { key: 'overall_soundscape', guidance: '1–4 English sentences, one paragraph: ambience and physical/non-verbal sound for the whole video. No dialogue, singing, or diegetic music. N/A only when total silence is explicitly requested.' },
  { key: 'non_diegetic_music', guidance: '1–3 English sentences of audience-only score: instrumentation, speed, rhythm, dynamics. No abstract mood words. N/A when there is none.' },
]

export const REFERENCE_CONTRACT_SECTIONS: ContractSection[] = [
  { key: 'subject_definitions', guidance: 'One line per tracked item (person, scene, object, style, action): label, reference role, and the key features to follow. Name the source asset (<Picture N>, <Video N>) inside the definition when provenance matters.' },
  { key: 'summary', guidance: 'One short paragraph starting with a bracketed task type — [reference generation], [keyframe completion], [video editing], [video continuation], [audio reuse], [audio reference] — combined with +. Reuse existing labels only.' },
  { key: 'retention_analysis', guidance: 'One line per label with appearance shots and a marker: fully_preserved / partially_preserved / attribute_transfer / weak_reference for visuals; fully_copy / partially_copy / reference / weak_reference for audio. New actions or backgrounds are not fidelity loss.' },
  { key: 'detailed_description', guidance: 'Body, 350–500 words for generation tasks. Style sentence before [Shot 1]. [Shot N] At MM:SS.mmm for later shots, strictly increasing. Insert each label at its first appearance and wherever its role applies.' },
  { key: 'overall_soundscape', guidance: 'Full-video ambience and physical sound; shot-synced dialogue and SFX stay in detailed_description.' },
  { key: 'non_diegetic_music', guidance: 'Audience-only score: instrumentation, tempo, dynamics. State audio copy/reference relationships here. N/A when there is none.' },
]

/** Official duration format: seconds → MM:SS.mmm with exactly three decimals. */
export function formatCutTime(seconds: number) {
  const safe = Math.max(0, seconds)
  const minutes = Math.floor(safe / 60)
  const whole = Math.floor(safe % 60)
  const millis = Math.round((safe - Math.floor(safe)) * 1000)
  return `${String(minutes).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

/** Evenly spaced interior cut suggestions for a target shot count. */
export function suggestCutTimes(duration: number, cuts: number) {
  if (cuts <= 0 || duration <= 1) return []
  return Array.from({ length: cuts }, (_, index) => formatCutTime((duration * (index + 1)) / (cuts + 1)))
}

/** Keyframe-mode alignment instruction lines, verbatim shapes from the guide. */
export function keyframeAlignmentInstruction(mode: GenerationMode, duration: number) {
  const end = duration.toFixed(2)
  if (mode === 'image') return 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.'
  if (mode === 'frames') return `Align <Picture 1> with 0.00 seconds and <Picture 2> with ${end} seconds (the end of [Shot 1]) of the target video.`
  return ''
}

export type BaseContractDraftInput = {
  mode: GenerationMode
  duration: number
  prompt: string
  cuts?: number
}

/** Labeled three-field scaffold for base modes, prefilled with the current
 *  prompt and suggested cut times. */
export function buildBaseContractDraft(input: BaseContractDraftInput) {
  const cuts = input.cuts ?? (input.duration > 6 ? 2 : input.duration > 3 ? 1 : 0)
  const times = suggestCutTimes(input.duration, cuts)
  const alignment = keyframeAlignmentInstruction(input.mode, input.duration)
  const shotLines = [
    `[Shot 1] ${input.prompt.trim() || 'Describe overall style, composition, subject, action, camera, and any dialogue here.'}`,
    ...times.map((time) => `[Shot ${times.indexOf(time) + 2}] At ${time}, describe the next continuous beat — new composition, action change, or camera cut.`),
  ].join('\n')
  const body = [
    alignment,
    `integrated_multimodal_description:\n${shotLines}`,
    'overall_soundscape:\nDescribe ambience and physical sound for the whole video in 1–4 sentences. No dialogue or diegetic music here.',
    input.prompt.includes('<d>') || input.prompt.includes('dialogue') ? 'non_diegetic_music:\nN/A' : 'non_diegetic_music:\nDescribe audience-only score (instrumentation, tempo, dynamics) in 1–3 sentences, or N/A.',
  ].filter(Boolean).join('\n\n')
  return body
}

export type ReferenceContractDraftInput = {
  bindings: MovieReferenceBinding[]
  referenceVideos: MediaFile[]
  referenceAudios: MediaFile[]
  duration: number
  prompt: string
}

/** Six-section Ref2VA scaffold: subject lines derived from the workspace's
 *  actual reference bindings, retention stubs, and the user's scene text. */
export function buildReferenceContractDraft(input: ReferenceContractDraftInput) {
  const subjectLines = input.bindings.slice(0, 9).map((binding, index) => {
    const name = binding.label.replace(/^(Character|Wardrobe|Hair|Accessory|Location):\s*/, '').split(' / ')[0]
    const role = binding.purpose === 'location' ? 'environment' : binding.purpose === 'wardrobe' ? 'wardrobe' : binding.purpose === 'hair' ? 'hairstyle' : binding.purpose === 'accessory' ? 'accessory' : 'identity'
    return `<Subject ${index + 1}> is the ${role} of ${name}, following ${binding.file.name} (loaded as <Picture ${index + 1}>). List the exact features to preserve: ${role === 'identity' ? 'face, proportions, skin, hairline, and distinguishing marks' : 'shape, materials, colors, and placement'}.`
  })
  const videoLines = input.referenceVideos.map((file, index) => `<Video ${index + 1}> is ${file.name}, used as a whole-video motion/temporal reference.`)
  const audioLines = input.referenceAudios.map((file, index) => `<Audio ${index + 1}> is ${file.name}, used as a voice/sound reference.`)
  const retention = [...input.bindings.slice(0, 9).map((_binding, index) => `<Subject ${index + 1}> (appears in [Shot 1]): fully_preserved - the listed features are retained throughout.`)]
  const cuts = suggestCutTimes(input.duration, input.duration > 6 ? 2 : 1)
  return [
    'subject_definitions:\n' + [...subjectLines, ...videoLines, ...audioLines].join('\n'),
    'summary:\n[reference generation] One short paragraph: what the target video shows, which subjects interact, and the outcome. Reuse the labels above only.',
    'retention_analysis:\n' + retention.join('\n'),
    `detailed_description:\nStyle sentence first. [Shot 1] ${input.prompt.trim() || 'Describe composition, subjects, environment, actions, camera, and where each referenced subject appears.'}${cuts.map((time) => `\n[Shot 2] At ${time}, describe the next continuous beat.`).join('')} Insert each <Subject N> at its first appearance. 350–500 words for generation tasks.`,
    'overall_soundscape:\nFull-video ambience and physical sound in 1–4 sentences.',
    'non_diegetic_music:\nAudience-only score, or N/A.',
  ].join('\n\n')
}

export type ContractValidation = { warnings: string[] }

const CUT_TIME_PATTERN = /\[Shot (\d+)\] At (\d{2}):(\d{2})\.(\d{3})/g
const TAG_PATTERN = /<(Picture|Video|Audio|Subject) (\d+)>/g

/** Structural validation of a contract draft: section presence/order,
 *  strictly increasing cut times inside the duration, unresolved file tags. */
export function validateContract(text: string, options: { duration: number; referenceMode: boolean; definedSubjects?: string[] }): ContractValidation {
  const warnings: string[] = []
  const sections = (options.referenceMode ? REFERENCE_CONTRACT_SECTIONS : BASE_CONTRACT_SECTIONS).map((section) => section.key)
  const positions = sections.map((key) => text.indexOf(`${key}:`))
  const missing = sections.filter((_key, index) => positions[index] === -1)
  if (missing.length) warnings.push(`Missing ${options.referenceMode ? 'reference contract' : 'base contract'} section(s): ${missing.join(', ')}.`)
  const present = positions.filter((position) => position !== -1)
  if (present.length > 1 && present.some((position, index) => index > 0 && position < present[index - 1])) {
    warnings.push('Contract sections are out of the official order.')
  }
  let lastSeconds = -1
  let lastShot = 1
  // exec-loop (not matchAll): the test harness transpiles to a target where
  // for-of over matchAll iterators silently runs zero iterations.
  let match: RegExpExecArray | null
  while ((match = CUT_TIME_PATTERN.exec(text)) !== null) {
    const shot = Number(match[1])
    const seconds = Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4]}`)
    if (shot <= lastShot) warnings.push(`[Shot ${shot}] does not follow the previous shot number.`)
    lastShot = Math.max(lastShot, shot)
    if (seconds <= lastSeconds) warnings.push(`Cut time at ${match[2]}:${match[3]}.${match[4]} is not strictly increasing.`)
    if (seconds >= options.duration) warnings.push(`Cut time at ${match[2]}:${match[3]}.${match[4]} falls at or beyond the ${options.duration}s duration.`)
    lastSeconds = Math.max(lastSeconds, seconds)
  }
  const defined = new Set(options.definedSubjects ?? [])
  let tag: RegExpExecArray | null
  while ((tag = TAG_PATTERN.exec(text)) !== null) {
    if (tag[1] === 'Subject' && defined.size && !defined.has(`${tag[1]} ${tag[2]}`)) {
      warnings.push(`<${tag[1]} ${tag[2]}> is used but not defined in subject_definitions.`)
    }
  }
  return { warnings }
}

export type ReferenceInventory = { images: number; videos: number; audios: number }

/** Enforces the #1 multi-character rule: slot order must match mention order,
 *  every mention must have a loaded file, and loaded files should be used. */
export function referenceOrderWarnings(prompt: string, inventory: ReferenceInventory): string[] {
  const warnings: string[] = []
  const firstMention = new Map<string, number>()
  let match: RegExpExecArray | null
  while ((match = TAG_PATTERN.exec(prompt)) !== null) {
    const tag = `${match[1]} ${match[2]}`
    if (!firstMention.has(tag)) firstMention.set(tag, match.index ?? 0)
  }
  for (const [kind, count] of Object.entries({ Picture: inventory.images, Video: inventory.videos, Audio: inventory.audios })) {
    // Array.from (not iterator spread): the test harness transpiles to a
    // target where spreading Map iterators silently yields [].
    const mentioned = Array.from(firstMention.entries()).filter(([tag]) => tag.startsWith(`${kind} `)).sort((a, b) => a[1] - b[1])
    mentioned.forEach(([tag], index) => {
      const number = Number(tag.split(' ')[1])
      if (number !== index + 1) warnings.push(`<${tag}> is mentioned before <${kind} ${index + 1}> — slot order must match the order references were added.`)
      if (number > count) warnings.push(`${tag} is mentioned but only ${count} ${kind.toLowerCase()}${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} loaded.`)
    })
    if (count > 0 && mentioned.length === 0 && kind === 'Picture') warnings.push(`${count} picture reference${count === 1 ? '' : 's'} loaded but none mentioned in the prompt — add <Picture 1> where each applies.`)
  }
  return Array.from(new Set(warnings))
}
