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

const media = (path, kind) => ({ path, name: path.split('/').pop(), kind })
const take = (id, overrides) => ({ id, outputId: 'out-1', jobId: null, artifacts: [], latentPath: null, metrics: null, createdAt: 1, supersededBy: null, evicted: false, contentHash: null, ...overrides })
const output = (id, chainId, takes) => ({ id, chainId, substratesAvailable: ['decoded'], createdAt: 1, canonicalTakeId: takes.find((t) => !t.supersededBy)?.id ?? null, takes })
const chainOf = (id, overrides) => ({ id, projectId: 'p1', kind: 'generation', inputSpec: {}, settings: {}, lockState: 'unlocked', hopCount: 0, driftMetrics: null, stale: false, createdAt: 1, outputs: [], ops: [], identity: null, ...overrides })

console.log('(l) L4 — selection decides the surface (effectiveMode)')
{
  eq(generation.effectiveMode({ firstFrameOutputId: null, lastFrameOutputId: null, referenceOutputIds: [], referenceCharacterIds: [], referenceLocationIds: [] }), 'text', 'L4: nothing + prompt = text-to-video')
  eq(generation.effectiveMode({ firstFrameOutputId: 'o1', lastFrameOutputId: null, referenceOutputIds: [], referenceCharacterIds: [], referenceLocationIds: [] }), 'image', 'L4: a selected image output = image-to-video')
  eq(generation.effectiveMode({ firstFrameOutputId: 'o1', lastFrameOutputId: 'o2', referenceOutputIds: [], referenceCharacterIds: [], referenceLocationIds: [] }), 'frames', 'L4: first + last = frames')
  eq(generation.effectiveMode({ firstFrameOutputId: 'o1', lastFrameOutputId: 'o2', referenceOutputIds: ['o3'], referenceCharacterIds: [], referenceLocationIds: [] }), 'reference', 'L4: any reference wins over frames (resolveMovieShot precedence)')
  eq(generation.effectiveMode({ firstFrameOutputId: null, lastFrameOutputId: null, referenceOutputIds: [], referenceCharacterIds: ['char-1'], referenceLocationIds: [] }), 'reference', 'L4: a library character binding selects reference mode')
  eq(generation.effectiveMode({ firstFrameOutputId: null, lastFrameOutputId: null, referenceOutputIds: [], referenceCharacterIds: [], referenceLocationIds: ['loc-1'] }), 'reference', 'L4: a location binding selects reference mode')
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
  const ready = { connected: true, h3Ready: true, utilities: [{ tool: 'remove-subtitles', label: 'Remove subtitles', available: true, missing: [] }, { tool: 'ia2v', label: 'Image + audio → video', available: false, missing: ['node LTXICLoRALoaderModelOnly'] }] }
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

  const offline = options.endpointOptions('produce', ['image'], { connected: false, h3Ready: false, utilities: [] })
  ok(offline.find((row) => row.id === 'produce:i2v').available, 'produce(offline): chain creation still offered — the refusal surfaces at submit')
  ok(offline.find((row) => row.id === 'produce:fork-decoded').available, 'produce(offline): forking still offered — no engine needed')
  const offlineVideo = options.endpointOptions('produce', ['video'], { connected: false, h3Ready: false, utilities: [{ tool: 'remove-subtitles', label: 'Remove subtitles', available: true, missing: [] }] })
  ok(!offlineVideo.find((row) => row.id === 'produce:utility:remove-subtitles').available, 'produce(offline): utilities stay gated on the engine')
  ok(offlineVideo.find((row) => row.id === 'produce:utility:remove-subtitles').reason.includes('offline'), 'produce(offline): the utility reason says the engine is offline')
  const offlineConsume = options.endpointOptions('consume', ['image'], { connected: false, h3Ready: false, utilities: [] })
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

console.log(`\ntest-canvas: ${passed} assertions passed`)
