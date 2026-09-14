/** Turbo-LoRA registry entries: every few-step distillation family that can
 * accelerate the H3 core, as DATA. Each entry declares the filename patterns
 * that identify its weights, the sampler/steps pairing contract, and how its
 * loader renders (plain LoraLoaderModelOnly, or the larryvrh dedicated pair
 * when that pack is installed).
 *
 * Verified against the publishers' file listings (2026-09-14):
 *  - official/Comfy-Org mirrors: minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16,
 *    minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16
 *  - lightx2v/Minimax-h3-Turbo: fl2v 4-step v0.1…v1.2 (768p), fl2v 8-step
 *    v1.0 768p, ref2v 4-step v0.1, ref2v 8-step v1.0 768p
 *  - alibaba-pai/MiniMax-H3-Acc-LoRAs (PDD): MiniMax-H3-FL2VA-Acc-8Step,
 *    MiniMax-H3-Ref2VA-Acc-8Step
 *  - drbaph/MiniMax-H3-Turbo-Lora-ComfyUI: larryvrh-lineage pruned conversions
 *    (v4_step600 / 4step_ckpt500/850, EMA variants) + resized re-publishes of
 *    the lightx2v weights (those classify as the lightx2v source family). */
import type { ObjectInfo } from '../comfyInfo'
import type { ModelFile } from '../../types'
import type { ComfyNode, ComfyPrompt, GraphContext, OptimizationEntry, TransformOptions, TurboLoaderChoice, TurboPlan } from './types'
import { H3, LARRYVRH_TURBO_NODES } from './ids'

/** True when the larryvrh ComfyUI-MiniMax-H3-Turbo pack is installed
 * (MiniMaxH3TurboLoRA + MiniMaxH3TurboSampler both present in object_info). */
export function larryvrhTurboPackPresent(info: ObjectInfo | undefined): boolean {
  return Boolean(info && LARRYVRH_TURBO_NODES.every((node) => info[node]))
}

function firstLoraMatch(files: ModelFile[], patterns: RegExp[]): ModelFile | undefined {
  const candidates = files.filter((file) => file.kind === 'loras')
  for (const pattern of patterns) {
    const match = candidates.find((file) => pattern.test(file.name))
    if (match) return match
  }
  return undefined
}

/** The one transform every turbo entry shares: insert the loader node after
 * the UNet (or whatever the model tail is) at the factory's turbo seam. The
 * node class depends on the resolved plan — plain stock loader, or the
 * dedicated larryvrh loader whose sampler pairs with the family. */
function turboTransform(graph: ComfyPrompt, ctx: GraphContext, opts: TransformOptions): void {
  const plan = opts.turboPlan
  if (!plan) return
  const node: ComfyNode = plan.loader === 'dedicated'
    ? { class_type: 'MiniMaxH3TurboLoRA', inputs: { lora_name: plan.loraName, strength: plan.strength, low_vram: false } }
    : { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: plan.loraName, strength_model: plan.strength } }
  ctx.wrapModel('turboLora', H3.turboLora, node)
}

type TurboDefinition = {
  id: string
  label: string
  patterns: RegExp[]
  pairing: OptimizationEntry['pairing']
  ui: OptimizationEntry['ui']
}

function turboEntry(definition: TurboDefinition): OptimizationEntry {
  return {
    id: definition.id,
    label: definition.label,
    kind: 'turbo',
    appliesTo: ['minimax'],
    wraps: 'modelChain',
    patterns: definition.patterns,
    pairing: definition.pairing,
    detect(info, files) {
      const match = firstLoraMatch(files, definition.patterns)
      return { available: Boolean(match), model: match?.name, packs: { larryvrhTurbo: larryvrhTurboPackPresent(info) } }
    },
    transform: turboTransform,
    ui: definition.ui,
  }
}

/** OFFICIAL_SAMPLER_PIN: every family that does not declare its own sampler
 * keeps the official res_multistep + simple pair the ComfyUI templates use —
 * turbo LoRAs are trained for it (see workflow.ts). */
export const TURBO_ENTRIES: OptimizationEntry[] = [
  turboEntry({
    id: 'turbo.official-fl2v-8',
    label: 'Official MiniMax FL2V 8-step',
    patterns: [/^minimax_h3_fl2v_turbo_8step_v\d+(?:\.\d+)?_comfyui_bf16\.safetensors$/i],
    pairing: { sampler: 'res_multistep', scheduler: 'simple', steps: 8 },
    ui: {
      description: 'The validated official 8-step Turbo LoRA (Comfy-Org conversion) — the Studio default turbo.',
      installHint: 'ComfyUI Model Zoo → MiniMax H3 → loras (minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors)',
    },
  }),
  turboEntry({
    id: 'turbo.lightx2v-fl2v-8',
    label: 'lightx2v FL2V 8-step (768p)',
    patterns: [
      /^minimax_h3_fl2v_turbo_8step_v\d+(?:\.\d+)?_768p/i,
      // drbaph's dynamic-rank re-publish of the same weights (non-768p name).
      /^minimax_h3_fl2v_turbo_8step_v\d+(?:\.\d+)?_comfyui_resized_avg_rank_\d+_bf16\.safetensors$/i,
    ],
    pairing: { sampler: 'res_multistep', scheduler: 'simple', steps: 8 },
    ui: {
      description: 'lightx2v 8-step distillation trained at 768p — the quality-leaning 8-step option.',
      installHint: 'huggingface.co/lightx2v/Minimax-h3-Turbo — minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors',
    },
  }),
  turboEntry({
    id: 'turbo.ref2v-4',
    label: 'Official Ref2V 4-step',
    patterns: [/^minimax_h3_ref2v_turbo_4step/i],
    pairing: { sampler: 'res_multistep', scheduler: 'simple', steps: 4 },
    ui: {
      description: 'The official reference-to-video 4-step Turbo LoRA (Ref2VA); the same weights lightx2v publishes.',
      installHint: 'ComfyUI Model Zoo → MiniMax H3 → loras (minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors)',
    },
  }),
  turboEntry({
    id: 'turbo.lightx2v-ref2v-8',
    label: 'lightx2v Ref2VA 8-step',
    patterns: [/^minimax_h3_ref2v_turbo_8step/i],
    pairing: { sampler: 'res_multistep', scheduler: 'simple', steps: 8 },
    ui: {
      description: 'lightx2v 8-step Ref2VA distillation — reference mode at 8 steps (previously impossible).',
      installHint: 'huggingface.co/lightx2v/Minimax-h3-Turbo — minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors',
    },
  }),
  turboEntry({
    id: 'turbo.lightx2v-fl2v-4',
    label: 'lightx2v FL2V 4-step (default speed)',
    patterns: [/^minimax_h3_fl2v_turbo_4step/i],
    pairing: { sampler: 'res_multistep', scheduler: 'simple', samplerNode: 'MiniMaxH3TurboSampler', steps: 4 },
    ui: {
      description: 'The default speed family: 4-step FL2V (v1.2 latest). Pairs with the larryvrh Turbo Sampler when installed.',
      warning: '4-step turbo trades motion/audio fidelity for speed — compare against 8-step on the same seed.',
      installHint: 'huggingface.co/lightx2v/Minimax-h3-Turbo — minimax_h3_fl2v_turbo_4step_v1.2_768p_comfyui_bf16.safetensors',
    },
  }),
  turboEntry({
    id: 'turbo.drbaph-4',
    label: 'drbaph 4-step (larryvrh lineage)',
    patterns: [/^minimax_h3_turbo_(?:v4_step600(?:_ema)?|4step(?:_ema)?_ckpt\d+)_pruned_comfyui\.safetensors$/i],
    pairing: { sampler: 'res_multistep', scheduler: 'simple', samplerNode: 'MiniMaxH3TurboSampler', steps: 4 },
    ui: {
      description: 'drbaph ComfyUI conversions of larryvrh\'s original 4-step (v4 step-600 EMA recommended). Pairs with the larryvrh Turbo Sampler.',
      warning: 'The pruned conversions need the matching pruned base model — check drbaph\'s README pairing table.',
      installHint: 'huggingface.co/drbaph/MiniMax-H3-Turbo-Lora-ComfyUI',
    },
  }),
  turboEntry({
    id: 'turbo.pdd-fl2va-8',
    label: 'alibaba-pai PDD FL2VA 8-step',
    patterns: [/^minimax[-_]?h3[-_]?fl2va[-_]?acc[-_]?8step\.safetensors$/i],
    pairing: { sampler: 'res_multistep', scheduler: 'simple', steps: 8 },
    ui: {
      description: 'Alibaba PAI parallel-decoding-distillation 8-step accelerator (quality-turbo) for FL2VA.',
      warning: 'PDD needs recent ComfyUI with native PDD support or the ComfyUI-MiniMax-H3-PDD-Acc pack.',
      installHint: 'huggingface.co/alibaba-pai/MiniMax-H3-Acc-LoRAs — MiniMax-H3-FL2VA-Acc-8Step.safetensors',
    },
  }),
  turboEntry({
    id: 'turbo.pdd-ref2va-8',
    label: 'alibaba-pai PDD Ref2VA 8-step',
    patterns: [/^minimax[-_]?h3[-_]?ref2va[-_]?acc[-_]?8step\.safetensors$/i],
    pairing: { sampler: 'res_multistep', scheduler: 'simple', steps: 8 },
    ui: {
      description: 'Alibaba PAI parallel-decoding-distillation 8-step accelerator (quality-turbo) for Ref2VA.',
      warning: 'PDD needs recent ComfyUI with native PDD support or the ComfyUI-MiniMax-H3-PDD-Acc pack.',
      installHint: 'huggingface.co/alibaba-pai/MiniMax-H3-Acc-LoRAs — MiniMax-H3-Ref2VA-Acc-8Step.safetensors',
    },
  }),
]

/** The fallback entry for a selected turbo LoRA no family claims (custom or
 * future weights): the pre-registry plain-loader behavior, unchanged. */
export const GENERIC_TURBO_ENTRY: OptimizationEntry = {
  id: 'turbo.generic',
  label: 'Custom turbo LoRA',
  kind: 'turbo',
  appliesTo: ['minimax'],
  wraps: 'modelChain',
  detect() {
    return { available: false }
  },
  transform: turboTransform,
  ui: {
    description: 'An unrecognized LoRA loaded through the stock plain loader at the requested step count.',
    warning: 'Not a known turbo family — verify its trained step count and sampler pairing yourself.',
  },
}

/** First family whose patterns classify the filename (registry order wins). */
export function classifyTurboFamily(filename: string, entries: readonly OptimizationEntry[] = TURBO_ENTRIES): OptimizationEntry | undefined {
  if (!filename) return undefined
  return entries.find((entry) => entry.patterns?.some((pattern) => pattern.test(filename)))
}

/** Resolves how a turbo render will load: which family owns the selected LoRA,
 * how many steps the scheduler runs, and whether the dedicated loader/sampler
 * pair replaces the plain nodes. The dedicated path needs the family's declared
 * sampler node AND the MiniMaxH3TurboLoRA loader present in object_info (the
 * larryvrh pack ships both), the family to declare a samplerNode pairing at
 * all (the 4-step families), and the user not to have forced the plain loader. */
export function resolveTurboPlan(input: {
  turbo: 'off' | '4' | '8'
  loraName: string
  strength?: number
  loader?: TurboLoaderChoice
  info?: ObjectInfo
}, entries: readonly OptimizationEntry[] = TURBO_ENTRIES): TurboPlan | undefined {
  if (input.turbo === 'off' || !input.loraName) return undefined
  const family = classifyTurboFamily(input.loraName, entries) ?? GENERIC_TURBO_ENTRY
  const samplerNode = family.pairing?.samplerNode
  const dedicated = Boolean(samplerNode)
    && input.loader !== 'plain'
    && Boolean(input.info && input.info['MiniMaxH3TurboLoRA'] && samplerNode && input.info[samplerNode])
  return {
    entryId: family.id,
    loraName: input.loraName,
    strength: input.strength ?? 1,
    steps: family.pairing?.steps ?? Number(input.turbo),
    loader: dedicated ? 'dedicated' : 'plain',
    samplerNode: dedicated ? samplerNode : undefined,
  }
}

/** Ranked LoRA-filename patterns for model-selection inference. When a family
 * is explicitly chosen only its patterns run; otherwise the per-step ranking
 * picks the best installed file (official first, then lightx2v newest-first;
 * PDD/drbaph are detected and surfaced but selected only explicitly). */
export function turboLoraPatterns(target: 'fl2v' | 'ref2v', turbo: 'off' | '4' | '8', family?: string, entries: readonly OptimizationEntry[] = TURBO_ENTRIES): RegExp[] {
  if (family) {
    const entry = entries.find((candidate) => candidate.id === family)
    if (entry?.patterns) return entry.patterns
  }
  if (target === 'ref2v') {
    return turbo === '8'
      ? [/^minimax_h3_ref2v_turbo_8step/i]
      : [/^minimax_h3_ref2v_turbo_4step/i]
  }
  if (turbo === '4') {
    return [
      /^minimax_h3_fl2v_turbo_4step_v1\.2/i,
      /^minimax_h3_fl2v_turbo_4step_v1\.1/i,
      /^minimax_h3_fl2v_turbo_4step_v1\.0/i,
      /^minimax_h3_fl2v_turbo_4step/i,
    ]
  }
  if (turbo === '8') {
    return [
      /^minimax_h3_fl2v_turbo_8step_v\d+(?:\.\d+)?_comfyui_bf16\.safetensors$/i,
      /^minimax_h3_fl2v_turbo_8step_v\d+(?:\.\d+)?_768p/i,
      /^minimax_h3_fl2v_turbo_8step/i,
    ]
  }
  return [
    /^minimax_h3_fl2v_turbo_8step_v\d+(?:\.\d+)?_comfyui_bf16\.safetensors$/i,
    /^minimax_h3_fl2v_turbo_8step_v\d+(?:\.\d+)?_768p/i,
    /^minimax_h3_fl2v_turbo_8step/i,
    /^minimax_h3_fl2v_turbo_4step_v1\.2/i,
    /^minimax_h3_fl2v_turbo_4step_v1\.1/i,
    /^minimax_h3_fl2v_turbo_4step_v1\.0/i,
    /^minimax_h3_fl2v_turbo_4step/i,
  ]
}
