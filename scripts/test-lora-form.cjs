#!/usr/bin/env node
'use strict'

/** Form-adapter suite (task k271ykk) — the LoRA form-compatibility node.
 *
 * Two halves:
 *
 *  (a) PYTHON BRIDGE — runs the node package's own unittest suite
 *      (custom-nodes/minimax-lora-form-adapter/tests: the centered-fit math,
 *       both traps as tests, the kijai golden, the detection matrix) with
 *      python3+numpy. No network: the golden runs from the committed
 *      fixture. python3 missing → loud SKIP; python3 present but numpy
 *      missing → FAIL with the install hint (the trap test is the point of
 *      the task — it must never silently not run on a capable machine).
 *  (b) SERVER SIDE (against dist-server, like test-fetcher/test-runtime):
 *      - server/modelForms.ts: safetensors header reads + the full
 *        detection matrix (model curve/full/non-H3 × lora full-width/curve/
 *        adaln-free/prefixed/diffusers), compat verdicts, guidance text;
 *      - the first-party node pack: registry entry, availability, install
 *        into a stub checkout from the repo's own custom-nodes payload
 *        (marker, files, uninstall), license-audit discipline (MIT);
 *      - the fetch-catalog entry: single-sourced license/repo, localInstall
 *        flag, and the fetch engine's LOCAL INSTALL path — a transport that
 *        THROWS if touched proves the network is never used for this entry;
 *      - scan-time tagging: h3FormForScannedFile over synthetic checkpoints.
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')

const REPO = path.join(__dirname, '..')
const NODE_PKG = path.join(REPO, 'custom-nodes', 'minimax-lora-form-adapter')

let passed = 0
function ok(condition, label) {
  assert.ok(condition, label)
  passed += 1
  console.log(`  ok - ${label}`)
}

// ---------------------------------------------------------------------------
// (a) Python bridge — the node's own suite
// ---------------------------------------------------------------------------
console.log('lora-form: python node suite (math + traps + kijai golden)')
{
  const python = process.platform === 'win32' ? 'python' : 'python3'
  const probe = spawnSync(python, ['-c', 'import numpy'], { encoding: 'utf8' })
  if (probe.error && probe.error.code === 'ENOENT') {
    console.log(`  SKIP - ${python} not found on PATH; the node's math/golden suite did not run here (CI installs python3+numpy and runs it in full)`)
  } else if (probe.status !== 0) {
    console.error(`  FAIL - ${python} is available but numpy is not — install it (pip install numpy) so the projection-math suite actually runs`)
    process.exit(1)
  } else {
    const run = spawnSync(python, ['-m', 'unittest', 'discover', '-s', path.join(NODE_PKG, 'tests')], {
      cwd: NODE_PKG,
      encoding: 'utf8',
      timeout: 120_000,
    })
    const tail = (run.stdout + run.stderr).trim().split('\n').filter(Boolean).slice(-3).join(' | ')
    ok(run.status === 0, `the node's unittest suite passes (${tail})`)
    ok(/Ran \d+ tests/.test(run.stdout + run.stderr), 'unittest reported a test count')
  }
}

// ---------------------------------------------------------------------------
// Shared helpers for the server-side halves
// ---------------------------------------------------------------------------
const { readSafetensorsHeader, detectH3ModelForm, detectH3LoraForm, h3LoraCompat, h3LoraGuidance, h3FormForScannedFile } = require(path.join(REPO, 'dist-server', 'server', 'modelForms.js'))
const { ENGINE_NODE_PACKS, checkNodePack, findNodePack, installNodePack, uninstallNodePack, resolveFirstPartyRoot } = require(path.join(REPO, 'dist-server', 'server', 'engineNodes.js'))
const { FETCH_CATALOG, findFetchEntry } = require(path.join(REPO, 'dist-server', 'server', 'fetchCatalog.js'))
const { FetchManager } = require(path.join(REPO, 'dist-server', 'server', 'fetcher.js'))

/** Minimal safetensors writer (F32, zero-filled) for detection fixtures:
 *  detection reads dtype + shape from the header, so the data sections are
 *  zero buffers of the declared byte size — sparse on disk via holes. */
function u64(value) {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64LE(BigInt(value))
  return buffer
}
function writeSafetensors(file, tensors) {
  const header = { __metadata__: { test: 'lora-form' } }
  const blobs = []
  let offset = 0
  for (const [name, shape] of Object.entries(tensors)) {
    const bytes = shape.reduce((product, dimension) => product * dimension, 4)
    header[name] = { dtype: 'F32', shape, data_offsets: [offset, offset + bytes] }
    blobs.push(Buffer.alloc(bytes))
    offset += bytes
  }
  const rawHeader = Buffer.from(JSON.stringify(header), 'utf8')
  const pad = (8 - (rawHeader.length % 8)) % 8
  fs.writeFileSync(file, Buffer.concat([u64(rawHeader.length + pad), rawHeader, Buffer.alloc(pad, 0x20), ...blobs]))
}

/** Shape sugar: every fixture tensor is zero-filled of this shape. */
function zeros(...shape) {
  return shape
}

function makeCheckout() {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'lora-form-checkout-'))
  fs.writeFileSync(path.join(checkout, 'main.py'), '# stub ComfyUI checkout\n')
  return checkout
}

// ---------------------------------------------------------------------------
// Server-side halves (async)
// ---------------------------------------------------------------------------
async function main() {
// ---------------------------------------------------------------------------
// (b1) Detection matrix — model side, from header shapes (never names)
// ---------------------------------------------------------------------------
console.log('lora-form: model-side detection matrix')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lora-form-models-'))
  const curve = path.join(dir, 'some-random-name.safetensors')
  writeSafetensors(curve, {
    adaln_t_table: zeros(1025, 8),
    'blocks.0.adaln_proj.linear.weight': zeros(96768, 8),
    'final_layer.adaln_proj.linear.weight': zeros(10752, 8),
  })
  const full = path.join(dir, 'full.safetensors')
  writeSafetensors(full, {
    'time_embedder.proj_in.weight': zeros(5376, 256),
    'time_embedder.proj_out.weight': zeros(2688, 5376),
    'blocks.0.adaln_proj.linear.weight': zeros(96768, 2688),
  })
  const hybrid = path.join(dir, 'hybrid-nosignal.safetensors')
  writeSafetensors(hybrid, {
    adaln_t_table: zeros(1025, 8),
    'blocks.49.adaln_proj.linear.weight': zeros(96768, 8),
  })
  const other = path.join(dir, 'other.safetensors')
  writeSafetensors(other, { 'blocks.0.attn.qkv_proj.weight': zeros(512, 512) })
  const junk = path.join(dir, 'junk.safetensors')
  fs.writeFileSync(junk, Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3]))

  ok(detectH3ModelForm(await readSafetensorsHeader(curve)) === 'curve', 'adaln_t_table [1025,8] ⇒ curve (name not consulted)')
  ok(detectH3ModelForm(await readSafetensorsHeader(full)) === 'full', 'time_embedder.* ⇒ full')
  ok(detectH3ModelForm(await readSafetensorsHeader(hybrid)) === 'curve', 'the hybrid class (table present, no name signal) ⇒ curve')
  ok(detectH3ModelForm(await readSafetensorsHeader(other)) === null, 'non-H3 shapes ⇒ null')
  ok((await readSafetensorsHeader(junk)) === null && detectH3ModelForm(null) === null, 'junk files degrade to null, never throw')
}

// ---------------------------------------------------------------------------
// (b2) Detection matrix — LoRA side + compat verdicts + guidance
// ---------------------------------------------------------------------------
console.log('lora-form: lora-side detection + compat + guidance')
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lora-form-loras-'))
  const fullWidth = path.join(dir, 'full-width.safetensors')
  writeSafetensors(fullWidth, {
    'blocks.0.adaln_proj.linear.lora_A.weight': zeros(16, 2688),
    'blocks.0.adaln_proj.linear.lora_B.weight': zeros(96768, 16),
  })
  const fullWidthPrefixed = path.join(dir, 'prefixed.safetensors')
  writeSafetensors(fullWidthPrefixed, {
    'diffusion_model.blocks.0.adaln_proj.linear.lora_A.weight': zeros(64, 2688),
    'diffusion_model.blocks.0.adaln_proj.linear.lora_B.weight': zeros(96768, 64),
  })
  const curveNative = path.join(dir, 'curve.safetensors')
  writeSafetensors(curveNative, {
    'diffusion_model.blocks.0.adaln_proj.linear.lora_A.weight': zeros(8, 8),
    'diffusion_model.blocks.0.adaln_proj.linear.lora_B.weight': zeros(96768, 8),
  })
  const adalnFree = path.join(dir, 'free.safetensors')
  writeSafetensors(adalnFree, {
    'blocks.0.attn.qkv_proj.lora_A.weight': zeros(16, 3072),
    'blocks.0.attn.qkv_proj.lora_B.weight': zeros(3072, 16),
  })
  const diffusers = path.join(dir, 'peft.safetensors')
  writeSafetensors(diffusers, { 'transformer.blocks.0.attn.to_q.lora_A.weight': zeros(16, 3072) })

  const fullInfo = detectH3LoraForm(await readSafetensorsHeader(fullWidth))
  ok(fullInfo.form === 'full-width-adaln' && fullInfo.adalnAWidth === 2688 && fullInfo.adalnPairs === 1, 'lora_A [16,2688] ⇒ full-width-adaln')
  const prefixedInfo = detectH3LoraForm(await readSafetensorsHeader(fullWidthPrefixed))
  ok(prefixedInfo.form === 'full-width-adaln' && prefixedInfo.prefixed, 'prefixed community LoRA detected (the issue-#28 class)')
  ok(detectH3LoraForm(await readSafetensorsHeader(curveNative)).form === 'curve-adaln', 'lora_A [8,8] ⇒ curve-adaln (kijai _pruned class)')
  const freeInfo = detectH3LoraForm(await readSafetensorsHeader(adalnFree))
  ok(freeInfo.form === 'adaln-free' && freeInfo.adalnAWidth === null, 'no adaln keys ⇒ adaln-free (the Civitai style class)')
  ok(detectH3LoraForm(await readSafetensorsHeader(diffusers)).diffUsersNaming, 'diffusers/PEFT naming flagged for guidance')

  // compat verdicts: the same decision the node's plan_form_adaptation makes
  ok(h3LoraCompat('curve', 'full-width-adaln') === 'needs-adapter', 'full-width LoRA × curve base ⇒ needs-adapter')
  ok(h3LoraCompat('curve', 'curve-adaln') === 'ok', 'curve LoRA × curve base ⇒ ok')
  ok(h3LoraCompat('curve', 'adaln-free') === 'ok', 'adaln-free LoRA works everywhere')
  ok(h3LoraCompat('full', 'full-width-adaln') === 'ok', 'full-width LoRA × full base ⇒ ok')
  ok(h3LoraCompat('full', 'curve-adaln') === 'refused', 'curve LoRA × full base ⇒ refused (wrong direction)')
  ok(h3LoraCompat(null, 'full-width-adaln') === 'unknown' && h3LoraCompat('curve', null) === 'unknown', 'unknown forms surface as unknown')

  const guidance = h3LoraGuidance('curve', fullInfo, 'minimax-lora-form-adapter')
  ok(/MiniMaxH3LoraFormLoader/.test(guidance ?? ''), 'mismatch guidance names the adapter node')
  ok(h3LoraGuidance('full', fullInfo, 'x') === undefined, 'no guidance when forms are fine')
  const refused = h3LoraGuidance('full', detectH3LoraForm(await readSafetensorsHeader(curveNative)), 'x')
  ok(/wrong direction/.test(refused ?? ''), 'reverse-direction guidance explains itself')

  // scan-time tagging helper: kind-aware
  const junkPath = path.join(dir, 'junk2.safetensors')
  fs.writeFileSync(junkPath, Buffer.from([1, 2, 3]))
  ok((await h3FormForScannedFile(fullWidth, 'loras')) === 'full-width-adaln', 'scan tags the LoRA form')
  ok((await h3FormForScannedFile(fullWidth, 'diffusion_models')) === undefined, 'a LoRA-shaped header is not a diffusion-model form')
  ok((await h3FormForScannedFile(junkPath, 'loras')) === undefined, 'unreadable files carry no tag')
  ok((await h3FormForScannedFile(path.join(dir, 'plain.pt'), 'loras')) === undefined, 'non-safetensors files carry no tag')
}

// ---------------------------------------------------------------------------
// (c) First-party node pack: registry + install from custom-nodes
// ---------------------------------------------------------------------------
console.log('lora-form: first-party node pack (registry + install)')
{
  const pack = findNodePack('lora-form-adapter')
  ok(pack !== null, 'the lora-form-adapter registry entry exists')
  ok(pack.installMode === 'first-party' && pack.licenseSpdx === 'MIT', 'first-party mode, MIT (our own code)')
  ok(pack.firstPartyDir === 'minimax-lora-form-adapter', 'payload directory declared')
  const payloadRoot = resolveFirstPartyRoot()
  ok(payloadRoot !== null && fs.existsSync(path.join(payloadRoot, pack.firstPartyDir)), 'the custom-nodes payload resolves in this checkout')
  for (const expected of ['LICENSE', 'README.md', 'pyproject.toml', '__init__.py', path.join('minimax_lora_form_adapter', 'math_core.py'), path.join('minimax_lora_form_adapter', 'adapter.py'), path.join('tests', 'test_golden.py')]) {
    ok(fs.existsSync(path.join(payloadRoot, pack.firstPartyDir, expected)), `payload ships ${expected}`)
  }
  const checkout = makeCheckout()
  const status0 = await checkNodePack(pack, { kind: 'checkout', checkout }, null)
  ok(status0.vendored === true && status0.availability === 'ready', 'first-party availability is ready (payload present, no vendor root needed)')
  ok(status0.installed === false, 'not installed yet in a fresh checkout')
  const install = await installNodePack(pack, { target: { kind: 'checkout', checkout } })
  ok(install.installed, `install from the studio payload succeeds: ${install.notes.join(' ')}`)
  const installedDir = path.join(checkout, 'custom_nodes', pack.name)
  ok(fs.existsSync(path.join(installedDir, '__init__.py')), 'the node package landed in custom_nodes/')
  const marker = JSON.parse(fs.readFileSync(path.join(installedDir, '.studio-node.json'), 'utf8'))
  ok(marker.id === 'lora-form-adapter' && marker.revision === pack.pinnedRevision, `marker records id + pin (${marker.revision})`)
  // .npz fixtures are not weight files (the weights policy extensions) —
  // they are plain payload files, copied with the pack
  ok(fs.existsSync(path.join(installedDir, 'tests', 'fixtures', 'h3_form_fixtures.npz')), 'test fixtures ride along as plain payload (not weight files)')
  const status1 = await checkNodePack(pack, { kind: 'checkout', checkout }, null)
  ok(status1.installed && status1.installedRevision === pack.pinnedRevision, 'post-install status reports the pinned revision')
  const removed = await uninstallNodePack(pack, { kind: 'checkout', checkout })
  ok(removed.removed && !fs.existsSync(installedDir), 'uninstall deletes the folder')
  ok(ENGINE_NODE_PACKS.filter((entry) => entry.installMode === 'first-party').every((entry) => entry.licenseSpdx === 'MIT' || entry.licenseSpdx === 'Apache-2.0'), 'first-party packs stay permissive (audit discipline mirrored)')
}

// ---------------------------------------------------------------------------
// (d) Fetch-catalog entry + the local-install path (transport never touched)
// ---------------------------------------------------------------------------
console.log('lora-form: fetch catalog entry + consent-gated LOCAL install')
{
  const entry = findFetchEntry('pack:lora-form-adapter')
  ok(entry !== null && entry.localInstall === true, 'the catalog entry exists and is marked localInstall')
  const pack = findNodePack('lora-form-adapter')
  ok(entry.licenseSpdx === pack.licenseSpdx && entry.source.url === pack.repoUrl, 'license + repo single-sourced from ENGINE_NODE_PACKS')
  ok(FETCH_CATALOG.some((candidate) => candidate.id === 'pack:lora-form-adapter' && candidate.destination.kind === 'node-pack'), 'destination is the node-pack channel')

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lora-form-home-'))
  const checkout = makeCheckout()
  const settings = {
    comfyUrl: 'http://127.0.0.1:8188',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'q:latest',
    modelRoot: path.join(home, 'models'),
    paths: { diffusion_models: path.join(home, 'models', 'diffusion_models'), text_encoders: '', vae: '', loras: '', vae_approx: '', clip_vision: '' },
    outputDirectory: path.join(home, 'output'),
    ffmpegPath: 'ffmpeg',
    engine: { mode: 'external', checkoutPath: checkout, pythonPath: '', portPreference: 0, autoStart: false, profile: 'default', profiles: {}, patches: {} },
    fetch: { consents: {} },
  }

  const events = []
  const failingTransport = {
    resolveHfRevision() { throw new Error('transport must never be touched for a localInstall entry') },
    resolveGitHead() { throw new Error('transport must never be touched for a localInstall entry') },
    download() { throw new Error('transport must never be touched for a localInstall entry') },
  }
  const manager = new FetchManager({
    homeDirectory: home,
    loadSettings: async () => settings,
    logEvent: (event) => events.push(event),
    logFailure: (stage, error) => events.push({ kind: `failure:${stage}`, error: String(error) }),
    transport: failingTransport,
  })

  const noConsent = await manager.start('pack:lora-form-adapter')
  ok(!noConsent.started && /consent/i.test(noConsent.reason), 'the local install still requires consent (the doctrine is absolute)')

  settings.fetch.consents['pack:lora-form-adapter'] = { consented: true, licenseSpdx: 'MIT' }
  const started = await manager.start('pack:lora-form-adapter')
  ok(started.started, 'consent granted ⇒ install starts')
  await new Promise((resolve) => setTimeout(resolve, 150))
  const deadline = Date.now() + 5000
  let status
  while (Date.now() < deadline) {
    status = (await manager.catalogStatus()).find((candidate) => candidate.id === 'pack:lora-form-adapter')
    if (status.state === 'placed') break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  ok(status.state === 'placed', `catalog status reports placed (state=${status.state})`)
  ok(fs.existsSync(path.join(checkout, 'custom_nodes', pack.name, '__init__.py')), 'the pack actually installed into the checkout')
  ok(!events.some((event) => String(event.kind).startsWith('failure:')), `no failures logged during the local install (${events.map((event) => event.kind).join(', ')})`)
  const record = JSON.parse(fs.readFileSync(path.join(home, 'fetcher', 'fetch-state.json'), 'utf8')).installs['pack:lora-form-adapter']
  ok(record && /first-party payload/.test(record.sourceLabel), `the install record names the local payload (${record?.sourceLabel})`)
}

console.log(`\nPASS: lora-form adapter suite (${passed} assertions) — python node suite (math fidelity incl. the centered/uncentered + bias traps, kijai golden at cos 0.9968/1.000000, detection matrix, key hygiene), server-side detection matrix from header shapes, compat verdicts + guidance, first-party pack install from custom-nodes, and the consent-gated local-install fetch path with a never-touch transport`)
}

main().catch((error) => {
  console.error(`\nFAIL: lora-form adapter suite — ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
})
