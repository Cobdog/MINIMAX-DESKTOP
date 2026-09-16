// Canvas Phase 1 — the L33 rendering-budget MEASUREMENT driver (spec §3).
//
// Boots the built app on a scratch home + port, opens ?canvas=1&bench=1 in
// system Chromium (the same never-download policy as playwright.config.ts),
// runs the in-page harness (src/canvas/Benchmark.tsx — stages 100/500/1000/
// 2000 synthetic objects on the REAL substrate and measures fps, pan jank,
// zoom fps, substrate renders, and culled DOM size), and writes the results
// to docs/research/canvas-rendering-budget.json.
//
// NOT part of the CI gate on purpose: shared-runner perf numbers are noise.
// The budget is a data point for the DOM-vs-Pixi flip decision; re-run
// locally on target hardware when the substrate changes materially:
//
//   pnpm build && node scripts/canvas-budget.cjs
//
// Flags:
//   --json <path>   output path (default docs/research/canvas-rendering-budget.json)
//   --headless=0    run headed (visible) for eyeballing the protocol
'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')

// -- flag parsing ------------------------------------------------------------
const args = process.argv.slice(2)
const outputPath = (() => {
  const index = args.indexOf('--json')
  return index >= 0 && args[index + 1] ? path.resolve(args[index + 1]) : path.join(ROOT, 'docs', 'research', 'canvas-rendering-budget.json')
})()
const headless = !args.includes('--headless=0')

// -- system chromium resolution (same policy as playwright.config.ts) --------
const CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/chrome',
  ...(process.env.MINIMAX_TEST_BROWSER ? [process.env.MINIMAX_TEST_BROWSER] : []),
]
function resolveChromium() {
  for (const candidate of CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate
  }
  fail(`no system Chromium/Chrome found — install one or set MINIMAX_TEST_BROWSER (this script never downloads a browser)`)
}
function fail(message) {
  console.error(`canvas-budget: ${message}`)
  server?.kill()
  process.exit(1)
}

// -- boot the built app --------------------------------------------------------
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-canvas-budget-'))
const port = String(4590 + Math.floor(Math.random() * 200))
const server = spawn(process.execPath, ['dist-server/server/index.js'], {
  env: { ...process.env, MINIMAX_STUDIO_HOME: home, MINIMAX_LAN_PORT: port, MINIMAX_NO_HTTPS: '1' },
  stdio: ['ignore', 'ignore', 'ignore'],
  cwd: ROOT,
})

// -- drive chromium over CDP (no puppeteer: raw CDP over the websocket is
//    overkill; playwright is a devDependency — use it) ------------------------
async function main() {
  const { chromium } = require('@playwright/test')
  const executablePath = resolveChromium()
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/api/lan/settings`)
      if (probe.ok) break
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 300))
    if (attempt === 59) fail('the built server never became ready — run `pnpm build` first')
  }

  const browser = await chromium.launch({ executablePath, headless })
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  const consoleErrors = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  await page.goto(`http://127.0.0.1:${port}/?canvas=1&bench=1`)
  await page.waitForSelector('[data-canvas-bench-panel]', { timeout: 20_000 })
  console.log('harness mounted — running the protocol (≈30 s, four stages)…')
  await page.locator('[data-canvas-bench-run]').click()

  // The harness prints CANVAS_BUDGET <json> when done; poll the window too.
  const payload = await page.waitForFunction(() => globalThis.__canvasBudgetResults, null, { timeout: 180_000 })
  const results = await payload.jsonValue()
  await browser.close()

  if (!results || !Array.isArray(results.results) || results.results.length !== 4) {
    fail(`the harness returned an unexpected payload: ${JSON.stringify(results).slice(0, 300)}`)
  }
  if (consoleErrors.length) {
    console.log(`note: ${consoleErrors.length} console error(s) during the run (environmental fetch/WS failures are expected offline):`)
    for (const line of consoleErrors.slice(0, 5)) console.log(`  ${line.slice(0, 160)}`)
  }

  const record = {
    _comment: 'L33 rendering-budget measurement (canvas-ui-v1 §3). Produced by scripts/canvas-budget.cjs driving ?canvas=1&bench=1 (src/canvas/Benchmark.tsx): the REAL substrate, synthetic document, staged objects. fps = delivered rAF frames/sec; jank = fraction of pan frames > 20 ms; renders = substrate React re-renders (band/cull-set changes only — pan must be ~0); DOM = tiles mounted after culling. Re-run on target hardware when the substrate changes materially.',
    ...results,
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`)
  console.log(`\nwrote ${path.relative(ROOT, outputPath)}`)
  for (const stage of record.results) {
    console.log(
      `  N=${String(stage.staged).padStart(4)}  edges=${String(stage.edges).padStart(4)}  idle=${stage.idleFps.toFixed(0)}fps  drift=${stage.driftFps.toFixed(0)}fps (renders ${stage.rendersDrift})  pan=${stage.panFps.toFixed(0)}fps (jank ${(stage.panJank * 100).toFixed(0)}%, renders ${stage.rendersPan})  zoom=${stage.zoomFps.toFixed(0)}fps (renders ${stage.rendersZoom})  idle renders ${stage.rendersIdle}  DOM=${stage.mountedTiles}  ${Math.round(stage.stageMs)}ms`,
    )
  }
  server.kill()
  process.exit(0)
}

main().catch((error) => fail(error instanceof Error ? error.stack : String(error)))
