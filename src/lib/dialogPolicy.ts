export const noDialogueDirection = 'Audio direction: no spoken dialogue, narration, voice-over, singing, lip-sync, subtitles, captions, or text overlays. Use only natural ambient sound effects and room tone when audio is appropriate.'

export const naturalMovementDirection = 'Motion direction: when living subjects are present, use subtle natural micro-movements such as gentle breathing, occasional blinking, small eye movements, and restrained posture adjustments. Preserve the requested pose, action, framing, identity, wardrobe, and scene continuity. Do not add gestures, camera movement, or new actions.'

export function applyDialoguePolicy(prompt: string, noDialogue: boolean) {
  return noDialogue ? `${prompt.trim()} ${noDialogueDirection}`.trim() : prompt.trim()
}

/** H3 generates audio for every second of video and fills unspecified silence
 *  with gibberish speech — a bare "no dialogue" leaves the audio budget
 *  unspent (the actual failure mode, docs/research/h3-sampler-shaping-and-
 *  motion-control.md §1c(a)). v1 spends that budget on one continuous,
 *  scene-appropriate ambient bed; LLM-assisted per-second ambience via the
 *  prompt assistant is a future enhancement. */
export const h3AmbienceDirection = 'Audio ambience: spend the full audio budget on a continuous scene-appropriate ambient bed — steady room tone plus the environmental ambience of the setting, sustained across the whole duration. No voices anywhere in the audio.'

/** Official prompt-contract field for the audience-only score; N/A requests
 *  true silence for the music track. */
export const h3SilentScoreField = 'non_diegetic_music:\nN/A'

/** Full no-dialogue emission for the H3 generation path: the shared negation
 *  (belt-and-braces), the ambience bed that deliberately spends the audio
 *  budget, and the silent-score field. The labeled field is appended last so
 *  no free-text direction can be read as its value, and only when the prompt
 *  does not already declare it — a user- or assistant-composed score must not
 *  gain a contradicting second value. */
export function applyH3DialoguePolicy(prompt: string, noDialogue: boolean) {
  const negated = applyDialoguePolicy(prompt, noDialogue)
  if (!noDialogue) return negated
  const withAmbience = `${negated} ${h3AmbienceDirection}`
  return withAmbience.includes('non_diegetic_music:') ? withAmbience : `${withAmbience}\n${h3SilentScoreField}`
}

export function applyNaturalMovementPolicy(prompt: string, naturalMovement: boolean) {
  const trimmed = prompt.trim()
  if (!naturalMovement || trimmed.includes(naturalMovementDirection)) return trimmed
  return `${trimmed} ${naturalMovementDirection}`.trim()
}

export function buildCharacterDialogueRequest(input: {
  characterName: string
  characterDescription: string
  voiceNotes: string
  shotPrompt: string
  intent: string
  requiredWords: string
  delivery: string
  length: string
  language: string
  duration: number
}) {
  return [
    `Write dialogue for ${input.characterName}, an adult fictional character, for a ${input.duration}-second video shot.`,
    `Character: ${input.characterDescription || 'No additional character description provided.'}`,
    `Established voice: ${input.voiceNotes || 'Natural, believable speech.'}`,
    `Current shot context: ${input.shotPrompt.trim() || 'No visual prompt has been written yet.'}`,
    `The line should communicate: ${input.intent}`,
    `Delivery: ${input.delivery}. Length: ${input.length}. Language: ${input.language}.`,
    input.requiredWords ? `Include these exact words naturally: ${input.requiredWords}` : '',
    'Write only the exact words the character should speak. Do not add quotation marks, a speaker label, stage direction, explanation, alternatives, markdown, or camera instructions. Keep it performable within the available shot and avoid exposition that sounds unnatural.',
  ].filter(Boolean).join('\n\n')
}
