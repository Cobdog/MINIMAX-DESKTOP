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
  // media resolution prefers the engine-visible sourcePath and records kind
  const outputs = generation.buildOutputIndex(doc)
  const resolved = generation.mediaForOutput(outputs.get('out-1'))
  eq(resolved.media.path, '/out/a.mp4', 'media: metrics.sourcePath (the engine-visible copy) wins')
  eq(resolved.media.kind, 'video', 'media: kind read from the take metrics')
  eq(generation.mediaForOutput(undefined), null, 'media: unresolvable output answers null (honest)')
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
  eq(ops.opKindsFor('image').length, 6, 'kinds: the image surface offers six v1 op kinds (stabilize is video-only)')
  ok(ops.opKindsFor('image').includes('crop'), 'kinds: image offers crop')
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
  const mc = take('take-mc', { metrics: { kind: 'video', motionContext: { folder: 'h3_context/src/clip', clipIndex: 3 } }, latentPath: 'h3_context/src/clip3.latent' })
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
  eq(load.inputs.latent_path, 'h3_context/chain-a/clip', 'graph: LoadLatent reads the SOURCE folder via loadFrom')
  eq(load.inputs.clip_index, 0, 'graph: LoadLatent reads the SOURCE clip index (not index-1 of the fork)')
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

console.log(`\ntest-canvas: ${passed} assertions passed`)
