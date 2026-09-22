/**
 * Canvas Phase 2 — the typed-hole option menus (§3: "type-directed filter over
 * the op/graph registry, availability-aware, parameter-directed constraints
 * surface as affordance hints inside the menu").
 *
 * PURE module: an endpoint's direction (head = consume-from here, tail =
 * produce-into here) plus the source media kinds plus an AVAILABILITY FACTS
 * object produce the menu rows — availability, install guidance, and the
 * parameter hints (17n+5 frame grid, 32px multiples, ≤15 s) are data. The
 * store computes the facts; the tests feed synthetic facts. Ranking per L19:
 * type-natural generation routes first, category visible on every row.
 */
import type { GenerationMode } from '../types'

export type EndpointDirection = 'consume' | 'produce'
export type SourceKind = 'image' | 'video' | 'audio'

/** Availability facts — computed by the canvas store from the shared
 *  registries and passed in as data so this module stays engine-free. */
export type OptionAvailability = {
  connected: boolean
  h3Ready: boolean
  /** Phase 4: the Motion-Context custom nodes (latent continuation). */
  motionContextReady: boolean
  /** Phase 4: the audio engine (the dock's launcher row reads this; the
   *  ACE-Step row went with the engine, 2026-09-21). */
  music3: { available: boolean; missing: string[] }
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
    /** (R-20) The audio engines' canonical home is the produce menu — the
     *  launcher chips retired (one home per engine). */
    | { kind: 'audio-dock'; engine: 'music3' }
    | { kind: 'set-first-frame' }
    | { kind: 'set-last-frame' }
    | { kind: 'add-reference' }
    | { kind: 'fork'; substrate: 'decoded' | 'extracted-frame' | 'latents' }
    /** Phase 3: the pose rig dock (§5.2 control-input family, epic 66xhflw). */
    | { kind: 'pose-rig' }
  available: boolean
  /** Why not (install guidance rides here). */
  reason?: string
  /** Parameter-directed constraint hint (§3). */
  hint?: string
}

/** The parameter hints every generation row carries — HUMANIZED (R-22, Wave
 *  3): the audit's finding was engine internals as user-facing copy
 *  ("158 frames (17n+5 grid) · 1344x768 (32px multiples)"). The row speaks
 *  outcome (a ~N s clip at a quality band); the frame grid stays in the
 *  take's provenance where the power user reads it.
 */
export function parameterHint(duration = 6, resolution = '1344x768'): string {
  const band = resolution.startsWith('864x') || resolution.startsWith('608x') ? 'SD' : resolution.startsWith('768x1344') ? 'HD portrait' : 'HD'
  return `~${duration.toFixed(1)} s clip · ${band} (${resolution})`
}


/**
 * The menu for one endpoint. Direction decides the option SPACE (§3 + L20:
 * "what can extend/produce this" only): the head lists what this chain can
 * CONSUME (input roles for the selected source), the tail lists what can be
 * PRODUCED from this tile's output, filtered by the source's media kinds.
 *
 * `targetMediaType` is the chain whose head the menu opens on (tmz8vh7,
 * 2026-09-20): last-frame and reference roles are H3 VIDEO concepts, and an
 * image-intent chain that binds one silently fell through the stills
 * predicate into the video ladder (audit P1-2) — they are not OFFERED for
 * image chains. First-frame stays: on an image chain it is the Edit-surface
 * handoff binding (the dated 34afx79 decision).
 */
export function endpointOptions(direction: EndpointDirection, sourceKinds: ReadonlyArray<SourceKind>, availability: OptionAvailability, targetMediaType?: 'video' | 'image' | 'audio'): EndpointOption[] {
  const kinds = new Set(sourceKinds)
  const hasImage = kinds.has('image')
  const hasVideo = kinds.has('video')
  const imageTarget = targetMediaType === 'image'

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
      if (!imageTarget) rows.push({
        id: 'consume:last-frame', group: 'input', label: 'Use as last frame', description: 'Frame-anchored end — first + last frame mode once a first frame is set.',
        action: { kind: 'set-last-frame' }, available: true,
      })
    }
    if (!imageTarget) rows.push({
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
  // re-encode). The engine-side nodes gate honestly. (R-22) the row is
  // OUTCOME-named — the storage substrate is not the user's decision axis.
  rows.push({
    id: 'produce:fork-latents', group: 'fork', label: 'Continue from this take (no re-encode)', description: 'The next chain picks up this take’s saved latent — Motion-Context conditioning, no re-encode.',
    action: { kind: 'fork', substrate: 'latents' }, available: availability.motionContextReady,
    reason: availability.motionContextReady ? undefined : 'Latent continuation needs the ComfyUI-H3-Motion-Context custom nodes — install the pack manually, then refresh the engine.',
    hint: 'the take’s saved clip pins the context rows · motion + audio continue',
  })
  // (R-20) The audio engines: one canonical home each — the produce menu
  // (the launcher chips are retired). Availability-gated with their missing
  // list as the reason, exactly like every other row.
  // Availability note: the dock rows stay ENABLED offline — the DOCK is the
  // honest gate (its submit carries the refusal with the missing list, the
  // established offline pattern); disabling here would kill the authoring
  // surface instead of gating the render. The needs ride the hint.
  rows.push({
    id: 'produce:music3', group: 'generate', label: 'Music 3 — a complete song', description: 'The audio dock opens on this chain — caption, lyrics, seconds; the track lands as its own object.',
    action: { kind: 'audio-dock', engine: 'music3' }, available: true,
    hint: availability.music3.available ? 'complete songs · own object' : `author now · render needs ${availability.music3.missing.join('; ')}`,
  })
  return rows
}
