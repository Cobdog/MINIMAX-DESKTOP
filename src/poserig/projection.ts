/** Orthographic projection — rig space (3D) → canvas pixels (2D).
 *
 * §5.2 #2: "Render = orthographic project to canvas at target resolution."
 * The same basis drives the three.js ORTHOGRAPHIC viewport camera, so what
 * the user poses is exactly what projects. Pure math — node-testable; the
 * scene layer (rigScene.ts) consumes these helpers so browser and tests
 * agree on the mapping.
 *
 * NOTE the §5.2 subtlety: the 2D render's OVERLAP ORDER is the fixed §3
 * draw order (body limbs → joints → hands → face), NOT depth-sorted — that
 * is what the trainer's renderer does, so it is what the model saw. The
 * projection here therefore only needs geometry, not occlusion.
 */

import { vcross, vsub, vadd, vscale, v3, vdot, type Vec3 } from './ik'
import type { KeypointSet134 } from './template'

export type Vec2 = { x: number; y: number }

export type OrbitView = {
  /** Azimuth around the character (radians; 0 = camera on +z). */
  yaw: number
  /** Elevation (radians; 0 = horizontal, positive = looking down). Clamped
   *  to ±85° so the basis never degenerates. */
  pitch: number
}

export const DEFAULT_VIEW: OrbitView = { yaw: 0, pitch: 0.12 }

/** Camera basis: right/up on the image plane + forward (camera → scene).
 *  Character's left stays +x at yaw 0. */
export function viewBasis(view: OrbitView): { right: Vec3; up: Vec3; forward: Vec3 } {
  const pitch = Math.max(-1.4835, Math.min(1.4835, view.pitch)) // ±85°
  const forward = v3(Math.sin(view.yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(view.yaw) * Math.cos(pitch))
  let right = vcross(v3(0, 1, 0), forward)
  if (Math.abs(right.x) + Math.abs(right.y) + Math.abs(right.z) < 1e-9) right = v3(1, 0, 0)
  const rx = right.x, ry = right.y, rz = right.z
  const rl = Math.sqrt(rx * rx + ry * ry + rz * rz)
  right = v3(rx / rl, ry / rl, rz / rl)
  const up = vcross(forward, right)
  return { right, up, forward }
}

export type ProjectionFit = {
  /** World point mapped to the canvas center (rig center). */
  center: Vec3
  /** World units → pixels. Derived from the rig's height and a margin. */
  scale: number
}

/** Compute the fit so the figure's height spans `fill` of the canvas. */
export function fitProjection(points: ReadonlyArray<readonly number[]>, width: number, height: number, fill = 0.72): ProjectionFit {
  let minY = Infinity
  let maxY = -Infinity
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const p of points) {
    if (p[1] < minY) minY = p[1]
    if (p[1] > maxY) maxY = p[1]
    if (p[0] < minX) minX = p[0]
    if (p[0] > maxX) maxX = p[0]
    if (p[2] < minZ) minZ = p[2]
    if (p[2] > maxZ) maxZ = p[2]
  }
  const center = v3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2)
  const worldHeight = Math.max(0.1, maxY - minY)
  const scale = (height * fill) / worldHeight
  return { center, scale }
}

/** Project a single world point (y-down canvas pixels, origin top-left). */
export function projectPoint(p: Vec3, basis: { right: Vec3; up: Vec3 }, fit: ProjectionFit, width: number, height: number): Vec2 {
  const d = vsub(p, fit.center)
  return {
    x: width / 2 + vdot(d, basis.right) * fit.scale,
    y: height / 2 - vdot(d, basis.up) * fit.scale,
  }
}

/** Inverse of the pointer path: screen-space pixel delta → world delta on
 *  the camera plane (the §5.2 "drag targets projected onto a user-facing
 *  plane"). */
export function screenDeltaToWorld(dx: number, dy: number, basis: { right: Vec3; up: Vec3 }, scale: number): Vec3 {
  return vadd(vscale(basis.right, dx / scale), vscale(basis.up, -dy / scale))
}

/** A 134-keypoint set after projection — every part is Vec2 pixels. */
export type ProjectedKeypoints = {
  body: Vec2[]
  feet: Vec2[]
  face: Vec2[]
  handRight: Vec2[]
  handLeft: Vec2[]
}

/** Project a full 134-keypoint set. */
export function projectKeypoints(kp: KeypointSet134, view: OrbitView, fit: ProjectionFit, width: number, height: number): ProjectedKeypoints {
  const basis = viewBasis(view)
  const projectAll = (points: Vec3[]): Vec2[] => points.map((p) => projectPoint(p, basis, fit, width, height))
  return {
    body: projectAll(kp.body),
    feet: projectAll(kp.feet),
    face: projectAll(kp.face),
    handRight: projectAll(kp.handRight),
    handLeft: projectAll(kp.handLeft),
  }
}

/** All 134 keypoints as one flat array (for fitting + bounding). */
export function flattenKeypoints(kp: KeypointSet134): Vec3[] {
  const out: Vec3[] = []
  for (const p of kp.body) out.push(p)
  for (const p of kp.feet) out.push(p)
  for (const p of kp.face) out.push(p)
  for (const p of kp.handRight) out.push(p)
  for (const p of kp.handLeft) out.push(p)
  return out
}

/** The horizontal mirror of a PROJECTED keypoint set (canvas pixels,
 *  x → width − x, hands swapped) — used by the 2D reference overlay. */
export function mirrorKeypoints2D(kp: ProjectedKeypoints, width: number): ProjectedKeypoints {
  const flip = (points: Vec2[]): Vec2[] => points.map((p) => ({ x: width - p.x, y: p.y }))
  return {
    body: flip(kp.body),
    feet: flip(kp.feet),
    face: flip(kp.face),
    handRight: flip(kp.handLeft),
    handLeft: flip(kp.handRight),
  }
}
