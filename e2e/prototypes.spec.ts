import { expect, test, type Page } from '@playwright/test'

// Wave 3 — the three UI-direction prototypes (tests 12–14 of 14). Each proto
// route mounts its own lazy shell under ?proto=; the app routes are never
// touched. All data is the shared mock store — no server, no engine — so the
// interactions under test (audition cycling, select-then-operate, projection
// flipping, downstream staleness) are fully deterministic.

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

// Direction A — the Shot Bench. The audition stack is the spine: J/K cycle
// takes IN PLACE, the param-diff gutter tracks what changed between adjacent
// takes, a modifier flip marks takes stale (deferred commit — no dialog),
// and the re-run gesture walks the queue back to fresh.
test('proto A — Shot Bench cycles takes in place with a live param-diff gutter', async ({ page }) => {
  const problems = await trackErrors(page)
  await page.goto('/?proto=bench')
  await expect(page.locator('[data-proto="bench"]')).toBeVisible()
  await expect(page.getByText('PROTOTYPE — static mock data')).toBeVisible()
  await expect(page.locator('[data-proto-switch="stage"]')).toBeVisible()
  await expect(page.locator('[data-proto-switch="score"]')).toBeVisible()
  await expect(page.locator('.bench-outliner')).toBeVisible()
  await expect(page.locator('.bench-stack')).toBeVisible()
  await expect(page.locator('.proto-queue')).toBeVisible()

  // Keyboard-first: J/K cycle the take family; the diff gutter follows.
  const takeLabel = page.locator('[data-bench-take]')
  const diff = page.locator('[data-bench-diff]')
  await expect(takeLabel).toHaveText('T1')
  await expect(diff).toContainText('first take')
  await page.keyboard.press('j')
  await expect(takeLabel).toHaveText('T2')
  await expect(diff).toContainText('T2 vs T1')
  await expect(diff).toContainText('steps')
  await expect(diff).toContainText('30 → 40')
  await page.keyboard.press('j')
  await expect(takeLabel).toHaveText('T3')
  // T3 vs T2 differs in seed, turbo AND guidance — a real multi-field diff.
  await expect(diff).toContainText('seed')
  await expect(diff).toContainText('128441 → 90210')
  await expect(diff).toContainText('guidance')
  await page.keyboard.press('k')
  await expect(takeLabel).toHaveText('T2')

  // Deferred commit: flipping a modifier op marks the shot's takes stale —
  // no modal dialog ever appears.
  await page.locator('[data-op-toggle="shot-1:upscale"]').check()
  await expect(page.locator('[data-take-chip="s1t1"] [data-cache="stale"]')).toBeVisible()
  await expect(page.locator('.bench-stack-stale.active')).toBeVisible()
  expect(await page.locator('.ui-dialog-center, .modal-backdrop, [role="dialog"]').count()).toBe(0)

  // The re-run gesture: stale takes re-render through the visible queue.
  await page.getByRole('button', { name: /re-run/i }).click()
  await expect(page.locator('[data-take-chip="s1t1"] [data-cache="rendering"], [data-take-chip="s1t1"] [data-cache="fresh"]')).toBeVisible()
  await expect(page.locator('[data-take-chip="s1t1"] [data-cache="fresh"]')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.proto-queue [data-qstate="done"]').filter({ hasText: 'Re-run' })).toBeVisible()

  await page.screenshot({ path: 'test-results/shots/12-proto-bench.png' })
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

// Direction B — The Stage. Select-then-operate: clicking different objects
// swaps the panel's CONTENT (shot params vs image transform) without any
// global mode; Operate→Settings: a slider change fires the render
// immediately — the object shows its own progress bar and a queue item
// lands, no confirm dialog.
test('proto B — The Stage: panel follows selection and changes render immediately', async ({ page }) => {
  const problems = await trackErrors(page)
  await page.goto('/?proto=stage')
  await expect(page.locator('[data-proto="stage"]')).toBeVisible()

  // Empty-panel state, then a shot: the panel becomes the shot's operations.
  await expect(page.locator('[data-stage-panel="empty"]')).toBeVisible()
  const shotObject = page.locator('[data-stage-object="shot-1"]')
  await shotObject.click()
  const shotPanel = page.locator('[data-stage-panel="shot"]')
  await expect(shotPanel).toBeVisible()
  await expect(shotPanel.locator('> header strong')).toContainText('Rain street')

  // A different object TYPE — the panel swaps to the image's operations.
  await page.locator('[data-stage-object="lib-plate"]').click()
  await expect(page.locator('[data-stage-panel="image"]')).toBeVisible()
  await expect(page.locator('[data-stage-slider="scale"]')).toBeVisible()
  await expect(page.locator('[data-stage-slider="seed"]')).toHaveCount(0)

  // Back to the shot; nudge the seed slider — the change RUNS (progress on
  // the object itself, a queue item follows) and no dialog ever appears.
  await shotObject.click()
  await expect(page.locator('[data-stage-panel="shot"]')).toBeVisible()
  const seedValue = page.locator('[data-stage-seed-value]')
  await expect(seedValue).toHaveText('128441')
  await page.locator('[data-stage-slider="seed"]').focus()
  // One ArrowRight snaps the range to its next step (step 137 from min 1000
  // lands on 128547) — the change RUNS immediately.
  await page.keyboard.press('ArrowRight')
  await expect(seedValue).toHaveText('128547')
  await expect(page.locator('[data-obj-progress]')).toBeVisible()
  await expect(page.locator('.stage-miniqueue .proto-queue-item').filter({ hasText: 'Render new take' })).toBeVisible({ timeout: 8_000 })
  expect(await page.locator('.ui-dialog-center, .modal-backdrop, [role="dialog"]').count()).toBe(0)

  // The audition stack, spatially: clicking the already-selected shot cycles
  // its takes, and so do J/K once the slider no longer holds focus.
  const takeOnObject = page.locator('[data-stage-object="shot-1"] [data-stage-take]')
  await expect(takeOnObject).toHaveText('T1')
  await shotObject.click() // click-again cycles the stack
  await expect(takeOnObject).toHaveText('T2')
  await page.keyboard.press('k')
  await expect(takeOnObject).toHaveText('T1')
  await page.keyboard.press('j')
  await expect(takeOnObject).toHaveText('T2')
  // Escape deselects (and the panel returns to its empty state).
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-stage-panel="empty"]')).toBeVisible()

  await page.screenshot({ path: 'test-results/shots/13-proto-stage.png' })
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

// Direction C — The Score. The document tree is the truth; the timeline is a
// projection (beat ruler + span-blocks + take lanes with cache badges) and
// the node graph is a second one. An upstream seed change flips ONLY
// downstream badges stale — the continuity dependency (shot 3 continues
// shot 2's ending) is honored, everything upstream stays fresh.
test('proto C — The Score: projections of one document, staleness flows downstream only', async ({ page }) => {
  const problems = await trackErrors(page)
  await page.goto('/?proto=score')
  await expect(page.locator('[data-proto="score"]')).toBeVisible()

  // The music-first ruler and the span-blocks with take lanes.
  await expect(page.locator('[data-score-ruler]')).toBeVisible()
  await expect(page.locator('[data-score-ruler]')).toContainText('Bar 1')
  await expect(page.locator('[data-score-ruler]')).toContainText('Bar 8')
  await expect(page.locator('[data-score-block]')).toHaveCount(4)
  await expect(page.locator('[data-score-lane]')).toHaveCount(8)
  await expect(page.locator('[data-score-block="shot-1"] .proto-badge[data-cache="fresh"]')).toBeVisible()

  // One document, many projections: flip to the node graph and back (click
  // and the printed V shortcut both work).
  await page.locator('[data-score-proj="graph"]').click()
  await expect(page.locator('[data-score-view="graph"]')).toBeVisible()
  await expect(page.locator('[data-graph-node="shot-3"]')).toBeVisible()
  await expect(page.locator('[data-graph-dep="shot-2->shot-3"]')).toBeVisible()
  await page.keyboard.press('v')
  await expect(page.locator('[data-score-view="timeline"]')).toBeVisible()

  // Upstream edit in the TREE: change shot 2's seed op. Only shot 2 and its
  // downstream (shot 3, which continues its ending) go stale.
  const seedInput = page.locator('[data-score-seed="shot-2"]')
  await expect(seedInput).toBeVisible()
  await seedInput.fill('5599')
  await expect(page.locator('[data-score-block="shot-2"] .proto-badge[data-cache="stale"]')).toBeVisible()
  await expect(page.locator('[data-score-block="shot-3"] .proto-badge[data-cache="stale"]')).toBeVisible()
  await expect(page.locator('[data-score-block="shot-1"] .proto-badge[data-cache="fresh"]')).toBeVisible()
  await expect(page.locator('[data-score-block="shot-4"] .proto-badge[data-cache="fresh"]')).toBeVisible()
  await expect(page.locator('[data-score-lane="s2t1"] [data-cache="stale"]')).toBeVisible()
  await expect(page.locator('[data-score-lane="s3t1"] [data-cache="stale"]')).toBeVisible()
  await expect(page.locator('[data-score-lane="s1t1"] [data-cache="fresh"]')).toBeVisible()
  await expect(page.locator('[data-score-lane="s4t1"] [data-cache="fresh"]')).toBeVisible()

  // The continuity edge draws when the dependent block is hovered.
  await page.locator('[data-score-block="shot-3"]').hover()
  await expect(page.locator('[data-score-dep]')).toBeVisible()

  // Playhead scrub on the ruler: direct DOM transform (rAF discipline),
  // asserted without any React involvement.
  const playhead = page.locator('[data-score-playhead]')
  const rulerBox = await page.locator('[data-score-ruler]').boundingBox()
  expect(rulerBox).not.toBeNull()
  const before = await playhead.evaluate((element) => element.style.transform)
  await page.mouse.move(rulerBox!.x + 60, rulerBox!.y + 12)
  await page.mouse.down()
  await page.mouse.move(rulerBox!.x + 420, rulerBox!.y + 12, { steps: 6 })
  await page.mouse.up()
  const after = await playhead.evaluate((element) => element.style.transform)
  expect(after).not.toBe(before)
  expect(after).toContain('translateX')
  expect(await page.locator('[data-score-readout]')).toContainText('Bar')

  await page.screenshot({ path: 'test-results/shots/14-proto-score.png' })
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})
