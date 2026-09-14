import type { Ltx25ModelSelection, ModelFile, ModelKind, ModelSelection } from '../types'
import { turboLoraPatterns } from './graph'

function findModel(files: ModelFile[], kind: ModelKind, expressions: RegExp | RegExp[]) {
  const candidates = files.filter((file) => file.kind === kind)
  for (const expression of Array.isArray(expressions) ? expressions : [expressions]) {
    const match = candidates.find((file) => expression.test(file.name))
    if (match) return match.name
  }
  return ''
}

export function inferSelections(files: ModelFile[], turbo: 'off' | '4' | '8', family?: string): ModelSelection {
  const find = (kind: ModelKind, expressions: RegExp | RegExp[]) => findModel(files, kind, expressions)
  return {
    fl2va: find('diffusion_models', [/^minimax_h3_fl2va_pruned_int8_convrot\.safetensors$/i, /^minimax_h3_fl2va.*\.safetensors$/i]),
    ref2va: find('diffusion_models', [/^minimax_h3_ref2va_pruned_int8_convrot\.safetensors$/i, /^minimax_h3_ref2va.*\.safetensors$/i]),
    textEncoder: find('text_encoders', [/^qwen3vl_32b_minimax_h3_nvfp4_awq\.safetensors$/i, /^qwen3vl_32b_minimax_h3.*\.safetensors$/i]),
    videoVae: find('vae', [/^minimax_h3_video_vae_fp16\.safetensors$/i, /^minimax_h3_video_vae.*\.safetensors$/i]),
    audioVae: find('vae', [/^minimax_h3_audio_vae_fp32\.safetensors$/i, /^minimax_h3_audio_vae.*\.safetensors$/i]),
    previewVae: find('vae_approx', /^taeh3_decoder\.safetensors$/i),
    // Turbo inference is family-ranked through the optimization registry:
    // official weights first, then lightx2v newest-first, with an explicit
    // family choice (registry entry id) constraining the patterns to it.
    fl2vLora: find('loras', turboLoraPatterns('fl2v', turbo, family)),
    // Reference mode: the official 4-step LoRA (ComfyUI's template pair), or
    // the lightx2v Ref2VA 8-step when 8-step reference mode is requested.
    ref2vLora: find('loras', turboLoraPatterns('ref2v', turbo, family)),
  }
}

export function inferLtx25Selections(files: ModelFile[], latentUpscalers: string[]): Ltx25ModelSelection {
  return {
    diffusion: findModel(files, 'diffusion_models', [
      /^ltx-2\.5-22b-distilled-transformer-comfy-int8-convrot\.safetensors$/i,
      /^ltx-2\.5-22b-distilled-transformer-nvfp4\.safetensors$/i,
      /^ltx-2\.5-22b-distilled-transformer.*\.safetensors$/i,
    ]),
    textEncoder: findModel(files, 'text_encoders', [
      /^gemma4-12b-with-proj-ltx-2\.5-comfy-int8-convrot\.safetensors$/i,
      /^gemma4-12b-with-proj-ltx-2\.5.*\.safetensors$/i,
    ]),
    videoVae: findModel(files, 'vae', /^ltx-2\.5-video-vae.*\.safetensors$/i),
    audioVae: findModel(files, 'vae', /^ltx-2\.5-audio-vae.*\.safetensors$/i),
    latentUpscaler: latentUpscalers.find((name) => /^ltx-2\.5-latent-spatial-upscaler-x2.*\.safetensors$/i.test(name)) ?? '',
  }
}
