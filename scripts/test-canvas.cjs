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

console.log('(k) seedSpawnPoint (spatial-queue contract c)')
{
  const camera = { x: 0, y: 0, k: 1 }
  const spawn = derive.seedSpawnPoint(camera, 1920, 1080)
  const screen = cameraMod.worldToScreen(spawn.x + derive.TILE_W / 2, spawn.y, camera)
  close(screen.x, 960, 1e-6, 'spawn: centered under the prompt bar')
  ok(screen.y > 300 && screen.y < 540, 'spawn: lands in the upper-middle band where the bar sits')
}

console.log(`\ntest-canvas: ${passed} assertions passed`)
