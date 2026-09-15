/**
 * Camera-path validation, ported from validate_path() in camera.py of
 * NyckM/3d-Camera-control-H3-Minimax (v19.1 @ 846880d, Apache-2.0).
 * The error taxonomy is part of the ported contract — every message matches
 * the upstream byte-for-byte (asserted in scripts/test-camera.cjs).
 *
 * Known, documented divergences on pathological inputs (unreachable through
 * the editor, recorded here so a diff against upstream is never a surprise):
 *  - Python's json accepts int values beyond double range where float(value)
 *    would raise OverflowError (uncaught upstream); JS parses 1e999 to
 *    Infinity and this port rejects it with the finite-number message.
 *  - Python's \s in the subject_box regex (coordinateAnchor.ts) is
 *    Unicode-aware over a slightly larger control-char set than JS \s; the
 *    accepted whitespace sets agree on everything a user can type.
 */
import type { CameraKeyframe } from './types'

const FIELDS = ['time', 'azimuth', 'elevation', 'distance'] as const
const ANCHOR: CameraKeyframe = { time: 0, azimuth: 0, elevation: 0, distance: 1 }

/** Parse + validate the trajectory JSON. Throws Error with the upstream
 *  message on any violation; returns the float-coerced keyframes (numbers
 *  are floats by construction in JS, matching Python's float(value)). */
export function validatePath(raw: string | null | undefined): CameraKeyframe[] {
  if (typeof raw !== 'string') throw new Error('Camera path must be a JSON array.')
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    // Python's json accepts NaN / Infinity literals that JSON.parse rejects;
    // null at the same sites produces the identical downstream "must be a
    // finite number" verdict, so substitute and retry once.
    const pyOnly = raw.replace(/(:\s*|,\s*|\[\s*)(-?Infinity|NaN)\b(?=\s*[,\]}])/g, '$1null')
    try {
      data = JSON.parse(pyOnly)
    } catch {
      throw new Error('Camera path must be a JSON array.')
    }
  }
  if (!Array.isArray(data) || data.length < 2 || data.length > 24) {
    throw new Error('Use between 2 and 24 camera keyframes.')
  }
  const result: CameraKeyframe[] = []
  for (const item of data) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error('Each keyframe must be an object.')
    }
    const record = item as Record<string, unknown>
    const pose = {} as CameraKeyframe
    for (const field of FIELDS) {
      const value = record[field]
      if (typeof value === 'boolean' || typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${field} must be a finite number.`)
      }
      pose[field] = value
    }
    if (
      !(pose.time >= 0 && pose.time <= 1)
      || !(pose.elevation >= -89 && pose.elevation <= 89)
      || !(pose.distance >= 0.1 && pose.distance <= 4)
    ) {
      throw new Error('Allowed ranges: time 0..1, elevation -89..89, distance 0.1..4.')
    }
    result.push(pose)
  }
  for (let i = 1; i < result.length; i += 1) {
    if (result[i].time <= result[i - 1].time) {
      throw new Error('Keyframe times must be strictly increasing.')
    }
  }
  const first = result[0]
  const drifted = (['time', 'azimuth', 'elevation', 'distance'] as const)
    .some((k) => Math.abs(first[k] - ANCHOR[k]) > 1e-6)
  if (drifted) {
    throw new Error('The anchored source must start at time=0, azimuth=0, elevation=0, distance=1.')
  }
  let travel = 0
  for (let i = 1; i < result.length; i += 1) travel += Math.abs(result[i].azimuth - result[i - 1].azimuth)
  if (travel > 11520) throw new Error('Azimuth travel exceeds 32 full turns.')
  return result
}
