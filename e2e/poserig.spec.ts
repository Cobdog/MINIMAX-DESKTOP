import { expect, test, type Page } from '@playwright/test'

// Pose rig e2e (task 41ebvfo) — the ?poserig=1 dev surface. Deterministic
// by design: poses come from presets, exports from the versioned
// window.__poserig test hook, and every palette assertion samples COMPUTED
// pixel positions (never eyeballed):
//   1. route loads clean (no renderer errors — three.js + WebGL headless)
//   2. a preset applies
//   3. a drag fires (IK: wrist moves, bone lengths hold)
//   4. exports are deterministic (keypoint JSON ×2 identical; PNG contact
//      sheet data-URL ×2 identical)
//   5. PIXEL palette-exactness — synthetic render through the SAME painter:
//      joint centers exactly the full §3 palette, limb interiors exactly
//      ×0.6, hand line + blue dots, white face dots, black background; plus
//      the live preview canvas sampled at computed joint positions.

type PoserigHook = {
  pose: () => Record<string, { x: number; y: number; z: number }>
  timeline: () => { totalFrames: number; canvas: { width: number; height: number }; keyframes: Array<{ frame: number }> }
  applyPreset: (id: string) => void
  exportJson: () => Array<Record<string, unknown>>
  projected: () => { body: Array<{ x: number; y: number }>; handLeft: Array<{ x: number; y: number }>; face: Array<{ x: number; y: number }>; feet: Array<{ x: number; y: number }> }
  jointScreenPos: (jointId: string) => { x: number; y: number } | null
  samplePreview: (x: number, y: number) => number[]
  renderKeypointsPixels: (kp: unknown, width: number, height: number) => number[][][]
  renderSheetDataUrl: () => string
}

/** The hook object contains functions, which do not survive evaluate-round
 *  trips — always dereference it INSIDE the page. */
async function callHook<T>(page: Page, invoke: string): Promise<T> {
  return page.evaluate(`(window.__poserig && (${invoke}))`) as Promise<T>
}

async function trackErrors(page: Page) {
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`)
  })
  return problems
}

const environmental = (entry: string) =>
  entry.includes('Failed to load resource')
  || /WebSocket connection to .* failed/.test(entry)
  // Headless GL may log context-loss/performance advisories; not a defect of
  // the surface (the assertions below prove the render works regardless).
  || /WEBGL|WebGL|GPU stall|swiftshader|Software WebGL/i.test(entry)

// The §3 palette (poseSpec.ts) — mirrored here so the assertion is against
// the SPEC, not against the app's own export (no circular proof).
const PALETTE = [
  [255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0], [0, 255, 85],
  [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255], [170, 0, 255], [255, 0, 255],
  [255, 0, 170], [255, 0, 85],
]

test('poserig — route loads, preset applies, timeline wired', async ({ page }) => {
  const problems = await trackErrors(page)
  await page.goto('/?poserig=1')
  await expect(page.locator('[data-poserig="app"]')).toBeVisible()
  await expect(page.locator('[data-poserig-viewport]')).toBeVisible()
  await expect(page.locator('[data-poserig-preview]')).toBeVisible()
  await expect(page.locator('[data-poserig-timeline]')).toBeVisible()

  // Eight presets render; the disabled pending templates are visible as
  // documented slots, the shipped one selected.
  await expect(page.locator('[data-poserig-preset]').nth(0)).toBeVisible()
  expect(await page.locator('[data-poserig-preset]').count()).toBe(8)
  const templateSelect = page.locator('[data-poserig-template]')
  await expect(templateSelect).toBeVisible()
  expect(await templateSelect.locator('option[disabled]').count()).toBe(2)

  // The server-render bridge is OFF with its E-FC0.5 note.
  const serverButton = page.locator('[data-poserig-export-server]')
  await expect(serverButton).toBeDisabled()
  await expect(serverButton).toHaveAttribute('title', /version-pinned OFF/)

  // A preset applies: pose changes deterministically (victory raises wrists).
  const wristBefore = await callHook<number>(page, 'window.__poserig.pose().rWrist.y')
  await page.locator('[data-poserig-preset="victory"]').click()
  const wristAfter = await callHook<number>(page, 'window.__poserig.pose().rWrist.y')
  expect(wristAfter).toBeGreaterThan(wristBefore + 0.6)

  // Timeline: 2 s default → 56 total frames, 4 grid ticks (5/22/39/56).
  expect(await page.locator('[data-poserig-tick]').count()).toBe(4)
  const timeline = await callHook<{ totalFrames: number }>(page, 'window.__poserig.timeline().totalFrames')
  expect(timeline).toBe(56)
  expect(await page.locator('[data-poserig-tick][data-key="1"]').count()).toBeGreaterThanOrEqual(1)

  await page.screenshot({ path: 'test-results/shots/15-poserig.png' })
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('poserig — a drag fires: IK moves the wrist, bone lengths hold', async ({ page }) => {
  const problems = await trackErrors(page)
  await page.goto('/?poserig=1')
  await expect(page.locator('[data-poserig="app"]')).toBeVisible()

  const before = await page.evaluate(() => {
    const h = (window as unknown as { __poserig: PoserigHook }).__poserig
    const pose = h.pose()
    return {
      wrist: { ...pose.rWrist },
      elbow: { ...pose.rElbow },
      shoulder: { ...pose.rShoulder },
      screen: h.jointScreenPos('rWrist'),
    }
  })
  expect(before.screen).not.toBeNull()

  // Drag the right wrist up and outward through the viewport.
  const viewport = page.locator('[data-poserig-viewport]')
  const box = await viewport.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(before.screen!.x, before.screen!.y)
  await page.mouse.down()
  await page.mouse.move(before.screen!.x - 60, before.screen!.y - 120, { steps: 8 })
  await page.mouse.up()

  const after = await page.evaluate(() => {
    const h = (window as unknown as { __poserig: PoserigHook }).__poserig
    const pose = h.pose()
    return { wrist: { ...pose.rWrist }, elbow: { ...pose.rElbow }, shoulder: { ...pose.rShoulder } }
  })
  // The drag moved the wrist and re-solved the elbow; the shoulder (chain
  // root) stayed put.
  const moved = Math.hypot(after.wrist.x - before.wrist.x, after.wrist.y - before.wrist.y, after.wrist.z - before.wrist.z)
  expect(moved).toBeGreaterThan(0.2)
  expect(Math.hypot(after.shoulder.x - before.shoulder.x, after.shoulder.y - before.shoulder.y)).toBeLessThan(1e-6)
  // Two-bone IK preserved both bone lengths (the §5.2 solver contract).
  const len = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
  expect(Math.abs(len(after.shoulder, after.elbow) - len(before.shoulder, before.elbow))).toBeLessThan(1e-6)
  expect(Math.abs(len(after.elbow, after.wrist) - len(before.elbow, before.wrist))).toBeLessThan(1e-6)

  // The selection readout followed the pick.
  await expect(page.locator('[data-poserig-selected]')).toContainText(/wrist/i)

  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('poserig — exports are deterministic and shape-correct', async ({ page }) => {
  const problems = await trackErrors(page)
  await page.goto('/?poserig=1')
  await page.locator('[data-poserig-preset="walking"]').click()

  // Keypoint JSON: 56 frames, per-frame canvas, structural completeness.
  const frames = await page.evaluate(() => {
    const h = (window as unknown as { __poserig: PoserigHook }).__poserig
    return h.exportJson()
  })
  expect(frames.length).toBe(56)
  const first = frames[0] as { canvas_width: number; canvas_height: number; people: Array<Record<string, number[]>> }
  expect(first.canvas_width).toBe(512)
  expect(first.canvas_height).toBe(512)
  expect(first.people.length).toBe(1)
  const person = first.people[0]
  expect(person.pose_keypoints_2d.length).toBe(18 * 3)
  expect(person.foot_keypoints_2d.length).toBe(6 * 3)
  expect(person.face_keypoints_2d.length).toBe(70 * 3)
  expect(person.hand_right_keypoints_2d.length).toBe(21 * 3)
  expect(person.hand_left_keypoints_2d.length).toBe(21 * 3)

  // Deterministic: same state → identical bytes.
  const frames2 = await page.evaluate(() => (window as unknown as { __poserig: PoserigHook }).__poserig.exportJson())
  expect(JSON.stringify(frames2)).toBe(JSON.stringify(frames))

  // PNG contact sheet: identical data-URL across renders, non-trivial size.
  const sheet1 = await page.evaluate(() => (window as unknown as { __poserig: PoserigHook }).__poserig.renderSheetDataUrl())
  const sheet2 = await page.evaluate(() => (window as unknown as { __poserig: PoserigHook }).__poserig.renderSheetDataUrl())
  expect(sheet1.startsWith('data:image/png')).toBe(true)
  expect(sheet1.length).toBeGreaterThan(20_000)
  expect(sheet1).toBe(sheet2)

  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('poserig — palette-exact pixels (the §3 contract, sampled not eyeballed)', async ({ page }) => {
  const problems = await trackErrors(page)
  await page.goto('/?poserig=1')
  await expect(page.locator('[data-poserig="app"]')).toBeVisible()
  // Wait for the first preview paint (the hook's renderKeypointsPixels rides
  // the same module; the preview proves the painter is live).
  await expect(page.locator('[data-poserig-preview]')).toBeVisible()

  // Synthetic "starfish" skeleton through the SAME painter: chains radiate
  // outward from the neck so no shape ever overlaps a sampled pixel — exact
  // interior colors are guaranteed by the draw list, any deviation is a
  // renderer bug.
  const results = await page.evaluate(() => {
    const h = (window as unknown as { __poserig: PoserigHook }).__poserig
    const body = [
      { x: 256, y: 60 },   // 0 nose
      { x: 256, y: 100 },  // 1 neck
      { x: 196, y: 130 }, { x: 140, y: 170 }, { x: 84, y: 210 },   // right arm
      { x: 316, y: 130 }, { x: 372, y: 170 }, { x: 428, y: 210 },  // left arm
      { x: 216, y: 300 }, { x: 180, y: 380 }, { x: 150, y: 460 },  // right leg
      { x: 296, y: 300 }, { x: 332, y: 380 }, { x: 362, y: 460 },  // left leg
      { x: 236, y: 44 }, { x: 276, y: 44 }, { x: 214, y: 52 }, { x: 298, y: 52 }, // eyes/ears
    ]
    const handAt = (cx: number, cy: number) => Array.from({ length: 21 }, (_, i) => ({ x: cx + (i % 5) * 12, y: cy + Math.floor(i / 5) * 12 }))
    const kp = {
      body,
      feet: Array.from({ length: 6 }, (_, i) => ({ x: 456, y: 486 + i * 5 })),
      face: Array.from({ length: 68 }, (_, i) => ({ x: 470 + (i % 17), y: 24 + Math.floor(i / 17) })),
      handRight: handAt(60, 300),
      handLeft: handAt(240, 320),
    }
    const image = h.renderKeypointsPixels(kp, 512, 512)
    const at = (x: number, y: number) => image[y][x]
    const out: Record<string, number[]> = {}
    for (let i = 0; i < 18; i += 1) out[`joint${i}`] = at(body[i].x, body[i].y)
    for (let i = 0; i < 6; i += 1) out[`foot${i}`] = at(kp.feet[i].x, kp.feet[i].y)
    // Chain-bone interiors, 2 px off-axis at the midpoint (well inside the
    // 4.5-px semi-minor, far outside every r4 joint disk).
    const interior = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len = Math.hypot(dx, dy)
      return at(Math.round((a.x + b.x) / 2 - (dy / len) * 2), Math.round((a.y + b.y) / 2 + (dx / len) * 2))
    }
    const pairs: Array<[number, number]> = [[2, 3], [3, 4], [5, 6], [6, 7], [8, 9], [9, 10], [11, 12], [12, 13]]
    pairs.forEach(([a, b], i) => { out[`limb${i}`] = interior(body[a], body[b]) })
    out.handDot = at(kp.handRight[0].x, kp.handRight[0].y)
    // Edge 0 (hue 0 → pure red): between the two r4 dots (6 px from each
    // center at 12-px spread), one pixel ABOVE the centerline — the
    // centerline row sub-pixel-blends with the wrist-fan edges that radiate
    // from hand point 0 (verified by pixel dump; the row above is solid).
    out.handEdge0 = at(kp.handRight[0].x + 6, kp.handRight[0].y - 1)
    out.faceDot = at(kp.face[0].x, kp.face[0].y)
    out.background = at(4, 4)
    out.background2 = at(508, 508)
    return out
  })

  const eq = (label: string, actual: number[], expected: number[]) =>
    expect(actual, `${label}: got rgb(${actual.join(',')}), want rgb(${expected.join(',')})`).toEqual(expected)

  for (let i = 0; i < 18; i += 1) eq(`joint ${i} full palette`, results[`joint${i}`], PALETTE[i])
  for (let i = 0; i < 6; i += 1) eq(`foot dot ${i}`, results[`foot${i}`], PALETTE[i])
  // The sampled chain pairs map to BODY_LIMB_SEQ entries [2,3],[3,4],[5,6],
  // [6,7],[8,9],[9,10],[11,12],[12,13] → palette indices 2,3,4,5,7,8,10,11.
  const limbPaletteIndex = [2, 3, 4, 5, 7, 8, 10, 11]
  limbPaletteIndex.forEach((colorIndex, index) => {
    const expected = PALETTE[colorIndex].map((c) => Math.trunc(c * 0.6))
    eq(`limb ${index} fill (palette[${colorIndex}] × 0.6)`, results[`limb${index}`], expected)
  })
  eq('hand dot DWPose blue', results.handDot, [0, 0, 255])
  eq('hand edge 0 (h=0) red line', results.handEdge0, [255, 0, 0])
  eq('face dot white', results.faceDot, [255, 255, 255])
  eq('background black', results.background, [0, 0, 0])
  eq('background black (corner)', results.background2, [0, 0, 0])

  // Live preview canvas (the standing preset): sample the computed positions
  // of clean body joints — neck, shoulders, hips, knees, ankles — full
  // palette; wrist centers are covered by the later hand dots (draw-order
  // proof): DWPose blue.
  const live = await page.evaluate(() => {
    const h = (window as unknown as { __poserig: PoserigHook }).__poserig
    const kp = h.projected()
    const sample: Record<string, number[]> = {}
    const at = (p: { x: number; y: number }) => h.samplePreview(p.x, p.y)
    sample.neck = at(kp.body[1])
    sample.rShoulder = at(kp.body[2])
    sample.lShoulder = at(kp.body[5])
    sample.rHip = at(kp.body[8])
    sample.lKnee = at(kp.body[12])
    sample.footLBigToe = at(kp.feet[0])
    sample.footLHeel = at(kp.feet[2])
    sample.footRHeel = at(kp.feet[5])
    sample.rWrist = at(kp.body[4])
    return sample
  })
  eq('live neck', live.neck, PALETTE[1])
  eq('live rShoulder', live.rShoulder, PALETTE[2])
  eq('live lShoulder', live.lShoulder, PALETTE[5])
  eq('live rHip', live.rHip, PALETTE[8])
  eq('live lKnee', live.lKnee, PALETTE[12])
  eq('live left big-toe dot', live.footLBigToe, PALETTE[0])
  eq('live left heel dot', live.footLHeel, PALETTE[2])
  eq('live right heel dot', live.footRHeel, PALETTE[5])
  eq('live rWrist (hand dots draw over joints — trainer order)', live.rWrist, [0, 0, 255])

  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})
