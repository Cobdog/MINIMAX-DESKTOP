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
 *
 * The H3 form gate is SOURCE-AWARE (task rq0lsax, 2026-09-20): the form tag
 * exists only where the studio could open the file — local-root rows. An
 * instance-sourced row ('source: instance' or 'both', the engine-relative
 * names the connected engine lists) carries no header read (see
 * server/instanceInventory.ts — the instance API lists filenames only), so a
 * missing form there is MISSING EVIDENCE, not evidence of a wrong file: the
 * pick applies with a warning and the engine stays the final arbiter (it
 * loads the file or fails loudly). Local rows keep the hard refusal — there
 * the header read genuinely ran and found no H3 shape.
 *
 * The H3 families expose THREE checkpoint-class slots (rq0lsax): fl2va (the
 * first-frame/I2V lane), ref2va (the reference lane), and merged (ONE
 * pre-merged checkpoint standing in for both — the runtime-merge machinery
 * exists precisely so nobody HAS to pre-merge, but a community merge on disk
 * is the merge slot's reason to exist). When the merged pick applies it is
 * THE checkpoint — it fills both lanes, and simultaneously-set lane picks
 * get an explicit superseded warning (never a silent drop). The pre-split
 * single 'checkpoint' pick migrates onto fl2va AND ref2va (see
 * migrateLegacyModelOverrideSlots).
 */
import type { ModelFile, ModelOverrideSlots } from '../types'
import { inferH3ImgSelection, T1_IMAGE_VAE_PATTERN } from './graph/h3image'
import { inferAceStepSelections } from './aceStepWorkflow'
import { inferLtx23Selections, inferLtx25Selections, inferSelections } from './modelSelection'
import { inferMusic3Selection } from './music3Workflow'

export type ModelOverrideSlotName = 'checkpoint' | 'fl2va' | 'ref2va' | 'merged' | 'textEncoder' | 'vae'

/** Every slot key in resolution order (the generic 'checkpoint' first, then
 *  the H3 per-lane trio, then the shared encoder/VAE picks). */
export const OVERRIDE_SLOTS: readonly ModelOverrideSlotName[] = ['checkpoint', 'fl2va', 'ref2va', 'merged', 'textEncoder', 'vae']

/** The diffusion-model slots the H3 form gate governs. */
const CHECKPOINT_CLASS_SLOTS: ReadonlySet<ModelOverrideSlotName> = new Set(['checkpoint', 'fl2va', 'ref2va', 'merged'])

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
    note: 'The FL2VA and Ref2VA picks pin each render lane separately — only the mode\'s slot loads. The merged pick is ONE pre-merged checkpoint standing in for both lanes when set (unused unless needed). Text encoder is the Qwen3-VL companion; VAE is the video decoder.',
    slots: ['fl2va', 'ref2va', 'merged', 'textEncoder', 'vae'],
    slotKinds: { fl2va: 'diffusion_models', ref2va: 'diffusion_models', merged: 'diffusion_models', textEncoder: 'text_encoders', vae: 'vae' },
    requireH3Form: true,
  },
  {
    id: 'h3image',
    label: 'MiniMax H3 image workbench',
    note: 'The still-image families share the H3 stack. FL2VA and Ref2VA pin the stock lanes (and the runtime-merge loader\'s base/overlay inputs); the merged pick feeds the hybrid line as one plain-loaded file — a pre-merged checkpoint needs no runtime merge. The T=1 image VAE stays inference-pinned (its legality is per-family).',
    slots: ['fl2va', 'ref2va', 'merged', 'textEncoder', 'vae'],
    slotKinds: { fl2va: 'diffusion_models', ref2va: 'diffusion_models', merged: 'diffusion_models', textEncoder: 'text_encoders', vae: 'vae' },
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
  fl2va: 'FL2VA checkpoint (first-frame lane)',
  ref2va: 'Ref2VA checkpoint (reference lane)',
  merged: 'Merged checkpoint (both lanes)',
  textEncoder: 'Text encoder',
  vae: 'VAE',
}

/** How each generic slot lands in the family's concrete selection record.
 *  Multiple fields mean the pick drives every one of them (acestep's
 *  base/sft pair: the model choice decides which loads). The H3 families'
 *  per-lane slots each drive their OWN field — the render mode picks the
 *  lane downstream (the video factory's UNETLoader and the workbench's
 *  stock branches) — and the merged slot additionally fills both lanes in
 *  applyModelOverrides (it IS both models). */
const SLOT_FIELDS: Record<ModelFamilyId, Partial<Record<ModelOverrideSlotName, string[]>>> = {
  minimax: { fl2va: ['fl2va'], ref2va: ['ref2va'], merged: ['merged'], textEncoder: ['textEncoder'], vae: ['videoVae'] },
  h3image: { fl2va: ['fl2va'], ref2va: ['ref2va'], merged: ['merged'], textEncoder: ['textEncoder'], vae: ['videoVae'] },
  ltx25: { checkpoint: ['diffusion'], textEncoder: ['textEncoder'], vae: ['videoVae'] },
  ltx23: { textEncoder: ['textEncoder'], vae: ['videoVae'] },
  music3: { checkpoint: ['diffusion'], textEncoder: ['textEncoder'], vae: ['vae'] },
  acestep: { checkpoint: ['base', 'sft'], vae: ['vae'] },
}

/** The families whose checkpoint slot split into the per-lane trio (rq0lsax). */
const H3_LANE_FAMILIES: ReadonlySet<string> = new Set(['minimax', 'h3image'])

/** Legacy migration (rq0lsax, dated decision 2026-09-20): the pre-split
 *  single 'checkpoint' pick on an H3 family drove BOTH lanes (fl2va and
 *  ref2va — the old SLOT_FIELDS pair), so it migrates onto fl2va AND
 *  ref2va, fill-if-unset — never silently dropped, and behavior-preserving
 *  (an existing user's reference-mode renders keep loading the picked file
 *  exactly as before; fl2va-only would have silently re-inferred the
 *  reference lane). Non-H3 families keep 'checkpoint'; an empty/absent
 *  legacy pick is a no-op. */
export function migrateLegacyModelOverrideSlots(familyId: string, slots?: ModelOverrideSlots): ModelOverrideSlots {
  if (!slots || typeof slots.checkpoint !== 'string' || !slots.checkpoint.trim() || !H3_LANE_FAMILIES.has(familyId)) return slots ?? {}
  const next: ModelOverrideSlots = { ...slots }
  delete next.checkpoint
  if (!next.fl2va) next.fl2va = slots.checkpoint.trim()
  if (!next.ref2va) next.ref2va = slots.checkpoint.trim()
  return next
}

/** chain > global, per slot; unset slots stay unset (auto). */
export function mergeModelOverrides(chain?: ModelOverrideSlots, global?: ModelOverrideSlots): ModelOverrideSlots {
  const merged: ModelOverrideSlots = {}
  const source = [chain, global]
  for (const slot of OVERRIDE_SLOTS) {
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
  | { slot: ModelOverrideSlotName; state: 'applied'; file: string; warning?: string }
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

/** Which contract check produced a refusal — the form gate is the one the
 *  resolution may convert to a warning for instance-sourced rows. */
type SlotRefusal = { check: 'slot' | 'kind' | 'form' | 'vae'; reason: string }

function slotRefusal(family: ModelFamilyInfo, slot: ModelOverrideSlotName, file: ModelFile): SlotRefusal | null {
  if (!family.slots.includes(slot)) {
    return { check: 'slot', reason: `the ${family.label} family does not take a ${SLOT_LABELS[slot].toLowerCase()} pick — it resolves engine-side or stays inferred.` }
  }
  const expectedKind = family.slotKinds[slot]
  if (expectedKind && file.kind !== expectedKind) {
    return { check: 'kind', reason: `'${file.name}' is a ${file.kind.replace(/_/g, ' ')} file — the ${SLOT_LABELS[slot].toLowerCase()} slot picks from ${expectedKind.replace(/_/g, ' ')}.` }
  }
  if (family.requireH3Form && CHECKPOINT_CLASS_SLOTS.has(slot) && !file.h3Form) {
    return { check: 'form', reason: `'${file.name}' carries no detectable MiniMax-H3 form (no adaln tensors in its safetensors header) — the H3 graphs would fail to load it.` }
  }
  if (slot === 'vae' && (family.id === 'minimax' || family.id === 'h3image') && T1_IMAGE_VAE_PATTERN.test(file.name)) {
    return { check: 'vae', reason: `'${file.name}' is the Mamad8 T=1 image decoder — pinned to single-frame graphs; pick the video VAE for this family.` }
  }
  return null
}

/** Validates one pick against the family contract (the same verdict
 *  resolution and submission produce — one source for UI and ladder). */
export function resolveModelOverrides(familyId: string, files: ModelFile[], overrides?: ModelOverrideSlots): OverrideResolution {
  const family = modelFamilyInfo(familyId) as ModelFamilyInfo | null
  const resolution: OverrideResolution = {
    family: (family?.id ?? 'minimax') as ModelFamilyId,
    slots: {
      checkpoint: { slot: 'checkpoint', state: 'auto' },
      fl2va: { slot: 'fl2va', state: 'auto' },
      ref2va: { slot: 'ref2va', state: 'auto' },
      merged: { slot: 'merged', state: 'auto' },
      textEncoder: { slot: 'textEncoder', state: 'auto' },
      vae: { slot: 'vae', state: 'auto' },
    },
    refusals: [],
    warnings: [],
    applied: {},
  }
  if (!family) return resolution
  const effective = migrateLegacyModelOverrideSlots(familyId, overrides)
  for (const slot of OVERRIDE_SLOTS) {
    const pick = effective[slot]
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
    const refusal = slotRefusal(family, slot, scanned)
    if (refusal) {
      // The source-aware form gate (rq0lsax): an instance-listed row has no
      // header to read, so a missing form is missing EVIDENCE, not a wrong
      // file — the pick applies with a warning and the engine stays the
      // final arbiter. Local rows (the header read genuinely ran and found
      // no H3 shape) keep the hard refusal above.
      if (refusal.check === 'form' && (scanned.source === 'instance' || scanned.source === 'both')) {
        const warning = `'${scanned.name}' is instance-listed — its MiniMax-H3 form cannot be verified from the instance inventory (the listing carries no safetensors header). Applying the pick as chosen; the engine loads it or fails loudly.`
        resolution.slots[slot] = { slot, state: 'applied', file: scanned.name, warning }
        resolution.applied[slot] = scanned.name
        resolution.warnings.push(warning)
        continue
      }
      resolution.slots[slot] = { slot, state: 'refused', file: scanned.name, reason: refusal.reason }
      resolution.refusals.push({ slot, file: scanned.name, reason: refusal.reason })
      continue
    }
    resolution.slots[slot] = { slot, state: 'applied', file: scanned.name }
    resolution.applied[slot] = scanned.name
  }
  // The merged pick is THE checkpoint when it applies — simultaneously-set
  // lane picks are superseded, and the resolution SAYS so (never a silent
  // drop; the submission surfaces these like every other warning).
  const mergedOutcome = resolution.slots.merged
  if (mergedOutcome.state === 'applied') {
    for (const lane of ['fl2va', 'ref2va'] as const) {
      const laneOutcome = resolution.slots[lane]
      if (laneOutcome.state === 'applied') {
        resolution.warnings.push(`Model override '${laneOutcome.file}' (${SLOT_LABELS[lane]}) is superseded by the merged checkpoint pick '${mergedOutcome.file}' — clear one of the two if this is unintended.`)
      }
    }
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
 *  inference result — refusals block the submission, degradations warn.
 *  The H3 merged pick additionally fills BOTH lane fields (it IS both
 *  models): the video factory's per-mode UNETLoader and every readiness
 *  gate then carry it with zero further plumbing, and the workbench's
 *  builder sees selection.merged to skip the runtime merge. */
export function applyModelOverrides<T extends Record<string, unknown>>(familyId: ModelFamilyId, selection: T, resolution: OverrideResolution): T {
  const fields = SLOT_FIELDS[familyId]
  if (!fields) return selection
  const next: Record<string, unknown> = { ...selection }
  for (const slot of OVERRIDE_SLOTS) {
    const outcome = resolution.slots[slot]
    if (outcome.state !== 'applied') continue
    const targets = fields[slot]
    if (!targets) continue
    for (const field of targets) next[field] = outcome.file
  }
  const mergedOutcome = resolution.slots.merged
  if (mergedOutcome.state === 'applied') {
    next.fl2va = mergedOutcome.file
    next.ref2va = mergedOutcome.file
    next.merged = mergedOutcome.file
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
 *  H3 per-lane labels show each lane's own inference; the merged slot never
 *  infers (community merges are name-invisible BY DESIGN — that is this
 *  layer's reason to exist), so its auto label honestly reads 'nothing
 *  detected'. */
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
