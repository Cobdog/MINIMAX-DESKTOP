/**
 * Project archive format (§7 of docs/specs/canvas-document-model.md, L32):
 * export ONE project's DB rows (project, chains, outputs, takes, ops, control
 * tracks, identity payloads, plans, asset_forks — global assets are NOT rows;
 * they ride by id + hash manifest) + the blob tree (media + latents, by
 * content hash) in a single archive.
 *
 * Container: a spec-conformant ZIP with DEFLATE entries, written and parsed
 * in-module — no new native dependency (node's stdlib has no zip; zstd needs
 * Node ≥ 23 or a native dep, and §7 allows zip). The format is fixed NOW per
 * L32's rationale; only CANVAS_ARCHIVE_VERSION gates compatibility.
 *
 *   archive.zip
 *     manifest.json   — format/archiveVersion/schemaVersion/writer app version,
 *                       blob + global-asset manifests, counts
 *     document.json   — the project's rows verbatim (schema_version included)
 *     blobs/<sha256>  — content-addressed blob payloads (missing blobs are
 *                       recorded in the manifest, never fabricated)
 *
 * Import = the reverse, honoring schemaVersion: unknown-newer refuses LOUDLY
 * (CanvasSchemaVersionError naming the writing app version — §2/F9). Import
 * requires the project id to be free (documented seam: id remapping on
 * collision is a UX decision for the canvas import flow).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { CANVAS_ARCHIVE_VERSION, CANVAS_SCHEMA_VERSION, CanvasSchemaVersionError, type DocumentStore } from './documents'

// ---------------------------------------------------------------------------
// ZIP (spec-conformant subset: local file headers + central directory + EOCD,
// deflate or stored entries, no data descriptors, no zip64)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(timestamp: number): { time: number; date: number } {
  const at = new Date(timestamp)
  const time = ((at.getHours() & 0x1f) << 11) | ((at.getMinutes() & 0x3f) << 5) | ((at.getSeconds() >> 1) & 0x1f)
  const date = (((at.getFullYear() - 1980) & 0x7f) << 9) | (((at.getMonth() + 1) & 0x0f) << 5) | (at.getDate() & 0x1f)
  return { time, date: date < 0 ? 0 : date }
}

type ZipEntry = { name: string; data: Buffer }

/** Packs entries into a ZIP buffer (deflate when it helps, stored otherwise). */
export function packZip(entries: ZipEntry[]): Buffer {
  const localChunks: Buffer[] = []
  const centralChunks: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8')
    const deflated = deflateRawSync(entry.data, { level: 6 })
    const useDeflate = deflated.length < entry.data.length
    const payload = useDeflate ? deflated : entry.data
    const method = useDeflate ? 8 : 0
    const { time, date } = dosDateTime(Date.now())
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc32(entry.data), 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    local.writeUInt16LE(0, 28) // extra len
    localChunks.push(local, nameBuffer, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc32(entry.data), 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    centralChunks.push(central, nameBuffer)

    offset += local.length + nameBuffer.length + payload.length
  }
  const centralDirectory = Buffer.concat(centralChunks)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDirectory.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...localChunks, centralDirectory, eocd])
}

/** Parses a ZIP buffer via its central directory (entries only — no zip64). */
export function unpackZip(archive: Buffer): Map<string, Buffer> {
  const eocdSignature = 0x06054b50
  let eocd = -1
  for (let index = archive.length - 22; index >= Math.max(0, archive.length - 22 - 65_536); index -= 1) {
    if (archive.readUInt32LE(index) === eocdSignature) {
      eocd = index
      break
    }
  }
  if (eocd < 0) throw new Error('This is not a readable project archive (no ZIP end record).')
  const entries = archive.readUInt16LE(eocd + 10)
  let cursor = archive.readUInt32LE(eocd + 16)
  const files = new Map<string, Buffer>()
  for (let index = 0; index < entries; index += 1) {
    if (archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error('The archive central directory is corrupt.')
    const method = archive.readUInt16LE(cursor + 10)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const localOffset = archive.readUInt32LE(cursor + 42)
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const payload = archive.subarray(dataStart, dataStart + compressedSize)
    files.set(name, method === 8 ? inflateRawSync(payload) : Buffer.from(payload))
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return files
}

// ---------------------------------------------------------------------------
// export / import (§7)
// ---------------------------------------------------------------------------
type ArchiveManifest = {
  format: 'minimax-canvas-archive'
  archiveVersion: number
  schemaVersion: number
  writerAppVersion: string
  exportedAt: number
  projectId: string
  projectName: string
  counts: Record<string, number>
  blobs: Array<{ path: string; kind: string; hash: string; size: number | null }>
  missingBlobs: Array<{ path: string; kind: string; hash: string }>
  globalAssets: Array<{ id: string; kind: string; fieldsHash: string }> // ride by id + hash (§7)
}

/** Exports one project as a ZIP archive buffer. Blob payloads are read from
 *  the content-addressed tree and hash-verified on the way in; missing blobs
 *  are recorded in the manifest (visible, never fabricated). */
export function exportProjectArchive(store: DocumentStore, projectId: string): { archive: Buffer; manifest: ArchiveManifest } {
  const db = store.db
  const document = store.getProjectDocument(projectId)
  if (!document) throw new Error(`project ${projectId} does not exist`)
  const projectRow = db.prepare('SELECT * FROM canvas_project WHERE id = ?').get(projectId) as Record<string, unknown>
  const chainRows = db.prepare('SELECT * FROM canvas_chain WHERE project_id = ?').all(projectId) as Array<Record<string, unknown>>
  const chainIds = chainRows.map((row) => String(row.id))
  const outputRows = chainIds.length
    ? (db.prepare(`SELECT * FROM canvas_output WHERE chain_id IN (${chainIds.map(() => '?').join(',')})`).all(...chainIds) as Array<Record<string, unknown>>)
    : []
  const outputIds = outputRows.map((row) => String(row.id))
  const takeRows = outputIds.length
    ? (db.prepare(`SELECT * FROM canvas_take WHERE output_id IN (${outputIds.map(() => '?').join(',')})`).all(...outputIds) as Array<Record<string, unknown>>)
    : []
  const stackRows = chainIds.length
    ? (db.prepare(`SELECT * FROM canvas_op_stack WHERE chain_id IN (${chainIds.map(() => '?').join(',')})`).all(...chainIds) as Array<Record<string, unknown>>)
    : []
  const stackIds = stackRows.map((row) => String(row.id))
  const opRows = stackIds.length
    ? (db.prepare(`SELECT * FROM canvas_op WHERE stack_id IN (${stackIds.map(() => '?').join(',')})`).all(...stackIds) as Array<Record<string, unknown>>)
    : []
  const identityRows = chainIds.length
    ? (db.prepare(`SELECT * FROM canvas_identity_payload WHERE chain_id IN (${chainIds.map(() => '?').join(',')})`).all(...chainIds) as Array<Record<string, unknown>>)
    : []
  const controlRows = chainIds.length
    ? (db.prepare(`SELECT * FROM canvas_control_track WHERE chain_id IN (${chainIds.map(() => '?').join(',')})`).all(...chainIds) as Array<Record<string, unknown>>)
    : []
  const planRows = db.prepare('SELECT * FROM canvas_plan WHERE project_id = ?').all(projectId) as Array<Record<string, unknown>>
  const forkRows = db.prepare('SELECT * FROM canvas_asset_fork WHERE project_id = ?').all(projectId) as Array<Record<string, unknown>>

  // referenced blobs + files
  const blobRows = new Map<string, Record<string, unknown>>()
  const referencedPaths = new Set<string>()
  for (const take of takeRows) {
    try {
      for (const artifact of JSON.parse(String(take.artifacts_json ?? '[]')) as string[]) referencedPaths.add(artifact)
    } catch { /* tolerant: our own writes, guarded like the store's reads */ }
    if (typeof take.latent_path === 'string' && take.latent_path) referencedPaths.add(take.latent_path)
  }
  for (const track of controlRows) {
    referencedPaths.add(String(track.input_ref))
    if (typeof track.mask_ref === 'string' && track.mask_ref) referencedPaths.add(String(track.mask_ref))
  }
  const blobEntries: Array<{ name: string; data: Buffer }> = []
  const packedHashes = new Set<string>()
  const blobs: ArchiveManifest['blobs'] = []
  const missingBlobs: ArchiveManifest['missingBlobs'] = []
  for (const relPath of referencedPaths) {
    const row = db.prepare('SELECT * FROM canvas_blob WHERE path = ?').get(relPath) as Record<string, unknown> | undefined
    if (!row) {
      // Referenced but never registered (a pre-blob latent recorded as a
      // relative engine path, a legacy control ref): VISIBLE in the
      // manifest's missing list — never a silent omission while the counts
      // claim full blob coverage.
      missingBlobs.push({ path: relPath, kind: relPath.endsWith('.latent') ? 'latent' : 'media', hash: 'unregistered' })
      continue
    }
    blobRows.set(relPath, row)
    const hash = String(row.content_hash)
    if (hash.startsWith('unverified:')) {
      missingBlobs.push({ path: relPath, kind: String(row.kind), hash })
      continue
    }
    if (packedHashes.has(hash)) {
      blobs.push({ path: relPath, kind: String(row.kind), hash, size: row.size === null || row.size === undefined ? null : Number(row.size) })
      continue // content already packed — the tree is content-addressed
    }
    const data = store.readBlob(relPath)
    if (!data) {
      missingBlobs.push({ path: relPath, kind: String(row.kind), hash })
      continue
    }
    const actual = createHash('sha256').update(data).digest('hex')
    if (actual !== hash) {
      missingBlobs.push({ path: relPath, kind: String(row.kind), hash })
      continue
    }
    blobEntries.push({ name: `blobs/${hash}`, data })
    packedHashes.add(hash)
    blobs.push({ path: relPath, kind: String(row.kind), hash, size: data.length })
  }

  // global assets ride by id + hash manifest (NOT as rows — §7)
  const globalAssets: ArchiveManifest['globalAssets'] = []
  for (const fork of forkRows) {
    const asset = db.prepare('SELECT * FROM canvas_asset WHERE id = ?').get(fork.asset_id) as Record<string, unknown> | undefined
    if (!asset) continue
    globalAssets.push({
      id: String(asset.id),
      kind: String(asset.kind),
      fieldsHash: createHash('sha256').update(String(asset.fields_json ?? '')).update(String(asset.canonical_reference_set_json ?? '')).digest('hex'),
    })
  }

  const manifest: ArchiveManifest = {
    format: 'minimax-canvas-archive',
    archiveVersion: CANVAS_ARCHIVE_VERSION,
    schemaVersion: Number(projectRow.schema_version),
    writerAppVersion: String(projectRow.app_version ?? 'unknown'),
    exportedAt: Date.now(),
    projectId,
    projectName: String(projectRow.name),
    counts: {
      chains: chainRows.length,
      outputs: outputRows.length,
      takes: takeRows.length,
      ops: opRows.length,
      controlTracks: controlRows.length,
      identityPayloads: identityRows.length,
      plans: planRows.length,
      assetForks: forkRows.length,
      blobs: blobs.length,
      missingBlobs: missingBlobs.length,
    },
    blobs,
    missingBlobs,
    globalAssets,
  }
  const documentPayload = {
    project: projectRow,
    chains: chainRows,
    outputs: outputRows,
    takes: takeRows,
    opStacks: stackRows,
    ops: opRows,
    identityPayloads: identityRows,
    controlTracks: controlRows,
    plans: planRows,
    assetForks: forkRows,
    blobRows: [...blobRows.values()],
  }
  const archive = packZip([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    { name: 'document.json', data: Buffer.from(JSON.stringify(documentPayload, null, 2), 'utf8') },
    ...blobEntries,
  ])
  return { archive, manifest }
}

export type ArchiveImportReport = {
  projectId: string
  counts: Record<string, number>
  missingGlobalAssets: Array<{ id: string; kind: string; fieldsHash: string }>
  restoredBlobs: number
  verifiedBlobs: number
}

/** Imports a project archive. Unknown-newer archive/document versions refuse
 *  loudly (CanvasSchemaVersionError); a taken project id refuses with a clear
 *  reason (id-remap UX is the canvas import flow's call, not ours). The whole
 *  import is one transaction and a failure leaves NOTHING behind: blob
 *  payloads are staged under import-temp names and renamed into the
 *  content-addressed tree only after the transaction commits (rolled-back
 *  rows never leave orphan files). Shared content (the same hash in two
 *  archives, or bytes this studio already ingested) upserts instead of
 *  colliding on canvas_blob's path PK — content-addressed rows are
 *  idempotent by construction. */
export function importProjectArchive(store: DocumentStore, archive: Buffer): ArchiveImportReport {
  const db = store.db
  const files = unpackZip(archive)
  const manifestBuffer = files.get('manifest.json')
  const documentBuffer = files.get('document.json')
  if (!manifestBuffer || !documentBuffer) throw new Error('The archive is missing its manifest or document payload.')
  let manifest: ArchiveManifest
  let payload: Record<string, Array<Record<string, unknown>> | Record<string, unknown>>
  try {
    manifest = JSON.parse(manifestBuffer.toString('utf8')) as ArchiveManifest
    payload = JSON.parse(documentBuffer.toString('utf8')) as Record<string, Array<Record<string, unknown>> | Record<string, unknown>>
  } catch (error) {
    throw new Error(`The archive payloads are not readable JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (manifest.format !== 'minimax-canvas-archive') throw new Error('This file is not a MiniMax canvas archive.')
  if (manifest.archiveVersion > CANVAS_ARCHIVE_VERSION) {
    throw new CanvasSchemaVersionError(manifest.archiveVersion, CANVAS_ARCHIVE_VERSION, manifest.writerAppVersion, 'project archive (format)')
  }
  if (manifest.schemaVersion > CANVAS_SCHEMA_VERSION) {
    throw new CanvasSchemaVersionError(manifest.schemaVersion, CANVAS_SCHEMA_VERSION, manifest.writerAppVersion, `project archive for "${manifest.projectName}"`)
  }

  // Blob payloads are written to STAGED names inside the transaction and
  // renamed only after it commits; a failure un-stages them.
  const staged: Array<{ stagedPath: string; targetPath: string }> = []
  try {
    const report = db.transaction((): ArchiveImportReport => {
      const projectId = manifest.projectId
      const existing = db.prepare('SELECT id FROM canvas_project WHERE id = ?').get(projectId)
      if (existing) throw new Error(`A project with id ${projectId} already exists in this studio. Delete or rename it before importing this archive.`)
      if (!payload.project || typeof payload.project !== 'object' || Array.isArray(payload.project)) {
        throw new Error('The archive document payload has no project row.')
      }

      const rows = {
        project: payload.project as Record<string, unknown>,
        chains: (payload.chains ?? []) as Array<Record<string, unknown>>,
        outputs: (payload.outputs ?? []) as Array<Record<string, unknown>>,
        takes: (payload.takes ?? []) as Array<Record<string, unknown>>,
        opStacks: (payload.opStacks ?? []) as Array<Record<string, unknown>>,
        ops: (payload.ops ?? []) as Array<Record<string, unknown>>,
        identityPayloads: (payload.identityPayloads ?? []) as Array<Record<string, unknown>>,
        controlTracks: (payload.controlTracks ?? []) as Array<Record<string, unknown>>,
        plans: (payload.plans ?? []) as Array<Record<string, unknown>>,
        assetForks: (payload.assetForks ?? []) as Array<Record<string, unknown>>,
        blobRows: (payload.blobRows ?? []) as Array<Record<string, unknown>>,
      }

      // Global assets ride by id + hash: a fork whose global asset is absent
      // locally gets a VISIBLE placeholder (never a silent drop, never an FK
      // hole) — reported as missingGlobalAssets.
      const missingGlobalAssets: ArchiveImportReport['missingGlobalAssets'] = []
      for (const asset of manifest.globalAssets) {
        const present = db.prepare('SELECT id FROM canvas_asset WHERE id = ?').get(asset.id)
        if (present) continue
        missingGlobalAssets.push(asset)
        db.prepare('INSERT INTO canvas_asset (id, kind, fields_json, canonical_reference_set_json, created_at, deleted_at) VALUES (?, ?, ?, NULL, ?, NULL)')
          .run(asset.id, asset.kind, JSON.stringify({ __placeholder: true, note: 'imported from archive; global asset content not present locally', fieldsHash: asset.fieldsHash }), Date.now())
      }

      // blobs first (takes reference them): hash-verify, write STAGED, and
      // remember whether the payload actually rode the archive (a deduped
      // export lists the path without resending the bytes).
      let restoredBlobs = 0
      let verifiedBlobs = 0
      const payloadAbsent: Array<{ path: string; targetPath: string }> = []
      for (const blob of manifest.blobs) {
        const targetPath = join(store.blobRoot, blob.hash.slice(0, 2), blob.hash)
        const data = files.get(`blobs/${blob.hash}`)
        if (!data) {
          // Content deduped at export (or a hostile manifest): the row may
          // still import — but if the file is not present locally either,
          // the blob must be marked missing, never claimed present.
          payloadAbsent.push({ path: blob.path, targetPath })
          continue
        }
        const actual = createHash('sha256').update(data).digest('hex')
        if (actual !== blob.hash) throw new Error(`Archive blob ${blob.hash} failed its content-hash check — the archive is corrupt; nothing was imported.`)
        const stagedPath = `${targetPath}.importing-${Math.random().toString(36).slice(2, 10)}`
        mkdirSync(join(store.blobRoot, blob.hash.slice(0, 2)), { recursive: true })
        writeFileSync(stagedPath, data)
        staged.push({ stagedPath, targetPath })
        restoredBlobs += 1
        verifiedBlobs += 1
      }

      const insertAll = (table: string, rowsToInsert: Array<Record<string, unknown>>) => {
        if (!rowsToInsert.length) return
        for (const row of rowsToInsert) {
          const keys = Object.keys(row)
          db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((key) => (row[key] === undefined ? null : row[key])))
        }
      }
      insertAll('canvas_project', [rows.project])
      // FK order: chains before their op stacks (canvas_op_stack.chain_id ->
      // canvas_chain.id), outputs before takes, assets before forks.
      insertAll('canvas_chain', rows.chains)
      insertAll('canvas_op_stack', rows.opStacks)
      insertAll('canvas_output', rows.outputs)
      insertAll('canvas_take', rows.takes)
      insertAll('canvas_op', rows.ops)
      insertAll('canvas_identity_payload', rows.identityPayloads)
      insertAll('canvas_control_track', rows.controlTracks)
      insertAll('canvas_plan', rows.plans)
      insertAll('canvas_asset_fork', rows.assetForks)
      // canvas_blob rows: UPSERT-WITH-VERIFY (the path is the PK and content
      // addressing makes rows idempotent). A pre-existing row with the SAME
      // hash is refreshed to present (this import just proved the bytes); a
      // divergent row is replaced by the archive's verified one. Never a raw
      // UNIQUE-constraint abort on shared content.
      for (const row of rows.blobRows) {
        const path = typeof row.path === 'string' ? row.path : ''
        if (!path) continue
        const hash = typeof row.content_hash === 'string' ? row.content_hash : ''
        const existing = db.prepare('SELECT content_hash FROM canvas_blob WHERE path = ?').get(path) as { content_hash: string } | undefined
        if (existing && existing.content_hash === hash) {
          db.prepare('UPDATE canvas_blob SET kind = ?, size = ?, last_verified_at = ?, missing = 0 WHERE path = ?')
            .run(typeof row.kind === 'string' ? row.kind : 'media', row.size === undefined || row.size === null ? null : Number(row.size), Date.now(), path)
          continue
        }
        if (existing) {
          db.prepare('UPDATE canvas_blob SET kind = ?, content_hash = ?, size = ?, last_verified_at = ?, missing = 0, relinked_from = ? WHERE path = ?')
            .run(typeof row.kind === 'string' ? row.kind : 'media', hash, row.size === undefined || row.size === null ? null : Number(row.size), Date.now(), typeof row.relinked_from === 'string' ? row.relinked_from : null, path)
          continue
        }
        insertAll('canvas_blob', [row])
      }
      // missingBlobs AFTER the rows exist (the pre-insert order was a no-op),
      // plus payload-absent blobs whose file is not present locally either.
      const markMissing = new Set<string>()
      for (const blob of manifest.missingBlobs) markMissing.add(blob.path)
      for (const absent of payloadAbsent) {
        if (!existsSync(absent.targetPath)) markMissing.add(absent.path)
      }
      for (const path of markMissing) db.prepare('UPDATE canvas_blob SET missing = 1 WHERE path = ?').run(path)

    // reindex what landed (FTS is a projection, not exported state)
    const jsonText = (raw: unknown): Record<string, unknown> => {
      try {
        const parsed = JSON.parse(String(raw ?? '{}')) as Record<string, unknown>
        return parsed && typeof parsed === 'object' ? parsed : {}
      } catch {
        return {}
      }
    }
    for (const chain of rows.chains) {
      const spec = jsonText(chain.input_spec_json)
      const fresh = spec.fresh as Record<string, unknown> | undefined
      const prompt = fresh && typeof fresh.prompt === 'string' ? fresh.prompt : ''
      db.prepare('DELETE FROM canvas_fts WHERE source_kind = ? AND source_id = ?').run('chain', String(chain.id))
      db.prepare('INSERT INTO canvas_fts (text, source_id, source_kind) VALUES (?, ?, ?)').run(prompt, String(chain.id), 'chain')
    }
    for (const plan of rows.plans) {
      const brief = jsonText(plan.document_json).brief
      db.prepare('DELETE FROM canvas_fts WHERE source_kind = ? AND source_id = ?').run('plan', String(plan.id))
      db.prepare('INSERT INTO canvas_fts (text, source_id, source_kind) VALUES (?, ?, ?)').run(typeof brief === 'string' ? brief : '', String(plan.id), 'plan')
    }

    return {
      projectId,
      counts: { ...manifest.counts, restoredBlobs, verifiedBlobs, placeholderAssets: missingGlobalAssets.length },
      missingGlobalAssets,
      restoredBlobs,
      verifiedBlobs,
    }
    })()
    // Commit succeeded: the staged payloads become the content-addressed
    // files (atomic rename — a torn import file can never sit at a canonical
    // hash path).
    for (const { stagedPath, targetPath } of staged) {
      renameSync(stagedPath, targetPath)
    }
    return report
  } catch (error) {
    // Rows rolled back; the staged payloads must not survive the failure
    // ("a failure leaves nothing behind" — files included).
    for (const { stagedPath } of staged) {
      try {
        unlinkSync(stagedPath)
      } catch { /* already gone — nothing to unstage */ }
    }
    throw error
  }
}
