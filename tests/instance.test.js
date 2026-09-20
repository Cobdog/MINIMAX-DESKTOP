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
//
// Vitest port (task z7ogmig, 2026-09-20) of scripts/test-instance.cjs:
// assertion bodies carry over verbatim; the linear main() became one test
// per section ((d)+(e) stay one test — they share the booted server and the
// settings flow); the module-scope dist-server requires are guarded so a
// missing build NOTE-skips; the engine + server ports draw from this
// suite's disjoint range (tests/lib/ports.cjs) instead of the old random
// 6500-6599 picks; the shared git fixture repo builds once at module scope
// as before.
import { test } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = require('node:path').dirname(fileURLToPath(import.meta.url))
const REPO = require('node:path').resolve(__dirname, '..')

const { spawn, execSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { makePortAllocator } = require('./lib/ports.cjs')

const freePort = makePortAllocator('instance')

// NOTE guard: every module under test loads from dist-server — without the
// build there is nothing to exercise (the suite's own philosophy).
const hasServerBuild = fs.existsSync(path.join(REPO, 'dist-server', 'server', 'instanceInventory.js'))
if (!hasServerBuild) {
  console.log('NOTE - no dist-server build present (instanceInventory.js); run pnpm build:server — this suite runs on legs that build the server.')
}
const maybe = hasServerBuild ? test : test.skip

const { instanceNamesForKind, inventoryFromObjectInfo, mergeModelInventories, parseModelsEndpointList } = hasServerBuild ? require(path.join(REPO, 'dist-server', 'server', 'instanceInventory.js')) : {}
const { ENGINE_NODE_PACKS, checkNodePack, installNodePack, nodePackInstanceState, nodePackInstallDir, resolveNodePackTarget, resolveVendorRoot, uninstallNodePack } = hasServerBuild ? require(path.join(REPO, 'dist-server', 'server', 'engineNodes.js')) : {}
const { compareSemverish, gitOrderRevision, managedNoticeText, parsePyproject, readGitHeadSha, relateVersionToPin } = hasServerBuild ? require(path.join(REPO, 'dist-server', 'server', 'packVersioning.js')) : {}

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-instance-home-'))
}

// ---- the shared git fixture set (version matrix + routes status board) ----
// A REAL git repo (A → B on main, C on a side branch off A — deterministic
// ordering ground), a packed-refs copy, a detached-HEAD copy, a plain
// folder, and an external-target matrix dir holding one fixture folder per
// badge state. No network, no engine.
const gitEnv = { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' }
const gitHome = makeHome()
const gitRepo = path.join(gitHome, 'repo')
fs.mkdirSync(gitRepo, { recursive: true })
const git = (repo, ...args) => execSync(`git -C ${JSON.stringify(repo)} ${args.join(' ')}`, { env: gitEnv, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
git(gitRepo, 'init -q -b main')
git(gitRepo, '-c user.email=matrix@test -c user.name=matrix commit --allow-empty -q -m A')
const shaA = git(gitRepo, 'rev-parse HEAD')
git(gitRepo, '-c user.email=matrix@test -c user.name=matrix commit --allow-empty -q -m B')
const shaB = git(gitRepo, 'rev-parse HEAD')
git(gitRepo, `checkout -q -b side ${shaA}`)
git(gitRepo, '-c user.email=matrix@test -c user.name=matrix commit --allow-empty -q -m C')
const shaC = git(gitRepo, 'rev-parse HEAD')
git(gitRepo, 'checkout -q main')
const gitPackedRepo = path.join(gitHome, 'packed')
fs.cpSync(gitRepo, gitPackedRepo, { recursive: true })
git(gitPackedRepo, 'pack-refs --all')
const gitDetachedRepo = path.join(gitHome, 'detached')
fs.cpSync(gitRepo, gitDetachedRepo, { recursive: true })
git(gitDetachedRepo, `checkout -q ${shaB}`)
const plainGitDir = path.join(gitHome, 'plain')
fs.mkdirSync(plainGitDir, { recursive: true })
const matrixDir = path.join(gitHome, 'matrix-custom-nodes')
fs.mkdirSync(matrixDir, { recursive: true })
const matrixTarget = { kind: 'external', customNodesDir: matrixDir }
const krea2editPack = ENGINE_NODE_PACKS.find((entry) => entry.id === 'krea2edit')
const fixtures = { gitRepo, gitPackedRefs: path.join(gitPackedRepo, '.git'), gitDetached: path.join(gitDetachedRepo, '.git'), plainDir: plainGitDir, matrixDir, shaA, shaB, shaC }

maybe('(a) instance inventory parsing: object_info loader enums', () => {
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
})

maybe('(a) /models endpoint parsing + preference', () => {
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
})

maybe('(a) instance ∪ local merge with source tags', () => {
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
})

maybe('(b) external custom-nodes target resolution + installs + foreign refusal + the working-instance report', async () => {
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
    const foreignPack = ENGINE_NODE_PACKS.find((entry) => entry.id === 'krea2-controlnet')
    fs.mkdirSync(path.join(externalDir, foreignPack.name), { recursive: true })
    fs.writeFileSync(path.join(externalDir, foreignPack.name, 'mine.py'), '# not ours\n')
    const refused = await installNodePack(foreignPack, { target, sourceDirectory: sourceDir })
    ok(refused.installed === false && /refusing to replace/i.test(refused.notes.join(' ')), 'a foreign folder in the external target is refused, never replaced')
    ok(fs.readFileSync(path.join(externalDir, foreignPack.name, 'mine.py'), 'utf8') === '# not ours\n', 'the foreign folder\'s bytes are untouched')
    const foreignStatus = await checkNodePack(foreignPack, target, null, 'unknown')
    ok(foreignStatus.folderState === 'foreign' && foreignStatus.installed === false, 'checkNodePack reports the foreign folder state')

    // ---- the maintainer's report (9om4bi9 follow-up): the external folder
    // already holds the VENDORED and FIRST-PARTY packs (a working instance).
    // The rows must report PRESENCE honestly — payload availability stays
    // truthful (the bug: every foreign row read availability 'unavailable',
    // which disabled Install and read as "cannot be installed") — and the
    // engine must refuse to DELETE what it did not place.
    const vendorRoot = resolveVendorRoot()
    ok(vendorRoot !== null, 'the vendored payload root resolves in this checkout')
    const secondExternal = path.join(home, 'external-custom-nodes-working-instance')
    fs.mkdirSync(secondExternal, { recursive: true })
    const workingTarget = { kind: 'external', customNodesDir: secondExternal }
    const vdn = ENGINE_NODE_PACKS.find((entry) => entry.id === 'vdn-h3')
    const formAdapter = ENGINE_NODE_PACKS.find((entry) => entry.id === 'lora-form-adapter')
    fs.mkdirSync(path.join(secondExternal, vdn.name), { recursive: true })
    fs.writeFileSync(path.join(secondExternal, vdn.name, 'their_vdn.py'), '# theirs\n')
    fs.mkdirSync(path.join(secondExternal, formAdapter.name), { recursive: true })
    fs.writeFileSync(path.join(secondExternal, formAdapter.name, 'their_adapter.py'), '# theirs\n')
    const vdnForeign = await checkNodePack(vdn, workingTarget, vendorRoot, 'absent')
    ok(vdnForeign.folderState === 'foreign' && vdnForeign.installed === false, 'a pre-existing VDN folder is foreign/not-managed, never claimed installed')
    ok(vdnForeign.availability === 'ready', 'a pre-existing VDN folder keeps payload availability READY (not the unavailable that read as "cannot be installed")')
    ok(/already present/i.test(vdnForeign.note ?? ''), 'the external-target note leads with presence')
    const adapterForeign = await checkNodePack(formAdapter, workingTarget, vendorRoot, 'unknown')
    ok(adapterForeign.folderState === 'foreign' && adapterForeign.availability === 'ready', 'a pre-existing form-adapter folder keeps payload availability ready')
    const vdnInstallRefused = await installNodePack(vdn, { target: workingTarget })
    ok(vdnInstallRefused.installed === false && /refusing to replace/i.test(vdnInstallRefused.notes.join(' ')), 'installing the vendored VDN OVER the pre-existing folder is refused (payload present — the refusal is the folder discipline, not a missing source)')
    const vdnUninstallRefused = await uninstallNodePack(vdn, workingTarget)
    ok(vdnUninstallRefused.removed === false && /never deletes/i.test(vdnUninstallRefused.reason ?? ''), 'uninstall of a marker-less folder is refused by the engine (the discipline held server-side, not just in the UI)')
    ok(fs.readFileSync(path.join(secondExternal, vdn.name, 'their_vdn.py'), 'utf8') === '# theirs\n' && fs.existsSync(path.join(secondExternal, formAdapter.name, 'their_adapter.py')), 'both pre-existing folders survive every attempt untouched')

    const removed = await uninstallNodePack(pack, target)
    ok(removed.removed === true && !fs.existsSync(path.join(externalDir, pack.name)), 'uninstall deletes exactly the pack folder in the external target')
  }
})

maybe('(c) live pack detection from object_info', () => {
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
})

maybe('(f) version detection — pure parsers', () => {
  console.log('instance: pack version detection — pure parsers')
  {
    ok(compareSemverish('v1.0.0', '1.0.0') === 0 && compareSemverish('1.2.0', '1.10.0') < 0 && compareSemverish('2.0.0', '1.9.9') > 0, 'semverish compare orders versions numerically (v-prefix tolerated, 2 < 10)')
    ok(compareSemverish('1.0.0', '86f886dac23013d88996e3a2e99093ba44d322fb') === null, 'a sha is not semver-orderable — null, never a guess')

    const py = parsePyproject('[project]\nname = "x"\nversion = "1.4.2"\ndescription = "y"\n\n[tool.comfy]\nPublisherId = "abc"\nDisplayName = "X"\n')
    ok(py.version === '1.4.2' && py.hasComfySection === true, 'pyproject parsing reads the [project] version and detects the [tool.comfy] registry section')
    const pyPlain = parsePyproject('[project]\nname = "x"\nversion = "0.3.0"\n')
    ok(pyPlain.version === '0.3.0' && pyPlain.hasComfySection === false, 'a bare pyproject version parses without a tool.comfy section')
    const pyBroken = parsePyproject('[project\nthis is ] not toml at all\n')
    ok(pyBroken.version === undefined && pyBroken.hasComfySection === false, 'exotic pyproject content degrades to nothing found, never a throw')

    const detached = readGitHeadSha(fixtures.gitDetached)
    ok(/^[0-9a-f]{40}$/.test(detached ?? ''), 'a detached .git/HEAD (raw sha) reads directly')
    ok(readGitHeadSha(path.join(fixtures.gitPackedRefs)) === null || /^[0-9a-f]{40}$/.test(readGitHeadSha(fixtures.gitPackedRefs) ?? ''), 'packed-refs-only metadata never throws')
  }
})

maybe('(f) git ordering on a crafted checkout', async () => {
  console.log('instance: git ordering on a crafted checkout')
  {
    // The crafted repo: A → B on main, C on a side branch off A.
    const orderAB = await gitOrderRevision(fixtures.gitRepo, fixtures.shaB, fixtures.shaA)
    ok(orderAB === 'descendant', `HEAD (B) descends from the pin (A) → ahead (got ${orderAB})`)
    const orderBA = await gitOrderRevision(fixtures.gitRepo, fixtures.shaA, fixtures.shaB)
    ok(orderBA === 'ancestor', `an older commit against a newer pin → behind (got ${orderBA})`)
    const orderUnrelated = await gitOrderRevision(fixtures.gitRepo, fixtures.shaB, fixtures.shaC)
    ok(orderUnrelated === 'unrelated', 'commits on diverged branches order as unrelated, never guessed')
    ok(await gitOrderRevision(fixtures.gitRepo, 'main', fixtures.shaA) === 'unknown', 'a non-sha revision answers unknown without spawning git')
    ok(await gitOrderRevision(fixtures.plainDir, fixtures.shaA, fixtures.shaB) === 'unknown', 'a folder with no git metadata answers unknown')
  }
})

maybe('(f) version relation to the pin', async () => {
  console.log('instance: version relation to the pin')
  {
    const relation = await relateVersionToPin(fixtures.shaB, { kind: 'git-checkout', revision: fixtures.shaB }, fixtures.gitRepo)
    ok(relation === 'at-pin', 'an exact sha match is at-pin before any git spawn')
    ok(await relateVersionToPin('main', { kind: 'git-checkout', revision: fixtures.shaB }, fixtures.gitRepo) === 'unknown', 'a branch pin vs a detected sha has no local relation — unknown')
    ok(await relateVersionToPin('v1.0.0', { kind: 'comfyui-registry', version: '1.4.2' }, fixtures.gitRepo) === 'ahead-of-pin', 'a registry semver above a tag pin is ahead-of-pin')
    ok(await relateVersionToPin('v2.0.0', { kind: 'comfyui-registry', version: '1.4.2' }, fixtures.gitRepo) === 'behind-pin', 'a registry semver below a tag pin is behind-of-pin')
    ok(await relateVersionToPin('86f886dac23013d88996e3a2e99093ba44d322fb', { kind: 'comfyui-registry', version: '1.4.2' }, fixtures.gitRepo) === 'unknown', 'a registry semver vs a sha pin is honestly unknown')
    const noticeAhead = managedNoticeText({ ...krea2editPack, pinnedRevision: fixtures.shaA }, { kind: 'git-checkout', revision: fixtures.shaB }, 'ahead-of-pin')
    ok(/managed by the ComfyUI instance/.test(noticeAhead ?? '') && noticeAhead.includes(fixtures.shaA.slice(0, 12)) && noticeAhead.includes(fixtures.shaB.slice(0, 12)) && /ahead of the pin/.test(noticeAhead ?? '') && /instance side/.test(noticeAhead ?? ''), 'the AC-4 notice names both revisions, the direction, and that updates happen instance-side')
    const noticeDiffers = managedNoticeText(krea2editPack, { kind: 'git-checkout', revision: '1111111111111111111111111111111111111111' }, 'differs')
    ok(/not determinable/.test(noticeDiffers ?? ''), 'an unknowable ordering is said out loud, never guessed')
    ok(managedNoticeText(krea2editPack, { kind: 'comfyui-registry', version: '1.0.0' }, 'at-pin') === undefined, 'no notice when the managed version satisfies the pin')
  }
})

maybe('(f) the checkNodePack status matrix on crafted folders', async () => {
  console.log('instance: the checkNodePack status matrix on crafted folders')
  {
    // (1) studio-installed @ pin — the marker rung.
    const pinDir = path.join(fixtures.matrixDir, 'comfyui-krea2edit')
    fs.mkdirSync(pinDir, { recursive: true })
    fs.writeFileSync(path.join(pinDir, '.studio-node.json'), `${JSON.stringify({ id: 'krea2edit', revision: krea2editPack.pinnedRevision, mode: 'user-fetch', installedAt: Date.now(), source: 'matrix' }, null, 2)}\n`)
    const atPin = await checkNodePack(krea2editPack, matrixTarget, null, 'unknown')
    ok(atPin.installed === true && atPin.versionInfo?.source === 'studio-marker' && atPin.versionInfo?.managedBy === 'studio' && atPin.versionInfo?.version === krea2editPack.pinnedRevision, 'a studio marker reports source studio-marker with the exact revision')
    ok(atPin.versionRelation === 'at-pin', 'a marker at the pinned revision reports at-pin')

    // (2) studio-installed at an OLD pin — the outdated state.
    const oldSha = '0123456789abcdef0123456789abcdef01234567'
    fs.writeFileSync(path.join(pinDir, '.studio-node.json'), `${JSON.stringify({ id: 'krea2edit', revision: oldSha, mode: 'user-fetch', installedAt: Date.now(), source: 'matrix' }, null, 2)}\n`)
    const outdated = await checkNodePack(krea2editPack, matrixTarget, null, 'unknown')
    ok(outdated.versionRelation === 'differs' && /pinned revision changed — reinstall to move/.test(outdated.note ?? ''), 'a drifted marker reports differs + the honest reinstall note')

    // (3) foreign + Comfy-Registry pyproject — managed by ComfyUI.
    const cnrDir = path.join(fixtures.matrixDir, 'comfyui-krea2-controlnet')
    fs.mkdirSync(cnrDir, { recursive: true })
    fs.writeFileSync(path.join(cnrDir, 'pyproject.toml'), '[project]\nname = "comfyui-krea2-controlnet"\nversion = "1.4.2"\n\n[tool.comfy]\nPublisherId = "facok"\nDisplayName = "Krea2 ControlNet"\n')
    const cnr = await checkNodePack(ENGINE_NODE_PACKS.find((entry) => entry.id === 'krea2-controlnet'), matrixTarget, null, 'absent')
    ok(cnr.folderState === 'foreign' && cnr.versionInfo?.source === 'comfyui-registry' && cnr.versionInfo?.managedBy === 'comfyui' && cnr.versionInfo?.version === '1.4.2', 'a Comfy-Registry pyproject folder reports comfyui-registry @ its version, managed by ComfyUI')
    ok(cnr.versionRelation === 'unknown' && cnr.managedNotice === undefined, 'a branch pin (main) vs a registry semver claims no relation and raises no notice')

    // (4) foreign git checkout vs a sha pin on the same history — ahead.
    const gitPack = { ...krea2editPack, pinnedRevision: fixtures.shaA }
    const gitDir = path.join(fixtures.matrixDir, 'comfyui-krea2edit-git')
    fs.mkdirSync(gitDir, { recursive: true })
    fs.cpSync(fixtures.gitRepo, gitDir, { recursive: true })
    // (The matrix pack's folder name differs — point the pack at it.)
    const gitPackRenamed = { ...gitPack, name: 'comfyui-krea2edit-git' }
    const ahead = await checkNodePack(gitPackRenamed, matrixTarget, null, 'active')
    ok(ahead.folderState === 'foreign' && ahead.versionInfo?.source === 'git-checkout' && ahead.versionInfo?.managedBy === 'comfyui' && ahead.versionInfo?.version === fixtures.shaB, 'a git-checkout folder reports the HEAD sha, managed by ComfyUI')
    ok(ahead.versionRelation === 'ahead-of-pin', 'HEAD descending from the pin orders ahead-of-pin via the folder\'s own git history')
    ok(/ahead of the pin/.test(ahead.managedNotice ?? '') && ahead.managedNotice?.includes(fixtures.shaB.slice(0, 12)), 'the managed notice appears with the direction and the installed revision')

    // (5) foreign plain folder — presence without version.
    const plainDir = path.join(fixtures.matrixDir, 'krea2-anypaint')
    fs.mkdirSync(plainDir, { recursive: true })
    fs.writeFileSync(path.join(plainDir, 'user-file.py'), '# theirs\n')
    const plain = await checkNodePack(ENGINE_NODE_PACKS.find((entry) => entry.id === 'krea2-anypaint'), matrixTarget, null, 'unknown')
    ok(plain.folderState === 'foreign' && plain.versionInfo === undefined && plain.versionRelation === undefined && plain.managedNotice === undefined, 'a plain foreign folder stays version-unknown with no fabricated fields')

    // (6) absent — nothing to detect.
    const absent = await checkNodePack(ENGINE_NODE_PACKS.find((entry) => entry.id === 'autocontext'), matrixTarget, null, 'unknown')
    ok(absent.folderState === 'missing' && absent.versionInfo === undefined, 'a missing folder stays missing with no version fields')
  }
})

const hasWebBuild = fs.existsSync(path.join(REPO, 'dist', 'index.html'))
if (!hasWebBuild) {
  console.log('  NOTE - no web build present (dist/index.html); sections (d)/(e) run on legs that build the web app (ubuntu CI, pnpm gate)')
}
const routesMaybe = hasServerBuild && hasWebBuild ? test : test.skip

routesMaybe('(d) app-relative io defaults through the real settings pipeline + (e) routes against the real server + fake engine', async () => {
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
  const child = spawn(process.execPath, [path.join(REPO, 'dist-server', 'server', 'index.js')], {
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

      // Trim-at-save parity (review M5, g5x37k8 2026-09-19): the inline
      // PathCheckNote trims a pasted path before stat-checking it; the save
      // path must trim the SAME fields or a trailing newline validates
      // green and then scans nothing. Failing-without-it: the round-trip
      // kept the raw whitespace (and a leading-space path was refused as
      // "relative" while the note called the trimmed form found).
      const root = path.join(home, 'models-root')
      const paddedPaths = await api('/api/lan/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: {
        ...fresh,
        modelRoot: `${root}\n`,
        paths: { ...fresh.paths, loras: `${path.join(root, 'loras')}\n`, vae: `  ${path.join(root, 'vae')}  ` },
      } }) })
      ok(paddedPaths.status === 200, `padded model roots save instead of being misread as relative (got ${paddedPaths.status}: ${JSON.stringify(paddedPaths.body).slice(0, 160)})`)
      ok(paddedPaths.body.settings.modelRoot === root, `modelRoot round-trips trimmed (got ${JSON.stringify(paddedPaths.body.settings.modelRoot)})`)
      ok(paddedPaths.body.settings.paths.loras === path.join(root, 'loras'), `paths.loras round-trips trimmed — trailing newline healed (got ${JSON.stringify(paddedPaths.body.settings.paths.loras)})`)
      ok(paddedPaths.body.settings.paths.vae === path.join(root, 'vae'), `paths.vae round-trips trimmed — padded spaces healed (got ${JSON.stringify(paddedPaths.body.settings.paths.vae)})`)

      // Relative io dirs are refused at the write boundary.
      const relativeIo = await api('/api/lan/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: { ...fresh, inputDirectory: 'relative/input' } }) })
      ok(relativeIo.status === 400 && /inputDirectory must be an absolute path/.test(relativeIo.body.error), 'a relative inputDirectory is refused loudly')
      const relativeExternal = await api('/api/lan/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: { ...fresh, engine: { ...fresh.engine, externalCustomNodesDir: 'relative/nodes' } } }) })
      ok(relativeExternal.status === 400 && /externalCustomNodesDir must be an absolute path/.test(relativeExternal.body.error), 'a relative external custom-nodes folder is refused loudly')

      // Model overrides (rq0lsax, 2026-09-20): the H3 per-lane slots
      // (fl2va/ref2va/merged) normalize through the REAL pipeline, and a
      // legacy single-checkpoint pick migrates onto fl2va+ref2va
      // fill-if-unset — never silently dropped. The generic families keep
      // 'checkpoint'. The VAE split (epdvxd4, 2026-09-20): a legacy 'vae'
      // pick migrates onto videoVae (the video families — its old meaning
      // there) or audioVae (music3/acestep, whose one decoder IS
      // audio-class), fill-if-unset, consumed key. Failing-without-it: the
      // pre-split normalizer kept only the six old slot keys —
      // videoVae/audioVae/imageVae posted as auto (dropped at save) and the
      // legacy vae pick stayed a key no family exposes anymore.
      const legacyOverrides = await api('/api/lan/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: { ...fresh, modelOverrides: {
        minimax: { checkpoint: 'legacy-merge.safetensors', fl2va: 'explicit-fl2va.safetensors', vae: '  ' },
        h3image: { checkpoint: 'legacy-image.safetensors', vae: 'legacy-h3-video-vae.safetensors', videoVae: 'explicit-workbench-video-vae.safetensors' },
        music3: { vae: 'legacy-dav.safetensors' },
        acestep: { vae: 'legacy-ace-audio-vae.safetensors', imageVae: 'not-a-real-pick.safetensors' },
      } } }) })
      const normalized = legacyOverrides.body.settings.modelOverrides ?? {}
      ok(normalized.minimax?.fl2va === 'explicit-fl2va.safetensors', `minimax: an explicit lane pick wins its lane (got ${JSON.stringify(normalized.minimax)})`)
      ok(normalized.minimax?.ref2va === 'legacy-merge.safetensors', 'minimax: the legacy pick fills the UNSET lane')
      ok(!('checkpoint' in (normalized.minimax ?? {})), 'minimax: the consumed legacy key never persists')
      ok(!('vae' in (normalized.minimax ?? {})), 'minimax: a blank slot drops to auto')
      ok(normalized.h3image?.fl2va === 'legacy-image.safetensors' && normalized.h3image?.ref2va === 'legacy-image.safetensors', 'h3image: the legacy pick lands on BOTH lanes (behavior-preserving)')
      ok(normalized.h3image?.videoVae === 'explicit-workbench-video-vae.safetensors', 'h3image: an explicit videoVae pick wins over the legacy vae value')
      ok(!('vae' in (normalized.h3image ?? {})), 'h3image: the consumed legacy vae key never persists')
      ok(normalized.music3?.audioVae === 'legacy-dav.safetensors', 'music3: the legacy vae pick lands on audioVae (the family one decoder is audio-class)')
      ok(normalized.acestep?.audioVae === 'legacy-ace-audio-vae.safetensors', 'acestep: the legacy vae pick lands on audioVae')
      ok(normalized.acestep?.imageVae === 'not-a-real-pick.safetensors', 'acestep: an imageVae pick persists shape-wise — the family gate lives renderer-side (refused as unexposed at consult)')
      const reread = (await api('/api/lan/settings')).body.settings.modelOverrides ?? {}
      ok(reread.minimax?.ref2va === 'legacy-merge.safetensors' && !('checkpoint' in (reread.minimax ?? {})), 'the migrated shape is what persists on disk')
      await api('/api/lan/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: fresh }) })

      // (tmz8vh7, 2026-09-20) The decoder-class routing + stored-wedge
      // healing: a T=1-named legacy pick never lands on videoVae, and the
      // ALREADY-NORMALIZED wedge (videoVae naming the T=1 file — the exact
      // shape this seam's pre-tmz8vh7 output wrote into the maintainer's
      // settings.json) heals on the next load. Failing-without-it: the
      // legacy key lands on videoVae verbatim and the stored wedge
      // round-trips unchanged — the state that refused every video render
      // with the T=1 message.
      const t1File = 'minimax_h3_t1_image_vae_step1597.safetensors'
      const t1Overrides = await api('/api/lan/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: { ...fresh, modelOverrides: {
        minimax: { vae: t1File },
        h3image: { vae: t1File },
        music3: { vae: 'a-video-vae.safetensors' },
      } } }) })
      const t1norm = t1Overrides.body.settings.modelOverrides ?? {}
      ok(!t1norm.minimax?.videoVae && !('vae' in (t1norm.minimax ?? {})), `minimax: a T=1-named legacy pick has no legal slot — dropped, never wedged onto videoVae (got ${JSON.stringify(t1norm.minimax)})`)
      ok(t1norm.h3image?.imageVae === t1File && !t1norm.h3image?.videoVae, `h3image: a T=1-named legacy pick routes to imageVae — the one legal slot (got ${JSON.stringify(t1norm.h3image)})`)
      ok(!t1norm.music3?.audioVae, `music3: a video-named legacy pick on an audio family has no legal slot — dropped (got ${JSON.stringify(t1norm.music3)})`)
      await api('/api/lan/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: fresh }) })

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

      // The maintainer's report (9om4bi9 follow-up): VDN (vendored) and the
      // form adapter (first-party) must install into a CLEAN external folder
      // with NO source directory — direct payload placement.
      const vdnInstall = await api('/api/lan/engine/nodes/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'vdn-h3' }) })
      ok(vdnInstall.status === 200 && vdnInstall.body.pack.installed === true, `the vendored VDN pack installs into the external folder with no source dir (got ${vdnInstall.status}: ${vdnInstall.body.error ?? 'ok'})`)
      ok(fs.existsSync(path.join(externalDir, 'ComfyUI-VDN-H3', '.studio-node.json')), 'the VDN payload + marker land inside the external folder')
      const formInstall = await api('/api/lan/engine/nodes/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'lora-form-adapter' }) })
      ok(formInstall.status === 200 && formInstall.body.pack.installed === true, `the first-party form adapter installs into the external folder with no source dir (got ${formInstall.status}: ${formInstall.body.error ?? 'ok'})`)
      ok(fs.existsSync(path.join(externalDir, 'minimax-lora-form-adapter', '.studio-node.json')), 'the form-adapter payload + marker land inside the external folder')

      // Install from a local copy into the external folder through the route.
      const install = await api('/api/lan/engine/nodes/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'krea2edit', sourceDirectory: localCopy }) })
      ok(install.status === 200 && install.body.pack.installed === true, 'install into the external folder succeeds through the route')
      ok(fs.existsSync(path.join(externalDir, 'comfyui-krea2edit', '.studio-node.json')), 'the pack + marker land inside the configured external folder')

      const after = await api('/api/lan/engine/nodes')
      const afterById = new Map(after.body.packs.map((pack) => [pack.id, pack]))
      const installedRow = afterById.get('krea2edit')
      ok(installedRow.installed === true && installedRow.instanceState === 'absent', 'installed-but-not-loaded reads as the restart-needed state (installed + absent)')
      ok(afterById.get('h3-hybrid-loader')?.instanceState === 'active', 'the live verdict keeps coming from the instance, not the folder')

      // Uninstall through the route.
      const uninstalled = await api('/api/lan/engine/nodes/uninstall', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'krea2edit' }) })
      ok(uninstalled.status === 200 && uninstalled.body.pack.installed === false, 'uninstall removes the pack from the external folder')
      ok(!fs.existsSync(path.join(externalDir, 'comfyui-krea2edit')), 'the external folder no longer holds the pack')

      // ---- the maintainer's exact condition (9om4bi9 follow-up): the
      // external folder ALREADY holds the packs (a working instance) ----
      // Remove OUR marker installs first so the fixture folders are truly
      // foreign (the pre-existing scenario, not our own install).
      for (const packId of ['vdn-h3', 'lora-form-adapter']) {
        const cleanup = await api('/api/lan/engine/nodes/uninstall', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: packId }) })
        ok(cleanup.status === 200, `the marker install of ${packId} uninstalls cleanly before the pre-existing fixtures`)
      }
      for (const [, folder, file] of [['vdn-h3', 'ComfyUI-VDN-H3', '__init__.py'], ['lora-form-adapter', 'minimax-lora-form-adapter', 'nodes.py']]) {
        fs.mkdirSync(path.join(externalDir, folder), { recursive: true })
        fs.writeFileSync(path.join(externalDir, folder, file), '# their own copy\n')
      }
      const presentRows = (await api('/api/lan/engine/nodes')).body.packs
      const vdnRow = presentRows.find((pack) => pack.id === 'vdn-h3')
      ok(vdnRow.folderState === 'foreign' && vdnRow.installed === false, 'a pre-existing VDN folder reports foreign/not-installed (never claimed as managed)')
      ok(vdnRow.availability === 'ready', 'a pre-existing VDN folder keeps its payload availability honest (ready — not the source-less "unavailable" that read as "cannot be installed")')
      ok(/already present/i.test(vdnRow.note ?? ''), 'the note leads with PRESENCE for a pre-existing external folder')
      const formRow = presentRows.find((pack) => pack.id === 'lora-form-adapter')
      ok(formRow.folderState === 'foreign' && formRow.availability === 'ready', 'a pre-existing form-adapter folder reports foreign + payload-ready')
      const presentInstall = await api('/api/lan/engine/nodes/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'vdn-h3' }) })
      ok(presentInstall.status === 400 && /refusing to replace/i.test(presentInstall.body.error), 'installing OVER a pre-existing folder is still refused (the discipline holds)')
      const presentUninstall = await api('/api/lan/engine/nodes/uninstall', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'vdn-h3' }) })
      ok(presentUninstall.status === 404 && /never deletes/i.test(presentUninstall.body.error), 'uninstall of a pre-existing (marker-less) folder is refused by the engine — never deleted')
      ok(fs.readFileSync(path.join(externalDir, 'ComfyUI-VDN-H3', '__init__.py'), 'utf8') === '# their own copy\n', 'the pre-existing VDN bytes are untouched by both attempts')
      ok(fs.existsSync(path.join(externalDir, 'minimax-lora-form-adapter', 'nodes.py')), 'the pre-existing form-adapter folder is untouched')

      // Foreign refusal through the route (the user-fetch pack).
      const foreignDir = path.join(externalDir, 'comfyui-krea2-controlnet')
      fs.mkdirSync(foreignDir, { recursive: true })
      fs.writeFileSync(path.join(foreignDir, 'user-file.py'), '# theirs\n')
      const foreign = await api('/api/lan/engine/nodes/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'krea2-controlnet', sourceDirectory: localCopy }) })
      ok(foreign.status === 400 && /refusing to replace/i.test(foreign.body.error), 'the route refuses a foreign folder in the external target')
      const foreignRow = (await api('/api/lan/engine/nodes')).body.packs.find((pack) => pack.id === 'krea2-controlnet')
      ok(foreignRow.folderState === 'foreign', 'the foreign state is listed honestly for the Settings chip')

      // ---- the status board (task mjhlt3k): version-aware rows + the
      // refresh contract + the AC-1 network-source decoration. Fixtures:
      // a studio marker AT the pin, a Comfy-Registry pyproject folder, a
      // git-checkout folder (real history, unrelated to the pin → the
      // honest differs notice), and a folder that appears BETWEEN two
      // GETs — the per-request re-scan the Refresh button drives.
      console.log('instance: status board — version fields, notices, refresh, network-source gate')
      {
        const markerDir = path.join(externalDir, 'comfyui-krea2edit')
        fs.mkdirSync(markerDir, { recursive: true })
        fs.writeFileSync(path.join(markerDir, '.studio-node.json'), `${JSON.stringify({ id: 'krea2edit', revision: '86f886dac23013d88996e3a2e99093ba44d322fb', mode: 'user-fetch', installedAt: Date.now(), source: 'route' }, null, 2)}\n`)
        const cnrDir = path.join(externalDir, 'comfyui-krea2-controlnet')
        fs.mkdirSync(cnrDir, { recursive: true })
        fs.writeFileSync(path.join(cnrDir, 'pyproject.toml'), '[project]\nname = "comfyui-krea2-controlnet"\nversion = "1.4.2"\n\n[tool.comfy]\nPublisherId = "facok"\n')
        const gitDir = path.join(externalDir, 'ComfyUI_MinimaxH3_AutoContext')
        fs.cpSync(fixtures.gitRepo, gitDir, { recursive: true })

        const board = (await api('/api/lan/engine/nodes')).body.packs
        const byBoardId = new Map(board.map((pack) => [pack.id, pack]))
        const markerRow = byBoardId.get('krea2edit')
        ok(markerRow.installed === true && markerRow.versionInfo?.source === 'studio-marker' && markerRow.versionRelation === 'at-pin' && markerRow.versionInfo.version === markerRow.pinnedRevision, 'a marker at the pin reports studio-marker / at-pin with the revision')
        const cnrRow = byBoardId.get('krea2-controlnet')
        ok(cnrRow.folderState === 'foreign' && cnrRow.versionInfo?.source === 'comfyui-registry' && cnrRow.versionInfo?.managedBy === 'comfyui' && cnrRow.versionInfo?.version === '1.4.2', 'a Comfy-Registry pyproject folder reports managed-by-comfyui with its version')
        const gitRow = byBoardId.get('autocontext')
        ok(gitRow.folderState === 'foreign' && gitRow.versionInfo?.source === 'git-checkout' && gitRow.versionInfo?.version === fixtures.shaB, 'a git-checkout folder reports the HEAD sha as its version')
        ok(gitRow.versionRelation === 'differs' && /not determinable/.test(gitRow.managedNotice ?? ''), 'a git HEAD unrelated to the sha pin reports differs with the honest not-locally-determinable notice')
        ok(byBoardId.get('krea2edit')?.hasNetworkSource === true && byBoardId.get('vdn-h3')?.hasNetworkSource === false && byBoardId.get('lora-form-adapter')?.hasNetworkSource === false, 'hasNetworkSource marks fetch-catalog packs (user-fetch yes; vendored and local-install entries no)')

        // The refresh contract: a folder created AFTER the previous GET
        // appears on the NEXT GET — every read is a fresh folder scan.
        const anypaintDir = path.join(externalDir, 'krea2-anypaint')
        fs.mkdirSync(anypaintDir, { recursive: true })
        fs.writeFileSync(path.join(anypaintDir, 'node.py'), '# theirs\n')
        const refreshed = (await api('/api/lan/engine/nodes')).body.packs
        const anypaintRow = refreshed.find((pack) => pack.id === 'krea2-anypaint')
        ok(anypaintRow.folderState === 'foreign', 'a folder appearing between GETs is picked up by the next read (the refresh the button drives)')
        ok(refreshed.find((pack) => pack.id === 'lora-form-adapter')?.versionInfo === undefined, 'a plain foreign folder carries no fabricated version fields')
      }
    }
  } finally {
    child.kill('SIGINT')
    await waitUntil(() => child.exitCode !== null, 5_000, 'server exit').catch(() => child.kill('SIGKILL'))
    engine.close()
    if (serverOutput.includes('minimax-instance CRASH')) console.log(serverOutput)
  }
})

maybe('suite summary', () => {
  console.log(`\ninstance: ${passed} checks passed`)
})
