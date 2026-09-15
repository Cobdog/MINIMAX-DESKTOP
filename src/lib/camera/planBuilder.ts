/**
 * The camera plan builder, ported from build_plan() / _camera_mode() /
 * beat_curves() in camera.py of NyckM/3d-Camera-control-H3-Minimax (v19.1 @
 * 846880d, Apache-2.0). Key order inside the produced plan is load-bearing:
 * it is the serialization order of the compact-JSON prompt and the storyboard.
 */
import { FPS } from './constants'
import { pyFixed, pyFormatG, pyRound } from './parity'
import { aspectLabel, reversalIndices } from './cameraText'
import type { CameraKeyframe, CameraPlan, CameraSegment, Pose, PromptDetail } from './types'

function poseOf(point: CameraKeyframe): Pose {
  return { azimuth: point.azimuth, elevation: point.elevation, distance: point.distance }
}

function cameraMode(start: CameraKeyframe, end: CameraKeyframe): string {
  if (Math.abs(end.azimuth - start.azimuth) < 1e-8
    && Math.abs(end.elevation - start.elevation) < 1e-8
    && Math.abs(end.distance - start.distance) < 1e-8) {
    return 'hold the camera viewpoint, elevation and radius unchanged for this entire interval'
  }
  const moves: string[] = []
  const da = end.azimuth - start.azimuth
  const de = end.elevation - start.elevation
  const dd = end.distance - start.distance
  if (Math.abs(da) > 1e-8) {
    moves.push(`physically move the CAMERA ${pyFixed(Math.abs(da), 3)} degrees around the fixed target toward the camera's ${da > 0 ? 'RIGHT' : 'LEFT'}, keeping the lens aimed at that target; the subject itself stays stationary`)
  }
  if (Math.abs(de) > 1e-8) {
    moves.push(de > 0
      ? 'physically RAISE the CAMERA along a vertical arc around the fixed target, revealing a higher viewpoint; keep aiming at the target'
      : 'physically LOWER the CAMERA along a vertical arc around the fixed target, revealing a lower viewpoint; keep aiming at the target')
    if (Math.abs(end.elevation) < 1e-8) {
      moves.push('return to the reference elevation offset of 0 degrees; do not pass beyond it')
    } else {
      moves.push(`${de > 0 ? 'increase' : 'decrease'} elevation offset from ${pyFixed(start.elevation, 3)} to ${pyFixed(end.elevation, 3)} degrees relative to the reference camera`)
    }
  } else {
    moves.push(`maintain elevation offset ${pyFixed(end.elevation, 3)} degrees`)
  }
  if (Math.abs(dd) > 1e-8) {
    moves.push(`${dd > 0 ? 'pull back' : 'move closer'} from radius ${pyFixed(start.distance, 3)} to ${pyFixed(end.distance, 3)} times the reference radius`)
  } else {
    moves.push(`maintain radius ${pyFixed(end.distance, 3)} times the reference radius`)
  }
  return moves.join('; simultaneously ')
}

function beatCurves(path: readonly CameraKeyframe[], interpolation: string, detail: PromptDetail = 'extended contracts'): string[] {
  const curve = interpolation !== 'smooth' ? 'linear'
    : detail === 'extended contracts' ? 'monotone cubic per axis' : 'smoothstep'
  return new Array<string>(path.length - 1).fill(curve)
}

/** Build the h3-camera-plan-v15 document. `path` is the SIGNED (mirrored)
 *  trajectory; `end` the clip duration in seconds; `aspect` the reference
 *  frame's width/height (null normalizes to 16:9). */
export function buildPlan(
  path: CameraKeyframe[],
  end: number,
  interpolation: string,
  instruction: string,
  aspect: number | null,
  detail: PromptDetail = 'extended contracts',
): CameraPlan {
  const curves = beatCurves(path, interpolation, detail)
  const segments: CameraSegment[] = []
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1]
    const b = path[i]
    segments.push({
      id: `S${i}`,
      start_s: pyRound(a.time * end, 6),
      end_s: pyRound(b.time * end, 6),
      camera_mode: cameraMode(a, b),
      camera_travel: b.azimuth > a.azimuth ? 'right' : b.azimuth < a.azimuth ? 'left' : 'none',
      signed_orbit_degrees: b.azimuth - a.azimuth,
      speed_curve: curves[i - 1],
      rotation_deg_per_s: pyRound(Math.abs(b.azimuth - a.azimuth) / Math.max((b.time - a.time) * end, 1e-9), 3),
      background_travel: '',
      start: poseOf(a),
      end: poseOf(b),
    })
  }
  const turns = Array.from(reversalIndices(path)).sort((x, y) => x - y)
  const extended = detail !== 'v15 baseline'
  const tailSeconds = (1 - path[path.length - 1].time) * end
  let final: string
  if (tailSeconds >= 1 / FPS - 1e-9) {
    final = `Reach the final pose at ${pyFixed(path[path.length - 1].time * end, 6)}s and hold it through ${pyFixed(end, 6)}s.`
  } else if (tailSeconds > 1e-9) {
    final = `Reach the final pose on the final visible frame at ${pyFixed(end, 6)}s; there is no separate visible hold.`
  } else {
    final = `Reach the final pose at ${pyFixed(end, 6)}s; there is no additional hold.`
  }
  const totalOrbit = path.slice(1).reduce((sum, b, i) => sum + Math.abs(b.azimuth - path[i].azimuth), 0)
  const netOrbit = path[path.length - 1].azimuth - path[0].azimuth
  // Key order is the Python dict's insertion order: head, the four extended
  // contract keys (extended only — baseline pops them, leaving no gap),
  // tail. Object spread preserves that order; segments/final land after the
  // contract keys exactly like upstream.
  const head = {
    schema: 'h3-camera-plan-v15',
    camera_choreography: segments.map((s) => `From ${pyFixed(s.start_s, 3)}s to ${pyFixed(s.end_s, 3)}s: ${s.camera_mode}`).join(' Then '),
    total_orbit_travel_degrees: totalOrbit,
    net_orbit_degrees: netOrbit,
    frame: aspectLabel(aspect),
    duration_s: end,
    fps: FPS,
    reference: 'The input image is the exact first frame. Preserve its original composition and viewing angle.',
    coordinate_convention: 'Azimuth is an unwrapped orbit offset from the reference camera: positive travels toward the '
      + "camera's right, negative toward its left while looking at the target. Do not interpret the sign "
      + 'as the subject own left or right, a pan in place, or a direction for the subject to rotate. '
      + 'Right and left are the moving camera frame while its lens points at the target, not the editor observer view. Elevation is an orbital angle offset relative to the reference '
      + 'camera, not an absolute ground angle or a tilt in place. Zero restores the reference elevation. '
      + 'Radius is distance to the target divided by the starting distance. Keep aiming at the same '
      + 'subject target, keep focal length fixed and camera roll zero. Do not force the source subject '
      + 'into a different initial bounding box. Preserve signed full turns; do not replace them with a shorter arc.',
    preserve: 'The scene and subjects remain rigid in world space: identity, pose, materials, lighting and physical contacts stay unchanged. Only the camera moves. Hold the captured instant: fire, smoke, water and particles keep their captured shapes and world positions; do not continue their motion.',
    motion: interpolation === 'smooth'
      ? (extended
        ? 'Interpolate each axis with a monotone cubic curve. Start and finish at zero speed. '
          + 'Keep each axis velocity continuous at interior keyframes; slow that axis to zero at its holds '
          + 'and reversals. Preserve explicit hold intervals. Never overshoot the two endpoint values. '
          + 'Speed may vary through the take; do not add a stop at every waypoint or a cut.'
        : 'Within EACH segment use smoothstep easing: accelerate from zero speed and decelerate to zero '
          + 'at the next keyframe. Pass through the keyframe without an extra dwell or cut. Angular and '
          + 'radius offsets ease together; interpolate within each pair of endpoints without overshoot.')
      : 'Interpolate the angular offsets and radius linearly WITHIN EACH segment. Speed may change at '
        + 'a keyframe when adjacent segments differ in duration or displacement. No extra dwell or cut.',
    parallax: 'Reveal consistent perspective and occlusion from physical camera motion. Background displacement depends on scene depth; do not prescribe an artificial screen-space shift.',
  }
  const tail = {
    segments,
    final,
    forbid: 'No cuts, subject rotation, subject animation, digital zoom, lighting changes, or visible planning annotations.',
    instruction: instruction.trim() || 'Preserve the source scene.',
    sound: 'Silence.',
  }
  let plan: CameraPlan
  if (extended) {
    plan = {
      ...head,
      axis_separation: 'Follow azimuth, elevation angle and radius independently. An azimuth-only move with fixed '
        + 'elevation and radius stays on a level orbit. Changing radius at a nonzero elevation can also '
        + 'change world height. Do not add an unrequested radius or elevation change.',
      rotation_direction: 'Read signed orbit offsets in the moving camera frame while aiming at the target. Keep the requested direction and full turns; do not rotate the subject instead.',
      completion: totalOrbit > 0.5
        ? `The camera covers ${pyFormatG(totalOrbit)} degrees of `
          + `rotation in ${end.toFixed(3)}s, an average of `
          + `${pyFixed(totalOrbit / Math.max(end, 1e-9), 1)} degrees per `
          + `second over the motion interval, not an instantaneous speed constraint. Follow the segment times and land on signed orbit offset ${pyFormatG(netOrbit)} degrees. `
          + 'Reaching only part of the way is the most common failure: the amount of travel matters as much as '
          + 'its direction, and a small angle must stay small.'
        : '',
      reversals: turns.length > 0
        ? 'Direction reversals at ' + turns.map((i) => `${pyFixed(path[i].time * end, 3)}s`).join(', ')
          + `. At each turnaround ${interpolation === 'smooth' ? 'the orbit axis eases to zero speed and reverses while the other axes follow their own curves' : 'the camera holds its speed into the turn, changes direction and holds it out again'}`
          + ': no added cut or dwell.'
        : '',
      ...tail,
    }
  } else {
    // Baseline must serialise exactly like v15, so the added keys are absent
    // rather than left empty: the JSON formats render every key.
    plan = { ...head, ...tail }
    for (const segment of plan.segments) {
      delete segment.rotation_deg_per_s
      delete segment.background_travel
    }
  }
  return plan
}

export { cameraMode, beatCurves }
