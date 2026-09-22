// Manager-first pack install suite (task 0pktw5h, directive ffcff765).
// NO real engine, NO real Manager, NO network: a LOCAL fake engine speaks
// the verified 4.2.2 contract (docs/devdocs/comfyui-manager-api/index.md —
// the presence flag, the v2 task-queue routes, the WS cm-* events), and the
// real built server routes pack installs through it. Arms:
//   (a) pure client unit: the honest-absent probe parsing (the
//       supports_csrf_post KEY — core's unconditional supports_v4 must NOT
//       read as presence), the QueueTaskItem payload derivation for the two
//       gap-row packs, the history verdict parser, the bounded poll, and
//       the WS event normalizer (cm-queue-status / cm-task-completed shapes
//       per the capture; cm-api-try-install-customnode NEVER a prompt).
//   (b) routes, Manager PRESENT arm: install of h3-motion-context queues a
//       QueueTaskItem with our engine-bridge client_id, consent enforced,
//       uninstall of a foreign folder goes through the Manager, the nodes
//       list states presence + version + installed packs, and the WS
//       cm-queue-status flow reaches a system-channel subscriber.
//   (c) routes, Manager ABSENT arm (the settling test): /features without
//       the Manager key → the board's manager verdict is absent WITH the
//       reason; installs fall back to the studio path with the reason named
//       in the notes (NEVER silent); consent still gates; an unreachable
//       engine degrades to absent-with-reason without breaking the list.
// Run after `pnpm build` (the server boots from dist-server; the web build
// must exist for index.js to start).
import { test, afterAll } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = require('node:path').dirname(fileURLToPath(import.meta.url))
const REPO = require('node:path').resolve(__dirname, '..')

const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { WebSocket, WebSocketServer } = require('ws')
const { makePortAllocator } = require('./lib/ports.cjs')
const { makeScratchDir, removeAllScratchDirs } = require('./lib/scratch.cjs')
afterAll(() => { void removeAllScratchDirs() })

const freePort = makePortAllocator('manager-install')

const hasServerBuild = fs.existsSync(path.join(REPO, 'dist-server', 'server', 'managerClient.js'))
if (!hasServerBuild) {
  console.log('NOTE - no dist-server build present (managerClient.js); run pnpm build — this suite runs on legs that build the server.')
}
const maybe = hasServerBuild ? test : test.skip

const { createManagerClient, managerInstallParams, managerPackId, managerUninstallParams, waitForManagerTask } = hasServerBuild
  ? require(path.join(REPO, 'dist-server', 'server', 'managerClient.js')) : {}
const { normalizeManagerEvent } = hasServerBuild
  ? require(path.join(REPO, 'dist-server', 'server', 'realtime.js')) : {}
const { findNodePack } = hasServerBuild
  ? require(path.join(REPO, 'dist-server', 'server', 'engineNodes.js')) : {}

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

function makeHome() {
  return makeScratchDir(path.join(os.tmpdir(), 'minimax-manager-home-'))
}

// ---------------------------------------------------------------------------
// (a) pure client unit arm
// ---------------------------------------------------------------------------

maybe('(a) manager client unit: probe key discipline, payload derivation, history parsing, poll, WS normalizer', async () => {
  // The probe funnel records asks so each arm feeds exact bodies.
  const makeFunnel = () => {
    const asks = []
    const routes = new Map()
    const funnel = async (url, routePath, init) => {
      asks.push({ path: routePath, init })
      const handler = routes.get(routePath)
      if (!handler) throw new Error(`ComfyUI returned 404 (${routePath})`)
      return handler(init)
    }
    return { asks, routes, funnel }
  }

  console.log('manager: presence is the supports_csrf_post KEY, not the extension.manager key')
  {
    const { routes, funnel } = makeFunnel()
    routes.set('/features', async () => ({ extension: { manager: { supports_v4: true } } }))
    const client = createManagerClient(funnel)
    const probe = await client.probe('http://engine.local')
    ok(probe.present === false && probe.version === null, 'core 0.34.0\'s unconditional supports_v4 alone reads ABSENT (bare extension.manager key is not presence)')
    ok(/does not advertise ComfyUI-Manager/.test(probe.reason), `the absent verdict carries the reason (got: ${probe.reason})`)

    const { routes: routes2, funnel: funnel2 } = makeFunnel()
    routes2.set('/features', async () => ({ extension: { manager: { supports_v4: true, supports_csrf_post: true } } }))
    routes2.set('/v2/manager/version', async () => '4.2.2\n')
    const present = await createManagerClient(funnel2).probe('http://engine.local')
    ok(present.present === true && present.version === '4.2.2', 'the Manager-added supports_csrf_post key reads PRESENT with the version string')

    const unreachable = await createManagerClient(async () => { throw new Error('connect ECONNREFUSED') }).probe('http://engine.local')
    ok(unreachable.present === false && /could not be asked/.test(unreachable.reason), 'an unreachable engine is absent WITH the reason (never a bare false)')
  }

  console.log('manager: QueueTaskItem payload derivation for the two gap-row packs (PR #45)')
  {
    const motion = findNodePack('h3-motion-context')
    const lbh = findNodePack('lbh-latent-upscaler')
    ok(motion && lbh, 'both gap-row packs resolve from the registry')
    ok(managerPackId(motion) === 'NikoDemon80/ComfyUI-H3-Motion-Context', `h3-motion-context maps to the GitHub owner/repo id (got ${managerPackId(motion)})`)
    ok(managerPackId(lbh) === 'LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler', `lbh-latent-upscaler maps to the GitHub owner/repo id (got ${managerPackId(lbh)})`)
    const params = managerInstallParams(motion)
    ok(params.id === 'NikoDemon80/ComfyUI-H3-Motion-Context' && params.selected_version === 'nightly' && params.version === 'nightly', 'install params install at nightly (the only git expressible version — the sha pin is not)')
    ok(params.repository === motion.repoUrl, 'nightly carries the repository URL (required)')
    ok(params.mode === 'cache' && params.channel === 'default', 'mode/channel match the Manager UI defaults')
    assert.deepEqual(managerUninstallParams(lbh), { node_name: 'Comfyui_Minimax_h3_latent_Upscaler', is_unknown: false }, 'uninstall params carry node_name + is_unknown')
    // Non-GitHub identities are honestly non-installable.
    ok(managerPackId({ ...motion, repoUrl: 'https://example.com/x' }) === null, 'a non-GitHub repoUrl has no Manager identity — null, never a guess')
    ok(managerInstallParams({ ...motion, repoUrl: 'https://example.com/x' }) === null, 'install params refuse to derive for a non-GitHub identity')
  }

  console.log('manager: history verdict parsing + the bounded poll')
  {
    // historyFor through a REAL client over a scripted funnel: the first
    // ask answers nothing (running), the second the terminal item.
    let asks = 0
    const funnel = async (url, routePath) => {
      if (routePath.startsWith('/v2/manager/queue/history')) {
        asks += 1
        if (asks === 1) return [] // queued, nothing recorded yet → running
        return [{ ui_id: 'ui-1', client_id: 'c-1', kind: 'install', timestamp: '2026-09-21T00:00:00Z', result: 'done', status: { status_str: 'success', completed: true, messages: ['Install done'] } }]
      }
      throw new Error(`unexpected route ${routePath}`)
    }
    const client = createManagerClient(funnel)
    const sleeps = []
    const verdict = await waitForManagerTask(client, 'http://engine.local', { uiId: 'ui-1', clientId: 'c-1' }, { pollMs: 1, timeoutMs: 5_000, sleep: async (ms) => { sleeps.push(ms) } })
    ok(verdict.state === 'success' && verdict.messages.join('') === 'Install done' && verdict.result === 'done', `the poll resolves the terminal verdict (got ${JSON.stringify(verdict)})`)
    ok(sleeps.length >= 1, 'the poll waited between asks')

    const neverTerminal = { historyFor: async () => ({ state: 'running', messages: [], result: null }) }
    const still = await waitForManagerTask(neverTerminal, 'http://engine.local', { uiId: 'ui-2', clientId: 'c-1' }, { pollMs: 1, timeoutMs: 5 })
    ok(still.state === 'running', 'a still-running task after the budget answers running — honest, not failed')
  }

  console.log('manager: the WS event normalizer (capture §1 shapes)')
  {
    const drained = normalizeManagerEvent({ type: 'cm-queue-status', data: { status: 'all-done' } })
    ok(drained && drained.systemType === 'cm-queue' && drained.payload.phase === 'queue-status' && drained.payload.status === 'all-done', 'cm-queue-status {status:"all-done"} normalizes to a queue-status envelope')

    const completed = normalizeManagerEvent({ type: 'cm-task-completed', data: { ui_id: 'ui-9', kind: 'install', status: { status_str: 'success', completed: true, messages: ['ok'] } } })
    ok(completed && completed.payload.phase === 'completed' && completed.payload.ui_id === 'ui-9' && completed.payload.status_str === 'success' && completed.payload.messages.join() === 'ok', 'cm-task-completed carries ui_id + the TaskExecutionStatus verdict')

    const started = normalizeManagerEvent({ type: 'cm-task-started', data: { ui_id: 'ui-9', kind: 'install' } })
    ok(started && started.payload.phase === 'started' && started.payload.ui_id === 'ui-9', 'cm-task-started carries the task identity')

    const prompt = normalizeManagerEvent({ type: 'cm-api-try-install-customnode', data: { id: 'evil-pack' } })
    ok(prompt && prompt.remoteInstallPrompt === true && prompt.detail === 'evil-pack', 'a remote install prompt is marked for LOG-ONLY — never an install affordance')

    ok(normalizeManagerEvent({ type: 'progress', data: { value: 1, max: 2 } }) === null, 'job-channel events stay out of the Manager normalizer')
    ok(normalizeManagerEvent('junk') === null && normalizeManagerEvent(null) === null, 'non-object frames normalize to nothing')
  }
})

// ---------------------------------------------------------------------------
// The fake engine (Manager arms): the verified 4.2.2 surface
// ---------------------------------------------------------------------------

/** A fake ComfyUI with an ACTIVE Manager: /features carries the
 *  supports_csrf_post flag, the queue/task route CAPTURES QueueTaskItems
 *  (scriptable history verdicts), /v2/customnode/installed answers, and a
 *  real /ws WebSocket lets the suite speak the cm-* event flow. */
function makeFakeEngine({ managerFlag }) {
  const state = {
    queuedTasks: [],
    historyScript: () => ({ status_str: 'success', completed: true, messages: ['Install done'] }),
    upstreamSocket: null,
    clientIdSeen: null,
  }
  const requestListener = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://engine.local')
    const json = (value, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (url.pathname === '/features') {
      // The core /features envelope: extension.manager carries the flags.
      const features = managerFlag
        ? { extension: { manager: { supports_v4: true, supports_csrf_post: true } } }
        : { extension: { manager: { supports_v4: true } } }
      return json(features)
    }
    if (url.pathname === '/v2/manager/version') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(managerFlag ? '4.2.2' : 'not here')
      return
    }
    if (url.pathname === '/v2/manager/queue/task' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => { body += String(chunk) })
      req.on('end', () => {
        state.queuedTasks.push({ body, contentType: req.headers['content-type'] ?? '' })
        // The verified answer: a bare 200 with an EMPTY body.
        res.writeHead(200)
        res.end()
      })
      return
    }
    if (url.pathname === '/v2/manager/queue/history') {
      const items = state.queuedTasks.map((task, index) => {
        const parsed = JSON.parse(task.body)
        const verdict = state.historyScript(index, parsed)
        if (!verdict) return null
        return { ui_id: parsed.ui_id, client_id: parsed.client_id, kind: parsed.kind, timestamp: '2026-09-21T00:00:00Z', result: 'done', status: verdict }
      }).filter(Boolean)
      return json(items)
    }
    if (url.pathname === '/v2/customnode/installed') {
      return json(['ComfyUI-H3-Motion-Context'])
    }
    if (url.pathname === '/system_stats') {
      return json({ system: { comfyui_version: 'v0.34.0' }, devices: [] })
    }
    const targeted = /^\/object_info\/(.+)$/.exec(url.pathname)
    if (url.pathname === '/object_info' || targeted) {
      return json({})
    }
    if (url.pathname === '/models' || url.pathname.startsWith('/models/')) {
      return json([])
    }
    res.writeHead(404)
    res.end()
  }
  const server = http.createServer(requestListener)
  // The engine's own WS endpoint: accepts the hub's upstream connection
  // (recording the clientId it registers) and lets the test push cm-* frames.
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://engine.local')
    if (url.pathname !== '/ws') { socket.destroy(); return }
    wss.handleUpgrade(request, socket, head, (ws) => {
      state.clientIdSeen = url.searchParams.get('clientId')
      state.upstreamSocket = ws
    })
  })
  return { server, state }
}

async function bootStudio(home) {
  const serverPort = await freePort()
  const child = spawn(process.execPath, [path.join(REPO, 'dist-server', 'server', 'index.js')], {
    cwd: REPO,
    env: { ...process.env, MINIMAX_STUDIO_HOME: home, MINIMAX_LAN_PORT: String(serverPort), MINIMAX_NO_HTTPS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk) })
  const base = `http://127.0.0.1:${serverPort}`
  const api = async (route, init) => {
    const response = await fetch(`${base}${route}`, init)
    return { status: response.status, body: await response.json().catch(() => ({})) }
  }
  try {
    await waitUntil(async () => {
      try { return (await fetch(`${base}/api/lan/settings`)).ok } catch { return false }
    }, 15_000, 'server boot')
  } catch {
    throw new Error(`studio server never booted:\n${output.slice(-2_000)}`)
  }
  return { child, base, api, output }
}

async function pointAtEngine(api, enginePort, home, externalDir) {
  const current = (await api('/api/lan/settings')).body.settings
  const saved = await api('/api/lan/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: {
      ...current,
      comfyUrl: `http://127.0.0.1:${enginePort}`,
      engine: { ...current.engine, mode: 'external', externalCustomNodesDir: externalDir },
    } }),
  })
  assert.ok(saved.status === 200, `settings applied (${saved.status}: ${JSON.stringify(saved.body).slice(0, 200)})`)
}

async function stopStudio(child, base) {
  if (base) await fetch(`${base}/api/lan/engine/stop`, { method: 'POST' }).catch(() => undefined)
  if (child) {
    child.kill('SIGINT')
    await waitUntil(() => child.exitCode !== null, 5_000, 'server exit').catch(() => child.kill('SIGKILL'))
  }
}

// ---------------------------------------------------------------------------
// (b) routes, Manager PRESENT
// ---------------------------------------------------------------------------

maybe('(b) Manager-present arm: Manager-first install/uninstall through the real server + fake engine', async () => {
  const home = makeHome()
  const engine = makeFakeEngine({ managerFlag: true })
  const enginePort = await freePort()
  await new Promise((resolve) => engine.server.listen(enginePort, '127.0.0.1', resolve))
  const externalDir = path.join(home, 'custom-nodes')
  fs.mkdirSync(externalDir, { recursive: true })
  const studio = await bootStudio(home)

  try {
    await pointAtEngine(studio.api, enginePort, home, externalDir)

    console.log('manager-present: the nodes list states presence honestly')
    {
      const listed = await studio.api('/api/lan/engine/nodes')
      ok(listed.status === 200, 'the nodes route answers')
      ok(listed.body.manager.present === true && listed.body.manager.version === '4.2.2', `the board verdict says Manager 4.2.2 present (got ${JSON.stringify(listed.body.manager)})`)
      ok(Array.isArray(listed.body.manager.installedPacks) && listed.body.manager.installedPacks.includes('ComfyUI-H3-Motion-Context'), 'the Manager\'s own installed list rides along (verify cross-check)')
      const motion = listed.body.packs.find((pack) => pack.id === 'h3-motion-context')
      const vendored = listed.body.packs.find((pack) => pack.id === 'vdn-h3')
      ok(motion.managerInstallable === true, 'h3-motion-context (gap row, user-fetch + network entry + GitHub) is manager-installable')
      ok(vendored.managerInstallable !== true, 'the vendored pack stays studio-managed (Manager is not its installer)')
      ok(motion.fetchConsented === false || motion.fetchConsented === true, 'the consent verdict decorates the row')
    }

    console.log('manager-present: install refuses without the fetch consent (the license gate)')
    {
      const refused = await studio.api('/api/lan/engine/nodes/install', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'h3-motion-context' }),
      })
      ok(refused.status === 403 && /consent/i.test(refused.body.error), `a Manager install without consent is refused with the library pointer (got ${refused.status}: ${String(refused.body.error).slice(0, 120)})`)
      ok(engine.state.queuedTasks.length === 0, 'nothing was queued behind the refusal')
    }

    console.log('manager-present: consented install queues the verified QueueTaskItem')
    {
      const current = (await studio.api('/api/lan/settings')).body.settings
      await studio.api('/api/lan/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings: { ...current, fetch: { consents: { 'pack:h3-motion-context': { consented: true, licenseSpdx: 'GPL-3.0-only', at: Date.now() } } } } }),
      })
      const installed = await studio.api('/api/lan/engine/nodes/install', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'h3-motion-context' }),
      })
      ok(installed.status === 200, `the consented Manager install answers 200 (got ${installed.status}: ${JSON.stringify(installed.body).slice(0, 200)})`)
      ok(installed.body.via === 'manager', `the answer names the serving path via=manager (got ${installed.body.via})`)
      ok(/ComfyUI-Manager/.test((installed.body.notes ?? []).join(' ')), 'the notes name ComfyUI-Manager')
      ok(/HEAD/.test((installed.body.notes ?? []).join(' ')), 'the notes state the HEAD-not-pin caveat')

      ok(engine.state.queuedTasks.length === 1, `exactly one task was queued (got ${engine.state.queuedTasks.length})`)
      const task = JSON.parse(engine.state.queuedTasks[0].body)
      ok(typeof task.ui_id === 'string' && task.ui_id.length > 10, 'the QueueTaskItem carries a minted ui_id')
      ok(typeof task.client_id === 'string' && /^[0-9a-f-]{36}$/i.test(task.client_id), `client_id is the engine-bridge hub id — a UUID the WS session owns (got ${task.client_id})`)
      ok(task.kind === 'install', 'kind is install')
      const params = task.params
      ok(params.id === 'NikoDemon80/ComfyUI-H3-Motion-Context', `params.id is the GitHub owner/repo identity (got ${params.id})`)
      ok(params.selected_version === 'nightly' && params.repository, 'nightly + repository (the only pin-honorable-adjacent form at 4.2.2)')
      ok(params.mode === 'cache' && params.channel === 'default', 'mode/cache + channel/default per the Manager UI defaults')
      ok(engine.state.queuedTasks[0].contentType === 'application/json', `the CSRF-honoring content type (got ${engine.state.queuedTasks[0].contentType})`)
    }

    console.log('manager-present: a Manager task FAILURE is never silently fallen back from')
    {
      engine.state.historyScript = () => ({ status_str: 'failed', completed: true, messages: ['pip resolve failed'] })
      const failed = await studio.api('/api/lan/engine/nodes/install', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'lbh-latent-upscaler' }),
      })
      // No consent recorded for lbh — set it first so the failure under test is the TASK failure.
      ok(failed.status === 403, 'the consent gate fires first (lbh row not yet consented)')
      const current = (await studio.api('/api/lan/settings')).body.settings
      await studio.api('/api/lan/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings: { ...current, fetch: { consents: { ...current.fetch.consents, 'pack:lbh-latent-upscaler': { consented: true, licenseSpdx: 'MIT', at: Date.now() } } } } }),
      })
      const failedTask = await studio.api('/api/lan/engine/nodes/install', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'lbh-latent-upscaler' }),
      })
      ok(failedTask.status === 400 && /pip resolve failed/.test(failedTask.body.error), `the Manager's own failure messages surface (got ${failedTask.status}: ${String(failedTask.body.error).slice(0, 160)})`)
      ok(/NOT used/.test(failedTask.body.error) || /retry/i.test(failedTask.body.error), 'the refusal names the deliberate alternative — never a silent studio fallback')
    }

    console.log('manager-present: uninstall of a FOREIGN folder asks the Manager, never deletes')
    {
      engine.state.historyScript = () => ({ status_str: 'success', completed: true, messages: ['Uninstalled'] })
      const foreignDir = path.join(externalDir, 'ComfyUI-H3-Motion-Context')
      fs.mkdirSync(foreignDir, { recursive: true })
      fs.writeFileSync(path.join(foreignDir, '__init__.py'), '# placed outside the studio\n')
      const before = engine.state.queuedTasks.length
      const uninstalled = await studio.api('/api/lan/engine/nodes/uninstall', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'h3-motion-context' }),
      })
      ok(uninstalled.status === 200 && uninstalled.body.via === 'manager', `the foreign-folder uninstall goes through the Manager (got ${uninstalled.status} via ${uninstalled.body.via})`)
      ok(fs.existsSync(foreignDir), 'the studio did NOT delete the foreign folder itself — the Manager owns the removal')
      const task = JSON.parse(engine.state.queuedTasks[before].body)
      ok(task.kind === 'uninstall' && task.params.node_name === 'ComfyUI-H3-Motion-Context' && task.params.is_unknown === false, `uninstall params match UninstallPackParams (got ${JSON.stringify(task.params)})`)
    }

    console.log('manager-present: the WS cm-queue flow reaches a system-channel subscriber')
    {
      // Open a client WS, subscribe system + job (job keeps upstream interest
      // in the pre-0pktw5h world; system alone now also qualifies).
      const socket = new WebSocket(`ws://127.0.0.1:${new URL(studio.base).port}/ws`)
      const received = []
      await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
      socket.send(JSON.stringify({ type: 'sub', ch: 'system' }))
      socket.send(JSON.stringify({ type: 'sub', ch: 'job' }))
      socket.on('message', (data, isBinary) => {
        if (isBinary) return
        try { received.push(JSON.parse(String(data))) } catch { /* ignore */ }
      })
      // The hub's upstream must connect to the fake engine's /ws with its
      // stable clientId — the SAME id the queue tasks carried.
      await waitUntil(() => engine.state.upstreamSocket !== null, 10_000, 'hub upstream connection')
      ok(engine.state.clientIdSeen === JSON.parse(engine.state.queuedTasks[0].body).client_id, 'the WS session the Manager targets is the hub\'s stable clientId (event routing works by construction)')
      engine.state.upstreamSocket.send(JSON.stringify({ type: 'cm-queue-status', data: { status: 'all-done' } }))
      engine.state.upstreamSocket.send(JSON.stringify({ type: 'cm-task-completed', data: { ui_id: 'ui-x', kind: 'install', status: { status_str: 'success', completed: true, messages: [] } } }))
      await waitUntil(() => received.some((envelope) => envelope.type === 'cm-queue'), 10_000, 'cm-queue envelope on the system channel')
      const queueStatus = received.find((envelope) => envelope.type === 'cm-queue' && envelope.payload.phase === 'queue-status')
      const completed = received.find((envelope) => envelope.type === 'cm-queue' && envelope.payload.phase === 'completed')
      ok(queueStatus && queueStatus.payload.status === 'all-done', 'cm-queue-status {status:"all-done"} arrives as a system envelope')
      ok(completed && completed.payload.ui_id === 'ui-x' && completed.payload.status_str === 'success', 'cm-task-completed arrives with the task verdict')
      socket.close()
    }
  } finally {
    await stopStudio(studio.child, studio.base)
    engine.state.upstreamSocket?.close()
    engine.server.close()
    engine.server.closeAllConnections?.()
  }
})

// ---------------------------------------------------------------------------
// (c) routes, Manager ABSENT — the settling test
// ---------------------------------------------------------------------------

maybe('(c) Manager-absent arm: honest fallback with the reason shown, never silent', async () => {
  const home = makeHome()

  console.log('manager-absent: engine up, no Manager flag — the studio path serves with the reason named')
  {
    const engine = makeFakeEngine({ managerFlag: false })
    const enginePort = await freePort()
    await new Promise((resolve) => engine.server.listen(enginePort, '127.0.0.1', resolve))
    const externalDir = path.join(home, 'custom-nodes-absent')
    fs.mkdirSync(externalDir, { recursive: true })
    const localCopy = path.join(home, 'motion-copy')
    fs.mkdirSync(localCopy, { recursive: true })
    fs.writeFileSync(path.join(localCopy, '__init__.py'), '# h3-motion-context\n')
    const studio = await bootStudio(home)
    try {
      await pointAtEngine(studio.api, enginePort, home, externalDir)
      const listed = await studio.api('/api/lan/engine/nodes')
      ok(listed.body.manager.present === false, 'the probe reads absent when only supports_v4 is served')
      ok(/does not advertise ComfyUI-Manager/.test(listed.body.manager.reason), `the absent reason is specific (got: ${listed.body.manager.reason})`)
      const motion = listed.body.packs.find((pack) => pack.id === 'h3-motion-context')
      ok(motion.managerInstallable !== true, 'the row is NOT manager-installable when the probe is absent')

      // Consent recorded (the fetch consent exists), Manager absent → the
      // studio path installs from the local copy, and the notes SAY why
      // Manager did not serve it.
      const current = (await studio.api('/api/lan/settings')).body.settings
      await studio.api('/api/lan/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings: { ...current, fetch: { consents: { 'pack:h3-motion-context': { consented: true, licenseSpdx: 'GPL-3.0-only', at: Date.now() } } } } }),
      })
      const installed = await studio.api('/api/lan/engine/nodes/install', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'h3-motion-context', sourceDirectory: localCopy }),
      })
      ok(installed.status === 200, `the studio fallback install succeeds (got ${installed.status}: ${JSON.stringify(installed.body).slice(0, 200)})`)
      ok(installed.body.via === 'studio', `the answer names the serving path via=studio (got ${installed.body.via})`)
      const noteText = (installed.body.notes ?? []).join(' ')
      ok(/studio path/.test(noteText) && /does not advertise ComfyUI-Manager/.test(noteText), `the notes state the Manager-absent reason (got: ${noteText.slice(0, 220)})`)
      ok(engine.state.queuedTasks.length === 0, 'the absent Manager was never asked to queue anything')
      ok(fs.existsSync(path.join(externalDir, 'ComfyUI-H3-Motion-Context', '__init__.py')), 'the studio path placed the pack in the external folder')

      // Uninstall of the marker install the studio just made is the studio's own.
      const uninstalled = await studio.api('/api/lan/engine/nodes/uninstall', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'h3-motion-context' }),
      })
      ok(uninstalled.status === 200 && uninstalled.body.via === 'studio', 'a studio marker uninstall stays studio-served when Manager is absent')

      // A FOREIGN folder with Manager absent keeps the honest refusal.
      const foreignDir = path.join(externalDir, 'Comfyui_Minimax_h3_latent_Upscaler')
      fs.mkdirSync(foreignDir, { recursive: true })
      const refused = await studio.api('/api/lan/engine/nodes/uninstall', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'lbh-latent-upscaler' }),
      })
      ok(refused.status === 404 && /not installed by the studio/.test(refused.body.error), 'a foreign folder without Manager keeps the never-delete refusal')
      ok(/ComfyUI-Manager is not available/.test(refused.body.error), `the refusal names the Manager-absent context (got: ${String(refused.body.error).slice(0, 200)})`)
    } finally {
      await stopStudio(studio.child, studio.base)
      engine.state.upstreamSocket?.close()
      engine.server.close()
      engine.server.closeAllConnections?.()
    }
  }

  console.log('manager-absent: engine DOWN — the probe degrades, the board still answers')
  {
    const studio = await bootStudio(home)
    try {
      const deadPort = await freePort()
      const current = (await studio.api('/api/lan/settings')).body.settings
      await studio.api('/api/lan/settings', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings: { ...current, comfyUrl: `http://127.0.0.1:${deadPort}` } }),
      })
      const listed = await studio.api('/api/lan/engine/nodes')
      ok(listed.status === 200, 'the nodes route still answers with the engine down')
      ok(listed.body.manager.present === false && /could not be asked/.test(listed.body.manager.reason), `an unreachable engine reads absent with the reason (got: ${listed.body.manager.reason.slice(0, 120)})`)
      const install = await studio.api('/api/lan/engine/nodes/install', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'h3-motion-context' }),
      })
      ok(install.status === 400, `with no engine and no target the install refuses (got ${install.status})`)
    } finally {
      await stopStudio(studio.child, studio.base)
    }
  }
})

test('suite accounting', () => {
  console.log(`manager-install: ${passed} assertions passed`)
})
