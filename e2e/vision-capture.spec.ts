import fs from 'node:fs'
import path from 'node:path'
import { test } from '@playwright/test'
import { SCENARIOS } from '../scripts/vision-e2e/scenarios'

/**
 * VISION CAPTURE — phase 1 of 3 (see scripts/vision-e2e/JUDGE.md).
 *
 * Drives the scenarios at the pinned 1920x1080 viewport and writes a
 * self-describing bundle under test-results/vision/<run-id>/:
 *
 *   <run-id>--<checkpoint-id>.png   full-page capture of the checkpoint
 *   manifest.json                   run metadata + image→rubric mapping
 *
 * Capture NEVER judges and NEVER calls any model or external API. It exits 0
 * when the bundle is complete and prints `VISION_BUNDLE <path>`; the next
 * steps (judge → report) are dispatched by the orchestrator:
 *   judge:  Sonnet subagent running scripts/vision-e2e/JUDGE.md on the bundle
 *   report: pnpm vision:report [bundle-path]
 *
 * Filenames carry the run-id prefix on EVERY image: the harness's Read-tool
 * image upload dedupes by filename, so unique names guarantee a judge never
 * gets a stale cached upload for a regenerated screenshot.
 *
 * Console noise note: engine-offline fetch failures are expected (same
 * `environmental` class as e2e/app.spec.ts); capture records them into the
 * manifest as judge context instead of failing.
 */

const RESULTS_ROOT = path.resolve('test-results/vision')

// Cache-busting run id: timestamped, pid-tagged, random-suffixed.
const runId = [
  new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\..+/, ''),
  process.pid,
  Math.random().toString(36).slice(2, 6),
].join('-')

const bundleDir = path.join(RESULTS_ROOT, runId)

/** Collected per scenario while the tests run (workers=1 — file order). */
type CapturedScenario = {
  id: string
  label: string
  startedAt: string
  consoleErrors: string[]
  checkpoints: Array<{ id: string; label: string; image: string; rubric: string }>
}
const captured: CapturedScenario[] = []

test.beforeAll(() => {
  fs.mkdirSync(bundleDir, { recursive: true })
})

test.afterAll(() => {
  if (captured.length === 0) return
  const manifest = {
    runId,
    createdAt: new Date().toISOString(),
    viewport: { width: 1920, height: 1080, deviceScaleFactor: 1, fullPage: true },
    scenarioCount: captured.length,
    scenarios: captured,
    judge: {
      instructions: 'scripts/vision-e2e/JUDGE.md',
      output: 'verdicts.json (this directory)',
      report: 'pnpm vision:report <this-directory>',
    },
  }
  fs.writeFileSync(path.join(bundleDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  // Pointer for `pnpm vision:report` with no argument (newest bundle wins
  // anyway on mtime; the pointer survives and makes intent explicit).
  fs.writeFileSync(path.join(RESULTS_ROOT, 'LATEST'), `${runId}\n`)
  console.log(`\nVISION_BUNDLE ${bundleDir}`)
  console.log('Next: dispatch the judge subagent (scripts/vision-e2e/JUDGE.md), then `pnpm vision:report`.\n')
})

for (const scenario of SCENARIOS) {
  test(`vision capture: ${scenario.label}`, async ({ page }) => {
    const consoleErrors: string[] = []
    page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`))
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(`console.error: ${message.text()}`)
    })

    const startedAt = new Date().toISOString()
    await scenario.run(page)

    const entry: CapturedScenario = {
      id: scenario.id,
      label: scenario.label,
      startedAt,
      consoleErrors: [],
      checkpoints: [],
    }
    for (const checkpoint of scenario.checkpoints) {
      // Optional per-checkpoint driver (datasets-workbench, sv14rt0): lets
      // one scenario present several states. Absent on older scenarios —
      // the loop captures the state run() left, exactly as before.
      if (checkpoint.drive) await checkpoint.drive(page)
      const image = `${runId}--${checkpoint.id}.png`
      await page.screenshot({ path: path.join(bundleDir, image), fullPage: true })
      entry.checkpoints.push({ id: checkpoint.id, label: checkpoint.label, image, rubric: checkpoint.rubric })
    }

    await scenario.after?.(page)
    // Environmental noise only (engine offline / live-preview WS) — recorded
    // for the judge's context, not treated as capture failures.
    entry.consoleErrors = consoleErrors
      .filter((line) => !line.includes('Failed to load resource'))
      .filter((line) => !/WebSocket connection to .* failed/.test(line))
      .slice(0, 20)
    captured.push(entry)
  })
}
