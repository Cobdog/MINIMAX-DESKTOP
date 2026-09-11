import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// Every test attaches the console/page-error guard — the decomposition
// refactor must not introduce wiring regressions, and uncaught renderer
// errors are exactly that class of bug.
async function trackErrors(page: Page) {
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`)
  })
  return problems
}

// Environmental noise, not renderer defects: fetch failures against the
// (absent) configured engine, and the browser's own log line when the app's
// live-preview WebSocket cannot reach ComfyUI. The app surfaces both as
// designed "Engine offline" UI.
const environmental = (entry: string) =>
  entry.includes('Failed to load resource')
  || /WebSocket connection to .* failed/.test(entry)

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => {
    throw new Error(`Uncaught renderer error during navigation: ${error.message}`)
  })
})

const VIEW_HEADINGS: Array<[label: string, heading: RegExp]> = [
  ['Create', /MiniMax H3|Create/i],
  ['LTX 2.5', /LTX/i],
  ['Music', /ACE|Music/i],
  ['Music 3', /Music 3/i],
  ['Create Image', /Z-Image|Image/i],
  ['Characters', /Character/i],
  ['Hair', /Hair/i],
  ['Wardrobe', /Wardrobe/i],
  ['Accessories', /Accessor/i],
  ['Locations', /Location/i],
  ['Movie', /Movie/i],
  ['Queue', /Queue|render/i],
  ['Library', /Library/i],
  ['Clip editor', /Clip|Editor/i],
  ['Settings', /Settings/i],
]

test('boots to the Create view with the studio shell', async ({ page }) => {
  const problems = await trackErrors(page)
  await page.goto('/')
  await expect(page.locator('#root')).toBeAttached()
  await expect(page.getByRole('button', { name: /create/i }).first()).toBeVisible()
  await expect(page.locator('.app-shell, .studio, main, [class*="sidebar"]').first()).toBeVisible()
  await expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('every view renders without renderer errors', async ({ page }) => {
  const problems = await trackErrors(page)
  await page.goto('/')
  for (const [label] of VIEW_HEADINGS) {
    const button = page.getByRole('button', { name: new RegExp(label, 'i') }).first()
    await expect(button).toBeVisible({ timeout: 10_000 })
    await button.click()
    await page.waitForTimeout(400)
    const main = page.locator('main, [class*="view"], [class*="page"]').first()
    await expect(main).toBeVisible()
  }
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

test('captures a 1920x1080 screenshot of every view for vision inspection', async ({ page }) => {
  await page.goto('/')
  let index = 0
  for (const [label] of VIEW_HEADINGS) {
    index += 1
    const button = page.getByRole('button', { name: new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }).first()
    await expect(button).toBeVisible({ timeout: 10_000 })
    await button.click()
    await page.waitForTimeout(500)
    await page.screenshot({ path: `test-results/shots/${String(index).padStart(2, '0')}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png` })
  }
})

// The primary action and the render controls must be reachable without
// scrolling at the pinned viewport — the panel scrolls internally instead.
test('Create view keeps Generate and render controls visible at 1080p', async ({ page }) => {
  await page.goto('/')
  const inViewport = async (locator: ReturnType<Page['locator']>) => {
    const box = await locator.boundingBox()
    expect(box).not.toBeNull()
    return box!.y >= 0 && box!.y + box!.height <= 1080
  }
  await expect(page.getByRole('button', { name: /generate video/i })).toBeVisible()
  expect(await inViewport(page.getByRole('button', { name: /generate video/i }))).toBe(true)
  await expect(page.locator('#duration')).toBeVisible()
  expect(await inViewport(page.locator('#duration'))).toBe(true)
  // The right panel owns an internal scroll region for its settings.
  await expect(page.locator('.preview-scroll')).toBeAttached()
})

test('settings round-trips a change through the server API', async ({ page }) => {
  const problems = await trackErrors(page)
  await page.goto('/')
  await page.getByRole('button', { name: /settings/i }).first().click()
  const ollamaModel = page.locator('#ollama-model, input[aria-label*="Ollama model" i]').first()
  const target = ollamaModel.isVisible().then(() => ollamaModel).catch(() => null)
  // The settings view renders service inputs as text fields in the web app.
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
  void target
})

test('mobile companion view boots alongside the studio', async ({ page }) => {
  const problems = await trackErrors(page)
  await page.goto('/?mobile=1')
  await expect(page.locator('.mobile-app, main').first()).toBeVisible()
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

// Wave 1 — the realtime event fabric: on boot the client establishes its ONE
// fabric connection to the app's own server (WebSocket primary, SSE v2
// fallback) and telemetry samples start flowing. Engine-independent and
// deterministic — a sample arrives even on boxes with no GPU (flagged
// available:false), because the server-side sampler runs without an engine.
test('the realtime fabric connects on boot and telemetry samples flow', async ({ page }) => {
  const problems = await trackErrors(page)
  await page.goto('/')
  await page.waitForFunction(() => {
    const diagnostics = (window as unknown as { __minimaxRealtime?: { connected: boolean; transport: string; received: Record<string, number> } }).__minimaxRealtime
    return Boolean(diagnostics && diagnostics.connected && diagnostics.transport && (diagnostics.received.telemetry ?? 0) >= 1)
  }, undefined, { timeout: 15_000 })
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

// Wave 0b — the per-view error boundary: a render crash in one view must not
// take the shell down, and the boundary's console output + fallback UI must
// be sanitized (the injected crash message carries sentinel "prompt" words
// that may never survive anywhere). The crash is forced by wrapping the
// window.minimax bridge at install time: getSettings hands the app a settings
// object whose `gpuTier` getter throws — only SettingsView reads that field
// during render, so the shell and every other view stay healthy.
// `testedComfyVersion` is pinned so the App-level version-recording effect
// never spreads the object (a spread would not observe the poison either way,
// but pinning keeps the poisoned instance in state deterministically).
test('a crashing view is contained by its error boundary without leaking prompt text', async ({ page }) => {
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
  await page.goto('/')
  await expect(page.locator('.sidebar')).toBeVisible()
  await page.getByRole('button', { name: /settings/i }).first().click()
  // The per-view boundary shows the sanitized fallback — the shell survives.
  await expect(page.getByText('This view hit an error')).toBeVisible()
  await expect(page.locator('.sidebar')).toBeVisible()
  // The rendered summary is sanitized: sentinel words never reach the DOM.
  const summary = page.locator('.error-boundary-summary')
  await expect(summary).toBeVisible()
  await expect(summary).toContainText('[redacted]')
  expect((await summary.innerText()).toLowerCase()).not.toContain('umbrella')
  // Navigation still works: switching views remounts a healthy view.
  await page.getByRole('button', { name: /library/i }).first().click()
  await expect(page.getByText('This view hit an error')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: /video library/i })).toBeVisible()
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

// Wave 2b — the keyboard-first a11y baseline: the Create view's core flow
// must be fully operable without a mouse. Exercises the two Base UI
// migrations directly: arrow-key tab navigation (roving tabindex) and the
// dialogs' focus trap / Escape / focus-restore behavior. Focus visibility is
// asserted at each step — the token-driven :focus-visible ring must actually
// render, not merely exist in the stylesheet.
test('Create view core flow is fully keyboard-operable', async ({ page }) => {
  const problems = await trackErrors(page)
  // The workspace is SERVER-persisted (SQLite under the shared test home), so
  // earlier runs can boot this test with a stale mode/prompt. Wait for the
  // authoritative boot load before driving, then normalize by keyboard.
  const workspaceLoaded = page.waitForResponse((response) => response.url().includes('/api/lan/workspace'), { timeout: 8_000 }).catch(() => null)
  await page.goto('/')
  await workspaceLoaded

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
  // Walks Tab (or Shift+Tab) until the active element satisfies the
  // predicate; fails the test if the limit is exhausted first.
  const tabUntil = async (predicate: () => Promise<boolean>, backward = false, limit = 60) => {
    for (let index = 0; index < limit; index += 1) {
      if (await predicate()) return
      await page.keyboard.press(backward ? 'Shift+Tab' : 'Tab')
    }
    expect(await predicate(), 'Tab walk never reached the target').toBe(true)
  }
  const activeIs = (selector: string) => page.evaluate((target) => Boolean(document.activeElement?.closest(target)), selector)

  // 1. Focus the prompt editor by keyboard only and type (clearing whatever
  //    a previous run persisted).
  const prompt = page.locator('#prompt')
  await prompt.focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type('a lone drummer on a night train, windows streaked with rain')
  await expect(prompt).toHaveValue(/lone drummer/)
  const editorFocus = await focusReport()
  expect(editorFocus.focusVisible).toBe(true)
  // The composer's textarea:focus treatment is the border+glow ring (the
  // global outline rule is overridden there) — either affordance proves the
  // focused control renders a visible indicator.
  expect(editorFocus.outline.includes('solid') || editorFocus.boxShadow !== 'none').toBe(true)

  // 2. Backward Tab reaches the mode tabs (the strip sits directly above the
  //    composer); arrow keys move AND activate (Base UI roving tabindex).
  await tabUntil(() => activeIs('.mode-tabs'), true)
  expect(await activeIs('.mode-tabs [role="tab"][aria-selected="true"]')).toBe(true)
  const tabFocus = await focusReport()
  expect(tabFocus.focusVisible).toBe(true)
  expect(tabFocus.outline).toContain('rgb(198, 255, 99)')
  // The workspace persists server-side, so a previous run may have left the
  // mode anywhere — arrow (with wrap) to the deterministic Text start first.
  const selectedTabName = async () => page.locator('.mode-tabs [role="tab"][aria-selected="true"]').innerText()
  for (let index = 0; index < 5 && !/Text/i.test(await selectedTabName()); index += 1) {
    await page.keyboard.press('ArrowRight')
  }
  await expect(page.locator('.mode-tabs [role="tab"][aria-selected="true"]')).toHaveAccessibleName(/Text/i)
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('.mode-tabs [role="tab"][aria-selected="true"]')).toHaveAccessibleName(/Image/i)
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('.mode-tabs [role="tab"][aria-selected="true"]')).toHaveAccessibleName(/First \+ last/i)
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('.mode-tabs [role="tab"][aria-selected="true"]')).toHaveAccessibleName(/Reference/i)
  // The prompt survived the mode switches.
  await expect(prompt).toHaveValue(/lone drummer/)

  // 3. Reference mode surfaces the source-media dialog trigger. Reach it by
  //    Tab, open with Enter — Base UI Dialog traps focus and focuses the
  //    close button (our initialFocus).
  const manageButton = page.getByRole('button', { name: /manage source media/i })
  await manageButton.waitFor({ state: 'visible' })
  await tabUntil(() => page.evaluate(() => document.activeElement?.getAttribute('class')?.includes('source-media-manage') ?? false))
  const manageFocus = await focusReport()
  expect(manageFocus.focusVisible).toBe(true)
  await page.keyboard.press('Enter')
  const dialog = page.locator('.source-media-modal')
  await expect(dialog).toBeVisible()
  await expect(page.locator('.source-media-modal [aria-label="Close source media"]')).toBeFocused()
  // Focus trap: Tab cycles inside the popup and never escapes it. The wrap
  // past the last control redirects on the next animation frame (the focus
  // guard's rAF), so each press settles briefly — hammering Tab faster than
  // a frame would transit the invisible guard span mid-redirect.
  for (let index = 0; index < 16; index += 1) {
    await page.keyboard.press('Tab')
    await page.waitForTimeout(60)
  }
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('.source-media-modal')))).toBe(true)
  // Escape closes the dialog and restores focus to the trigger.
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(manageButton).toBeFocused()

  // 4. The Community library dialog (second Base UI migration) opens and
  //    closes by keyboard with focus restore. Its trigger sits above the
  //    source-media section, so walk backward.
  await tabUntil(() => page.evaluate(() => document.activeElement?.classList.contains('prompt-library-open') ?? false), true)
  await page.keyboard.press('Enter')
  const libraryDialog = page.locator('.prompt-library-modal')
  await expect(libraryDialog).toBeVisible()
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('.prompt-library-modal')))).toBe(true)
  // Its tab strip is keyboard-navigable too (Base UI Tabs, automatic activation).
  await tabUntil(() => activeIs('.prompt-library-tabs'))
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('.prompt-library-tabs [role="tab"][aria-selected="true"]')).toHaveAccessibleName(/Saved/i)
  await page.keyboard.press('Escape')
  await expect(libraryDialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: /community library/i })).toBeFocused()

  // 5. The primary action: with the engine offline the Generate button is
  //    correctly DISABLED — and a disabled control is skipped by Tab order,
  //    which is correct HTML behavior, not an a11y gap. The walk instead
  //    proves the tab order reaches the generate bar's neighborhood: the
  //    last operable control on the panel, with a visible focus ring.
  const advanced = page.getByRole('button', { name: /advanced controls/i })
  await tabUntil(() => page.evaluate(() => document.activeElement?.textContent?.includes('Advanced controls') ?? false), false, 120)
  await expect(advanced).toBeFocused()
  const advancedFocus = await focusReport()
  expect(advancedFocus.focusVisible).toBe(true)
  expect(advancedFocus.outline).toContain('solid')
  const generate = page.getByRole('button', { name: /generate video/i })
  await expect(generate).toBeVisible()
  await expect(generate).toBeDisabled()
  // Cleanup: return the (server-persisted) workspace to its default state so
  // the next run — including the screenshot loop — boots deterministic.
  // Still keyboard-only: clear the prompt, then arrow back to Text mode.
  await prompt.focus()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await tabUntil(() => activeIs('.mode-tabs'), true, 120)
  for (let index = 0; index < 5 && !/Text/i.test(await selectedTabName()); index += 1) {
    await page.keyboard.press('ArrowRight')
  }
  await expect(page.locator('.mode-tabs [role="tab"][aria-selected="true"]')).toHaveAccessibleName(/Text/i)
  // Let the debounced server save land before the context closes.
  await page.waitForTimeout(1_200)
  expect(problems.filter((entry) => !environmental(entry))).toEqual([])
})

// Wave 2d — filmstrip posters + the video element pool, proven at the view
// level. The OLD Library mounted one <video controls preload="metadata"> per
// card; 12 completed jobs meant 12 range-request-holding elements against
// the browser's 6-connections-per-origin ceiling. Now cards are static
// sprite-sheet posters and a pooled element exists only while playing.
// Engine-independent: jobs are seeded straight through the storage API and
// the filmstrip route needs only ffmpeg (installed on CI via apt; runners
// without it skip this test with a logged reason).
test('library cards render filmstrip posters and pool their video playback', async ({ page }) => {
  const ffmpegAvailable = await new Promise<boolean>((resolve) => {
    const probe = spawn('ffmpeg', ['-version'])
    probe.on('error', () => resolve(false))
    probe.on('close', (code) => resolve(code === 0))
  })
  test.skip(!ffmpegAvailable, 'ffmpeg is not installed on this runner — the filmstrip capability needs it (CI installs it; see .github/workflows/ci.yml)')

  const base = 'http://127.0.0.1:4199'
  const outputDirectory = path.resolve('test-home/e2e-filmstrip-output')
  const settingsResponse = await fetch(`${base}/api/lan/settings`)
  const originalSettings = ((await settingsResponse.json()) as { settings: Record<string, unknown> }).settings
  const postSettings = (settings: Record<string, unknown>) => fetch(`${base}/api/lan/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings }),
  })

  // Stage the shared fixture 12 times under a deterministic output directory
  // (the settings are restored afterwards so later runs stay clean), then
  // seed 12 completed jobs pointing at those copies through the storage API.
  fs.mkdirSync(outputDirectory, { recursive: true })
  const fixture = path.resolve(__dirname, 'fixtures/sample-clip.mp4')
  const seedCount = 12
  const jobs = Array.from({ length: seedCount }, (_, index) => {
    const name = `e2e-filmstrip-${String(index + 1).padStart(2, '0')}.mp4`
    const filePath = path.join(outputDirectory, name)
    fs.copyFileSync(fixture, filePath)
    return {
      id: `e2e-filmstrip-${String(index + 1).padStart(2, '0')}`,
      mode: 'text',
      status: 'completed',
      prompt: `wave 2d pooled clip number ${index + 1}`,
      createdAt: Date.now() - (index + 1) * 60_000,
      progress: 100,
      width: 320,
      height: 180,
      duration: 3,
      provider: 'minimax',
      mediaType: 'video',
      outputUrl: `/api/lan/media?source=output&path=${encodeURIComponent(filePath)}`,
      localOutputPath: filePath,
    }
  })
  await postSettings({ ...originalSettings, outputDirectory })
  const seeded = await fetch(`${base}/api/lan/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobs }),
  })
  expect(seeded.ok, 'seeding jobs through the storage API must succeed').toBe(true)

  try {
    const problems = await trackErrors(page)
    await page.goto('/')
    await page.getByRole('button', { name: /library/i }).first().click()
    await expect(page.getByRole('heading', { name: /video library/i })).toBeVisible()

    // Exact card lookup: card text runs together ("number 1" + "320 × 180"),
    // and "number 1" is a substring of "number 10" — so match the prompt's
    // own <strong> element by its exact text.
    const cardFor = (index: number) => page.locator('.library-card').filter({ has: page.getByText(`wave 2d pooled clip number ${index}`, { exact: true }) })
    await expect(cardFor(1)).toBeVisible({ timeout: 15_000 })
    expect(await page.locator('.library-card').count()).toBeGreaterThanOrEqual(seedCount)

    // Filmstrip posters: every card ends up with a loaded sprite-sheet <img>
    // (each first load triggers one server-side ffmpeg generation — poll,
    // twelve sheets take a moment to generate on first view).
    await expect(page.locator('.library-card img.filmstrip-poster').first()).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => page.evaluate(() => Array.from(document.querySelectorAll<HTMLImageElement>('.library-card img.filmstrip-poster')).filter((image) => image.complete && image.naturalWidth > 0).length), { timeout: 30_000 }).toBeGreaterThanOrEqual(seedCount)

    // The pool bound: no <video> is mounted for posters — the whole document
    // holds at most 4 (the pool size) at any moment, versus one per card
    // before the rewire. Pooled elements live detached until leased, so a
    // static grid contributes ZERO.
    expect(await page.evaluate(() => document.querySelectorAll('video').length)).toBeLessThanOrEqual(4)

    // Click a card → its pooled video plays (controls, exclusive).
    await cardFor(1).locator('.play-overlay').click()
    await page.waitForFunction(() => {
      const video = document.querySelector('video')
      return Boolean(video && !video.paused && video.readyState >= 2)
    }, undefined, { timeout: 15_000 })
    expect(await page.evaluate(() => document.querySelectorAll('video').length)).toBe(1)

    // Click another card → the first lease is released (poster back, its
    // connection dropped) and exactly one video — the NEW card's — plays.
    await cardFor(2).locator('.play-overlay').click()
    await page.waitForFunction(() => {
      const videos = document.querySelectorAll('video')
      if (videos.length !== 1) return false
      const video = videos[0]
      return Boolean(!video.paused && video.readyState >= 2)
    }, undefined, { timeout: 15_000 })
    const playingSource = await page.evaluate(() => document.querySelector('video')?.getAttribute('src') ?? '')
    expect(playingSource).toContain('e2e-filmstrip-02')
    await expect(cardFor(1).locator('.play-overlay')).toBeVisible()

    expect(problems.filter((entry) => !environmental(entry))).toEqual([])
  } finally {
    // Restore the pre-test settings so the shared e2e home stays clean.
    await postSettings(originalSettings)
  }
})
