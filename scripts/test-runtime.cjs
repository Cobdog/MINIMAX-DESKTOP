// RuntimeManager suite (self-managed ComfyUI runtime). Real child
// processes, no mocks of the process layer — a checkout-shaped STUB
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
//       idempotent start, external-mode start rejected, launch-profile +
//       patch-consent persistence, node-pack list/install/uninstall
//   (h) python realism (optional): real interpreter, real main.py
//   (i) launch profiles (increment 2): validation/sanitization, spawn env
//       injection, profile recorded in state file + status, port policy
//   (j) vendored node packs (increment 2): registry licensing discipline,
//       install (weights LINKED, never copied) / uninstall / version-bump
//       reinstall / foreign-folder refusal / availability, against local
//       fixture packs AND the repo's real vendored payload
//   (k) consent patch manager (increment 2): layout detect (current/old/
//       unknown/patched), apply with pristine backup + atomic write, check,
//       idempotence, refuse-unknown (file unchanged), revert, version gate,
//       structural + (when python exists) ast.parse validation
//   (l) weight symlink policy (increment 2): linkNeverCopy chain +
//       linkWeightIntoModelRoot (reuse, refuse-overwrite, no-copy)
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
const { DEFAULT_ENGINE_PROFILES, mergeEngineProfiles, resolveActiveProfile } = require(path.join(__dirname, '..', 'dist-server', 'server', 'engineProfiles.js'))
const { ENGINE_PATCHES, LONGCACHE_PATCH, applyEnginePatch, checkEnginePatch, detectPatchLayout, revertEnginePatch, structuralBalance, transformPatchedText } = require(path.join(__dirname, '..', 'dist-server', 'server', 'enginePatch.js'))
const { ENGINE_NODE_PACKS, checkNodePack, findNodePack, installNodePack, uninstallNodePack, isUsableCheckout, linkNeverCopy, linkWeightIntoModelRoot, nodePackInstallDir, resolveVendorRoot } = require(path.join(__dirname, '..', 'dist-server', 'server', 'engineNodes.js'))

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
      profile: 'default',
      profiles: JSON.parse(JSON.stringify(DEFAULT_ENGINE_PROFILES)),
      patches: {},
      ...engineExtra,
    },
    paths: { ...kindDirs, ...pathsExtra },
    ...rest,
  }
}

// ---- Increment-2 fixtures ---------------------------------------------------

/** The current 0.33.x/0.34 MiniMax-H3 block-loop layout, shaped exactly as
 *  the ported strict regexes expect (8-space method body inside _forward). */
const FIXTURE_MODEL_CURRENT = `import comfy.model_prefetch


class MiniMaxH3Model:
    def _forward(self, x, timestep, context, transformer_options={}, minimax_payload=None, denoise_mask=None, audio_denoise_mask=None, **kwargs):
        # blocks
        patches_replace = transformer_options.get("patches_replace", {})
        blocks_replace = patches_replace.get("dit", {})
        prefetch_queue = comfy.model_prefetch.make_prefetch_queue(list(self.blocks), device, transformer_options)
        for i, block in enumerate(self.blocks):
            h = block(h, t_emb, mod_segments, rope_freqs, transformer_options=transformer_options)
        if prefetch_queue is not None:
            comfy.model_prefetch.prefetch_queue_pop(prefetch_queue, device, None)
        return h
`

/** The older malloc_scope="block" loop layout (backwards-compat regex). */
const FIXTURE_MODEL_OLD = `import comfy.model_prefetch


class MiniMaxH3Model:
    def _forward(self, x, timestep, context, transformer_options={}, minimax_payload=None, denoise_mask=None, audio_denoise_mask=None, **kwargs):
        # blocks
        patches_replace = transformer_options.get("patches_replace", {})
        blocks_replace = patches_replace.get("dit", {})
        prefetch_queue = comfy.model_prefetch.make_prefetch_queue(list(self.blocks), device, transformer_options)
        for i, block in enumerate(self.blocks):
            h = block(h, t_emb, mod_segments, rope_freqs, transformer_options=transformer_options)
        if prefetch_queue is not None:
            comfy.model_prefetch.prefetch_queue_pop(prefetch_queue, device, None, malloc_scope="block")
        return h
`

/** A future/refactored loop the strict regexes must REFUSE to touch. */
const FIXTURE_MODEL_UNKNOWN = `import comfy.model_prefetch


class MiniMaxH3Model:
    def _forward(self, x, timestep, context, transformer_options={}, minimax_payload=None, denoise_mask=None, audio_denoise_mask=None, **kwargs):
        # blocks (refactored upstream)
        patches_replace = transformer_options.get("patches_replace", {})
        blocks_replace = patches_replace.get("dit", {})
        h = self._run_all_blocks(h, t_emb, mod_segments, rope_freqs, transformer_options)
        return h
`

/** A checkout-shaped directory carrying the patch target + version file:
 *  main.py (the runnable node stub — a launch must actually boot), the
 *  comfy/ldm/minimax/model.py layout under test, and a stated version. */
function makePatchCheckout(layoutText, comfyVersion) {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-runtime-patch-'))
  fs.copyFileSync(path.join(FIXTURES, 'runtime-stub.cjs'), path.join(checkout, 'main.py'))
  const targetDir = path.join(checkout, 'comfy', 'ldm', 'minimax')
  fs.mkdirSync(targetDir, { recursive: true })
  fs.writeFileSync(path.join(targetDir, 'model.py'), layoutText)
  if (comfyVersion !== undefined) {
    fs.writeFileSync(path.join(checkout, 'comfyui_version.py'), `# generated\n__version__ = "${comfyVersion}"\n`)
  }
  return checkout
}

function patchTargetOf(checkout) {
  return path.join(checkout, 'comfy', 'ldm', 'minimax', 'model.py')
}

/** A tiny local fixture "pack" with code, a weight, and junk to skip. */
function makeFixtureVendorRoot() {
  const vendorRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-runtime-vendor-'))
  const pack = path.join(vendorRoot, 'fixture-pack')
  fs.mkdirSync(path.join(pack, 'weights'), { recursive: true })
  fs.mkdirSync(path.join(pack, '__pycache__'), { recursive: true })
  fs.writeFileSync(path.join(pack, '__init__.py'), '# fixture node pack\n')
  fs.writeFileSync(path.join(pack, 'README.md'), '# fixture pack\n')
  fs.writeFileSync(path.join(pack, 'weights', 'tiny.safetensors'), 'FAKE-WEIGHT-BYTES')
  fs.writeFileSync(path.join(pack, '__pycache__', 'junk.pyc'), 'skip me')
  return { vendorRoot, pack }
}

/** The registry entry shape for a fixture pack (license-clean vendored). */
function fixturePackEntry(vendorDir = 'fixture-pack') {
  return {
    id: 'fixture-pack',
    name: 'fixture-pack',
    description: 'suite fixture',
    repoUrl: 'https://example.invalid/fixture-pack',
    pinnedRevision: 'rev1',
    licenseSpdx: 'MIT',
    installMode: 'vendor',
    vendorDir,
  }
}

/** The python interpreter probe used by the suite (null when absent). */
async function findPython() {
  const candidates = IS_WIN ? ['python', 'python3'] : ['python3', 'python']
  return new Promise((resolve) => {
    const attempt = (index) => {
      if (index >= candidates.length) return resolve(null)
      const probe = spawn(candidates[index], ['-c', 'import sys; sys.exit(0)'], { stdio: 'ignore', windowsHide: true })
      probe.on('error', () => attempt(index + 1))
      probe.on('exit', (code) => (code === 0 ? resolve(candidates[index]) : attempt(index + 1)))
    }
    attempt(0)
  })
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
  // The standalone entry REFUSES to boot without the web build (dist/index.html).
  // Legs that build only the server (Engine CI Windows) skip this section with
  // a note — the routes are platform-neutral; the OS-specific supervision
  // paths (taskkill tree-kill, tasklist verification) ran in sections (c)–(f).
  if (!fs.existsSync(path.join(__dirname, '..', 'dist', 'index.html'))) {
    console.log('  NOTE - no web build present (dist/index.html); the standalone server will not boot — route coverage runs on legs that build the web app (ubuntu CI, pnpm test:all)')
  } else {
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
      body: JSON.stringify({ settings: { ...current, engine: { mode: 'managed', checkoutPath: '/definitely/not/a/checkout', pythonPath: process.execPath, portPreference: 0, autoStart: false, profile: 'default', profiles: current.engine.profiles, patches: {} } } }),
    })
    ok(badCheckout.status === 200, 'settings accept a (not-yet-validated) checkout path')
    const badStart = await api('/api/lan/engine/start', { method: 'POST' })
    ok(badStart.status === 400 && /checkout/i.test(badStart.body.error), 'an invalid checkout fails the start with a 400 and a clear reason')
    ok(badStart.body.state === 'stopped', 'a config-validation refusal never attempted a launch — posture stays stopped')

    // ---- increment 2: profile + consent persistence, node-pack routes ----
    // Restore the good checkout first, then persist a vdn profile whose
    // default-profile env smuggles a forbidden var (must be dropped) and a
    // consent record for the LongCache patch (must survive normalization).
    const profileSaved = await api('/api/lan/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        settings: {
          ...current,
          engine: {
            mode: 'managed', checkoutPath: checkout, pythonPath: process.execPath, portPreference: 0, autoStart: false,
            profile: 'vdn',
            profiles: {
              default: { label: 'Default', description: 'stock', env: { PATH: '/should-be-dropped', STOCK_VAR: 'yes' }, hooks: [] },
              vdn: { label: 'VDN', description: 'vdn stack', env: { VDN_H3_PROBE: '1' }, hooks: [{ kind: 'patch', patchId: 'longcache-block-loop' }] },
            },
            patches: { 'longcache-block-loop': { consented: true } },
          },
        },
      }),
    })
    ok(profileSaved.status === 200 && profileSaved.body.settings.engine.profile === 'vdn', 'the launch profile persists through normalizeSettings')
    const savedProfiles = profileSaved.body.settings.engine.profiles
    ok(savedProfiles.default.env.STOCK_VAR === 'yes' && !('PATH' in savedProfiles.default.env), 'a forbidden env var (PATH) is dropped at normalization; legal ones survive')
    ok(savedProfiles.vdn.hooks.length === 1 && savedProfiles.vdn.hooks[0].patchId === 'longcache-block-loop', 'the vdn profile keeps its patch hook')
    ok(profileSaved.body.settings.engine.patches['longcache-block-loop']?.consented === true, 'patch consent persists through normalizeSettings')

    const nodes = await api('/api/lan/engine/nodes')
    ok(nodes.status === 200 && Array.isArray(nodes.body.packs) && nodes.body.packs.length >= 3, 'the node-pack registry lists its entries')
    const vdnPack = nodes.body.packs.find((pack) => pack.id === 'vdn-h3')
    ok(vdnPack && vdnPack.vendored === true && vdnPack.availability === 'ready', 'the vendored VDN pack reports ready against the real vendor payload')
    const facokPack = nodes.body.packs.find((pack) => pack.id === 'krea2-controlnet')
    ok(facokPack && facokPack.licenseSpdx === 'NO-LICENSE' && facokPack.installMode === 'user-fetch', 'the unlicensed pack is listed as NO-LICENSE user-fetch (never vendored)')

    const installPack = await api('/api/lan/engine/nodes/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'vdn-h3' }) })
    ok(installPack.status === 200 && installPack.body.pack.installed === true, 'the install route places the vendored pack into the configured checkout')
    ok(fs.existsSync(path.join(checkout, 'custom_nodes', 'ComfyUI-VDN-H3', '__init__.py')), 'the installed pack is on disk in custom_nodes/')
    const noSource = await api('/api/lan/engine/nodes/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'krea2-controlnet' }) })
    ok(noSource.status === 400, 'a user-fetch install without a source directory is a 400 with the reason')
    const uninstallPack = await api('/api/lan/engine/nodes/uninstall', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'vdn-h3' }) })
    ok(uninstallPack.status === 200 && uninstallPack.body.pack.installed === false, 'the uninstall route removes the pack (delete folder)')
    ok(!fs.existsSync(path.join(checkout, 'custom_nodes', 'ComfyUI-VDN-H3')), 'the pack folder is gone after uninstall')
    const unknownPack = await api('/api/lan/engine/nodes/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'nope' }) })
    ok(unknownPack.status === 400, 'an unknown pack id is a 400')

    child.kill()
    await waitUntil(() => !isAlive(child.pid), 5_000, 'test server exit')
    if (serverOutput.includes('FAIL')) console.log('  NOTE - server output contained FAIL; inspect manually')
  }

  // ---- (h) python realism (optional) ----------------------------------------------
  console.log('runtime: python realism')
  {
    const python = await findPython()
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

  // ---- (i) launch profiles (increment 2) ------------------------------------------
  console.log('runtime: launch profiles')
  {
    // Normalization discipline: forbidden/malformed env keys and unknown
    // hook ids are dropped WITH a report; malformed profile ids never land.
    const merged = mergeEngineProfiles({
      default: { label: 'Default', description: 'stock', env: { PATH: '/evil', VDN_H3_X: '1', 'bad name': 'x' }, hooks: [], portPolicy: {} },
      custom: { label: 'Custom', description: 'user', env: { MY_VAR: 'yes' }, hooks: [{ kind: 'patch', patchId: 'longcache-block-loop' }, { kind: 'patch', patchId: 'nope' }], portPolicy: {} },
      'Bad Id!': { label: 'x', description: '', env: {}, hooks: [], portPolicy: {} },
    }, new Set(['longcache-block-loop']))
    ok(merged.profiles.default.env.VDN_H3_X === '1' && !('PATH' in merged.profiles.default.env) && !('bad name' in merged.profiles.default.env), 'forbidden and malformed env keys are dropped; legal ones survive')
    ok(merged.profiles.custom.hooks.length === 1 && merged.profiles.custom.hooks[0].patchId === 'longcache-block-loop', 'unknown hook patch ids are dropped, known ones kept')
    ok(!('Bad Id!' in merged.profiles) && merged.dropped.some((entry) => entry.includes('Bad Id!')), 'malformed profile ids are dropped and reported')

    // Unknown active id → default fallback WITH a warning (never a silent
    // stock launch).
    const typoResolved = resolveActiveProfile(makeSettings(makeCheckout(), { engine: { profile: 'typo-profile' } }))
    ok(typoResolved.id === 'default' && /does not exist/.test(typoResolved.warning ?? ''), 'an unknown profile id falls back to default with a warning')

    // Port policy: profile-reserved ports join the allocator skip-list.
    const policyBase = await freePort()
    ok(await allocatePort({ startPort: policyBase, extraReserved: [policyBase] }) === policyBase + 1, 'a profile-reserved port is skipped by allocation')

    // Spawn env injection + boot-posture record + consent-degrade warning.
    const home = makeHome()
    const checkout = makeCheckout()
    const profiles = JSON.parse(JSON.stringify(DEFAULT_ENGINE_PROFILES))
    profiles.vdn = { ...profiles.vdn, env: { MINIMAX_STUDIO_PROFILE_PROBE: 'injected-123' } }
    const runtime = makeManager(home, makeSettings(checkout, { engine: { profile: 'vdn', profiles } }), { startPort: await suiteStartPort() })
    const started = await runtime.start()
    ok(started.status.profile === 'vdn', 'status reports the active launch profile')
    ok(started.status.logTail.some((line) => line.includes('injected-123')), 'profile env vars reach the spawned engine process')
    const record = JSON.parse(fs.readFileSync(path.join(home, 'engine', 'runtime-state.json'), 'utf8'))
    ok(record.profile === 'vdn', 'the boot-posture state file records the active profile')
    ok((started.status.warning ?? '').includes('consent not given'), 'the vdn profile asks for the LongCache patch; without consent the launch degrades with a warning')
    ok(Array.isArray(started.status.patches) && started.status.patches.some((patch) => patch.id === 'longcache-block-loop'), 'the patch posture rides the status payload')
    const stopped = await runtime.stop()
    ok(stopped.state === 'stopped', 'a profile launch stops cleanly')
  }

  // ---- (j) vendored node packs (increment 2) --------------------------------------
  console.log('runtime: vendored node packs')
  {
    // Licensing discipline on the REAL registry data.
    ok(ENGINE_NODE_PACKS.every((pack) => typeof pack.licenseSpdx === 'string' && pack.licenseSpdx.length > 0), 'every registry entry carries an SPDX record')
    const facok = ENGINE_NODE_PACKS.find((pack) => pack.repoUrl.includes('facok'))
    ok(facok && facok.licenseSpdx === 'NO-LICENSE' && facok.installMode === 'user-fetch', 'the unlicensed facok pack is NO-LICENSE + user-fetch (never vendored)')
    const vdnEntry = ENGINE_NODE_PACKS.find((pack) => pack.id === 'vdn-h3')
    ok(vdnEntry && vdnEntry.installMode === 'vendor' && vdnEntry.licenseSpdx === 'Apache-2.0', 'the VDN port is the vendored entry at Apache-2.0')
    const vendorRoot = resolveVendorRoot()
    ok(vendorRoot !== null && fs.existsSync(path.join(vendorRoot, 'ComfyUI-VDN-H3', '__init__.py')), 'the repo ships the vendored VDN payload (vendor/nodes/ComfyUI-VDN-H3)')
    ok(fs.existsSync(path.join(vendorRoot, 'ComfyUI-VDN-H3', 'LICENSE')), 'the vendored payload keeps its own LICENSE file')

    // Fixture-pack lifecycle: availability → install → no-op → bump →
    // uninstall → foreign refusal → user-fetch → bad inputs.
    const { vendorRoot: fixtureRoot } = makeFixtureVendorRoot()
    const checkout = makeCheckout()
    const entry = fixturePackEntry()
    const listed = await checkNodePack(entry, checkout, fixtureRoot)
    ok(listed.availability === 'ready' && listed.installed === false && listed.vendored === true, 'a vendored pack with its payload present reports ready + not installed')

    const install = await installNodePack(entry, { checkout, vendorRoot: fixtureRoot })
    ok(install.installed === true, 'install succeeds into the checkout custom_nodes/')
    const installedDir = nodePackInstallDir(checkout, entry)
    ok(fs.existsSync(path.join(installedDir, '__init__.py')), 'pack code lands in custom_nodes/<name>')
    ok(!fs.existsSync(path.join(installedDir, '__pycache__')), 'junk dirs (__pycache__) are skipped')
    const weightLink = path.join(installedDir, 'weights', 'tiny.safetensors')
    const sourceWeight = path.join(fixtureRoot, 'fixture-pack', 'weights', 'tiny.safetensors')
    const linkedStat = fs.statSync(weightLink)
    ok(fs.lstatSync(weightLink).isSymbolicLink() || (linkedStat.ino !== 0 && linkedStat.ino === fs.statSync(sourceWeight).ino), 'pack weights are LINKED (symlink/junction/hardlink), never copied')
    ok(fs.readFileSync(weightLink, 'utf8') === 'FAKE-WEIGHT-BYTES', 'the link resolves to the vendored bytes')
    const marker = JSON.parse(fs.readFileSync(path.join(installedDir, '.studio-node.json'), 'utf8'))
    ok(marker.id === 'fixture-pack' && marker.revision === 'rev1', 'the studio marker records id + pinned revision')

    const again = await installNodePack(entry, { checkout, vendorRoot: fixtureRoot })
    ok(again.installed === true && again.alreadyInstalled === true, 're-install at the same pin is a no-op (alreadyInstalled)')

    // Version bump = delete + reinstall at the pin (never a merge).
    const bumped = { ...entry, pinnedRevision: 'rev2' }
    const reinstalled = await installNodePack(bumped, { checkout, vendorRoot: fixtureRoot })
    ok(reinstalled.installed === true && reinstalled.notes.some((note) => note.includes('rev1')), 'a revision bump reinstalls (delete + fresh install at the pin)')
    ok(JSON.parse(fs.readFileSync(path.join(installedDir, '.studio-node.json'), 'utf8')).revision === 'rev2', 'the marker moves to the new pin')
    ok(fs.lstatSync(weightLink).isSymbolicLink() || fs.statSync(weightLink).ino === fs.statSync(sourceWeight).ino, 'weights stay linked across the reinstall')

    // Uninstall = delete folder; the vendored payload itself is untouched.
    const removed = await uninstallNodePack(bumped, checkout)
    ok(removed.removed === true && !fs.existsSync(installedDir), 'uninstall deletes the pack folder')
    ok(fs.existsSync(sourceWeight), 'the vendored payload is untouched by uninstall')
    ok((await uninstallNodePack(bumped, checkout)).removed === false, 'uninstalling a missing pack reports honestly')

    // A foreign custom_nodes/<name> (no studio marker) is refused, untouched.
    fs.mkdirSync(installedDir, { recursive: true })
    fs.writeFileSync(path.join(installedDir, '__init__.py'), '# user installed this by hand\n')
    const foreign = await installNodePack(entry, { checkout, vendorRoot: fixtureRoot })
    ok(foreign.installed === false && foreign.notes.some((note) => note.includes('not installed by the studio')), 'a foreign custom_nodes/<name> is refused, never replaced')
    ok(fs.readFileSync(path.join(installedDir, '__init__.py'), 'utf8').includes('by hand'), 'the foreign install is byte-for-byte untouched')

    // User-fetch mode: needs a local source directory (the network fetcher
    // is a later increment); relative paths and bad checkouts are refused.
    const userFetchEntry = { ...fixturePackEntry(), installMode: 'user-fetch', id: 'fixture-fetch', name: 'fixture-fetch', vendorDir: undefined }
    const needsSource = await installNodePack(userFetchEntry, { checkout, vendorRoot: fixtureRoot })
    ok(needsSource.installed === false && needsSource.notes.some((note) => note.includes('local directory')), 'user-fetch without a source directory is refused with the reason')
    const fetched = await installNodePack(userFetchEntry, { checkout, vendorRoot: fixtureRoot, sourceDirectory: path.join(fixtureRoot, 'fixture-pack') })
    ok(fetched.installed === true && fs.existsSync(path.join(nodePackInstallDir(checkout, userFetchEntry), '__init__.py')), 'user-fetch installs from a nominated local copy')
    const fetchedStatus = await checkNodePack(userFetchEntry, checkout, fixtureRoot)
    ok(fetchedStatus.availability === 'needs-source' && (fetchedStatus.note ?? '').includes('user-fetch'), 'user-fetch availability is surfaced with its note')
    const relative = await installNodePack({ ...userFetchEntry, id: 'fixture-fetch-2', name: 'fixture-fetch-2' }, { checkout, sourceDirectory: 'relative/path', vendorRoot: fixtureRoot })
    ok(relative.installed === false, 'a relative source directory is refused')
    const badCheckoutInstall = await installNodePack(entry, { checkout: '/definitely/not/a/checkout', vendorRoot: fixtureRoot })
    ok(badCheckoutInstall.installed === false && badCheckoutInstall.notes.some((note) => note.includes('main.py')), 'install into a non-checkout is refused')
    ok(isUsableCheckout('/definitely/not/here') === false && isUsableCheckout(checkout) === true, 'checkout validation answers both ways')

    // The REAL vendored payload installs offline from vendor/nodes.
    const real = findNodePack('vdn-h3')
    const realInstall = await installNodePack(real, { checkout, vendorRoot })
    ok(realInstall.installed === true && fs.existsSync(path.join(nodePackInstallDir(checkout, real), 'vdn_h3', 'nodes.py')), 'the real vendored VDN payload installs from vendor/nodes (no network)')
    ok(!fs.existsSync(path.join(nodePackInstallDir(checkout, real), 'assets')), 'the vendored payload carries no demo media (assets/ excluded at vendor time)')
    await uninstallNodePack(real, checkout)
  }

  // ---- (k) consent patch manager (increment 2) ------------------------------------
  console.log('runtime: consent patch manager')
  {
    // Pure layout detection over the three fixture layouts.
    ok(detectPatchLayout(FIXTURE_MODEL_CURRENT) === 'clean-current', 'the current 0.33.x/0.34 loop layout is detected')
    ok(detectPatchLayout(FIXTURE_MODEL_OLD) === 'clean-old', 'the older malloc_scope layout is detected')
    ok(detectPatchLayout(FIXTURE_MODEL_UNKNOWN) === 'unknown', 'a refactored layout is unknown (refuse territory)')

    // Structural validator sanity.
    ok(structuralBalance('def f(:\n    pass\n').ok === false, 'unbalanced brackets are rejected by the structural validator')
    ok(structuralBalance("x = ('a string with ) and ] inside')\n").ok === true, 'string contents do not confuse the structural validator')

    // Apply on the current layout: patched markers, pristine backup,
    // atomic write, no temp survivor.
    const checkout = makePatchCheckout(FIXTURE_MODEL_CURRENT, '0.34.0')
    const target = patchTargetOf(checkout)
    const before = fs.readFileSync(target, 'utf8')
    const applied = await applyEnginePatch(LONGCACHE_PATCH, checkout, { pythonCommand: process.execPath })
    ok(applied.applied === true, 'the block-loop hook applies on the verified layout')
    ok(applied.validation === 'structural' || applied.validation === 'python-ast', `validation ran (${applied.validation})`)
    const patched = fs.readFileSync(target, 'utf8')
    ok(patched.includes('def _run_blocks(self, h, t_emb') && patched.includes('("block_loop", 0) in blocks_replace'), 'the patched file carries the hook markers')
    ok(detectPatchLayout(patched) === 'patched', 'the patched text detects as patched')
    ok(structuralBalance(patched).ok === true, 'the patched file passes structural validation')
    const backupPath = `${target}${LONGCACHE_PATCH.backupSuffix}`
    ok(fs.readFileSync(backupPath, 'utf8') === before, 'a pristine backup of the original is kept')
    ok(!fs.existsSync(`${target}.studio-tmp`), 'no temp file survives the atomic write')

    // The pure transform is idempotent on already-patched text.
    const transformAgain = transformPatchedText(patched)
    ok(transformAgain.ok === true && transformAgain.text === patched, 'the transform is a no-op on already-patched text')

    // Idempotent apply + --check.
    const again = await applyEnginePatch(LONGCACHE_PATCH, checkout, { pythonCommand: process.execPath })
    ok(again.applied === false && again.already === true, 're-apply on a patched file is a no-op (already)')
    const check = await checkEnginePatch(LONGCACHE_PATCH, checkout)
    ok(check.layout === 'patched' && check.backupPresent === true && typeof check.fingerprint === 'string' && check.fingerprint.length === 64, 'check reports patched + backup + a sha256 layout fingerprint')
    ok(check.versionGate.ok === true && check.versionGate.version === '0.34.0' && check.versionGate.source === 'checkout', 'the version gate reads the checkout version')

    // Revert restores the pristine original byte-for-byte.
    const reverted = await revertEnginePatch(LONGCACHE_PATCH, checkout)
    ok(reverted.reverted === true && fs.readFileSync(target, 'utf8') === before, 'revert restores the pristine original byte-for-byte')
    ok((await checkEnginePatch(LONGCACHE_PATCH, checkout)).layout === 'clean-current', 'post-revert the layout is clean again')

    // Old layout patches too.
    const oldCheckout = makePatchCheckout(FIXTURE_MODEL_OLD, '0.33.6')
    ok((await applyEnginePatch(LONGCACHE_PATCH, oldCheckout, { pythonCommand: process.execPath })).applied === true, 'the older malloc_scope layout also patches')

    // Refuse-unknown: the file is byte-for-byte unchanged.
    const unknownCheckout = makePatchCheckout(FIXTURE_MODEL_UNKNOWN, '0.34.0')
    const unknownBefore = fs.readFileSync(patchTargetOf(unknownCheckout), 'utf8')
    const refused = await applyEnginePatch(LONGCACHE_PATCH, unknownCheckout, { pythonCommand: process.execPath })
    ok(refused.applied === false && /no file was changed/.test(refused.reason ?? ''), 'an unrecognized layout is refused with the no-file-changed reason')
    ok(fs.readFileSync(patchTargetOf(unknownCheckout), 'utf8') === unknownBefore, 'the refused file is byte-for-byte unchanged')
    ok(!fs.existsSync(`${patchTargetOf(unknownCheckout)}${LONGCACHE_PATCH.backupSuffix}`), 'a refused apply writes no backup either')

    // Version gate: unverified version fails; settings fallback works; no
    // version anywhere fails CLOSED.
    const futureCheck = await checkEnginePatch(LONGCACHE_PATCH, makePatchCheckout(FIXTURE_MODEL_CURRENT, '0.35.1'))
    ok(futureCheck.versionGate.ok === false && futureCheck.versionGate.version === '0.35.1', 'an unverified ComfyUI version fails the gate (degrade, do not patch)')
    const noVersionCheckout = makePatchCheckout(FIXTURE_MODEL_CURRENT, undefined)
    const viaSettings = await checkEnginePatch(LONGCACHE_PATCH, noVersionCheckout, '0.34.0')
    ok(viaSettings.versionGate.source === 'settings' && viaSettings.versionGate.ok === true, 'the recorded testedComfyVersion stands in when the checkout states no version')
    const noVersionAtAll = await checkEnginePatch(LONGCACHE_PATCH, noVersionCheckout)
    ok(noVersionAtAll.versionGate.ok === false && noVersionAtAll.versionGate.source === 'none', 'with no version anywhere the gate fails closed')

    // Missing target.
    const missing = await applyEnginePatch(LONGCACHE_PATCH, makeCheckout(), { pythonCommand: process.execPath })
    ok(missing.applied === false && missing.layout === 'missing', 'a checkout without the target reports layout missing, applied false')

    // The ast gate when the launch command IS python (and the real parser
    // agrees with our patched output).
    const python = await findPython()
    if (!python) {
      console.log('  NOTE - no python on PATH; ast-gate checks skipped (structural path covered above)')
    } else {
      const pythonCheckout = makePatchCheckout(FIXTURE_MODEL_CURRENT, '0.34.0')
      const withPython = await applyEnginePatch(LONGCACHE_PATCH, pythonCheckout, { pythonCommand: python })
      ok(withPython.applied === true && withPython.validation === 'python-ast', 'the ast gate runs (python-ast) when the launch command is python')
      const astAccepts = await new Promise((resolve) => {
        const probe = spawn(python, ['-c', 'import ast,sys; ast.parse(open(sys.argv[1],encoding="utf-8").read())', patchTargetOf(pythonCheckout)], { stdio: 'ignore' })
        probe.on('error', () => resolve(false))
        probe.on('exit', (code) => resolve(code === 0))
      })
      ok(astAccepts === true, "python's own ast.parse accepts the patched file (real parser agreement)")
      ok(ENGINE_PATCHES.length === 1 && ENGINE_PATCHES[0].id === 'longcache-block-loop', 'the patch registry ships exactly the LongCache patch')
    }

    // Launch integration: vdn profile + consent → the hook patches before
    // spawn; revert still works afterwards.
    const launchCheckout = makePatchCheckout(FIXTURE_MODEL_CURRENT, '0.34.0')
    const launchRuntime = makeManager(makeHome(), makeSettings(launchCheckout, { engine: { profile: 'vdn', patches: { 'longcache-block-loop': { consented: true } } } }), { startPort: await suiteStartPort() })
    const launched = await launchRuntime.start()
    ok(launched.status.state === 'running' && launched.status.profile === 'vdn', 'the vdn profile launches with the patch hook in play')
    ok(detectPatchLayout(fs.readFileSync(patchTargetOf(launchCheckout), 'utf8')) === 'patched', 'consent + verified layout + gate pass → the target is patched before spawn')
    ok(fs.existsSync(`${patchTargetOf(launchCheckout)}${LONGCACHE_PATCH.backupSuffix}`), 'the pre-launch patch kept its pristine backup')
    ok(launched.status.logTail.some((line) => line.includes('patch longcache-block-loop applied')), 'the applied patch is named in the log tail')
    ok((await revertEnginePatch(LONGCACHE_PATCH, launchCheckout)).reverted === true, 'revert works after the launch integration too')
    await launchRuntime.stop()
  }

  // ---- (l) weight symlink policy (increment 2) ------------------------------------
  console.log('runtime: weight symlink policy')
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-runtime-links-'))
    const weightSource = path.join(home, 'vdn-branch.safetensors')
    fs.writeFileSync(weightSource, 'WEIGHT-BYTES')
    const settings = makeSettings(makeCheckout())

    const intoRoot = await linkWeightIntoModelRoot(weightSource, 'loras', settings)
    ok(intoRoot.ok === true, 'a weight lands in the model root as a link')
    const linkPath = intoRoot.ok ? intoRoot.path : ''
    ok(fs.readFileSync(linkPath, 'utf8') === 'WEIGHT-BYTES', 'the link resolves to the real bytes')
    ok(fs.lstatSync(linkPath).isSymbolicLink() || fs.statSync(linkPath).ino === fs.statSync(weightSource).ino, 'it is a link (symlink/junction/hardlink), not a copy')

    const relink = await linkWeightIntoModelRoot(weightSource, 'loras', settings)
    ok(relink.ok === true && relink.path === linkPath, 'linking the same weight again reuses the existing link')

    fs.writeFileSync(path.join(settings.paths.vae, 'vdn-branch.safetensors'), 'SOMEONE-ELSES-WEIGHT')
    const conflict = await linkWeightIntoModelRoot(weightSource, 'vae', settings)
    ok(conflict.ok === false && /refusing to overwrite/i.test(conflict.reason), 'an existing different entry is refused, never overwritten')
    ok(fs.readFileSync(path.join(settings.paths.vae, 'vdn-branch.safetensors'), 'utf8') === 'SOMEONE-ELSES-WEIGHT', 'the conflicting file is untouched')

    const dirSource = path.join(home, 'pack-weights')
    fs.mkdirSync(dirSource)
    fs.writeFileSync(path.join(dirSource, 'a.safetensors'), 'A')
    ok((await linkNeverCopy(dirSource, path.join(home, 'dir-link'))).ok === true, 'directories link too (junction on Windows)')

    const missingTarget = await linkNeverCopy(path.join(home, 'nope.safetensors'), path.join(home, 'nope-link'))
    ok(missingTarget.ok === false && /does not exist/.test(missingTarget.reason), 'a missing link target is refused with the reason')

    const badRoot = await linkWeightIntoModelRoot(weightSource, 'loras', { ...settings, paths: { ...settings.paths, loras: 'relative/root' } })
    ok(badRoot.ok === false && /not a usable absolute directory/.test(badRoot.reason), 'an invalid model root refuses the link (no guesses)')
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
