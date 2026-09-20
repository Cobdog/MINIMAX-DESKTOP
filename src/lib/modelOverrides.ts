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
 *
 * The VAE slots split by DECODER CLASS (task epdvxd4): videoVae, audioVae,
 * and imageVae (the Mamad8 T=1 decoder) replace the old single 'vae' pick.
 * The graphs load DISTINCT decoders — the H3 video/workbench graphs carry a
 * video VAELoader (node 3) AND an audio VAELoader (node 4), the T=1 Fast
 * profile decodes through its own image VAE, the LTX engines carry the same
 * video/audio pair, and the audio-only engines' (music3/acestep) one VAE is
 * audio-class — so a single 'vae' entry could reach only ever one of them.
 * Slot legality is per family (IMAGE_VAE_FAMILIES): the imageVae pick
 * exists only where a single-frame graph can legally consume it; the video
 * family refuses it outright (every video graph is multi-frame — the
 * factory-level Mamad8 ban). Cross-class picks refuse at the seam (the
 * marker heuristics at VIDEO_VAE_MARKER document their own limits).
 */
import type { ModelFile, ModelOverrideSlots } from '../types'
import { inferH3ImgSelection, T1_IMAGE_VAE_PATTERN } from './graph/h3image'
import { inferAceStepSelections } from './aceStepWorkflow'
import { inferLtx23Selections, inferLtx25Selections, inferSelections } from './modelSelection'
import { inferMusic3Selection } from './music3Workflow'

export type ModelOverrideSlotName = 'checkpoint' | 'fl2va' | 'ref2va' | 'merged' | 'textEncoder' | 'vae' | 'videoVae' | 'audioVae' | 'imageVae'

/** Every slot key in resolution order (the generic 'checkpoint' first, then
 *  the H3 per-lane trio, then the shared encoder pick, then the decoder-split
 *  VAE trio). The trailing 'vae' key is LEGACY (task epdvxd4): migrate
 *  consumes it before the resolution loop ever reads it — it stays listed so
 *  mergeModelOverrides never drops a stored pick ahead of the migration seam
 *  (the same trick that keeps a legacy 'checkpoint' alive for the H3 lanes). */
export const OVERRIDE_SLOTS: readonly ModelOverrideSlotName[] = ['checkpoint', 'fl2va', 'ref2va', 'merged', 'textEncoder', 'vae', 'videoVae', 'audioVae', 'imageVae']

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

/** The T=1 legality map (task epdvxd4, AC-4): the imageVae slot exists ONLY
 *  where a single-frame graph legally decodes through the Mamad8 decoder.
 *  The video family's EVERY graph is multi-frame (frameCount floors at 5),
 *  so per the factory-level ban (assertNoT1ImageVaeInVideoGraph) it exposes
 *  no imageVae slot at all — a pick there is refused as unexposed, never a
 *  silent maybe-corruption. The workbench's T=1 Fast profile is the one
 *  legal consumer; its packet/compose/edit siblings never touch the slot's
 *  field. The LTX families have no T=1 image decoder at all. */
export const IMAGE_VAE_FAMILIES: ReadonlySet<ModelFamilyId> = new Set(['h3image'])

/** The family registry the Settings page and the properties panel render. */
export const MODEL_FAMILIES: readonly ModelFamilyInfo[] = [
  {
    id: 'minimax',
    label: 'MiniMax H3 video',
    note: 'The FL2VA and Ref2VA picks pin each render lane separately — only the mode\'s slot loads. The merged pick is ONE pre-merged checkpoint standing in for both lanes when set (unused unless needed). Text encoder is the Qwen3-VL companion; the video and audio VAE picks load the graph\'s two decoders (nodes 3/4). No image-VAE slot exists here — the video graph is always multi-frame and the Mamad8 T=1 decoder is factory-banned from it.',
    slots: ['fl2va', 'ref2va', 'merged', 'textEncoder', 'videoVae', 'audioVae'],
    slotKinds: { fl2va: 'diffusion_models', ref2va: 'diffusion_models', merged: 'diffusion_models', textEncoder: 'text_encoders', videoVae: 'vae', audioVae: 'vae' },
    requireH3Form: true,
  },
  {
    id: 'h3image',
    label: 'MiniMax H3 image workbench',
    note: 'The still-image families share the H3 stack. FL2VA and Ref2VA pin the stock lanes (and the runtime-merge loader\'s base/overlay inputs); the merged pick feeds the hybrid line as one plain-loaded file — a pre-merged checkpoint needs no runtime merge. The video/audio VAE picks load nodes 3/4; the image VAE pick is the Mamad8 T=1 decoder the T=1 Fast profile decodes through (the only family where it is legal).',
    slots: ['fl2va', 'ref2va', 'merged', 'textEncoder', 'videoVae', 'audioVae', 'imageVae'],
    slotKinds: { fl2va: 'diffusion_models', ref2va: 'diffusion_models', merged: 'diffusion_models', textEncoder: 'text_encoders', videoVae: 'vae', audioVae: 'vae', imageVae: 'vae' },
    requireH3Form: true,
  },
  {
    id: 'ltx25',
    label: 'LTX-2.5 video',
    note: 'The LTX-2.5 general engine: diffusion transformer, Gemma text encoder, and the graph\'s two decoders — the video VAE (node 3) and the audio VAE (node 4). The latent upscaler stays inferred (engine combo list).',
    slots: ['checkpoint', 'textEncoder', 'videoVae', 'audioVae'],
    slotKinds: { checkpoint: 'diffusion_models', textEncoder: 'text_encoders', videoVae: 'vae', audioVae: 'vae' },
    requireH3Form: false,
  },
  {
    id: 'ltx23',
    label: 'LTX-2.3 utilities',
    note: 'The one-graph editing tools. The single-file dev checkpoint resolves through the engine\'s combo list (models/checkpoints is outside the scanner kinds), so only the text encoder and the split-weights VAE picks (video/audio, the Obscura Remova lane) are scan-anchored.',
    slots: ['textEncoder', 'videoVae', 'audioVae'],
    slotKinds: { textEncoder: 'text_encoders', videoVae: 'vae', audioVae: 'vae' },
    requireH3Form: false,
  },
  {
    id: 'music3',
    label: 'MiniMax Music 3',
    note: 'The Music 3 song engine: diffusion model, text encoder, and the DAV audio VAE — the family\'s one decoder is audio-class.',
    slots: ['checkpoint', 'textEncoder', 'audioVae'],
    slotKinds: { checkpoint: 'diffusion_models', textEncoder: 'text_encoders', audioVae: 'vae' },
    requireH3Form: false,
  },
  {
    id: 'acestep',
    label: 'ACE-Step XL 1.5',
    note: 'The checkpoint pick drives both the base and SFT cuts (the model choice decides which loads). The audio VAE is the family\'s one decoder (audio-class). The dual Qwen text encoders stay inferred — they are two distinct files.',
    slots: ['checkpoint', 'audioVae'],
    slotKinds: { checkpoint: 'diffusion_models', audioVae: 'vae' },
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
  vae: 'VAE (legacy)',
  videoVae: 'Video VAE',
  audioVae: 'Audio VAE',
  imageVae: 'Image VAE (T=1)',
}

/** How each generic slot lands in the family's concrete selection record.
 *  Multiple fields mean the pick drives every one of them (acestep's
 *  base/sft pair: the model choice decides which loads). The H3 families'
 *  per-lane slots each drive their OWN field — the render mode picks the
 *  lane downstream (the video factory's UNETLoader and the workbench's
 *  stock branches) — and the merged slot additionally fills both lanes in
 *  applyModelOverrides (it IS both models). The VAE trio drives the
 *  DECODER-named fields (task epdvxd4): videoVae/audioVae reach their own
 *  VAELoader nodes; imageVae drives h3image's t1ImageVae, which the T=1
 *  Fast profile substitutes at ITS decode node. The audio-only families'
 *  one decoder field is literally named 'vae' — the audioVae slot's target
 *  there is still the audio-class file. */
const SLOT_FIELDS: Record<ModelFamilyId, Partial<Record<ModelOverrideSlotName, string[]>>> = {
  minimax: { fl2va: ['fl2va'], ref2va: ['ref2va'], merged: ['merged'], textEncoder: ['textEncoder'], videoVae: ['videoVae'], audioVae: ['audioVae'] },
  h3image: { fl2va: ['fl2va'], ref2va: ['ref2va'], merged: ['merged'], textEncoder: ['textEncoder'], videoVae: ['videoVae'], audioVae: ['audioVae'], imageVae: ['t1ImageVae'] },
  ltx25: { checkpoint: ['diffusion'], textEncoder: ['textEncoder'], videoVae: ['videoVae'], audioVae: ['audioVae'] },
  ltx23: { textEncoder: ['textEncoder'], videoVae: ['videoVae'], audioVae: ['audioVae'] },
  music3: { checkpoint: ['diffusion'], textEncoder: ['textEncoder'], audioVae: ['vae'] },
  acestep: { checkpoint: ['base', 'sft'], audioVae: ['vae'] },
}

/** The families whose checkpoint slot split into the per-lane trio (rq0lsax). */
const H3_LANE_FAMILIES: ReadonlySet<string> = new Set(['minimax', 'h3image'])

/** The families whose legacy single 'vae' pick meant the VIDEO decoder
 *  (epdvxd4) — their graphs load a video+audio VAELoader pair and the old
 *  slot drove only the video one. */
const VIDEO_VAE_FAMILIES: ReadonlySet<string> = new Set(['minimax', 'h3image', 'ltx25', 'ltx23'])

/** The families whose legacy single 'vae' pick meant the AUDIO decoder
 *  (epdvxd4) — their one decoder is audio-class (music3's DAV, ACE-Step's
 *  audio VAE), so landing the legacy pick anywhere else would refuse-and-
 *  drop the user's working pick. */
const AUDIO_VAE_FAMILIES: ReadonlySet<string> = new Set(['music3', 'acestep'])

/** Legacy migration (rq0lsax, dated decision 2026-09-20): the pre-split
 *  single 'checkpoint' pick on an H3 family drove BOTH lanes (fl2va and
 *  ref2va — the old SLOT_FIELDS pair), so it migrates onto fl2va AND
 *  ref2va, fill-if-unset — never silently dropped, and behavior-preserving
 *  (an existing user's reference-mode renders keep loading the picked file
 *  exactly as before; fl2va-only would have silently re-inferred the
 *  reference lane). Non-H3 families keep 'checkpoint'; an empty/absent
 *  legacy pick is a no-op.
 *
 *  The VAE arm (epdvxd4, dated decision 2026-09-20): the pre-split single
 *  'vae' pick migrates onto the slot that PRESERVES its meaning per family —
 *  videoVae where the old slot drove the video decoder (the H3/LTX video
 *  families), audioVae where the family's one decoder is audio-class
 *  (music3/acestep). Fill-if-unset; the consumed key never re-refuses as
 *  an unexposed slot; an empty/absent pick is a no-op.
 *
 *  DECODER-CLASS ROUTING (tmz8vh7, dated decision 2026-09-20): the pre-split
 *  slot's dropdown listed EVERY scanned VAE file, so the pick's NAME is the
 *  only evidence of which decoder the user actually pinned — and a pick that
 *  migrates onto a slot its class REFUSES wedges every render in the family.
 *  This is the maintainer's first-session T=1 report verbatim: a pre-split
 *  pick of the Mamad8 T=1 decoder migrated onto videoVae and refused every
 *  video submit ("Model override refused — videoVae: … Mamad8 T=1 image
 *  decoder…"), invisible in the UI (no 'vae' row exists post-split, and the
 *  chain panel only verdicts the chain's OWN pick). Marked names therefore
 *  route to the slot where they are LEGAL: T=1-named onto imageVae (only
 *  h3image exposes it), audio-named onto audioVae on the video families,
 *  video-named onto videoVae; a marked name NO slot in the family can load
 *  (T=1 on a pure video family, video-class on an audio family) drops — it
 *  was already unrenderable pre-split (the factory guard threw), so dropping
 *  restores the honest state instead of propagating the wedge. Unmarked
 *  names keep the family-meaning landing above. */
export function migrateLegacyModelOverrideSlots(familyId: string, slots?: ModelOverrideSlots): ModelOverrideSlots {
  if (!slots) return {}
  let next: ModelOverrideSlots | null = null
  if (typeof slots.checkpoint === 'string' && slots.checkpoint.trim() && H3_LANE_FAMILIES.has(familyId)) {
    next = { ...slots }
    delete next.checkpoint
    if (!next.fl2va) next.fl2va = slots.checkpoint.trim()
    if (!next.ref2va) next.ref2va = slots.checkpoint.trim()
  }
  if (typeof slots.vae === 'string' && slots.vae.trim()) {
    const legacyVae = slots.vae.trim()
    const t1Class = T1_IMAGE_VAE_PATTERN.test(legacyVae)
    const audioClass = AUDIO_VAE_MARKER.test(legacyVae)
    const videoClass = VIDEO_VAE_MARKER.test(legacyVae)
    if (VIDEO_VAE_FAMILIES.has(familyId)) {
      next = next ?? { ...slots }
      if (t1Class && familyId === 'h3image') {
        if (!next.imageVae) next.imageVae = legacyVae
      } else if (audioClass && !t1Class) {
        if (!next.audioVae) next.audioVae = legacyVae
      } else if (!t1Class) {
        if (!next.videoVae) next.videoVae = legacyVae
      }
      // A T=1-named pick on a pure video family has no legal slot — dropped.
      delete next.vae
    } else if (AUDIO_VAE_FAMILIES.has(familyId)) {
      next = next ?? { ...slots }
      if (!videoClass) {
        if (!next.audioVae) next.audioVae = legacyVae
      }
      delete next.vae
    }
    // Any other family never exposed a 'vae' pick (it refused as unexposed
    // before the split) — the key drops rather than haunting the stored set.
    else {
      next = next ?? { ...slots }
      delete next.vae
    }
  }
  return next ?? slots
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

/** Filename markers for the VAE decoder classes (epdvxd4, AC-2). HEURISTICS
 *  WITH KNOWN LIMITS, documented here because no better evidence exists: the
 *  scan carries no VAE header-shape detection (h3Form reads diffusion-model
 *  adaln tensors only), so class follows the NAME — /video/i marks the video
 *  decoders (minimax_h3_video_vae*, ltx-2.5-video-vae*, LTX23_video_vae*),
 *  /audio|dav/i marks the audio decoders (…audio_vae*, music3's DAV), and
 *  T1_IMAGE_VAE_PATTERN is the Mamad8 image class. A file matching NO marker
 *  (ACE-Step's ace_1.5_vae, a community rename) cannot be classified by
 *  name: it applies — the engine stays the final arbiter, exactly like the
 *  instance-sourced form arm below. No known audio decoder name contains
 *  'video' and no known video decoder name contains 'audio'/'dav'; the
 *  markers refuse the cross-class picks that would ship a doomed graph. */
const VIDEO_VAE_MARKER = /video/i
const AUDIO_VAE_MARKER = /audio|dav/i

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
  // The decoder-class gate (epdvxd4): each VAE slot refuses picks whose
  // filename marks them as ANOTHER decoder class — the pick layer's
  // extension of the factory-level Mamad8 ban (a T=1 decoder in a
  // multi-frame graph, or a video decoder decoding audio, is a doomed or
  // corrupting graph; refuse it at the pick, never at the engine).
  if (slot === 'videoVae' || slot === 'audioVae' || slot === 'imageVae') {
    if (slot !== 'imageVae' && T1_IMAGE_VAE_PATTERN.test(file.name)) {
      return { check: 'vae', reason: `'${file.name}' is the Mamad8 T=1 image decoder — pinned to single-frame graphs; pick the video VAE for this slot.` }
    }
    if (slot === 'imageVae' && !T1_IMAGE_VAE_PATTERN.test(file.name)) {
      return { check: 'vae', reason: `'${file.name}' is not a Mamad8-class T=1 image decoder (the minimax_h3_t1_image_vae* family) — the image VAE slot pins the T=1 Fast profile's decoder, and a video/audio decoder there is the same cross-class swap the factory guard bans in reverse.` }
    }
    if (slot === 'videoVae' && AUDIO_VAE_MARKER.test(file.name)) {
      return { check: 'vae', reason: `'${file.name}' looks like an audio-class VAE by name — the video VAE slot decodes video frames; pick the audio VAE slot for audio decoders.` }
    }
    if (slot === 'audioVae' && VIDEO_VAE_MARKER.test(file.name)) {
      return { check: 'vae', reason: `'${file.name}' looks like a video-class VAE by name — the audio VAE slot decodes audio latents; pick the video VAE slot for video decoders.` }
    }
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
      videoVae: { slot: 'videoVae', state: 'auto' },
      audioVae: { slot: 'audioVae', state: 'auto' },
      imageVae: { slot: 'imageVae', state: 'auto' },
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
