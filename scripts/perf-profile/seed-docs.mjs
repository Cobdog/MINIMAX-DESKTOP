// Density-matrix seeder (profiler task eebh7ah): authors canvas documents
// through the REAL documents API — chain → output → blob-ingest (base64, the
// dropped-media path) → take with the blob artifact + metrics — so every tile
// the SPA renders is an honest document object backed by a real blob file.
// Records per-op server latency so document-CRUD throughput at density is a
// measured number, not a guess.
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "../../test-results/perf-profile")
const BASE = process.env.SEED_BASE ?? 'http://127.0.0.1:5301'
const TIERS = [10, 50, 150, 300]
const VIDEO_FRACTION = 0.55
const CONCURRENCY = 8

const videoRes = (i) => ['640x360', '832x480', '960x540', '1344x768', '768x1344', '1080x608'][i % 6]
const videoDur = (i) => 2 + (i % 5)

const timings = { ingest: [], chain: [], output: [], take: [] }
async function timed(kind, fn) {
  const started = performance.now()
  const result = await fn()
  timings[kind].push(performance.now() - started)
  return result
}

const api = async (pathname, method = 'GET', body) => {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) throw new Error(`${method} ${pathname} -> ${response.status}: ${(await response.text()).slice(0, 200)}`)
  return response.json()
}

async function seedObject(projectId, mediaPath, kind) {
  const bytes = await readFile(mediaPath)
  const name = path.basename(mediaPath)
  const ingest = await timed('ingest', () => api('/api/lan/documents/blobs/ingest', 'POST', {
    kind, name, data: bytes.toString('base64'),
  }))
  const { chain } = await timed('chain', () => api('/api/lan/documents/chains', 'POST', {
    projectId, kind: 'media', inputSpec: { fresh: { media: { kind }, name } }, settings: {},
  }))
  const { output } = await timed('output', () => api('/api/lan/documents/outputs', 'POST', {
    chainId: chain.id, substrates: ['decoded'],
  }))
  // metrics mirror the real drop path (store.ts ingestDrop): sourcePath =
  // engine-visible copy, blobPath = content-addressed artifact — so the
  // library projection (mediaForOutput) resolves every take.
  const metrics = kind === 'video'
    ? { kind, name, sourcePath: ingest.path, blobPath: ingest.blob.relPath, duration: videoDur(Number(/(\d+)\.mp4$/.exec(name)?.[1] ?? 0)), width: Number(videoRes(Number(/(\d+)\.mp4$/.exec(name)?.[1] ?? 0)).split('x')[0]), height: Number(videoRes(Number(/(\d+)\.mp4$/.exec(name)?.[1] ?? 0)).split('x')[1]) }
    : { kind, name, sourcePath: ingest.path, blobPath: ingest.blob.relPath }
  await timed('take', () => api('/api/lan/documents/takes', 'POST', {
    outputId: output.id, artifacts: [ingest.blob.relPath], metrics,
  }))
  return { chainId: chain.id, outputId: output.id, blob: ingest.blob.relPath, kind }
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  await Promise.all(Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  }))
  return results
}

function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  return { count: sorted.length, totalMs: Math.round(sorted.reduce((a, b) => a + b, 0)), p50: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1), max: +sorted[sorted.length - 1].toFixed(1) }
}

const videos = (await readdir(path.join(root, 'media/video'))).sort().map((name) => path.join(root, 'media/video', name))
const stills = (await readdir(path.join(root, 'media/still'))).sort().map((name) => path.join(root, 'media/still', name))

const state = { base: BASE, tiers: {} }
const tierTimings = {}
for (const tier of TIERS) {
  const videoCount = Math.round(tier * VIDEO_FRACTION)
  const stillCount = tier - videoCount
  const media = [
    ...videos.slice(0, videoCount).map((p) => ({ p, kind: 'video' })),
    ...stills.slice(0, stillCount).map((p) => ({ p, kind: 'image' })),
  ]
  const tierTimingsStart = JSON.parse(JSON.stringify(timings))
  const started = performance.now()
  const { project } = await api('/api/lan/documents/projects', 'POST', { name: `density-${tier}-v2` })
  const objects = await mapLimit(media, CONCURRENCY, (entry, index) => seedObject(project.id, entry.p, entry.kind, index))
  const wallMs = performance.now() - started

  const documentStarted = performance.now()
  const docResponse = await fetch(`${BASE}/api/lan/documents/project?id=${encodeURIComponent(project.id)}`)
  const docBody = await docResponse.text()
  const getMs = performance.now() - documentStarted

  const delta = {}
  for (const key of Object.keys(timings)) {
    const before = tierTimingsStart[key]?.length ?? 0
    delta[key] = summary(timings[key].slice(before))
  }
  tierTimings[tier] = delta
  state.tiers[tier] = {
    projectId: project.id,
    objects: objects.length,
    videos: videoCount,
    stills: stillCount,
    seedWallMs: Math.round(wallMs),
    seedConcurrency: CONCURRENCY,
    documentGetMs: +getMs.toFixed(1),
    documentBytes: docBody.length,
    documentKiB: Math.round(docBody.length / 1024),
  }
  console.log(`tier ${tier}: ${objects.length} objects in ${(wallMs / 1000).toFixed(1)}s; document GET ${getMs.toFixed(0)}ms, ${state.tiers[tier].documentKiB} KiB`)
}

state.opTimings = Object.fromEntries(Object.keys(timings).map((key) => [key, summary(timings[key])]))
await writeFile(path.join(root, 'artifacts/seed-state.json'), JSON.stringify(state, null, 2))
console.log('per-op totals across all tiers:', JSON.stringify(state.opTimings))
