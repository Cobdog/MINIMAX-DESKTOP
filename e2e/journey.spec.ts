import http from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

/**
 * THE JOURNEY-SWEEP ACCEPTANCE WALK (task c4fifi5 — reality audit
 * 2026-09-25 punch items #4/#6/#7/#9/#3): the maintainer's journey against
 * THE ENVIRONMENT MIRROR (e2e/mirror/fakeEngineServer.mjs + the
 * maintainer-instance profile — the standing artifact, not an inline stub).
 *
 *   #9  the wizard SURVIVES connection (the audit's F1: it vanished the
 *       moment the engine connected; steps 2-4 were unreachable) and
 *       reopens on demand from Settings.
 *   #4a the footer spawn bar carries the image/video lane toggle (F6:
 *       every post-first-chain spawn was a video chain).
 *   #4c an image chain is never labeled "text → video" (F8's mislabel).
 *   #4b the image lane's unavailable regeneration refuses honestly NAMING
 *       the Mamad8 T=1 gate at the point of choice (F8/M5).
 *   #7  the turbo fetch affordance never points at a catalog without the
 *       goods (F10: "fetch missing (8)" over an empty catalog).
 *   #6  a validation rejection never shows the literal `[redacted]` token
 *       (F11 — the Wave-1 bar extended to the validation surface).
 *   #3  live previews ROUTE through the PreviewOverride pack on the mirror
 *       (M6/C7 — the pack-class node appears in the submitted graph).
 *
 * Harness discipline: the mirror is a child process on a reserved ephemeral
 * port; the studio NEVER touches 8188/8189; settings are swapped + restored
 * around the walk (the wave1.spec.ts pattern); teardown is verified.
 */

const MIRROR_PROFILE = 'e2e/mirror/profiles/maintainer-instance.json'

type MirrorHistoryEntry = {
  prompt?: Array<Record<string, unknown>>
  outputs?: Record<string, unknown>
  status?: { status_str?: string; completed?: boolean }
}

async function mirrorJson(port: number, pathname: string, init?: { method?: string; body?: string }) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, init)
  return (await response.json()) as Record<string, unknown>
}

test('Journey sweep — the maintainer\'s walk on the environment mirror (#4/#6/#7/#9/#3)', async ({ page, request }) => {
  test.setTimeout(240_000)
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))

  // The mirror: the STANDING fake engine as a child process, on a port we
  // reserve first (nothing assumes 4199/5173/8188/8189 are ours).
  const holder = http.createServer(() => undefined)
  const mirrorPort = await new Promise<number>((resolve) => holder.listen(0, '127.0.0.1', () => resolve((holder.address() as AddressInfo).port)))
  await new Promise<void>((resolve) => holder.close(() => resolve()))
  const mirror: ChildProcess = spawn('node', [path.join(process.cwd(), 'e2e/mirror/fakeEngineServer.mjs'), '--port', String(mirrorPort), '--profile', MIRROR_PROFILE], { stdio: ['ignore', 'pipe', 'pipe'] })
  let mirrorLog = ''
  mirror.stdout?.on('data', (chunk: Buffer) => { mirrorLog += chunk.toString() })
  mirror.stderr?.on('data', (chunk: Buffer) => { mirrorLog += chunk.toString() })
  try {
    await expect.poll(async () => {
      try { await mirrorJson(mirrorPort, '/system_stats'); return true } catch { return false }
    }, { timeout: 15_000 }).toBe(true)

    // The studio points at the mirror BEFORE any page opens (the settings
    // POST pattern — the app must never probe its default URL).
    const originalSettings = ((await (await request.get('/api/lan/settings')).json()) as { settings: Record<string, unknown> }).settings
    const listed = ((await (await request.get('/api/lan/jobs')).json()) as { jobs?: Array<Record<string, unknown>> }).jobs
    const stale = (listed ?? []).filter((job) => job.status === 'queued' || job.status === 'running').map((job) => ({ ...job, status: 'cancelled' }))
    if (stale.length) await request.post('/api/lan/jobs', { data: { jobs: stale } })
    await request.post('/api/lan/settings', { data: { settings: {
      ...originalSettings,
      comfyUrl: `http://127.0.0.1:${mirrorPort}`,
      engine: { ...(originalSettings.engine as Record<string, unknown>), mode: 'external' },
    } } })
    await resetSession(page)

    // ---- STEP 1 (#9): the engine is UP at boot — the wizard still shows --
    // (F1: with a connected engine the registry is never empty, and the old
    // guard unmounted the wizard the moment models arrived. Steps 2-4 were
    // unreachable for exactly the maintainer's setup.)
    await page.goto('/?canvas=1')
    await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
    const wizard = page.locator('[data-canvas-wizard]')
    await expect(wizard).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('[data-canvas-engine]')).toHaveAttribute('data-engine-connected', 'true', { timeout: 20_000 })
    // …and it STAYS visible after the registry fills (the vanishing bug).
    await expect(page.locator('[data-canvas-bar-engine], [data-canvas-engine]').first()).toContainText('ready', { timeout: 20_000 })
    await expect(wizard).toBeVisible()
    await expect(wizard).toHaveAttribute('data-wizard-step', '0')
    await expect(wizard).toContainText('1 of 4 — Engine')

    // ---- STEP 2 (#9): steps 2-4 are completable (the audit's unreachable) -
    await page.locator('[data-wizard-next]').click()
    await expect(wizard).toHaveAttribute('data-wizard-step', '1')
    await expect(wizard).toContainText('2 of 4 — Models')
    // The registry step reads the ENGINE's models (the mirror serves 15 files
    // across 5 folders — a connected instance, not an empty one).
    await expect(page.locator('[data-wizard-registry]')).toContainText('diffusion models', { timeout: 10_000 })
    await page.locator('[data-wizard-next]').click()
    await expect(wizard).toHaveAttribute('data-wizard-step', '2')
    await expect(wizard).toContainText('3 of 4 — Node packs')
    await page.locator('[data-wizard-next]').click()
    await expect(wizard).toHaveAttribute('data-wizard-step', '3')
    await expect(wizard).toContainText('4 of 4 — First prompt')
    // Skippable (never a nag)…
    await page.locator('[data-wizard-skip]').click()
    await expect(wizard).toHaveCount(0)

    // ---- STEP 3 (#9): the way back in — Settings reopens it on demand ----
    await page.locator('[data-canvas-settings-button]').click()
    await expect(page.locator('[data-canvas-settings-dock]')).toBeVisible({ timeout: 10_000 })
    await page.locator('[data-settings-reopen-wizard]').click()
    await expect(wizard).toBeVisible({ timeout: 10_000 })
    await expect(wizard).toContainText('1 of 4 — Engine')
    // …and the dock closed behind the reopened wizard (one journey at a time).
    await expect(page.locator('[data-canvas-settings-dock]')).toHaveCount(0)
    await page.locator('[data-wizard-skip]').click()
    await expect(wizard).toHaveCount(0)

    // ---- STEP 4: the first video render (feeds #3's graph check) ---------
    await page.locator('[data-canvas-prompt]').fill('a lighthouse over a black sea, slow push-in')
    await page.locator('[data-canvas-submit]').click()
    const firstTile = page.locator('[data-canvas-tile]').first()
    await expect(firstTile).toBeVisible({ timeout: 15_000 })
    await expect(firstTile).toHaveAttribute('data-tile-status', 'idle', { timeout: 60_000 })

    // ---- STEP 5 (#3): the PreviewOverride pack owns this render's preview -
    // (M6/C7: PR #48 claims the pack routes when present; the audit's walk
    // found no override node in the graph the engine received. The mirror
    // serves the pack classes + taeh3 files — the submitted graph must carry
    // the pack's node with the taeh3 decoder by name.)
    await expect.poll(async () => {
      const history = (await mirrorJson(mirrorPort, '/history')) as Record<string, MirrorHistoryEntry>
      return Object.values(history).some((entry) => {
        const graph = (entry.prompt?.[0] ?? {}) as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>
        return Object.values(graph).some((node) => typeof node?.class_type === 'string' && /MiniMaxH3PreviewOverride/.test(node.class_type))
      })
    }, { timeout: 20_000 }).toBe(true)
    // …with the decoder the mirror actually serves (the taeh3 fallback pick).
    const history = (await mirrorJson(mirrorPort, '/history')) as Record<string, MirrorHistoryEntry>
    const videoGraph = Object.values(history).flatMap((entry) => {
      const graph = (entry.prompt?.[0] ?? {}) as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>
      return Object.values(graph)
    })
    const overrideNode = videoGraph.find((node) => typeof node?.class_type === 'string' && /MiniMaxH3PreviewOverride/.test(node.class_type!))
    expect(overrideNode?.inputs?.vae_name).toBe('taeh3_alpha.safetensors')

    // ---- STEP 6 (#4a): the footer spawn bar carries the lane toggle ------
    // (F6: once a chain exists the bar was video-only — the image lane had no
    // entrance after the hero.) Deselect, then the bar's empty context shows.
    await page.keyboard.press('Escape')
    const bar = page.locator('[data-canvas-bottombar]')
    await expect(bar).toHaveAttribute('data-canvas-bar-context', 'empty', { timeout: 10_000 })
    await expect(bar.locator('[data-canvas-bar-prompt]')).toBeVisible()
    await bar.locator('[data-canvas-bar-lane-toggle="image"]').click()
    await expect(bar.locator('[data-canvas-bar-lane="image"]')).toBeVisible()
    await bar.locator('[data-canvas-bar-prompt]').fill('a crisp product shot of a brass compass on chart paper')
    await bar.locator('[data-canvas-bar-prompt]').press('Enter')
    const tiles = page.locator('[data-canvas-tile]')
    await expect(tiles).toHaveCount(2, { timeout: 15_000 })

    // ---- STEP 7 (#4c): the image chain is never labeled "text → video" ---
    // The spawned image tile is selected by the spawn; the contextual bar's
    // mode chip must speak the image vocabulary (F8's mislabel dies).
    const barMode = bar.locator('[data-canvas-bar-mode]')
    await expect(bar).toHaveAttribute('data-canvas-bar-context', 'chain', { timeout: 10_000 })
    await expect(barMode).toHaveText(/image/i, { timeout: 10_000 })
    await expect(barMode).not.toHaveText(/video/i)

    // ---- STEP 8 (#4b): the honest Mamad8 gate at the point of choice -----
    // The image chain's generate refuses with the workbench ladder's honest
    // reason: the missing T=1 VAE FILE is named (the mirror serves neither
    // the Mamad8 decoder nor the Image Studio pack classes). The spawn
    // selected the tile and opened the inspector (the submitPrompt contract).
    const panel = page.locator('[data-canvas-properties]')
    await expect(panel).toBeVisible({ timeout: 10_000 })
    await expect(panel.locator('[data-canvas-validation]')).toContainText('minimax_h3_t1_image_vae', { timeout: 10_000 })
    await expect(panel.locator('[data-canvas-mode]')).not.toHaveText(/video/i)

    // ---- STEP 9 (#7): the fetch affordance never promises an empty catalog -
    // The mirror's registry carries the official turbo LoRA only: 8 of 9
    // families are missing and the fetch catalog has ZERO turbo rows. The
    // dead-end promise ("fetchable there") must be gone.
    const videoTile = page.locator('[data-canvas-tile]', { hasText: 'lighthouse' })
    await videoTile.click()
    // The completed video render landed its take — the tile is a MEDIA object
    // (transport + properties in the bar).
    await expect(bar).toHaveAttribute('data-canvas-bar-context', 'media', { timeout: 10_000 })
    await page.locator('[data-canvas-bar-properties]').click()
    await expect(panel.locator('[data-canvas-section="engine"]')).toBeVisible()
    await expect(panel.locator('[data-canvas-turbo-fetch]')).toHaveCount(0)
    await expect(panel.locator('[data-canvas-turbo-fetch-note]')).toBeVisible()
    const noteText = await panel.locator('[data-canvas-turbo-fetch-note]').innerText()
    expect(noteText.toLowerCase()).not.toContain('fetchable there')

    // ---- STEP 10 (#6): a validation rejection carries no [redacted] token -
    await mirrorJson(mirrorPort, '/__control', { method: 'POST', body: JSON.stringify({ failMode: 'validation' }) })
    await page.locator('[data-canvas-generate]').click()
    const validationToast = page.locator('[data-canvas-toast="error"]', { hasText: 'Graph validation failed' })
    await expect(validationToast.first()).toBeVisible({ timeout: 20_000 })
    const toastText = (await validationToast.first().innerText()).trim()
    expect(toastText.includes('[redacted]'), `the toast must carry no redaction marker (got: ${toastText})`).toBe(false)
    for (const token of ['MiniMaxH3ImageToVideo', 'value_smaller_than_min']) {
      expect(toastText.includes(token), `the structural signal survives: ${token} (got: ${toastText})`).toBe(true)
    }
    // The persisted job error carries no marker either (the failed card's
    // alert renders it).
    await expect.poll(async () => {
      const jobs = ((await (await request.get('/api/lan/jobs')).json()) as { jobs: Array<{ status: string; error?: string }> }).jobs
      return jobs.find((job) => (job.error ?? '').includes('Graph validation failed'))?.error ?? ''
    }, { timeout: 15_000 }).resolves
    const jobs = ((await (await request.get('/api/lan/jobs')).json()) as { jobs: Array<{ status: string; error?: string }> }).jobs
    const validationError = jobs.find((job) => (job.error ?? '').includes('Graph validation failed'))?.error ?? ''
    expect(validationError.includes('[redacted]'), `the job error must carry no marker (got: ${validationError})`).toBe(false)
    await mirrorJson(mirrorPort, '/__control', { method: 'POST', body: JSON.stringify({ failMode: null }) })

    // No harness-caused page errors (business failures are honest toasts).
    expect(problems, `page errors: ${problems.join(' | ')}`).toEqual([])

    // ---- teardown ----------------------------------------------------------
    await request.post('/api/lan/settings', { data: { settings: originalSettings } })
    await resetSession(page)
  } finally {
    mirror.kill('SIGINT')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { mirror.kill('SIGKILL'); resolve() }, 5_000)
      mirror.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
  // The child actually exited (never an orphaned fake engine): a signal kill
  // leaves exitCode null and `signal` set — either way the process is gone.
  expect(mirror.exitCode !== null || mirror.signalCode !== null).toBe(true)
  expect(mirrorLog).not.toContain('EADDRINUSE')
})

async function resetSession(page: Page) {
  await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } })
  const listed = await page.request.get('/api/lan/jobs')
  if (listed.ok()) {
    const body = (await listed.json()) as { jobs?: Array<Record<string, unknown>> }
    const stale = (body.jobs ?? []).filter((job) => job.status === 'queued' || job.status === 'running' || job.status === 'pending').map((job) => ({ ...job, status: 'cancelled' }))
    if (stale.length) await page.request.post('/api/lan/jobs', { data: { jobs: stale } })
  }
}

/** THE REFERENCE-PREP RULING (maintainer 2026-09-26, directive 1e363ec0
 *  item 5): "scaled longest side to the selected resolution. Never
 *  cropped." Proven at WIRING truth on the environment mirror: a 1:2
 *  portrait reference bound to a 1344x768 (16:9) render must reach the
 *  engine as a 672x1344 PNG — longest side matched, aspect preserved, zero
 *  crop. The old path cover-cropped it into the output ratio (1344x768),
 *  destroying half the reference; the conditioning node takes unconstrained
 *  IMAGE refs and scales them itself, so the true aspect is what it wants.
 *  The proof reads the PNG the engine ACTUALLY received (IHDR of the
 *  uploaded bytes served back from the mirror's /view). */
test('reference prep on the mirror: longest side to the resolution, aspect preserved, never cropped', async ({ page, request }) => {
  test.setTimeout(240_000)
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))

  const holder = http.createServer(() => undefined)
  const mirrorPort = await new Promise<number>((resolve) => holder.listen(0, '127.0.0.1', () => resolve((holder.address() as AddressInfo).port)))
  await new Promise<void>((resolve) => holder.close(() => resolve()))
  const mirror: ChildProcess = spawn('node', [path.join(process.cwd(), 'e2e/mirror/fakeEngineServer.mjs'), '--port', String(mirrorPort), '--profile', MIRROR_PROFILE], { stdio: ['ignore', 'pipe', 'pipe'] })
  let mirrorLog = ''
  mirror.stdout?.on('data', (chunk: Buffer) => { mirrorLog += chunk.toString() })
  mirror.stderr?.on('data', (chunk: Buffer) => { mirrorLog += chunk.toString() })
  try {
    await expect.poll(async () => {
      try { await mirrorJson(mirrorPort, '/system_stats'); return true } catch { return false }
    }, { timeout: 15_000 }).toBe(true)
    const originalSettings = ((await (await request.get('/api/lan/settings')).json()) as { settings: Record<string, unknown> }).settings
    await request.post('/api/lan/settings', { data: { settings: {
      ...originalSettings,
      comfyUrl: `http://127.0.0.1:${mirrorPort}`,
      engine: { ...(originalSettings.engine as Record<string, unknown>), mode: 'external' },
    } } })
    await resetSession(page)

    await page.goto('/?canvas=1')
    await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
    await expect(page.locator('[data-canvas-engine]')).toHaveAttribute('data-engine-connected', 'true', { timeout: 20_000 })
    // The render chain (16:9 default → 1344x768; longest side 1344).
    await page.locator('[data-canvas-prompt]').fill('a tall glass tower over a frozen lake, reference study')
    await page.locator('[data-canvas-submit]').click()
    await expect(page.locator('[data-canvas-tile]')).toHaveCount(1, { timeout: 15_000 })
    // Drop a 1:2 PORTRAIT reference (500x1000).
    await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 500
      canvas.height = 1000
      const context = canvas.getContext('2d')!
      context.fillStyle = '#2b3a55'
      context.fillRect(0, 0, 500, 1000)
      context.fillStyle = '#e8b04b'
      context.fillRect(120, 300, 260, 400)
      const dataUrl = canvas.toDataURL('image/png')
      const binary = atob(dataUrl.split(',')[1])
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      const transfer = new DataTransfer()
      transfer.items.add(new File([bytes], 'portrait-reference.png', { type: 'image/png' }))
      document.querySelector('[data-canvas-root]')!.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }))
    })
    await expect(page.locator('[data-canvas-tile]')).toHaveCount(2, { timeout: 15_000 })
    // Bind it as the render's reference (the drop + documents-API write).
    const document = await (await page.evaluate(async () => {
      const session = await (await fetch('/api/lan/documents/session')).json() as { session: { activeProject: string | null } }
      const response = await fetch(`/api/lan/documents/project?id=${encodeURIComponent(session.session.activeProject!)}`)
      return (await response.json()) as {
        chains: Array<{ id: string; kind: string; settings: Record<string, unknown>; outputs: Array<{ id: string }> }>
      }
    }))
    const renderChain = document.chains.find((chain) => chain.kind === 'generation')!
    const mediaChain = document.chains.find((chain) => chain.kind === 'media')!
    await page.request.post('/api/lan/documents/chains/update', { data: { id: renderChain.id, settings: { ...renderChain.settings, referenceOutputIds: [mediaChain.outputs[0]!.id] } } })
    await page.reload()
    await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
    await page.locator(`[data-canvas-tile="${renderChain.id}"]`).click()
    await expect(page.locator('[data-canvas-properties]')).toBeVisible({ timeout: 10_000 })

    // Generate: the reference-mode render uploads the PREPARED reference,
    // then submits the graph naming it.
    await page.locator('[data-canvas-generate]').click()

    type GraphNode = { class_type?: string; inputs?: Record<string, unknown> }
    const findReferenceGraph = async () => {
      const history = (await mirrorJson(mirrorPort, '/history')) as Record<string, MirrorHistoryEntry>
      for (const entry of Object.values(history)) {
        const graph = (entry.prompt?.[0] ?? {}) as Record<string, GraphNode>
        if (Object.values(graph).some((node) => node.class_type === 'MiniMaxH3ReferenceToVideo')) return graph
      }
      return null
    }
    await expect.poll(() => findReferenceGraph().then((graph) => graph !== null), { timeout: 30_000 }).toBe(true)
    const referenceGraph = (await findReferenceGraph())!
    const conditioning = Object.values(referenceGraph).find((node) => node.class_type === 'MiniMaxH3ReferenceToVideo')!
    // The output latent stays the selected 16:9 resolution.
    expect(conditioning.inputs?.width).toBe(1344)
    expect(conditioning.inputs?.height).toBe(768)
    // The reference slot names the uploaded file; fetch its bytes back.
    const refLink = conditioning.inputs?.['ref_images.ref_image_0'] as [string, number]
    expect(Array.isArray(refLink)).toBe(true)
    const loadImage = referenceGraph[refLink[0]]
    const uploadedName = String((loadImage.inputs as { image?: unknown } | undefined)?.image ?? '').split('/').pop() as string
    expect(uploadedName.endsWith('.png')).toBe(true)
    const view = await fetch(`http://127.0.0.1:${mirrorPort}/view?filename=${encodeURIComponent(uploadedName)}`)
    expect(view.status).toBe(200)
    const png = new Uint8Array(await view.arrayBuffer())
    // PNG IHDR: width/height are big-endian uint32 at bytes 16 and 20.
    const readUint32 = (offset: number) => (png[offset]! * 2 ** 24) + (png[offset + 1]! * 2 ** 16) + (png[offset + 2]! * 2 ** 8) + png[offset + 3]!
    const width = readUint32(16)
    const height = readUint32(20)
    // THE RULING, on the bytes the engine received: 1:2 portrait at a 16:9
    // resolution → 672x1344 — longest side matched to 1344, aspect exactly
    // preserved, ZERO crop (the old path delivered a cropped 1344x768).
    expect({ width, height }).toEqual({ width: 672, height: 1344 })
    expect(Math.abs(width / height - 500 / 1000)).toBeLessThan(0.01)

    expect(problems, `page errors: ${problems.join(' | ')}`).toEqual([])

    await request.post('/api/lan/settings', { data: { settings: originalSettings } })
    await resetSession(page)
  } finally {
    mirror.kill('SIGINT')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { mirror.kill('SIGKILL'); resolve() }, 5_000)
      mirror.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
  expect(mirror.exitCode !== null || mirror.signalCode !== null).toBe(true)
  expect(mirrorLog).not.toContain('EADDRINUSE')
})
