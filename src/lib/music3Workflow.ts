/** MiniMax Music 3 graph builder — complete songs up to ~5 minutes.
 *
 *  Topology and pin names verified against ComfyUI core
 *  (comfy_extras/nodes_minimax_music.py) and Comfy-Org's official
 *  audio_minimax_music_3 template: TextEncode carries caption + lyrics +
 *  seed + max_duration (its `seconds` output sizes the empty latent),
 *  KSampler runs euler/simple with the zeroed-out negative, and the audio
 *  VAE decodes tiled (1536/64) — the low-VRAM path — before
 *  SaveAudioAdvanced (mp3 V0). */
import type { ModelFile } from '../types'

export type Music3ModelSelection = {
  diffusion: string
  textEncoder: string
  vae: string
}

export type Music3GenerationOptions = {
  caption: string
  lyrics: string
  duration: number
  seed: number
  cfgScale?: number
  topK?: number
  tiledDecode: boolean
  filenamePrefix: string
}

export const MUSIC3_REQUIRED_NODES = ['MiniMaxMusic3TextEncode', 'EmptyMiniMaxMusic3LatentAudio', 'ConditioningZeroOut', 'VAEDecodeAudioTiled', 'SaveAudioAdvanced', 'KSampler'] as const

/** Prefers the INT8 diffusion build (the low-VRAM recommendation) and falls
 *  back to fp16 when only that is installed. */
export function inferMusic3Selection(models: ModelFile[]): Music3ModelSelection {
  const byKind = (kind: string) => models.filter((model) => model.kind === kind)
  const diffusion = byKind('diffusion_models')
  const vae = byKind('vae')
  const textEncoders = byKind('text_encoders')
  return {
    diffusion: diffusion.find((m) => /music3.*int8|music3_dit_int8/i.test(m.name))?.name
      ?? diffusion.find((m) => /music3/i.test(m.name))?.name ?? '',
    textEncoder: textEncoders.find((m) => /music3.*text_encoder/i.test(m.name))?.name ?? '',
    vae: vae.find((m) => /music3.*dav/i.test(m.name))?.name ?? '',
  }
}

export function buildMusic3Workflow(options: Music3GenerationOptions, models: Music3ModelSelection): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  const prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: models.diffusion, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: models.textEncoder, type: 'minimax', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: models.vae } },
    '4': {
      class_type: 'MiniMaxMusic3TextEncode',
      inputs: {
        clip: ['2', 0],
        caption: options.caption,
        lyrics: options.lyrics,
        seed: options.seed,
        max_duration: Math.min(300, Math.max(4, options.duration)),
        cfg_scale: options.cfgScale ?? 1.7,
        top_k: options.topK ?? 50,
      },
    },
    '5': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } },
    '6': { class_type: 'EmptyMiniMaxMusic3LatentAudio', inputs: { seconds: ['4', 1], batch_size: 1 } },
    '7': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0],
        seed: options.seed, steps: 30, cfg: options.cfgScale ?? 1.7,
        sampler_name: 'euler', scheduler: 'simple', denoise: 1,
      },
    },
    '9': {
      class_type: 'SaveAudioAdvanced',
      inputs: { audio: ['8', 0], filename_prefix: options.filenamePrefix, format: 'mp3', bitrate: 'V0' },
    },
  }
  // Tiled decode is the low-VRAM default (overlapping tiles cut memory at a
  // small seam risk); full decode keeps the best quality on large GPUs.
  prompt['8'] = options.tiledDecode
    ? { class_type: 'VAEDecodeAudioTiled', inputs: { samples: ['7', 0], vae: ['3', 0], tile_size: 1536, overlap: 64 } }
    : { class_type: 'VAEDecodeAudio', inputs: { samples: ['7', 0], vae: ['3', 0] } }
  return prompt
}

/** Assembles the official three-section caption. Sections are omitted when
 *  blank so the model never sees empty headings. */
export function buildMusic3Caption(sections: { globalMetadata: string; vocalDetails: string; arrangement: string }) {
  return [
    sections.globalMetadata.trim() ? `Global Metadata: ${sections.globalMetadata.trim()}` : '',
    sections.vocalDetails.trim() ? `Vocal Details: ${sections.vocalDetails.trim()}` : '',
    sections.arrangement.trim() ? `Arrangement: ${sections.arrangement.trim()}` : '',
  ].filter(Boolean).join('\n')
}

export const MUSIC3_SECTION_TAGS = ['[Intro]', '[Verse]', '[Pre-Chorus]', '[Chorus]', '[Post-Chorus]', '[Bridge]', '[Instrumental]', '[Solo]', '[Outro]'] as const

/** The official rewriter skill's rules, paraphrased for the local Ollama
 *  assistant: keep the three-section shape, concrete and audio-specific
 *  language, structure only via tags, and no mood abstractions. */
export function buildMusic3CaptionRewriteRequest(draft: string) {
  return [
    'Rewrite this MiniMax Music 3 caption so it follows the model’s official format. Keep the three sections — Global Metadata (genre, BPM, key, scale, emotional progression, listening scenario, production profile), Vocal Details (gender, timbre, performance style, harmonies, vocal effects), and Arrangement (primary/secondary instruments, groove, bass, percussion, textures, spatial effects) — in that order, omitting any section that has no content.',
    'Rules: concrete audio-specific language only (no “beautiful”, “amazing”, “cinematic”); one listening scenario; keep the stated BPM/key/scale exactly; describe the emotional progression through musical changes, not adjectives; leave all structural directions in the lyrics tags, not the caption.',
    'Return only the rewritten caption with the three section headings, no commentary.',
    `DRAFT:\n${draft.trim()}`,
  ].join('\n\n')
}
