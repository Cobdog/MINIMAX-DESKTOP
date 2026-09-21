import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { H3_REGISTRY_LISTINGS, serveModelRegistry, serveObjectInfo, stockObjectInfo } from './fakeEngineInfo'

// H3 Image Workbench (k9vu6t0, docs/specs/image-workbench-v1.md §2/§11): the
// dedicated surface end to end at ?images=1 — engine-independent (the packet
// take is seeded through the documents API exactly the way the landing loop
// writes it: ONE take whose artifacts are the N frame outputs, scorer verdict
// + canonical pointer in metrics). Covers: the mode rail, the 9-slot
// reference strip with roles + auto-per-role transports, the Keep dial, the
// generated contract, take-strip frame picking (manual pick beats the
// scorer), the always-opt-in refine affordance with engine-pairing honesty
// (engine offline → both engines say unavailable, never silent), the burst
// lane's E-IW2 gate, the beyond-9 honesty note, and the consent-gated exit
// dialog with the hybrid limitation named. Every test attaches the
// console/page-error guard like app.spec.ts.

const environmental = (entry: string) =>
  entry.includes('Failed to load resource')
  || /WebSocket connection to .* failed/.test(entry)
  || /Connecting to 'blob:.*' violates the following Content Security Policy directive: "connect-src/.test(entry)
  || /net::ERR_CONNECTION_REFUSED/.test(entry) // the engine is deliberately offline in this leg

async function trackErrors(page: Page) {
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`)
  })
  return problems
}

// Three DISTINCT 1x1 PNGs (content-hash distinct — the blob tree dedupes).
const FRAME_PNGS = [
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==',
]

type Seeded = { projectId: string; chainId: string; outputId: string; takeId: string; artifactPaths: string[] }

/** Seeds one workbench session with one landed packet take, the exact shape
 *  the landing loop writes (frame artifacts + scorer verdict + canonical
 *  pointer in metrics.h3img). */
async function seedSession(request: APIRequestContext): Promise<Seeded> {
  const project = await (await request.post('/api/lan/documents/projects', { data: { name: 'IW e2e' } })).json()
  const chain = await (await request.post('/api/lan/documents/chains', {
    data: {
      projectId: project.project.id,
      kind: 'h3img',
      settings: {
        family: 'h3img.generate.packet',
        intent: 'a ceramic bowl of lemons on an oak table',
        tier: 5,
        keepDial: 0.55,
        seed: 4242,
        resolution: '1344x768',
        loras: [],
        refs: [],
        semanticOverflow: false,
        framePicks: {},
        refineEngine: '',
        poserigInbox: null,
      },
    },
  })).json()
  const output = await (await request.post('/api/lan/documents/outputs', { data: { chainId: chain.chain.id, substrates: ['decoded'] } })).json()
  const artifactPaths: string[] = []
  for (let index = 0; index < FRAME_PNGS.length; index += 1) {
    const ingested = await (await request.post('/api/lan/documents/blobs/ingest', { data: { data: FRAME_PNGS[index], name: `packet-frame-${index}.png`, kind: 'image' } })).json()
    artifactPaths.push(ingested.path)
  }
  const take = await (await request.post('/api/lan/documents/takes', {
    data: {
      outputId: output.output.id,
      jobId: null,
      artifacts: artifactPaths,
      metrics: {
        kind: 'image',
        duration: 0,
        width: 1344,
        height: 768,
        sourcePath: artifactPaths[0],
        h3img: {
          family: 'h3img.generate.packet',
          profile: 'packet',
          tier: 5,
          frames: 3,
          prompt: 'the generated contract text',
          refs: [{ role: 'subject', transport: 'native', name: 'identity.png' }],
          loras: [],
          seed: 4242,
          resolution: '1344x768',
          hybrid: true,
          scorer: { bestIndex: 1, reason: 'sharpest of the pool (Laplacian 123.4)', metricBasis: 'pixel metrics only (no references supplied; CLIP similarity is a seam — not computed, no dependencies)' },
          canonicalFrameIndex: 1,
        },
      },
    },
  })).json()
  await request.post('/api/lan/documents/session', { data: { openProjects: [project.project.id], activeProject: project.project.id } })
  return { projectId: project.project.id, chainId: chain.chain.id, outputId: output.output.id, takeId: take.take.id, artifactPaths }
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw new Error(`Uncaught renderer error during navigation: ${error.message}`)
  })
})

test('the workbench boots at ?images=1 with the seeded packet take on the pick surface', async ({ page, request }) => {
  const problems = await trackErrors(page)
  await seedSession(request)
  await page.goto('/?images=1')
  await expect(page.locator('[data-iw-root]')).toBeVisible()
  // The mode rail: five modes, the packet family selected.
  await expect(page.locator('[data-iw-mode-rail]')).toBeVisible()
  await expect(page.locator('[data-iw-mode="generate"]')).toBeVisible()
  await expect(page.locator('[data-iw-mode="compose"]')).toBeVisible()
  await expect(page.locator('[data-iw-mode="edit"]')).toBeVisible()
  await expect(page.locator('[data-iw-mode="refine"]')).toBeVisible()
  await expect(page.locator('[data-iw-root][data-iw-family="h3img.generate.packet"]')).toBeVisible()
  // The take strip IS the pick surface: one take, three frame artifacts,
  // the scorer's frame starred.
  const take = page.locator(`[data-iw-take][data-iw-take-kind="packet"]`)
  await expect(take).toBeVisible()
  await expect(take.locator('[data-iw-frame]')).toHaveCount(3)
  await expect(take.locator('[data-iw-frame="1"]')).toHaveClass(/scorer/)
  await expect(take.locator('[data-iw-frame="1"]')).toHaveClass(/picked/)
  // The preview shows the picked frame with the scorer verdict.
  await expect(page.locator('[data-iw-preview-image]')).toBeVisible()
  await expect(page.locator('[data-iw-scorer]')).toContainText('sharpest')
  const problemsAfterBoot = problems.filter((entry) => !environmental(entry))
  expect(problemsAfterBoot).toEqual([])
})

test('the workbench carries the shared surface switcher — Alt+2/Alt+3 live (the surface contract)', async ({ page, request }) => {
  const problems = await trackErrors(page)
  await seedSession(request)
  await page.goto('/?images=1')
  await expect(page.locator('[data-iw-mode-rail]')).toBeVisible({ timeout: 15_000 })
  // The registry-driven switcher renders in the workbench header like on
  // every registered surface (app-tour wave d6iy68r, review M1 — before the
  // fix this surface was the one place Alt+1..9 was dead and datasets was
  // unreachable except by URL).
  const imagesPill = page.locator('[data-surface-switcher] [data-surface="images"]')
  await expect(imagesPill).toBeVisible()
  await expect(imagesPill).toHaveAttribute('aria-current', 'page')
  await page.keyboard.press('Alt+2')
  await expect(page.locator('[data-ds-root]')).toBeVisible({ timeout: 15_000 })
  await page.keyboard.press('Alt+3')
  await expect(page.locator('[data-iw-mode-rail]')).toBeVisible({ timeout: 15_000 })
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('manual pick on the take strip overrides the scorer (the canonical frame pointer)', async ({ page, request }) => {
  const problems = await trackErrors(page)
  const seeded = await seedSession(request)
  await page.goto('/?images=1')
  const take = page.locator(`[data-iw-take="${seeded.takeId}"]`)
  await expect(take.locator('[data-iw-frame="2"]')).toBeVisible()
  await take.locator('[data-iw-frame="2"]').click()
  // The pick persists through the document store (chain settings framePicks)
  // — reload and the manual choice stands.
  await page.reload()
  const reloaded = page.locator(`[data-iw-take="${seeded.takeId}"]`)
  await expect(reloaded.locator('[data-iw-frame="2"]')).toHaveClass(/picked/)
  await expect(reloaded.locator('[data-iw-frame="1"]')).not.toHaveClass(/picked/)
  const problemsAfter = problems.filter((entry) => !environmental(entry))
  expect(problemsAfter).toEqual([])
})

test('the refine affordance is opt-in with engine-pairing honesty; the burst lane states its gate', async ({ page, request }) => {
  const problems = await trackErrors(page)
  await seedSession(request)
  await page.goto('/?images=1')
  // Always opt-in: no refine ran, the affordance presents both engines.
  await expect(page.locator('[data-iw-refine]')).toBeVisible()
  await expect(page.locator('[data-iw-refine-tap="klein"]')).toBeVisible()
  await expect(page.locator('[data-iw-refine-tap="krea2"]')).toBeVisible()
  // Engine offline → BOTH engines say so (disabled with their reason), never
  // a silent skip.
  await expect(page.locator('[data-iw-refine-tap="klein"]')).toBeDisabled()
  await expect(page.locator('[data-iw-refine-tap="krea2"]')).toBeDisabled()
  await expect(page.locator('.iw-engine-note')).toContainText(/unavailable/i)
  // The primary Generate CTA names its reason too (app-tour wave d6iy68r,
  // review M7 — the refine-tap title pattern, never a silent dead button).
  const generate = page.locator('[data-iw-generate]')
  await expect(generate).toBeDisabled()
  await expect(generate).toHaveAttribute('title', /unavailable/i)
  // The burst lane ships behind the E-IW2 gate + experiment flag.
  const burst = page.locator('[data-iw-burst-fuse]')
  await expect(burst).toBeDisabled()
  await expect(burst).toContainText('E-IW2')
  const problemsAfter = problems.filter((entry) => !environmental(entry))
  expect(problemsAfter).toEqual([])
})

test('the reference strip: roles, auto-per-role transports, the beyond-9 honesty, and the Keep dial', async ({ page, request }) => {
  const problems = await trackErrors(page)
  await seedSession(request)
  await page.goto('/?images=1')
  // The strip: the budget counter and the honest v1 statement.
  await expect(page.locator('[data-iw-ref-count]')).toHaveText('0/9')
  await expect(page.locator('.iw-refs-note')).toContainText('9 native references')
  await expect(page.locator('[data-iw-ref-add-file]')).toBeVisible()
  await expect(page.locator('[data-iw-ref-add-canvas]')).toBeVisible()
  await expect(page.locator('[data-iw-ref-add-poserig]')).toBeVisible()
  // The Keep dial rides its band hint.
  await expect(page.locator('[data-iw-keep-dial]')).toBeVisible()
  await expect(page.locator('[data-iw-keep-hint]')).toContainText('large pose/composition')
  // The generated contract preview (never hand-written).
  await expect(page.locator('[data-iw-contract]')).toContainText('generated')
  await expect(page.locator('[data-iw-contract-text]')).toContainText('bowl of lemons')
  const problemsAfter = problems.filter((entry) => !environmental(entry))
  expect(problemsAfter).toEqual([])
})

test('the exit dialog is consent-gated and names the hybrid limitation honestly', async ({ page, request }) => {
  const problems = await trackErrors(page)
  await seedSession(request)
  await page.goto('/?images=1')
  await page.locator('[data-iw-exit]').click()
  const dialog = page.locator('[data-iw-exit-dialog]')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('created and selected, never submitted')
  // No hybrid loader (engine offline) → the stock limitation is NAMED.
  await expect(page.locator('[data-iw-exit-hybrid]')).toContainText('silently drop one of')
  await page.locator('[data-iw-exit-choice="anchor"]').click()
  await expect(page.locator('[data-iw-exit-confirm]')).toBeEnabled()
  await page.locator('[data-iw-exit-confirm]').click()
  // The exit seeds: the pinned media chain + the anchored video chain land
  // on the project (created, never submitted — no job appears).
  await expect(page.locator('[data-iw-exit-dialog]')).not.toBeVisible()
  await expect.poll(async () => {
    const doc = await (await page.request.get(`/api/lan/documents/project?id=${(await (await page.request.get('/api/lan/documents/session')).json()).session.activeProject}`)).json()
    return doc.chains.filter((chain: { kind: string }) => chain.kind === 'media' || chain.kind === 'generate').length
  }, { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  const problemsAfter = problems.filter((entry) => !environmental(entry))
  expect(problemsAfter).toEqual([])
})

test('the canvas tile names the workbench packet and links to the pick surface', async ({ page, request }) => {
  const problems = await trackErrors(page)
  await seedSession(request)
  await page.goto('/')
  // The session chain renders as a canvas object with the frame-count chip.
  // The take chips are zoom-gated (band 'near'): zoom in past the mid band.
  const chip = page.locator('[data-canvas-take-to-workbench]')
  await expect(chip).toBeVisible({ timeout: 15_000 }).catch(async () => {
    for (let index = 0; index < 3; index += 1) await page.getByRole('button', { name: 'Zoom in' }).click()
  })
  await expect(chip).toContainText('3 frames')
  const problemsAfter = problems.filter((entry) => !environmental(entry))
  expect(problemsAfter).toEqual([])
})

// ---------------------------------------------------------------------------
// The FULL generation path through a fake engine speaking the real contract
// (the canvas F6 precedent): submit → poll → the packet-aware landing
// (getHistory → EVERY frame descriptor → server-side byte ingest → the
// first-party scorer decoding the frames → ONE take whose artifacts are the
// N frames). This is AC1's landing mechanics proven engine-free end to end.
test('a generation lands as ONE take whose artifacts are the packet frames (fake engine, full path)', async ({ page, request }) => {
  const problems = await trackErrors(page)
  const http = await import('node:http')

  // (Wave 2 R-12) The engine's /models listing resolves the workbench's
  // availability — no local files (the T=1 decoder + the MaxiMin adapter
  // ride the listing).
  const workbenchListings = {
    ...H3_REGISTRY_LISTINGS,
    vae: [...H3_REGISTRY_LISTINGS.vae, 'minimax_h3_t1_image_vae_step1597.safetensors'],
    loras: [...H3_REGISTRY_LISTINGS.loras, 'MaxiMin-HHH-R2V-ThisIsFine.safetensors'],
  }

  const frameBytes = FRAME_PNGS.map((base64) => Buffer.from(base64, 'base64'))
  const PROMPT_ID = 'iw-e2e-landing-1'
  const engine = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://engine.local')
    if (url.pathname === '/system_stats') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ system: {}, devices: [] }))
      return
    }
    if (serveObjectInfo(url, stockObjectInfo({ MiniMaxH3HybridLoader: {} }), res)) return
    if (serveModelRegistry(url, workbenchListings, res)) return
    if (url.pathname === '/upload/image') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: 'uploaded.png', subfolder: '', type: 'input' }))
      return
    }
    if (url.pathname === '/prompt') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ prompt_id: PROMPT_ID, number: 1, node_errors: {} }))
      return
    }
    if (url.pathname === `/history/${PROMPT_ID}`) {
      // THREE per-frame publish outputs — the exact history shape the
      // workbench's frame nodes produce.
      const outputs: Record<string, unknown> = {}
      for (let index = 0; index < 3; index += 1) {
        outputs[`70${index}`] = { images: [{ filename: `iw-frame-0000${index + 1}_.png`, subfolder: '', type: 'output' }] }
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ [PROMPT_ID]: { prompt: [], outputs, status: { completed: true } } }))
      return
    }
    if (url.pathname === '/view') {
      const filename = url.searchParams.get('filename') ?? ''
      const match = filename.match(/0000(\d)/)
      const index = match ? Number(match[1]) - 1 : 0
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(frameBytes[index] ?? frameBytes[0])
      return
    }
    res.writeHead(404)
    res.end()
  })
  const enginePort = await new Promise<number>((resolve) => engine.listen(0, '127.0.0.1', () => resolve((engine.address() as { port: number }).port)))

  const originalSettings = ((await (await request.get('/api/lan/settings')).json()) as { settings: Record<string, unknown> }).settings
  try {
    // Cancel any stale non-terminal jobs from earlier runs first (the vision
    // after-hook precedent) — they would poll this run's dead engine.
    const listed = await (await request.get('/api/lan/jobs')).json() as { jobs?: Array<Record<string, unknown>> }
    const stale = (listed.jobs ?? []).filter((job) => job.status === 'queued' || job.status === 'running').map((job) => ({ ...job, status: 'cancelled' }))
    if (stale.length) await request.post('/api/lan/jobs', { data: { jobs: stale } })
    await request.post('/api/lan/settings', { data: { settings: {
      ...originalSettings,
      comfyUrl: `http://127.0.0.1:${enginePort}`,
    } } })
    await request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } })
    await page.goto('/?images=1')
    await expect(page.locator('[data-iw-root]')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[data-iw-engine="on"]')).toBeVisible({ timeout: 15_000 })
    await page.locator('[data-iw-intent]').fill('a ceramic bowl of lemons on an oak table, morning light')
    await page.locator('[data-iw-generate]').click()
    // The submission lands ONE take whose artifacts are the THREE frames,
    // the scorer ran (a starred frame + verdict), and the preview paints.
    const take = page.locator('[data-iw-take-kind="packet"]').first()
    await expect(take).toBeVisible({ timeout: 30_000 })
    await expect(take.locator('[data-iw-frame]')).toHaveCount(3, { timeout: 15_000 })
    await expect(page.locator('[data-iw-scorer]')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('[data-iw-preview-image]')).toBeVisible()
    expect(problems.filter((entry) => !environmental(entry))).toEqual([])
  } finally {
    await request.post('/api/lan/settings', { data: { settings: originalSettings } }).catch(() => undefined)
    await request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } }).catch(() => undefined)
    // Remove the dummy model files: the shared test-home must return to its
    // EMPTY-model-roots state — the first-run-guidance e2e keys on it (the
    // QOL wave's precondition). Scratch this test created, in a gitignored
    // tree, removed by the same test.
    await new Promise<void>((resolve) => engine.close(() => resolve()))
  }
})
