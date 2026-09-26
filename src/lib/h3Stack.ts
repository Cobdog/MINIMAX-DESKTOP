/** The H3 stack report — DERIVED, never parallel (maintainer ruling
 *  2026-09-26: "the auto inferred models are there, the H3 Engine Stack
 *  reports are incorrect").
 *
 *  This module once carried its own expectation table — hardcoded expected
 *  filenames plus anchored fallback regexes per slot — a SECOND source of
 *  truth beside the inference ladders. The pickers resolved the
 *  maintainer's real files (substring + size-class anchors) while the
 *  table's regexes demanded tokens the ladders never require (the
 *  `_minimax_h3_` infix), so present models read MISSING while the UI
 *  showed them inferred. PR #52's basename fix addressed the comparison;
 *  the root was the parallel table itself. The report now resolves every
 *  slot through the SAME code path submit uses — inferSelections' ladders
 *  + the override seam (resolveModels) — and states, per row: the RESOLVED
 *  model (what the graph will load, registry name verbatim), its source
 *  layer (override/global/inferred), presence truth, and — display
 *  guidance ONLY — the canonical official artifact. A slot with no
 *  resolution reads as the honest empty state with inference-shaped
 *  guidance, never missing-because-unlisted; a found-but-refused pick (or
 *  a resolved TE of the wrong dimension class) narrates the existing
 *  refusal machinery's reason and blocks readiness, exactly like the
 *  submission would. */
import type { ModelFile, ModelSelection, ModelOverrideSlots } from '../types'
import type { ObjectInfo } from './comfyInfo'
import { dbg } from './dbg'
import { basenameOf, inferSelections, teDimClassRefusal } from './modelSelection'
import { resolveModels, type ModelOverrideSlotName } from './modelOverrides'
import { missingCoreNodeClasses, type MissingNodeClass } from './preflight'

export const diagnosticPrompt = 'A woman standing beside a window in soft daylight, natural skin texture, subtle head movement, realistic cinematic photography.'

/** The canonical official stack and per-slot display guidance — GUIDANCE
 *  ONLY, never validation. `canonical` names the official artifact the row
 *  hints at when the resolved file differs; `makeVisible` is the
 *  inference-shaped guidance shown when NOTHING resolves (what shape of
 *  name the ladder would pick up — read from the ladders in
 *  modelSelection.ts / the turbo registry; the ladders own the truth).
 *  `tier` + `field` say WHERE the row's resolution lives: the same
 *  inferSelections call the submit path runs, at the tier the row names. */
const stackSlots = [
  { label: 'FL2VA', kind: 'diffusion_models' as const, canonical: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', tier: 'off' as const, field: 'fl2va' as const, overrideSlot: 'fl2va' as ModelOverrideSlotName, makeVisible: 'a diffusion-model file whose name contains "fl2va" (the first-frame lane)' },
  { label: 'Text encoder', kind: 'text_encoders' as const, canonical: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', tier: 'off' as const, field: 'textEncoder' as const, overrideSlot: 'textEncoder' as ModelOverrideSlotName, makeVisible: 'a 32B-class qwen3vl text encoder (a name containing "qwen3vl_32b" — the 4B/8B companions are the wrong dimension class and refuse)' },
  { label: 'Video VAE', kind: 'vae' as const, canonical: 'minimax_h3_video_vae_fp16.safetensors', tier: 'off' as const, field: 'videoVae' as const, overrideSlot: 'videoVae' as ModelOverrideSlotName, makeVisible: 'a VAE whose name contains "video_vae"' },
  { label: 'Audio VAE', kind: 'vae' as const, canonical: 'minimax_h3_audio_vae_fp32.safetensors', tier: 'off' as const, field: 'audioVae' as const, overrideSlot: 'audioVae' as ModelOverrideSlotName, makeVisible: 'a VAE whose name contains "audio_vae"' },
  { label: 'Turbo 8', kind: 'loras' as const, canonical: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors', tier: '8' as const, field: 'fl2vLora' as const, overrideSlot: null, makeVisible: 'the official 8-step turbo LoRA or a lightx2v fl2v 8-step name — the turbo ladder is anchored on purpose (no loose fallback: a wrong-tier pick is worse than none)' },
]

export type H3StackSlotRow = {
  label: string
  kind: ModelFile['kind']
  /** The canonical official artifact — DISPLAY guidance only, never a gate. */
  canonical: string
  /** The RESOLVED model the graph will load (registry name, verbatim); ''
   *  when nothing resolves — see makeVisible for what naming to surface. */
  selected: string
  /** Which layer produced the selection: 'override' (a pick applied) or
   *  'inferred' (the ladder); '' when nothing resolves. */
  source: 'override' | 'inferred' | ''
  /** The override layer that applied ('chain'|'global'); undefined for
   *  inferred rows and picks that only legacy migration filled. */
  layer?: 'chain' | 'global'
  /** Presence truth: the registry lists the resolved name verbatim. */
  present: boolean
  /** The resolved basename IS the canonical artifact (display hint). */
  isCanonical: boolean
  /** Found but refused — the existing refusal machinery's reason (an
   *  override pick the family contract rejects, or the TE dimension-class
   *  guard on the resolved encoder). Submission refuses; so does readiness. */
  refusal?: string
  /** Inference-shaped guidance for the empty state: what naming resolves. */
  makeVisible: string
}

/** The report is the SAME resolution the graphs will use, narrated. For each
 *  slot it resolves through inferSelections + the override seam — the store's
 *  selectionFor code path, not a fork — and the row states what the graph
 *  will load, from which layer, with presence truth. `overrides` here is the
 *  SETTINGS-level (global) layer both surfaces pass; per-chain picks surface
 *  in the chain properties panel, so the layer attribution names 'global'.
 *
 *  Verdicts: `validated` is a DISPLAY statement (every slot resolves to the
 *  canonical official artifact — the pill's vocabulary, never a gate).
 *  `ready` is the honest usability verdict the doctor/wizard surfaces keep:
 *  every slot resolves + present, nothing refused (override refusal or the
 *  TE dimension class — the same checks the submit validate rung runs), and
 *  the engine serves the H3 core node classes (R-29: weights cannot fix a
 *  node class).
 *
 *  (R-29, audit C F7) With an object_info snapshot at hand the report also
 *  checks the ENGINE side: an instance a version behind serves every file
 *  check yet fails at render. `nodes.missing` names the h3-video core
 *  classes the engine does not serve, and `ready` is false while any are
 *  missing. No snapshot (or an empty one) keeps the file-only verdict: the
 *  connection rung owns that refusal. */
export function h3StackReport(models: ModelFile[], overrides?: ModelOverrideSlots, info?: ObjectInfo | Record<string, unknown>) {
  const quality = resolveModels('minimax', inferSelections(models, 'off'), models, overrides, { global: overrides })
  const turbo = resolveModels('minimax', inferSelections(models, '8'), models, overrides, { global: overrides })
  const byTier: Record<'off' | '8', { selection: ModelSelection }> = { off: quality, '8': turbo }
  const rows: H3StackSlotRow[] = stackSlots.map((definition) => {
    const selected = byTier[definition.tier].selection[definition.field]
    const outcome = definition.overrideSlot ? quality.resolution.slots[definition.overrideSlot] : null
    const applied = outcome && outcome.state === 'applied' ? outcome : null
    const refused = outcome && outcome.state === 'refused' ? outcome : null
    // (eyzcev5 composition) The submit validate rung runs the TE
    // dimension-class guard on the RESOLVED selection — best-available can
    // resolve a 4B-class encoder NON-EMPTY (the crash class the old
    // readiness could not see). The row narrates the same verdict.
    const teRefusal = definition.overrideSlot === 'textEncoder' && selected ? teDimClassRefusal('minimax', selected) : null
    const refusal = refused ? refused.reason : (teRefusal ?? undefined)
    const row: H3StackSlotRow = {
      label: definition.label,
      kind: definition.kind,
      canonical: definition.canonical,
      selected,
      source: applied ? 'override' : selected ? 'inferred' : '',
      ...(applied && applied.layer ? { layer: applied.layer } : {}),
      present: Boolean(selected) && models.some((model) => model.name === selected),
      isCanonical: Boolean(selected) && basenameOf(selected).toLowerCase() === definition.canonical.toLowerCase(),
      ...(refusal ? { refusal } : {}),
      makeVisible: definition.makeVisible,
    }
    // (A-DBG) The per-slot junction: the report narrates the same trace the
    // picker used — what resolved, from which layer, and any refusal.
    dbg('h3stack.slot', { slot: definition.label, picked: selected || '(none)', source: row.source || 'none', canonical: row.isCanonical, ...(refusal ? { refused: true } : {}) })
    return row
  })
  const missingNodes: MissingNodeClass[] = missingCoreNodeClasses(info, 'h3-video')
  return {
    rows,
    validated: rows.every((row) => row.present && row.isCanonical),
    ready: rows.every((row) => row.present) && rows.every((row) => !row.refusal) && missingNodes.length === 0,
    warnings: quality.resolution.warnings,
    nodes: { missing: missingNodes },
  }
}

export function findH3PreviewOverrideNode(info: ObjectInfo) {
  return Object.keys(info).find((name) => name === 'MiniMaxH3PreviewOverrideCS')
    ?? Object.keys(info).find((name) => /minimax.*h3.*preview.*override/i.test(name))
}
