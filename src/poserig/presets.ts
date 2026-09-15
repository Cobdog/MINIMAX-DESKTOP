/** Preset pose library — the cheapest input mode (§5.2 #5: "preset pose/
 *  animation library … from-scratch keyframe authoring (the IK rig proper)").
 *
 * Eight archetypes, hand-authored joint positions. EVERY preset is passed
 * through normalizePose on load, so bone lengths are exact even where the
 * authored numbers are approximate — the solver cleans up the data, the data
 * stays readable. Positions in rig units (meters, y-up, character faces +z,
 * character's left = +x — see template.ts).
 */

import type { Vec3 } from './ik'
import { normalizePose, type RigPose } from './rig'
import { HUMAN_TEMPLATE, type SkeletonTemplate } from './template'

type JointTuple = readonly [number, number, number]

export type PosePreset = {
  id: string
  label: string
  hint: string
  joints: Readonly<Record<string, JointTuple>>
}

export const PRESETS: ReadonlyArray<PosePreset> = [
  {
    id: 'standing',
    label: 'Standing',
    hint: 'neutral rest pose',
    joints: {
      midHip: [0, 1.0, 0], spine: [0, 1.16, 0.01], neck: [0, 1.38, 0.01], nose: [0, 1.58, 0.02],
      rShoulder: [-0.19, 1.36, 0], rElbow: [-0.215, 1.09, 0.02], rWrist: [-0.23, 0.855, 0.05],
      lShoulder: [0.19, 1.36, 0], lElbow: [0.215, 1.09, 0.02], lWrist: [0.23, 0.855, 0.05],
      rHip: [-0.10, 0.97, 0], rKnee: [-0.105, 0.53, 0.02], rAnkle: [-0.11, 0.09, -0.01],
      lHip: [0.10, 0.97, 0], lKnee: [0.105, 0.53, 0.02], lAnkle: [0.11, 0.09, -0.01],
    },
  },
  {
    id: 't-pose',
    label: 'T-pose',
    hint: 'calibration / silhouette',
    joints: {
      midHip: [0, 1.0, 0], spine: [0, 1.16, 0.01], neck: [0, 1.38, 0.01], nose: [0, 1.58, 0.02],
      rShoulder: [-0.19, 1.36, 0], rElbow: [-0.49, 1.36, 0], rWrist: [-0.78, 1.36, 0],
      lShoulder: [0.19, 1.36, 0], lElbow: [0.49, 1.36, 0], lWrist: [0.78, 1.36, 0],
      rHip: [-0.10, 0.97, 0], rKnee: [-0.105, 0.53, 0.01], rAnkle: [-0.11, 0.09, -0.01],
      lHip: [0.10, 0.97, 0], lKnee: [0.105, 0.53, 0.01], lAnkle: [0.11, 0.09, -0.01],
    },
  },
  {
    id: 'walking',
    label: 'Walking',
    hint: 'mid-stride, arms swinging',
    joints: {
      midHip: [0, 1.0, 0.03], spine: [0, 1.16, 0.04], neck: [0, 1.38, 0.04], nose: [0, 1.58, 0.06],
      rShoulder: [-0.19, 1.36, 0.03], rElbow: [-0.25, 1.08, -0.10], rWrist: [-0.29, 0.88, -0.24],
      lShoulder: [0.19, 1.36, 0.03], lElbow: [0.17, 1.10, 0.14], lWrist: [0.14, 0.90, 0.30],
      rHip: [-0.10, 0.97, 0.03], rKnee: [-0.12, 0.54, 0.18], rAnkle: [-0.13, 0.10, 0.34],
      lHip: [0.10, 0.97, 0.03], lKnee: [0.10, 0.55, -0.14], lAnkle: [0.11, 0.12, -0.30],
    },
  },
  {
    id: 'running',
    label: 'Running',
    hint: 'deep stride, arms pumped',
    joints: {
      midHip: [0, 1.0, 0.08], spine: [0, 1.16, 0.11], neck: [0, 1.38, 0.13], nose: [0, 1.57, 0.19],
      rShoulder: [-0.19, 1.36, 0.10], rElbow: [-0.31, 1.12, -0.08], rWrist: [-0.38, 1.26, -0.16],
      lShoulder: [0.19, 1.36, 0.10], lElbow: [0.31, 1.10, 0.10], lWrist: [0.38, 1.22, 0.20],
      rHip: [-0.10, 0.97, 0.08], rKnee: [-0.12, 0.64, 0.20], rAnkle: [-0.16, 0.34, 0.40],
      lHip: [0.10, 0.97, 0.08], lKnee: [0.10, 0.48, -0.18], lAnkle: [0.13, 0.66, -0.36],
    },
  },
  {
    id: 'sitting',
    label: 'Sitting',
    hint: 'seated, knees forward',
    joints: {
      midHip: [0, 0.55, 0], spine: [0, 0.71, 0.01], neck: [0, 0.93, 0.02], nose: [0, 1.13, 0.03],
      rShoulder: [-0.19, 0.91, 0.02], rElbow: [-0.23, 0.62, 0.12], rWrist: [-0.10, 0.60, 0.34],
      lShoulder: [0.19, 0.91, 0.02], lElbow: [0.23, 0.62, 0.12], lWrist: [0.10, 0.60, 0.34],
      rHip: [-0.11, 0.52, 0], rKnee: [-0.13, 0.52, 0.44], rAnkle: [-0.14, 0.10, 0.46],
      lHip: [0.11, 0.52, 0], lKnee: [0.11, 0.52, 0.44], lAnkle: [0.12, 0.10, 0.46],
    },
  },
  {
    id: 'crouch',
    label: 'Crouch',
    hint: 'low, coiled, arms forward',
    joints: {
      midHip: [0, 0.55, -0.06], spine: [0, 0.71, -0.04], neck: [0, 0.93, -0.03], nose: [0, 1.12, -0.01],
      rShoulder: [-0.19, 0.91, -0.02], rElbow: [-0.21, 0.78, 0.14], rWrist: [-0.16, 0.72, 0.42],
      lShoulder: [0.19, 0.91, -0.02], lElbow: [0.21, 0.78, 0.14], lWrist: [0.16, 0.72, 0.42],
      rHip: [-0.10, 0.52, -0.06], rKnee: [-0.21, 0.50, 0.20], rAnkle: [-0.12, 0.09, -0.02],
      lHip: [0.10, 0.52, -0.06], lKnee: [0.21, 0.50, 0.20], lAnkle: [0.12, 0.09, -0.02],
    },
  },
  {
    id: 'reaching',
    label: 'Reaching up',
    hint: 'right hand high, stretching',
    joints: {
      midHip: [0, 1.0, 0], spine: [0.03, 1.17, 0.01], neck: [0.05, 1.39, 0.01], nose: [0.07, 1.58, 0.02],
      rShoulder: [-0.17, 1.37, 0], rElbow: [-0.20, 1.62, 0.01], rWrist: [-0.20, 1.86, 0.02],
      lShoulder: [0.20, 1.35, 0], lElbow: [0.24, 1.08, 0.02], lWrist: [0.26, 0.85, 0.05],
      rHip: [-0.10, 0.97, 0], rKnee: [-0.105, 0.53, 0.01], rAnkle: [-0.11, 0.09, -0.01],
      lHip: [0.10, 0.97, 0], lKnee: [0.105, 0.53, 0.01], lAnkle: [0.11, 0.09, -0.01],
    },
  },
  {
    id: 'victory',
    label: 'Arms raised',
    hint: 'both arms up in a V',
    joints: {
      midHip: [0, 1.0, 0], spine: [0, 1.16, 0.01], neck: [0, 1.38, 0.01], nose: [0, 1.58, 0.02],
      rShoulder: [-0.19, 1.36, 0], rElbow: [-0.37, 1.61, 0], rWrist: [-0.57, 1.87, 0],
      lShoulder: [0.19, 1.36, 0], lElbow: [0.37, 1.61, 0], lWrist: [0.57, 1.87, 0],
      rHip: [-0.10, 0.97, 0], rKnee: [-0.105, 0.53, 0.01], rAnkle: [-0.11, 0.09, -0.01],
      lHip: [0.10, 0.97, 0], lKnee: [0.105, 0.53, 0.01], lAnkle: [0.11, 0.09, -0.01],
    },
  },
]

/** Convert a preset to a rig pose — fill unspecified joints from rest, then
 *  re-impose bone lengths (normalizePose). */
export function presetToPose(preset: PosePreset, template: SkeletonTemplate = HUMAN_TEMPLATE): RigPose {
  const pose: RigPose = {}
  for (const joint of template.joints) {
    const tuple = preset.joints[joint.id]
    if (tuple) pose[joint.id] = { x: tuple[0], y: tuple[1], z: tuple[2] } satisfies Vec3
    else pose[joint.id] = { x: joint.rest.x, y: joint.rest.y, z: joint.rest.z }
  }
  return normalizePose(template, pose)
}
