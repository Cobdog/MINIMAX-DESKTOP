// start.sh launcher contract suite (task ukyxwfa). Drives the REAL script
// through `sh` with hermetic scratch configs (MINIMAX_START_CONFIG) and
// scratch studio homes — the launcher's repo-root .start-config.json is never
// touched, and no e2e home or foreign port is ever read. Every dry run /
// boot rides a freshly probed 7000–7099 port (house discipline: never assume
// 4178/5173 are free — the maintainer's own studio may be running). Sections:
//   (a) first-run seeding + dry-run plan (dev defaults per the 2026-09-19
//       decision: port 4178 in the FILE, dev on)
//   (b) --set / --print round-trip; bad values name the field; unknown keys
//       list the valid ones; port/vite-port collision refused
//   (c) invalid saved config (bad JSON, bad field) refuses to boot and names
//       the offender; --set is the documented single-field repair path
//   (d) flag parsing: unknown flag → usage error; bare --dev → honest hint
//   (e) env precedence: caller-set MINIMAX_LAN_PORT / MINIMAX_STUDIO_HOME win
//   (f) busy-port honesty: occupied port → refusal naming the port and the
//       holding PID (the test's own listener), never a kill
//   (g) prompts-configure (MINIMAX_START_TUI=prompts, piped stdin): full save
//       including the engine-URL write into <home>/settings.json (other
//       fields preserved) and token regeneration; cancel path saves nothing
//   (h) missing dependencies: a start.sh copy without node_modules/ reports
//       "pnpm install" honestly (print and interactive-declined paths)
//   (i) dev-vs-prod boot plan selection (vite+tsc+--watch vs plain node) and
//       the source-map flag toggle
//   (j) real production boot through the launcher on a 7000–7099 port
//       (recorded PID only, SIGTERM teardown, port re-probed free) — runs
//       when the build exists (gate order: after build), NOTE-skips otherwise
// POSIX-only: start.sh targets /bin/sh; the Windows engine leg does not run
// this suite and a win32 invocation self-skips with a NOTE.
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')

const REPO = path.join(__dirname, '..')
const START_SH = path.join(REPO, 'start.sh')

if (process.platform === 'win32') {
  console.log('NOTE: test:launcher drives start.sh (POSIX sh) — the launcher does not run on Windows; skipping.')
  process.exit(0)
}

let passed = 0
function ok(condition, label) {
  assert.ok(condition, label)
  passed += 1
  console.log(`  ok - ${label}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

// House port discipline: this suite's range is 7000–7099.
async function freePort() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = 7000 + Math.floor(Math.random() * 100)
    const busy = await new Promise((resolve) => {
      const probe = net.connect({ port: candidate, host: '127.0.0.1' })
      probe.on('error', () => resolve(false)) // connection refused — free
      probe.on('connect', () => { probe.destroy(); resolve(true) })
    })
    if (!busy) return candidate
  }
  throw new Error('no free port found in 50 attempts')
}

/** Runs the real start.sh under sh. Everything the launcher needs to stay
 *  hermetic rides env: the config path and (per case) the studio home;
 *  options.script substitutes a COPY of the script (the missing-deps case). */
function run(args, options = {}) {
  const result = spawnSync('sh', [options.script ?? START_SH, ...args], {
    cwd: options.cwd ?? REPO,
    env: { ...process.env, ...(options.env ?? {}) },
    input: options.input ?? '',
    encoding: 'utf8',
    timeout: options.timeout ?? 60_000,
  })
  return { code: result.status, out: `${result.stdout || ''}${result.stderr || ''}` }
}

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-launcher-'))
}

async function main() {
  const hasBuild = fs.existsSync(path.join(REPO, 'dist', 'index.html')) && fs.existsSync(path.join(REPO, 'dist-server', 'server', 'index.js'))

  // ---- (a) first-run seeding + dry-run plan ---------------------------------
  console.log('launcher: first-run seeding + dry-run plan')
  {
    const dir = scratch()
    const config = path.join(dir, 'config.json')
    const port = await freePort()
    const vitePort = port === 7099 ? 7098 : 7099
    const result = run(['--print'], { env: { MINIMAX_START_CONFIG: config, MINIMAX_LAN_PORT: String(port), MINIMAX_VITE_PORT: String(vitePort) } })
    ok(result.code === 0, `first dry run exits 0 (got ${result.code})\n${result.out}`)
    ok(fs.existsSync(config), 'first run seeds the config file')
    const saved = JSON.parse(fs.readFileSync(config, 'utf8'))
    ok(saved.port === 4178, 'seeded port is 4178 (app default)')
    ok(saved.vitePort === 5173, 'seeded vite port is 5173 (vite default)')
    ok(saved.dev === true, 'seeded dev mode is ON (dated 2026-09-19 decision)')
    ok(saved.host === '0.0.0.0' && saved.https === true && saved.token === false, 'seeded host/https/token match the app defaults')
    ok(result.out.includes('seeded defaults at'), 'first run announces the seeding')
    ok(result.out.includes('mode=dev') && result.out.includes(`port=${port}`), 'machine line reports dev mode and the resolved port')
    ok(result.out.includes('node --enable-source-maps --watch dist-server/server/index.js'), 'dev plan uses node --watch with source maps')
    ok(result.out.includes(`vite --port ${vitePort} --strictPort`), 'dev plan boots vite with --strictPort')
    ok(result.out.includes('not booting'), 'dry run states it is not booting')
  }

  // ---- (b) --set / --print round-trip + validation ---------------------------
  console.log('launcher: --set/--print round-trip and field validation')
  {
    const dir = scratch()
    const config = path.join(dir, 'config.json')
    const port = await freePort()
    const env = { MINIMAX_START_CONFIG: config, MINIMAX_LAN_PORT: String(port) }
    ok(run(['--set', `port=${port}`], { env }).code === 0, '--set port succeeds')
    ok(JSON.parse(fs.readFileSync(config, 'utf8')).port === port, '--set persists to the config file')
    const after = run(['--print'], { env })
    ok(after.code === 0 && after.out.includes(`port=${port}`), '--print reflects the saved port')
    ok(run(['--set', 'log-level=debug'], { env }).code === 0, '--set log-level accepts debug')
    ok(run(['--print'], { env }).out.includes('log=debug'), '--print reflects the saved log level')

    const badPort = run(['--set', 'port=nope'], { env })
    ok(badPort.code !== 0 && badPort.out.includes('port: expected an integer'), 'bad port value is refused naming the field')
    const badKey = run(['--set', 'frob=1'], { env })
    ok(badKey.code !== 0 && badKey.out.includes('unknown key') && badKey.out.includes('vite-port'), 'unknown key lists the valid keys')
    const missingValue = run(['--set'], { env })
    ok(missingValue.code !== 0 && missingValue.out.includes('--set needs'), 'missing --set value is a usage error')
    const savedStill = JSON.parse(fs.readFileSync(config, 'utf8'))
    ok(savedStill.port === port, 'refused --set values do not corrupt the config')

    const collide = run(['--set', `vite-port=${port}`], { env })
    ok(collide.code !== 0 && collide.out.includes('vitePort: must differ from port'), 'vite port == LAN port is refused')
    const relative = run(['--set', 'data-dir=relative/path'], { env })
    ok(relative.code !== 0 && relative.out.includes('dataDir: must be an absolute path'), 'relative data dir is refused (the app demands absolute write paths)')
  }

  // ---- (c) invalid saved config refuses to boot ------------------------------
  console.log('launcher: invalid saved config honesty')
  {
    const dir = scratch()
    const config = path.join(dir, 'config.json')
    fs.writeFileSync(config, 'not json {')
    const broken = run(['--print'], { env: { MINIMAX_START_CONFIG: config } })
    ok(broken.code !== 0 && broken.out.includes('is not valid JSON'), 'unparseable config refuses to boot naming the file')
    ok(broken.out.includes('refusing to boot'), 'the refusal is explicit, never a silent wrong boot')
    fs.writeFileSync(config, JSON.stringify({ port: 12 }))
    const badField = run(['--print'], { env: { MINIMAX_START_CONFIG: config } })
    ok(badField.code !== 0 && badField.out.includes('port: expected an integer'), 'out-of-range port names the field')
    // The documented repair path: --set rewrites the offending field.
    const port = await freePort()
    ok(run(['--set', `port=${port}`], { env: { MINIMAX_START_CONFIG: config } }).code === 0, '--set repairs a single bad field')
    ok(run(['--print'], { env: { MINIMAX_START_CONFIG: config } }).code === 0, 'the repaired config boots (dry run)')
    fs.writeFileSync(config, JSON.stringify({ frob: 1 }))
    const unknownField = run(['--print'], { env: { MINIMAX_START_CONFIG: config } })
    ok(unknownField.code !== 0 && unknownField.out.includes('unknown config field'), 'unknown config fields are refused, not ignored')
  }

  // ---- (d) flag parsing -------------------------------------------------------
  console.log('launcher: flag parsing')
  {
    const dir = scratch()
    const env = { MINIMAX_START_CONFIG: path.join(dir, 'config.json') }
    const unknown = run(['--frobnicate'], { env })
    ok(unknown.code === 2 && unknown.out.includes('unknown flag: --frobnicate'), 'unknown flag exits 2 with usage')
    ok(unknown.out.includes('usage: ./start.sh'), 'usage text follows the error')
    const devAlone = run(['--dev'], { env })
    ok(devAlone.code === 2 && devAlone.out.includes('--dev only applies to --configure'), 'bare --dev explains itself instead of booting')
    const help = run(['--help'], { env })
    ok(help.code === 0 && help.out.includes('--configure'), '--help prints the flag surface')
  }

  // ---- (e) env precedence -----------------------------------------------------
  console.log('launcher: caller env wins over the config file')
  {
    const dir = scratch()
    const config = path.join(dir, 'config.json')
    const envPort = await freePort()
    const savedPort = envPort === 7001 ? 7002 : 7001
    run(['--set', `port=${savedPort}`], { env: { MINIMAX_START_CONFIG: config } })
    const result = run(['--print'], { env: { MINIMAX_START_CONFIG: config, MINIMAX_LAN_PORT: String(envPort), MINIMAX_STUDIO_HOME: path.join(dir, 'env-home') } })
    ok(result.code === 0 && result.out.includes(`port=${envPort}`), 'MINIMAX_LAN_PORT overrides the saved port')
    ok(result.out.includes(`home=${path.join(dir, 'env-home')}`), 'MINIMAX_STUDIO_HOME overrides the saved home')
    ok(!result.out.includes(`port=${savedPort} `), 'the overridden port is not reported as active')
  }

  // ---- (f) busy-port honesty ---------------------------------------------------
  console.log('launcher: busy-port honesty')
  {
    const dir = scratch()
    const config = path.join(dir, 'config.json')
    const port = await freePort()
    const holder = http.createServer((request, response) => { response.end('occupied') })
    await new Promise((resolve) => holder.listen(port, '0.0.0.0', resolve))
    run(['--set', `port=${port}`], { env: { MINIMAX_START_CONFIG: config } })
    const result = run(['--print'], { env: { MINIMAX_START_CONFIG: config } })
    ok(result.code !== 0, `dry run on a busy port fails (port ${port})`)
    ok(result.out.includes(`port ${port} is not available`), 'the refusal names the port')
    const pidMatch = result.out.match(/held by PID (\d+)/)
    if (pidMatch) {
      ok(pidMatch[1] === String(process.pid), 'the reported holder is the actual listener (this test process)')
    } else {
      console.log('  NOTE: holder PID not resolvable on this machine (lsof/ss/fuser absent) — the port-level assertion stands')
    }
    ok(result.out.includes('never kills'), 'the message states the never-kill posture')
    await new Promise((resolve) => holder.close(resolve))
    const freed = run(['--print'], { env: { MINIMAX_START_CONFIG: config } })
    ok(freed.code === 0, 'the same config boots once the port is released')
  }

  // ---- (g) prompts-configure save ----------------------------------------------
  console.log('launcher: prompts configure (save + engine write + token regen)')
  {
    const dir = scratch()
    const config = path.join(dir, 'config.json')
    const home = path.join(dir, 'studio-home')
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ comfyUrl: 'http://127.0.0.1:8188', ollamaUrl: 'http://127.0.0.1:11434' }))
    const port = await freePort()
    const vitePort = port === 7099 ? 7098 : 7099
    // Prompts, in order: port, token, qr, regen, data dir, engine, https,
    // bind, log, [dev] dev, pretty, maps, vite port, save.
    const answers = [String(port), 'y', 'y', 'y', '', 'http://127.0.0.1:8199', 'y', '', '', 'y', 'y', 'y', String(vitePort), 'y']
    const result = run(['--configure', '--dev', '--print'], {
      env: { MINIMAX_START_CONFIG: config, MINIMAX_STUDIO_HOME: home, MINIMAX_START_TUI: 'prompts' },
      input: `${answers.join('\n')}\n`,
    })
    ok(result.code === 0, `prompts configure + preview exits 0\n${result.out}`)
    const saved = JSON.parse(fs.readFileSync(config, 'utf8'))
    ok(saved.port === port && saved.token === true && saved.dev === true && saved.vitePort === vitePort, 'every answered field is saved')
    const settings = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'))
    ok(settings.comfyUrl === 'http://127.0.0.1:8199', 'the engine URL was written to the app settings')
    ok(settings.ollamaUrl === 'http://127.0.0.1:11434', 'the engine write preserves the other settings fields')
    const tokenFile = path.join(home, 'lan-access-token.txt')
    ok(fs.existsSync(tokenFile) && /^[a-f0-9]{32}$/.test(fs.readFileSync(tokenFile, 'utf8').trim()), 'token regeneration writes a 32-hex token in the app format')
    ok(result.out.includes(`mode=dev port=${port}`), 'the post-save preview reports the new port')

    // Cancel path: the config now has token=true, so the prompt order is
    // port, token, qr, regen, data dir, engine, https, bind, log, save —
    // nine keeps, then "n" at the save confirm.
    const before = fs.readFileSync(config, 'utf8')
    const cancelled = run(['--configure', '--print'], {
      env: { MINIMAX_START_CONFIG: config, MINIMAX_STUDIO_HOME: home, MINIMAX_START_TUI: 'prompts' },
      input: '\n\n\n\n\n\n\n\n\nn\n',
    })
    ok(cancelled.code === 0 && cancelled.out.includes('nothing was saved'), 'cancel path saves nothing')
    ok(fs.readFileSync(config, 'utf8') === before, 'the config file is byte-identical after cancelling')
  }

  // ---- (h) missing dependencies --------------------------------------------------
  console.log('launcher: missing-dependency honesty')
  {
    const dir = scratch()
    const copied = path.join(dir, 'start.sh')
    fs.copyFileSync(START_SH, copied)
    const config = path.join(dir, 'config.json')
    const env = { MINIMAX_START_CONFIG: config, MINIMAX_START_TUI: 'prompts' }
    // Running the COPY from a cwd outside the repo also proves the script is
    // self-locating (and that the repo path's space is handled).
    const printed = run(['--print'], { cwd: dir, env, script: copied })
    ok(printed.code !== 0 && printed.out.includes('pnpm install'), `print without node_modules reports pnpm install\n${printed.out}`)
    const bare = run([], { cwd: dir, env, script: copied })
    ok(bare.code !== 0 && bare.out.includes('pnpm install'), 'bare run without node_modules (offer declined by EOF) reports pnpm install')
    ok(!fs.existsSync(path.join(REPO, '.start-config.json')), 'no run ever writes the repo-root config without an explicit override')
  }

  // ---- (i) dev-vs-prod boot plan --------------------------------------------------
  console.log('launcher: dev-vs-prod boot plan selection')
  {
    const dir = scratch()
    const config = path.join(dir, 'config.json')
    const port = await freePort()
    const vitePort = port === 7099 ? 7098 : 7099
    const env = { MINIMAX_START_CONFIG: config, MINIMAX_LAN_PORT: String(port), MINIMAX_VITE_PORT: String(vitePort) }
    run(['--set', 'dev=false'], { env })
    const prod = run(['--print'], { env })
    if (hasBuild) {
      ok(prod.code === 0 && prod.out.includes('[prod] node dist-server/server/index.js'), 'prod plan boots the built server')
    } else {
      ok(prod.code !== 0 && prod.out.includes('pnpm build'), 'prod plan without a build points at pnpm build (honest, adaptive)')
    }
    ok(!prod.out.includes('vite --port'), 'prod plan never boots vite')
    run(['--set', 'dev=true'], { env })
    const dev = run(['--print'], { env })
    ok(dev.code === 0, `dev plan dry-run exits 0\n${dev.out}`)
    ok(dev.out.includes('tsc -p tsconfig.server.json --watch'), 'dev plan watches the server sources')
    ok(dev.out.includes('node --enable-source-maps --watch'), 'dev plan runs node --watch with source maps')
    run(['--set', 'source-maps=false'], { env })
    const noMaps = run(['--print'], { env })
    ok(noMaps.out.includes('node --watch dist-server/server/index.js') && !noMaps.out.includes('--enable-source-maps'), 'source-maps off drops the flag')
  }

  // ---- (j) real production boot through the launcher -------------------------------
  console.log('launcher: real production boot (recorded PID only)')
  {
    if (!hasBuild) {
      console.log('  NOTE: build output absent — the real-boot section skips (the gate runs this suite after build).')
    } else {
      const dir = scratch()
      const config = path.join(dir, 'config.json')
      const home = path.join(dir, 'boot-home')
      const port = await freePort()
      const env = { MINIMAX_START_CONFIG: config }
      run(['--set', `port=${port}`], { env })
      run(['--set', 'dev=false'], { env })
      const child = spawn('sh', [START_SH], {
        cwd: REPO,
        env: { ...process.env, MINIMAX_START_CONFIG: config, MINIMAX_STUDIO_HOME: home, MINIMAX_NO_HTTPS: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout.on('data', (chunk) => { output += String(chunk) })
      child.stderr.on('data', (chunk) => { output += String(chunk) })
      const ready = await waitUntil(async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/api/lan/settings`)
          return response.ok
        } catch { return false }
      }, 20_000, 'launcher-booted server to answer /api/lan/settings')
      ok(ready, 'the launcher boots the real server and it serves the API')
      ok(output.includes('MiniMax Studio launcher') && output.includes(`port=${port}`), 'the boot banner states the active config')
      child.kill('SIGTERM') // the recorded PID only — never anything else
      const exited = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 10_000)
        child.on('exit', () => { clearTimeout(timer); resolve(true) })
      })
      ok(exited, 'SIGTERM to the recorded PID stops the booted server')
      const released = await new Promise((resolve) => {
        const probe = net.connect({ port, host: '127.0.0.1' })
        probe.on('error', () => resolve(true))
        probe.on('connect', () => { probe.destroy(); resolve(false) })
      })
      ok(released, 'the port is free again after teardown')
    }
  }

  console.log(`\nlauncher: ${passed} checks passed`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
