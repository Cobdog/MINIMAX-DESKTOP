/** Model overrides — the explicit-pick layer OVER the selection-inference
 *  ladder (task euxwdva).
 *
 * Every engine family resolves its models by inferring them from the
 * directory scan (src/lib/modelSelection.ts's pattern ladder, h3image's
 * inferH3ImgSelection, music3/ace's own). That ladder can only find files
 * whose names match a known pattern — a community merge (TenStrip
 * 10Eros-Max beta5 int8, say) matches nothing and is therefore invisible
 * to generation, no matter that it sits in the scanned folder. This module
 * is the ONE seam where an explicit user pick beats inference:
 *
 *   resolveModels(family, inferredSelection, scan, overrides)
 *
 * RESOLUTION ORDER (the contract every surface documents): chain-level
 * override > global (Settings) override > auto (inference). An absent or
 * empty slot is auto — nothing changes for existing users.
 *
 * Picks are scan-anchored: a slot's value must be the EXACT filename of a
 * scanned file (matched case-insensitively, then canonicalized to the
 * scanned file's real name so a case-drifted pick never loads a filename
 * the engine would reject). Three outcomes per slot:
 *
 *   applied  — the scanned file becomes the slot's selection
 *   degraded — the file vanished from the scan since it was set: fall back
 *              to auto WITH a visible warning (environmental drift, not a
 *              user error — the render may proceed)
 *   refused  — the file is present but the family cannot use it (wrong
 *              kind, no detected H3 form on an H3 checkpoint slot, the T=1
 *              image VAE pushed into the video family, or a slot the family
 *              does not expose): the submission REFUSES with the reason —
 *              never a doomed graph
 *
 * Quant variants (int8 / nvfp4 / fp8 / fp16) are filename-level cuts of the
 * same architecture; the machine-checkable expectation in scan data is the
 * KIND plus — for the H3 checkpoint slots — the safetensors adaln form
 * (ModelFile.h3Form, detected at scan time from tensor shapes, never the
 * filename; see server/modelForms.ts). A wrong-quant pick is therefore not
 * refusable here and is deliberately not guessed at.
 */
import type { ModelFile, ModelOverrideSlots } from '../types'
import { inferH3ImgSelection, T1_IMAGE_VAE_PATTERN } from './graph/h3image'
import { inferAceStepSelections } from './aceStepWorkflow'
import { inferLtx23Selections, inferLtx25Selections, inferSelections } from './modelSelection'
import { inferMusic3Selection } from './music3Workflow'

export type ModelOverrideSlotName = 'checkpoint' | 'textEncoder' | 'vae'

export type ModelFamilyId = 'minimax' | 'h3image' | 'ltx25' | 'ltx23' | 'music3' | 'acestep'

export type ModelFamilyInfo = {
  id: ModelFamilyId
  label: string
  note: string
  /** The slots this family exposes. Omitted slots resolve engine-side
   *  (ltx23's single-file checkpoint arrives through engine combo lists,
   *  outside the six scanner kinds) or are genuinely plural (acestep's two
   *  DISTINCT text encoders — one pick for both would be dishonest). */
  slots: readonly ModelOverrideSlotName[]
  /** The scan kind each exposed slot picks from. */
  slotKinds: Partial<Record<ModelOverrideSlotName, ModelFile['kind']>>
  /** H3 families refuse checkpoint picks with no detected adaln form. */
  requireH3Form: boolean
}

/** The family registry the Settings page and the properties panel render. */
export const MODEL_FAMILIES: readonly ModelFamilyInfo[] = [
  {
    id: 'minimax',
    label: 'MiniMax H3 video',
    note: 'The checkpoint pick drives BOTH FL2VA and Ref2VA — only the render mode\'s slot loads. Text encoder is the Qwen3-VL companion; VAE is the video decoder.',
    slots: ['checkpoint', 'textEncoder', 'vae'],
    slotKinds: { checkpoint: 'diffusion_models', textEncoder: 'text_encoders', vae: 'vae' },
    requireH3Form: true,
  },
  {
    id: 'h3image',
    label: 'MiniMax H3 image workbench',
    note: 'The still-image families share the H3 stack. The checkpoint pick drives FL2VA and Ref2VA; the T=1 image VAE stays inference-pinned (its legality is per-family).',
    slots: ['checkpoint', 'textEncoder', 'vae'],
    slotKinds: { checkpoint: 'diffusion_models', textEncoder: 'text_encoders', vae: 'vae' },
    requireH3Form: true,
  },
  {
    id: 'ltx25',
    label: 'LTX-2.5 video',
    note: 'The LTX-2.5 general engine: diffusion transformer, Gemma text encoder, video VAE. The audio VAE and latent upscaler stay inferred.',
    slots: ['checkpoint', 'textEncoder', 'vae'],
    slotKinds: { checkpoint: 'diffusion_models', textEncoder: 'text_encoders', vae: 'vae' },
    requireH3Form: false,
  },
  {
    id: 'ltx23',
    label: 'LTX-2.3 utilities',
    note: 'The one-graph editing tools. The single-file dev checkpoint resolves through the engine\'s combo list (models/checkpoints is outside the scanner kinds), so only the text encoder and VAE picks are scan-anchored.',
    slots: ['textEncoder', 'vae'],
    slotKinds: { textEncoder: 'text_encoders', vae: 'vae' },
    requireH3Form: false,
  },
  {
    id: 'music3',
    label: 'MiniMax Music 3',
    note: 'The Music 3 song engine: diffusion model, text encoder, DAV VAE.',
    slots: ['checkpoint', 'textEncoder', 'vae'],
    slotKinds: { checkpoint: 'diffusion_models', textEncoder: 'text_encoders', vae: 'vae' },
    requireH3Form: false,
  },
  {
    id: 'acestep',
    label: 'ACE-Step XL 1.5',
    note: 'The checkpoint pick drives both the base and SFT cuts (the model choice decides which loads). The dual Qwen text encoders stay inferred — they are two distinct files.',
    slots: ['checkpoint', 'vae'],
    slotKinds: { checkpoint: 'diffusion_models', vae: 'vae' },
    requireH3Form: false,
  },
]

export function modelFamilyInfo(id: string): ModelFamilyInfo | null {
  for (const family of MODEL_FAMILIES) if (family.id === id) return family
  return null
}

export const SLOT_LABELS: Record<ModelOverrideSlotName, string> = {
  checkpoint: 'Checkpoint / diffusion model',
  textEncoder: 'Text encoder',
  vae: 'VAE',
}

/** How each generic slot lands in the family's concrete selection record.
 *  Multiple fields mean the pick drives every one of them (minimax's ONE
 *  user-facing checkpoint is both fl2va and ref2va — the render mode decides
 *  which loads; acestep's base/sft pair likewise). */
const SLOT_FIELDS: Record<ModelFamilyId, Partial<Record<ModelOverrideSlotName, string[]>>> = {
  minimax: { checkpoint: ['fl2va', 'ref2va'], textEncoder: ['textEncoder'], vae: ['videoVae'] },
  h3image: { checkpoint: ['fl2va', 'ref2va'], textEncoder: ['textEncoder'], vae: ['videoVae'] },
  ltx25: { checkpoint: ['diffusion'], textEncoder: ['textEncoder'], vae: ['videoVae'] },
  ltx23: { textEncoder: ['textEncoder'], vae: ['videoVae'] },
  music3: { checkpoint: ['diffusion'], textEncoder: ['textEncoder'], vae: ['vae'] },
  acestep: { checkpoint: ['base', 'sft'], vae: ['vae'] },
}

/** chain > global, per slot; unset slots stay unset (auto). */
export function mergeModelOverrides(chain?: ModelOverrideSlots, global?: ModelOverrideSlots): ModelOverrideSlots {
  const merged: ModelOverrideSlots = {}
  const source = [chain, global]
  for (const slot of ['checkpoint', 'textEncoder', 'vae'] as ModelOverrideSlotName[]) {
    for (const layer of source) {
      const value = layer?.[slot]
      if (typeof value === 'string' && value.trim()) {
        merged[slot] = value.trim()
        break
      }
    }
  }
  return merged
}

export type OverrideSlotOutcome =
  | { slot: ModelOverrideSlotName; state: 'auto' }
  | { slot: ModelOverrideSlotName; state: 'applied'; file: string }
  | { slot: ModelOverrideSlotName; state: 'degraded'; file: string; warning: string }
  | { slot: ModelOverrideSlotName; state: 'refused'; file: string; reason: string }

export type OverrideResolution = {
  family: ModelFamilyId
  slots: Record<ModelOverrideSlotName, OverrideSlotOutcome>
  /** Wrong-kind picks — submissions refuse with these. */
  refusals: Array<{ slot: ModelOverrideSlotName; file: string; reason: string }>
  /** Missing-file picks — submissions proceed on auto and surface these. */
  warnings: string[]
  /** The applied files per slot (provenance). */
  applied: ModelOverrideSlots
}

function slotRefusal(family: ModelFamilyInfo, slot: ModelOverrideSlotName, file: ModelFile): string | null {
  if (!family.slots.includes(slot)) {
    return `the ${family.label} family does not take a ${SLOT_LABELS[slot].toLowerCase()} pick — it resolves engine-side or stays inferred.`
  }
  const expectedKind = family.slotKinds[slot]
  if (expectedKind && file.kind !== expectedKind) {
    return `'${file.name}' is a ${file.kind.replace(/_/g, ' ')} file — the ${SLOT_LABELS[slot].toLowerCase()} slot picks from ${expectedKind.replace(/_/g, ' ')}.`
  }
  if (family.requireH3Form && slot === 'checkpoint' && !file.h3Form) {
    return `'${file.name}' carries no detectable MiniMax-H3 form (no adaln tensors in its safetensors header) — the H3 graphs would fail to load it.`
  }
  if (slot === 'vae' && (family.id === 'minimax' || family.id === 'h3image') && T1_IMAGE_VAE_PATTERN.test(file.name)) {
    return `'${file.name}' is the Mamad8 T=1 image decoder — pinned to single-frame graphs; pick the video VAE for this family.`
  }
  return null
}

/** Validates one pick against the family contract (the same verdict
 *  resolution and submission produce — one source for UI and ladder). */
export function resolveModelOverrides(familyId: string, files: ModelFile[], overrides?: ModelOverrideSlots): OverrideResolution {
  const family = modelFamilyInfo(familyId) as ModelFamilyInfo | null
  const resolution: OverrideResolution = {
    family: (family?.id ?? 'minimax') as ModelFamilyId,
    slots: { checkpoint: { slot: 'checkpoint', state: 'auto' }, textEncoder: { slot: 'textEncoder', state: 'auto' }, vae: { slot: 'vae', state: 'auto' } },
    refusals: [],
    warnings: [],
    applied: {},
  }
  if (!family) return resolution
  for (const slot of ['checkpoint', 'textEncoder', 'vae'] as ModelOverrideSlotName[]) {
    const pick = overrides?.[slot]
    if (typeof pick !== 'string' || !pick.trim()) continue
    const name = pick.trim()
    // Exact filename against the scan, case-insensitive; the SCANNED file's
    // real name wins so a case-drifted pick never outlives its file.
    let scanned: ModelFile | null = null
    for (const file of files) {
      if (file.name.toLowerCase() === name.toLowerCase()) {
        scanned = file
        break
      }
    }
    if (!scanned) {
      const warning = `Model override '${name}' is no longer in the scan — rendering with the auto (inferred) ${SLOT_LABELS[slot].toLowerCase()} instead.`
      resolution.slots[slot] = { slot, state: 'degraded', file: name, warning }
      resolution.warnings.push(warning)
      continue
    }
    const reason = slotRefusal(family, slot, scanned)
    if (reason) {
      resolution.slots[slot] = { slot, state: 'refused', file: scanned.name, reason }
      resolution.refusals.push({ slot, file: scanned.name, reason })
      continue
    }
    resolution.slots[slot] = { slot, state: 'applied', file: scanned.name }
    resolution.applied[slot] = scanned.name
  }
  return resolution
}

/** One pick's verdict in isolation (the Settings rows and the properties
 *  panel render this; never a second validation path). */
export function overridePickOutcome(familyId: ModelFamilyId, slot: ModelOverrideSlotName, name: string, files: ModelFile[]): OverrideSlotOutcome {
  return resolveModelOverrides(familyId, files, { [slot]: name }).slots[slot]
}

/** Applies a resolution's applied slots onto the family's concrete selection
 *  (generic: field names per SLOT_FIELDS). Degraded/refused slots stay on the
 *  inference result — refusals block the submission, degradations warn. */
export function applyModelOverrides<T extends Record<string, unknown>>(familyId: ModelFamilyId, selection: T, resolution: OverrideResolution): T {
  const fields = SLOT_FIELDS[familyId]
  if (!fields) return selection
  const next: Record<string, unknown> = { ...selection }
  for (const slot of ['checkpoint', 'textEncoder', 'vae'] as ModelOverrideSlotName[]) {
    const outcome = resolution.slots[slot]
    if (outcome.state !== 'applied') continue
    const targets = fields[slot]
    if (!targets) continue
    for (const field of targets) next[field] = outcome.file
  }
  return next as T
}

/** THE SEAM: one call from any surface — inferred selection in, resolved
 *  selection + honest resolution out. `inferred` is the family's own
 *  inference output (untouched; every family keeps its ladder). */
export function resolveModels<T extends Record<string, unknown>>(familyId: ModelFamilyId, inferred: T, files: ModelFile[], overrides?: ModelOverrideSlots): { selection: T; resolution: OverrideResolution } {
  const resolution = resolveModelOverrides(familyId, files, overrides)
  return { selection: applyModelOverrides(familyId, inferred, resolution), resolution }
}

/** What AUTO would use for one slot right now (the label beside the 'auto
 *  (inferred)' option, so the user sees exactly what they are overriding).
 *  Runs the family's own inference untouched; '' when nothing resolves. The
 *  minimax/h3image checkpoint label shows the FL2VA pick (the slot's primary
 *  field; Ref2VA rides the same pick). */
export function inferredOverrideSlotFile(familyId: ModelFamilyId, slot: ModelOverrideSlotName, files: ModelFile[]): string {
  const primary = SLOT_FIELDS[familyId][slot]?.[0]
  if (!primary) return ''
  let record: Record<string, unknown> | null = null
  if (familyId === 'minimax') record = inferSelections(files, 'off')
  else if (familyId === 'h3image') record = inferH3ImgSelection(files)
  else if (familyId === 'ltx25') record = inferLtx25Selections(files, [])
  else if (familyId === 'ltx23') record = inferLtx23Selections(files, { checkpoints: [], latentUpscalers: [] })
  else if (familyId === 'music3') record = inferMusic3Selection(files)
  else if (familyId === 'acestep') record = inferAceStepSelections(files)
  const value = record ? record[primary] : undefined
  return typeof value === 'string' ? value : ''
}
