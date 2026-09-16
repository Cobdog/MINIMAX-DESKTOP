// Local-first fetcher suite (task hgjbea2). NO REAL NETWORK anywhere: the
// engine-level sections inject in-memory transports, the HTTP-path section
// points the production transport at a LOCAL origin server via
// MINIMAX_STUDIO_FETCH_TEST_ORIGIN (the allowlist still runs against the
// logical hosts), and the route section boots the real built server with
// MINIMAX_STUDIO_FETCH_MOCK_ROOT pointing at a fixture tree. Sections:
//   (a) catalog integrity: schema, license presence, destination validity,
//       single-sourcing against ENGINE_NODE_PACKS, pin kinds, detect globs
//   (b) consent gating: no transport call without a recorded, license-
//       matching consent (the check lives in the engine, not the route)
//   (c) verification + mismatch: catalog sha256/size pins are enforced;
//       nothing unverified is placed, partials are discarded
//   (d) pin stamping: branch pins resolve-and-stamp the HEAD SHA into the
//       install record AND the node-pack marker (never the branch string)
//   (e) install-record round-trip: state file, catalog status, remove
//       semantics (links removed, foreign files kept, cache retained)
//   (f) placement policy: weights LINK into model roots (never copied),
//       a foreign file at the destination fails the fetch
//   (f2) dataset-repo sources: HF DATASET repos download through the
//       /datasets/<repo>/resolve/... URL form (task gg7mu3s — the gated
//       fasth3-live VAE row)
//   (g) engine-checkout: codeload tarball fetch → extract → main.py gate;
//       a non-empty destination is refused
//   (h) production HTTP transport against a local origin: redirect
//       allowlist (evil hop refused), Range resume, 429 backoff retry
//   (i) routes against the real built server: catalog GET, 403 without
//       consent, consent → fetch → placed (stamped marker), remove
// Run after `pnpm build:server` (the modules load from dist-server).
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')

const REPO = path.join(__dirname, '..')
const { FETCH_CATALOG, findFetchEntry, fetchModelRootPath, fetchExtraModelRoots, matchesGlob, modelRootTargetPath } = require(path.join(REPO, 'dist-server', 'server', 'fetchCatalog.js'))
const { FetchManager, createHttpFetchTransport, extractTarGz, sha256File, transportForEnvironment } = require(path.join(REPO, 'dist-server', 'server', 'fetcher.js'))
const { ENGINE_NODE_PACKS, checkNodePack, findNodePack } = require(path.join(REPO, 'dist-server', 'server', 'engineNodes.js'))

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-fetch-home-'))
}

function makeSettings(home, extra = {}) {
  const modelRoot = path.join(home, 'models')
  const kindDirs = {}
  for (const kind of ['diffusion_models', 'text_encoders', 'vae', 'loras', 'vae_approx', 'clip_vision']) {
    kindDirs[kind] = path.join(modelRoot, kind)
    fs.mkdirSync(kindDirs[kind], { recursive: true })
  }
  return {
    comfyUrl: 'http://127.0.0.1:8188',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'qwen3:latest',
    modelRoot,
    paths: kindDirs,
    outputDirectory: path.join(home, 'output'),
    ffmpegPath: 'ffmpeg',
    engine: { mode: 'external', checkoutPath: extra.checkout ?? '', pythonPath: '', portPreference: 0, autoStart: false, profile: 'default', profiles: {}, patches: {} },
    fetch: { consents: {} },
    ...extra.settings,
  }
}

function makeCheckout() {
  const checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-fetch-checkout-'))
  fs.writeFileSync(path.join(checkout, 'main.py'), '# stub ComfyUI checkout\n')
  return checkout
}

/** A transport that writes REAL bytes of the expected size to the
 *  destination and reports the REAL digest — engine-flow tests (consent,
 *  stamping, placement, records) use it; it does NOT enforce the catalog
 *  digest pins (digest enforcement is tested through the production HTTP
 *  path in section h and the filesystem mock in section i). Counts every
 *  call for the consent gate. */
function makeClaimingTransport(overrides = {}) {
  const state = { downloads: 0, resolves: 0 }
  const transport = {
    state,
    async resolveHfRevision(repo, ref) {
      state.resolves += 1
      return overrides.resolveHfRevision?.(repo, ref) ?? `a${crypto.createHash('sha1').update(`${repo}@${ref}`).digest('hex').slice(0, 39)}`
    },
    async resolveGitHead(url, ref) {
      state.resolves += 1
      return overrides.resolveGitHead?.(url, ref) ?? `b${crypto.createHash('sha1').update(`${url}@${ref}`).digest('hex').slice(0, 39)}`
    },
    async download(options) {
      state.downloads += 1
      if (overrides.download) return overrides.download(options)
      if (options.expectedSizeBytes !== undefined && fs.existsSync(options.destPath) && fs.statSync(options.destPath).size === options.expectedSizeBytes) {
        return { sizeBytes: options.expectedSizeBytes, sha256: await sha256File(options.destPath), resumedBytes: 0 }
      }
      if (options.url.includes('codeload.github.com')) {
        const archive = makeTarGz(overrides.archiveFiles ?? [['main.py', '# comfy\n'], ['comfy/__init__.py', ''], ['LICENSE', 'GPL\n']])
        fs.mkdirSync(path.dirname(options.destPath), { recursive: true })
        fs.writeFileSync(options.destPath, archive)
        return { sizeBytes: archive.length, sha256: await sha256File(options.destPath), resumedBytes: 0 }
      }
      const size = options.expectedSizeBytes ?? 16
      fs.mkdirSync(path.dirname(options.destPath), { recursive: true })
      fs.writeFileSync(options.destPath, Buffer.alloc(size, 7))
      return { sizeBytes: size, sha256: await sha256File(options.destPath), resumedBytes: 0 }
    },
  }
  return transport
}

// ---- minimal ustar builder (test-side; the extractor is the code under test)
function tarHeader(name, size, type = '0', linkname = '') {
  const block = Buffer.alloc(512)
  block.write(name.slice(0, 99), 0, 'utf8')
  block.write('0000644\0', 100)
  block.write('0000000\0', 108)
  block.write('0000000\0', 116)
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  block.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136)
  block.write('        ', 148) // checksum placeholder (the extractor does not validate it)
  block.write(type, 156)
  block.write(linkname.slice(0, 99), 157)
  block.write('ustar\0', 257)
  block.write('00', 263)
  return block
}

function makeTarGz(entries) {
  const blocks = []
  for (const [name, content] of entries) {
    const body = Buffer.from(content, 'utf8')
    blocks.push(tarHeader(`fake-repo-abcd1234/${name}`, body.length, name.endsWith('/') ? '5' : '0'))
    if (body.length > 0) {
      const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512)
      body.copy(padded)
      blocks.push(padded)
    }
  }
  blocks.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(blocks))
}

function makeManager(home, settings, transport, overrides = {}) {
  const events = []
  const manager = new FetchManager({
    homeDirectory: home,
    loadSettings: async () => settings,
    logEvent: () => {},
    logFailure: () => {},
    transport,
    onProgress: (progress) => events.push(progress),
    ...overrides,
  })
  return { manager, events }
}

async function fetchAndAwait(manager, events, id, startOptions = {}) {
  const started = await manager.start(id, startOptions)
  if (!started.started) throw new Error(`fetch refused: ${started.reason}`)
  await waitUntil(() => events.some((event) => event.id === id && (event.phase === 'done' || event.phase === 'failed')), 30_000, `fetch ${id} to settle`)
  const failure = events.find((event) => event.id === id && event.phase === 'failed')
  return { failure }
}

// ---------------------------------------------------------------------------
async function main() {
  // ---- (a) catalog integrity ---------------------------------------------------
  console.log('fetcher: catalog integrity')
  {
    const ids = new Set()
    const validGroups = new Set(['node-packs', 'weights', 'preprocessors', 'engine'])
    const validDestinations = new Set(['model-root', 'pack-ckpt', 'node-pack', 'engine-checkout'])
    const validSizeClasses = new Set(['small', 'medium', 'large', 'huge'])
    const validRoots = new Set(['diffusion_models', 'text_encoders', 'vae', 'loras', 'vae_approx', 'clip_vision', 'model_patches', 'vdn', 'geometry_estimation', 'checkpoints', 'latent_upscale_models'])
    for (const entry of FETCH_CATALOG) {
      ok(!ids.has(entry.id) && /^[a-z0-9][a-z0-9._:-]*$/i.test(entry.id), `unique well-formed id: ${entry.id}`)
      ids.add(entry.id)
      ok(typeof entry.name === 'string' && entry.name.length > 3, `${entry.id}: human name`)
      ok(typeof entry.description === 'string' && entry.description.length > 20, `${entry.id}: human description`)
      ok(validGroups.has(entry.group), `${entry.id}: valid group`)
      ok(validDestinations.has(entry.destination.kind), `${entry.id}: valid destination kind`)
      ok(validSizeClasses.has(entry.sizeClass), `${entry.id}: valid size class`)
      ok(typeof entry.licenseSpdx === 'string' && entry.licenseSpdx.length > 2, `${entry.id}: license verdict present (consent surfaces it)`)
      ok(entry.source.kind === 'hf' || entry.source.kind === 'git', `${entry.id}: valid source kind`)
      ok(['sha', 'tag', 'branch'].includes(entry.source.revision.kind) && entry.source.revision.value.length > 0, `${entry.id}: pin kind + value`)
      if (entry.source.kind === 'hf') {
        ok(/^[\w.-]+\/[\w.-]+$/.test(entry.source.repo), `${entry.id}: hf repo shape`)
        ok(Array.isArray(entry.files) && entry.files.length > 0, `${entry.id}: hf entries list files`)
        for (const file of entry.files) {
          ok(typeof file.path === 'string' && file.path.length > 0 && !path.isAbsolute(file.path) && !file.path.includes('..'), `${entry.id}: file path is relative and safe (${file.path})`)
          ok(typeof file.sizeBytes === 'number' && file.sizeBytes > 0, `${entry.id}: file size pinned (${file.path})`)
          ok(file.sha256 === undefined || /^[0-9a-f]{64}$/i.test(file.sha256), `${entry.id}: sha256 well-formed when present (${file.path})`)
        }
      }
      if (entry.destination.kind === 'model-root') {
        ok(validRoots.has(entry.destination.root), `${entry.id}: model root is a ComfyUI folder name (${entry.destination.root})`)
        ok(typeof entry.detectGlob === 'string' && entry.detectGlob.includes('*'), `${entry.id}: model-root entries carry a presence glob`)
      }
      if (entry.destination.kind === 'pack-ckpt') {
        ok(typeof entry.destination.packDirectory === 'string' && entry.destination.packDirectory.length > 0 && !entry.destination.packDirectory.includes('..'), `${entry.id}: pack directory safe`)
        ok(entry.destination.relativePath.startsWith('ckpts/'), `${entry.id}: pack-ckpt targets live under the pack's ckpts/ tree`)
      }
      if (entry.destination.kind === 'node-pack') {
        const pack = findNodePack(entry.destination.packId)
        ok(pack !== null, `${entry.id}: node-pack entry references a real registry pack`)
        ok(entry.licenseSpdx === pack.licenseSpdx && entry.source.url === pack.repoUrl, `${entry.id}: license + repo single-sourced from ENGINE_NODE_PACKS`)
      }
    }
    // The seed commitments (mission + licensing pass) are all present.
    for (const expected of ['pack:minimax-h3-turbo', 'pack:krea2-controlnet', 'pack:h3-audio-t8', 'fun-control-union', 'vdn-stage-dmd-250', 'vdn-stage-b-2000', 'smhfacct-hybrid-b25-49', 'dwpose-onnx', 'dwpose-torchscript', 'da3-base', 'hed-annotator', 'mlsd-annotator', 'engine-comfyui', 'fasth3-vae-w4a8', 'matlowai-fused-turbo-int8', 'pack:autocontext']) {
      ok(ids.has(expected), `seed entry present: ${expected}`)
    }
    const facok = findFetchEntry('pack:krea2-controlnet')
    ok(facok.licenseSpdx === 'NO-LICENSE' && facok.source.revision.kind === 'branch', 'facok is NO-LICENSE with a moving branch pin (the stamping case)')
    const t8 = findFetchEntry('pack:h3-audio-t8')
    ok(t8.licenseSpdx === 'GPL-3.0-or-later' && t8.source.revision.kind === 'branch', 'T8mars is GPL-3.0-or-later user-fetch (fetchable-but-flagged, never vendored)')
    const larryvrh = findFetchEntry('pack:minimax-h3-turbo')
    ok(larryvrh.licenseSpdx === 'Apache-2.0' && larryvrh.source.revision.kind === 'sha', 'Larryvrh turbo pins a SHA (immutable)')
    // AutoContext row (task p8oyfy1, docs/research/autocontext-deepread.md §7):
    // supElement's segmented-inference pack — permissive Apache-2.0 at an
    // immutable sha pin, single-sourced from ENGINE_NODE_PACKS (checked
    // per-entry above); the "Add files via upload" history makes a sha pin,
    // not a branch, the right posture.
    const autocontext = findFetchEntry('pack:autocontext')
    ok(autocontext.licenseSpdx === 'Apache-2.0' && autocontext.source.revision.kind === 'sha' && autocontext.source.revision.value === 'f1062d34e3c25ef421b2aadeb69f2d21831d1625', 'AutoContext is Apache-2.0 at the deep-read sha pin (immutable)')
    const autocontextPack = findNodePack('autocontext')
    ok(autocontext.name === autocontextPack.name && autocontext.source.url === autocontextPack.repoUrl && autocontextPack.installMode === 'user-fetch', 'the AutoContext row is single-sourced from ENGINE_NODE_PACKS (user-fetch pack, license verdict lives there)')
    ok(findFetchEntry('smhfacct-hybrid-b25-49').optional === true, 'the smhfacct hybrid is marked OPTIONAL (runtime merge preferred)')
    ok(FETCH_CATALOG.filter((entry) => entry.experimentPrerequisite).length >= 7, 'experiment prerequisites are clearly marked')
    ok(findFetchEntry('engine-comfyui').licenseSpdx === 'GPL-3.0' && findFetchEntry('engine-comfyui').source.revision.kind === 'tag', 'the engine checkout is GPL-3.0 at a pinned tag')
    // fasth3-live assessment rows (task gg7mu3s): both carry full integrity
    // pins + honest descriptions of what is verified vs author-claimed.
    const fasth3Vae = findFetchEntry('fasth3-vae-w4a8')
    ok(fasth3Vae.source.kind === 'hf' && fasth3Vae.source.dataset === true && fasth3Vae.source.revision.kind === 'sha', 'the w4a8 VAE is a sha-pinned HF DATASET source (the /datasets/ download path)')
    ok(fasth3Vae.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256 ?? '') && typeof file.sizeBytes === 'number'), 'the w4a8 VAE carries full sha256 + size pins despite the dataset gate masking the LFS oid')
    ok(/license-gated/i.test(fasth3Vae.description) && /401/.test(fasth3Vae.description) && /unverified/i.test(fasth3Vae.description), 'the w4a8 VAE description discloses the HF gate (anonymous fetch 401s) and the unverified fidelity claim')
    ok(fasth3Vae.destination.kind === 'model-root' && fasth3Vae.destination.root === 'vae' && matchesGlob('minimax_h3_video_vae_w4a8_from_fp16.safetensors', fasth3Vae.detectGlob), 'the w4a8 VAE lands in the vae root with a matching presence glob')
    const matlowai = findFetchEntry('matlowai-fused-turbo-int8')
    ok(matlowai.destination.kind === 'model-root' && matlowai.destination.root === 'diffusion_models', 'the MATLOWAI fused turbo lands in diffusion_models')
    ok(matlowai.source.kind === 'hf' && matlowai.source.revision.kind === 'sha' && matlowai.files[0].sha256 === '4262e4e9963c553fa00016bbe83961407a4fc0a888be95fd836c8d4f2304e48b' && matlowai.files[0].sizeBytes === 20_980_178_976, 'the MATLOWAI entry pins the verified LFS sha256 + size at a pinned revision')
    ok(matlowai.experimentPrerequisite === true && /unverified/i.test(matlowai.description), 'the MATLOWAI entry is an experiment prerequisite with its author claims flagged unverified')
    ok(fetchExtraModelRoots().includes('model_patches') && fetchExtraModelRoots().includes('vdn') && fetchExtraModelRoots().includes('geometry_estimation'), 'extra model roots enumerate for config mirroring')
    ok(matchesGlob('minimax_h3_fun_controlnet_union_pruned_int8_convrot.safetensors', '*fun_controlnet_union*'), 'the presence glob catches the staged quantized variant')
    // License discipline: no non-permissive pack is vendor mode (the audit's
    // invariant, re-checked here against the assembled catalog).
    for (const pack of ENGINE_NODE_PACKS) {
      if (pack.installMode === 'vendor') ok(['Apache-2.0', 'MIT', 'ISC'].includes(pack.licenseSpdx), `vendor mode stays permissive-only: ${pack.id}`)
    }
  }

  // ---- (b) consent gating --------------------------------------------------------
  console.log('fetcher: consent gating')
  {
    const home = makeHome()
    const settings = makeSettings(home)
    const transport = makeClaimingTransport()
    const { manager } = makeManager(home, settings, transport)

    const noConsent = await manager.start('mlsd-annotator')
    ok(!noConsent.started && /consent/i.test(noConsent.reason), 'a fetch without any consent record is refused with the reason')
    ok(transport.state.downloads === 0 && transport.state.resolves === 0, 'the transport was NEVER touched without consent (no network)')

    settings.fetch.consents['mlsd-annotator'] = { consented: false, licenseSpdx: 'NO-LICENSE' }
    const revoked = await manager.start('mlsd-annotator')
    ok(!revoked.started && /consent/i.test(revoked.reason), 'a consented:false record is still a refusal')

    settings.fetch.consents['mlsd-annotator'] = { consented: true, licenseSpdx: 'Apache-2.0' }
    const wrongLicense = await manager.start('mlsd-annotator')
    ok(!wrongLicense.started && /license changed|acknowledges/i.test(wrongLicense.reason), 'a consent recorded for a DIFFERENT license is invalid (license changes re-consent)')

    // The engine-level gate is what the routes call; the route test (i)
    // proves the same over HTTP.
    const unknown = await manager.start('not-a-thing')
    ok(!unknown.started && /unknown/i.test(unknown.reason), 'an unknown id is refused')
    ok(transport.state.downloads === 0 && transport.state.resolves === 0, 'still zero transport calls after every refusal')
  }

  // ---- (c) verification + mismatch ------------------------------------------------
  console.log('fetcher: verification and mismatch')
  {
    const home = makeHome()
    const checkout = makeCheckout()
    fs.mkdirSync(path.join(checkout, 'custom_nodes', 'comfyui_controlnet_aux', 'ckpts', 'lllyasviel', 'Annotators'), { recursive: true })
    const settings = makeSettings(home, { checkout })
    settings.fetch.consents['mlsd-annotator'] = { consented: true, licenseSpdx: 'NO-LICENSE' }

    // A transport whose bytes do NOT match the catalog sha pin: the fetch
    // must fail, place nothing, and leave no partial behind.
    const badSha = makeClaimingTransport({ download: async (options) => {
      fs.mkdirSync(path.dirname(options.destPath), { recursive: true })
      fs.writeFileSync(options.destPath, Buffer.alloc(options.expectedSizeBytes ?? 32, 1))
      const sha = await sha256File(options.destPath)
      if (options.expectedSha256 !== undefined && sha !== options.expectedSha256.toLowerCase()) {
        fs.rmSync(options.destPath, { force: true })
        throw new Error(`verification failed (expected sha256 ${options.expectedSha256.slice(0, 16)}…) for ${options.url} — the partial file was discarded`)
      }
      return { sizeBytes: options.expectedSizeBytes ?? 32, sha256: sha, resumedBytes: 0 }
    } })
    const badManager = makeManager(home, settings, badSha)
    const bad = await fetchAndAwait(badManager.manager, badManager.events, 'mlsd-annotator')
    ok(bad.failure && /verification failed/i.test(bad.failure.message), 'a sha mismatch fails the fetch with the verification reason')
    ok(!fs.existsSync(path.join(checkout, 'custom_nodes', 'comfyui_controlnet_aux', 'ckpts', 'lllyasviel', 'Annotators', 'mlsd_large_512_fp32.pth')), 'nothing was placed after a sha mismatch')
    ok(!fs.readdirSync(path.join(home, 'fetches', 'mlsd-annotator', 'files')).length, 'no partial file survived the mismatch')

    const after = await badManager.manager.catalogStatus()
    const failedStatus = after.find((entry) => entry.id === 'mlsd-annotator')
    ok(failedStatus.state === 'absent' && /last fetch failed/.test(failedStatus.note ?? ''), 'the catalog surfaces the failure honestly')
  }

  // ---- (d) pin stamping -------------------------------------------------------------
  console.log('fetcher: pin stamping')
  {
    const home = makeHome()
    const checkout = makeCheckout()
    const settings = makeSettings(home, { checkout })
    const stamped = '79ebfd3bd80d2180b334dd7ce57f3c9ddaa0848f'
    const transport = makeClaimingTransport({ resolveGitHead: async () => stamped, archiveFiles: [['__init__.py', '# facok pack\n'], ['LICENSE', ''], ['nodes.py', '# nodes\n']] })
    const { manager, events } = makeManager(home, settings, transport)
    settings.fetch.consents['pack:krea2-controlnet'] = { consented: true, licenseSpdx: 'NO-LICENSE' }

    const result = await fetchAndAwait(manager, events, 'pack:krea2-controlnet')
    ok(!result.failure, `the facok pack fetches cleanly (${result.failure?.message ?? 'ok'})`)
    const state = JSON.parse(fs.readFileSync(path.join(home, 'fetcher', 'fetch-state.json'), 'utf8'))
    const record = state.installs['pack:krea2-controlnet']
    ok(record.revision === stamped && record.pinKind === 'branch', `the install record stamps the resolved HEAD SHA (${record.revision.slice(0, 12)}), never the branch string`)
    ok(record.licenseSpdx === 'NO-LICENSE' && record.licenseAcknowledged === true, 'the record carries the acknowledged license')
    const marker = JSON.parse(fs.readFileSync(path.join(checkout, 'custom_nodes', 'comfyui-krea2-controlnet', '.studio-node.json'), 'utf8'))
    ok(marker.revision === stamped, `the node-pack marker records the stamped SHA (${marker.revision.slice(0, 12)}), not 'main'`)
    const pack = findNodePack('krea2-controlnet')
    const status = (await manager.catalogStatus()).find((entry) => entry.id === 'pack:krea2-controlnet')
    ok(status.state === 'placed' && status.installedRevision === stamped, 'catalog status reports the stamped revision')
    const packStatus = await checkNodePack(pack, checkout, null)
    ok(packStatus.installed && !/pinned revision changed/.test(packStatus.note ?? ''), 'a stamped branch pin does NOT read as registry drift in the pack status')

    // A sha pin (Larryvrh) must use the pin verbatim — no resolve call.
    const shaCalls = transport.state.resolves
    settings.fetch.consents['pack:minimax-h3-turbo'] = { consented: true, licenseSpdx: 'Apache-2.0' }
    await fetchAndAwait(manager, events, 'pack:minimax-h3-turbo')
    const turboRecord = JSON.parse(fs.readFileSync(path.join(home, 'fetcher', 'fetch-state.json'), 'utf8')).installs['pack:minimax-h3-turbo']
    ok(turboRecord.revision === '4274783a23afcfdbea3b4876cb79effd6c510785' && turboRecord.pinKind === 'sha', 'a sha pin is used verbatim (immutable)')
    ok(transport.state.resolves === shaCalls, 'no revision resolution happened for the sha pin')
  }

  // ---- (e) install-record round-trip + remove -----------------------------------------
  console.log('fetcher: install-record round-trip')
  {
    const home = makeHome()
    const checkout = makeCheckout()
    fs.mkdirSync(path.join(checkout, 'custom_nodes', 'comfyui_controlnet_aux', 'ckpts', 'hr16', 'DWPose-TorchScript-BatchSize5'), { recursive: true })
    const settings = makeSettings(home, { checkout })
    const { manager, events } = makeManager(home, settings, makeClaimingTransport())
    settings.fetch.consents['dwpose-torchscript'] = { consented: true, licenseSpdx: 'Apache-2.0' }
    const result = await fetchAndAwait(manager, events, 'dwpose-torchscript')
    ok(!result.failure, `the DWPose fetch runs end to end (${result.failure?.message ?? 'ok'})`)

    const state = JSON.parse(fs.readFileSync(path.join(home, 'fetcher', 'fetch-state.json'), 'utf8'))
    const record = state.installs['dwpose-torchscript']
    ok(record.files.length === 1 && record.files[0].sizeBytes === 135_059_124 && /^[0-9a-f]{64}$/.test(record.files[0].sha256), 'the record carries per-file size + digest')
    ok(record.verified === 'sha256', 'verification level is the weakest link (sha256 when every file is pinned)')

    const status = (await manager.catalogStatus()).find((entry) => entry.id === 'dwpose-torchscript')
    ok(status.state === 'placed' && status.placedPaths.length === 1, 'catalog status: placed with the placement path')

    const removed = await manager.remove('dwpose-torchscript')
    ok(removed.removed, 'remove succeeds')
    ok(!fs.existsSync(status.placedPaths[0]), 'the studio link is removed from the pack ckpt tree')
    ok(fs.existsSync(path.join(home, 'fetches', 'dwpose-torchscript', 'files', 'dw-ll_ucoco_384_bs5.torchscript.pt')), 'the fetch cache keeps the bytes (refetch re-links without the network)')
    const afterRemove = (await manager.catalogStatus()).find((entry) => entry.id === 'dwpose-torchscript')
    ok(afterRemove.state === 'cached', 'status degrades to cached after remove')
  }

  // ---- (f) placement policy --------------------------------------------------------
  console.log('fetcher: placement policy')
  {
    const home = makeHome()
    const settings = makeSettings(home)
    const { manager, events } = makeManager(home, settings, makeClaimingTransport())
    settings.fetch.consents['da3-base'] = { consented: true, licenseSpdx: 'Apache-2.0' }
    const result = await fetchAndAwait(manager, events, 'da3-base')
    ok(!result.failure, `placement fetch ok (${result.failure?.message ?? 'ok'})`)
    const entry = findFetchEntry('da3-base')
    const target = modelRootTargetPath(entry.destination, settings, entry.files[0].path)
    const stat = fs.lstatSync(target)
    const cacheFile = path.join(home, 'fetches', 'da3-base', 'files', 'geometry_estimation', 'depth_anything_3_base.safetensors')
    // Windows without symlink privilege legitimately lands a hardlink — the
    // invariant is SHARED BYTES, not the specific link kind.
    ok(stat.isSymbolicLink() || fs.statSync(target).ino === fs.statSync(cacheFile).ino, 'the placed weight is a LINK, not a copy (link-never-copy)')
    if (stat.isSymbolicLink()) ok(fs.realpathSync(target) === fs.realpathSync(cacheFile), 'the link resolves to the fetch cache bytes')
    else ok(fs.statSync(target).size === fs.statSync(cacheFile).size && fs.statSync(target).ino === fs.statSync(cacheFile).ino, 'the hardlink shares the cache bytes')

    // A foreign file at the destination: the fetch refuses, never replaces.
    const home2 = makeHome()
    const settings2 = makeSettings(home2)
    const foreignPath = modelRootTargetPath(entry.destination, settings2, entry.files[0].path)
    fs.mkdirSync(path.dirname(foreignPath), { recursive: true })
    fs.writeFileSync(foreignPath, Buffer.alloc(64, 3))
    settings2.fetch.consents['da3-base'] = { consented: true, licenseSpdx: 'Apache-2.0' }
    const refused = makeManager(home2, settings2, makeClaimingTransport())
    fs.mkdirSync(path.join(home2, 'fetches', 'da3-base', 'files', 'geometry_estimation'), { recursive: true })
    fs.copyFileSync(path.join(home, 'fetches', 'da3-base', 'files', 'geometry_estimation', 'depth_anything_3_base.safetensors'), path.join(home2, 'fetches', 'da3-base', 'files', 'geometry_estimation', 'depth_anything_3_base.safetensors'))
    const refusedResult = await fetchAndAwait(refused.manager, refused.events, 'da3-base')
    ok(refusedResult.failure && /could not be linked|refusing to overwrite/i.test(refusedResult.failure.message), 'a foreign file at the destination fails the fetch (never overwritten)')
    ok(fs.lstatSync(foreignPath).isFile() && fs.statSync(foreignPath).size === 64, 'the user\'s foreign file is untouched')

    // Presence detection: a locally staged variant counts as present with
    // NO fetch at all (the fun-control-union doctrine).
    const home3 = makeHome()
    const settings3 = makeSettings(home3)
    const stagedDir = fetchModelRootPath('model_patches', settings3)
    fs.mkdirSync(stagedDir, { recursive: true })
    fs.writeFileSync(path.join(stagedDir, 'minimax_h3_fun_controlnet_union_pruned_int8_convrot.safetensors'), Buffer.alloc(128, 9))
    const { manager: presentManager } = makeManager(home3, settings3, makeClaimingTransport())
    const present = (await presentManager.catalogStatus()).find((candidate) => candidate.id === 'fun-control-union')
    ok(present.state === 'present' && /detected/.test(present.note ?? ''), 'a staged quantized variant satisfies presence via the detect glob')
  }

  // ---- (f2) dataset-repo sources (task gg7mu3s) --------------------------------------
  console.log('fetcher: dataset-repo download URLs')
  {
    // The fasth3-live VAE lives in an HF DATASET repo (license-gated). The
    // engine must build /datasets/<repo>/resolve/... download URLs for it,
    // use its sha pin verbatim (no revision API call), and link the file
    // into the vae root like any weights row.
    const home = makeHome()
    const settings = makeSettings(home)
    const urls = []
    const transport = makeClaimingTransport({
      download: async (options) => {
        urls.push(options.url)
        const size = options.expectedSizeBytes ?? 16
        fs.mkdirSync(path.dirname(options.destPath), { recursive: true })
        fs.writeFileSync(options.destPath, Buffer.alloc(size, 7))
        return { sizeBytes: size, sha256: await sha256File(options.destPath), resumedBytes: 0 }
      },
    })
    const { manager, events } = makeManager(home, settings, transport)
    settings.fetch.consents['fasth3-vae-w4a8'] = { consented: true, licenseSpdx: 'minimax-h3-community-license-agreement' }
    const result = await fetchAndAwait(manager, events, 'fasth3-vae-w4a8')
    ok(!result.failure, `the dataset-repo VAE row fetches through the engine (${result.failure?.message ?? 'ok'})`)
    ok(urls.length === 1 && urls[0] === 'https://huggingface.co/datasets/jacokon/fasth3-live/resolve/b21e88784d0c036ea19508cfff2c2839bddef6eb/minimax_h3_video_vae_w4a8_from_fp16.safetensors', 'dataset sources download from /datasets/<repo>/resolve/<sha>/<path>')
    ok(transport.state.resolves === 0, 'the sha pin resolved locally — no revision API call')
    const entry = findFetchEntry('fasth3-vae-w4a8')
    const target = modelRootTargetPath(entry.destination, settings, entry.files[0].path)
    ok(fs.existsSync(target) && path.basename(target) === 'minimax_h3_video_vae_w4a8_from_fp16.safetensors', 'the VAE links into the vae model root')
    const state = JSON.parse(fs.readFileSync(path.join(home, 'fetcher', 'fetch-state.json'), 'utf8'))
    ok(state.installs['fasth3-vae-w4a8'].verified === 'sha256', 'the gated-repo row still verifies at the sha256 level (the pin does not depend on the gate)')
  }

  // ---- (g) engine checkout ----------------------------------------------------------
  console.log('fetcher: engine checkout')
  {
    const home = makeHome()
    const settings = makeSettings(home)
    const transport = makeClaimingTransport({
      archiveFiles: [['main.py', 'print("comfy")\n'], ['comfy/__init__.py', ''], ['README.md', 'ComfyUI\n'], ['LICENSE', 'GPL-3.0\n']],
    })
    const { manager, events } = makeManager(home, settings, transport)
    settings.fetch.consents['engine-comfyui'] = { consented: true, licenseSpdx: 'GPL-3.0' }
    const destination = path.join(home, 'checkouts', 'ComfyUI-v0.34.0')
    const result = await fetchAndAwait(manager, events, 'engine-comfyui', { destinationDir: destination })
    ok(!result.failure, `the engine checkout fetch runs (${result.failure?.message ?? 'ok'})`)
    ok(fs.existsSync(path.join(destination, 'main.py')) && !fs.existsSync(path.join(destination, 'fake-repo-abcd1234')), 'the archive extracted with the <repo>-<ref>/ prefix stripped, main.py at the root')
    ok(fs.readFileSync(path.join(destination, 'main.py'), 'utf8').includes('comfy'), 'file content survived extraction + gunzip')
    const status = (await manager.catalogStatus()).find((entry) => entry.id === 'engine-comfyui')
    ok(status.state === 'placed' && status.placedPaths[0] === destination, 'the checkout is recorded as the placement')

    // A non-empty destination is refused — the studio never overwrites a
    // checkout (even one it fetched earlier).
    const again = await manager.remove('engine-comfyui')
    ok(again.removed && !fs.existsSync(destination), 'remove deletes the fetched checkout tree')
    fs.mkdirSync(destination, { recursive: true })
    fs.writeFileSync(path.join(destination, 'user-file.txt'), 'not yours')
    const refused = await manager.start('engine-comfyui', { destinationDir: destination })
    ok(!refused.started && /not empty|never overwrites/i.test(refused.reason), 'a non-empty destination is refused before any download')

    // Extraction safety: traversal entries are skipped, not written.
    const evilTar = path.join(home, 'evil.tar.gz')
    fs.writeFileSync(evilTar, makeTarGz([['ok.py', 'ok\n'], ['../escape.py', 'nope\n']]))
    const safeDir = path.join(home, 'extract-safe')
    const extracted = await extractTarGz(evilTar, safeDir)
    ok(fs.existsSync(path.join(safeDir, 'ok.py')) && !fs.existsSync(path.join(home, 'escape.py')), 'a traversal entry is refused by the extractor')
    ok(extracted.skipped.some((name) => name.includes('escape')), 'the skipped entry is reported')
  }

  // ---- (h) production HTTP transport (local origin, allowlist still live) -----------
  console.log('fetcher: production HTTP transport')
  {
    const body = crypto.randomBytes(256 * 1024)
    const bodySha = crypto.createHash('sha256').update(body).digest('hex')
    let rangeRequests = 0
    let firstRangeFailed = false
    const server = await new Promise((resolveServer) => {
      const app = http.createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1')
        if (url.pathname === '/api/models/alibaba-pai%2FMiniMax-H3-Fun-Controlnet-Union/revision/main' || url.pathname.startsWith('/api/models/')) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ sha: '6419c27ece80f330826ae4439fa9c5910c475ccf' }))
          return
        }
        if (url.pathname === '/evil-redirect') {
          response.writeHead(302, { location: 'https://evil.example.com/payload' })
          response.end()
          return
        }
        if (url.pathname === '/repo/resolve/main/file.bin') {
          response.writeHead(302, { location: 'https://cdn-lfs.hf.co/cdn/file.bin' })
          response.end()
          return
        }
        if (url.pathname === '/flaky.bin') {
          if (!firstRangeFailed) {
            firstRangeFailed = true
            response.writeHead(429)
            response.end('slow down')
            return
          }
          response.writeHead(200, { 'content-length': String(body.length) })
          response.end(body)
          return
        }
        if (url.pathname === '/cdn/file.bin') {
          const range = request.headers.range
          if (range) {
            rangeRequests += 1
            const start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0)
            if (start >= body.length) {
              response.writeHead(416)
              response.end()
              return
            }
            const slice = body.subarray(start)
            response.writeHead(206, { 'content-length': String(slice.length), 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` })
            response.end(slice)
            return
          }
          response.writeHead(200, { 'content-length': String(body.length) })
          response.end(body)
          return
        }
        response.writeHead(404)
        response.end('nope')
      })
      app.listen(0, '127.0.0.1', () => resolveServer(app))
    })
    const port = server.address().port
    process.env.MINIMAX_STUDIO_FETCH_TEST_ORIGIN = `http://127.0.0.1:${port}`
    const transport = createHttpFetchTransport({ backoffMs: [20, 40] })

    const resolved = await transport.resolveHfRevision('alibaba-pai/MiniMax-H3-Fun-Controlnet-Union', 'main')
    ok(resolved === '6419c27ece80f330826ae4439fa9c5910c475ccf', 'revision resolution through the real HTTP path')

    const dest = path.join(makeHome(), 'file.bin')
    const download = await transport.download({ url: 'https://huggingface.co/repo/resolve/main/file.bin', destPath: dest, expectedSizeBytes: body.length, expectedSha256: bodySha })
    ok(download.sizeBytes === body.length && download.sha256 === bodySha, 'a full download verifies sha256 + size against the pins')
    ok(fs.readFileSync(dest).equals(body), 'the verified bytes are on disk')

    // Resume: pre-seed a .part with the first half, the Range request must
    // complete the file without rewriting the head.
    const destResume = path.join(makeHome(), 'resume.bin')
    fs.mkdirSync(path.dirname(destResume), { recursive: true })
    fs.writeFileSync(`${destResume}.part`, body.subarray(0, Math.floor(body.length / 2)))
    const resumed = await transport.download({ url: 'https://huggingface.co/repo/resolve/main/file.bin', destPath: destResume, expectedSizeBytes: body.length, expectedSha256: bodySha })
    ok(rangeRequests >= 1 && resumed.resumedBytes === Math.floor(body.length / 2), 'an interrupted download resumes via a Range request from the partial size')
    ok(fs.readFileSync(destResume).equals(body) && resumed.sha256 === bodySha, 'the resumed file verifies end-to-end')

    // A corrupted partial (bytes will not match the pin) restarts clean and
    // still lands verified bytes.
    fs.rmSync(destResume, { force: true })
    fs.writeFileSync(`${destResume}.part`, crypto.randomBytes(Math.floor(body.length / 2)))
    const corruptedResume = await transport.download({ url: 'https://huggingface.co/repo/resolve/main/file.bin', destPath: destResume, expectedSizeBytes: body.length, expectedSha256: bodySha })
    ok(fs.readFileSync(destResume).equals(body) && corruptedResume.sha256 === bodySha, 'a corrupt partial cannot poison the final verification')

    // 429 → backoff → success through the retry loop.
    const flaky = await transport.download({ url: 'https://huggingface.co/flaky.bin', destPath: path.join(makeHome(), 'flaky.bin') })
    ok(flaky.sizeBytes === body.length, 'a 429 is retried after backoff and succeeds')

    // The allowlist: a redirect off the fixed hosts is refused, never followed.
    const evilDest = path.join(makeHome(), 'evil.bin')
    await assert.rejects(
      () => transport.download({ url: 'https://huggingface.co/evil-redirect', destPath: evilDest }),
      /non-allowlisted host|evil\.example\.com/,
      'a redirect to a non-allowlisted host is a hard failure',
    )
    ok(!fs.existsSync(evilDest) && !fs.existsSync(`${evilDest}.part`), 'nothing landed from the refused redirect')
    delete process.env.MINIMAX_STUDIO_FETCH_TEST_ORIGIN
    server.close()
  }

  // ---- (i) routes against the real built server --------------------------------------
  console.log('fetcher: /api/lan/fetch/* routes')
  {
    if (!fs.existsSync(path.join(REPO, 'dist', 'index.html'))) {
      console.log('  NOTE - no web build present (dist/index.html); route coverage runs on legs that build the web app (ubuntu CI, pnpm test:all)')
    } else {
      const home = makeHome()
      const checkout = makeCheckout()
      fs.mkdirSync(path.join(checkout, 'custom_nodes', 'comfyui_controlnet_aux', 'ckpts', 'lllyasviel', 'Annotators'), { recursive: true })
      // The mock transport tree: a githead pin for facok + its archive, and
      // a WRONG-bytes file for mlsd (the mismatch-through-routes case).
      const mockRoot = path.join(home, 'fetch-mock')
      fs.mkdirSync(path.join(mockRoot, 'githead', 'facok_comfyui-krea2-controlnet'), { recursive: true })
      fs.writeFileSync(path.join(mockRoot, 'githead', 'facok_comfyui-krea2-controlnet', 'main'), '79ebfd3bd80d2180b334dd7ce57f3c9ddaa0848f')
      fs.mkdirSync(path.join(mockRoot, 'archive'), { recursive: true })
      fs.writeFileSync(path.join(mockRoot, 'archive', 'facok_comfyui-krea2-controlnet_79ebfd3bd80d2180b334dd7ce57f3c9ddaa0848f.tar.gz'), makeTarGz([['__init__.py', '# facok\n'], ['nodes.py', '# depth lock\n']]))
      fs.mkdirSync(path.join(mockRoot, 'hf', 'lllyasviel', 'Annotators'), { recursive: true })
      fs.writeFileSync(path.join(mockRoot, 'hf', 'lllyasviel', 'Annotators', 'mlsd_large_512_fp32.pth'), Buffer.alloc(128, 5)) // wrong size + sha

      const port = 4310 + Math.floor(Math.random() * 80)
      const child = spawn(process.execPath, ['dist-server/server/index.js'], {
        cwd: REPO,
        env: { ...process.env, MINIMAX_STUDIO_HOME: home, MINIMAX_LAN_PORT: String(port), MINIMAX_STUDIO_FETCH_MOCK_ROOT: mockRoot },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let serverOutput = ''
      child.stdout.on('data', (chunk) => { serverOutput += String(chunk) })
      child.stderr.on('data', (chunk) => { serverOutput += String(chunk) })
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
      const base = `https://127.0.0.1:${port}`
      const api = async (route, init) => {
        const response = await fetch(`${base}${route}`, init)
        return { status: response.status, body: await response.json().catch(() => ({})) }
      }
      await waitUntil(async () => {
        try { return (await fetch(`${base}/api/lan/settings`)).ok } catch { return false }
      }, 15_000, 'server boot')

      // Configure the checkout through the real settings pipeline.
      const current = (await api('/api/lan/settings')).body.settings
      await api('/api/lan/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: { ...current, engine: { ...current.engine, mode: 'managed', checkoutPath: checkout } } }) })

      const catalog = await api('/api/lan/fetch/catalog')
      ok(catalog.status === 200 && catalog.body.entries.length === FETCH_CATALOG.length, 'GET catalog lists every entry with statuses')
      ok(catalog.body.entries.every((entry) => ['present', 'placed', 'cached', 'absent'].includes(entry.state)), 'every catalog row carries a state')
      ok(catalog.body.entries.every((entry) => typeof entry.licenseSpdx === 'string'), 'every catalog row surfaces its license (the consent contract)')

      const noConsent = await api('/api/lan/fetch/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'pack:krea2-controlnet' }) })
      ok(noConsent.status === 403 && /consent/i.test(noConsent.body.error), 'POST start without consent is a 403 with the reason')

      const consented = await api('/api/lan/fetch/consent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'pack:krea2-controlnet', consented: true }) })
      ok(consented.status === 200, 'POST consent records the acknowledgement')
      const savedSettings = (await api('/api/lan/settings')).body.settings
      ok(savedSettings.fetch.consents['pack:krea2-controlnet']?.consented === true && savedSettings.fetch.consents['pack:krea2-controlnet']?.licenseSpdx === 'NO-LICENSE', 'the consent persists through normalizeSettings with its license')

      const started = await api('/api/lan/fetch/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'pack:krea2-controlnet' }) })
      ok(started.status === 200 && started.body.started === true, 'POST start with consent kicks off the fetch')
      await waitUntil(async () => {
        const state = await api('/api/lan/fetch/catalog')
        return state.body.entries.find((entry) => entry.id === 'pack:krea2-controlnet')?.state === 'placed'
      }, 20_000, 'the facok pack to place')
      const placedState = await api('/api/lan/fetch/catalog')
      const placed = placedState.body.entries.find((entry) => entry.id === 'pack:krea2-controlnet')
      ok(placed.installedRevision === '79ebfd3bd80d2180b334dd7ce57f3c9ddaa0848f', 'the route-placed pack reports the fetch-stamped HEAD SHA')
      const marker = JSON.parse(fs.readFileSync(path.join(checkout, 'custom_nodes', 'comfyui-krea2-controlnet', '.studio-node.json'), 'utf8'))
      ok(marker.revision === '79ebfd3bd80d2180b334dd7ce57f3c9ddaa0848f', 'the pack marker carries the stamped SHA over the routes path')

      // Mismatch through the routes: wrong bytes in the mock → failed fetch,
      // nothing placed, honest note.
      await api('/api/lan/fetch/consent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'mlsd-annotator', consented: true }) })
      await api('/api/lan/fetch/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'mlsd-annotator' }) })
      await waitUntil(async () => {
        const state = await api('/api/lan/fetch/catalog')
        const entry = state.body.entries.find((candidate) => candidate.id === 'mlsd-annotator')
        return Boolean(entry && /last fetch failed/.test(entry.note ?? ''))
      }, 20_000, 'the mismatched fetch to fail')
      ok(!fs.existsSync(path.join(checkout, 'custom_nodes', 'comfyui_controlnet_aux', 'ckpts', 'lllyasviel', 'Annotators', 'mlsd_large_512_fp32.pth')), 'no unverified bytes were placed through the routes')

      const removed = await api('/api/lan/fetch/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'pack:krea2-controlnet' }) })
      ok(removed.status === 200 && removed.body.removed === true, 'POST remove takes the placement back')
      ok(!fs.existsSync(path.join(checkout, 'custom_nodes', 'comfyui-krea2-controlnet')), 'the fetched pack folder is gone')
      const unknownRemove = await api('/api/lan/fetch/remove', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'nope' }) })
      ok(unknownRemove.status === 404, 'removing an unknown id is a 404')

      child.kill()
      await new Promise((resolveExit) => { if (child.exitCode !== null) resolveExit(); else child.on('exit', resolveExit) })
      if (serverOutput.includes('FAIL')) console.log('  NOTE - server output contained FAIL; inspect manually')
    }
  }

  // ---- transport selection ----------------------------------------------------------
  console.log('fetcher: transport selection')
  {
    const home = makeHome()
    process.env.MINIMAX_STUDIO_FETCH_MOCK_ROOT = home
    const selected = transportForEnvironment()
    ok(typeof selected.resolveHfRevision === 'function' && typeof selected.download === 'function', 'the mock root env selects the filesystem transport (zero network)')
    delete process.env.MINIMAX_STUDIO_FETCH_MOCK_ROOT
  }

  console.log(`\nfetcher suite: ${passed} assertions passed`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
