// Pose-rig suite (task 41ebvfo). VM harness (scripts/lib/ts-vm.cjs) — the
// pure modules (ik / template / rig / projection / poseSpec / drawPose /
// poseModel / presets) are DOM-free by design; the three.js + React shell is
// covered by e2e/poserig.spec.ts. Sections:
//   (a) IK two-bone — exact reach, bone lengths preserved, unreachable
//       clamping, pole side
//   (b) FABRIK — lengths preserved, base pinned, target hit, far targets
//       straighten without stretching
//   (c) grid — 17n+5 semantics consistent with src/lib/workflow.ts
//       frameCount, snapping, ≤15 s
//   (d) timeline — add/move/delete keyframes, interpolation + end-hold
//   (e) projection — exact orthographic pixels at a known view, drag-delta
//       inverse
//   (f) poseSpec — the §3 palette VERBATIM, ×0.6 limb colors, HSV table,
//       radii/widths
//   (g) drawPose — op list shape, order, geometry (cv2 semi-axes), eps
//       guard, fingerprint stability, faceLinks flagged option
//   (h) rig — presets normalize to exact bone lengths, drags preserve them,
//       mirror is an involution, subtree rotation touches descendants only
//   (i) 134-keypoint derivation — counts, attachment invariants
//   (j) JSON round-trip — shape, scores, re-render fingerprint IDENTICAL
//       (export → parse → ops), import lifts body flat
//   (k) server bridge — OFF by default, throws, graph pins draw_feet=true
//   (l) template registry — E-FC1 verdict applied: AP-10K unlocked
//       (selectable, NON-DEFAULT, measured label) + free-form disabled
//       with the measured reason
//   (n) AP-10K quadruped — 17-keypoint layout, AnimalPose render ops
//       (17 lines, no dots), estimator-dict export, rig invariants
//   (o) goldens — canonical preset fingerprints + the AP-10K rest pose vs
//       the committed fixture (UPDATE=1 pnpm test:poserig regenerates)
//
// Vitest port (task z7ogmig, 2026-09-20) of scripts/test-poserig.cjs:
// assertion bodies carry over verbatim; the linear sections became one test
// each; the fixture stays in scripts/fixtures with an anchored path.
import { test } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = require('node:path').dirname(fileURLToPath(import.meta.url))

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadTs } = require('../scripts/lib/ts-vm.cjs')

let passed = 0
function ok(condition, label) {
  assert.ok(condition, label)
  passed += 1
  console.log(`  ok - ${label}`)
}
function eq(actual, expected, label) {
  // The vm harness runs modules in their own realm — cross-realm arrays fail
  // deepStrictEqual on prototype identity. JSON normalization is the honest
  // comparison for plain data.
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), label)
  passed += 1
  console.log(`  ok - ${label}`)
}
function close(a, b, tol, label) {
  assert.ok(Math.abs(a - b) <= tol, `${label}: |${a} - ${b}| > ${tol}`)
  passed += 1
  console.log(`  ok - ${label}`)
}

const ik = loadTs('src/poserig/ik.ts')
const spec = loadTs('src/poserig/poseSpec.ts')
const draw = loadTs('src/poserig/drawPose.ts')
const templateMod = loadTs('src/poserig/template.ts')
const rigMod = loadTs('src/poserig/rig.ts')
const projection = loadTs('src/poserig/projection.ts')
const model = loadTs('src/poserig/poseModel.ts')
const presets = loadTs('src/poserig/presets.ts')
const workflow = loadTs('src/lib/workflow.ts')

const HUMAN = templateMod.HUMAN_TEMPLATE
const v3 = ik.v3
const vdist = ik.vdist

test('(a) analytic two-bone IK', () => {
  const root = v3(0, 1, 0)
  // Reachable target: exact hit, lengths exact.
  const target = v3(0.3, 0.7, 0.1)
  const { mid, end, reached } = ik.solveTwoBone(root, target, 0.4, 0.3, v3(0, -1, -1))
  ok(reached, 'two-bone: reachable target reports reached')
  close(vdist(end, target), 0, 1e-9, 'two-bone: end effector lands on target')
  close(vdist(root, mid), 0.4, 1e-9, 'two-bone: upper bone length preserved')
  close(vdist(mid, end), 0.3, 1e-9, 'two-bone: lower bone length preserved')
  // Unreachable: full extension toward the target, lengths still exact.
  const far = v3(2, 2, 2)
  const clamped = ik.solveTwoBone(root, far, 0.4, 0.3, v3(0, -1, -1))
  ok(!clamped.reached, 'two-bone: unreachable target reports not reached')
  close(vdist(root, clamped.end), 0.7, 1e-9, 'two-bone: unreachable clamps to full extension')
  close(vdist(root, clamped.mid), 0.4, 1e-9, 'two-bone: unreachable keeps upper length')
  close(vdist(clamped.mid, clamped.end), 0.3, 1e-9, 'two-bone: unreachable keeps lower length')
  // Pole side: knee forward for a +z pole.
  const leg = ik.solveTwoBone(v3(0, 1, 0), v3(0, 0.4, 0), 0.45, 0.45, v3(0, 0, 1))
  ok(leg.mid.z > 0, 'two-bone: mid joint lands on the pole side (+z)')
  ok(leg.mid.y < 0.71 && leg.mid.y > 0.69, 'two-bone: mid joint at the law-of-cosines height')
  // Degenerate: target on the root never yields NaN.
  const degenerate = ik.solveTwoBone(root, root, 0.4, 0.3, v3(0, -1, 0))
  ok(Number.isFinite(degenerate.mid.x + degenerate.end.x), 'two-bone: degenerate target stays finite')
})

test('(b) FABRIK spine chain', () => {
  const chain = [v3(0, 1.0, 0), v3(0, 1.16, 0.01), v3(0, 1.38, 0.01)]
  const target = v3(0.12, 1.32, 0.06)
  const result = ik.solveFabrik(chain, target)
  close(result.error, 0, 1e-5, 'FABRIK: reachable target hit within tolerance')
  close(vdist(result.points[0], chain[0]), 0, 1e-9, 'FABRIK: base stays pinned')
  const l1 = vdist(result.points[0], result.points[1])
  const l2 = vdist(result.points[1], result.points[2])
  const rest1 = vdist(chain[0], chain[1])
  const rest2 = vdist(chain[1], chain[2])
  close(l1, rest1, 1e-6, 'FABRIK: bone 1 length preserved')
  close(l2, rest2, 1e-6, 'FABRIK: bone 2 length preserved')
  // Far target: straightens, no stretch.
  const far = ik.solveFabrik(chain, v3(3, 3, 3))
  const total = rest1 + rest2
  close(vdist(far.points[0], far.points[2]), total, 1e-6, 'FABRIK: far target fully extends without stretching')
})

test('(c) the 17n+5 grid', () => {
  for (let seconds = 1; seconds <= 15; seconds += 0.5) {
    const frames = model.frameCount(seconds)
    eq((frames - 5) % 17, 0, `frameCount(${seconds}) = ${frames} is on 17n+5`)
    assert.ok(frames >= Math.round(seconds * 24))
    assert.ok(frames < Math.round(seconds * 24) + 17)
    // Consistent with the app's own frame math (workflow.ts).
    assert.equal(frames, workflow.frameCount(seconds), `grid matches workflow.frameCount(${seconds})`)
  }
  passed += 1
  console.log('  ok - grid matches workflow.frameCount across 1–15 s')
  eq(model.gridFrames(73), [5, 22, 39, 56, 73], 'gridFrames enumerates 5/22/39/56/…')
  eq(model.snapToGrid(6, 73), 5, 'snapToGrid(6) → 5 (nearest)')
  eq(model.snapToGrid(30, 73), 22, 'snapToGrid(30) → 22 (nearest)')
  eq(model.snapToGrid(31, 73), 39, 'snapToGrid(31) → 39 (nearest)')
  eq(model.snapToGrid(999, 73), 73, 'snapToGrid clamps to total')
  ok(model.isOnGrid(39) && !model.isOnGrid(40) && !model.isOnGrid(4), 'isOnGrid membership')
  ok(model.frameCount(15) === 362, 'workflow-style pad-up gives 362 for 15 s (decode-trim semantics)')
  eq(model.MAX_TOTAL_FRAMES, 345, 'rig authoring clips at the largest 17n+5 ≤ 360 = 345')
  const capped = model.createTimeline(HUMAN, 15)
  eq(capped.totalFrames, 345, '15 s timeline is clipped to 345 frames (≤15 s invariant)')
})

test('(d) timeline keyframes + interpolation', () => {
  const template = HUMAN
  const poseA = presets.presetToPose(presets.PRESETS[0], template)
  const poseB = presets.presetToPose(presets.PRESETS.find((p) => p.id === 'victory'), template)
  let timeline = model.createTimeline(template, 3)
  eq(timeline.totalFrames, 73, '3 s → 73 frames')
  timeline = model.addKeyframe(timeline, 39, poseB)
  eq(timeline.keyframes.map((k) => k.frame), [5, 39], 'keyframes sorted after add')
  timeline = model.addKeyframe(timeline, 44, poseA) // snaps to 39 → replaces
  eq(timeline.keyframes.map((k) => k.frame), [5, 39], 'add snaps to grid and replaces')
  const middle = model.samplePose(timeline, 22, template)
  const a = model.samplePose(timeline, 5, template)
  const b = model.samplePose(timeline, 39, template)
  close(middle.nose.x, (a.nose.x + b.nose.x) / 2, 1e-9, 'midpoint sample = mean of keyframes')
  close(middle.nose.y, (a.nose.y + b.nose.y) / 2, 1e-9, 'midpoint sample y = mean')
  // End-hold semantics.
  const held = model.samplePose(timeline, 72, template)
  close(held.nose.y, b.nose.y, 1e-9, 'beyond last keyframe holds last pose')
  // Move: refused onto an occupied frame, applied onto a free one.
  const moved = model.moveKeyframe(timeline, 39, 56)
  eq(moved.keyframes.map((k) => k.frame), [5, 56], 'move keyframe relocates on grid')
  const refused = model.moveKeyframe(moved, 56, 5)
  eq(refused.keyframes.map((k) => k.frame), [5, 56], 'move onto occupied frame is refused (no silent merge)')
  const deleted = model.deleteKeyframe(refused, 56)
  eq(deleted.keyframes.map((k) => k.frame), [5], 'delete keyframe removes it')
})

test('(e) orthographic projection', () => {
  const view = { yaw: 0, pitch: 0 }
  const basis = projection.viewBasis(view)
  close(basis.right.x, 1, 1e-9, 'yaw 0: right = +x')
  close(basis.up.y, 1, 1e-9, 'yaw 0: up = +y')
  close(basis.forward.z, 1, 1e-9, 'yaw 0: forward = +z')
  const fit = { center: v3(0, 0.875, 0), scale: 200 }
  const p1 = projection.projectPoint(v3(0.5, 1.0, 3), basis, fit, 400, 400)
  eq(p1.x, 300, 'project: x = W/2 + dx·scale (z ignored — orthographic)')
  eq(p1.y, 175, 'project: y = H/2 − dy·scale')
  // Drag inverse: a round pixel delta maps back through the same basis.
  const delta = projection.screenDeltaToWorld(24, -16, basis, 200)
  close(delta.x, 0.12, 1e-9, 'screenDeltaToWorld: dx/scale → world x')
  close(delta.y, 0.08, 1e-9, 'screenDeltaToWorld: −dy/scale → world y')
  close(delta.z, 0, 1e-12, 'screenDeltaToWorld stays on the camera plane (z=0)')
  // Pitch clamp keeps the basis non-degenerate.
  const steep = projection.viewBasis({ yaw: 0, pitch: 1.5 })
  ok(Math.abs(steep.right.x) + Math.abs(steep.right.z) > 1e-6, 'pitch clamped before degeneracy')
})

test('(f) poseSpec — the §3 palette verbatim', () => {
  eq(spec.POSE_PALETTE.length, 18, 'palette has 18 colors')
  eq(
    spec.POSE_PALETTE.map((c) => `${c[0]},${c[1]},${c[2]}`).join(' '),
    '255,0,0 255,85,0 255,170,0 255,255,0 170,255,0 85,255,0 0,255,0 0,255,85 0,255,170 0,255,255 0,170,255 0,85,255 0,0,255 85,0,255 170,0,255 255,0,255 255,0,170 255,0,85',
    'palette values byte-for-byte as §3.1',
  )
  eq(spec.limbFillColor(0), [153, 0, 0], 'limb 0 fill = 255×0.6 = 153,0,0')
  eq(spec.limbFillColor(3), [153, 153, 0], 'limb 3 fill = 255,255,0 × 0.6')
  eq(spec.limbFillColor(7), [0, 153, 51], 'limb 7 fill = 0,255,85 × 0.6')
  eq(spec.limbFillColor(17), [153, 0, 51], 'limb 17 fill = 255,0,85 × 0.6')
  eq(spec.STICK_WIDTH, 4, 'stickwidth 4 (cv2 semi-axis)')
  eq(spec.JOINT_RADIUS, 4, 'joint radius 4')
  eq(spec.FACE_DOT_RADIUS, 3, 'face dot radius 3')
  eq(spec.HAND_LINE_WIDTH, 2, 'hand line width 2')
  eq(spec.HAND_DOT_COLOR, [0, 0, 255], 'hand dots DWPose blue')
  eq(spec.hsvToInts(0), [255, 0, 0], 'HSV 0 → red')
  eq(spec.hsvToInts(1 / 3), [0, 255, 0], 'HSV 1/3 → green (colorsys semantics)')
  eq(spec.hsvToInts(0.25), [127, 255, 0], 'HSV 0.25 → 127,255,0 (int truncation)')
  eq(spec.handEdgeColor(0), [255, 0, 0], 'hand edge 0 red')
  eq(spec.handEdgeColor(15), [127, 0, 255], 'hand edge 15 (h=0.75) violet')
  eq(spec.BODY_LIMB_SEQ.length, 17, '17 limbs')
  eq(spec.HAND_EDGES.length, 20, '20 hand edges')
  eq(spec.KP.total, 134, '134 keypoints total')
})

test('(g) drawPose — op list + geometry', () => {
  const pose = presets.presetToPose(presets.PRESETS[0], HUMAN)
  const renderer = model.makeRenderer(HUMAN, { yaw: 0, pitch: 0.12 }, { width: 512, height: 512 })
  const kp = renderer(pose)
  const ops = draw.buildDrawOps(kp)
  const circles = ops.filter((op) => op.kind === 'circle').length
  const ellipses = ops.filter((op) => op.kind === 'ellipse').length
  const lines = ops.filter((op) => op.kind === 'line').length
  eq(ellipses, 17, '17 limb ellipses')
  eq(circles, 18 + 6 + 21 + 21 + 68, '18 joints + 6 feet + 42 hand dots + 68 face dots')
  eq(lines, 40, '20 finger edges × 2 hands')
  eq(ops.length, 17 + 18 + 6 + 40 + 42 + 68, 'op count exact')
  // Order: limbs first, then joint dots, left hand before right hand, face last.
  const kinds = ops.map((op) => op.kind)
  eq(kinds.indexOf('circle'), 17, 'joint dots follow the 17 limbs')
  eq(kinds.lastIndexOf('ellipse'), 16, 'no ellipses after the limb block')
  const faceStart = ops.length - 68
  ok(ops.slice(faceStart).every((op) => op.kind === 'circle' && op.color[0] === 255 && op.color[1] === 255 && op.color[2] === 255), 'face dots are the trailing 68, all white')
  // Geometry: a horizontal limb ellipse — center, semi-axes, rotation.
  const nose = { x: 256, y: 100 }
  const neck = { x: 256, y: 160 }
  const kpSimple = {
    body: Array.from({ length: 18 }, (_, i) => (i === 0 ? nose : i === 1 ? neck : { x: 400 + (i % 5) * 3, y: 420 + i * 2 })),
    feet: Array.from({ length: 6 }, () => ({ x: 300, y: 480 })),
    face: Array.from({ length: 68 }, (_, i) => ({ x: 250 + (i % 10), y: 90 + i })),
    handRight: Array.from({ length: 21 }, (_, i) => ({ x: 430, y: 440 + i })),
    handLeft: Array.from({ length: 21 }, (_, i) => ({ x: 80, y: 440 + i })),
  }
  const simpleOps = draw.buildDrawOps(kpSimple)
  const noseNeck = simpleOps[12] // BODY_LIMB_SEQ[12] = [1, 0] neck→nose — vertical in this fixture
  eq(noseNeck.kind, 'ellipse', 'limb 12 drawn (neck→nose pair)')
  eq(noseNeck.cx, 256, 'limb ellipse center x = midpoint')
  eq(noseNeck.cy, 130, 'limb ellipse center y = midpoint')
  close(noseNeck.rx, 30.5, 1e-9, 'limb ellipse semi-major = int(len/2)+0.5')
  eq(noseNeck.ry, 4.5, 'limb ellipse semi-minor = stickwidth 4 + 0.5 (cv2 semi-axis convention)')
  close(noseNeck.rotationDeg, 90, 1e-9, 'vertical limb rotates 90°')
  eq(noseNeck.color, [0, 0, 153], 'limb 12 fill = palette[12] × 0.6 = 0,0,153')
  const joint1 = simpleOps.find((op) => op.kind === 'circle' && op.cx === 256 && op.cy === 160)
  eq(joint1.r, 4, 'neck joint dot radius 4')
  eq(joint1.color, [255, 85, 0], 'neck joint full palette[1]')
  // eps guard: a hand dot at pixel 0 is skipped (the DWPose absent marker).
  const zeroHand = {
    ...kpSimple,
    handLeft: kpSimple.handLeft.map((p, i) => (i === 5 ? { x: 0, y: 440 } : p)),
  }
  const guardOps = draw.buildDrawOps(zeroHand)
  ok(!guardOps.some((op) => op.kind === 'circle' && op.cx === 0), 'hand keypoint at x=0 skipped (eps guard)')
  // faceLinks — OFF by default, ON adds pink link ops before the dots.
  eq(draw.buildDrawOps(kpSimple).length, draw.buildDrawOps(kpSimple, {}).length, 'options default stable')
  const withLinks = draw.buildDrawOps(kpSimple, { faceLinks: true })
  eq(withLinks.length, ops.length + 59, 'faceLinks adds the 59 contour links (jaw 17 + brows 10 + eyes 12 + mouth 20)')
  eq(withLinks.find((op) => op.kind === 'line' && op.color[0] === 255 && op.color[1] === 128 && op.color[2] === 128)?.width, 1, 'face links are 1-px light pink (flagged spec-text variant)')
  // Fingerprint determinism.
  eq(draw.opsFingerprint(ops), draw.opsFingerprint(draw.buildDrawOps(kp)), 'fingerprint stable across calls')
})

test('(h) rig — constraints under manipulation', () => {
  const template = HUMAN
  for (const preset of presets.PRESETS) {
    const pose = presets.presetToPose(preset, template)
    const error = model.poseBoneLengthError(template, pose)
    assert.ok(error <= 0.02, `preset ${preset.id}: bone-length error ${error.toFixed(4)} ≤ 0.02`)
  }
  passed += 1
  console.log('  ok - all presets normalize to rest bone lengths (±0.02)')
  // Drag a wrist far: arm bones keep lengths.
  const pose = presets.presetToPose(presets.PRESETS[0], template)
  rigMod.dragJoint(template, pose, 'rWrist', v3(-0.6, 1.5, 0.3))
  const upper = vdist(pose.rShoulder, pose.rElbow)
  const lower = vdist(pose.rElbow, pose.rWrist)
  const rest = templateMod.restPositions(template)
  close(upper, vdist(rest.rShoulder, rest.rElbow), 1e-6, 'drag wrist: upper arm length preserved')
  close(lower, vdist(rest.rElbow, rest.rWrist), 1e-6, 'drag wrist: forearm length preserved')
  // Unreachable drag clamps rather than stretches.
  rigMod.dragJoint(template, pose, 'lWrist', v3(5, 5, 5))
  const leftUpper = vdist(pose.lShoulder, pose.lElbow)
  close(leftUpper, vdist(rest.lShoulder, rest.lElbow), 1e-6, 'unreachable wrist drag still preserves bone length')
  // Mirror is an involution and swaps sides.
  const reaching = presets.presetToPose(presets.PRESETS.find((p) => p.id === 'reaching'), template)
  const mirrored = rigMod.mirrorPose(template, reaching)
  close(mirrored.rWrist.y, reaching.lWrist.y, 1e-9, 'mirror: right wrist takes the left wrist height')
  close(mirrored.rWrist.x, -reaching.lWrist.x, 1e-9, 'mirror: x flipped across the sagittal plane')
  const twice = rigMod.mirrorPose(template, mirrored)
  close(twice.rWrist.x, reaching.rWrist.x, 1e-9, 'mirror twice = identity')
  close(twice.lWrist.x, reaching.lWrist.x, 1e-9, 'mirror twice = identity (left)')
  // Subtree rotation moves descendants only (z axis = raises the arm sideways).
  const rot = presets.presetToPose(presets.PRESETS[0], template)
  const before = { ...rot }
  rigMod.rotateSubtree(template, rot, 'lShoulder', v3(0, 0, 1), Math.PI / 2)
  ok(Math.abs(rot.lElbow.x - before.lElbow.x) > 0.1, `subtree rotation moves the elbow (Δx ${(rot.lElbow.x - before.lElbow.x).toFixed(3)})`)
  eq(rot.rWrist.x, before.rWrist.x, 'subtree rotation leaves the other arm untouched')
  eq(rot.midHip.x, before.midHip.x, 'subtree rotation leaves the root untouched')
})

test('(i) 134-keypoint derivation', () => {
  const pose = presets.presetToPose(presets.PRESETS[0], HUMAN)
  const kp = HUMAN.deriveKeypoints(pose)
  eq(kp.body.length, 18, 'body 18')
  eq(kp.feet.length, 6, 'feet 6')
  eq(kp.face.length, 68, 'face 68')
  eq(kp.handRight.length, 21, 'right hand 21')
  eq(kp.handLeft.length, 21, 'left hand 21')
  // Eyes/ears symmetric about the sagittal plane at rest.
  close(kp.body[14].x + kp.body[15].x, 0, 1e-6, 'eyes symmetric (x)')
  close(kp.body[16].x + kp.body[17].x, 0, 1e-6, 'ears symmetric (x)')
  ok(kp.body[15].x > 0, 'character LEFT eye at +x (mirror-correct facing)')
  // Hands attached near wrists; face near the nose; feet near ankles.
  const wristR = kp.body[4]
  const handSpanR = Math.max(...kp.handRight.map((p) => vdist(p, wristR)))
  ok(handSpanR < 0.25, `right hand points cluster near the wrist (span ${handSpanR.toFixed(3)})`)
  const wristL = kp.body[7]
  const handSpanL = Math.max(...kp.handLeft.map((p) => vdist(p, wristL)))
  ok(handSpanL < 0.25, 'left hand points cluster near the wrist')
  const faceSpan = Math.max(...kp.face.map((p) => vdist(p, pose.nose)))
  ok(faceSpan < 0.16, `face landmarks cluster around the nose (span ${faceSpan.toFixed(3)})`)
  const ankleL = kp.body[13]
  ok(kp.feet.slice(0, 3).every((p) => vdist(p, ankleL) < 0.16), 'left foot points near the left ankle')
  const ankleR = kp.body[10]
  ok(kp.feet.slice(3).every((p) => vdist(p, ankleR) < 0.16), 'right foot points near the right ankle')
  // Foot order: left triple first (COCO-WholeBody).
  ok(vdist(kp.feet[3], ankleR) < vdist(kp.feet[3], ankleL), 'foot index 3 belongs to the RIGHT ankle')
})

test('(j) keypoint JSON round-trip', () => {
  const template = HUMAN
  const pose = presets.presetToPose(presets.PRESETS.find((p) => p.id === 'walking'), template)
  const canvas = { width: 480, height: 832 }
  const renderer = model.makeRenderer(template, { yaw: 0.2, pitch: 0.1 }, canvas)
  const projected = renderer(pose)
  const frame = model.frameFromPose(projected, canvas)
  eq(frame.canvas_width, 480, 'per-frame canvas_width')
  eq(frame.canvas_height, 832, 'per-frame canvas_height')
  const person = frame.people[0]
  eq(person.pose_keypoints_2d.length, 54, 'body 18×3')
  eq(person.foot_keypoints_2d.length, 18, 'feet 6×3')
  eq(person.face_keypoints_2d.length, 210, 'face 70×3 (68 + appended eyes, SDPose-compatible)')
  eq(person.hand_right_keypoints_2d.length, 63, 'right hand 21×3')
  eq(person.hand_left_keypoints_2d.length, 63, 'left hand 21×3')
  ok(person.pose_keypoints_2d.every((v, i) => (i % 3 === 2 ? v === 1 : Number.isFinite(v))), 'scores all 1.0, coords finite')
  // THE renderer round-trip: export → parse → re-render → IDENTICAL ops.
  const direct = draw.opsFingerprint(draw.buildDrawOps(projected))
  const parsed = model.parseOpenPoseJson([frame])
  ok(!('error' in parsed), 'exported frame parses back')
  const reProjected = model.projectedFromPerson(parsed.frames[0].people[0])
  const reFingerprint = draw.opsFingerprint(draw.buildDrawOps(reProjected))
  eq(reFingerprint, direct, 'export → parse → re-render produces IDENTICAL draw ops')
  // Rejection paths.
  ok('error' in model.parseOpenPoseJson([]), 'empty array rejected')
  ok('error' in model.parseOpenPoseJson([{ canvas_width: 10, canvas_height: 10, people: [{ pose_keypoints_2d: [1, 2] }] }]), 'malformed body rejected')
  // Full-timeline export shape.
  const timeline = model.createTimeline(template, 2, canvas)
  const withSecond = model.addKeyframe(timeline, 39, pose)
  const frames = model.exportOpenPoseJson(withSecond, template, model.makeRenderer(template, withSecond.view, canvas))
  eq(frames.length, 56, '2 s → 56 exported frames (one per video frame)')
  ok(frames.every((f) => f.canvas_width === 480 && f.canvas_height === 832), 'every frame carries its canvas size')
  // Import: body lifted flat, bone lengths re-imposed.
  const imported = model.poseFromFrame(frames[0], template)
  ok(imported !== null, 'import produces a rig pose')
  const bodyIds = ['nose', 'neck', 'rShoulder', 'rElbow', 'rWrist', 'lShoulder', 'lElbow', 'lWrist', 'rHip', 'rKnee', 'rAnkle', 'lHip', 'lKnee', 'lAnkle']
  const maxDrift = Math.max(...bodyIds.map((id) => Math.abs(imported[id].y - pose[id].y)))
  ok(maxDrift < 0.4, `flat-lift import keeps the body near the source — depth lost by design (max drift ${maxDrift.toFixed(3)})`)
  ok(model.poseBoneLengthError(template, imported) <= 0.02, 'imported pose satisfies bone-length constraints')
})

test('(k) server-render bridge (E-FC0.5)', () => {
  eq(model.SERVER_RENDER_BRIDGE.enabled, false, 'bridge flag OFF by default (version-pinned)')
  assert.throws(() => model.buildServerBridgePayload([]), /version-pinned OFF/, 'payload builder throws loudly while OFF')
  const graphSpec = model.serverBridgeGraphSpec()
  eq(graphSpec.class_type, 'SDPoseDrawKeypoints', 'bridge graph targets the native node')
  eq(graphSpec.inputs.draw_feet, true, 'bridge graph pins draw_feet=true (node default is FALSE)')
  eq(graphSpec.inputs.stick_width, 4, 'bridge graph pins stick_width=4')
})

test('(l) template registry — E-FC1 verdict applied', () => {
  const shipped = templateMod.TEMPLATES.filter((t) => t.status === 'shipped')
  const pending = templateMod.TEMPLATES.filter((t) => t.status === 'pending')
  eq(templateMod.DEFAULT_TEMPLATE_ID, 'human-134', 'default template stays human-134 (AP-10K is NON-default)')
  eq(shipped.length, 2, 'two selectable templates (human-134 + ap10k-quadruped)')
  eq(templateMod.templateById('ap10k-quadruped').status, 'shipped', 'AP-10K is selectable (shipped)')
  const ap10k = templateMod.AP10K_TEMPLATE
  eq(ap10k.output, 'ap10k', 'AP-10K declares the ap10k output contract')
  eq(
    ap10k.note,
    'Looser adherence — measured ~2–3× human-skeleton error, 1.4–2× sprite mode; renders true quadrupeds, no humanization (E-FC1, 2026-09-15)',
    'AP-10K measured label verbatim (the UI renders it at selection time)',
  )
  ok(!ap10k.presetSet, 'AP-10K has no human preset library (UI hides the preset panel)')
  eq(pending.length, 1, 'one disabled slot (freeform)')
  const freeform = templateMod.templateById('freeform')
  ok(freeform.status === 'pending', 'free-form slot stays disabled')
  ok(
    freeform.pendingNote.includes('E-FC1 arm C') && freeform.pendingNote.includes('Envelope-following only'),
    'free-form reason is the MEASURED finding (arm C: envelope-following only)',
  )
  eq(templateMod.templateById('human-134').label, 'Human (DWPose 134)', 'templateById resolves')
  ok(templateMod.templateById('nope') === undefined, 'unknown id → undefined')
  eq(presets.PRESETS.length, 8, 'eight preset archetypes ship')
})

test('(n) AP-10K quadruped template — layout, render ops, export format', () => {
  const ap10k = templateMod.AP10K_TEMPLATE
  const names = spec.AP10K_KEYPOINT_NAMES
  eq(names.length, 17, 'AP-10K name table: 17 keypoints')
  eq(spec.AP10K_LIMB_COLORS.length, spec.AP10K_LIMB_SEQ.length, 'one color per AP-10K limb (testbed colorsList)')

  const rest = templateMod.restPositions(ap10k)
  const kp = ap10k.deriveKeypoints(rest)
  eq(kp.kind, 'ap10k', 'derived set targets the ap10k contract')
  eq(kp.body.length, 17, '17 body keypoints (AP-10K estimator layout)')
  ok(kp.feet.length === 0 && kp.face.length === 0 && kp.handRight.length === 0 && kp.handLeft.length === 0, 'no human attachments (no humanization)')
  ok(kp.body.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)), 'all 17 slots filled')
  eq(kp.body[3], rest.neck, 'slot 3 = neck')
  eq(kp.body[4], rest.tailRoot, 'slot 4 = tail root')
  eq(kp.body[5], rest.lFrontShoulder, 'slot 5 = left front shoulder')
  eq(kp.body[16], rest.rBackPaw, 'slot 16 = right back paw')
  ok(kp.body[2].z > rest.neck.z, 'nose derives forward of the neck (back→neck line)')
  ok(kp.body[0].x > 0 && kp.body[1].x < 0, 'left eye +x / right eye −x (animal left = +x)')

  // Edge list sanity vs the name table — the renderer's own 1-based list
  // decremented (poseSpec provenance): front legs hang off the NECK, back
  // legs off the TAIL ROOT, eyes+nose form the head triangle.
  const idx = (name) => names.indexOf(name)
  ok(spec.AP10K_LIMB_SEQ.some((e) => e[0] === idx('neck') && e[1] === idx('lFrontShoulder')), 'edge: neck→lFrontShoulder')
  ok(spec.AP10K_LIMB_SEQ.some((e) => e[0] === idx('tailRoot') && e[1] === idx('rBackHip')), 'edge: tailRoot→rBackHip')
  ok(spec.AP10K_LIMB_SEQ.some((e) => e[0] === idx('lEye') && e[1] === idx('rEye')), 'edge: lEye→rEye')
  ok(spec.AP10K_LIMB_SEQ.some((e) => e[0] === idx('neck') && e[1] === idx('tailRoot')), 'edge: neck→tailRoot (the back line)')

  // Render ops: the AnimalPose line renderer — 17 lines, width 5, full
  // colors in edge order, NO joint dots.
  const renderer = model.makeRenderer(ap10k, { yaw: 0, pitch: 0.12 }, { width: 512, height: 512 })
  const projected = renderer(rest)
  eq(projected.kind, 'ap10k', 'output kind rides through projection')
  const ops = draw.buildDrawOps(projected)
  eq(ops.length, spec.AP10K_LIMB_SEQ.length, 'one op per AP-10K limb')
  ok(ops.every((op) => op.kind === 'line'), 'all ops are LINES (the animalpose renderer draws no joint dots)')
  ok(ops.every((op) => op.width === spec.AP10K_LINE_WIDTH), 'line width 5 (cv2 thickness — not a DWPose semi-axis)')
  let colorsMatch = true
  for (let i = 0; i < ops.length; i += 1) if (JSON.stringify(ops[i].color) !== JSON.stringify(spec.AP10K_LIMB_COLORS[i])) colorsMatch = false
  ok(colorsMatch, 'limb colors = the testbed renderer\'s colorsList verbatim, in edge order')

  // Export format: the estimator's own dict (version 'ap10k', animals).
  const tl = model.createTimeline(ap10k, 1, { width: 512, height: 512 })
  const frames = model.exportAp10kJson(tl, ap10k, renderer)
  eq(frames.length, tl.totalFrames, 'one estimator dict per frame')
  const f0 = frames[0]
  eq(f0.version, 'ap10k', 'version marker ap10k')
  eq(f0.canvas_width, 512, 'canvas_width')
  eq(f0.canvas_height, 512, 'canvas_height')
  eq(f0.animals.length, 1, 'one animal authored')
  eq(f0.animals[0].length, 17, '17 keypoints per animal')
  ok(f0.animals[0].every((k) => k.length === 3 && k[2] === 1), 'flat [x, y, score] triples, score 1 (authored)')

  // Rig invariants on the quadruped: rest is bone-exact, drags preserve
  // limb lengths, mirror is an involution that swaps L/R.
  close(model.poseBoneLengthError(ap10k, rest), 0, 1e-9, 'AP-10K rest pose is bone-length exact')
  const posed = templateMod.restPositions(ap10k)
  const l1 = ik.vdist(rest.lFrontShoulder, rest.lFrontKnee)
  const l2 = ik.vdist(rest.lFrontKnee, rest.lFrontPaw)
  rigMod.dragJoint(ap10k, posed, 'lFrontPaw', v3(0.25, 0.30, 0.40))
  close(ik.vdist(posed.lFrontShoulder, posed.lFrontKnee), l1, 1e-9, 'front-paw drag: upper bone preserved (two-bone IK)')
  close(ik.vdist(posed.lFrontKnee, posed.lFrontPaw), l2, 1e-9, 'front-paw drag: lower bone preserved')
  const mirrored = rigMod.mirrorPose(ap10k, posed)
  ok(Math.abs(mirrored.lFrontPaw.x - -posed.rFrontPaw.x) < 1e-9, 'mirror swaps L/R (lFrontPaw ← rFrontPaw)')
  eq(rigMod.mirrorPose(ap10k, mirrored), posed, 'mirror is an involution')
})

test('(o) golden fingerprints (canonical poses + AP-10K rest)', () => {
  const fixturePath = path.resolve(__dirname, '..', 'scripts', 'fixtures', 'poserig-goldens.json')
  const canonical = presets.PRESETS.map((preset) => {
    const pose = presets.presetToPose(preset, HUMAN)
    const renderer = model.makeRenderer(HUMAN, { yaw: 0, pitch: 0.12 }, { width: 512, height: 512 })
    return { id: preset.id, fingerprint: draw.opsFingerprint(draw.buildDrawOps(renderer(pose))) }
  })
  // E-FC1: the AP-10K rest pose rides the same golden harness (the animal
  // renderer's op list — 17 lines — is as contract-bound as the human's).
  const ap10kRest = templateMod.restPositions(templateMod.AP10K_TEMPLATE)
  const ap10kRenderer = model.makeRenderer(templateMod.AP10K_TEMPLATE, { yaw: 0, pitch: 0.12 }, { width: 512, height: 512 })
  canonical.push({ id: 'ap10k-rest', fingerprint: draw.opsFingerprint(draw.buildDrawOps(ap10kRenderer(ap10kRest))) })
  if (process.env.UPDATE === '1' || !fs.existsSync(fixturePath)) {
    fs.writeFileSync(fixturePath, `${JSON.stringify({ note: 'canonical pose render fingerprints — regenerate with UPDATE=1 pnpm test:poserig', poses: canonical }, null, 2)}\n`)
    console.log(`  wrote golden fixture: ${fixturePath}`)
    passed += 1
    console.log('  ok - goldens regenerated')
  } else {
    const golden = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
    eq(canonical.length, golden.poses.length, 'golden pose count matches')
    for (let i = 0; i < canonical.length; i += 1) {
      eq(canonical[i].id, golden.poses[i].id, `golden ${i}: preset id`)
      eq(canonical[i].fingerprint, golden.poses[i].fingerprint, `golden ${canonical[i].id}: render fingerprint identical`)
    }
  }
  console.log(`\nposerig: ${passed} assertions passed`)
})
