// Server-side load driver (profiler task eebh7ah) — runs against the
// --cpu-prof/--heap-prof server instance. Five phases, each measured:
//   1. blob-serving burst    — concurrency 16 over distinct blob files
//   2. project GET burst     — the 300-object document read
//   3. FTS queries           — /api/lan/documents/search (take kind)
//   4. autosave churn        — session + camera view writes (the persist path)
//   5. WS fan-out            — 8 /ws clients, batch take appends, receipt latency
import { WebSocket } from 'ws'

const BASE = process.env.SEED_BASE ?? 'http://127.0.0.1:5302'
const WS_BASE = BASE.replace('http', 'ws')

const percentiles = (samples, p) => {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}
const summary = (samples) => ({
  count: samples.length,
  p50: +percentiles(samples, 0.5).toFixed(1),
  p95: +percentiles(samples, 0.95).toFixed(1),
  p99: +percentiles(samples, 0.99).toFixed(1),
  max: +Math.max(...samples).toFixed(1),
  mean: +(samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(1),
})

const get = async (pathname) => {
  const started = performance.now()
  const response = await fetch(`${BASE}${pathname}`)
  await response.arrayBuffer()
  if (!response.ok) throw new Error(`GET ${pathname} -> ${response.status}`)
  return performance.now() - started
}

const state = await (await fetch(`${BASE}/api/lan/documents/projects`)).json()
const tier300 = state.projects.find((project) => project.name === 'density-300-v2') ?? state.projects.find((project) => project.name.startsWith('density-300'))
if (!tier300) throw new Error('density-300 project not found — run seed-docs.mjs against this server first')
const document = await (await fetch(`${BASE}/api/lan/documents/project?id=${tier300.id}`)).json()
const blobs = document.chains.flatMap((chain) => chain.outputs.flatMap((output) => output.takes.map((take) => take.artifacts[0]))).filter(Boolean)
console.log(`tier-300 project ${tier300.id}: ${document.chains.length} chains, ${blobs.length} blob artifacts`)

// ---- phase 1: blob serving burst ----------------------------------------------
const BLOB_REQUESTS = 480
const BLOB_CONCURRENCY = 16
const blobLatencies = []
let blobCursor = 0
const blobStarted = performance.now()
await Promise.all(Array.from({ length: BLOB_CONCURRENCY }, async () => {
  for (let index = 0; index < BLOB_REQUESTS / BLOB_CONCURRENCY; index += 1) {
    const blob = blobs[(blobCursor++) % blobs.length]
    blobLatencies.push(await get(`/api/lan/documents/blobs/file?path=${encodeURIComponent(blob)}`))
  }
}))
const blobWall = performance.now() - blobStarted
console.log(`phase1 blob burst: ${BLOB_REQUESTS} reqs @ ${BLOB_CONCURRENCY}x in ${Math.round(blobWall)}ms → ${Math.round((BLOB_REQUESTS * 1000) / blobWall)} rps`, JSON.stringify(summary(blobLatencies)))

// ---- phase 2: project GET burst ------------------------------------------------
const DOC_REQUESTS = 240
const docLatencies = []
const docStarted = performance.now()
await Promise.all(Array.from({ length: BLOB_CONCURRENCY }, async () => {
  for (let index = 0; index < DOC_REQUESTS / BLOB_CONCURRENCY; index += 1) {
    docLatencies.push(await get(`/api/lan/documents/project?id=${tier300.id}`))
  }
}))
const docWall = performance.now() - docStarted
console.log(`phase2 project GET burst: ${DOC_REQUESTS} reqs @ ${BLOB_CONCURRENCY}x in ${Math.round(docWall)}ms → ${Math.round((DOC_REQUESTS * 1000) / docWall)} rps`, JSON.stringify(summary(docLatencies)))

// ---- phase 3: FTS queries -------------------------------------------------------
const ftsLatencies = []
for (let index = 0; index < 150; index += 1) {
  const query = index % 3 === 0 ? 'clip' : index % 3 === 1 ? 'still' : 'canvas-media'
  const started = performance.now()
  const response = await fetch(`${BASE}/api/lan/documents/search?q=${query}&kind=take&limit=50`)
  await response.json()
  if (!response.ok) throw new Error(`search -> ${response.status}`)
  ftsLatencies.push(performance.now() - started)
}
console.log('phase3 FTS search:', JSON.stringify(summary(ftsLatencies)))

// ---- phase 4: autosave churn (persistView path) ---------------------------------
const post = async (pathname, body) => {
  const started = performance.now()
  const response = await fetch(`${BASE}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  await response.json()
  if (!response.ok) throw new Error(`POST ${pathname} -> ${response.status}`)
  return performance.now() - started
}
const autosaveLatencies = []
for (let index = 0; index < 60; index += 1) {
  autosaveLatencies.push(await post('/api/lan/documents/session', { openProjects: [tier300.id], activeProject: tier300.id }))
  autosaveLatencies.push(await post('/api/lan/documents/projects/update', { id: tier300.id, camera: { camera: { x: 60 + index, y: 40 + index, k: 0.9 }, layout: {} } }))
}
console.log('phase4 autosave churn (120 writes):', JSON.stringify(summary(autosaveLatencies)))

// ---- phase 5: WS fan-out on batch takes -----------------------------------------
const CLIENTS = 8
const sockets = []
const received = Array.from({ length: CLIENTS }, () => [])
await Promise.all(Array.from({ length: CLIENTS }, ( _, i) => new Promise((resolve) => {
  const socket = new WebSocket(`${WS_BASE}/ws`)
  socket.on('open', () => { sockets.push(socket); resolve() })
  socket.on('message', (data) => received[i].push({ at: performance.now(), text: String(data).slice(0, 120) }))
  socket.on('error', () => resolve())
})))
console.log(`phase5 ws clients connected: ${sockets.length}`)

// batch-append 50 takes across existing outputs (the fan-out trigger)
const fanoutStarted = performance.now()
const appendLatencies = []
const outputs = document.chains.flatMap((chain) => chain.outputs.map((output) => output.id)).slice(0, 50)
for (const outputId of outputs) {
  appendLatencies.push(await post('/api/lan/documents/takes', { outputId, artifacts: [], metrics: { kind: 'image', name: `fanout-probe` } }))
}
const appendWall = performance.now() - fanoutStarted
await new Promise((resolve) => setTimeout(resolve, 1200))
const fanoutWall = performance.now() - fanoutStarted
const counts = received.map((list) => list.length)
console.log(`phase5 batch takes: 50 appends in ${Math.round(appendWall)}ms (${JSON.stringify(summary(appendLatencies))}); fan-out messages per client: ${counts.join('/')}; total wall incl. delivery ${Math.round(fanoutWall)}ms`)
const sample = received.find((list) => list.length)?.[Math.floor(counts.find((c) => c > 0) / 2) ?? 0]
console.log('phase5 sample fan-out message:', sample?.text)

for (const socket of sockets) socket.close()
console.log('LOAD DRIVER DONE')
