import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { expect, test, type Page } from '@playwright/test'

// Canvas Phase 5 (task 7mcp11b): the old shell is DELETED — the canvas is the
// app. This suite now proves the post-deletion app end to end: default boot
// (no ?canvas param), the kept surfaces through their canvas docks, the
// absence of every deleted view (nav, markers, headings), the mobile
// companion, the realtime fabric, the per-surface error-boundary discipline,
// the keyboard baseline, and the durable media-tile poster treatment.
//
// Every test attaches the console/page-error guard — uncaught renderer errors
// are exactly the class of wiring bug a deletion wave can introduce.
async function trackErrors(page: Page) {
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`)
  })
  return problems
}

// Environmental noise, not renderer defects: fetch failures against the
// (absent) configured engine, the browser's own log line when the app's
// live-preview WebSocket cannot reach ComfyUI, and the trace-recorder CSP
// note (see canvas.spec.ts for the verified rationale).
const environmental = (entry: string) =>
  entry.includes('Failed to load resource')
  || /WebSocket connection to .* failed/.test(entry)
  || /Connecting to 'blob:.*' violates the following Content Security Policy directive: "connect-src/.test(entry)

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw new Error(`Uncaught renderer error during navigation: ${error.message}`)
  })
})

/** Deterministic boot: close the canvas session (the empty-canvas launcher
 *  only shows with no open canvases). */
async function resetSession(page: Page) {
  await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } })
}

// The deleted old shell: every retired view's markers must be GONE — the
// Phase-5 successor of the Phase-3/4 retirement smoke (greyed + still
// navigable). Now: not greyed — ABSENT.
test('boots to the canvas app by default — no param, no old shell (§8 Phase 5)', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await expect(page.locator('[data-canvas-launcher]')).toBeVisible()
  await expect(page.locator('[data-canvas-radar]')).toBeVisible()

  // The old shell is DEAD: no app shell, no sidebar nav, no retired markers.
  await expect(page.locator('.app-shell')).toHaveCount(0)
  await expect(page.locator('.sidebar')).toHaveCount(0)
  await expect(page.locator('.nav-button')).toHaveCount(0)
  await expect(page.locator('[data-retired]')).toHaveCount(0)
  await expect(page.locator('.retired-affordance')).toHaveCount(0)

  // The deleted views' surfaces are absent (headings the old shell rendered).
  for (const gone of [/create with minimax h3/i, /video library/i, /movie editor/i, /create with ltx/i]) {
    await expect(page.getByRole('heading', { name: gone })).toHaveCount(0)
  }
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('?canvas=1 stays a harmless alias of the default route', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/?canvas=1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await expect(page.locator('[data-canvas-launcher]')).toBeVisible()
  await expect(page.locator('.app-shell')).toHaveCount(0)
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

// The Phase-3/4 retirement smoke tests, flipped to DELETION assertions: the
// seven greyed views (Clip editor, Video reference clipper, Frame bookmarks,
// Create, Queue, Library, LTX 2.5) died with the shell.
test('the 7 greyed views are deleted: no nav, no markers, no surfaces (§8 Phase 5)', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  // Nav model gone entirely → nothing to click, nothing greyed.
  await expect(page.locator('.nav-button[data-retired]')).toHaveCount(0)
  await expect(page.locator('[data-retired="clip-editor"]')).toHaveCount(0)
  await expect(page.locator('[data-retired="create"]')).toHaveCount(0)
  await expect(page.locator('[data-retired="jobs"]')).toHaveCount(0)
  await expect(page.locator('[data-retired="library"]')).toHaveCount(0)
  await expect(page.locator('[data-retired="ltx25"]')).toHaveCount(0)
  // The capabilities live on canvas: the launcher chips + radar buttons.
  for (const selector of ['[data-canvas-settings-button]', '[data-canvas-diagnostics-button]', '[data-canvas-library-button]', '[data-canvas-index-button]']) {
    await expect(page.locator(selector)).toBeVisible()
  }
  await page.screenshot({ path: 'test-results/shots/25-phase5-default-canvas.png' })
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

// The still-live surfaces' accounting (h14qd9t): every kept surface opens
// through its canvas dock and renders without renderer errors — the successor
// of "every view renders".
test('every kept surface renders without renderer errors through its canvas dock', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')

  // (The Studios dock block was removed with the Studios — Phase 0,
  // 2026-09-20; git history is the archive.)

  // The Director Suite (Phase 5b): the timeline projection summons by V.
  await page.keyboard.press('v')
  await expect(page.locator('[data-canvas-timeline]')).toBeVisible()
  await page.keyboard.press('Escape')

  // The Diagnostics dock (inventory row 10).
  await page.locator('[data-canvas-diagnostics-button]').click()
  await expect(page.getByRole('heading', { name: /diagnostics/i }).first()).toBeVisible({ timeout: 10_000 })
  await page.locator('[data-canvas-diagnostics-close]').click()

  // The Settings dock (Phase 4).
  await page.locator('[data-canvas-settings-button]').click()
  await expect(page.getByRole('heading', { name: /settings/i }).first()).toBeVisible({ timeout: 10_000 })
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('captures 1920x1080 screenshots of the post-deletion surfaces for vision inspection', async ({ page }) => {
  await resetSession(page)
  await page.goto('/')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'test-results/shots/01-default-canvas.png' })
  // (The 02-studios-characters capture was removed with the Studios —
  // Phase 0, 2026-09-20.)
  // Phase 5b: the plan surface is the timeline projection (MoviePlanner
  // retired); capture its summoned empty state.
  await page.keyboard.press('v')
  await expect(page.locator('[data-canvas-timeline]')).toBeVisible()
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'test-results/shots/03-timeline.png' })
  await page.keyboard.press('Escape')
  await page.locator('[data-canvas-diagnostics-button]').click()
  await expect(page.getByRole('heading', { name: /diagnostics/i }).first()).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'test-results/shots/04-diagnostics.png' })
})

// Successor of the Create-view controls test: the launcher (the empty-canvas
// generation surface) keeps its primary controls visible at the pinned 1080p
// viewport.
test('launcher keeps the prompt bar and chips visible at 1080p', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/')
  const inViewport = async (locator: ReturnType<Page['locator']>) => {
    const box = await locator.boundingBox()
    expect(box).not.toBeNull()
    return box!.y >= 0 && box!.y + box!.height <= 1080
  }
  await expect(page.locator('[data-canvas-promptbar]')).toBeVisible()
  expect(await inViewport(page.locator('[data-canvas-prompt]'))).toBe(true)
  expect(await inViewport(page.locator('[data-canvas-submit]'))).toBe(true)
  for (const chip of ['image', 'video', 'music3', 'acestep', 'movie', 'prompt-library']) {
    await expect(page.locator(`[data-canvas-chip="${chip}"]`)).toBeVisible()
    expect(await inViewport(page.locator(`[data-canvas-chip="${chip}"]`))).toBe(true)
  }
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('settings round-trips a change through the server API (docked)', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/')
  await page.locator('[data-canvas-settings-button]').click()
  await expect(page.locator('[data-canvas-settings-dock]')).toBeVisible()
  const outputInput = page.locator('#output-path')
  await expect(outputInput).toBeVisible()
  const original = await outputInput.inputValue()
  await outputInput.fill(`${original}/e2e-probe`)
  await page.getByRole('button', { name: /save/i }).first().click()
  await page.waitForTimeout(600)
  const persisted = await (await fetch(`http://127.0.0.1:${process.env.MINIMAX_E2E_PORT ?? '4199'}/api/lan/settings`)).json()
  expect(persisted.settings.outputDirectory).toContain('e2e-probe')
  // Restore so other tests see the clean state.
  await outputInput.fill(original)
  await page.getByRole('button', { name: /save/i }).first().click()
  await page.waitForTimeout(400)
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

// 15th test (LLM layer): the Settings LLM section renders in its
// provider-empty fallback state — now inside the canvas Settings dock. The
// e2e server has no llama.cpp router configured (llamaCppUrl defaults to ''),
// so the section must show the Ollama-fallback indicator, the router address
// input, and the unload-on-generate toggle — deeper provider behavior lives
// in test:llm against a mock router.
test('Settings renders the LLM router section with the Ollama fallback state', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/')
  await page.locator('[data-canvas-settings-button]').click()
  await expect(page.locator('[data-canvas-settings-dock]')).toBeVisible()

  const llmSection = page.locator('.llm-section')
  await expect(llmSection).toBeVisible()
  await expect(llmSection.getByText(/llama\.cpp router/i)).toBeVisible()
  // No router configured → the fallback pill, never a false "online" state.
  await expect(llmSection.locator('.health-pill')).toHaveText(/ollama fallback/i)
  const routerInput = page.locator('#llm-router-url')
  await expect(routerInput).toBeVisible()
  await expect(routerInput).toHaveValue('')
  // The choreography + thinking toggles render with their defaults (on / off).
  const unloadToggle = llmSection.locator('.settings-check input').first()
  await expect(unloadToggle).toBeChecked()
  // The model list stays empty without a reachable provider — no phantom rows.
  await expect(llmSection.locator('.llm-model-row')).toHaveCount(0)

  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

// Diagnostics suite (task xyo4is4): the PII-scrubbed surface renders
// engine-independently inside its dock, builds its report from structured
// fields only, copies it through the (permission-granted) clipboard, and
// saves it as a local download — no network beyond this app's own server,
// nothing leaves the machine.
test('diagnostics dock renders, builds a scrubbed report, and copies it', async ({ page }) => {
  const problems = await trackErrors(page)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await resetSession(page)
  await page.goto('/')
  await page.locator('[data-canvas-diagnostics-button]').click()
  await expect(page.locator('[data-canvas-diagnostics-dock]')).toBeVisible()
  await expect(page.getByRole('heading', { name: /diagnostics/i }).first()).toBeVisible()

  // Sections render (engine state is environment-dependent: the e2e server
  // has no engine on CI, but a dev box may expose one on the default port).
  const engineSection = page.locator('section[aria-label="Engine"]')
  await expect(engineSection.locator('.health-pill')).toHaveText(/offline|connected/i)
  await expect(page.locator('section[aria-label="Sanitizer self-test"] .health-pill')).toHaveText(/pass/i)

  // The report blob exists, is scrubbed by construction, and carries the
  // deterministic section skeleton.
  const preview = page.locator('.diagnostics-report-preview')
  await expect(preview).toBeVisible()
  const text = await preview.innerText()
  expect(text).toContain('MiniMax Studio diagnostic report')
  expect(text).toContain('[ENGINE]')
  expect(text).toContain('external mode')
  expect(text).toContain('[MODEL SCAN]')
  expect(text).toContain('[SANITIZER SELF-TEST]')

  // Copy: the clipboard receives exactly the previewed (scrubbed) blob.
  await page.getByRole('button', { name: /copy report/i }).click()
  await expect(page.locator('.llm-test-result')).toContainText(/copied/i)
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied.startsWith('MiniMax Studio diagnostic report')).toBe(true)
  expect(copied).toContain('[SETUP DOCTOR]')

  // Save: the report lands as a local file download, no server round trip.
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: /save report/i }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^minimax-diagnostics-.*\.txt$/)

  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

// (The mobile companion boot test was removed with the mobile route —
// Phase 0, 2026-09-20; git history is the archive.)

// Wave 1 — the realtime event fabric: on boot the client establishes its ONE
// fabric connection to the app's own server (WebSocket primary, SSE v2
// fallback) and telemetry samples start flowing. The canvas EngineHost mounts
// the same session/queue hooks the old shell did — the fabric is unchanged.
test('the realtime fabric connects on boot and telemetry samples flow', async ({ page }) => {
  const problems = await trackErrors(page)
  await page.goto('/')
  await page.waitForFunction(() => {
    const diagnostics = (window as unknown as { __minimaxRealtime?: { connected: boolean; transport: string; received: Record<string, number> } }).__minimaxRealtime
    return Boolean(diagnostics && diagnostics.connected && diagnostics.transport && (diagnostics.received.telemetry ?? 0) >= 1)
  }, undefined, { timeout: 15_000 })
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

// Wave 0b — the per-surface error boundary: a render crash inside a dock must
// not take the canvas down, and the boundary's console output + fallback UI
// must be sanitized (the injected crash message carries sentinel "prompt"
// words that may never survive anywhere). The crash is forced by wrapping the
// window.minimax bridge at install time: getSettings hands the app a settings
// object whose `gpuTier` getter throws — only SettingsView reads that field
// during render, so the canvas root and every other dock stay healthy.
test('a crashing docked surface is contained by its error boundary without leaking prompt text', async ({ page }) => {
  const consoleErrors: string[] = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  await page.addInitScript(() => {
    let installed: unknown
    Object.defineProperty(window, 'minimax', {
      configurable: true,
      get: () => installed,
      set: (client: unknown) => {
        installed = new Proxy(client, {
          get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver)
            if (property !== 'getSettings' || typeof value !== 'function') return value
            return async () => {
              const settings = await (value as () => Promise<Record<string, unknown>>)()
              const poisoned = { ...settings, testedComfyVersion: 'e2e-pinned' }
              Object.defineProperty(poisoned, 'gpuTier', {
                enumerable: true,
                get: () => { throw new Error('settings.gpuTier render failed: moonlit qzxveldra umbrella merchants waltzing') },
              })
              return poisoned
            }
          },
        })
      },
    })
  })
  await resetSession(page)
  await page.goto('/')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await page.locator('[data-canvas-settings-button]').click()
  // The per-surface boundary shows the sanitized fallback — the canvas
  // survives (radar + root stay alive).
  await expect(page.getByText('This view hit an error')).toBeVisible()
  await expect(page.locator('[data-canvas-radar]')).toBeVisible()
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  // The rendered summary is sanitized: sentinel words never reach the DOM.
  const summary = page.locator('.error-boundary-summary')
  await expect(summary).toBeVisible()
  await expect(summary).toContainText('[redacted]')
  expect((await summary.innerText()).toLowerCase()).not.toContain('umbrella')
  // The rest of the app still works: the diagnostics dock opens a healthy
  // surface while the crashed settings dock shows its fallback.
  await page.locator('[data-canvas-settings-close]').click()
  await page.locator('[data-canvas-diagnostics-button]').click()
  await expect(page.getByText('This view hit an error')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: /diagnostics/i }).first()).toBeVisible()
  // The boundary logged (with its ref + [redacted]) and NOTHING logged or
  // rendered carries the raw injected message.
  expect(consoleErrors.length).toBeGreaterThan(0)
  for (const entry of consoleErrors) {
    expect(entry.includes('qzxveldra')).toBe(false)
    expect(entry.includes('umbrella')).toBe(false)
    expect(entry.includes('waltzing')).toBe(false)
  }
  expect(consoleErrors.some((entry) => entry.includes('boundary:settings'))).toBe(true)
  expect(consoleErrors.some((entry) => entry.includes('[redacted]'))).toBe(true)
})

// Wave 2a — the transient-update discipline, proven: high-frequency updates
// riding a store subscription with direct DOM writes must not trigger ANY
// React render. The probe pair (a transform-painted mover beside a
// data-render-count sibling canary) mounts only with ?probe=transient; the
// e2e runs the production build, so a DEV-only tree-shaken mechanism could
// never be exercised — the query flag keeps it inert in every normal session.
test('transient updates paint through store.subscribe with zero React re-renders', async ({ page }) => {
  const problems = await trackErrors(page)
  await page.goto('/?probe=transient')
  await expect(page.locator('[data-transient-probe="root"]')).toBeAttached()
  // Everything runs inside ONE synchronous evaluate: no await gap, so an
  // unrelated re-render (settings landing, telemetry tick) cannot land
  // between the before/after reads and pollute the assertion.
  const result = await page.evaluate(() => {
    const driver = (window as unknown as { __studioDriveTransient?: (count: number) => { mounted: boolean; applied: number; from: number; to: number } }).__studioDriveTransient
    const counter = document.querySelector('[data-transient-probe="counter"]')
    const mover = document.querySelector<HTMLElement>('[data-transient-probe="mover"]')
    const before = counter ? Number(counter.getAttribute('data-render-count')) : -1
    const transformBefore = mover ? mover.style.transform : ''
    const report = driver ? driver(120) : { mounted: false, applied: 0, from: 0, to: 0 }
    return {
      ready: Boolean(driver && counter && mover),
      renderCountBefore: before,
      renderCountAfter: counter ? Number(counter.getAttribute('data-render-count')) : -1,
      transformBefore,
      transformAfter: mover ? mover.style.transform : '',
      ...report,
    }
  })
  expect(result.ready).toBe(true)
  // All 120 store updates reached the subscriber and moved the element.
  expect(result.applied).toBe(120)
  expect(result.to).toBeGreaterThan(result.from)
  expect(result.transformAfter).not.toBe(result.transformBefore)
  expect(result.transformAfter).toContain(`${result.to}px`)
  // The discipline itself: 120 transient updates, ZERO React renders of the
  // surrounding tree.
  expect(result.renderCountAfter).toBe(result.renderCountBefore)
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

// Wave 2b successor — the keyboard-first baseline on the post-deletion app:
// the launcher's prompt bar owns the global `/` focus, the focus-visible
// ring actually renders, and the Base UI prompt-library dialog keeps its
// focus-trap / Escape / focus-restore discipline (the dialog machinery the
// old Create view carried, now on canvas).
test('launcher core flow is keyboard-operable (focus rings + dialog discipline)', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')

  // `/` focuses the prompt bar from anywhere (§7).
  await page.keyboard.press('/')
  const focusReport = () => page.evaluate(() => {
    const element = document.activeElement
    if (!element) return { tag: 'none', focusVisible: false, outline: 'none', boxShadow: 'none' }
    const style = getComputedStyle(element)
    return {
      tag: element.tagName.toLowerCase(),
      focusVisible: element.matches(':focus-visible'),
      outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
      boxShadow: style.boxShadow,
    }
  })
  await expect(page.locator('[data-canvas-prompt]')).toBeFocused()
  const promptFocus = await focusReport()
  expect(promptFocus.focusVisible).toBe(true)
  expect(promptFocus.outline.includes('solid') || promptFocus.boxShadow !== 'none').toBe(true)
  await page.keyboard.type('a lone drummer on a night train, windows streaked with rain')
  await expect(page.locator('[data-canvas-prompt]')).toHaveValue(/lone drummer/)

  // The prompt-library dialog opens by keyboard (Tab forward to the chip —
  // the chip row sits BELOW the prompt bar in the launcher's DOM order —
  // then Enter) and keeps the Base UI discipline: focus inside, Escape
  // restores the trigger.
  for (let index = 0; index < 14; index += 1) {
    if (await page.evaluate(() => document.activeElement?.getAttribute('data-canvas-chip') === 'prompt-library')) break
    await page.keyboard.press('Tab')
  }
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-canvas-chip'))).toBe('prompt-library')
  const chipFocus = await focusReport()
  expect(chipFocus.focusVisible).toBe(true)
  await page.keyboard.press('Enter')
  const dialog = page.locator('.prompt-library-modal')
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('.prompt-library-modal')))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('[data-canvas-chip="prompt-library"]')).toBeFocused()

  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

// Wave 2d successor — the filmstrip/pool capability on the post-deletion app.
// The old Library's video cards are gone; the canvas media tile is the video
// surface now. A real mp4 ingested through the canvas file input lands as a
// stored blob + take; after reload (session previews are transient BY
// DESIGN) the tile renders its DURABLE poster: a paused blob-served <video>
// at preload=metadata — frame 0 as the poster, zero autoplay, one element
// per video object. (The sprite-sheet generation + pool machinery stay
// unit/e2e-proven server-side in test:filmstrip against the same fixture.)
test('canvas media tiles render durable video posters from stored blobs', async ({ page }) => {
  // Codec honesty guard (the same pattern the pooled-playback proof used):
  // distro Chromium builds ship without proprietary codecs.
  await page.goto('/')
  const h264Capable = await page.evaluate(() => document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"') !== '')
  test.skip(!h264Capable, 'this system browser cannot decode H.264 (typical for distro Chromium builds without proprietary codecs) — the video-poster proof needs a codec-complete browser such as Google Chrome')

  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await page.setInputFiles('[data-canvas-file-input]', path.resolve(__dirname, 'fixtures/sample-clip.mp4'))
  await expect(page.locator('[data-canvas-tile]')).toHaveCount(1, { timeout: 15_000 })
  // The durable copy: reload drops the session-local preview (an object URL,
  // transient by design) and the tile falls back to its STORED artifact —
  // the blob-served paused <video> (frame 0 poster, no autoplay).
  await page.reload()
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await expect(page.locator('[data-canvas-tile]')).toHaveCount(1, { timeout: 15_000 })
  const poster = page.locator('video[data-canvas-poster="blob"]').first()
  await expect(poster).toBeVisible()
  await expect(poster).toHaveAttribute('preload', 'metadata')
  await page.waitForFunction(() => {
    const video = document.querySelector<HTMLVideoElement>('video[data-canvas-poster="blob"]')
    return Boolean(video && video.paused)
  }, undefined, { timeout: 10_000 })
  expect(await page.evaluate(() => document.querySelectorAll('video').length)).toBe(1)
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('settings-GET Option B: token mode gates the read, the SPA editor path keeps working', async ({ page }) => {
  const problems = await trackErrors(page)
  // A dedicated token-mode server on this run's own port (the shared e2e
  // webServer is open mode by design). Option B (maintainer decision
  // 2026-09-18): GET /settings requires the token in token mode; the SPA
  // attaches it from the launch link, so the settings editor loads.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-e2e-token-'))
  const port = 5710 + Math.floor(Math.random() * 80) // this agent's 5700-5799 range
  const child = spawn(process.execPath, ['dist-server/server/index.js'], {
    env: { ...process.env, MINIMAX_STUDIO_HOME: home, MINIMAX_LAN_PORT: String(port), MINIMAX_NO_HTTPS: '1', MINIMAX_LAN_TOKEN: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  try {
    const base = `http://127.0.0.1:${port}`
    let token = ''
    for (let attempt = 0; attempt < 50 && !token; attempt += 1) {
      try { token = fs.readFileSync(path.join(home, 'lan-access-token.txt'), 'utf8').trim() } catch { await new Promise((resolve) => setTimeout(resolve, 200)) }
    }
    expect(token).toMatch(/^[a-f0-9]{32}$/i)
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { if ((await fetch(`${base}/api/lan/settings`, { headers: { 'x-minimax-token': token } })).ok) break } catch { /* booting */ }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    // Option B, mode 1 — token mode: the bare read is 401 (checked from a
    // browser context, not just node): no token, no settings.
    await page.goto(base)
    const bareStatus = await page.evaluate(async (origin) => (await fetch(`${origin}/api/lan/settings`)).status, base)
    expect(bareStatus).toBe(401)
    // Mode 2 — the SPA editor path: launch-link token in hand, the settings
    // dock loads through the same GET the editor round-trips.
    await page.goto(`${base}/?canvas=1&token=${token}`)
    await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready', { timeout: 20_000 })
    await page.locator('[data-canvas-settings-button]').click()
    const dock = page.locator('[data-canvas-settings-dock]')
    await expect(dock).toBeVisible()
    await expect(dock.locator('[data-canvas-settings-body]')).toBeVisible()
    await expect(dock.getByText(/comfyui/i).first()).toBeVisible()
    expect(problems.filter((entry) => !environmental(entry))).toEqual([])
  } finally {
    child.kill()
    await new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else child.on('exit', () => resolve()) })
  }
})

// ---------------------------------------------------------------------------
// QOL wave (rrxlw2r) — registry-driven surface navigation + first-run
// guidance. The switcher is shared chrome (src/surfaces/): surfaces
// self-register (canvas + datasets + images — the workbench appended its
// entry with k9vu6t0, the registry's documented append point).
// ---------------------------------------------------------------------------

test('surface switcher: registry entries in the canvas titlebar, canvas active', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  const switcher = page.locator('[data-surface-switcher]')
  await expect(switcher).toBeVisible()
  // Exactly the REGISTERED surfaces — unregistered routes never appear.
  // (k9vu6t0: the images workbench's registry entry landed — three now.)
  await expect(switcher.locator('[data-surface]')).toHaveCount(3)
  await expect(switcher.locator('[data-surface="canvas"]')).toHaveAttribute('aria-current', 'page')
  await expect(switcher.locator('[data-surface="datasets"]')).toHaveAttribute('href', '/?datasets=1')
  await expect(switcher.locator('[data-surface="images"]')).toHaveAttribute('href', '/?images=1')
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('surface switcher: navigates canvas → datasets → canvas', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await page.locator('[data-surface-switcher] [data-surface="datasets"]').click()
  await expect(page.locator('[data-ds-root]')).toBeVisible()
  const switcher = page.locator('[data-surface-switcher]')
  await expect(switcher.locator('[data-surface="datasets"]')).toHaveAttribute('aria-current', 'page')
  await switcher.locator('[data-surface="canvas"]').click()
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await expect(page.locator('[data-surface-switcher] [data-surface="canvas"]')).toHaveAttribute('aria-current', 'page')
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('surface switcher: Alt+2 jumps to datasets, Alt+1 back — never fights the canvas keys', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  await page.goto('/')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await page.keyboard.press('Alt+2')
  await expect(page.locator('[data-ds-root]')).toBeVisible()
  await page.keyboard.press('Alt+1')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('first-run guidance: empty model roots show dismissible onboarding, never a dead app', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  // The e2e home has empty model roots (nothing scanned) — the first-run
  // condition by construction. The notice waits for the scan to settle.
  await page.goto('/')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  const notice = page.locator('[data-canvas-first-run]')
  await expect(notice).toBeVisible({ timeout: 20_000 })
  await expect(notice).toContainText('No models visible')
  // Path one: straight into Settings (the engine connection — the
  // registry-only model source).
  await notice.getByRole('button', { name: 'Open settings — engine connection' }).click()
  await expect(page.locator('[data-canvas-settings-dock]')).toBeVisible()
  await page.locator('[data-canvas-settings-close]').click()
  await expect(page.locator('[data-canvas-settings-dock]')).toHaveCount(0)
  // Path two: the fetcher browser is one click away too.
  await notice.getByRole('button', { name: 'Browse fetchable items' }).click()
  await expect(page.locator('[data-canvas-settings-dock]')).toBeVisible()
  await page.locator('[data-canvas-settings-close]').click()
  // Dismiss is durable (per-browser latch — non-nagging by design).
  await notice.getByRole('button', { name: 'Dismiss setup guidance' }).click()
  await expect(page.locator('[data-canvas-first-run]')).toHaveCount(0)
  await page.reload()
  await expect(page.locator('[data-canvas-launcher]')).toBeVisible()
  await expect(page.locator('[data-canvas-first-run]')).toHaveCount(0)
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

// External-instance integration (task 9om4bi9): with the engine pointed at a
// fake EXTERNAL instance (serving a crafted object_info + /models listing),
// the Settings surface must show the merged inventory — instance-tagged model
// rows with NO local roots configured — the external custom-nodes folder, the
// LIVE pack chips read from the instance, an install that lands inside the
// external folder, and the honest restart-needed chip afterwards. The fake
// engine speaks the verified contract (the canvas suite's harness pattern);
// settings are restored in finally so later tests see the clean home.
test('external instance: instance-sourced models, live pack chips, install into the external custom nodes folder', async ({ page }) => {
  const problems = await trackErrors(page)
  const { mkdirSync, writeFileSync, existsSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const http = await import('node:http')

  const objectInfo = {
    UNETLoader: { input: { required: { unet_name: [['instance-h3-fl2va.safetensors', 'instance-h3-ref2va.safetensors'], {}] } } },
    CLIPLoader: { input: { required: { clip_name: ['x.safetensors', { options: ['instance-encoder.safetensors'] }] } } },
    VAELoader: { input: { required: { vae_name: [['instance-vae.safetensors'], {}] } } },
    LoraLoader: { input: { required: { lora_name: [['instance-lora.safetensors'], {}] } } },
    MiniMaxH3HybridLoader: { input: { required: { ckpt_name: [['instance-h3-fl2va.safetensors'], {}] } } },
    KSamplerSelect: { input: { required: {} } },
  }
  const engine = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://engine.local')
    if (url.pathname === '/system_stats') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ system: { comfyui_version: 'v0.34.0' }, devices: [] }))
      return
    }
    const targeted = /^\/object_info\/(.+)$/.exec(url.pathname)
    if (targeted) {
      // (Wave 2 A-8) The targeted per-class form: key-miss = absence.
      const className = decodeURIComponent(targeted[1]!)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(className in objectInfo ? { [className]: objectInfo[className] } : {}))
      return
    }
    if (url.pathname === '/object_info') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(objectInfo))
      return
    }
    if (url.pathname === '/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(['diffusion_models', 'text_encoders', 'vae', 'loras']))
      return
    }
    if (url.pathname === '/models/diffusion_models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(['instance-h3-fl2va.safetensors', 'instance-h3-ref2va.safetensors']))
      return
    }
    if (url.pathname === '/models/vae') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(['instance-vae.safetensors']))
      return
    }
    res.writeHead(404)
    res.end()
  })
  const enginePort = await new Promise<number>((resolve) => engine.listen(0, '127.0.0.1', () => resolve((engine.address() as { port: number }).port)))

  // (Wave 2 R-12) No local roots at all — the instance listing is the whole
  // inventory. An external custom nodes folder + a local repo copy to
  // install krea2edit from.
  const home = join(process.cwd(), 'test-home')
  const externalDir = join(home, 'e2e-external-nodes')
  mkdirSync(externalDir, { recursive: true })
  const localCopy = join(home, 'e2e-krea2edit-copy')
  mkdirSync(localCopy, { recursive: true })
  writeFileSync(join(localCopy, '__init__.py'), '# krea2edit e2e\n')

  const originalSettings = ((await (await page.request.get('/api/lan/settings')).json()) as { settings: Record<string, unknown> }).settings
  try {
    const applied = await page.request.post('/api/lan/settings', { data: { settings: {
      ...originalSettings,
      comfyUrl: `http://127.0.0.1:${enginePort}`,
      engine: { ...(originalSettings.engine as Record<string, unknown>), mode: 'external', externalCustomNodesDir: externalDir },
    } } })
    expect(applied.status(), `settings POST must succeed: ${JSON.stringify(await applied.json().catch(() => ({})))}`).toBe(200)
    // Shared-home hygiene (the testing.md accumulation lesson): a previous
    // run may have left comfyui-krea2edit installed in the fixture folder —
    // reset it through the app's own uninstall API so the "missing" state is
    // deterministic. 404 = already gone; both fine.
    await page.request.post('/api/lan/engine/nodes/uninstall', { data: { id: 'krea2edit' } }).catch(() => undefined)
    await resetSession(page)
    await page.goto('/')
    await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
    await page.locator('[data-canvas-settings-button]').click()
    await expect(page.locator('[data-canvas-settings-dock]')).toBeVisible()

    // External mode surfaces the custom-nodes folder; io defaults are
    // app-relative (the e2e home IS the app folder for this server).
    const externalInput = page.locator('[data-external-custom-nodes]')
    await expect(externalInput).toBeVisible()
    await expect(externalInput).toHaveValue(externalDir)
    await expect(page.locator('[data-input-path]')).toHaveValue(/[\\/]data[\\/]input$/)
    await expect(page.locator('#output-path')).toHaveValue(/[\\/]data[\\/]output$/)

    // The registry-only inventory: the instance's own listing, no local files.
    const diffusionCount = page.locator('[data-model-kind-count="diffusion_models"]')
    await expect(diffusionCount).toBeVisible({ timeout: 20_000 })
    // (Wave 2 R-12) The count row names the ENGINE as the source — the
    // instance/local split display died with the merge.)
    await expect(diffusionCount).toContainText('2 files on the engine')

    // Live chips from the instance's own node list: the hybrid loader pack is
    // INSTALLED ON INSTANCE (its class is served) with no folder install at
    // all; krea2edit is missing (the instance serves none of its classes).
    const hybridRow = page.locator('.node-pack-row').filter({ hasText: 'ComfyUI_MinimaxH3HybridLoader' })
    await expect(hybridRow.locator('[data-node-pack-chip]')).toHaveAttribute('data-node-pack-chip', 'installed on instance', { timeout: 15_000 })
    const krea2editRow = page.locator('.node-pack-row').filter({ hasText: 'comfyui-krea2edit' })
    await expect(krea2editRow.locator('[data-node-pack-chip]')).toHaveAttribute('data-node-pack-chip', 'missing')

    // Install krea2edit from the local copy INTO THE EXTERNAL FOLDER. The UI
    // no longer prompts for a path (mjhlt3k AC-1: a network pack's install
    // affordance is Fetch…, never a local-source dialogue), so the local-copy
    // contract is exercised through the route — which keeps supporting it —
    // and the UI asserts the honest badge: installed at the pin, but the
    // instance has not loaded it — restart to activate.
    const installed = await page.request.post('/api/lan/engine/nodes/install', { data: { id: 'krea2edit', sourceDirectory: localCopy } })
    expect(installed.status(), `krea2edit local-copy install must succeed: ${JSON.stringify(await installed.json().catch(() => ({})))}`).toBe(200)
    // The route-side install changed the folder behind the UI's back — the
    // board's Refresh button (mjhlt3k AC-2) is the re-resolve trigger.
    await krea2editRow.locator('[data-node-pack-chip]').scrollIntoViewIfNeeded()
    await page.locator('[data-node-pack-refresh]').click()
    await expect(krea2editRow.locator('[data-node-pack-chip]')).toHaveAttribute('data-node-pack-chip', 'installed @ pin — restart engine to activate', { timeout: 15_000 })
    expect(existsSync(join(externalDir, 'comfyui-krea2edit', '.studio-node.json'))).toBe(true)

    // The maintainer's exact report (9om4bi9 follow-up): a working instance's
    // external folder already holds the form adapter → the row reports
    // PRESENT with the Install button disabled (not "cannot be installed");
    // and the vendored VDN pack installs with NO source directory at all.
    mkdirSync(join(externalDir, 'minimax-lora-form-adapter'), { recursive: true })
    writeFileSync(join(externalDir, 'minimax-lora-form-adapter', 'nodes.py'), '# theirs\n')
    await page.locator('[data-canvas-settings-close]').click()
    await page.locator('[data-canvas-settings-button]').click()
    const formAdapterRow = page.locator('.node-pack-row').filter({ hasText: 'minimax-lora-form-adapter' })
    await expect(formAdapterRow.locator('[data-node-pack-chip]')).toHaveAttribute('data-node-pack-chip', 'present — not studio-managed', { timeout: 15_000 })
    await expect(formAdapterRow.getByRole('button', { name: /^Install$/ })).toBeDisabled()
    expect(readFileSync(join(externalDir, 'minimax-lora-form-adapter', 'nodes.py'), 'utf8')).toBe('# theirs\n')

    const vdnRow = page.locator('.node-pack-row').filter({ hasText: 'ComfyUI-VDN-H3' })
    await vdnRow.locator('[data-node-pack-chip]').scrollIntoViewIfNeeded()
    await vdnRow.getByRole('button', { name: /^Install$/ }).click()
    await expect(vdnRow.locator('[data-node-pack-chip]')).toHaveAttribute('data-node-pack-chip', 'installed @ pin — restart engine to activate', { timeout: 15_000 })
    expect(existsSync(join(externalDir, 'ComfyUI-VDN-H3', '.studio-node.json'))).toBe(true)

    // A pre-existing folder (no studio marker) is reported as PRESENT in the
    // external target — never silently replaced, never deleted, and the row
    // offers no install affordance at all with the honest reason (the 9om4bi9
    // follow-up: this is a working instance's normal state, not a failure;
    // mjhlt3k: a foreign USER-FETCH row carries neither Fetch… nor Install —
    // its only install path would be refused over the pre-existing folder).
    mkdirSync(join(externalDir, 'comfyui-minimax-h3-audio-T8'), { recursive: true })
    writeFileSync(join(externalDir, 'comfyui-minimax-h3-audio-T8', 'user-file.py'), '# theirs\n')
    await page.locator('[data-canvas-settings-close]').click()
    await page.locator('[data-canvas-settings-button]').click()
    const radianceRow = page.locator('.node-pack-row').filter({ hasText: 'comfyui-minimax-h3-audio-T8' })
    await expect(radianceRow.locator('[data-node-pack-chip]')).toHaveAttribute('data-node-pack-chip', 'present — not studio-managed', { timeout: 15_000 })
    await expect(radianceRow.getByRole('button', { name: 'Fetch…' })).toHaveCount(0)
    await expect(radianceRow.getByRole('button', { name: /^Install$/ })).toHaveCount(0)
    expect(fs.readFileSync(join(externalDir, 'comfyui-minimax-h3-audio-T8', 'user-file.py'), 'utf8')).toBe('# theirs\n')

    expect(problems.filter((entry) => !environmental(entry))).toEqual([])
  } finally {
    await page.request.post('/api/lan/settings', { data: { settings: originalSettings } })
    engine.close()
  }
})

// ---------------------------------------------------------------------------
// App-tour UX fix wave (d6iy68r) — the adversarial review's canvas findings:
// the Escape double-action (one press must do ONE thing) and the boot-time
// empty-jobs 400 (the debounced persist POSTed {"jobs":[]} on every fresh
// boot; the server's 1..100 upsert contract rejected it and the catch
// mirrored [] to localStorage as "degraded mode").

test('canvas Escape does one action per press: closing the index keeps the selection', async ({ page }) => {
  const problems = await trackErrors(page)
  await resetSession(page)
  // A workbench session chain renders as a canvas object (the images.spec
  // seed shape — no media bytes needed for a selectable tile).
  const project = await (await page.request.post('/api/lan/documents/projects', { data: { name: 'Escape e2e' } })).json()
  await page.request.post('/api/lan/documents/chains', {
    data: {
      projectId: project.project.id,
      kind: 'h3img',
      settings: {
        family: 'h3img.generate.packet', intent: '', tier: 5, keepDial: 0.55, seed: 7,
        resolution: '1344x768', loras: [], refs: [], semanticOverflow: false,
        framePicks: {}, refineEngine: '', poserigInbox: null,
      },
    },
  })
  await page.request.post('/api/lan/documents/session', { data: { openProjects: [project.project.id], activeProject: project.project.id } })
  await page.goto('/')
  await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
  await expect(page.locator('[data-canvas-tile]')).toHaveCount(1, { timeout: 15_000 })
  await page.locator('[data-canvas-tile]').first().click()
  await expect(page.locator('.canvas-tile.selected')).toHaveCount(1)
  // ⌘K opens the index (focus lands in its input — the overlay's own Escape
  // handler is the one that fires). One Escape closes the index…
  await page.keyboard.press('Control+k')
  await expect(page.locator('[data-canvas-index]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-canvas-index]')).toHaveCount(0)
  // …and the SELECTION SURVIVES the same press (before the fix the window
  // handler then read the already-updated state, fell through the chain,
  // and deselected — panel + selection vanished from ONE Escape).
  await expect(page.locator('.canvas-tile.selected')).toHaveCount(1)
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('boot never POSTs an empty job list — no 400 on a fresh home', async ({ page }) => {
  const problems = await trackErrors(page)
  // A dedicated fresh home (the token-mode precedent): the shared e2e home
  // accumulates jobs across runs, which would mask the empty-list path.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-e2e-jobs400-'))
  const port = 6910 + Math.floor(Math.random() * 80) // this agent's 6900–6999 range
  const child = spawn(process.execPath, ['dist-server/server/index.js'], {
    env: { ...process.env, MINIMAX_STUDIO_HOME: home, MINIMAX_LAN_PORT: String(port), MINIMAX_NO_HTTPS: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/lan/settings`)).ok) break } catch { /* booting */ }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    const rejectedJobPosts: Array<number | string> = []
    page.on('response', (response) => {
      if (response.url().endsWith('/api/lan/jobs') && response.request().method() === 'POST' && response.status() >= 400) {
        rejectedJobPosts.push(response.status())
      }
    })
    await page.goto(`http://127.0.0.1:${port}/?canvas=1`)
    await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready', { timeout: 20_000 })
    // The debounced (1 s) persist fires after the boot load settles; give it
    // generous room. An empty list has nothing to upsert — the client guards
    // it and the server's "1 to 100 jobs" contract never sees the request.
    await page.waitForTimeout(3000)
    expect(rejectedJobPosts).toEqual([])
    expect(problems.filter((entry) => !environmental(entry))).toEqual([])
  } finally {
    child.kill()
    await new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else child.on('exit', () => resolve()) })
  }
})

test('a virgin home seeds no "Imported workspace" — the legacy import gates on actual data', async ({ page }) => {
  const problems = await trackErrors(page)
  // A dedicated fresh home: virgin is exactly the phantom-project condition
  // (review M5) — no workspace_state, no jobs, no prompts, no characters.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-e2e-legacy-'))
  const port = 6910 + Math.floor(Math.random() * 80) // this agent's 6900–6999 range
  const child = spawn(process.execPath, ['dist-server/server/index.js'], {
    env: { ...process.env, MINIMAX_STUDIO_HOME: home, MINIMAX_LAN_PORT: String(port), MINIMAX_NO_HTTPS: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { if ((await fetch(`http://127.0.0.1:${port}/api/lan/settings`)).ok) break } catch { /* booting */ }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    await page.goto(`http://127.0.0.1:${port}/?canvas=1`)
    await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready', { timeout: 20_000 })
    // The canvas boot ran the §6 legacy import on this virgin home — with
    // nothing to import it must seed NOTHING (before, every fresh install
    // got an "Imported workspace" resume card for a workspace that never
    // existed, and the honest empty state was unreachable).
    const bootstrap = await (await fetch(`http://127.0.0.1:${port}/api/lan/documents/bootstrap`)).json()
    expect(bootstrap.legacyImport.imported).toBe(true)
    expect(bootstrap.legacyImport.counts.projectsSeeded).toBe(0)
    await expect(page.locator('[data-canvas-resume="legacy:project"]')).toHaveCount(0)
    expect(problems.filter((entry) => !environmental(entry))).toEqual([])
  } finally {
    child.kill()
    await new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else child.on('exit', () => resolve()) })
  }
})
