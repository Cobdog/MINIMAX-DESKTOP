/**
 * Camera interpolation, ported from trajectory_math.py of
 * NyckM/3d-Camera-control-H3-Minimax (bruxosdovfx "Camera H3", v19.1,
 * commit 846880de859959e801b2c506dc424bd5c8b5c6c4, Apache-2.0).
 * Faithful port for task ving89w — semantics preserved exactly, including
 * the clamping and slope rules; angles stay UNWRAPPED (0 -> 360 is a full
 * turn), matching upstream.
 */
import type { CameraKeyframe, Interpolation, Pose, PromptDetail } from './types'

export const AXES = ['azimuth', 'elevation', 'distance'] as const

function validate(path: readonly CameraKeyframe[]): void {
  if (path.length === 0) throw new Error('Empty camera path / Trajetória vazia.')
  let previous = -Infinity
  for (const point of path) {
    // Upstream checks time + the three axes for finiteness before touching them.
    if (![point.time, point.azimuth, point.elevation, point.distance].every(Number.isFinite)) {
      throw new Error('Non-finite camera value / Valor de câmera não finito.')
    }
    if (point.time <= previous) throw new Error('Times must increase / Tempos devem ser crescentes.')
    previous = point.time
  }
}

/** Monotone PCHIP slope: zero at endpoints, holds and reversals — the
 *  no-overshoot tangent. Weighted-harmonic-mean form, identical arithmetic
 *  order to upstream so sampled values match bit-for-bit. */
function slope(path: readonly CameraKeyframe[], index: number, axis: (typeof AXES)[number]): number {
  if (index === 0 || index === path.length - 1) return 0.0
  const left = path[index - 1]
  const center = path[index]
  const right = path[index + 1]
  const h0 = center.time - left.time
  const h1 = right.time - center.time
  const d0 = (center[axis] - left[axis]) / h0
  const d1 = (right[axis] - center[axis]) / h1
  if (d0 === 0 || d1 === 0 || d0 > 0 !== d1 > 0) return 0.0
  const w0 = 2 * h1 + h0
  const w1 = h1 + 2 * h0
  return (w0 + w1) / (w0 / d0 + w1 / d1)
}

/** Sample raw signed angles/radius (upstream interpolate_pose).
 *  - 'smooth' + 'v15 baseline': smoothstep easing per segment
 *  - 'smooth' + 'extended contracts': monotone cubic (PCHIP Hermite) per axis
 *  - 'linear': straight lerp, independent of detail
 *  Values outside [first.time, last.time] clamp to the endpoint poses. */
export function interpolatePose(
  path: readonly CameraKeyframe[],
  time: number,
  interpolation: Interpolation = 'smooth',
  detail: PromptDetail = 'v15 baseline',
): Pose {
  validate(path)
  if (!Number.isFinite(time)) throw new Error('Time must be finite / Tempo deve ser finito.')
  if (time <= path[0].time) {
    return { azimuth: path[0].azimuth, elevation: path[0].elevation, distance: path[0].distance }
  }
  if (time >= path[path.length - 1].time) {
    const last = path[path.length - 1]
    return { azimuth: last.azimuth, elevation: last.elevation, distance: last.distance }
  }
  for (let index = 0; index < path.length - 1; index += 1) {
    const left = path[index]
    const right = path[index + 1]
    if (time <= right.time) {
      const h = right.time - left.time
      const u = (time - left.time) / h
      if (interpolation !== 'smooth') {
        return {
          azimuth: left.azimuth + (right.azimuth - left.azimuth) * u,
          elevation: left.elevation + (right.elevation - left.elevation) * u,
          distance: left.distance + (right.distance - left.distance) * u,
        }
      }
      if (detail !== 'extended contracts') {
        const ease = u * u * (3 - 2 * u)
        return {
          azimuth: left.azimuth + (right.azimuth - left.azimuth) * ease,
          elevation: left.elevation + (right.elevation - left.elevation) * ease,
          distance: left.distance + (right.distance - left.distance) * ease,
        }
      }
      // Hermite basis via Math.pow (explicit: the VM harness transpiles `**`
      // to Math.pow anyway). ECMAScript leaves pow implementation-approximated,
      // so V8 versions can differ from each other and from CPython's libm pow
      // at the last ulps — sampled interpolation therefore compares against
      // the Python goldens with a 1e-12 tolerance in the test (the compiled
      // prompts never route through this function and stay byte-exact).
      const u2 = Math.pow(u, 2)
      const u3 = Math.pow(u, 3)
      const h00 = 2 * u3 - 3 * u2 + 1
      const h10 = u3 - 2 * u2 + u
      const h01 = -2 * u3 + 3 * u2
      const h11 = u3 - u2
      const axis = (name: (typeof AXES)[number], i: number): number => {
        const value =
          h00 * path[i][name] + h10 * h * slope(path, index, name)
          + h01 * path[i + 1][name] + h11 * h * slope(path, index + 1, name)
        const low = Math.min(path[i][name], path[i + 1][name])
        const high = Math.max(path[i][name], path[i + 1][name])
        return Math.min(Math.max(value, low), high)
      }
      return {
        azimuth: axis('azimuth', index),
        elevation: axis('elevation', index),
        distance: axis('distance', index),
      }
    }
  }
  // Unreachable after the time clamp; kept for exhaustiveness.
  const last = path[path.length - 1]
  return { azimuth: last.azimuth, elevation: last.elevation, distance: last.distance }
}
