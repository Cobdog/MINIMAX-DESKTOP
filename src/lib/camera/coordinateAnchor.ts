/**
 * The subject_box coordinate anchor, ported from coordinate_anchor() in
 * camera.py of NyckM/3d-Camera-control-H3-Minimax (v19.1 @ 846880d,
 * Apache-2.0). Keeps literal L/T/W/H syntax — empty means the image extent,
 * not a guessed subject; a supplied box preserves the user's precision
 * verbatim instead of silently rounding small boxes to zero.
 */
import type { CoordinateAnchor } from './types'

const NUMBER = '([+-]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?)'
const BOX_RE = new RegExp(
  '^\\[\\s*L\\s*=\\s*' + NUMBER + '\\s*,\\s*T\\s*=\\s*' + NUMBER
  + '\\s*,\\s*W\\s*=\\s*' + NUMBER + '\\s*,\\s*H\\s*=\\s*' + NUMBER + '\\s*\\]$',
)

/** Parse a `[L=0.516, T=0.148, W=0.071, H=0.249]` string (or empty) into the
 *  anchor block. Throws the upstream messages on malformed or
 *  out-of-normalized-bounds boxes. */
export function coordinateAnchor(raw: string | null | undefined): CoordinateAnchor {
  const text = String(raw ?? '').trim()
  if (!text) {
    return {
      kind: 'reference_image',
      box: '[L=0.000, T=0.000, W=1.000, H=1.000]',
      instruction: 'The complete reference image occupies [L=0.000, T=0.000, W=1.000, H=1.000]. Preserve its initial composition. This is the image boundary, not a subject bounding box.',
    }
  }
  const match = BOX_RE.exec(text)
  // m[0] !== text rejects a trailing newline, which Python's re.fullmatch
  // refuses but a bare JS `$` anchor would otherwise accept.
  if (!match || match[0] !== text) {
    throw new Error('subject_box must use [L=0.516, T=0.148, W=0.071, H=0.249], or be empty.')
  }
  const l = Number.parseFloat(match[1])
  const t = Number.parseFloat(match[2])
  const w = Number.parseFloat(match[3])
  const h = Number.parseFloat(match[4])
  if (![l, t, w, h].every(Number.isFinite) || Math.min(l, t) < 0 || Math.min(w, h) <= 0
    || l + w > 1 + 1e-9 || t + h > 1 + 1e-9) {
    throw new Error('subject_box must have positive size and stay within the normalized image.')
  }
  const box = `[L=${match[1]}, T=${match[2]}, W=${match[3]}, H=${match[4]}]`
  return {
    kind: 'user_subject',
    box,
    instruction: 'In the reference first frame, the main subject occupies ' + box + '. Use this region to identify the fixed orbit target. It defines the starting framing, not a forced box for every subsequent frame. Let the requested camera motion determine subsequent perspective and size.',
  }
}
