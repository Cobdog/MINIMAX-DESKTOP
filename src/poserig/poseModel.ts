/** The pose data model — timeline, OpenPose-134 JSON, and the grid.
 *
 * Frame grid: the H3 video VAE decodes on 17n+5 (5/22/39/56… ≤15 s @ 24 fps
 * — fun-control-input-surface.md §1c). The timeline's TOTAL length is
 * grid-compliant (same semantics as src/lib/workflow.ts frameCount, which
 * rounds up to the next grid point so the decode trims down), and authored
 * KEYFRAMES snap to grid frames. Keypoint JSON is the rig's internal
 * representation — the model never sees it (§5.2 "contract first").
 *
 * Serialization format = the OpenPose/SDPose frame dict the native
 * `SDPoseDrawKeypoints` node consumes (per-frame canvas size, one person,
 * flat [x, y, score] triples; see poseSpec.ts header for the slot layout).
 *
 * Pure data logic — no three.js / DOM (node-testable).
 */

import type { Vec3 } from './ik'
import { vdist } from './ik'
import { clonePose, lerpPose, normalizePose, type RigPose } from './rig'
import { restPositions, type SkeletonTemplate } from './template'
import { flattenKeypoints, type OrbitView, type ProjectedKeypoints, type Vec2, fitProjection, projectKeypoints } from './projection'
import { buildDrawOps, opsFingerprint, type PoseDrawOptions } from './drawPose'

export const FPS = 24
export const GRID_STEP = 17
export const GRID_OFFSET = 5
export const MAX_SECONDS = 15

/** The hard clip: 15 s @ 24 fps = 360 frames, and the grid only offers
 *  17n+5 — so the largest legal total is 345 (14.375 s). workflow.ts's
 *  frameCount(15) = 362 pads UP for decode-trim semantics; the rig CLIPS
 *  here instead because it AUTHORS the exact frame count. */
export const MAX_TOTAL_FRAMES = 345

/** Total frames for a duration — smallest 17n+5 ≥ seconds×24 (matches
 *  workflow.ts frameCount: pad UP, the decode trims down). */
export function frameCount(seconds: number): number {
  const base = Math.max(GRID_OFFSET, Math.round(seconds * FPS))
  return base + ((GRID_OFFSET - (base % GRID_STEP) + GRID_STEP) % GRID_STEP)
}

/** All grid frames from 5 to total (inclusive): [5, 22, 39, …]. */
export function gridFrames(total: number): number[] {
  const out: number[] = []
  for (let f = GRID_OFFSET; f <= total; f += GRID_STEP) out.push(f)
  return out
}

/** Nearest grid frame to `frame` (clamped into [5, total]). */
export function snapToGrid(frame: number, total: number): number {
  const clamped = Math.max(GRID_OFFSET, Math.min(total, Math.round(frame)))
  const lower = GRID_OFFSET + Math.floor((clamped - GRID_OFFSET) / GRID_STEP) * GRID_STEP
  const upper = Math.min(total, lower + GRID_STEP)
  return clamped - lower <= upper - clamped ? lower : upper
}

export function isOnGrid(frame: number): boolean {
  return frame >= GRID_OFFSET && (frame - GRID_OFFSET) % GRID_STEP === 0
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export type PoseKeyframe = { frame: number; pose: RigPose }

export type PoseTimeline = {
  templateId: string
  /** Total frame count (grid-compliant). */
  totalFrames: number
  /** Keyframes sorted by frame. */
  keyframes: PoseKeyframe[]
  view: OrbitView
  canvas: { width: number; height: number }
}

export function createTimeline(template: SkeletonTemplate, seconds = 2, canvas = { width: 512, height: 512 }): PoseTimeline {
  const total = Math.min(frameCount(seconds), MAX_TOTAL_FRAMES)
  return {
    templateId: template.id,
    totalFrames: total,
    keyframes: [{ frame: GRID_OFFSET, pose: clonePose(createRestPose(template)) }],
    view: { yaw: 0, pitch: 0.12 },
    canvas,
  }
}

/** Rest pose as a RigPose. */
export function createRestPose(template: SkeletonTemplate): RigPose {
  return restPositions(template)
}

/** Pose at an arbitrary frame: linear interpolation between the surrounding
 *  keyframes; hold the ends beyond them (the apply node's last-frame-hold
 *  semantics — §1c). */
export function samplePose(timeline: PoseTimeline, frame: number, template: SkeletonTemplate): RigPose {
  const keys = timeline.keyframes
  if (keys.length === 0) return createRestPose(template)
  if (frame <= keys[0].frame) return clonePose(keys[0].pose)
  const last = keys[keys.length - 1]
  if (frame >= last.frame) return clonePose(last.pose)
  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = keys[i]
    const b = keys[i + 1]
    if (frame >= a.frame && frame <= b.frame) {
      const t = (frame - a.frame) / (b.frame - a.frame)
      return lerpPose(a.pose, b.pose, t, template)
    }
  }
  return clonePose(last.pose)
}

export function addKeyframe(timeline: PoseTimeline, frame: number, pose: RigPose): PoseTimeline {
  const snapped = snapToGrid(frame, timeline.totalFrames)
  const keyframes = timeline.keyframes.filter((entry) => entry.frame !== snapped)
  keyframes.push({ frame: snapped, pose })
  keyframes.sort((a, b) => a.frame - b.frame)
  return { ...timeline, keyframes }
}

export function moveKeyframe(timeline: PoseTimeline, from: number, to: number): PoseTimeline {
  const target = snapToGrid(to, timeline.totalFrames)
  const existing = timeline.keyframes.filter((entry) => entry.frame === target && entry.frame !== from)
  if (existing.length > 0) return timeline // never merge keyframes silently
  const keyframes = timeline.keyframes.map((entry) => (entry.frame === from ? { frame: target, pose: entry.pose } : entry))
  keyframes.sort((a, b) => a.frame - b.frame)
  return { ...timeline, keyframes }
}

export function deleteKeyframe(timeline: PoseTimeline, frame: number): PoseTimeline {
  return { ...timeline, keyframes: timeline.keyframes.filter((entry) => entry.frame !== frame) }
}

// ---------------------------------------------------------------------------
// OpenPose-134 JSON (the internal representation + SDPose bridge format)
// ---------------------------------------------------------------------------

export type OpenPosePerson = {
  pose_keypoints_2d: number[] // 18 × 3
  foot_keypoints_2d: number[] // 6 × 3
  face_keypoints_2d: number[] // 70 × 3 (68 landmarks + REye + LEye appended —
  // exactly how SDPose serializes; the draw node drops the appended pair)
  hand_right_keypoints_2d: number[] // 21 × 3
  hand_left_keypoints_2d: number[] // 21 × 3
}

export type OpenPoseFrame = {
  canvas_width: number
  canvas_height: number
  people: OpenPosePerson[]
}

/** Project a rig pose at `view` onto a canvas and emit the OpenPose person
 *  dict (score 1.0 for authored keypoints — the rig always "detects" its own
 *  output; the 0-score absence mechanism is for extracted keypoints). */
export function personFromPose(kp: ProjectedKeypoints): OpenPosePerson {
  const flat = (points: ReadonlyArray<Vec2 | Vec3>) => {
    const out: number[] = []
    for (const p of points) out.push(Math.trunc(p.x), Math.trunc(p.y), 1)
    return out
  }
  // face: 68 landmarks + REye(body[14]) + LEye(body[15]) appended (SDPose).
  const face = flat(kp.face).concat(flat([kp.body[14], kp.body[15]]))
  return {
    pose_keypoints_2d: flat(kp.body),
    foot_keypoints_2d: flat(kp.feet),
    face_keypoints_2d: face,
    hand_right_keypoints_2d: flat(kp.handRight),
    hand_left_keypoints_2d: flat(kp.handLeft),
  }
}

export function frameFromPose(kp: ProjectedKeypoints, canvas: { width: number; height: number }): OpenPoseFrame {
  return { canvas_width: canvas.width, canvas_height: canvas.height, people: [personFromPose(kp)] }
}

/** Reconstruct renderable keypoints from a serialized person (the renderer
 *  round-trip: rig → project → JSON → THESE keypoints → identical draw ops).
 *  The appended eye pair (face indices 68-69) is dropped — SDPose adds it on
 *  serialize and drops it on draw; so do we. */
export function projectedFromPerson(person: OpenPosePerson): ProjectedKeypoints {
  const unflat = (flat: ReadonlyArray<number>, count: number): Vec2[] => {
    const out: Vec2[] = []
    for (let i = 0; i < count; i += 1) out.push({ x: flat[i * 3] ?? 0, y: flat[i * 3 + 1] ?? 0 })
    return out
  }
  return {
    body: unflat(person.pose_keypoints_2d, 18),
    feet: unflat(person.foot_keypoints_2d, 6),
    face: unflat(person.face_keypoints_2d, 68),
    handRight: unflat(person.hand_right_keypoints_2d, 21),
    handLeft: unflat(person.hand_left_keypoints_2d, 21),
  }
}

/** Full-timeline export: one OpenPose frame per video frame 0..total-1. */
export function exportOpenPoseJson(timeline: PoseTimeline, template: SkeletonTemplate, derive: (pose: RigPose) => ProjectedKeypoints): OpenPoseFrame[] {
  const frames: OpenPoseFrame[] = []
  for (let frame = 0; frame < timeline.totalFrames; frame += 1) {
    frames.push(frameFromPose(derive(samplePose(timeline, frame, template)), timeline.canvas))
  }
  return frames
}

/** Parse + validate imported OpenPose/SDPose JSON (pose-transfer input).
 *  Returns the first person of the first well-formed frame or a reason. */
export function parseOpenPoseJson(data: unknown): { frames: OpenPoseFrame[] } | { error: string } {
  if (!Array.isArray(data) || data.length === 0) return { error: 'expected a non-empty array of frames' }
  for (const frame of data) {
    if (typeof frame !== 'object' || frame === null) return { error: 'frame is not an object' }
    const record = frame as Record<string, unknown>
    if (typeof record.canvas_width !== 'number' || typeof record.canvas_height !== 'number') return { error: 'frame missing canvas_width/canvas_height' }
    if (!Array.isArray(record.people) || record.people.length === 0) return { error: 'frame has no people' }
    for (const person of record.people) {
      const p = person as Record<string, unknown>
      const body = p.pose_keypoints_2d
      if (!Array.isArray(body) || body.length !== 18 * 3) return { error: `pose_keypoints_2d must be 18×3 flat (got ${Array.isArray(body) ? body.length : 'non-array'})` }
    }
  }
  return { frames: data as OpenPoseFrame[] }
}

/** Import the body skeleton of an OpenPose frame into a rig pose: 2D
 *  keypoints lifted to the z=0 plane (y flipped to y-up), uniformly rescaled
 *  to the template's BODY span, then bone lengths re-imposed by
 *  normalizePose (honest 2.5D import — depth comes out flat; re-posing in
 *  depth is the rig's job afterwards). Returns null when the frame lacks a
 *  usable body. */
export function poseFromFrame(frame: OpenPoseFrame, template: SkeletonTemplate): RigPose | null {
  const person = frame.people[0]
  if (!person) return null
  const bodyFlat = person.pose_keypoints_2d
  if (bodyFlat.length < 14 * 3) return null
  const canvasH = frame.canvas_height || 1
  const bodyIds = ['nose', 'neck', 'rShoulder', 'rElbow', 'rWrist', 'lShoulder', 'lElbow', 'lWrist', 'rHip', 'rKnee', 'rAnkle', 'lHip', 'lKnee', 'lAnkle']
  const pose: RigPose = {}
  for (let i = 0; i < bodyIds.length; i += 1) {
    const x = bodyFlat[i * 3]
    const y = bodyFlat[i * 3 + 1]
    pose[bodyIds[i]] = { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? canvasH - y : 0, z: 0 }
  }
  // Uniform rescale: source body span (pixels, y-up) → template body span.
  const rest = restPositions(template)
  let minY = Infinity
  let maxY = -Infinity
  let minX = Infinity
  let maxX = -Infinity
  for (const id of bodyIds) {
    if (pose[id].y < minY) minY = pose[id].y
    if (pose[id].y > maxY) maxY = pose[id].y
    if (pose[id].x < minX) minX = pose[id].x
    if (pose[id].x > maxX) maxX = pose[id].x
  }
  const span = Math.max(1, maxY - minY)
  const restSpan = Math.max(0.1, rest.nose.y - rest.lAnkle.y)
  const scale = restSpan / span
  const centerX = (minX + maxX) / 2
  for (const id of bodyIds) {
    pose[id] = { x: (pose[id].x - centerX) * scale, y: (pose[id].y - minY) * scale, z: 0 }
  }
  // Fill non-body joints: rest defaults, then derive the spine root.
  for (const joint of template.joints) {
    if (!pose[joint.id]) pose[joint.id] = { x: rest[joint.id].x, y: rest[joint.id].y, z: rest[joint.id].z }
  }
  const hips = midpoint(pose.rHip, pose.lHip)
  const hipRise = rest.midHip.y - rest.rHip.y // midHip sits above the hip line
  pose.midHip = { x: hips.x, y: hips.y + hipRise, z: 0 }
  pose.spine = third(pose.midHip, pose.neck)
  return normalizePose(template, pose)
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }
}

function third(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + (b.x - a.x) * 0.45, y: a.y + (b.y - a.y) * 0.45, z: a.z + (b.z - a.z) * 0.45 }
}

// ---------------------------------------------------------------------------
// Server-render bridge — VERSION-PINNED, OFF BY DEFAULT (E-FC0.5)
// ---------------------------------------------------------------------------

/**
 * E-FC0.5 (2026-09-14, Flux 41ebvfo): raw keypoint JSON IS accepted by the
 * engine when wrapped as {"__value__": <raw>} (execution.py:970-977 — the
 * core mechanism that passes list values past link syntax). Palette-exact by
 * construction (the server's own SDPoseDrawKeypoints paints), zero GPU.
 *
 * BUT `__value__` is UNDOCUMENTED PUBLIC API — not a contract. The rig
 * therefore renders client-side by default (canvas → PNG frames) and only
 * emits this payload when the operator explicitly opts in, after pinning the
 * engine version in the availability gate. The graph built here must set
 * draw_feet: true (the node defaults it FALSE; feet-present is the
 * palette-exact config E-FC0.5 vision-verified).
 */
export const SERVER_RENDER_BRIDGE = {
  enabled: false,
  /** The engine build the E-FC0.5 probe verified (execution.py behavior).
   *  Update ONLY with a re-run of the probe — see the task comment. */
  verifiedAgainst: 'ComfyUI v0.34.0 (testbed 8189, 2026-09-14)',
} as const

export type ServerBridgePayload = { __value__: OpenPoseFrame[] }

/** Build the {"__value__": [frames]} literal for SDPoseDrawKeypoints. Throws
 *  unless the flag is explicitly enabled — the failure is loud by design so
 *  no code path silently ships an undocumented-API dependency. */
export function buildServerBridgePayload(frames: OpenPoseFrame[]): ServerBridgePayload {
  if (!SERVER_RENDER_BRIDGE.enabled) {
    throw new Error('Server-render bridge is version-pinned OFF (E-FC0.5): client canvas render is the default. Flip SERVER_RENDER_BRIDGE.enabled only after pinning the engine version — see poseModel.ts.')
  }
  return { __value__: frames }
}

/** The graph fragment the bridge payload plugs into (documented shape —
 *  wiring into the real graph factory is the canvas integration's job). */
export function serverBridgeGraphSpec(): { node: string; class_type: string; inputs: Record<string, unknown> } {
  return {
    node: 'SDPoseDrawKeypoints',
    class_type: 'SDPoseDrawKeypoints',
    inputs: {
      keypoints: '<< __value__ payload >>',
      draw_body: true,
      draw_hands: true,
      draw_face: true,
      draw_feet: true, // node default FALSE — feet-present is the verified palette-exact config
      draw_head: true,
      stick_width: 4,
      face_point_size: 3,
      score_threshold: 0.3,
    },
  }
}

// ---------------------------------------------------------------------------
// Frame rendering pipeline (pose → projected keypoints → draw ops)
// ---------------------------------------------------------------------------

export type PoseRenderer = (pose: RigPose) => ProjectedKeypoints

/** Standard renderer for a template + view + canvas: derive 134 keypoints,
 *  fit, project. `fitPose` lets the timeline pin the fit across frames so
 *  the figure never re-scales mid-clip. */
export function makeRenderer(template: SkeletonTemplate, view: OrbitView, canvas: { width: number; height: number }): PoseRenderer {
  return (pose: RigPose) => {
    const kp = template.deriveKeypoints(pose)
    const fit = fitProjection(flattenKeypoints(kp).map((p) => [p.x, p.y, p.z]), canvas.width, canvas.height)
    return projectKeypoints(kp, view, fit, canvas.width, canvas.height)
  }
}

/** Render every frame's draw-op fingerprint (deterministic export preview —
 *  also the round-trip test's comparison basis). */
export function frameFingerprints(timeline: PoseTimeline, template: SkeletonTemplate, options: PoseDrawOptions = {}): string[] {
  const render = makeRenderer(template, timeline.view, timeline.canvas)
  const out: string[] = []
  for (let frame = 0; frame < timeline.totalFrames; frame += 1) {
    out.push(opsFingerprint(buildDrawOps(render(samplePose(timeline, frame, template)), options)))
  }
  return out
}

/** Bone-length sanity for a pose over the CONSTRAINT bones — the spine
 *  chain, the two-bone limbs, and the swing joints (the bones the solver
 *  preserves). Display-only bones ending at FREE joints (shoulders, hips)
 *  are deliberately excluded: free joints move directly, by design. */
export function poseBoneLengthError(template: SkeletonTemplate, pose: RigPose): number {
  const rest = restPositions(template)
  let worst = 0
  const check = (aId: string, bId: string) => {
    const a = pose[aId]
    const b = pose[bId]
    if (!a || !b) return
    const error = Math.abs(vdist(a, b) - vdist(rest[aId], rest[bId]))
    if (error > worst) worst = error
  }
  for (let i = 0; i < template.spineChain.length - 1; i += 1) check(template.spineChain[i], template.spineChain[i + 1])
  for (const limb of template.limbs) {
    check(limb.root, limb.mid)
    check(limb.mid, limb.end)
  }
  for (const swing of template.swingJoints) check(swing.base, swing.tip)
  return worst
}


