import type { AceStepGenerationOptions, AceStepModelSelection, ModelFile } from '../types'
import { findRegistryModel } from './modelSelection'
import type { ComfyPrompt } from './workflow'

export const ACE_STEP_REQUIRED_NODES = [
  'UNETLoader', 'DualCLIPLoader', 'VAELoader', 'TextEncodeAceStepAudio1.5',
  'EmptyAceStep1.5LatentAudio', 'ConditioningZeroOut', 'ModelSamplingAuraFlow',
  'KSampler', 'VAEDecodeAudio', 'SaveAudioAdvanced',
] as const

/** The shared registry-inference engine (Wave 2): basename anchors +
 *  size-class ranking over the exact official names. */
function matching(models: ModelFile[], kind: ModelFile['kind'], pattern: RegExp) {
  return findRegistryModel(models, kind, [pattern])
}

export function inferAceStepSelections(models: ModelFile[]): AceStepModelSelection {
  return {
    base: matching(models, 'diffusion_models', /^acestep_v1\.5_xl_base_bf16(?:\.safetensors)?$/i),
    sft: matching(models, 'diffusion_models', /^acestep_v1\.5_xl_sft_bf16(?:\.safetensors)?$/i),
    textEncoderSmall: matching(models, 'text_encoders', /^qwen_0\.6b_ace15(?:\.safetensors)?$/i),
    textEncoderLarge: matching(models, 'text_encoders', /^qwen_4b_ace15(?:\.safetensors)?$/i),
    vae: matching(models, 'vae', /^ace_1\.5_vae(?:\.safetensors)?$/i),
  }
}

/** The 1.5 text encoder's enum vocabularies (nodes_ace.py:44/:46, served
 *  object_info @ a87667f — mirrored by the contract fixture): the time
 *  signature is the bare numerator, the key is '<root> <major|minor>'.
 *  AceStepGenerationOptions carries both as free strings, so the mapping to
 *  the engine's vocabulary lives HERE, at the builder — the one boundary
 *  that knows the contract. Unmappable values refuse at build time, never
 *  as an engine-side value_not_in_list after submission. */
const ACE_TIMESIGNATURES = ['2', '3', '4', '6'] as const
const ACE_KEY_ROOTS = ['C', 'C#', 'Db', 'D', 'D#', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'G#', 'Ab', 'A', 'A#', 'Bb', 'B'] as const

/** '4/4' and '4' both land on '4'; a denominator is engine vocabulary the
 *  node does not carry. */
export function aceTimeSignature(uiValue: string): string {
  const numerator = String(uiValue).trim().split('/')[0]
  if ((ACE_TIMESIGNATURES as readonly string[]).includes(numerator)) return numerator
  throw new Error(`ACE-Step 1.5 serves time signatures [${ACE_TIMESIGNATURES.join(', ')}] — '${uiValue}' does not map onto them.`)
}

/** A bare root means major (the node's own first-option default, and the
 *  canvas planner's choice); 'A minor' passes through as-is. */
export function aceKeyScale(uiValue: string): string {
  const value = String(uiValue).trim()
  const match = /^(.+?)\s+(major|minor)$/.exec(value)
  const root = match ? match[1] : value
  const mode = match ? match[2] : 'major'
  if (!(ACE_KEY_ROOTS as readonly string[]).includes(root)) {
    throw new Error(`ACE-Step 1.5 serves keys [${ACE_KEY_ROOTS.join('/')} × major/minor] — '${uiValue}' does not map onto them.`)
  }
  return `${root} ${mode}`
}

export function buildAceStepWorkflow(options: AceStepGenerationOptions, models: AceStepModelSelection): ComfyPrompt {
  const diffusion = options.model === 'sft' ? models.sft : models.base
  const lyrics = options.instrumental ? '[Instrumental]' : options.lyrics.trim()
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: diffusion, weight_dtype: 'default' } },
    '2': { class_type: 'DualCLIPLoader', inputs: { clip_name1: models.textEncoderSmall, clip_name2: models.textEncoderLarge, type: 'ace', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: models.vae } },
    '4': {
      class_type: 'TextEncodeAceStepAudio1.5',
      inputs: {
        clip: ['2', 0], tags: options.tags.trim(), lyrics, seed: options.seed,
        bpm: options.bpm, duration: options.duration, timesignature: aceTimeSignature(options.timeSignature),
        language: options.language, keyscale: aceKeyScale(options.keyScale), generate_audio_codes: options.generateAudioCodes,
        cfg_scale: 2, temperature: 0.85, top_p: 1, top_k: 0, min_p: 0,
      },
    },
    '5': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } },
    '6': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 3 } },
    '7': { class_type: 'EmptyAceStep1.5LatentAudio', inputs: { seconds: options.duration, batch_size: 1 } },
    '8': {
      class_type: 'KSampler',
      inputs: {
        model: ['6', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['7', 0],
        seed: options.seed, steps: 50, cfg: options.model === 'sft' ? 7 : 6,
        sampler_name: 'euler', scheduler: 'simple', denoise: 1,
      },
    },
    '9': { class_type: 'VAEDecodeAudio', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    '10': { class_type: 'SaveAudioAdvanced', inputs: { audio: ['9', 0], filename_prefix: options.filenamePrefix, format: 'flac' } },
  }
}
