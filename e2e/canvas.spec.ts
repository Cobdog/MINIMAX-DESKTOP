import { expect, test, type Page } from '@playwright/test'

// Canvas Phase 1 (task jl4ye8x) — the ?canvas=1 route against the production
// build: launcher → seed tile (mock queued job), drop-anything → media tile,
// the radar aggregation + zoom-to-attention, the summonable index with
// navigate-to-region, session/camera restore through the documents API, and
// the pan/zoom ZERO-RENDER canary (the transient discipline, e2e-asserted —
// the ?probe=canvas precedent from transientProbe). No engine anywhere:
// generation is Phase 2; the seed job is the honest mock in jobsStore.

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
  // Playwright TRACE RECORDING fetches blob: previews for the trace bundle;
  // that tracer-side fetch is what trips connect-src (the <img> itself loads
  // fine — status 200, img-src allows blob:). Not an app defect; verified by
  // the same flow passing without tracing.
  || /Connecting to 'blob:.*' violates the following Content Security Policy directive: "connect-src/.test(entry)

/** Deterministic boots: close the whole canvas session before loading. */
async function resetSession(page: Page) {
  await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } })
}

async function currentTransform(page: Page): Promise<string> {
  return page.locator('[data-canvas-world]').evaluate((element) => element.style.transform)
}

test('canvas boots to the launcher (§4) with radar + chips + resume cards', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  // The empty canvas IS the launcher: prompt bar, the L15-confirmed chips,
  // resume cards, and the in-route titlebar radar.
  await expect(page.locator('[data-canvas-launcher]')).toBeVisible()
  await expect(page.locator('[data-canvas-promptbar]')).toBeVisible()
  for (const chip of ['image', 'video', 'noDialogue', 'drop']) {
    await expect(page.locator(`[data-canvas-chip="${chip}"]`)).toBeVisible()
  }
  await expect(page.locator('[data-canvas-radar]')).toBeVisible()
  await expect(page.locator('[data-canvas-radar-text]')).toHaveText('calm')
  // Resume cards list the canvases the document store knows (the legacy
  // import seeds at least one on first touch).
  await expect(page.locator('[data-canvas-resume]').first()).toBeVisible()
  await expect(page.locator('[data-canvas-viewport]')).toBeVisible()
  await expect(page.locator('[data-canvas-zoom]')).toBeVisible()
  await page.screenshot({ path: 'test-results/shots/15-canvas-launcher.png' })
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('prompt submit spawns the seed tile queued at the prompt bar (contract c + L26)', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')

  await page.locator('[data-canvas-prompt]').fill('a lone drummer on a night train')
  await page.locator('[data-canvas-submit]').click()

  // The seed tile appears, queued for GPU (the mock job parked in jobsStore —
  // generation itself is Phase 2), and the launcher collapses.
  const tile = page.locator('[data-canvas-tile]').first()
  await expect(tile).toBeVisible({ timeout: 10_000 })
  await expect(tile).toHaveAttribute('data-tile-status', 'queued-gpu')
  await expect(tile).toHaveAttribute('data-tile-kind', 'seed')
  await expect(tile.locator('.canvas-tile-ring[data-status="queued-gpu"]')).toBeVisible()
  // The radar counts it (§4 aggregate).
  await expect(page.locator('[data-canvas-radar]')).toHaveAttribute('data-queued', '1')
  await expect(page.locator('[data-canvas-radar-text]')).toContainText('1 queued')
  // A canvas was created for it (tab + persisted project).
  await expect(page.locator('[data-canvas-tab]').first()).toBeVisible()
  // The tile carries the head/tail endpoint affordances (visual only, Phase 2).
  await expect(tile.locator('[data-canvas-endpoint="head"]')).toBeVisible()
  await expect(tile.locator('[data-canvas-endpoint="tail"]')).toBeVisible()
  // Selection followed: the floating inspector shell opens on the tile.
  await expect(page.locator('[data-canvas-inspector]')).toBeVisible()
  await page.screenshot({ path: 'test-results/shots/16-canvas-seed-tile.png' })
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('dropping media lands a media tile routed by kind', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')

  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['placeholder-bytes'], 'alley-plate.png', { type: 'image/png' }))
    document.querySelector('[data-canvas-root]')!.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }))
  })

  const tile = page.locator('[data-canvas-tile]').first()
  await expect(tile).toBeVisible({ timeout: 10_000 })
  await expect(tile).toHaveAttribute('data-tile-kind', 'media')
  await expect(tile).toHaveAttribute('data-tile-status', 'idle')
  // The dropped file's bytes preview session-locally until Phase 2 ingestion.
  await expect(tile.locator('img.canvas-tile-poster')).toBeVisible()
  // A neutral ambient toast routed the honest Phase-2 note (§4 tiers).
  await expect(page.locator('[data-canvas-toast="neutral"]').first()).toBeVisible()
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('pan and zoom render ZERO React frames (the transient discipline)', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1&probe=canvas')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await page.locator('[data-canvas-prompt]').fill('discipline probe shot')
  await page.locator('[data-canvas-submit]').click()
  await expect(page.locator('[data-canvas-tile]').first()).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(800) // fly-to + camera settle

  const canary = page.locator('[data-canvas-renders]')
  const tile = page.locator('[data-canvas-tile]').first()
  const before = await currentTransform(page)
  const rendersBefore = await canary.evaluate((element) => Number(element.dataset.canvasRenders))

  // (1) The synthetic drive: 120 camera updates through the real
  // store→rAF pipeline — the world moves, React stays asleep.
  const drive = await page.evaluate(() => (window as unknown as { __canvasDriveCamera(count: number): { appliedAfter: number; pending: boolean } }).__canvasDriveCamera(120))
  expect(drive.pending).toBe(true)
  await page.waitForTimeout(120)
  const afterDrive = await currentTransform(page)
  expect(afterDrive).not.toBe(before)
  expect(afterDrive).toContain('translate')
  expect(await canary.evaluate((element) => Number(element.dataset.canvasRenders))).toBe(rendersBefore)

  // (2) A REAL mouse pan over empty canvas — gesture-driven, same contract.
  const viewport = page.locator('[data-canvas-viewport]')
  const box = await viewport.boundingBox()
  const beforePan = await currentTransform(page)
  await page.mouse.move(box!.x + 1200, box!.y + 600)
  await page.mouse.down()
  await page.mouse.move(box!.x + 700, box!.y + 420, { steps: 24 })
  await page.mouse.up()
  const afterPan = await currentTransform(page)
  expect(afterPan).not.toBe(beforePan)
  expect(await canary.evaluate((element) => Number(element.dataset.canvasRenders))).toBe(rendersBefore)

  // (3) A REAL wheel zoom about the cursor. Two notches from 0.9× land past
  // the mid→near band at 1.05 — EXACTLY ONE render is the designed cost of
  // the semantic-zoom content swap, never a per-frame render.
  const beforeZoom = await currentTransform(page)
  await page.mouse.move(box!.x + 960, box!.y + 540)
  await page.mouse.wheel(0, -120)
  await page.mouse.wheel(0, -120)
  await page.waitForTimeout(200)
  const afterZoom = await currentTransform(page)
  expect(afterZoom).not.toBe(beforeZoom)
  const rendersAfterZoom = await canary.evaluate((element) => Number(element.dataset.canvasRenders))
  expect(rendersAfterZoom).toBeLessThanOrEqual(rendersBefore + 1)
  // The one allowed render bought the band swap: near-band content is in.
  await expect(tile.locator('[data-canvas-latent]')).toBeVisible()

  // (4) The zoom readout moved too (direct DOM write, not React state).
  await expect(page.locator('[data-canvas-zoom]')).not.toHaveText('90%')
  await page.screenshot({ path: 'test-results/shots/17-canvas-zero-render.png' })
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('radar zooms to attention on failure (contract a: durable on the object)', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1&probe=canvas')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await page.locator('[data-canvas-prompt]').fill('attention probe shot')
  await page.locator('[data-canvas-submit]').click()
  const tile = page.locator('[data-canvas-tile]').first()
  await expect(tile).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(900) // let the fly-to settle

  // Pan AWAY from the tile so zoom-to-attention has distance to cover.
  const viewport = page.locator('[data-canvas-viewport]')
  const box = await viewport.boundingBox()
  await page.mouse.move(box!.x + 1500, box!.y + 500)
  await page.mouse.down()
  await page.mouse.move(box!.x + 300, box!.y + 760, { steps: 20 })
  await page.mouse.up()

  // A failure event arrives through the real store path (gated scenario).
  const scenario = await page.evaluate(() => (window as unknown as { __canvasScenario(name: string): { ok: boolean } }).__canvasScenario('fail-worst'))
  expect(scenario.ok).toBe(true)

  // Durable on the object: failed ring + reason + dismiss, radar pings.
  await expect(tile).toHaveAttribute('data-tile-status', 'failed')
  await expect(tile.locator('.canvas-tile-failure')).toContainText('engine exploded (scenario)')
  await expect(page.locator('[data-canvas-radar]')).toHaveAttribute('data-attention', '1')
  await expect(page.locator('[data-canvas-radar]')).toHaveClass(/attention/)

  // Click = zoom-to-attention: the camera moves onto the worst item.
  const before = await currentTransform(page)
  await page.locator('[data-canvas-radar]').click()
  await page.waitForTimeout(900)
  const after = await currentTransform(page)
  expect(after).not.toBe(before)

  // Dismiss clears the durable failure honestly (the job record stays —
  // only the on-object banner goes).
  await tile.locator('.canvas-tile-failure button').click()
  await expect(tile).not.toHaveAttribute('data-tile-status', 'failed')
  await expect(page.locator('[data-canvas-radar]')).toHaveAttribute('data-attention', '0')
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('the summonable index searches and navigates to the region (⌘K)', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await page.locator('[data-canvas-prompt]').fill('lighthouse keeper counting ships')
  await page.locator('[data-canvas-submit]').click()
  await expect(page.locator('[data-canvas-tile]').first()).toBeVisible({ timeout: 10_000 })

  // Pan away so navigation has somewhere to go.
  const viewport = page.locator('[data-canvas-viewport]')
  const box = await viewport.boundingBox()
  await page.mouse.move(box!.x + 1500, box!.y + 500)
  await page.mouse.down()
  await page.mouse.move(box!.x + 300, box!.y + 700, { steps: 20 })
  await page.mouse.up()
  const movedAway = await currentTransform(page)

  // ⌘K opens the index; typing filters to the object row (client rows over
  // the loaded document; FTS merges behind).
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.locator('[data-canvas-index]')).toBeVisible()
  await expect(page.locator('[data-canvas-index-row="project"]').first()).toBeVisible()
  await page.locator('[data-canvas-index-input]').fill('lighthouse')
  await expect(page.locator('[data-canvas-index-row="object"]').first()).toBeVisible()

  // Enter navigates: the camera flies to the tile and selects it.
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-canvas-index]')).toHaveCount(0)
  await page.waitForTimeout(900)
  const navigated = await currentTransform(page)
  expect(navigated).not.toBe(movedAway)
  await expect(page.locator('[data-canvas-inspector]')).toBeVisible()

  // Escape closes the index; a fresh open focuses the field.
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.locator('[data-canvas-index]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-canvas-index]')).toHaveCount(0)
  await page.screenshot({ path: 'test-results/shots/18-canvas-index.png' })
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('session + camera autosave restore through the documents API', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await page.locator('[data-canvas-prompt]').fill('persistence probe shot')
  await page.locator('[data-canvas-submit]').click()
  await expect(page.locator('[data-canvas-tile]').first()).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(900)

  // Drive the camera and let the debounce persist it (§2.1 invariant 10).
  const viewport = page.locator('[data-canvas-viewport]')
  const box = await viewport.boundingBox()
  await page.mouse.move(box!.x + 1400, box!.y + 600)
  await page.mouse.down()
  await page.mouse.move(box!.x + 500, box!.y + 350, { steps: 18 })
  await page.mouse.up()
  await page.waitForTimeout(1_100) // persist debounce is 600 ms

  // The persisted blob carries the camera (the documents API is the store).
  const session = await page.evaluate(async () => {
    const response = await fetch('/api/lan/documents/session')
    return (await response.json()).session as { activeProject: string | null; openProjects: string[] }
  })
  expect(session.activeProject).toBeTruthy()
  expect(session.openProjects).toContain(session.activeProject)
  const project = await page.evaluate(async (id) => {
    const response = await fetch(`/api/lan/documents/project?id=${encodeURIComponent(id)}`)
    return (await response.json()).project as { camera: { camera?: { x: number; y: number; k: number } } }
  }, session.activeProject)
  const saved = project.camera.camera
  expect(saved).toBeTruthy()
  expect(saved!.k).toBeGreaterThan(0)

  // Reload: the same project reopens with the camera restored.
  await page.reload()
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await expect(page.locator('[data-canvas-tile]').first()).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(400)
  const restored = await currentTransform(page)
  const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(restored)
  expect(match).not.toBeNull()
  expect(Number(match![1])).toBeCloseTo(saved!.x, 0)
  expect(Number(match![2])).toBeCloseTo(saved!.y, 0)

  // Close the canvas (tab ×) — the session empties and the launcher returns.
  await page.locator('[data-canvas-tab] .canvas-tab-close').first().click()
  await expect(page.locator('[data-canvas-launcher]')).toBeVisible()
  // …and the closed canvas is resumable from its card.
  const card = page.locator('[data-canvas-resume]').first()
  await expect(card).toBeVisible()
  await card.click()
  await expect(page.locator('[data-canvas-tile]').first()).toBeVisible({ timeout: 10_000 })
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})
