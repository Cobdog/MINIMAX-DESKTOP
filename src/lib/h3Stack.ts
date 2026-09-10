/** Detection and reporting for the validated official MiniMax H3 model stack. */
import type { ModelFile } from '../types'
import type { ObjectInfo } from './comfyInfo'

export const diagnosticPrompt = 'A woman standing beside a window in soft daylight, natural skin texture, subtle head movement, realistic cinematic photography.'

export const validatedH3Files = [
  { label: 'FL2VA', kind: 'diffusion_models' as const, expected: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', fallback: /^minimax_h3_fl2va.*\.safetensors$/i },
  { label: 'Text encoder', kind: 'text_encoders' as const, expected: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', fallback: /^qwen3vl_32b_minimax_h3.*\.safetensors$/i },
  { label: 'Video VAE', kind: 'vae' as const, expected: 'minimax_h3_video_vae_fp16.safetensors', fallback: /^minimax_h3_video_vae.*\.safetensors$/i },
  { label: 'Audio VAE', kind: 'vae' as const, expected: 'minimax_h3_audio_vae_fp32.safetensors', fallback: /^minimax_h3_audio_vae.*\.safetensors$/i },
  { label: 'Turbo 8', kind: 'loras' as const, expected: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors', fallback: /^minimax_h3_fl2v_turbo_8step.*\.safetensors$/i },
]

export function h3StackReport(models: ModelFile[]) {
  const rows = validatedH3Files.map((definition) => {
    const files = models.filter((model) => model.kind === definition.kind)
    const exact = files.find((model) => model.name.toLowerCase() === definition.expected.toLowerCase())
    const fallback = files.find((model) => definition.fallback.test(model.name))
    return { ...definition, selected: exact?.name ?? fallback?.name ?? '', validated: Boolean(exact) }
  })
  return { rows, validated: rows.every((row) => row.validated), ready: rows.every((row) => row.selected) }
}

export function findH3PreviewOverrideNode(info: ObjectInfo) {
  return Object.keys(info).find((name) => name === 'MiniMaxH3PreviewOverrideCS')
    ?? Object.keys(info).find((name) => /minimax.*h3.*preview.*override/i.test(name))
}
