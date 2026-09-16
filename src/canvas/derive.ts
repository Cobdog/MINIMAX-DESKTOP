/**
 * Canvas Phase 1 — document → spatial projection (§2 "every view is a
 * projection of it", §3 tile anatomy).
 *
 * Pure functions over the Phase-0 document shape (server/documents.ts
 * hydration): chains become tiles, input-spec outputRefs become derived
 * edges, jobs + chain stale flags become the status ring. No React, no DOM —
 * covered by scripts/test-canvas.cjs through the VM harness.
 *
 * Phase-1 boundary kept honest: nothing here fires or schedules generation.
 * The seed tile's queued state is a projection of jobsStore (the launcher
 * drops a mock job there); Phase 2 replaces the mock with the real submit.
 */
import { type CameraState, type ViewBlob } from './camera'

// ---- document shapes (mirror server/documents.ts hydration) -----------------

export type DocumentTake = {
  id: string
  outputId: string
  jobId: string | null
  artifacts: string[]
  latentPath: string | null
  metrics: Record<string, unknown> | null
  createdAt: number
  supersededBy: string | null
  evicted: boolean
  contentHash: string | null
}

export type DocumentOutput = {
  id: string
  chainId: string
  substratesAvailable: string[]
  createdAt: number
  canonicalTakeId: string | null
  takes: DocumentTake[]
}

export type DocumentOp = { id: string; stackId: string; ordinal: number; kind: string; settings: Record<string, unknown>; bakedAt: number | null }

export type DocumentChain = {
  id: string
  projectId: string
  kind: string
  inputSpec: Record<string, unknown>
  settings: Record<string, unknown>
  lockState: string
  hopCount: number
  driftMetrics: Record<string, unknown> | null
  stale: boolean
  createdAt: number
  outputs: DocumentOutput[]
  ops: DocumentOp[]
}

export type CanvasDocument = {
  project: { id: string; name: string; camera: Record<string, unknown>; createdAt: number; lastActiveAt: number }
  chains: DocumentChain[]
}

/** The job facts the status ring needs — GenerationJob is structural here so
 *  the canvas never imports the old surface's full type (Phase 4 kills it). */
export type JobFact = { id: string; status: string; progress: number; error?: string; prompt?: string }

// ---- status ring (§3, §4 contract) ------------------------------------------

export type TileStatus = 'idle' | 'queued-gpu' | 'running' | 'stale' | 'failed'

export const STATUS_LABEL: Record<TileStatus, string> = {
  'idle': 'idle',
  'queued-gpu': 'queued for GPU',
  'running': 'running',
  'stale': 'stale',
  'failed': 'failed — needs attention',
}

/**
 * The on-object state (§4 spatial per-job state, contract a + L26): a linked
 * job wins over the chain's stale flag in this order — failed (durable until
 * dismissed) > running > queued-for-GPU — because it is the live truth about
 * work touching the object; stale is the document's derived state when no
 * work is in flight.
 */
export function tileStatus(chain: { stale: boolean }, job: JobFact | null, dismissed: boolean): TileStatus {
  if (job && job.status === 'failed') return dismissed ? (chain.stale ? 'stale' : 'idle') : 'failed'
  if (job && job.status === 'running') return 'running'
  if (job && (job.status === 'queued' || job.status === 'pending')) return 'queued-gpu'
  return chain.stale ? 'stale' : 'idle'
}

// ---- tiles -------------------------------------------------------------------

export type TileKind = 'media' | 'seed'

export type Tile = {
  id: string // chain id — one tile per chain in Phase 1
  kind: TileKind
  title: string
  prompt: string
  x: number
  y: number
  w: number
  h: number
  status: TileStatus
  statusNote: string | null
  jobId: string | null
  refOutputs: string[]
  ops: Array<{ id: string; kind: string }>
  canonical: DocumentTake | null
  priors: number
  substrates: string[]
  /** Output-contained absolute artifact path for the filmstrip poster, if any. */
  previewPath: string | null
  duration: number
  lockState: string
}

export const TILE_W = 320
export const TILE_H_MEDIA = 296
export const TILE_H_SEED = 132
/** L25 (decided): adjacency-near-parent default. */
export const ADJACENCY_GAP_X = 140
const GRID_ORIGIN = { x: 120, y: 96 }
const GRID_STEP = { x: TILE_W + ADJACENCY_GAP_X, y: TILE_H_MEDIA + 110 }
const GRID_ROWS = 4

export function tileRect(tile: Tile): { x: number; y: number; w: number; h: number } {
  return { x: tile.x, y: tile.y, w: tile.w, h: tile.h }
}

/** The chain's prompt: input-spec fresh prompt first, settings prompt second. */
export function chainPrompt(chain: DocumentChain): string {
  const fresh = chain.inputSpec && typeof chain.inputSpec.fresh === 'object' ? (chain.inputSpec.fresh as Record<string, unknown>) : null
  if (fresh && typeof fresh.prompt === 'string' && fresh.prompt) return fresh.prompt
  if (typeof chain.settings.prompt === 'string' && chain.settings.prompt) return chain.settings.prompt
  return ''
}

/** Media kind a drop/seed carries (input-spec fresh media kind). */
export function chainMediaKind(chain: DocumentChain): string | null {
  const fresh = chain.inputSpec && typeof chain.inputSpec.fresh === 'object' ? (chain.inputSpec.fresh as Record<string, unknown>) : null
  const media = fresh && typeof fresh.media === 'object' ? (fresh.media as Record<string, unknown>) : null
  const kind = media?.kind
  return typeof kind === 'string' && kind ? kind : null
}

/** Collects output ids referenced anywhere in an input spec (the §2.1
 *  recursion, same leniency as the server's collectOutputRefs). */
export function collectOutputRefs(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectOutputRefs(item, into)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if ((key === 'outputId' || key === 'output_id') && typeof child === 'string' && child) into.add(child)
    else collectOutputRefs(child, into)
  }
}

function outputOwnerIndex(document: CanvasDocument): Map<string, { chain: DocumentChain; output: DocumentOutput }> {
  const index = new Map<string, { chain: DocumentChain; output: DocumentOutput }>()
  for (const chain of document.chains) {
    for (const output of chain.outputs) index.set(output.id, { chain, output })
  }
  return index
}

function takeDuration(take: DocumentTake): number {
  const raw = take.metrics?.duration
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) && value > 0 ? value : 0
}

function previewArtifactOf(take: DocumentTake | null): string | null {
  if (!take) return null
  for (const artifact of take.artifacts) {
    if (artifact.startsWith('/')) return artifact
  }
  return null
}

function titleFor(document: CanvasDocument, chain: DocumentChain, index: number): string {
  const mediaKind = chainMediaKind(chain)
  if (mediaKind) return `${mediaKind} ${index + 1}`
  const prompt = chainPrompt(chain)
  if (prompt) {
    const firstLine = prompt.split(/[.\n]/).map((part) => part.trim()).find(Boolean) ?? prompt
    return firstLine.length > 42 ? `${firstLine.slice(0, 41)}…` : firstLine
  }
  return `${chain.kind} ${index + 1}`
}

/**
 * The Phase-1 projection: one tile per live chain. Placement order (L25
 * decided: adjacency-near-parent default + cluster grid for roots):
 *   1. a persisted layout entry (project view blob) wins — UI state, never
 *      document semantics;
 *   2. root chains (no output refs) fill the grid deterministically by
 *      creation order;
 *   3. ref chains land right of their first resolvable source tile, stacked
 *      by sibling order (cluster-on-parent).
 */
export function deriveTiles(
  document: CanvasDocument,
  jobs: ReadonlyArray<JobFact>,
  links: Readonly<Record<string, string>>,
  layout: ViewBlob['layout'],
  dismissed: ReadonlySet<string> = new Set(),
): Tile[] {
  const jobsById = new Map(jobs.map((job) => [job.id, job]))
  const owner = outputOwnerIndex(document)
  const byId = new Map(document.chains.map((chain) => [chain.id, chain]))

  const refCounts = new Map<string, number>()
  const refsOf = new Map<string, string[]>()
  for (const chain of document.chains) {
    const refs = new Set<string>()
    collectOutputRefs(chain.inputSpec, refs)
    refsOf.set(chain.id, Array.from(refs))
  }

  const placed = new Map<string, { x: number; y: number }>()
  let rootIndex = 0
  for (const chain of document.chains) {
    const refs = refsOf.get(chain.id) ?? []
    const saved = layout?.[chain.id]
    if (saved) {
      placed.set(chain.id, { x: saved.x, y: saved.y })
      continue
    }
    if (!refs.length) {
      const column = Math.floor(rootIndex / GRID_ROWS)
      const row = rootIndex % GRID_ROWS
      placed.set(chain.id, { x: GRID_ORIGIN.x + column * GRID_STEP.x, y: GRID_ORIGIN.y + row * GRID_STEP.y })
      rootIndex += 1
      continue
    }
    const source = refs.map((id) => owner.get(id)?.chain).find((chain): chain is DocumentChain => Boolean(chain))
    const sourcePlace = source ? placed.get(source.id) : undefined
    if (!source || !sourcePlace) {
      // Orphaned ref (source tombstoned): fall back to the grid slot.
      const column = Math.floor(rootIndex / GRID_ROWS)
      const row = rootIndex % GRID_ROWS
      placed.set(chain.id, { x: GRID_ORIGIN.x + column * GRID_STEP.x, y: GRID_ORIGIN.y + row * GRID_STEP.y })
      rootIndex += 1
      continue
    }
    const count = refCounts.get(source.id) ?? 0
    refCounts.set(source.id, count + 1)
    placed.set(chain.id, { x: sourcePlace.x + TILE_W + ADJACENCY_GAP_X, y: sourcePlace.y + count * (TILE_H_MEDIA + 60) })
  }

  return document.chains.map((chain, index) => {
    const refs = refsOf.get(chain.id) ?? []
    const jobId = links[chain.id] ?? null
    const job = jobId ? jobsById.get(jobId) ?? null : null
    const canonical = chain.outputs.flatMap((output) => output.takes).find((take) => take.supersededBy === null) ?? null
    const priors = chain.outputs.reduce((sum, output) => sum + output.takes.filter((take) => take.supersededBy !== null).length, 0)
    const place = placed.get(chain.id) ?? GRID_ORIGIN
    const kind: TileKind = canonical || chain.kind === 'media' ? 'media' : 'seed'
    const width = layout?.[chain.id]?.w ?? TILE_W
    return {
      id: chain.id,
      kind,
      title: titleFor(document, chain, index),
      prompt: chainPrompt(chain),
      x: place.x,
      y: place.y,
      w: width,
      h: kind === 'media' ? TILE_H_MEDIA : TILE_H_SEED,
      status: tileStatus(chain, job, dismissed.has(chain.id)),
      statusNote: job && job.status === 'failed' ? job.error ?? 'generation failed' : null,
      jobId,
      refOutputs: refs,
      ops: chain.ops.map((op) => ({ id: op.id, kind: op.kind })),
      canonical,
      priors,
      substrates: chain.outputs.flatMap((output) => output.substratesAvailable),
      previewPath: previewArtifactOf(canonical),
      duration: canonical ? takeDuration(canonical) : 0,
      lockState: chain.lockState,
    }
  }).filter((tile) => byId.has(tile.id))
}

// ---- derived edges ------------------------------------------------------------

export type Edge = { id: string; fromChain: string; toChain: string; fx: number; fy: number; tx: number; ty: number }

/** Fork records → edges (§3: read-only, direction rendered). The source is
 *  the OWNER chain of the referenced output; the target is the consuming
 *  chain's tile. Unresolvable refs (tombstoned source) yield no edge — the
 *  tile keeps its refOutputs so Phase 2+ can re-link visually. */
export function deriveEdges(document: CanvasDocument, tiles: ReadonlyArray<Tile>): Edge[] {
  const owner = outputOwnerIndex(document)
  const byId = new Map(tiles.map((tile) => [tile.id, tile]))
  const edges: Edge[] = []
  for (const tile of tiles) {
    for (const outputId of tile.refOutputs) {
      const sourceChain = owner.get(outputId)?.chain
      if (!sourceChain) continue
      const source = byId.get(sourceChain.id)
      if (!source || source.id === tile.id) continue
      edges.push({
        id: `${source.id}->${tile.id}`,
        fromChain: source.id,
        toChain: tile.id,
        fx: source.x + source.w,
        fy: source.y + source.h / 2,
        tx: tile.x,
        ty: tile.y + tile.h / 2,
      })
    }
  }
  return edges
}

/** Cubic bezier from the source's tail to the target's head — horizontal
 *  handles, so direction reads left→right even at tight angles. */
export function edgePath(edge: Pick<Edge, 'fx' | 'fy' | 'tx' | 'ty'>): string {
  const dx = Math.max(48, Math.abs(edge.tx - edge.fx) / 2)
  return `M ${edge.fx} ${edge.fy} C ${edge.fx + dx} ${edge.fy}, ${edge.tx - dx} ${edge.ty}, ${edge.tx} ${edge.ty}`
}

/** Edge bounding box for viewport culling. */
export function edgeRect(edge: Pick<Edge, 'fx' | 'fy' | 'tx' | 'ty'>): { x: number; y: number; w: number; h: number } {
  const x = Math.min(edge.fx, edge.tx)
  const y = Math.min(edge.fy, edge.ty)
  return { x, y, w: Math.abs(edge.tx - edge.fx), h: Math.abs(edge.ty - edge.fy) }
}

// ---- attention (radar) ---------------------------------------------------------

export type AttentionCounts = { running: number; queued: number; needsAttention: number }

export type AttentionItem = { tileId: string; weight: number; label: string }

/**
 * Radar aggregation (§4): running/queued from the job facts the canvas links,
 * needs-attention = undismissed failed jobs + stale chains. Worst-first
 * ordering: failed (2) > stale (1); among equals, oldest chain wins.
 */
export function attention(tiles: ReadonlyArray<Tile>): { counts: AttentionCounts; worst: AttentionItem | null } {
  let running = 0
  let queued = 0
  let needsAttention = 0
  let worst: AttentionItem | null = null
  for (const tile of tiles) {
    if (tile.status === 'running') running += 1
    if (tile.status === 'queued-gpu') queued += 1
    if (tile.status === 'failed' || tile.status === 'stale') {
      needsAttention += 1
      const weight = tile.status === 'failed' ? 2 : 1
      if (!worst || weight > worst.weight) worst = { tileId: tile.id, weight, label: tile.status === 'failed' ? 'failed generation' : 'stale chain' }
    }
  }
  return { counts: { running, queued, needsAttention }, worst }
}

/** Camera-restore helper: the union rect of all tiles (zoom-to-fit source). */
export function tilesBoundingRect(tiles: ReadonlyArray<Tile>): { x: number; y: number; w: number; h: number } | null {
  if (!tiles.length) return null
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const tile of tiles) {
    minX = Math.min(minX, tile.x)
    minY = Math.min(minY, tile.y)
    maxX = Math.max(maxX, tile.x + tile.w)
    maxY = Math.max(maxY, tile.y + tile.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** The world point where the launcher's seed tile spawns (spatial-queue
 *  contract c): centered under where the prompt bar sits on screen. */
export function seedSpawnPoint(camera: CameraState, width: number, height: number): { x: number; y: number } {
  const center = { x: width / 2, y: height * 0.42 }
  return { x: (center.x - camera.x) / camera.k - TILE_W / 2, y: (center.y - camera.y) / camera.k }
}

// ---- mock job (Phase 2 replaces this) -------------------------------------------

export const CANVAS_MOCK_JOB_PREFIX = 'canvas-mock:'

export type MockJob = { id: string; prompt: string; mediaType: 'video' | 'image' | 'audio' }

/** The seed tile's queued-state job (jobsStore shape subset). Generation is
 *  Phase 2 — Phase 1 parks the job honestly in the queue with status
 *  'queued' and marks it a canvas mock by id prefix + manifest, so the radar
 *  and the tile ring read real store state and nothing pretends to render. */
export function mockJobFor(spec: MockJob): JobFact & { status: 'queued'; mode: string; createdAt: number } {
  return { id: `${CANVAS_MOCK_JOB_PREFIX}${spec.id}`, status: 'queued', progress: 0, prompt: spec.prompt, mode: spec.mediaType === 'image' ? 'text' : 'text', createdAt: Date.now() }
}

export function isCanvasMockJob(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(CANVAS_MOCK_JOB_PREFIX)
}
