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
import { findRegistryModel } from './modelSelection'

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

/** The OFFICIAL Music 3 audio-VAE artifact (researched 2026-09-26 against
 *  Comfy-Org/MiniMax-Music-3 on Hugging Face: vae/minimax_music3_dav.safetensors,
 *  216,696,128 bytes). Exported so the surfaces' empty-state copy can name
 *  WHAT is missing instead of a bare "nothing detected" (audit F3/M4:
 *  "nothing detected" read as a bug when it is a requirement). */
export const MUSIC3_DAV_FILENAME = 'minimax_music3_dav.safetensors'

/** Prefers the INT8 diffusion build (the low-VRAM recommendation) and falls
 *  back to fp16 when only that is installed. Resolves registry rows through
 *  the shared inference engine (Wave 2): basename anchors + size-class
 *  ranking, so subpathed and renamed Music 3 files resolve too.
 *
 *  The audio-VAE ladder (sweep #5, task 68e9k17 — the RECORDED DECISION):
 *  loosened the way the H3 family's audio-VAE ladder is — the exact
 *  official artifact first, then the music3-DAV family, then the bare
 *  'dav' needle (a renamed quant, a repack, a subpath still auto-resolves).
 *  The H3 video family's audio VAE (minimax_h3_audio_vae_fp32.safetensors)
 *  deliberately does NOT resolve here: the two official artifacts are
 *  DISTINCT (MiniMax-Music-3's DAV is 216,696,128 bytes; MiniMax-H3's audio
 *  VAE is 605,254,808 bytes — different repos, different decoder families),
 *  so auto-wiring the H3 file into Music 3's VAEDecodeAudioTiled would ship
 *  a wrong-decoder graph (the never-a-doomed-graph doctrine). The 'dav'
 *  needle cannot substring-match it. The explicit escape hatch stays the
 *  manual pick, where the engine is the final arbiter; an engine serving
 *  only the H3 audio VAE honestly reads "nothing detected" — a requirement
 *  to surface (MUSIC3_DAV_FILENAME), not a file to infer. */
export function inferMusic3Selection(models: ModelFile[]): Music3ModelSelection {
  return {
    diffusion: findRegistryModel(models, 'diffusion_models', [/music3.*int8|music3_dit_int8/i, /music3/i]),
    textEncoder: findRegistryModel(models, 'text_encoders', [/music3.*text_encoder/i]),
    vae: findRegistryModel(models, 'vae', [/^minimax_music3_dav\.safetensors$/i, /music3.*dav/i], 'dav'),
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
      // format is a dynamic v3 combo: the mp3 key's real sub-input is
      // quality (V0/128k/320k) — the old bitrate key was never declared and
      // the engine silently dropped it. Retired music3.bitrate-unknown-input.
      inputs: { audio: ['8', 0], filename_prefix: options.filenamePrefix, format: 'mp3', quality: 'V0' },
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
