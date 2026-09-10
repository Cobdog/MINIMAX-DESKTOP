export const noDialogueDirection = 'Audio direction: no spoken dialogue, narration, voice-over, singing, lip-sync, subtitles, captions, or text overlays. Use only natural ambient sound effects and room tone when audio is appropriate.'

export const naturalMovementDirection = 'Motion direction: when living subjects are present, use subtle natural micro-movements such as gentle breathing, occasional blinking, small eye movements, and restrained posture adjustments. Preserve the requested pose, action, framing, identity, wardrobe, and scene continuity. Do not add gestures, camera movement, or new actions.'

export function applyDialoguePolicy(prompt: string, noDialogue: boolean) {
  return noDialogue ? `${prompt.trim()} ${noDialogueDirection}`.trim() : prompt.trim()
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
