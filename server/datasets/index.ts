/**
 * Dataset manager — the orchestrator: bundles the store, curation passes,
 * the VLM client, the serialized bake queue, and the dashboard computation
 * into the API surface the LAN routes call (spec §1–§11). Nothing here
 * mutates a referenced source file — the source is sacred.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { createDatasetStore, type DatasetStore, type LayerRow, type SourceRow } from './store'
import {
  clipEmbedder,
  clusterBy,
  evaluateSlowMo,
  computeTier1,
  cosineSimilarity,
  perceptualEmbed,
  representativeFrameBytes,
  auditSlowMo,
  detectSceneCuts,
  TIER1_NEAR_DUP_MAX_DISTANCE,
  TIER2_CLUSTER_THRESHOLD,
  tier1Distance,
  type EmbedVector,
  type Tier1Signature,
} from './curation'
import { extractGrayPixels, type ToolOptions } from './probe'
import {
  createBakeQueue,
  evaluateGates,
  planBake,
  recordBakeJob,
  runBake,
  settleBakeJob,
  writeExport,
  type BakeOutcome,
  type ExportResult,
} from './bake'
import { captionView, discussClip, handCaptionGuard, type BatchGuard, type VlmSeam } from './vlm'
import {
  bucketBadge,
  geometryWall,
  trainerProjections,
  validateTrigger,
  VRAM_WALL_GB,
  VRAM_WARN_GB,
  type TrainerId,
} from './model'

export type DashboardItem = {
  layerId: string
  width: number
  height: number
  frames: number
  aspect: number
  class: string
  captioned: boolean
  stale: boolean
  bucket: ReturnType<typeof bucketBadge>
}

export type DatasetManagerOptions = {
  db: Database.Database
  /** App-owned roots (beside the studio db, like canvas-blobs). */
  mediaRoot: string
  trashRoot: string
  tools: ToolOptions
  /** rife-ncnn-vulkan binary when present on PATH (availability-gated). */
  rifePath?: string | null
  /** Security wave 2 (HIGH-1): by-reference sources must sit inside the
   *  studio home or one of these resolver roots (see the store's gate). */
  allowedSourceRoots?: () => string[]
  /** Security wave 2 (LOW-2): resolves whether a CONSENT for the CLIP
   *  embedder download is recorded. Absent/false = the perceptual fallback
   *  only — the network is never touched from a curation pass. */
  clipConsent?: () => boolean
  logEvent(event: { kind: string; [key: string]: unknown }): void
  logFailure(stage: string, error: unknown, detail?: Record<string, unknown>): void
}

export function createDatasetManager(options: DatasetManagerOptions) {
  const store: DatasetStore = createDatasetStore(options.db, {
    mediaRoot: options.mediaRoot,
    trashRoot: options.trashRoot,
    tools: options.tools,
    allowedSourceRoots: options.allowedSourceRoots,
    logEvent: options.logEvent,
  })
  const queue = createBakeQueue()
  const slowMoCache = new Map<string, { suspect: boolean; reasons: string[] }>()

  // ---- ingest orchestration (async decode probe never blocks import) -------
  // App-tour wave (d6iy68r, review M2): EVERY freshly-inserted source gets
  // its probe settled — runDecodeProbe is terminal-at-once for stills and
  // refused sources (both facts-complete without a decode) and async only
  // for floor-passing videos, which are the one real pending workload.
  async function ingestReference(path: string, provenance?: { originNote?: string; originDate?: string; aiGenerated?: boolean; consentNote?: string }) {
    const result = await store.ingestReference(path, provenance)
    if (!result.deduped) {
      void store.runDecodeProbe(result.source.id).catch((error: unknown) => options.logFailure('datasets/probe', error, { id: result.source.id }))
    }
    return result
  }

  async function ingestUpload(name: string, bytes: Buffer, provenance?: { originNote?: string; originDate?: string; aiGenerated?: boolean; consentNote?: string }) {
    const result = await store.ingestUpload(name, bytes, provenance)
    if (!result.deduped) {
      void store.runDecodeProbe(result.source.id).catch((error: unknown) => options.logFailure('datasets/probe', error, { id: result.source.id }))
    }
    return result
  }

  // Boot sweep (d6iy68r): heal sources stranded non-terminal by the pre-fix
  // orchestrator (images and refused sources ingested before this wave sat
  // 'pending'/'probing' forever, so the client's poll never ended on
  // existing homes). Re-queueing a floor-passing video is idempotent (the
  // decode simply re-runs); mid-probe rows from a crashed server recover too.
  for (const source of store.listSources()) {
    if (source.probeState === 'done' || source.probeState === 'failed') continue
    void store.runDecodeProbe(source.id).catch((error: unknown) => options.logFailure('datasets/probe-sweep', error, { id: source.id }))
  }

  /** Canvas bridge, direction 1 (§11): a completed take / canvas media file
   * becomes a referenced source — an explicit user action, the file stays
   * where the canvas put it (the MoviePlanner-seeding pattern). */
  const ingestFromCanvas = ingestReference

  // ---- curation passes (§6) ------------------------------------------------

  /** Tier-1 + tier-2 dedup pass over the current (non-trashed) layers.
   * Advisory-only: assignments are recorded (cluster_id, cluster_no) so the
   * gallery can group/number; NOTHING is deleted or refused by this pass. */
  async function runDedupPass(): Promise<{ tier1Clusters: number; tier2Clusters: number; embedBackend: string }> {
    const layers = store.listLayers()
    const members: Array<{ layerId: string; sourceId: string; signature?: Tier1Signature; embed?: EmbedVector }> = []
    for (const layer of layers) {
      const source = store.getSource(layer.sourceId)
      if (!source || source.floorVerdict === 'refuse') continue
      try {
        const duration = source.probe.durationSec ?? 1
        const inSec = (layer.trim?.inFrame ?? 0) / (source.probe.fps ?? 24)
        const outSec = (layer.trim?.outFrame ?? (source.decodedFrames ?? duration * (source.probe.fps ?? 24))) / (source.probe.fps ?? 24)
        members.push({
          layerId: layer.id,
          sourceId: layer.sourceId,
          signature: await computeTier1(source.absPath, options.tools, Math.max(0.2, outSec - inSec)),
        })
      } catch (error) {
        options.logFailure('datasets/tier1', error, { layerId: layer.id })
      }
    }
    const tier1 = clusterBy(members.filter((member) => member.signature), (a, b) => tier1Distance(a.signature!, b.signature!), TIER1_NEAR_DUP_MAX_DISTANCE)
    // Tier 2 — aspect-normalized embeddings at each layer's representative
    // frame; CLIP backend when a recorded consent allows its download, else
    // the perceptual fallback (LOW-2: no LAN-peer-triggered weight fetches).
    const clip = await clipEmbedder(options.clipConsent?.() ?? false)
    const embedBackend = clip ? 'clip' : 'perceptual'
    const embedMembers: Array<{ layerId: string; embed: EmbedVector }> = []
    for (const layer of layers) {
      const source = store.getSource(layer.sourceId)
      if (!source) continue
      try {
        if (clip) {
          const { bytes } = await representativeFrameBytes(source.absPath, options.tools, {
            durationSec: source.probe.durationSec ?? 1,
            trimInSec: (layer.trim?.inFrame ?? 0) / (source.probe.fps ?? 24),
            trimOutSec: (layer.trim?.outFrame ?? 0) / (source.probe.fps ?? 24) || null,
          })
          embedMembers.push({ layerId: layer.id, embed: await clip.embedImage(bytes) })
        } else {
          const atSec = Math.max(0, ((layer.trim?.inFrame ?? 0) + (layer.trim?.outFrame ?? 999) / 2) / (source.probe.fps ?? 24))
          const pixels = await extractGrayPixels(source.absPath, options.tools, Math.min(atSec, Math.max(0, (source.probe.durationSec ?? 1) - 0.05)), 32)
          embedMembers.push({ layerId: layer.id, embed: perceptualEmbed(pixels) })
        }
      } catch (error) {
        options.logFailure('datasets/tier2', error, { layerId: layer.id })
      }
    }
    const embedByLayer = new Map(embedMembers.map((member) => [member.layerId, member.embed]))
    persistEmbeds(embedByLayer, embedBackend)
    // clusterBy takes a DISTANCE (lower = closer); cosine similarity is
    // inverted: distance = 1 − cos, threshold = 1 − 0.94.
    const tier2 = clusterBy(embedMembers, (a, b) => 1 - cosineSimilarity(a.embed, b.embed), 1 - TIER2_CLUSTER_THRESHOLD)
    let tier1Clusters = 0
    let tier2Clusters = 0
    for (const [layerId, assignment] of tier1) {
      if (assignment.clusterId) {
        tier1Clusters += 1
        // Tier-1 members are near-dups of the SAME ratio content — same
        // cluster id family as tier 2 for gallery grouping.
        store.setLayerCluster(layerId, assignment.clusterId, assignment.clusterNo)
      }
    }
    for (const [layerId, assignment] of tier2) {
      if (assignment.clusterId) {
        tier2Clusters += 1
        store.setLayerCluster(layerId, assignment.clusterId, assignment.clusterNo)
      }
    }
    options.logEvent({ kind: 'datasets.dedup-pass', layers: layers.length, tier1Clusters, tier2Clusters, embedBackend })
    return { tier1Clusters, tier2Clusters, embedBackend }
  }

  function persistEmbeds(embedByLayer: Map<string, EmbedVector>, backend: string) {
    const statement = options.db.prepare(`INSERT INTO dataset_embeds (layer_id, backend, vector, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(layer_id) DO UPDATE SET backend = excluded.backend, vector = excluded.vector, updated_at = excluded.updated_at`)
    for (const [layerId, vector] of embedByLayer) {
      statement.run(layerId, backend, Buffer.from(new Float32Array(vector).buffer), Date.now())
    }
  }

  /** CLIP reference-triage (§6 N9): rank the library against a reference
   * image (any image bytes). Same index as tier-2; ranked results feed bulk
   * selection in the UI. */
  async function referenceTriage(referenceBytes: Buffer, limit = 50): Promise<{ backend: string; results: Array<{ layerId: string; score: number }> }> {
    const rows = options.db.prepare('SELECT layer_id, backend, vector FROM dataset_embeds').all() as Array<{ layer_id: string; backend: string; vector: Buffer }>
    if (!rows.length) return { backend: 'none', results: [] }
    const clip = await clipEmbedder(options.clipConsent?.() ?? false)
    let reference: EmbedVector | null = null
    if (clip) {
      try {
        reference = await clip.embedImage(referenceBytes)
      } catch { reference = null }
    }
    if (!reference) {
      // Perceptual ranking needs raw pixels — decode the reference through
      // ffmpeg into gray (the deterministic fallback path). The temp frame
      // is removed in finally (audit NOTE, wave 2: one leaked /tmp file per
      // call otherwise).
      const { writeFile: writeTemp, unlink: unlinkTemp } = await import('node:fs/promises')
      const { tmpdir } = await import('node:os')
      const temp = join(tmpdir(), `ds-ref-${randomUUID().slice(0, 8)}.jpg`)
      try {
        await writeTemp(temp, referenceBytes)
        const pixels = await extractGrayPixels(temp, options.tools, 0, 32)
        reference = perceptualEmbed(pixels)
      } finally {
        await unlinkTemp(temp).catch(() => undefined)
      }
    }
    const ranked = rows
      .map((row) => ({ layerId: row.layer_id, score: cosineSimilarity(reference!, new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.length / 4)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(200, limit)))
    return { backend: rows[0]?.backend ?? 'perceptual', results: ranked }
  }

  /** find-similar-to-this-layer (the same index, layer-seeded). */
  function findSimilar(layerId: string, limit = 20): Array<{ layerId: string; score: number }> {
    const row = options.db.prepare('SELECT vector FROM dataset_embeds WHERE layer_id = ?').get(layerId) as { vector: Buffer } | undefined
    if (!row) return []
    const source = new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.length / 4)
    const rows = options.db.prepare('SELECT layer_id, vector FROM dataset_embeds WHERE layer_id != ?').all(layerId) as Array<{ layer_id: string; vector: Buffer }>
    return rows
      .map((entry) => ({ layerId: entry.layer_id, score: cosineSimilarity(source, new Float32Array(entry.vector.buffer, entry.vector.byteOffset, entry.vector.length / 4)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  /** Slow-mo audit (§6): composed signals, cached per source; suspects get
   * dispositions via store.setLayerSlowmo (retime / caption / exclude). */
  async function auditSourceSlowMo(sourceId: string): Promise<{ suspect: boolean; reasons: string[] }> {
    const cached = slowMoCache.get(sourceId)
    if (cached) return cached
    const source = store.getSource(sourceId)
    if (!source) throw new Error(`No source ${sourceId}.`)
    const audit = await auditSlowMo(source.absPath, options.tools, source.probe.durationSec ?? 1)
    const withFps = { ...audit, reasons: [...audit.reasons] }
    if (source.probe.fps !== null) {
      const fpsVerdict = evaluateSlowMo({ fps: source.probe.fps, frameDiffMean: audit.frameDiffMean, frameDiffStd: audit.frameDiffStd, dupFrameRatio: audit.dupFrameRatio, freezeDetected: audit.freezeDetected })
      withFps.suspect = withFps.suspect || fpsVerdict.suspect
      withFps.reasons = [...fpsVerdict.reasons, ...withFps.reasons]
    }
    const result = { suspect: withFps.suspect, reasons: withFps.reasons }
    slowMoCache.set(sourceId, result)
    return result
  }

  /** Scene-split (§6 N5): user-invoked; proposals recorded, then the user
   * accepts/edits; accepted cuts split into child layers via splitAtCuts. */
  async function proposeSceneSplits(sourceId: string): Promise<Array<{ frameNo: number; atSec: number }>> {
    const source = store.getSource(sourceId)
    if (!source) throw new Error(`No source ${sourceId}.`)
    if (!source.probe.durationSec || !source.probe.fps) throw new Error('Scene detection needs a video with duration and fps facts.')
    const proposals = await detectSceneCuts(source.absPath, options.tools, { durationSec: source.probe.durationSec, fps: source.probe.fps, totalFrames: source.decodedFrames })
    store.proposeCuts(sourceId, proposals.map((proposal) => proposal.frameNo), proposals.map(() => false))
    return proposals
  }

  /** Creates scene-split CHILD layers from the accepted cut list (children
   * attach visibly to the master; re-runs create NEW children). */
  function splitAtCuts(sourceId: string): LayerRow[] {
    const source = store.getSource(sourceId)
    if (!source) throw new Error(`No source ${sourceId}.`)
    const cuts = store.cutsFor(sourceId).filter((cut) => cut.accepted).map((cut) => cut.frameNo).sort((a, b) => a - b)
    if (!cuts.length) throw new Error('No accepted cuts — accept at least one proposed cut first.')
    const bounds = store.effectiveFrameBounds(source)
    const edges = [0, ...cuts, bounds.total]
    const children: LayerRow[] = []
    for (let index = 0; index < edges.length - 1; index += 1) {
      children.push(store.createLayer({
        sourceId,
        name: `scene ${index + 1}`,
        trim: { inFrame: edges[index], outFrame: edges[index + 1] },
        origin: 'scene-split',
        sceneSplitOf: sourceId,
      }))
    }
    return children
  }

  // ---- VLM orchestration (§4; the four automation modes) ---------------------

  function vlmConfig(layer: LayerRow, source: SourceRow) {
    const fps = source.probe.fps ?? 24
    return {
      sourcePath: source.absPath,
      durationSec: ((layer.trim?.outFrame ?? source.decodedFrames ?? (source.probe.durationSec ?? 1) * fps) - (layer.trim?.inFrame ?? 0)) / fps,
      trimInSec: (layer.trim?.inFrame ?? 0) / fps,
      trimOutSec: (layer.trim?.outFrame ?? 0) / fps || null,
      contentClass: layer.contentClass ?? store.getSettings().contentClass,
      triggerToken: store.getSettings().triggerToken,
    }
  }

  /** Mode (c): per-clip caption/recaption — one layer, dense→condense. */
  async function captionLayer(seam: VlmSeam, layerId: string, instruction?: string): Promise<{ layerId: string; caption: string; model: string }> {
    const layer = store.getLayer(layerId)
    if (!layer) throw new Error(`No layer ${layerId}.`)
    const source = store.getSource(layer.sourceId)
    if (!source) throw new Error('The layer\'s source is gone.')
    const result = await captionView(seam, options.tools, { ...vlmConfig(layer, source), instruction })
    store.setCaption(layerId, result.caption, 'vlm', result.model)
    return { layerId, caption: result.caption, model: result.model }
  }

  /** Modes (a)+(b): headless batch with instruction templates. The
   * batch-never-overwrite-hand rule is enforced here (N2). */
  async function captionBatch(seam: VlmSeam, layerIds: string[], run: { instruction?: string; guard: BatchGuard }): Promise<{ captioned: string[]; skipped: string[]; queuedForReview: string[]; errors: Array<{ layerId: string; error: string }> }> {
    const items = layerIds.map((layerId) => {
      const layer = store.getLayer(layerId)
      return layer ? { layerId, author: layer.caption?.author ?? 'none' } : null
    }).filter(Boolean) as Array<{ layerId: string; author: string }>
    const guardResult = handCaptionGuard(items, run.guard)
    const captioned: string[] = []
    const queuedForReview: string[] = []
    const errors: Array<{ layerId: string; error: string }> = []
    for (const item of guardResult.caption) {
      try {
        await captionLayer(seam, item.layerId, run.instruction)
        captioned.push(item.layerId)
      } catch (error) {
        errors.push({ layerId: item.layerId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    for (const item of guardResult.queued) {
      // Draft-review mode: the VLM caption lands as a draft marked queued —
      // a human approves it before it exports (review_state).
      try {
        const result = await captionLayer(seam, item.layerId, run.instruction)
        store.setCaptionReview(item.layerId, 'queued')
        queuedForReview.push(item.layerId)
        void result
      } catch (error) {
        errors.push({ layerId: item.layerId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { captioned, skipped: guardResult.skipped.map((item) => item.layerId), queuedForReview, errors }
  }

  /** Mode (d): free-form discussion — no caption write. */
  const discuss = (seam: VlmSeam, layerId: string, message: string, history?: Array<{ role: 'user' | 'assistant'; content: string }>) => {
    const layer = store.getLayer(layerId)
    if (!layer) throw new Error(`No layer ${layerId}.`)
    const source = store.getSource(layer.sourceId)
    if (!source) throw new Error('The layer\'s source is gone.')
    return discussClip(seam, options.tools, { sourcePath: source.absPath, durationSec: vlmConfig(layer, source).durationSec, message, history })
  }

  // ---- dashboard (§7) ---------------------------------------------------------

  function dashboard() {
    const settings = store.getSettings()
    const layers = store.listLayers()
    const items: DashboardItem[] = []
    for (const layer of layers) {
      const source = store.getSource(layer.sourceId)
      if (!source) continue
      const width = layer.crop?.w ?? source.probe.width
      const height = layer.crop?.h ?? source.probe.height
      const fps = source.probe.fps ?? 24
      const frames = source.kind === 'image' ? 1 : (layer.trim?.outFrame ?? source.decodedFrames ?? Math.round((source.probe.durationSec ?? 1) * fps)) - (layer.trim?.inFrame ?? 0)
      items.push({
        layerId: layer.id,
        width,
        height,
        frames,
        aspect: width / Math.max(1, height),
        class: layer.contentClass ?? settings.contentClass,
        captioned: Boolean(layer.caption?.text?.trim()),
        stale: Boolean(layer.caption?.stale),
        bucket: bucketBadge(width, height, frames),
      })
    }
    // Distributions (shape heuristics — outliers, holes, over-concentration;
    // no canonical target is pretended).
    const aspectBuckets = new Map<string, number>()
    const durationBuckets = new Map<string, number>()
    const resolutionBuckets = new Map<string, number>()
    const classBuckets = new Map<string, number>()
    let captioned = 0
    let stale = 0
    for (const item of items) {
      const aspect = nearestAspect(item.aspect)
      aspectBuckets.set(aspect, (aspectBuckets.get(aspect) ?? 0) + 1)
      const duration = item.frames <= 1 ? 'still' : item.frames <= 45 ? '≤39f' : item.frames <= 91 ? '56–90f' : item.frames <= 125 ? '107–124f' : '>124f'
      durationBuckets.set(duration, (durationBuckets.get(duration) ?? 0) + 1)
      const resolution = `${Math.round(item.width / 32) * 32}×${Math.round(item.height / 32) * 32}`
      resolutionBuckets.set(resolution, (resolutionBuckets.get(resolution) ?? 0) + 1)
      classBuckets.set(item.class, (classBuckets.get(item.class) ?? 0) + 1)
      if (item.captioned) captioned += 1
      if (item.stale) stale += 1
    }
    // Per-trainer preflight: worst-case item binds the dataset (peak VRAM =
    // MAX of buckets — envelope §1.5); BOTH trainer profiles computed.
    let binding: { diffsynx: number; musubi: number } | null = null
    let worstItem: DashboardItem | null = null
    for (const item of items) {
      if (item.frames <= 1) continue
      const projections = trainerProjections(item.width * item.height, item.frames)
      if (!binding || projections.musubi.projectedGb > binding.musubi) {
        binding = { diffsynx: projections.diffsynx.projectedGb, musubi: projections.musubi.projectedGb }
        worstItem = item
      }
    }
    const preflight = binding && worstItem
      ? {
          worstLayerId: worstItem.layerId,
          item: `${worstItem.width}×${worstItem.height}×${worstItem.frames}f`,
          diffsynxGb: binding.diffsynx,
          musubiGb: binding.musubi,
          binds: (binding.diffsynx >= binding.musubi ? 'diffsynx' : 'musubi') as TrainerId,
          wall: VRAM_WALL_GB,
          warn: VRAM_WARN_GB,
          verdict: binding.musubi > VRAM_WALL_GB ? 'over-wall' : binding.musubi > VRAM_WARN_GB ? 'near-wall' : 'fits',
          geometry: geometryWall(worstItem.width * worstItem.height, worstItem.frames),
        }
      : null
    return {
      items: items.length,
      distributions: {
        aspect: sortedEntries(aspectBuckets),
        duration: sortedEntries(durationBuckets),
        resolution: sortedEntries(resolutionBuckets),
        contentClass: sortedEntries(classBuckets),
        captionCoverage: { captioned, total: items.length, stale },
      },
      guidance: guidanceHeuristics(items, aspectBuckets, captioned),
      preflight,
    }
  }

  function nearestAspect(ratio: number): string {
    const presets: Array<[string, number]> = [['21:9', 21 / 9], ['16:9', 16 / 9], ['4:3', 4 / 3], ['1:1', 1], ['3:4', 3 / 4], ['9:16', 9 / 16]]
    let best = presets[0]
    for (const preset of presets) {
      if (Math.abs(Math.log(ratio / preset[1])) < Math.abs(Math.log(ratio / best[1]))) best = preset
    }
    return best[0]
  }

  function sortedEntries(map: Map<string, number>): Array<{ key: string; count: number }> {
    return Array.from(map.entries()).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count)
  }

  /** Shape-based guidance (§7): outliers, holes, over-concentration. Honest
   * by design — it never pretends to know the right mix. */
  function guidanceHeuristics(items: DashboardItem[], aspectBuckets: Map<string, number>, captioned: number): string[] {
    const guidance: string[] = []
    if (!items.length) return ['The dataset is empty — import sources and crop layers first.']
    const total = items.length
    for (const [aspect, count] of aspectBuckets) {
      const share = count / total
      if (share > 0.7 && aspectBuckets.size > 1) guidance.push(`Over-concentration: ${Math.round(share * 100)} % of items are ${aspect} — one aspect dominates; cross-ratio coverage is what mixed-bucket training gets for free.`)
    }
    if (aspectBuckets.size === 1) guidance.push('Only one aspect ratio is present — cross-ratio variants of your best content are measured-free bucket diversity.')
    const uncaptioned = total - captioned
    if (uncaptioned > 0) guidance.push(`${uncaptioned} item(s) have no caption — uncaptioned items train against an empty prompt and weaken the whole run (gate 1 refuses them at export).`)
    const withStale = items.filter((item) => item.stale).length
    if (withStale) guidance.push(`${withStale} caption(s) are stale (the view changed after captioning) — the recaption queue owns them.`)
    const wallStops = items.filter((item) => item.bucket.wall === 'stop').length
    if (wallStops) guidance.push(`${wallStops} item(s) sit beyond a measured geometry wall — they cannot train on 24 GB regardless of budget (see the preflight).`)
    if (!guidance.length) guidance.push('No shape outliers detected; optional user-set targets remain the arbiter of the right mix.')
    return guidance
  }

  // ---- bake + export (§5/§8/§9) ------------------------------------------------

  /** Bakes ONE layer through the serialized queue (the arbiter). Returns the
   * outcome; a MISSING source refuses before any tool runs. */
  function bakeLayer(layerId: string, config: { outputFolder: string; gridTarget?: number | null; jobId?: string; acceptChanged?: boolean }): Promise<BakeOutcome> {
    const layer = store.getLayer(layerId)
    if (!layer) return Promise.reject(new Error(`No layer ${layerId}.`))
    const source = store.getSource(layer.sourceId)
    if (!source) return Promise.reject(new Error('The layer\'s source is gone.'))
    if (source.health === 'missing') return Promise.reject(new Error(`Source is MISSING — bake refuses: ${source.healthDetail ?? 'the file is gone'}. Re-link by content hash first.`))
    if (source.health === 'changed' && !config.acceptChanged) {
      return Promise.reject(new Error('Source is CHANGED (same path, different content) — crop/trim indices may no longer align. Pass acceptChanged: true to bake anyway (explicit accept, spec §2.1).'))
    }
    if (source.kind === 'video' && source.probeState !== 'done') {
      return Promise.reject(new Error(`The decoded frame count is still ${source.probeState} — it is required before this source's first bake (the f56 antidote). Wait for the probe or re-run it.`))
    }
    const plan = planBake(layer, source, config.gridTarget ?? null)
    const jobId = config.jobId ?? randomUUID()
    recordBakeJob(options.db, { id: jobId, layerId, gridTarget: plan.gridTarget, encodeFrames: plan.encodeFrames, fpsMode: plan.fpsMode })
    const startedAt = Date.now()
    return queue.enqueue(async () => {
      const outcome = await runBake(layer, source, plan, {
        ffmpegPath: options.tools.ffmpegPath,
        rifePath: options.rifePath ?? null,
        outputFolder: config.outputFolder,
        audioPolicy: store.getSettings().audioPolicy,
        isCancelled: () => queue.isCancelled(jobId),
        logFailure: options.logFailure,
      })
      settleBakeJob(options.db, outcome, jobId, startedAt)
      if (outcome.state === 'done') store.markLayerInterpolated(layerId, outcome.interpolated)
      queue.clearCancelled(jobId)
      return outcome
    })
  }

  /** Full export flow: gates → bake each layer → write the shape → record the
   * immutable snapshot. Refusing items never bake; warning-tier needs the
   * explicit accept. */
  async function exportDataset(request: {
    shape: 'musubi' | 'diffsynx' | 'external'
    trainer: TrainerId
    folder: string
    layerIds: string[]
    gridTarget?: number | null
    acceptWarnings?: boolean
  }): Promise<ExportResult> {
    const settings = store.getSettings()
    const layers = request.layerIds.map((id) => store.getLayer(id)).filter(Boolean) as LayerRow[]
    if (!layers.length) throw new Error('No layers selected for export.')
    // Pre-gate (before any bake): caption/format gates don't need baked facts.
    const preGated = layers.map((layer) => {
      const source = store.getSource(layer.sourceId)!
      const slowMo = slowMoCache.get(layer.sourceId)
      const findings = evaluateGates({
        layer,
        caption: layer.caption?.text ?? '',
        triggerToken: settings.triggerToken,
        slowMoSuspect: Boolean(slowMo?.suspect),
        inCluster: Boolean(layer.clusterId),
        sourceCuts: store.cutsFor(layer.sourceId).filter((cut) => cut.accepted).map((cut) => cut.frameNo),
        audioPolicy: settings.audioPolicy,
        sourceHasAudio: source.probe.hasAudio,
        bakedFpsExact: true,
      })
      return { layer, findings }
    })
    const refusing = preGated.filter((entry) => entry.findings.some((finding) => finding.tier === 'refuse'))
    if (refusing.length === layers.length) {
      throw new Error(`All ${refusing.length} selected item(s) refuse at the gates — nothing baked. First refusal: ${refusing[0].findings.find((f) => f.tier === 'refuse')?.reason}`)
    }
    const bakeFolder = join(options.mediaRoot, 'bake-scratch', randomUUID().slice(0, 8))
    await mkdir(bakeFolder, { recursive: true })
    try {
      const baked: BakeOutcome[] = []
      for (const entry of preGated) {
        if (entry.findings.some((finding) => finding.tier === 'refuse')) continue
        if (entry.findings.some((finding) => finding.tier === 'warn') && !request.acceptWarnings) continue
        baked.push(await bakeLayer(entry.layer.id, { outputFolder: bakeFolder, gridTarget: request.gridTarget ?? null }))
      }
      // Post-gate with baked facts, then write the export.
      const exportItems = preGated
        .filter((entry) => baked.some((outcome) => outcome.layerId === entry.layer.id))
        .map((entry) => {
          const outcome = baked.find((candidate) => candidate.layerId === entry.layer.id)!
          const source = store.getSource(entry.layer.sourceId)!
          const slowMo = slowMoCache.get(entry.layer.sourceId)
          const findings = evaluateGates({
            layer: entry.layer,
            caption: entry.layer.caption?.text ?? '',
            triggerToken: settings.triggerToken,
            baked: outcome,
            slowMoSuspect: Boolean(slowMo?.suspect),
            inCluster: Boolean(entry.layer.clusterId),
            sourceCuts: store.cutsFor(entry.layer.sourceId).filter((cut) => cut.accepted).map((cut) => cut.frameNo),
            audioPolicy: settings.audioPolicy,
            sourceHasAudio: source.probe.hasAudio,
            bakedFpsExact: outcome.state === 'done',
          })
          return { layer: entry.layer, caption: entry.layer.caption?.text ?? '', baked: outcome, findings }
        })
      const result = await writeExport({
        shape: request.shape,
        trainer: request.trainer,
        folder: request.folder,
        triggerToken: settings.triggerToken,
        contentClass: settings.contentClass,
        items: exportItems,
        audioPolicy: settings.audioPolicy,
        acceptWarnings: Boolean(request.acceptWarnings),
      }, store, options.tools)
      options.db.prepare(`INSERT INTO dataset_exports (id, shape, folder, trigger_token, content_class, recipe_json, gate_report_json, items_json, item_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(result.exportId, request.shape, request.folder, settings.triggerToken, settings.contentClass, JSON.stringify(result.recipe), JSON.stringify(result.gateReport), JSON.stringify(result.refused), result.written.length, Date.now())
      return result
    } finally {
      // Security wave 2 (LOW-1): bake-scratch is per-export intermediate
      // space — sweep it on completion AND failure so every export leaves
      // the media store as it found it (previously each export permanently
      // abandoned its full intermediate set inside dataset-media).
      await import('node:fs/promises').then((fs) => fs.rm(bakeFolder, { recursive: true, force: true })).catch((error: unknown) => options.logFailure('datasets/bake-scratch-cleanup', error, { folder: bakeFolder }))
    }
  }

  function listExports() {
    return (options.db.prepare('SELECT * FROM dataset_exports ORDER BY created_at DESC').all() as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      shape: String(row.shape),
      folder: String(row.folder),
      triggerToken: String(row.trigger_token ?? ''),
      contentClass: String(row.content_class),
      itemCount: Number(row.item_count),
      createdAt: Number(row.created_at),
    }))
  }

  // ---- library view (§2.3) -------------------------------------------------------

  /** The gallery payload: masters with their children, probe/audit state,
   * cluster groupings — one round trip for the whole workbench. */
  function library() {
    const sources = store.listSources()
    const layers = store.listLayers()
    const bySource = new Map<string, LayerRow[]>()
    for (const layer of layers) {
      const list = bySource.get(layer.sourceId) ?? []
      list.push(layer)
      bySource.set(layer.sourceId, list)
    }
    return {
      sources: sources.map((source) => ({
        id: source.id,
        kind: source.kind,
        name: source.absPath.split('/').pop() ?? source.absPath,
        ingestPath: source.ingestPath,
        probe: source.probe,
        decodedFrames: source.decodedFrames,
        probeState: source.probeState,
        health: source.health,
        healthDetail: source.healthDetail,
        floor: { verdict: source.floorVerdict, reason: source.floorReason },
        provenance: { originNote: source.originNote, originDate: source.originDate, aiGenerated: source.aiGenerated, consentNote: source.consentNote },
        createdAt: source.createdAt,
        layers: (bySource.get(source.id) ?? []).map((layer) => ({
          id: layer.id,
          name: layer.name,
          crop: layer.crop,
          trim: layer.trim,
          origin: layer.origin,
          contentClass: layer.contentClass,
          slowmoDisposition: layer.slowmoDisposition,
          interpolated: layer.interpolated,
          clusterId: layer.clusterId,
          clusterNo: layer.clusterNo,
          caption: layer.caption ? { text: layer.caption.text, author: layer.caption.author, stale: layer.caption.stale, reviewState: layer.caption.reviewState } : null,
          bucket: bucketBadge(layer.crop?.w ?? source.probe.width, layer.crop?.h ?? source.probe.height, source.kind === 'image' ? 1 : (layer.trim?.outFrame ?? source.decodedFrames ?? 0) - (layer.trim?.inFrame ?? 0)),
          media: `/api/lan/datasets/media?source=${source.id}`,
        })),
      })),
      trashed: {
        sources: store.listTrashedSources().map((source) => ({ id: source.id, name: source.absPath.split('/').pop() ?? source.absPath, ingestPath: source.ingestPath, layers: (store.layersFor(source.id)).length })),
      },
    }
  }

  return {
    store,
    ingestReference,
    ingestUpload,
    ingestFromCanvas,
    runDedupPass,
    referenceTriage,
    findSimilar,
    auditSourceSlowMo,
    proposeSceneSplits,
    splitAtCuts,
    captionLayer,
    captionBatch,
    discuss,
    dashboard,
    bakeLayer,
    exportDataset,
    listExports,
    library,
    validateTriggerFor: (caption: string) => validateTrigger(store.getSettings().triggerToken, caption),
    queue: { cancel: queue.cancel },
  }
}

export type DatasetManager = ReturnType<typeof createDatasetManager>
