/** Workbench ownership-contract generation (task k9vu6t0, spec §5/§3).
 *
 * Preservation contract text is GENERATED from the Keep dial + per-picture
 * assignments — never hand-written (the packs' <Picture N> scoping, the
 * astropuzzo source_fidelity semantics: the dial changes preservation
 * WORDING for traits the instruction does not mention, not denoise
 * strength; 0.50-0.60 is the documented start band for large
 * pose/composition moves). The user supplies INTENT; this module phrases
 * the contract the engine reads.
 *
 * Pure: no React, no stores — covered by scripts/test-h3img.cjs through the
 * VM harness.
 */
import type { H3ImgRefRole } from './graph/h3image'
import { H3IMG_RECIPE_PINS } from './graph/h3image'

export type ContractIntent = {
  familyId: string
  /** The user's free-form intent (the WHAT). */
  instruction: string
  /** Ordered reference slots — Picture N is index+1 (wiring order). */
  refs: Array<{ role: H3ImgRefRole; note?: string }>
  /** Edit/directed families anchor the source as Picture 1. */
  sourceAnchored: boolean
  /** The global "Keep unspecified traits" dial (0-1). */
  keepDial: number
  /** Optional per-picture overrides (Picture index -> dial). */
  keepOverrides?: Record<number, number>
  tier?: number
}

/** The role phrase for one slot — what this picture contributes. */
export function roleSentence(role: H3ImgRefRole, note?: string, familyId?: string): string {
  const custom = note?.trim()
  switch (role) {
    case 'subject':
      // The outfit family scopes its subject-transport refs to the garment
      // (the packs' clothing-sheet recipe: identity stays Picture 1).
      if (familyId === 'h3img.edit.outfit') return custom ? `the wardrobe reference — ${custom}` : 'the wardrobe reference (native transport): only the named garment transfers'
      return custom ? `the identity anchor — ${custom}` : 'the identity anchor: face, proportions, skin, hairline, distinguishing marks (native transport)'
    case 'pose':
      return custom ? `the pose reference — ${custom}` : 'the body pose and limb positions reference (semantic transport)'
    case 'style':
      return custom ? `the style reference — ${custom}` : 'the style reference (semantic transport)'
    case 'lighting':
      return custom ? `the lighting reference — ${custom}` : 'the lighting reference (semantic transport)'
    case 'background':
      return custom ? `the environment reference — ${custom}` : 'the environment/background reference (semantic transport)'
    case 'freeform':
      return custom ? `an additional reference — ${custom}` : 'an additional reference (native transport)'
    default:
      return custom ?? 'a reference'
  }
}

/** The Keep dial's preservation wording (source_fidelity semantics). The
 * band edges follow the research: 0.50-0.60 starts for large
 * pose/composition transfers; high values lock everything unnamed. */
export function keepWording(dial: number): string {
  if (dial >= 0.8) return 'Preserve every trait this instruction does not explicitly change, exactly as in <Picture 1> — composition, camera, lighting, wardrobe, environment, and identity details.'
  if (dial >= 0.6) return 'Preserve all unspecified traits from <Picture 1>: identity, wardrobe, environment, camera framing, and lighting stay; only the requested change lands.'
  if (dial >= 0.5) return `Preserve the subject's identity and the overall scene; the requested change is a large pose/composition move, so framing may reshape around it (keep-dial ${dial.toFixed(2)} — the documented band for large moves).`
  if (dial >= 0.3) return `Preserve the subject's identity; composition, environment, and lighting may reinterpret around the requested change (keep-dial ${dial.toFixed(2)}).`
  return `Loose preservation: keep only the subjects this contract names; style, composition, and environment may move freely around the change (keep-dial ${dial.toFixed(2)}).`
}

/** Per-family lock/change template (the research §3 table, verbatim classes). */
function familyContract(familyId: string): { locks: string; changes: string } | null {
  switch (familyId) {
    case 'h3img.edit.identity':
      return { locks: 'Lock from <Picture 1>: the source pose, scene, camera, and lighting.', changes: 'Change: identity, face, hair, physique, and wardrobe/accessories as requested from the donor reference.' }
    case 'h3img.edit.background':
      return { locks: 'Lock from <Picture 1>: the subject, pose, camera framing, and the lighting on the subject.', changes: 'Change: replace the background/environment with the one in the background reference.' }
    case 'h3img.edit.outfit':
      return { locks: 'Lock from <Picture 1>: identity, face, hair, pose, scene, and camera.', changes: 'Change: only the named garment(s) per the wardrobe reference — nothing else about the outfit or the person.' }
    case 'h3img.edit.lighting':
      return { locks: 'Lock from <Picture 1>: the subject, pose, scene, and composition.', changes: 'Change: the illumination — use the lighting from the lighting reference.' }
    case 'h3img.edit.pose':
      return { locks: 'Lock from <Picture 1>: identity, wardrobe, scene, lighting, lens, and framing.', changes: 'Change: the body pose and limb positions — use the body pose from the pose reference.' }
    case 'h3img.edit.freeform':
      return null
    default:
      return null
  }
}

/** The honest beyond-9 statement + curation guidance (spec §3, AC2). */
export const BEYOND_NINE_GUIDANCE = '9 native references is the v1 budget (the engine\'s REF2VA cap). More requires RefMod bundling, which arrives with the RefMod factory — for now, curate down: keep the identity anchor plus one reference per distinct role, and drop near-duplicates (they are what blurs into a hybrid). Semantic-only overflow is an expert experimental toggle, off by default.'

/**
 * Composes the full workbench prompt: the user's intent, the per-picture
 * subject definitions (role-scoped, transport-named), the family's
 * lock/change template, the Keep dial's preservation wording with optional
 * per-picture overrides, the packet/tail wording, and the closing
 * change-nothing-else clause. Deterministic — same intent, same contract.
 */
export function composeWorkbenchPrompt(intent: ContractIntent): string {
  const parts: string[] = []
  const instruction = intent.instruction.trim()
  if (instruction) parts.push(instruction)

  const hasPictures = intent.sourceAnchored || intent.refs.length > 0
  if (hasPictures) {
    const definitions: string[] = []
    let picture = 1
    if (intent.sourceAnchored) {
      definitions.push(`<Picture ${picture}> — the source image: the anchored subject of this edit.`)
      picture += 1
    }
    for (const ref of intent.refs) {
      definitions.push(`<Picture ${picture}> — ${roleSentence(ref.role, ref.note, intent.familyId)}.`)
      picture += 1
    }
    parts.push(`subject_definitions:\n${definitions.join('\n')}`)
  }

  const family = familyContract(intent.familyId)
  const assignments: string[] = []
  if (family) {
    assignments.push(family.locks)
    assignments.push(family.changes)
  } else if (hasPictures) {
    // Compose/generate with refs: the generic ownership shape (thaakeno's
    // verbatim example class) — each picture contributes its role, nothing
    // unassigned.
    let picture = 1
    if (intent.sourceAnchored) {
      assignments.push('Keep the identity and pose from <Picture 1>.')
      picture += 1
    }
    for (const ref of intent.refs) {
      const verb = ref.role === 'pose' ? 'Use the body pose and limb positions from'
        : ref.role === 'style' ? 'Use the visual style from'
        : ref.role === 'lighting' ? 'Use the lighting from'
        : ref.role === 'background' ? 'Replace the background with the environment from'
        : `Keep the identity-defining traits of the subject in`
      assignments.push(`${verb} <Picture ${picture}>${ref.note ? ` (${ref.note.trim()})` : ''}.`)
      picture += 1
    }
  }
  if (assignments.length) parts.push(`Ownership contract:\n${assignments.join(' ')}`)

  // The Keep dial + per-picture overrides.
  const overrides = intent.keepOverrides ?? {}
  const overrideLines: string[] = []
  for (const key of Object.keys(overrides).sort((a, b) => Number(a) - Number(b))) {
    const index = Number(key)
    if (Number.isFinite(index) && index >= 1) overrideLines.push(`<Picture ${index}>: ${keepWording(overrides[index])}`)
  }
  parts.push(`Preservation of unspecified traits: ${keepWording(intent.keepDial)}${overrideLines.length ? `\nPer-picture preservation:\n${overrideLines.join('\n')}` : ''}`)

  // Packet / tail wording.
  if (intent.tier === 39) {
    parts.push('Directed settle: the change completes by 65% of the sequence and is held perfectly still from there to the final frame.')
  } else if (intent.tier && intent.tier > 1) {
    parts.push(`A short, nearly still ${intent.tier}-frame sequence depicting this single scene; one frame will be selected as the final image.`)
  } else {
    parts.push('A single still image.')
  }

  parts.push('Change nothing else.')
  return parts.join('\n\n')
}

/** The Keep dial's healthy band hint for the UI (the spec's large-move
 * band, straight from the pins). */
export function keepDialHint(dial: number): string {
  const [bandLow, bandHigh] = H3IMG_RECIPE_PINS.keepDial.largeMoveBand
  if (dial >= bandLow && dial <= bandHigh) return 'The documented start band for large pose/composition moves.'
  if (dial > bandHigh) return 'High preservation — everything unnamed stays locked.'
  return 'Low preservation — unnamed traits may reinterpret around your change.'
}
