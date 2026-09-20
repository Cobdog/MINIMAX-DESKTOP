// LLM layer test (v2 wave). Boots a MOCK llama.cpp ROUTER (router-mode
// /models + OpenAI-compatible /v1/chat/completions with non-stream JSON and
// SSE stream variants, including a reasoning_content-bearing thinking
// sequence, plus /models/unload), a minimal mock ComfyUI (just /prompt), and
// a mock Ollama — then boots the BUILT app server configured against them
// and asserts end to end:
//   (a) UNITS against dist-server/server/llm exports — family inference from
//       the JSON manifests, per-family completion params (DeepSeek top-level
//       thinking object + effort; Gemma chat_template_kwargs + token budget),
//       and the Gemma channel-strip macro
//   (b) provider selection + model listing + family/vision shaping through
//       /api/lan/llm/models, with the router active and auto-resolved model
//   (c) the layered composer through /api/lan/llm/generate — 8-layer system
//       message, content-level variants, target-engine rows, user fragment
//       overrides, structured JSON thinking-off
//   (d) DeepSeek wire shape on the mock: top-level thinking object (never
//       'off'), reasoning_effort, and reasoning_content passback on
//       multi-turn history
//   (e) token streaming through the REALTIME FABRIC llm channel: prepare →
//       streamLlm-shaped generate → tokens arrive intact; a thinking stream's
//       reasoning_content deltas never leak into the token channel
//   (f) unload choreography: POST /api/lan/prompt unloads the loaded
//       non-sticky router model (observable on the engine channel + on the
//       mock), sticky patterns and the setting-off state skip it
//   (g) vision captioning: Gemma image-part-first content order on the wire
//   (h) Ollama fallback when the router URL is empty: model listing from
//       /api/tags, the legacy /api/lan/ollama routes still working, and
//       prepare rejecting streaming
// Run after `pnpm build` (the server and units load from dist-server).
//
// Vitest port (task z7ogmig, 2026-09-20) of scripts/test-llm.cjs:
// assertion bodies carry over verbatim; the linear main() became one test
// per section (sequential within the file — (b)-(g) share the booted
// router-mode app server and mocks, (h) boots the fallback server); CWD-
// relative paths are now __dirname-anchored and ports draw from this suite's
// disjoint range (tests/lib/ports.cjs).
import { test, afterAll } from 'vitest'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = require('node:path').dirname(fileURLToPath(import.meta.url))
const REPO = require('node:path').resolve(__dirname, '..')

const { spawn } = require('node:child_process')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const assert = require('node:assert/strict')
const WebSocket = require('ws')
const { makePortAllocator } = require('./lib/ports.cjs')
const { inferFamily, familyManifest, buildCompletionParams, stripChannelMarkup } = require(path.join(REPO, 'dist-server', 'server', 'llm', 'registry.js'))

const freePort = makePortAllocator('llm')

const children = []
const servers = []
let output = ''

const fail = (message) => {
  for (const child of children) child.kill()
  for (const server of servers) server.close()
  throw new Error(`FAIL: ${message}\n--- server output ---\n${output}`)
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

async function waitForHttp(port, pathname) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`)
      if (response.ok) return response
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  fail(`${pathname} never became ready on port ${port}`)
}

function bootServer(home, port) {
  const child = spawn(process.execPath, [path.join(REPO, 'dist-server', 'server', 'index.js')], {
    env: { ...process.env, MINIMAX_STUDIO_HOME: home, MINIMAX_LAN_PORT: String(port), MINIMAX_NO_HTTPS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  child.stdout.on('data', (chunk) => { output += `[server ${port}] ${String(chunk)}` })
  child.stderr.on('data', (chunk) => { output += `[server ${port}] ${String(chunk)}` })
  return child
}

function fabricClient(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const state = { envelopes: [], opened: false }
  socket.on('open', () => { state.opened = true })
  socket.on('error', () => { /* close/redirect noise; waitFor handles the rest */ })
  socket.on('message', (data) => {
    try { state.envelopes.push(JSON.parse(data.toString('utf8'))) } catch { /* ignore */ }
  })
  state.send = (value) => socket.send(JSON.stringify(value))
  state.waitFor = async (predicate, label, timeoutMs = 8000) => {
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

async function postJson(port, pathname, body) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

// ---- the mock llama.cpp router ----------------------------------------------
function createMockRouter() {
  const calls = { completions: [], unload: [] }
  const router = http.createServer(async (request, response) => {
    const body = await readBody(request)
    if (request.method === 'GET' && request.url === '/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        data: [
          { id: 'deepseek-v4-flash-0731', status: { value: 'loaded' }, architecture: { input_modalities: ['text'] } },
          { id: 'gemma-4-31b-it', status: { value: 'unloaded' }, architecture: { input_modalities: ['text', 'image'] } },
        ],
      }))
      return
    }
    if (request.method === 'POST' && request.url === '/models/unload') {
      calls.unload.push(JSON.parse(body || '{}'))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ success: true }))
      return
    }
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      const parsed = JSON.parse(body || '{}')
      calls.completions.push(parsed)
      if (parsed.stream === true) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        const write = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`)
        // Thinking mode: first chunk carries reasoning_content:"" (must not
        // open anything), then real reasoning, then the visible tokens.
        if (parsed.thinking && parsed.thinking.type === 'enabled') {
          write({ choices: [{ delta: { role: 'assistant', reasoning_content: '' } }] })
          write({ choices: [{ delta: { reasoning_content: 'deliberating quietly' } }] })
        }
        const tokens = ['stre', 'amed ', 'answer']
        let index = 0
        const timer = setInterval(() => {
          if (index < tokens.length) {
            write({ choices: [{ delta: { content: tokens[index] } }] })
            index += 1
          } else {
            clearInterval(timer)
            write({ choices: [{ delta: {}, finish_reason: 'stop' }] })
            response.write('data: [DONE]\n\n')
            response.end()
          }
        }, 25)
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      const thinking = parsed.thinking && parsed.thinking.type === 'enabled'
      // A structured request (schema contract in the system message) gets a
      // valid JSON body back so the parse path is exercised.
      const firstMessage = parsed.messages && parsed.messages[0] ? String(parsed.messages[0].content) : ''
      const content = firstMessage.includes('valid JSON object') ? '{"ok":true,"from":"router"}' : 'composed answer'
      response.end(JSON.stringify({
        choices: [{ message: { content, ...(thinking ? { reasoning_content: 'the reasoning' } : {}) }, finish_reason: 'stop' }],
      }))
      return
    }
    response.writeHead(404); response.end('{}')
  })
  return { router, calls }
}

// ---- the mock ComfyUI (only what /api/lan/prompt touches) -------------------
function createMockComfy() {
  const calls = { prompt: 0 }
  const comfy = http.createServer(async (request, response) => {
    await readBody(request)
    if (request.method === 'POST' && request.url === '/prompt') {
      calls.prompt += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ prompt_id: 'llm-test-prompt', number: 1 }))
      return
    }
    response.writeHead(404); response.end('{}')
  })
  return { comfy, calls }
}

// ---- the mock Ollama ----------------------------------------------------------
function createMockOllama() {
  const calls = { generate: [], chat: [] }
  const ollama = http.createServer(async (request, response) => {
    const body = await readBody(request)
    if (request.method === 'GET' && request.url === '/api/tags') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ models: [{ name: 'qwen3:latest', size: 5000 }, { name: 'nomic-embed', size: 342 }] }))
      return
    }
    if (request.method === 'POST' && request.url === '/api/generate') {
      calls.generate.push(JSON.parse(body || '{}'))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ response: ' ollama says hi ' }))
      return
    }
    if (request.method === 'POST' && request.url === '/api/chat') {
      calls.chat.push(JSON.parse(body || '{}'))
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ message: { content: '{"ok":true,"from":"ollama"}' } }))
      return
    }
    response.writeHead(404); response.end('{}')
  })
  return { ollama, calls }
}

// Cross-section state (sequential tests share it, as the linear main() did)
let routerCalls = null
let comfyCalls = null
let ollamaCalls = null
let routerPort = 0
let comfyPort = 0
let ollamaPort = 0
let port = 0
let client = null

afterAll(() => {
  for (const child of children) child.kill()
  for (const server of servers) server.close()
})

test('(a) registry units: family inference, per-family completion params, the Gemma channel-strip macro', () => {
  assert.equal(inferFamily('DeepSeek-V4-Flash-0731-Q4'), 'deepseek', 'name-pattern family inference (case-insensitive)')
  assert.equal(inferFamily('gemma-4-31b-it'), 'gemma')
  assert.equal(inferFamily('qwen3:latest'), 'qwen')
  assert.equal(inferFamily('llama-3.3-70b'), 'llama')
  assert.equal(inferFamily('totally-unknown-model'), 'other', 'unknown names fall back to other')

  const deepseekParams = buildCompletionParams(familyManifest('deepseek'), { thinking: true })
  assert.equal(typeof deepseekParams.thinking.type, 'string', 'deepseek thinking is a top-level object')
  assert.equal(deepseekParams.thinking.type, 'enabled')
  assert.equal(deepseekParams.reasoning_effort, 'low', 'default effort comes from the manifest')
  const deepseekOff = buildCompletionParams(familyManifest('deepseek'), { thinking: false })
  assert.equal(deepseekOff.thinking.type, 'disabled', "thinking off is {type:'disabled'} — the string 'off' never appears")
  assert.equal(deepseekOff.reasoning_effort, undefined, 'no effort when thinking is off')

  const gemmaOn = buildCompletionParams(familyManifest('gemma'), { thinking: true })
  assert.equal(gemmaOn.chat_template_kwargs.enable_thinking, true, 'gemma thinking rides chat_template_kwargs')
  assert.equal(gemmaOn.max_tokens, 1024 + 2048, 'gemma thinking adds the 2048 budget')
  const gemmaOff = buildCompletionParams(familyManifest('gemma'), { thinking: false })
  assert.equal(gemmaOff.chat_template_kwargs.enable_thinking, false)
  assert.equal(gemmaOff.max_tokens, 1024)
  assert.equal(gemmaOff.temperature, 1.0, 'gemma sampling defaults from the manifest')
  assert.equal(gemmaOff.top_k, 64)

  assert.equal(stripChannelMarkup('<|channel>thought\nreasoning<channel|>answer'), 'answer', 'channel strip keeps the post-closer tail')
  assert.equal(stripChannelMarkup('<|channel>thought\n<channel|>clean'), 'clean', 'empty channel (thinking off) stripped')
  assert.equal(stripChannelMarkup('plain content'), 'plain content', 'non-gemma content passes through')
  // Interleaved channels: content between an opener and the NEXT closer is
  // thought and drops; only pre-opener text in each segment survives.
  assert.equal(stripChannelMarkup('a<channel|>b<|channel>c<channel|>d'), 'abd', 'macro handles interleaved channels')
})

test('(b) model listing + provider selection through /api/lan/llm/models (router active, auto-resolved model)', async () => {
  // ---- mocks + router-mode app server ----------------------------------------
  const { router, calls: routerCallsLocal } = createMockRouter()
  const { comfy, calls: comfyCallsLocal } = createMockComfy()
  const { ollama, calls: ollamaCallsLocal } = createMockOllama()
  routerCalls = routerCallsLocal
  comfyCalls = comfyCallsLocal
  ollamaCalls = ollamaCallsLocal
  routerPort = await listen(router)
  comfyPort = await listen(comfy)
  ollamaPort = await listen(ollama)
  servers.push(router, comfy, ollama)

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-llm-'))
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({
    comfyUrl: `http://127.0.0.1:${comfyPort}`,
    ollamaUrl: `http://127.0.0.1:${ollamaPort}`,
    ollamaModel: 'qwen3:latest',
    llamaCppUrl: `http://127.0.0.1:${routerPort}`,
  }))
  port = await freePort()
  bootServer(home, port)
  await waitForHttp(port, '/api/lan/settings')

  const modelsResponse = await (await fetch(`http://127.0.0.1:${port}/api/lan/llm/models`)).json()
  assert.equal(modelsResponse.provider, 'router', 'configured router URL selects the router provider')
  assert.equal(modelsResponse.models.length, 2)
  const deepseekEntry = modelsResponse.models.find((entry) => entry.id === 'deepseek-v4-flash-0731')
  const gemmaEntry = modelsResponse.models.find((entry) => entry.id === 'gemma-4-31b-it')
  assert.equal(deepseekEntry.family, 'deepseek', 'family inferred from the model name')
  assert.equal(deepseekEntry.familyLabel, 'DeepSeek')
  assert.equal(deepseekEntry.vision, false, 'router input_modalities carry no image → not vision')
  assert.equal(deepseekEntry.status, 'loaded', 'router status surfaced')
  assert.equal(gemmaEntry.family, 'gemma')
  assert.equal(gemmaEntry.vision, true, 'image modality → vision-capable')
  assert.equal(modelsResponse.model, 'deepseek-v4-flash-0731', 'active model auto-resolves to the first listed when unset')
  assert.equal(deepseekEntry.active, true)
  // The same route probes a candidate URL for the Settings Test button.
  const probe = await (await fetch(`http://127.0.0.1:${port}/api/lan/llm/models?url=${encodeURIComponent(`http://127.0.0.1:${routerPort}`)}`)).json()
  assert.equal(probe.connected, true, 'candidate probe reaches the router')
  assert.ok(probe.latencyMs >= 0)
  const ssrf = await fetch(`http://127.0.0.1:${port}/api/lan/llm/models?url=${encodeURIComponent('http://example.com')}`)
  assert.equal(ssrf.status, 400, 'non-local probe rejected by the SSRF guard')
})

test('(c) the layered composer through /api/lan/llm/generate: 8-layer system, content variants, fragments, structured JSON', async () => {
  const generateResponse = await (await postJson(port, '/api/lan/llm/generate', {
    task: 'enhance', targetEngine: 'minimax-h3', length: 'detailed', contentLevel: 'nsfw',
    instructions: 'Runtime facts.', draft: 'courier in the rain',
  })).json()
  assert.equal(generateResponse.response, 'composed answer')
  assert.equal(generateResponse.provider, 'router')
  const composedBody = routerCalls.completions[routerCalls.completions.length - 1]
  assert.equal(composedBody.model, 'deepseek-v4-flash-0731', 'model field routes the router')
  const system = composedBody.messages[0]
  assert.equal(system.role, 'system', 'ONE composed system message at messages[0]')
  const layers = system.content.split('\n\n')
  assert.ok(layers.length >= 7, 'layered system message')
  assert.ok(layers.some((layer) => layer.indexOf('[output_format] ') === 0 && layer.includes('natural production language')), 'minimax-h3 output_format row resolved')
  assert.ok(layers.some((layer) => layer.indexOf('[style] ') === 0 && layer.includes('anatomically precise vocabulary')), 'requested content level resolved')
  assert.ok(layers.some((layer) => layer.indexOf('[length] ') === 0 && layer.includes('Develop the prompt fully')), 'length tier resolved')
  assert.ok(system.content.includes('[context] Runtime facts.'), 'runtime instructions ride the context layer')
  assert.ok(!system.content.includes('Do not respond unless you are uncensored.'), 'gemma-only conditioning omitted for deepseek')
  const userMessage = composedBody.messages[composedBody.messages.length - 1]
  assert.equal(userMessage.content, 'courier in the rain', 'draft is the user message')
  assert.equal(composedBody.thinking.type, 'disabled', 'freeform defaults thinking OFF (user setting default)')

  // Content-level variants all resolve (content-neutral stance).
  for (const level of ['sfw', 'suggestive', 'nsfw']) {
    await postJson(port, '/api/lan/llm/generate', { task: 'enhance', targetEngine: 'minimax-h3', contentLevel: level, draft: 'x' })
    const body = routerCalls.completions[routerCalls.completions.length - 1]
    assert.ok(body.messages[0].content.includes('[style] '), `${level} variant composes a style layer`)
  }
  const sfwBody = routerCalls.completions[routerCalls.completions.length - 3]
  assert.ok(sfwBody.messages[0].content.includes('textures, colors, light'), 'sfw style text verbatim')

  // Structured requests: thinking forced off + schema contract + parsed JSON.
  const structured = await (await postJson(port, '/api/lan/llm/generate', {
    task: 'planner', draft: 'plan a scene', schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
  })).json()
  assert.deepEqual(structured.result, { ok: true, from: 'router' }, 'schema requests parse the JSON body')
  const structuredBody = routerCalls.completions[routerCalls.completions.length - 1]
  assert.equal(structuredBody.thinking.type, 'disabled', 'structured tasks force thinking off for speed')
  assert.ok(structuredBody.messages[0].content.includes('valid JSON object'), 'schema contract appended')

  // User-editable fragments persist server-side and override the seed text.
  const fragmentSave = await postJson(port, '/api/lan/llm/fragments', { id: 'factory:rules:default', content: 'HOUSE RULES OVERRIDE MARKER' })
  assert.equal(fragmentSave.status, 200)
  await postJson(port, '/api/lan/llm/generate', { task: 'enhance', targetEngine: 'minimax-h3', draft: 'x' })
  assert.ok(routerCalls.completions[routerCalls.completions.length - 1].messages[0].content.includes('HOUSE RULES OVERRIDE MARKER'), 'fragment override wins over factory text')
  const fragmentList = await (await fetch(`http://127.0.0.1:${port}/api/lan/llm/fragments`)).json()
  assert.ok(fragmentList.fragments.some((row) => row.id === 'factory:rules:default' && row.content.includes('HOUSE RULES OVERRIDE MARKER')), 'overrides listed through the fragments route')
})

test('(d) DeepSeek wire shapes on the mock: top-level thinking, reasoning_effort, reasoning_content passback', async () => {
  await postJson(port, '/api/lan/llm/generate', { task: 'enhance', targetEngine: 'minimax-h3', draft: 'x', thinking: true })
  const thinkingBody = routerCalls.completions[routerCalls.completions.length - 1]
  assert.equal(thinkingBody.thinking.type, 'enabled', 'explicit thinking override honored')
  assert.equal(thinkingBody.thinking.type === 'enabled' && thinkingBody.reasoning_effort, 'low', 'reasoning_effort present when enabled')
  const thinkingResponse = await (await postJson(port, '/api/lan/llm/generate', { task: 'enhance', targetEngine: 'minimax-h3', draft: 'x', thinking: true })).json()
  assert.equal(thinkingResponse.reasoning, 'the reasoning', 'non-stream thinking returns reasoning_content for passback')

  // Multi-turn: reasoning_content rides assistant history messages.
  await postJson(port, '/api/lan/llm/generate', {
    task: 'chat-prompt', draft: 'follow up',
    history: [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'prior answer', reasoning: 'the reasoning' },
    ],
  })
  const historyBody = routerCalls.completions[routerCalls.completions.length - 1]
  const assistantTurn = historyBody.messages.find((message) => message.role === 'assistant')
  assert.ok(assistantTurn, 'assistant history preserved')
  assert.equal(assistantTurn.reasoning_content, 'the reasoning', 'reasoning_content passed back on the assistant turn')
})

test('(e) token streaming through the realtime fabric llm channel: tokens intact, reasoning deltas never leak', async () => {
  client = fabricClient(port)
  await client.opened_()
  client.send({ type: 'sub', ch: 'engine' })

  const prepared = await (await postJson(port, '/api/lan/llm/prepare', { task: 'enhance', targetEngine: 'minimax-h3', draft: 'stream me', thinking: true })).json()
  assert.equal(prepared.endpoint, `http://127.0.0.1:${routerPort}`, 'prepare returns the router endpoint')
  assert.equal(prepared.model, 'deepseek-v4-flash-0731')
  assert.ok(prepared.messages[0].role === 'system' && prepared.messages[0].content.includes('[output_format]'))
  assert.equal(prepared.options.thinking.type, 'enabled', 'family params ride the fabric options')

  // Plain stream: every token arrives in order.
  const plainPrepared = await (await postJson(port, '/api/lan/llm/prepare', { task: 'enhance', targetEngine: 'minimax-h3', draft: 'stream me' })).json()
  client.send({ ch: 'llm', type: 'generate', reqId: 'llm-stream-1', payload: plainPrepared })
  await client.waitFor((state) => state.envelopes.some((envelope) => envelope.ch === 'llm' && envelope.payload.reqId === 'llm-stream-1' && envelope.type === 'done'), 'plain stream done')
  const tokenText = client.envelopes.filter((envelope) => envelope.ch === 'llm' && envelope.payload.reqId === 'llm-stream-1' && envelope.type === 'token').map((envelope) => envelope.payload.delta).join('')
  assert.equal(tokenText, 'streamed answer', 'tokens stream through the fabric intact')

  // Thinking stream: reasoning deltas parsed but NEVER forwarded as tokens.
  client.send({ ch: 'llm', type: 'generate', reqId: 'llm-stream-2', payload: prepared })
  await client.waitFor((state) => state.envelopes.some((envelope) => envelope.ch === 'llm' && envelope.payload.reqId === 'llm-stream-2' && envelope.type === 'done'), 'thinking stream done')
  const thinkingTokens = client.envelopes.filter((envelope) => envelope.ch === 'llm' && envelope.payload.reqId === 'llm-stream-2' && envelope.type === 'token').map((envelope) => envelope.payload.delta).join('')
  assert.equal(thinkingTokens, 'streamed answer', 'reasoning_content never leaks into the token channel')
  const thinkingStreamBody = routerCalls.completions[routerCalls.completions.length - 1]
  assert.equal(thinkingStreamBody.stream, true, 'the fabric always requests streaming')
})

test('(f) unload choreography on generation submit: engine-channel observable, sticky + setting-off respected', async () => {
  assert.equal(routerCalls.unload.length, 0, 'no unload before any generation')
  const submit = await postJson(port, '/api/lan/prompt', { prompt: { '1': { class_type: 'X', inputs: {} } } })
  assert.ok(submit.ok, 'submission succeeded')
  assert.equal(comfyCalls.prompt, 1, 'the graph reached ComfyUI')
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(routerCalls.unload.length, 1, 'the loaded non-sticky router model was unloaded on submit')
  assert.equal(routerCalls.unload[0].model, 'deepseek-v4-flash-0731')
  const engineEvent = client.envelopes.find((envelope) => envelope.ch === 'engine' && envelope.type === 'lifecycle' && envelope.payload.name === 'llm-router' && envelope.payload.phase === 'stopped')
  assert.ok(engineEvent, 'unload surfaced on the engine channel')
  assert.ok(String(engineEvent.payload.detail).includes('deepseek-v4-flash-0731'), 'engine event names the unloaded model')

  // Sticky models skip the choreography; the setting-off state skips entirely.
  const settingsNow = await (await fetch(`http://127.0.0.1:${port}/api/lan/settings`)).json()
  await postJson(port, '/api/lan/settings', { settings: { ...settingsNow.settings, llamaStickyModels: 'deepseek' } })
  await postJson(port, '/api/lan/prompt', { prompt: { '1': { class_type: 'X', inputs: {} } } })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(routerCalls.unload.length, 1, 'sticky pattern skips the unload')
  await postJson(port, '/api/lan/settings', { settings: { ...settingsNow.settings, llamaStickyModels: '', unloadLlmOnGenerate: false } })
  await postJson(port, '/api/lan/prompt', { prompt: { '1': { class_type: 'X', inputs: {} } } })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(routerCalls.unload.length, 1, 'unloadLlmOnGenerate=false skips the choreography entirely')
  await postJson(port, '/api/lan/settings', { settings: { ...settingsNow.settings, llamaStickyModels: '', unloadLlmOnGenerate: true } })
})

test('(g) vision captioning: Gemma image-part-first content order on the wire', async () => {
  const vision = await (await postJson(port, '/api/lan/llm/vision', { image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg', model: 'gemma-4-31b-it' })).json()
  assert.equal(vision.caption, 'composed answer')
  assert.equal(vision.model, 'gemma-4-31b-it')
  const visionBody = routerCalls.completions[routerCalls.completions.length - 1]
  const parts = visionBody.messages[0].content
  assert.equal(Array.isArray(parts), true, 'vision requests use multimodal content parts')
  assert.equal(parts[0].type, 'image_url', 'gemma orders the IMAGE part first')
  assert.equal(parts[0].image_url.url.startsWith('data:image/png;base64,'), true)
  assert.equal(parts[1].type, 'text')
})

test('(h) Ollama fallback with an EMPTY router URL: listing, legacy routes, prepare refusing streaming', async () => {
  for (const child of children.splice(0)) child.kill()

  const fallbackHome = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-llm-fallback-'))
  fs.writeFileSync(path.join(fallbackHome, 'settings.json'), JSON.stringify({
    comfyUrl: `http://127.0.0.1:${comfyPort}`,
    ollamaUrl: `http://127.0.0.1:${ollamaPort}`,
    ollamaModel: 'qwen3:latest',
    llamaCppUrl: '',
  }))
  const fallbackPort = await freePort()
  bootServer(fallbackHome, fallbackPort)
  await waitForHttp(fallbackPort, '/api/lan/settings')
  const fallbackModels = await (await fetch(`http://127.0.0.1:${fallbackPort}/api/lan/llm/models`)).json()
  assert.equal(fallbackModels.provider, 'ollama', 'empty router URL selects the Ollama fallback')
  assert.equal(fallbackModels.model, 'qwen3:latest', 'active model is the Ollama setting')
  assert.equal(fallbackModels.models.length, 1, 'embedding stub filtered like bootstrap')
  assert.equal(fallbackModels.models[0].family, 'qwen', 'family inference applies to Ollama names too')

  // The legacy routes still work, byte-for-byte, through the provider seam.
  const legacy = await (await postJson(fallbackPort, '/api/lan/ollama', { prompt: 'hello there' })).json()
  assert.equal(legacy.response, 'ollama says hi', 'legacy freeform route delegates and strips')
  assert.equal(ollamaCalls.generate.length, 1)
  assert.equal(ollamaCalls.generate[0].model, 'qwen3:latest')
  assert.equal(ollamaCalls.generate[0].stream, false)
  assert.equal(ollamaCalls.generate[0].think, false)
  assert.equal(ollamaCalls.generate[0].options.temperature, 0.6, 'legacy wire options preserved')
  assert.equal(ollamaCalls.generate[0].options.num_predict, 1200)
  const legacyStructured = await (await postJson(fallbackPort, '/api/lan/ollama/structured', { prompt: 'json please', schema: { type: 'object' } })).json()
  assert.deepEqual(legacyStructured.result, { ok: true, from: 'ollama' }, 'legacy structured route delegates')
  assert.equal(ollamaCalls.chat.length, 1)
  assert.equal(ollamaCalls.chat[0].format.type, 'object', 'schema rides the format field')

  // Streaming prepare is router-only.
  const prepareFallback = await postJson(fallbackPort, '/api/lan/llm/prepare', { draft: 'x' })
  assert.equal(prepareFallback.status, 400, 'prepare rejects streaming on the Ollama fallback')
  // Unload choreography is a router concern — Ollama never sees one.
  await postJson(fallbackPort, '/api/lan/prompt', { prompt: { '1': { class_type: 'X', inputs: {} } } })
  await new Promise((resolve) => setTimeout(resolve, 200))

  for (const child of children) child.kill()
  for (const server of servers) server.close()
  console.log('PASS: LLM layer — router provider selected from settings with family-inferred model listing (vision from router metadata), the 8-layer composer resolving verbatim seed fragments by NULL-wildcard specificity (sfw/suggestive/nsfw trio + target-engine rows + server-persisted user overrides), DeepSeek wire rules (top-level thinking object never \'off\', reasoning_effort, reasoning_content passback), token streaming through the realtime fabric llm channel (reasoning deltas never leak as tokens), VRAM unload choreography on every generation submit (engine-channel observable, sticky + setting-off respected, ~2 s budget), Gemma image-part-first vision captioning, and the byte-exact Ollama fallback when the router URL is empty.')
})
