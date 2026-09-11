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
