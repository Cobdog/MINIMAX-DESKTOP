#!/usr/bin/env node
/**
 * The standing FAKE ENGINE for experience-first walks (reality audit
 * 2026-09-25, task jf53fb8). A profile-driven stand-in ComfyUI that speaks
 * the studio's FULL engine contract — /system_stats, /object_info (+ the
 * targeted per-class form), /models (+per-folder), /prompt, /history,
 * /queue, /view, /upload/image, /interrupt, /free — plus the /ws WebSocket
 * event stream (status/execution_start/progress/executed/execution_success/
 * execution_error/interrupted and binary PNG preview frames).
 *
 * Stock class schemas are the REAL captured fixture
 * (scripts/fixtures/engine-object-info.json — contract truth, never
 * hand-written shapes); a profile adds PACK classes as extras, exactly the
 * way e2e/fakeEngineInfo.ts layers them.
 *
 * Profiles are JSON next to this file under profiles/:
 *   stock-h3.json           — the official H3 stack, no packs (Phase 1)
 *   maintainer-instance.json — the maintainer's real inventory approximated
 *                              from their session evidence (Phase 2 mirror)
 *
 * Usage: node e2e/mirror/fakeEngineServer.mjs --port 7341 \
 *          --profile e2e/mirror/profiles/stock-h3.json
 *
 * Live control (for break-it-on-purpose legs, no restart):
 *   POST /__control {"failMode":"validation"|"error"|"hang"|null,
 *                    "steps":n,"stepDelayMs":n}
 *   GET  /__control — current state
 *
 * NEVER point this at anything GPU-adjacent: it is a plain node HTTP+ws
 * server, and the studio that talks to it must run with an ISOLATED home.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2)
const argOf = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}
const port = Number(argOf('--port') ?? 0)
const profilePath = argOf('--profile')
if (!port || !profilePath) {
  console.error('usage: fakeEngineServer.mjs --port N --profile <profile.json>')
  process.exit(2)
}
const profile = JSON.parse(fs.readFileSync(path.resolve(repoRoot, profilePath), 'utf8'))

// ---------------------------------------------------------------- stock schemas (the REAL capture)
const fixture = JSON.parse(fs.readFileSync(path.join(repoRoot, 'scripts/fixtures/engine-object-info.json'), 'utf8'))
const objectInfo = { ...(fixture.nodes ?? {}) }
for (const [className, schema] of Object.entries(profile.objectInfoExtras ?? {})) objectInfo[className] = schema

// ---------------------------------------------------------------- synthetic PNG (tiny, tinted per job)
const crcTable = []
for (let n = 0; n < 256; n += 1) {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[n] = c >>> 0
}
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
/** A WxH PNG with a two-tone vertical gradient tinted by `seed` — visually
 *  distinguishable per render, decodable by any viewer. */
function pngGradient(width, height, seed) {
  const r = (seed * 61) % 256, g = (seed * 127) % 256, b = (seed * 193) % 256
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3)
    raw[row] = 0 // filter none
    const t = y / Math.max(1, height - 1)
    for (let x = 0; x < width; x += 1) {
      const i = row + 1 + x * 3
      raw[i] = Math.round(r * t + 40 * (1 - t))
      raw[i + 1] = Math.round(g * (1 - t) + 60 * t)
      raw[i + 2] = Math.round(b * t + 80 * (1 - t))
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2 // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// A real mp4 on disk (the committed e2e fixture) for video outputs.
const sampleMp4 = fs.readFileSync(path.join(repoRoot, 'e2e/fixtures/sample-clip.mp4'))

// ---------------------------------------------------------------- state
const state = {
  failMode: null, // null | 'validation' | 'error' | 'hang'
  steps: profile.render?.steps ?? 8,
  stepDelayMs: profile.render?.stepDelayMs ?? 350,
  outputKind: profile.render?.outputKind ?? 'video', // video | image
  emitBinaryPreviews: profile.render?.emitBinaryPreviews ?? true,
  // POST /refresh hit count (truth-surface sweep #2, 68e9k17): the mirror
  // counts engine-side folder re-scan asks so tests can PROVE a client
  // re-pull carried refresh semantics (read it via GET /__control).
  refreshHits: 0,
}
const control = (req, res, url) => {
  if (url.pathname === '/__control' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ profile: profile.id, ...state }))
    return true
  }
  if (url.pathname === '/__control' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      try {
        const patch = JSON.parse(body || '{}')
        for (const key of Object.keys(state)) if (key in patch) state[key] = patch[key]
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ profile: profile.id, ...state }))
      } catch {
        res.writeHead(400); res.end()
      }
    })
    return true
  }
  return false
}

// outputs served at /view: name -> {bytes, mime}
const viewFiles = new Map()
let jobCounter = 0
const histories = new Map() // promptId -> history record
let running = null // { promptId, timer, interrupted }

// ---------------------------------------------------------------- ws broadcast
const server = http.createServer((req, res) => { void handle(req, res) })
const wss = new WebSocketServer({ server })
const send = (obj) => { const s = JSON.stringify(obj); for (const c of wss.clients) if (c.readyState === 1) c.send(s) }
const sendPreview = (seed, step) => {
  const png = pngGradient(192, 108, seed + step)
  // ComfyUI's modern binary preview: [u32 version=1][u32 type (2=png)][image
  // at offset 8] — the exact frame server/realtime.ts parseUpstreamBinary
  // decodes.
  const header = Buffer.alloc(8)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(2, 4)
  const frame = Buffer.concat([header, png])
  for (const c of wss.clients) if (c.readyState === 1) c.send(frame)
}

// ---------------------------------------------------------------- scripted execution
function runPrompt(promptId, graph) {
  const my = { promptId, timer: null, interrupted: false }
  running = my
  const tick = (fn, delay) => { my.timer = setTimeout(fn, delay) }
  const finishRecord = (images, status) => {
    histories.set(promptId, {
      prompt: [graph, { client_id: 'studio-realtime', prompt_id: promptId }, ''],
      outputs: { final: { images } },
      status: { status_str: status, completed: true, messages: [] },
    })
  }
  send({ type: 'status', data: { status: { exec_info: { queue_remaining: 1 } } } })
  send({ type: 'execution_start', data: { prompt_id: promptId } })
  if (state.failMode === 'hang') return // nothing more — the hang leg
  const total = state.steps
  let step = 0
  const seed = jobCounter
  const advance = () => {
    if (my.interrupted) return
    step += 1
    if (state.failMode === 'error' && step === 3) {
      send({ type: 'executing', data: { prompt_id: promptId, node: 'KSamplerSelect' } })
      send({
        type: 'execution_error',
        data: {
          prompt_id: promptId,
          node_type: 'MiniMaxH3ImageToVideo',
          node_id: 'sampler',
          exception_type: 'OOM',
          exception_message: 'CUDA out of memory. Tried to allocate 2.34 GiB (GPU 0; 23.99 GiB total capacity)',
          traceback: 'fake traceback',
          current_inputs: {},
        },
      })
      finishRecord([], 'error')
      send({ type: 'status', data: { status: { exec_info: { queue_remaining: 0 } } } })
      running = null
      return
    }
    send({ type: 'progress', data: { prompt_id: promptId, value: step, max: total } })
    if (state.emitBinaryPreviews && step % 2 === 0) sendPreview(seed, step)
    if (step < total) {
      tick(advance, state.stepDelayMs)
      return
    }
    // done — emit output(s) and close the job. Graph-aware: a graph whose
    // save tail is SaveImage nodes (the image workbench's packet ladder)
    // receives one PNG per SaveImage node; a video graph receives the mp4.
    const n = jobCounter
    const graphNodes = Object.values(graph ?? {})
    const saveImageCount = graphNodes.filter((node) => node && typeof node === 'object' && node.class_type === 'SaveImage').length
    const wantImages = state.outputKind === 'image' || saveImageCount > 0
    const images = []
    if (wantImages) {
      const count = Math.max(1, saveImageCount)
      for (let i = 0; i < count; i += 1) {
        const filename = `ComfyUI_${String(n).padStart(5, '0')}_${i}.png`
        viewFiles.set(filename, { bytes: pngGradient(768, 432, n * 7 + i * 31), mime: 'image/png' })
        images.push({ filename, subfolder: '', type: 'output' })
      }
    } else {
      const filename = `ComfyUI_${String(n).padStart(5, '0')}_.mp4`
      viewFiles.set(filename, { bytes: sampleMp4, mime: 'video/mp4' })
      images.push({ filename, subfolder: '', type: 'output' })
    }
    send({ type: 'executing', data: { prompt_id: promptId, node: 'MiniMaxH3ImageToVideo' } })
    send({ type: 'executed', data: { prompt_id: promptId, node: 'save', output: { images } } })
    send({ type: 'execution_success', data: { prompt_id: promptId } })
    send({ type: 'status', data: { status: { exec_info: { queue_remaining: 0 } } } })
    finishRecord(images, 'success')
    running = null
  }
  tick(advance, state.stepDelayMs)
}

// ---------------------------------------------------------------- http
const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const readBody = (req) => new Promise((resolve) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => resolve(Buffer.concat(chunks)))
})

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://engine.local')
  try {
    if (control(req, res, url)) return

    if (url.pathname === '/system_stats') {
      return json(res, 200, profile.systemStats ?? {
        system: { comfyui_version: 'v0.34.0', python_version: '3.12.3', os: 'linux' },
        devices: [{ name: 'NVIDIA GeForce RTX 4090', type: 'cuda', index: 0, vram_total: 25757220864, vram_free: 24000000000, torch_version: '2.8.0+cu128' }],
      })
    }

    if (url.pathname === '/object_info') return json(res, 200, objectInfo)
    const targeted = /^\/object_info\/(.+)$/.exec(url.pathname)
    if (targeted) {
      const className = decodeURIComponent(targeted[1])
      return json(res, 200, className in objectInfo ? { [className]: objectInfo[className] } : {})
    }

    if (url.pathname === '/models') return json(res, 200, Object.keys(profile.modelListings ?? {}))
    const folder = /^\/models\/(.+)$/.exec(url.pathname)
    if (folder) {
      const kind = decodeURIComponent(folder[1])
      const listing = (profile.modelListings ?? {})[kind]
      if (!listing) { res.writeHead(404); res.end(); return }
      return json(res, 200, listing)
    }

    if (url.pathname === '/prompt' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8'))
      jobCounter += 1
      const promptId = `fake-${Date.now().toString(36)}-${jobCounter}`
      if (state.failMode === 'validation') {
        return json(res, 400, {
          error: 'Prompt outputs failed validation',
          node_errors: {
            sampler: {
              errors: [{
                type: 'value_smaller_than_min',
                message: 'Value 1 in field: length is smaller than the minimum of 5',
                details: '17 >= 5',
                extra_info: { input_name: ['length', 1], message: 'Value 1 in field: length is smaller than the minimum of 5' },
              }],
              class_type: 'MiniMaxH3ImageToVideo',
              dependent_outputs: [],
              errors_by_input: { length: 0 },
            },
          },
        })
      }
      runPrompt(promptId, body.prompt ?? {})
      return json(res, 200, { prompt_id: promptId, number: jobCounter, node_errors: {} })
    }

    if (url.pathname === '/queue') {
      const q = running ? [running.promptId] : []
      return json(res, 200, { queue_running: q, queue_pending: [] })
    }
    if (url.pathname === '/history') return json(res, 200, Object.fromEntries(histories))
    const hist = /^\/history\/(.+)$/.exec(url.pathname)
    if (hist) {
      const id = decodeURIComponent(hist[1])
      return json(res, 200, histories.has(id) ? { [id]: histories.get(id) } : {})
    }

    if (url.pathname === '/view') {
      const filename = url.searchParams.get('filename') ?? ''
      const file = viewFiles.get(filename)
      if (!file) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'content-type': file.mime, 'content-length': String(file.bytes.length) })
      res.end(req.method === 'HEAD' ? undefined : file.bytes)
      return
    }

    if (url.pathname === '/upload/image' && req.method === 'POST') {
      const body = await readBody(req)
      const contentType = req.headers['content-type'] ?? ''
      const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
      if (!boundaryMatch) { res.writeHead(400); res.end(); return }
      const boundary = Buffer.from(`--${boundaryMatch[1] ?? boundaryMatch[2]}`)
      let start = body.indexOf(boundary)
      const saved = []
      while (start >= 0) {
        const next = body.indexOf(boundary, start + boundary.length)
        if (next < 0) break
        const part = body.subarray(start + boundary.length + 2, next - 2) // strip CRLF around
        const headerEnd = part.indexOf('\r\n\r\n')
        if (headerEnd >= 0) {
          const header = part.subarray(0, headerEnd).toString('utf8')
          const nameMatch = /filename="([^"]*)"/.exec(header)
          if (nameMatch && nameMatch[1]) {
            const filename = nameMatch[1]
            const bytes = part.subarray(headerEnd + 4)
            viewFiles.set(filename, { bytes, mime: filename.endsWith('.png') ? 'image/png' : filename.match(/\.mp4$|\.webm$/) ? 'video/mp4' : 'application/octet-stream' })
            saved.push(filename)
          }
        }
        start = next
      }
      return json(res, 200, saved.length ? { name: saved[0], subfolder: '', type: 'input' } : { name: 'upload.png', subfolder: '', type: 'input' })
    }

    if (url.pathname === '/interrupt' && req.method === 'POST') {
      if (running) {
        clearTimeout(running.timer)
        send({ type: 'execution_interrupted', data: { prompt_id: running.promptId, node_id: 'sampler' } })
        send({ type: 'status', data: { status: { exec_info: { queue_remaining: 0 } } } })
        histories.set(running.promptId, { prompt: [], outputs: {}, status: { status_str: 'interrupted', completed: true, messages: [] } })
        running = null
      }
      return json(res, 200, {})
    }
    if (url.pathname === '/free' && req.method === 'POST') return json(res, 200, {})
    if (url.pathname === '/refresh' && req.method === 'POST') {
      state.refreshHits += 1
      return json(res, 200, {})
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: `fake engine has no ${url.pathname}` }))
  } catch (failure) {
    console.error('[fake-engine] handler failure', failure)
    if (!res.headersSent) { res.writeHead(500); res.end() }
  }
}

server.listen(port, '127.0.0.1', () => {
  console.log(`[fake-engine] profile=${profile.id} listening on http://127.0.0.1:${port}`)
  console.log(`[fake-engine] object_info classes=${Object.keys(objectInfo).length} model folders=${Object.keys(profile.modelListings ?? {}).join(', ')}`)
  console.log(`[fake-engine] customNodeDirs=${(profile.customNodeDirs ?? []).join(', ') || '(none)'}`)
})
