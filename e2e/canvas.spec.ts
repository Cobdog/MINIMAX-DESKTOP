import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// Canvas Phase 2 (task flyuh6h) — the ?canvas=1 route against the production
// build, ENGINE-INDEPENDENT by design: submission paths assert the honest
// offline/validation states AND the built GRAPH CONSTRUCTION through the
// ?probe=canvas seams (the flows validate/build before submit — the graph
// plan builds per selection with zero engine). Ingestion lands dropped bytes
// as real blobs, the properties panel edits per-chain settings + the identity
// payload, typed-hole menus open at the endpoints, forks create chains +
// derived edges, and completed jobs land takes on their chains.

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

/** Deterministic boots: close the whole canvas session before loading, and
 *  neutralize stale NON-TERMINAL jobs from earlier runs through the same
 *  storage API the queue persists through — the shared queue is continuous
 *  by design (D1/D2); the suite's scenarios need a calm slate. */
async function resetSession(page: Page) {
  await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } })
  const listed = await page.request.get('/api/lan/jobs')
  if (listed.ok()) {
    const body = await listed.json() as { jobs?: Array<Record<string, unknown>> }
    const stale = (body.jobs ?? []).filter((job) => job.status === 'queued' || job.status === 'running' || job.status === 'pending').map((job) => ({ ...job, status: 'cancelled' }))
    if (stale.length) await page.request.post('/api/lan/jobs', { data: { jobs: stale } })
  }
}

async function currentTransform(page: Page): Promise<string> {
  return page.locator('[data-canvas-world]').evaluate((element) => element.style.transform)
}

/** Drops a REAL (valid) PNG file named `name` onto the canvas — a decodable
 *  image, so blob-served posters actually render. */
async function dropPng(page: Page, name: string) {
  await page.evaluate((fileName) => {
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 36
    const context = canvas.getContext('2d')!
    context.fillStyle = '#2b3a55'
    context.fillRect(0, 0, 64, 36)
    context.fillStyle = '#e8b04b'
    context.fillRect(8, 8, 16, 16)
    const dataUrl = canvas.toDataURL('image/png')
    const binary = atob(dataUrl.split(',')[1])
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    const transfer = new DataTransfer()
    transfer.items.add(new File([bytes], fileName, { type: 'image/png' }))
    document.querySelector('[data-canvas-root]')!.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }))
  }, name)
}

/** The active project's document, straight from the documents API. */
async function activeDocument(page: Page) {
  const session = await page.evaluate(async () => {
    const response = await fetch('/api/lan/documents/session')
    return (await response.json()).session as { activeProject: string | null }
  })
  expect(session.activeProject).toBeTruthy()
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/lan/documents/project?id=${encodeURIComponent(id)}`)
    return (await response.json()) as {
      chains: Array<{ id: string; kind: string; lockState: string; stale: boolean; settings: Record<string, unknown>; inputSpec: Record<string, unknown>; ops: Array<{ id: string; kind: string; ordinal: number; settings: Record<string, unknown>; bakedAt: number | null }>; controlTracks?: Array<{ id: string; kind: string; source: string; inputRef: string }>; outputs: Array<{ id: string; takes: Array<{ id: string; jobId: string | null; artifacts: string[]; latentPath: string | null; supersededBy: string | null; metrics: Record<string, unknown> | null }> }>; identity?: { subjectText: string; strength: number } | null }>
      plans?: Array<{ id: string; document: { segments: Array<{ prompt: string }> } }>
    }
  }, session.activeProject!)
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
  // Phase 2: the engine chip reports the honest state (offline in tests).
  await expect(page.locator('[data-canvas-engine]')).toHaveAttribute('data-engine-connected', 'false')
  // The contextual bar shows the generation surface for nothing-selected.
  await expect(page.locator('[data-canvas-bottombar]')).toHaveAttribute('data-canvas-bar-context', 'empty')
  await expect(page.locator('[data-canvas-bar-engine]')).toContainText('engine offline')
  // Resume cards list the canvases the document store knows (the legacy
  // import seeds at least one on first touch).
  await expect(page.locator('[data-canvas-resume]').first()).toBeVisible()
  await expect(page.locator('[data-canvas-viewport]')).toBeVisible()
  await expect(page.locator('[data-canvas-zoom]')).toBeVisible()
  await page.screenshot({ path: 'test-results/shots/15-canvas-launcher.png' })
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('prompt submit spawns the seed tile; a refused engine parks NOTHING (honest offline state)', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')

  await page.locator('[data-canvas-prompt]').fill('a lone drummer on a night train')
  await page.locator('[data-canvas-submit]').click()

  // The seed tile appears (the object always lands — state lives with its
  // objects), but with the engine offline the REAL submit is refused: no job
  // parks in the queue, the tile stays idle, and the reason surfaces.
  const tile = page.locator('[data-canvas-tile]').first()
  await expect(tile).toBeVisible({ timeout: 10_000 })
  await expect(tile).toHaveAttribute('data-tile-kind', 'seed')
  await expect(tile).toHaveAttribute('data-tile-status', 'idle', { timeout: 5_000 })
  await expect(page.locator('[data-canvas-radar]')).toHaveAttribute('data-queued', '0')
  await expect(page.locator('[data-canvas-toast="error"]').first()).toContainText('ComfyUI')
  // A canvas was created for it (tab + persisted project).
  await expect(page.locator('[data-canvas-tab]').first()).toBeVisible()
  // The properties panel opened on the new chain with the honest validation.
  await expect(page.locator('[data-canvas-properties]')).toBeVisible()
  await expect(page.locator('[data-canvas-validation]')).toContainText('Start ComfyUI')
  // The tile carries the clickable head/tail endpoint affordances.
  await expect(tile.locator('[data-canvas-endpoint="head"]')).toBeVisible()
  await expect(tile.locator('[data-canvas-endpoint="tail"]')).toBeVisible()
  await page.screenshot({ path: 'test-results/shots/16-canvas-seed-tile.png' })
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('queued state + radar aggregation through the real job link (probe scenario)', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1&probe=canvas')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await page.locator('[data-canvas-prompt]').fill('queued-state probe shot')
  await page.locator('[data-canvas-submit]').click()
  const tile = page.locator('[data-canvas-tile]').first()
  await expect(tile).toBeVisible({ timeout: 10_000 })

  // The gated scenario parks a mock queued job through the REAL store link —
  // the exact state a live submission produces once the engine accepts.
  const scenario = await page.evaluate(() => (window as unknown as { __canvasScenario(name: string): { ok: boolean } }).__canvasScenario('seed-mock'))
  expect(scenario.ok).toBe(true)
  await expect(tile).toHaveAttribute('data-tile-status', 'queued-gpu')
  await expect(page.locator('[data-canvas-radar]')).toHaveAttribute('data-queued', '1')
  await expect(page.locator('[data-canvas-radar-text]')).toContainText('1 queued')
  // The contextual bar (chain selected) carries the state chip too.
  await expect(page.locator('[data-canvas-bottombar]')).toHaveAttribute('data-canvas-bar-context', 'chain')
  await expect(page.locator('[data-canvas-bar-mode]')).toContainText('text')
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('dropping media ingests real bytes: blob row, media chain, take, served poster', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')

  await dropPng(page, 'alley-plate.png')
  const tile = page.locator('[data-canvas-tile]').first()
  await expect(tile).toBeVisible({ timeout: 10_000 })
  await expect(tile).toHaveAttribute('data-tile-kind', 'media')
  await expect(tile).toHaveAttribute('data-tile-status', 'idle')
  // The session-local object URL paints instantly (Phase-1 behavior kept).
  await expect(tile.locator('img.canvas-tile-poster').first()).toBeVisible()

  // The durable copy is the content-addressed blob: after a reload the
  // session preview is gone and the poster comes from the documents blob
  // route — the <img> actually loads it.
  await page.reload()
  const reloaded = page.locator('[data-canvas-tile]').first()
  await expect(reloaded).toBeVisible({ timeout: 10_000 })
  const poster = reloaded.locator('img.canvas-tile-poster[data-canvas-poster="blob"]')
  await expect(poster).toBeVisible()
  const src = await poster.getAttribute('src')
  expect(src).toContain('/api/lan/documents/blobs/file?path=canvas-blobs%2F')
  const served = await page.request.get(src!)
  expect(served.ok()).toBeTruthy()

  // The document tells the same story: media chain → output → take whose
  // artifacts are the registered blob path (hash-addressed, invariant 9).
  const document = await activeDocument(page)
  const mediaChain = document.chains.find((chain) => chain.kind === 'media')
  expect(mediaChain).toBeTruthy()
  const take = mediaChain!.outputs[0]?.takes[0]
  expect(take?.artifacts[0]?.startsWith('canvas-blobs/')).toBeTruthy()
  expect(mediaChain!.outputs[0]?.takes.find((entry) => entry.supersededBy === null)).toBeTruthy()
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('submit plans build the correct graph per selection (engine-free, L4)', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1&probe=canvas')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')

  // A real ingested output to select against.
  await dropPng(page, 'plan-source.png')
  await expect(page.locator('[data-canvas-tile]').first()).toBeVisible({ timeout: 10_000 })
  const document = await activeDocument(page)
  const outputId = document.chains.find((chain) => chain.kind === 'media')!.outputs[0]!.id

  const plan = page.evaluate.bind(page)
  const t2v = await plan((spec: unknown) => (window as unknown as { __canvasSubmitPlan(spec: unknown): { mode: string; validation: string | null; graph: { unetModel: string | null; loadImageCount: number; nodeClasses: string[]; loraLoaderCount: number } } }).__canvasSubmitPlan(spec), {})
  expect(t2v.mode).toBe('text')
  expect(t2v.validation).toContain('Start ComfyUI') // the honest offline refusal
  expect(t2v.graph.unetModel).toBe('TEST-fl2va.safetensors')
  expect(t2v.graph.loadImageCount).toBe(0)

  const i2v = await plan((spec: unknown) => (window as unknown as { __canvasSubmitPlan(spec: unknown): { mode: string; graph: { unetModel: string | null; loadImageCount: number } } }).__canvasSubmitPlan(spec), { firstFrameOutputId: outputId })
  expect(i2v.mode).toBe('image')
  expect(i2v.graph.unetModel).toBe('TEST-fl2va.safetensors')
  expect(i2v.graph.loadImageCount).toBe(1)

  const frames = await plan((spec: unknown) => (window as unknown as { __canvasSubmitPlan(spec: unknown): { mode: string; graph: { loadImageCount: number } } }).__canvasSubmitPlan(spec), { firstFrameOutputId: outputId, lastFrameOutputId: outputId })
  expect(frames.mode).toBe('frames')
  expect(frames.graph.loadImageCount).toBe(2)

  const ref2v = await plan((spec: unknown) => (window as unknown as { __canvasSubmitPlan(spec: unknown): { mode: string; graph: { unetModel: string | null; nodeClasses: string[]; loadImageCount: number } } }).__canvasSubmitPlan(spec), { referenceOutputIds: [outputId] })
  expect(ref2v.mode).toBe('reference')
  expect(ref2v.graph.unetModel).toBe('TEST-ref2va.safetensors')
  expect(ref2v.graph.nodeClasses).toContain('MiniMaxH3ReferenceToVideo')
  expect(ref2v.graph.nodeClasses).not.toContain('MiniMaxH3ImageToVideo')
  expect(ref2v.graph.loadImageCount).toBe(1)

  // The fast tier wires the turbo LoRA; the quality tier stays LoRA-free.
  const fast = await plan((spec: unknown) => (window as unknown as { __canvasSubmitPlan(spec: unknown): { graph: { loraLoaderCount: number } } }).__canvasSubmitPlan(spec), { turbo: '8' })
  expect(fast.graph.loraLoaderCount).toBeGreaterThan(0)
  const quality = await plan((spec: unknown) => (window as unknown as { __canvasSubmitPlan(spec: unknown): { graph: { loraLoaderCount: number } } }).__canvasSubmitPlan(spec), { turbo: 'off' })
  expect(quality.graph.loraLoaderCount).toBe(0)
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('the properties panel edits per-chain settings and the identity payload', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await page.locator('[data-canvas-prompt]').fill('properties panel probe shot')
  await page.locator('[data-canvas-submit]').click()
  const tile = page.locator('[data-canvas-tile]').first()
  await expect(tile).toBeVisible({ timeout: 10_000 })

  // The panel opens on selection with the absorption sections.
  const panel = page.locator('[data-canvas-properties]')
  await expect(panel).toBeVisible()
  for (const section of ['prompt', 'engine', 'references', 'identity', 'guides', 'takes']) {
    await expect(panel.locator(`[data-canvas-section="${section}"]`)).toBeVisible()
  }
  // The universal prompt field carries the spawned prompt.
  await expect(panel.locator('[data-canvas-section="prompt"] textarea').first()).toHaveValue('properties panel probe shot')

  // Engine params: the tier chips (fast vs quality) + a duration edit.
  await panel.locator('[data-canvas-tier="8"]').click()
  await panel.locator('[data-canvas-duration]').fill('9')
  // Identity payload: verbatim subject text + the stiffness↔drift dial.
  await panel.locator('[data-canvas-identity-subject]').fill('the drummer, black coat, case in left hand')
  await panel.locator('[data-canvas-identity-strength] input[type="range"]').evaluate((element) => {
    // React-controlled input: the native prototype setter defeats the value
    // tracker so the change actually propagates.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(element, '0.7')
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.waitForTimeout(1_000) // debounced commits land

  const document = await activeDocument(page)
  const chain = document.chains.find((entry) => entry.kind === 'generation')!
  expect(chain.settings.turbo).toBe('8')
  expect(chain.settings.duration).toBe(9)
  expect(chain.identity?.subjectText).toBe('the drummer, black coat, case in left hand')
  expect(Math.abs((chain.identity?.strength ?? 0) - 0.7)).toBeLessThan(0.06)
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('typed-hole menus open at the endpoints and fork creates chain + edge', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await dropPng(page, 'fork-source.png')
  const mediaTile = page.locator('[data-canvas-tile]').first()
  await expect(mediaTile).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(900) // fly-to settle (d3 transition) before clicking

  // TAIL (produce-into): type-directed rows — generation refuses offline with
  // the reason; forking needs no engine.
  await mediaTile.locator('[data-canvas-endpoint="tail"]').click()
  const menu = page.locator('[data-canvas-endpoint-menu="produce"]')
  await expect(menu).toBeVisible()
  await expect(menu.locator('[data-canvas-menu-row="produce:ref2v"]')).toBeEnabled()
  await expect(menu.locator('[data-canvas-menu-row="produce:ref2v"] .canvas-menu-row-hint')).toContainText('17n+5')
  await expect(menu.locator('[data-canvas-menu-row="produce:fork-decoded"]')).toBeEnabled()
  await expect(menu.locator('[data-canvas-menu-row="produce:fork-decoded"] .canvas-menu-row-hint')).toContainText('never altered')

  // Fork decoded through the menu: a new chain + inputRef + derived edge.
  await menu.locator('[data-canvas-menu-row="produce:fork-decoded"]').click()
  await expect(page.locator('[data-canvas-tile]')).toHaveCount(2, { timeout: 10_000 })
  await expect(page.locator('[data-canvas-edge]')).toHaveCount(1)
  const document = await activeDocument(page)
  const fork = document.chains.find((chain) => chain.inputSpec && (chain.inputSpec as Record<string, unknown>).outputRef)
  expect(fork).toBeTruthy()
  expect((fork!.inputSpec as { outputRef: { substrate: string } }).outputRef.substrate).toBe('decoded')
  // L25: the fork landed adjacent to its parent.
  const positions = await page.evaluate(() => Array.from(document.querySelectorAll('[data-canvas-tile]')).map((element) => ({ x: (element as HTMLElement).offsetLeft })))
  expect(Math.max(...positions.map((p) => p.x))).toBeGreaterThan(Math.min(...positions.map((p) => p.x)))

  // HEAD (consume-from) with NO other selection: the menu explains honestly
  // (type filtering leaves nothing to offer without a source).
  await page.locator('[data-canvas-tile]').nth(1).locator('[data-canvas-endpoint="head"]').click()
  const consume = page.locator('[data-canvas-endpoint-menu="consume"]')
  await expect(consume).toBeVisible()
  await expect(consume.locator('footer')).toContainText('Select the object to consume from')
  await expect(consume.locator('[data-canvas-menu-row="consume:first-frame"]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(consume).toHaveCount(0)

  // With a source SELECTED, the consume menu offers the input roles: set the
  // media object as the fork chain's first frame (L4 wiring).
  await page.locator('[data-canvas-tile]').first().click()
  await page.waitForTimeout(300)
  await page.locator('[data-canvas-tile]').nth(1).locator('[data-canvas-endpoint="head"]').click()
  await expect(page.locator('[data-canvas-endpoint-menu="consume"] [data-canvas-menu-row="consume:first-frame"]')).toBeVisible()
  await page.locator('[data-canvas-endpoint-menu="consume"] [data-canvas-menu-row="consume:first-frame"]').click()
  await expect(page.locator('[data-canvas-toast="success"]').first()).toContainText('image → video')
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('the fork gesture from the take strip pins the substrate (B key)', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await dropPng(page, 'gesture-source.png')
  const mediaTile = page.locator('[data-canvas-tile]').first()
  await expect(mediaTile).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(900) // fly-to settle (d3 transition) before clicking
  await mediaTile.click()

  // §7: B opens the fork menu on the selected output tile.
  await page.keyboard.press('b')
  const forkMenu = page.locator('[data-canvas-fork-menu]')
  await expect(forkMenu).toBeVisible()
  await expect(forkMenu.locator('[data-canvas-fork-substrate="decoded"]')).toBeVisible()
  await forkMenu.locator('[data-canvas-fork-substrate="decoded"]').click()
  await expect(page.locator('[data-canvas-tile]')).toHaveCount(2, { timeout: 10_000 })
  await expect(page.locator('[data-canvas-edge]')).toHaveCount(1)
  // The new fork chain is selected and its properties panel is open.
  await expect(page.locator('[data-canvas-properties]')).toBeVisible()
  await expect(page.locator('[data-canvas-bottombar]')).toHaveAttribute('data-canvas-bar-context', 'chain')
  await expect(page.locator('[data-canvas-bar-fork-history]')).toContainText('1 source')
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('a completed job lands a take on its chain (canonical pointed, blob registered)', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1&probe=canvas')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')

  // Real ingested media provides the completion's stored source; the seed
  // chain carries the linked job.
  await dropPng(page, 'landing-source.png')
  await expect(page.locator('[data-canvas-tile]').first()).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Escape') // deselect → the bar returns to the generation surface
  await page.locator('[data-canvas-bar-prompt]').fill('completion landing probe')
  await page.locator('[data-canvas-bar-prompt]').press('Enter')
  const tiles = page.locator('[data-canvas-tile]')
  await expect(tiles).toHaveCount(2, { timeout: 10_000 })
  const seedTile = page.locator('[data-canvas-tile][data-tile-kind="seed"]')
  await expect(seedTile).toBeVisible()

  // Park the queued link, then complete the job using the REAL stored source —
  // the exact store transition the queue's completion path makes.
  expect((await page.evaluate(() => (window as unknown as { __canvasScenario(name: string): { ok: boolean } }).__canvasScenario('seed-mock'))).ok).toBe(true)
  const completed = await page.evaluate(() => (window as unknown as { __canvasScenario(name: string): { ok: boolean; jobId: string } }).__canvasScenario('complete-mock'))
  expect(completed.ok).toBe(true)

  // The take lands: the seed chain upgrades to a media tile (canonical take
  // present), the toast confirms, and the document records the landing.
  // (Pin by position, not by kind — the kind attribute is what changes.)
  await expect(page.locator('[data-canvas-tile]').nth(1)).toHaveAttribute('data-tile-kind', 'media', { timeout: 10_000 })
  await expect(page.locator('[data-canvas-toast="success"]').first()).toBeVisible()
  const document = await activeDocument(page)
  const generationChain = document.chains.find((chain) => chain.kind === 'generation')!
  const takes = generationChain.outputs[0]?.takes ?? []
  expect(takes.length).toBe(1)
  expect(takes[0]?.jobId).toBeTruthy()
  expect(takes[0]?.supersededBy).toBeNull()
  expect(takes[0]?.artifacts[0]?.startsWith('canvas-blobs/')).toBeTruthy()
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('multi-select batch gestures: lock all + honest generate-all refusal (§4)', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await dropPng(page, 'multi-a.png')
  await expect(page.locator('[data-canvas-tile]').first()).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Escape') // deselect → the bar returns to the generation surface
  await page.locator('[data-canvas-bar-prompt]').fill('multi select second object')
  await page.locator('[data-canvas-bar-prompt]').press('Enter')
  const tiles = page.locator('[data-canvas-tile]')
  await expect(tiles).toHaveCount(2, { timeout: 10_000 })
  await page.waitForTimeout(900) // fly-to settle (d3 transition) before clicking

  // Shift-click adds to the selection: the bar flips to the multi context
  // with the REAL batch gestures (Phase 3).
  await tiles.first().click({ modifiers: ['Shift'] })
  await expect(page.locator('[data-canvas-bottombar]')).toHaveAttribute('data-canvas-bar-context', 'multi')
  await expect(page.locator('[data-canvas-bar-generate-all]')).toBeVisible()
  await expect(page.locator('[data-canvas-bar-lock-all]')).toBeVisible()

  // Multi-lock: both chains record lockState 'locked' in the document (the
  // consent gate — propagation-stable, takes always resident).
  await page.locator('[data-canvas-bar-lock-all]').click()
  await expect(page.locator('[data-canvas-bar-lock-all]')).toContainText('unlock all', { timeout: 10_000 })
  const locked = await activeDocument(page)
  expect(locked.chains.every((chain) => chain.lockState === 'locked')).toBe(true)
  // And back (the gesture toggles).
  await page.locator('[data-canvas-bar-lock-all]').click()
  const unlocked = await activeDocument(page)
  expect(unlocked.chains.every((chain) => chain.lockState === 'unlocked')).toBe(true)

  // Multi-generate offline: the engine refuses both honestly — nothing parks
  // in the queue, the bar says so, the objects stay idle.
  await page.locator('[data-canvas-bar-generate-all]').click()
  await expect(page.locator('[data-canvas-toast="error"]').first()).toContainText('ComfyUI')
  await expect(page.locator('[data-canvas-radar]')).toHaveAttribute('data-queued', '0')
  await page.screenshot({ path: 'test-results/shots/19-canvas-multi-batch.png' })
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
  // Link a job first (the real submit is refused offline), then fail it.
  expect((await page.evaluate(() => (window as unknown as { __canvasScenario(name: string): { ok: boolean } }).__canvasScenario('seed-mock'))).ok).toBe(true)
  await expect(tile).toHaveAttribute('data-tile-status', 'queued-gpu')
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
  await expect(page.locator('[data-canvas-properties]')).toBeVisible()

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

// ---- Canvas Phase 3 (task j5sj28v) ----------------------------------------------

test('op modal: add/edit/reorder/undo/bake with a LIVE tile preview (§5.1, L3+L8)', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await dropPng(page, 'op-stack-plate.png')
  const tile = page.locator('[data-canvas-tile]').first()
  await expect(tile).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(600)

  // §7: Enter on a media selection opens the op modal (the ONLY editor — L8).
  await tile.click()
  await page.keyboard.press('Enter')
  const modal = page.locator('.canvas-opmodal')
  await expect(modal).toBeVisible()
  await expect(modal.locator('[data-canvas-op-stage]')).toBeVisible()
  await expect(modal.locator('[data-canvas-op-stack]')).toContainText('An empty stack')

  // Add a crop (ImageCrop data — the first op, per §5.1)…
  await modal.locator('[data-canvas-op-add]').click()
  await modal.locator('[data-canvas-op-add="crop"]').click()
  await expect(modal.locator('[data-canvas-op-stack] .canvas-op-row')).toHaveCount(1, { timeout: 10_000 })
  let document = await activeDocument(page)
  expect(document.chains[0]!.ops.map((op) => op.kind)).toEqual(['crop'])
  expect(document.chains[0]!.ops[0]!.settings).toMatchObject({ x: 0.5, y: 0.5, zoom: 1, fit: 'crop' })

  // …an adjust (ctx.filter proxy) — the slider edit lands (debounced) and the
  // TILE preview live-updates (L3 decided: live-update).
  await modal.locator('[data-canvas-op-add]').click()
  await modal.locator('[data-canvas-op-add="adjust"]').click()
  await expect(modal.locator('[data-canvas-op-stack] .canvas-op-row')).toHaveCount(2, { timeout: 10_000 })
  await modal.locator('[data-canvas-op-field="brightness"]').evaluate((element) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(element, '0.6') // the offset slider: 0 = neutral, +0.6 → brightness 1.6
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await page.waitForTimeout(1_100) // edit debounce + document reload
  document = await activeDocument(page)
  const adjust = document.chains[0]!.ops.find((op) => op.kind === 'adjust')!
  expect(adjust.settings.brightness).toBeGreaterThan(1.4)
  const tileFilter = await tile.locator('img.canvas-tile-poster').first().evaluate((element) => element.style.filter)
  expect(tileFilter).toContain('brightness')

  // Reorder: rotate joins third, moves up past the adjust (drag-to-reorder's
  // atomic step — the buttons are the accessible form).
  await modal.locator('[data-canvas-op-add]').click()
  await modal.locator('[data-canvas-op-add="rotate"]').click()
  await expect(modal.locator('[data-canvas-op-stack] .canvas-op-row')).toHaveCount(3, { timeout: 10_000 })
  await modal.locator('.canvas-op-row[data-op-kind="rotate"] [data-canvas-op-up]').click()
  await page.waitForTimeout(600)
  document = await activeDocument(page)
  expect(document.chains[0]!.ops.map((op) => op.kind)).toEqual(['crop', 'rotate', 'adjust'])

  // Per-op undo (⌘Z undoes the LAST unbaked op in stack order — here the
  // adjust, which the reorder moved last).
  await page.keyboard.press('ControlOrMeta+z')
  await expect(modal.locator('[data-canvas-op-stack] .canvas-op-row')).toHaveCount(2, { timeout: 10_000 })
  document = await activeDocument(page)
  expect(document.chains[0]!.ops.map((op) => op.kind)).toEqual(['crop', 'rotate'])

  // Bake: explicit, two-step, irreversible — the op row freezes afterwards.
  await modal.locator('.canvas-op-row[data-op-kind="crop"] [data-canvas-op-bake]').click()
  await expect(modal.locator('.canvas-op-row[data-op-kind="crop"] [data-canvas-op-bake]')).toContainText('irreversible?')
  await modal.locator('.canvas-op-row[data-op-kind="crop"] [data-canvas-op-bake]').click()
  await expect(modal.locator('.canvas-op-row[data-op-kind="crop"] .canvas-op-baked')).toBeVisible({ timeout: 10_000 })
  await expect(modal.locator('.canvas-op-row[data-op-kind="crop"] [data-canvas-op-undo]')).toHaveCount(0)
  document = await activeDocument(page)
  expect(document.chains[0]!.ops.find((op) => op.kind === 'crop')!.bakedAt).not.toBeNull()

  await page.keyboard.press('Escape')
  await expect(modal).toHaveCount(0)
  await page.screenshot({ path: 'test-results/shots/20-canvas-op-modal.png' })
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('fork semantics complete: early take → canonical switch → stale propagation → rerun gesture', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await dropPng(page, 'fork-semantics.png')
  const source = page.locator('[data-canvas-tile]').first()
  await expect(source).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(600)

  // Fork decoded (B gesture) — the fork chain consumes the source output.
  await source.click()
  await page.keyboard.press('b')
  await page.locator('[data-canvas-fork-substrate="decoded"]').click()
  await expect(page.locator('[data-canvas-tile]')).toHaveCount(2, { timeout: 10_000 })
  await expect(page.locator('[data-canvas-edge]')).toHaveCount(1)

  // A second take lands on the SOURCE through the real append path (the
  // append-only take model): the new one is canonical, the first is a prior.
  let document = await activeDocument(page)
  const sourceChain = document.chains.find((chain) => chain.kind === 'media')!
  const sourceOutput = sourceChain.outputs[0]!
  const blobArtifact = sourceOutput.takes[0]!.artifacts[0]!
  await page.request.post('/api/lan/documents/takes', { data: { outputId: sourceOutput.id, artifacts: [blobArtifact], metrics: { kind: 'image', sourcePath: '', name: 'second-take.png' } } })
  await page.reload()
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  const tiles = page.locator('[data-canvas-tile]')
  await expect(tiles).toHaveCount(2, { timeout: 10_000 })
  document = await activeDocument(page)
  const takes = document.chains.find((chain) => chain.kind === 'media')!.outputs[0]!.takes
  expect(takes.length).toBe(2)
  expect(takes.filter((take) => take.supersededBy === null).length).toBe(1)
  // takes list newest-first: [0] = the appended second take (canonical),
  // [1] = the original take (the prior the strip will offer).
  const firstTakeId = takes[1]!.id

  // Zoom into the near band so the take strip renders, then switch the
  // canonical pointer BACK to the first take (click the prior chip).
  await source.click()
  const viewport = page.locator('[data-canvas-viewport]')
  const box = await viewport.boundingBox()
  await page.mouse.move(box!.x + 700, box!.y + 400)
  for (let index = 0; index < 4; index += 1) await page.mouse.wheel(0, -140)
  await page.waitForTimeout(400)
  const prior = page.locator('[data-canvas-take-switch]').first()
  await expect(prior).toBeVisible({ timeout: 10_000 })
  await prior.click()
  await page.waitForTimeout(800)

  // The pointer switched to the ORIGINAL take (F5/takes: nothing deleted) AND
  // the fork chain went stale — an upstream change marks downstream
  // (invariant 3, visible ring).
  document = await activeDocument(page)
  const mediaChain = document.chains.find((chain) => chain.kind === 'media')!
  const canonical = mediaChain.outputs[0]!.takes.find((take) => take.supersededBy === null)!
  expect(canonical.id).toBe(firstTakeId)
  expect(mediaChain.outputs[0]!.takes.filter((take) => take.supersededBy !== null).length).toBe(1)
  const forkChain = document.chains.find((chain) => chain.kind === 'generation')!
  expect(forkChain.stale).toBe(true)

  // The rerun gesture is one chip on the fork's context; offline the submit
  // refuses — the chain stays HONESTLY stale until a submit goes out. (Close
  // the floating panel first — it can overlap the fork tile's position.)
  const forkTile = page.locator(`[data-canvas-tile="${forkChain.id}"]`)
  await page.locator('[data-canvas-properties] button[aria-label="Close properties"]').click()
  await forkTile.click()
  await expect(page.locator('[data-canvas-bottombar]')).toHaveAttribute('data-canvas-bar-context', 'chain')
  const rerun = page.locator('[data-canvas-bar-rerun]')
  await expect(rerun).toBeVisible()
  await expect(forkTile).toHaveAttribute('data-tile-status', 'stale')
  await rerun.click()
  await expect(page.locator('[data-canvas-toast="error"]').first()).toContainText('ComfyUI')
  const afterRefusal = await activeDocument(page)
  expect(afterRefusal.chains.find((chain) => chain.id === forkChain.id)!.stale).toBe(true)

  // Locks gate propagation (L21): clear the stale flag through the same API
  // a successful rerun would, lock the fork, switch the canonical pointer
  // again — the locked chain stays PRISTINE.
  await page.request.post('/api/lan/documents/chains/update', { data: { id: forkChain.id, stale: false } })
  await page.locator('[data-canvas-bar-lock]').click()
  await page.waitForTimeout(700)
  await source.click()
  await page.waitForTimeout(300)
  await page.locator('[data-canvas-take-switch]').first().click()
  await page.waitForTimeout(800)
  const afterLock = await activeDocument(page)
  expect(afterLock.chains.find((chain) => chain.id === forkChain.id)!.stale).toBe(false)
  expect(afterLock.chains.find((chain) => chain.id === forkChain.id)!.lockState).toBe('locked')
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('engines-as-ops: the utility typed-hole seam builds the official template (probe), menu gates honestly', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1&probe=canvas')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await dropPng(page, 'utility-source.png')
  await expect(page.locator('[data-canvas-tile]').first()).toBeVisible({ timeout: 10_000 })

  // The probe is the typed-hole → graph-construction seam: validation refuses
  // offline with the honest message, yet the REAL factory builds the official
  // template against a resolved TEST selection (construction is pure).
  const plan = page.evaluate.bind(page)
  const removeSubtitles = await plan((tool: string) => (window as unknown as { __canvasUtilityPlan(tool: string): { validation: string | null; graph: { nodeClasses: string[]; loadVideoCount: number; manualSigmasCount: number; saveVideo: boolean; audioSourceClass: Array<string | null>; total: number } } }).__canvasUtilityPlan(tool), 'remove-subtitles')
  expect(removeSubtitles.validation).toContain('Start ComfyUI')
  expect(removeSubtitles.graph.loadVideoCount).toBe(1)
  expect(removeSubtitles.graph.manualSigmasCount).toBe(2) // the two-stage ManualSigmas shape
  expect(removeSubtitles.graph.saveVideo).toBe(true)
  expect(removeSubtitles.graph.audioSourceClass[0]).toBe('GetVideoComponents') // original audio passes through
  expect(removeSubtitles.graph.nodeClasses).toContain('LTXAddVideoICLoRAGuide')

  const ia2v = await plan((tool: string) => (window as unknown as { __canvasUtilityPlan(tool: string): { graph: { audioSourceClass: Array<string | null>; loadVideoCount: number } | null } }).__canvasUtilityPlan(tool), 'ia2v')
  expect(ia2v.graph!.audioSourceClass[0]).toBe('LTXVAudioVAEDecode') // ia2v muxes GENERATED audio
  expect(ia2v.graph!.loadVideoCount).toBe(0)

  // The menu rows stay availability-gated: offline every utility is offered
  // but disabled with the honest reason — ia2v (no node packs) leads with the
  // missing-weights install guidance; a pack-gated tool leads with the engine.
  const tile = page.locator('[data-canvas-tile]').first()
  await page.waitForTimeout(600)
  await tile.locator('[data-canvas-endpoint="tail"]').click()
  const menu = page.locator('[data-canvas-endpoint-menu="produce"]')
  await expect(menu).toBeVisible()
  const ia2vRow = menu.locator('[data-canvas-menu-row="produce:utility:ia2v"]')
  await expect(ia2vRow).toBeVisible()
  await expect(ia2vRow).toBeDisabled()
  await expect(ia2vRow).toContainText('Not ready — missing')
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('Z-Image as an op: image intent spawns a still chain; control via a selected image (probe)', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1&probe=canvas')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')

  // Nothing-selected + image intent (§5.4): the launcher's image chip + Enter.
  await page.locator('[data-canvas-chip="image"]').click()
  await page.locator('[data-canvas-prompt]').fill('a lighthouse over a black sea, still')
  await page.locator('[data-canvas-submit]').click()
  const tile = page.locator('[data-canvas-tile]').first()
  await expect(tile).toBeVisible({ timeout: 10_000 })
  // Offline the Z-Image surface refuses honestly — the object still lands.
  await expect(page.locator('[data-canvas-toast="error"]').first()).toContainText('ComfyUI')
  await expect(page.locator('[data-canvas-radar]')).toHaveAttribute('data-queued', '0')
  let document = await activeDocument(page)
  expect(document.chains[0]!.settings.mediaType).toBe('image')

  // A real ingested image to select against (the control surface).
  await page.keyboard.press('Escape')
  await dropPng(page, 'zimage-control.png')
  await expect(page.locator('[data-canvas-tile]')).toHaveCount(2, { timeout: 10_000 })
  document = await activeDocument(page)
  const controlOutput = document.chains.find((chain) => chain.kind === 'media')!.outputs[0]!.id

  const plan = page.evaluate.bind(page)
  const plain = await plan((spec: unknown) => (window as unknown as { __canvasSubmitPlan(spec: unknown): { mode: string; validation: string | null; graph: { saveNode: boolean; loadImageCount: number; controlnet: boolean; unetModel: string | null } } }).__canvasSubmitPlan(spec), { mediaType: 'image' })
  expect(plain.mode).toBe('z-image')
  expect(plain.validation).toContain('Start ComfyUI')
  expect(plain.graph.saveNode).toBe(true) // SaveImage — the still surface
  expect(plain.graph.loadImageCount).toBe(0)
  expect(plain.graph.controlnet).toBe(false)

  const control = await plan((spec: unknown) => (window as unknown as { __canvasSubmitPlan(spec: unknown): { mode: string; graph: { loadImageCount: number; controlnet: boolean; unetModel: string | null } } }).__canvasSubmitPlan(spec), { mediaType: 'image', firstFrameOutputId: controlOutput })
  expect(control.mode).toBe('z-image-control')
  expect(control.graph.loadImageCount).toBe(1) // the control image loader
  expect(control.graph.controlnet).toBe(true) // the Fun ControlNet Union node
  expect(control.graph.unetModel).toBe('TEST-z_image_turbo.safetensors')

  // Video intent is untouched: the same probe without mediaType stays H3.
  const video = await plan((spec: unknown) => (window as unknown as { __canvasSubmitPlan(spec: unknown): { mode: string; graph: { saveNode?: boolean } } }).__canvasSubmitPlan(spec), {})
  expect(video.mode).toBe('text')
  expect((video.graph as { saveNode?: boolean }).saveNode).toBeUndefined()
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('the pose rig docks as a canvas panel and exports a control track (§5.2)', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await dropPng(page, 'pose-target.png')
  const tile = page.locator('[data-canvas-tile]').first()
  await expect(tile).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(600)

  // The typed-hole consume menu carries the control-inputs group.
  await tile.locator('[data-canvas-endpoint="head"]').click()
  const menu = page.locator('[data-canvas-endpoint-menu="consume"]')
  await expect(menu).toBeVisible()
  await expect(menu.locator('[data-canvas-menu-group="control"]')).toBeVisible()
  await menu.locator('[data-canvas-menu-row="consume:pose-rig"]').click()

  // The dock: a floating react-rnd panel mounting the SAME rig chunk.
  const dock = page.locator('[data-canvas-poserig]')
  await expect(dock).toBeVisible({ timeout: 15_000 })
  await expect(dock.locator('[data-poserig="app"]')).toBeVisible({ timeout: 15_000 })
  await expect(dock.locator('[data-poserig-preview]')).toBeVisible()

  // Export-to-control-track: the rendered frames land as a blob + a
  // canvas_control_track row on the target chain (§2.1).
  await dock.locator('[data-poserig-export-track]').click()
  await expect(page.locator('[data-canvas-toast="success"]').first()).toBeVisible({ timeout: 20_000 })
  const document = await activeDocument(page)
  const target = document.chains.find((chain) => chain.kind === 'media')!
  expect(target.controlTracks?.length).toBe(1)
  expect(target.controlTracks![0]!.kind).toBe('pose')
  expect(target.controlTracks![0]!.source).toBe('poserig')

  await dock.locator('[data-canvas-poserig-close]').click()
  await expect(dock).toHaveCount(0)
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

// Phase 5 (task 7mcp11b): the deletion wave — the Phase-3 retirement flips to
// DELETION. The trio (Clip editor, Video reference clipper, Frame bookmarks)
// greys out in Phase 3 with "still directly navigable until Phase 5"; Phase 5
// deletes them: no nav (the shell itself is gone), no markers, no surfaces.
// The capabilities live on canvas: the op modal's trim + the fork/substrate
// machinery (asserted by their own specs above).
test('Phase-5 deletion smoke: the Phase-3 retired trio is gone; op/fork surfaces carry it (§8)', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')

  // The old shell is dead — nothing greyed because nothing remains.
  await expect(page.locator('.nav-button')).toHaveCount(0)
  await expect(page.locator('[data-retired]')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Movie editor' })).toHaveCount(0)
  await expect(page.locator('[data-retired="clip-editor"]')).toHaveCount(0)

  // The absorbed capability: a media object opens the OP MODAL (trim/crop/
  // mask live there — the clipper's trim + the bookmark studio's frames are
  // op-kind + substrate choices on the object).
  await dropPng(page, 'phase5-trio.png')
  await expect(page.locator('[data-canvas-tile]')).toHaveCount(1, { timeout: 10_000 })
  await page.locator('[data-canvas-tile]').first().click()
  await page.keyboard.press('Enter')
  await expect(page.locator('.canvas-opmodal')).toBeVisible()
  await page.locator('[data-canvas-op-add]').click()
  await expect(page.locator('[data-canvas-op-add="crop"]')).toBeVisible() // image media — the per-kind gating holds
  await expect(page.locator('[data-canvas-op-add="trim"]')).toHaveCount(0) // trim is video-only (honest)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.screenshot({ path: 'test-results/shots/21-phase5-trio-deleted.png' })
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

// ---------------------------------------------------------------------------
// Canvas Phase 4 (task 6rymbx3) — latent-fork rendering seam, the engine
// retirement wave's canvas replacements, libraries/Settings docking.
// ---------------------------------------------------------------------------

test('latent-fork rendering: the Motion-Context graph pins the source clip (probe + real landing)', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1&probe=canvas')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')

  // The offline seam: graph CONSTRUCTION is pure. A latentFrom spec builds
  // the exact continuation graph — Load pins the SOURCE clip (not index-1 of
  // the fork's own folder), Context wraps the conditioning, Save writes the
  // fork's own folder, Trim drops the overlap rows.
  const plan = page.evaluate.bind(page)
  const latent = await plan((spec: unknown) => (window as unknown as { __canvasSubmitPlan(spec: unknown): { graph: { motionContext: { loadLatent: Record<string, unknown> | null; context: boolean; saveLatent: Record<string, unknown> | null; trim: boolean } } } }).__canvasSubmitPlan(spec), { latentFrom: { folder: 'h3_context/src-chain/clip', clipIndex: 2 } })
  expect(latent.graph.motionContext.loadLatent).toEqual({ latent_path: 'h3_context/src-chain', clip_index: 3 })
  expect(latent.graph.motionContext.context).toBe(true)
  expect(latent.graph.motionContext.trim).toBe(true)
  expect((latent.graph.motionContext.saveLatent as Record<string, unknown>)?.filename_prefix).toBe('h3_context/plan/clip')
  // Offline (no Motion-Context nodes reported): a plain plan carries NO
  // Motion-Context nodes — honest availability, never a doomed graph.
  const plain = await plan((spec: unknown) => (window as unknown as { __canvasSubmitPlan(spec: unknown): { graph: { motionContext: { loadLatent: unknown; saveLatent: unknown } } } }).__canvasSubmitPlan(spec), {})
  expect(plain.graph.motionContext.loadLatent).toBeNull()
  expect(plain.graph.motionContext.saveLatent).toBeNull()

  // The REAL landing path records the saved-clip facts: a media object
  // provides the stored source, a seed chain carries the linked job, and the
  // complete-mock-latent scenario drives the exact store transition a
  // Motion-Context completion makes — the take lands with latentPath +
  // metrics.motionContext.
  await dropPng(page, 'latent-source.png')
  await expect(page.locator('[data-canvas-tile]')).toHaveCount(1, { timeout: 10_000 })
  await page.keyboard.press('Escape')
  // The canvas is no longer empty — the contextual bar IS the generation
  // surface (nothing selected): submit the seed chain there.
  await page.locator('[data-canvas-bar-prompt]').fill('the source chain whose latent we fork')
  await page.locator('[data-canvas-bar-prompt]').press('Enter')
  await expect(page.locator('[data-canvas-tile]')).toHaveCount(2, { timeout: 10_000 })
  const seeded = await page.evaluate(() => (window as unknown as { __canvasScenario(name: string): { ok: boolean; chainId?: string } }).__canvasScenario('seed-mock'))
  expect(seeded.ok).toBe(true)
  // B1 (latent durability): the engine-side latent file EXISTS under the
  // output directory when the render completes — the landing path resolves
  // the engine-relative path against it and registers the substrate into
  // the content-addressed blob tree (hashed, evictable, exported).
  const latentFile = path.join(os.homedir(), 'Documents', 'ComfyUI', 'output', 'h3_context', seeded.chainId!, 'clip_00001.safetensors')
  fs.mkdirSync(path.dirname(latentFile), { recursive: true })
  fs.writeFileSync(latentFile, `e2e-latent-substrate-${seeded.chainId}`)
  const landed = await page.evaluate(() => (window as unknown as { __canvasScenario(name: string): { ok: boolean; chainId?: string } }).__canvasScenario('complete-mock-latent'))
  expect(landed.ok).toBe(true)
  await page.waitForTimeout(600)
  let document = await activeDocument(page)
  const seedChain = document.chains.find((chain) => chain.id === landed.chainId)!
  const landedTake = seedChain.outputs[0]!.takes[0]!
  expect(landedTake.latentPath).toMatch(/^canvas-blobs\//)
  expect((landedTake.metrics?.motionContext as Record<string, unknown>)?.folder).toContain(`h3_context/${landed.chainId}/clip`)

  // The fork menu on that object now offers the latents substrate (the take
  // carries one)…
  await page.keyboard.press('Escape')
  await page.locator(`[data-canvas-tile="${landed.chainId}"]`).click()
  await page.keyboard.press('b')
  const forkMenu = page.locator('[data-canvas-fork-menu]')
  await expect(forkMenu).toBeVisible()
  await forkMenu.locator('[data-canvas-fork-substrate="latents"]').click()
  await expect(page.locator('[data-canvas-toast="success"]').first()).toBeVisible({ timeout: 8_000 })

  // …and the fork chain's submit refuses honestly offline (the nodes are not
  // installed in the test engine) — the honest validation surfaces in the
  // fork's own properties panel, never a doomed job.
  document = await activeDocument(page)
  const forkChain = document.chains.find((chain) => (chain.inputSpec.outputRef as Record<string, unknown> | undefined)?.substrate === 'latents')!
  expect(forkChain).toBeTruthy()
  await expect(page.locator('[data-canvas-validation]')).toContainText('Motion-Context', { timeout: 10_000 })
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('external-engine completions land visibly (B2): honest fetch attempt, errored take, descriptor preserved', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1&probe=canvas')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await dropPng(page, 'remote-source.png')
  await expect(page.locator('[data-canvas-tile]')).toHaveCount(1, { timeout: 10_000 })
  await page.keyboard.press('Escape')
  await page.locator('[data-canvas-bar-prompt]').fill('a render whose engine output never resolves locally')
  await page.locator('[data-canvas-bar-prompt]').press('Enter')
  await expect(page.locator('[data-canvas-tile]')).toHaveCount(2, { timeout: 10_000 })
  await page.evaluate(() => (window as unknown as { __canvasScenario(name: string): unknown }).__canvasScenario('seed-mock'))
  // Complete the job the way an external-engine render does: outputUrl only,
  // no localOutputPath. The landing attempts the server-side fetch (fails —
  // no engine), retries are bounded, and the failure parks VISIBLY.
  const remote = await page.evaluate(() => (window as unknown as { __canvasScenario(name: string): { ok: boolean; reason?: string; landedError?: string | null; descriptorPreserved?: string | null; artifacts?: number; tileStatus?: string | null } }).__canvasScenario('complete-mock-remote'))
  expect(remote.ok).toBe(true)
  expect(remote.landedError).toContain('could not be fetched')
  expect(remote.descriptorPreserved).toBe('Canvas_Remote_Mock.mp4')
  expect(remote.artifacts).toBe(0)
  expect(remote.tileStatus).toBe('failed')
  // Durable on the object (server truth) — dismissable like any failure.
  const document = await activeDocument(page)
  const erroredTake = document.chains.flatMap((chain) => chain.outputs.flatMap((output) => output.takes)).find((take) => typeof (take.metrics as Record<string, unknown> | null)?.landingError === 'string')
  expect(erroredTake).toBeTruthy()
  expect((erroredTake!.metrics as Record<string, unknown>).landingError).toContain('could not be fetched')
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('audio jobs relink after a mid-render reload through the canvas manifest (M1)', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1&probe=canvas')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await dropPng(page, 'audio-source.png')
  await expect(page.locator('[data-canvas-tile]')).toHaveCount(1, { timeout: 10_000 })
  const seeded = await page.evaluate(() => (window as unknown as { __canvasScenario(name: string): { ok: boolean; reason?: string; chainId?: string; jobId?: string } }).__canvasScenario('seed-audio-mock'))
  expect(seeded.ok).toBe(true)
  // Persist the queued mock job before the reload (the debounced flush rides
  // pagehide, but pin it deterministically for the test).
  await page.waitForTimeout(1_400)
  // RELOAD mid-render: the audio job is queued. The relink after reload
  // reads manifest.canvas.chainId — which the fixed audio submit cores
  // attach from job creation. Pre-fix there was no manifest at all.
  await page.reload()
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  const ring = page.locator(`[data-canvas-tile="${seeded.chainId}"] .canvas-tile-ring`)
  await expect(ring).toHaveAttribute('data-status', 'queued-gpu', { timeout: 10_000 })
  // Complete it (local media source) — the take lands on the AUDIO chain.
  const completed = await page.evaluate(() => (window as unknown as { __canvasScenario(name: string): { ok: boolean; reason?: string; jobId?: string; source?: string } }).__canvasScenario('complete-mock'))
  expect(completed.ok).toBe(true)
  await page.waitForTimeout(700)
  const document = await activeDocument(page)
  const audioChain = document.chains.find((chain) => chain.id === seeded.chainId)
  expect(audioChain).toBeTruthy()
  const audioTake = audioChain!.outputs[0]?.takes.find((take) => take.supersededBy === null)
  expect(audioTake).toBeTruthy()
  expect((audioTake!.metrics as Record<string, unknown>).kind).toBe('audio')
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test("the 'r' rerunStale gesture clears the stale flags it remediates (M2)", async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1&probe=canvas')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await dropPng(page, 'stale-source.png')
  await expect(page.locator('[data-canvas-tile]')).toHaveCount(1, { timeout: 10_000 })
  const result = await page.evaluate(() => (window as unknown as { __canvasScenario(name: string): { ok: boolean; reason?: string; chainId?: string; staleCleared?: boolean | null } }).__canvasScenario('rerun-stale-clears'))
  expect(result.ok).toBe(true)
  expect(result.staleCleared).toBe(true)
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('engines-as-ops complete: LTX-2.5 general row + the audio docks (probe seams + honest gating)', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1&probe=canvas')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await dropPng(page, 'engine-source.png')
  const tile = page.locator('[data-canvas-tile]').first()
  await expect(tile).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(600)

  // The LTX-2.5 GENERAL surface is a typed-hole produce row (image source),
  // availability-gated offline with the honest reason.
  await tile.locator('[data-canvas-endpoint="tail"]').click()
  const menu = page.locator('[data-canvas-endpoint-menu="produce"]')
  await expect(menu).toBeVisible()
  const ltxRow = menu.locator('[data-canvas-menu-row="produce:ltx25"]')
  await expect(ltxRow).toBeVisible()
  await expect(ltxRow).toBeDisabled()
  await expect(ltxRow).toContainText('Not ready')

  // The engine-op plan seams: ltx25 + both audio engines build their graphs
  // offline (construction is pure) while validation refuses honestly.
  const plan = page.evaluate.bind(page)
  const ltx = await plan((spec: unknown) => (window as unknown as { __canvasSubmitPlan(spec: unknown): { mode: string; validation: string | null; graph: { manualSigmasCount: number; saveVideo: boolean } } }).__canvasSubmitPlan(spec), { engine: 'ltx25' })
  expect(ltx.mode).toBe('ltx25')
  expect(ltx.validation).toContain('Start ComfyUI')
  expect(ltx.graph.manualSigmasCount).toBeGreaterThan(0)
  expect(ltx.graph.saveVideo).toBe(true)

  const music3 = await plan((spec: unknown) => (window as unknown as { __canvasSubmitPlan(spec: unknown): { mode: string; validation: string | null; graph: { textEncode: boolean; saveAudio: boolean } } }).__canvasSubmitPlan(spec), { mediaType: 'audio', audioEngine: 'music3' })
  expect(music3.mode).toBe('music3')
  expect(music3.graph.textEncode).toBe(true)
  expect(music3.graph.saveAudio).toBe(true)
  const ace = await plan((spec: unknown) => (window as unknown as { __canvasSubmitPlan(spec: unknown): { mode: string; graph: { textEncode: boolean; saveAudio: boolean } } }).__canvasSubmitPlan(spec), { mediaType: 'audio', audioEngine: 'acestep' })
  expect(ace.mode).toBe('acestep')
  expect(ace.graph.textEncode).toBe(true)
  expect(ace.graph.saveAudio).toBe(true)

  // The audio dock: the bottom bar's nothing-selected context opens Music 3;
  // offline the submit button carries the honest refusal.
  await page.keyboard.press('Escape')
  await page.locator('[data-canvas-bar-music3]').click()
  const dock = page.locator('[data-canvas-audio-dock]')
  await expect(dock).toBeVisible()
  await expect(dock).toHaveAttribute('data-canvas-audio-engine', 'music3')
  await dock.locator('[data-canvas-audio-caption]').fill('warm ambient piano with tape hiss')
  await expect(dock.locator('[data-canvas-audio-validation]')).toContainText('Start ComfyUI')
  await expect(dock.locator('[data-canvas-audio-submit]')).toBeDisabled()
  await dock.locator('[data-canvas-audio-close]').click()
  await expect(dock).toHaveCount(0)
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('the library projection (V): outputs across the session, filtered + navigate-to', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await dropPng(page, 'library-object.png')
  await expect(page.locator('[data-canvas-tile]')).toHaveCount(1, { timeout: 10_000 })

  // V cycles the projection family (§7, Phase 5b): ∅ → timeline → library.
  // First press = the timeline; second = the library this test exercises.
  await page.keyboard.press('v')
  await expect(page.locator('[data-canvas-timeline]')).toBeVisible()
  await page.keyboard.press('v')
  const overlay = page.locator('[data-canvas-library]')
  await expect(overlay).toBeVisible()
  await expect(overlay.locator('[data-canvas-library-row="image"]')).toHaveCount(1)
  await overlay.locator('[data-canvas-library-input]').fill('library-object')
  await expect(overlay.locator('[data-canvas-library-row="image"]')).toHaveCount(1)
  await overlay.locator('[data-canvas-library-filter="audio"]').click()
  await expect(overlay.locator('.canvas-index-empty')).toBeVisible()
  await overlay.locator('[data-canvas-library-filter="all"]').click()

  // Navigate-to: selecting the row flies to the object and closes.
  await overlay.locator('[data-canvas-library-row="image"]').click()
  await expect(overlay).toHaveCount(0)
  await expect(page.locator('[data-canvas-tile]').first()).toBeVisible()
  await page.screenshot({ path: 'test-results/shots/22-canvas-library-projection.png' })
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('the plan editor survives a late stale document response (the gap-menu seeding race)', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  // The race (the standing timeline-gap-menu vision FAIL): the scenario's
  // rapid seeding (new plan + two adds + two prompt fills) fires overlapping
  // document reloads; an OUT-OF-ORDER stale response used to be applied
  // last-write-wins, regressing the store to an older document — the editor
  // repainted from it and the prompt textareas went empty while the
  // persisted document was correct. This test DELIVERS the stale response
  // deterministically: the first project GET whose plan holds exactly ONE
  // segment is held back until the very end, then released.
  let held: { fulfill: () => Promise<void> } | null = null
  await page.route(/\/api\/lan\/documents\/project\?/, async (route) => {
    const response = await route.fetch()
    if (!held) {
      try {
        const body = JSON.parse(await response.text()) as { plans?: Array<{ document?: { segments?: unknown[] } }> }
        if (body.plans?.some((plan) => plan.document?.segments?.length === 1)) {
          let release: () => void = () => undefined
          const released = new Promise<void>((resolve) => { release = resolve })
          held = {
            fulfill: async () => {
              release()
              await route.fulfill({ response, body: JSON.stringify(body) })
            },
          }
          await released
          return
        }
        await route.fulfill({ response, body: JSON.stringify(body) })
        return
      } catch {
        // fall through to the plain passthrough below
      }
    }
    await route.fulfill({ response })
  })
  await page.goto('/?canvas=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await page.keyboard.press('v')
  const overlay = page.locator('[data-canvas-timeline]')
  await expect(overlay).toBeVisible()
  await overlay.locator('[data-canvas-timeline-new-plan]').click()
  await expect(overlay.locator('[data-canvas-plan-brief]')).toBeVisible({ timeout: 10_000 })
  await overlay.locator('[data-canvas-plan-add-segment]').click()
  await overlay.locator('[data-canvas-plan-add-segment]').click()
  await expect(overlay.locator('[data-canvas-segment]')).toHaveCount(2)
  await overlay.locator('[data-canvas-segment-prompt]').nth(0).fill('the drummer steps off the night train into the rain')
  await overlay.locator('[data-canvas-segment-prompt]').nth(0).blur()
  await overlay.locator('[data-canvas-segment-prompt]').nth(1).fill('the corridor lights stutter as she passes')
  await overlay.locator('[data-canvas-segment-prompt]').nth(1).blur()
  await page.waitForTimeout(500)
  await overlay.locator('[data-canvas-gap]').first().click()
  await expect(overlay.locator('[data-canvas-gap-menu]')).toBeVisible()

  // The stale one-segment response arrives LAST (the contended-machine
  // condition). The sequenced store must refuse it: two segments stay, and
  // the editor fields repaint from the PERSISTED truth, not the regression.
  expect(held).toBeTruthy()
  await held!.fulfill()
  await page.waitForTimeout(400)
  await expect(overlay.locator('[data-canvas-segment]')).toHaveCount(2)
  await expect(overlay.locator('.canvas-timeline-title')).toContainText('2 segments')
  await expect(overlay.locator('[data-canvas-segment-prompt]').nth(0)).toHaveValue('the drummer steps off the night train into the rain')
  await expect(overlay.locator('[data-canvas-segment-prompt]').nth(1)).toHaveValue('the corridor lights stutter as she passes')
  // And the persisted document agrees (the DOM never diverges from it).
  const document = await activeDocument(page)
  const prompts = document.plans![0]!.document.segments.map((segment) => segment.prompt)
  expect(prompts).toEqual(['the drummer steps off the night train into the rain', 'the corridor lights stutter as she passes'])
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('context menus clamp inside the viewport when opened near the bottom (F8)', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await dropPng(page, 'clamp-source.png')
  const mediaTile = page.locator('[data-canvas-tile]').first()
  await expect(mediaTile).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(900) // fly-to settle before forking

  // The menu positions itself by the tile's WORLD coordinates (derive.ts
  // grid/adjacency layout — panning the camera never moves it), so the F8
  // defect needs a tile whose WORLD y is deep, not a panned camera. Forks
  // of the SAME source stack vertically (source.y + n*(TILE_H_MEDIA+60));
  // three forks put the third at world y ≈ 96 + 2*326 = 748 — its produce
  // menu (measured 480px tall) extended 170+px below the fold pre-clamp,
  // the judge-confirmed-twice defect.
  for (let fork = 0; fork < 3; fork += 1) {
    await mediaTile.locator('[data-canvas-endpoint="tail"]').click()
    const forkMenu = page.locator('[data-canvas-endpoint-menu="produce"]')
    await expect(forkMenu).toBeVisible()
    await forkMenu.locator('[data-canvas-menu-row="produce:fork-decoded"]').click()
    await expect(page.locator('[data-canvas-tile]')).toHaveCount(2 + fork, { timeout: 10_000 })
    await page.waitForTimeout(300)
  }
  // The lowest tile on screen is the third fork. Let the fit camera settle
  // (d3 transition), then pick the max-y tile by measured box — DOM order
  // and mid-flight cameras are not trustworthy position signals. The MENU
  // positions at world coordinates on a viewport-fixed backdrop (that
  // decoupling from the camera IS the F8 defect surface).
  await page.waitForTimeout(1200)
  const tileHandles = page.locator('[data-canvas-tile]')
  const tileCount = await tileHandles.count()
  let lowestIndex = 0
  let lowestBottom = -1
  for (let index = 0; index < tileCount; index += 1) {
    const box = (await tileHandles.nth(index).boundingBox())!
    if (box.y + box.height > lowestBottom) {
      lowestBottom = box.y + box.height
      lowestIndex = index
    }
  }
  const lowest = tileHandles.nth(lowestIndex)
  expect(lowestBottom).toBeGreaterThan(600)
  await lowest.locator('[data-canvas-endpoint="tail"]').click()
  const menu = page.locator('[data-canvas-endpoint-menu="produce"]')
  await expect(menu).toBeVisible()
  const menuBox = (await menu.boundingBox())!
  // The natural position (world y ≈ 748 + 24 = 772) puts the 480px menu's
  // bottom ~170px past the fold pre-clamp — the clamp must have pulled it
  // up into the viewport.
  expect(menuBox.y).toBeLessThan(700)
  // The whole menu sits inside the viewport — the footer included (its
  // reachability was the defect), with a small margin for shadows.
  expect(menuBox.y).toBeGreaterThanOrEqual(0)
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(1080 - 4)
  await expect(menu.locator('footer')).toBeVisible()
  const footerBox = (await menu.locator('footer').boundingBox())!
  expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(1080 - 4)
  // Rows remain reachable: at least the menu's LAST row is inside the box.
  const rowCount = await menu.locator('[data-canvas-menu-row]').count()
  expect(rowCount).toBeGreaterThan(0)
  const lastRow = menu.locator('[data-canvas-menu-row]').nth(rowCount - 1)
  const lastRowBox = (await lastRow.boundingBox())!
  expect(lastRowBox.y + lastRowBox.height).toBeLessThanOrEqual(1080 - 4)
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('Settings docks as a floating panel reachable from the canvas titlebar', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')

  // The titlebar button opens the dock; the REAL SettingsView renders inside
  // (the engine connection section is its first content).
  await page.locator('[data-canvas-settings-button]').click()
  const dock = page.locator('[data-canvas-settings-dock]')
  await expect(dock).toBeVisible()
  await expect(dock.locator('[data-canvas-settings-body]')).toBeVisible()
  await expect(dock.getByText(/comfyui/i).first()).toBeVisible()
  // The canvas stays alive behind it — the dock is a floating thin surface.
  await expect(page.locator('[data-canvas-viewport]')).toBeVisible()
  await dock.locator('[data-canvas-settings-close]').click()
  await expect(dock).toHaveCount(0)
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('the global asset store binds through the properties panel (consent-gated)', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  // A real global asset with a curated reference set (path existence is a
  // render-time concern; binding is a document edit).
  await page.request.post('/api/lan/documents/assets', { data: { id: 'e2e:asset:location', kind: 'location', fields: { name: 'E2E Windmill' }, canonicalReferenceSet: ['/test-home/e2e/windmill-1.png'] } })
  await page.goto('/?canvas=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await page.locator('[data-canvas-prompt]').fill('a chain to bind the asset on')
  await page.locator('[data-canvas-submit]').click()
  await expect(page.locator('[data-canvas-tile]').first()).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(800)

  // The panel's global-assets select lists it; binding forks into the
  // project (consent) and adds the reference binding.
  await expect(page.locator('[data-canvas-ref-asset]')).toBeVisible({ timeout: 10_000 })
  await page.locator('[data-canvas-ref-asset]').selectOption('e2e:asset:location')
  await expect(page.locator('[data-canvas-toast]').last()).toContainText(/forked into this project/i, { timeout: 10_000 })
  await page.waitForTimeout(900)
  const document = await activeDocument(page)
  const chain = document.chains[0]!
  expect((chain.settings.referenceAssetIds as string[]) ?? []).toContain('e2e:asset:location')
  // The <Picture N> binding surfaces in the panel's reference list.
  await expect(page.locator('[data-canvas-reference-list]')).toContainText('Location asset: E2E Windmill')
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

// Phase 5 (task 7mcp11b): the Phase-4 retirement flips to DELETION — the four
// views (Create, Queue, Library, LTX 2.5) died with the shell. Their canvas
// replacements are already proven above; this smoke proves the ABSENCE plus
// each replacement being one gesture away (D-deps resolve to the canvas).
test('Phase-5 deletion smoke: Create / Queue / Library / LTX 2.5 are gone; the canvas replacements stand (§8)', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')

  // Absence: no shell, no greyed nav, no retired markers, no old headings.
  await expect(page.locator('.nav-button')).toHaveCount(0)
  await expect(page.locator('[data-retired]')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: /create with minimax h3/i })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Queue' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: /video library/i })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: /create with ltx/i })).toHaveCount(0)

  // Create → the launcher prompt bar IS the generation surface (empty canvas
  // = launcher; a prompt spawns the seed object).
  await expect(page.locator('[data-canvas-promptbar]')).toBeVisible()

  // Queue → ⌘K summons the index (the flat queue across all jobs).
  await page.keyboard.press('Control+k')
  await expect(page.locator('[data-canvas-index]')).toBeVisible()
  await page.keyboard.press('Escape')

  // Library → V cycles the projection family (5b: timeline first, library
  // second — one more press).
  await page.keyboard.press('v')
  await expect(page.locator('[data-canvas-timeline]')).toBeVisible()
  await page.keyboard.press('v')
  await expect(page.locator('[data-canvas-library]')).toBeVisible()
  await page.keyboard.press('Escape')

  // LTX 2.5 → the engine lives as the typed-hole produce row on an image
  // object (probe-asserted by the engines-as-ops spec above); the old
  // workspace surface is gone.
  await expect(page.locator('[data-retired="ltx25"]')).toHaveCount(0)
  await page.screenshot({ path: 'test-results/shots/23-phase5-four-deleted.png' })
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

// Phase 5 (task 7mcp11b): the MoviePlanner shot handoff seeds a REAL canvas
// chain through the store's seedChain — compiled prompt + shot settings,
// CONSENT-GATED (created + selected + inspected, NEVER submitted: zero jobs
// appear; the user generates from the panel — principle 5).
test('the Studios dock shot handoff seeds a chain, consent-gated (nothing auto-executes)', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1&probe=canvas')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  const result = await page.evaluate(() => (window as unknown as { __canvasScenario(name: string): { ok: boolean; chainId?: string; selected?: boolean; inspector?: boolean; jobsCreated?: number; reason?: string } }).__canvasScenario('seed-chain'))
  expect(result.ok, result.reason).toBe(true)
  expect(result.selected).toBe(true)
  expect(result.inspector).toBe(true)
  expect(result.jobsCreated).toBe(0)
  await expect(page.locator(`[data-canvas-tile="${result.chainId}"]`)).toBeVisible({ timeout: 10_000 })
  // The shot's compiled settings persisted on the chain (the document write
  // settles; the API read is the durable truth).
  await page.waitForTimeout(400)
  const document = await activeDocument(page)
  const chain = document.chains.find((entry) => entry.id === result.chainId)
  expect(chain, 'the seeded chain exists in the document').toBeTruthy()
  expect(chain!.settings.prompt).toContain('drummer steps off the night train')
  expect(chain!.settings.duration).toBe(9)
  expect(chain!.settings.resolution).toBe('768x1344')
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

// ---- Phase 5b (task 2u0rent): the Director Suite — timeline projection,
// plan documents, the measured gap menu, MoviePlanner retirement. ----------

/** The active project's RAW document (plans included — the typed helper
 *  predates them). */
async function rawDocument(page: Page) {
  const session = await page.evaluate(async () => {
    const response = await fetch('/api/lan/documents/session')
    return (await response.json()).session as { activeProject: string | null }
  })
  expect(session.activeProject).toBeTruthy()
  return page.evaluate(async (id) => {
    const response = await fetch(`/api/lan/documents/project?id=${encodeURIComponent(id)}`)
    return await response.json() as {
      chains: Array<{ id: string; kind: string; settings: Record<string, unknown> }>
      plans: Array<{ id: string; document: { brief: string; segments: Array<{ id: string; title: string; prompt: string; duration: number; chainId: string | null }>; gaps: Array<{ afterSegmentId: string; kind: string }> } }>
    }
  }, session.activeProject!)
}

test('the timeline projection (V): chain outputs chronologically + adopt-chronology + navigate-to', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await dropPng(page, 'timeline-object.png')
  await expect(page.locator('[data-canvas-tile]')).toHaveCount(1, { timeout: 10_000 })

  // V opens the TIMELINE first (the §7 flip family: ∅ → timeline → library).
  // Unplanned: the dropped media's output is item one; one item = no gaps.
  await page.keyboard.press('v')
  const overlay = page.locator('[data-canvas-timeline]')
  await expect(overlay).toBeVisible()
  await expect(overlay.locator('[data-canvas-timeline-item]')).toHaveCount(1)
  await expect(overlay.locator('[data-canvas-gap]')).toHaveCount(0)

  // Adopt chronology → a persisted canvas_plan whose segment carries the
  // chain_ref (the API read is the durable truth).
  await overlay.locator('[data-canvas-timeline-adopt]').click()
  await expect(overlay.locator('[data-canvas-plan-editor]')).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(400)
  const document = await rawDocument(page)
  expect(document.plans.length).toBe(1)
  expect(document.plans[0]!.document.segments.length).toBe(1)
  expect(document.plans[0]!.document.segments[0]!.chainId).toBe(document.chains[0]!.id)

  // Navigate-to: clicking the item flies to the object and closes.
  await overlay.locator('[data-canvas-timeline-item]').first().click()
  await expect(overlay).toHaveCount(0)
  await expect(page.locator('[data-canvas-tile]').first()).toBeVisible()
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('plan documents: brief + segments + reference handoffs, consent-gated seeding (chain_ref written), persistence across reload', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await page.keyboard.press('v')
  const overlay = page.locator('[data-canvas-timeline]')
  await expect(overlay).toBeVisible()

  // A fresh plan; the brief + two segments commit on blur (document writes).
  await overlay.locator('[data-canvas-timeline-new-plan]').click()
  await expect(overlay.locator('[data-canvas-plan-brief]')).toBeVisible({ timeout: 10_000 })
  await overlay.locator('[data-canvas-plan-brief]').fill('a night train heist in three beats')
  await overlay.locator('[data-canvas-plan-brief]').blur()
  await overlay.locator('[data-canvas-plan-add-segment]').click()
  await overlay.locator('[data-canvas-plan-add-segment]').click()
  await expect(overlay.locator('[data-canvas-segment]')).toHaveCount(2)
  await overlay.locator('[data-canvas-segment-prompt]').nth(0).fill('the drummer steps off the night train into the rain')
  await overlay.locator('[data-canvas-segment-prompt]').nth(0).blur()
  await overlay.locator('[data-canvas-segment-prompt]').nth(1).fill('the corridor lights stutter as she passes')
  await overlay.locator('[data-canvas-segment-prompt]').nth(1).blur()
  await page.waitForTimeout(500)
  let document = await rawDocument(page)
  expect(document.plans[0]!.document.brief).toContain('night train heist')
  expect(document.plans[0]!.document.segments.map((segment) => segment.prompt)).toEqual(['the drummer steps off the night train into the rain', 'the corridor lights stutter as she passes'])

  // Seed segment 1 — the consent gate (created + selected, ZERO jobs; the
  // reference-handoff ids ride the chain settings for the panel to bind).
  const jobsBefore = ((await (await page.request.get('/api/lan/jobs')).json()) as { jobs?: unknown[] }).jobs?.length ?? 0
  await overlay.locator('[data-canvas-segment-seed]').first().click()
  await expect(page.locator('[data-canvas-tile]')).toHaveCount(1, { timeout: 10_000 })
  await page.waitForTimeout(600)
  const jobsAfter = ((await (await page.request.get('/api/lan/jobs')).json()) as { jobs?: unknown[] }).jobs?.length ?? 0
  expect(jobsAfter).toBe(jobsBefore)
  document = await rawDocument(page)
  const seededChainId = document.plans[0]!.document.segments[0]!.chainId
  expect(seededChainId).toBeTruthy()
  expect(document.chains.find((chain) => chain.id === seededChainId)!.settings.prompt).toContain('drummer steps off')

  // Persistence across reload: the plan rides the document (canvas_plan),
  // not session state — the timeline reprojects it identically.
  await page.reload()
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await page.keyboard.press('v')
  await expect(page.locator('[data-canvas-timeline] [data-canvas-segment]')).toHaveCount(2, { timeout: 10_000 })
  await expect(page.locator('[data-canvas-timeline] [data-canvas-segment-state]').first()).toContainText(/idle/i)
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('the measured gap menu: five entries with honest verdicts; the FLF splice wires the REAL continuation frame', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  // A REAL video object (the committed sample clip) — the splice extracts
  // its final frame server-side through ffmpeg, no engine involved.
  await page.setInputFiles('[data-canvas-file-input]', path.resolve(__dirname, 'fixtures/sample-clip.mp4'))
  await expect(page.locator('[data-canvas-tile]')).toHaveCount(1, { timeout: 20_000 })
  await page.keyboard.press('v')
  const overlay = page.locator('[data-canvas-timeline]')
  await expect(overlay).toBeVisible()
  await overlay.locator('[data-canvas-timeline-adopt]').click()
  await expect(overlay.locator('[data-canvas-plan-editor]')).toBeVisible({ timeout: 10_000 })
  await overlay.locator('[data-canvas-plan-add-segment]').click()
  await expect(overlay.locator('[data-canvas-segment]')).toHaveCount(2)
  await overlay.locator('[data-canvas-segment-prompt]').nth(1).fill('she rounds the corner into the strobing corridor')
  await overlay.locator('[data-canvas-segment-prompt]').nth(1).blur()
  // The blur commits through the document store; the seed button enables
  // when the reloaded plan lands (uncontrolled inputs commit on blur).
  // Segment 1 is already seeded by adopt-chronology — its button is GONE;
  // the remaining seed button belongs to segment 2.
  await expect(overlay.locator('[data-canvas-segment-seed]')).toHaveCount(1)
  await expect(overlay.locator('[data-canvas-segment-seed]').first()).toBeEnabled({ timeout: 10_000 })
  await overlay.locator('[data-canvas-segment-seed]').first().click()
  await expect(page.locator('[data-canvas-tile]')).toHaveCount(2, { timeout: 10_000 })
  await page.waitForTimeout(400)

  // The gap between the two segments opens the MEASURED menu: five entries,
  // honest mechanism labels, engine-dependent renders disabled by design.
  await overlay.locator('[data-canvas-gap]').first().click()
  const menu = overlay.locator('[data-canvas-gap-menu]')
  await expect(menu).toBeVisible()
  await expect(menu.locator('[data-canvas-gap-option]')).toHaveCount(5)
  await expect(menu.locator('[data-canvas-gap-option="cut"]')).toContainText(/9.8 dB/i)
  await expect(menu.locator('[data-canvas-gap-option="flf"]')).toContainText(/36.2\/34.3 dB/i)
  await expect(menu.locator('[data-canvas-gap-mechanism="in-model"]')).toHaveCount(2)
  await expect(menu.locator('[data-canvas-gap-mechanism="post"]')).toHaveCount(2)
  await expect(menu.locator('[data-canvas-gap-mechanism="assembly"]')).toHaveCount(1)
  await expect(menu.locator('[data-canvas-gap-option="bridge"]')).toBeDisabled()
  await expect(menu.locator('[data-canvas-gap-option="black"]')).toBeDisabled()
  await expect(menu.locator('[data-canvas-gap-option="bridge"]')).toContainText(/engine work/i)

  // FLF EXECUTES (the Phase-5 toast-note handoff, now gap machinery): the
  // prior segment's FINAL frame is extracted and wired as the next
  // segment's first frame — real document state, not a toast.
  await menu.locator('[data-canvas-gap-option="flf"]').click()
  await expect(page.locator('[data-canvas-toast="success"]').last()).toContainText(/splice wired/i, { timeout: 20_000 })
  await page.waitForTimeout(600)
  const document = await rawDocument(page)
  const plan = document.plans[0]!.document
  const rightChain = document.chains.find((chain) => chain.id === plan.segments[1]!.chainId)!
  const firstFrameOutputId = rightChain.settings.firstFrameOutputId as string | undefined
  expect(firstFrameOutputId).toBeTruthy()
  const frameChain = document.chains.find((chain) => chain.outputs.some((output) => (output as unknown as { id: string }).id === firstFrameOutputId))
  expect(frameChain, 'the continuation frame is its own media object').toBeTruthy()
  expect(plan.gaps).toContainEqual({ afterSegmentId: plan.segments[0]!.id, kind: 'flf' })
  // The strip shows the recorded gap kind now.
  await expect(overlay.locator('[data-canvas-gap]').first()).toContainText(/FLF splice/i)
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('MoviePlanner retired (5b): no movie tab; the plan surface is the timeline; the handoff probe still seeds consent-gated', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')

  // The Studios dock carries the five ASSET studios — the movie tab died
  // with its surface (the plan lives on the document store now).
  await page.locator('[data-canvas-studios-button]').click()
  const dock = page.locator('[data-canvas-studios-dock]')
  await expect(dock).toBeVisible()
  await expect(dock.locator('[data-canvas-studios-tab]')).toHaveCount(5)
  await expect(dock.locator('[data-canvas-studios-tab="movie"]')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: /movie planner/i })).toHaveCount(0)
  await page.locator('[data-canvas-studios-close]').click()

  // The launcher's movie-plan chip opens the TIMELINE (the Director Suite).
  await page.locator('[data-canvas-chip="movie"]').click()
  await expect(page.locator('[data-canvas-timeline]')).toBeVisible()
  await page.keyboard.press('Escape')

  // The consent-gated chain seeding survived retirement (the store path the
  // shot handoff used — now the segment-seeding core).
  await page.goto('/?canvas=1&probe=canvas')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  const result = await page.evaluate(() => (window as unknown as { __canvasScenario(name: string): { ok: boolean; chainId?: string; selected?: boolean; jobsCreated?: number; reason?: string } }).__canvasScenario('seed-chain'))
  expect(result.ok, result.reason).toBe(true)
  expect(result.jobsCreated).toBe(0)
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('the mobile companion still boots, marked unmaintained (L10)', async ({ page }) => {
  const problems = await trackErrors(page)
  await page.goto('/?mobile=1')
  // The route renders its companion shell — kept booting per L10 (out of v1
  // scope, no canvas capabilities; the unmaintained marker is in the code).
  await expect(page.locator('main.mobile-app')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.mobile-header')).toContainText('MiniMax Studio')
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

