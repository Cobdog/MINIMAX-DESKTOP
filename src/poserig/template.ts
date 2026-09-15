/** Skeleton templates — the rig's pluggable topology layer.
 *
 * fun-control-input-surface.md §5.2 #4: "the renderer is dumb — the
 * template defines joints/limbs/palette". This module owns the HUMAN_134
 * template (the default) and the AP-10K quadruped template (E-FC1 verdict,
 * 2026-09-15: topology-TOLERANT, not agnostic — AP-10K unlocks as a
 * first-class NON-DEFAULT template with the measured label; free-form
 * stays disabled, envelope-following only). E-FC1 numbers: Flux ma59y73.
 *
 * Pure data + pure functions: no three.js, no DOM (node-testable).
 *
 * Coordinate system: y up, character faces +z, character's LEFT = +x (so a
 * default camera on +z looking back sees the character mirrored the way a
 * real person faces you — their left hand on your right). Units ≈ meters,
 * rest pose is a relaxed standing figure ~1.75 tall (human) / a standing
 * quadruped ~0.75 at the back (AP-10K).
 */

import { vcross, vadd, vsub, vscale, vnorm, v3, vdist, type Vec3 } from './ik'

// ---------------------------------------------------------------------------
// Output model: the full 134-keypoint set in RIG space (3D). drawPose.ts
// consumes its orthographic 2D projection; poseModel.ts serializes it.
// ---------------------------------------------------------------------------

/** Which estimator contract a keypoint set (and its template) targets —
 *  the 2D render branch and the keypoint-JSON export key off this. Default
 *  (undefined) = the human 134 format. */
export type KeypointOutput = 'openpose134' | 'ap10k'

export type KeypointSet134 = {
  /** openpose134: 18 slots. ap10k: 17 slots in AP-10K estimator order
   *  (poseSpec.AP10K_KEYPOINT_NAMES). */
  body: Vec3[]
  feet: Vec3[] // 6 (openpose134; empty for ap10k)
  face: Vec3[] // 68 (openpose134; empty for ap10k)
  handRight: Vec3[] // 21 (openpose134; empty for ap10k)
  handLeft: Vec3[] // 21 (openpose134; empty for ap10k)
  /** The contract this set targets; undefined = openpose134. */
  kind?: KeypointOutput
}

export type TemplateJoint = {
  id: string
  label: string
  /** Rest position (standing neutral). */
  rest: Vec3
  /** Parent joint id (kinematic tree root = midHip); enables subtree
   *  rotation and mirrors. */
  parent?: string
  /** The output body-slot index this joint maps to, if any: the OpenPose
   *  body index for human-134 (nose=0 … lAnkle=13) or the AP-10K keypoint
   *  index for ap10k templates. Joints without one are rig-only (posing
   *  helpers) or procedurally derived (see the template's deriveKeypoints). */
  bodyIndex?: number
}

export type TemplateBone = {
  from: string
  to: string
  /** Palette index for the 3D viewport stick color (visual only — the 2D
   *  render's limb colors come from poseSpec.BODY_LIMB_SEQ, not from this). */
  colorIndex: number
}

export type TemplateLimb = {
  /** Two-bone analytic IK chain: drag `end`, the solver places `mid`. */
  root: string
  mid: string
  end: string
  /** World-space bend hint: elbows back/down, knees forward. */
  pole: Vec3
}

export interface SkeletonTemplate {
  id: string
  label: string
  status: 'shipped' | 'pending'
  pendingNote?: string
  /** Honest-label slot: rendered by the UI whenever THIS template is
   *  selected (pending slots use pendingNote instead). The AP-10K entry
   *  carries its E-FC1-measured adherence label here — keep it verbatim. */
  note?: string
  /** Estimator contract the template's keypoint JSON targets (default
   *  'openpose134'). Also selects the 2D render contract. */
  output?: KeypointOutput
  /** The preset library that applies to this template ('human' = the shipped
   *  archetype presets). Absent → the UI hides the preset panel. */
  presetSet?: 'human'
  joints: ReadonlyArray<TemplateJoint>
  /** Display bones for the 3D viewport. */
  bones: ReadonlyArray<TemplateBone>
  /** Analytic two-bone IK chains (arms, legs). */
  limbs: ReadonlyArray<TemplateLimb>
  /** FABRIK chain (spine-neck); joints[spineChain[0]] is the pinned root. */
  spineChain: ReadonlyArray<string>
  /** The single-bone "swing" joints (radial clamp only): head = nose. */
  swingJoints: ReadonlyArray<{ base: string; tip: string }>
  /** Derive the keypoint output from rig joint positions (procedural
   *  attachment of face / hands / feet / eyes / ears — or, for ap10k, the
   *  head keypoints from the back→neck line). */
  deriveKeypoints: (positions: Record<string, Vec3>) => KeypointSet134
}

// ---------------------------------------------------------------------------
// Head-local frame helpers
// ---------------------------------------------------------------------------

export type Frame3 = { side: Vec3; up: Vec3; forward: Vec3; origin: Vec3 }

/** Head frame from neck→nose. side = character's left (+x at rest),
 *  forward = face direction (+z at rest), up = nose direction. */
export function headFrame(neck: Vec3, nose: Vec3): Frame3 {
  const up = vnorm(vsub(nose, neck))
  let forward = vcross(v3(1, 0, 0), up)
  if (Math.abs(forward.x) + Math.abs(forward.y) + Math.abs(forward.z) < 1e-6) forward = v3(0, 0, 1)
  forward = vnorm(forward)
  const side = vnorm(vcross(up, forward))
  return { side, up, forward, origin: nose }
}

/** Point in a frame from local (u=side, v=up, w=forward) offsets. */
export function framePoint(frame: Frame3, u: number, v: number, w: number): Vec3 {
  return vadd(vadd(vadd(frame.origin, vscale(frame.side, u)), vscale(frame.up, v)), vscale(frame.forward, w))
}

// ---------------------------------------------------------------------------
// Canonical procedural layouts (§5.2 #1: "hands/face default to procedural
// relaxed poses … the training renders always include them, so emit
// plausible ones rather than none")
// ---------------------------------------------------------------------------

/** 68 iBUG-style face landmarks as (side, up, forward) offsets from the nose
 *  tip: 0-16 jaw, 17-21 right brow, 22-26 left brow, 27-35 nose, 36-41 right
 *  eye, 42-47 left eye, 48-59 outer mouth, 60-67 inner mouth. */
export const FACE_LANDMARKS: ReadonlyArray<readonly [number, number, number]> = (() => {
  const pts: Array<[number, number, number]> = []
  // Jaw: half-ellipse from beside the right ear, under the chin, to the left.
  for (let i = 0; i < 17; i += 1) {
    const theta = (-80 + (160 * i) / 16) * (Math.PI / 180)
    pts.push([0.055 * Math.sin(theta), -0.012 - 0.078 * Math.cos(theta), 0.008 - 0.026 * Math.cos(theta)])
  }
  // Brows (right then left), gentle arcs above the eyes.
  for (let i = 0; i < 5; i += 1) pts.push([-0.038 + 0.030 * (i / 4), 0.019 + 0.006 * Math.sin(Math.PI * i / 4), 0.033])
  for (let i = 0; i < 5; i += 1) pts.push([0.008 + 0.030 * (i / 4), 0.019 + 0.006 * Math.sin(Math.PI * i / 4), 0.033])
  // Nose: 9 points — bridge 27-30, base 31-35 (iBUG convention).
  pts.push([0, 0.010, 0.030])
  for (let i = 0; i < 3; i += 1) pts.push([0, 0.010 - 0.034 * ((i + 1) / 4), 0.030 - 0.024 * ((i + 1) / 4)])
  pts.push([-0.010, -0.028, 0.016])
  pts.push([0, -0.030, 0.018])
  pts.push([0.010, -0.028, 0.016])
  pts.push([-0.008, -0.033, 0.010])
  pts.push([0.008, -0.033, 0.010])
  // Eyes: 6 points each on small ellipses.
  for (let i = 0; i < 6; i += 1) {
    const theta = (Math.PI * 2 * i) / 6
    pts.push([-0.024 + 0.010 * Math.cos(theta), 0.009 + 0.005 * Math.sin(theta), 0.030])
  }
  for (let i = 0; i < 6; i += 1) {
    const theta = (Math.PI * 2 * i) / 6
    pts.push([0.024 + 0.010 * Math.cos(theta), 0.009 + 0.005 * Math.sin(theta), 0.030])
  }
  // Mouth outer (12) + inner (8).
  for (let i = 0; i < 12; i += 1) {
    const theta = (Math.PI * 2 * i) / 12
    pts.push([0.024 * Math.cos(theta), -0.054 + 0.011 * Math.sin(theta), 0.030])
  }
  for (let i = 0; i < 8; i += 1) {
    const theta = (Math.PI * 2 * i) / 8
    pts.push([0.016 * Math.cos(theta), -0.054 + 0.006 * Math.sin(theta), 0.032])
  }
  return pts
})()

/** Eyes/ears (OpenPose body 14-17) as (side, up, forward) offsets from nose. */
export const EYE_RIGHT_LOCAL: readonly [number, number, number] = [-0.036, 0.024, 0.024]
export const EYE_LEFT_LOCAL: readonly [number, number, number] = [0.036, 0.024, 0.024]
export const EAR_RIGHT_LOCAL: readonly [number, number, number] = [-0.085, 0.022, -0.070]
export const EAR_LEFT_LOCAL: readonly [number, number, number] = [0.085, 0.022, -0.070]

/** One hand's 21 points as (spread=thumb side, thick=palm normal, along)
 *  offsets in units of hand length; wrist at origin, fingers along +1.
 *  Relaxed, slightly curled — §5.2 "procedural relaxed poses". */
export const HAND_LOCAL: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], // 0 wrist
  [0.16, 0.14, 0.10], [0.22, 0.17, 0.20], [0.26, 0.18, 0.30], [0.29, 0.175, 0.38], // thumb 1-4
  [0.10, 0.03, 0.28], [0.11, 0.02, 0.48], [0.115, 0.01, 0.64], [0.12, 0.005, 0.76], // index 5-8
  [0.02, 0.03, 0.30], [0.02, 0.02, 0.52], [0.02, 0.01, 0.71], [0.02, 0.005, 0.84], // middle 9-12
  [-0.06, 0.03, 0.28], [-0.07, 0.02, 0.48], [-0.075, 0.01, 0.65], [-0.08, 0.005, 0.77], // ring 13-16
  [-0.13, 0.03, 0.25], [-0.145, 0.02, 0.41], [-0.155, 0.01, 0.54], [-0.16, 0.005, 0.64], // pinky 17-20
]

/** Relaxed hand attached to a wrist: frame from the forearm direction
 *  (fingers continue the forearm line, thumb toward the character's front).
 *  `outward` = +1 for the LEFT hand, −1 for the RIGHT. Scale = hand length
 *  (≈ 0.68 × forearm, human proportion). */
export function deriveHand(elbow: Vec3, wrist: Vec3, outward: number): Vec3[] {
  const along = vnorm(vsub(wrist, elbow))
  const handLen = 0.68 * vdist(wrist, elbow)
  let outwardAxis = vcross(along, v3(0, 0, 1))
  if (Math.abs(outwardAxis.x) + Math.abs(outwardAxis.y) + Math.abs(outwardAxis.z) < 1e-6) {
    outwardAxis = v3(outward, 0, 0)
  }
  // Spread axis: outward projected perpendicular to `along`; thickness fills
  // the frame. Thumb side = spread × outward.
  let spread = vsub(outwardAxis, vscale(along, outwardAxis.x * along.x + outwardAxis.y * along.y + outwardAxis.z * along.z))
  if (Math.abs(spread.x) + Math.abs(spread.y) + Math.abs(spread.z) < 1e-6) spread = v3(0, 0, 1)
  spread = vscale(vnorm(spread), outward)
  const thick = vcross(along, spread)
  const out: Vec3[] = []
  for (let i = 0; i < HAND_LOCAL.length; i += 1) {
    const local = HAND_LOCAL[i]
    out.push(vadd(vadd(vadd(wrist, vscale(spread, local[0] * handLen)), vscale(thick, local[1] * handLen)), vscale(along, local[2] * handLen)))
  }
  return out
}

/** Six foot points from the ankle. The foot extends along the character's
 *  FACING (+z, orthogonalized against the shin) — not along the shin, which
 *  for a standing leg points into the floor and would put the heel up the
 *  calf. Toes spread across the body side; the heel sits behind and below
 *  the ankle. Order (COCO-WholeBody feet): L big toe, L small toe, L heel,
 *  R big toe, R small toe, R heel. */
export function deriveFeet(knee: Vec3, ankle: Vec3, outward: number): { bigToe: Vec3; smallToe: Vec3; heel: Vec3 } {
  const shin = vnorm(vsub(ankle, knee))
  const worldForward = v3(0, 0, 1)
  let foot = vsub(worldForward, vscale(shin, worldForward.x * shin.x + worldForward.y * shin.y + worldForward.z * shin.z))
  if (Math.abs(foot.x) + Math.abs(foot.y) + Math.abs(foot.z) < 1e-6) foot = v3(0, 0, 1)
  foot = vnorm(foot)
  const worldSide = v3(outward, 0, 0)
  let side = vsub(worldSide, vscale(foot, worldSide.x * foot.x + worldSide.y * foot.y + worldSide.z * foot.z))
  if (Math.abs(side.x) + Math.abs(side.y) + Math.abs(side.z) < 1e-6) side = v3(outward, 0, 0)
  return {
    bigToe: vadd(vadd(vadd(ankle, vscale(foot, 0.095)), vscale(side, -0.014)), v3(0, -0.032, 0)),
    smallToe: vadd(vadd(vadd(ankle, vscale(foot, 0.088)), vscale(side, 0.028)), v3(0, -0.036, 0)),
    heel: vadd(vadd(vsub(ankle, vscale(foot, 0.055)), v3(0, -0.045, 0)), vscale(side, 0.004)),
  }
}

// ---------------------------------------------------------------------------
// HUMAN_134 — the shipped template
// ---------------------------------------------------------------------------

/** Editable rig joints (ids are stable API for presets + tests). Rest values
 *  keep human proportions; bone lengths are derived from them. */
export const HUMAN_JOINTS: ReadonlyArray<TemplateJoint> = [
  { id: 'midHip', label: 'Hips (root)', rest: v3(0, 1.00, 0), parent: undefined },
  { id: 'spine', label: 'Spine', rest: v3(0, 1.16, 0.01), parent: 'midHip' },
  { id: 'neck', label: 'Neck', rest: v3(0, 1.38, 0.01), parent: 'spine' },
  { id: 'nose', label: 'Head', rest: v3(0, 1.58, 0.02), parent: 'neck', bodyIndex: 0 },
  { id: 'rShoulder', label: 'R shoulder', rest: v3(-0.19, 1.36, 0), parent: 'neck', bodyIndex: 2 },
  { id: 'rElbow', label: 'R elbow', rest: v3(-0.215, 1.09, 0.02), parent: 'rShoulder', bodyIndex: 3 },
  { id: 'rWrist', label: 'R wrist', rest: v3(-0.23, 0.855, 0.05), parent: 'rElbow', bodyIndex: 4 },
  { id: 'lShoulder', label: 'L shoulder', rest: v3(0.19, 1.36, 0), parent: 'neck', bodyIndex: 5 },
  { id: 'lElbow', label: 'L elbow', rest: v3(0.215, 1.09, 0.02), parent: 'lShoulder', bodyIndex: 6 },
  { id: 'lWrist', label: 'L wrist', rest: v3(0.23, 0.855, 0.05), parent: 'lElbow', bodyIndex: 7 },
  { id: 'rHip', label: 'R hip', rest: v3(-0.10, 0.97, 0), parent: 'midHip', bodyIndex: 8 },
  { id: 'rKnee', label: 'R knee', rest: v3(-0.105, 0.53, 0.02), parent: 'rHip', bodyIndex: 9 },
  { id: 'rAnkle', label: 'R ankle', rest: v3(-0.11, 0.09, -0.01), parent: 'rKnee', bodyIndex: 10 },
  { id: 'lHip', label: 'L hip', rest: v3(0.10, 0.97, 0), parent: 'midHip', bodyIndex: 11 },
  { id: 'lKnee', label: 'L knee', rest: v3(0.105, 0.53, 0.02), parent: 'lHip', bodyIndex: 12 },
  { id: 'lAnkle', label: 'L ankle', rest: v3(0.11, 0.09, -0.01), parent: 'lKnee', bodyIndex: 13 },
]

export const HUMAN_TEMPLATE: SkeletonTemplate = {
  id: 'human-134',
  label: 'Human (DWPose 134)',
  status: 'shipped',
  note: 'Default template — the palette-exact DWPose 134 contract (§3), the measured-baseline pose path.',
  presetSet: 'human',
  joints: HUMAN_JOINTS,
  bones: [
    { from: 'midHip', to: 'spine', colorIndex: 6 },
    { from: 'spine', to: 'neck', colorIndex: 7 },
    { from: 'neck', to: 'nose', colorIndex: 0 },
    { from: 'neck', to: 'rShoulder', colorIndex: 0 },
    { from: 'rShoulder', to: 'rElbow', colorIndex: 2 },
    { from: 'rElbow', to: 'rWrist', colorIndex: 3 },
    { from: 'neck', to: 'lShoulder', colorIndex: 1 },
    { from: 'lShoulder', to: 'lElbow', colorIndex: 4 },
    { from: 'lElbow', to: 'lWrist', colorIndex: 5 },
    { from: 'midHip', to: 'rHip', colorIndex: 8 },
    { from: 'rHip', to: 'rKnee', colorIndex: 9 },
    { from: 'rKnee', to: 'rAnkle', colorIndex: 10 },
    { from: 'midHip', to: 'lHip', colorIndex: 11 },
    { from: 'lHip', to: 'lKnee', colorIndex: 12 },
    { from: 'lKnee', to: 'lAnkle', colorIndex: 13 },
  ],
  limbs: [
    { root: 'rShoulder', mid: 'rElbow', end: 'rWrist', pole: v3(0, -1, -1) },
    { root: 'lShoulder', mid: 'lElbow', end: 'lWrist', pole: v3(0, -1, -1) },
    { root: 'rHip', mid: 'rKnee', end: 'rAnkle', pole: v3(0, 0, 1) },
    { root: 'lHip', mid: 'lKnee', end: 'lAnkle', pole: v3(0, 0, 1) },
  ],
  spineChain: ['midHip', 'spine', 'neck'],
  swingJoints: [{ base: 'neck', tip: 'nose' }],
  deriveKeypoints: (positions) => {
    const neck = positions.neck
    const nose = positions.nose
    const head = headFrame(neck, nose)

    const body: Vec3[] = new Array(18)
    body[0] = nose
    body[1] = neck
    body[2] = positions.rShoulder
    body[3] = positions.rElbow
    body[4] = positions.rWrist
    body[5] = positions.lShoulder
    body[6] = positions.lElbow
    body[7] = positions.lWrist
    body[8] = positions.rHip
    body[9] = positions.rKnee
    body[10] = positions.rAnkle
    body[11] = positions.lHip
    body[12] = positions.lKnee
    body[13] = positions.lAnkle
    body[14] = framePoint(head, EYE_RIGHT_LOCAL[0], EYE_RIGHT_LOCAL[1], EYE_RIGHT_LOCAL[2])
    body[15] = framePoint(head, EYE_LEFT_LOCAL[0], EYE_LEFT_LOCAL[1], EYE_LEFT_LOCAL[2])
    body[16] = framePoint(head, EAR_RIGHT_LOCAL[0], EAR_RIGHT_LOCAL[1], EAR_RIGHT_LOCAL[2])
    body[17] = framePoint(head, EAR_LEFT_LOCAL[0], EAR_LEFT_LOCAL[1], EAR_LEFT_LOCAL[2])

    const face: Vec3[] = []
    for (let i = 0; i < FACE_LANDMARKS.length; i += 1) {
      const local = FACE_LANDMARKS[i]
      face.push(framePoint(head, local[0], local[1], local[2]))
    }

    const handRight = deriveHand(positions.rElbow, positions.rWrist, -1)
    const handLeft = deriveHand(positions.lElbow, positions.lWrist, 1)

    const rightFoot = deriveFeet(positions.rKnee, positions.rAnkle, -1)
    const leftFoot = deriveFeet(positions.lKnee, positions.lAnkle, 1)
    const feet = [leftFoot.bigToe, leftFoot.smallToe, leftFoot.heel, rightFoot.bigToe, rightFoot.smallToe, rightFoot.heel]

    return { body, feet, face, handRight, handLeft }
  },
}

// ---------------------------------------------------------------------------
// AP10K — the E-FC1-unlocked quadruped template (NON-DEFAULT)
// ---------------------------------------------------------------------------

/** Editable rig joints for the quadruped. 14 of the 17 AP-10K keypoints are
 *  directly poseable (their `bodyIndex` = the AP-10K slot, see
 *  poseSpec.AP10K_KEYPOINT_NAMES); the two eyes and the nose derive
 *  procedurally from the back→neck line. `back` is a rig-only root joint
 *  (the AP-10K skeleton's neck—tail edge passes through it). Rest pose: a
 *  relaxed standing dog-type quadruped, ~0.75 at the back, facing +z. */
export const AP10K_JOINTS: ReadonlyArray<TemplateJoint> = [
  { id: 'back', label: 'Back (root)', rest: v3(0, 0.62, 0), parent: undefined },
  { id: 'neck', label: 'Neck', rest: v3(0, 0.68, 0.28), parent: 'back', bodyIndex: 3 },
  { id: 'tailRoot', label: 'Tail root', rest: v3(0, 0.62, -0.28), parent: 'back', bodyIndex: 4 },
  { id: 'lFrontShoulder', label: 'L front shoulder', rest: v3(0.10, 0.55, 0.24), parent: 'neck', bodyIndex: 5 },
  { id: 'lFrontKnee', label: 'L front knee', rest: v3(0.105, 0.30, 0.20), parent: 'lFrontShoulder', bodyIndex: 6 },
  { id: 'lFrontPaw', label: 'L front paw', rest: v3(0.11, 0.05, 0.21), parent: 'lFrontKnee', bodyIndex: 7 },
  { id: 'rFrontShoulder', label: 'R front shoulder', rest: v3(-0.10, 0.55, 0.24), parent: 'neck', bodyIndex: 8 },
  { id: 'rFrontKnee', label: 'R front knee', rest: v3(-0.105, 0.30, 0.20), parent: 'rFrontShoulder', bodyIndex: 9 },
  { id: 'rFrontPaw', label: 'R front paw', rest: v3(-0.11, 0.05, 0.21), parent: 'rFrontKnee', bodyIndex: 10 },
  { id: 'lBackHip', label: 'L hip', rest: v3(0.10, 0.58, -0.24), parent: 'tailRoot', bodyIndex: 11 },
  { id: 'lBackKnee', label: 'L back knee', rest: v3(0.105, 0.33, -0.17), parent: 'lBackHip', bodyIndex: 12 },
  { id: 'lBackPaw', label: 'L back paw', rest: v3(0.11, 0.05, -0.23), parent: 'lBackKnee', bodyIndex: 13 },
  { id: 'rBackHip', label: 'R hip', rest: v3(-0.10, 0.58, -0.24), parent: 'tailRoot', bodyIndex: 14 },
  { id: 'rBackKnee', label: 'R back knee', rest: v3(-0.105, 0.33, -0.17), parent: 'rBackHip', bodyIndex: 15 },
  { id: 'rBackPaw', label: 'R back paw', rest: v3(-0.11, 0.05, -0.23), parent: 'rBackKnee', bodyIndex: 16 },
]

/** The E-FC1 verdict template. UNLOCKED (renders true quadrupeds, zero
 *  humanization — arm B) but NON-DEFAULT: measured ~2–3× the human-skeleton
 *  round-trip error and 1.4–2× the sprite/region ceiling. The `note` is the
 *  measured label, rendered at selection time — keep it verbatim. Its
 *  keypoint JSON targets the AP-10K estimator format (poseModel.ts), and
 *  its 2D render is the AnimalPose line renderer (poseSpec + drawPose). */
export const AP10K_TEMPLATE: SkeletonTemplate = {
  id: 'ap10k-quadruped',
  label: 'AP-10K quadruped (dog-type)',
  status: 'shipped',
  output: 'ap10k',
  note: 'Looser adherence — measured ~2–3× human-skeleton error, 1.4–2× sprite mode; renders true quadrupeds, no humanization (E-FC1, 2026-09-15)',
  joints: AP10K_JOINTS,
  bones: [
    { from: 'back', to: 'neck', colorIndex: 0 },
    { from: 'back', to: 'tailRoot', colorIndex: 7 },
    { from: 'neck', to: 'lFrontShoulder', colorIndex: 1 },
    { from: 'lFrontShoulder', to: 'lFrontKnee', colorIndex: 2 },
    { from: 'lFrontKnee', to: 'lFrontPaw', colorIndex: 3 },
    { from: 'neck', to: 'rFrontShoulder', colorIndex: 4 },
    { from: 'rFrontShoulder', to: 'rFrontKnee', colorIndex: 5 },
    { from: 'rFrontKnee', to: 'rFrontPaw', colorIndex: 6 },
    { from: 'tailRoot', to: 'lBackHip', colorIndex: 8 },
    { from: 'lBackHip', to: 'lBackKnee', colorIndex: 9 },
    { from: 'lBackKnee', to: 'lBackPaw', colorIndex: 10 },
    { from: 'tailRoot', to: 'rBackHip', colorIndex: 11 },
    { from: 'rBackHip', to: 'rBackKnee', colorIndex: 12 },
    { from: 'rBackKnee', to: 'rBackPaw', colorIndex: 13 },
  ],
  limbs: [
    // Front carpi fold BACK, hind stifles fold FORWARD (dog anatomy).
    { root: 'lFrontShoulder', mid: 'lFrontKnee', end: 'lFrontPaw', pole: v3(0, -1, -1) },
    { root: 'rFrontShoulder', mid: 'rFrontKnee', end: 'rFrontPaw', pole: v3(0, -1, -1) },
    { root: 'lBackHip', mid: 'lBackKnee', end: 'lBackPaw', pole: v3(0, -1, 1) },
    { root: 'rBackHip', mid: 'rBackKnee', end: 'rBackPaw', pole: v3(0, -1, 1) },
  ],
  // FABRIK topline (tail→back→neck): dragging the head bends the whole
  // back like the human's spine chain; no swing joints — the head keypoints
  // derive procedurally from the back→neck line instead.
  spineChain: ['tailRoot', 'back', 'neck'],
  swingJoints: [],
  deriveKeypoints: (positions) => {
    // Poseable keypoints land in their AP-10K slot.
    const body: Vec3[] = new Array(17)
    for (const joint of AP10K_JOINTS) {
      if (joint.bodyIndex !== undefined) body[joint.bodyIndex] = positions[joint.id]
    }
    // Procedural head: the muzzle continues the back→neck line; the eyes
    // sit either side of the skull base (animal's left = +x at rest).
    const dir = vnorm(vsub(positions.neck, positions.back))
    let side = vcross(v3(0, 1, 0), dir)
    if (Math.abs(side.x) + Math.abs(side.y) + Math.abs(side.z) < 1e-6) side = v3(1, 0, 0)
    side = vnorm(side)
    body[2] = vadd(positions.neck, vscale(dir, 0.17))
    body[0] = vadd(vadd(positions.neck, vscale(dir, 0.07)), vscale(side, 0.048))
    body[1] = vadd(vadd(positions.neck, vscale(dir, 0.07)), vscale(side, -0.048))
    return { kind: 'ap10k', body, feet: [], face: [], handRight: [], handLeft: [] }
  },
}

/** Registry — human-134 is the DEFAULT; AP-10K is first-class NON-DEFAULT
 *  (E-FC1); the free-form slot stays a DOCUMENTED PENDING entry so the UI
 *  and tests can enumerate it without stub code that pretends to work. */
export const DEFAULT_TEMPLATE_ID = 'human-134'

export const TEMPLATES: ReadonlyArray<SkeletonTemplate> = [
  HUMAN_TEMPLATE,
  AP10K_TEMPLATE,
  {
    ...HUMAN_TEMPLATE,
    id: 'freeform',
    label: 'Freeform creature (disabled)',
    status: 'pending',
    pendingNote: 'Envelope-following only — E-FC1 arm C: zero per-limb articulation with conflicting topology (a humanoid-mimic skeleton over a dog trajectory rendered a spectral figure riding the path; DWPose found a person in 0/39 frames). Per-limb articulation for arbitrary graphs is NOT promisable at v1.',
  },
]

export function templateById(id: string): SkeletonTemplate | undefined {
  for (const template of TEMPLATES) if (template.id === id) return template
  return undefined
}

/** Rest-pose position map (a fresh, mutable rig state). */
export function restPositions(template: SkeletonTemplate): Record<string, Vec3> {
  const out: Record<string, Vec3> = {}
  for (const joint of template.joints) out[joint.id] = { x: joint.rest.x, y: joint.rest.y, z: joint.rest.z }
  return out
}
