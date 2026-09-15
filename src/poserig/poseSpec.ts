/** The DWPose whole-body render contract — RESEARCH-PINNED constants.
 *
 * Every value here is copied verbatim from fun-control-input-surface.md §3.1
 * ("the EXACT pose render contract"), which was extracted from the trainer's
 * own code (VideoX-Fun `comfyui/annotator/dwpose_utils/util.py`, lineage of
 * Mikubill/sd-webui-controlnet — same constants ship in our local testbed's
 * controlnet_aux `custom_controlnet_aux/dwpose/util.py` and in ComfyUI core
 * `comfy_extras/pose/keypoint_draw.py`). The consumer (H3 Fun Control) eats
 * rendered RGB frames only — keypoint JSON never reaches the model — so this
 * render spec IS the model-facing contract.
 *
 * VERBATIM DISCREPANCY, resolved in favor of the trainer's code: §3.1's
 * one-line summary says the face renders as "white dots + pink links", but
 * the trainer's `draw_facepose` (verified 3×: controlnet_aux local, ComfyUI
 * core local, VideoX-Fun GitHub) draws WHITE DOTS ONLY, radius 3 — and the
 * demo asset `asset/pose.jpg` was pixel-inspected for this task: zero
 * non-grayscale pixels in the face region. The "magenta face mesh" seen in
 * the pose.mp4 demo is the HSV-rainbow HAND lines whenever a hand crosses
 * the face. Our default therefore draws dots only; the spec-text variant is
 * available behind `faceLinks` (see drawPose.ts) and flagged as
 * off-distribution. Do not "fix" this silently either way — see the task
 * 41ebvfo final report.
 *
 * Keypoint layout (ComfyUI `nodes_sdpose.py` — the format the native
 * SDPoseDrawKeypoints server bridge consumes):
 *   body      0..17   18 OpenPose keypoints, neck at 1
 *   feet      18..23  COCO-WholeBody foot order: L big toe, L small toe,
 *                     L heel, R big toe, R small toe, R heel
 *   face      24..91  68 iBUG-style landmarks
 *   hand R    92..112 21 (wrist + 4 per finger; thumb→pinky)
 *   hand L    113..133
 */

/** The 18-color limb palette, in limb order. §3.1 verbatim. */
export const POSE_PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0],
  [170, 255, 0], [85, 255, 0], [0, 255, 0], [0, 255, 85],
  [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255],
  [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255],
  [255, 0, 170], [255, 0, 85],
]

/** The 17 body limbs as 0-indexed keypoint pairs (trainer limbSeq, 1-based
 *  in the original: [2,3],[2,6],[3,4],[4,5],[6,7],[7,8],[2,9],[9,10],
 *  [10,11],[2,12],[12,13],[13,14],[2,1],[1,15],[15,17],[1,16],[16,18]). */
export const BODY_LIMB_SEQ: ReadonlyArray<readonly [number, number]> = [
  [1, 2], [1, 5], [2, 3], [3, 4],
  [5, 6], [6, 7], [1, 8], [8, 9],
  [9, 10], [1, 11], [11, 12], [12, 13],
  [1, 0], [0, 14], [14, 16], [0, 15],
  [15, 17],
]

/** Body-limb fill alpha — colors × 0.6, int-truncated exactly as the trainer
 *  does (`[int(float(c) * 0.6) for c in color]`). All palette entries are
 *  multiples of 85, so the product is always an exact integer — no rounding
 *  ambiguity between implementations. */
export const LIMB_ALPHA = 0.6

/** Ellipse stick width. The trainer passes this as the cv2 SEMI-axis
 *  (`ellipse2Poly(center, (int(length / 2), stickwidth), …)`), i.e. limbs
 *  render ~8 px across — implement the same way, not as a 4 px total width. */
export const STICK_WIDTH = 4

/** Joint-marker radius (full palette color, filled). */
export const JOINT_RADIUS = 4

/** Hand finger-bone line thickness. */
export const HAND_LINE_WIDTH = 2

/** Hand keypoint dot radius + color (DWPose blue). */
export const HAND_DOT_RADIUS = 4
export const HAND_DOT_COLOR: readonly [number, number, number] = [0, 0, 255]

/** Face landmark dot radius + color. */
export const FACE_DOT_RADIUS = 3
export const FACE_DOT_COLOR: readonly [number, number, number] = [255, 255, 255]

/** The 20 finger-bone edges per hand (0 = wrist; thumb→pinky). §3.1 + the
 *  trainer's `draw_handpose` edge list, identical in ComfyUI core. */
export const HAND_EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
]

/** OpenPose-134 slot indices (the internal keypoint array). */
export const KP = {
  bodyCount: 18,
  feetStart: 18,
  feetCount: 6,
  faceStart: 24,
  faceCount: 68,
  handRightStart: 92,
  handLeftStart: 113,
  total: 134,
} as const

/** OpenPose body keypoint names in order (for labels + tests). */
export const BODY_KEYPOINT_NAMES = [
  'nose', 'neck', 'rShoulder', 'rElbow', 'rWrist', 'lShoulder', 'lElbow', 'lWrist',
  'rHip', 'rKnee', 'rAnkle', 'lHip', 'lKnee', 'lAnkle', 'rEye', 'lEye', 'rEar', 'lEar',
] as const

/** HSV→RGB exactly as matplotlib/colorsys do it, with the same int()
 *  truncation the ecosystem renderers apply. h ∈ [0, 1), s = v = 1. */
export function hsvToInts(h: number): readonly [number, number, number] {
  const hh = ((h % 1) + 1) % 1
  const sector = Math.floor(hh * 6)
  const f = hh * 6 - sector
  let r = 0
  let g = 0
  let b = 0
  switch (sector % 6) {
    case 0: r = 1; g = f; b = 0; break
    case 1: r = 1 - f; g = 1; b = 0; break
    case 2: r = 0; g = 1; b = f; break
    case 3: r = 0; g = 1 - f; b = 1; break
    case 4: r = f; g = 0; b = 1; break
    default: r = 1; g = 0; b = 1 - f; break
  }
  return [Math.trunc(r * 255), Math.trunc(g * 255), Math.trunc(b * 255)]
}

/** The rainbow color of hand-finger edge `index` (hue = index / 20). */
export function handEdgeColor(index: number): readonly [number, number, number] {
  return hsvToInts(index / HAND_EDGES.length)
}

/** Body-limb fill color: palette[index] × LIMB_ALPHA, int-truncated. */
export function limbFillColor(paletteIndex: number): readonly [number, number, number] {
  const c = POSE_PALETTE[paletteIndex % POSE_PALETTE.length]
  return [Math.trunc(c[0] * LIMB_ALPHA), Math.trunc(c[1] * LIMB_ALPHA), Math.trunc(c[2] * LIMB_ALPHA)]
}

/** The black canvas: every training frame is zeros-initialized RGB. */
export const CANVAS_BACKGROUND: readonly [number, number, number] = [0, 0, 0]
