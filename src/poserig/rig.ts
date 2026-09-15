/** The rig — joint-position manipulation over a SkeletonTemplate.
 *
 * A "pose" is a plain Record<jointId, Vec3> (cheap to clone, interpolate,
 * serialize). Every mutation here is PURE-ish: functions take a pose and
 * return the same object mutated in place (drag loops need no allocation)
 * unless noted. No three.js / DOM — node-testable.
 *
 * Drag semantics (§5.2 #2): drag targets are projected onto a user-facing
 * plane by the SCENE layer (rigScene.ts converts pointer deltas to world
 * deltas); this layer decides what solving means per joint:
 *   - limb end (wrist/ankle) → analytic two-bone over its chain
 *   - spine chain member (neck) → FABRIK with midHip pinned
 *   - swing tip (nose/head) → radial clamp around its base (head swing)
 *   - root (midHip) → translate the whole figure
 *   - any other joint (elbow/knee/shoulder/hip/spine) → direct FK move
 */

import {
  mirrorX, rotateAroundAxis, solveFabrik, solveTwoBone, vadd, vdist, vsub, vscale,
  type Vec3,
} from './ik'
import { restPositions, type SkeletonTemplate } from './template'

export type RigPose = Record<string, Vec3>

export function clonePose(pose: RigPose): RigPose {
  const out: RigPose = {}
  for (const key of Object.keys(pose)) out[key] = { x: pose[key].x, y: pose[key].y, z: pose[key].z }
  return out
}

/** Bone lengths implied by a pose (used by the solver and preset
 *  normalization — lengths are REST-derived, drags never change them). */
export function poseBoneLengths(template: SkeletonTemplate, pose: RigPose): number[] {
  return template.spineChain
    .slice(0, template.spineChain.length - 1)
    .map((id, i) => vdist(pose[id], pose[template.spineChain[i + 1]]))
}

/** Limb chain lengths from REST (two-bone chains keep rest limb lengths —
 *  the rig has no stretch). */
export function limbLengths(template: SkeletonTemplate, limbIndex: number): { l1: number; l2: number } {
  const rest = restPositions(template)
  const limb = template.limbs[limbIndex]
  return { l1: vdist(rest[limb.root], rest[limb.mid]), l2: vdist(rest[limb.mid], rest[limb.end]) }
}

/** Move `jointId` toward `worldTarget`, solving IK for the affected chain.
 * Returns the joint ids that changed (for cheap scene updates). */
export function dragJoint(template: SkeletonTemplate, pose: RigPose, jointId: string, worldTarget: Vec3): string[] {
  // Limb end-effector: analytic two-bone.
  for (const limb of template.limbs) {
    if (limb.end === jointId) {
      const { l1, l2 } = limbLengths(template, template.limbs.indexOf(limb))
      const solved = solveTwoBone(pose[limb.root], worldTarget, l1, l2, limb.pole)
      pose[limb.mid] = solved.mid
      pose[limb.end] = solved.end
      return [limb.mid, limb.end]
    }
    if (limb.mid === jointId) {
      // Dragging the elbow/knee directly: pure FK placement of the mid joint;
      // the end effector follows rigidly (translate delta).
      const delta = vsub(worldTarget, pose[limb.mid])
      pose[limb.mid] = { x: worldTarget.x, y: worldTarget.y, z: worldTarget.z }
      pose[limb.end] = vadd(pose[limb.end], delta)
      return [limb.mid, limb.end]
    }
  }

  // Spine chain (FABRIK, base pinned).
  const chainIndex = template.spineChain.indexOf(jointId)
  if (chainIndex >= 0) {
    const chain = template.spineChain.map((id) => pose[id])
    // Drag an intermediate spine joint: solve toward a target that keeps the
    // tip near its current position by dragging the CHAIN through this joint.
    // v1 semantics: dragging `neck` moves the chain tip to the target;
    // dragging an interior point translates the whole upper chain.
    if (chainIndex === chain.length - 1) {
      const solved = solveFabrik(chain, worldTarget)
      for (let i = 0; i < template.spineChain.length; i += 1) pose[template.spineChain[i]] = solved.points[i]
      return template.spineChain.slice()
    }
    const delta = vsub(worldTarget, pose[jointId])
    for (let i = chainIndex; i < template.spineChain.length; i += 1) {
      pose[template.spineChain[i]] = vadd(pose[template.spineChain[i]], delta)
    }
    return template.spineChain.slice(chainIndex)
  }

  // Swing joints (head): radial clamp around the base.
  for (const swing of template.swingJoints) {
    if (swing.tip === jointId) {
      const rest = restPositions(template)
      const restLen = vdist(rest[swing.base], rest[swing.tip])
      const dir = vsub(worldTarget, pose[swing.base])
      const len = vdist(pose[swing.base], worldTarget)
      if (len > 1e-9) {
        pose[swing.tip] = vadd(pose[swing.base], vscale(dir, restLen / len))
      }
      return [swing.tip]
    }
  }

  // Root drag: translate the entire figure.
  if (jointId === template.spineChain[0]) {
    const delta = vsub(worldTarget, pose[jointId])
    for (const id of Object.keys(pose)) pose[id] = vadd(pose[id], delta)
    return Object.keys(pose)
  }

  // Free joint (shoulder/hip): direct placement (the parent chain keeps its
  // shape; limbs re-solve on their next drag).
  pose[jointId] = { x: worldTarget.x, y: worldTarget.y, z: worldTarget.z }
  return [jointId]
}

/** Children-first-free rotation: rotate the subtree rooted at `jointId`
 * around `origin`+`axis` (screen-space rotations pass the camera axis). */
export function rotateSubtree(template: SkeletonTemplate, pose: RigPose, jointId: string, axis: Vec3, angleRad: number): string[] {
  const children: Record<string, string[]> = {}
  for (const joint of template.joints) {
    if (joint.parent) {
      if (!children[joint.parent]) children[joint.parent] = []
      children[joint.parent].push(joint.id)
    }
  }
  const affected: string[] = []
  const walk = (id: string) => {
    affected.push(id)
    for (const child of children[id] ?? []) walk(child)
  }
  walk(jointId)
  // The pivot joint itself stays; its descendants rotate about it.
  const origin = pose[jointId]
  for (const id of affected.slice(1)) pose[id] = rotateAroundAxis(pose[id], origin, axis, angleRad)
  return affected.slice(1)
}

/** Keyboard nudge: move `jointId` by `delta` world units (scene layer
 *  converts arrow keys to camera-plane deltas), re-solving IK. */
export function nudgeJoint(template: SkeletonTemplate, pose: RigPose, jointId: string, delta: Vec3): string[] {
  return dragJoint(template, pose, jointId, vadd(pose[jointId], delta))
}

/** Mirror the pose across the sagittal plane (x → −x), swapping L/R pairs
 *  (rShoulder↔lShoulder, …). The result is an exact mirror: applying it
 *  twice returns the original pose. */
export function mirrorPose(template: SkeletonTemplate, pose: RigPose): RigPose {
  const mirrored = clonePose(pose)
  const partner = (id: string): string | undefined => {
    if (id.startsWith('r')) return `l${id.slice(1)}`
    if (id.startsWith('l')) return `r${id.slice(1)}`
    return undefined
  }
  for (const joint of template.joints) {
    const other = partner(joint.id)
    mirrored[joint.id] = mirrorX(other && pose[other] ? pose[other] : pose[joint.id])
  }
  return mirrored
}

/** Re-impose the rig's kinematic constraints on an authored/ad-hed pose:
 * limb mids re-solved (ends kept), spine FABRIK toward the current neck,
 * swing tips clamped. Presets run through this so shipped poses are always
 * bone-length-exact even though their source data is hand-authored. */
export function normalizePose(template: SkeletonTemplate, pose: RigPose): RigPose {
  const rest = restPositions(template)
  // Spine first: FABRIK toward the pose's neck position.
  const chain = template.spineChain.map((id) => pose[id] ?? rest[id])
  const solved = solveFabrik(chain, pose[template.spineChain[template.spineChain.length - 1]] ?? chain[chain.length - 1])
  for (let i = 0; i < template.spineChain.length; i += 1) pose[template.spineChain[i]] = solved.points[i]
  // Limbs: two-bone with rest lengths toward the pose's end positions.
  for (const limb of template.limbs) {
    const target = pose[limb.end] ?? rest[limb.end]
    const l1 = vdist(rest[limb.root], rest[limb.mid])
    const l2 = vdist(rest[limb.mid], rest[limb.end])
    const boneSolved = solveTwoBone(pose[limb.root], target, l1, l2, limb.pole)
    pose[limb.mid] = boneSolved.mid
    pose[limb.end] = boneSolved.end
  }
  // Swing joints: clamp head length.
  for (const swing of template.swingJoints) {
    const restLen = vdist(rest[swing.base], rest[swing.tip])
    const len = vdist(pose[swing.base], pose[swing.tip])
    if (len > 1e-9) pose[swing.tip] = vadd(pose[swing.base], vscale(vsub(pose[swing.tip], pose[swing.base]), restLen / len))
  }
  return pose
}

/** Interpolate two poses (timeline sampling). Joint-wise linear lerp — pose
 *  space is position-based, so linear paths stay bone-length-plausible
 *  between adjacent keyframes; normalizePose() is available for callers that
 *  need hard constraints re-imposed per sampled frame. */
export function lerpPose(a: RigPose, b: RigPose, t: number, template: SkeletonTemplate): RigPose {
  const out: RigPose = {}
  for (const joint of template.joints) {
    const pa = a[joint.id]
    const pb = b[joint.id]
    out[joint.id] = {
      x: pa.x + (pb.x - pa.x) * t,
      y: pa.y + (pb.y - pa.y) * t,
      z: pa.z + (pb.z - pa.z) * t,
    }
  }
  return out
}
