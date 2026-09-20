import type { ModelFile, ModelKind, ModelSelection } from '../types'
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
    // The H3 preview TAE ships under two names: Kijai's original
    // vae_approx/taeh3.safetensors (the fetchable catalog entry) and the
    // preview-override pack's taeh3_decoder.safetensors. The engine's native
    // previewer matches any vae_approx file starting with "taeh3" — this
    // selection feeds the graph-side override node, so both names resolve
    // (the explicit decoder name stays preferred).
    previewVae: find('vae_approx', [/^taeh3_decoder\.safetensors$/i, /^taeh3\.safetensors$/i]),
    // Turbo inference is family-ranked through the optimization registry:
    // official weights first, then lightx2v newest-first, with an explicit
    // family choice (registry entry id) constraining the patterns to it.
    fl2vLora: find('loras', turboLoraPatterns('fl2v', turbo, family)),
    // Reference mode: the official 4-step LoRA (ComfyUI's template pair), or
    // the 8-step fast tier when 8-step reference mode is requested — ranked
    // larryvrh v4_step600_ema first per the 2026-09-15 bake-off (task
    // muwufpp), lightx2v Ref2VA 8-step as the measured runner-up.
    ref2vLora: find('loras', turboLoraPatterns('ref2v', turbo, family)),
  }
}
