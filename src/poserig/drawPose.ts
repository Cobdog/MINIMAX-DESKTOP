/** The palette-exact DWPose renderer — §3.1 implemented verbatim.
 *
 * This module owns the model-facing contract: H3 Fun Control eats rendered
 * RGB frames, so THIS painter (not the keypoint data) is what the model sees.
 * Constants and ordering live in poseSpec.ts; this file turns projected
 * 2D keypoints into (a) a pure, deterministic OP LIST (node-testable,
 * golden-fixtured) and (b) painted canvas pixels (browser).
 *
 * Draw order, verbatim from the trainer's `draw_pose`:
 *   1. 17 body limbs — filled rotated ellipses, palette × 0.6 (truncated int)
 *   2. 18 body joint dots — r4 filled circles, FULL palette color
 *   3. 6 feet dots — r4, palette[0..5] (full color; the trainer's own draw
 *      omits feet, ComfyUI core's draw_wholebody_keypoints draws them with
 *      draw_feet=true — the E-FC0.5-verified palette-exact config, so feet
 *      are ON here; see poseModel.ts's server-bridge graph doing the same)
 *   4. LEFT hand: 20 finger edges (thickness 2, HSV rainbow hue = i/20) then
 *      21 blue dots r4
 *   5. RIGHT hand: same
 *   6. 68 face dots — r3 white
 * (Trainer order: body, left hand, right hand, face. ComfyUI core draws the
 * right hand first — an overlap-only difference; the trainer wins.)
 *
 * Coordinate conventions mirror cv2 exactly: pixel coords are int()-truncated;
 * limb ellipses use cv2 SEMI-axes (int(len/2), 4) with the +0.5 pixel-center
 * adjustment ComfyUI's port adds; the eps guard (skip keypoints at the pixel
 * origin — DWPose's "absent" marker) applies to hands/face/feet only, exactly
 * like the trainer's code (draw_bodypose has no eps guard).
 *
 * Canvas 2D anti-aliases where cv2 does not — interior pixels are exact
 * either way; edge-pixel differences are sub-pixel coverage, which the
 * control net consumes fine (it saw AA-free training renders; both hard and
 * AA edges are in-distribution enough that this was never a quality lever).
 */

import {
  AP10K_LIMB_COLORS, AP10K_LIMB_SEQ, AP10K_LINE_WIDTH, BODY_LIMB_SEQ, CANVAS_BACKGROUND, FACE_DOT_COLOR,
  FACE_DOT_RADIUS, HAND_DOT_COLOR, HAND_DOT_RADIUS, HAND_EDGES, HAND_LINE_WIDTH, JOINT_RADIUS, STICK_WIDTH,
  handEdgeColor, limbFillColor, POSE_PALETTE,
} from './poseSpec'
import type { ProjectedKeypoints } from './projection'

export type Rgb = readonly [number, number, number]

export type DrawOp =
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; rotationDeg: number; color: Rgb }
  | { kind: 'circle'; cx: number; cy: number; r: number; color: Rgb }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; width: number; color: Rgb }

export type PoseDrawOptions = {
  /** §3.1 spec text says the face renders "white dots + pink links"; the
   *  trainer's code and demo asset are DOTS ONLY (see poseSpec.ts header).
   *  OFF by default = the verified training distribution. Turning this on is
   *  an explicit, flagged experiment. Link color: light pink (255,128,128)
   *  [SPEC — the spec text gives no value; this is the OpenPose-editor
   *  lineage convention]. */
  faceLinks?: boolean
}

/** iBUG-68 face contour rings used when faceLinks is enabled. */
const FACE_LINK_RING_STARTS: ReadonlyArray<readonly [number, number]> = [
  [0, 17], // jaw ring
  [17, 5], // right brow
  [22, 5], // left brow
  [36, 6], // right eye
  [42, 6], // left eye
  [48, 12], // outer mouth
  [60, 8], // inner mouth
]

const EPS_PX = 1 // int(x) > 0 — the trainer's `x1 > eps` in pixel space

function drawBodyLimbs(kp: ProjectedKeypoints, ops: DrawOp[]): void {
  for (let i = 0; i < BODY_LIMB_SEQ.length; i += 1) {
    const a = kp.body[BODY_LIMB_SEQ[i][0]]
    const b = kp.body[BODY_LIMB_SEQ[i][1]]
    if (!a || !b) continue
    const x1 = Math.trunc(a.x)
    const y1 = Math.trunc(a.y)
    const x2 = Math.trunc(b.x)
    const y2 = Math.trunc(b.y)
    const cx = Math.trunc((x1 + x2) / 2)
    const cy = Math.trunc((y1 + y2) / 2)
    const dx = x1 - x2
    const dy = y1 - y2
    const length = Math.sqrt(dx * dx + dy * dy)
    const angle = (Math.atan2(dy, dx) * 180) / Math.PI
    ops.push({
      kind: 'ellipse',
      cx,
      cy,
      rx: Math.trunc(length / 2) + 0.5,
      ry: STICK_WIDTH + 0.5,
      rotationDeg: angle,
      color: limbFillColor(i),
    })
  }
}

function drawJointDots(kp: ProjectedKeypoints, ops: DrawOp[]): void {
  for (let i = 0; i < kp.body.length; i += 1) {
    const p = kp.body[i]
    if (!p) continue
    ops.push({ kind: 'circle', cx: Math.trunc(p.x), cy: Math.trunc(p.y), r: JOINT_RADIUS, color: POSE_PALETTE[i % POSE_PALETTE.length] })
  }
  for (let i = 0; i < kp.feet.length; i += 1) {
    const p = kp.feet[i]
    if (!p) continue
    const x = Math.trunc(p.x)
    const y = Math.trunc(p.y)
    if (x < EPS_PX || y < EPS_PX) continue
    ops.push({ kind: 'circle', cx: x, cy: y, r: JOINT_RADIUS, color: POSE_PALETTE[(18 + i) % POSE_PALETTE.length] })
  }
}

function drawHand(points: ProjectedKeypoints['handRight'], ops: DrawOp[]): void {
  if (points.length === 0) return
  for (let ie = 0; ie < HAND_EDGES.length; ie += 1) {
    const a = points[HAND_EDGES[ie][0]]
    const b = points[HAND_EDGES[ie][1]]
    if (!a || !b) continue
    const x1 = Math.trunc(a.x)
    const y1 = Math.trunc(a.y)
    const x2 = Math.trunc(b.x)
    const y2 = Math.trunc(b.y)
    if (x1 < EPS_PX || y1 < EPS_PX || x2 < EPS_PX || y2 < EPS_PX) continue
    ops.push({ kind: 'line', x1, y1, x2, y2, width: HAND_LINE_WIDTH, color: handEdgeColor(ie) })
  }
  for (const p of points) {
    const x = Math.trunc(p.x)
    const y = Math.trunc(p.y)
    if (x < EPS_PX || y < EPS_PX) continue
    ops.push({ kind: 'circle', cx: x, cy: y, r: HAND_DOT_RADIUS, color: HAND_DOT_COLOR })
  }
}

function drawFace(kp: ProjectedKeypoints, ops: DrawOp[], options: PoseDrawOptions): void {
  if (options.faceLinks) {
    for (const [start, count] of FACE_LINK_RING_STARTS) {
      for (let i = 0; i < count; i += 1) {
        const a = kp.face[start + i]
        const b = kp.face[start + ((i + 1) % count)]
        if (!a || !b) continue
        const x1 = Math.trunc(a.x)
        const y1 = Math.trunc(a.y)
        const x2 = Math.trunc(b.x)
        const y2 = Math.trunc(b.y)
        if (x1 < EPS_PX || y1 < EPS_PX || x2 < EPS_PX || y2 < EPS_PX) continue
        ops.push({ kind: 'line', x1, y1, x2, y2, width: 1, color: [255, 128, 128] })
      }
    }
  }
  for (const p of kp.face) {
    const x = Math.trunc(p.x)
    const y = Math.trunc(p.y)
    if (x < EPS_PX || y < EPS_PX) continue
    ops.push({ kind: 'circle', cx: x, cy: y, r: FACE_DOT_RADIUS, color: FACE_DOT_COLOR })
  }
}

/** The pure, deterministic draw list for one frame. This is the golden-
 * fixtured artifact: same keypoints + options → identical op list on every
 * platform, independent of canvas anti-aliasing. */
/** AP-10K renderer — the AnimalPose line drawing (E-FC1, poseSpec.ts
 *  provenance): 17 limbs in the testbed renderer's edge order, FULL-color
 *  lines of width 5, NO joint dots, no eps guard (its loop draws every edge
 *  unconditionally). Round line caps come from paintDrawOps's global cap —
 *  cv2's default butt cap differs only at end pixels, the same sub-pixel
 *  delta the module header already documents for the DWPose path. */
function drawAnimalLimbs(kp: ProjectedKeypoints, ops: DrawOp[]): void {
  for (let i = 0; i < AP10K_LIMB_SEQ.length; i += 1) {
    const a = kp.body[AP10K_LIMB_SEQ[i][0]]
    const b = kp.body[AP10K_LIMB_SEQ[i][1]]
    if (!a || !b) continue
    ops.push({
      kind: 'line',
      x1: Math.trunc(a.x),
      y1: Math.trunc(a.y),
      x2: Math.trunc(b.x),
      y2: Math.trunc(b.y),
      width: AP10K_LINE_WIDTH,
      color: AP10K_LIMB_COLORS[i],
    })
  }
}

export function buildDrawOps(kp: ProjectedKeypoints, options: PoseDrawOptions = {}): DrawOp[] {
  const ops: DrawOp[] = []
  if (kp.kind === 'ap10k') {
    drawAnimalLimbs(kp, ops)
    return ops
  }
  drawBodyLimbs(kp, ops)
  drawJointDots(kp, ops)
  drawHand(kp.handLeft, ops)
  drawHand(kp.handRight, ops)
  drawFace(kp, ops, options)
  return ops
}

/** A 2D-context-like interface — keeps the painter testable headlessly if a
 *  test wants to rasterize with its own implementation. */
export interface PaintContext {
  fillStyle: string | CanvasGradient | CanvasPattern
  strokeStyle: string | CanvasGradient | CanvasPattern
  lineWidth: number
  lineCap: CanvasLineCap
  fillRect(x: number, y: number, w: number, h: number): void
  beginPath(): void
  ellipse(cx: number, cy: number, rx: number, ry: number, rotation: number, start: number, end: number): void
  arc(cx: number, cy: number, r: number, start: number, end: number): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  fill(): void
  stroke(): void
}

/** Paint ops onto a context. Black canvas first (the §3 background), then
 *  the ops in order — later ops overwrite earlier ones exactly like the
 *  trainer's sequential cv2 draws. */
export function paintDrawOps(ctx: PaintContext, ops: ReadonlyArray<DrawOp>, width: number, height: number): void {
  const rgb = (c: Rgb) => `rgb(${c[0]},${c[1]},${c[2]})`
  ctx.fillStyle = rgb(CANVAS_BACKGROUND)
  ctx.fillRect(0, 0, width, height)
  ctx.lineCap = 'round'
  for (const op of ops) {
    ctx.fillStyle = rgb(op.color)
    ctx.strokeStyle = rgb(op.color)
    ctx.lineWidth = op.kind === 'line' ? op.width : 1
    ctx.beginPath()
    if (op.kind === 'ellipse') {
      ctx.ellipse(op.cx, op.cy, op.rx, op.ry, (op.rotationDeg * Math.PI) / 180, 0, Math.PI * 2)
      ctx.fill()
    } else if (op.kind === 'circle') {
      ctx.arc(op.cx, op.cy, op.r, 0, Math.PI * 2)
      ctx.fill()
    } else {
      ctx.moveTo(op.x1, op.y1)
      ctx.lineTo(op.x2, op.y2)
      ctx.stroke()
    }
  }
}

/** Render one frame to a fresh canvas element (browser path). */
export function renderFrameCanvas(kp: ProjectedKeypoints, width: number, height: number, options: PoseDrawOptions = {}): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas context unavailable')
  paintDrawOps(ctx, buildDrawOps(kp, options), width, height)
  return canvas
}

/** Stable fingerprint of a draw list (the unit-suite golden artifact). */
export function opsFingerprint(ops: ReadonlyArray<DrawOp>): string {
  let hash = 0x811c9dc5
  const json = JSON.stringify(ops)
  for (let i = 0; i < json.length; i += 1) {
    hash ^= json.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `fnv1a-${hash.toString(16)}-${ops.length}`
}
