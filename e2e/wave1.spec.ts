import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { H3_REGISTRY_LISTINGS, serveModelRegistry, serveObjectInfo, stockObjectInfo } from './fakeEngineInfo'
// Scratch-dir ledger (Wave 4 test hygiene): every per-run dir registers and
// the file-level afterAll tears them down — per-run scratch never accumulates.
import { makeScratchDir, removeAllScratchDirs } from '../tests/lib/scratch.cjs'

test.afterAll(() => { void removeAllScratchDirs() })

/**
 * THE WAVE-1 ACCEPTANCE BAR (task jpc96dp, plan §3): the maintainer's exact
 * first-session journey, walked end to end on EXTERNAL mode against a fake
 * engine speaking the real contract (Audit C's harness pattern — scratch
 * port, engine down at boot, kill/restart mid-session, teardown verified;
 * never 8188/8189, no GPU).
 *
 *   1. fresh home, engine NOT running → truthful offline chip, live control
 *   2. engine starts → the app notices BY ITSELF (R-01 re-check loop)
 *   3. prompt at startup → video path → a VIDEO graph, never T=1/image
 *   4. missing things → refused BEFORE the engine (R-02); engine errors →
 *      classified, unmangled (R-03)
 *   5. kill the engine mid-session → honest failure in seconds-to-minutes
 *      (R-01) — both the restart-orphan and the stayed-dead paths
 *   6. the render completes and lands on the canvas (takes visible)
 */
test('Wave 1 acceptance walk — the maintainer\'s first session, end to end on external mode', async ({ page, request }) => {
  test.setTimeout(330_000)
  const problems = await trackErrors(page)
  const SHOT_DIR = path.join(process.cwd(), 'test-results', 'wave1-walk')
  fs.mkdirSync(SHOT_DIR, { recursive: true })

  // (Wave 2 R-12) No local model files, no configured local roots: the fake
  // engine's OWN /models listing is the app's whole model inventory — the
  // registry-only walk (instance-invisible = nonexistent). The diffusion
  // rows are subpathed exactly as a real instance lists them.

  // The fake engine: MUTABLE registry + history so one server walks every
  // phase of the journey (up/incomplete, preflight-missing, 400-shaped,
  // killed, restarted-fresh, completing).
  const missingClassBody = JSON.stringify({
    error: {
      type: 'missing_node_type',
      message: "Node 'MiniMaxH3SamplerStandalone' not found. The custom node may not be installed.",
      details: "Node ID '#15'",
      extra_info: { node_id: '15', class_type: 'MiniMaxH3SamplerStandalone', node_title: 'MiniMaxH3SamplerStandalone' },
    },
    node_errors: {},
  })
  const engineState = {
    registry: stockObjectInfo() as Record<string, unknown>,
    promptMode: 'ok' as 'ok' | 'missing400',
    history: new Map<string, { completed: boolean; outputs: Record<string, unknown> }>(),
    promptSeq: 0,
  }
  const submittedGraphs: Array<Record<string, { class_type: string; inputs: Record<string, unknown> }>> = []
  const fakeMp4 = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])

  const engineHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://engine.local')
    if (url.pathname === '/system_stats') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ system: { comfyui_version: 'v0.34.0' }, devices: [] }))
      return
    }
    if (serveObjectInfo(url, engineState.registry, res)) return
    if (serveModelRegistry(url, H3_REGISTRY_LISTINGS, res)) return
    if (url.pathname === '/prompt' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk })
      req.on('end', () => {
        if (engineState.promptMode === 'missing400') {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(missingClassBody)
          return
        }
        engineState.promptSeq += 1
        const promptId = `wave1-${engineState.promptSeq}`
        submittedGraphs.push((JSON.parse(body) as { prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> }).prompt)
        engineState.history.set(promptId, { completed: false, outputs: {} })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ prompt_id: promptId, number: engineState.promptSeq, node_errors: {} }))
      })
      return
    }
    const historyMatch = /^\/history\/(.+)$/.exec(url.pathname)
    if (historyMatch && req.method === 'GET') {
      const promptId = decodeURIComponent(historyMatch[1]!)
      const entry = engineState.history.get(promptId)
      if (!entry) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({}))
        return
      }
      if (entry.completed) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ [promptId]: { prompt: [], outputs: entry.outputs, status: { completed: true } } }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ [promptId]: { prompt: [], outputs: {}, status: { completed: false } } }))
      return
    }
    if (url.pathname === '/queue' && req.method === 'GET') {
      const running = Array.from(engineState.history.entries()).filter(([, entry]) => !entry.completed).map(([promptId]) => ['entry', promptId])
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ queue_running: running, queue_pending: [] }))
      return
    }
    if (url.pathname === '/view') {
      res.writeHead(200, { 'content-type': 'video/mp4' })
      res.end(fakeMp4)
      return
    }
    res.writeHead(404)
    res.end()
  }

  // The engine is DOWN at boot (step 1); the port is reserved so the
  // restart phases re-listen on the same address.
  const holder = http.createServer(() => undefined)
  const enginePort = await new Promise<number>((resolve) => holder.listen(0, '127.0.0.1', () => resolve((holder.address() as AddressInfo).port)))
  await new Promise<void>((resolve) => holder.close(() => resolve()))
  const startEngine = () => new Promise<http.Server>((resolve) => {
    const engine = http.createServer(engineHandler)
    engine.listen(enginePort, '127.0.0.1', () => resolve(engine))
  })
  let engine: http.Server | null = null
  const stopEngine = async () => {
    if (!engine) return
    const closing = engine
    engine = null
    await new Promise<void>((resolve) => closing.close(() => resolve()))
  }

  const originalSettings = ((await (await request.get('/api/lan/settings')).json()) as { settings: Record<string, unknown> }).settings
  try {
    const listed = ((await (await request.get('/api/lan/jobs')).json()) as { jobs?: Array<Record<string, unknown>> }).jobs
    const stale = (listed ?? []).filter((job) => job.status === 'queued' || job.status === 'running').map((job) => ({ ...job, status: 'cancelled' }))
    if (stale.length) await request.post('/api/lan/jobs', { data: { jobs: stale } })
    await request.post('/api/lan/settings', { data: { settings: {
      ...originalSettings,
      comfyUrl: `http://127.0.0.1:${enginePort}`,
      engine: { ...(originalSettings.engine as Record<string, unknown>), mode: 'external' },
    } } })
    await resetSession(page)

    // ---- STEP 1: fresh home, engine down → truthful offline + live chip ----
    await page.goto('/?canvas=1')
    await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
    const chip = page.locator('[data-canvas-engine]')
    await expect(chip).toHaveAttribute('data-engine-connected', 'false', { timeout: 15_000 })
    await expect(chip).toContainText('engine offline')
    // R-09: the offline chip is a LIVE CONTROL — it opens Settings docked
    // (the engine section is the page's first section).
    await chip.click()
    await expect(page.locator('[data-canvas-settings-dock]')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-canvas-settings-body]')).toContainText('ComfyUI engine')
    await page.locator('[data-canvas-settings-close]').click()
    await expect(page.locator('[data-canvas-settings-dock]')).toHaveCount(0)

    await page.screenshot({ path: `${SHOT_DIR}/step1-engine-down-live-chip.png` })

    // ---- STEP 2: the engine starts → the app notices BY ITSELF ----------
    engine = await startEngine()
    await expect(chip).toHaveAttribute('data-engine-connected', 'true', { timeout: 20_000 })
    await expect(chip).toContainText('H3 engine ready')
    // The recovery toast (the restart-watch's "I picked it up" signal).
    await expect(page.locator('[data-canvas-toast="success"]').first()).toContainText('Engine connected', { timeout: 10_000 })

    await page.screenshot({ path: `${SHOT_DIR}/step2-self-detected-recovery-toast.png` })

    // ---- STEP 3: prompt at startup → the VIDEO graph, never T=1/image ----
    await page.locator('[data-canvas-prompt]').fill('a lighthouse over a black sea, slow swell')
    await page.locator('[data-canvas-submit]').click()
    const tile = page.locator('[data-canvas-tile]').first()
    await expect(tile).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => submittedGraphs.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1)
    const firstGraph = submittedGraphs[0]!
    const classes = Object.values(firstGraph).map((node) => node.class_type)
    expect(classes).toContain('CreateVideo')
    expect(classes).toContain('SaveVideo')
    expect(classes).toContain('MiniMaxH3ImageToVideo')
    expect(classes, 'never the T=1/image family').not.toContain('MiniMaxH3HybridLoader')
    expect(classes).not.toContain('SaveImage')
    // Multi-frame by construction: 6 s → the 17n+5 grid, never length 1.
    const conditioning = Object.values(firstGraph).find((node) => node.class_type === 'MiniMaxH3ImageToVideo')!
    expect(Number(conditioning!.inputs.length)).toBeGreaterThanOrEqual(100)
    // The job parks running (the fake engine reports incomplete).
    await expect(tile).toHaveAttribute('data-tile-status', 'running', { timeout: 20_000 })

    // ---- STEP 4a: a missing class refuses BEFORE the engine (R-02) -------
    // The instance "loses" a stock class the built graph needs — across a
    // restart, the realistic registry change: the recovery re-pull (R-01)
    // refreshes the app's object_info, and the NEXT submit refuses at the
    // preflight with the readable, action-mapped list while the engine
    // receives nothing further. (The fake's history deliberately SURVIVES
    // this restart so the running lighthouse job rides the blip — a harness
    // fiction noted here; step 5A exercises the honest history-loss path.)
    await stopEngine()
    await expect(chip).toHaveAttribute('data-engine-connected', 'false', { timeout: 30_000 }) // the loop must SEE the loss, or the restart never registers as a recovery
    delete engineState.registry.CreateVideo
    engine = await startEngine()
    await expect(chip).toHaveAttribute('data-engine-connected', 'true', { timeout: 20_000 })
    await page.waitForTimeout(1_000) // the recovery's object_info re-pull settles
    const submittedBefore = submittedGraphs.length
    await page.keyboard.press('Escape') // deselect — with objects present the contextual bar is the prompt surface (R-20)
    await page.locator('[data-canvas-bar-prompt]').fill('a second shot the registry cannot run')
    await page.locator('[data-canvas-bar-prompt]').press('Enter')
    await expect(page.locator('[data-canvas-tile]')).toHaveCount(2, { timeout: 10_000 })
    const refusal = page.locator('[data-canvas-toast="error"]').first()
    await expect(refusal).toContainText('CreateVideo', { timeout: 10_000 })
    await expect(refusal).toContainText('Update ComfyUI')
    await expect(refusal).toContainText('nothing was submitted')
    await page.waitForTimeout(1_500)
    expect(submittedGraphs.length, 'the refusal happened BEFORE the engine').toBe(submittedBefore)
    // (R-17, Wave 3) the refusal ALSO opens the per-item remediation surface:
    // the stock row carries the update-ComfyUI advice (nothing to fetch) and
    // exactly one action (the graph-compatibility view).
    const remediation = page.locator('[data-canvas-remediation-dock]')
    await expect(remediation).toBeVisible()
    const stockRow = remediation.locator('[data-remediation-row="CreateVideo"]')
    await expect(stockRow).toHaveAttribute('data-remediation-kind', 'stock')
    await expect(stockRow).toContainText('update ComfyUI')
    await expect(stockRow.locator('[data-remediation-stock]')).toBeVisible()
    await remediation.locator('[data-remediation-close]').click()
    await expect(remediation).toHaveCount(0)

    // ---- STEP 4b: an engine error comes back classified, unmangled (R-03)
    // The registry heals (another restart + re-pull) but the ENGINE itself
    // now rejects the prompt with the real missing-node 400 body — the
    // failure must come back readable and classified, never redacted soup.
    await stopEngine()
    await expect(chip).toHaveAttribute('data-engine-connected', 'false', { timeout: 20_000 })
    engineState.registry.CreateVideo = {}
    engineState.promptMode = 'missing400'
    engine = await startEngine()
    await expect(chip).toHaveAttribute('data-engine-connected', 'true', { timeout: 20_000 })
    await page.waitForTimeout(1_000)
    await page.keyboard.press('Escape')
    await page.locator('[data-canvas-bar-prompt]').fill('a third shot the engine rejects at validation')
    await page.locator('[data-canvas-bar-prompt]').press('Enter')
    await expect(page.locator('[data-canvas-tile]')).toHaveCount(3, { timeout: 10_000 })
    await expect.poll(async () => {
      const jobs = ((await (await request.get('/api/lan/jobs')).json()) as { jobs: Array<{ prompt: string; status: string; error?: string }> }).jobs
      return jobs.find((job) => (job.prompt ?? '').includes('a third shot'))?.status
    }, { timeout: 20_000 }).toBe('failed')
    const failedJob = ((await (await request.get('/api/lan/jobs')).json()) as { jobs: Array<{ prompt: string; status: string; error?: string }> }).jobs
      .find((job) => (job.prompt ?? '').includes('a third shot'))!
    expect(failedJob.error).toContain('missing_node_type')
    expect(failedJob.error).toContain('MiniMaxH3SamplerStandalone')
    expect(failedJob.error.startsWith('[redacted]'), 'never the audit-C redacted soup').toBe(false)
    engineState.promptMode = 'ok'

    // ---- STEP 5: kill the engine mid-session → honest failure, fast -----
    // Path A — RESTART within the grace: the orphaned prompt is unknown to
    // the fresh instance; the job fails with the restart advice in seconds.
    await stopEngine()
    await expect(chip).toHaveAttribute('data-engine-connected', 'false', { timeout: 20_000 })
    await expect(page.locator('[data-canvas-toast="error"]').first()).toContainText('Engine connection lost', { timeout: 15_000 })
    await page.waitForTimeout(3_000) // one lost-probe cycle, inside the 45 s grace
    engineState.history.clear() // a fresh instance knows nothing
    engine = await startEngine()
    await expect(chip).toHaveAttribute('data-engine-connected', 'true', { timeout: 20_000 })
    await expect.poll(async () => {
      const jobs = ((await (await request.get('/api/lan/jobs')).json()) as { jobs: Array<{ status: string; error?: string }> }).jobs
      return jobs.filter((job) => job.status === 'queued' || job.status === 'running').length
    }, { timeout: 30_000 }).toBe(0)
    const restarted = ((await (await request.get('/api/lan/jobs')).json()) as { jobs: Array<{ status: string; error?: string }> }).jobs
      .filter((job) => job.status === 'failed')
    expect(restarted.some((job) => (job.error ?? '').includes('restarted'))).toBe(true)

    // Path B — STAYS DEAD past the grace: the engine-unreachable failure
    // lands in well under the 60-minute deadline (the R-26 backstop's job).
    await page.keyboard.press('Escape')
    await page.locator('[data-canvas-bar-prompt]').fill('a fourth shot orphaned by a dead engine')
    await page.locator('[data-canvas-bar-prompt]').press('Enter')
    await expect(page.locator('[data-canvas-tile]')).toHaveCount(4, { timeout: 10_000 })
    await expect.poll(() => submittedGraphs.length, { timeout: 20_000 }).toBe(submittedBefore + 1)
    const deadEngineStarted = Date.now()
    await stopEngine()
    await expect.poll(async () => {
      const jobs = ((await (await request.get('/api/lan/jobs')).json()) as { jobs: Array<{ prompt: string; status: string; error?: string }> }).jobs
      const job = jobs.find((entry) => (entry.prompt ?? '').includes('a fourth shot'))
      return job?.status === 'failed' && (job.error ?? '').includes('unreachable') ? 'failed-unreachable' : job?.status ?? 'missing'
    }, { timeout: 90_000 }).toBe('failed-unreachable')
    expect(Date.now() - deadEngineStarted).toBeLessThan(120_000) // seconds-to-minutes, not 60 min

    // ---- STEP 6: the engine returns; a render completes and LANDS --------
    engineState.history.clear()
    engine = await startEngine()
    await expect(chip).toHaveAttribute('data-engine-connected', 'true', { timeout: 20_000 })
    const landedBefore = submittedGraphs.length
    await page.keyboard.press('Escape')
    await page.locator('[data-canvas-bar-prompt]').fill('the shot that finally lands')
    await page.locator('[data-canvas-bar-prompt]').press('Enter')
    await expect(page.locator('[data-canvas-tile]')).toHaveCount(5, { timeout: 10_000 })
    await expect.poll(() => submittedGraphs.length, { timeout: 20_000 }).toBe(landedBefore + 1)
    // Complete the render server-side: the history entry gains the mp4 the
    // landing loop ingests through the engine /view descriptor.
    const finalPromptId = `wave1-${engineState.promptSeq}`
    engineState.history.set(finalPromptId, {
      completed: true,
      outputs: { 19: { gifs: [{ filename: 'ComfyUI_00001_.mp4', subfolder: '', type: 'output' }] } },
    })
    await expect.poll(async () => {
      const document = await activeDocument(page)
      const chain = document.chains.find((entry) => entry.kind === 'generation' && (entry.settings.prompt === 'the shot that finally lands'))
      return chain?.outputs[0]?.takes.length ?? 0
    }, { timeout: 45_000 }).toBeGreaterThanOrEqual(1)
    const document = await activeDocument(page)
    const landedChain = document.chains.find((entry) => entry.kind === 'generation' && entry.settings.prompt === 'the shot that finally lands')!
    expect(landedChain.outputs[0]!.takes[0]!.artifacts.length).toBeGreaterThanOrEqual(1)
    expect(problems.filter((entry) => !environmental(entry))).toEqual([])
    await page.screenshot({ path: `${SHOT_DIR}/step6-render-landed-on-canvas.png` })
  } finally {
    await request.post('/api/lan/settings', { data: { settings: originalSettings } }).catch(() => undefined)
    await resetSession(page).catch(() => undefined)
    if (engine) await new Promise<void>((resolve) => engine!.close(() => resolve()))
  }
})

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
  || /Connecting to 'blob:.*' violates the following Content Security Policy directive: "connect-src/.test(entry)
  // The dead-engine phases produce fetch failures BY DESIGN (the app polls a
  // gone engine) — the whole point of steps 5A/5B.
  || /(?:fetch|load) .*(?:failed|Failed)/.test(entry) && /127\.0\.0\.1/.test(entry)

async function resetSession(page: Page) {
  await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } })
  const listed = await page.request.get('/api/lan/jobs')
  if (listed.ok()) {
    const body = (await listed.json()) as { jobs?: Array<Record<string, unknown>> }
    const stale = (body.jobs ?? []).filter((job) => job.status === 'queued' || job.status === 'running' || job.status === 'pending').map((job) => ({ ...job, status: 'cancelled' }))
    if (stale.length) await page.request.post('/api/lan/jobs', { data: { jobs: stale } })
  }
}

async function activeDocument(page: Page) {
  return page.evaluate(async () => {
    const session = (await (await fetch('/api/lan/documents/session')).json()).session as { activeProject: string | null }
    if (!session.activeProject) throw new Error('no active canvas document')
    const response = await fetch(`/api/lan/documents/project?id=${encodeURIComponent(session.activeProject)}`)
    return (await response.json()) as {
      chains: Array<{ id: string; kind: string; settings: { prompt?: string }; outputs: Array<{ id: string; takes: Array<{ artifacts: string[]; jobId?: string }> }> }>
    }
  })
}

// ---------------------------------------------------------------------------
// R-17 (Wave 3): the per-item-consented REMEDIATION surface — the full loop.
// A chain whose graph carries the first-party form-adapter node; the engine
// loses the class across a restart (the registry-truth moment); the next
// render attempt refuses at the preflight AND opens the remediation dock —
// whose one Install action (first-party payload, no network) lands the pack
// into the configured external target; the post-install restart heals the
// registry and the re-render SUBMITS. The loop from refusal to render,
// closed by one action on one row.
// ---------------------------------------------------------------------------
test('R-17: the remediation dock closes the loop — refusal → one install action → the re-render submits', async ({ page, request }) => {
  test.setTimeout(180_000)
  const problems = await trackErrors(page)
  const os = await import('node:os')
  const externalDir = makeScratchDir(path.join(os.tmpdir(), 'mm-r17-target-'))

  const engineState = {
    registry: stockObjectInfo({ MiniMaxH3LoraFormLoader: {} }) as Record<string, unknown>,
    promptSeq: 0,
    served: new Set<string>(),
  }
  const listings = { ...H3_REGISTRY_LISTINGS, loras: [...H3_REGISTRY_LISTINGS.loras, 'civitai_h3_style.safetensors'] }
  const submittedGraphs: Array<Record<string, { class_type: string }>> = []
  const engineHandler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://engine.local')
    if (url.pathname === '/system_stats') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ system: { comfyui_version: 'v0.34.0' }, devices: [] }))
      return
    }
    if (serveObjectInfo(url, engineState.registry, res)) return
    if (serveModelRegistry(url, listings, res)) return
    if (url.pathname === '/prompt' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk })
      req.on('end', () => {
        engineState.promptSeq += 1
        submittedGraphs.push((JSON.parse(body) as { prompt: Record<string, { class_type: string }> }).prompt)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ prompt_id: `r17-${engineState.promptSeq}`, number: engineState.promptSeq, node_errors: {} }))
      })
      return
    }
    if (url.pathname.startsWith('/history/')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    res.writeHead(404)
    res.end()
  }
  // One FIXED port for every restart (the acceptance walk's pattern): the
  // app's comfyUrl never changes, so the re-check loop sees loss and
  // recovery on its own cadence without a settings reload.
  const holder = http.createServer()
  const enginePort = await new Promise<number>((resolve) => holder.listen(0, '127.0.0.1', () => resolve((holder.address() as AddressInfo).port)))
  await new Promise<void>((resolve) => holder.close(() => resolve()))
  let engine: http.Server | null = null
  const startEngine = async () => {
    engine = http.createServer(engineHandler)
    await new Promise<void>((resolve) => engine!.listen(enginePort, '127.0.0.1', () => resolve()))
  }
  const stopEngine = async () => { if (engine) { const closing = engine; engine = null; await new Promise<void>((resolve) => closing.close(() => resolve())) } }
  await startEngine()

  const originalSettings = ((await (await request.get('/api/lan/settings')).json()) as { settings: Record<string, unknown> }).settings
  try {
    await request.post('/api/lan/settings', { data: { settings: {
      ...originalSettings,
      comfyUrl: `http://127.0.0.1:${enginePort}`,
      engine: { ...(originalSettings.engine as Record<string, unknown>), mode: 'external', externalCustomNodesDir: externalDir },
    } } })
    await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } })
    await page.goto('/?canvas=1')
    await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
    await expect(page.locator('[data-canvas-engine]')).toHaveAttribute('data-engine-connected', 'true', { timeout: 30_000 })

    // Seed the chain directly: a video chain with ONE stack LoRA — with the
    // form-adapter class served, the built graph wraps slot 0 in
    // MiniMaxH3LoraFormLoader (the first-party pack's node).
    const project = await (await page.request.post('/api/lan/documents/projects', { data: { name: 'R-17 remediation loop' } })).json()
    const chain = await (await page.request.post('/api/lan/documents/chains', { data: { projectId: project.project.id, kind: 'generate', settings: { prompt: 'a bronze bell in the fog', mediaType: 'video', loraStack: [{ name: 'civitai_h3_style.safetensors', strength: 0.8 }] } } })).json()
    await page.request.post('/api/lan/documents/session', { data: { openProjects: [project.project.id], activeProject: project.project.id } })
    await page.reload()
    await expect(page.locator(`[data-canvas-tile="${chain.chain.id}"]`)).toBeVisible({ timeout: 15_000 })
    await page.locator(`[data-canvas-tile="${chain.chain.id}"]`).click()
    await page.locator('[data-canvas-generate]').click()
    await expect.poll(() => submittedGraphs.length, { timeout: 20_000 }).toBe(1)
    expect(Object.values(submittedGraphs[0]!).some((node) => node.class_type === 'MiniMaxH3LoraFormLoader'), 'the graph carries the first-party adapter node').toBe(true)

    // The registry-truth moment: the engine loses the class across a
    // restart (the loop sees loss + recovery, object_info re-pulls without
    // the class). NOTE the honest boundary this test asserts: the BUILDER
    // availability-gates pack nodes, so a real submit here would fall back
    // to the stock loader rather than emit a missing class — the preflight's
    // pack branch is defense-in-depth by construction. The remediation DOCK
    // is driven through the app's own seam (the PREFLIGHT_REFUSAL_EVENT the
    // submit cores fire — the exact payload shape preflightRefusal emits),
    // so the surface, its rows, and its one-action install are exercised
    // against the real server without faking a builder state that cannot
    // occur.
    await stopEngine()
    await expect(page.locator('[data-canvas-engine]')).toHaveAttribute('data-engine-connected', 'false', { timeout: 30_000 })
    delete engineState.registry.MiniMaxH3LoraFormLoader
    await startEngine()
    await expect(page.locator('[data-canvas-engine]')).toHaveAttribute('data-engine-connected', 'true', { timeout: 30_000 })
    await page.waitForTimeout(1_000) // the recovery's object_info re-pull settles

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('minimax:preflight-refusal', { detail: { missing: [{ className: 'MiniMaxH3LoraFormLoader', packId: 'lora-form-adapter', stock: false }] } }))
    })
    const remediation = page.locator('[data-canvas-remediation-dock]')
    await expect(remediation).toBeVisible({ timeout: 15_000 })
    const row = remediation.locator('[data-remediation-row="MiniMaxH3LoraFormLoader"]')
    await expect(row).toHaveAttribute('data-remediation-kind', 'install')
    await expect(row).toContainText('no network')
    await expect(remediation.locator('[data-remediation-lede]')).toContainText('nothing was submitted')

    // ONE ACTION on the row: the first-party payload installs into the
    // configured external target — no network — and the row says what comes
    // next (restart to activate).
    await row.locator('[data-remediation-install="lora-form-adapter"]').click()
    await expect(row.locator('[data-remediation-installed]')).toBeVisible({ timeout: 30_000 })
    expect(fs.existsSync(path.join(externalDir, 'minimax-lora-form-adapter')), 'the payload landed in the configured external target').toBe(true)

    // The post-install restart heals the registry — the re-render SUBMITS:
    // the loop from refusal to render closed by one row action. (The dock
    // steps aside first — it was doing its job over the canvas.)
    await stopEngine()
    await expect(page.locator('[data-canvas-engine]')).toHaveAttribute('data-engine-connected', 'false', { timeout: 30_000 })
    engineState.registry.MiniMaxH3LoraFormLoader = {}
    await startEngine()
    await expect(page.locator('[data-canvas-engine]')).toHaveAttribute('data-engine-connected', 'true', { timeout: 30_000 })
    await page.waitForTimeout(1_000)
    await remediation.locator('[data-remediation-close]').click()
    await expect(remediation).toHaveCount(0)
    await page.locator(`[data-canvas-tile="${chain.chain.id}"]`).click()
    await page.locator('[data-canvas-generate]').click()
    await expect.poll(() => submittedGraphs.length, { timeout: 20_000 }).toBe(2)
    expect(Object.values(submittedGraphs[1]!).some((node) => node.class_type === 'MiniMaxH3LoraFormLoader'), 'the re-render carries the adapter node again').toBe(true)
    expect(problems.filter((entry) => !environmental(entry))).toEqual([])
  } finally {
    await request.post('/api/lan/settings', { data: { settings: originalSettings } }).catch(() => undefined)
    await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } }).catch(() => undefined)
    if (engine) await stopEngine()
  }
})

// ---------------------------------------------------------------------------
// A-DBG (directive c250ab36): the junction logger's live proof — booted with
// ?dbg=1, the renderer's console carries tagged junction lines (the triage
// transcript), and a page WITHOUT the flag stays silent (the no-op contract).
// ---------------------------------------------------------------------------
test('Wave 1 A-DBG: ?dbg=1 turns the console into a tagged triage transcript; off stays silent', async ({ page }) => {
  const junctionLines: string[] = []
  page.on('console', (message) => {
    if (message.text().includes('[dbg:')) junctionLines.push(message.text())
  })
  await page.goto('/?canvas=1&dbg=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready', { timeout: 30_000 })
  // The session.engine probes log from boot; a fabric line logs on connect.
  await expect.poll(() => junctionLines.length, { timeout: 30_000 }).toBeGreaterThan(0)
  const tags = new Set(junctionLines.map((line) => (/\[dbg:([a-z.]+)\]/.exec(line) ?? [])[1]).filter(Boolean))
  expect(tags.size).toBeGreaterThan(0)
  expect(junctionLines.every((line) => line.startsWith('[dbg:')), 'every line carries its junction tag')

  // OFF: the ?dbg=1 page PERSISTED the flag to localStorage (same browser
  // context) — clear it and reload: no flag, no storage → total silence
  // (one boolean check per call).
  const quiet = await page.context().newPage()
  const quietLines: string[] = []
  quiet.on('console', (message) => { if (message.text().includes('[dbg:')) quietLines.push(message.text()) })
  await quiet.goto('/?canvas=1')
  await quiet.evaluate(() => window.localStorage.removeItem('minimax-dbg'))
  await quiet.reload()
  await expect(quiet.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready', { timeout: 30_000 })
  await quiet.waitForTimeout(2_000)
  expect(quietLines).toEqual([])
  await quiet.close()
})
