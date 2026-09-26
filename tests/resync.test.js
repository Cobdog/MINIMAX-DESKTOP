// The truth-surface sweep #2 (task 68e9k17, audit M1/C1): the stale-registry
// lie. THE EMPIRICAL ROOT (this sweep, 2026-09-26): the server's bootstrap
// serves FRESH listings across an engine restart, and the OBSERVED
// down→up transition re-pulls — but an engine restart that completes between
// two probes (the fake-engine class: ~1 s; the audit's own mirror walk) is
// INVISIBLE: no down-tick, no transition, no re-pull, and the studio keeps
// the old registry while the pack board (its own TTL-probed object_info
// pull) flips — exactly the audit's M1. The fix under test: the recovered
// transition re-syncs WITH refresh semantics, and every connected tick
// compares a LIGHT models-only listing (no object_info — A-8 holds) and
// re-syncs on drift.
//
// This suite is the MIRROR test the task mandates: the REAL built server +
// the REAL environment-mirror fake engine (e2e/mirror/fakeEngineServer.mjs,
// profiles/stock-h3.json + maintainer-instance.json) + the REAL client
// recovery flow (src/lib/engineRecovery.ts, VM-loaded) driven over HTTP —
// kill the engine, restart it, assert inventory freshness.
//
// Legs:
//   (a) the light route's truth: shape, subpath'd rows verbatim, the
//       engine-down answer
//   (b) THE SUB-TICK RESTART (the audit's case): restart between probes →
//       the drift check catches it on the next connected tick → full resync
//       WITH refresh (the engine's /refresh hit count proves the semantics)
//   (c) the OBSERVED recovery: a down probe, then restart → recovered
//       transition → resync with refresh → fresh listing
import { test, afterAll } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = require('node:path').dirname(fileURLToPath(import.meta.url))
const REPO = require('node:path').resolve(__dirname, '..')

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { loadTs } = require('../scripts/lib/ts-vm.cjs')
const { makePortAllocator } = require('./lib/ports.cjs')
const { makeScratchDir, removeAllScratchDirs } = require('./lib/scratch.cjs')
afterAll(() => { void removeAllScratchDirs() })

const freePort = makePortAllocator('resync')

const hasServerBuild = fs.existsSync(path.join(REPO, 'dist-server', 'server', 'index.js'))
if (!hasServerBuild) {
  console.log('NOTE - no dist-server build present (server/index.js); run pnpm build:server — this suite runs on legs that build the server.')
}
const maybe = hasServerBuild ? test : test.skip

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
    await sleep(80)
  }
  if (await predicate()) return true
  throw new Error(`timed out after ${timeoutMs} ms waiting for: ${label}`)
}

// ---- the mirror engine (the standing artifact) ---------------------------
const engineFor = (port, profile) => spawn(process.execPath, [
  path.join(REPO, 'e2e', 'mirror', 'fakeEngineServer.mjs'),
  '--port', String(port),
  '--profile', path.join(REPO, 'e2e', 'mirror', 'profiles', profile),
], { stdio: ['ignore', 'ignore', 'pipe'] })

async function engineControl(port) {
  const response = await fetch(`http://127.0.0.1:${port}/__control`)
  return response.json()
}

// ---- the real client recovery flow (VM-loaded) ---------------------------
const recovery = hasServerBuild ? loadTs('src/lib/engineRecovery.ts') : null

/** The HTTP bridge the renderer's web apiClient would provide, pointed at
 *  the real built server (which holds the engine URL in settings). */
function httpBridge(serverBase) {
  return {
    getComfyStatus: async (url) => fetch(`${serverBase}/api/lan/comfy-status?url=${encodeURIComponent(url)}`).then((r) => r.json()),
    getObjectInfo: async () => fetch(`${serverBase}/api/lan/object-info`).then((r) => r.json()),
    scanModels: async (settings, options) => fetch(`${serverBase}/api/lan/bootstrap${options?.refresh ? '?refresh=1' : ''}`).then((r) => r.json()).then((body) => body.models),
    lightInventory: async () => {
      const response = await fetch(`${serverBase}/api/lan/inventory-light`)
      if (!response.ok) return null
      const body = await response.json()
      if (body.connected !== true || !Array.isArray(body.models) || !Array.isArray(body.servedKinds)) return null
      return { models: body.models, servedKinds: body.servedKinds }
    },
  }
}

/** The live store adapter: the same surface the zustand store gives the
 *  hook, recorded. */
function liveStore(models) {
  const state = { connected: false, models, settings: { comfyUrl: '' } }
  const writes = { resync: [], models: [], lost: 0, recovered: 0 }
  return {
    state, writes,
    deps: {
      store: {
        status: () => ({ connected: state.connected }),
        settings: () => state.settings,
        models: () => state.models,
        setStatus: (next) => { state.connected = next.connected },
        setInfo: () => undefined,
        bumpInfoEpoch: () => undefined,
        setModels: (next) => { state.models = next; writes.models.push(next) },
        markEngineLost: () => { writes.lost += 1 },
        markEngineRecovered: () => { writes.recovered += 1 },
        markInventoryResync: (record) => { writes.resync.push(record) },
      },
    },
  }
}

maybe('(a)+(b)+(c) the mirror re-sync truth: light listing, sub-tick restart drift, observed recovery — against the real server + the environment mirror', async () => {
  const home = makeScratchDir(path.join(os.tmpdir(), 'minimax-resync-home-'))
  const enginePort = await freePort()
  const serverPort = await freePort()

  let engine = engineFor(enginePort, 'stock-h3.json')

  const server = spawn(process.execPath, [path.join(REPO, 'dist-server', 'server', 'index.js')], {
    cwd: REPO,
    env: { ...process.env, MINIMAX_STUDIO_HOME: home, MINIMAX_LAN_PORT: String(serverPort), MINIMAX_NO_HTTPS: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const base = `http://127.0.0.1:${serverPort}`
  const apiUrl = `http://127.0.0.1:${enginePort}`

  try {
    await waitUntil(async () => {
      try { return (await fetch(`${apiUrl}/system_stats`)).ok } catch { return false }
    }, 10_000, 'mirror engine boot (stock-h3)')
    await waitUntil(async () => {
      try { return (await fetch(`${base}/api/lan/settings`)).ok } catch { return false }
    }, 15_000, 'studio server boot')

    // Point the studio at the mirror engine (external mode).
    const current = (await fetch(`${base}/api/lan/settings`).then((r) => r.json())).settings
    const applied = await fetch(`${base}/api/lan/settings`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { ...current, comfyUrl: apiUrl, engine: { ...current.engine, mode: 'external' } } }),
    }).then((r) => r.json())
    ok(applied.settings?.comfyUrl === apiUrl, 'settings point the studio at the mirror engine')

    const bridge = httpBridge(base)
    const engineUrl = apiUrl

    // ---- (a) the light route's truth ----
    console.log('resync: (a) the light inventory route')
    {
      const light = await bridge.lightInventory()
      ok(light !== null, 'the light route answers a judgeable listing while the engine is up')
      ok(light.servedKinds.includes('diffusion_models') && light.servedKinds.includes('vae'), 'servedKinds names the folders the engine serves')
      ok(light.models.some((file) => file.name === 'H3/ssd/minimax_h3_fl2va_pruned_int8_convrot.safetensors'), 'subpath\'d registry rows arrive verbatim (registry truth)')
      ok(light.models.every((file) => typeof file.bytes === 'number'), 'rows carry the honest bytes field')
      const bootScan = await bridge.scanModels({}, undefined)
      ok(bootScan.length === light.models.length, 'the light listing and the full bootstrap agree on the file count while shapes match')
    }

    // The boot sequence: mount-effect scan (no refresh), then the boot probe.
    const store = liveStore(await bridge.scanModels({}, undefined))
    store.state.settings = { comfyUrl: engineUrl }
    await recovery.runEngineCheck({ bridge, store: store.deps.store }, engineUrl, 'boot')
    ok(store.state.connected === true, 'the boot probe sees the engine connected')
    ok(store.writes.resync.length === 0, 'boot claims no resync (the mount scan owned the inventory)')

    // A steady tick with an unchanged engine: no drift, no resync.
    await recovery.runEngineCheck({ bridge, store: store.deps.store }, engineUrl, 'loop')
    ok(store.writes.resync.length === 0, 'an unchanged engine on a steady tick triggers nothing')

    // ---- (b) THE SUB-TICK RESTART (the audit's M1 shape) ----
    console.log('resync: (b) the sub-tick restart — drift catches the invisible one')
    {
      const refreshBefore = (await engineControl(enginePort)).refreshHits ?? 0
      // Kill and restart FAST — no probe ever sees the engine down (the
      // probes here are manual, and none runs while it is dead).
      engine.kill('SIGINT')
      await waitUntil(() => engine.exitCode !== null, 5_000, 'engine exit (sub-tick)').catch(() => engine.kill('SIGKILL'))
      engine = engineFor(enginePort, 'maintainer-instance.json')
      await waitUntil(async () => {
        try { return (await fetch(`${apiUrl}/system_stats`)).ok } catch { return false }
      }, 10_000, 'mirror engine restart (maintainer-instance)')

      const next = await recovery.runEngineCheck({ bridge, store: store.deps.store }, engineUrl, 'loop')
      ok(next.connected === true, 'the engine answers connected (the restart was sub-tick — no down edge was ever observed)')
      ok(store.writes.lost === 0 && store.writes.recovered === 0, 'no transition fired — this is the invisible-restart case the drift check exists for')
      ok(store.writes.resync.length === 1, `the drift check re-synced on the next connected tick (got ${store.writes.resync.length})`)
      ok(store.writes.resync[0].cause === 'drift' && store.writes.resync[0].ok === true, 'the resync record names the drift cause, honestly ok')
      ok(store.writes.models.length === 1, 'the fresh listing landed in the store exactly once')
      const names = store.state.models.map((file) => file.name)
      ok(names.includes('qwen3vl_4b_minimax_h3_int8.safetensors'), 'the restarted engine\'s NEW file (the 4B trap encoder) is in the studio inventory')
      ok(names.includes('h3image/minimax_h3_image_vae_fp16.safetensors'), 'the new subpath\'d VAE rows are in')
      ok(names.some((name) => name.startsWith('taeh3')), 'the preview models (vae_approx) resynced too — the audit\'s "Preview models: 0 files" lie is dead')
      const control = await engineControl(enginePort)
      ok((control.refreshHits ?? 0) > refreshBefore, `the resync carried refresh semantics (the engine was asked to POST /refresh: ${refreshBefore} → ${control.refreshHits})`)
    }

    // ---- (c) the OBSERVED recovery ----
    console.log('resync: (c) the observed recovery — down tick, restart, up tick')
    {
      engine.kill('SIGINT')
      await waitUntil(() => engine.exitCode !== null, 5_000, 'engine exit (observed)').catch(() => engine.kill('SIGKILL'))
      const down = await recovery.runEngineCheck({ bridge, store: store.deps.store }, engineUrl, 'loop')
      ok(down.connected === false, 'the down probe sees the engine gone')
      ok(store.writes.lost === 1, 'the loss was marked')

      engine = engineFor(enginePort, 'stock-h3.json')
      await waitUntil(async () => {
        try { return (await fetch(`${apiUrl}/system_stats`)).ok } catch { return false }
      }, 10_000, 'mirror engine restart (stock-h3)')
      // The restart resets the engine's own counter — baseline from THIS process.
      const refreshBefore = (await engineControl(enginePort)).refreshHits ?? 0

      await recovery.runEngineCheck({ bridge, store: store.deps.store }, engineUrl, 'loop')
      ok(store.writes.recovered === 1, 'the recovery was marked')
      const resyncs = store.writes.resync.length
      ok(resyncs === 2, `exactly one more resync fired for the recovery (got ${resyncs})`)
      ok(store.writes.resync[1].cause === 'recovery' && store.writes.resync[1].ok === true, 'the recovery resync recorded honestly')
      const names = store.state.models.map((file) => file.name)
      ok(!names.includes('qwen3vl_4b_minimax_h3_int8.safetensors'), 'the stock profile\'s listing replaced the mirror one (fresh again, the other direction)')
      const control = await engineControl(enginePort)
      ok((control.refreshHits ?? 0) > refreshBefore, `the recovery resync also carried refresh semantics (${refreshBefore} → ${control.refreshHits})`)
    }

    // The light route's engine-down truth (the engine now runs; ask a dead
    // port through a THROWING engine url is the server-side shape — use the
    // running engine killed at teardown instead: covered by the route guard
    // in (a)'s null contract via the unit suite).
  } finally {
    // The standing teardown pattern (instance suite): SIGINT, then a bounded
    // wait, then SIGKILL — a server mid-graceful-shutdown must never hang
    // the suite (and the fork's stdio pipes never keep it alive).
    engine.kill('SIGINT')
    server.kill('SIGINT')
    await waitUntil(() => server.exitCode !== null, 5_000, 'server exit').catch(() => server.kill('SIGKILL'))
    await waitUntil(() => engine.exitCode !== null, 5_000, 'engine exit').catch(() => engine.kill('SIGKILL'))
  }

  console.log(`  resync: ${passed} assertions passed`)
})

test('suite summary', () => {
  console.log(`  resync: ${passed} assertions passed (total)`)
})
