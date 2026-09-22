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

// Shared-home isolation (Wave 4 test hygiene, the fh94g76 flake): the e2e
// home persists across runs, and the seed clips are byte-DETERMINISTIC
// (ffmpeg testsrc2) — every run's ingest dedupes onto the SAME source row,
// so layers accumulate on one master until an old 4:3 layer becomes the
// list's `.first()` and an aspect chip reads already-active+disabled. Every
// run now starts from a clean dataset slate, cleaned through the app's OWN
// API (trash the seeded sources, then empty the trash) — never by hand.
test.beforeAll(async ({ request }) => {
  const library = await (await request.get('/api/lan/datasets/library')).json() as {
    sources?: Array<{ id: string; absPath?: string }>
    trashed?: { sources?: Array<{ id: string; absPath?: string }> }
  }
  const seeded = (row: { id: string; absPath?: string }) => /e2e-(clip|still)\.(mp4|png)/.test(row.absPath ?? '')
  for (const row of [...(library.sources ?? []), ...(library.trashed?.sources ?? [])]) {
    if (seeded(row)) await request.post('/api/lan/datasets/sources/trash', { data: { sourceId: row.id } }).catch(() => undefined)
  }
  await request.post('/api/lan/datasets/trash/empty', { data: {} }).catch(() => undefined)
})

/** One synthetic 512² still, ingested by reference (the app-tour wave's
 * poll-terminus coverage — images resolve their probe facts at ingest). */
async function seedStill(request: APIRequestContext) {
  const home = join(process.cwd(), 'test-home')
  mkdirSync(home, { recursive: true })
  const dir = mkdtempSync(join(home, 'ds-e2e-'))
  const still = join(dir, 'e2e-still.png')
  await exec('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=1:size=512x512:rate=24', '-frames:v', '1', still])
  const response = await request.post('/api/lan/datasets/ingest/reference', { data: { path: still } })
  expect(response.ok()).toBeTruthy()
  const body = await response.json()
  return body.source.id as string
}

test('the workbench boots at ?datasets=1 with the seeded master in the gallery', async ({ page }) => {
  const problems = await trackErrors(page)
  const sourceId = await seedLibrary(page.request)
  await page.goto('/?datasets=1')
  await expect(page.locator('[data-ds-root]')).toBeVisible()
  await expect(page.locator('[data-ds-gallery]')).toBeVisible()
  const master = page.locator(`[data-ds-master][data-health="healthy"]`, { hasText: 'e2e-clip' }).first()
  await expect(master).toBeVisible({ timeout: 10_000 })
  await expect(master.locator('.ds-master-facts')).toContainText('480×832')
  // The empty state is gone and the shared surface switcher is present with
  // the canvas reachable (QOL wave rrxlw2r — the registry-driven switcher
  // replaced the old one-way "← canvas" chip).
  await expect(page.locator('[data-ds-empty]')).toHaveCount(0)
  await expect(page.locator('[data-surface-switcher] [data-surface="canvas"]')).toBeVisible()
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

test('the surface switcher carries the datasets entry from the canvas (QOL wave rrxlw2r)', async ({ page }) => {
  await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } })
  await page.goto('/')
  // The old launcher chip was RETIRED when the registry-driven titlebar
  // switcher landed (2026-09-18) — one entry point per surface, in the
  // shared chrome every surface carries.
  await expect(page.locator('[data-canvas-chip="datasets"]')).toHaveCount(0)
  await expect(page.locator('[data-surface-switcher] [data-surface="datasets"]')).toBeVisible()
})

// ---------------------------------------------------------------------------
// App-tour UX fix wave (d6iy68r) — the adversarial review's datasets findings:
// the forever-poll terminus, the vanishing error banner, the crop-editor
// scroll deadlock below the 32-grid floor, and Escape on the overlays.

test('an ingested still settles its probe state — the library poll terminates (no forever-fetch)', async ({ page }) => {
  const problems = await trackErrors(page)
  await seedLibrary(page.request)
  await seedStill(page.request)
  // A below-floor still: refused at import — its chip must carry the
  // server's detailed reason (app-tour wave d6iy68r, review M6), and it
  // too must settle its probe state. Content identity is the hash, so a
  // re-run on the shared home DEDUPES into the earlier run's source — the
  // ingest response then carries no refusal field, but the refused row and
  // its reason live on in the library; the DOM assertions below are the
  // truth either way (the accumulation trap testing.md documents).
  const home = join(process.cwd(), 'test-home')
  const tinyDir = mkdtempSync(join(home, 'ds-e2e-'))
  const tinyStill = join(tinyDir, 'e2e-tiny-still.png')
  await exec('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=1:size=200x200:rate=24', '-frames:v', '1', tinyStill])
  await page.request.post('/api/lan/datasets/ingest/reference', { data: { path: tinyStill } })
  await page.goto('/?datasets=1')
  const stillMaster = page.locator('[data-ds-master]', { hasText: 'e2e-still' }).first()
  await expect(stillMaster).toBeVisible({ timeout: 10_000 })
  // The still never counts as probe-pending: no "probing…" flag renders for it.
  await expect(stillMaster.locator('.ds-master-flag', { hasText: /probing/ })).toHaveCount(0)
  // The refusal chip explains itself (the full server reason rides the
  // title — the same honesty the crop editor gives at crop-time).
  const refusedMaster = page.locator('[data-ds-master]', { hasText: 'e2e-tiny-still' }).first()
  await expect(refusedMaster).toBeVisible({ timeout: 10_000 })
  await expect(refusedMaster.locator('.ds-master-flag', { hasText: 'refused at import' })).toHaveAttribute('title', /256²/)
  // The poll terminus, observed on the wire: after the initial load, ZERO
  // further library fetches for >2 poll cycles (1.5 s each). Before the
  // server-side fix the still sat 'pending' forever and this count grew
  // every 1.5 s — two requests per cycle, sustained for the session's life.
  let libraryFetches = 0
  page.on('request', (request) => {
    if (request.url().includes('/api/lan/datasets/library')) libraryFetches += 1
  })
  await page.waitForTimeout(3400)
  expect(libraryFetches).toBe(0)
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('error banners survive the background poll — action failures stay readable', async ({ page }) => {
  const problems = await trackErrors(page)
  // A LONG clip keeps its decode probe pending through the assertion window
  // (the poll runs only while a video probe is pending — the exact condition
  // that used to wipe the banner on every successful refresh).
  const home = join(process.cwd(), 'test-home')
  mkdirSync(home, { recursive: true })
  const dir = mkdtempSync(join(home, 'ds-e2e-'))
  const longClip = join(dir, 'e2e-long.mp4')
  await exec('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=120:size=480x832:rate=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', longClip])
  const ingested = await (await page.request.post('/api/lan/datasets/ingest/reference', { data: { path: longClip } })).json()
  // A layer exists and is selectable; the trigger token is UNSET so the
  // first export attempt must refuse at the gates (the review's repro).
  await page.request.post('/api/lan/datasets/settings', { data: { triggerToken: '', contentClass: 'style' } })
  await page.request.post('/api/lan/datasets/layers', { data: { sourceId: ingested.source.id, name: 'banner-layer' } })
  await page.goto('/?datasets=1')
  const master = page.locator('[data-ds-master]', { hasText: 'e2e-long' }).first()
  await expect(master).toBeVisible({ timeout: 10_000 })
  await master.locator('.ds-master-name').click() // expand to see the layer
  const layer = master.locator('[data-ds-layer]', { hasText: 'banner-layer' }).first()
  await expect(layer).toBeVisible()
  await layer.locator('.ds-layer-select').click()
  await page.locator('.ds-tab', { hasText: 'export' }).click()
  await page.locator('[data-ds-run-export]').click()
  await expect(page.locator('[data-ds-error]')).toContainText(/refuse/i, { timeout: 10_000 })
  // Two-plus poll cycles pass with background refreshes succeeding while
  // the probe is still pending — the banner must SURVIVE them (before the
  // fix it vanished within ~1.5 s, faster than a human could read it).
  await page.waitForTimeout(3400)
  await expect(page.locator('[data-ds-error]')).toBeVisible()
  await expect(page.locator('[data-ds-error]')).toContainText(/refuse/i)
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('the crop editor scroll-resize never strands below the grid floor (the 256×256 deadlock)', async ({ page }) => {
  await seedLibrary(page.request)
  await page.goto('/?datasets=1')
  const master = page.locator('[data-ds-master]', { hasText: 'e2e-clip' }).first()
  await expect(master).toBeVisible({ timeout: 10_000 })
  await master.getByRole('button', { name: /layer/ }).first().click()
  await expect(page.locator('[data-ds-editor]')).toBeVisible()
  const stage = page.locator('[data-ds-stage]')
  const readoutHeight = async () => {
    const text = await page.locator('.ds-crop-readout').innerText()
    return Number(/h (\d+)/.exec(text)?.[1] ?? 0)
  }
  // Shrink deep into the sub-267 px zone where a 6 % multiplicative tick is
  // smaller than one 32 px grid step. The old code re-snapped EVERY tick
  // from the previous snapped value, so 256 (and 192, 160…) were fixed
  // points — the review measured 15+ ticks with zero change.
  for (let index = 0; index < 9; index += 1) {
    await stage.hover()
    await page.mouse.wheel(0, 200)
  }
  const plateau = await readoutHeight()
  for (let index = 0; index < 5; index += 1) {
    await stage.hover()
    await page.mouse.wheel(0, 200)
  }
  const shrunkFurther = await readoutHeight()
  expect(shrunkFurther).toBeLessThan(plateau)
  // Growth un-strands too: scrolling back up must grow it again.
  for (let index = 0; index < 3; index += 1) {
    await stage.hover()
    await page.mouse.wheel(0, -200)
  }
  const grown = await readoutHeight()
  expect(grown).toBeGreaterThan(shrunkFurther)
})

test('the crop editor and caption panel answer Escape (one press, one action)', async ({ page }) => {
  await seedLibrary(page.request)
  await page.goto('/?datasets=1')
  const master = page.locator('[data-ds-master]', { hasText: 'e2e-clip' }).first()
  await expect(master).toBeVisible({ timeout: 10_000 })
  // Crop editor: Escape closes it (Close was the only exit before).
  await master.getByRole('button', { name: /layer/ }).first().click()
  await expect(page.locator('[data-ds-editor]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-ds-editor]')).toHaveCount(0)
  // A saved layer gives the caption phase its subject (the default full-frame
  // stamp, same as the aspect-spectrum test's save).
  await master.getByRole('button', { name: /layer/ }).first().click()
  await expect(page.locator('[data-ds-editor]')).toBeVisible()
  await page.locator('[data-ds-save-layer]').click()
  await expect(page.locator('[data-ds-editor]')).toHaveCount(0)
  // Caption panel: Escape closes the panel — but the inner VLM modal owns
  // the FIRST press while it is open.
  await master.locator('.ds-master-name').click()
  const layer = page.locator('[data-ds-layer]').first()
  await expect(layer).toBeVisible()
  await layer.getByRole('button', { name: 'caption' }).click()
  await expect(page.locator('[data-ds-caption]')).toBeVisible()
  await page.locator('[data-ds-caption] .ds-btn.ghost', { hasText: 'VLM' }).click()
  await expect(page.locator('[data-ds-vlm]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-ds-vlm]')).toHaveCount(0)
  await expect(page.locator('[data-ds-caption]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-ds-caption]')).toHaveCount(0)
})
