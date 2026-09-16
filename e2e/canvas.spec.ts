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
      chains: Array<{ id: string; kind: string; settings: Record<string, unknown>; inputSpec: Record<string, unknown>; outputs: Array<{ id: string; takes: Array<{ id: string; jobId: string | null; artifacts: string[]; supersededBy: string | null }> }>; identity?: { subjectText: string; strength: number } | null }>
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

test('multi-select shows the batch context (§4 contexts, not modes)', async ({ page }) => {
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
  // with the honest Phase-3 batch stub.
  await tiles.first().click({ modifiers: ['Shift'] })
  await expect(page.locator('[data-canvas-bottombar]')).toHaveAttribute('data-canvas-bar-context', 'multi')
  await expect(page.locator('[data-canvas-bar-batch]')).toBeVisible()
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
