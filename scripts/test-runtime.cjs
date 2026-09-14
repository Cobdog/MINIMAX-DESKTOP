// RuntimeManager suite (self-managed ComfyUI runtime, increment 1). Real
// child processes, no mocks of the process layer — a checkout-shaped STUB
// (scripts/fixtures/runtime-stub*.cjs, copied into a temp checkout as
// main.py) stands in for ComfyUI: it binds the port, serves /system_stats,
// logs NDJSON + raw lines, and NEVER reads stdin, exactly like the real
// engine. The production spawn path runs verbatim (command from settings,
// cwd = checkout, fixed argv). Neither python nor a real ComfyUI checkout is
// required anywhere; the python section runs only when an interpreter
// exists and skips with a logged note otherwise. Sections:
//   (a) extra_model_paths.yaml generation: validation, escaping, foreign
//       file preserved once, writes land inside the checkout only
//   (b) port allocation: reserved 8188/8189 skipped, bound ports skipped,
//       occupied preference falls through to the scan
//   (c) lifecycle: spawn → supervise → stop; yaml mirrored into the
//       checkout; state file written/cleared; idempotent start (no double
//       spawn); log tail; health; port freed after stop
//   (d) failure taxonomy: exit-before-ready (failed + reason + recovery),
//       unexpected crash after running (failed with the exit code)
//   (e) forced tree-kill: SIGTERM-immune stub + grandchild die with the tree
//   (f) boot reconcile: adopt (no double spawn), adopted stop (verified
//       signalling), stale record → fresh start, stray under external mode
//       (reported, not killed by reconcile), unknown squatter (never
//       adopted, never signalled, engine starts on the next port)
//   (g) routes against the real built server: status/start/stop contract,
//       idempotent start, external-mode start rejected
//   (h) python realism (optional): real interpreter, real main.py
// Run after `pnpm build:server` (the modules load from dist-server).
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const net = require('node:net')
const path = require('node:path')
const assert = require('node:assert/strict')

const { RuntimeManager, allocatePort, renderExtraModelPathsYaml, validateModelRoot, writeExtraModelPathsConfig, extraModelPathsTarget, RESERVED_ENGINE_PORTS } = require(path.join(__dirname, '..', 'dist-server', 'server', 'runtime.js'))
const { EngineProcess } = require(path.join(__dirname, '..', 'dist-server', 'server', 'engineProcess.js'))

const FIXTURES = path.join(__dirname, 'fixtures')
const IS_WIN = process.platform === 'win32'
const DEATH_BUDGET_MS = 8_000

EngineProcess.setUrlGuard(() => true) // readiness probes: loopback stubs are fine

let passed = 0
function ok(condition, label) {
  assert.ok(condition, label)
  passed += 1
  console.log(`  ok - ${label}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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
    if (await predicate()) return true
    await sleep(60)
  }
  if (await predicate()) return true
  throw new Error(`timed out after ${timeoutMs} ms waiting for: ${label}`)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

function holdPort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

/** A bare 200-on-everything HTTP squatter — NOT our engine, must never be
 *  adopted or signalled. */
function holdHttp(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => { response.writeHead(200); response.end('not your engine') })
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-runtime-home-'))
}

/** A stub "ComfyUI checkout": temp dir containing main.py (node-JS stub
 *  content — node runs it regardless of extension, so the PRODUCTION argv
 *  `pythonPath main.py --port N` is exercised exactly). */
function makeCheckout(fixture = 'runtime-stub.cjs') {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-runtime-checkout-'))
  fs.copyFileSync(path.join(FIXTURES, fixture), path.join(checkout, 'main.py'))
  return checkout
}

/** Hermetic scan start per section: the suite must never scan the production
 *  8191+ range where a previous run's (or the user's) leftover engine might
 *  sit answering /system_stats — a readiness probe that hits a foreign
 *  listener resolves ready and turns the test into a lie. */
async function suiteStartPort() {
  return freePort()
}

/** Minimal settings shaped for the RuntimeManager's needs (engine + paths +
 *  comfyUrl); the suite never persists through normalizeSettings. */
function makeSettings(checkout, extra = {}) {
  const { engine: engineExtra = {}, paths: pathsExtra = {}, ...rest } = extra
  const modelRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-runtime-models-'))
  const kindDirs = {
    diffusion_models: path.join(modelRoot, 'diffusion_models'),
    text_encoders: path.join(modelRoot, 'text_encoders'),
    vae: path.join(modelRoot, 'vae'),
    loras: path.join(modelRoot, 'loras'),
    vae_approx: path.join(modelRoot, 'vae_approx'),
    clip_vision: path.join(modelRoot, 'clip_vision'),
  }
  for (const dir of Object.values(kindDirs)) fs.mkdirSync(dir, { recursive: true })
  return {
    comfyUrl: 'http://127.0.0.1:8188',
    engine: {
      mode: 'managed',
      checkoutPath: checkout,
      pythonPath: process.execPath,
      portPreference: 0,
      autoStart: false,
      ...engineExtra,
    },
    paths: { ...kindDirs, ...pathsExtra },
    ...rest,
  }
}

/** Managers under test — a failed assertion mid-section must not leave a
 *  live stub engine pinning the event loop (the natural process exit would
 *  never fire with a child's pipes open). */
const liveRuntimes = new Set()

function makeManager(home, settings, overrides = {}) {
  const runtime = new RuntimeManager({
    homeDirectory: home,
    loadSettings: async () => settings,
    logEvent: () => {},
    logFailure: () => {},
    isLocalServiceUrl: () => true,
    readyTimeoutMs: 15_000,
    ...overrides,
  })
  liveRuntimes.add(runtime)
  return runtime
}

async function waitForState(runtime, state, label) {
  return waitUntil(async () => (await runtime.status()).state === state, 20_000, `${label} → ${state}`)
}

// ---------------------------------------------------------------------------
async function main() {
  // ---- (a) extra_model_paths.yaml generation --------------------------------
  console.log('runtime: extra_model_paths.yaml generation')
  {
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-runtime-root-'))
    ok(validateModelRoot(realDir) === path.resolve(realDir), 'an existing absolute root validates and resolves')
    ok(validateModelRoot('relative/path') === null, 'relative root rejected')
    ok(validateModelRoot('/definitely/not/here') === null, 'nonexistent root rejected')
    ok(validateModelRoot('') === null && validateModelRoot(null) === null, 'empty/null rejected')

    const yaml = renderExtraModelPathsYaml([{ key: 'vae', path: IS_WIN ? 'C:\\models\\vae' : '/models/vae' }])
    ok(yaml.includes('vae:') && yaml.includes(IS_WIN ? '"C:\\\\models\\\\vae"' : '"/models/vae"'), 'yaml emits the folder key and a quoted, escaped absolute path')
    ok(yaml.includes('never copied') || yaml.includes('NEVER copied'), 'yaml header states the no-copy contract')

    const checkout = makeCheckout()
    const settings = makeSettings(checkout, { paths: { diffusion_models: realDir, text_encoders: 'relative/x', vae: '/definitely/not/here', loras: realDir, vae_approx: realDir, clip_vision: realDir } })
    const foreign = 'checkpoints:\n    - "/user/original"\n'
    fs.writeFileSync(extraModelPathsTarget(checkout), foreign)
    const first = await writeExtraModelPathsConfig(checkout, settings)
    ok(first.written === true && first.roots.length === 1 && first.roots[0] === path.resolve(realDir), 'only the valid root is written (invalid kinds reported as skipped)')
    ok(first.skipped.includes('text_encoders') && first.skipped.includes('vae'), 'invalid kinds are named in the skip list')
    ok(fs.readFileSync(path.join(checkout, 'extra_model_paths.yaml.pre-studio'), 'utf8') === foreign, 'a foreign yaml is preserved once as .pre-studio')
    const generated = fs.readFileSync(extraModelPathsTarget(checkout), 'utf8')
    ok(generated.startsWith('# Generated by MiniMax Studio'), 'the generated file carries the studio marker')
    ok(generated.includes(`- ${JSON.stringify(path.resolve(realDir))}`), 'the validated absolute root is emitted verbatim')
    ok(!generated.includes('relative') && !generated.includes('/definitely/not/here'), 'invalid roots never reach the yaml')

    // A SECOND foreign file must not clobber the original backup.
    fs.writeFileSync(extraModelPathsTarget(checkout), 'checkpoints:\n    - "/user/second"\n')
    await writeExtraModelPathsConfig(checkout, settings)
    ok(fs.readFileSync(path.join(checkout, 'extra_model_paths.yaml.pre-studio'), 'utf8') === foreign, 'the original backup is never overwritten by later foreign files')

    const bare = makeSettings(checkout, { paths: { diffusion_models: 'nope', text_encoders: 'nope', vae: 'nope', loras: 'nope', vae_approx: 'nope', clip_vision: 'nope' } })
    const none = await writeExtraModelPathsConfig(checkout, bare)
    ok(none.written === false, 'no valid roots → nothing written (an existing file is left alone)')
    ok(fs.existsSync(extraModelPathsTarget(checkout)), 'the existing generated file survives a no-root run')
  }

  // ---- (b) port allocation ----------------------------------------------------
  console.log('runtime: port allocation')
  {
    const fromReserved = await allocatePort({ startPort: 8188 })
    ok(fromReserved !== null && !RESERVED_ENGINE_PORTS.includes(fromReserved) && fromReserved > 8189, `reserved user ports 8188/8189 are never allocated (got ${fromReserved})`)
    const preferredReserved = await allocatePort({ preference: 8188, startPort: 8191 })
    ok(preferredReserved !== null && !RESERVED_ENGINE_PORTS.includes(preferredReserved), 'a reserved preference is refused, the scan answers instead')

    const base = await freePort()
    const heldA = await holdPort(base)
    const heldB = await holdPort(base + 2)
    const picked = await allocatePort({ startPort: base })
    ok(picked === base + 1, `bound ports are skipped (scan from ${base} → ${picked})`)
    const viaPreference = await allocatePort({ preference: base, startPort: base })
    ok(viaPreference !== null && viaPreference !== base, 'an occupied preference falls through to the scan')
    heldA.close()
    heldB.close()
    await sleep(150) // let the held sockets release before later sections
  }

  // ---- (c) lifecycle -----------------------------------------------------------
  console.log('runtime: spawn / supervise / stop lifecycle')
  {
    const home = makeHome()
    const checkout = makeCheckout()
    const settings = makeSettings(checkout)
    const runtime = makeManager(home, settings, { startPort: await suiteStartPort() })
    const before = EngineProcess.liveCount

    const started = await runtime.start()
    ok(started.status.state === 'running' && started.already === false, 'start resolves with state running')
    ok(Number.isInteger(started.status.pid), 'pid reported')
    const status = await runtime.status()
    ok(status.url === `http://127.0.0.1:${status.port}`, 'url matches the allocated port')
    ok(!RESERVED_ENGINE_PORTS.includes(status.port), `allocated port clear of the reserved user instances (got ${status.port})`)
    ok(status.health === 'ok', 'lazy /system_stats health sample answers ok')
    ok(status.logTail.some((line) => line.includes('boot')), 'NDJSON boot event captured in the log tail')
    ok(status.logTail.some((line) => line.includes('raw startup line')), 'raw stdout lines captured in the log tail')
    ok(fs.existsSync(extraModelPathsTarget(checkout)), 'extra_model_paths.yaml mirrored into the checkout')
    ok(fs.readFileSync(extraModelPathsTarget(checkout), 'utf8').includes(JSON.stringify(path.resolve(settings.paths.diffusion_models))), 'the yaml points at the real model root')

    const record = JSON.parse(fs.readFileSync(path.join(home, 'engine', 'runtime-state.json'), 'utf8'))
    ok(record.port === status.port && record.pid === status.pid && record.checkout === path.resolve(checkout), 'runtime-state.json records port/pid/checkout for boot reconcile')

    const again = await runtime.start()
    ok(again.already === true && again.status.pid === started.status.pid, 'a second start is idempotent — same pid, already: true')
    ok(EngineProcess.liveCount === before + 1, 'no second process was spawned')

    const stopped = await runtime.stop()
    ok(stopped.state === 'stopped', 'stop resolves stopped')
    ok(!isAlive(started.status.pid), 'the engine process is dead after stop')
    ok(!fs.existsSync(path.join(home, 'engine', 'runtime-state.json')), 'state file cleared on stop')
    const rebinding = await holdPort(status.port)
    ok(true, 'the port is free again after stop')
    rebinding.close()
    ok((await runtime.stop()).state === 'stopped', 'stop is idempotent when already stopped')
  }

  // ---- (d) failure taxonomy ------------------------------------------------------
  console.log('runtime: failure taxonomy')
  {
    const home = makeHome()
    const checkout = makeCheckout('runtime-stub-crash.cjs')
    const runtime = makeManager(home, makeSettings(checkout), { startPort: await suiteStartPort() })
    const started = await runtime.start()
    ok(started.status.state === 'running', 'crash stub comes up running first')
    await waitForState(runtime, 'failed', 'unexpected exit')
    const failed = await runtime.status()
    ok(failed.lastError && failed.lastError.includes('exited with code 3'), `unexpected death lands failed with the exit code (got "${failed.lastError}")`)
    ok(!isAlive(started.status.pid), 'crashed process reaped')

    const failCheckout = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-runtime-checkout-'))
    fs.writeFileSync(path.join(failCheckout, 'main.py'), "process.stderr.write('stub: failing before ready\\n'); process.exit(7)\n")
    const failRuntime = makeManager(makeHome(), makeSettings(failCheckout), { startPort: await suiteStartPort() })
    await assert.rejects(failRuntime.start(), /did not become ready/, 'exit-before-ready rejects the start')
    const failedStart = await failRuntime.status()
    ok(failedStart.state === 'failed' && /before becoming ready|code 7/.test(failedStart.lastError ?? ''), `exit-before-ready recorded with reason (got "${failedStart.lastError}")`)
    ok(EngineProcess.liveCount === 0, 'failed launches leave nothing live')
  }

  // ---- (e) forced tree-kill --------------------------------------------------------
  console.log('runtime: forced tree-kill (SIGTERM-immune engine + grandchild)')
  {
    const checkout = makeCheckout('runtime-stub-immune.cjs')
    const runtime = makeManager(makeHome(), makeSettings(checkout), { startPort: await suiteStartPort() })
    const started = await runtime.start()
    ok(started.status.state === 'running', 'immune stub runs')
    const stopped = await runtime.stop()
    ok(stopped.state === 'stopped', 'stop terminates even when SIGTERM is ignored (grace → escalation)')
    ok(!isAlive(started.status.pid), 'immune engine dead after stop')
    // The grandchild pid rides the log tail (structured event extras): prove
    // it died with the tree, not by its own 10 s timer.
    const grandLine = stopped.logTail.find((line) => line.includes('grandchild'))
    const match = grandLine ? /"pid":(\d+)/.exec(grandLine) : null
    ok(Boolean(match), `grandchild pid announced in the log tail (line: ${grandLine ?? 'none'})`)
    if (match) {
      ok(await waitUntil(() => !isAlive(Number(match[1])), DEATH_BUDGET_MS, 'grandchild death'), 'grandchild died with the tree (not by its own 10 s timer)')
    }
  }

  // ---- (f) boot reconcile -----------------------------------------------------------
  console.log('runtime: boot posture reconcile')
  {
    // (f1) adopt: a second manager on the same home adopts the running engine.
    const home = makeHome()
    const checkout = makeCheckout()
    const adoptStart = await suiteStartPort()
    const first = makeManager(home, makeSettings(checkout, { engine: { autoStart: false } }), { startPort: adoptStart })
    const running = await first.start()
    const liveBefore = EngineProcess.liveCount
    const secondSettings = makeSettings(checkout, { engine: { autoStart: true } })
    const second = makeManager(home, secondSettings, { startPort: adoptStart })
    await second.reconcileOnBoot()
    const adopted = await second.status()
    ok(adopted.state === 'running' && adopted.adopted === true && adopted.pid === running.status.pid && adopted.port === running.status.port, 'a healthy recorded instance is ADOPTED (same pid/port, no double spawn)')
    ok(adopted.stray !== true, 'adopting under managed mode is not a stray')
    ok(EngineProcess.liveCount === liveBefore, 'reconcile spawned nothing')
    const stopped = await second.stop()
    ok(stopped.state === 'stopped' && !isAlive(running.status.pid), 'adopted stop verifies the recorded signature and reaps it')

    // (f2) stale record: nothing on the port, dead pid → fresh start.
    const staleHome = makeHome()
    const staleCheckout = makeCheckout()
    const deadPid = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
      child.on('exit', () => resolve(child.pid))
    })
    fs.mkdirSync(path.join(staleHome, 'engine'), { recursive: true })
    fs.writeFileSync(path.join(staleHome, 'engine', 'runtime-state.json'), JSON.stringify({ version: 1, port: 49_999, pid: deadPid, command: process.execPath, args: ['main.py', '--port', '49999'], startedAt: Date.now(), checkout: staleCheckout }))
    const staleRuntime = makeManager(staleHome, makeSettings(staleCheckout, { engine: { autoStart: true } }), { startPort: await freePort() })
    await staleRuntime.reconcileOnBoot()
    const fresh = await staleRuntime.status()
    ok(fresh.state === 'running' && fresh.adopted !== true && fresh.pid !== deadPid && fresh.port !== 49_999, 'a stale record is discarded; autoStart launches a fresh engine')
    await staleRuntime.stop()

    // (f3) stray: healthy recorded instance but managed mode is OFF — reported,
    // never killed by reconcile; an explicit stop still reaps it.
    const strayHome = makeHome()
    const strayCheckout = makeCheckout()
    const owner = makeManager(strayHome, makeSettings(strayCheckout), { startPort: await suiteStartPort() })
    const strayEngine = await owner.start()
    const externalViewer = makeManager(strayHome, makeSettings(strayCheckout, { engine: { mode: 'external' } }), { startPort: await suiteStartPort() })
    await externalViewer.reconcileOnBoot()
    const strayStatus = await externalViewer.status()
    ok(strayStatus.mode === 'external' && strayStatus.state === 'running' && strayStatus.stray === true && strayStatus.pid === strayEngine.status.pid, 'external-mode reconcile reports the stray honestly (running, stray, not killed)')
    ok(isAlive(strayEngine.status.pid), 'reconcile under external mode does NOT kill the engine')
    const strayStop = await externalViewer.stop()
    ok(strayStop.state === 'stopped' && !isAlive(strayEngine.status.pid), 'an explicit stop reaps the stray (verified signalling)')

    // (f4) unknown squatter: healthy HTTP responder on the recorded port with a
    // dead recorded pid → never adopted, never signalled, engine starts on the
    // NEXT port and the posture says so.
    const squatHome = makeHome()
    const squatCheckout = makeCheckout()
    const squatPort = await freePort()
    const squatter = await holdHttp(squatPort)
    const squatDeadPid = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
      child.on('exit', () => resolve(child.pid))
    })
    fs.mkdirSync(path.join(squatHome, 'engine'), { recursive: true })
    fs.writeFileSync(path.join(squatHome, 'engine', 'runtime-state.json'), JSON.stringify({ version: 1, port: squatPort, pid: squatDeadPid, command: process.execPath, args: ['main.py', '--port', String(squatPort)], startedAt: Date.now(), checkout: squatCheckout }))
    const squatRuntime = makeManager(squatHome, makeSettings(squatCheckout, { engine: { autoStart: true } }), { startPort: squatPort })
    await squatRuntime.reconcileOnBoot()
    const squatStatus = await squatRuntime.status()
    ok(squatStatus.state === 'running' && squatStatus.port !== squatPort && squatStatus.adopted !== true, `an unknown squatter is skipped, the engine runs on the next port (got ${squatStatus.port})`)
    ok((squatStatus.warning ?? '').includes(String(squatPort)), 'the squatter is reported in the status warning')
    const squatterStillUp = await new Promise((resolve) => {
      const request = http.get(`http://127.0.0.1:${squatPort}/`, (response) => { response.resume(); resolve(response.statusCode === 200) })
      request.on('error', () => resolve(false))
    })
    ok(squatterStillUp, 'the squatter process was NEVER killed')
    await squatRuntime.stop()
    squatter.close()
  }

  // ---- (g) routes against the real server ----------------------------------------
  console.log('runtime: /api/lan/engine/* routes')
  {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    const home = makeHome()
    const checkout = makeCheckout()
    const port = 4210 + Math.floor(Math.random() * 80)
    const child = spawn(process.execPath, ['dist-server/server/index.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, MINIMAX_STUDIO_HOME: home, MINIMAX_LAN_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let serverOutput = ''
    child.stdout.on('data', (chunk) => { serverOutput += String(chunk) })
    child.stderr.on('data', (chunk) => { serverOutput += String(chunk) })
    const base = `https://127.0.0.1:${port}`
    const api = async (route, init) => {
      const response = await fetch(`${base}${route}`, init)
      return { status: response.status, body: await response.json().catch(() => ({})) }
    }
    await waitUntil(async () => {
      try { return (await fetch(`${base}/api/lan/settings`)).ok } catch { return false }
    }, 15_000, 'server boot')

    const initial = await api('/api/lan/engine/status')
    ok(initial.status === 200 && initial.body.mode === 'external' && initial.body.state === 'stopped' && Array.isArray(initial.body.logTail), 'default posture: external mode, stopped, empty tail')

    const rejected = await api('/api/lan/engine/start', { method: 'POST' })
    ok(rejected.status === 400 && typeof rejected.body.error === 'string', 'start is refused in external mode with a clear error')

    const current = (await api('/api/lan/settings')).body.settings
    const configured = await api('/api/lan/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { ...current, engine: { mode: 'managed', checkoutPath: checkout, pythonPath: process.execPath, portPreference: 0, autoStart: false } } }),
    })
    ok(configured.status === 200 && configured.body.settings.engine.mode === 'managed', 'managed engine settings persist through normalizeSettings')

    const started = await api('/api/lan/engine/start', { method: 'POST' })
    ok(started.status === 200 && started.body.state === 'running' && started.body.already === false && started.body.mode === 'managed', 'POST start → running with mode managed')
    ok(started.body.url === `http://127.0.0.1:${started.body.port}` && Number.isInteger(started.body.pid), 'status carries url + pid')

    const again = await api('/api/lan/engine/start', { method: 'POST' })
    ok(again.status === 200 && again.body.already === true && again.body.pid === started.body.pid, 'a repeated start reports already: true with the same pid (no double spawn)')

    const status = await api('/api/lan/engine/status')
    ok(status.status === 200 && status.body.state === 'running' && status.body.health === 'ok' && !RESERVED_ENGINE_PORTS.includes(status.body.port), 'GET status: running, healthy, port clear of user instances')

    const stopped = await api('/api/lan/engine/stop', { method: 'POST' })
    ok(stopped.status === 200 && stopped.body.state === 'stopped', 'POST stop → stopped')
    ok(!isAlive(started.body.pid), 'the engine process is gone')

    const badCheckout = await api('/api/lan/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { ...current, engine: { mode: 'managed', checkoutPath: '/definitely/not/a/checkout', pythonPath: process.execPath, portPreference: 0, autoStart: false } } }),
    })
    ok(badCheckout.status === 200, 'settings accept a (not-yet-validated) checkout path')
    const badStart = await api('/api/lan/engine/start', { method: 'POST' })
    ok(badStart.status === 400 && /checkout/i.test(badStart.body.error), 'an invalid checkout fails the start with a 400 and a clear reason')
    ok(badStart.body.state === 'stopped', 'a config-validation refusal never attempted a launch — posture stays stopped')

    child.kill()
    await waitUntil(() => !isAlive(child.pid), 5_000, 'test server exit')
    if (serverOutput.includes('FAIL')) console.log('  NOTE - server output contained FAIL; inspect manually')
  }

  // ---- (h) python realism (optional) ----------------------------------------------
  console.log('runtime: python realism')
  {
    const candidates = IS_WIN ? ['python', 'python3'] : ['python3', 'python']
    const python = await new Promise((resolve) => {
      const attempt = (index) => {
        if (index >= candidates.length) return resolve(null)
        const probe = spawn(candidates[index], ['-c', 'import sys; sys.exit(0)'], { stdio: 'ignore', windowsHide: true })
        probe.on('error', () => attempt(index + 1))
        probe.on('exit', (code) => (code === 0 ? resolve(candidates[index]) : attempt(index + 1)))
      }
      attempt(0)
    })
    if (!python) {
      console.log('  NOTE - no usable python3/python on PATH; skipping the python fixture (CI runners have it)')
    } else {
      const checkout = makeCheckout()
      fs.copyFileSync(path.join(FIXTURES, 'runtime-stub.py'), path.join(checkout, 'main.py'))
      const runtime = makeManager(makeHome(), makeSettings(checkout, { engine: { pythonPath: python } }), { startPort: await suiteStartPort() })
      const started = await runtime.start()
      ok(started.status.state === 'running', 'a real python main.py --port N launches and becomes ready')
      ok(started.status.health === 'ok', 'health probe answers from the python engine')
      ok(started.status.logTail.some((line) => line.includes('runtime-stub.py')), 'python stdout observed unbuffered')
      const stopped = await runtime.stop()
      ok(stopped.state === 'stopped' && !isAlive(started.status.pid), 'python engine stopped by the same escalation path')
    }
  }

  const leftover = await EngineProcess.shutdownAll()
  ok(leftover.every((summary) => summary.code === 0 || summary.killedByUs), 'no stub outlives the suite')
  console.log(`runtime: all ${passed} checks passed`)
}

main().then(
  () => { process.exitCode = 0 },
  async (error) => {
    console.error(`FAIL: ${error && error.stack ? error.stack : error}`)
    // Reap everything before exiting: a live stub engine's pipes would pin
    // the event loop and turn a clean failure into a hang.
    await Promise.allSettled([...liveRuntimes].map((runtime) => runtime.stop()))
    await EngineProcess.shutdownAll()
    process.exit(1)
  },
)
