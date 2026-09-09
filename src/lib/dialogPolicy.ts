export const noDialogueDirection = 'Audio direction: no spoken dialogue, narration, voice-over, singing, lip-sync, subtitles, captions, or text overlays. Use only natural ambient sound effects and room tone when audio is appropriate.'

export function applyDialoguePolicy(prompt: string, noDialogue: boolean) {
  return noDialogue ? `${prompt.trim()} ${noDialogueDirection}`.trim() : prompt.trim()
}
