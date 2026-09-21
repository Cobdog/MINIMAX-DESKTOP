import { execSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'

// Node-pack status board (mjhlt3k): the version-aware badge matrix, the
// managed-instance notices, the Refresh button, and the AC-1 path-prompt
// gate — end to end against the built app with a LOCAL FAKE ENGINE (the
// test-instance suite's verified contract: /system_stats, /object_info,
// /models) and crafted custom_nodes fixture folders. No real engine, no
// network. Shared-home discipline: persisted settings are restored through
// the settings API in a finally; fixture folders live in os.tmpdir().

const environmental = (entry: string) =>
  entry.includes('Failed to load resource')
  || /WebSocket connection to .* failed/.test(entry)
  || /Connecting to 'blob:.*' violates the following Content Security Policy directive: "connect-src/.test(entry)
  || /net::ERR_CONNECTION_REFUSED/.test(entry)

async function trackErrors(page: Page) {
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`)
  })
  return problems
}

async function resetSession(page: Page) {
  await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } })
}

async function originalSettings(page: Page): Promise<Record<string, unknown>> {
  return ((await (await page.request.get('/api/lan/settings')).json()) as { settings: Record<string, unknown> }).settings
}

async function restoreSettings(page: Page, settings: Record<string, unknown>) {
  await page.request.post('/api/lan/settings', { data: { settings } })
}

async function openSettings(page: Page) {
  await page.locator('[data-canvas-settings-button]').click()
  await expect(page.locator('[data-canvas-settings-dock]')).toBeVisible()
}

/** A real git repo with one commit — its HEAD sha is unrelated to every
 *  registry pin, exercising the honest differs notice. */
function craftGitPackFixture(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const env = { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' }
  const git = (...args: string[]) => execSync(`git -C ${JSON.stringify(dir)} ${args.join(' ')}`, { env, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  git('init -q -b main')
  git('-c user.email=pack@test -c user.name=pack commit --allow-empty -q -m fixture')
  return git('rev-parse HEAD')
}

// The board matrix at a glance (AC-3 + AC-4 + AC-1 + AC-2): one capture of
// the packs section against fixtures covering every badge state the folder
// + instance can produce together.
test('node-pack status board — badges, versions, managed notices, refresh, no path prompts', async ({ page }) => {
  const problems = await trackErrors(page)
  const original = await originalSettings(page)
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-nodepacks-'))
  const engine = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://engine.local')
    if (url.pathname === '/system_stats') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ system: { comfyui_version: 'v0.34.0' }, devices: [] }))
      return
    }
    // The instance serves the hybrid loader's classes (installed on the
    // instance with NO folder — the live-only verdict) and nothing else —
    // through BOTH the full and the targeted per-class form (Wave 2 A-8:
    // key-miss = absence, never the status).
    const objectInfo = {
      UNETLoader: { input: { required: { unet_name: [['instance-only.safetensors'], {}] } } },
      MiniMaxH3HybridLoader: { input: { required: {} } },
      KSamplerSelect: { input: { required: {} } },
    }
    const targetedClass = /^\/object_info\/(.+)$/.exec(url.pathname)
    if (targetedClass) {
      const className = decodeURIComponent(targetedClass[1]!)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(className in objectInfo ? { [className]: objectInfo[className] } : {}))
      return
    }
    if (url.pathname === '/object_info') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(objectInfo))
      return
    }
    if (url.pathname === '/models' || url.pathname === '/models/diffusion_models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(url.pathname === '/models' ? ['diffusion_models'] : ['instance-only.safetensors']))
      return
    }
    res.writeHead(404)
    res.end()
  })
  const enginePort = await new Promise<number>((resolvePort) => engine.listen(0, '127.0.0.1', () => resolvePort((engine.address() as { port: number }).port)))
  try {
    // Fixtures: studio marker AT the pin / Comfy-Registry pyproject / git
    // checkout / plain foreign / absent.
    const markerDir = path.join(externalDir, 'comfyui-krea2edit')
    fs.mkdirSync(markerDir, { recursive: true })
    fs.writeFileSync(path.join(markerDir, '.studio-node.json'), `${JSON.stringify({ id: 'krea2edit', revision: '86f886dac23013d88996e3a2e99093ba44d322fb', mode: 'user-fetch', installedAt: Date.now(), source: 'e2e' }, null, 2)}\n`)
    const cnrDir = path.join(externalDir, 'comfyui-krea2-controlnet')
    fs.mkdirSync(cnrDir, { recursive: true })
    fs.writeFileSync(path.join(cnrDir, 'pyproject.toml'), '[project]\nname = "comfyui-krea2-controlnet"\nversion = "1.4.2"\n\n[tool.comfy]\nPublisherId = "facok"\n')
    const gitSha = craftGitPackFixture(path.join(externalDir, 'ComfyUI_MinimaxH3_AutoContext'))
    const plainDir = path.join(externalDir, 'krea2-anypaint')
    fs.mkdirSync(plainDir, { recursive: true })
    fs.writeFileSync(path.join(plainDir, 'user-file.py'), '# theirs\n')

    const applied = await page.request.post('/api/lan/settings', { data: { settings: {
      ...original,
      comfyUrl: `http://127.0.0.1:${enginePort}`,
      engine: { ...(original.engine as Record<string, unknown>), mode: 'external', externalCustomNodesDir: externalDir },
    } } })
    expect(applied.status(), `settings POST must succeed: ${JSON.stringify(await applied.json().catch(() => ({})))}`).toBe(200)

    await resetSession(page)
    await page.goto('/')
    await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
    await openSettings(page)

    // ---- AC-3: the badge matrix, one assertion per state ------------------
    const krea2editRow = page.locator('.node-pack-row').filter({ hasText: 'comfyui-krea2edit' })
    await expect(krea2editRow.locator('[data-node-pack-chip]')).toBeAttached({ timeout: 15_000 })
    await expect(krea2editRow.locator('[data-node-pack-chip]')).toHaveAttribute('data-node-pack-chip', 'installed @ pin — restart engine to activate')
    await expect(krea2editRow.locator('[data-node-pack-version]')).toHaveText('86f886dac230')

    const cnrRow = page.locator('.node-pack-row').filter({ hasText: 'comfyui-krea2-controlnet' })
    await expect(cnrRow.locator('[data-node-pack-chip]')).toHaveAttribute('data-node-pack-chip', 'managed by ComfyUI')
    await expect(cnrRow.locator('[data-node-pack-version]')).toHaveText('1.4.2')
    // Branch pin (main) vs a registry semver: no relation claimed, no notice.
    await expect(cnrRow.locator('.node-pack-managed-notice')).toHaveCount(0)

    const gitRow = page.locator('.node-pack-row').filter({ hasText: 'ComfyUI_MinimaxH3_AutoContext' })
    await expect(gitRow.locator('[data-node-pack-chip]')).toHaveAttribute('data-node-pack-chip', 'managed by ComfyUI')
    await expect(gitRow.locator('[data-node-pack-version]')).toHaveText(`${gitSha.slice(0, 12)} · differs from pin`)
    // ---- AC-4: the managed-instance notice names both versions + says the
    // update happens instance-side (the studio never touches the folder).
    const gitNotice = gitRow.locator('.node-pack-managed-notice')
    await expect(gitNotice).toBeVisible()
    await expect(gitNotice).toContainText('managed by the ComfyUI instance')
    await expect(gitNotice).toContainText(gitSha.slice(0, 12))
    await expect(gitNotice).toContainText('f1062d34e3c2')
    await expect(gitNotice).toContainText('instance side')

    const anypaintRow = page.locator('.node-pack-row').filter({ hasText: 'krea2-anypaint' })
    await expect(anypaintRow.locator('[data-node-pack-chip]')).toHaveAttribute('data-node-pack-chip', 'present — not studio-managed')
    const hybridRow = page.locator('.node-pack-row').filter({ hasText: 'ComfyUI_MinimaxH3HybridLoader' })
    await expect(hybridRow.locator('[data-node-pack-chip]')).toHaveAttribute('data-node-pack-chip', 'installed on instance')
    const radianceRow = page.locator('.node-pack-row').filter({ hasText: 'ComfyUI-MiniMax-H3-Turbo' })
    await expect(radianceRow.locator('[data-node-pack-chip]')).toHaveAttribute('data-node-pack-chip', 'missing', { timeout: 15_000 })

    // ---- AC-1: no path prompts anywhere once the target is known ----------
    await expect(page.locator('.node-pack-source')).toHaveCount(0)
    // A missing network pack's install affordance is Fetch… (no Install
    // button demanding a path); its Fetch is enabled with a target set.
    await expect(radianceRow.getByRole('button', { name: 'Fetch…' })).toBeEnabled()
    await expect(radianceRow.getByRole('button', { name: /^Install$/ })).toHaveCount(0)
    // A foreign row refuses every install affordance: no Fetch…, and the
    // user-fetch row carries no Install button at all (Fetch… is its only
    // install path; the presence note explains the refusal).
    await expect(anypaintRow.getByRole('button', { name: 'Fetch…' })).toHaveCount(0)
    await expect(anypaintRow.getByRole('button', { name: /^Install$/ })).toHaveCount(0)

    // ---- AC-2: Refresh re-scans the folder and re-resolves every row -----
    const lateDir = path.join(externalDir, 'ComfyUI-MiniMax-H3-Turbo')
    fs.mkdirSync(lateDir, { recursive: true })
    fs.writeFileSync(path.join(lateDir, 'their-file.py'), '# theirs\n')
    await expect(radianceRow.locator('[data-node-pack-chip]')).toHaveAttribute('data-node-pack-chip', 'missing')
    const refresh = page.locator('[data-node-pack-refresh]')
    await refresh.scrollIntoViewIfNeeded()
    await refresh.click()
    await expect(radianceRow.locator('[data-node-pack-chip]')).toHaveAttribute('data-node-pack-chip', 'present — not studio-managed', { timeout: 15_000 })
    expect(problems.filter((entry) => !environmental(entry))).toEqual([])
  } finally {
    await restoreSettings(page, original).catch(() => undefined)
    engine.close()
    fs.rmSync(externalDir, { recursive: true, force: true })
  }
})
