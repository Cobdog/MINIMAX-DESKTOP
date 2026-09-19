// External-instance integration suite (task 9om4bi9). Every AC's
// failing-without-it proof lives here; NO real network and NO real engine —
// the route sections boot the real built server against a LOCAL fake engine
// speaking the verified contract (the /models response shape is ground-truth
// from the reference ComfyUI server.py: a JSON array of filename strings,
// 404 for an unknown folder). Sections:
//   (a) instance inventory parsing: object_info loader enums (combo and
//       options forms), /models endpoint list parsing, endpoint-vs-enums
//       preference, and the instance∪local merge with source tags
//   (b) external install target: mode-following target resolution, install
//       path construction, install from a local copy into the external
//       folder, foreign-folder refusal, folder/instance status fields
//   (c) live pack detection: object_info node classes → active/absent/
//       unknown verdicts
//   (d) app-relative io defaults through the real settings pipeline: unset
//       → <home>/data/{input,output}; absolute values survive (migration-
//       safe); relative values are refused at the write boundary
//   (e) routes against the real built server + fake engine: the merged
//       bootstrap inventory (instance/both/local), live pack chips, install
//       into the external folder, the restart-needed state, foreign refusal,
//       uninstall
// Run after `pnpm build` (modules load from dist-server; the server needs
// the web build present).
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')

const REPO = path.join(__dirname, '..')
const { instanceNamesForKind, inventoryFromObjectInfo, mergeModelInventories, parseModelsEndpointList } = require(path.join(REPO, 'dist-server', 'server', 'instanceInventory.js'))
const { ENGINE_NODE_PACKS, checkNodePack, installNodePack, nodePackInstanceState, nodePackInstallDir, resolveNodePackTarget, uninstallNodePack } = require(path.join(REPO, 'dist-server', 'server', 'engineNodes.js'))

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

// House port discipline: this suite's range is 6500–6599.
async function freePort() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = 6500 + Math.floor(Math.random() * 100)
    const busy = await new Promise((resolve) => {
      const probe = net.connect({ port: candidate, host: '127.0.0.1' })
      probe.on('error', () => resolve(false)) // connection refused — free
      probe.on('connect', () => { probe.destroy(); resolve(true) })
    })
    if (!busy) return candidate
  }
  throw new Error('no free port found in 50 attempts')
}

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-instance-home-'))
}

async function main() {
  // ---- (a) instance inventory parsing ---------------------------------------
  console.log('instance: object_info loader enums')
  {
    const info = {
      UNETLoader: { input: { required: { unet_name: [['fl2va.safetensors', 'sub/ref2va.safetensors'], {}] } } },
      // The options form: [ default, { options: [...] } ]
      CLIPLoader: { input: { required: { clip_name: ['unused.safetensors', { options: ['qwen3vl.safetensors', 'gemma.safetensors'] }] } } },
      VAELoader: { input: { required: { vae_name: [['video_vae.safetensors'], {}] } } },
      LoraLoader: { input: { required: { lora_name: [['turbo.safetensors'], {}] } } },
      CLIPVisionLoader: { input: { required: { clip_name: [['vision.safetensors'], {}] } } },
    }
    const inventory = inventoryFromObjectInfo(info)
    ok(inventory.diffusion_models.join('|') === 'fl2va.safetensors|sub/ref2va.safetensors', 'UNETLoader.unet_name combo list lands as diffusion_models (subpaths kept)')
    ok(inventory.text_encoders.join('|') === 'qwen3vl.safetensors|gemma.safetensors', 'CLIPLoader options-form list lands as text_encoders')
    ok(inventory.vae.join('|') === 'video_vae.safetensors' && inventory.loras.join('|') === 'turbo.safetensors' && inventory.clip_vision.join('|') === 'vision.safetensors', 'VAE/LoRA/CLIP-vision enums map to their kinds')
    ok(Array.isArray(inventory.vae_approx) && inventory.vae_approx.length === 0, 'vae_approx has no loader probe — /models endpoint only')
    ok(inventoryFromObjectInfo(null).diffusion_models.length === 0, 'a null payload degrades to empty inventories, never a throw')
    ok(inventoryFromObjectInfo({ UNETLoader: { input: { required: { unet_name: ['one.safetensors', {}] } } } }).diffusion_models.length === 0, 'a non-combo enum value contributes nothing')
  }

  console.log('instance: /models endpoint parsing + preference')
  {
    ok(parseModelsEndpointList(['a.safetensors', 'sub/b.safetensors']).join('|') === 'a.safetensors|sub/b.safetensors', 'a JSON string array parses')
    ok(parseModelsEndpointList({ error: 'not found' }) === null, 'an error object is not a listing (null — fallback stays in play)')
    ok(Array.isArray(parseModelsEndpointList([])) && parseModelsEndpointList([]).length === 0, 'an empty array is a valid (empty) listing')
    ok(instanceNamesForKind('diffusion_models', ['ep.safetensors'], ['oi.safetensors']).join('|') === 'ep.safetensors', 'a non-empty endpoint list wins over object_info')
    ok(instanceNamesForKind('loras', null, ['oi.safetensors']).join('|') === 'oi.safetensors', 'no endpoint → object_info fallback')
    ok(instanceNamesForKind('text_encoders', [], ['oi.safetensors']).join('|') === 'oi.safetensors', 'an EMPTY endpoint answer never masks a non-empty object_info fallback')
    ok(instanceNamesForKind('vae_approx', [], []).length === 0, 'both empty → empty')
  }

  console.log('instance: instance ∪ local merge with source tags')
  {
    const local = [
      { name: 'shared.safetensors', kind: 'diffusion_models', bytes: 1234, h3Form: 'curve', path: '/models/diffusion_models/shared.safetensors' },
      { name: 'local-only.safetensors', kind: 'vae', bytes: 99, path: '/models/vae/local-only.safetensors' },
      { name: 'shared.safetensors', kind: 'vae', bytes: 7, path: '/models/vae/shared.safetensors' },
    ]
    const merged = mergeModelInventories(local, {
      diffusion_models: ['shared.safetensors', 'instance-only.gguf'],
      vae: [],
      text_encoders: [],
      loras: [],
      vae_approx: [],
      clip_vision: [],
    })
    const byKey = new Map(merged.map((file) => [`${file.kind}/${file.name}`, file]))
    ok(byKey.get('diffusion_models/shared.safetensors')?.source === 'both', 'a file visible from both sides collapses to one row tagged both')
    ok(byKey.get('diffusion_models/shared.safetensors')?.bytes === 1234 && byKey.get('diffusion_models/shared.safetensors')?.h3Form === 'curve', 'the both row keeps the local scan\'s bytes + h3Form')
    ok(byKey.get('diffusion_models/instance-only.gguf')?.source === 'instance' && byKey.get('diffusion_models/instance-only.gguf')?.bytes === 0, 'an instance-only row carries source instance and bytes 0 (the instance API reports no sizes)')
    ok(byKey.get('vae/local-only.safetensors')?.source === 'local', 'a local-only row keeps its local tag')
    ok(byKey.get('vae/shared.safetensors')?.source === 'local', 'the same name under a DIFFERENT kind never merges across kinds')
    ok(merged.length === 4, 'union cardinality is exact (no duplicates, no drops)')
    ok(mergeModelInventories([], { diffusion_models: ['only.safetensors'], text_encoders: [], vae: [], loras: [], vae_approx: [], clip_vision: [] }).length === 1, 'an instance alone fills the inventory — zero local roots required')
  }

  // ---- (b) external install target -------------------------------------------
  console.log('instance: external custom-nodes target resolution + installs')
  {
    const home = makeHome()
    const externalDir = path.join(home, 'custom_nodes')
    fs.mkdirSync(externalDir, { recursive: true })
    const checkout = path.join(home, 'ComfyUI')
    fs.mkdirSync(path.join(checkout, 'custom_nodes'), { recursive: true })
    fs.writeFileSync(path.join(checkout, 'main.py'), '# comfy\n')

    const managed = resolveNodePackTarget({ mode: 'managed', checkoutPath: checkout, externalCustomNodesDir: externalDir })
    ok(managed.targetKind === 'checkout' && managed.target.checkout === checkout, 'managed mode targets the checkout even when an external dir is also set (mode wins)')
    ok(resolveNodePackTarget({ mode: 'managed', checkoutPath: '', externalCustomNodesDir: externalDir }).target === null, 'managed mode without a usable checkout has no target')
    const external = resolveNodePackTarget({ mode: 'external', checkoutPath: checkout, externalCustomNodesDir: externalDir })
    ok(external.targetKind === 'external' && external.target.customNodesDir === externalDir, 'external mode targets the configured custom nodes folder (a stale checkout never wins)')
    const legacy = resolveNodePackTarget({ mode: 'external', checkoutPath: checkout, externalCustomNodesDir: '' })
    ok(legacy.targetKind === 'checkout', 'external mode WITHOUT the folder falls back to a usable checkout (the legacy install flow is never silently dropped)')
    ok(resolveNodePackTarget({ mode: 'external', checkoutPath: '', externalCustomNodesDir: '' }).target === null, 'external mode with neither folder nor checkout has no target')
    ok(resolveNodePackTarget({ mode: 'external', checkoutPath: '', externalCustomNodesDir: path.join(home, 'missing') }).target === null, 'a non-existent folder is not a usable target')

    const pack = ENGINE_NODE_PACKS.find((entry) => entry.id === 'krea2edit')
    ok(pack, 'the krea2edit registry row exists')
    const target = { kind: 'external', customNodesDir: externalDir }
    ok(nodePackInstallDir(pack, target) === path.join(externalDir, pack.name), 'the external install dir is <folder>/<pack name>')

    // Install from a local copy into the external folder.
    const sourceDir = path.join(home, 'local-copy')
    fs.mkdirSync(sourceDir, { recursive: true })
    fs.writeFileSync(path.join(sourceDir, '__init__.py'), '# krea2edit\n')
    fs.writeFileSync(path.join(sourceDir, 'nodes.py'), 'NODE_CLASS_MAPPINGS = {}\n')
    const installed = await installNodePack(pack, { target, sourceDirectory: sourceDir })
    ok(installed.installed === true, 'a local-copy install into the external folder succeeds')
    ok(fs.existsSync(path.join(externalDir, pack.name, '.studio-node.json')), 'the studio marker lands inside the external folder')
    const checked = await checkNodePack(pack, target, null, 'absent')
    ok(checked.installed === true && checked.targetKind === 'external' && checked.instanceState === 'absent', 'an installed pack whose instance does not serve the classes carries installed + absent (the restart-needed state)')

    // Foreign refusal: a pack folder that exists WITHOUT our marker.
    const foreignPack = ENGINE_NODE_PACKS.find((entry) => entry.id === 'radiance')
    fs.mkdirSync(path.join(externalDir, foreignPack.name), { recursive: true })
    fs.writeFileSync(path.join(externalDir, foreignPack.name, 'mine.py'), '# not ours\n')
    const refused = await installNodePack(foreignPack, { target, sourceDirectory: sourceDir })
    ok(refused.installed === false && /refusing to replace/i.test(refused.notes.join(' ')), 'a foreign folder in the external target is refused, never replaced')
    ok(fs.readFileSync(path.join(externalDir, foreignPack.name, 'mine.py'), 'utf8') === '# not ours\n', 'the foreign folder\'s bytes are untouched')
    const foreignStatus = await checkNodePack(foreignPack, target, null, 'unknown')
    ok(foreignStatus.folderState === 'foreign' && foreignStatus.installed === false, 'checkNodePack reports the foreign folder state')

    const removed = await uninstallNodePack(pack, target)
    ok(removed.removed === true && !fs.existsSync(path.join(externalDir, pack.name)), 'uninstall deletes exactly the pack folder in the external target')
  }

  // ---- (c) live pack detection ------------------------------------------------
  console.log('instance: live pack detection from object_info')
  {
    const hybrid = ENGINE_NODE_PACKS.find((entry) => entry.id === 'h3-hybrid-loader')
    const krea2edit = ENGINE_NODE_PACKS.find((entry) => entry.id === 'krea2edit')
    ok(nodePackInstanceState(hybrid, ['MiniMaxH3HybridLoader', 'KSamplerSelect']) === 'active', 'serving any registered class = active on the instance')
    ok(nodePackInstanceState(krea2edit, ['MiniMaxH3HybridLoader']) === 'absent', 'an answering instance without the classes = absent')
    ok(nodePackInstanceState(hybrid, null) === 'unknown', 'no object_info = unknown, never a false absent')
    ok(ENGINE_NODE_PACKS.every((entry) => Array.isArray(entry.instanceNodeClasses) && entry.instanceNodeClasses.length > 0), 'every registry row carries at least one detection class')
    ok(nodePackInstanceState({ ...hybrid, instanceNodeClasses: [] }, ['X']) === 'unknown', 'a row with no detection classes answers unknown instead of guessing')
  }

  // ---- (d) app-relative io defaults through the real settings pipeline ---------
  // ---- (e) routes against the real server + fake engine -----------------------
  if (!fs.existsSync(path.join(REPO, 'dist', 'index.html'))) {
    console.log('  NOTE - no web build present (dist/index.html); sections (d)/(e) run on legs that build the web app (ubuntu CI, pnpm gate)')
  } else {
    const home = makeHome()

    // The fake engine: serves /system_stats, a crafted /object_info (loader
    // enums + one pack's classes), and the /models routes — with vae_approx
    // 404 (older-instance shape) and text_encoders answering EMPTY so the
    // object_info fallback must still win.
    const objectInfo = {
      UNETLoader: { input: { required: { unet_name: [['shared.safetensors', 'instance-only.gguf'], {}] } } },
      CLIPLoader: { input: { required: { clip_name: ['x.safetensors', { options: ['instance-encoder.safetensors'] }] } } },
      VAELoader: { input: { required: { vae_name: [['instance-vae.safetensors'], {}] } } },
      LoraLoader: { input: { required: { lora_name: [['instance-lora.safetensors'], {}] } } },
      MiniMaxH3HybridLoader: { input: { required: { ckpt_name: [['shared.safetensors'], {}] } } },
      KSamplerSelect: { input: { required: {} } },
    }
    const enginePort = await freePort()
    const engine = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://engine.local')
      if (url.pathname === '/system_stats') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ system: { comfyui_version: 'v0.34.0' }, devices: [] }))
        return
      }
      if (url.pathname === '/object_info') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(objectInfo))
        return
      }
      if (url.pathname === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(['diffusion_models', 'text_encoders', 'vae', 'loras']))
        return
      }
      if (url.pathname === '/models/diffusion_models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(['shared.safetensors', 'instance-only.gguf']))
        return
      }
      if (url.pathname === '/models/text_encoders') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify([]))
        return
      }
      if (url.pathname === '/models/vae') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(['instance-vae.safetensors']))
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise((resolve) => engine.listen(enginePort, '127.0.0.1', resolve))

    // A local model root holding ONE file that the instance also lists.
    const modelRoot = path.join(home, 'models')
    fs.mkdirSync(path.join(modelRoot, 'diffusion_models'), { recursive: true })
    fs.writeFileSync(path.join(modelRoot, 'diffusion_models', 'shared.safetensors'), 'x')
    fs.mkdirSync(path.join(modelRoot, 'vae'), { recursive: true })
    fs.writeFileSync(path.join(modelRoot, 'vae', 'local-only.safetensors'), 'x')

    const externalDir = path.join(home, 'external-custom-nodes')
    fs.mkdirSync(externalDir, { recursive: true })
    const localCopy = path.join(home, 'krea2edit-copy')
    fs.mkdirSync(localCopy, { recursive: true })
    fs.writeFileSync(path.join(localCopy, '__init__.py'), '# krea2edit\n')

    const serverPort = await freePort()
    const child = spawn(process.execPath, ['dist-server/server/index.js'], {
      cwd: REPO,
      env: { ...process.env, MINIMAX_STUDIO_HOME: home, MINIMAX_LAN_PORT: String(serverPort), MINIMAX_NO_HTTPS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let serverOutput = ''
    child.stdout.on('data', (chunk) => { serverOutput += String(chunk) })
    child.stderr.on('data', (chunk) => { serverOutput += String(chunk) })
    const base = `http://127.0.0.1:${serverPort}`
    const api = async (route, init) => {
      const response = await fetch(`${base}${route}`, init)
      return { status: response.status, body: await response.json().catch(() => ({})) }
    }

    try {
      await waitUntil(async () => {
        try { return (await fetch(`${base}/api/lan/settings`)).ok } catch { return false }
      }, 15_000, 'server boot')

      console.log('instance: app-relative io defaults (unset vs set)')
      {
        const fresh = (await api('/api/lan/settings')).body.settings
        ok(fresh.outputDirectory === path.resolve(path.join(home, 'data', 'output')), `an unset outputDirectory defaults to <home>/data/output (got ${fresh.outputDirectory})`)
        ok(fresh.inputDirectory === path.resolve(path.join(home, 'data', 'input')), `an unset inputDirectory defaults to <home>/data/input (got ${fresh.inputDirectory})`)
        ok(!fresh.outputDirectory.includes('Documents') && !fresh.inputDirectory.includes('Documents'), 'neither default points into ~/Documents')

        // Migration safety: absolute values survive normalize + write.
        const keptOutput = path.join(home, 'my-output')
        const keptInput = path.join(home, 'my-input')
        fs.mkdirSync(keptOutput, { recursive: true })
        fs.mkdirSync(keptInput, { recursive: true })
        const saved = await api('/api/lan/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: { ...fresh, outputDirectory: keptOutput, inputDirectory: keptInput } }) })
        ok(saved.status === 200 && saved.body.settings.outputDirectory === keptOutput && saved.body.settings.inputDirectory === keptInput, 'absolute io directories round-trip untouched (migration-safe)')

        // Relative io dirs are refused at the write boundary.
        const relativeIo = await api('/api/lan/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: { ...fresh, inputDirectory: 'relative/input' } }) })
        ok(relativeIo.status === 400 && /inputDirectory must be an absolute path/.test(relativeIo.body.error), 'a relative inputDirectory is refused loudly')
        const relativeExternal = await api('/api/lan/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: { ...fresh, engine: { ...fresh.engine, externalCustomNodesDir: 'relative/nodes' } } }) })
        ok(relativeExternal.status === 400 && /externalCustomNodesDir must be an absolute path/.test(relativeExternal.body.error), 'a relative external custom-nodes folder is refused loudly')

        // Point the studio at the fake engine + the external folder + local roots.
        const current = (await api('/api/lan/settings')).body.settings
        const configured = await api('/api/lan/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: {
          ...current,
          comfyUrl: `http://127.0.0.1:${enginePort}`,
          modelRoot,
          paths: { ...current.paths, diffusion_models: path.join(modelRoot, 'diffusion_models'), vae: path.join(modelRoot, 'vae') },
          engine: { ...current.engine, mode: 'external', externalCustomNodesDir: externalDir },
        } }) })
        ok(configured.status === 200, 'the external custom-nodes folder persists through normalizeSettings')
        ok(configured.body.settings.engine.externalCustomNodesDir === externalDir, 'the configured folder round-trips exactly')
      }

      console.log('instance: merged inventory through /api/lan/bootstrap')
      {
        const boot = await api('/api/lan/bootstrap')
        ok(boot.status === 200 && boot.body.connected === true, 'bootstrap connects to the fake engine')
        const models = boot.body.models
        const byKey = new Map(models.map((file) => [`${file.kind}/${file.name}`, file]))
        ok(byKey.get('diffusion_models/shared.safetensors')?.source === 'both', 'the file visible locally AND on the instance is one row tagged both')
        ok(byKey.get('diffusion_models/instance-only.gguf')?.source === 'instance', 'an instance-only diffusion model arrives with no local root configured for it')
        ok(byKey.get('text_encoders/instance-encoder.safetensors')?.source === 'instance', 'an EMPTY /models answer falls back to the object_info enums (endpoint never masks the fallback)')
        ok(byKey.get('vae/local-only.safetensors')?.source === 'local', 'a local-only file keeps its local tag')
        ok(!models.some((file) => file.path), 'filesystem paths stay stripped from the renderer payload')
      }

      console.log('instance: live pack chips + external install through the routes')
      {
        const before = await api('/api/lan/engine/nodes')
        ok(before.status === 200, 'GET engine/nodes answers')
        const byId = new Map(before.body.packs.map((pack) => [pack.id, pack]))
        ok(byId.get('h3-hybrid-loader')?.instanceState === 'active', 'a pack whose classes the instance serves reads active — with no folder install at all')
        ok(byId.get('krea2edit')?.instanceState === 'absent' && byId.get('krea2edit')?.folderState === 'missing', 'a pack the instance does not serve reads absent + missing')
        ok(byId.get('lora-form-adapter')?.targetKind === 'external', 'the rows report the EXTERNAL target when external mode + folder are configured')

        // Install from a local copy into the external folder through the route.
        const install = await api('/api/lan/engine/nodes/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'krea2edit', sourceDirectory: localCopy }) })
        ok(install.status === 200 && install.body.pack.installed === true, 'install into the external folder succeeds through the route')
        ok(fs.existsSync(path.join(externalDir, 'comfyui-krea2edit', '.studio-node.json')), 'the pack + marker land inside the configured external folder')

        const after = await api('/api/lan/engine/nodes')
        const afterById = new Map(after.body.packs.map((pack) => [pack.id, pack]))
        const installedRow = afterById.get('krea2edit')
        ok(installedRow.installed === true && installedRow.instanceState === 'absent', 'installed-but-not-loaded reads as the restart-needed state (installed + absent)')
        ok(afterById.get('h3-hybrid-loader')?.instanceState === 'active', 'the live verdict keeps coming from the instance, not the folder')

        // Foreign refusal through the route.
        const foreignDir = path.join(externalDir, 'radiance')
        fs.mkdirSync(foreignDir, { recursive: true })
        fs.writeFileSync(path.join(foreignDir, 'user-file.py'), '# theirs\n')
        const foreign = await api('/api/lan/engine/nodes/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'radiance', sourceDirectory: localCopy }) })
        ok(foreign.status === 400 && /refusing to replace/i.test(foreign.body.error), 'the route refuses a foreign folder in the external target')
        const foreignRow = (await api('/api/lan/engine/nodes')).body.packs.find((pack) => pack.id === 'radiance')
        ok(foreignRow.folderState === 'foreign', 'the foreign state is listed honestly for the Settings chip')

        // Uninstall through the route.
        const uninstalled = await api('/api/lan/engine/nodes/uninstall', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'krea2edit' }) })
        ok(uninstalled.status === 200 && uninstalled.body.pack.installed === false, 'uninstall removes the pack from the external folder')
        ok(!fs.existsSync(path.join(externalDir, 'comfyui-krea2edit')), 'the external folder no longer holds the pack')
      }
    } finally {
      child.kill('SIGINT')
      await waitUntil(() => child.exitCode !== null, 5_000, 'server exit').catch(() => child.kill('SIGKILL'))
      engine.close()
      if (serverOutput.includes('minimax-instance CRASH')) console.log(serverOutput)
    }
  }

  console.log(`\ninstance: ${passed} checks passed`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
