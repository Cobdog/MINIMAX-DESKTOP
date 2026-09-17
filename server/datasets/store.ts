/**
 * Dataset manager store (spec §1/§2): sources (by-reference and LAN-upload),
 * layers, captions with authorship + append-only history, the managed aspect
 * spectrum, soft-delete trash with per-path semantics, FTS over
 * captions/provenance, and the health check (MISSING/CHANGED by hash).
 *
 * The source is sacred: nothing in this module writes to a referenced file,
 * ever. Upload-path bytes live under the app-owned media root; trashing an
 * uploaded source MOVES its bytes into the trash store (restorable) — the one
 * real delete in the tool (empty-trash) only ever touches app-owned storage.
 */
import { mkdir, copyFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import {
  DEFAULT_AUDIO_POLICY,
  OFFICIAL_ASPECTS,
  alignCropRect,
  floorVerdict,
  type AspectEntry,
  type AudioPolicy,
  type ContentClass,
  type CropRect,
} from './model'
import { probeMedia, decodedFrameCount, type ProbeFacts, type ToolOptions } from './probe'

export const DATASET_SCHEMA_VERSION = 1

// ---------------------------------------------------------------------------
// Migration 003 (append-only; applied by db.ts)
// ---------------------------------------------------------------------------

export function upDatasetTables(db: Database.Database): void {
  db.exec(`
    -- Sources: an imported file. Identity is the CONTENT HASH for both ingest
    -- paths (re-import / re-upload of the same content resolves to the same
    -- source). ingest_path A ('reference') points at user-owned bytes that are
    -- NEVER touched; path B ('upload') owns its bytes inside mediaRoot.
    CREATE TABLE dataset_sources (
      id TEXT PRIMARY KEY,
      ingest_path TEXT NOT NULL CHECK (ingest_path IN ('reference', 'upload')),
      abs_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('video', 'image')),
      probe_json TEXT NOT NULL DEFAULT '{}',
      decoded_frames INTEGER,
      probe_state TEXT NOT NULL DEFAULT 'pending' CHECK (probe_state IN ('pending', 'probing', 'done', 'failed')),
      probe_error TEXT,
      origin_note TEXT NOT NULL DEFAULT '',
      origin_date TEXT,
      ai_generated INTEGER NOT NULL DEFAULT 0,
      consent_note TEXT NOT NULL DEFAULT '',
      health TEXT NOT NULL DEFAULT 'healthy' CHECK (health IN ('healthy', 'missing', 'changed')),
      health_detail TEXT,
      floor_verdict TEXT NOT NULL DEFAULT 'ok',
      floor_reason TEXT,
      trashed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX dataset_sources_hash ON dataset_sources(content_hash);

    -- Layers: derived views (crop and/or trim) — every export item IS a layer.
    CREATE TABLE dataset_layers (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES dataset_sources(id),
      name TEXT NOT NULL DEFAULT '',
      crop_x INTEGER, crop_y INTEGER, crop_w INTEGER, crop_h INTEGER,
      trim_in_frame INTEGER, trim_out_frame INTEGER,
      origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'scene-split', 'canvas-bridge')),
      content_class TEXT CHECK (content_class IN ('style', 'character', 'motion')),
      slowmo_disposition TEXT CHECK (slowmo_disposition IN ('retime', 'caption', 'exclude')),
      interpolated INTEGER NOT NULL DEFAULT 0,
      cluster_id TEXT,
      cluster_no INTEGER,
      scene_split_of TEXT,
      trashed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX dataset_layers_source ON dataset_layers(source_id);
    CREATE INDEX dataset_layers_cluster ON dataset_layers(cluster_id);

    -- Captions attach to LAYERS, never sources (§4).
    CREATE TABLE dataset_captions (
      layer_id TEXT PRIMARY KEY REFERENCES dataset_layers(id),
      text TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT 'hand',
      author_model TEXT,
      stale INTEGER NOT NULL DEFAULT 0,
      stale_reason TEXT,
      review_state TEXT CHECK (review_state IN (null, 'queued', 'approved')),
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX dataset_captions_stale ON dataset_captions(stale);

    -- Append-only caption history (N2): every edit is recorded.
    CREATE TABLE dataset_caption_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      layer_id TEXT NOT NULL REFERENCES dataset_layers(id),
      text TEXT NOT NULL,
      author TEXT NOT NULL,
      author_model TEXT,
      recorded_at INTEGER NOT NULL
    );
    CREATE INDEX dataset_caption_history_layer ON dataset_caption_history(layer_id);

    -- The managed aspect spectrum: officials always present, undeletable.
    CREATE TABLE dataset_aspects (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      ratio REAL NOT NULL,
      official INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      position INTEGER NOT NULL
    );

    -- Scene-split proposals (N5): user-invoked, cut points editable until
    -- children exist; accepted splits become child layers.
    CREATE TABLE dataset_scene_cuts (
      source_id TEXT NOT NULL REFERENCES dataset_sources(id),
      frame_no INTEGER NOT NULL,
      accepted INTEGER NOT NULL DEFAULT 0,
      suggested INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (source_id, frame_no)
    );

    -- Tier-2 embeddings (the reference-triage / find-similar index). Backend
    -- recorded per row: 'clip' when transformers.js is available, else the
    -- deterministic perceptual fallback (also the test backend).
    CREATE TABLE dataset_embeds (
      layer_id TEXT PRIMARY KEY REFERENCES dataset_layers(id),
      backend TEXT NOT NULL,
      vector BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Bake jobs (§9 operational contracts): the serialized queue's ledger.
    CREATE TABLE dataset_bake_jobs (
      id TEXT PRIMARY KEY,
      export_id TEXT,
      layer_id TEXT NOT NULL REFERENCES dataset_layers(id),
      state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'done', 'failed', 'cancelled')),
      target_frames INTEGER NOT NULL,
      grid_target INTEGER NOT NULL,
      decoded_frames INTEGER,
      interpolated INTEGER NOT NULL DEFAULT 0,
      fps_plan TEXT,
      error TEXT,
      started_at INTEGER,
      finished_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX dataset_bake_jobs_state ON dataset_bake_jobs(state);

    -- Export snapshots (immutable records: recipe card + gate report).
    CREATE TABLE dataset_exports (
      id TEXT PRIMARY KEY,
      shape TEXT NOT NULL CHECK (shape IN ('musubi', 'diffsynx', 'external')),
      folder TEXT NOT NULL,
      trigger_token TEXT NOT NULL DEFAULT '',
      content_class TEXT NOT NULL DEFAULT 'style',
      recipe_json TEXT,
      gate_report_json TEXT,
      items_json TEXT,
      item_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    -- Dataset-level settings (single row, id=1).
    CREATE TABLE dataset_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      trigger_token TEXT NOT NULL DEFAULT '',
      content_class TEXT NOT NULL DEFAULT 'style',
      audio_policy_json TEXT NOT NULL DEFAULT '${JSON.stringify(DEFAULT_AUDIO_POLICY)}',
      updated_at INTEGER NOT NULL
    );
    INSERT INTO dataset_settings (id, updated_at) VALUES (1, 0);

    -- FTS over captions + provenance (contentless; managed explicitly).
    CREATE VIRTUAL TABLE dataset_fts USING fts5(
      text,
      source_id UNINDEXED,
      layer_id UNINDEXED,
      kind UNINDEXED,
      content='',
      contentless_delete=1
    );
  `)
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export type SourceRow = {
  id: string
  ingestPath: 'reference' | 'upload'
  absPath: string
  contentHash: string
  sizeBytes: number
  mtimeMs: number
  kind: 'video' | 'image'
  probe: ProbeFacts
  decodedFrames: number | null
  probeState: 'pending' | 'probing' | 'done' | 'failed'
  probeError: string | null
  originNote: string
  originDate: string | null
  aiGenerated: boolean
  consentNote: string
  health: 'healthy' | 'missing' | 'changed'
  healthDetail: string | null
  floorVerdict: 'ok' | 'warn' | 'refuse'
  floorReason: string | null
  trashedAt: number | null
  createdAt: number
  updatedAt: number
}

export type LayerRow = {
  id: string
  sourceId: string
  name: string
  crop: CropRect | null
  trim: { inFrame: number | null; outFrame: number | null }
  origin: 'manual' | 'scene-split' | 'canvas-bridge'
  contentClass: ContentClass | null
  slowmoDisposition: 'retime' | 'caption' | 'exclude' | null
  interpolated: boolean
  clusterId: string | null
  clusterNo: number | null
  sceneSplitOf: string | null
  trashedAt: number | null
  createdAt: number
  updatedAt: number
  // hydrated joins
  caption: { text: string; author: string; authorModel: string | null; stale: boolean; staleReason: string | null; reviewState: string | null } | null
  source: { id: string; kind: 'video' | 'image'; width: number; height: number; fps: number | null; decodedFrames: number | null; health: string; absPath: string; contentHash: string }
}

export type DatasetSettings = {
  triggerToken: string
  contentClass: ContentClass
  audioPolicy: AudioPolicy
}

export type ProvenanceInput = { originNote?: string; originDate?: string | null; aiGenerated?: boolean; consentNote?: string }

export type IngestResult = { source: SourceRow; deduped: boolean; refusal?: { verdict: 'refuse' | 'warn'; reason: string } }

export type LayerInput = {
  sourceId: string
  name?: string
  crop?: CropRect | null
  trim?: { inFrame: number | null; outFrame: number | null } | null
  origin?: 'manual' | 'scene-split' | 'canvas-bridge'
  contentClass?: ContentClass | null
  sceneSplitOf?: string | null
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type DatasetStoreOptions = {
  /** App-owned storage: uploaded bytes live under mediaRoot, trash under trashRoot. */
  mediaRoot: string
  trashRoot: string
  tools: ToolOptions
  logEvent(event: { kind: string; [key: string]: unknown }): void
}

export function createDatasetStore(db: Database.Database, options: DatasetStoreOptions) {
  const now = () => Date.now()

  // -- statements (prepared once) -------------------------------------------
  const st = {
    insertSource: db.prepare(`INSERT INTO dataset_sources (id, ingest_path, abs_path, content_hash, size_bytes, mtime_ms, kind, probe_json, floor_verdict, floor_reason, origin_note, created_at, updated_at)
      VALUES (@id, @ingest_path, @abs_path, @content_hash, @size_bytes, @mtime_ms, @kind, @probe_json, @floor_verdict, @floor_reason, @origin_note, @created_at, @updated_at)`),
    sourceByHash: db.prepare('SELECT * FROM dataset_sources WHERE content_hash = ?'),
    sourceById: db.prepare('SELECT * FROM dataset_sources WHERE id = ?'),
    listSources: db.prepare('SELECT * FROM dataset_sources WHERE trashed_at IS NULL ORDER BY created_at DESC, rowid ASC'),
    listTrashedSources: db.prepare('SELECT * FROM dataset_sources WHERE trashed_at IS NOT NULL ORDER BY trashed_at DESC'),
    updateSourceProbe: db.prepare('UPDATE dataset_sources SET probe_json = ?, decoded_frames = ?, probe_state = ?, probe_error = ?, updated_at = ? WHERE id = ?'),
    updateSourceProvenance: db.prepare('UPDATE dataset_sources SET origin_note = ?, origin_date = ?, ai_generated = ?, consent_note = ?, updated_at = ? WHERE id = ?'),
    updateSourceHealth: db.prepare('UPDATE dataset_sources SET health = ?, health_detail = ?, mtime_ms = ?, size_bytes = ?, updated_at = ? WHERE id = ?'),
    relinkSource: db.prepare('UPDATE dataset_sources SET abs_path = ?, mtime_ms = ?, size_bytes = ?, health = ?, health_detail = ?, updated_at = ? WHERE id = ?'),
    trashSource: db.prepare('UPDATE dataset_sources SET trashed_at = ?, updated_at = ? WHERE id = ?'),
    restoreSource: db.prepare('UPDATE dataset_sources SET trashed_at = NULL, updated_at = ? WHERE id = ?'),
    insertLayer: db.prepare(`INSERT INTO dataset_layers (id, source_id, name, crop_x, crop_y, crop_w, crop_h, trim_in_frame, trim_out_frame, origin, content_class, scene_split_of, created_at, updated_at)
      VALUES (@id, @source_id, @name, @crop_x, @crop_y, @crop_w, @crop_h, @trim_in_frame, @trim_out_frame, @origin, @content_class, @scene_split_of, @created_at, @updated_at)`),
    layerById: db.prepare('SELECT * FROM dataset_layers WHERE id = ?'),
    layersBySource: db.prepare('SELECT * FROM dataset_layers WHERE source_id = ? AND trashed_at IS NULL ORDER BY created_at ASC, rowid ASC'),
    listLayers: db.prepare('SELECT * FROM dataset_layers WHERE trashed_at IS NULL ORDER BY created_at ASC, rowid ASC'),
    listTrashedLayers: db.prepare('SELECT * FROM dataset_layers WHERE trashed_at IS NOT NULL ORDER BY trashed_at DESC'),
    updateLayerGeometry: db.prepare('UPDATE dataset_layers SET crop_x = ?, crop_y = ?, crop_w = ?, crop_h = ?, trim_in_frame = ?, trim_out_frame = ?, name = ?, content_class = ?, updated_at = ? WHERE id = ?'),
    setLayerClass: db.prepare('UPDATE dataset_layers SET content_class = ?, updated_at = ? WHERE id = ?'),
    setLayerSlowmo: db.prepare('UPDATE dataset_layers SET slowmo_disposition = ?, updated_at = ? WHERE id = ?'),
    setLayerCluster: db.prepare('UPDATE dataset_layers SET cluster_id = ?, cluster_no = ?, updated_at = ? WHERE id = ?'),
    markLayerInterpolated: db.prepare('UPDATE dataset_layers SET interpolated = ?, updated_at = ? WHERE id = ?'),
    trashLayer: db.prepare('UPDATE dataset_layers SET trashed_at = ?, updated_at = ? WHERE id = ?'),
    restoreLayer: db.prepare('UPDATE dataset_layers SET trashed_at = NULL, updated_at = ? WHERE id = ?'),
    upsertCaption: db.prepare(`INSERT INTO dataset_captions (layer_id, text, author, author_model, stale, stale_reason, review_state, updated_at)
      VALUES (@layer_id, @text, @author, @author_model, 0, NULL, NULL, @updated_at)
      ON CONFLICT(layer_id) DO UPDATE SET text = excluded.text, author = excluded.author, author_model = excluded.author_model, stale = 0, stale_reason = NULL, review_state = NULL, updated_at = excluded.updated_at`),
    captionByLayer: db.prepare('SELECT * FROM dataset_captions WHERE layer_id = ?'),
    flagCaptionStale: db.prepare('UPDATE dataset_captions SET stale = 1, stale_reason = ?, review_state = CASE WHEN review_state IS NULL THEN NULL ELSE review_state END, updated_at = ? WHERE layer_id = ?'),
    setCaptionReview: db.prepare('UPDATE dataset_captions SET review_state = ?, updated_at = ? WHERE layer_id = ?'),
    insertCaptionHistory: db.prepare('INSERT INTO dataset_caption_history (layer_id, text, author, author_model, recorded_at) VALUES (?, ?, ?, ?, ?)'),
    captionHistory: db.prepare('SELECT * FROM dataset_caption_history WHERE layer_id = ? ORDER BY id ASC'),
    settings: db.prepare('SELECT * FROM dataset_settings WHERE id = 1'),
    updateSettings: db.prepare('UPDATE dataset_settings SET trigger_token = ?, content_class = ?, audio_policy_json = ?, updated_at = ? WHERE id = 1'),
    ftsInsert: db.prepare('INSERT INTO dataset_fts (rowid, text, source_id, layer_id, kind) VALUES (?, ?, ?, ?, ?)'),
    ftsDelete: db.prepare('DELETE FROM dataset_fts WHERE rowid = ?'),
    ftsSearch: db.prepare(`SELECT dataset_fts.rowid AS fts_rowid, source_id, layer_id, kind FROM dataset_fts WHERE dataset_fts MATCH ? ORDER BY rank LIMIT ?`),
    cutsBySource: db.prepare('SELECT * FROM dataset_scene_cuts WHERE source_id = ? ORDER BY frame_no ASC'),
    upsertCut: db.prepare(`INSERT INTO dataset_scene_cuts (source_id, frame_no, accepted, suggested, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_id, frame_no) DO UPDATE SET accepted = excluded.accepted, suggested = excluded.suggested`),
    deleteCut: db.prepare('DELETE FROM dataset_scene_cuts WHERE source_id = ? AND frame_no = ?'),
    clearCuts: db.prepare('DELETE FROM dataset_scene_cuts WHERE source_id = ?'),
  }

  const upsertAspect = db.prepare(`INSERT INTO dataset_aspects (id, label, ratio, official, enabled, position) VALUES (?, ?, ?, 1, 1, ?)
    ON CONFLICT(id) DO UPDATE SET position = excluded.position`)

  // -- aspect spectrum seed (idempotent) -------------------------------------
  db.transaction(() => {
    for (let index = 0; index < OFFICIAL_ASPECTS.length; index += 1) {
      const aspect = OFFICIAL_ASPECTS[index]
      upsertAspect.run(aspect.label, aspect.label, aspect.ratio, index)
    }
  })()

  // -- helpers ---------------------------------------------------------------
  function parseJson<T>(raw: unknown, fallback: T): T {
    try {
      const parsed = JSON.parse(typeof raw === 'string' ? raw : '') as T
      return parsed && typeof parsed === 'object' ? parsed : fallback
    } catch {
      return fallback
    }
  }

  function hydrateSource(rowUnknown: unknown): SourceRow | null {
    if (!rowUnknown || typeof rowUnknown !== 'object') return null
    const row = rowUnknown as Record<string, unknown>
    return {
      id: String(row.id),
      ingestPath: row.ingest_path === 'upload' ? 'upload' : 'reference',
      absPath: String(row.abs_path),
      contentHash: String(row.content_hash),
      sizeBytes: Number(row.size_bytes),
      mtimeMs: Number(row.mtime_ms),
      kind: row.kind === 'image' ? 'image' : 'video',
      probe: parseJson<ProbeFacts>(row.probe_json, { kind: 'video', width: 0, height: 0, fps: null, durationSec: null, hasAudio: false, dbfs: null, codec: null }),
      decodedFrames: row.decoded_frames === null || row.decoded_frames === undefined ? null : Number(row.decoded_frames),
      probeState: (row.probe_state as SourceRow['probeState']) ?? 'pending',
      probeError: row.probe_error ? String(row.probe_error) : null,
      originNote: String(row.origin_note ?? ''),
      originDate: row.origin_date ? String(row.origin_date) : null,
      aiGenerated: Boolean(row.ai_generated),
      consentNote: String(row.consent_note ?? ''),
      health: (row.health as SourceRow['health']) ?? 'healthy',
      healthDetail: row.health_detail ? String(row.health_detail) : null,
      floorVerdict: (row.floor_verdict as SourceRow['floorVerdict']) ?? 'ok',
      floorReason: row.floor_reason ? String(row.floor_reason) : null,
      trashedAt: row.trashed_at === null || row.trashed_at === undefined ? null : Number(row.trashed_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
  }

  function hydrateLayer(rowUnknown: unknown): LayerRow | null {
    if (!rowUnknown || typeof rowUnknown !== 'object') return null
    const row = rowUnknown as Record<string, unknown>
    const source = hydrateSource(st.sourceById.get(String(row.source_id)))
    const caption = st.captionByLayer.get(String(row.id)) as Record<string, unknown> | undefined
    const crop = row.crop_w === null || row.crop_w === undefined ? null : { x: Number(row.crop_x), y: Number(row.crop_y), w: Number(row.crop_w), h: Number(row.crop_h) }
    return {
      id: String(row.id),
      sourceId: String(row.source_id),
      name: String(row.name ?? ''),
      crop,
      trim: {
        inFrame: row.trim_in_frame === null || row.trim_in_frame === undefined ? null : Number(row.trim_in_frame),
        outFrame: row.trim_out_frame === null || row.trim_out_frame === undefined ? null : Number(row.trim_out_frame),
      },
      origin: (row.origin as LayerRow['origin']) ?? 'manual',
      contentClass: (row.content_class as ContentClass | null) ?? null,
      slowmoDisposition: (row.slowmo_disposition as LayerRow['slowmoDisposition']) ?? null,
      interpolated: Boolean(row.interpolated),
      clusterId: row.cluster_id ? String(row.cluster_id) : null,
      clusterNo: row.cluster_no === null || row.cluster_no === undefined ? null : Number(row.cluster_no),
      sceneSplitOf: row.scene_split_of ? String(row.scene_split_of) : null,
      trashedAt: row.trashed_at === null || row.trashed_at === undefined ? null : Number(row.trashed_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      caption: caption
        ? {
            text: String(caption.text ?? ''),
            author: String(caption.author ?? 'hand'),
            authorModel: caption.author_model ? String(caption.author_model) : null,
            stale: Boolean(caption.stale),
            staleReason: caption.stale_reason ? String(caption.stale_reason) : null,
            reviewState: caption.review_state ? String(caption.review_state) : null,
          }
        : null,
      source: source
        ? { id: source.id, kind: source.kind, width: source.probe.width, height: source.probe.height, fps: source.probe.fps, decodedFrames: source.decodedFrames, health: source.health, absPath: source.absPath, contentHash: source.contentHash }
        : { id: String(row.source_id), kind: 'video', width: 0, height: 0, fps: null, decodedFrames: null, health: 'missing', absPath: '', contentHash: '' },
    }
  }

  async function contentHashOfFile(path: string): Promise<string> {
    const { createReadStream } = await import('node:fs')
    const { createXXHash128 } = await import('hash-wasm')
    // xxhash128 over streamed bytes (hash-wasm's streaming API keeps memory flat).
    const hasher = await createXXHash128()
    await new Promise<void>((resolvePromise, reject) => {
      const stream = createReadStream(path)
      stream.on('data', (chunk) => { hasher.update(chunk as Buffer) })
      stream.on('error', reject)
      stream.on('end', () => resolvePromise())
    })
    return hasher.digest()
  }

  function ftsIndexLayer(layer: LayerRow) {
    const row = db.prepare('SELECT rowid AS rid FROM dataset_fts WHERE layer_id = ? LIMIT 1').get(layer.id) as { rid: number } | undefined
    if (row) st.ftsDelete.run(row.rid)
    const parts: string[] = []
    if (layer.caption?.text) parts.push(layer.caption.text)
    if (layer.name) parts.push(layer.name)
    const source = hydrateSource(st.sourceById.get(layer.sourceId))
    if (source) parts.push(source.originNote, source.consentNote, layer.id)
    const text = parts.filter(Boolean).join(' ').slice(0, 8000)
    const insert = db.prepare('INSERT INTO dataset_fts (text, source_id, layer_id, kind) VALUES (?, ?, ?, ?)')
    insert.run(text, layer.sourceId, layer.id, 'layer')
  }

  function ftsRemoveLayer(layerId: string) {
    const row = db.prepare('SELECT rowid AS rid FROM dataset_fts WHERE layer_id = ? LIMIT 1').get(layerId) as { rid: number } | undefined
    if (row) st.ftsDelete.run(row.rid)
  }

  // -- ingest (§2.1: both paths, one identity contract) ----------------------

  /** Shared file-ingest core (both paths): hash → dedupe-or-insert. */
  async function ingestFileAt(resolved: string, ingestPath: 'reference' | 'upload', provenance?: ProvenanceInput): Promise<IngestResult> {
    const info = await stat(resolved).catch(() => null)
    if (!info?.isFile()) throw new Error(`No file at ${resolved} — ingest needs an existing file.`)
    const hash = await contentHashOfFile(resolved)
    const existing = hydrateSource(st.sourceByHash.get(hash) as Record<string, unknown>)
    if (existing) {
      // Identity is the hash: a re-import or re-upload of the same content
      // resolves to the SAME source. If the recorded path differs and the old
      // location is gone, adopt the new one (content-addressed re-link).
      if (existing.absPath !== resolved) {
        const oldGone = !(await stat(existing.absPath).catch(() => null))
        if (oldGone) {
          st.relinkSource.run(resolved, Math.round(info.mtimeMs), info.size, 'healthy', `Re-linked by re-import (content hash ${hash.slice(0, 12)}).`, now(), existing.id)
        }
      }
      return { source: hydrateSource(st.sourceById.get(existing.id))!, deduped: true }
    }
    const probe = await probeMedia(resolved, options.tools)
    const floor = floorVerdict(probe.kind, probe.width, probe.height)
    const id = randomUUID()
    st.insertSource.run({
      id,
      ingest_path: ingestPath,
      abs_path: resolved,
      content_hash: hash,
      size_bytes: info.size,
      mtime_ms: Math.round(info.mtimeMs),
      kind: probe.kind,
      probe_json: JSON.stringify(probe),
      floor_verdict: floor.verdict,
      floor_reason: floor.reason ?? null,
      origin_note: provenance?.originNote ?? '',
      created_at: now(),
      updated_at: now(),
    })
    const source = hydrateSource(st.sourceById.get(id))!
    options.logEvent({ kind: 'datasets.ingest', id, hash: hash.slice(0, 12), mediaKind: probe.kind, floor: floor.verdict, path: ingestPath })
    return {
      source,
      deduped: false,
      refusal: floor.verdict === 'refuse' ? { verdict: 'refuse', reason: floor.reason! } : floor.verdict === 'warn' ? { verdict: 'warn', reason: floor.reason! } : undefined,
    }
  }

  /** Ingest path A — by reference (§2.1). Nothing is copied; the recorded
   * path is the user's file, which this tool never writes to. */
  function ingestReference(absPath: string, provenance?: ProvenanceInput): Promise<IngestResult> {
    return ingestFileAt(resolve(absPath), 'reference', provenance)
  }

  /** Ingest path B — LAN upload (§2.1, blessing amendment). The bytes land in
   * the app's media store; the upload IS the import. Same identity contract. */
  async function ingestUpload(fileName: string, bytes: Buffer, provenance?: ProvenanceInput): Promise<IngestResult> {
    if (!bytes.length) throw new Error('The upload carried no bytes.')
    await mkdir(options.mediaRoot, { recursive: true })
    const safeName = fileName.replace(/[^a-z0-9._-]+/gi, '_').slice(-80) || 'upload.mp4'
    const dest = join(options.mediaRoot, `${randomUUID().slice(0, 8)}-${safeName}`)
    await writeFile(dest, bytes)
    try {
      return await ingestFileAt(dest, 'upload', provenance)
    } catch (error) {
      // Never leave orphaned upload bytes behind a failed ingest.
      await import('node:fs').then((fs) => fs.promises.unlink(dest)).catch(() => undefined)
      throw error
    }
  }

  /** The async decoded-frame-count probe (§2.2): full decode, background. */
  async function runDecodeProbe(sourceId: string): Promise<void> {
    const source = hydrateSource(st.sourceById.get(sourceId))
    if (!source) throw new Error(`No source ${sourceId}.`)
    if (source.kind === 'image') {
      st.updateSourceProbe.run(JSON.stringify({ ...source.probe }), 1, 'done', null, now(), sourceId)
      return
    }
    db.prepare("UPDATE dataset_sources SET probe_state = 'probing', updated_at = ? WHERE id = ?").run(now(), sourceId)
    try {
      const count = await decodedFrameCount(source.absPath, options.tools)
      st.updateSourceProbe.run(JSON.stringify(source.probe), count, 'done', null, now(), sourceId)
      options.logEvent({ kind: 'datasets.probe-done', id: sourceId, decodedFrames: count })
    } catch (error) {
      st.updateSourceProbe.run(JSON.stringify(source.probe), null, 'failed', error instanceof Error ? error.message : String(error), now(), sourceId)
    }
  }

  // -- health check (§2.1): MISSING / CHANGED, never silent strandings ------

  /** Health-checks referenced sources: stat; when size or mtime moved, hash
   * the bytes to distinguish moved-gone (MISSING) from replaced (CHANGED). */
  async function checkHealth(sourceIds?: string[]): Promise<{ checked: number; missing: number; changed: number }> {
    const rows = (sourceIds
      ? sourceIds.map((id) => st.sourceById.get(id)).filter(Boolean)
      : db.prepare("SELECT * FROM dataset_sources WHERE trashed_at IS NULL AND ingest_path = 'reference'").all()) as Array<Record<string, unknown>>
    let missing = 0
    let changed = 0
    for (const row of rows) {
      const source = hydrateSource(row)!
      const info = await stat(source.absPath).catch(() => null)
      if (!info) {
        if (source.health !== 'missing') {
          st.updateSourceHealth.run('missing', `The file at ${source.absPath} is gone. Layers are intact; bake refuses until re-linked (pick a file with the same content — hash ${source.contentHash.slice(0, 12)}).`, source.mtimeMs, source.sizeBytes, now(), source.id)
          missing += 1
        }
        continue
      }
      if (source.health === 'missing') {
        // Came back? Verify by hash before declaring healthy.
        const hash = await contentHashOfFile(source.absPath).catch(() => null)
        if (hash === source.contentHash) st.updateSourceHealth.run('healthy', null, Math.round(info.mtimeMs), info.size, now(), source.id)
        else st.updateSourceHealth.run('changed', 'The file at this path now holds DIFFERENT content — crop/trim indices may no longer align. Bake warns; explicit accept required.', Math.round(info.mtimeMs), info.size, now(), source.id)
        continue
      }
      if (Math.round(info.mtimeMs) !== source.mtimeMs || info.size !== source.sizeBytes) {
        const hash = await contentHashOfFile(source.absPath).catch(() => null)
        if (hash === source.contentHash) st.updateSourceHealth.run('healthy', null, Math.round(info.mtimeMs), info.size, now(), source.id)
        else {
          st.updateSourceHealth.run('changed', 'Same path, different content (hash mismatch) — crop/trim indices may no longer align. Bake warns; explicit accept is required before these layers bake.', Math.round(info.mtimeMs), info.size, now(), source.id)
          changed += 1
        }
      } else if (source.health !== 'healthy') {
        st.updateSourceHealth.run('healthy', null, source.mtimeMs, source.sizeBytes, now(), source.id)
      }
    }
    return { checked: rows.length, missing, changed }
  }

  /** Re-link a MISSING source by picking a new file; the pick is accepted
   * only when its content hash matches (content-addressed re-link). */
  async function relinkSource(sourceId: string, newPath: string): Promise<{ relinked: boolean; reason?: string }> {
    const source = hydrateSource(st.sourceById.get(sourceId))
    if (!source) throw new Error(`No source ${sourceId}.`)
    const info = await stat(newPath).catch(() => null)
    if (!info?.isFile()) return { relinked: false, reason: `No file at ${newPath}.` }
    const hash = await contentHashOfFile(newPath)
    if (hash !== source.contentHash) {
      return { relinked: false, reason: `Content hash mismatch: the picked file is not the same content as the missing source (want ${source.contentHash.slice(0, 12)}, got ${hash.slice(0, 12)}).` }
    }
    st.relinkSource.run(resolve(newPath), Math.round(info.mtimeMs), info.size, 'healthy', `Re-linked ${new Date().toISOString().slice(0, 10)} (hash match).`, now(), sourceId)
    return { relinked: true }
  }

  // -- trash (§1 soft delete; §2.1 per-path semantics) -----------------------

  /** Trashing a REFERENCED source removes the library entry only. Trashing an
   * UPLOADED source moves the app-owned bytes into the trash store. The file
   * on disk (user originals) is never touched by any deletion. */
  async function trashSourceDo(sourceId: string): Promise<{ trashed: boolean; layersAffected: number; captionsAffected: number }> {
    const source = hydrateSource(st.sourceById.get(sourceId))
    if (!source) throw new Error(`No source ${sourceId}.`)
    const layers = (st.layersBySource.all(sourceId) as Array<Record<string, unknown>>)
    const captions = layers.filter((layer) => st.captionByLayer.get(layer.id))
    if (source.ingestPath === 'upload') {
      await mkdir(options.trashRoot, { recursive: true })
      const trashedPath = join(options.trashRoot, `${source.id}-${source.absPath.split('/').pop()}`)
      await copyFile(source.absPath, trashedPath).catch(() => undefined)
      await rename(source.absPath, trashedPath).catch(() => undefined)
      db.prepare('UPDATE dataset_sources SET abs_path = ? WHERE id = ?').run(trashedPath, sourceId)
    }
    st.trashSource.run(now(), now(), sourceId)
    for (const layer of layers) {
      st.trashLayer.run(now(), now(), String(layer.id))
      ftsRemoveLayer(String(layer.id))
    }
    return { trashed: true, layersAffected: layers.length, captionsAffected: captions.length }
  }

  async function restoreSourceDo(sourceId: string): Promise<{ restored: boolean }> {
    const source = hydrateSource(st.sourceById.get(sourceId))
    if (!source) throw new Error(`No source ${sourceId}.`)
    if (source.ingestPath === 'upload' && source.absPath.startsWith(options.trashRoot)) {
      // Move the bytes back into the media store.
      const back = join(options.mediaRoot, `${randomUUID().slice(0, 8)}-${source.absPath.split('/').pop()?.replace(/^[a-f0-9-]{36}-/, '')}`)
      await copyFile(source.absPath, back).catch(() => undefined)
      await rename(source.absPath, back).catch(() => undefined)
      db.prepare('UPDATE dataset_sources SET abs_path = ? WHERE id = ?').run(back, sourceId)
    }
    st.restoreSource.run(now(), sourceId)
    db.prepare('UPDATE dataset_layers SET trashed_at = NULL, updated_at = ? WHERE source_id = ?').run(now(), sourceId)
    for (const layer of (st.layersBySource.all(sourceId) as Array<Record<string, unknown>>)) ftsIndexLayer(hydrateLayer(layer)!)
    return { restored: true }
  }

  /** Empty-trash is the ONE real delete — and only app-owned (upload-path)
   * bytes are ever eligible; referenced rows just drop the library entry. */
  async function emptyTrash(): Promise<{ dropped: number; bytesDeleted: number }> {
    const rows = st.listTrashedSources.all() as Array<Record<string, unknown>>
    let dropped = 0
    let bytesDeleted = 0
    for (const row of rows) {
      const source = hydrateSource(row)!
      if (source.ingestPath === 'upload') {
        const info = await stat(source.absPath).catch(() => null)
        if (info && source.absPath.startsWith(options.trashRoot)) {
          await import('node:fs').then((fs) => fs.promises.unlink(source.absPath)).catch(() => undefined)
          bytesDeleted += info.size
        }
      }
      db.prepare('DELETE FROM dataset_captions WHERE layer_id IN (SELECT id FROM dataset_layers WHERE source_id = ?)').run(source.id)
      db.prepare('DELETE FROM dataset_caption_history WHERE layer_id IN (SELECT id FROM dataset_layers WHERE source_id = ?)').run(source.id)
      db.prepare('DELETE FROM dataset_layers WHERE source_id = ?').run(source.id)
      db.prepare('DELETE FROM dataset_scene_cuts WHERE source_id = ?').run(source.id)
      db.prepare('DELETE FROM dataset_sources WHERE id = ?').run(source.id)
      dropped += 1
    }
    return { dropped, bytesDeleted }
  }

  // -- layers (§3) ------------------------------------------------------------

  function effectiveFrameBounds(source: SourceRow): { total: number } {
    if (source.kind === 'image') return { total: 1 }
    if (source.decodedFrames) return { total: source.decodedFrames }
    const claimed = source.probe.durationSec && source.probe.fps ? Math.round(source.probe.durationSec * source.probe.fps) : 0
    return { total: claimed }
  }

  function createLayer(input: LayerInput): LayerRow {
    const source = hydrateSource(st.sourceById.get(input.sourceId))
    if (!source) throw new Error(`No source ${input.sourceId}.`)
    if (source.floorVerdict === 'refuse') throw new Error(`The source was refused at import (${source.floorReason}) — it carries no layers.`)
    const { width, height } = source.probe
    const crop = input.crop ? alignCropRect(input.crop, width, height) : null
    if (crop) {
      const floor = floorVerdict(source.kind, crop.w, crop.h)
      if (floor.verdict === 'refuse') throw new Error(`Crop refused at crop-time: ${floor.reason}`)
    }
    const bounds = effectiveFrameBounds(source)
    let trim = input.trim ?? null
    if (trim && source.kind === 'video') {
      const inFrame = Math.max(0, Math.round(trim.inFrame ?? 0))
      const outFrame = Math.min(bounds.total, Math.round(trim.outFrame ?? bounds.total))
      if (outFrame - inFrame < 1) throw new Error('A trim window needs at least one frame.')
      trim = { inFrame, outFrame }
    } else trim = source.kind === 'image' ? { inFrame: 0, outFrame: 1 } : null
    const id = randomUUID()
    st.insertLayer.run({
      id,
      source_id: input.sourceId,
      name: (input.name ?? '').slice(0, 200),
      crop_x: crop?.x ?? null, crop_y: crop?.y ?? null, crop_w: crop?.w ?? null, crop_h: crop?.h ?? null,
      trim_in_frame: trim?.inFrame ?? null, trim_out_frame: trim?.outFrame ?? null,
      origin: input.origin ?? 'manual',
      content_class: input.contentClass ?? null,
      scene_split_of: input.sceneSplitOf ?? null,
      created_at: now(), updated_at: now(),
    })
    const layer = hydrateLayer(st.layerById.get(id))!
    ftsIndexLayer(layer)
    return layer
  }

  /** Editing a layer's crop or trim after captioning flags the caption stale
   * (§4 — crop AND trim: content removed from view invalidates the caption). */
  function updateLayerGeometry(layerId: string, update: { name?: string; crop?: CropRect | null; trim?: { inFrame: number | null; outFrame: number | null } | null; contentClass?: ContentClass | null }): LayerRow {
    const existing = hydrateLayer(st.layerById.get(layerId))
    if (!existing) throw new Error(`No layer ${layerId}.`)
    const source = hydrateSource(st.sourceById.get(existing.sourceId))!
    const nextCrop = update.crop === undefined ? existing.crop : update.crop ? alignCropRect(update.crop, source.probe.width, source.probe.height) : null
    if (update.crop && nextCrop) {
      const floor = floorVerdict(source.kind, nextCrop.w, nextCrop.h)
      if (floor.verdict === 'refuse') throw new Error(`Crop refused at crop-time: ${floor.reason}`)
    }
    const nextTrim = update.trim === undefined ? existing.trim : update.trim
    const cropChanged = JSON.stringify(nextCrop) !== JSON.stringify(existing.crop)
    const trimChanged = JSON.stringify(nextTrim) !== JSON.stringify(existing.trim)
    st.updateLayerGeometry.run(
      nextCrop?.x ?? null, nextCrop?.y ?? null, nextCrop?.w ?? null, nextCrop?.h ?? null,
      nextTrim?.inFrame ?? null, nextTrim?.outFrame ?? null,
      update.name !== undefined ? update.name.slice(0, 200) : existing.name,
      update.contentClass !== undefined ? update.contentClass : existing.contentClass,
      now(), layerId,
    )
    if ((cropChanged || trimChanged) && existing.caption?.text) {
      const what: string[] = []
      if (cropChanged) what.push('crop')
      if (trimChanged) what.push('trim')
      st.flagCaptionStale.run(`The layer's ${what.join(' and ')} changed after captioning — the caption may no longer describe the effective view. Recaption before export, or accept explicitly.`, now(), layerId)
    }
    const layer = hydrateLayer(st.layerById.get(layerId))!
    ftsIndexLayer(layer)
    return layer
  }

  // -- captions (§4) -----------------------------------------------------------

  /** Writes a caption with authorship + history. `hand` edits always win over
   * nothing; the batch-never-overwrite rule lives in the VLM runner (it calls
   * setCaption with respectHandGuard), while THIS primitive records whatever
   * the caller says — single source of truth for history. */
  function setCaption(layerId: string, text: string, author: 'hand' | 'vlm', authorModel?: string): LayerRow {
    const layer = hydrateLayer(st.layerById.get(layerId))
    if (!layer) throw new Error(`No layer ${layerId}.`)
    const trimmed = text.slice(0, 8000)
    const previous = st.captionByLayer.get(layerId) as Record<string, unknown> | undefined
    if (previous) st.insertCaptionHistory.run(layerId, String(previous.text ?? ''), String(previous.author ?? 'hand'), previous.author_model ? String(previous.author_model) : null, now())
    st.upsertCaption.run({ layer_id: layerId, text: trimmed, author, author_model: authorModel ?? null, updated_at: now() })
    st.setCaptionReview.run(null, now(), layerId)
    const updated = hydrateLayer(st.layerById.get(layerId))!
    ftsIndexLayer(updated)
    return updated
  }

  function captionHistory(layerId: string): Array<{ text: string; author: string; authorModel: string | null; recordedAt: number }> {
    return (st.captionHistory.all(layerId) as Array<Record<string, unknown>>).map((row) => ({
      text: String(row.text),
      author: String(row.author),
      authorModel: row.author_model ? String(row.author_model) : null,
      recordedAt: Number(row.recorded_at),
    }))
  }

  // -- settings ----------------------------------------------------------------

  function getSettings(): DatasetSettings {
    const row = st.settings.get() as Record<string, unknown>
    return {
      triggerToken: String(row.trigger_token ?? ''),
      contentClass: (row.content_class as ContentClass) ?? 'style',
      audioPolicy: parseJson<AudioPolicy>(row.audio_policy_json, DEFAULT_AUDIO_POLICY),
    }
  }

  function saveSettings(update: Partial<DatasetSettings>): DatasetSettings {
    const current = getSettings()
    const next = {
      triggerToken: update.triggerToken !== undefined ? update.triggerToken.slice(0, 60) : current.triggerToken,
      contentClass: update.contentClass ?? current.contentClass,
      audioPolicy: update.audioPolicy ?? current.audioPolicy,
    }
    st.updateSettings.run(next.triggerToken, next.contentClass, JSON.stringify(next.audioPolicy), now())
    return next
  }

  // -- aspects -------------------------------------------------------------------

  function listAspects(): AspectEntry[] {
    return (db.prepare('SELECT * FROM dataset_aspects ORDER BY position ASC').all() as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      label: String(row.label),
      ratio: Number(row.ratio),
      official: Boolean(row.official),
      enabled: Boolean(row.enabled),
      position: Number(row.position),
    }))
  }

  function setAspectEnabled(id: string, enabled: boolean): AspectEntry[] {
    db.prepare('UPDATE dataset_aspects SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
    return listAspects()
  }

  function addCustomAspect(label: string, ratio: number): AspectEntry[] {
    const clean = label.trim().slice(0, 12) || `${ratio.toFixed(3)}`
    if (!Number.isFinite(ratio) || ratio <= 0) throw new Error('A custom aspect needs a positive w/h ratio.')
    const existing = db.prepare('SELECT id FROM dataset_aspects WHERE label = ?').get(clean) as { id: string } | undefined
    if (existing) throw new Error(`An aspect named ${clean} already exists.`)
    // Insert positioned by ratio (widest → tallest); officials keep their
    // relative order, customs interleave by their ratio value.
    const all = listAspects()
    let position = all.length
    for (const entry of all) {
      if (ratio > entry.ratio) { position = entry.position; break }
    }
    db.prepare('UPDATE dataset_aspects SET position = position + 1 WHERE position >= ?').run(position)
    db.prepare('INSERT INTO dataset_aspects (id, label, ratio, official, enabled, position) VALUES (?, ?, ?, 0, 1, ?)').run(`custom-${randomUUID().slice(0, 8)}`, clean, ratio, position)
    return listAspects()
  }

  /** Customs are deletable; officials are NEVER deletable (blessing amendment). */
  function deleteAspect(id: string): AspectEntry[] {
    const row = db.prepare('SELECT * FROM dataset_aspects WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!row) throw new Error(`No aspect ${id}.`)
    if (row.official) throw new Error('Official-range aspects are always present and never deletable — disable one instead.')
    db.prepare('DELETE FROM dataset_aspects WHERE id = ?').run(id)
    return listAspects()
  }

  // -- search (FTS over captions/provenance) ------------------------------------

  function searchLayers(query: string, limit = 100): Array<{ layerId: string | null; sourceId: string; kind: string }> {
    const match = buildFtsMatch(query)
    if (!match) return []
    try {
      return (st.ftsSearch.all(match, Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>).map((row) => ({
        layerId: row.layer_id ? String(row.layer_id) : null,
        sourceId: String(row.source_id),
        kind: String(row.kind),
      }))
    } catch {
      return []
    }
  }

  // -- scene cuts (§6 N5) ---------------------------------------------------------

  function proposeCuts(sourceId: string, frames: number[], accepted: boolean[]): { sourceId: string; cuts: Array<{ frameNo: number; accepted: boolean; suggested: boolean }> } {
    const source = hydrateSource(st.sourceById.get(sourceId))
    if (!source) throw new Error(`No source ${sourceId}.`)
    const withChildren = db.prepare("SELECT COUNT(*) AS n FROM dataset_layers WHERE source_id = ? AND origin = 'scene-split' AND trashed_at IS NULL").get(sourceId) as { n: number }
    if (withChildren.n > 0) {
      // Cut points are editable until children exist; re-running after
      // children exist creates NEW children (never mutates old ones) — so the
      // proposal is APPENDED, existing accepted cuts untouched.
      for (let index = 0; index < frames.length; index += 1) {
        st.upsertCut.run(sourceId, Math.round(frames[index]), Boolean(accepted[index]), true, now())
      }
    } else {
      st.clearCuts.run(sourceId)
      for (let index = 0; index < frames.length; index += 1) {
        st.upsertCut.run(sourceId, Math.round(frames[index]), Boolean(accepted[index]), true, now())
      }
    }
    return { sourceId, cuts: cutsFor(sourceId) }
  }

  function cutsFor(sourceId: string): Array<{ frameNo: number; accepted: boolean; suggested: boolean }> {
    return (st.cutsBySource.all(sourceId) as Array<Record<string, unknown>>).map((row) => ({ frameNo: Number(row.frame_no), accepted: Boolean(row.accepted), suggested: Boolean(row.suggested) }))
  }

  return {
    // ingest + identity + health
    ingestReference,
    ingestUpload,
    runDecodeProbe,
    checkHealth,
    relinkSource,
    contentHashOfFile,
    // queries
    getSource: (id: string) => hydrateSource(st.sourceById.get(id) as Record<string, unknown>),
    getLayer: (id: string) => hydrateLayer(st.layerById.get(id) as Record<string, unknown>),
    listSources: () => (st.listSources.all() as Array<Record<string, unknown>>).map((row) => hydrateSource(row)!),
    listTrashedSources: () => (st.listTrashedSources.all() as Array<Record<string, unknown>>).map((row) => hydrateSource(row)!),
    layersFor: (sourceId: string) => (st.layersBySource.all(sourceId) as Array<Record<string, unknown>>).map((row) => hydrateLayer(row)!),
    listLayers: () => (st.listLayers.all() as Array<Record<string, unknown>>).map((row) => hydrateLayer(row)!),
    effectiveFrameBounds,
    // layers
    createLayer,
    updateLayerGeometry,
    setLayerClass: (layerId: string, contentClass: ContentClass | null) => { st.setLayerClass.run(contentClass, now(), layerId); return hydrateLayer(st.layerById.get(layerId) as Record<string, unknown>) },
    setLayerSlowmo: (layerId: string, disposition: 'retime' | 'caption' | 'exclude' | null) => { st.setLayerSlowmo.run(disposition, now(), layerId); return hydrateLayer(st.layerById.get(layerId) as Record<string, unknown>) },
    setLayerCluster: (layerId: string, clusterId: string | null, clusterNo: number | null) => { st.setLayerCluster.run(clusterId, clusterNo, now(), layerId) },
    markLayerInterpolated: (layerId: string, interpolated: boolean) => { st.markLayerInterpolated.run(interpolated ? 1 : 0, now(), layerId) },
    trashLayer: (layerId: string) => { ftsRemoveLayer(layerId); st.trashLayer.run(now(), now(), layerId); return hydrateLayer(st.layerById.get(layerId) as Record<string, unknown>) },
    restoreLayer: (layerId: string) => { st.restoreLayer.run(now(), layerId); const layer = hydrateLayer(st.layerById.get(layerId) as Record<string, unknown>); if (layer) ftsIndexLayer(layer); return layer },
    // trash
    trashSource: trashSourceDo,
    restoreSource: restoreSourceDo,
    emptyTrash,
    // captions
    setCaption,
    captionHistory,
    setCaptionReview: (layerId: string, reviewState: 'queued' | 'approved' | null) => { st.setCaptionReview.run(reviewState, now(), layerId) },
    // provenance
    setProvenance: (sourceId: string, provenance: { originNote?: string; originDate?: string | null; aiGenerated?: boolean; consentNote?: string }) => {
      const source = hydrateSource(st.sourceById.get(sourceId))
      if (!source) throw new Error(`No source ${sourceId}.`)
      st.updateSourceProvenance.run(
        provenance.originNote !== undefined ? provenance.originNote.slice(0, 2000) : source.originNote,
        provenance.originDate !== undefined ? provenance.originDate : source.originDate,
        provenance.aiGenerated !== undefined ? (provenance.aiGenerated ? 1 : 0) : source.aiGenerated ? 1 : 0,
        provenance.consentNote !== undefined ? provenance.consentNote.slice(0, 2000) : source.consentNote,
        now(), sourceId,
      )
      return hydrateSource(st.sourceById.get(sourceId))
    },
    // settings + aspects
    getSettings,
    saveSettings,
    listAspects,
    setAspectEnabled,
    addCustomAspect,
    deleteAspect,
    // search
    searchLayers,
    // scene cuts
    proposeCuts,
    cutsFor,
  }
}

/** Injection-safe FTS5 MATCH (the repo.ts ftsMatchExpression contract). */
function buildFtsMatch(raw: string): string {
  const tokens = String(raw).split(/["*()]+/).map((token) => token.trim()).filter((token) => token.length > 0)
  return tokens.map((token) => `"${token}"*`).join(' AND ')
}

export type DatasetStore = ReturnType<typeof createDatasetStore>
