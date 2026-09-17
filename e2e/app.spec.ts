import path from 'node:path'
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
  for (const selector of ['[data-canvas-settings-button]', '[data-canvas-studios-button]', '[data-canvas-diagnostics-button]', '[data-canvas-library-button]', '[data-canvas-index-button]']) {
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

  // The Studios dock: the five kept ASSET-authoring surfaces (Characters,
  // Hair, Wardrobe, Accessories, Locations) — lazy chunks load + render.
  // Movie retired with MoviePlanner in Phase 5b: the plan surface is the
  // timeline projection (plan documents on the document store).
  await page.locator('[data-canvas-studios-button]').click()
  await expect(page.locator('[data-canvas-studios-dock]')).toBeVisible()
  const studioHeadings: Array<[string, RegExp]> = [
    ['characters', /character studio/i],
    ['hair', /hair studio/i],
    ['wardrobes', /wardrobe studio/i],
    ['accessories', /accessory studio/i],
    ['locations', /location studio/i],
  ]
  for (const [tab, heading] of studioHeadings) {
    await page.locator(`[data-canvas-studios-tab="${tab}"]`).click()
    await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(150)
  }
  await expect(page.locator('[data-canvas-studios-tab="movie"]')).toHaveCount(0)
  await page.locator('[data-canvas-studios-close]').click()
  await expect(page.locator('[data-canvas-studios-dock]')).toHaveCount(0)

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
  await page.locator('[data-canvas-studios-button]').click()
  await expect(page.getByRole('heading', { name: /character studio/i }).first()).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(400)
  await page.screenshot({ path: 'test-results/shots/02-studios-characters.png' })
  await page.locator('[data-canvas-studios-close]').click()
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
  for (const chip of ['image', 'video', 'music3', 'acestep', 'studios', 'movie', 'prompt-library']) {
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
  const persisted = await (await fetch('http://127.0.0.1:4199/api/lan/settings')).json()
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

test('mobile companion view boots alongside the studio', async ({ page }) => {  const problems = await trackErrors(page)
  await page.goto('/?mobile=1')
  await expect(page.locator('.mobile-app, main').first()).toBeVisible()
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

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
