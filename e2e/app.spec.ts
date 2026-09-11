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
