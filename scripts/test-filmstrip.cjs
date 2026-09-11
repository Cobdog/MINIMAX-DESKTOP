// Filmstrip test (wave 2d): boots the BUILT standalone server on a scratch
// port + scratch home (like test-storage.cjs) and exercises the sprite-sheet
// capability end to end against the committed fixture clip:
//   (a) GET /api/lan/assets/filmstrip generates lazily → PNG (magic bytes,
//       expected grid dimensions from the shared layout math)
//   (b) second GET revalidates by ETag (304) with the SAME generation count
//   (c) three concurrent first requests share ONE ffmpeg run (single-flight)
//   (d) containment guard rejects outside/traversal paths; non-video 400s
//   (e) source mtime invalidation: a touched source regenerates
//   (f) POST (the output-attribution hook) registers the frame-indexed asset
//       row (fps 24, frame_count = duration × 24) and warm-starts the sheet
// Engine-independent: no ComfyUI — only ffmpeg is required. Runners without
// ffmpeg SKIP with a logged reason (assert ffmpeg availability first).
const { spawn, spawnSync } = require('node:child_process')
const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const Database = require('better-sqlite3')

// ---- ffmpeg availability: skip gracefully with a logged reason ----------
const ffmpegProbe = spawnSync('ffmpeg', ['-version'], { timeout: 10_000 })
if (ffmpegProbe.error || ffmpegProbe.status !== 0) {
  console.log('SKIP: ffmpeg is not available on this runner — the filmstrip capability needs it. (CI installs it via apt; see .github/workflows/ci.yml.)')
  process.exit(0)
}

async function freePort() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = 4400 + Math.floor(Math.random() * 200)
    const busy = await new Promise((resolve) => {
      const probe = net.connect({ port: candidate, host: '127.0.0.1' })
      probe.on('error', () => resolve(false))
      probe.on('connect', () => { probe.destroy(); resolve(true) })
    })
    if (!busy) return candidate
  }
  throw new Error('no free port found in 50 attempts')
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-filmstrip-'))
const outputDirectory = path.join(home, 'output')
let child = null
let output = ''

const fail = (message) => {
  console.error(`FAIL: ${message}\n--- server output ---\n${output}`)
  if (child) child.kill()
  process.exit(1)
}

async function waitFor(port, pathname) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`)
      if (response.ok) return response
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  fail(`${pathname} never became ready`)
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function assertPng(buffer, label) {
  assert.ok(buffer.length > 24 && buffer.subarray(0, 8).equals(PNG_SIGNATURE), `${label} must be a PNG (magic bytes)`)
  // IHDR: width/height are big-endian at offsets 16/20.
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

async function main() {
  const port = await freePort()
  child = spawn(process.execPath, ['dist-server/server/index.js'], {
    env: { ...process.env, MINIMAX_STUDIO_HOME: home, MINIMAX_LAN_PORT: String(port), MINIMAX_NO_HTTPS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk) })
  const timeout = setTimeout(() => fail('server did not become ready in 15 s'), 15_000)
  await waitFor(port, '/api/lan/settings')
  clearTimeout(timeout)
  if (!output.includes(`"port":${port}`)) fail('the readiness probe reached a server that is not the test child')
  const base = `http://127.0.0.1:${port}`

  // Point the scratch server's output directory INSIDE its own scratch home
  // (the default would be the real user Documents tree) and stage fixtures.
  const saved = await fetch(`${base}/api/lan/settings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { comfyUrl: 'http://127.0.0.1:8188', outputDirectory } }),
  })
  assert.equal(saved.status, 200, 'settings POST must accept the scratch output directory')
  fs.mkdirSync(outputDirectory, { recursive: true })
  const fixture = path.resolve(__dirname, '..', 'e2e', 'fixtures', 'sample-clip.mp4')
  fs.copyFileSync(fixture, path.join(outputDirectory, 'filmstrip-a.mp4'))
  fs.copyFileSync(fixture, path.join(outputDirectory, 'filmstrip-b.mp4'))
  fs.writeFileSync(path.join(outputDirectory, 'not-a-video.txt'), 'still frames only')
  const clipA = path.join(outputDirectory, 'filmstrip-a.mp4')
  const clipB = path.join(outputDirectory, 'filmstrip-b.mp4')
  const filmstrip = (file, extra = '') => `${base}/api/lan/assets/filmstrip?${new URLSearchParams({ path: file })}${extra}`

  // (a) First GET generates lazily and serves a PNG with the shared layout:
  //     duration 3 s → 12 samples → 4×3 grid at 160 px/cell → 640×270.
  const first = await fetch(filmstrip(clipA, '&duration=3'))
  if (first.status !== 200) fail(`first GET failed: ${await first.text()}`)
  assert.equal(first.headers.get('content-type'), 'image/png')
  assert.equal(first.headers.get('x-minimax-filmstrip-cols'), '4')
  assert.equal(first.headers.get('x-minimax-filmstrip-rows'), '3')
  assert.equal(first.headers.get('x-minimax-filmstrip-frame-count'), '12')
  assert.equal(first.headers.get('x-minimax-filmstrip-generations'), '1', 'the very first request must report exactly one generation')
  const dimensions = assertPng(Buffer.from(await first.arrayBuffer()), 'first sheet')
  assert.deepEqual(dimensions, { width: 640, height: 270 }, 'sheet must tile 4×3 cells of 160×90')
  const etag = first.headers.get('etag')
  assert.ok(etag, 'sheet response must carry a content-derived ETag')
  const sheetFile = path.join(outputDirectory, 'MiniMax Studio Frames', '.filmstrips')
  assert.ok(fs.existsSync(sheetFile), 'sheets must be cached under the output directory (dot-folder)')

  // (b) Second GET: ETag revalidation (304) and no new generation.
  const revalidate = await fetch(filmstrip(clipA, '&duration=3'), { headers: { 'if-none-match': etag } })
  assert.equal(revalidate.status, 304, 'an unchanged sheet must answer 304 to If-None-Match')
  const second = await fetch(filmstrip(clipA, '&duration=3'))
  assert.equal(second.headers.get('etag'), etag, 'ETag must be stable across hits')
  assert.equal(second.headers.get('x-minimax-filmstrip-generations'), '1', 'a cached sheet must not regenerate')

  // (c) Single-flight: three CONCURRENT first requests for clip-b → one
  // ffmpeg run between them (counter moved by exactly one).
  const before = Number(second.headers.get('x-minimax-filmstrip-generations'))
  const concurrent = await Promise.all([fetch(filmstrip(clipB)), fetch(filmstrip(clipB)), fetch(filmstrip(clipB))])
  for (const response of concurrent) {
    assert.equal(response.status, 200, 'every concurrent request must succeed')
    assertPng(Buffer.from(await response.arrayBuffer()), 'concurrent sheet')
  }
  const after = await fetch(filmstrip(clipB))
  assert.equal(Number(after.headers.get('x-minimax-filmstrip-generations')), before + 1, 'three parallel first requests must share ONE generation')

  // (d) Guards: outside the output directory, traversal, missing file,
  //     non-video extension.
  const outside = await fetch(filmstrip('/etc/passwd'))
  assert.equal(outside.status, 403, 'a path outside the output directory must be rejected')
  const traversal = await fetch(`${base}/api/lan/assets/filmstrip?${new URLSearchParams({ path: path.join(outputDirectory, '..', 'escape.mp4') })}`)
  assert.equal(traversal.status, 403, 'traversal out of the output directory must be rejected')
  const missing = await fetch(filmstrip(path.join(outputDirectory, 'nope.mp4')))
  assert.equal(missing.status, 404, 'a missing file must 404')
  const notVideo = await fetch(filmstrip(path.join(outputDirectory, 'not-a-video.txt')))
  assert.equal(notVideo.status, 400, 'a non-video file must be refused')

  // (e) Invalidation: a source newer than its sheet regenerates.
  const future = new Date(Date.now() + 60_000)
  fs.utimesSync(clipA, future, future)
  const regenerated = await fetch(filmstrip(clipA, '&duration=3'), { headers: { 'if-none-match': etag } })
  assert.equal(regenerated.status, 200, 'a touched source must regenerate (ETag changed)')
  assert.notEqual(regenerated.headers.get('etag'), etag, 'the new ETag must reflect the new source mtime')
  const afterInvalidation = Number(regenerated.headers.get('x-minimax-filmstrip-generations'))
  assert.equal(afterInvalidation, before + 2, 'invalidation must have added exactly one regeneration')

  // (f) Attribution hook: registers the frame-indexed asset row (fps 24 /
  //     frame_count = duration × 24 — the documented approximation) and
  //     warm-starts the sheet without regenerating (cache still fresh).
  const registered = await fetch(`${base}/api/lan/assets/filmstrip`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: clipB, width: 320, height: 180, duration: 3 }),
  })
  if (registered.status !== 200) fail(`attribution POST failed: ${await registered.text()}`)
  const registeredBody = await registered.json()
  assert.equal(registeredBody.registered, true)
  assert.equal(registeredBody.fps, 24)
  assert.equal(registeredBody.frameCount, 72, 'frame_count must be duration × 24 (3 s → 72)')
  const warm = await fetch(filmstrip(clipB))
  assert.equal(Number(warm.headers.get('x-minimax-filmstrip-generations')), afterInvalidation, 'the warm start must reuse the cached sheet, not regenerate')
  const db = new Database(path.join(home, 'studio.db'))
  const asset = db.prepare('SELECT * FROM assets WHERE path = ?').get(clipB)
  db.close()
  assert.ok(asset, 'the assets table must hold the registered output')
  assert.equal(asset.kind, 'video')
  assert.equal(asset.mime, 'video/mp4')
  assert.equal(asset.bytes, fs.statSync(clipB).size)
  assert.equal(asset.width, 320)
  assert.equal(asset.height, 180)
  assert.equal(asset.duration_ms, 3000)
  assert.equal(asset.fps, 24)
  assert.equal(asset.frame_count, 72)

  child.kill()
  console.log('PASS: filmstrip generation, caching, single-flight, guards, invalidation, and asset registration all verified.')
}

main().catch((error) => fail(error instanceof Error ? error.stack : String(error)))
