/**
 * Camera vocabulary helpers — the discovered-H3-quirk prompt craft ported
 * from camera.py of NyckM/3d-Camera-control-H3-Minimax (v19.1 @ 846880d,
 * Apache-2.0): aspect labeling, the frame-width crossing-count parallax
 * vocabulary, the checkable end view, and the screen-side direction
 * contract that catches the model mirroring the requested orbit.
 *
 * Fidelity note: parallaxTravel, endView and directionContract are NOT wired
 * into the v19.1 compile output upstream (build_plan stopped injecting
 * per-segment background travel; the plan carries a static parallax line).
 * They are ported verbatim because they are the documented quirk vocabulary
 * the audit called out, and the future canvas-phase editor / A-B harness
 * consumes them directly. golden-tested against the Python source.
 */
import { COMMON_ASPECTS, REFERENCE_ASPECT_FOV, VERTICAL_FOV } from './constants'
import type { CameraKeyframe } from './types'
import { pyFixed, pyFormatG } from './parity'

/** Width / height of a ComfyUI IMAGE batch ([B, H, W, C]) shape, or null. */
export function imageAspect(image: { shape?: number[] } | null | undefined): number | null {
  const shape = image?.shape
  if (!shape || shape.length < 3) return null
  const height = shape[shape.length - 3]
  const width = shape[shape.length - 2]
  if (height <= 0 || width <= 0) return null
  return width / height
}

/** Nearest common aspect label, or a 'W:1' string when nothing is close. */
export function aspectLabel(aspect: number | null): string {
  if (aspect === null) return '16:9'
  let best = COMMON_ASPECTS[0]
  let bestDiff = Math.abs(best[0] - aspect)
  for (const item of COMMON_ASPECTS) {
    const diff = Math.abs(item[0] - aspect)
    if (diff < bestDiff) {
      best = item
      bestDiff = diff
    }
  }
  return Math.abs(best[0] - aspect) < 0.04 ? best[1] : `${pyFixed(aspect, 2)}:1`
}

/** Horizontal FOV in degrees for a frame of the given aspect, assuming the
 *  40-degree vertical FOV the parallax vocabulary is calibrated against.
 *  Operation order mirrors math.radians/math.degrees (x * precomputed
 *  constant) so the crossing counts match Python bit-for-bit. */
export function horizontalFov(aspect?: number | null): number {
  const ratio = aspect || REFERENCE_ASPECT_FOV
  return 2 * (Math.atan(Math.tan((VERTICAL_FOV / 2) * (Math.PI / 180)) * ratio) * (180 / Math.PI))
}

/** Keyframes where the orbit changes direction, so the camera has to stop
 *  there (upstream reversal_indices — returns a Set for truthiness parity). */
export function reversalIndices(path: readonly CameraKeyframe[]): Set<number> {
  const result = new Set<number>()
  for (let i = 1; i < path.length - 1; i += 1) {
    const before = path[i].azimuth - path[i - 1].azimuth
    const after = path[i + 1].azimuth - path[i].azimuth
    if (before * after < 0) result.add(i)
  }
  return result
}

/** The finished angle as a checkable view, leading with the number. */
export function endView(netRotation: number): string {
  const abs = Math.abs(netRotation)
  const turns = Math.floor(abs / 360.0)
  const rest = abs % 360.0
  let place: string
  if (rest < 1) {
    place = 'back at exactly the reference view'
  } else {
    const bearing = rest < 20 ? 'still close to the reference angle'
      : rest < 70 ? 'partway between the reference view and a full profile'
        : rest < 110 ? 'about a full profile'
          : rest < 160 ? 'between a full profile and the far side'
            : 'the far side, opposite the reference view'
    place = `${pyFormatG(rest)} degrees around from the reference view, ${pyFixed(rest / 90, 2)} of a quarter turn, ${bearing}`
  }
  const laps = turns ? `${pyFormatG(turns)} complete turn${turns > 1 ? 's' : ''} and then ` : ''
  return laps + place
}

/** Background travel in words, not boxes: v15 prescribes no screen-space
 *  displacement. Counting crossings instead of a single sweep is what keeps
 *  a 132 degree turn distinct from a full 360; any box-shaped measure
 *  saturates once the background leaves the frame. */
export function parallaxTravel(deltaAzimuth: number, deltaElevation: number, aspect?: number | null): string {
  const moves: string[] = []
  const crossings = Math.abs(deltaAzimuth) / horizontalFov(aspect)
  if (Math.abs(deltaAzimuth) >= 5) {
    const side = deltaAzimuth > 0 ? 'right' : 'left'
    const other = deltaAzimuth > 0 ? 'left' : 'right'
    moves.push(crossings > 1.15
      ? `background features cross the full frame width to the ${side} about ${pyFixed(crossings, 1)} times `
        + `over, entering at the ${other} edge as each one leaves`
      : `background features slide about ${pyFixed(crossings, 2)} of a frame width to the ${side}, with new `
        + `background entering at the ${other} edge`)
  }
  if (Math.abs(deltaElevation) >= 3) {
    moves.push(`background features also move about ${pyFixed(Math.abs(deltaElevation) / VERTICAL_FOV, 2)} of a frame `
      + `height ${deltaElevation > 0 ? 'upward' : 'downward'}`)
  }
  return moves.join('; ')
}

/** Frame edges cannot be mirrored; the words left and right can. The subject
 *  faces the camera, so the subject own left is the viewer right. Naming the
 *  edge the background enters from gives a check that does not depend on
 *  that reading. Empty when the move reverses or has no net direction. */
export function directionContract(path: readonly CameraKeyframe[]): string {
  const net = path[path.length - 1].azimuth - path[0].azimuth
  if (Math.abs(net) <= 0.5 || reversalIndices(path).size > 0) return ''
  const side = net > 0 ? 'right' : 'left'
  const other = side === 'right' ? 'left' : 'right'
  return `The camera travels toward the ${side} of the frame as the viewer sees it. This is screen ${side}, not `
    + `the subject own ${side}, and the two are opposite. Two checks that must both hold. First, background `
    + `features slide toward the ${side} edge and new background enters from the ${other} edge. Second, the `
    + `shot progressively reveals the side of the subject that starts out nearest the ${side} edge of the `
    + `frame. If the background enters from the ${side} edge instead, the rotation is mirrored and wrong.`
}
