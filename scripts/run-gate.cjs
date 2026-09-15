#!/usr/bin/env node
'use strict'

/**
 * UNIFIED GATE — the full verification chain in canonical order.
 *
 *   pnpm gate
 *
 * Suites (each in its OWN process, output captured; streamed on failure):
 *   typecheck → lint → unit/node suites (test, test:registry, test:storage,
 *   test:realtime, test:filmstrip, test:llm, test:engine, test:runtime,
 *   test:fetcher) →
 *   build → smoke:server → e2e (Playwright) → vision-capture (Playwright).
 *
 * Behavior:
 *   - Per-suite PASS/FAIL line with wall-clock timing.
 *   - NOISE SUPPRESSION: known-benign output lines (pino logs, webpack
 *     chunk-size warnings, pnpm's own bookkeeping …) are filtered even on
 *     failure, and a green run's output stays short; a red run's output
 *     points at the real cause (full filtered output of the failing suite,
 *     plus the suppression tally so nothing disappears silently).
 *   - A failed `build` skips its dependents (smoke / e2e / vision) as
 *     SKIP(dep) — everything else still runs so one failure doesn't hide
 *     another.
 *   - Final summary table; process exits non-zero if anything failed.
 *
 * The vision-capture step only CAPTURES a screenshot bundle (phase 1 of 3).
 * Judgment is harness-side (scripts/vision-e2e/JUDGE.md), reporting is
 * `pnpm vision:report` — the gate prints the pending-bundle pointer at the
 * end when a fresh bundle has not been judged yet.
 */

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const IS_WINDOWS = process.platform === 'win32'
const MINUTE = 60_000

/** Gate order is canonical — do not reorder without updating README. */
const SUITES = [
  { name: 'typecheck', command: 'pnpm run typecheck', timeoutMs: 10 * MINUTE },
  { name: 'lint', command: 'pnpm run lint', timeoutMs: 10 * MINUTE },
  // License audit (task 68rnn84): dependency SPDX classification + the
  // never-vendor-what-we-can't-ship registry invariant. Docs-only duty —
  // runs before the heavy suites so a red license state is visible early.
  { name: 'license:audit', command: 'pnpm run license:audit', timeoutMs: 2 * MINUTE },
  { name: 'test', command: 'pnpm run test', timeoutMs: 20 * MINUTE },
  { name: 'test:registry', command: 'pnpm run test:registry', timeoutMs: 20 * MINUTE },
  { name: 'test:storage', command: 'pnpm run test:storage', timeoutMs: 20 * MINUTE },
  { name: 'test:realtime', command: 'pnpm run test:realtime', timeoutMs: 20 * MINUTE },
  { name: 'test:filmstrip', command: 'pnpm run test:filmstrip', timeoutMs: 20 * MINUTE },
  { name: 'test:llm', command: 'pnpm run test:llm', timeoutMs: 20 * MINUTE },
  { name: 'test:engine', command: 'pnpm run test:engine', timeoutMs: 20 * MINUTE },
  { name: 'test:runtime', command: 'pnpm run test:runtime', timeoutMs: 20 * MINUTE },
  // Local-first fetcher (task hgjbea2): catalog integrity, consent gating,
  // verification, pin stamping, placement, routes — transport mocked, zero
  // real network.
  { name: 'test:fetcher', command: 'pnpm run test:fetcher', timeoutMs: 20 * MINUTE },
  // Form-adapter node (task k271ykk): the node package's python suite
  // (centered-fit math, both traps, the kijai golden) + the server-side
  // registry/catalog/detection suites. Needs python3+numpy for the math
  // half (CI installs it; the suite skips loudly when python is absent and
  // FAILS when python exists without numpy).
  { name: 'test:lora-form', command: 'pnpm run test:lora-form', timeoutMs: 20 * MINUTE },
  // build:web + build:server directly — typecheck already ran as its own suite
  // (the plain `build` script re-runs typecheck; redundant here).
  { name: 'build', command: 'pnpm run build:web && pnpm run build:server', timeoutMs: 15 * MINUTE, dependents: ['smoke:server', 'e2e', 'vision-capture'] },
  { name: 'smoke:server', command: 'pnpm run smoke:server', timeoutMs: 5 * MINUTE },
  // Playwright directly (build is fresh) — scoped to the two projects.
  { name: 'e2e', command: 'pnpm exec playwright test --project=e2e', timeoutMs: 30 * MINUTE },
  { name: 'vision-capture', command: 'pnpm exec playwright test --project=vision', timeoutMs: 15 * MINUTE },
]

/**
 * Known-benign output (filtered everywhere, tallied per pattern). Keep this
 * list principled: every entry is output that carries no signal about
 * whether the suite passed, and each `why` says so.
 */
const NOISE_PATTERNS = [
  { why: 'pnpm run bookkeeping', re: /^(\$ |Done in \d+(\.\d+)?s$|\/home\/\S+$|"" )/ },
  { why: 'pnpm lockfile/supply-chain notices', re: /^(✓ Lockfile|Lockfile is up to date|Already up to date|Progress: resolved)/ },
  { why: 'vite/webpack chunk-size advisory', re: /(Some chunks are larger than|after minification:|entry point size limit|adjust the chunk size limit|The following chunk\(s\) exceeded|larger than \d+ kB)/ },
  { why: 'vite build banner', re: /^(vite v\d|transforming|rendering chunks|computing gzip size|dist\/)/ },
  { why: 'electron download notice', re: /(electron|Electron).{0,80}(download|mirror|skip)/ },
  { why: 'pino pretty server log line', re: /^\[?\d{1,2}:\d{2}:\d{2}(\.\d+)?\]? (AM |PM )?(INFO|WARN|DEBUG|ERROR|TRACE):/ },
  { why: 'playwright server teardown noise', re: /(webserver exit|Process from webserver|killed by signal|Error: Page closed)/ },
]

function filterOutput(raw) {
  const lines = raw.split(/\r?\n/)
  const kept = []
  const suppressed = new Map()
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed !== '') {
      const hit = NOISE_PATTERNS.find((pattern) => pattern.re.test(line) || pattern.re.test(trimmed))
      if (hit) {
        suppressed.set(hit.why, (suppressed.get(hit.why) ?? 0) + 1)
        continue
      }
    }
    kept.push(line)
  }
  return { kept, suppressed }
}

function runSuite(suite) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(suite.command, {
      shell: true,
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const append = (chunk) => { output += chunk.toString() }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const timer = setTimeout(() => {
      output += `\n[GATE] suite "${suite.name}" exceeded its ${(suite.timeoutMs / MINUTE).toFixed(0)}m timeout and was killed\n`
      if (IS_WINDOWS) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: true })
      else child.kill('SIGKILL')
    }, suite.timeoutMs)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const { kept, suppressed } = filterOutput(output)
      resolve({
        suite,
        status: signal || (code !== null && code !== 0) ? 'FAIL' : 'PASS',
        exitCode: code,
        signal,
        seconds: (Date.now() - started) / 1000,
        output: kept,
        suppressed,
      })
    })
  })
}

function printFailure(result) {
  const lines = result.output
  console.log(`    ---- ${result.suite.name} output (known-benign lines filtered) ----`)
  const tail = lines.length > 300 ? lines.slice(lines.length - 300) : lines
  if (lines.length > 300) console.log(`    [${lines.length - 300} earlier lines truncated]`)
  for (const line of tail) console.log(`    ${line}`)
  console.log('    ---- end output ----')
}

function suppressionTally(result) {
  if (result.suppressed.size === 0) return ''
  const parts = [...result.suppressed.entries()].map(([why, count]) => `${count}× ${why}`)
  return `  [suppressed benign output: ${parts.join(', ')}]`
}

async function main() {
  const gateStarted = Date.now()
  const results = []
  const failedNames = new Set()
  // dependencyOf: suite name → the suite whose failure skips it (a failed
  // build leaves smoke/e2e/vision without anything to run against).
  const dependencyOf = {}
  for (const suite of SUITES) {
    for (const dependent of suite.dependents ?? []) dependencyOf[dependent] = suite.name
  }

  console.log(`GATE — ${new Date().toISOString()} — ${SUITES.length} suites`)
  console.log('')

  for (const suite of SUITES) {
    if (dependencyOf[suite.name] && failedNames.has(dependencyOf[suite.name])) {
      const skipped = { suite, status: 'SKIP', seconds: 0, output: [], suppressed: new Map() }
      results.push(skipped)
      console.log(`  SKIP  ${suite.name.padEnd(16)} (dependency "${dependencyOf[suite.name]}" failed)`)
      continue
    }
    process.stdout.write(`  ....  ${suite.name.padEnd(16)}`)
    const result = await runSuite(suite)
    results.push(result)
    if (result.status === 'FAIL') failedNames.add(suite.name)
    const seconds = `${result.seconds.toFixed(1)}s`
    if (result.status === 'PASS') {
      console.log(`\r  PASS  ${suite.name.padEnd(16)} ${seconds}${suppressionTally(result)}`)
    } else {
      console.log(`\r  FAIL  ${suite.name.padEnd(16)} ${seconds}${result.signal ? ` (signal ${result.signal})` : ` (exit ${result.exitCode})`}`)
      printFailure(result)
    }
  }

  // Pending vision bundle pointer: a captured-but-unjudged bundle is normal
  // (judgment is harness-side); surface the next step so it can't be missed.
  const visionRoot = path.resolve(__dirname, '..', 'test-results', 'vision')
  const pointer = path.join(visionRoot, 'LATEST')
  if (fs.existsSync(pointer)) {
    const latest = fs.readFileSync(pointer, 'utf8').trim()
    const bundle = path.join(visionRoot, latest)
    if (fs.existsSync(bundle) && !fs.existsSync(path.join(bundle, 'verdicts.json'))) {
      console.log('')
      console.log(`  vision bundle captured but NOT judged: ${bundle}`)
      console.log('  next: dispatch the judge subagent (scripts/vision-e2e/JUDGE.md), then `pnpm vision:report`')
    }
  }

  const totalSeconds = (Date.now() - gateStarted) / 1000
  const passed = results.filter((result) => result.status === 'PASS').length
  const failed = results.filter((result) => result.status === 'FAIL').length
  const skipped = results.filter((result) => result.status === 'SKIP').length

  console.log('')
  console.log('  ┌─────────────────┬────────┬───────────┐')
  console.log('  │ suite           │ result │ wall time │')
  console.log('  ├─────────────────┼────────┼───────────┤')
  for (const result of results) {
    const mark = result.status === 'PASS' ? 'PASS' : result.status === 'FAIL' ? 'FAIL' : 'SKIP'
    console.log(`  │ ${result.suite.name.padEnd(15).slice(0, 15)} │ ${mark.padEnd(6)} │ ${(result.seconds.toFixed(1) + 's').padStart(9)} │`)
  }
  console.log('  ├─────────────────┼────────┼───────────┤')
  console.log(`  │ ${'TOTAL'.padEnd(15)} │ ${String(passed).padStart(2)}/${String(results.length).padStart(2)}  │ ${(totalSeconds.toFixed(1) + 's').padStart(9)} │`)
  console.log('  └─────────────────┴────────┴───────────┘')
  if (skipped > 0) console.log(`  (${skipped} suite(s) skipped on failed dependencies)`)
  console.log('')
  if (failed > 0) {
    console.log(`GATE RED — ${failed} failing suite(s): ${results.filter((r) => r.status === 'FAIL').map((r) => r.suite.name).join(', ')}`)
    process.exit(1)
  }
  console.log(`GATE GREEN — all ${passed} executed suites passed in ${(totalSeconds / 60).toFixed(1)}m`)
  process.exit(0)
}

main().catch((error) => {
  console.error(`GATE harness error: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
