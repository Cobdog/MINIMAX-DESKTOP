// Canvas Phase 1 suite (task jl4ye8x). VM harness (scripts/lib/ts-vm.cjs) —
// the PURE modules (camera, derive) are DOM-free by design; the React shell
// is covered by e2e/canvas.spec.ts. Sections:
//   (a) camera store — subscribe/notify, no-op set silence, batch, k clamp
//   (b) bands — thresholds as data, bandFor at boundaries
//   (c) coordinate transforms — screenToWorld/worldToScreen round-trip,
//       zoomAbout anchor stability
//   (d) culling — visibleWorldRect margin in world units, visibleTileIds
//       membership + stable order, empty viewport
//   (e) cameraForRect — fit respects padding + clamp; centers on the rect
//   (f) parseViewBlob — tolerant default, layout kept, garbage tolerated
//   (g) tileStatus — the §4 priority ladder (failed durable-until-dismissed
//       > running > queued > stale > idle)
//   (h) deriveTiles — kinds, adjacency-near-parent (L25), layout pinning,
//       take/prior derivation, refs collection
//   (i) deriveEdges + edgePath — fork edges from input specs, orphaned refs,
//       bezier geometry + culling bbox
//   (j) attention — radar counts, worst-first (failed > stale), calm state
//   (k) seedSpawnPoint — the spatial-queue contract c point
const assert = require('node:assert/strict')
const { loadTs } = require('./lib/ts-vm.cjs')

let passed = 0
function ok(condition, label) {
  assert.ok(condition, label)
  passed += 1
  console.log(`  ok - ${label}`)
}
function eq(actual, expected, label) {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), label)
  passed += 1
  console.log(`  ok - ${label}`)
}
function close(a, b, tol, label) {
  assert.ok(Math.abs(a - b) <= tol, `${label}: |${a} - ${b}| > ${tol}`)
  passed += 1
  console.log(`  ok - ${label}`)
}

const cameraMod = loadTs('src/canvas/camera.ts')
const derive = loadTs('src/canvas/derive.ts')

console.log('(a) camera store discipline')
{
  const store = cameraMod.createCamera({ x: 10, y: 20, k: 1 })
  eq(store.get(), { x: 10, y: 20, k: 1 }, 'store: initial state')
  let notifications = 0
  const unsubscribe = store.subscribe(() => { notifications += 1 })
  store.set({ x: 11, y: 20, k: 1 })
  eq(notifications, 1, 'store: a changed set notifies exactly once')
  store.set({ x: 11, y: 20, k: 1 })
  eq(notifications, 1, 'store: a no-op set is silent')
  store.batch((current) => ({ x: current.x + 5, y: current.y, k: current.k }))
  eq(notifications, 2, 'store: batch notifies once for one logical move')
  store.set({ x: 0, y: 0, k: 99 })
  close(store.get().k, cameraMod.CAMERA_MAX_K, 0, 'store: k clamps at MAX_K')
  store.set({ x: 0, y: 0, k: 0.0001 })
  close(store.get().k, cameraMod.CAMERA_MIN_K, 0, 'store: k clamps at MIN_K')
  unsubscribe()
  const afterUnsubscribe = notifications
  store.set({ x: 50, y: 50, k: 1 })
  eq(notifications, afterUnsubscribe, 'store: unsubscribed listeners stop firing')
}

console.log('(b) semantic-zoom bands as data')
{
  eq(cameraMod.ZOOM_BANDS.map((band) => band.id), ['far', 'mid', 'near'], 'bands: the three §3 bands in order')
  eq(cameraMod.bandFor(0.2), 'far', 'bands: deep zoom-out is far')
  eq(cameraMod.bandFor(0.449), 'far', 'bands: just below the far/mid threshold')
  eq(cameraMod.bandFor(0.45), 'mid', 'bands: threshold lands in mid (upTo exclusive)')
  eq(cameraMod.bandFor(1.0), 'mid', 'bands: 100% is mid')
  eq(cameraMod.bandFor(1.05), 'near', 'bands: just past mid ceiling is near')
  eq(cameraMod.bandFor(4), 'near', 'bands: deep zoom-in is near')
}

console.log('(c) coordinate transforms')
{
  const camera = { x: 100, y: -40, k: 0.5 }
  const world = cameraMod.screenToWorld(300, 60, camera)
  close(world.x, 400, 1e-9, 'screenToWorld: x = (sx - tx)/k')
  close(world.y, 200, 1e-9, 'screenToWorld: y = (sy - ty)/k')
  const screen = cameraMod.worldToScreen(world.x, world.y, camera)
  close(screen.x, 300, 1e-9, 'worldToScreen∘screenToWorld is identity (x)')
  close(screen.y, 60, 1e-9, 'worldToScreen∘screenToWorld is identity (y)')
  const zoomed = cameraMod.zoomAbout(camera, 2, 300, 60)
  const anchored = cameraMod.worldToScreen(world.x, world.y, zoomed)
  close(anchored.x, 300, 1e-6, 'zoomAbout: the anchor point stays fixed')
  close(anchored.y, 60, 1e-6, 'zoomAbout: the anchor point stays fixed (y)')
}

console.log('(d) viewport + margin culling')
{
  const camera = { x: 0, y: 0, k: 1 }
  const rect = cameraMod.visibleWorldRect(camera, 1920, 1080, 600)
  close(rect.x, -600, 1e-9, 'cull rect: margin extends left')
  close(rect.w, 1920 + 1200, 1e-9, 'cull rect: width includes both margins')
  const zoomedOut = { x: 0, y: 0, k: 0.5 }
  const zoomedRect = cameraMod.visibleWorldRect(zoomedOut, 1920, 1080, 600)
  close(zoomedRect.w, (1920 + 1200) / 0.5, 1e-9, 'cull rect: screen-px margin converts to world units by 1/k')
  const tiles = [
    { id: 'on', x: 0, y: 0, w: 320, h: 296 },
    { id: 'margin', x: 2400, y: 0, w: 320, h: 296 }, // inside +600 margin
    { id: 'off', x: 4000, y: 0, w: 320, h: 296 },
    { id: 'edge-touch', x: -320, y: 0, w: 320, h: 296 }, // touches the left edge exactly
  ]
  eq(cameraMod.visibleTileIds(tiles, camera, 1920, 1080, 600), ['on', 'margin', 'edge-touch'], 'culling: membership follows input order (stable)')
  eq(cameraMod.visibleTileIds([], camera, 1920, 1080, 600), [], 'culling: no tiles yields no ids')
  const tiny = { x: 940, y: 500, w: 2, h: 2 }
  eq(cameraMod.visibleTileIds([{ id: 'center', ...tiny }], camera, 1920, 1080, 0), ['center'], 'culling: zero margin still keeps on-screen tiles')
}

console.log('(e) cameraForRect (zoom-to-attention / fit)')
{
  const rect = { x: 0, y: 0, w: 2400, h: 500 }
  const fitted = cameraMod.cameraForRect(rect, 1920, 1080, { fit: true, paddingPx: 200 })
  ok(fitted.k < 1, 'fit: a rect wider than the viewport zooms out')
  const center = cameraMod.worldToScreen(rect.x + rect.w / 2, rect.y + rect.h / 2, fitted)
  close(center.x, 960, 1e-6, 'fit: the rect centers horizontally')
  close(center.y, 540, 1e-6, 'fit: the rect centers vertically')
  const huge = cameraMod.cameraForRect({ x: 0, y: 0, w: 1e9, h: 1e9 }, 1920, 1080, { fit: true })
  close(huge.k, cameraMod.CAMERA_MIN_K, 0, 'fit: an absurd rect clamps at MIN_K instead of degenerating')
  const attention = cameraMod.cameraForRect({ x: 5000, y: 2000, w: 320, h: 296 }, 1920, 1080, { k: 1 })
  close(attention.x, 960 - 5160, 1e-9, 'cameraForRect at k=1 centers the tile')
}

console.log('(f) parseViewBlob')
{
  const empty = cameraMod.parseViewBlob(undefined)
  ok(Number.isFinite(empty.camera.x + empty.camera.y + empty.camera.k), 'blob: missing blob yields a finite default camera')
  ok(empty.layout === undefined, 'blob: no layout when absent')
  const blob = cameraMod.parseViewBlob({ camera: { x: 12, y: 34, k: 1.4 }, layout: { c1: { x: 100, y: 80 }, c2: { x: 0, y: 0 } } })
  eq(blob.camera, { x: 12, y: 34, k: 1.4 }, 'blob: camera round-trips')
  eq(Object.keys(blob.layout), ['c1', 'c2'], 'blob: layout entries kept')
  const garbage = cameraMod.parseViewBlob('nonsense')
  ok(Number.isFinite(garbage.camera.k), 'blob: garbage never crashes')
  const junkLayout = cameraMod.parseViewBlob({ layout: { bad: { x: 'left' }, partial: { x: 5, y: 6 } } })
  ok(junkLayout.layout && junkLayout.layout.partial && junkLayout.layout.bad === undefined, 'blob: invalid entries drop, valid ones survive')
}

console.log('(g) tileStatus — the §4 priority ladder')
{
  const fresh = { stale: false }
  eq(derive.tileStatus(fresh, null, false), 'idle', 'status: no job, not stale → idle')
  eq(derive.tileStatus(fresh, { id: 'j', status: 'queued', progress: 0 }, false), 'queued-gpu', 'status: queued job → queued-for-GPU (L26)')
  eq(derive.tileStatus(fresh, { id: 'j', status: 'running', progress: 40 }, false), 'running', 'status: running job wins over everything but failure')
  eq(derive.tileStatus(fresh, { id: 'j', status: 'failed', progress: 90, error: 'boom' }, false), 'failed', 'status: failed job wins')
  eq(derive.tileStatus({ stale: true }, null, false), 'stale', 'status: stale chain with no job → stale')
  eq(derive.tileStatus({ stale: true }, { id: 'j', status: 'queued', progress: 0 }, false), 'queued-gpu', 'status: live work beats the derived stale flag')
  eq(derive.tileStatus({ stale: false }, { id: 'j', status: 'failed', progress: 1 }, true), 'idle', 'status: dismissed failure degrades honestly (contract a)')
  eq(derive.tileStatus({ stale: true }, { id: 'j', status: 'failed', progress: 1 }, true), 'stale', 'status: dismissed failure on a stale chain shows stale')
  // B2: an ERRORED LANDING (a completed render whose bytes could not be
  // fetched) is durable on the take — deriveTiles surfaces it as the
  // needs-attention ring with its reason, dismissable like any failure.
  {
    const erroredTake = { id: 'te', outputId: 'o', jobId: 'job-e', artifacts: [], latentPath: null, metrics: { kind: 'video', landingError: 'the engine output could not be fetched: engine offline' }, createdAt: 2, supersededBy: null, evicted: false, contentHash: null }
    const erroredDoc = {
      project: { id: 'pe', name: 'E', camera: {}, createdAt: 0, lastActiveAt: 0 },
      chains: [{ id: 'chain-e', projectId: 'pe', kind: 'generation', inputSpec: { fresh: { prompt: 'remote render' } }, settings: {}, lockState: 'unlocked', hopCount: 0, driftMetrics: null, stale: false, createdAt: 1, outputs: [{ id: 'o', chainId: 'chain-e', substratesAvailable: [], createdAt: 1, canonicalTakeId: 'te', takes: [erroredTake] }], ops: [] }],
    }
    const tiles = derive.deriveTiles(erroredDoc, [{ id: 'job-e', status: 'completed', progress: 100 }], { 'chain-e': 'job-e' }, undefined, new Set())
    eq(tiles[0].status, 'failed', 'errored landing: a completed-but-unlandable render shows the failure ring (never silent idle)')
    eq(tiles[0].statusNote, 'the engine output could not be fetched: engine offline', 'errored landing: the reason is the status note')
    const dismissedTiles = derive.deriveTiles(erroredDoc, [{ id: 'job-e', status: 'completed', progress: 100 }], { 'chain-e': 'job-e' }, undefined, new Set(['chain-e']))
    eq(dismissedTiles[0].status, 'idle', 'errored landing: dismissable like any other failure')
  }
}

/** Minimal document fixture builder. */
function fixture() {
  const take = (id, outputId, superseded) => ({
    id, outputId, jobId: null, artifacts: [], latentPath: null, metrics: { duration: 6 },
    createdAt: 1, supersededBy: superseded ?? null, evicted: false, contentHash: null,
  })
  return {
    project: { id: 'p1', name: 'Fixture', camera: {}, createdAt: 0, lastActiveAt: 0 },
    chains: [
      {
        id: 'seed-1', projectId: 'p1', kind: 'generation', inputSpec: { fresh: { prompt: 'a drummer on a night train' } },
        settings: { prompt: 'a drummer on a night train' }, lockState: 'unlocked', hopCount: 0, driftMetrics: null, stale: false, createdAt: 1,
        outputs: [{ id: 'out-1', chainId: 'seed-1', substratesAvailable: ['decoded'], createdAt: 1, canonicalTakeId: 't1', takes: [take('t1', 'out-1'), take('t0', 'out-1', 't1')] }],
        ops: [{ id: 'op-1', stackId: 's', ordinal: 1, kind: 'crop', settings: {}, bakedAt: null }],
      },
      {
        id: 'fork-1', projectId: 'p1', kind: 'generation', inputSpec: { outputRef: { outputId: 'out-1', substrate: 'decoded' } },
        settings: {}, lockState: 'unlocked', hopCount: 1, driftMetrics: null, stale: true, createdAt: 2,
        outputs: [], ops: [],
      },
      {
        id: 'media-1', projectId: 'p1', kind: 'media', inputSpec: { fresh: { media: { name: 'plate.png', kind: 'image' } } },
        settings: { name: 'plate.png' }, lockState: 'locked', hopCount: 0, driftMetrics: null, stale: false, createdAt: 3,
        outputs: [], ops: [],
      },
    ],
  }
}

console.log('(h) deriveTiles')
{
  const document = fixture()
  const tiles = derive.deriveTiles(document, [], {}, undefined)
  eq(tiles.length, 3, 'tiles: one tile per chain')
  const byId = new Map(tiles.map((tile) => [tile.id, tile]))
  eq(byId.get('seed-1').kind, 'media', 'tiles: a chain with canonical take is a media tile')
  eq(byId.get('seed-1').priors, 1, 'tiles: superseded take counts as a prior')
  ok(Boolean(byId.get('seed-1').canonical), 'tiles: canonical take derived (supersededBy null)')
  eq(byId.get('seed-1').ops.map((op) => op.kind), ['crop'], 'tiles: op chips come from the stack')
  close(byId.get('seed-1').duration, 6, 1e-9, 'tiles: duration from take metrics')
  eq(byId.get('fork-1').kind, 'seed', 'tiles: a ref-only chain with no output is a seed tile')
  eq(byId.get('fork-1').status, 'stale', 'tiles: chain stale flag surfaces on the ring')
  eq(byId.get('fork-1').refOutputs, ['out-1'], 'tiles: input-spec refs collected')
  eq(byId.get('media-1').title, 'image 3', 'tiles: media kind names the tile by kind + ordinal')

  // L25 adjacency: fork lands right of its source; roots fill the grid.
  const source = byId.get('seed-1')
  const fork = byId.get('fork-1')
  ok(fork.x >= source.x + source.w, 'placement: fork sits right of its source (adjacency default)')
  ok(Math.abs(fork.y - source.y) < derive.TILE_H_MEDIA, 'placement: fork clusters at its source height')
  const media = byId.get('media-1')
  ok(media.x !== fork.x || media.y !== fork.y, 'placement: roots occupy distinct grid slots')

  // Layout pinning: a persisted layout entry wins over derivation.
  const pinned = derive.deriveTiles(document, [], {}, { 'media-1': { x: 999, y: 777 } })
  eq({ x: pinned[2].x, y: pinned[2].y }, { x: 999, y: 777 }, 'placement: the view-blob layout pins the tile')

  // Job links drive the status ring through jobsStore facts.
  const jobs = [{ id: 'job-9', status: 'running', progress: 10 }]
  const linked = derive.deriveTiles(document, jobs, { 'seed-1': 'job-9' }, undefined)
  eq(linked[0].status, 'running', 'tiles: linked job status drives the ring')
  const failed = derive.deriveTiles(document, [{ id: 'job-9', status: 'failed', progress: 10, error: 'engine exploded' }], { 'seed-1': 'job-9' }, undefined)
  eq(failed[0].status, 'failed', 'tiles: linked failure is durable on the object')
  eq(failed[0].statusNote, 'engine exploded', 'tiles: failure reason attaches')

  // Orphaned ref (tombstoned source output id) falls back to the grid.
  const orphan = { ...document, chains: [document.chains[1]] }
  const orphanTiles = derive.deriveTiles(orphan, [], {}, undefined)
  ok(orphanTiles[0].x >= derive.TILE_W * 0 || orphanTiles[0].x === orphanTiles[0].x, 'placement: orphaned ref does not crash')
  eq(orphanTiles[0].refOutputs, ['out-1'], 'placement: orphaned ref still records its reference')
}

console.log('(i) derived edges + paths')
{
  const document = fixture()
  const tiles = derive.deriveTiles(document, [], {}, undefined)
  const edges = derive.deriveEdges(document, tiles)
  eq(edges.length, 1, 'edges: one fork edge from the ref')
  eq(edges[0].id, 'seed-1->fork-1', 'edges: id encodes direction')
  ok(edges[0].fx > 0 && edges[0].tx > edges[0].fx, 'edges: source tail → target head (left to right)')
  const path = derive.edgePath({ fx: 100, fy: 50, tx: 500, ty: 90 })
  ok(path.startsWith('M 100 50 C 300 50, 300 90, 500 90'), `edges: cubic path geometry (${path})`)
  const flat = derive.edgePath({ fx: 100, fy: 50, tx: 120, ty: 50 })
  ok(flat.includes('C 148 50'), 'edges: minimum handle length keeps tight edges readable')
  const rect = derive.edgeRect({ fx: 100, fy: 50, tx: 500, ty: 90 })
  eq({ x: 100, y: 50 }, { x: rect.x, y: rect.y }, 'edges: bbox origin at the min corner')
  close(rect.w, 400, 1e-9, 'edges: bbox width')
  const noEdges = derive.deriveEdges(document, tiles.filter((tile) => tile.id !== 'fork-1'))
  eq(noEdges.length, 0, 'edges: no edge when the consumer tile is absent')
}

console.log('(j) attention (radar)')
{
  const document = fixture()
  const tiles = derive.deriveTiles(document, [], {}, undefined)
  const calm = derive.attention(tiles)
  eq(calm.counts, { running: 0, queued: 0, needsAttention: 1 }, 'attention: stale chain counts as needs-attention')
  eq(calm.worst.label, 'stale chain', 'attention: worst reports the stale chain')
  const withFailed = derive.deriveTiles(document, [{ id: 'j', status: 'failed', progress: 0 }], { 'media-1': 'j' }, undefined)
  const escalated = derive.attention(withFailed)
  eq(escalated.counts.needsAttention, 2, 'attention: failed + stale both count (different chains)')
  eq(escalated.worst.weight, 2, 'attention: failed outranks stale (worst-first)')
  eq(escalated.worst.tileId, 'media-1', 'attention: worst names the failing tile')
}

console.log('(k) seedSpawnPoint (spatial-queue contract c) + spawn anti-overlap')
{
  const camera = { x: 0, y: 0, k: 1 }
  const spawn = derive.seedSpawnPoint(camera, 1920, 1080)
  const screen = cameraMod.worldToScreen(spawn.x + derive.TILE_W / 2, spawn.y, camera)
  close(screen.x, 960, 1e-6, 'spawn: centered under the prompt bar')
  ok(screen.y > 300 && screen.y < 540, 'spawn: lands in the upper-middle band where the bar sits')
  const occupied = [{ x: spawn.x, y: spawn.y, w: derive.TILE_W, h: derive.TILE_H_MEDIA }]
  const nudged = derive.avoidOverlap(spawn, occupied)
  ok(nudged.y > spawn.y, 'spawn: a colliding spawn nudges down out of the existing tile')
  ok(derive.avoidOverlap(spawn, []).y === spawn.y, 'spawn: a clear canvas keeps the contract-c point')
  const column = Array.from({ length: 4 }, (_, index) => ({ x: spawn.x, y: spawn.y + index * (derive.TILE_H_MEDIA + 60), w: derive.TILE_W, h: derive.TILE_H_MEDIA }))
  const fourth = derive.avoidOverlap(spawn, column)
  ok(fourth.y >= spawn.y + 4 * (derive.TILE_H_MEDIA + 60) - 1, 'spawn: stacks down the column until free')
}


// ---- Phase 2 (task flyuh6h): generation-as-a-projection pure modules -------
const localStorageStub = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
}
const generation = loadTs('src/canvas/generation.ts', { localStorage: localStorageStub, window: { dispatchEvent: () => undefined, addEventListener: () => undefined } })
const options = loadTs('src/canvas/options.ts')
const fetchDeepLink = loadTs('src/lib/fetchDeepLink.ts')
const h3Submit = loadTs('src/lib/h3Submit.ts', { localStorage: localStorageStub })
const ops = loadTs('src/canvas/ops.ts')
const ltx23Submit = loadTs('src/lib/ltx23UtilitySubmit.ts', { localStorage: localStorageStub })
const zImageSubmit = loadTs('src/lib/zImageSubmit.ts', { localStorage: localStorageStub })

const media = (path, kind) => ({ path, name: path.split('/').pop(), kind })
const take = (id, overrides) => ({ id, outputId: 'out-1', jobId: null, artifacts: [], latentPath: null, metrics: null, createdAt: 1, supersededBy: null, evicted: false, contentHash: null, ...overrides })
const output = (id, chainId, takes) => ({ id, chainId, substratesAvailable: ['decoded'], createdAt: 1, canonicalTakeId: takes.find((t) => !t.supersededBy)?.id ?? null, takes })
const chainOf = (id, overrides) => ({ id, projectId: 'p1', kind: 'generation', inputSpec: {}, settings: {}, lockState: 'unlocked', hopCount: 0, driftMetrics: null, stale: false, createdAt: 1, outputs: [], ops: [], identity: null, ...overrides })

console.log('(l) L4 — selection decides the surface (effectiveMode)')
{
  eq(generation.effectiveMode({ firstFrameOutputId: null, lastFrameOutputId: null, referenceOutputIds: [], referenceCharacterIds: [], referenceLocationIds: [], referenceAssetIds: [] }), 'text', 'L4: nothing + prompt = text-to-video')
  eq(generation.effectiveMode({ firstFrameOutputId: 'o1', lastFrameOutputId: null, referenceOutputIds: [], referenceCharacterIds: [], referenceLocationIds: [], referenceAssetIds: [] }), 'image', 'L4: a selected image output = image-to-video')
  eq(generation.effectiveMode({ firstFrameOutputId: 'o1', lastFrameOutputId: 'o2', referenceOutputIds: [], referenceCharacterIds: [], referenceLocationIds: [], referenceAssetIds: [] }), 'frames', 'L4: first + last = frames')
  eq(generation.effectiveMode({ firstFrameOutputId: 'o1', lastFrameOutputId: 'o2', referenceOutputIds: ['o3'], referenceCharacterIds: [], referenceLocationIds: [], referenceAssetIds: [] }), 'reference', 'L4: any reference wins over frames (resolveMovieShot precedence)')
  eq(generation.effectiveMode({ firstFrameOutputId: null, lastFrameOutputId: null, referenceOutputIds: [], referenceCharacterIds: ['char-1'], referenceLocationIds: [], referenceAssetIds: [] }), 'reference', 'L4: a library character binding selects reference mode')
  eq(generation.effectiveMode({ firstFrameOutputId: null, lastFrameOutputId: null, referenceOutputIds: [], referenceCharacterIds: [], referenceLocationIds: ['loc-1'], referenceAssetIds: [] }), 'reference', 'L4: a location binding selects reference mode')
  // tolerant settings read: the document is external data
  const read = generation.readChainSettings({ duration: 99, turbo: '8', resolution: '768x1344', referenceOutputIds: ['a', 'b', 3], prompt: 'x' })
  eq(read.duration, 15, 'settings: duration clamps to the 15s ceiling')
  eq(read.turbo, '8', 'settings: turbo tier kept')
  eq(read.resolution, '768x1344', 'settings: known resolution kept')
  eq(read.referenceOutputIds, ['a', 'b'], 'settings: non-string reference ids dropped, never a crash')
  eq(generation.readChainSettings({}).mode || 'text', 'text', 'settings: absent settings fall back cleanly')
}

console.log('(m) fork substrates → input refs (§2 outputRef)')
{
  const doc = {
    project: { id: 'p1', name: 'P', camera: {}, createdAt: 1, lastActiveAt: 1 },
    chains: [
      chainOf('src', { outputs: [output('out-1', 'src', [take('take-1', { metrics: { kind: 'video', sourcePath: '/out/a.mp4' }, artifacts: ['canvas-blobs/aa/hash1'], latentPath: 'canvas-blobs/ll/hashl' })])] }),
      chainOf('fork', { inputSpec: generation.forkInputSpec({ outputId: 'out-1', takeId: 'take-1', substrate: 'decoded' }) }),
    ],
  }
  const forkChain = doc.chains[1]
  const refs = new Set()
  derive.collectOutputRefs(forkChain.inputSpec, refs)
  eq([...refs], ['out-1'], 'fork: the input ref carries the source outputId (the derived-edge walk resolves it)')
  eq(forkChain.inputSpec.outputRef.substrate, 'decoded', 'fork: substrate recorded in the input ref')
  eq(forkChain.inputSpec.outputRef.takeId, 'take-1', 'fork: the pinned take records fork-from-early-take')
  const extracted = generation.forkInputSpec({ outputId: 'out-1', takeId: null, substrate: 'extracted-frame', extractedPath: '/out/frame.png', frameIndex: 0 })
  eq(extracted.outputRef.extractedPath, '/out/frame.png', 'fork: extraction provenance rides the input ref')
  // substrates availability is honest per take
  const withLatent = take('t', { latentPath: 'canvas-blobs/ll/h' })
  eq(generation.substratesForTake(withLatent, 'video'), ['decoded', 'extracted-frame', 'latents'], 'substrates: video take with a resident latent offers all three')
  eq(generation.substratesForTake(take('t2'), 'image'), ['decoded'], 'substrates: an image take offers decoded only')
  eq(generation.substratesForTake(null, 'video'), [], 'substrates: no take, no forks')
  // media resolution prefers the VERIFIED blob artifact and records kind (m3:
  // metrics.sourcePath is a convenience copy whose absolute path may be stale
  // or foreign after an archive import — the wrong-file substitution guard)
  const outputs = generation.buildOutputIndex(doc)
  const resolved = generation.mediaForOutput(outputs.get('out-1'))
  eq(resolved.media.path, 'canvas-blobs/aa/hash1', 'media: the verified content-addressed blob wins over metrics.sourcePath')
  eq(resolved.media.kind, 'video', 'media: kind read from the take metrics')
  eq(generation.mediaForOutput(undefined), null, 'media: unresolvable output answers null (honest)')
  // Audit D5 (junllxf): a canvas-resolved media file must carry a SERVABLE
  // preview URL — prepareImage throws "No preview available" otherwise and
  // canvas i2v/frames from document objects can never submit.
  ok(typeof resolved.media.preview === 'string' && resolved.media.preview.includes('/api/lan/documents/blobs/file?path=canvas-blobs'), `media: a blob-artifact take gets the blob preview URL (got ${JSON.stringify(resolved.media.preview)})`)
  const bareTake = take('t-bare', { metrics: { kind: 'image', sourcePath: '/out/pic.jpg' }, artifacts: [] })
  const outputForBare = output('out-bare', 'src', [bareTake])
  const bareEntry = generation.buildOutputIndex({ chains: [chainOf('src', { outputs: [outputForBare] })] }).get('out-bare')
  const bareResolved = generation.mediaForOutput(bareEntry)
  ok(bareResolved && typeof bareResolved.media.preview === 'string' && bareResolved.media.preview.startsWith('/api/lan/media?source=output&path='), `media: a take with no blob artifact falls back to the output-dir media preview URL (got ${JSON.stringify(bareResolved && bareResolved.media.preview)})`)
  // the wrong-file class: after an archive import the sourcePath is the
  // ORIGINAL machine's path — a render must consume the blob, never that
  const importedTake = take('take-imported', { metrics: { kind: 'image', sourcePath: '/home/other-machine/works/image.png' }, artifacts: ['canvas-blobs/bb/hash2'] })
  const importedDoc = {
    project: { id: 'p2', name: 'Imported', camera: {}, createdAt: 1, lastActiveAt: 1 },
    chains: [chainOf('imported-src', { outputs: [output('out-2', 'imported-src', [importedTake])] })],
  }
  const importedResolved = generation.mediaForOutput(generation.buildOutputIndex(importedDoc).get('out-2'))
  eq(importedResolved.media.path, 'canvas-blobs/bb/hash2', 'media: a foreign absolute sourcePath NEVER substitutes for the verified blob (archive-import wrong-file guard)')
  // a take with ONLY a local sourcePath still resolves (the pre-blob path)
  const localOnly = take('take-local', { metrics: { kind: 'video', sourcePath: '/out/local.mp4' }, artifacts: [] })
  const localDoc = {
    project: { id: 'p3', name: 'Local', camera: {}, createdAt: 1, lastActiveAt: 1 },
    chains: [chainOf('local-src', { outputs: [output('out-3', 'local-src', [localOnly])] })],
  }
  eq(generation.mediaForOutput(generation.buildOutputIndex(localDoc).get('out-3')).media.path, '/out/local.mp4', 'media: a sourcePath-only take still resolves through it')
}

console.log('(n) typed-hole option menus (§3 filtering + hints)')
{
  const ready = { connected: true, h3Ready: true, motionContextReady: true, ltx25: { available: true, missing: [] }, music3: { available: true, missing: [] }, acestep: { available: true, missing: [] }, utilities: [{ tool: 'remove-subtitles', label: 'Remove subtitles', available: true, missing: [] }, { tool: 'ia2v', label: 'Image + audio → video', available: false, missing: ['node LTXICLoRALoaderModelOnly'] }] }
  const produce = options.endpointOptions('produce', ['image'], ready)
  const produceIds = produce.map((row) => row.id)
  ok(produceIds.includes('produce:i2v'), 'produce(image): i2v offered')
  ok(produceIds.includes('produce:frames'), 'produce(image): frames offered')
  ok(produceIds.includes('produce:ref2v'), 'produce(image): ref2v offered')
  ok(produceIds.includes('produce:fork-decoded'), 'produce(image): decoded fork offered')
  ok(!produceIds.includes('produce:fork-frame'), 'produce(image): frame extraction NOT offered (needs video)')
  ok(produce.find((row) => row.id === 'produce:i2v').available, 'produce(image): i2v offered (chain creation is engine-free; the refusal lives at submit)')
  ok(produce.find((row) => row.id === 'produce:i2v').hint.includes('17n+5'), 'produce: the 17n+5 frame-grid hint surfaces in-menu')
  ok(!options.endpointOptions('produce', [], ready).some((row) => row.id === 'produce:ref2v'.replace('ref2v', 'i2v')), 'produce(no kinds): nothing to offer')
  ok(produce.find((row) => row.id === 'produce:i2v').hint.includes('32px'), 'produce: the 32px-multiples hint surfaces in-menu')
  ok(produce.find((row) => row.id === 'produce:i2v').hint.includes('2–15 s'), 'produce: the ≤15s duration hint surfaces in-menu')

  const produceVideo = options.endpointOptions('produce', ['video'], ready)
  ok(!produceVideo.some((row) => row.id === 'produce:i2v'), 'produce(video): i2v filtered out — image-only route')
  ok(produceVideo.find((row) => row.id === 'produce:fork-frame').available, 'produce(video): frame extraction offered')
  const utility = produceVideo.find((row) => row.id === 'produce:utility:remove-subtitles')
  ok(utility && utility.available, 'produce(video): an available LTX-2.3 utility is offered')
  const missing = produce.find((row) => row.id === 'produce:utility:ia2v')
  ok(missing && !missing.available && missing.reason.includes('node LTXICLoRALoaderModelOnly'), 'produce: install guidance names the missing node')
  ok(!produceVideo.some((row) => row.id === 'produce:utility:ia2v'), 'produce(video): the image+audio utility is filtered out')

  const offline = options.endpointOptions('produce', ['image'], { connected: false, h3Ready: false, utilities: [], motionContextReady: true, ltx25: { available: true, missing: [] }, music3: { available: true, missing: [] }, acestep: { available: true, missing: [] } })
  ok(offline.find((row) => row.id === 'produce:i2v').available, 'produce(offline): chain creation still offered — the refusal surfaces at submit')
  ok(offline.find((row) => row.id === 'produce:fork-decoded').available, 'produce(offline): forking still offered — no engine needed')
  const offlineVideo = options.endpointOptions('produce', ['video'], { connected: false, h3Ready: false, motionContextReady: true, ltx25: { available: true, missing: [] }, music3: { available: true, missing: [] }, acestep: { available: true, missing: [] }, utilities: [{ tool: 'remove-subtitles', label: 'Remove subtitles', available: true, missing: [] }] })
  ok(!offlineVideo.find((row) => row.id === 'produce:utility:remove-subtitles').available, 'produce(offline): utilities stay gated on the engine')
  ok(offlineVideo.find((row) => row.id === 'produce:utility:remove-subtitles').reason.includes('offline'), 'produce(offline): the utility reason says the engine is offline')
  const offlineConsume = options.endpointOptions('consume', ['image'], { connected: false, h3Ready: false, utilities: [], motionContextReady: true, ltx25: { available: true, missing: [] }, music3: { available: true, missing: [] }, acestep: { available: true, missing: [] } })
  ok(offlineConsume.find((row) => row.id === 'consume:first-frame').available, 'consume(offline): input roles are pure document edits — always available')

  const consume = options.endpointOptions('consume', ['image'], ready)
  ok(consume.find((row) => row.id === 'consume:first-frame').available, 'consume(image): first-frame role offered')
  ok(!options.endpointOptions('consume', ['video'], ready).some((row) => row.id === 'consume:first-frame'), 'consume(video): first-frame role filtered out for video sources')
  ok(options.endpointOptions('consume', ['video'], ready).find((row) => row.id === 'consume:reference').available, 'consume(video): reference role accepts any media kind')
}

// QOL wave (rrxlw2r) — the one-click fetch affordance (nits idg8ui4):
// missing-deps → catalog mapping + unavailable rows carrying fetch targets.
console.log('(n2) fetch deep-link mapping — slots/nodes → catalog entries')
{
  const entry = (id, state) => ({ id, name: `name of ${id}`, state, group: 'weights' })
  const catalog = [
    entry('ltx23-dev-checkpoint', 'absent'),
    entry('ltx23-dev-fp8', 'absent'),
    entry('ltx23-gemma-encoders', 'placed'),
    entry('ltx23-kijai-vaes', 'absent'),
    entry('pack:ltxvideo', 'absent'),
    entry('pack:kjnodes', 'present'),
    entry('unrelated-entry', 'absent'),
  ]
  const targets = fetchDeepLink.fetchTargetsForMissing(
    { slots: ['checkpoint', 'textEncoder', 'videoVae', 'outpaintLora', 'madeUpSlot'], nodes: ['LTXICLoRALoaderModelOnly', 'GetImageSizeAndCount', 'MiniMaxH3MotionContext'] },
    catalog,
  )
  const ids = targets.map((target) => target.id).join('|')
  ok(ids === 'ltx23-dev-checkpoint|ltx23-dev-fp8|ltx23-kijai-vaes|pack:ltxvideo', `mapping: slots+nodes resolve to the live catalog, catalog order, alternatives kept (${ids})`)
  ok(!ids.includes('ltx23-gemma-encoders'), 'mapping: an already-PLACED entry is never offered (fetching it again fixes nothing)')
  ok(!ids.includes('pack:kjnodes'), 'mapping: an already-PRESENT pack is never offered')
  ok(!ids.includes('unrelated-entry'), 'mapping: unrelated catalog entries stay out')
  ok(!ids.includes('ltx23-ic-outpaint'), 'mapping: a slot whose entry id is not in the live catalog degrades to nothing (no dead links)')
  ok(targets.every((target) => typeof target.name === 'string' && target.name.length > 0), 'mapping: every target carries its display name')
  eq(fetchDeepLink.fetchTargetsForMissing({ slots: ['checkpoint'], nodes: [] }, null), [], 'mapping: no catalog snapshot → no targets (rows degrade to install guidance)')
  eq(fetchDeepLink.fetchTargetsForMissing({ slots: [], nodes: [] }, catalog), [], 'mapping: nothing missing → no targets')

  // Rows: an unavailable utility with catalog coverage carries fetchTargets;
  // the manual wording surfaces where no catalog entry can satisfy the gap.
  const facts = {
    connected: true, h3Ready: true, motionContextReady: false,
    ltx25: { available: false, missing: ['LTX-2.5 models'] },
    music3: { available: true, missing: [] }, acestep: { available: true, missing: [] },
    fetchCatalog: catalog,
    utilities: [{ tool: 'remove-subtitles', label: 'Remove subtitles', available: false, missing: ['ltx-2.3-22b-dev checkpoint'], missingSlots: ['checkpoint'], missingNodes: [] }],
  }
  const rows = options.endpointOptions('produce', ['video'], facts)
  const utilityRow = rows.find((row) => row.id === 'produce:utility:remove-subtitles')
  ok(utilityRow && !utilityRow.available, 'rows: the unavailable utility stays disabled')
  ok(utilityRow.fetchTargets && utilityRow.fetchTargets.map((target) => target.id).join('|') === 'ltx23-dev-checkpoint|ltx23-dev-fp8', 'rows: the unavailable utility carries its fetch targets (consent still separate)')
  const latentsRow = rows.find((row) => row.id === 'produce:fork-latents')
  ok(latentsRow && !latentsRow.available && /install the pack manually/.test(latentsRow.reason), 'rows: Motion-Context (no catalog entry) keeps the honest manual wording')
  ok(!latentsRow.fetchTargets, 'rows: manual cases carry no fetch targets')
  const ltx25Row = options.endpointOptions('produce', ['image'], facts).find((row) => row.id === 'produce:ltx25')
  ok(ltx25Row && !ltx25Row.available && /install them manually/.test(ltx25Row.reason), 'rows: LTX-2.5 (no catalog entries) says install manually')
  ok(!ltx25Row.fetchTargets, 'rows: LTX-2.5 carries no fetch targets')
  const covered = options.endpointOptions('produce', ['video'], { ...facts, utilities: [{ ...facts.utilities[0], available: true, missingSlots: [], missingNodes: [], missing: [] }] })
  ok(!covered.find((row) => row.id === 'produce:utility:remove-subtitles').fetchTargets, 'rows: an AVAILABLE utility needs no fetch affordance')
}

console.log('(o) reference binding allocation (the promptComposer model, per chain)')
{
  const character = { id: 'char-1', name: 'Ada', description: '', wardrobe: '', voiceNotes: '', visualStyle: '', referencePrompt: '', createdAt: 1, updatedAt: 1, referenceMode: 'set', referenceImages: [media('/lib/ada-1.png', 'image'), media('/lib/ada-2.png', 'image')], wardrobeIds: ['ward-1'], accessoryIds: [], hairStyleIds: [], identityTemplate: 'custom', hairPreset: '', skinTone: '' }
  const wardrobe = { id: 'ward-1', name: 'Field coat', description: '', accessories: [], materials: '', colors: '', visualStyle: '', referencePrompt: '', referenceImages: [media('/lib/coat.png', 'image')], selectedReferencePaths: undefined, createdAt: 1, updatedAt: 1 }
  const location = { id: 'loc-1', name: 'Night yard', description: '', atmosphere: '', timeOfDay: '', continuityAnchors: '', visualStyle: '', environmentMode: 'built', referenceMode: 'set', referenceImages: [media('/lib/yard.png', 'image')], createdAt: 1, updatedAt: 1 }
  const libraries = { characters: [character], wardrobes: [wardrobe], locations: [location] }
  const document = {
    project: { id: 'p1', name: 'P', camera: {}, createdAt: 1, lastActiveAt: 1 },
    chains: [chainOf('src', { outputs: [output('out-c', 'src', [take('tk-c', { metrics: { kind: 'image', sourcePath: '/out/still.png' } })])] })],
  }
  const outputs = generation.buildOutputIndex(document)
  const resolveMedia = (outputId) => generation.mediaForOutput(outputs.get(outputId))
  const settings = generation.readChainSettings({ referenceCharacterIds: ['char-1'], referenceLocationIds: ['loc-1'], referenceOutputIds: ['out-c'] })
  const bindings = generation.resolveChainReferences(settings, libraries, resolveMedia)
  // one authoritative picture per subject/outfit/location before extras, then
  // the canvas output ref in its recorded order, capped at 9.
  eq(bindings.length, 5, 'bindings: identity(2) + wardrobe(1) + location(1) + canvas ref(1)')
  eq(bindings[0].label, 'Character: Ada / master', 'bindings: the master identity picture leads')
  ok(bindings.some((binding) => binding.purpose === 'wardrobe' && binding.label.includes('Field coat')), 'bindings: the assigned wardrobe binds')
  ok(bindings.some((binding) => binding.purpose === 'location' && binding.label.includes('Night yard')), 'bindings: the location binds')
  const canvasRef = bindings.find((binding) => binding.source === 'canvas')
  ok(canvasRef && canvasRef.file.path === '/out/still.png', 'bindings: the canvas output reference resolves to its stored media')
  // tombstoned/unresolvable output refs drop honestly — no hole in Picture N
  const dropped = generation.resolveChainReferences(generation.readChainSettings({ referenceOutputIds: ['gone'] }), libraries, resolveMedia)
  eq(dropped.length, 0, 'bindings: an unresolvable output ref is dropped, never fabricated')
  // unknown library ids drop too
  const unknown = generation.resolveChainReferences(generation.readChainSettings({ referenceCharacterIds: ['nope'] }), libraries, resolveMedia)
  eq(unknown.length, 0, 'bindings: an unknown library id binds nothing')
}

console.log('(p) the shared validation ladder (lib/h3Submit)')
{
  const template = {
    mode: 'text', prompt: 'a lone drummer', width: 1344, height: 768, duration: 6, seed: 1, steps: 30,
    turbo: 'off', turboLoader: 'auto', experimentalSampling: false, loraStrength: 1, sampler: 'res_multistep', scheduler: 'simple',
    refImageSize: 'match', upscale: { mode: 'off', model: '', vae: '', lbhModel: '', missingNodes: [] }, rtxModel: '',
    firstFrame: null, lastFrame: null, referenceImages: [], referenceVideos: [], referenceAudios: [], timelineGuides: [],
    livePreview: { enabled: false, mode: 'standard' },
  }
  const request = (overrides = {}) => ({ ...template, ...overrides })
  const facts = { connected: true, modelReady: true, selection: { previewVae: '' }, h3PreviewOverrideNode: undefined }
  eq(h3Submit.validateH3Render(request(), facts), null, 'ladder: a healthy t2v request passes')
  eq(h3Submit.validateH3Render(request(), { ...facts, connected: false }), 'Start ComfyUI and verify the server connection in Settings.', 'ladder: offline refuses with the honest message')
  eq(h3Submit.validateH3Render(request(), { ...facts, modelReady: false }), 'One or more required MiniMax H3 model components are missing.', 'ladder: missing models refuses')
  eq(h3Submit.validateH3Render(request({ mode: 'image' }), facts), 'Choose a first frame for this mode.', 'ladder: i2v without a first frame refuses')
  eq(h3Submit.validateH3Render(request({ mode: 'frames' }), facts), 'Choose a first frame for this mode.', 'ladder: frames without any frame refuses first')
  eq(h3Submit.validateH3Render(request({ mode: 'frames', firstFrame: media('/a.png', 'image') }), facts), 'Choose a last frame for first-and-last-frame generation.', 'ladder: frames without the LAST frame refuses')
  eq(h3Submit.validateH3Render(request({ mode: 'reference' }), facts), 'Add at least one reference image, video, or audio file.', 'ladder: ref2v with no references refuses')
  const tooMany = request({ mode: 'reference', referenceImages: Array.from({ length: 10 }, (_, index) => media(`/r${index}.png`, 'image')) })
  eq(h3Submit.validateH3Render(tooMany, facts), 'Reference limits are 9 pictures, 3 videos, and 3 audio files. Remove extras before rendering.', 'ladder: >9 reference pictures refuses')
  const badGuide = request({ mode: 'reference', referenceImages: [media('/r.png', 'image')], timelineGuides: [{ file: media('/g.png', 'image'), seconds: 7 }] })
  ok(String(h3Submit.validateH3Render(badGuide, facts)).includes('lands at or beyond'), 'ladder: a guide beyond the duration refuses with the frame warning')
  eq(h3Submit.validateH3Render(request({ prompt: '  ' }), facts), 'Add a prompt before generating.', 'ladder: an empty prompt refuses')
}

console.log('(q) graph construction per selection (engine-free, L4)')
{
  const fakeSelection = { fl2va: 'T-fl2va.safetensors', ref2va: 'T-ref2va.safetensors', textEncoder: 'T-qwen.safetensors', videoVae: 'T-vvae.safetensors', audioVae: 'T-avae.safetensors', previewVae: '', fl2vLora: 'T-fl2v-lora.safetensors', ref2vLora: 'T-ref2v-lora.safetensors' }
  const request = (roles) => generation.buildCanvasRenderRequest(
    generation.readChainSettings(roles),
    { firstFrame: roles.__first ?? null, lastFrame: roles.__last ?? null, referenceImages: roles.__refs ?? [] },
    [],
  )
  const unetOf = (graph) => Object.values(graph).find((node) => node.class_type === 'UNETLoader')
  const classes = (graph) => Object.values(graph).map((node) => node.class_type)

  const t2v = request({ prompt: 'rain on neon glass' })
  eq(t2v.mode, 'text', 'graph: nothing selected builds text-to-video')
  eq(unetOf(generation.planCanvasGraph(t2v, fakeSelection)).inputs.unet_name, 'T-fl2va.safetensors', 'graph: t2v loads the FL2VA branch')
  ok(!classes(generation.planCanvasGraph(t2v, fakeSelection)).includes('LoadImage'), 'graph: t2v has no image loaders')
  ok(t2v.prompt.includes('rain on neon glass'), 'graph: the composed prompt carries the text')

  const i2v = request({ prompt: 'continue the walk', firstFrameOutputId: 'o1', __first: media('/out/first.png', 'image') })
  eq(i2v.mode, 'image', 'graph: a first frame builds image-to-video')
  const i2vGraph = generation.planCanvasGraph(i2v, fakeSelection, { first: 'first.png' })
  eq(classes(i2vGraph).filter((cls) => cls === 'LoadImage').length, 1, 'graph: i2v wires exactly one first-frame loader')
  eq(unetOf(i2vGraph).inputs.unet_name, 'T-fl2va.safetensors', 'graph: i2v stays on the FL2VA branch')

  const frames = request({ prompt: 'loop the alley', firstFrameOutputId: 'o1', lastFrameOutputId: 'o2', __first: media('/out/a.png', 'image'), __last: media('/out/b.png', 'image') })
  eq(frames.mode, 'frames', 'graph: first+last builds frames mode')
  eq(classes(generation.planCanvasGraph(frames, fakeSelection, { first: 'a.png', last: 'b.png' })).filter((cls) => cls === 'LoadImage').length, 2, 'graph: frames wires both frame loaders')

  const ref2v = request({ prompt: 'Ada crosses the yard', referenceOutputIds: ['o1', 'o2'], __refs: [media('/out/r1.png', 'image'), media('/out/r2.png', 'image')] })
  eq(ref2v.mode, 'reference', 'graph: references build ref2v')
  const refGraph = generation.planCanvasGraph(ref2v, fakeSelection, { images: ['r1.png', 'r2.png'] })
  eq(unetOf(refGraph).inputs.unet_name, 'T-ref2va.safetensors', 'graph: ref2v switches to the Ref2VA branch')
  ok(classes(refGraph).includes('MiniMaxH3ReferenceToVideo'), 'graph: ref2v uses the ReferenceToVideo conditioning node')
  eq(classes(refGraph).filter((cls) => cls === 'LoadImage').length, 2, 'graph: ref2v wires one loader per ordered reference')
  ok(!classes(refGraph).includes('MiniMaxH3ImageToVideo'), 'graph: ref2v does NOT use the ImageToVideo node')

  // turbo tier: the 8-step fast path adds the LoRA loader (registry-wired)
  const turbo8 = request({ prompt: 'fast pass', turbo: '8' })
  const turboGraph = generation.planCanvasGraph(turbo8, fakeSelection)
  ok(classes(turboGraph).some((cls) => cls.includes('LoraLoader')), 'graph: the fast tier wires the turbo LoRA loader')
  const quality = request({ prompt: 'slow pass', turbo: 'off' })
  ok(!classes(generation.planCanvasGraph(quality, fakeSelection)).some((cls) => cls.includes('LoraLoader')), 'graph: the quality tier stays LoRA-free (registry inertness)')
}

// ---- Phase 3 (task j5sj28v): the op-stack model (§5.1) ----------------------
console.log('(r) op-stack model — kinds, tolerant settings, live-preview composition')
{
  // Type-directed kind offering (§3 discipline).
  eq(ops.opKindsFor('image').length, 7, 'kinds: the image surface offers seven v1 op kinds (stabilize is video-only; the workbench tone-lock joined k9vu6t0)')
  ok(ops.opKindsFor('image').includes('crop'), 'kinds: image offers crop')
  ok(ops.opKindsFor('image').includes('h3img.tone-lock'), 'kinds: image offers the workbench tone-lock (frequency-separated blend)')
  ok(!ops.opKindsFor('image').includes('trim'), 'kinds: image does NOT offer trim (video op)')
  ok(ops.opKindsFor('video').includes('trim'), 'kinds: video offers trim')
  ok(!ops.opKindsFor('video').includes('crop'), 'kinds: video does NOT offer crop (ImageCrop is the image data model)')
  ok(ops.opKindsFor('audio').length === 0, 'kinds: audio offers no v1 ops (honest)')

  // Tolerant settings reads — documents are external data.
  const crop = ops.readOpSettings('crop', { x: 9, y: -4, zoom: 0.2, fit: 'contain' })
  eq({ x: crop.x, y: crop.y }, { x: 1, y: 0 }, 'settings: crop x/y clamp to [0,1]')
  close(crop.zoom, 1, 1e-9, 'settings: crop zoom clamps at the 1 floor')
  eq(ops.readOpSettings('crop', {}).fit, 'crop', 'settings: absent crop falls back to fill-crop')
  eq(ops.readOpSettings('rotate', { degrees: 'left' }).degrees, 0, 'settings: a non-numeric rotation falls back to 0')
  const trim = ops.readOpSettings('trim', { start: 10, end: 12 })
  eq(trim, { start: 10, end: 12 }, 'settings: a legal trim section round-trips')
  const trimNudged = ops.readOpSettings('trim', { start: 10, end: 11 })
  close(trimNudged.end, 12, 1e-9, 'settings: a sub-2s trim widens to the clipper minimum')
  const mask = ops.readOpSettings('mask', { strokes: [{ points: [0.1, 0.2], size: 0.05, erase: false }, { points: 'x', size: 1, erase: true }, null] })
  eq(mask.strokes.length, 1, 'settings: malformed strokes drop, never crash')
  eq(ops.readOpSettings('color-grade', {}).temperature, 0, 'settings: an absent grade is neutral')

  // Live-preview composition (L3: live-update) — stack order applies.
  const neutral = ops.opPreviewStyle([])
  eq(neutral.filter, 'none', 'preview: an empty stack is the identity')
  eq(neutral.objectPosition, '50.0% 50.0%', 'preview: default focal point is center')
  const composed = ops.opPreviewStyle([
    { kind: 'adjust', settings: { brightness: 1.4, contrast: 1.1, saturation: 1 } },
    { kind: 'crop', settings: { x: 0.25, y: 0.75, zoom: 1.5, fit: 'crop' } },
    { kind: 'rotate', settings: { degrees: 90 } },
    { kind: 'color-grade', settings: { temperature: 0.5, tint: 0 } },
  ])
  ok(composed.filter.includes('brightness(1.400)'), 'preview: the adjust op composes into the filter')
  ok(composed.filter.includes('sepia(0.175)'), 'preview: a warm grade composes its sepia proxy')
  ok(composed.transform.includes('scale(1.5000)'), 'preview: crop zoom composes into the transform')
  ok(composed.transform.includes('rotate(90.00deg)'), 'preview: rotation composes into the transform')
  eq(composed.objectPosition, '25.0% 75.0%', 'preview: the crop focal point becomes object-position')
  const trimmed = ops.opPreviewStyle([{ kind: 'trim', settings: { start: 2, end: 8 } }])
  eq({ s: trimmed.trimStart, e: trimmed.trimEnd }, { s: 2, e: 8 }, 'preview: the trim window surfaces for the scrubber')
  const stackedZoom = ops.opPreviewStyle([{ kind: 'crop', settings: { x: 0.5, y: 0.5, zoom: 2, fit: 'crop' } }, { kind: 'crop', settings: { x: 0.5, y: 0.5, zoom: 2, fit: 'crop' } }])
  ok(stackedZoom.transform.includes('scale(4.0000)'), 'preview: stacked crops MULTIPLY (stack order semantics)')

  // Reorder permutations — baked ops are immovable, moves clamp at the ends.
  const stack = [
    { id: 'a', bakedAt: null },
    { id: 'b', bakedAt: null },
    { id: 'c', bakedAt: 123 },
    { id: 'd', bakedAt: null },
  ]
  eq(ops.moveOpPermutation(stack, 'b', 1), null, 'reorder: a move ONTO a baked op is refused')
  eq(ops.moveOpPermutation(stack, 'c', -1), null, 'reorder: a baked op never moves (frozen by trigger)')
  eq(ops.moveOpPermutation(stack, 'a', -1), null, 'reorder: the first op cannot move up')
  eq(ops.moveOpPermutation(stack, 'd', 1), null, 'reorder: the last op cannot move down')
  eq(ops.moveOpPermutation(stack, 'a', 1), ['b', 'a', 'c', 'd'], 'reorder: a-↓ swaps with b')
  eq(ops.moveOpPermutation(stack, 'd', -1), null, 'reorder: d-↑ is blocked by the baked c (baked ops are barriers)')
  eq(ops.moveOpPermutation(stack, 'gone', 1), null, 'reorder: an unknown op is a no-op')

  // Chip summaries.
  eq(ops.opSummary('crop', { x: 0.5, y: 0.5, zoom: 1.4, fit: 'crop' }), '1.4×', 'summary: crop zoom reads on the chip')
  eq(ops.opSummary('rotate', { degrees: 90 }), '90°', 'summary: rotation degrees read on the chip')
  eq(ops.opSummary('trim', { start: 1, end: 5 }), '1.0–5.0s', 'summary: the trim section reads on the chip')
  eq(ops.opSummary('adjust', { brightness: 1, contrast: 1, saturation: 1 }), 'neutral', 'summary: a neutral adjust reads neutral')
}

console.log('(s) typed-hole surface — the pose rig row (§5.2) + utility rows')
{
  const facts = { connected: false, h3Ready: false, utilities: [], motionContextReady: true, ltx25: { available: true, missing: [] }, music3: { available: true, missing: [] }, acestep: { available: true, missing: [] } }
  const consume = options.endpointOptions('consume', [], facts)
  const poseRig = consume.find((row) => row.id === 'consume:pose-rig')
  ok(poseRig && poseRig.available, 'options: the pose rig row is offered on the consume side (engine-free)')
  eq(poseRig.group, 'control', 'options: the pose rig row sits in the control-inputs group')
  ok(poseRig.hint.includes('17n+5'), 'options: the pose rig row carries the keyframe-grid hint')
  const produce = options.endpointOptions('produce', ['image'], facts)
  ok(!produce.some((row) => row.id === 'consume:pose-rig'), 'options: the pose rig row never leaks to the produce side')
}

console.log('(t) the LTX-2.3 utility validation ladder + official-template plan')
{
  const video = { path: '/out/scene.mp4', name: 'scene.mp4', kind: 'video' }
  const offlineFacts = { connected: false, info: {}, models: [] }
  eq(ltx23Submit.validateLtx23Utility({ tool: 'remove-subtitles', video }, offlineFacts), 'Start ComfyUI and verify the server connection in Settings.', 'ladder: offline refuses with the honest message')
  eq(ltx23Submit.validateLtx23Utility({ tool: 'remove-subtitles', video: null }, { connected: true, info: {}, models: [] }).length > 0, true, 'ladder: no detection offline → the refusal names what is missing')
  const noVideo = ltx23Submit.validateLtx23Utility({ tool: 'outpaint', video: null }, { connected: true, info: { LTXAddVideoICLoRAGuide: 1, ImagePadKJ: 1, Float32ColorCorrect: 1 }, models: [] })
  // The registry gate leads the input gate: with no models resolved the
  // refusal names the missing stack (install guidance), not the input.
  ok(String(noVideo).includes('not ready'), 'ladder: unresolved weights refuse with install guidance before the input check')
  const ia2v = ltx23Submit.validateLtx23Utility({ tool: 'ia2v', video: null, image: null, audio: null }, { connected: true, info: {}, models: [] })
  ok(String(ia2v).includes('both an input image and an audio file') || String(ia2v).includes('not ready'), 'ladder: ia2v names its two inputs or its missing stack')

  // The plan builds the REAL official template with a resolved TEST selection
  // — construction is pure (the typed-hole seam the e2e probe asserts too).
  const plan = ltx23Submit.planLtx23UtilityGraph(
    { tool: 'remove-subtitles', video },
    { info: {}, models: [] },
    { video: 'scene.mp4' },
  )
  // Offline facts cannot resolve the models, so the plan refuses honestly —
  // the factory half is exercised through the fully-resolved path below.
  eq(plan.graph, null, 'plan: unresolved models refuse the plan (honest)')
  ok(plan.refusal.includes('not ready'), 'plan: the refusal names the missing stack')
}

console.log('(u) Z-Image as an op — the still-surface validation ladder + graph plan')
{
  const offlineFacts = { connected: false, info: {} }
  eq(zImageSubmit.validateZImage({ prompt: 'a still', seed: 1, width: 1344, height: 768, surface: 'plain', controlImage: null, controlMode: 'canny' }, offlineFacts), 'Start ComfyUI and verify the server connection in Settings.', 'ladder: offline refuses with the honest message')
  eq(
    zImageSubmit.validateZImage({ prompt: '   ', seed: 1, width: 1344, height: 768, surface: 'plain', controlImage: null, controlMode: 'canny' }, offlineFacts),
    'Add a prompt before generating.',
    'ladder: an empty prompt refuses before anything else',
  )
  const fakeInfo = {
    UNETLoader: { input: { required: { unet_name: [['z_image_turbo_bf16.safetensors', 'other.safetensors']] } } },
    CLIPLoader: { input: { required: { clip_name: [['qwen_3_4b.safetensors']] } } },
    VAELoader: { input: { required: { vae_name: [['ae.safetensors']] } } },
    ModelPatchLoader: { input: { required: { model_name: [['Z-Image-Turbo-Fun-Controlnet-Union.safetensors']] } } },
    QwenImageDiffsynthControlnet: { input: { required: {} } },
    GetImageSize: { input: { required: {} } },
    Canny: { input: { required: {} } },
  }
  const selection = zImageSubmit.resolveZImageSelection(fakeInfo)
  eq(selection.model, 'z_image_turbo_bf16.safetensors', 'resolve: the combo list resolves the turbo model name')
  eq(selection.encoder, 'qwen_3_4b.safetensors', 'resolve: the Qwen 3 encoder resolves')
  ok(zImageSubmit.zImageControlNodesReady(fakeInfo, 'canny'), 'resolve: the canny control path is node-ready')
  ok(!zImageSubmit.zImageControlNodesReady(fakeInfo, 'depth'), 'resolve: depth needs its aux preprocessor (not installed here)')
  const noControlImage = zImageSubmit.validateZImage({ prompt: 'a still', seed: 1, width: 1344, height: 768, surface: 'control', controlImage: null, controlMode: 'canny' }, { connected: true, info: fakeInfo })
  eq(noControlImage, 'Choose a control image for the structure-guided still.', 'ladder: control surface without an image refuses')

  // Graph plans: plain = the Z-Image turbo template; control = the
  // zImageControlnet machinery (Fun ControlNet Union).
  const plainPlan = zImageSubmit.planZImageGraph({ prompt: 'a still', seed: 7, width: 1024, height: 576, surface: 'plain', controlImage: null, controlMode: 'canny' }, selection)
  const plainClasses = Object.values(plainPlan).map((node) => node.class_type)
  ok(plainClasses.includes('UNETLoader') && plainClasses.includes('SaveImage'), 'plan: the plain surface builds the Z-Image turbo template')
  ok(!plainClasses.includes('LoadImage'), 'plan: the plain surface wires no image loader (text→still)')
  const controlPlan = zImageSubmit.planZImageGraph({ prompt: 'a still', seed: 7, width: 1024, height: 576, surface: 'control', controlImage: { path: '/x.png', name: 'x.png', kind: 'image' }, controlMode: 'canny' }, selection, { controlImage: 'x.png' })
  const controlClasses = Object.values(controlPlan).map((node) => node.class_type)
  ok(controlClasses.includes('QwenImageDiffsynthControlnet'), 'plan: the control surface wires the Fun ControlNet Union node')
  ok(controlClasses.includes('Canny'), 'plan: the control surface preprocesses through native Canny')
  ok(controlClasses.includes('ModelPatchLoader'), 'plan: the control surface loads the union patch')
}


// ---------------------------------------------------------------------------
// Phase 4 — latent continuation (the Motion-Context engine seam), the global
// asset bindings, the LocationStudio H3-Ref2V migration, and the extracted
// engine submit cores' ladders.
// ---------------------------------------------------------------------------
console.log('(t) latent continuation — chain options + Motion-Context graph shape')
{
  const mc = take('take-mc', { metrics: { kind: 'video', motionContext: { folder: 'h3_context/src/clip', clipIndex: 3 } }, latentPath: 'h3_context/src/clip_00004.safetensors' })
  eq(generation.latentPathFor({ folder: 'h3_context/src/clip', clipIndex: 3 }), 'h3_context/src/clip_00004.safetensors', 'latent path: the recorded slot is the pack’s REAL on-disk name (1-based %05d .safetensors)')
  eq(generation.latentPathFor({ folder: 'h3_context/chain-z/clip', clipIndex: 0 }), 'h3_context/chain-z/clip_00001.safetensors', 'latent path: chain start (app index 0) is the pack’s clip 1')
  eq(generation.takeMotionContext(mc), { folder: 'h3_context/src/clip', clipIndex: 3 }, 'motion-context: the saved-clip facts read tolerantly from take metrics')
  eq(generation.takeMotionContext(take('plain')), null, 'motion-context: a take without facts answers null (the honest refusal signal)')
  eq(generation.takeMotionContext(take('bad', { metrics: { motionContext: { folder: '', clipIndex: -1 } } })), null, 'motion-context: malformed facts refuse, never a guess')
  eq(generation.substratesForTake(mc, 'video'), ['decoded', 'extracted-frame', 'latents'], 'motion-context: a latent-carrying take offers the latents substrate')

  const save = generation.canvasChainOption('chain-a', null)
  eq(save, { index: 0, folder: 'h3_context/chain-a/clip' }, 'chain option: a plain render SAVES its latent at index 0 (chain start)')
  const forkOption = generation.canvasChainOption('chain-b', { folder: 'h3_context/chain-a/clip', clipIndex: 0 })
  eq(forkOption.index, 1, 'chain option: a latent fork is a continuation (index > 0 loads)')
  eq(forkOption.loadFrom, { folder: 'h3_context/chain-a/clip', clipIndex: 0 }, 'chain option: the fork pins the SOURCE clip explicitly')
  ok(forkOption.folder.startsWith('h3_context/chain-b/'), 'chain option: the fork SAVES into its own folder — never a write into the source')

  // The graph itself: the same plan helpers the probe surface reads.
  const fakeSelection = { fl2va: 'T-fl2va.safetensors', ref2va: 'T-ref2va.safetensors', textEncoder: 'T-te.safetensors', videoVae: 'T-vvae.safetensors', audioVae: 'T-avae.safetensors', previewVae: '', fl2vLora: '', ref2vLora: '' }
  const request = (chain) => generation.buildCanvasRenderRequest(
    generation.chainSettingsDefaults(null),
    { firstFrame: null, lastFrame: null, referenceImages: [], referenceVideos: [], referenceAudios: [] },
    [],
    chain,
  )
  const classes = (graph) => Object.values(graph).map((node) => node.class_type)
  const saveGraph = generation.planCanvasGraph(request(save), fakeSelection)
  ok(classes(saveGraph).includes('MiniMaxH3MotionContextSaveLatent'), 'graph: a plain canvas render saves its sampler latent (segment-0 semantics)')
  ok(!classes(saveGraph).includes('MiniMaxH3MotionContextLoadLatent'), 'graph: segment 0 never loads')
  ok(!classes(saveGraph).includes('MiniMaxH3MotionContextTrim'), 'graph: segment 0 does not trim')

  const forkGraph = generation.planCanvasGraph(request(forkOption), fakeSelection)
  const load = Object.values(forkGraph).find((node) => node.class_type === 'MiniMaxH3MotionContextLoadLatent')
  ok(Boolean(load), 'graph: the latent fork LOADS the saved clip (no re-encode)')
  eq(load.inputs.latent_path, 'h3_context/chain-a', 'graph: LoadLatent reads the SOURCE folder (the /clip filename stem is stripped — the loader wants the directory)')
  eq(load.inputs.clip_index, 1, 'graph: LoadLatent reads the pack-indexed slot (app clipIndex 0 + 1 — index 0 never reads a file)')
  const saveNode = Object.values(forkGraph).find((node) => node.class_type === 'MiniMaxH3MotionContextSaveLatent')
  eq(saveNode.inputs.filename_prefix, 'h3_context/chain-b/clip', 'graph: SaveLatent writes the fork\'s OWN folder')
  ok(classes(forkGraph).includes('MiniMaxH3MotionContextTrim'), 'graph: the continuation trims the overlap rows from the delivered output')
}

console.log('(u) global asset bindings (§2 asset, F3 — consent-gated)')
{
  const settings = { ...generation.chainSettingsDefaults(null), referenceAssetIds: ['asset-loc'] }
  const assets = [
    { id: 'asset-loc', kind: 'location', label: 'The mill', images: [media('/refs/mill-1.png', 'image'), media('/refs/mill-2.png', 'image')] },
    { id: 'asset-dead', kind: 'character', label: 'Gone', images: [] },
  ]
  const bindings = generation.resolveChainReferences(settings, generation.emptyLibraries, () => null, assets)
  eq(bindings.length, 2, 'assets: a bound asset contributes its curated set to the ordered bindings')
  ok(bindings.every((binding) => binding.source === 'asset'), 'assets: the bindings carry the asset source')
  eq(generation.effectiveMode(settings), 'reference', 'assets: an asset binding selects reference mode (L4)')
  const cleared = generation.resolveChainReferences({ ...settings, referenceAssetIds: [] }, generation.emptyLibraries, () => null, assets)
  eq(cleared.length, 0, 'assets: unbinding removes the asset pictures (no zombies)')
  const withDead = generation.resolveChainReferences({ ...generation.chainSettingsDefaults(null), referenceAssetIds: ['asset-dead', 'missing'] }, generation.emptyLibraries, () => null, assets)
  eq(withDead.length, 0, 'assets: dropped/tombstoned assets are skipped honestly — never a hole in <Picture N>')
}

console.log('(v) LocationStudio migration — H3 Ref2V walkthrough (the LTX-only consumer leaves LTX)')
{
  const walkthrough = loadTs('src/lib/locationWalkthrough.ts')
  const project = { name: 'The Mill', description: 'a stone mill by the creek', atmosphere: 'cold morning fog', timeOfDay: 'dawn', continuityAnchors: 'the broken wheel', visualStyle: 'documentary', environmentMode: 'built' }
  const nature = { ...project, environmentMode: 'nature' }
  const prompt = walkthrough.locationWalkthroughPrompt(project)
  ok(prompt.includes('walkthrough reference video of The Mill'), 'walkthrough: the built-mode direction names the location')
  ok(prompt.includes('cold morning fog') && prompt.includes('the broken wheel'), 'walkthrough: the location profile rides the prompt')
  ok(walkthrough.locationWalkthroughPrompt(nature).includes('natural-landscape survey'), 'walkthrough: nature mode enforces the structure-exclusion survey')
  ok(walkthrough.locationWalkthroughPrompt(project, { cameraLanguage: 'Orbit slowly.' }).includes('Camera language: Orbit slowly.'), 'walkthrough: the guided camera preset passes verbatim')

  const request = walkthrough.locationWalkthroughRequest(project, media('/refs/mill-master.png', 'image'), 42, { duration: 20 })
  eq(request.mode, 'reference', 'walkthrough request: the approved image rides Ref2V (<Picture 1>)')
  eq(request.referenceImages.length, 1, 'walkthrough request: exactly one reference picture')
  eq(request.duration, 15, 'walkthrough request: duration clamps to the H3 15s ceiling (LTX allowed 20)')
  eq(request.seed, 42, 'walkthrough request: the seed is the caller\'s reproducibility seed')
  const facts = { connected: false, modelReady: false, selection: {}, h3PreviewOverrideNode: undefined }
  const h3 = loadTs('src/lib/h3Submit.ts')
  eq(h3.validateH3Render(request, facts), 'Start ComfyUI and verify the server connection in Settings.', 'walkthrough request: validates through the shared H3 ladder (offline refusal)')
}

console.log('(w) the extracted engine cores — ladders stay verbatim (one code path, both surfaces)')
{
  const ltx25 = loadTs('src/lib/ltx25Submit.ts')
  const option = { mode: 'image', prompt: 'a wide survey', width: 1344, height: 768, duration: 10, seed: 1, preset: 'quality', filenamePrefix: 'video/plan' }
  eq(ltx25.validateLtx25(option, null, { connected: false, info: {}, selection: {} }), 'Start ComfyUI and verify the server connection in Settings.', 'ltx25 ladder: offline refuses first')
  eq(ltx25.validateLtx25({ ...option, prompt: '' }, null, { connected: true, info: {}, selection: {} }), 'Add an LTX prompt before generating.', 'ltx25 ladder: empty prompt refuses')
  eq(ltx25.validateLtx25(option, null, { connected: true, info: {}, selection: {} }), 'Choose a first frame for LTX image-to-video.', 'ltx25 ladder: i2v without a frame refuses')
  ok(ltx25.LTX25_NATIVE_REQUIRED_NODES.includes('ManualSigmas'), 'ltx25: the node contract ships with the core (the workspace\'s gate, shared)')

  const music3 = loadTs('src/lib/music3Submit.ts')
  eq(music3.validateMusic3({ caption: '', lyrics: '', duration: 60, seed: 1, tiledDecode: true, filenamePrefix: 'a' }, { connected: true, selection: {} }), 'Write at least one caption section before generating.', 'music3 ladder: empty caption refuses')
  eq(music3.validateMusic3({ caption: 'warm jazz', lyrics: '', duration: 60, seed: 1, tiledDecode: true, filenamePrefix: 'a' }, { connected: true, selection: { diffusion: '', textEncoder: '', vae: '' } }), 'The Music 3 diffusion model, text encoder, and DAV VAE are required. Install them, then rescan in Settings.', 'music3 ladder: missing models refuse with the install hint')

  const ace = loadTs('src/lib/aceStepSubmit.ts')
  const aceOption = { model: 'base', tags: 'synthwave', lyrics: '', instrumental: false, duration: 60, seed: 1, bpm: 120, filenamePrefix: 'a' }
  eq(ace.validateAceStep(aceOption, { connected: true, info: { 'TextEncodeAceStepAudio1.5': 1, UNETLoader: 1, DualCLIPLoader: 1, VAELoader: 1, 'EmptyAceStep1.5LatentAudio': 1, ConditioningZeroOut: 1, ModelSamplingAuraFlow: 1, KSampler: 1, VAEDecodeAudio: 1, SaveAudioAdvanced: 1 }, selection: { base: 'ace.safetensors', sft: '', vae: 'v.safetensors', textEncoderSmall: 's.safetensors', textEncoderLarge: 'l.safetensors' } }), null, 'acestep ladder: a ready engine passes clean')
  eq(ace.validateAceStep(aceOption, { connected: true, info: {}, selection: { base: '', sft: '', vae: '', textEncoderSmall: '', textEncoderLarge: '' } }), 'The ACE-Step BASE model, audio VAE, and both Qwen ACE text encoders are required.', 'acestep ladder: missing models refuse naming the variant')
}

// ---------------------------------------------------------------------------
// Phase 5 (task 7mcp11b) — the deletion wave's extracted cores: the character
// contact-sheet submission (ContactSheet-REQUIRED — the LTX survey fallback
// died with the shell). The MoviePlanner latent scene-chain core died with
// its only caller in Phase 5b (MoviePlanner retired — the scene-chain
// successor is the store's submitPlanEpisode over canvas chains; its ladder
// reuses submitH3Render's, asserted in (p)). Async (the submission is an
// async function); the suite's tail summary moves inside the runner.
// ---------------------------------------------------------------------------
async function phase5Cores() {
  console.log('(x) Phase-5 extracted cores — contact sheet (ContactSheet-only)')
  const contact = loadTs('src/lib/contactSheetSubmit.ts')
  const contactFacts = (overrides = {}) => ({ settings: { comfyUrl: 'http://x' }, connected: true, models: [], selection: { ref2va: 'r', textEncoder: 't', videoVae: 'v' }, clientId: 'c', ...overrides })
  const project = { id: 'char-1', name: 'Mira', baseImage: media('/refs/mira.png', 'image') }
  const noop = () => {}
  const io = { notify: noop, setJobs: () => { throw new Error('no job should be created by a refused submission') } }
  eq(await contact.submitCharacterContactSheet(project, contactFacts({ connected: false }), io), 'Start ComfyUI and verify the server connection in Settings.', 'contact sheet: offline refuses first (the shared ladder)')
  eq(await contact.submitCharacterContactSheet({ id: 'char-2', name: 'Mira' }, contactFacts(), io), 'Approve a character identity image first.', 'contact sheet: no approved identity image refuses')
  eq(await contact.submitCharacterContactSheet(project, contactFacts(), io), 'Install the ComfyUI-H3-ContactSheet nodes and the five-view turnaround LoRA (minimax_h3_five_view_*), then refresh the engine.', 'contact sheet: the ContactSheet nodes + turnaround LoRA are REQUIRED (Phase-4 cleanup applied — the LTX survey fallback is gone)')
}

// ---------------------------------------------------------------------------
// (l–r) The structured H3 prompt editor's pure layer (fh94g76): the concat
// contract's goldens, the no-loss round-trip parse (adversarial), merge
// semantics for library box-sets, chips/warning data, and the settings
// round-trip for promptMode/structured.
// ---------------------------------------------------------------------------
console.log('(l) composeStructuredPrompt — the concat contract goldens')
{
  const sp = loadTs('src/lib/structuredPrompt.ts')
  const baker = {
    concept: 'a baker opens her street bakery before sunrise',
    subjects: [{ id: 's1', name: 'Mara', appearance: 'a middle-aged baker with flour-dusted forearms', wardrobe: 'a linen apron', features: 'a calm, slightly raspy voice' }],
    setting: 'A small street bakery on a wet cobblestone lane',
    lighting: 'Warm golden-hour light spilling from the shopfront',
    style: 'Live-action, cinematic',
    camera: 'The camera pushes in with small amplitude at slow speed',
    flow: [
      { id: 'f1', from: 0, to: 3, text: 'Mara unbolts the shutters and props the window display open' },
      { id: 'f2', from: 3, to: 6, text: 'she sets the first loaves on the counter as steam rises' },
      { id: 'f3', from: 6, to: 6, text: 'a moment — the doorbell rings once' },
    ],
    audio: { soundscape: 'Wooden shutters scrape open over a quiet street; the doorbell rings once.', music: 'A soft acoustic-guitar pattern at a moderate tempo.', dialogue: 'Mara (S1) says: <d>[English] First batch of the morning.</d>' },
  }
  // Guide-exact: style-led [Shot 1] opening, subjects defined before use,
  // scene/lighting/camera prose, ordered timed shots (row 1 continues
  // [Shot 1], moments render from their from-time), dialogue in <d>, the two
  // audio fields last with a blank line between sections.
  eq(
    sp.composeStructuredPrompt(baker, { duration: 6 }),
    'integrated_multimodal_description: [Shot 1] Live-action, cinematic, a baker opens her street bakery before sunrise. '
    + 'Mara: a middle-aged baker with flour-dusted forearms, wearing a linen apron, a calm, slightly raspy voice. '
    + 'A small street bakery on a wet cobblestone lane. Warm golden-hour light spilling from the shopfront. '
    + 'The camera pushes in with small amplitude at slow speed. '
    + 'Mara unbolts the shutters and props the window display open. '
    + '[Shot 2] At 00:03.000, she sets the first loaves on the counter as steam rises. '
    + '[Shot 3] At 00:06.000, a moment — the doorbell rings once. '
    + 'Mara (S1) says: <d>[English] First batch of the morning.</d>\n\n'
    + 'overall_soundscape: Wooden shutters scrape open over a quiet street; the doorbell rings once.\n\n'
    + 'non_diegetic_music: A soft acoustic-guitar pattern at a moderate tempo.',
    'golden: the full draft composes guide-exactly',
  )
  // Empty boxes contribute nothing.
  eq(sp.composeStructuredPrompt(sp.emptyStructuredDraft(), { duration: 6 }), '', 'empty draft composes to the empty string')
  eq(
    sp.composeStructuredPrompt({ ...sp.emptyStructuredDraft(), style: 'Cinematic', concept: 'a lighthouse in fog' }),
    'integrated_multimodal_description: [Shot 1] Cinematic, a lighthouse in fog.',
    'visual-only draft: no audio sections emitted',
  )
  eq(
    sp.composeStructuredPrompt({ ...sp.emptyStructuredDraft(), audio: { soundscape: 'Rain taps the glass.', music: '', dialogue: '' } }),
    'overall_soundscape: Rain taps the glass.\n\nnon_diegetic_music: N/A',
    'soundscape-only draft: music completes the pair as N/A (the guide\'s completed-prompt shape)',
  )
  eq(
    sp.composeStructuredPrompt({ ...sp.emptyStructuredDraft(), audio: { soundscape: '', music: 'Sparse piano.', dialogue: '' } }),
    'non_diegetic_music: Sparse piano.',
    'music-only draft: the music field alone (no invented soundscape)',
  )
  // Empty flow rows are skipped; shot numbering counts rendered rows only.
  const gapped = sp.composeStructuredPrompt({ ...sp.emptyStructuredDraft(), flow: [
    { id: 'a', from: 0, to: 0, text: '' },
    { id: 'b', from: 0, to: 2, text: 'the kettle boils' },
    { id: 'c', from: 2, to: 4, text: '' },
    { id: 'd', from: 4, to: 6, text: 'she pours' },
  ] }, { duration: 6 })
  eq(gapped, 'integrated_multimodal_description: [Shot 1] the kettle boils. [Shot 2] At 00:04.000, she pours.', 'empty rows skip; numbering counts rendered rows')
  // Ranges clip to the duration; negative from clamps to zero.
  const clipped = sp.composeStructuredPrompt({ ...sp.emptyStructuredDraft(), flow: [
    { id: 'a', from: -3, to: 2, text: 'pre-roll beat' },
    { id: 'b', from: 9, to: 9, text: 'late moment' },
  ] }, { duration: 6 })
  eq(clipped, 'integrated_multimodal_description: [Shot 1] pre-roll beat. [Shot 2] At 00:06.000, late moment.', 'clipping: negative from clamps to 0, past-duration from clips to the duration')
  // No duration context: times render unclipped (compose never invents facts).
  eq(
    sp.composeStructuredPrompt({ ...sp.emptyStructuredDraft(), flow: [{ id: 'a', from: 12, to: 12, text: 'late' }] }),
    'integrated_multimodal_description: [Shot 1] late.',
    'single flow row: no cut label (it IS [Shot 1])',
  )
  // Byte-parity with the freeform path: compose output is a plain string the
  // freeform surface could have typed — the engine sees no difference.
  ok(!sp.composeStructuredPrompt(baker, { duration: 6 }).includes('undefined'), 'compose never leaks undefined parts')
  ok(typeof sp.composeStructuredPrompt(baker) === 'string', 'compose works without a duration context')

  eq(sp.flowCutLabel(3), 'At 00:03.000', 'cut label: seconds pad to MM:SS.mmm')
  eq(sp.flowCutLabel(63.5), 'At 01:03.500', 'cut label: minutes carry')
  eq(sp.flowCutLabel(0), 'At 00:00.000', 'cut label: zero')
}

console.log('(m) parseStructuredPrompt — the deterministic no-loss round-trip')
{
  const sp = loadTs('src/lib/structuredPrompt.ts')
  // The parts the grammar pins recover EXACTLY from the composed output:
  // flow rows (+ from-times), the audio fields, the style run.
  const source = [
    'integrated_multimodal_description: [Shot 1] Live-action, cinematic, a baker opens her shop.',
    'Mara: a middle-aged baker. [Shot 2] At 00:03.000, she sets loaves on the counter.',
    'Mara (S1) says: <d>[English] First batch of the morning.</d>',
    '',
    'overall_soundscape: Shutters scrape open over a quiet street.',
    '',
    'non_diegetic_music: A soft acoustic-guitar pattern.',
  ].join('\n')
  const parsed = sp.parseStructuredPrompt(source)
  eq(parsed.style, 'Live-action, cinematic', 'parse: the leading style run splits into the Style box')
  eq(parsed.flow.length, 2, 'parse: shot markers become flow rows')
  eq(parsed.flow[1].from, 3, 'parse: "At MM:SS.mmm" becomes the row from-time')
  eq(parsed.flow[1].text, 'she sets loaves on the counter.', 'parse: the row text follows the cut label')
  eq(parsed.audio.dialogue, 'Mara (S1) says: <d>[English] First batch of the morning.</d>', 'parse: the dialogue sentence (speaker phrase + <d> span) lifts whole into the Audio dialogue')
  eq(parsed.audio.soundscape, 'Shutters scrape open over a quiet street.', 'parse: the soundscape field splits out')
  eq(parsed.audio.music, 'A soft acoustic-guitar pattern.', 'parse: the music field splits out')
  ok(parsed.flow[0].text.includes('a baker opens her shop'), 'parse: the [Shot 1] opening becomes the first flow beat (never dropped)')
  eq(sp.parseStructuredPrompt('non_diegetic_music: N/A').audio.music, '', 'parse: N/A music reads as empty (not the literal N/A)')

  // Box stability for the grammar-pinned parts: parse∘compose recovers the
  // from-times exactly, the cut-labeled rows' text exactly, and the audio
  // fields + style run byte-exactly (the opening boxes merge into the [Shot 1]
  // prose by design — their words survive in the opening beat).
  const draft = {
    concept: 'c', subjects: [], setting: '', lighting: '', style: 'Cinematic', camera: '',
    flow: [
      { id: '1', from: 0, to: 0, text: 'the opening beat' },
      { id: '2', from: 2.5, to: 4, text: 'the second beat!' },
    ],
    audio: { soundscape: 'Room tone.', music: 'Sparse piano.', dialogue: '<d>[English] Hello.</d>' },
  }
  const round = sp.parseStructuredPrompt(sp.composeStructuredPrompt(draft, { duration: 6 }))
  eq(round.flow.map((row) => row.from), [0, 2.5], 'round-trip: from-times are stable')
  ok(round.flow[0].text.includes('the opening beat') && round.flow[0].text.includes('c'), 'round-trip: the opening beat keeps the merged opening prose words')
  eq(round.flow[1].text, 'the second beat!', 'round-trip: cut-labeled row text is byte-stable')
  eq(round.audio.dialogue, draft.audio.dialogue, 'round-trip: dialogue bytes are stable')
  eq(round.audio.soundscape, draft.audio.soundscape, 'round-trip: soundscape is stable')
  eq(round.audio.music, draft.audio.music, 'round-trip: music is stable')
  eq(round.style, draft.style, 'round-trip: the style run is stable')

  // ADVERSARIAL no-loss (AC 1): for hostile inputs, every CONTENT token of
  // the input survives somewhere in compose(parse(input)) — the toggle never
  // loses text in either direction, deterministically (no LLM). Structural
  // spans (shot markers, cut-time labels) are the grammar, not content: the
  // concat renumbers shots and normalizes times by contract.
  const hostile = [
    'Plain prose with unicode: 风筝 drift over 京都市 — café 拍摄 🎬.',
    'A "quoted" line; <Picture 3> tags, [unclear] spans, and <d>[Chinese] 你好，世界</d> dialogue.',
    '[Shot 4] At 99:99.999, garbage times and stray markers [Shot',
    'Tabs\tand\t\tweird spacing   plus CR-safe endings',
    'overall_soundscape: label mid-flow',
    'SOFÍSTICATED ünïcode — ’typographic’ “quotes”',
    '',
    '   ',
  ].join('\r\n')
  const composed = sp.composeStructuredPrompt(sp.parseStructuredPrompt(hostile))
  const structural = /\[Shot\s+\d+\]|At\s+\d{1,3}:\d{2}\.\d{3},?/gi
  const missing = composed === '' ? [] : hostile.replace(structural, ' ').split(/\s+/).filter((token) => token && !composed.includes(token))
  eq(missing, [], 'adversarial: every content token of a hostile prompt survives the round-trip (no silent drops)')

  // The no-loss toggle pair, as the surface performs it: parse on the way in
  // (string untouched), compose on any box edit (string becomes the concat).
  const toggle = 'The quick brown fox says: <d>[English] Wow.</d>'
  const afterParse = sp.parseStructuredPrompt(toggle)
  ok(sp.parseStructuredPrompt(toggle) !== null, 'toggle in: the parse always produces a draft')
  ok(sp.composeStructuredPrompt(afterParse).includes('The quick brown fox says:') && sp.composeStructuredPrompt(afterParse).includes('<d>[English] Wow.</d>', ), 'toggle out: the concat carries the words and the dialogue bytes')
}

console.log('(n) mergeStructuredDraft + the settings round-trip + guards')
{
  const sp = loadTs('src/lib/structuredPrompt.ts')
  const current = { ...sp.emptyStructuredDraft(), concept: 'keep me', style: 'Cinematic', flow: [{ id: '1', from: 0, to: 1, text: 'beat one' }] }
  const incoming = sp.parseStructuredPrompt('integrated_multimodal_description: [Shot 1] a library entry.\n\noverall_soundscape: Rain.\n\nnon_diegetic_music: N/A')
  const merged = sp.mergeStructuredDraft(current, incoming)
  eq(merged.concept, 'keep me', 'merge: existing text is never replaced')
  eq(merged.style, 'Cinematic', 'merge: untouched boxes stay')
  eq(merged.flow.map((row) => row.text), ['beat one', 'a library entry.'], 'merge: the entry\'s beat appends in order')
  eq(merged.audio.soundscape, 'Rain.', 'merge: audio splits in')
  eq(sp.mergeStructuredDraft(sp.emptyStructuredDraft(), incoming).flow.map((row) => row.text), ['a library entry.'], 'merge into empty = the incoming draft')

  // The persistence guard: garbage reads as empty, never crashes.
  eq(sp.readStructuredDraft(null), null, 'guard: null reads as null')
  eq(sp.readStructuredDraft('nope'), null, 'guard: a string reads as null')
  const guarded = sp.readStructuredDraft({ concept: 7, subjects: ['junk', { name: 'Mara' }], flow: [{ from: 'x', text: 't' }], audio: 'junk' })
  eq(guarded.concept, '', 'guard: wrong-typed fields read as empty')
  eq(guarded.subjects.length, 1, 'guard: malformed cards drop, well-formed ones survive')
  eq(guarded.subjects[0].name, 'Mara', 'guard: the surviving card keeps its name')
  eq(guarded.flow.length, 1, 'guard: malformed rows drop, well-formed ones survive')
  eq(guarded.audio.soundscape, '', 'guard: a malformed audio object reads as empty fields')

  // The chain-settings round-trip: promptMode + structured persist and
  // reload through the tolerant reader (generation.ts is pure).
  const generation = loadTs('src/canvas/generation.ts')
  const settings = generation.readChainSettings({ prompt: 'p', promptMode: 'structured', structured: { concept: 'c', subjects: [{ name: 'Mara' }], flow: [{ from: 1, to: 2, text: 'b' }], audio: { soundscape: 's' } } })
  eq(settings.promptMode, 'structured', 'settings: promptMode round-trips')
  eq(settings.structured.concept, 'c', 'settings: the structured draft round-trips')
  eq(settings.structured.subjects[0].name, 'Mara', 'settings: subject cards round-trip')
  eq(settings.structured.flow[0].from, 1, 'settings: flow rows round-trip')
  eq(settings.structured.audio.soundscape, 's', 'settings: the audio box round-trips')
  const plain = generation.readChainSettings({ prompt: 'p' })
  eq(plain.promptMode, 'freeform', 'settings: legacy chains default to freeform')
  eq(plain.structured, null, 'settings: legacy chains carry no structured draft')
  eq(generation.chainSettingsDefaults().promptMode, 'freeform', 'settings: defaults start freeform')
}

console.log('(o) chips, warnings, dialogue helper, assist adapters')
{
  const sp = loadTs('src/lib/structuredPrompt.ts')
  // The camera chips are the guide §4.3 motion-type table.
  const cameraLabels = sp.STRUCTURED_CHIPS.camera.map((chip) => chip.label)
  for (const move of ['Static Shot', 'Push In', 'Pull Out', 'Pan Left', 'Pan Right', 'Tilt Up', 'Pedestal Down', 'Arc Shot', 'Tracking Shot', 'POV']) {
    ok(cameraLabels.includes(move), `camera chips carry the official motion type "${move}"`)
  }
  ok(sp.STRUCTURED_CHIPS.camera.some((chip) => chip.insertion.startsWith('the camera pushes in')), 'camera chips insert natural-English motion prose (guide §4.3)')
  ok(sp.STRUCTURED_CHIPS.style.some((chip) => chip.label === '2D-animated'), 'style chips carry the guide\'s style list')
  for (const box of ['setting', 'lighting', 'style', 'camera', 'audio']) {
    ok(sp.STRUCTURED_CHIPS[box].length >= 5, `the ${box} chip row is substantive`)
  }
  eq(sp.appendChipText('', 'golden hour'), 'golden hour', 'chip append: empty box takes the insertion directly')
  eq(sp.appendChipText('soft overcast daylight', 'golden hour'), 'soft overcast daylight, golden hour', 'chip append: vocabulary joins with ", "')
  eq(sp.appendChipText('the camera pushes in', 'with large amplitude'), 'the camera pushes in with large amplitude', 'chip append: modifiers join with a space')

  const warnings = sp.flowRowWarnings([
    { id: 'a', from: 0, to: 2, text: 'fine' },
    { id: 'b', from: 7, to: 9, text: 'late beat' },
    { id: 'c', from: 1, to: 1, text: 'goes backwards' },
    { id: 'd', from: 2, to: 2, text: '' },
  ], 6)
  eq(warnings.length, 3, 'warnings: out-of-range start, past-duration end, and non-increasing cuts each warn')
  ok(warnings[0].warning.includes('outside the 6s clip'), 'warnings: the out-of-range wording names the duration')
  ok(warnings[1].warning.includes('past the 6s duration'), 'warnings: the past-end wording names the duration')
  ok(warnings[2].warning.includes('strictly increase'), 'warnings: the guide\'s strictly-increasing rule rides along')
  eq(sp.flowRowWarnings([{ id: 'x', from: 0, to: 0, text: 'moment' }], 6), [], 'warnings: a moment (to ≤ from) inside range is legal — no warning')

  eq(sp.wrapDialogueLine('Hello there.', 'English'), '<d>[English] Hello there.</d>', 'dialogue helper: wraps a bare line with the language tag')
  eq(sp.wrapDialogueLine('<d>[English] already wrapped</d>'), '<d>[English] already wrapped</d>', 'dialogue helper: already-formatted lines pass through untouched')
  eq(sp.wrapDialogueLine('   '), '', 'dialogue helper: blank lines stay blank')

  const context = sp.buildBoxAssistContext('camera', { duration: 8, mode: 'text' })
  ok(context.includes('camera box'), 'assist context: names the box being refined')
  ok(context.includes('8 seconds'), 'assist context: carries the duration')
  const constrained = sp.buildBoxAssistContext('audio', { duration: 8, mode: 'text', noDialogue: true })
  ok(constrained.includes('no spoken dialogue'), 'assist context: the no-dialogue constraint reaches the audio box')
  ok(sp.buildStructuredParseInstructions().includes('Never invent'), 'parse instructions: the no-invention contract')
  ok(sp.structuredParseSchema.properties.flow, 'parse schema: carries the flow rows shape')
  eq(sp.parseFlowRows('[Shot 1] opens on the shop. [Shot 2] At 00:03.500, she pours.')[1].from, 3.5, 'flow assist parser: cut times become from-seconds')
  eq(sp.parseFlowRows('one line\nanother line').length, 2, 'flow assist parser: unmarked lines each become a beat')
  eq(sp.parseFlowRows('[Shot 1] opens on the shop. [Shot 2] At 00:03.500, she pours.')[1].text, 'she pours.', 'flow assist parser: the row text follows the label')
}

// ---------------------------------------------------------------------------
// Phase 5b (task 2u0rent) — the Director Suite pure layer: the plan document
// (canvas_plan.document_json per document-model §1), the MEASURED gap menu
// (verdicts from docs/research/h3-transitions-and-latent-continuity.md), and
// the timeline projection (chronological chain outputs / plan segments).
// ---------------------------------------------------------------------------
console.log('(y) Phase 5b — plan documents + the measured gap menu + the timeline projection')
{
  const plan = loadTs('src/canvas/plan.ts')

  eq(plan.GAP_KINDS, ['cut', 'nle', 'flf', 'black', 'bridge'], 'gap kinds: the schema\'s five, hard cut first (the measured default)')
  eq(plan.GAP_MENU.map((entry) => entry.kind), plan.GAP_KINDS, 'gap menu: exactly one entry per kind, in menu order')
  ok(plan.GAP_MENU.every((entry) => entry.verdict.length > 40), 'gap menu: every entry carries its measured verdict')
  const flf = plan.gapMenuEntry('flf')
  eq([flf.mechanism, flf.executable, flf.engineDependent], ['in-model', true, false], 'gap menu: FLF is THE executable in-model splice (36 dB class, tranche 1)')
  const bridge = plan.gapMenuEntry('bridge')
  eq([bridge.mechanism, bridge.executable, bridge.engineDependent], ['in-model', false, true], 'gap menu: the diegetic bridge is in-model but engine-dependent (a labeled choice, never a pretend button)')
  ok(plan.gapMenuEntry('nle').mechanism === 'post' && plan.gapMenuEntry('cut').mechanism === 'assembly', 'gap menu: NLE is post-production, the hard cut is assembly')
  ok(plan.gapMenuEntry('black').engineDependent === true, 'gap menu: the guided dip-to-black is engine-dependent (the plain dip is post)')

  const read = plan.readPlanDocument({
    brief: 'a night train heist',
    segments: [
      { id: 's1', title: 'Open', prompt: 'rain on the platform', duration: 8, chainId: 'c1', referenceCharacterIds: ['lib-char'], referenceLocationIds: [] },
      { id: 's2', duration: 'garbage', chainId: 7 },
    ],
    gaps: [
      { afterSegmentId: 's1', kind: 'flf' },
      { afterSegmentId: 's1', kind: 'nle' },
      { afterSegmentId: 'missing', kind: 'cut' },
      { afterSegmentId: 's2', kind: 'warp' },
    ],
  })
  eq(read.brief, 'a night train heist', 'plan read: the brief round-trips')
  eq(read.segments.length, 2, 'plan read: segments survive a tolerant read')
  eq(read.segments[1].duration, 6, 'plan read: a garbage duration falls back to the default')
  ok(read.segments[1].chainId === null, 'plan read: a non-string chain_ref reads null, never a crash')
  eq(read.segments[1].title, 'Segment 2', 'plan read: an absent title gets an indexed fallback')
  eq(read.gaps.map((gap) => `${gap.afterSegmentId}:${gap.kind}`), ['s1:flf', 's1:nle'], 'plan read: dangling + unknown-kind gaps drop; duplicates read raw')
  eq(plan.gapAfter(read, 's1').kind, 'flf', 'gapAfter: the first recorded gap wins')
  eq(plan.gapAfter(read, 's2').kind, 'cut', 'gapAfter: a missing gap is the measured default (hard cut)')
  eq(plan.gapAfter(plan.readPlanDocument({}), 'anything').kind, 'cut', 'gapAfter: an empty plan defaults to hard cut')

  eq(plan.episodeRunEnd(read, 0), 2, 'episode run: the recorded FLF gap extends the run over the next segment')
  const flfPlan = plan.readPlanDocument({ segments: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], gaps: [{ afterSegmentId: 'a', kind: 'flf' }, { afterSegmentId: 'b', kind: 'flf' }, { afterSegmentId: 'c', kind: 'nle' }] })
  eq(plan.episodeRunEnd(flfPlan, 0), 3, 'episode run: contiguous FLF joins extend; a non-FLF gap ends the episode')
  eq(plan.episodeRunEnd(flfPlan, 3), 4, 'episode run: a lone tail segment is its own (degenerate) run')

  // The projection over a small document: c1 has a rendered video take, c2
  // is an unrendered seed, c3 has an image take.
  const doc = {
    project: { id: 'p1', name: 'P', camera: {}, createdAt: 1, lastActiveAt: 1 },
    chains: [
      chainOf('c1', { settings: { prompt: 'the drummer boards. rain sheets the platform', duration: 8 }, outputs: [output('o1', 'c1', [take('t1', { outputId: 'o1', metrics: { kind: 'video', duration: 8.2, sourcePath: '/out/a.mp4' } })])] }),
      chainOf('c2', { settings: { prompt: 'the corridor', duration: 6 }, outputs: [] }),
      chainOf('c3', { settings: { prompt: 'a still of the platform clock', duration: 5 }, outputs: [output('o3', 'c3', [take('t3', { outputId: 'o3', metrics: { kind: 'image', duration: 5, sourcePath: '/out/c.png' } })])] }),
    ],
    plans: [],
  }

  const unplanned = plan.deriveTimeline({ document: doc, plan: null, jobs: [], links: {} })
  eq(unplanned.planId, null, 'timeline (unplanned): no plan id')
  eq(unplanned.items.map((item) => item.chainId), ['c1', 'c3'], 'timeline (unplanned): chain OUTPUTS in creation order (unrendered seeds excluded)')
  ok(Math.abs(unplanned.plannedDuration - 13.2) < 1e-9, 'timeline (unplanned): durations come from the real takes')
  eq(unplanned.gaps.map((gap) => gap.kind), ['cut'], 'timeline (unplanned): implicit hard cuts between outputs')
  eq(unplanned.gaps[0].flfReady, true, 'timeline (unplanned): FLF readiness reads the left take (a video with a renderable path)')

  const planRow = {
    id: 'plan-1',
    document: {
      brief: 'b',
      segments: [
        { id: 's1', title: 'Board', prompt: 'the drummer boards', duration: 8, chainId: 'c1', referenceCharacterIds: [], referenceLocationIds: [] },
        { id: 's2', title: 'Corridor', prompt: 'the corridor', duration: 6, chainId: 'c2', referenceCharacterIds: [], referenceLocationIds: [] },
        { id: 's3', title: 'Clock', prompt: 'the platform clock', duration: 5, chainId: null, referenceCharacterIds: [], referenceLocationIds: [] },
      ],
      gaps: [{ afterSegmentId: 's1', kind: 'flf' }],
    },
  }
  const projected = plan.deriveTimeline({ document: doc, plan: planRow, jobs: [], links: {} })
  eq(projected.planId, 'plan-1', 'timeline (plan): the plan id rides the projection')
  eq(projected.items.map((item) => item.segmentId), ['s1', 's2', 's3'], 'timeline (plan): segments in plan order')
  eq(projected.items.map((item) => [item.start, item.end]), [[0, 8], [8, 14], [14, 19]], 'timeline (plan): cumulative planned ranges')
  eq(projected.items.map((item) => item.status), ['idle', 'idle', 'unseeded'], 'timeline (plan): the F7 status ladder rides the items (unseeded without a chain)')
  ok(Math.abs(projected.renderedDuration - 8.2) < 1e-9, 'timeline (plan): rendered duration sums real takes only')
  eq(projected.gaps.map((gap) => gap.kind), ['flf', 'cut'], 'timeline (plan): the recorded gap + the default between s2/s3')
  eq(projected.gaps[0].flfReady, true, 'timeline (plan): FLF ready — s1\'s canonical take is a renderable video')
  eq(projected.gaps[1].flfReady, false, 'timeline (plan): FLF not ready past an unrendered segment')

  const failed = plan.deriveTimeline({ document: doc, plan: planRow, jobs: [{ id: 'j2', status: 'failed', progress: 0, error: 'engine exploded' }], links: { c2: 'j2' } })
  eq(failed.items[1].status, 'failed', 'timeline: a failed linked job surfaces on its segment (projections inherit the no-silent-failure contract)')
  eq(failed.items[1].statusNote, 'engine exploded', 'timeline: the failure reason rides the item')

  const adopted = plan.planDocumentFromChains(doc)
  eq(adopted.segments.map((segment) => segment.chainId), ['c1', 'c3'], 'adopt chronology: every chain with a canonical take becomes a segment carrying its chain_ref')
  ok(Math.abs(adopted.segments[0].duration - 8.2) < 1e-9, 'adopt chronology: the segment duration comes from the take')
  eq(adopted.segments[0].title, 'the drummer boards', 'adopt chronology: titles derive from the prompts (first clause, capped)')
  eq(adopted.gaps.length, 0, 'adopt chronology: gaps start at the measured default (implicit hard cuts)')

  eq(plan.formatTimelineDuration(83), '1:23', 'format: m:ss')
  eq(plan.formatTimelineDuration(0), '0:00', 'format: zero')
}

// ---------------------------------------------------------------------------
// The camera path editor's pure layer (y93rk61) — the camera compiler's
// FIRST consumer: the doc model, the profile/duration grid mapping, the
// compile step, the Camera-box text contract (emit → best-effort parse →
// never-lossy splice), the persistence guard, and the one-click presets.
// ---------------------------------------------------------------------------
console.log('(z) cameraPath — the compile step + the box-text round-trip')
{
  const cp = loadTs('src/lib/cameraPath.ts')
  const sp = loadTs('src/lib/structuredPrompt.ts')

  // The profile grid: the compiler's three proven profiles, nearest-first
  // (all ≡5 mod 17 — the same grid workflow.frameCount quantizes to).
  eq(cp.nearestProfile(6), '124 frames (~5.17s)', 'profiles: a 6s chain (144 frames) is nearest 124')
  eq(cp.nearestProfile(10), '243 frames (~10.13s)', 'profiles: a 10s chain is nearest 243')
  eq(cp.nearestProfile(15), '362 frames (~15.08s)', 'profiles: a 15s chain is nearest 362')
  eq(cp.nearestProfile(0), '124 frames (~5.17s)', 'profiles: degenerate durations clamp to the shortest')
  ok(Math.abs(cp.planEndOf('124 frames (~5.17s)') - 123 / 24) < 1e-12, 'profiles: the timeline uses the (frames-1)/24 last-visible-frame convention')

  const defaults = cp.defaultCameraPathDoc(6)
  eq(defaults.keyframes.length, 3, 'default doc: the upstream DEFAULT_PATH trajectory')
  eq(defaults.orbitDirection, 'invert H3 orbit', 'default doc: the mirror-quirk calibration default')
  eq(defaults.profile, '124 frames (~5.17s)', 'default doc: profile follows the chain duration')

  // The compile step is the product: compileCameraDoc routes through the
  // port's public API and surfaces the plan + read-only diagnostics.
  const doc = {
    keyframes: [
      { time: 0, azimuth: 0, elevation: 0, distance: 1 },
      { time: 0.3, azimuth: -120, elevation: -12, distance: 1.5 },
      { time: 0.7, azimuth: -60, elevation: 20, distance: 0.55 },
      { time: 1, azimuth: -240, elevation: 0, distance: 2 },
    ],
    profile: '243 frames (~10.13s)', interpolation: 'smooth', elevationRange: '+/-30', orbitDirection: 'invert H3 orbit', subjectBox: '',
  }
  const compiled = cp.compileCameraDoc(doc)
  eq(compiled.result.frames, 243, 'compile: the profile\'s frame count (wire into generation length)')
  eq(compiled.result.fps, 24, 'compile: 24 fps rides the result')
  ok(compiled.plan.camera_choreography.startsWith('From 0.000s to 3.025s:'), 'compile: the plan carries the per-segment choreography')
  ok(compiled.result.compiledPrompt.includes('subject_definitions:') && compiled.result.storyboardJson.includes('h3-camera-plan'), 'compile: the six-section prompt + the storyboard are available for graph-side adoption')
  let threw = ''
  try { cp.compileCameraDoc({ ...doc, keyframes: [{ time: 0, azimuth: 0, elevation: 0, distance: 1 }, { time: 0, azimuth: 5, elevation: 0, distance: 1 }] }) } catch (error) { threw = error.message }
  eq(threw, 'Keyframe times must be strictly increasing.', 'compile: the compiler\'s own error taxonomy reaches the editor')

  // The box text: the compiler's own bytes, header-anchored, closed grammar.
  const text = cp.cameraBoxText(doc)
  ok(text.startsWith('Compiled camera path — 243 frames at 24 fps (10.083s):'), 'box text: the parseable header leads')
  ok(text.includes('physically move the CAMERA 120.000 degrees around the fixed target toward the camera\'s RIGHT'), 'box text: the signed (mirrored) orbit language')
  ok(text.includes('Reach the final pose at 10.083333s; there is no additional hold.'), 'box text: the final sentence terminates the block')
  ok(!text.includes('subject_definitions:'), 'box text: NOT the six-section compiledPrompt (it would collide with the outer concat structure)')
  const boxed = cp.cameraBoxText({ ...doc, subjectBox: '[L=0.516, T=0.148, W=0.071, H=0.249]' })
  ok(boxed.includes('the main subject occupies [L=0.516, T=0.148, W=0.071, H=0.249]'), 'box text: a subject box lands its literal anchor instruction')
  ok(!text.includes('main subject occupies'), 'box text: no anchor line without a subject box')

  // The best-effort parse: signed-frame reconstruction (no direction drift —
  // 'same as HUD' reproduces the same bytes), approximate by contract.
  const parsed = cp.parseCameraBoxText(text, 10)
  ok(parsed.approximate, 'parse: reconstruction is flagged approximate (review-gated)')
  eq(parsed.doc.profile, '243 frames (~10.13s)', 'parse: the profile recovers from the header')
  eq(parsed.doc.orbitDirection, 'same as HUD', 'parse: reconstructs in the signed frame (recompile = same bytes)')
  eq(parsed.doc.keyframes.length, 4, 'parse: one keyframe per segment boundary + the anchor')
  eq(parsed.doc.keyframes.map((point) => point.azimuth), [0, 120, 60, 240], 'parse: signed azimuths recover (the authored -120 mirrored to +120)')
  eq(parsed.doc.keyframes.map((point) => point.elevation), [0, -12, 20, 0], 'parse: elevation endpoints recover')
  eq(parsed.doc.keyframes.map((point) => point.distance), [1, 1.5, 0.55, 2], 'parse: radius endpoints recover')
  ok(Math.abs(parsed.doc.keyframes[1].time - 0.3) < 1e-3 && Math.abs(parsed.doc.keyframes[2].time - 0.7) < 1e-3, 'parse: times recover within the 3-decimal text rounding')
  eq(parsed.doc.keyframes[3].time, 1, 'parse: the final keyframe lands exactly on time 1')
  ok(parsed.block && parsed.block.start === 0, 'parse: the block starts at the header')
  eq(cp.cameraBoxText(parsed.doc), text, 'parse → recompile is byte-stable (the round-trip never drifts)')

  // Foreign text: no header → the default doc, no block (apply must append).
  const foreign = cp.parseCameraBoxText('The camera tracks him at slow speed', 6)
  eq(foreign.block, null, 'parse: hand prose carries no block')
  eq(foreign.doc.keyframes.length, 3, 'parse: foreign text falls back to the default doc')

  // The never-lossy splice.
  const chipGlue = ', the camera pushes in with small amplitude at slow speed'
  const edited = { ...parsed.doc, keyframes: parsed.doc.keyframes.map((point, index) => index === 2 ? { ...point, azimuth: 30 } : point) }
  const recompiled = cp.cameraBoxText(edited)
  ok(recompiled !== text, 'splice setup: the edited recompile differs')
  const applied = cp.applyCameraBoxText(text + chipGlue, recompiled)
  ok(applied.includes('the camera pushes in with small amplitude at slow speed'), 'splice: chip text glued after the final sentence SURVIVES')
  ok(applied.includes('move the CAMERA 90.000 degrees around the fixed target toward the camera\'s LEFT'), 'splice: the new block lands (the edited 90° left segment)')
  ok(!applied.includes('Reach the final pose at 10.083333s; there is no additional hold.\nFrom 0.000s'), 'splice: no block duplication')
  const prefixed = cp.applyCameraBoxText(`The camera arcs low.\n${text}`, recompiled)
  ok(prefixed.startsWith('The camera arcs low.\nCompiled camera path'), 'splice: foreign text BEFORE the block survives')
  eq(cp.applyCameraBoxText('The camera tracks him at slow speed', text), `The camera tracks him at slow speed\n${text}`, 'splice: with no recognized block the compiled text APPENDS (never replaces)')
  eq(cp.applyCameraBoxText('', text), text, 'splice: an empty box takes the block directly')

  // The persistence guard.
  ok(cp.readCameraPathDoc(doc) !== null, 'guard: a valid doc reads back')
  eq(cp.readCameraPathDoc(doc).keyframes[1].azimuth, -120, 'guard: the authored (HUD) azimuth round-trips, not the signed one')
  eq(cp.readCameraPathDoc(null), null, 'guard: null reads null')
  eq(cp.readCameraPathDoc('junk'), null, 'guard: a string reads null')
  eq(cp.readCameraPathDoc({ ...doc, keyframes: 'nope' }), null, 'guard: malformed keyframes read null')
  eq(cp.readCameraPathDoc({ ...doc, orbitDirection: 'sideways' }), null, 'guard: an unknown widget value reads null (the compiler\'s choice taxonomy)')
  eq(cp.readCameraPathDoc({ ...doc, keyframes: [{ time: 0, azimuth: 0, elevation: 0, distance: 1 }, { time: 0, azimuth: 9, elevation: 0, distance: 1 }] }), null, 'guard: keyframes violating validatePath read null')

  // The structured draft carries the doc; compose never reads it.
  eq(sp.emptyStructuredDraft().cameraPath, null, 'draft: the empty draft carries no doc')
  const withPath = { ...sp.emptyStructuredDraft(), concept: 'a probe', cameraPath: doc }
  eq(sp.composeStructuredPrompt(withPath, { duration: 6 }), sp.composeStructuredPrompt({ ...sp.emptyStructuredDraft(), concept: 'a probe' }, { duration: 6 }), 'draft: the doc is inert to compose (the box text is the contract)')
  ok(sp.readStructuredDraft({ concept: 'c', cameraPath: doc }).cameraPath.keyframes.length === 4, 'draft: the doc shallow-preserves through the persistence guard')
  ok(sp.readStructuredDraft({ concept: 'c', cameraPath: [1, 2] }).cameraPath === null, 'draft: a malformed doc reads as null, never a crash')
  ok(sp.mergeStructuredDraft(sp.emptyStructuredDraft(), withPath).cameraPath.keyframes.length === 4, 'draft: merge carries an incoming doc when none exists')
  ok(sp.mergeStructuredDraft(withPath, sp.emptyStructuredDraft()).cameraPath.keyframes.length === 4, 'draft: merge keeps the current doc')
  const generation = loadTs('src/canvas/generation.ts')
  const settings = generation.readChainSettings({ prompt: 'p', promptMode: 'structured', structured: { concept: 'c', cameraPath: doc } })
  ok(settings.structured.cameraPath.keyframes[3].distance === 2, 'settings: the authored doc round-trips through chain settings')

  // The one-click presets: the compiler's vocabulary, clamped to its ranges.
  // A path with tail room APPENDS; the DEFAULT_PATH (already ending at 1)
  // mutates its final keyframe instead.
  const tailDoc = { ...defaults, keyframes: [{ time: 0, azimuth: 0, elevation: 0, distance: 1 }, { time: 0.4, azimuth: 45, elevation: 10, distance: 1 }, { time: 0.8, azimuth: 90, elevation: 0, distance: 0.8 }] }
  const orbited = cp.applyCameraMovePreset(tailDoc, 'orbit')
  eq(orbited.keyframes.length, 4, 'presets: orbit appends a keyframe when the path has tail room')
  eq(orbited.keyframes[3].azimuth, 180, 'presets: orbit turns +90 from the current end (90 → 180)')
  ok(orbited.keyframes[3].time > 0.8 && orbited.keyframes[3].time <= 1, 'presets: the new keyframe lands inside the remaining tail')
  eq(cp.applyCameraMovePreset(tailDoc, 'static').keyframes[3].azimuth, 90, 'presets: static holds the end pose')
  eq(cp.applyCameraMovePreset(tailDoc, 'rise').keyframes[3].elevation, 15, 'presets: rise adds +15° to the END pose (0 → 15, inside the +/-30 range)')
  const elevated = { ...defaults, keyframes: [{ time: 0, azimuth: 0, elevation: 0, distance: 1 }, { time: 0.5, azimuth: 45, elevation: 10, distance: 1 }, { time: 1, azimuth: 90, elevation: 28, distance: 0.8 }] }
  eq(cp.applyCameraMovePreset(elevated, 'rise').keyframes[2].elevation, 30, 'presets: rise clamps at the elevation range (28 + 15 → 30, mutating the at-1 end)')
  ok(Math.abs(cp.applyCameraMovePreset(tailDoc, 'closer').keyframes[3].distance - 0.56) < 1e-9, 'presets: closer multiplies the radius by 0.7 (0.8 → 0.56)')
  const away = cp.applyCameraMovePreset({ ...defaults, keyframes: [{ time: 0, azimuth: 0, elevation: 0, distance: 1 }, { time: 0.5, azimuth: 45, elevation: 10, distance: 3 }, { time: 1, azimuth: 90, elevation: 0, distance: 3.2 }] }, 'away')
  eq(away.keyframes[2].distance, 4, 'presets: away caps at the compiler\'s 4× radius ceiling (3.2 × 1.4, mutating the at-1 end)')
  eq(cp.applyCameraMovePreset(defaults, 'orbit').keyframes.length, 3, 'presets: a path already ending at time 1 mutates the final keyframe instead')
  eq(cp.applyCameraMovePreset(defaults, 'orbit').keyframes[2].azimuth, 180, 'presets: the mutation still applies the move (90 → 180)')
  eq(cp.applyCameraMovePreset(defaults, 'nope'), null, 'presets: unknown ids read null')
  ok(cp.CAMERA_MOVE_PRESETS.map((preset) => preset.id).join('|') === 'orbit|rise|fall|closer|away|static', 'presets: exactly the AC\'s six (orbit/rise/fall/closer/away/static)')

  // The freeform detour: compose → parse never drops compiled-block bytes
  // (the structured editor's no-loss rule holds for the camera language —
  // the deterministic parse parks them in Concept; the doc is derived state
  // and re-derives best-effort through the editor).
  const detourDraft = { ...sp.emptyStructuredDraft(), concept: 'a probe shot', camera: text + ', the camera pushes in' }
  const detoured = sp.parseStructuredPrompt(sp.composeStructuredPrompt(detourDraft, { duration: 6 }))
  const detourText = [detoured.concept, detoured.setting, detoured.lighting, detoured.style, detoured.camera].concat(detoured.flow.map((row) => row.text)).join('\n')
  for (const fragment of ['Compiled camera path — 243 frames at 24 fps', 'physically move the CAMERA', 'Reach the final pose', 'the camera pushes in']) {
    ok(detourText.includes(fragment), `freeform detour: "${fragment.slice(0, 34)}" survives compose → parse`)
  }
}

// ---------------------------------------------------------------------------
// The LoRA timeline's pure layer (7twfk6o, layer 1 — segment granularity):
// the 17n+5 grid conformance, the transition-window defaults from the measured
// verdicts, the compiler (ranges → segments; degenerate input refused WITH
// REASONS; uncovered spans → base segments), the plan-document builder, and
// the graph seam that chains the per-segment LoRA stacks.
// ---------------------------------------------------------------------------
console.log('(aa) LoRA timeline — the compiler, the grid, the measured windows')
{
  const lt = loadTs('src/canvas/loraTimeline.ts')
  const plan = loadTs('src/canvas/plan.ts')
  const generation = loadTs('src/canvas/generation.ts', { localStorage: localStorageStub, window: { dispatchEvent: () => undefined, addEventListener: () => undefined } })
  const workflow = loadTs('src/lib/workflow.ts')

  // (1) The grid: nearest 17n+5 inside the 56–345 band (the chain clamp 2–15 s
  // expressed in frames), ties snapping up like frameCount.
  eq(lt.conformFrames(48), 56, 'grid: 2.0s snaps UP to the band floor 56f (48 is below the minimum)')
  eq(lt.conformFrames(56), 56, 'grid: a legal count is its own snap')
  eq(lt.conformFrames(144), 141, 'grid: 6.0s (144f) snaps to the NEAREST rung 141f (3 away, vs 158 14 away)')
  eq(lt.conformFrames(156), 158, 'grid: 6.5s (156f) snaps to the nearest rung 158f (2 away, vs 141 15 away)')
  eq(lt.conformFrames(360), 345, 'grid: 15s clamps to the band ceiling 345f')
  ok(Math.abs(lt.conformDurationSeconds(6) - 141 / 24) < 1e-9, 'grid: duration conformance is frames/24')
  // The drift guard: every conformed duration is a fixed point of
  // workflow.frameCount (the two grid implementations can never diverge).
  for (let seconds = 2; seconds <= 15; seconds += 0.25) {
    const frames = lt.conformFrames(seconds * 24)
    ok(frames % 17 === 5, `grid: ${frames}f ≡ 5 (mod 17) for painted ${seconds}s`)
    eq(workflow.frameCount(lt.conformDurationSeconds(seconds)), frames, `grid: frameCount(conform(${seconds}s)) === ${frames}f (the shared grid holds)`)
  }
  eq(lt.legalBoundarySeconds(0, 15).length, 18, 'grid: 18 legal boundary positions across 0–15s (56..345 step 17)')
  ok(Math.abs(lt.snapRangeBoundary(6, 0, 12) - 141 / 24) < 1e-9, 'grid: a dragged boundary snaps to the nearest legal position (6s → 5.875s)')
  ok(lt.snapRangeBoundary(6, 0, 4) === null, 'grid: a 4s span cannot split into two ≥2s legal segments — the drag is REFUSED (null), never clamped degenerate')

  // (2) The measured window defaults (the tranche-1 verdicts).
  eq(lt.DEFAULT_TRANSITION_WINDOW.cut, 0, 'windows: the hard cut is instantaneous (the measured default)')
  ok(Math.abs(lt.DEFAULT_TRANSITION_WINDOW.flf - 22 / 24) < 1e-9, 'windows: FLF defaults to the 22-frame Motion-Context continuation window')
  ok(Math.abs(lt.DEFAULT_TRANSITION_WINDOW.black - 0.75) < 1e-9, 'windows: dip-to-black defaults to the measured 15–18f dip (18f = 0.75s)')
  eq(lt.DEFAULT_TRANSITION_WINDOW.nle, 0.5, 'windows: the NLE crossfade defaults to the 0.5s post convention')
  ok(Math.abs(lt.DEFAULT_TRANSITION_WINDOW.bridge - 22 / 24) < 1e-9, 'windows: the bridge carries the FLF-class window (its render stays engine work)')

  // (3) Degenerate input is refused WITH REASONS (every reason user-facing).
  const range = (id, start, end, loras) => ({ id, start, end, loras: loras ?? [] })
  const A = { name: 'style-a.safetensors', strength: 0.8 }
  const B = { name: 'style-b.safetensors', strength: 0.5 }
  ok(!lt.compileLoraTimeline(lt.newLoraTimelineDoc(), 12).ok, 'refuse: an unpainted clip does not compile')
  ok(lt.compileLoraTimeline(lt.newLoraTimelineDoc(), 12).reasons[0].includes('Paint at least one'), 'refuse: the empty-set reason is the action to take')
  ok(!lt.compileLoraTimeline({ ranges: [range('r1', 3, 3)], transitions: [] }, 12).ok, 'refuse: a zero-length range')
  ok(lt.compileLoraTimeline({ ranges: [range('r1', 3, 3)], transitions: [] }, 12).reasons[0].includes('ends at or before its start'), 'refuse: the point-range reason names the defect')
  ok(lt.compileLoraTimeline({ ranges: [range('r1', 0, 1.2)], transitions: [] }, 12).reasons[0].includes('Paint it at least 2s'), 'refuse: sub-floor ranges carry the 17n+5 minimum in the reason')
  ok(!lt.compileLoraTimeline({ ranges: [range('r1', 0, 16)], transitions: [] }, 12).ok, 'refuse: a range past the 15s ceiling')
  ok(!lt.compileLoraTimeline({ ranges: [range('r1', 0, 5), range('r2', 4, 9)], transitions: [] }, 12).ok, 'refuse: overlapping ranges')
  ok(lt.compileLoraTimeline({ ranges: [range('r1', 0, 5), range('r2', 4, 9)], transitions: [] }, 12).reasons[0].includes('overlap'), 'refuse: the overlap reason states where')
  ok(!lt.compileLoraTimeline({ ranges: [range('r1', 6, 14)], transitions: [] }, 12).ok, 'refuse: a range extending past the clip')
  ok(lt.compileLoraTimeline({ ranges: [range('r1', 0, 5, [A, B, { name: 'c.safetensors', strength: 1 }])], transitions: [] }, 12).reasons.some((reason) => reason.includes('3 LoRAs')), 'refuse: >2 stack entries names the slot cap')
  ok(lt.compileLoraTimeline({ ranges: [range('r1', 0, 5, [{ name: '', strength: 1 }])], transitions: [] }, 12).reasons.some((reason) => reason.includes('no LoRA file')), 'refuse: an unpicked slot name')

  // (4) The compile: two painted ranges over a 12s clip.
  const twoRanges = {
    ranges: [range('r1', 0, 5.5, [A]), range('r2', 5.5, 12, [A, B])],
    transitions: [],
  }
  const compiled = lt.compileLoraTimeline(twoRanges, 12)
  ok(compiled.ok, 'compile: two clean ranges compile')
  eq(compiled.segments.map((segment) => segment.frames), [124, 158], 'compile: each segment conforms to the 17n+5 grid (124f, 158f)')
  ok(Math.abs(compiled.segments[0].durationSeconds - 124 / 24) < 1e-9, 'compile: 5.5s painted conforms to 5.1667s (nearest rung 124f, 8 away vs 141 9 away)')
  ok(Math.abs(compiled.segments[1].durationSeconds - 158 / 24) < 1e-9, 'compile: 6.5s painted conforms to 6.583s')
  ok(Math.abs(compiled.totalSeconds - (124 + 158) / 24) < 1e-9, 'compile: the planned total is the conformed sum (may drift off the painted clip in either direction)')
  eq(compiled.segments[0].range.start, 0, 'compile: the PAINTED range rides verbatim (provenance)')
  ok(Math.abs(compiled.segments[0].range.end - 5.5) < 1e-9, 'compile: painted end stays 5.5s even though the conformed layout stretches')
  eq(compiled.segments[0].gapAfter.kind, 'cut', 'compile: an unrecorded boundary joins at the measured default (hard cut)')
  eq(compiled.segments[0].gapAfter.widthSeconds, 0, 'compile: the hard cut window is zero')
  eq(compiled.segments[1].title, 'style-a + style-b', 'compile: the title derives from the LoRA set')
  eq(compiled.segments[0].loras.length, 1, 'compile: the stack rides the segment')
  ok(compiled.warnings.some((warning) => warning.includes('conforms to')), 'compile: a stretched duration warns honestly')

  // (5) Uncovered spans compile to BASE segments (never silent gaps).
  const partial = lt.compileLoraTimeline({ ranges: [range('r1', 0, 4, [A])], transitions: [] }, 12)
  ok(partial.ok, 'base: partial painting compiles')
  eq(partial.segments.length, 2, 'base: the uncovered tail becomes a base segment')
  eq(partial.segments[1].loras, [], 'base: the base segment carries no stack')
  eq(partial.segments[1].title, 'base look', 'base: the base segment is labeled honestly')
  ok(Math.abs(partial.segments[1].range.start - 4) < 1e-9, 'base: the base segment records its painted span')

  // A sub-floor uncovered span joins the LEFT range — reported, never silent.
  const absorbed = lt.compileLoraTimeline({ ranges: [range('r1', 0, 5, [A]), range('r2', 5.5, 12, [B])], transitions: [] }, 12)
  ok(absorbed.ok, 'absorb: a 0.5s uncovered span does not block the compile')
  eq(absorbed.segments.length, 2, 'absorb: the sub-floor span joins the previous range (no base segment)')
  ok(Math.abs(absorbed.segments[0].range.end - 5.5) < 1e-9, 'absorb: the left range extends over the span')
  ok(absorbed.warnings.some((warning) => warning.includes('uncovered span')), 'absorb: the join warns')

  // (6) Recorded transitions: the user's kind + window win; the FLF gap lands
  // on the plan document (only non-cut gaps persist — a missing gap IS the
  // cut default per plan.ts's read contract).
  const flfCompiled = lt.compileLoraTimeline({
    ranges: [range('r1', 0, 5, [A]), range('r2', 5, 12, [B])],
    transitions: [{ afterRangeId: 'r1', kind: 'flf', widthSeconds: 1.25 }],
  }, 12)
  eq(flfCompiled.segments[0].gapAfter.kind, 'flf', 'transition: the recorded FLF choice wins over the cut default')
  ok(Math.abs(flfCompiled.segments[0].gapAfter.widthSeconds - 1.25) < 1e-9, 'transition: the user-set window width rides (not the 22f default)')
  const planDoc = lt.loraTimelineToPlanDocument(flfCompiled, { prompt: 'the drummer boards', referenceCharacterIds: ['lib-ada'], referenceLocationIds: [] })
  eq(planDoc.segments.length, 2, 'plan: every compiled segment becomes a plan segment')
  eq(planDoc.segments[0].prompt, 'the drummer boards', 'plan: the source chain\'s prompt is inherited')
  eq(planDoc.segments[0].referenceCharacterIds, ['lib-ada'], 'plan: reference handoffs are inherited')
  ok(Math.abs(planDoc.segments[0].loraRange.end - 5) < 1e-9, 'plan: the painted range is recorded (AC4 provenance)')
  eq(planDoc.segments[0].loraStack, [{ name: 'style-a.safetensors', strength: 0.8 }], 'plan: the per-segment stack is recorded (AC4 provenance)')
  eq(planDoc.segments[1].loraStack, [{ name: 'style-b.safetensors', strength: 0.5 }], 'plan: each segment carries its OWN stack')
  eq(planDoc.gaps, [{ afterSegmentId: planDoc.segments[0].id, kind: 'flf' }], 'plan: only non-cut gaps persist (the cut is the missing-gap default)')

  // The plan reader round-trips the provenance tolerantly (foreign data never
  // crashes; garbage provenance drops to absent, never to a wrong value).
  const reread = plan.readPlanDocument(planDoc)
  ok(Math.abs(reread.segments[0].loraRange.end - 5) < 1e-9, 'plan read: loraRange survives the tolerant round-trip')
  eq(reread.segments[0].loraStack[0].name, 'style-a.safetensors', 'plan read: loraStack survives the tolerant round-trip')
  const garbage = plan.readPlanDocument({ segments: [{ id: 's1', loraRange: 'nope', loraStack: [{ name: 7 }] }] })
  ok(garbage.segments[0].loraRange === undefined, 'plan read: garbage provenance drops (absent, never wrong)')
  ok(garbage.segments[0].loraStack === undefined, 'plan read: a malformed stack drops entirely')

  // (7) The doc reader: tolerant, id-stable, transition-validated.
  const readDoc = lt.readLoraTimelineDoc({
    ranges: [
      { id: 'r1', start: 0, end: 5, loras: [{ name: 'a.safetensors', strength: 0.9 }, { name: 'b.safetensors', strength: 0.4 }, { name: 'c.safetensors', strength: 1 }] },
      { id: 'r1', start: 6, end: 9 },
    ],
    transitions: [{ afterRangeId: 'r1', kind: 'warp' }, { afterRangeId: 'missing', kind: 'flf' }],
  })
  eq(readDoc.ranges.length, 2, 'read: ranges survive')
  eq(readDoc.ranges[1].id, 'r1-2', 'read: duplicate ids are re-suffixed (boundary keys stay unique)')
  eq(readDoc.ranges[0].loras.length, 2, 'read: a 3-entry stack truncates to the slot cap')
  eq(readDoc.transitions.length, 0, 'read: unknown kinds and dangling range refs drop')
  eq(lt.readLoraTimelineDoc(null).ranges.length, 0, 'read: null reads as the empty doc, never a crash')

  // (8) Chain settings: the stack + the authored doc ride the tolerant read
  // (the per-segment chains seeded by applyLoraTimeline carry their stacks
  // through exactly this path).
  const stacked = generation.readChainSettings({ prompt: 'p', loraStack: [{ name: 'a.safetensors', strength: 0.8 }, { name: 'b.safetensors', strength: 1.7 }], loraTimeline: { ranges: [{ id: 'r1', start: 0, end: 5, loras: [{ name: 'a.safetensors', strength: 0.8 }] }], transitions: [] } })
  eq(stacked.loraStack, [{ name: 'a.safetensors', strength: 0.8 }, { name: 'b.safetensors', strength: 1.7 }], 'settings: the stack round-trips')
  eq(stacked.loraStack[1].strength, 1.7, 'settings: strengths inside 0–2 stay verbatim')
  eq(stacked.loraTimeline.ranges[0].loras[0].name, 'a.safetensors', 'settings: the authored timeline doc round-trips')
  const clamped = generation.readChainSettings({ loraStack: [{ name: 'a.safetensors', strength: 9 }] })
  eq(clamped.loraStack[0].strength, 2, 'settings: out-of-band strengths clamp at 2')
  eq(generation.readChainSettings({}).loraTimeline, null, 'settings: no doc reads null')

  // (9) The graph seam: the stack chains LoraLoaderModelOnly after the turbo
  // seam ('8'/'9'), slot 0 upgrading to the first-party form adapter when its
  // node reports; ABSENT stack = byte-identical factory output (inertness).
  const fakeSelection = { fl2va: 'T-fl2va.safetensors', ref2va: 'T-ref2va.safetensors', textEncoder: 'T-qwen.safetensors', videoVae: 'T-vvae.safetensors', audioVae: 'T-avae.safetensors', previewVae: '', fl2vLora: 'T-fl2v-lora.safetensors', ref2vLora: 'T-ref2v-lora.safetensors' }
  const stackRequest = generation.buildCanvasRenderRequest(
    generation.readChainSettings({ prompt: 'p', turbo: 'off', loraStack: [A, B] }),
    { firstFrame: null, lastFrame: null, referenceImages: [], referenceVideos: [], referenceAudios: [] },
    [],
  )
  const stackGraph = generation.planCanvasGraph(stackRequest, fakeSelection)
  eq(stackGraph['8'].class_type, 'LoraLoaderModelOnly', 'graph: stack slot 0 loads through the stock loader without the adapter pack')
  eq(stackGraph['8'].inputs.lora_name, 'style-a.safetensors', 'graph: slot 0 carries its LoRA file')
  ok(Math.abs(stackGraph['8'].inputs.strength_model - 0.8) < 1e-9, 'graph: slot 0 carries its strength')
  eq(stackGraph['8'].inputs.model.join('.'), '1.0', 'graph: without turbo the stack chains straight off the UNet')
  eq(stackGraph['9'].class_type, 'LoraLoaderModelOnly', 'graph: stack slot 1 loads through the stock loader')
  eq(stackGraph['9'].inputs.model.join('.'), '8.0', 'graph: slot 1 consumes slot 0\'s MODEL output (the chain composes)')
  const bare = generation.planCanvasGraph(generation.buildCanvasRenderRequest(
    generation.readChainSettings({ prompt: 'p', turbo: 'off' }),
    { firstFrame: null, lastFrame: null, referenceImages: [], referenceVideos: [], referenceAudios: [] },
    [],
  ), fakeSelection)
  ok(bare['8'] === undefined && bare['9'] === undefined, 'graph: NO stack = no stack loaders (the seam is inert by option-absence)')
  const turboStackGraph = generation.planCanvasGraph(generation.buildCanvasRenderRequest(
    generation.readChainSettings({ prompt: 'p', turbo: '8', loraStack: [A] }),
    { firstFrame: null, lastFrame: null, referenceImages: [], referenceVideos: [], referenceAudios: [] },
    [],
  ), fakeSelection)
  ok(turboStackGraph['5'] !== undefined, 'graph: the turbo tier keeps its own loader (the stack is orthogonal)')
  eq(turboStackGraph['8'].inputs.model.join('.'), '5.0', 'graph: the stack chains AFTER the turbo seam')
  const adapted = workflow.buildMiniMaxWorkflow(
    { mode: 'text', prompt: 'p', width: 1344, height: 768, duration: 6, seed: 1, steps: 30, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', refImageSize: 'match', referenceImages: [], referenceVideos: [], referenceAudios: [], filenamePrefix: 'video/t', loraStack: [A] },
    fakeSelection,
    {},
    { MiniMaxH3LoraFormLoader: {} },
  )
  eq(adapted['8'].class_type, 'MiniMaxH3LoraFormLoader', 'graph: with the pack installed slot 0 rides the form adapter (cross-form safety, first among stack loaders)')
  eq(adapted['8'].inputs.lora_name, 'style-a.safetensors', 'graph: the adapter carries the LoRA name')

  // (10) Combined-strength guidance (the workbench pins): warnings, never
  // silent rewrites.
  const risky = lt.compileLoraTimeline({ ranges: [range('r1', 0, 6, [{ name: 'a.safetensors', strength: 0.5 }, { name: 'b.safetensors', strength: 0.5 }])], transitions: [] }, 12)
  ok(risky.ok && risky.warnings.some((warning) => warning.includes('healthy')), 'guidance: combined 1.0 warns above the healthy band')
  const collapse = lt.compileLoraTimeline({ ranges: [range('r1', 0, 6, [{ name: 'a.safetensors', strength: 0.8 }, { name: 'b.safetensors', strength: 0.5 }]), range('r2', 6, 12, [{ name: 'c.safetensors', strength: 0.6 }, { name: 'd.safetensors', strength: 0.5 }])], transitions: [] }, 12)
  ok(collapse.warnings.some((warning) => warning.includes('collapse-risk')), 'guidance: combined 1.1 flags the collapse-risk band')

  // (11) Take-metrics provenance (AC4): the manifest's LoRA records become
  // the take's metrics.loras — turbo (models.turboLora @ loraStrength) + the
  // temporal stack; nothing active = the metric stays ABSENT.
  eq(lt.activeLorasOf(null), {}, 'metrics: no manifest → no loras key')
  eq(lt.activeLorasOf({ models: {}, loraStack: [] }), {}, 'metrics: nothing active → the metric stays absent (never an empty array)')
  eq(lt.activeLorasOf({ models: { turboLora: { name: 'turbo-8.safetensors', bytes: 1 } }, loraStrength: 0.75, loraStack: [{ name: 'style-a.safetensors', strength: 0.8 }] }),
    { loras: [{ name: 'turbo-8.safetensors', strength: 0.75 }, { name: 'style-a.safetensors', strength: 0.8 }] },
    'metrics: the turbo LoRA (at its strength) + the temporal stack both ride')
  eq(lt.activeLorasOf({ models: { turboLora: { name: 'turbo-8.safetensors' } }, loraStack: [{ name: 'style-a.safetensors', strength: 0.8 }, { malformed: true }] }),
    { loras: [{ name: 'turbo-8.safetensors', strength: 1 }, { name: 'style-a.safetensors', strength: 0.8 }] },
    'metrics: a missing strength defaults 1; malformed stack entries drop; garbage never crashes')
}

phase5Cores()
  .then(() => { console.log(`\ntest-canvas: ${passed} assertions passed`) })
  .catch((error) => { console.error(error); process.exit(1) })
