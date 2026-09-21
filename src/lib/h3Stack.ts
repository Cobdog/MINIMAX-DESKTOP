/** Detection and reporting for the validated official MiniMax H3 model stack. */
import type { ModelFile, ModelOverrideSlots } from '../types'
import type { ObjectInfo } from './comfyInfo'
import { resolveModelOverrides, type ModelOverrideSlotName } from './modelOverrides'
import { missingCoreNodeClasses, type MissingNodeClass } from './preflight'

export const diagnosticPrompt = 'A woman standing beside a window in soft daylight, natural skin texture, subtle head movement, realistic cinematic photography.'

export const validatedH3Files = [
  { label: 'FL2VA', kind: 'diffusion_models' as const, expected: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', fallback: /^minimax_h3_fl2va.*\.safetensors$/i, overrideSlot: 'fl2va' as ModelOverrideSlotName },
  { label: 'Text encoder', kind: 'text_encoders' as const, expected: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', fallback: /^qwen3vl_32b_minimax_h3.*\.safetensors$/i, overrideSlot: 'textEncoder' as ModelOverrideSlotName },
  { label: 'Video VAE', kind: 'vae' as const, expected: 'minimax_h3_video_vae_fp16.safetensors', fallback: /^minimax_h3_video_vae.*\.safetensors$/i, overrideSlot: 'videoVae' as ModelOverrideSlotName },
  { label: 'Audio VAE', kind: 'vae' as const, expected: 'minimax_h3_audio_vae_fp32.safetensors', fallback: /^minimax_h3_audio_vae.*\.safetensors$/i, overrideSlot: 'audioVae' as ModelOverrideSlotName },
  { label: 'Turbo 8', kind: 'loras' as const, expected: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors', fallback: /^minimax_h3_fl2v_turbo_8step.*\.safetensors$/i },
]

/** The report validates the RESOLVED selection: with overrides set, the
 *  affected rows carry the USER'S pick (an applied override replaces the
 *  pattern-inferred file; a refused/degraded pick falls back to inference
 *  like the submit path does) and are flagged `override` so the surface can
 *  say whose choice the row shows. The validated verdict stays "is this the
 *  exact official file" — an override to a community merge reads Custom,
 *  honestly.
 *
 *  (R-29, audit C F7) With an object_info snapshot at hand the report also
 *  checks the ENGINE side: an instance a version behind serves every file
 *  check yet fails at render. `nodes.missing` names the h3-video core
 *  classes the engine does not serve, and `ready` is false while any are
 *  missing — the weights cannot fix a node class. No snapshot (or an empty
 *  one) keeps the file-only verdict: the connection rung owns that refusal. */
export function h3StackReport(models: ModelFile[], overrides?: ModelOverrideSlots, info?: ObjectInfo | Record<string, unknown>) {
  const resolution = overrides ? resolveModelOverrides('minimax', models, overrides) : null
  const rows = validatedH3Files.map((definition) => {
    const files = models.filter((model) => model.kind === definition.kind)
    const exact = files.find((model) => model.name.toLowerCase() === definition.expected.toLowerCase())
    const fallback = files.find((model) => definition.fallback.test(model.name))
    const overrideOutcome = resolution && definition.overrideSlot ? resolution.slots[definition.overrideSlot] : null
    const appliedOverride = overrideOutcome && overrideOutcome.state === 'applied' ? overrideOutcome.file : null
    const selected = appliedOverride ?? exact?.name ?? fallback?.name ?? ''
    return { ...definition, selected, validated: Boolean(exact) && selected === exact!.name, override: Boolean(appliedOverride) }
  })
  const missingNodes: MissingNodeClass[] = missingCoreNodeClasses(info, 'h3-video')
  return { rows, validated: rows.every((row) => row.validated), ready: rows.every((row) => row.selected) && missingNodes.length === 0, nodes: { missing: missingNodes } }
}

export function findH3PreviewOverrideNode(info: ObjectInfo) {
  return Object.keys(info).find((name) => name === 'MiniMaxH3PreviewOverrideCS')
    ?? Object.keys(info).find((name) => /minimax.*h3.*preview.*override/i.test(name))
}
