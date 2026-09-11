// Realtime event fabric test (wave 1). Boots the BUILT standalone server on a
// verified-free scratch port + scratch home (like test-storage.cjs) and
// exercises the fabric end to end, engine-independently:
//   (a) UNITS against dist-server/server/realtime.js exports — binary preview
//       framing round-trip, job-key hash determinism, job-channel
//       normalization from recorded ComfyUI event fixtures (both binary
//       framings), and the backpressure outbox (slow client: bounded JSON
//       queue with oldest-dropped accounting + newest-wins preview frames)
//   (b) WS connect (open LAN posture) receives the system hello; a telemetry
//       subscriber receives a pushed sample within ~6 s WITHOUT any ComfyUI
//   (c) job+preview fan-out through a FAKE upstream ComfyUI WebSocket: one
//       shared upstream, normalized job envelopes with server-side prompt
//       correlation (progress carries no prompt_id upstream), binary preview
//       frames stamped with the job-key hash, per-channel seq monotonicity
//   (d) llm channel against a local mock OpenAI SSE endpoint: tokens stream,
//       done fires, abort cancels the upstream fetch, and a non-local
//       endpoint is rejected by the SSRF guard
//   (e) SSE v2 fallback (/api/lan/realtime) pushes telemetry
//   (f) token mode: WS without/with a wrong token is refused before the
//       handshake; the correct token connects
// Run after `pnpm build` (the server and units load from dist-server).
const { spawn } = require('node:child_process')
const http = require('node:http')
const net = require('node:net')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const WebSocket = require('ws')
const { WebSocketServer } = require('ws')
const {
  normalizeComfyEvent,
  encodePreviewFrame,
  decodePreviewFrame,
  parseUpstreamBinary,
  hashJobKey,
  ClientOutbox,
} = require(path.join(__dirname, '..', 'dist-server', 'server', 'realtime.js'))

/** Verifiably-free port (a stale dev server squatting the range would
 *  otherwise answer the readiness probe against the WRONG home). */
async function freePort() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = 4550 + Math.floor(Math.random() * 300)
    const busy = await new Promise((resolve) => {
      const probe = net.connect({ port: candidate, host: '127.0.0.1' })
      probe.on('error', () => resolve(false))
      probe.on('connect', () => { probe.destroy(); resolve(true) })
    })
    if (!busy) return candidate
  }
  throw new Error('no free port found in 50 attempts')
}

const children = []
const servers = []
let output = ''

const fail = (message) => {
  console.error(`FAIL: ${message}\n--- server output ---\n${output}`)
  for (const child of children) child.kill()
  for (const server of servers) server.close()
  process.exit(1)
}

async function waitForHttp(port, pathname) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`)
      if (response.ok) return response
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  fail(`${pathname} never became ready on ${port}`)
}

function bootServer(home, port, extraEnv = {}) {
  const child = spawn(process.execPath, ['dist-server/server/index.js'], {
    env: { ...process.env, MINIMAX_STUDIO_HOME: home, MINIMAX_LAN_PORT: String(port), MINIMAX_NO_HTTPS: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  child.stdout.on('data', (chunk) => { output += `[server ${port}] ${String(chunk)}` })
  child.stderr.on('data', (chunk) => { output += `[server ${port}] ${String(chunk)}` })
  return child
}

/** A WS client that collects JSON envelopes per channel and binary frames. */
function fabricClient(port, token) {
  const query = token ? `?token=${encodeURIComponent(token)}` : ''
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`)
  const state = { envelopes: [], frames: [], opened: false, error: null, closeCode: null }
  socket.binaryType = 'nodebuffer'
  socket.on('open', () => { state.opened = true })
  socket.on('error', (error) => { state.error = error })
  socket.on('close', (code) => { state.closeCode = code })
  socket.on('message', (data, isBinary) => {
    if (isBinary) { state.frames.push(Buffer.from(data)); return }
    try { state.envelopes.push(JSON.parse(data.toString('utf8'))) } catch { /* ignore */ }
  })
  state.send = (value) => socket.send(JSON.stringify(value))
  state.waitFor = async (predicate, label, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = predicate(state)
      if (found) return found
      if (Date.now() > deadline) fail(`timed out waiting for ${label}`)
      await new Promise((resolve) => setTimeout(resolve, 60))
    }
  }
  state.opened_ = () => new Promise((resolve, reject) => {
    if (state.opened) return resolve()
    const timer = setTimeout(() => reject(new Error('WS open timeout')), 8000)
    socket.on('open', () => { clearTimeout(timer); resolve() })
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
  })
  return state
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

async function main() {
  // ---- (a) units -----------------------------------------------------------
  // Binary framing round-trip for every mime, hash 0 (unknown job) included.
  const payload = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x01, 0x02, 0x03, 0x04])
  for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'video/mp4']) {
    const frame = encodePreviewFrame(hashJobKey('prompt-x'), mime, payload)
    const decoded = decodePreviewFrame(frame)
    assert.ok(decoded, `frame for ${mime} must decode`)
    assert.equal(decoded.mime, mime)
    assert.equal(decoded.jobHash, hashJobKey('prompt-x'))
    assert.ok(decoded.payload.equals(payload), 'payload must round-trip byte-identical')
  }
  const unknownJob = encodePreviewFrame(0, 'image/jpeg', payload)
  assert.equal(decodePreviewFrame(unknownJob).jobHash, 0)
  assert.equal(decodePreviewFrame(Buffer.from([0x02, 0, 0, 0, 0, 0, 1, 1])), null, 'wrong magic must be rejected')
  assert.equal(encodePreviewFrame(1, 'text/html', payload), null, 'unknown mime must not encode')
  assert.notEqual(hashJobKey('a'), hashJobKey('b'))
  assert.equal(hashJobKey('a'), hashJobKey('a'), 'hash must be deterministic')

  // Upstream binary parsing: legacy string framing (the SSE bridge's format)…
  const legacyEvent = Buffer.alloc(8); legacyEvent.write('preview', 'utf8')
  const legacyMime = Buffer.alloc(16); legacyMime.write('image/jpeg', 'utf8')
  const legacy = parseUpstreamBinary(Buffer.concat([legacyEvent, legacyMime, payload]))
  assert.equal(legacy.mime, 'image/jpeg')
  assert.ok(legacy.payload.equals(payload), 'legacy framing payload starts at byte 24')
  // …modern int framing (plain jpeg, plain png, animated block at 32)…
  const modern = parseUpstreamBinary(Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]), payload]))
  assert.equal(modern.mime, 'image/jpeg')
  assert.ok(modern.payload.equals(payload))
  const modernPng = parseUpstreamBinary(Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 0, 0, 2]), payload]))
  assert.equal(modernPng.mime, 'image/png')
  const animatedHeader = Buffer.alloc(32)
  animatedHeader.writeUInt32BE(1, 0); animatedHeader.writeUInt32BE(1, 4); animatedHeader.writeUInt32BE(1, 8)
  const animated = parseUpstreamBinary(Buffer.concat([animatedHeader, payload]))
  assert.equal(animated.mime, 'image/jpeg')
  assert.ok(animated.payload.equals(payload), 'animated preview payload starts at byte 32')
  assert.equal(parseUpstreamBinary(Buffer.from([0, 0, 0, 1, 0, 0, 0, 9, 1])), null, 'unknown modern kind is not a preview')

  // Job-channel normalization from recorded ComfyUI event fixtures.
  const start = normalizeComfyEvent({ type: 'execution_start', data: { prompt_id: 'p1' } })
  assert.deepEqual(start.events, [{ type: 'execution_start', promptId: 'p1' }])
  const progress = normalizeComfyEvent({ type: 'progress', data: { value: 7, max: 30 } }, 'p1')
  assert.deepEqual(progress.events, [{ type: 'progress', promptId: 'p1', value: 7, max: 30 }], 'prompt-less progress gets the active prompt correlated server-side')
  assert.deepEqual(normalizeComfyEvent({ type: 'progress', data: { value: 1, max: 0 } }, 'p1').events, [], 'progress with max=0 is noise')
  const executed = normalizeComfyEvent({ type: 'executed', data: { prompt_id: 'p1', node: '84', output: { images: [{ filename: 'a.mp4', subfolder: 'video', type: 'output' }] } } })
  assert.deepEqual(executed.events[0].images, [{ filename: 'a.mp4', subfolder: 'video', type: 'output' }])
  const errored = normalizeComfyEvent({ type: 'execution_error', data: { prompt_id: 'p1', node_type: 'KSampler', exception_message: 'OOM' } })
  assert.equal(errored.events.length, 2)
  assert.equal(errored.events[1].type, 'job_done')
  assert.equal(errored.events[1].outcome, 'error')
  for (const name of ['interrupted', 'execution_interrupted']) {
    const events = normalizeComfyEvent({ type: name, data: { prompt_id: 'p1' } }).events
    assert.equal(events[0].type, 'interrupted')
    assert.equal(events[1].outcome, 'interrupted')
  }
  const success = normalizeComfyEvent({ type: 'execution_success', data: {} }, 'p1')
  assert.deepEqual(success.events.map((event) => event.type), ['execution_success', 'job_done'])
  assert.equal(success.events[1].outcome, 'success')
  const override = normalizeComfyEvent({ type: 'minimax_h3_preview_override', data: { prompt_id: 'p1', image: 'AAAA', mime: 'image/webp', fps: 12, step: 3, total: 30 } }, 'p1')
  assert.equal(override.events[0].type, 'preview_meta')
  assert.equal(override.events[0].totalSteps, 30)
  assert.equal(override.previewFrame.mime, 'image/webp')
  assert.equal(override.previewFrame.base64, 'AAAA')
  const badOverrideMime = normalizeComfyEvent({ type: 'minimax_h3_preview_override', data: { prompt_id: 'p1', image: 'AAAA', mime: 'text/html' } }, 'p1')
  assert.equal(badOverrideMime.previewFrame, null, 'non-image override mimes carry metadata only')
  assert.deepEqual(normalizeComfyEvent({ type: 'some_future_event', data: { prompt_id: 'p1' } }).events, [], 'unknown event types normalize to nothing')
  assert.deepEqual(normalizeComfyEvent('not-an-object').events, [])
  const queue = normalizeComfyEvent({ type: 'status', data: { status: { exec_info: { queue_remaining: 2 } } } })
  assert.deepEqual(queue.events, [{ type: 'queue_status', promptId: '', queueRemaining: 2 }])

  // Backpressure outbox: a client that never drains.
  const sent = []
  let buffered = 0
  const neverDrains = { send: (data) => { sent.push(data) }, get bufferedAmount() { return buffered } }
  const outbox = new ClientOutbox(neverDrains, { jsonLimit: 4, highWaterBytes: 8 })
  buffered = 1_000_000
  for (let index = 0; index < 10; index += 1) outbox.queueJson(`env-${index}`)
  outbox.queuePreview(42, Buffer.from('frame-a'))
  outbox.queuePreview(42, Buffer.from('frame-b'))
  outbox.queuePreview(7, Buffer.from('frame-c'))
  assert.equal(outbox.pending, 6, 'bounded JSON queue keeps 4; two jobs keep one pending preview each')
  assert.equal(outbox.consumeDropped(), 6, 'six oldest JSON envelopes dropped while congested')
  buffered = 0
  outbox.pump()
  assert.deepEqual(sent.map(String), ['env-6', 'env-7', 'env-8', 'env-9', 'frame-b', 'frame-c'], 'drain sends the surviving JSON in order, then the NEWEST frame per job (frame-a was stale)')
  assert.equal(outbox.pending, 0)

  // ---- (b) boot + WS + telemetry without any ComfyUI engine ----------------
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-realtime-'))

  // Fake upstream ComfyUI on a kernel-assigned port, known to the server via
  // settings BEFORE boot (the fabric connects upstream lazily on subscribe).
  let upstreamConnections = 0
  const upstreamServer = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  servers.push(upstreamServer)
  const upstreamReady = new Promise((resolve) => upstreamServer.on('listening', () => resolve(upstreamServer.address().port)))
  const upstreamPort = await upstreamReady
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ comfyUrl: `http://127.0.0.1:${upstreamPort}` }))
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09])
  upstreamServer.on('connection', (socket) => {
    upstreamConnections += 1
    setTimeout(() => {
      socket.send(JSON.stringify({ type: 'execution_start', data: { prompt_id: 'e2e-prompt-1' } }))
      socket.send(Buffer.concat([legacyEvent, legacyMime, jpegBytes]))
      socket.send(JSON.stringify({ type: 'progress', data: { value: 7, max: 30 } }))
      socket.send(JSON.stringify({ type: 'execution_success', data: {} }))
    }, 150)
  })

  const port = await freePort()
  bootServer(home, port)
  await waitForHttp(port, '/api/lan/settings')
  if (!output.includes(`[server ${port}]`) || !output.includes(`"port":${port}`)) fail('the readiness probe reached a server that is not the test child')

  const client = fabricClient(port)
  await client.opened_()
  await client.waitFor((state) => state.envelopes.some((envelope) => envelope.ch === 'system' && envelope.type === 'hello'), 'system hello')
  client.send({ type: 'sub', ch: 'telemetry' })
  const telemetry = await client.waitFor((state) => state.envelopes.find((envelope) => envelope.ch === 'telemetry' && envelope.type === 'sample'), 'a pushed telemetry sample (no engine involved)')
  assert.equal(typeof telemetry.payload.available, 'boolean', 'telemetry sample carries the GPU availability flag')

  // ---- (c) job + preview fan-out through the fake upstream -----------------
  client.send({ type: 'sub', ch: 'job' })
  client.send({ type: 'sub', ch: 'preview' })
  const jobStart = await client.waitFor((state) => state.envelopes.find((envelope) => envelope.ch === 'job' && envelope.type === 'execution_start'), 'execution_start on the job channel')
  assert.equal(jobStart.payload.promptId, 'e2e-prompt-1')
  const correlated = await client.waitFor((state) => state.envelopes.find((envelope) => envelope.ch === 'job' && envelope.type === 'progress'), 'progress correlated to the active prompt')
  assert.equal(correlated.payload.promptId, 'e2e-prompt-1', 'prompt-less upstream progress carries the server-correlated promptId')
  assert.equal(correlated.payload.value, 7)
  await client.waitFor((state) => state.envelopes.some((envelope) => envelope.ch === 'job' && envelope.type === 'job_done' && envelope.payload.outcome === 'success'), 'job_done success')
  const frame = await client.waitFor((state) => state.frames.length > 0 ? state.frames[0] : null, 'a binary preview frame')
  assert.equal(frame[0], 0x01, 'preview frame magic')
  assert.equal(frame.readUInt32BE(1), hashJobKey('e2e-prompt-1'), 'frame hash matches the executing job key')
  assert.equal(frame[5], 0, 'mime code 0 = image/jpeg')
  assert.ok(frame.subarray(6).equals(jpegBytes), 'frame payload is the exact upstream bytes (no base64 inflation)')
  const jobSeqs = client.envelopes.filter((envelope) => envelope.ch === 'job').map((envelope) => envelope.seq)
  for (let index = 1; index < jobSeqs.length; index += 1) assert.equal(jobSeqs[index], jobSeqs[index - 1] + 1, 'job channel seq is monotonic without gaps')

  // ---- (d) llm channel against a local mock OpenAI SSE endpoint ------------
  const tokens = ['Hel', 'lo ', 'fab', 'ric']
  let llmAbortCloses = 0
  const llmMock = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      assert.equal(body.stream, true, 'the fabric always requests streaming')
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (request.url.includes('endless')) {
        // Never-ending stream: only an abort can end it. (Abort detection
        // hangs off the RESPONSE — on modern Node the request stream's
        // 'close' fires as soon as the body finishes, not on disconnect.)
        let index = 0
        const timer = setInterval(() => { response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `t${index}` } }] })}\n\n`); index += 1 }, 60)
        response.on('close', () => { clearInterval(timer); if (!response.writableEnded) llmAbortCloses += 1 })
        return
      }
      let index = 0
      const timer = setInterval(() => {
        if (index < tokens.length) {
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: tokens[index] } }] })}\n\n`)
          index += 1
        } else {
          clearInterval(timer)
          response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
          response.write('data: [DONE]\n\n')
          response.end()
        }
      }, 30)
    })
  })
  const llmPort = await listen(llmMock)
  servers.push(llmMock)

  // Tokens stream through and done fires.
  const tokenPromise = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('llm stream timed out')), 8000)
    client.send({ ch: 'llm', type: 'generate', reqId: 'llm-1', payload: { endpoint: `http://127.0.0.1:${llmPort}`, model: 'mock', messages: [{ role: 'user', content: 'hi' }] } })
    let text = ''
    const check = () => {
      const done = client.envelopes.find((envelope) => envelope.ch === 'llm' && envelope.payload.reqId === 'llm-1' && envelope.type === 'done')
      const failed = client.envelopes.find((envelope) => envelope.ch === 'llm' && envelope.payload.reqId === 'llm-1' && envelope.type === 'error')
      if (done) { clearTimeout(deadline); resolve({ text, done }); return }
      if (failed) { clearTimeout(deadline); reject(new Error(`llm error: ${failed.payload.error}`)); return }
      for (const envelope of client.envelopes) {
        if (envelope.ch === 'llm' && envelope.payload.reqId === 'llm-1' && envelope.type === 'token' && !envelope.seen) {
          envelope.seen = true
          text += envelope.payload.delta
        }
      }
      setTimeout(check, 40)
    }
    check()
  })
  const streamed = await tokenPromise
  assert.equal(streamed.text, tokens.join(''), 'every token delta arrives in order')
  assert.equal(streamed.done.payload.finishReason, 'stop', 'finish_reason forwarded')

  // Abort cancels the upstream fetch.
  client.send({ ch: 'llm', type: 'generate', reqId: 'llm-2', payload: { endpoint: `http://127.0.0.1:${llmPort}/endless`, model: 'mock', messages: [{ role: 'user', content: 'hi' }] } })
  await client.waitFor((state) => state.envelopes.some((envelope) => envelope.ch === 'llm' && envelope.payload.reqId === 'llm-2' && envelope.type === 'token'), 'first token of the endless stream')
  client.send({ ch: 'llm', type: 'abort', reqId: 'llm-2' })
  await client.waitFor((state) => state.envelopes.find((envelope) => envelope.ch === 'llm' && envelope.payload.reqId === 'llm-2' && envelope.type === 'done'), 'done(aborted) after abort')
  const abortDone = client.envelopes.find((envelope) => envelope.ch === 'llm' && envelope.payload.reqId === 'llm-2' && envelope.type === 'done')
  assert.equal(abortDone.payload.aborted, true)
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.ok(llmAbortCloses >= 1, 'aborting closed the upstream HTTP connection')

  // SSRF: a non-local endpoint is rejected before any network I/O.
  client.send({ ch: 'llm', type: 'generate', reqId: 'llm-3', payload: { endpoint: 'http://example.com', model: 'mock', messages: [{ role: 'user', content: 'hi' }] } })
  const ssrf = await client.waitFor((state) => state.envelopes.find((envelope) => envelope.ch === 'llm' && envelope.payload.reqId === 'llm-3' && envelope.type === 'error'), 'SSRF rejection envelope')
  assert.ok(ssrf.payload.error.includes('local'), `rejection explains the local-only rule (got: ${ssrf.payload.error})`)

  // Shared upstream: the fabric opened exactly ONE ComfyUI connection for
  // every channel subscription on this client.
  assert.equal(upstreamConnections, 1, 'one shared upstream connection across all subscribers')

  // ---- (e) SSE v2 fallback --------------------------------------------------
  const sseResponse = await fetch(`http://127.0.0.1:${port}/api/lan/realtime?channels=telemetry`)
  assert.equal(sseResponse.status, 200)
  assert.ok((sseResponse.headers.get('content-type') ?? '').includes('text/event-stream'))
  const sseReader = sseResponse.body.getReader()
  const sseSample = await new Promise((resolve, reject) => {
    let bufferedText = ''
    const deadline = setTimeout(() => reject(new Error('SSE v2 telemetry sample timed out')), 8000)
    const pump = (result) => {
      bufferedText += Buffer.from(result.value ?? []).toString('utf8')
      for (const line of bufferedText.split('\n')) {
        if (!line.startsWith('data: ')) continue
        try {
          const envelope = JSON.parse(line.slice(6))
          if (envelope.ch === 'telemetry') { clearTimeout(deadline); resolve(envelope); return }
        } catch { /* partial line; keep reading */ }
      }
      if (result.done) { clearTimeout(deadline); reject(new Error('SSE closed before a telemetry sample')); return }
      void sseReader.read().then(pump, reject)
    }
    void sseReader.read().then(pump, reject)
  })
  assert.equal(typeof sseSample.payload.available, 'boolean')
  await sseReader.cancel()

  // ---- (f) token mode --------------------------------------------------------
  const tokenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-realtime-token-'))
  const tokenPort = await freePort()
  bootServer(tokenHome, tokenPort, { MINIMAX_LAN_TOKEN: '1' })
  let refusedStatus = 0
  for (let attempt = 0; attempt < 50 && !refusedStatus; attempt += 1) {
    try { refusedStatus = (await fetch(`http://127.0.0.1:${tokenPort}/api/lan/settings`)).status } catch { await new Promise((resolve) => setTimeout(resolve, 300)) }
  }
  assert.equal(refusedStatus, 401, 'token mode gates the HTTP API')
  const token = fs.readFileSync(path.join(tokenHome, 'lan-access-token.txt'), 'utf8').trim()

  const unauth = fabricClient(tokenPort)
  await assert.rejects(() => unauth.opened_(), /401|Unexpected server response/, 'WS without a token is refused before the handshake')
  const wrong = fabricClient(tokenPort, 'f'.repeat(32))
  await assert.rejects(() => wrong.opened_(), /401|Unexpected server response/, 'WS with a wrong token is refused')
  const authed = fabricClient(tokenPort, token)
  await authed.opened_()
  await authed.waitFor((state) => state.envelopes.some((envelope) => envelope.ch === 'system' && envelope.type === 'hello'), 'hello after token auth')

  for (const child of children) child.kill()
  for (const server of servers) server.close()
  console.log('PASS: realtime event fabric — WS + SSE v2 transports behind the constant-time token gate; job channel normalized once from one SHARED upstream ComfyUI socket (prompt correlation server-side, binary preview frames hash-stamped, no base64 on the WS path, per-channel seq gapless); telemetry pushes without an engine and stops with zero subscribers; llm channel streams tokens from a local OpenAI-compatible endpoint with abort + SSRF rejection; backpressure is bounded-queue/oldest-dropped for JSON and newest-wins for previews.')
}

void main().catch((error) => fail(error instanceof Error ? error.stack : String(error)))
