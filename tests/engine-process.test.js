// EngineProcess supervision contract test (wave 2c). Real child processes —
// no mocks of the process layer. Exercises, against dist-server like the
// sibling suites:
//   (a) NDJSON round-trip over stdout AND stderr: structured pass-through,
//       raw-line wrap, CRLF stripping, events observed BEFORE the stop (the
//       anti-buffering proof)
//   (b) readiness: ndjson match, exit-before-ready rejection, matcher
//       timeout rejection, http poll (fail-closed guard, then a wired guard)
//   (c) graceful stop: quit line respected, exit 0, killedByUs false
//   (d) forced tree-kill: SIGTERM-immune grandchild dead with the tree
//       (verified by PID-liveness polling), killedByUs true
//   (e) exit taxonomy: non-zero immediate exit; hard-timeout flag
//   (f) shutdownAll reaps the registry
//   (g) python realism when python3 is on PATH (PYTHONUNBUFFERED/-u asserted
//       from inside the child) — skipped with a note otherwise
// Run after `pnpm build:server` (the module loads from dist-server).
//
// Vitest port (task z7ogmig, 2026-09-20) of scripts/test-engine-process.cjs:
// assertion bodies carry over verbatim; the linear main() became one test
// per section; the module-scope dist-server require is guarded so a missing
// build NOTE-skips the file instead of crashing; the http-probe port draws
// from this suite's disjoint range (tests/lib/ports.cjs).
import { test, beforeAll } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = require('node:path').dirname(fileURLToPath(import.meta.url))
const REPO = require('node:path').resolve(__dirname, '..')

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { makePortAllocator } = require('./lib/ports.cjs')

const freePort = makePortAllocator('engine-process')

// NOTE guard: without a dist-server build there is nothing to test here —
// the suite runs on legs that build the server (the suite's own philosophy).
const hasServerBuild = fs.existsSync(path.join(REPO, 'dist-server', 'server', 'engineProcess.js'))
if (!hasServerBuild) {
  console.log('NOTE - no dist-server build present (engineProcess.js); run pnpm build:server — this suite runs on legs that build the server.')
}
const maybe = hasServerBuild ? test : test.skip

const { EngineProcess } = hasServerBuild ? require(path.join(REPO, 'dist-server', 'server', 'engineProcess.js')) : {}

const FIXTURE = path.join(REPO, 'scripts', 'fixtures', 'engine-child.cjs')
const PYTHON_FIXTURE = path.join(REPO, 'scripts', 'fixtures', 'engine-child.py')
const IS_WIN = process.platform === 'win32'
// The grandchild fixture outlives its parent by 10 s on purpose; the
// tree-kill sweep lands around 3.5 s. Anything under ~8 s proves the sweep
// killed it (its own timer would only fire at 10 s).
const GRANDCHILD_DEATH_BUDGET_MS = 8_000

const phases = []
if (hasServerBuild) EngineProcess.setEngineSink((event) => phases.push(event))

function phaseTrace(name) {
  return phases.filter((event) => event.name === name).map((event) => event.phase)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** process.kill(pid, 0) is the portable existence probe; EPERM means "alive
 *  but not ours to signal" (still alive for this test's purposes). */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(50)
  }
  if (predicate()) return true
  throw new Error(`timed out after ${timeoutMs} ms waiting for: ${label}`)
}

function probePython() {
  const candidates = IS_WIN ? ['python', 'python3'] : ['python3', 'python']
  return new Promise((resolve) => {
    const attempt = (index) => {
      if (index >= candidates.length) {
        resolve(null)
        return
      }
      // The Windows Store python3.exe alias exists but is NOT a usable
      // interpreter — the exit-code check rejects it and tries the next.
      const child = spawn(candidates[index], ['-c', 'import sys; sys.exit(0)'], { stdio: 'ignore', windowsHide: true })
      child.on('error', () => attempt(index + 1))
      child.on('exit', (code) => (code === 0 ? resolve(candidates[index]) : attempt(index + 1)))
    }
    attempt(0)
  })
}

let passed = 0
function ok(condition, label) {
  assert.ok(condition, label)
  passed += 1
  console.log(`  ok - ${label}`)
}

let python = null
beforeAll(async () => {
  python = await probePython()
})

maybe('(a) NDJSON round-trip + (b) ndjson readiness + (c) graceful stop', async () => {
  console.log('engine-process: ndjson round-trip, readiness, graceful stop')
  {
    const events = []
    const exits = []
    const engine = EngineProcess.spawn({
      command: process.execPath,
      args: [FIXTURE],
      name: 'ndjson-child',
      readiness: { type: 'ndjson', match: (event) => event.msg === 'ready', timeoutMs: 10_000 },
      onEvent: (event) => events.push(event),
      onExit: (summary) => exits.push(summary),
    })
    await engine.ready
    const boot = events.find((event) => event.msg === 'boot')
    ok(boot && boot.level === 'info', 'structured NDJSON event passes through')
    ok(events.some((event) => event.level === 'raw' && event.msg === 'plain text that is not json'), 'non-JSON line wraps as {level:"raw"} with the CR stripped')
    ok(engine.pid !== null && isAlive(engine.pid), 'child pid exposed and alive')
    const summary = await engine.gracefulStop()
    ok(summary.code === 0 && summary.signal === null, 'quit line honored: exit 0')
    ok(summary.killedByUs === false && summary.timedOut === false, 'graceful stop is not a kill and not a timeout')
    ok(summary.durationMs > 0, 'durationMs recorded')
    ok(exits.length === 1 && exits[0] === summary, 'onExit fired exactly once with the settled summary')
    ok(events.some((event) => event.msg === 'bye'), 'post-quit event still parsed (pipe flush before destroy)')
    const trace = phaseTrace('ndjson-child')
    ok(trace.join(',') === 'starting,ready,stopped', `phase trace starting→ready→stopped (got ${trace.join(',')})`)
    ok(!isAlive(engine.pid), 'child reaped after graceful exit')
  }
})

maybe('(b) readiness rejection taxonomy: exit-before-ready, matcher timeout', async () => {
  console.log('engine-process: readiness rejection taxonomy')
  {
    const failFastEvents = []
    const failFast = EngineProcess.spawn({
      command: process.execPath,
      args: [FIXTURE, '--fail-fast'],
      name: 'fail-fast-child',
      readiness: { type: 'ndjson', match: () => false, timeoutMs: 10_000 },
      onEvent: (event) => failFastEvents.push(event),
    })
    const failFastSummary = await failFast.exited
    ok(failFastSummary.code === 7, 'non-zero immediate exit normalized (code 7)')
    await assert.rejects(failFast.ready, /before becoming ready/, 'ready rejects when the child exits first')
    ok(failFastEvents.some((event) => event.level === 'raw' && event.msg === 'engine-child: failing fast'), 'stderr lines are parsed through the same NDJSON contract')
    ok(phaseTrace('fail-fast-child').includes('failed'), 'failed phase emitted for exit-before-ready')

    const noMatch = EngineProcess.spawn({
      command: process.execPath,
      args: [FIXTURE],
      name: 'no-match-child',
      readiness: { type: 'ndjson', match: () => false, timeoutMs: 500 },
    })
    await assert.rejects(noMatch.ready, /no matching event/, 'ready rejects on matcher timeout with a clear error')
    const noMatchSummary = await noMatch.gracefulStop()
    ok(noMatchSummary.code === 0 && noMatchSummary.killedByUs === false, 'a readiness failure does not leak the (still healthy) child')
  }
})

maybe('(b) http readiness: fail-closed default guard, then wired guard', async () => {
  console.log('engine-process: http readiness probe')
  {
    // No setUrlGuard has run: the module default is deny-all, so even a
    // loopback probe must reject BEFORE any fetch leaves the process.
    const guardless = EngineProcess.spawn({
      command: process.execPath,
      args: [FIXTURE],
      name: 'guardless-child',
      readiness: { type: 'http', url: 'http://127.0.0.1:9/', timeoutMs: 3_000 },
    })
    await assert.rejects(guardless.ready, /rejected \(local-only\)/, 'unwired URL guard fails closed')
    ok(phaseTrace('guardless-child').includes('failed'), 'failed phase emitted on guard rejection')
    await guardless.gracefulStop()

    EngineProcess.setUrlGuard(() => true)
    const port = await freePort()
    const events = []
    const httpChild = EngineProcess.spawn({
      command: process.execPath,
      args: [FIXTURE, '--http', String(port)],
      name: 'http-child',
      readiness: { type: 'http', url: `http://127.0.0.1:${port}`, pollMs: 100, timeoutMs: 10_000 },
      onEvent: (event) => events.push(event),
    })
    await httpChild.ready
    ok(true, 'http poll resolves once the child listens')
    const httpSummary = await httpChild.gracefulStop()
    ok(httpSummary.code === 0 && httpSummary.killedByUs === false, 'http-ready child stops gracefully')
  }
})

maybe('(d)+(e) forced tree-kill: grandchild dies with the tree', async () => {
  console.log('engine-process: forced tree-kill (SIGTERM-immune grandchild)')
  {
    const events = []
    const engine = EngineProcess.spawn({
      command: process.execPath,
      args: [FIXTURE, '--no-quit'],
      name: 'force-kill-child',
      graceTimeoutMs: 400,
      readiness: { type: 'ndjson', match: (event) => event.msg === 'ready', timeoutMs: 10_000 },
      onEvent: (event) => events.push(event),
    })
    await engine.ready
    const grandchildEvent = events.find((event) => event.msg === 'grandchild')
    ok(grandchildEvent && Number.isInteger(grandchildEvent.pid), 'grandchild pid announced over NDJSON')
    const grandchildPid = grandchildEvent.pid
    ok(isAlive(grandchildPid), 'grandchild alive before the stop')
    const summary = await engine.gracefulStop()
    ok(summary.killedByUs === true, 'grace window expiry escalated to killTree')
    ok(summary.timedOut === false, 'a grace escalation is not a hard timeout')
    if (IS_WIN) {
      ok(summary.code !== 0 || summary.signal !== null, `taskkill /T /F exit taxonomy (code ${summary.code})`)
    } else {
      ok(summary.signal === 'SIGTERM' || summary.signal === 'SIGKILL', `POSIX group-kill signal taxonomy (got ${summary.signal})`)
    }
    const grandchildDead = await (async () => {
      const deadline = Date.now() + GRANDCHILD_DEATH_BUDGET_MS
      while (Date.now() < deadline) {
        if (!isAlive(grandchildPid)) return true
        await sleep(50)
      }
      return !isAlive(grandchildPid)
    })()
    ok(grandchildDead, 'SIGTERM-immune grandchild died with the tree (not by its own 10 s timer)')
    const trace = phaseTrace('force-kill-child')
    ok(trace[trace.length - 1] === 'stopped', `a supervisor-initiated kill reports 'stopped' (got ${trace.join(',')}) — 'failed' is reserved for ends nobody ordered`)
  }
})

maybe('(e) hard deadline taxonomy', async () => {
  console.log('engine-process: hard timeout')
  {
    const events = []
    const engine = EngineProcess.spawn({
      command: process.execPath,
      args: [FIXTURE, '--no-quit'],
      name: 'hard-timeout-child',
      hardTimeoutMs: 500,
      readiness: { type: 'ndjson', match: (event) => event.msg === 'ready', timeoutMs: 10_000 },
      onEvent: (event) => events.push(event),
    })
    await engine.ready
    const summary = await engine.exited
    ok(summary.timedOut === true, 'hard deadline sets timedOut')
    ok(summary.killedByUs === true, 'hard deadline tree-kills the child')
    ok(phaseTrace('hard-timeout-child').includes('failed'), 'a hung engine killed by the hard deadline reports the failed phase')
    const grandchildEvent = events.find((event) => event.msg === 'grandchild')
    if (grandchildEvent) {
      ok(await waitUntil(() => !isAlive(grandchildEvent.pid), GRANDCHILD_DEATH_BUDGET_MS, 'hard-timeout grandchild death'), 'hard-timeout tree-kill also reaches the grandchild')
    }
  }
})

maybe('(f) shutdownAll reaps the registry', async () => {
  console.log('engine-process: shutdownAll')
  {
    EngineProcess.spawn({ command: process.execPath, args: [FIXTURE], name: 'bulk-1', readiness: { type: 'none' } })
    EngineProcess.spawn({ command: process.execPath, args: [FIXTURE], name: 'bulk-2', readiness: { type: 'none' } })
    ok(EngineProcess.liveCount >= 2, 'live registry tracks spawned engines')
    const summaries = await EngineProcess.shutdownAll()
    ok(summaries.length === 2 && summaries.every((summary) => summary.code === 0 && summary.killedByUs === false), 'shutdownAll gracefully stops everything it started')
    ok(EngineProcess.liveCount === 0, 'registry drained')
    const secondCall = await EngineProcess.shutdownAll()
    ok(secondCall.length === 0, 'shutdownAll is idempotent')
  }
})

maybe('(g) python realism: PYTHONUNBUFFERED merged and/or -u line buffering', async () => {
  console.log('engine-process: python unbuffered contract')
  if (!python) {
    console.log('  NOTE - no usable python3/python on PATH; skipping the python fixture (CI runners have it)')
  } else {
    const events = []
    const engine = EngineProcess.spawn({
      command: python,
      args: [PYTHON_FIXTURE],
      name: 'python-child',
      readiness: { type: 'ndjson', match: (event) => event.msg === 'ready', timeoutMs: 10_000 },
      onEvent: (event) => events.push(event),
    })
    await engine.ready
    const boot = events.find((event) => event.msg === 'boot')
    ok(Boolean(boot), 'python NDJSON observed before any stop (stdout not block-buffered)')
    ok(boot && (boot.unbufferedEnv === true || boot.lineBuffering === true), `PYTHONUNBUFFERED merged and/or -u line buffering (env=${boot && boot.unbufferedEnv} lineBuffering=${boot && boot.lineBuffering})`)
    const summary = await engine.gracefulStop()
    ok(summary.code === 0 && summary.killedByUs === false, 'python child honors the quit protocol')
    ok(events.some((event) => event.msg === 'bye'), 'python goodbye event parsed')
  }
  console.log(`engine-process: all ${passed} checks passed`)
})

