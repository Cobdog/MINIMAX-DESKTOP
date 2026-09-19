/**
 * Canvas document store (Phase 0) — the schema of docs/specs/canvas-document-model.md
 * (tables §1, migrations §2, retention/GC §3, FTS §4, legacy import §6, archive §7)
 * on the wave-1 SQLite substrate.
 *
 * NAMING DEVIATION (flagged, deliberate): the spec's table list uses bare names
 * (project, chain, take, asset …) but the substrate already owns `projects`,
 * `assets` and `jobs` for the old surface, which must keep working untouched.
 * Every new table is therefore namespaced `canvas_*` — a 1:1 mapping to the
 * spec's §1 list (the spec fixes shape, not DDL/names).
 *
 * Spec-plus columns (§1 does not name them, later sections require them):
 *   - canvas_project.settings_defaults_json — §6 "workspace → project settings"
 *     needs a home for one project's chain-settings defaults.
 *   - canvas_project/canvas_session/canvas_plan.app_version — §2 requires the
 *     unknown-newer refusal to "name the app version that wrote it", so the
 *     writer's version must be persisted with the document.
 *   - canvas_output has no failure column: failed legacy jobs import as
 *     outputs WITHOUT takes; the failure is durable on the job row
 *     (jobs.failure_json, §1 job extension) and surfaced through the chain's
 *     legacy block (the F6 failure-propagation seam — semantics stay open).
 *
 * Open-shaped seams implemented minimally (marked at each site):
 *   - F6 failure propagation: durable-on-object via jobs.failure_json + the
 *     legacy chain block; per-plan spawn/block/skip lands with the plan executor.
 *   - F8 re-link: hash-match auto-relink over user-nominated roots
 *     (POST /api/lan/documents/blobs/relink); the UX around it is open.
 *   - L13 asset reference-sets: imported as CURATED REFERENCE SETS
 *     (canonical_reference_set json) per the recorded OPEN state — they do NOT
 *     silently unify on takes.
 */
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type Database from 'better-sqlite3'
import { logEvent } from './logger'
import { ftsMatchExpression } from './repo'

/** The DOCUMENT schema version (distinct from migration ids): bumped only
 *  when a document's persisted shape changes; §2 one-way migrations carry
 *  existing documents forward. Unknown-NEWER versions refuse loudly. */
export const CANVAS_SCHEMA_VERSION = 1

/** The archive format version (§7): the container layout, not the document
 *  schema (which rides inside the manifest and is checked separately). */
export const CANVAS_ARCHIVE_VERSION = 1

/** Thrown when a plan write loses the optimistic-concurrency race (M5): the
 *  caller's expected version is stale. Routes map this to 409 with the
 *  CURRENT document attached so the client can rebase and retry — a clean
 *  conflict surface, never a silent lost update. */
export class PlanConflictError extends Error {
  readonly planId: string
  readonly currentUpdatedAt: number
  readonly currentDocument: Record<string, unknown>
  constructor(planId: string, currentUpdatedAt: number, currentDocument: Record<string, unknown>) {
    super('This plan changed while it was being edited — the canvas reloaded it; the edit was applied to the fresh copy or can be retried.')
    this.name = 'PlanConflictError'
    this.planId = planId
    this.currentUpdatedAt = currentUpdatedAt
    this.currentDocument = currentDocument
  }
}

/** Thrown when a document (or archive) carries a schema/archive version newer
 *  than this build understands. Routes map this to a loud 400 — never a
 *  silent downgrade or a re-shape. */
export class CanvasSchemaVersionError extends Error {
  readonly found: number
  readonly supported: number
  readonly writerAppVersion: string
  constructor(found: number, supported: number, writerAppVersion: string, what: string) {
    super(
      `Refusing to open this ${what}: it was written with document schema version ${found}, but this build of MiniMax Studio understands up to ${supported}. ` +
        `It was written by app version ${writerAppVersion || 'unknown'} — upgrade MiniMax Studio (or open it with that version) rather than risking data loss.`,
    )
    this.name = 'CanvasSchemaVersionError'
    this.found = found
    this.supported = supported
    this.writerAppVersion = writerAppVersion
  }
}

/** A business-rule refusal (audit minor, cleanup wave twmpu4m): the store's
 *  guards — a missing target, a state refusal like "already canonical", an
 *  imported archive that violates a store invariant — answer with their
 *  status (400 state refusal / 404 missing target) and the reason, never an
 *  opaque structural 500. Internal integrity aborts stay plain Errors. */
export class DocumentsRuleError extends Error {
  readonly status: 400 | 404
  constructor(message: string, status: 400 | 404 = 400) {
    super(message)
    this.name = 'DocumentsRuleError'
    this.status = status
  }
}

/** Resolves the running app version for schema-version stamps. Reads the
 *  package.json next to the built server; never throws (stamps fall back to
 *  'unknown', which the refusal message still surfaces honestly). */
export function resolveStudioAppVersion(): string {
  const fromEnv = process.env.MINIMAX_STUDIO_APP_VERSION
  if (fromEnv) return fromEnv
  try {
    const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string }
    return typeof manifest.version === 'string' && manifest.version ? manifest.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Migration 002 — the canvas document tables (§1). Appended to the wave-1
 * migration list in db.ts (one-way, append-only; a persisted history that
 * diverges is a hard error there). The `jobs` extension (§1 "extend existing")
 * is additive nullable columns — the old surface never references them, so its
 * reads/writes are byte-identical before and after.
 */
export function upCanvasDocuments(db: Database.Database): void {
  db.exec(`
    -- §1 project (= one canvas). Tombstone = deleted_at (indexed).
    CREATE TABLE canvas_project (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      camera_json TEXT NOT NULL DEFAULT '{}',
      settings_defaults_json TEXT NOT NULL DEFAULT '{}',
      app_version TEXT NOT NULL DEFAULT 'unknown',
      created_at INTEGER NOT NULL,
      deleted_at INTEGER,
      last_active_at INTEGER NOT NULL
    );
    CREATE INDEX canvas_project_deleted ON canvas_project(deleted_at);

    -- §1 session (singleton row): the multi-canvas shell state.
    CREATE TABLE canvas_session (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      open_projects_json TEXT NOT NULL DEFAULT '[]',
      active_project TEXT,
      app_version TEXT NOT NULL DEFAULT 'unknown',
      updated_at INTEGER NOT NULL
    );

    -- §1 chain — the document IS the graph of these.
    CREATE TABLE canvas_chain (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES canvas_project(id),
      kind TEXT NOT NULL,
      input_spec_json TEXT NOT NULL DEFAULT '{}',
      op_stack_id TEXT,
      settings_json TEXT NOT NULL DEFAULT '{}',
      lock_state TEXT NOT NULL DEFAULT 'unlocked',
      hop_count INTEGER NOT NULL DEFAULT 0,
      drift_metrics_json TEXT,
      stale INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE INDEX canvas_chain_project ON canvas_chain(project_id);
    CREATE INDEX canvas_chain_deleted ON canvas_chain(deleted_at);

    -- §1 output (the fork take-off). The canonical take of an output is the
    -- one take whose superseded_by is NULL (invariant 2: the pointer switch
    -- IS the supersession marker — no other column ever changes).
    CREATE TABLE canvas_output (
      id TEXT PRIMARY KEY,
      chain_id TEXT NOT NULL REFERENCES canvas_chain(id),
      substrates_available_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX canvas_output_chain ON canvas_output(chain_id);

    -- §1 take — APPEND-ONLY (invariant 2): inserts only; the sole legal
    -- UPDATEs are the superseded_by / evicted / evicted_at markers, enforced
    -- by the trigger below (schema-enforced, tested adversarially).
    CREATE TABLE canvas_take (
      id TEXT PRIMARY KEY,
      output_id TEXT NOT NULL REFERENCES canvas_output(id),
      job_id TEXT,
      artifacts_json TEXT NOT NULL DEFAULT '[]',
      latent_path TEXT,
      metrics_json TEXT,
      created_at INTEGER NOT NULL,
      superseded_by TEXT,
      evicted INTEGER NOT NULL DEFAULT 0,
      evicted_at INTEGER,
      content_hash TEXT
    );
    CREATE INDEX canvas_take_output ON canvas_take(output_id);
    CREATE INDEX canvas_take_superseded ON canvas_take(superseded_by);
    CREATE TRIGGER canvas_take_append_only BEFORE UPDATE ON canvas_take
    WHEN OLD.id IS NOT NEW.id
      OR OLD.output_id IS NOT NEW.output_id
      OR OLD.job_id IS NOT NEW.job_id
      OR OLD.artifacts_json IS NOT NEW.artifacts_json
      OR OLD.latent_path IS NOT NEW.latent_path
      OR OLD.metrics_json IS NOT NEW.metrics_json
      OR OLD.created_at IS NOT NEW.created_at
      OR OLD.content_hash IS NOT NEW.content_hash
    BEGIN
      SELECT RAISE(ABORT, 'canvas_take is append-only (canvas invariant 2): only superseded_by/evicted/evicted_at may change');
    END;

    -- §1 op_stack + op. Ops are the EDIT layer (mutable while live); bake is
    -- an explicit irreversible marker (S10) — once baked_at is set the row is
    -- frozen by trigger. Ordinal reorder is an UPDATE of ordinals only.
    CREATE TABLE canvas_op_stack (
      id TEXT PRIMARY KEY,
      chain_id TEXT NOT NULL REFERENCES canvas_chain(id),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE canvas_op (
      id TEXT PRIMARY KEY,
      stack_id TEXT NOT NULL REFERENCES canvas_op_stack(id),
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL,
      settings_json TEXT NOT NULL DEFAULT '{}',
      baked_at INTEGER
    );
    CREATE INDEX canvas_op_stack_ordinal ON canvas_op(stack_id, ordinal);
    CREATE TRIGGER canvas_op_baked_immutable BEFORE UPDATE ON canvas_op
    WHEN OLD.baked_at IS NOT NULL
      AND (NEW.ordinal IS NOT OLD.ordinal OR NEW.kind IS NOT OLD.kind OR NEW.settings_json IS NOT OLD.settings_json OR NEW.baked_at IS NOT OLD.baked_at)
    BEGIN
      SELECT RAISE(ABORT, 'baked ops are immutable: bake is an explicit irreversible marker');
    END;

    -- §1 identity_payload — reference set / RefMods + verbatim subject text +
    -- the strength dial; rides every window (invariant 7).
    CREATE TABLE canvas_identity_payload (
      id TEXT PRIMARY KEY,
      chain_id TEXT NOT NULL REFERENCES canvas_chain(id),
      ref_asset_ids_json TEXT NOT NULL DEFAULT '[]',
      refmod_ids_json TEXT NOT NULL DEFAULT '[]',
      subject_text TEXT NOT NULL DEFAULT '',
      strength REAL NOT NULL DEFAULT 1,
      per_slot_strengths_json TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX canvas_identity_chain ON canvas_identity_payload(chain_id);

    -- §1 control_track — one per shot + optional inpaint mask.
    CREATE TABLE canvas_control_track (
      id TEXT PRIMARY KEY,
      chain_id TEXT NOT NULL REFERENCES canvas_chain(id),
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      input_ref TEXT NOT NULL,
      mask_ref TEXT,
      params_json TEXT
    );
    CREATE INDEX canvas_control_chain ON canvas_control_track(chain_id);

    -- §1 asset — the GLOBAL store above projects. canonical_reference_set is
    -- the L13 recorded-open shape (curated sets; do NOT silently unify on
    -- takes — a future decision reuses this column either way).
    CREATE TABLE canvas_asset (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      fields_json TEXT NOT NULL DEFAULT '{}',
      canonical_reference_set_json TEXT,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE INDEX canvas_asset_kind ON canvas_asset(kind);
    CREATE INDEX canvas_asset_deleted ON canvas_asset(deleted_at);

    -- §1 asset_fork — consent-gated fork-into-project with lineage home.
    -- Stale-propagation from global-asset changes to forks is a PROPOSAL
    -- (semantics undecided) — the lineage json records the home edge only.
    CREATE TABLE canvas_asset_fork (
      project_id TEXT NOT NULL REFERENCES canvas_project(id),
      asset_id TEXT NOT NULL REFERENCES canvas_asset(id),
      forked_settings_snapshot_json TEXT NOT NULL DEFAULT '{}',
      lineage_json TEXT,
      consent_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, asset_id)
    );

    -- §1 plan — the MoviePlanner inheritance (brief, segments→chain refs,
    -- gap transitions, per-segment reference handoffs).
    CREATE TABLE canvas_plan (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES canvas_project(id),
      schema_version INTEGER NOT NULL,
      document_json TEXT NOT NULL,
      app_version TEXT NOT NULL DEFAULT 'unknown',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX canvas_plan_project ON canvas_plan(project_id);

    -- §1 blob — content-hash addressed; missing = visible placeholder state
    -- (invariant 9), relinked_from records the F8 re-link provenance.
    CREATE TABLE canvas_blob (
      path TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      size INTEGER,
      last_verified_at INTEGER,
      missing INTEGER NOT NULL DEFAULT 0,
      relinked_from TEXT
    );

    -- §6 marker: the legacy import ran (with its asserted counts). Absence
    -- means "retry clean"; the import is idempotent either way.
    CREATE TABLE canvas_import_marker (
      id TEXT PRIMARY KEY,
      imported_at INTEGER NOT NULL,
      counts_json TEXT NOT NULL DEFAULT '{}'
    );

    -- §4 FTS surfaces: chain prompts, asset fields, plan briefs, take/job
    -- metadata. Contentful FTS5 (self-maintaining deletes; the prompts_fts
    -- precedent is contentless because it predates contentless_delete=1
    -- needing explicit rowid deletes — a contentful table keeps the source
    -- mapping self-contained).
    CREATE VIRTUAL TABLE canvas_fts USING fts5(
      text,
      source_id UNINDEXED,
      source_kind UNINDEXED
    );
    -- job metadata stays live for ALL writers of the jobs table (the old
    -- surface included) with zero route changes — triggers maintain the rows.
    CREATE TRIGGER canvas_jobs_fts_insert AFTER INSERT ON jobs BEGIN
      INSERT INTO canvas_fts (text, source_id, source_kind)
      VALUES (NEW.prompt || ' ' || NEW.mode || ' ' || NEW.status || ' ' || COALESCE(NEW.error, ''), NEW.id, 'job');
    END;
    CREATE TRIGGER canvas_jobs_fts_delete AFTER DELETE ON jobs BEGIN
      DELETE FROM canvas_fts WHERE source_id = OLD.id AND source_kind = 'job';
    END;
    CREATE TRIGGER canvas_jobs_fts_update AFTER UPDATE ON jobs BEGIN
      DELETE FROM canvas_fts WHERE source_id = OLD.id AND source_kind = 'job';
      INSERT INTO canvas_fts (text, source_id, source_kind)
      VALUES (NEW.prompt || ' ' || NEW.mode || ' ' || NEW.status || ' ' || COALESCE(NEW.error, ''), NEW.id, 'job');
    END;

    -- §1 job extension (extend existing, additive + nullable): gpu queue
    -- state (L26), plan ref, failure diagnostics contract (F6 seam).
    ALTER TABLE jobs ADD COLUMN gpu_queue_state TEXT;
    ALTER TABLE jobs ADD COLUMN plan_ref TEXT;
    ALTER TABLE jobs ADD COLUMN failure_json TEXT;
  `)
}

// ---------------------------------------------------------------------------
// small helpers (module-local; the store's own reads tolerate a corrupt json
// blob by degrading to the default — never by crashing the route)
// ---------------------------------------------------------------------------
function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback
  try {
    const parsed = JSON.parse(raw) as T
    return parsed === null || parsed === undefined ? fallback : parsed
  } catch {
    return fallback
  }
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function intOrNull(value: unknown): number | null {
  const parsed = num(value)
  return parsed === null ? null : Math.trunc(parsed)
}

function now(): number {
  return Date.now()
}

function sha256Buffer(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function sha256File(path: string): string | null {
  try {
    return sha256Buffer(readFileSync(path))
  } catch {
    return null
  }
}

/** One row of the legacy character library, normalized just enough to import:
 *  an id and a body. Everything else rides verbatim in fields (L11 pattern). */
function libraryEntryKey(entry: unknown, index: number): string | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const record = entry as Record<string, unknown>
  const id = str(record.id) || str(record.name)
  return id || `index:${index}`
}

/** Collects every outputId referenced anywhere inside an input spec — the
 *  §2.1 recursion (fresh | outputRef | outputRefs[]) is walked leniently so
 *  an evolved-but-compatible spec still yields its fork edges (GC liveness
 *  must never MISS an edge because a new key appeared). */
function collectOutputRefs(value: unknown, into: Set<string>): void {
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

/** Collects every TAKE id pinned by an input spec — the fork-from-early-take
 *  edge (§2.1 outputRef.takeId). A pinned prior take is part of the live
 *  fork edge (§3 tier 1): GC must keep it resident exactly like the output's
 *  canonical take, or a latent fork of a prior take loses its substrate. */
function collectTakeRefs(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectTakeRefs(item, into)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if ((key === 'takeId' || key === 'take_id') && typeof child === 'string' && child) into.add(child)
    else collectTakeRefs(child, into)
  }
}

export type DocumentStoreOptions = {
  /** Content-addressed blob root (media + latents); created on demand. */
  blobRoot: string
  /** Writer app version stamped on documents (§2 refusal names it). */
  appVersion?: string
  /** Security hardening 1 (blob-read scoping): resolves the directories OUTSIDE
   *  the blob tree whose files may be REGISTERED into it (engine outputs, the
   *  output tree's canvas-media uploads, the studio home's app-owned stores).
   *  Registration copies + serves the file's bytes — an unscoped source would
   *  be an arbitrary-file-read primitive (`~/.ssh/id_rsa` as a take artifact).
   *  A resolver (not a static list) so settings changes are honored live.
   *  Absent = only the studio home (dirname of the blob root) is allowed. */
  allowedSourceRoots?: () => string[]
}

export type LegacyImportReport = {
  alreadyImported: boolean
  counts: {
    jobsSeen: number
    completedJobs: number
    takes: number
    failureOutputs: number
    skippedRunning: number
    prompts: number
    characters: number
    projectsSeeded: number
    blobHashChecks: number
    blobHashMismatches: number
  }
}

/** The canvas document store: pure functions over the shared better-sqlite3
 *  handle, prepared once. All multi-step mutations are transactions; every
 *  write stamps the document schema version; every project read guards the
 *  unknown-newer refusal (§2). */
export function createDocumentStore(db: Database.Database, options: DocumentStoreOptions) {
  const blobRoot = resolve(options.blobRoot)
  const appVersion = options.appVersion ?? resolveStudioAppVersion()

  /** Security hardening 1: containment gate for blob REGISTRATION sources.
   *  Legal sources are the studio home (the app-owned tree the blob root
   *  lives in) plus the resolver's roots (the configured output directory).
   *  Same lexical containment shape the media routes use. */
  function isAllowedBlobSource(path: string): boolean {
    const candidate = resolve(path)
    const roots = [dirname(blobRoot), ...(options.allowedSourceRoots?.() ?? []).map((root) => resolve(root))]
    return roots.some((root) => {
      const rel = relative(root, candidate)
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
    })
  }

  // ---- statements ----------------------------------------------------------
  const statements = {
    insertProject: db.prepare(`
      INSERT INTO canvas_project (id, name, schema_version, camera_json, settings_defaults_json, app_version, created_at, deleted_at, last_active_at)
      VALUES (@id, @name, @schema_version, @camera_json, @settings_defaults_json, @app_version, @created_at, NULL, @created_at)
    `),
    getProject: db.prepare('SELECT * FROM canvas_project WHERE id = ?'),
    listProjects: db.prepare('SELECT * FROM canvas_project WHERE deleted_at IS NULL ORDER BY last_active_at DESC, rowid ASC'),
    listTrashedProjects: db.prepare('SELECT * FROM canvas_project WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC'),
    touchProject: db.prepare('UPDATE canvas_project SET last_active_at = ? WHERE id = ?'),
    renameProject: db.prepare('UPDATE canvas_project SET name = ?, last_active_at = ? WHERE id = ?'),
    setProjectCamera: db.prepare('UPDATE canvas_project SET camera_json = ?, last_active_at = ? WHERE id = ?'),
    setProjectSettingsDefaults: db.prepare('UPDATE canvas_project SET settings_defaults_json = ?, last_active_at = ? WHERE id = ?'),
    tombstoneProject: db.prepare('UPDATE canvas_project SET deleted_at = ?, last_active_at = ? WHERE id = ? AND deleted_at IS NULL'),
    restoreProject: db.prepare('UPDATE canvas_project SET deleted_at = NULL, last_active_at = ? WHERE id = ? AND deleted_at IS NOT NULL'),

    getSession: db.prepare('SELECT * FROM canvas_session WHERE id = ?'),
    upsertSession: db.prepare(`
      INSERT INTO canvas_session (id, schema_version, open_projects_json, active_project, app_version, updated_at)
      VALUES (1, @schema_version, @open_projects_json, @active_project, @app_version, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        schema_version = excluded.schema_version, open_projects_json = excluded.open_projects_json,
        active_project = excluded.active_project, app_version = excluded.app_version, updated_at = excluded.updated_at
    `),

    insertChain: db.prepare(`
      INSERT INTO canvas_chain (id, project_id, kind, input_spec_json, op_stack_id, settings_json, lock_state, hop_count, drift_metrics_json, stale, created_at, deleted_at)
      VALUES (@id, @project_id, @kind, @input_spec_json, @op_stack_id, @settings_json, @lock_state, @hop_count, @drift_metrics_json, 0, @created_at, NULL)
    `),
    setChainOpStack: db.prepare('UPDATE canvas_chain SET op_stack_id = ? WHERE id = ?'),
    getChain: db.prepare('SELECT * FROM canvas_chain WHERE id = ?'),
    chainsByProject: db.prepare('SELECT * FROM canvas_chain WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at, rowid ASC'),
    allLiveChains: db.prepare('SELECT * FROM canvas_chain WHERE deleted_at IS NULL'),
    setChainSettings: db.prepare('UPDATE canvas_chain SET settings_json = ?, lock_state = ?, hop_count = ?, drift_metrics_json = ? WHERE id = ?'),
    setInputSpec: db.prepare('UPDATE canvas_chain SET input_spec_json = ? WHERE id = ?'),
    setChainStale: db.prepare('UPDATE canvas_chain SET stale = ? WHERE id = ?'),
    tombstoneChain: db.prepare('UPDATE canvas_chain SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL'),
    restoreChain: db.prepare('UPDATE canvas_chain SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL'),

    insertOutput: db.prepare('INSERT INTO canvas_output (id, chain_id, substrates_available_json, created_at) VALUES (?, ?, ?, ?)'),
    output: db.prepare('SELECT * FROM canvas_output WHERE id = ?'),
    outputsByChain: db.prepare('SELECT * FROM canvas_output WHERE chain_id = ? ORDER BY created_at, rowid ASC'),
    outputsByChains: db.prepare('SELECT o.* FROM canvas_output o JOIN canvas_chain c ON c.id = o.chain_id WHERE c.project_id = ?'),

    insertTake: db.prepare(`
      INSERT INTO canvas_take (id, output_id, job_id, artifacts_json, latent_path, metrics_json, created_at, superseded_by, evicted, evicted_at, content_hash)
      VALUES (@id, @output_id, @job_id, @artifacts_json, @latent_path, @metrics_json, @created_at, NULL, 0, NULL, @content_hash)
    `),
    take: db.prepare('SELECT * FROM canvas_take WHERE id = ?'),
    takeByJob: db.prepare('SELECT * FROM canvas_take WHERE job_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1'),
    nonEvictedTakes: db.prepare('SELECT id, artifacts_json, latent_path FROM canvas_take WHERE evicted = 0'),
    takesByOutput: db.prepare('SELECT * FROM canvas_take WHERE output_id = ? ORDER BY created_at DESC, rowid DESC'),
    canonicalTake: db.prepare('SELECT * FROM canvas_take WHERE output_id = ? AND superseded_by IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1'),
    supersedeTake: db.prepare('UPDATE canvas_take SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL'),
    markEvicted: db.prepare('UPDATE canvas_take SET evicted = 1, evicted_at = ? WHERE id = ? AND evicted = 0'),
    takesByOutputs: db.prepare('SELECT t.* FROM canvas_take t JOIN canvas_output o ON o.id = t.output_id WHERE o.chain_id = ?'),

    insertOpStack: db.prepare('INSERT INTO canvas_op_stack (id, chain_id, created_at) VALUES (?, ?, ?)'),
    insertOp: db.prepare('INSERT INTO canvas_op (id, stack_id, ordinal, kind, settings_json, baked_at) VALUES (?, ?, ?, ?, ?, NULL)'),
    opsByChain: db.prepare(`
      SELECT op.* FROM canvas_op op JOIN canvas_op_stack s ON s.id = op.stack_id WHERE s.chain_id = ? ORDER BY op.ordinal ASC
    `),
    opsByStack: db.prepare('SELECT * FROM canvas_op WHERE stack_id = ? ORDER BY ordinal ASC'),
    op: db.prepare('SELECT * FROM canvas_op WHERE id = ?'),
    nextOpOrdinal: db.prepare('SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM canvas_op WHERE stack_id = ?'),
    setOpOrdinal: db.prepare('UPDATE canvas_op SET ordinal = ? WHERE id = ?'),
    setOpSettings: db.prepare('UPDATE canvas_op SET settings_json = ? WHERE id = ?'),
    bakeOp: db.prepare('UPDATE canvas_op SET baked_at = ? WHERE id = ? AND baked_at IS NULL'),
    deleteOp: db.prepare('DELETE FROM canvas_op WHERE id = ?'),

    upsertIdentity: db.prepare(`
      INSERT INTO canvas_identity_payload (id, chain_id, ref_asset_ids_json, refmod_ids_json, subject_text, strength, per_slot_strengths_json, updated_at)
      VALUES (@id, @chain_id, @ref_asset_ids_json, @refmod_ids_json, @subject_text, @strength, @per_slot_strengths_json, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        ref_asset_ids_json = excluded.ref_asset_ids_json, refmod_ids_json = excluded.refmod_ids_json,
        subject_text = excluded.subject_text, strength = excluded.strength,
        per_slot_strengths_json = excluded.per_slot_strengths_json, updated_at = excluded.updated_at
    `),
    identityByChain: db.prepare('SELECT * FROM canvas_identity_payload WHERE chain_id = ?'),

    insertControlTrack: db.prepare(`
      INSERT INTO canvas_control_track (id, chain_id, kind, source, input_ref, mask_ref, params_json)
      VALUES (@id, @chain_id, @kind, @source, @input_ref, @mask_ref, @params_json)
    `),
    controlTracksByChain: db.prepare('SELECT * FROM canvas_control_track WHERE chain_id = ?'),
    trackByRef: db.prepare('SELECT id FROM canvas_control_track WHERE input_ref = ? OR mask_ref = ? LIMIT 1'),
    deleteControlTrack: db.prepare('DELETE FROM canvas_control_track WHERE id = ?'),

    insertAsset: db.prepare(`
      INSERT INTO canvas_asset (id, kind, fields_json, canonical_reference_set_json, created_at, deleted_at)
      VALUES (@id, @kind, @fields_json, @canonical_reference_set_json, @created_at, NULL)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind, fields_json = excluded.fields_json,
        canonical_reference_set_json = excluded.canonical_reference_set_json
    `),
    asset: db.prepare('SELECT * FROM canvas_asset WHERE id = ?'),
    listAssets: db.prepare('SELECT * FROM canvas_asset WHERE deleted_at IS NULL ORDER BY created_at DESC, rowid ASC'),
    listTrashedAssets: db.prepare('SELECT * FROM canvas_asset WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC'),
    tombstoneAsset: db.prepare('UPDATE canvas_asset SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL'),
    restoreAsset: db.prepare('UPDATE canvas_asset SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL'),

    insertAssetFork: db.prepare(`
      INSERT INTO canvas_asset_fork (project_id, asset_id, forked_settings_snapshot_json, lineage_json, consent_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, asset_id) DO UPDATE SET
        forked_settings_snapshot_json = excluded.forked_settings_snapshot_json,
        lineage_json = excluded.lineage_json, consent_at = excluded.consent_at
    `),
    assetForksByProject: db.prepare('SELECT * FROM canvas_asset_fork WHERE project_id = ?'),

    insertPlan: db.prepare(`
      INSERT INTO canvas_plan (id, project_id, schema_version, document_json, app_version, created_at, updated_at)
      VALUES (@id, @project_id, @schema_version, @document_json, @app_version, @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        document_json = excluded.document_json, schema_version = excluded.schema_version,
        app_version = excluded.app_version, updated_at = excluded.updated_at
    `),
    plan: db.prepare('SELECT * FROM canvas_plan WHERE id = ?'),
    trashedChains: db.prepare('SELECT * FROM canvas_chain WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC'),
    trashedChainsByProject: db.prepare('SELECT * FROM canvas_chain WHERE deleted_at IS NOT NULL AND project_id = ? ORDER BY deleted_at DESC'),
    plansByProject: db.prepare('SELECT * FROM canvas_plan WHERE project_id = ? ORDER BY updated_at DESC'),

    upsertBlob: db.prepare(`
      INSERT INTO canvas_blob (path, kind, content_hash, size, last_verified_at, missing, relinked_from)
      VALUES (@path, @kind, @content_hash, @size, @last_verified_at, @missing, @relinked_from)
      ON CONFLICT(path) DO UPDATE SET
        kind = excluded.kind, content_hash = excluded.content_hash, size = excluded.size,
        last_verified_at = excluded.last_verified_at, missing = excluded.missing
    `),
    blob: db.prepare('SELECT * FROM canvas_blob WHERE path = ?'),
    blobsByHash: db.prepare('SELECT * FROM canvas_blob WHERE content_hash = ?'),
    listBlobs: db.prepare('SELECT * FROM canvas_blob'),
    listMissingBlobs: db.prepare('SELECT * FROM canvas_blob WHERE missing = 1'),
    setBlobMissing: db.prepare('UPDATE canvas_blob SET missing = ?, last_verified_at = ? WHERE path = ?'),
    setBlobRelinked: db.prepare('UPDATE canvas_blob SET missing = 0, relinked_from = ?, last_verified_at = ? WHERE path = ?'),

    ftsPut: db.prepare('DELETE FROM canvas_fts WHERE source_id = ? AND source_kind = ?'),
    ftsInsert: db.prepare('INSERT INTO canvas_fts (text, source_id, source_kind) VALUES (?, ?, ?)'),
    ftsSearch: db.prepare(`
      SELECT source_id, source_kind, rank FROM canvas_fts WHERE canvas_fts MATCH ? ORDER BY rank LIMIT ?
    `),
    // kind-filtered variant: the filter belongs INSIDE the query, before the
    // LIMIT — filtering after would let other kinds fill the limit first and
    // return empty while matches exist beyond the cut.
    ftsSearchKind: db.prepare(`
      SELECT source_id, source_kind, rank FROM canvas_fts WHERE canvas_fts MATCH ? AND source_kind = ? ORDER BY rank LIMIT ?
    `),
    ftsBackfillJobs: db.prepare(`
      INSERT INTO canvas_fts (text, source_id, source_kind)
      SELECT j.prompt || ' ' || j.mode || ' ' || j.status || ' ' || COALESCE(j.error, ''), j.id, 'job'
      FROM jobs j
      WHERE NOT EXISTS (SELECT 1 FROM canvas_fts f WHERE f.source_kind = 'job' AND f.source_id = j.id)
    `),

    setJobQueueState: db.prepare('UPDATE jobs SET gpu_queue_state = ?, plan_ref = ?, failure_json = ? WHERE id = ?'),
    job: db.prepare('SELECT * FROM jobs WHERE id = ?'),

    getImportMarker: db.prepare('SELECT * FROM canvas_import_marker WHERE id = ?'),
    setImportMarker: db.prepare('INSERT INTO canvas_import_marker (id, imported_at, counts_json) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING'),
  }

  // ---- §2 version guard -----------------------------------------------------
  /** Throws CanvasSchemaVersionError when a persisted document version is
   *  newer than this build understands. Never downgrades, never reshapes. */
  function guardDocumentVersion(schemaVersion: unknown, appVersionOfWriter: unknown, what: string): number {
    const found = intOrNull(schemaVersion)
    if (found === null) throw new CanvasSchemaVersionError(Number.NaN, CANVAS_SCHEMA_VERSION, str(appVersionOfWriter), what)
    if (found > CANVAS_SCHEMA_VERSION) throw new CanvasSchemaVersionError(found, CANVAS_SCHEMA_VERSION, str(appVersionOfWriter), what)
    return found
  }

  function guardProject(project: Record<string, unknown> | undefined) {
    if (!project) return undefined
    guardDocumentVersion(project.schema_version, project.app_version, `project "${project.name}"`)
    return project
  }

  // ---- FTS (§4) --------------------------------------------------------------
  function ftsIndex(sourceId: string, kind: string, text: string) {
    statements.ftsPut.run(sourceId, kind)
    if (text.trim()) statements.ftsInsert.run(text, sourceId, kind)
  }

  function chainPromptText(inputSpec: unknown, settings: unknown): string {
    const parts: string[] = []
    const spec = parseJson<Record<string, unknown>>(inputSpec, {})
    const fresh = spec.fresh
    if (fresh && typeof fresh === 'object') {
      const prompt = (fresh as Record<string, unknown>).prompt
      if (typeof prompt === 'string') parts.push(prompt)
    }
    const settingsRecord = parseJson<Record<string, unknown>>(settings, {})
    for (const key of ['prompt', 'subjectText']) {
      const value = settingsRecord[key]
      if (typeof value === 'string' && value) parts.push(value)
    }
    return parts.join(' ')
  }

  function indexChain(chain: Record<string, unknown>) {
    ftsIndex(str(chain.id), 'chain', chainPromptText(chain.input_spec_json, chain.settings_json))
  }

  function indexAsset(asset: Record<string, unknown>) {
    const fields = parseJson<Record<string, unknown>>(asset.fields_json, {})
    const text = [fields.label, fields.name, fields.prompt, fields.description, fields.subjectText]
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
    ftsIndex(str(asset.id), 'asset', text)
  }

  function indexPlan(plan: Record<string, unknown>) {
    const document = parseJson<Record<string, unknown>>(plan.document_json, {})
    const brief = document.brief
    ftsIndex(str(plan.id), 'plan', typeof brief === 'string' ? brief : JSON.stringify(document).slice(0, 2000))
  }

  function indexTake(take: Record<string, unknown>) {
    const metrics = str(take.metrics_json)
    const artifacts = str(take.artifacts_json)
    const hash = str(take.content_hash)
    const job = take.job_id ? (statements.job.get(take.job_id) as Record<string, unknown> | undefined) : undefined
    const jobPrompt = job && typeof job.prompt === 'string' ? job.prompt : ''
    ftsIndex(str(take.id), 'take', [jobPrompt, metrics, artifacts, hash].filter(Boolean).join(' '))
  }

  // ---- blobs (§1 blob, §3 tier 2, F8 seam) -----------------------------------

  function blobRelativePath(hash: string): string {
    return join('canvas-blobs', hash.slice(0, 2), hash)
  }

  function blobAbsolutePath(relPath: string): string {
    return resolve(blobRoot, '..', relPath)
  }

  /** True only for paths that resolve INSIDE the blob root — the eviction
   *  sweep deletes files exclusively through this gate, so a registered
   *  engine-output path outside the tree is marked evicted but its file is
   *  left alone (restore = re-fetch from the engine, never our delete). */
  function isInsideBlobRoot(absPath: string): boolean {
    const rel = relative(blobRoot, absPath)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  }

  /** Registers a file into the content-addressed blob tree: hash, copy (or
   *  dedupe), upsert the row. Returns the registered relative path + hash, or
   *  a missing-marker registration when the file is absent (visible
   *  degradation — invariant 9 — never a silent skip).
   *  Torn-copy safety (M6): copies land at a staged name and are renamed
   *  into place atomically — a crash/ENOSPC mid-copy can never leave a
   *  truncated file at the canonical hash path. The dedupe-skip path
   *  re-verifies (size, then hash) instead of trusting the existing target:
   *  a torn copy from an older run is detected and repaired, never served as
   *  verified content.
   *  Security hardening 1: the SOURCE path must sit inside an allowed root —
   *  registration copies and later serves the bytes, so an unscoped source is
   *  an arbitrary-file-read primitive. Out-of-scope sources are refused
   *  LOUDLY (thrown error naming the file), never silently copied. */
  function registerBlobFile(kind: string, path: string): { relPath: string; hash: string | null; size: number | null; present: boolean } {
    if (!isAllowedBlobSource(path)) throw new Error(`Refusing to register "${path}" as a blob: the file is outside the studio home and the configured output directory.`)
    const hash = sha256File(path)
    if (!hash) {
      // Absent source: register a missing placeholder keyed by a stable
      // pseudo-path (the original location) so the failure is queryable.
      const relPath = join('canvas-blobs', 'unverified', hashPathKey(path))
      statements.upsertBlob.run({ path: relPath, kind, content_hash: `unverified:${path}`, size: null, last_verified_at: 0, missing: 1, relinked_from: null })
      return { relPath, hash: null, size: null, present: false }
    }
    const relPath = blobRelativePath(hash)
    const absTarget = join(blobRoot, hash.slice(0, 2), hash)
    const sourceSize = statSync(path).size
    const copyAtomic = () => {
      const staged = `${absTarget}.tmp-${randomUUID().slice(0, 8)}`
      mkdirSync(dirname(absTarget), { recursive: true })
      try {
        copyFileSync(path, staged)
        renameSync(staged, absTarget)
      } catch (error) {
        try {
          unlinkSync(staged)
        } catch {
          // The staged name is never the canonical path — a leftover is
          // inert (nothing resolves it); the error itself propagates.
        }
        throw error
      }
    }
    if (existsSync(absTarget)) {
      let trustworthy = false
      try {
        trustworthy = statSync(absTarget).size === sourceSize && sha256File(absTarget) === hash
      } catch {
        trustworthy = false
      }
      if (!trustworthy) copyAtomic()
    } else {
      copyAtomic()
    }
    const size = statSync(absTarget).size
    statements.upsertBlob.run({ path: relPath, kind, content_hash: hash, size, last_verified_at: now(), missing: 0, relinked_from: null })
    return { relPath, hash, size, present: true }
  }

  function hashPathKey(path: string): string {
    return createHash('sha256').update(path).digest('hex')
  }

  /** Blob kind from a file path (§1 blob kinds) — media kind inference for
   *  registrations that arrive without an explicit kind. */
  function blobKindForPath(path: string, fallback: string): string {
    const extension = extname(path).toLowerCase()
    if (['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(extension)) return 'image'
    if (['.mp4', '.webm', '.mov', '.mkv', '.avi'].includes(extension)) return 'video'
    if (['.mp3', '.wav', '.ogg', '.flac', '.m4a'].includes(extension)) return 'audio'
    if (['.latent', '.safetensors', '.pt', '.bin'].includes(extension)) return 'latent'
    return fallback
  }

  /** Verifies a blob's content against its registered hash (spot-checks +
   *  the archive import use this). Marks missing on absence/mismatch. */
  function verifyBlob(relPath: string): 'ok' | 'mismatch' | 'missing' {
    const row = statements.blob.get(relPath) as Record<string, unknown> | undefined
    if (!row) return 'missing'
    const hash = str(row.content_hash)
    if (hash.startsWith('unverified:')) {
      statements.setBlobMissing.run(1, now(), relPath)
      return 'missing'
    }
    const actual = sha256File(blobAbsolutePath(relPath))
    if (actual === null) {
      statements.setBlobMissing.run(1, now(), relPath)
      return 'missing'
    }
    if (actual !== hash) {
      statements.setBlobMissing.run(1, now(), relPath)
      return 'mismatch'
    }
    statements.setBlobMissing.run(0, now(), relPath)
    return 'ok'
  }

  /** F8 seam (minimal honest version): hash-match auto-relink of missing
   *  blobs over user-nominated roots. Bounded walk (depth + file cap) so a
   *  nominated root can never turn into an unbounded scan. */
  function relinkBlobs(roots: string[]): { relinked: number; stillMissing: number } {
    let relinked = 0
    const missing = statements.listMissingBlobs.all() as Array<Record<string, unknown>>
    if (!missing.length) return { relinked: 0, stillMissing: 0 }
    const wanted = new Map<string, Record<string, unknown>>()
    for (const row of missing) {
      const hash = str(row.content_hash)
      if (!hash.startsWith('unverified:')) wanted.set(hash, row)
    }
    const stillMissingHashes = new Set(wanted.keys())
    const fileBudget = { remaining: 20_000 }
    for (const root of roots.slice(0, 16)) {
      if (!stillMissingHashes.size) break
      walkRoot(resolve(str(root)), 0, (filePath) => {
        if (!stillMissingHashes.size || fileBudget.remaining <= 0) return
        fileBudget.remaining -= 1
        const hash = sha256File(filePath)
        if (hash && stillMissingHashes.has(hash)) {
          const row = wanted.get(hash) as Record<string, unknown>
          const target = join(blobRoot, hash.slice(0, 2), hash)
          mkdirSync(dirname(target), { recursive: true })
          copyFileSync(filePath, target)
          statements.setBlobRelinked.run(filePath, now(), str(row.path))
          stillMissingHashes.delete(hash)
          relinked += 1
        }
      })
    }
    return { relinked, stillMissing: stillMissingHashes.size }
  }

  function walkRoot(dir: string, depth: number, visit: (filePath: string) => void) {
    if (depth > 4) return
    let entries: Array<{ name: string; isFile: boolean; isDirectory: boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true }).map((entry) => ({ name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory() }))
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory) walkRoot(full, depth + 1, visit)
      else if (entry.isFile) visit(full)
    }
  }

  // ---- hydration -------------------------------------------------------------
  function hydrateProject(row: Record<string, unknown>) {
    guardProject(row)
    return {
      id: str(row.id),
      name: str(row.name),
      schemaVersion: Number(row.schema_version),
      camera: parseJson<Record<string, unknown>>(row.camera_json, {}),
      settingsDefaults: parseJson<Record<string, unknown>>(row.settings_defaults_json, {}),
      appVersion: str(row.app_version),
      createdAt: Number(row.created_at),
      deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
      lastActiveAt: Number(row.last_active_at),
    }
  }

  /** One listable project + the per-row report for rows this build refuses
   *  to open (M4) — visible to the caller, invisible to the boot path. */
  type ProjectListing = {
    projects: Array<ReturnType<typeof hydrateProject>>
    skipped: Array<{ id: string; name: string; schemaVersion: number | null; writerAppVersion: string }>
  }

  function listProjectRows(rows: Array<Record<string, unknown>>): ProjectListing {
    const projects: ProjectListing['projects'] = []
    const skipped: ProjectListing['skipped'] = []
    for (const row of rows) {
      const found = intOrNull(row.schema_version)
      if (found === null || found > CANVAS_SCHEMA_VERSION) {
        skipped.push({ id: str(row.id), name: str(row.name), schemaVersion: found, writerAppVersion: str(row.app_version) })
        continue
      }
      projects.push(hydrateProject(row))
    }
    return { projects, skipped }
  }

  function hydrateChain(row: Record<string, unknown>) {
    return {
      id: str(row.id),
      projectId: str(row.project_id),
      kind: str(row.kind),
      inputSpec: parseJson<Record<string, unknown>>(row.input_spec_json, {}),
      opStackId: row.op_stack_id === null ? null : str(row.op_stack_id),
      settings: parseJson<Record<string, unknown>>(row.settings_json, {}),
      lockState: str(row.lock_state),
      hopCount: Number(row.hop_count ?? 0),
      driftMetrics: parseJson<Record<string, unknown> | null>(row.drift_metrics_json, null),
      stale: Number(row.stale) === 1,
      createdAt: Number(row.created_at),
      deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
    }
  }

  function hydrateTake(row: Record<string, unknown>) {
    return {
      id: str(row.id),
      outputId: str(row.output_id),
      jobId: row.job_id === null ? null : str(row.job_id),
      artifacts: parseJson<string[]>(row.artifacts_json, []),
      latentPath: row.latent_path === null ? null : str(row.latent_path),
      metrics: parseJson<Record<string, unknown> | null>(row.metrics_json, null),
      createdAt: Number(row.created_at),
      supersededBy: row.superseded_by === null ? null : str(row.superseded_by),
      evicted: Number(row.evicted) === 1,
      evictedAt: row.evicted_at === null ? null : Number(row.evicted_at),
      contentHash: row.content_hash === null ? null : str(row.content_hash),
    }
  }

  function hydrateOutput(row: Record<string, unknown>) {
    const takes = (statements.takesByOutput.all(row.id) as Array<Record<string, unknown>>).map(hydrateTake)
    const canonical = takes.find((take) => take.supersededBy === null) ?? null
    return {
      id: str(row.id),
      chainId: str(row.chain_id),
      substratesAvailable: parseJson<string[]>(row.substrates_available_json, []),
      createdAt: Number(row.created_at),
      canonicalTakeId: canonical ? canonical.id : null,
      takes,
    }
  }

  // ---- document-read cache (perf wave 1) -------------------------------------
  //
  // GET /api/lan/documents/project re-hydrated and re-serialized the whole
  // graph on every request: at 300 objects that measured p99 ~400 ms at 16x
  // concurrency — the first hard cliff in docs/research/app-performance-
  // profile.md. The cache holds the serialized body + a content-hash ETag
  // per project; a hit costs two O(1) stamp reads and a socket write.
  //
  // Invalidation is FAIL-CLOSED, not seam-enumerated: the freshness stamp is
  // (PRAGMA data_version, total_changes()). total_changes() bumps on every
  // row THIS connection inserts/updates/deletes (any table — session, jobs,
  // FTS included); data_version bumps when ANY other connection commits. A
  // stamp change drops every entry, so no write path — present or future,
  // in-process or external — can serve a stale document. The price of that
  // conservatism (a rebuilt entry after an unrelated write) is exactly the
  // previous uncached behavior, never worse.
  type CachedProjectDocument = { etag: string; json: string; dataVersion: number; totalChanges: number }
  const documentReadCache = new Map<string, CachedProjectDocument>()
  const DOCUMENT_READ_CACHE_MAX = 4
  const totalChangesStatement = db.prepare('SELECT total_changes() AS n')
  const readWriteStamp = (): { dataVersion: number; totalChanges: number } => ({
    dataVersion: Number(db.pragma('data_version', { simple: true })),
    totalChanges: Number((totalChangesStatement.get() as { n: number | null }).n ?? 0),
  })

  /** The hydration fold behind both getProjectDocument and the read cache —
   *  unchanged behavior, extracted so the cached path builds exactly what
   *  the uncached path returns. */
  const foldProjectDocument = (id: string) => {
    const project = guardProject(statements.getProject.get(id) as Record<string, unknown> | undefined)
    if (!project) return null
    const chains = (statements.chainsByProject.all(id) as Array<Record<string, unknown>>).map((chainRow) => {
      const chain = hydrateChain(chainRow)
      const outputs = (statements.outputsByChain.all(chain.id) as Array<Record<string, unknown>>).map(hydrateOutput)
      const ops = (statements.opsByChain.all(chain.id) as Array<Record<string, unknown>>).map((op) => ({
        id: str(op.id),
        stackId: str(op.stack_id),
        ordinal: Number(op.ordinal),
        kind: str(op.kind),
        settings: parseJson<Record<string, unknown>>(op.settings_json, {}),
        bakedAt: op.baked_at === null ? null : Number(op.baked_at),
      }))
      const identityRow = statements.identityByChain.get(chain.id) as Record<string, unknown> | undefined
      const identity = identityRow
        ? {
            id: str(identityRow.id),
            refAssetIds: parseJson<string[]>(identityRow.ref_asset_ids_json, []),
            refmodIds: parseJson<string[]>(identityRow.refmod_ids_json, []),
            subjectText: str(identityRow.subject_text),
            strength: Number(identityRow.strength),
            perSlotStrengths: parseJson<Record<string, number> | null>(identityRow.per_slot_strengths_json, null),
          }
        : null
      const controlTracks = (statements.controlTracksByChain.all(chain.id) as Array<Record<string, unknown>>).map((track) => ({
        id: str(track.id),
        kind: str(track.kind),
        source: str(track.source),
        inputRef: str(track.input_ref),
        maskRef: track.mask_ref === null ? null : str(track.mask_ref),
        params: parseJson<Record<string, unknown> | null>(track.params_json, null),
      }))
      return { ...chain, outputs, ops, identity, controlTracks }
    })
    const plans = (statements.plansByProject.all(id) as Array<Record<string, unknown>>).map((plan) => {
      guardDocumentVersion(plan.schema_version, plan.app_version, `plan "${plan.id}"`)
      return {
        id: str(plan.id),
        projectId: id,
        schemaVersion: Number(plan.schema_version),
        document: parseJson<Record<string, unknown>>(plan.document_json, {}),
        createdAt: Number(plan.created_at),
        updatedAt: Number(plan.updated_at),
      }
    })
    const assetForks = (statements.assetForksByProject.all(id) as Array<Record<string, unknown>>).map((fork) => ({
      projectId: str(fork.project_id),
      assetId: str(fork.asset_id),
      forkedSettingsSnapshot: parseJson<Record<string, unknown>>(fork.forked_settings_snapshot_json, {}),
      lineage: parseJson<Record<string, unknown> | null>(fork.lineage_json, null),
      consentAt: Number(fork.consent_at),
    }))
    return { project: hydrateProject(project), chains, plans, assetForks }
  }

  // ---- retention / GC (§3) ----------------------------------------------------

  /** MARK phase: the set of take ids whose latents must stay resident.
   *  Tier 1 = canonical takes of every live chain's outputs, PLUS canonical
   *  takes of every output referenced by a live chain's input spec (the fork
   *  edges — this is what keeps a forked take alive even when its SOURCE
   *  chain is tombstoned), PLUS takes explicitly pinned by a fork edge's
   *  takeId (§3 "takes referenced by a live fork edge" — a substrate=latents
   *  fork of a PRIOR take keeps that prior's latent resident), PLUS every
   *  take of a locked chain. Derived by walking the actual fork edges —
   *  never a reference-counting guess. */
  function liveTakeIds(): Set<string> {
    const live = new Set<string>()
    const liveChains = statements.allLiveChains.all() as Array<Record<string, unknown>>
    // fork edges: every output referenced by a live chain's input spec, and
    // every take a fork edge pins explicitly
    const referencedOutputs = new Set<string>()
    for (const chain of liveChains) {
      const refs = new Set<string>()
      collectOutputRefs(parseJson<unknown>(chain.input_spec_json, {}), refs)
      for (const outputId of refs) referencedOutputs.add(outputId)
      const takeRefs = new Set<string>()
      collectTakeRefs(parseJson<unknown>(chain.input_spec_json, {}), takeRefs)
      for (const takeId of takeRefs) live.add(takeId)
    }
    for (const chain of liveChains) {
      const locked = str(chain.lock_state) === 'locked'
      for (const output of statements.outputsByChain.all(chain.id) as Array<Record<string, unknown>>) {
        const outputId = str(output.id)
        const canonical = statements.canonicalTake.get(outputId) as Record<string, unknown> | undefined
        if (canonical) live.add(str(canonical.id))
        if (locked) {
          // locked chains: ALL takes resident (tier 1)
          for (const take of statements.takesByOutput.all(outputId) as Array<Record<string, unknown>>) live.add(str(take.id))
        }
      }
    }
    // fork-edge liveness even when the source chain is tombstoned
    for (const outputId of referencedOutputs) {
      const canonical = statements.canonicalTake.get(outputId) as Record<string, unknown> | undefined
      if (canonical) live.add(str(canonical.id))
    }
    return live
  }

  /** True when any OTHER non-evicted take or control track still references
   *  the given blob path. Content-addressed paths are SHARED by content:
   *  identical bytes (FLF continuation frames of adjacent segments,
   *  fixed-seed reruns) collapse to one file — evicting one take must never
   *  delete the file a live canonical take still serves. The same discipline
   *  emptyTrash's referencedNow walk applies, checked per unlink. */
  function blobStillReferenced(relPath: string, excludingTakeId: string): boolean {
    for (const other of statements.nonEvictedTakes.all() as Array<Record<string, unknown>>) {
      if (str(other.id) === excludingTakeId) continue
      if (parseJson<string[]>(other.artifacts_json, []).includes(relPath)) return true
      if (typeof other.latent_path === 'string' && other.latent_path === relPath) return true
    }
    return Boolean(statements.trackByRef.get(relPath, relPath))
  }

  /** Evicts one tier-2 take: delete the latent/blob FILE (only inside the
   *  blob root, only when no other take/control track still references it),
   *  keep the row + metadata (restore = re-generate/re-fetch — settings
   *  persist, rerun-stable by invariant 1). Returns files deleted. */
  function evictTake(takeId: string): number {
    const take = statements.take.get(takeId) as Record<string, unknown> | undefined
    if (!take || Number(take.evicted) === 1) return 0
    let deletedFiles = 0
    const paths = parseJson<string[]>(take.artifacts_json, [])
    if (take.latent_path && typeof take.latent_path === 'string') paths.push(take.latent_path)
    for (const relPath of paths) {
      if (!relPath) continue
      const absPath = relPath.startsWith('canvas-blobs') ? blobAbsolutePath(relPath) : resolve(relPath)
      if (isInsideBlobRoot(absPath) && existsSync(absPath)) {
        if (blobStillReferenced(relPath, takeId)) continue // shared content: the file outlives this take's claim on it
        try {
          unlinkSync(absPath)
          deletedFiles += 1
        } catch { /* best-effort file removal; the marker is the contract */ }
        statements.setBlobMissing.run(1, now(), relPath)
      }
    }
    statements.markEvicted.run(now(), takeId)
    return deletedFiles
  }

  /** SWEEP: evict every superseded prior not in the live set. Trash is
   *  EXCLUDED — tombstoned chains/projects retain their blobs until the
   *  trash is explicitly emptied (§3). Runs at session-prune or
   *  storage-pressure triggers. */
  const sweep = db.transaction((): { evicted: number; filesDeleted: number } => {
    const live = liveTakeIds()
    let evicted = 0
    let filesDeleted = 0
    const candidates = db.prepare(`
      SELECT t.id FROM canvas_take t
      JOIN canvas_output o ON o.id = t.output_id
      JOIN canvas_chain c ON c.id = o.chain_id
      JOIN canvas_project p ON p.id = c.project_id
      WHERE t.evicted = 0 AND t.superseded_by IS NOT NULL
        AND c.deleted_at IS NULL AND p.deleted_at IS NULL
    `).all() as Array<{ id: string }>
    for (const candidate of candidates) {
      if (live.has(candidate.id)) continue
      filesDeleted += evictTake(candidate.id)
      evicted += 1
    }
    return { evicted, filesDeleted }
  })

  /** Session-scoped prune (§3 / L29): bulk-evict the non-canonical,
   *  non-locked takes of the given projects (default: the session's open
   *  projects), then run the sweep. Canonical and locked-chain takes are
   *  untouchable here — tested adversarially. */
  const pruneProjects = db.transaction((projectIds: string[]): { prunedTakes: number; filesDeleted: number; sweepEvicted: number } => {
    let prunedTakes = 0
    let filesDeleted = 0
    for (const projectId of projectIds) {
      const chains = db.prepare('SELECT * FROM canvas_chain WHERE project_id = ? AND deleted_at IS NULL').all(projectId) as Array<Record<string, unknown>>
      for (const chain of chains) {
        if (str(chain.lock_state) === 'locked') continue
        for (const take of statements.takesByOutputs.all(chain.id) as Array<Record<string, unknown>>) {
          if (take.superseded_by === null || Number(take.evicted) === 1) continue
          filesDeleted += evictTake(str(take.id))
          prunedTakes += 1
        }
      }
    }
    const sweepResult = sweep()
    return { prunedTakes, filesDeleted, sweepEvicted: sweepResult.evicted }
  })

  /** Empty trash — the EXPLICIT destructive act (§3): hard-deletes tombstoned
   *  projects/chains/assets, their sub-rows, and blob files nothing that
   *  remains still references. One transaction; the rows die together or not
   *  at all, and blob files are only removed when the last reference went. */
  const emptyTrash = db.transaction((): { projects: number; chains: number; assets: number; blobFilesDeleted: number } => {
    const trashedProjects = statements.listTrashedProjects.all() as Array<Record<string, unknown>>
    const trashedAssets = statements.listTrashedAssets.all() as Array<Record<string, unknown>>
    const projectIds = trashedProjects.map((row) => str(row.id))
    const chainIds = new Set<string>(
      (statements.trashedChains.all() as Array<Record<string, unknown>>).map((row) => str(row.id)),
    )
    for (const projectId of projectIds) {
      for (const chain of db.prepare('SELECT id FROM canvas_chain WHERE project_id = ?').all(projectId) as Array<{ id: string }>) chainIds.add(chain.id)
    }
    const assetIds = trashedAssets.map((row) => str(row.id))

    const takeIds: string[] = []
    const outputIds: string[] = []
    for (const chainId of chainIds) {
      for (const output of statements.outputsByChain.all(chainId) as Array<Record<string, unknown>>) {
        outputIds.push(str(output.id))
        for (const take of statements.takesByOutput.all(str(output.id)) as Array<Record<string, unknown>>) takeIds.push(str(take.id))
      }
    }
    const planIds = projectIds.flatMap((projectId) => (statements.plansByProject.all(projectId) as Array<Record<string, unknown>>).map((plan) => str(plan.id)))

    // children first (FK order)
    for (const chainId of chainIds) {
      db.prepare('DELETE FROM canvas_op WHERE stack_id IN (SELECT id FROM canvas_op_stack WHERE chain_id = ?)').run(chainId)
      db.prepare('DELETE FROM canvas_op_stack WHERE chain_id = ?').run(chainId)
      db.prepare('DELETE FROM canvas_identity_payload WHERE chain_id = ?').run(chainId)
      db.prepare('DELETE FROM canvas_control_track WHERE chain_id = ?').run(chainId)
    }
    for (const outputId of outputIds) db.prepare('DELETE FROM canvas_take WHERE output_id = ?').run(outputId)
    for (const takeId of takeIds) db.prepare('DELETE FROM canvas_fts WHERE source_kind = ? AND source_id = ?').run('take', takeId)
    for (const chainId of chainIds) db.prepare('DELETE FROM canvas_output WHERE chain_id = ?').run(chainId)
    for (const chainId of chainIds) {
      db.prepare('DELETE FROM canvas_fts WHERE source_kind = ? AND source_id = ?').run('chain', chainId)
      db.prepare('DELETE FROM canvas_chain WHERE id = ?').run(chainId)
    }
    for (const planId of planIds) db.prepare('DELETE FROM canvas_fts WHERE source_kind = ? AND source_id = ?').run('plan', planId)
    for (const projectId of projectIds) {
      db.prepare('DELETE FROM canvas_asset_fork WHERE project_id = ?').run(projectId)
      db.prepare('DELETE FROM canvas_plan WHERE project_id = ?').run(projectId)
      db.prepare('DELETE FROM canvas_chain WHERE project_id = ?').run(projectId)
      db.prepare('DELETE FROM canvas_project WHERE id = ?').run(projectId)
    }
    for (const assetId of assetIds) {
      db.prepare('DELETE FROM canvas_asset_fork WHERE asset_id = ?').run(assetId)
      db.prepare('DELETE FROM canvas_fts WHERE source_kind = ? AND source_id = ?').run('asset', assetId)
      db.prepare('DELETE FROM canvas_asset WHERE id = ?').run(assetId)
    }

    // blob files: delete only what no remaining take OR control track
    // references (control tracks' registered refs are document content too —
    // a pose-rig sheet must not lose its media to an unrelated trash-empty)
    let blobFilesDeleted = 0
    const referencedNow = new Set<string>()
    for (const take of db.prepare('SELECT * FROM canvas_take').all() as Array<Record<string, unknown>>) {
      for (const relPath of parseJson<string[]>(take.artifacts_json, [])) referencedNow.add(relPath)
      if (typeof take.latent_path === 'string' && take.latent_path) referencedNow.add(take.latent_path)
    }
    for (const track of db.prepare('SELECT input_ref, mask_ref FROM canvas_control_track').all() as Array<Record<string, unknown>>) {
      if (typeof track.input_ref === 'string' && track.input_ref) referencedNow.add(track.input_ref)
      if (typeof track.mask_ref === 'string' && track.mask_ref) referencedNow.add(track.mask_ref)
    }
    for (const blob of statements.listBlobs.all() as Array<Record<string, unknown>>) {
      const relPath = str(blob.path)
      if (referencedNow.has(relPath)) continue
      const absPath = blobAbsolutePath(relPath)
      if (isInsideBlobRoot(absPath) && existsSync(absPath)) {
        try {
          unlinkSync(absPath)
          blobFilesDeleted += 1
        } catch { /* best effort; the row removal is the contract */ }
      }
      db.prepare('DELETE FROM canvas_blob WHERE path = ?').run(relPath)
    }
    return { projects: projectIds.length, chains: chainIds.size, assets: assetIds.length, blobFilesDeleted }
  })

  // ---- staleness propagation (invariant 3 machinery) ---------------------------
  /** Marks every live chain whose input spec references an output of the
   *  given chain stale=1 (persisted derived state; nothing auto-executes).
   *  LOCKS GATE PROPAGATION (§7 P, coherent with switchCanonical and the
   *  unlock toast's contract): a locked chain stays pristine — it is pinned
   *  and does not go stale from upstream changes while locked. Cleared on
   *  rerun via setChainStale(id, false). */
  function propagateStaleness(chainId: string): number {
    const outputIds = new Set((statements.outputsByChain.all(chainId) as Array<Record<string, unknown>>).map((row) => str(row.id)))
    if (!outputIds.size) return 0
    let marked = 0
    for (const chain of statements.allLiveChains.all() as Array<Record<string, unknown>>) {
      if (str(chain.id) === chainId) continue
      if (str(chain.lock_state) === 'locked') continue
      const refs = new Set<string>()
      collectOutputRefs(parseJson<unknown>(chain.input_spec_json, {}), refs)
      for (const ref of refs) {
        if (outputIds.has(ref)) {
          statements.setChainStale.run(1, str(chain.id))
          marked += 1
          break
        }
      }
    }
    return marked
  }

  // ---- §6 legacy import --------------------------------------------------------
  /** The legacy import: jobs → outputs/takes on synthesized `legacy` chains,
   *  workspace → project settings defaults, saved prompts → prompt assets,
   *  (caller-supplied) library entries → global assets as curated reference
   *  sets (L13 recorded-open). Copy-never-destroy: sources are only ever
   *  READ. Deterministic ids make re-runs idempotent; the marker records
   *  completion; a failure throws with no marker → the next attempt retries
   *  clean. */
  const importLegacy = db.transaction((options: { characters?: unknown[]; force?: boolean }): LegacyImportReport => {
    const marker = statements.getImportMarker.get('legacy') as Record<string, unknown> | undefined
    if (marker && !options.force) {
      return { alreadyImported: true, counts: parseJson<LegacyImportReport['counts']>(marker.counts_json, {} as LegacyImportReport['counts']) }
    }
    const counts: LegacyImportReport['counts'] = {
      jobsSeen: 0, completedJobs: 0, takes: 0, failureOutputs: 0, skippedRunning: 0,
      prompts: 0, characters: 0, projectsSeeded: 0, blobHashChecks: 0, blobHashMismatches: 0,
    }

    // workspace → ONE initial project's chain-settings defaults (§6). The old
    // surface keeps reading workspace_state untouched until Phase 5.
    //
    // Phantom-seed fix (review M1, g5x37k8 2026-09-19): the project used to
    // seed UNCONDITIONALLY, so every fresh install grew an "Imported
    // workspace" card for a workspace that never existed (and the honest
    // "no other canvases yet" empty state could never appear). The seed now
    // requires actual legacy WORKSPACE content — jobs to import as chains,
    // or a saved workspace row with at least one key. Prompt/character
    // assets are projectless global assets and never justify a workspace.
    const legacyProjectId = 'legacy:project'
    const workspace = db.prepare("SELECT data_json FROM workspace_state WHERE name = 'create'").get() as { data_json: string } | undefined
    const defaults = workspace ? parseJson<Record<string, unknown>>(workspace.data_json, {}) : {}
    // jobs → outputs/takes (completed) / failure outputs (failed)
    const jobs = db.prepare('SELECT * FROM jobs ORDER BY created_at ASC, rowid ASC').all() as Array<Record<string, unknown>>
    const legacyPrompts = db.prepare('SELECT * FROM saved_prompts WHERE technique = 0').all() as Array<Record<string, unknown>>
    const workspaceHasContent = Boolean(workspace) && Object.keys(defaults).length > 0
    const seedLegacyProject = jobs.length > 0 || workspaceHasContent
    if (seedLegacyProject || statements.getProject.get(legacyProjectId)) {
      if (!statements.getProject.get(legacyProjectId)) {
        statements.insertProject.run({
          id: legacyProjectId,
          name: 'Imported workspace',
          schema_version: CANVAS_SCHEMA_VERSION,
          camera_json: '{}',
          settings_defaults_json: JSON.stringify(defaults),
          app_version: appVersion,
          created_at: now(),
        })
        counts.projectsSeeded = 1
      } else if (seedLegacyProject) {
        statements.setProjectSettingsDefaults.run(JSON.stringify(defaults), now(), legacyProjectId)
      }
    }
    counts.jobsSeen = jobs.length
    const spotChecks: Array<{ relPath: string; hash: string }> = []
    for (const job of jobs) {
      const jobId = str(job.id)
      const status = str(job.status)
      if (status === 'completed') {
        const chainId = `legacy:chain:${jobId}`
        if (!statements.getChain.get(chainId)) {
          // §6: "manifest = settings" — the job's reproducibility manifest is
          // the settings record; without one (older jobs) the params record
          // itself is the closest settings we ever had. artifacts = take.
          const params = parseJson<Record<string, unknown>>(job.params_json, {})
          const manifest = params.manifest && typeof params.manifest === 'object' && !Array.isArray(params.manifest) ? (params.manifest as Record<string, unknown>) : params
          const settings = { ...manifest }
          delete settings.graph
          delete settings.manifest
          const stackId = `legacy:stack:${jobId}`
          statements.insertChain.run({
            id: chainId,
            project_id: legacyProjectId,
            kind: 'legacy',
            input_spec_json: JSON.stringify({ fresh: { prompt: str(job.prompt) } }),
            op_stack_id: null,
            settings_json: JSON.stringify(settings),
            lock_state: 'unlocked',
            hop_count: 0,
            drift_metrics_json: null,
            created_at: intOrNull(job.created_at) ?? now(),
          })
          statements.insertOpStack.run(stackId, chainId, now())
          statements.setChainOpStack.run(stackId, chainId)
        }
        const outputId = `legacy:output:${jobId}`
        if (!statements.output.get(outputId)) {
          statements.insertOutput.run(outputId, `legacy:chain:${jobId}`, JSON.stringify(['decoded']), intOrNull(job.created_at) ?? now())
        }
        const takeId = `legacy:take:${jobId}`
        if (!statements.take.get(takeId)) {
          const artifactPath = mediaUrlToPath(str(job.output_url))
          let artifacts: string[] = []
          let contentHash: string | null = null
          if (artifactPath) {
            const registered = registerBlobFile(blobKindForPath(artifactPath, str(job.media_type) === 'audio' ? 'audio' : 'video'), artifactPath)
            if (registered.present && registered.hash) {
              artifacts = [registered.relPath]
              contentHash = registered.hash
              spotChecks.push({ relPath: registered.relPath, hash: registered.hash })
            } else {
              artifacts = [artifactPath]
            }
          }
          statements.insertTake.run({
            id: takeId,
            output_id: outputId,
            job_id: jobId,
            artifacts_json: JSON.stringify(artifacts),
            latent_path: null,
            metrics_json: JSON.stringify({ legacy: true, width: intOrNull(job.width), height: intOrNull(job.height), duration: num(job.duration) }),
            created_at: intOrNull(job.updated_at) ?? now(),
            content_hash: contentHash,
          })
          counts.takes += 1
        }
        counts.completedJobs += 1
      } else if (status === 'failed' || status === 'cancelled') {
        // Failed jobs import as visible, dismissable failure objects (§6:
        // durable-on-object applies retroactively). The take stays absent —
        // a failed generation produced no result; the failure is durable on
        // the job row + surfaced through the chain's legacy block (F6 seam).
        const chainId = `legacy:chain:${jobId}`
        if (!statements.getChain.get(chainId)) {
          const stackId = `legacy:stack:${jobId}`
          statements.insertChain.run({
            id: chainId,
            project_id: legacyProjectId,
            kind: 'legacy',
            input_spec_json: JSON.stringify({ fresh: { prompt: str(job.prompt) } }),
            op_stack_id: null,
            settings_json: JSON.stringify({ legacy: { jobId, status, error: str(job.error) || null, dismissed: false } }),
            lock_state: 'unlocked',
            hop_count: 0,
            drift_metrics_json: null,
            created_at: intOrNull(job.created_at) ?? now(),
          })
          statements.insertOpStack.run(stackId, chainId, now())
          statements.setChainOpStack.run(stackId, chainId)
        }
        const outputId = `legacy:output:${jobId}`
        if (!statements.output.get(outputId)) statements.insertOutput.run(outputId, chainId, '[]', intOrNull(job.created_at) ?? now())
        const failure = { stage: 'legacy', reason: str(job.error) || `job ${status}`, ref: jobId }
        db.prepare('UPDATE jobs SET failure_json = ? WHERE id = ? AND failure_json IS NULL').run(JSON.stringify(failure), jobId)
        counts.failureOutputs += 1
      } else {
        counts.skippedRunning += 1 // mid-flight jobs are not documents yet
      }
    }

    // prompt library → assets (kind: prompt). Technique corpus entries are
    // bundled app content (seeded server-side) — not user data, not copied
    // (same precedent as the localStorage migration). (legacyPrompts is read
    // above — the phantom-seed gate and this loop share one query.)
    for (const prompt of legacyPrompts) {
      const id = `legacy:prompt:${str(prompt.id)}`
      const fields = {
        label: str(prompt.label),
        prompt: str(prompt.prompt),
        negativePrompt: str(prompt.negative_prompt) || null,
        seed: prompt.seed === null ? null : Number(prompt.seed),
        sampler: str(prompt.sampler) || null,
        steps: prompt.steps === null ? null : Number(prompt.steps),
        cfgScale: prompt.cfg_scale === null ? null : Number(prompt.cfg_scale),
        source: parseJson<Record<string, unknown>>(prompt.source_json, {}) || null, // attribution rides verbatim (L11)
      }
      statements.insertAsset.run({ id, kind: 'prompt', fields_json: JSON.stringify(fields), canonical_reference_set_json: null, created_at: intOrNull(prompt.saved_at) || now() })
      counts.prompts += 1
    }

    // libraries → global assets as CURATED REFERENCE SETS (L13 recorded-open:
    // do NOT silently unify on takes). Characters are caller-supplied (the
    // in-memory synced library); wardrobe/location/accessory server stores do
    // not exist yet — their import lands with those stores (documented seam).
    for (let index = 0; index < (options.characters?.length ?? 0); index += 1) {
      const entry = options.characters?.[index]
      const key = libraryEntryKey(entry, index)
      if (!key) continue
      const record = entry as Record<string, unknown>
      const referenceSet = Array.isArray(record.referenceImages)
        ? record.referenceImages.filter((item): item is string => typeof item === 'string')
        : []
      statements.insertAsset.run({
        id: `legacy:character:${key}`,
        kind: 'character',
        fields_json: JSON.stringify(record),
        canonical_reference_set_json: JSON.stringify(referenceSet),
        created_at: now(),
      })
      counts.characters += 1
    }

    // FTS: backfill every job (the triggers only cover writes from now on)
    // and index the documents the import just created.
    statements.ftsBackfillJobs.run()
    for (const chain of db.prepare("SELECT * FROM canvas_chain WHERE kind = 'legacy'").all() as Array<Record<string, unknown>>) indexChain(chain)
    for (const asset of statements.listAssets.all() as Array<Record<string, unknown>>) indexAsset(asset)
    for (const take of db.prepare('SELECT * FROM canvas_take').all() as Array<Record<string, unknown>>) indexTake(take)

    // Verification (§6): counts are returned for the caller to assert; blob
    // hashes spot-verified (re-hash a bounded sample against the registry).
    const sample = spotChecks.slice(0, 8)
    for (const check of sample) {
      const verdict = verifyBlob(check.relPath)
      counts.blobHashChecks += 1
      if (verdict !== 'ok') counts.blobHashMismatches += 1
    }

    if (counts.blobHashMismatches > 0) {
      throw new Error(`legacy import aborted: ${counts.blobHashMismatches} blob hash spot-check(s) failed — sources left intact, nothing marked imported`)
    }
    statements.setImportMarker.run('legacy', now(), JSON.stringify(counts))
    return { alreadyImported: false, counts }
  })

  /** Decodes an /api/lan/media?source=output&path=… URL into the filesystem
   *  path it serves. Anything else returns null (no blob registration). */
  function mediaUrlToPath(url: string): string | null {
    if (!url.startsWith('/api/lan/media')) return null
    try {
      const parsed = new URL(url, 'http://minimax.local')
      const path = parsed.searchParams.get('path')
      return path && isAbsolute(path) ? path : null
    } catch {
      return null
    }
  }

  // ---- store surface ------------------------------------------------------------
  const store = {
    schemaVersion: CANVAS_SCHEMA_VERSION,
    appVersion,
    blobRoot,

    // projects --------------------------------------------------------------
    createProject: (input: { id?: string; name: string; camera?: Record<string, unknown>; settingsDefaults?: Record<string, unknown> }) => {
      const id = input.id ?? randomUUID()
      statements.insertProject.run({
        id,
        name: input.name,
        schema_version: CANVAS_SCHEMA_VERSION,
        camera_json: JSON.stringify(input.camera ?? {}),
        settings_defaults_json: JSON.stringify(input.settingsDefaults ?? {}),
        app_version: appVersion,
        created_at: now(),
      })
      return hydrateProject(statements.getProject.get(id) as Record<string, unknown>)
    },
    /** List with version-refusal ISOLATION (M4): a row this build cannot
     *  open (newer schema — e.g. after a downgrade) is skipped and REPORTED
     *  per row instead of throwing — one newer-schema project must never
     *  brick the boot by poisoning the whole list. The loud per-document
     *  refusal stays on getProject/getProjectDocument (§2/F9). */
    listProjects: () => listProjectRows(statements.listProjects.all() as Array<Record<string, unknown>>),
    listTrashedProjects: () => listProjectRows(statements.listTrashedProjects.all() as Array<Record<string, unknown>>),
    getProject: (id: string) => {
      const row = guardProject(statements.getProject.get(id) as Record<string, unknown> | undefined)
      return row ? hydrateProject(row) : null
    },
    setProjectCamera: (id: string, camera: Record<string, unknown>) => {
      guardProject(statements.getProject.get(id) as Record<string, unknown> | undefined)
      statements.setProjectCamera.run(JSON.stringify(camera), now(), id)
    },
    setProjectSettingsDefaults: (id: string, defaults: Record<string, unknown>) => {
      guardProject(statements.getProject.get(id) as Record<string, unknown> | undefined)
      statements.setProjectSettingsDefaults.run(JSON.stringify(defaults), now(), id)
    },
    renameProject: (id: string, name: string) => {
      guardProject(statements.getProject.get(id) as Record<string, unknown> | undefined)
      statements.renameProject.run(name, now(), id)
    },
    tombstoneProject: (id: string) => statements.tombstoneProject.run(now(), now(), id).changes,
    /** Restore is FULL (§3): bringing a project back also brings back its
     *  tombstoned chains — trash entries restore whole, never piecemeal. */
    restoreProject: db.transaction((id: string) => {
      const restored = statements.restoreProject.run(now(), id).changes
      const chains = db.prepare('UPDATE canvas_chain SET deleted_at = NULL WHERE project_id = ? AND deleted_at IS NOT NULL').run(id).changes
      return restored + chains
    }),

    /** The full document (§2 canvas-ui-v1: every view is a projection of
     *  this graph). Unknown-newer versions refuse loudly (§2/F9). */
    getProjectDocument: (id: string) => foldProjectDocument(id),

    /** The GET-route read (perf wave 1): fold once, serve many. Returns the
     *  serialized body + content-hash ETag, rebuilding (and re-caching) only
     *  when the fail-closed write stamp moved — see the cache block above.
     *  null when the project does not exist (same contract as
     *  getProjectDocument); version refusals still throw loudly, uncached. */
    getProjectDocumentCached: (id: string): { etag: string; json: string; cached: boolean } | null => {
      const stamp = readWriteStamp()
      const cached = documentReadCache.get(id)
      if (cached && cached.dataVersion === stamp.dataVersion && cached.totalChanges === stamp.totalChanges) {
        // LRU refresh: re-insertion keeps hot projects resident under the cap.
        documentReadCache.delete(id)
        documentReadCache.set(id, cached)
        return { etag: cached.etag, json: cached.json, cached: true }
      }
      if (cached) documentReadCache.delete(id)
      const document = foldProjectDocument(id)
      if (!document) return null
      const json = JSON.stringify(document)
      const etag = `"doc-${createHash('sha256').update(json).digest('hex').slice(0, 24)}"`
      documentReadCache.set(id, { etag, json, dataVersion: stamp.dataVersion, totalChanges: stamp.totalChanges })
      while (documentReadCache.size > DOCUMENT_READ_CACHE_MAX) {
        const oldest = documentReadCache.keys().next().value
        if (oldest === undefined) break
        documentReadCache.delete(oldest)
      }
      return { etag, json, cached: false }
    },

    // session ------------------------------------------------------------------
    getSession: () => {
      const row = statements.getSession.get(1) as Record<string, unknown> | undefined
      if (!row) return { openProjects: [] as string[], activeProject: null as string | null, schemaVersion: CANVAS_SCHEMA_VERSION }
      guardDocumentVersion(row.schema_version, row.app_version, 'session')
      return {
        openProjects: parseJson<string[]>(row.open_projects_json, []),
        activeProject: row.active_project === null ? null : str(row.active_project),
        schemaVersion: Number(row.schema_version),
      }
    },
    saveSession: (input: { openProjects: string[]; activeProject: string | null }) => {
      statements.upsertSession.run({
        schema_version: CANVAS_SCHEMA_VERSION,
        open_projects_json: JSON.stringify(input.openProjects),
        active_project: input.activeProject,
        app_version: appVersion,
        updated_at: now(),
      })
      return store.getSession()
    },

    // chains ---------------------------------------------------------------------
    createChain: (input: { id?: string; projectId: string; kind?: string; inputSpec?: Record<string, unknown>; settings?: Record<string, unknown>; lockState?: string }) => {
      const project = guardProject(statements.getProject.get(input.projectId) as Record<string, unknown> | undefined)
      if (!project) throw new DocumentsRuleError(`No project with id ${input.projectId}.`, 404)
      const id = input.id ?? randomUUID()
      const stackId = randomUUID()
      statements.insertChain.run({
        id,
        project_id: input.projectId,
        kind: input.kind ?? 'generation',
        input_spec_json: JSON.stringify(input.inputSpec ?? {}),
        op_stack_id: null,
        settings_json: JSON.stringify({ ...parseJson<Record<string, unknown>>(project.settings_defaults_json, {}), ...(input.settings ?? {}) }),
        lock_state: input.lockState === 'locked' ? 'locked' : 'unlocked',
        hop_count: 0,
        drift_metrics_json: null,
        created_at: now(),
      })
      statements.insertOpStack.run(stackId, id, now())
      statements.setChainOpStack.run(stackId, id)
      indexChain(statements.getChain.get(id) as Record<string, unknown>)
      statements.touchProject.run(now(), input.projectId)
      return hydrateChain(statements.getChain.get(id) as Record<string, unknown>)
    },
    getChain: (id: string) => {
      const row = statements.getChain.get(id) as Record<string, unknown> | undefined
      return row ? hydrateChain(row) : null
    },
    /** Settings edits are never silent about consequences: any downstream
     *  fork is marked stale (persisted derived state; nothing executes). */
    updateChain: db.transaction((input: {
      id: string
      settings?: Record<string, unknown>
      lockState?: string
      hopCount?: number
      driftMetrics?: Record<string, unknown> | null
      inputSpec?: Record<string, unknown>
    }) => {
      const row = statements.getChain.get(input.id) as Record<string, unknown> | undefined
      if (!row) throw new DocumentsRuleError(`No chain with id ${input.id}.`, 404)
      const settingsChanged = input.settings !== undefined
      statements.setChainSettings.run(
        JSON.stringify(input.settings ?? parseJson<Record<string, unknown>>(row.settings_json, {})),
        input.lockState === 'locked' || input.lockState === 'unlocked' ? input.lockState : str(row.lock_state),
        input.hopCount === undefined ? Number(row.hop_count) : Math.max(0, intOrNull(input.hopCount) ?? 0),
        input.driftMetrics === undefined ? (row.drift_metrics_json === null ? null : str(row.drift_metrics_json)) : JSON.stringify(input.driftMetrics ?? null),
        input.id,
      )
      if (input.inputSpec !== undefined) {
        statements.setInputSpec.run(JSON.stringify(input.inputSpec), input.id)
        propagateStaleness(input.id)
      }
      if (settingsChanged) propagateStaleness(input.id)
      indexChain(statements.getChain.get(input.id) as Record<string, unknown>)
      statements.touchProject.run(now(), str(row.project_id))
      return hydrateChain(statements.getChain.get(input.id) as Record<string, unknown>)
    }),
    setChainStale: (id: string, stale: boolean) => {
      statements.setChainStale.run(stale ? 1 : 0, id)
      return hydrateChain(statements.getChain.get(id) as Record<string, unknown>)
    },
    tombstoneChain: (id: string) => statements.tombstoneChain.run(now(), id).changes,
    restoreChain: (id: string) => statements.restoreChain.run(id).changes,
    listTrashedChains: (projectId?: string) =>
      ((projectId ? statements.trashedChainsByProject.all(projectId) : statements.trashedChains.all()) as Array<Record<string, unknown>>).map(hydrateChain),

    // outputs & takes ---------------------------------------------------------
    createOutput: (input: { id?: string; chainId: string; substrates?: string[] }) => {
      const chain = statements.getChain.get(input.chainId) as Record<string, unknown> | undefined
      if (!chain) throw new DocumentsRuleError(`No chain with id ${input.chainId}.`, 404)
      const id = input.id ?? randomUUID()
      statements.insertOutput.run(id, input.chainId, JSON.stringify(input.substrates ?? []), now())
      statements.touchProject.run(now(), str(chain.project_id))
      return hydrateOutput(statements.output.get(id) as Record<string, unknown>)
    },
    listOutputs: (chainId: string) => (statements.outputsByChain.all(chainId) as Array<Record<string, unknown>>).map(hydrateOutput),

    /** Takes are APPEND-ONLY: this is the only writer. artifacts/latent paths
     *  that point at real files are registered into the content-addressed
     *  blob tree (hash on ingest — invariant 9). One transaction: insert +
     *  supersession land together (a crash can never strand two non-
     *  superseded takes), ALL strays are superseded (an older build's crash
     *  window may have left some — the invariant is restored, not assumed),
     *  and a repeat append for an already-landed jobId is idempotent (two
     *  tabs / a retry after a transient failure land ONE take, not copies). */
    appendTake: db.transaction((input: {
      id?: string
      outputId: string
      jobId?: string | null
      artifacts?: string[]
      latentPath?: string | null
      metrics?: Record<string, unknown> | null
      contentHash?: string | null
      registerBlobs?: boolean
    }) => {
      const output = statements.output.get(input.outputId) as Record<string, unknown> | undefined
      if (!output) throw new DocumentsRuleError(`No output with id ${input.outputId}.`, 404)
      if (input.jobId) {
        const existing = statements.takeByJob.get(input.jobId) as Record<string, unknown> | undefined
        if (existing) return hydrateTake(existing)
      }
      const id = input.id ?? randomUUID()
      let artifacts = input.artifacts ?? []
      let latentPath = input.latentPath ?? null
      let contentHash = input.contentHash ?? null
      if (input.registerBlobs !== false) {
        const registered: string[] = []
        for (const artifact of artifacts) {
          // Blob registration is scoped (security hardening 1): an in-scope
          // existing file is hash-registered; anything else — absent, relative,
          // or OUT OF SCOPE (outside the studio home / output directory) — is
          // kept as the plain string the caller supplied. A refused copy is
          // observable (no blob row, no hash on the take) and loud in the
          // event log, never a silent traversal of someone's home directory.
          if (isAbsolute(artifact) && existsSync(artifact) && isAllowedBlobSource(artifact)) {
            const result = registerBlobFile(blobKindForPath(artifact, 'video'), artifact)
            if (result.present && result.hash) {
              registered.push(result.relPath)
              contentHash = contentHash ?? result.hash
            } else registered.push(artifact)
          } else {
            if (isAbsolute(artifact) && existsSync(artifact)) logEvent({ kind: 'documents.blob-registration-refused', scope: 'artifact', present: true })
            registered.push(artifact)
          }
        }
        artifacts = registered
        if (latentPath && isAbsolute(latentPath) && existsSync(latentPath)) {
          if (isAllowedBlobSource(latentPath)) {
            const result = registerBlobFile('latent', latentPath)
            if (result.present && result.hash) {
              latentPath = result.relPath
              contentHash = contentHash ?? result.hash
            }
          } else {
            logEvent({ kind: 'documents.blob-registration-refused', scope: 'latent', present: true })
          }
        }
      }
      // The pointer switch IS the supersession marker (invariant 2): a new
      // result landing makes the previous canonical a prior — nothing is
      // overwritten, at most one non-superseded take exists per output.
      // Supersede EVERY stray non-superseded take of this output BEFORE the
      // insert (migration 004's partial unique index enforces the invariant
      // at the statement boundary — supersede-then-insert keeps each
      // statement legal), not just the first: restoring the invariant beats
      // assuming it.
      for (const take of statements.takesByOutput.all(input.outputId) as Array<Record<string, unknown>>) {
        if (take.superseded_by === null) statements.supersedeTake.run(id, str(take.id))
      }
      statements.insertTake.run({
        id,
        output_id: input.outputId,
        job_id: input.jobId ?? null,
        artifacts_json: JSON.stringify(artifacts),
        latent_path: latentPath,
        metrics_json: input.metrics === null || input.metrics === undefined ? null : JSON.stringify(input.metrics),
        created_at: now(),
        content_hash: contentHash,
      })
      indexTake(statements.take.get(id) as Record<string, unknown>)
      return hydrateTake(statements.take.get(id) as Record<string, unknown>)
    }),
    listTakes: (outputId: string) => (statements.takesByOutput.all(outputId) as Array<Record<string, unknown>>).map(hydrateTake),
    canonicalTake: (outputId: string) => {
      const row = statements.canonicalTake.get(outputId) as Record<string, unknown> | undefined
      return row ? hydrateTake(row) : null
    },
    /** Explicit canonical pointer switch (invariant 2): make the chosen take
     *  canonical (reverting to an earlier take included). The chosen take's
     *  own supersession marker clears and every other non-superseded take of
     *  the output is marked superseded by it — nothing is deleted; the
     *  displaced canonical becomes a tier-2 prior. (Appending a new take
     *  switches the pointer automatically.) */
    supersedeTake: db.transaction((input: { outputId: string; takeId: string }) => {
      const next = statements.take.get(input.takeId) as Record<string, unknown> | undefined
      if (!next || str(next.output_id) !== input.outputId) throw new DocumentsRuleError(`Take ${input.takeId} does not belong to output ${input.outputId}.`, 404)
      const current = statements.canonicalTake.get(input.outputId) as Record<string, unknown> | undefined
      if (current && str(current.id) === input.takeId) throw new DocumentsRuleError('The take is already canonical.', 400)
      // Supersede the displaced canonical (and any stray) BEFORE clearing the
      // chosen take's marker: migration 004's partial unique index makes two
      // non-superseded takes per output a statement-level violation, so the
      // clear must land on an output whose other takes are already priors.
      for (const take of statements.takesByOutput.all(input.outputId) as Array<Record<string, unknown>>) {
        if (str(take.id) !== input.takeId && take.superseded_by === null) statements.supersedeTake.run(input.takeId, str(take.id))
      }
      db.prepare('UPDATE canvas_take SET superseded_by = NULL WHERE id = ?').run(input.takeId)
      return hydrateTake(statements.take.get(input.takeId) as Record<string, unknown>)
    }),

    // op stacks -----------------------------------------------------------------
    addOp: (input: { chainId: string; kind: string; settings?: Record<string, unknown> }) => {
      const chain = statements.getChain.get(input.chainId) as Record<string, unknown> | undefined
      if (!chain || !chain.op_stack_id) throw new DocumentsRuleError(`Chain ${input.chainId} has no op stack.`, 404)
      const id = randomUUID()
      const ordinal = (statements.nextOpOrdinal.get(chain.op_stack_id) as { ordinal: number }).ordinal
      statements.insertOp.run(id, str(chain.op_stack_id), ordinal, input.kind, JSON.stringify(input.settings ?? {}))
      return { id, ordinal, kind: input.kind }
    },
    ops: (chainId: string) => (statements.opsByChain.all(chainId) as Array<Record<string, unknown>>).map((op) => ({
      id: str(op.id), stackId: str(op.stack_id), ordinal: Number(op.ordinal), kind: str(op.kind),
      settings: parseJson<Record<string, unknown>>(op.settings_json, {}), bakedAt: op.baked_at === null ? null : Number(op.baked_at),
    })),
    /** Ordinal reorder = an UPDATE of ordinals only (undo cursor support). */
    reorderOps: db.transaction((chainId: string, orderedIds: string[]) => {
      const chain = statements.getChain.get(chainId) as Record<string, unknown> | undefined
      if (!chain || !chain.op_stack_id) throw new DocumentsRuleError(`Chain ${chainId} has no op stack.`, 404)
      const current = statements.opsByStack.all(str(chain.op_stack_id)) as Array<Record<string, unknown>>
      const currentIds = new Set(current.map((op) => str(op.id)))
      if (currentIds.size !== orderedIds.length || !orderedIds.every((id) => currentIds.has(id))) {
        throw new DocumentsRuleError('Reorder must be a permutation of the stack op ids.', 400)
      }
      orderedIds.forEach((id, index) => statements.setOpOrdinal.run(index + 1, id))
    }),
    updateOpSettings: (id: string, settings: Record<string, unknown>) => {
      const op = statements.op.get(id) as Record<string, unknown> | undefined
      if (!op) throw new DocumentsRuleError(`No op with id ${id}.`, 404)
      statements.setOpSettings.run(JSON.stringify(settings), id)
    },
    /** Bake = explicit irreversible marker (S10): frozen by trigger afterwards. */
    bakeOp: (id: string) => {
      const op = statements.op.get(id) as Record<string, unknown> | undefined
      if (!op) throw new DocumentsRuleError(`No op with id ${id}.`, 404)
      statements.bakeOp.run(now(), id)
    },
    deleteOp: (id: string) => {
      const op = statements.op.get(id) as Record<string, unknown> | undefined
      if (!op) return 0
      if (op.baked_at !== null) throw new DocumentsRuleError('Baked ops cannot be deleted — bake is irreversible.', 400)
      return statements.deleteOp.run(id).changes
    },

    // identity payloads & control tracks ----------------------------------------
    upsertIdentity: (input: {
      chainId: string
      refAssetIds?: string[]
      refmodIds?: string[]
      subjectText?: string
      strength?: number
      perSlotStrengths?: Record<string, number> | null
    }) => {
      const chain = statements.getChain.get(input.chainId) as Record<string, unknown> | undefined
      if (!chain) throw new DocumentsRuleError(`No chain with id ${input.chainId}.`, 404)
      const existing = statements.identityByChain.get(input.chainId) as Record<string, unknown> | undefined
      const id = existing ? str(existing.id) : randomUUID()
      statements.upsertIdentity.run({
        id,
        chain_id: input.chainId,
        ref_asset_ids_json: JSON.stringify(input.refAssetIds ?? (existing ? parseJson<string[]>(existing.ref_asset_ids_json, []) : [])),
        refmod_ids_json: JSON.stringify(input.refmodIds ?? (existing ? parseJson<string[]>(existing.refmod_ids_json, []) : [])),
        subject_text: input.subjectText ?? str(existing?.subject_text),
        strength: input.strength === undefined ? Number(existing?.strength ?? 1) : Math.max(0, Math.min(1, input.strength)),
        per_slot_strengths_json: input.perSlotStrengths === undefined ? (existing?.per_slot_strengths_json ?? null) : JSON.stringify(input.perSlotStrengths ?? null),
        updated_at: now(),
      })
      const row = statements.identityByChain.get(input.chainId) as Record<string, unknown>
      return {
        id: str(row.id),
        chainId: input.chainId,
        refAssetIds: parseJson<string[]>(row.ref_asset_ids_json, []),
        refmodIds: parseJson<string[]>(row.refmod_ids_json, []),
        subjectText: str(row.subject_text),
        strength: Number(row.strength),
        perSlotStrengths: parseJson<Record<string, number> | null>(row.per_slot_strengths_json, null),
      }
    },
    addControlTrack: (input: { chainId: string; kind: string; source: string; inputRef: string; maskRef?: string | null; params?: Record<string, unknown> | null }) => {
      const chain = statements.getChain.get(input.chainId) as Record<string, unknown> | undefined
      if (!chain) throw new DocumentsRuleError(`No chain with id ${input.chainId}.`, 404)
      const id = randomUUID()
      // Blob lifecycle (the appendTake contract, applied to control tracks):
      // a referenced real file is registered into the content-addressed tree
      // and the row stores the BLOB reference — the durable, exportable,
      // GC-protected form. A volatile absolute path (which after an archive
      // import is the ORIGINAL machine's path) never rides the document.
      const canonicalRef = (ref: string): string => {
        if (isAbsolute(ref) && existsSync(ref)) {
          const result = registerBlobFile(blobKindForPath(ref, 'image'), ref)
          if (result.present && result.hash) return result.relPath
        }
        return ref
      }
      statements.insertControlTrack.run({
        id,
        chain_id: input.chainId,
        kind: input.kind,
        source: input.source,
        input_ref: canonicalRef(input.inputRef),
        mask_ref: input.maskRef ? canonicalRef(input.maskRef) : null,
        params_json: input.params === undefined || input.params === null ? null : JSON.stringify(input.params),
      })
      return { id }
    },
    deleteControlTrack: (id: string) => statements.deleteControlTrack.run(id).changes,

    // global assets ----------------------------------------------------------------
    upsertAsset: (input: { id?: string; kind: string; fields: Record<string, unknown>; canonicalReferenceSet?: string[] | null }) => {
      if (!['character', 'location', 'wardrobe', 'refmod', 'prompt'].includes(input.kind)) throw new DocumentsRuleError(`Unknown asset kind ${input.kind}.`, 400)
      const id = input.id ?? randomUUID()
      statements.insertAsset.run({
        id,
        kind: input.kind,
        fields_json: JSON.stringify(input.fields),
        canonical_reference_set_json: input.canonicalReferenceSet === undefined || input.canonicalReferenceSet === null ? null : JSON.stringify(input.canonicalReferenceSet),
        created_at: now(),
      })
      indexAsset(statements.asset.get(id) as Record<string, unknown>)
      return { id, kind: input.kind }
    },
    listAssets: (kind?: string) =>
      (statements.listAssets.all() as Array<Record<string, unknown>>)
        .filter((row) => !kind || str(row.kind) === kind)
        .map((row) => ({
          id: str(row.id), kind: str(row.kind), fields: parseJson<Record<string, unknown>>(row.fields_json, {}),
          canonicalReferenceSet: parseJson<string[] | null>(row.canonical_reference_set_json, null),
          createdAt: Number(row.created_at),
        })),
    listTrashedAssets: (kind?: string) =>
      (statements.listTrashedAssets.all() as Array<Record<string, unknown>>)
        .filter((row) => !kind || str(row.kind) === kind)
        .map((row) => ({
          id: str(row.id), kind: str(row.kind), fields: parseJson<Record<string, unknown>>(row.fields_json, {}),
          canonicalReferenceSet: parseJson<string[] | null>(row.canonical_reference_set_json, null),
          createdAt: Number(row.created_at), deletedAt: Number(row.deleted_at),
        })),
    tombstoneAsset: (id: string) => statements.tombstoneAsset.run(now(), id).changes,
    restoreAsset: (id: string) => statements.restoreAsset.run(id).changes,

    /** Fork-into-project (F3 decided): consent-gated copy with lineage home. */
    forkAssetIntoProject: (input: { projectId: string; assetId: string; forkedSettings?: Record<string, unknown>; consent: true }) => {
      const project = statements.getProject.get(input.projectId) as Record<string, unknown> | undefined
      if (!project) throw new DocumentsRuleError(`No project with id ${input.projectId}.`, 404)
      const asset = statements.asset.get(input.assetId) as Record<string, unknown> | undefined
      if (!asset) throw new DocumentsRuleError(`No asset with id ${input.assetId}.`, 404)
      statements.insertAssetFork.run(
        input.projectId,
        input.assetId,
        JSON.stringify(input.forkedSettings ?? {}),
        JSON.stringify({ home: input.assetId }),
        now(), // consent_at: the explicit consent record
      )
      return { projectId: input.projectId, assetId: input.assetId }
    },
    assetForks: (projectId: string) => statements.assetForksByProject.all(projectId),

    // plans ---------------------------------------------------------------------------
    /** Optimistic concurrency (M5): a caller that read the plan at
     *  expectedUpdatedAt may only write while that version is still current
     *  — a concurrent edit (rapid segment changes racing a seed write-back)
     *  produces PlanConflictError (409 + the current document) instead of a
     *  silent last-write-wins lost update. Absent expectedUpdatedAt keeps
     *  the legacy unconditional upsert (create flows). */
    upsertPlan: (input: { id?: string; projectId: string; document: Record<string, unknown>; expectedUpdatedAt?: number }) => {
      const project = guardProject(statements.getProject.get(input.projectId) as Record<string, unknown> | undefined)
      if (!project) throw new DocumentsRuleError(`No project with id ${input.projectId}.`, 404)
      const id = input.id ?? randomUUID()
      if (input.id !== undefined && input.expectedUpdatedAt !== undefined) {
        const current = statements.plan.get(input.id) as Record<string, unknown> | undefined
        if (current) {
          const currentUpdated = intOrNull(current.updated_at)
          if (currentUpdated !== null && currentUpdated !== Math.trunc(input.expectedUpdatedAt)) {
            throw new PlanConflictError(input.id, currentUpdated, parseJson<Record<string, unknown>>(current.document_json, {}))
          }
        }
      }
      statements.insertPlan.run({
        id,
        project_id: input.projectId,
        schema_version: CANVAS_SCHEMA_VERSION,
        document_json: JSON.stringify(input.document),
        app_version: appVersion,
        created_at: now(),
        updated_at: now(),
      })
      indexPlan(statements.plan.get(id) as Record<string, unknown>)
      return { id }
    },
    plans: (projectId: string) => statements.plansByProject.all(projectId),

    // job extensions (§1 "extend existing") ----------------------------------------------
    setJobState: (input: { id: string; gpuQueueState?: 'active' | 'queued_for_gpu' | null; planRef?: string | null; failure?: { stage: string; reason: string; ref?: string } | null }) => {
      const job = statements.job.get(input.id) as Record<string, unknown> | undefined
      if (!job) throw new DocumentsRuleError(`No job with id ${input.id}.`, 404)
      const queue = input.gpuQueueState === undefined ? (job.gpu_queue_state === undefined ? null : (job.gpu_queue_state as string | null)) : input.gpuQueueState
      const planRef = input.planRef === undefined ? ((job.plan_ref as string | null) ?? null) : input.planRef
      const failure = input.failure === undefined ? ((job.failure_json as string | null) ?? null) : input.failure === null ? null : JSON.stringify(input.failure)
      statements.setJobQueueState.run(queue, planRef, failure, input.id)
      return { id: input.id }
    },

    // blobs & F8 ---------------------------------------------------------------------------
    registerBlobFile: (kind: string, path: string) => registerBlobFile(kind, path),
    verifyBlob,
    relinkBlobs,
    listBlobs: () => statements.listBlobs.all(),
    /** Reads a registered blob (by its registered relative path) — null when
     *  absent; the archive records the miss instead of fabricating content. */
    readBlob: (relPath: string): Buffer | null => {
      try {
        return readFileSync(blobAbsolutePath(relPath))
      } catch {
        return null
      }
    },
    /** Resolves a registered, PRESENT blob to its absolute path + kind for
     *  media serving (canvas Phase 2). Containment-gated: a relPath escaping
     *  the blob tree, an unregistered path, or a missing file all answer
     *  null — the route turns that into an honest 404, never a traversal. */
    resolveBlobFile: (relPath: string): { absPath: string; kind: string } | null => {
      if (!relPath || relPath.length > 512 || relPath.includes('\0')) return null
      const absPath = blobAbsolutePath(relPath)
      if (!isInsideBlobRoot(absPath)) return null
      const row = statements.blob.get(relPath) as Record<string, unknown> | undefined
      if (!row || Number(row.missing) === 1) return null
      if (!existsSync(absPath)) return null
      return { absPath, kind: str(row.kind) }
    },

    search: (query: string, kind?: string, limit = 50) => {
      const match = ftsMatchExpression(query)
      if (!match) return []
      const capped = Math.max(1, Math.min(200, limit))
      try {
        // The kind filter runs in SQL BEFORE the limit — a kind-filtered
        // query must never return empty while matches exist past the cut.
        return (kind
          ? statements.ftsSearchKind.all(match, kind, capped)
          : statements.ftsSearch.all(match, capped)) as Array<{ source_id: string; source_kind: string }>
      } catch {
        return [] // a malformed MATCH must never 500 the search route
      }
    },

    // retention / GC / trash -----------------------------------------------------------------
    sweep,
    pruneProjects,
    emptyTrash,
    liveTakeIds: () => [...liveTakeIds()],

    // §6 import
    importLegacy,
    legacyImportStatus: () => {
      const marker = statements.getImportMarker.get('legacy') as Record<string, unknown> | undefined
      return marker ? { imported: true, importedAt: Number(marker.imported_at), counts: parseJson<Record<string, number>>(marker.counts_json, {}) } : { imported: false }
    },

    // raw access for the archive module (same handle, same transaction discipline)
    db,
  }

  return store
}

export type DocumentStore = ReturnType<typeof createDocumentStore>
