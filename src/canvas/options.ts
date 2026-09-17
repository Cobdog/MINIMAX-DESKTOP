/**
 * Canvas Phase 2 — the typed-hole option menus (§3: "type-directed filter over
 * the op/graph registry, availability-aware, parameter-directed constraints
 * surface as affordance hints inside the menu").
 *
 * PURE module: an endpoint's direction (head = consume-from here, tail =
 * produce-into here) plus the source media kinds plus an AVAILABILITY FACTS
 * object produce the menu rows — availability, install guidance, and the
 * parameter hints (17n+5 frame grid, 32px multiples, ≤15 s) are data. The
 * store computes facts from the optimization registry + LTX-2.3 detection;
 * the tests feed synthetic facts. Ranking per L19: type-natural generation
 * routes first, category visible on every row.
 */
import { frameCount } from '../lib/workflow'
import type { GenerationMode } from '../types'

export type EndpointDirection = 'consume' | 'produce'
export type SourceKind = 'image' | 'video' | 'audio'

export type UtilityFact = { tool: string; label: string; available: boolean; missing: string[]; installHint?: string }

/** Availability facts — computed by the canvas store from the shared
 *  registries (detectOptimizations / findLtx23Utility detection) and passed
 *  in as data so this module stays engine-free. */
export type OptionAvailability = {
  connected: boolean
  h3Ready: boolean
  /** LTX-2.3 one-graph utilities (label + detection). */
  utilities: UtilityFact[]
  /** Phase 4: the Motion-Context custom nodes (latent continuation). */
  motionContextReady: boolean
  /** Phase 4: the LTX-2.5 GENERAL graph (the workspace greyed out; the
   *  engine survives as this typed-hole op). */
  ltx25: { available: boolean; missing: string[] }
  /** Phase 4: the audio engines (the dock's launcher rows read these). */
  music3: { available: boolean; missing: string[] }
  acestep: { available: boolean; missing: string[] }
}

export type EndpointOption = {
  id: string
  /** L19: category visible — the menu groups by this. */
  group: 'generate' | 'input' | 'utility' | 'fork' | 'control'
  label: string
  description: string
  /** The store action this row performs when picked. */
  action:
    | { kind: 'generate'; mode: GenerationMode }
    | { kind: 'set-first-frame' }
    | { kind: 'set-last-frame' }
    | { kind: 'add-reference' }
    | { kind: 'utility'; tool: string }
    | { kind: 'fork'; substrate: 'decoded' | 'extracted-frame' | 'latents' }
    /** Phase 3: the pose rig dock (§5.2 control-input family, epic 66xhflw). */
    | { kind: 'pose-rig' }
    /** Phase 4: the LTX-2.5 general graph (§5.4 engines-as-ops). */
    | { kind: 'ltx25' }
  available: boolean
  /** Why not (install guidance rides here). */
  reason?: string
  /** Parameter-directed constraint hint (§3). */
  hint?: string
}

/** The parameter hints every generation row carries: the official H3 frame
 *  grid (frames = 17n+5 by construction), 32-pixel resolution multiples, and
 *  the 2–15 s duration clamp. */
export function parameterHint(duration = 6, resolution = '1344x768'): string {
  return `${frameCount(duration)} frames (17n+5 grid) · ${resolution} (32px multiples) · 2–15 s`
}

const offline = (connected: boolean): string | undefined => (connected ? undefined : 'Engine offline — start ComfyUI to run this.')
const missingModels = (h3Ready: boolean, connected: boolean): string | undefined => (!h3Ready && connected ? 'MiniMax H3 model components are missing — install them, then refresh the engine.' : undefined)

/**
 * The menu for one endpoint. Direction decides the option SPACE (§3 + L20:
 * "what can extend/produce this" only): the head lists what this chain can
 * CONSUME (input roles for the selected source), the tail lists what can be
 * PRODUCED from this tile's output, filtered by the source's media kinds.
 */
export function endpointOptions(direction: EndpointDirection, sourceKinds: ReadonlyArray<SourceKind>, availability: OptionAvailability): EndpointOption[] {
  const kinds = new Set(sourceKinds)
  const hasImage = kinds.has('image')
  const hasVideo = kinds.has('video')

  if (direction === 'consume') {
    // Input roles are pure document edits — they never need the engine (only
    // the eventual render does). Type mismatches are FILTERED (never
    // offered); there is no availability gate on this side.
    const rows: EndpointOption[] = []
    if (hasImage) {
      rows.push({
        id: 'consume:first-frame', group: 'input', label: 'Use as first frame', description: 'This chain continues from the selected image — image → video.',
        action: { kind: 'set-first-frame' }, available: true,
      })
      rows.push({
        id: 'consume:last-frame', group: 'input', label: 'Use as last frame', description: 'Frame-anchored end — first + last frame mode once a first frame is set.',
        action: { kind: 'set-last-frame' }, available: true,
      })
    }
    rows.push({
      id: 'consume:reference', group: 'input', label: 'Add as reference', description: 'Join this chain’s ordered reference set (ref2v, ≤9 pictures).',
      action: { kind: 'add-reference' }, available: true,
      hint: '≤9 pictures · 3 videos · 3 audio',
    })
    // §5.2 control-input family (Phase 3, epic 66xhflw): the pose rig docks
    // as a floating canvas tool panel — a from-scratch control input, so it
    // is offered for ANY chain kind and never needs the engine.
    rows.push({
      id: 'consume:pose-rig', group: 'control', label: 'Pose rig', description: 'Author a pose control track for this chain — the IK rig docks as a panel; export lands as a control input.',
      action: { kind: 'pose-rig' }, available: true,
      hint: 'palette-exact DWPose · 17n+5 keyframe grid',
    })
    return rows
  }

  const rows: EndpointOption[] = []
  // Generation rows CREATE chains (pure document edits — always offered); the
  // engine gate lives at submit, where the honest offline refusal surfaces.
  // The utilities stay availability-gated: they need installed weights.
  if (hasImage) {
    rows.push({
      id: 'produce:i2v', group: 'generate', label: 'Generate — image → video', description: 'A new chain with this image as its first frame.',
      action: { kind: 'generate', mode: 'image' }, available: true,
      hint: parameterHint(),
    })
    rows.push({
      id: 'produce:frames', group: 'generate', label: 'Generate — first + last frame', description: 'Anchor both ends: pick this image as the first frame and a second as the last.',
      action: { kind: 'generate', mode: 'frames' }, available: true,
      hint: parameterHint(),
    })
  }
  rows.push({
    id: 'produce:ref2v', group: 'generate', label: 'Generate — reference → video', description: 'A new chain citing this output in its reference set.',
    action: { kind: 'generate', mode: 'reference' }, available: true,
    hint: `${parameterHint()} · ≤9 pictures`,
  })
  rows.push({
    id: 'produce:fork-decoded', group: 'fork', label: 'Fork — decoded media', description: 'New chain consuming this take’s decoded artifact.',
    action: { kind: 'fork', substrate: 'decoded' }, available: true,
    hint: 'Sources are never altered — the fork carries its own settings',
  })
  if (hasVideo) {
    rows.push({
      id: 'produce:fork-frame', group: 'fork', label: 'Fork — extracted frame', description: 'Extract one frame (ffmpeg, server-side) and continue from the still.',
      action: { kind: 'fork', substrate: 'extracted-frame' }, available: true,
      hint: 'frame index = seconds × 24 · negative counts from the end',
    })
  }
  // Phase 4: latent continuation RENDERS — the Motion-Context machinery
  // loads the saved sampler latent as never-denoised conditioning (no
  // re-encode). The engine-side nodes gate honestly.
  rows.push({
    id: 'produce:fork-latents', group: 'fork', label: 'Fork — latents on disk', description: 'Continue from the saved sampler latent — Motion-Context conditioning, no re-encode.',
    action: { kind: 'fork', substrate: 'latents' }, available: availability.motionContextReady,
    reason: availability.motionContextReady ? undefined : 'Latent continuation needs the ComfyUI-H3-Motion-Context custom nodes — install them, then refresh the engine.',
    hint: 'the take’s saved clip pins the context rows · motion + audio continue',
  })
  // §5.4 Phase 4 (L4 keep-utilities-only): the LTX-2.5 GENERAL i2v graph as
  // an engine-op over an image source (the workspace greyed out).
  if (hasImage) {
    rows.push({
      id: 'produce:ltx25', group: 'generate', label: 'Generate — LTX 2.5 image → video', description: 'A new chain on the LTX-2.5 general engine (4K/text ceilings; H3 stays the product default).',
      action: { kind: 'ltx25' },
      available: availability.ltx25.available,
      reason: !availability.ltx25.available
        ? `Not ready — missing ${availability.ltx25.missing.join('; ') || 'components'}.`
        : undefined,
      hint: 'engine switch lives in the chain’s properties',
    })
  }
  for (const utility of availability.utilities) {
    const wantsVideo = utility.tool !== 'ia2v'
    if (wantsVideo ? !hasVideo : !hasImage) continue
    rows.push({
      id: `produce:utility:${utility.tool}`, group: 'utility', label: utility.label,
      description: wantsVideo ? 'LTX-2.3 official-template tool over the 2.3-dev checkpoint.' : 'Image + audio → video through the official 2.3-dev template.',
      action: { kind: 'utility', tool: utility.tool },
      available: utility.available && availability.connected,
      reason: !utility.available
        ? `Not ready — missing ${utility.missing.join('; ') || 'components'}${utility.installHint ? `. ${utility.installHint}` : '.'}`
        : offline(availability.connected) ?? missingModels(availability.h3Ready, availability.connected),
    })
  }
  return rows
}
