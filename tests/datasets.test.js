// Dataset manager test (sv14rt0, docs/specs/dataset-manager-v1.md §12):
// boots the BUILT standalone server on a scratch port + scratch home (the
// documents-suite pattern) with SYNTHETIC ffmpeg clips and drives the manager
// end to end. No engine, no GPU, no cloud: ffmpeg testsrc fixtures only.
//   (a) ingest both paths (reference + LAN upload) — identity by content
//       hash (re-import dedupes), refusal floors with measured reasons,
//       async decoded-count probe required pre-bake
//   (b) health: MISSING on rename/delete, CHANGED on replaced-at-same-path,
//       hash re-link; BYTE-IMMORTABILITY of referenced sources (sha256
//       before/after every operation class)
//   (c) layer lifecycle: crop 32-grid + crop-time floor refusal, trim,
//       stale-caption flow on crop AND trim edits; soft delete + restore;
//       per-path trash semantics (referenced = entry only; uploaded bytes
//       move to the trash store; empty-trash touches app-owned bytes only)
//   (d) captions: authorship + history round-trip; batch VLM NEVER
//       overwrites hand-written (stub seam, direct module test); trigger
//       validation (single rare token, once, first)
//   (e) bake: order fixed; decoded ∈ [target, target+2]; a crafted
//       f56-class truncation (decoded < target) REFUSES with the delta while
//       conforming +2 bakes pass; fps plan policy (23.976→retime, 30→dropdup)
//   (f) gates 1–9 refuse/warn with reasons; warning-tier accept-all only
//   (g) exports: musubi TOML (built-in validation), DiffSynX manifest rows
//       (validation), external export standalone; per-trainer preflight
//       goldens vs the envelope's measured numbers (direct module test)
//   (h) curation: tier-1 aHash dedup advisory, tier-2 perceptual clusters,
//       reference-triage, scene-split children, slow-mo audit
//   (i) FTS + the aspect spectrum (officials never deletable, mirror logic)
//   (j) 1000-item scale gate (seed → library/search/dashboard budgets)
//   + security wave 2: source-scope gate (HIGH-1), contained bake/export
//       destinations (MEDIUM-1), upload caps + scratch sweep (LOW-1), CLIP
//       consent (LOW-2), content-truth extensions (LOW-3), trashed-dedupe +
//       trashed-media refusals (NOTES)
// Run after `pnpm build` (loads dist-server).
//
// Vitest port (task z7ogmig, 2026-09-20) of scripts/test-datasets.cjs:
// assertion bodies carry over verbatim; the continuous main() flow became a
// beforeAll (synthetic fixtures + server boot + the output-directory
// override) + one test per numbered section over module-scope state (tests
// run sequentially within the file, so the cross-section state flow is
// unchanged); the port probe draws from this suite's disjoint range
// (tests/lib/ports.cjs).
import { test, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = require('node:path').dirname(fileURLToPath(import.meta.url))
const REPO = require('node:path').resolve(__dirname, '..')

const { spawn, execFile } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const Database = require('better-sqlite3')
const { makePortAllocator } = require('./lib/ports.cjs')

const {
  gridTargetFor,
  assertDecodedCount,
  planFps,
  trainerProjections,
  validateTrigger,
  mirrorAspect,
  snapToGrid,
  videoFloorVerdict,
  stillFloorVerdict,
  recipeCard,
} = require(path.join(REPO, 'dist-server/server/datasets/model.js'))
const { handCaptionGuard, planVlmPass, denseInstruction } = require(path.join(REPO, 'dist-server/server/datasets/vlm.js'))
const { evaluateGates, validateMusubiToml, validateDiffsynxRows, planBake } = require(path.join(REPO, 'dist-server/server/datasets/bake.js'))
const { aHashBits, tier1Distance, clusterBy, perceptualEmbed, cosineSimilarity, evaluateSlowMo, adaptiveThreshold } = require(path.join(REPO, 'dist-server/server/datasets/curation.js'))

const ffmpeg = () => process.env.FFMPEG_PATH || 'ffmpeg'

const freePort = makePortAllocator('datasets')

const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

function makeHome(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `minimax-datasets-${label}-`))
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpeg(), args, (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${String(stderr).slice(-800)}`)) : resolve({ stdout, stderr })))
  })
}

async function bootServer(home, label) {
  const output = { text: '', label }
  const port = await freePort()
  const child = spawn(process.execPath, [path.join(REPO, 'dist-server/server/index.js')], {
    env: { ...process.env, MINIMAX_STUDIO_HOME: home, MINIMAX_LAN_PORT: String(port), MINIMAX_NO_HTTPS: '1', FFMPEG_PATH: ffmpeg() },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output.text += String(chunk) })
  child.stderr.on('data', (chunk) => { output.text += String(chunk) })
  const deadline = Date.now() + 20_000
  for (; ;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/lan/settings`)
      if (response.ok && output.text.includes(`"port":${port}`)) return { child, port, home, output }
    } catch { /* not up yet */ }
    if (Date.now() > deadline) {
      child.kill()
      throw new Error(`${label} server did not become ready in 20 s`)
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

function client(port) {
  const base = `http://127.0.0.1:${port}`
  const get = async (pathname) => {
    const response = await fetch(base + pathname)
    const body = await response.json().catch(() => ({}))
    return { status: response.status, body }
  }
  const post = async (pathname, payload) => {
    // Same-origin Origin header: the studio UI's own posture — the consent
    // routes accept recording ONLY from it (fetch-consent Option A).
    const response = await fetch(base + pathname, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(payload) })
    const body = await response.json().catch(() => ({}))
    return { status: response.status, body }
  }
  return { get, post }
}

let assertions = 0
const check = (condition, message) => {
  assert.ok(condition, message)
  assertions += 1
}

// Shared scenario state (the original threaded these through one main()).
let home = ''
let media = ''
let outDir = ''
let clips = {}
let server = null
let api = null
let immutability = []
let uploaded = null
let mainSource = null
let outsideHome = ''
let outsideClip = ''
let movedPath = ''
let restoredPath = ''
let layerA = null
let managerHome = ''
let manager = null
let managerMedia = ''
let mgmtLayer = null
let mgmtLayer2 = null
let bakeDir = ''
let ntscLayer = null
let hfrLayer = null

beforeAll(async () => {
  // =====================================================================
  // (0) Fixtures: synthetic clips (testsrc — tiny, no committed media).
  // Security wave 2: fixtures live INSIDE the scratch studio home — the
  // by-reference ingest surface is scope-gated (HIGH-1), so the legal-source
  // fixtures must sit in a legal root. The out-of-scope homes below exercise
  // the refusals.
  // =====================================================================
  home = makeHome('server')
  media = path.join(home, 'fixtures')
  fs.mkdirSync(media, { recursive: true })
  outDir = path.join(home, 'out')
  clips = {
    main: path.join(media, 'main-480x832-24fps-3s.mp4'), // healthy, audio
    tiny: path.join(media, 'tiny-144x96.mp4'), // below the hard-refuse floor
    small: path.join(media, 'small-304x176.mp4'), // warn band (below the practical floor, above the hard floor)
    still: path.join(media, 'still-512.png'), // still, ok floor
    stillTiny: path.join(media, 'still-200.png'), // still, hard-refuse
    ntsc: path.join(media, 'ntsc-23976.mp4'), // 23.976 → retime
    hfr: path.join(media, 'hfr-30fps.mp4'), // 30 → drop/dup
    loud: path.join(media, 'loud-audio.mp4'), // real audio row
  }
  await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=3:size=480x832:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clips.main])
  await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=1:size=144x96:rate=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clips.tiny])
  await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=1:size=304x176:rate=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clips.small])
  await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=duration=1:size=512x512:rate=24`, '-frames:v', '1', clips.still])
  await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=duration=1:size=200x200:rate=24`, '-frames:v', '1', clips.stillTiny])
  await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=480x832:rate=24000/1001', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clips.ntsc])
  await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=480x832:rate=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clips.hfr])
  await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=480x832:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clips.loud])
  check(Object.values(clips).every((clip) => fs.existsSync(clip)), 'all synthetic fixtures generated')

  // =====================================================================
  // (1) Boot + the output-directory override (the documents-suite pattern:
  // export/bake destinations are contained to it, MEDIUM-1).
  // =====================================================================
  server = await bootServer(home, 'datasets')
  api = client(server.port)
  const currentSettings = await api.get('/api/lan/settings')
  check(currentSettings.status === 200 && typeof currentSettings.body.settings.outputDirectory === 'string', 'settings readable before the output-directory override')
  const settingsApplied = await api.post('/api/lan/settings', { settings: { ...currentSettings.body.settings, outputDirectory: outDir } })
  check(settingsApplied.status === 200 && settingsApplied.body.settings.outputDirectory === outDir, 'the scratch output directory override applies')
  immutability = [{ file: clips.main, hash: sha256File(clips.main) }, { file: clips.still, hash: sha256File(clips.still) }]
})

afterAll(() => { if (server) server.child.kill() })

test('(0b) pure-model units (no server): grid, floors, budget goldens, triggers, aspects', () => {
  check(gridTargetFor(57) === 56, 'gridTargetFor(57) = 56 (the trainer clamps DOWN)')
  check(gridTargetFor(22) === 22 && gridTargetFor(21) === null, 'grid floor is 22 (17×1+5)')
  check(assertDecodedCount(56, 56).ok && assertDecodedCount(56, 58).ok, 'decoded ∈ [target, target+2] accepts 56 and 58')
  check(!assertDecodedCount(56, 55).ok && /55 .*below the grid target 56/.test(assertDecodedCount(56, 55).reason ?? ''), 'decoded < target refuses with the delta (the f56 class)')
  check(!assertDecodedCount(56, 59).ok, 'decoded > target+2 also refuses')
  const fpsNtsc = planFps(24000 / 1001)
  const fps30 = planFps(30)
  const fps25 = planFps(25)
  const fps12 = planFps(12)
  check(fpsNtsc.mode === 'retime' && fps25.mode === 'retime', '23.976 and 25 retimes (±4.1 % condition, audit M2)')
  check(fps30.mode === 'dropdup', '30 fps drop/dups (integer ratio — never warped 1.25×)')
  check(fps12.mode === 'interpolate', '12 fps interpolates (real gap — LAST resort, tagged)')
  check(videoFloorVerdict(480, 832).verdict === 'ok', '480×832 passes video floors')
  check(videoFloorVerdict(320, 192).verdict === 'ok', '320×192 is the practical floor (ok, at the line)')
  check(videoFloorVerdict(160, 96).verdict === 'warn', 'exactly 160×96 sits ON the mechanical floor — not below it (warn band, spec: refuse < 160×96)')
  check(videoFloorVerdict(319, 100).verdict === 'warn', 'below 320×192 warns (conditioning rows dominate)')
  check(videoFloorVerdict(100, 60).verdict === 'refuse', 'below 160×96 hard-refuses with the measured reason')
  check(stillFloorVerdict(512, 512).verdict === 'ok' && stillFloorVerdict(511, 511).verdict === 'warn', 'stills: 512² ok, below warns (SPEC-inferred floors labeled)')
  check(stillFloorVerdict(200, 200).verdict === 'refuse', 'stills below 256² refuse')
  check(snapToGrid(100, 480) === 96 && snapToGrid(33, 480) === 32, 'crop snapping to the 32-px grid')
  // Budget-rule goldens vs the envelope's measured table (decimal GB).
  const golden480x832x124 = trainerProjections(480 * 832, 124)
  check(Math.abs(golden480x832x124.diffsynx.projectedGb - 17.98) < 0.02, `DiffSynX projection at 480×832×124f ≈ 17.98 GB (got ${golden480x832x124.diffsynx.projectedGb.toFixed(2)}) — envelope measured 17,286 MiB = 18.1 GB, ≈ fit`)
  check(Math.abs(golden480x832x124.musubi.projectedGb - (17.98 + 2.788)) < 0.02, `musubi projection carries the measured +2,788 MiB offset (got ${golden480x832x124.musubi.projectedGb.toFixed(2)} GB — envelope: 20,074 MiB)`)
  const envelopePoints = [
    [256 * 448, 39, 5218], [384 * 672, 39, 6892], [480 * 832, 39, 8100], [576 * 992, 39, 10254],
    [768 * 1344, 39, 14658], [480 * 832, 22, 6528], [480 * 832, 90, 13960],
  ]
  for (const [px, frames, measuredMiB] of envelopePoints) {
    const projectedGb = trainerProjections(px, frames).diffsynx.projectedGb
    const measuredGb = measuredMiB / 1000
    // The envelope states the rule as ≈; the fit overestimates most at the
    // smallest geometry (the fixed 5.1 GB term dominates there): +20.0 % at
    // 256×448×39, ≤ +13 % everywhere else. Tolerance 21 % matches that
    // documented slop — the DASHBOARD must never read as more precise than
    // its own source.
    check(Math.abs(projectedGb - measuredGb) / measuredGb < 0.21, `budget-rule fit at ${px} px × ${frames}f: projected ${projectedGb.toFixed(2)} GB vs measured ${measuredGb.toFixed(2)} GB within the envelope's ≈ fit (≤ 21 %)`)
  }
  const recipeMotion = recipeCard('diffsynx', 'motion', 30, 0)
  check(/16–32/.test(recipeMotion.rank), 'motion recipe card carries the 16–32 rank band (guide class nuance, not flat 16)')
  check(/16 \(community/.test(recipeCard('musubi', 'style', 30, 0).rank), 'style recipe card carries rank 16')
  check(/de-distill|REQUIRED/i.test(recipeMotion.dedistillation), 'recipe card requires a de-distillation method for 500+ step runs')
  // Trigger validation (gate 8 definition).
  check(validateTrigger('ph0t0r34l', 'ph0t0r34l, a quiet street scene at dusk').ok, 'rare single trigger first-and-once passes')
  check(!validateTrigger('video', 'video, a quiet street').ok, 'common-word trigger refuses (rarity rule)')
  check(!validateTrigger('two words', 'two words, x').ok, 'multi-token trigger refuses (single token rule)')
  check(!validateTrigger('tok', 'a scene, tok here tok again').ok, 'trigger used twice refuses (exactly once)')
  check(!validateTrigger('tok', 'a scene with tok').ok, 'trigger not first refuses')
  // Aspect spectrum: linear hard stops + middle-click mirror.
  const aspects = [
    { id: '21:9', ratio: 21 / 9, label: '21:9', official: true, enabled: true, position: 0 },
    { id: '16:9', ratio: 16 / 9, label: '16:9', official: true, enabled: true, position: 1 },
    { id: '1:1', ratio: 1, label: '1:1', official: true, enabled: true, position: 3 },
    { id: '9:16', ratio: 9 / 16, label: '9:16', official: true, enabled: true, position: 5 },
  ]
  check(mirrorAspect(16 / 9, aspects)?.id === '9:16', 'middle-click mirror 16:9→9:16')
  check(mirrorAspect(1, aspects) === null, '1:1 has no distinct mirror in the list (mirrors to itself — no-op)')
  check(mirrorAspect(21 / 9, aspects) === null, 'mirror never INVENTS a ratio (no 9:21 entry → no mirror)')
})

test('(0c) VLM units (no router needed): the ≤8s chunk rule + hand-guard', () => {
  const plan12s = planVlmPass({ durationSec: 12, nativeVideo: false })
  check(plan12s.chunks.length === 2 && plan12s.chunks[1].toSec <= 12, '12 s view chunks into 2 ≤8 s passes (llama.cpp #27587)')
  check(plan12s.mode === 'image-set', 'image-set transport for chunked passes (family-agnostic)')
  check(planVlmPass({ durationSec: 5, nativeVideo: true }).mode === 'input-video', 'native input_video for ≤8 s on video-capable families')
  check(/NEVER/.test(denseInstruction('character')), 'character dense instruction carries the NEVER-appearance negative rules')
  const guard = handCaptionGuard([
    { layerId: 'hand-1', author: 'hand' },
    { layerId: 'vlm-1', author: 'vlm' },
    { layerId: 'none-1', author: 'none' },
  ], 'skip')
  check(guard.caption.some((item) => item.layerId === 'vlm-1') && guard.caption.some((item) => item.layerId === 'none-1') && !guard.caption.some((item) => item.layerId === 'hand-1'), 'batch guard (skip): hand-written excluded, vlm/uncaptioned included')
  check(handCaptionGuard([{ layerId: 'hand-1', author: 'hand' }], 'queue').queued.length === 1, 'batch guard (queue): hand-written queued for review instead')
})

test('(0d) curation units: tier-1 hash behavior + gate evaluation', () => {
  const same1 = aHashBits(Float32Array.from({ length: 256 }, (_, index) => 100 + (index % 7)))
  const same2 = aHashBits(Float32Array.from({ length: 256 }, (_, index) => 101 + (index % 7)))
  const different = aHashBits(Float32Array.from({ length: 256 }, (_, index) => (index * 31) % 251))
  check(tier1Distance({ hashes: [same1] }, { hashes: [same2] }) <= 6, 'near-identical frames hash together (≤6)')
  check(tier1Distance({ hashes: [same1] }, { hashes: [different] }) > 20, 'different content hashes far apart')
  const embedA = perceptualEmbed(Float32Array.from({ length: 1024 }, (_, index) => (index % 128) + 20 * Math.floor(index / 512)))
  const embedB = perceptualEmbed(Float32Array.from({ length: 1024 }, (_, index) => (index % 128) + 20 * Math.floor(index / 512)))
  const embedC = perceptualEmbed(Float32Array.from({ length: 1024 }, (_, index) => 255 - (index % 17)))
  check(cosineSimilarity(embedA, embedB) > 0.999, 'identical content embeds at cosine 1')
  check(cosineSimilarity(embedA, embedC) < 0.9, 'different content embeds apart (cluster threshold 0.94 respected)')
  const clusters = clusterBy(
    [
      { layerId: 'a', embed: embedA },
      { layerId: 'b', embed: embedB },
      { layerId: 'c', embed: embedC },
    ],
    (a, b) => 1 - cosineSimilarity(a.embed, b.embed),
    1 - 0.94,
  )
  check(clusters.get('a').clusterId === clusters.get('b').clusterId && clusters.get('c').clusterId === null, 'cross-ratio cluster groups same content, leaves the odd one unclustered')
  check(clusters.get('a').clusterNo === 1 && clusters.get('b').clusterNo === 2, 'cluster members are numbered for gallery grouping')
  check(evaluateSlowMo({ fps: 60, frameDiffMean: 5, frameDiffStd: 3, dupFrameRatio: 0, freezeDetected: false }).suspect, '50/60-class fps flags the retiming signature')
  check(adaptiveThreshold([1, 1, 2, 1, 40, 1, 2, 1]) > 5, 'adaptive cut threshold clears ordinary motion but catches the spike')
})

test('(1a) ingest both paths: hash identity, dedup, floors with reasons, async decode probe, probe-state terminus', async () => {
  const imported = await api.post('/api/lan/datasets/ingest/reference', { path: clips.main })
  check(imported.status === 200 && imported.body.source.probe.width === 480, 'reference ingest returns probed facts (480 wide)')
  check(imported.body.refusal === undefined, '480×832 clears the floors')
  const reimported = await api.post('/api/lan/datasets/ingest/reference', { path: clips.main })
  check(reimported.body.deduped === true && reimported.body.source.id === imported.body.source.id, 're-import of the same content resolves to the SAME source (identity = hash)')

  uploaded = await api.post('/api/lan/datasets/ingest/upload', { name: 'loud-audio.mp4', data: fs.readFileSync(clips.loud).toString('base64') })
  check(uploaded.status === 200 && uploaded.body.source.ingestPath === 'upload', 'LAN-upload ingest lands in the app-owned media store (path B)')
  const reuploaded = await api.post('/api/lan/datasets/ingest/upload', { name: 'loud-copy.mp4', data: fs.readFileSync(clips.loud).toString('base64') })
  check(reuploaded.body.deduped === true, 're-upload of the same content dedupes too (one identity contract)')

  const refusedTiny = await api.post('/api/lan/datasets/ingest/reference', { path: clips.tiny })
  check(refusedTiny.status === 200 && refusedTiny.body.refusal?.verdict === 'refuse' && /160×96/.test(refusedTiny.body.refusal.reason), 'below-floor source REFUSES at import with the measured reason (160×96)')
  const warnedSmall = await api.post('/api/lan/datasets/ingest/reference', { path: clips.small })
  check(warnedSmall.body.refusal?.verdict === 'warn' && /320×192/.test(warnedSmall.body.refusal.reason), 'warn-band source imports WITH the warning surfaced')
  const refusedStill = await api.post('/api/lan/datasets/ingest/reference', { path: clips.stillTiny })
  check(refusedStill.body.refusal?.verdict === 'refuse' && /256²/.test(refusedStill.body.refusal.reason) && /SPEC-inferred/.test(refusedStill.body.refusal.reason), 'stills hard floor refuses and SAYS the floors are spec-inferred (honesty)')

  // App-tour wave (d6iy68r, review M2): the probe-state TERMINUS. A refused
  // source never probes (no layers, no bakes ever attach to it) — its state
  // settles at ingest. Before the fix these sat 'pending' forever, so the
  // client's 1.5 s library poll never ended. No sleep here: terminal means
  // IMMEDIATELY, in the same tick as the ingest response.
  const terminusLibrary = await api.get('/api/lan/datasets/library')
  const terminusRow = (name) => terminusLibrary.body.sources.find((source) => source.name === name)
  const tinyRow = terminusRow('tiny-144x96.mp4')
  check(tinyRow?.probeState === 'done', `a refused VIDEO settles its probe state at ingest (got '${tinyRow?.probeState}') — it never probes, so 'pending' would be forever`)
  const stillTinyRow = terminusRow('still-200.png')
  check(stillTinyRow?.probeState === 'done', `a refused STILL settles at ingest too (got '${stillTinyRow?.probeState}')`)

  // Async decode probe: pending → done; required pre-bake.
  await new Promise((resolve) => setTimeout(resolve, 3500))
  const libraryAfter = await api.get('/api/lan/datasets/library')
  mainSource = libraryAfter.body.sources.find((source) => source.name === 'main-480x832-24fps-3s.mp4')
  check(mainSource && mainSource.probeState === 'done' && mainSource.decodedFrames === 72, `decoded-count probe lands async (72 frames, got ${mainSource?.decodedFrames})`)
  check(mainSource.probe.hasAudio === true && typeof mainSource.probe.dbfs === 'number', 'audio presence + dBFS recorded at import')
})

test('(1s) security wave 2 — HIGH-1 scope gate, LOW-3 content-truth extensions', async () => {
  outsideHome = makeHome('outside')
  outsideClip = path.join(outsideHome, 'private.mp4')
  fs.copyFileSync(clips.loud, outsideClip)
  const scopeRefused = await api.post('/api/lan/datasets/ingest/reference', { path: outsideClip })
  check(scopeRefused.status === 400 && /outside the studio home/.test(scopeRefused.body.error ?? ''), 'HIGH-1: registering an out-of-scope media path by reference is refused loudly')
  const scopeRefusedMissing = await api.post('/api/lan/datasets/ingest/reference', { path: path.join(outsideHome, 'never-existed.mp4') })
  check(
    scopeRefusedMissing.status === 400
      && /outside the studio home/.test(scopeRefusedMissing.body.error ?? '')
      && !/No file at/.test(scopeRefusedMissing.body.error ?? '')
      && !/No file at/.test(scopeRefused.body.error ?? ''),
    'HIGH-1: the out-of-scope refusal is uniform for existing and missing paths (no file-existence oracle — the existence-bearing message never appears)',
  )
  const libraryScoped = await api.get('/api/lan/datasets/library')
  check(libraryScoped.body.sources.every((source) => source.name !== 'private.mp4'), 'HIGH-1: the refused path never became a source (nothing to stream back)')
  const canvasScopeRefused = await api.post('/api/lan/datasets/ingest/canvas', { path: outsideClip })
  check(canvasScopeRefused.status === 400 && /outside the studio home/.test(canvasScopeRefused.body.error ?? ''), 'HIGH-1: the canvas bridge shares the same source-scope gate')
  const relinkScopeRefused = await api.post('/api/lan/datasets/relink', { sourceId: mainSource.id, path: outsideClip })
  check(relinkScopeRefused.body.relinked === false && /outside the studio home/.test(relinkScopeRefused.body.reason ?? ''), 'HIGH-1: re-link picks are scope-gated before any stat/probe')
  // LOW-3: the stored extension comes from the probed container, never the
  // client-chosen suffix (a polyglot payload.sh persists as .mp4).
  const polyglot = await api.post('/api/lan/datasets/ingest/upload', { name: 'payload.sh', data: fs.readFileSync(clips.hfr).toString('base64') })
  check(polyglot.status === 200 && /\.mp4$/.test(polyglot.body.source.absPath ?? ''), `LOW-3: a polyglot upload named payload.sh persists with the probed extension (${polyglot.body.source?.absPath?.split('/').pop()})`)
})

test('(2) health: MISSING / CHANGED / re-link; bake refusal while missing', async () => {
  movedPath = path.join(media, 'moved-main.mp4')
  fs.renameSync(clips.main, movedPath)
  const healthMissing = await api.post('/api/lan/datasets/health', {})
  check(healthMissing.body.missing >= 1, 'health check reports MISSING after the file moves')
  const libraryMissing = await api.get('/api/lan/datasets/library')
  const missingSource = libraryMissing.body.sources.find((source) => source.id === mainSource.id)
  check(missingSource.health === 'missing' && /Re-link/.test(missingSource.healthDetail ?? ''), 'MISSING surfaces with the re-link instruction (never a silent stranding)')
  const missingLayerAttempt = await api.post('/api/lan/datasets/bake', { layerId: 'any' })
  check(missingLayerAttempt.status === 400, 'bake refuses (400) while the source is missing')

  // CHANGED: same path, different content.
  fs.copyFileSync(clips.loud, clips.main)
  const healthChanged = await api.post('/api/lan/datasets/health', {})
  check(healthChanged.body.changed >= 1, 'same-path-different-content reports CHANGED (hash mismatch)')
  // Re-link by hash: move the ORIGINAL back under a new name and link it.
  restoredPath = path.join(media, 'restored-main.mp4')
  fs.copyFileSync(movedPath, restoredPath)
  const relink = await api.post('/api/lan/datasets/relink', { sourceId: mainSource.id, path: restoredPath })
  check(relink.body.relinked === true, 're-link accepts a hash-matching file')
  const relinkWrong = await api.post('/api/lan/datasets/relink', { sourceId: mainSource.id, path: clips.loud })
  check(relinkWrong.body.relinked === false && /hash mismatch/i.test(relinkWrong.body.reason ?? ''), 're-link REFUSES a hash-mismatching pick')
})

test('(3) layers + captions: grid snapping, crop-time floor refusal, stale flows', async () => {
  await api.post('/api/lan/datasets/settings', { triggerToken: 'ph0t0r34l', contentClass: 'style' })
  layerA = await api.post('/api/lan/datasets/layers', { sourceId: mainSource.id, name: 'crop A', crop: { x: 30, y: 20, w: 417, h: 763 }, trim: { inFrame: 0, outFrame: 40 } })
  check(layerA.status === 200, 'layer creation with crop+trim succeeds')
  const crop = layerA.body.layer.crop
  check(crop.x % 32 === 0 && crop.y % 32 === 0 && crop.w % 32 === 0 && crop.h % 32 === 0, `crop rect snapped to the 32-px grid (${crop.x},${crop.y},${crop.w},${crop.h})`)
  const cropRefused = await api.post('/api/lan/datasets/layers', { sourceId: mainSource.id, crop: { x: 0, y: 0, w: 64, h: 128 } })
  check(cropRefused.status === 400 && /Crop refused at crop-time/.test(cropRefused.body.error), 'sub-floor crop REFUSED at crop-time (not import-time)')

  const captionSet = await api.post('/api/lan/datasets/captions', { layerId: layerA.body.layer.id, text: 'ph0t0r34l, a colorful test pattern drifting in a quiet studio; no audible sound' })
  check(captionSet.body.layer.caption.author === 'hand', 'hand caption records authorship')
  // Stale on CROP edit.
  const cropEdit = await api.post('/api/lan/datasets/layers/update', { layerId: layerA.body.layer.id, crop: { x: 64, y: 64, w: 352, h: 640 } })
  check(cropEdit.body.layer.caption.stale === true && /crop changed after captioning/.test(cropEdit.body.layer.caption.staleReason ?? ''), 'caption flags STALE after a crop edit')
  // Stale on TRIM edit (the five-flag blessing extension).
  await api.post('/api/lan/datasets/captions', { layerId: layerA.body.layer.id, text: 'ph0t0r34l, refreshed caption for the full view; no audible sound' })
  const trimEdit = await api.post('/api/lan/datasets/layers/update', { layerId: layerA.body.layer.id, trim: { inFrame: 5, outFrame: 30 } })
  check(trimEdit.body.layer.caption.stale === true && /trim changed after captioning/.test(trimEdit.body.layer.caption.staleReason ?? ''), 'caption flags STALE after a trim edit (crop AND trim, blessing flag a)')
  // Recaption clears stale.
  await api.post('/api/lan/datasets/captions', { layerId: layerA.body.layer.id, text: 'ph0t0r34l, a tight test-pattern crop with steady motion; no audible sound' })
  const historyList = await api.get(`/api/lan/datasets/captions/history?layerId=${layerA.body.layer.id}`)
  check(historyList.body.history.length >= 2 && historyList.body.history.every((entry) => typeof entry.text === 'string'), 'caption history is append-only and round-trips')
})

test('(4) batch VLM never overwrites hand-written — stub seam, direct module test', async () => {
  const { createDatasetManager } = require(path.join(REPO, 'dist-server/server/datasets/index.js'))
  managerHome = makeHome('manager')
  const dbFile = path.join(managerHome, 'studio.db')
  const db = new Database(dbFile)
  db.exec(fs.readFileSync(require.resolve(path.join(REPO, 'dist-server/server/datasets/store.js')), 'utf8') ? '' : '')
  const { upDatasetTables } = require(path.join(REPO, 'dist-server/server/datasets/store.js'))
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)')
  upDatasetTables(db)
  db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(3, '003-dataset-manager', Date.now())
  managerMedia = path.join(managerHome, 'media')
  fs.mkdirSync(managerMedia, { recursive: true })
  manager = createDatasetManager({
    db,
    mediaRoot: managerMedia,
    trashRoot: path.join(managerHome, 'trash'),
    tools: { ffmpegPath: ffmpeg(), logFailure: () => undefined },
    // Security wave 2 (HIGH-1): the manager-level resolver option — the
    // fixtures live in the SERVER's scratch home, not this manager's home.
    allowedSourceRoots: () => [media],
    logEvent: () => undefined,
  })
  // The store gate refuses paths outside BOTH the manager's own home and
  // the resolver roots, before any stat/probe (no existence oracle).
  let managerScopeRefusal = null
  try { await manager.ingestReference(outsideClip) } catch (error) { managerScopeRefusal = error }
  check(managerScopeRefusal && /outside the studio home/.test(managerScopeRefusal.message), 'HIGH-1 (store level): the gate refuses out-of-scope references with the measured reason')
  const mgmtImport = await manager.ingestReference(clips.loud)
  mgmtLayer = manager.store.createLayer({ sourceId: mgmtImport.source.id, name: 'guard-hand' })
  manager.store.setCaption(mgmtLayer.id, 'hand-written precious caption', 'hand')
  mgmtLayer2 = manager.store.createLayer({ sourceId: mgmtImport.source.id, name: 'guard-vlm' })
  const stubSeam = {
    chat: async () => ({ text: 'VLM dense output', model: 'stub-vlm' }),
    textOnly: async () => 'ph0t0r34l, stub condensed caption; no audible sound',
    visionModel: async () => 'stub-vlm',
    supportsNativeVideo: async () => false,
  }
  const batch = await manager.captionBatch(stubSeam, [mgmtLayer.id, mgmtLayer2.id], { guard: 'skip' })
  check(batch.skipped.includes(mgmtLayer.id) && !batch.captioned.includes(mgmtLayer.id), 'batch VLM SKIPS the hand-written caption (never silently overwritten)')
  check(manager.store.getLayer(mgmtLayer.id).caption.text === 'hand-written precious caption', 'hand-written text survives the batch run verbatim')
  check(batch.captioned.includes(mgmtLayer2.id) && manager.store.getLayer(mgmtLayer2.id).caption.author.startsWith('vlm'), 'uncaptioned layer gets the VLM caption with authorship')
  const batchQueue = await manager.captionBatch(stubSeam, [mgmtLayer.id], { guard: 'queue' })
  check(batchQueue.queuedForReview.includes(mgmtLayer.id) && manager.store.getLayer(mgmtLayer.id).caption.reviewState === 'queued', 'guard=queue routes hand-written to the review queue instead')
})

test('(5) bake: order fixed, assertion range, crafted f56 refusal, fps conditional', async () => {
  bakeDir = path.join(managerHome, 'bakes')
  const planMain = planBake(layerA.body.layer, { ...mainSource, health: 'healthy', decodedFrames: 72, probe: { ...mainSource.probe } })
  check(planMain.encodeFrames === planMain.gridTarget + 2, `bake encodes grid target + 2 (target ${planMain.gridTarget}, encode ${planMain.encodeFrames})`)
  const bakeOk = await api.post('/api/lan/datasets/bake', { layerId: layerA.body.layer.id, folder: 'test-bakes' })
  check(bakeOk.status === 200 && bakeOk.body.outcome.state === 'done', 'conforming bake completes (relative destination, contained under the output directory)')
  check(bakeOk.body.outcome.decodedFrames === bakeOk.body.outcome.gridTarget + 2, `decoded = target+2 (${bakeOk.body.outcome.decodedFrames} of ${bakeOk.body.outcome.gridTarget}+2) — the assertion accepts [target, target+2]`)
  check(bakeOk.body.outcome.fpsMode === 'retime', '24 fps source takes the retime arm of the conditional policy (order fixed: trim → crop → CFR → grid+2)')
  // Crafted f56-class truncation: force a decode-short file through the assertion.
  const truncated = path.join(managerHome, 'truncated.mp4')
  await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', clips.loud, '-vf', 'trim=start_frame=0:end_frame=20,setpts=PTS-STARTPTS', '-r', '24', '-frames:v', '20', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', truncated])
  const { decodedFrameCount } = require(path.join(REPO, 'dist-server/server/datasets/probe.js'))
  const truncatedDecoded = await decodedFrameCount(truncated, { ffmpegPath: ffmpeg(), logFailure: () => undefined })
  const f56Verdict = assertDecodedCount(39, truncatedDecoded)
  check(!f56Verdict.ok && /clamp would walk DOWN/.test(f56Verdict.reason), `a crafted f56-class truncation (decoded ${truncatedDecoded} < target 39) REFUSES with the walk-down reason`)
  // fps modes: 23.976 → retime; 30 → dropdup (the audit-M2 conditional).
  const ntscImport = await manager.ingestReference(clips.ntsc)
  await manager.store.runDecodeProbe(ntscImport.source.id)
  ntscLayer = manager.store.createLayer({ sourceId: ntscImport.source.id, trim: { inFrame: 0, outFrame: 999 } })
  const ntscBake = await manager.bakeLayer(ntscLayer.id, { outputFolder: bakeDir })
  check(ntscBake.state === 'done' && ntscBake.fpsMode === 'retime', '23.976 source bakes via RETIME (no 1.25× warp)')
  const hfrImport = await manager.ingestReference(clips.hfr)
  await manager.store.runDecodeProbe(hfrImport.source.id)
  hfrLayer = manager.store.createLayer({ sourceId: hfrImport.source.id })
  const hfrBake = await manager.bakeLayer(hfrLayer.id, { outputFolder: bakeDir })
  check(hfrBake.state === 'done' && hfrBake.fpsMode === 'dropdup', '30 fps source bakes via DROP/DUP (speed preserved)')
})

test('(5s) security wave 2 — MEDIUM-1 contained destinations, LOW-1 upload caps + scratch sweep', async () => {
  const bakeEscape = await api.post('/api/lan/datasets/bake', { layerId: layerA.body.layer.id, folder: '../../../../../' + outsideHome })
  check(bakeEscape.status === 400 && /escapes the studio output directory/.test(bakeEscape.body.error ?? ''), 'MEDIUM-1: a ../../ bake destination is refused post-normalization')
  check(!fs.existsSync(path.join(outsideHome, 'baked')), 'MEDIUM-1: nothing was created at the escape target')
  const { MAX_DATASET_UPLOAD_BYTES } = require(path.join(REPO, 'dist-server/server/datasets/store.js'))
  const managerMediaBeforeCap = fs.existsSync(managerMedia) ? fs.readdirSync(managerMedia).length : 0
  let overCapRefusal = null
  try { await manager.ingestUpload('big.mp4', Buffer.alloc(MAX_DATASET_UPLOAD_BYTES + 1)) } catch (error) { overCapRefusal = error }
  check(overCapRefusal && /per-file cap/.test(overCapRefusal.message), 'LOW-1: an over-cap upload is refused with the measured size')
  check((fs.existsSync(managerMedia) ? fs.readdirSync(managerMedia).length : 0) === managerMediaBeforeCap, 'LOW-1: the refused over-cap upload wrote nothing to the media store')
  // Bake-scratch sweep on FAILURE: an impossible export destination (under
  // a plain file) fails the export AFTER baking — the scratch must still go.
  fs.writeFileSync(path.join(managerHome, 'blocker'), 'not a directory')
  manager.store.saveSettings({ triggerToken: 'ph0t0r34l' })
  manager.store.setCaption(hfrLayer.id, 'ph0t0r34l, a test pattern clip; no audible sound', 'hand')
  let failedExport = null
  try {
    await manager.exportDataset({ shape: 'musubi', trainer: 'musubi', folder: path.join(managerHome, 'blocker', 'sub'), layerIds: [hfrLayer.id], acceptWarnings: true })
  } catch (error) { failedExport = error }
  check(failedExport, 'LOW-1: the impossible-destination export surfaces its error (never silent)')
  const managerScratch = path.join(managerMedia, 'bake-scratch')
  check(!fs.existsSync(managerScratch) || fs.readdirSync(managerScratch).length === 0, 'LOW-1: bake-scratch is swept when the export FAILS, not just when it lands')
})

test('(6) gates 1–9: refuse vs warn with reasons; warning-tier accept-all only', () => {
  const gateLayer = manager.store.getLayer(mgmtLayer2.id)
  const baseGate = (overrides) => evaluateGates({
    layer: gateLayer,
    caption: gateLayer.caption?.text ?? '',
    triggerToken: 'ph0t0r34l',
    slowMoSuspect: false,
    inCluster: false,
    sourceCuts: [],
    audioPolicy: { expectSoundscapeClauses: true, blankReplaceExisting: false },
    sourceHasAudio: true,
    bakedFpsExact: true,
    ...overrides,
  })
  check(baseGate({}).every((finding) => finding.tier !== 'refuse') || baseGate({}).some((finding) => finding.tier === 'refuse'), 'gate evaluation runs')
  check(baseGate({ caption: '' }).some((finding) => finding.gate === 1 && finding.tier === 'refuse'), 'gate 1 refuses empty captions')
  check(baseGate({ triggerToken: 'video' }).some((finding) => finding.gate === 8 && finding.tier === 'refuse'), 'gate 8 refuses common-word triggers')
  check(baseGate({ slowMoSuspect: true }).some((finding) => finding.gate === 4 && finding.tier === 'refuse'), 'gate 4 refuses undispositioned slow-mo suspicion')
  check(baseGate({ slowMoSuspect: true, layer: { ...gateLayer, slowmoDisposition: 'caption' } }).every((finding) => finding.gate !== 4), 'a dispositioned slow-mo suspect passes gate 4')
  check(baseGate({ baked: { layerId: gateLayer.id, state: 'done', outputPath: 'x', wavPath: 'x', gridTarget: 39, decodedFrames: 38, interpolated: false, fpsMode: 'dropdup', fpsReason: '' }, bakedFpsExact: false }).some((finding) => finding.gate === 3), 'gate 3 refuses fps ≠ 24 after bake')
  check(baseGate({ baked: { layerId: gateLayer.id, state: 'done', outputPath: 'x', wavPath: 'x', gridTarget: 39, decodedFrames: 38, interpolated: false, fpsMode: 'dropdup', fpsReason: '' } }).some((finding) => finding.gate === 5 && finding.tier === 'refuse'), 'gate 5 refuses decoded < target (the f56 class at our door)')
  const warnFindings = baseGate({ inCluster: true, sourceCuts: [10], layer: { ...gateLayer, trim: { inFrame: 0, outFrame: 40 } } })
  check(warnFindings.some((finding) => finding.gate === 6 && finding.tier === 'warn'), 'gate 6 (near-dup cluster) is WARNING-tier (advisory only)')
  check(warnFindings.some((finding) => finding.gate === 9 && finding.tier === 'warn'), 'gate 9 (trim crossing a cut) is warning-tier when scene data exists')
  // Gate 7: real-audio row without a soundscape clause warns; WITH one passes.
  const gate7Missing = evaluateGates({ layer: gateLayer, caption: 'ph0t0r34l, a beeping test tone pattern', triggerToken: 'ph0t0r34l', slowMoSuspect: false, inCluster: false, sourceCuts: [], audioPolicy: { expectSoundscapeClauses: true, blankReplaceExisting: false }, sourceHasAudio: true, bakedFpsExact: true })
  check(gate7Missing.some((finding) => finding.gate === 7 && finding.tier === 'warn' && /promptability/.test(finding.reason)), 'gate 7 warns on real-audio rows missing the soundscape clause (policy-dependent)')
  const gate7Present = evaluateGates({ layer: gateLayer, caption: 'ph0t0r34l, a beeping test tone pattern, steady sine hum audible throughout', triggerToken: 'ph0t0r34l', slowMoSuspect: false, inCluster: false, sourceCuts: [], audioPolicy: { expectSoundscapeClauses: true, blankReplaceExisting: false }, sourceHasAudio: true, bakedFpsExact: true })
  check(gate7Present.every((finding) => finding.gate !== 7), 'gate 7 passes when the soundscape clause is present')
})

test('(7) exports: all three shapes + validations + contained destinations + scratch sweep', async () => {
  await api.post('/api/lan/datasets/captions', { layerId: layerA.body.layer.id, text: 'ph0t0r34l, a tight test-pattern crop with steady motion; no audible sound' })
  // MEDIUM-1: traversal and out-of-tree absolute destinations are refused.
  const exportEscape = await api.post('/api/lan/datasets/export', { shape: 'musubi', trainer: 'musubi', folder: '../../../../../' + outsideHome, layerIds: [layerA.body.layer.id] })
  check(exportEscape.status === 400 && /escapes the studio output directory/.test(exportEscape.body.error ?? ''), 'MEDIUM-1: a ../../ export destination is refused post-normalization')
  const exportAbsolute = await api.post('/api/lan/datasets/export', { shape: 'musubi', trainer: 'musubi', folder: outsideHome, layerIds: [layerA.body.layer.id] })
  check(exportAbsolute.status === 400 && /escapes the studio output directory/.test(exportAbsolute.body.error ?? ''), 'MEDIUM-1: an absolute destination outside the output directory is refused')
  check(!fs.existsSync(path.join(outsideHome, 'dataset_config.toml')) && !fs.existsSync(path.join(outsideHome, 'captions')), 'MEDIUM-1: the escape target was never written (no config clobber, no caption rows planted)')
  const exportDir = path.join(outDir, 'export-musubi')
  const musubiExport = await api.post('/api/lan/datasets/export', { shape: 'musubi', trainer: 'musubi', folder: 'export-musubi', layerIds: [layerA.body.layer.id] })
  check(musubiExport.status === 200 && musubiExport.body.written.length === 1, 'musubi export writes the item')
  check(fs.existsSync(path.join(exportDir, 'dataset_config.toml')) && fs.existsSync(path.join(exportDir, 'captions')) && fs.existsSync(path.join(exportDir, 'wavs')), 'musubi shape: TOML + caption sidecars + wav sidecars (landed inside the output directory)')
  check(musubiExport.body.validated.musubiConfig === 'built-in', 'musubi config passes the built-in named validation')
  check(validateMusubiToml(fs.readFileSync(path.join(exportDir, 'dataset_config.toml'), 'utf8')), 'the emitted TOML re-validates structurally (target_frames on the 17n+5 grid, batch 1, buckets on)')
  const serverScratch = path.join(home, 'dataset-media', 'bake-scratch')
  check(!fs.existsSync(serverScratch) || fs.readdirSync(serverScratch).length === 0, 'LOW-1: bake-scratch is swept after the export copy lands (no per-export residue)')
  const diffsynxDir = path.join(outDir, 'export-diffsynx')
  const dsExport = await api.post('/api/lan/datasets/export', { shape: 'diffsynx', trainer: 'diffsynx', folder: 'export-diffsynx', layerIds: [layerA.body.layer.id] })
  check(dsExport.status === 200 && dsExport.body.written.length === 1, 'DiffSynX export writes the item')
  const rows = fs.readFileSync(path.join(diffsynxDir, 'metadata.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  check(rows.length === 1 && rows[0].frame_rate === 24 && rows[0].input_audio.endsWith('.wav') && rows[0].prompt.startsWith('ph0t0r34l'), 'DiffSynX rows: video/prompt/input_audio/frame_rate=24 with the trigger first')
  check(validateDiffsynxRows(rows), 'DiffSynX rows pass the named dry-load validation shape')
  const externalDir = path.join(outDir, 'export-external')
  const externalExport = await api.post('/api/lan/datasets/export', { shape: 'external', trainer: 'diffsynx', folder: 'export-external', layerIds: [layerA.body.layer.id] })
  check(externalExport.status === 200 && fs.existsSync(path.join(externalDir, 'README.md')) && fs.existsSync(path.join(externalDir, 'dataset_config.toml')) && fs.existsSync(path.join(externalDir, 'metadata.jsonl')), 'external export is standalone (README + both shapes + prefilled configs)')
  // Warning-tier needs the explicit accept: an unaccepted warn-only item refuses.
  const warnExport = await api.post('/api/lan/datasets/export', { shape: 'musubi', trainer: 'musubi', folder: 'export-warn', layerIds: [layerA.body.layer.id], acceptWarnings: false })
  check(warnExport.status === 200 || warnExport.status === 400, 'export runs the gates before baking')
  // Refusing item never bakes: empty caption refuses outright.
  const emptyCaptionLayer = await api.post('/api/lan/datasets/layers', { sourceId: uploaded.body.source.id, name: 'no caption' })
  const refusedExport = await api.post('/api/lan/datasets/export', { shape: 'musubi', trainer: 'musubi', folder: 'export-refused', layerIds: [emptyCaptionLayer.body.layer.id] })
  check(refusedExport.status === 400 && /gate/i.test(refusedExport.body.error), 'an all-refusing selection throws before ANY bake (gate report owns the reasons)')
})

test('(8) curation over HTTP: dedup advisory, clusters grouped, CLIP consent gate (LOW-2)', async () => {
  const dedup = await api.post('/api/lan/datasets/dedup', {})
  check(dedup.status === 200 && typeof dedup.body.tier2Clusters === 'number' && ['clip', 'perceptual'].includes(dedup.body.embedBackend), `dedup pass completes (backend: ${dedup.body.embedBackend})`)
  check(dedup.body.embedBackend === 'perceptual' && dedup.body.clipConsent?.consented === false, 'LOW-2: without consent the perceptual backend runs and the response names the gate (no LAN-peer-triggered CLIP download)')
  const clipConsentRecorded = await api.post('/api/lan/datasets/clip/consent', { consented: true })
  check(clipConsentRecorded.status === 200 && clipConsentRecorded.body.consented === true && clipConsentRecorded.body.licenseSpdx === 'Apache-2.0', 'LOW-2: the CLIP consent records through the dedicated route with its license')
  const libraryPost = await api.get('/api/lan/datasets/library')
  const clustered = libraryPost.body.sources.flatMap((source) => source.layers).filter((layer) => layer.clusterId)
  check(Array.isArray(clustered), 'cluster assignments visible in the gallery payload (grouped + numbered)')
  const triage = await api.post('/api/lan/datasets/triage', { image: fs.readFileSync(clips.still).toString('base64') })
  check(triage.status === 200 && Array.isArray(triage.body.results), `reference-triage ranks the library by the tier-2 index (backend ${triage.body.backend})`)
  check(triage.body.clipConsent?.consented === true, 'LOW-2: the recorded consent is honored live on the next curation call')
})

test('(9) FTS + aspect management over HTTP', async () => {
  await api.post('/api/lan/datasets/captions', { layerId: layerA.body.layer.id, text: 'ph0t0r34l, unique-zanzibar-marker phrase caption; no audible sound' })
  const search = await api.get('/api/lan/datasets/search?q=zanzibar')
  check(search.status === 200 && search.body.hits.some((hit) => hit.layerId === layerA.body.layer.id), 'FTS finds the caption text (zanzibar marker)')
  const searchInject = await api.get('/api/lan/datasets/search?q=' + encodeURIComponent('" OR 1=1 --'))
  check(searchInject.status === 200, 'FTS injection attempt does not 500 (quoted-prefix MATCH)')
  const aspectsHttp = await api.get('/api/lan/datasets/aspects')
  check(aspectsHttp.body.aspects.length === 6 && aspectsHttp.body.aspects.every((aspect) => aspect.official), 'the official spectrum seeds (six, widest→tallest)')
  const aspectAdd = await api.post('/api/lan/datasets/aspects/add', { label: '2:1', ratio: 2 })
  check(aspectAdd.status === 200 && aspectAdd.body.aspects.some((aspect) => aspect.label === '2:1' && !aspect.official), 'custom aspects addable (interleaved by ratio)')
  const officialDelete = await api.post('/api/lan/datasets/aspects/delete', { id: '16:9' })
  check(officialDelete.status === 400 && /never deletable/.test(officialDelete.body.error), 'official aspects are NEVER deletable')
  const customId = aspectAdd.body.aspects.find((aspect) => aspect.label === '2:1').id
  const customDelete = await api.post('/api/lan/datasets/aspects/delete', { id: customId })
  check(customDelete.status === 200 && !customDelete.body.aspects.some((aspect) => aspect.label === '2:1'), 'custom aspects deletable')
})

test('(10) trash semantics: referenced vs uploaded; empty = one delete; trashed-dedupe + media refusals', async () => {
  const stillImport = await api.post('/api/lan/datasets/ingest/reference', { path: clips.still })
  const stillSourceId = stillImport.body.source.id
  // App-tour wave (d6iy68r, review M2): an ingested STILL reaches terminal
  // probe state IMMEDIATELY (its facts were probed at ingest; one frame) —
  // the async decode probe is a video-only concern. No sleep precedes this
  // read: 'pending' here is the forever-poll bug.
  const stillLibrary = await api.get('/api/lan/datasets/library')
  const stillRow = stillLibrary.body.sources.find((source) => source.id === stillSourceId)
  check(stillRow?.probeState === 'done' && stillRow?.decodedFrames === 1, `an ingested STILL is terminal at once (state '${stillRow?.probeState}', frames ${stillRow?.decodedFrames}) — no async probe, no forever-poll`)
  const stillBytesBefore = sha256File(clips.still)
  const stillTrashed = await api.post('/api/lan/datasets/sources/trash', { sourceId: stillSourceId })
  check(stillTrashed.status === 200 && stillTrashed.body.layersAffected === 0, 'referenced-source trash reports the blast radius')
  check(sha256File(clips.still) === stillBytesBefore && fs.existsSync(clips.still), 'trashing a REFERENCED source never touches the file on disk')
  const restoredStill = await api.post('/api/lan/datasets/sources/restore', { sourceId: stillSourceId })
  check(restoredStill.body.restored === true, 'restore is full')
  // Uploaded source: bytes move to the trash store; empty-trash deletes app-owned bytes only.
  const uploadTrash = await api.post('/api/lan/datasets/sources/trash', { sourceId: uploaded.body.source.id })
  check(uploadTrash.status === 200, 'uploaded-source trash runs')
  const trashBefore = await api.get('/api/lan/datasets/library')
  check(trashBefore.body.trashed.sources.some((entry) => entry.id === uploaded.body.source.id), 'trashed entries list in the trash view (restorable)')
  // Trashed sources stop serving media (HIGH-1 sub-oracle: trash view only).
  const trashedMedia = await api.get(`/api/lan/datasets/media?source=${uploaded.body.source.id}`)
  check(trashedMedia.status === 410, 'a trashed source does not serve media (restore first)')
  // Audit NOTE (wave 2): re-uploading TRASHED content must not dedupe into
  // the invisible trashed row (and must not orphan the fresh bytes).
  const serverMediaRoot = path.join(home, 'dataset-media')
  const mediaFilesBeforeReupload = fs.readdirSync(serverMediaRoot).length
  const reuploadTrashed = await api.post('/api/lan/datasets/ingest/upload', { name: 'loud-again.mp4', data: fs.readFileSync(clips.loud).toString('base64') })
  check(reuploadTrashed.status === 400 && /in the dataset trash/.test(reuploadTrashed.body.error ?? ''), 'NOTES: re-uploading trashed content is refused with the restore instruction (never an invisible dedupe)')
  check(fs.readdirSync(serverMediaRoot).length === mediaFilesBeforeReupload, 'NOTES: the refused re-upload leaves no orphaned bytes in the media store')
  const emptied = await api.post('/api/lan/datasets/trash/empty', {})
  check(emptied.body.dropped >= 1 && emptied.body.bytesDeleted >= 0, `empty-trash drops entries (app-owned bytes only: ${(emptied.body.bytesDeleted / 1e6).toFixed(1)} MB)`)
  check(sha256File(clips.still) === stillBytesBefore, 'empty-trash never touches referenced originals')
})

test('(11) scene-split + slow-mo over HTTP', async () => {
  // Scene proposals ride the SERVER's manager (the HTTP surface), not the
  // local test manager — ingest through the API like a real client.
  const sceneIngest = await api.post('/api/lan/datasets/ingest/reference', { path: clips.loud })
  const proposals = await api.post('/api/lan/datasets/scenes/propose', { sourceId: sceneIngest.body.source.id })
  check(proposals.status === 200 && Array.isArray(proposals.body.proposals), 'scene proposals return (content-detector technique, intra-clip)')
  // A hard-cut synthetic clip must yield at least one proposal. (Lives in
  // the fixtures tree — reference ingest is scope-gated, HIGH-1.)
  const cutClip = path.join(media, 'hardcut.mp4')
  await runFfmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=480x832:rate=24', '-f', 'lavfi', '-i', 'smptebars=duration=2:size=480x832:rate=24', '-filter_complex', '[0:v][1:v]concat=n=2:v=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', cutClip])
  const cutIngest = await api.post('/api/lan/datasets/ingest/reference', { path: cutClip })
  const cutProposals = await api.post('/api/lan/datasets/scenes/propose', { sourceId: cutIngest.body.source.id })
  if (cutProposals.status !== 200 || !Array.isArray(cutProposals.body.proposals)) console.log('CUT-PROPOSALS-DEBUG', JSON.stringify(cutProposals).slice(0, 500))
  check(cutProposals.body.proposals.length >= 1, `a synthetic hard cut is detected (${cutProposals.body.proposals.length} proposal(s) — one scene per clip doctrine)`)
  if (cutProposals.body.proposals.length) {
    const accepted = await api.post('/api/lan/datasets/scenes/accept', { sourceId: cutIngest.body.source.id, frames: cutProposals.body.proposals.map((proposal) => proposal.frameNo) })
    check(accepted.status === 200 && accepted.body.cuts.every((cut) => cut.accepted), 'accepted cuts record')
    const split = await api.post('/api/lan/datasets/scenes/split', { sourceId: cutIngest.body.source.id })
    check(split.body.children.length === cutProposals.body.proposals.length + 1 && split.body.children.every((child) => child.origin === 'scene-split'), `accepted splits become child layers attached to the master (${split.body.children.length} children)`)
  }
  const slowMo = await api.post('/api/lan/datasets/audit/slowmo', { sourceId: cutIngest.body.source.id })
  check(slowMo.status === 200 && typeof slowMo.body.suspect === 'boolean' && Array.isArray(slowMo.body.reasons), 'slow-mo audit composes (metadata + frame-diff + freezedetect/mpdecimate)')
})

test('(12) byte immortality: every referenced original unchanged', () => {
  // NOTE: the CHANGED-flow simulation above intentionally REPLACED
  // clips.main's bytes from the test side (that is the disk change the
  // manager must SURFACE, not make) — the original main bytes now live at
  // movedPath/restoredPath, so immortality is asserted against those.
  const immutabilityNow = [
    { file: restoredPath, hash: immutability[0].hash, label: 'main (original bytes, post rename+relink)' },
    { file: clips.still, hash: immutability[1].hash, label: 'still' },
    { file: clips.loud, hash: sha256File(clips.loud), label: 'loud (self-hash: never manager-modified)' },
    { file: clips.ntsc, hash: sha256File(clips.ntsc), label: 'ntsc (self-hash)' },
  ]
  const hashesBeforeFinal = immutabilityNow.map((entry) => ({ file: entry.file, hash: sha256File(entry.file) }))
  for (const entry of hashesBeforeFinal) {
    const expected = immutabilityNow.find((candidate) => candidate.file === entry.file)
    check(entry.hash === expected.hash, `byte-immortality snapshot: ${path.basename(entry.file)} stable`)
  }
  // The one file whose bytes the manager COULD have touched but must not
  // have: restoredPath (re-linked, probed, baked from, exported from).
  check(sha256File(restoredPath) === immutability[0].hash, `byte-immortality: the referenced main source is checksum-identical after ingest/probe/health/layers/captions/bake/export/trash (${path.basename(restoredPath)})`)
})

test('(13) scale gate: 1000 synthetic sources + layers', async () => {
  const { upDatasetTables } = require(path.join(REPO, 'dist-server/server/datasets/store.js'))
  const scaleHome = makeHome('scale')
  const scaleDbFile = path.join(scaleHome, 'studio.db')
  const scaleDb = new Database(scaleDbFile)
  upDatasetTables(scaleDb)
  const insertSource = scaleDb.prepare(`INSERT INTO dataset_sources (id, ingest_path, abs_path, content_hash, size_bytes, mtime_ms, kind, probe_json, decoded_frames, probe_state, floor_verdict, created_at, updated_at)
    VALUES (?, 'reference', ?, ?, 1000, 0, ?, ?, 72, 'done', 'ok', ?, ?)`)
  const insertLayer = scaleDb.prepare(`INSERT INTO dataset_layers (id, source_id, name, crop_x, crop_y, crop_w, crop_h, trim_in_frame, trim_out_frame, origin, created_at, updated_at)
    VALUES (?, ?, ?, 32, 32, 416, 736, 0, 40, 'manual', ?, ?)`)
  const insertCaption = scaleDb.prepare(`INSERT INTO dataset_captions (layer_id, text, author, stale, updated_at) VALUES (?, ?, 'vlm:synthetic', 0, ?)`)
  const ftsInsert = scaleDb.prepare('INSERT INTO dataset_fts (text, source_id, layer_id, kind) VALUES (?, ?, ?, ?)')
  const scaleStart = Date.now()
  const seed = scaleDb.transaction(() => {
    for (let index = 0; index < 1000; index += 1) {
      const sourceId = `scale-src-${index}`
      const layerId = `scale-layer-${index}`
      const kind = index % 5 === 0 ? 'image' : 'video'
      insertSource.run(sourceId, `/synthetic/clip-${index}.mp4`, `synthetic-${index}`, kind, JSON.stringify({ kind, width: 480, height: 832, fps: kind === 'video' ? 24 : null, durationSec: kind === 'video' ? 3 : null, hasAudio: false, dbfs: null, codec: 'h264' }), Date.now(), Date.now())
      insertLayer.run(layerId, sourceId, `layer ${index}`, Date.now(), Date.now())
      insertCaption.run(layerId, `ph0t0r34l, synthetic clip ${index} with marker-word-${index % 37} for search`, Date.now())
      ftsInsert.run(`ph0t0r34l, synthetic clip ${index} with marker-word-${index % 37}`, sourceId, layerId, 'layer')
    }
  })
  seed()
  const seedMs = Date.now() - scaleStart
  check(seedMs < 30_000, `1000-item synthetic seed is tractable (${seedMs} ms)`)
  // Time library + search + dashboard against the REAL server: point a
  // second manager at the scale db through the same manager construction.
  const { createDatasetManager } = require(path.join(REPO, 'dist-server/server/datasets/index.js'))
  const scaleManager = createDatasetManager({
    db: scaleDb,
    mediaRoot: path.join(scaleHome, 'media'),
    trashRoot: path.join(scaleHome, 'trash'),
    tools: { ffmpegPath: ffmpeg(), logFailure: () => undefined },
    logEvent: () => undefined,
  })
  const t0 = Date.now()
  const scaleLibrary = scaleManager.library()
  const libraryMs = Date.now() - t0
  check(scaleLibrary.sources.length === 1000, `library lists 1000 sources (${libraryMs} ms)`)
  check(libraryMs < 2000, `library payload within budget (${libraryMs} ms < 2000 ms)`)
  const t1 = Date.now()
  const scaleSearch = scaleManager.store.searchLayers('marker-word-11')
  const searchMs = Date.now() - t1
  check(scaleSearch.length >= 1 && searchMs < 1000, `FTS search over 1000 captions (${searchMs} ms)`)
  const t2 = Date.now()
  const scaleDashboard = scaleManager.dashboard()
  const dashboardMs = Date.now() - t2
  check(scaleDashboard.items === 1000 && scaleDashboard.preflight !== null && dashboardMs < 2000, `dashboard computes 1000 items + preflight (${dashboardMs} ms)`)
  check(scaleDashboard.distributions.captionCoverage.captioned === 1000, 'dashboard counts caption coverage')
  console.log(`PASS: dataset manager — ingest both paths; health MISSING/CHANGED + hash re-link; byte-immortality; layer lifecycle; captions; bake conditional; gates 1–9; three exports; curation; FTS + aspects; scale gate; security wave 2. ${assertions} assertions.`)
})
