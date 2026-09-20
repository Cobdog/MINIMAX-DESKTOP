import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// Settings UX fix wave (g5x37k8, review i7u40j6): the settings surface's
// blockers and majors, end to end against the built app. Engine-independent
// throughout — the pack-target resolution, the defaults confirm, the status
// error line, the save-warnings toast, the layout DOM truth, and the
// empty-jobs boot guard all exercise paths that need no engine.
//
// Shared-home discipline (docs/agent/testing.md): every test that mutates
// PERSISTED settings restores the original through the settings API in a
// finally; form-only mutations (no Save) persist nothing and need no
// restore.

const environmental = (entry: string) =>
  entry.includes('Failed to load resource')
  || /WebSocket connection to .* failed/.test(entry)
  || /Connecting to 'blob:.*' violates the following Content Security Policy directive: "connect-src/.test(entry)
  || /net::ERR_CONNECTION_REFUSED/.test(entry)

async function trackErrors(page: Page) {
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`)
  })
  return problems
}

async function resetSession(page: Page) {
  await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } })
}

async function originalSettings(page: Page): Promise<Record<string, unknown>> {
  return ((await (await page.request.get('/api/lan/settings')).json()) as { settings: Record<string, unknown> }).settings
}

async function restoreSettings(page: Page, settings: Record<string, unknown>) {
  await page.request.post('/api/lan/settings', { data: { settings } })
}

async function openSettings(page: Page) {
  await page.locator('[data-canvas-settings-button]').click()
  await expect(page.locator('[data-canvas-settings-dock]')).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw new Error(`Uncaught renderer error during navigation: ${error.message}`)
  })
})

// B1 — the pack list must re-resolve when the SAVED settings change the
// install target. Repro shape (review B1): boot with an empty external
// custom-nodes folder → chips read "no install target" → type a real folder
// → Save → the server is resolved, but the chips only refreshed on FIELD
// edits, so they stayed stale until the field was touched again. The fix
// refreshes once the save settles. Failing-without-it: without the post-save
// refresh the chip stays "no install target" and this times out.
test('B1: node-pack chips re-resolve after Save — no field re-edit needed', async ({ page }) => {
  const problems = await trackErrors(page)
  const original = await originalSettings(page)
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-settings-b1-'))
  try {
    // Boot with external mode and NO install target.
    const applied = await page.request.post('/api/lan/settings', { data: { settings: {
      ...original,
      engine: { ...(original.engine as Record<string, unknown>), mode: 'external', externalCustomNodesDir: '' },
    } } })
    expect(applied.status(), `settings POST must succeed: ${JSON.stringify(await applied.json().catch(() => ({})))}`).toBe(200)
    await resetSession(page)
    await page.goto('/')
    await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
    await openSettings(page)

    const vdnRow = page.locator('.node-pack-row').filter({ hasText: 'ComfyUI-VDN-H3' })
    await vdnRow.locator('[data-node-pack-chip]').scrollIntoViewIfNeeded()
    await expect(vdnRow.locator('[data-node-pack-chip]')).toHaveAttribute('data-node-pack-chip', 'no install target', { timeout: 15_000 })
    await expect(vdnRow.getByRole('button', { name: /^Install$/ })).toBeDisabled()

    // Type the target folder, then SAVE — and nothing else. The field edit
    // alone must NOT flip the chip (the server still holds the old settings
    // at that moment); the flip belongs to the post-save refresh.
    const externalInput = page.locator('[data-external-custom-nodes]')
    await expect(externalInput).toBeVisible()
    await externalInput.fill(externalDir)
    await expect(vdnRow.locator('[data-node-pack-chip]')).toHaveAttribute('data-node-pack-chip', 'no install target')

    // Role-name selector (works across the fix's markup change) so this test
    // proves the STALE-CHIP regression on pre-fix builds, not a selector.
    await page.getByRole('button', { name: 'Save settings' }).click()
    await expect(vdnRow.locator('[data-node-pack-chip]')).toHaveAttribute('data-node-pack-chip', 'missing', { timeout: 15_000 })
    await expect(vdnRow.getByRole('button', { name: /^Install$/ })).toBeEnabled()
    expect(problems.filter((entry) => !environmental(entry))).toEqual([])
  } finally {
    await restoreSettings(page, original)
  }
})

// B2 — "Reset to recommended" (the old "Apply to Create") must never
// silently replace user-tuned defaults: it confirms first and NAMES the
// deltas it will change. Failing-without-it: the old code applied the
// hardcoded set with no dialog, so the cancel assertion (duration stays 10)
// fails immediately.
test('B2: resetting generation defaults confirms and names the deltas — cancel keeps tuned values', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await openSettings(page)

  // The duration field is the first number input in the defaults grid —
  // positional so the selector also resolves on pre-fix builds (whose
  // NumberField had no label association).
  const duration = page.locator('.generation-defaults-grid input[type="number"]').first()
  await duration.scrollIntoViewIfNeeded()
  await duration.fill('10')
  await expect(duration).toHaveValue('10')

  // Text selector spans the pre-fix label ("Apply to Create") and the fixed
  // one ("Reset to recommended") — on the pre-fix build the click applies
  // the hardcoded set with NO dialog, and the dialog wait below times out:
  // the failing-without-it proof of the silent-overwrite regression.
  const reset = page.locator('button').filter({ hasText: /Apply to Create|Reset to recommended/ }).first()
  await expect(reset).toBeEnabled()

  // Cancel: the confirm names the exact delta; nothing changes. (The native
  // confirm BLOCKS the click promise until handled — click and dialog are
  // awaited concurrently.)
  const cancelDialog = page.waitForEvent('dialog')
  const cancelClick = reset.click()
  const dialog = await cancelDialog
  expect(dialog.message()).toContain('duration (s): 10 → 5')
  expect(dialog.type()).toBe('confirm')
  await dialog.dismiss()
  await cancelClick
  await expect(duration).toHaveValue('10')

  // Accept: the named change is exactly what happens.
  const acceptDialog = page.waitForEvent('dialog')
  const acceptClick = reset.click()
  const confirmed = await acceptDialog
  await confirmed.accept()
  await acceptClick
  await expect(duration).toHaveValue('5')
  // Already at recommended → the button disables instead of offering a no-op.
  await expect(reset).toBeDisabled()
  // M8 rides along: llamaVisionModel (the datasets/vision-scenario model)
  // now has a UI row — settable, not settings-file-only.
  await expect(page.locator('[data-llm-vision-model]')).toBeVisible()
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

// M3 — the status route's `error` used to be dead weight: a failed
// connection test showed only the stale "Offline" pill. The reason line must
// render, naming the address that was tried.
test('M3: a failed connection test renders its error with the tried address', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await openSettings(page)

  const url = page.locator('#comfy-url')
  await url.fill('http://127.0.0.1:9') // port 9 (discard): local, dead
  await page.locator('.connection-row').filter({ has: url }).getByRole('button', { name: 'Test connection' }).click()
  const errorLine = page.locator('[data-comfy-status-error]')
  await expect(errorLine).toBeVisible({ timeout: 15_000 })
  await expect(errorLine).toContainText('http://127.0.0.1:9')
  await expect(errorLine.textContent()).toBeTruthy()
  // No Save ran: nothing persisted, nothing to restore.
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

// M4 — the server computes save-warnings ("…does not exist yet") and the
// client used to drop them for a flat success toast. The toast must carry
// them. Persisted settings are restored in finally.
test('M4: saving settings surfaces the server\'s nonexistent-path warnings', async ({ page }) => {
  const problems = await trackErrors(page)
  const original = await originalSettings(page)
  try {
    await resetSession(page)
    await page.goto('/')
    await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
    await openSettings(page)

    const output = page.locator('#output-path')
    await output.fill(path.join(os.tmpdir(), 'mm-settings-m4-definitely-missing'))
    await page.locator('[data-save-settings]').click()
    await expect(page.locator('[data-canvas-toast].success')).toContainText('does not exist yet', { timeout: 20_000 })
    expect(problems.filter((entry) => !environmental(entry))).toEqual([])
  } finally {
    await restoreSettings(page, original)
  }
})

// M2 — Settings reachability: the deep-link opens the dock on the canvas,
// and the datasets + images surfaces carry the affordance (their hrefs
// preserve the LAN token when one is present).
test('M2: ?settings=1 opens the dock; datasets and images surfaces link to it', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?settings=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await expect(page.locator('[data-canvas-settings-dock]')).toBeVisible()
  await page.locator('[data-canvas-settings-close]').click()
  await expect(page.locator('[data-canvas-settings-dock]')).toHaveCount(0)

  await page.goto('/?datasets=1')
  const dsLink = page.locator('[data-ds-settings-link]')
  await expect(dsLink).toBeVisible()
  await expect(dsLink).toHaveAttribute('href', /\/\?settings=1/)

  // The images workbench needs a live session chain before its header
  // renders — seed one through the documents API (the surface's own e2e
  // pattern), then reset the session so the shared home's open-project
  // state is untouched.
  const project = await (await page.request.post('/api/lan/documents/projects', { data: { name: 'IW settings-link probe' } })).json()
  await page.request.post('/api/lan/documents/chains', { data: { projectId: project.project.id, kind: 'h3img', settings: { family: 'h3img.generate.packet', intent: '', tier: 5, keepDial: 0.55, seed: 1, resolution: '1344x768', loras: [], refs: [], semanticOverflow: false, framePicks: {}, refineEngine: '', poserigInbox: null } } })
  await page.request.post('/api/lan/documents/session', { data: { openProjects: [project.project.id], activeProject: project.project.id } })
  try {
    await page.goto('/?images=1')
    const iwLink = page.locator('[data-iw-settings-link]')
    await expect(iwLink).toBeVisible({ timeout: 20_000 })
    await expect(iwLink).toHaveAttribute('href', /\/\?settings=1/)
  } finally {
    await resetSession(page)
  }
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

// M9/M10/M11 — layout DOM truth (the vision scenario re-captures the visual
// side; these assert the geometry): pack actions reachable inside a 420px
// dock, the close button inside a 640px window, and the three-dock cascade
// (distinct positions, natural-order headers visible, raise-on-grab).
//
// Narrow viewports open the dock through the ?settings=1 deep-link: the
// titlebar overflows below ~1000px, and an actionability auto-scroll of the
// (previously scrollable) canvas root was exactly the bug that hung docks
// off-screen — the deep-link is the real user path that needs no scroll.
test('M9/M10/M11: dock geometry — actions reachable at 420px, close reachable at 640px, docks cascade', async ({ page }) => {
  await resetSession(page)

  // 420px dock: a 444px viewport makes the clamped default exactly the
  // 420px minimum (no resize drag needed — the deterministic path).
  await page.setViewportSize({ width: 444, height: 900 })
  await page.goto('/?settings=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await expect(page.locator('[data-canvas-settings-dock]')).toBeVisible()
  const vdnRow = page.locator('.node-pack-row').filter({ hasText: 'ComfyUI-VDN-H3' })
  const install = vdnRow.getByRole('button', { name: /^Install$/ })
  await install.scrollIntoViewIfNeeded()
  const installBox = await install.boundingBox()
  const bodyBox = await page.locator('[data-canvas-settings-body]').boundingBox()
  expect(installBox).not.toBeNull()
  expect(bodyBox).not.toBeNull()
  expect(installBox!.x, 'the dock sits at its clamped in-window position (no root scroll)').toBeGreaterThanOrEqual(0)
  expect(installBox!.x + installBox!.width, 'Install stays inside the dock body at min width').toBeLessThanOrEqual(bodyBox!.x + bodyBox!.width + 1)
  // DOM truth: the point at the Install button's center hits the row (or
  // the button) — never the page behind the clipped panel.
  const hit = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y)
    return element ? (element.closest('.node-pack-row') as HTMLElement | null)?.textContent ?? '' : ''
  }, { x: installBox!.x + installBox!.width / 2, y: installBox!.y + installBox!.height / 2 })
  expect(hit).toContain('ComfyUI-VDN-H3')
  // The root must not be scrollable sideways at all (the clip fix).
  const rootScroll = await page.evaluate(() => ({ left: document.querySelector('.canvas-root')?.scrollLeft ?? 0, overflow: getComputedStyle(document.querySelector('.canvas-root')!).overflow }))
  expect(rootScroll.left).toBe(0)
  expect(['clip', 'hidden']).toContain(rootScroll.overflow)

  // 640px window: the clamped default keeps the whole dock — close button
  // included — inside the window.
  await page.setViewportSize({ width: 640, height: 720 })
  await page.goto('/?settings=1')
  await expect(page.locator('[data-canvas-settings-dock]')).toBeVisible()
  const dockBox = await page.locator('[data-canvas-settings-dock]').boundingBox()
  const closeBox = await page.locator('[data-canvas-settings-close]').boundingBox()
  expect(dockBox).not.toBeNull()
  expect(closeBox).not.toBeNull()
  expect(dockBox!.x, 'the dock starts inside the window').toBeGreaterThanOrEqual(0)
  expect(closeBox!.x + closeBox!.width, 'the close button stays inside a 640px window').toBeLessThanOrEqual(640)
  // And it closes — the reachable button actually works.
  await page.locator('[data-canvas-settings-close]').click()
  await expect(page.locator('[data-canvas-settings-dock]')).toHaveCount(0)

  // Two docks in the NATURAL order (settings → diagnostics): distinct
  // cascaded positions, every header band directly hittable, and
  // raise-on-grab lifts a covered dock above its sibling. (The studios dock
  // was removed with the Studios — Phase 0, 2026-09-20.)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('/')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await openSettings(page)
  await page.locator('[data-canvas-diagnostics-button]').click()
  await expect(page.locator('[data-canvas-diagnostics-dock]')).toBeVisible()

  const ownerAt = (x: number, y: number) => page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y)
    const dockElement = element?.closest('[data-canvas-settings-dock],[data-canvas-diagnostics-dock]') as HTMLElement | null
    if (!dockElement) return ''
    if (dockElement.hasAttribute('data-canvas-settings-dock')) return 'settings'
    if (dockElement.hasAttribute('data-canvas-diagnostics-dock')) return 'diagnostics'
    return ''
  }, { x, y })

  const positions: Array<{ x: number; y: number }> = []
  for (const selector of ['[data-canvas-settings-dock]', '[data-canvas-diagnostics-dock]']) {
    const box = await page.locator(selector).boundingBox()
    expect(box, `${selector} exists`).not.toBeNull()
    positions.push({ x: box!.x, y: box!.y })
  }
  expect(new Set(positions.map((position) => `${position.x},${position.y}`)).size, 'no two open docks share a position (cascade)').toBe(2)

  // Natural order + the 48px y-steps: each dock's header band is the top
  // hit at its own icon — both titles directly reachable.
  for (const selector of ['[data-canvas-settings-dock]', '[data-canvas-diagnostics-dock]']) {
    const icon = page.locator(`${selector} .canvas-inspector-header svg`).first()
    const box = await icon.boundingBox()
    expect(box, `${selector} header icon has geometry`).not.toBeNull()
    expect(await ownerAt(box!.x + 2, box!.y + 2), `${selector}'s header band is the top hit at its icon`).toBeTruthy()
  }

  // Raise-on-grab: settings (lowest z, its band visible) gets grabbed —
  // after the grab it covers the later dock's header band, proving z moved.
  const diagnosticsIcon = await page.locator('[data-canvas-diagnostics-dock] .canvas-inspector-header svg').first().boundingBox()
  expect(await ownerAt(diagnosticsIcon!.x + 2, diagnosticsIcon!.y + 2)).toBe('diagnostics')
  const settingsBox = await page.locator('[data-canvas-settings-dock]').boundingBox()
  await page.mouse.click(settingsBox!.x + 60, settingsBox!.y + 8)
  expect(await ownerAt(diagnosticsIcon!.x + 2, diagnosticsIcon!.y + 2), 'a grabbed settings dock now covers the diagnostics header band (raise-on-grab)').toBe('settings')
})

// M13 — the boot-time 400: the debounced persist used to fire an empty
// {"jobs":[]} POST on every fresh boot (the server rejects empty batches,
// and the catch then mirrored [] to localStorage as "degraded mode"). The
// guard skips empty lists client-side. The GET is mocked to an empty list
// with the migration marker pre-set so the empty-list boot transition fires
// deterministically regardless of the shared home's accumulated jobs.
test('M13: no empty-jobs POST on boot — the 400-every-fresh-boot fix', async ({ page }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('minimax.data-migrated', '1') } catch { /* storage unavailable — the route mock still drives the case */ }
  })
  let emptyPosts = 0
  await page.route('**/api/lan/jobs*', async (route) => {
    const request = route.request()
    if (request.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jobs: [] }) })
      return
    }
    try {
      const body = request.postDataJSON() as { jobs?: unknown[] }
      if (request.method() === 'POST' && Array.isArray(body.jobs) && body.jobs.length === 0) emptyPosts += 1
    } catch { /* not JSON — counted by the server's own guard */ }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  })
  await resetSession(page)
  await page.goto('/')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  // Boot + the 1 s trailing debounce + margin: any empty POST lands here.
  await page.waitForTimeout(2500)
  expect(emptyPosts, 'no empty-jobs POST fires on boot').toBe(0)
})
