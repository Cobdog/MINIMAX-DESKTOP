import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

// Dataset manager v1 (sv14rt0, docs/specs/dataset-manager-v1.md §11/§12):
// the workbench surface end to end at ?datasets=1 — gallery from a real
// ingested source, the stamp-crop editor's interaction contract (aspect
// spectrum chips + the never-loops hard-stop hint + the 32-grid readout),
// layer save, the caption editor's live trigger validation, the dashboard's
// per-trainer preflight, and the export wizard's honest empty-selection
// refusal. Engine-independent (the media is a synthetic ffmpeg clip), and
// every test attaches the console/page-error guard like app.spec.ts.

const exec = promisify(execFile)

const environmental = (entry: string) =>
  entry.includes('Failed to load resource')
  || /WebSocket connection to .* failed/.test(entry)
  || /Connecting to 'blob:.*' violates the following Content Security Policy directive: "connect-src/.test(entry)

async function trackErrors(page: Page) {
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`)
  })
  return problems
}

async function seedLibrary(request: APIRequestContext) {
  // One synthetic 480×832 24 fps clip, ingested by reference through the
  // same HTTP surface a real client uses. The fixture lives INSIDE the
  // server's studio home (test-home) — by-reference ingest is scope-gated
  // (security wave 2) — and the file stays put (the source is sacred).
  const home = join(process.cwd(), 'test-home')
  mkdirSync(home, { recursive: true })
  const dir = mkdtempSync(join(home, 'ds-e2e-'))
  const clip = join(dir, 'e2e-clip.mp4')
  await exec('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=3:size=480x832:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip])
  const response = await request.post('/api/lan/datasets/ingest/reference', { data: { path: clip } })
  expect(response.ok()).toBeTruthy()
  const body = await response.json()
  expect(body.source.probe.width).toBe(480)
  // Wait for the async decode probe (required before layers bake; the UI
  // polls, the test just gives it a beat).
  await expect
    .poll(async () => {
      const library = await (await request.get('/api/lan/datasets/library')).json()
      return library.sources.find((source: { id: string }) => source.id === body.source.id)?.probeState
    }, { timeout: 15_000 })
    .toBe('done')
  return body.source.id as string
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw new Error(`Uncaught renderer error during navigation: ${error.message}`)
  })
})

test('the workbench boots at ?datasets=1 with the seeded master in the gallery', async ({ page }) => {
  const problems = await trackErrors(page)
  const sourceId = await seedLibrary(page.request)
  await page.goto('/?datasets=1')
  await expect(page.locator('[data-ds-root]')).toBeVisible()
  await expect(page.locator('[data-ds-gallery]')).toBeVisible()
  const master = page.locator(`[data-ds-master][data-health="healthy"]`, { hasText: 'e2e-clip' }).first()
  await expect(master).toBeVisible({ timeout: 10_000 })
  await expect(master.locator('.ds-master-facts')).toContainText('480×832')
  // The empty state is gone and the entry chip back to the canvas exists.
  await expect(page.locator('[data-ds-empty]')).toHaveCount(0)
  await expect(page.locator('.ds-back')).toHaveText(/canvas/)
  // No renderer errors beyond the known environmental set.
  await expect(problems.filter((entry) => !environmental(entry))).toEqual([])
  void sourceId
})

test('the stamp-crop editor: aspect spectrum, hard-stop hint, 32-grid crop, save', async ({ page }) => {
  await seedLibrary(page.request)
  await page.goto('/?datasets=1')
  const master = page.locator('[data-ds-master]', { hasText: 'e2e-clip' }).first()
  await expect(master).toBeVisible({ timeout: 10_000 })
  await master.getByRole('button', { name: /layer/ }).first().click()
  await expect(page.locator('[data-ds-editor]')).toBeVisible()
  // The managed spectrum renders the officials, widest → tallest.
  const strip = page.locator('[data-ds-aspect-strip]')
  await expect(strip).toBeVisible()
  for (const label of ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']) {
    await expect(strip.getByRole('button', { name: label, exact: true })).toBeVisible()
  }
  // Default is 16:9-class; the crop readout shows 32-grid values.
  await expect(page.locator('.ds-crop-readout')).toContainText(/w \d+ · h \d+/)
  // shift+scroll at the BOTTOM edge: the hard-stop hint appears (the
  // spectrum never loops — spec §3).
  const stage = page.locator('[data-ds-stage]')
  await strip.getByRole('button', { name: '9:16', exact: true }).click()
  await stage.click({ position: { x: 200, y: 200 } })
  for (let index = 0; index < 3; index += 1) {
    await stage.hover()
    await page.keyboard.down('Shift')
    await page.mouse.wheel(0, 240)
    await page.keyboard.up('Shift')
  }
  await expect(page.locator('.ds-status', { hasText: /hard stop/i }).first()).toBeVisible({ timeout: 5_000 })
  // Save a layer; it lands as a visible child with a bucket badge.
  await page.locator('[data-ds-save-layer]').click()
  await expect(page.locator('[data-ds-editor]')).toHaveCount(0)
  await master.locator('.ds-master-name').click() // expand to see the children
  const layer = page.locator('[data-ds-layer]').first()
  await expect(layer).toBeVisible({ timeout: 10_000 })
  await expect(layer.locator('.ds-bucket-badge')).toBeVisible()
})

test('the caption editor: live trigger validation and the stale badge flow', async ({ page }) => {
  await seedLibrary(page.request)
  await page.request.post('/api/lan/datasets/settings', { data: { triggerToken: 'ph0t0r34l', contentClass: 'style' } })
  await page.goto('/?datasets=1')
  const master = page.locator('[data-ds-master]', { hasText: 'e2e-clip' }).first()
  await expect(master).toBeVisible({ timeout: 10_000 })
  await master.getByRole('button', { name: /layer/ }).first().click()
  await page.locator('[data-ds-save-layer]').click()
  await master.locator('.ds-master-name').click() // expand to see the children
  await expect(page.locator('[data-ds-layer]').first()).toBeVisible({ timeout: 10_000 })
  // Open the caption editor; type a caption missing the trigger first.
  await page.locator('[data-ds-layer]').first().getByRole('button', { name: 'caption' }).click()
  await expect(page.locator('[data-ds-caption]')).toBeVisible()
  const textarea = page.locator('[data-ds-caption-textarea]')
  await textarea.fill('a colorful test pattern drifting slowly; no audible sound')
  await expect(page.locator('[data-ds-validation]')).toContainText(/trigger/i, { timeout: 5_000 })
  await textarea.fill('ph0t0r34l, a colorful test pattern drifting slowly; no audible sound')
  await expect(page.locator('[data-ds-validation-ok]')).toBeVisible({ timeout: 5_000 })
  await page.locator('[data-ds-save-caption]').click()
  await expect(page.locator('.ds-status', { hasText: 'Saved' })).toBeVisible()
  // Editing the crop afterwards flags the caption stale (§4).
  await page.locator('[data-ds-caption] .ds-btn.ghost', { hasText: 'Close' }).click()
  await page.locator('[data-ds-layer]').first().getByRole('button', { name: 'crop/trim' }).click()
  await page.locator('[data-ds-aspect-strip]').getByRole('button', { name: '4:3', exact: true }).click()
  await page.locator('[data-ds-save-layer]').click()
  await expect(page.locator('[data-ds-layer] .ds-stale-badge').first()).toBeVisible({ timeout: 10_000 })
})

test('the dashboard renders both trainer preflight profiles; export refuses honestly with no selection', async ({ page }) => {
  await seedLibrary(page.request)
  await page.goto('/?datasets=1')
  await page.getByRole('button', { name: 'dashboard' }).click()
  await expect(page.locator('[data-ds-dashboard]')).toBeVisible()
  await expect(page.locator('[data-ds-preflight]')).toBeVisible()
  await expect(page.locator('[data-ds-preflight-card]')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('[data-ds-preflight-card]')).toContainText('DiffSynX')
  await expect(page.locator('[data-ds-preflight-card]')).toContainText('musubi')
  await expect(page.locator('[data-ds-preflight-card]')).toContainText(/binds:/)
  await expect(page.locator('[data-ds-guidance]')).toBeVisible()
  // Export with nothing selected surfaces the honest error, not a silent pass.
  await page.getByRole('button', { name: 'export' }).click()
  await expect(page.locator('[data-ds-export]')).toBeVisible()
  await page.locator('[data-ds-run-export]').click()
  await expect(page.locator('[data-ds-error]')).toContainText(/No layers selected/i)
})

test('the launcher carries the datasets entry chip from the canvas', async ({ page }) => {
  await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } })
  await page.goto('/')
  await expect(page.locator('[data-canvas-chip="datasets"]')).toBeVisible()
})
