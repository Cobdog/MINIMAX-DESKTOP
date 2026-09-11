/**
 * The studio database (wave 1 storage substrate): a single better-sqlite3
 * file at <MINIMAX_STUDIO_HOME>/studio.db.
 *
 * Decision record (2026-09-11): better-sqlite3 over node:sqlite because FTS5
 * is required for prompt search and node:sqlite is still RC without FTS5.
 * The database is the app's own LOCAL USER DATA: prompts are stored raw and
 * searchable (FTS needs them) — log-PII scrubbing applies to LOGS and
 * exported diagnostics, never to the user's own database. Media files stay
 * on the filesystem; this file holds metadata only.
 *
 * Migration discipline (the Wan2GP versioned-migration pattern): migrations
 * are an append-only numbered list; each one records a row in
 * schema_migrations inside the same transaction as its DDL, and PRAGMA
 * user_version is stamped with the latest id. Persisted records survive app
 * upgrades unchanged — a code upgrade only ever APPENDS migrations, and a
 * persisted history that no longer matches a prefix of the list is a hard
 * error rather than a silent re-shape.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'

export type Migration = {
  id: number
  name: string
  up(db: Database.Database): void
}

/**
 * Migration 001 — the foundation schema. The assets column set is the
 * expensive-to-reverse part: fps / frame_count / duration_ms land NOW so the
 * frame↔time mapping never needs a table rebuild.
 */
export const migrations: Migration[] = [
  {
    id: 1,
    name: '001-foundation',
    up(db) {
      db.exec(`
        -- Generation job records. params_json holds the FULL client record
        -- (including the reproducibility manifest); the scalar columns are the
        -- queryable projection. The in-memory retry graph is NEVER persisted.
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY,
          provider TEXT,
          media_type TEXT,
          mode TEXT NOT NULL,
          status TEXT NOT NULL,
          prompt TEXT NOT NULL DEFAULT '',
          params_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          error TEXT,
          width INTEGER,
          height INTEGER,
          duration REAL,
          output_url TEXT
        );
        CREATE INDEX jobs_updated_at ON jobs(updated_at);

        -- Append-only progress/log tail. The realtime fabric writes here once
        -- it lands; for now terminal transitions + failures are recorded.
        CREATE TABLE job_events (
          job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          ts INTEGER NOT NULL,
          type TEXT NOT NULL,
          payload_json TEXT,
          PRIMARY KEY (job_id, seq)
        );

        -- Frame-indexed asset metadata (media bytes stay on the filesystem).
        CREATE TABLE assets (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          mime TEXT,
          bytes INTEGER,
          width INTEGER,
          height INTEGER,
          duration_ms INTEGER,
          fps REAL,
          frame_count INTEGER,
          sha256 TEXT,
          created_at INTEGER NOT NULL
        );

        -- Projects; kind separates 'movie' (today) from future project types.
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'movie',
          data_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        -- Persisted named workspace snapshots (the Create workspace is
        -- name='create'). Whole-document last-write-wins.
        CREATE TABLE workspace_state (
          name TEXT PRIMARY KEY,
          data_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        -- Saved prompt library backing table; prompts_fts indexes it.
        CREATE TABLE saved_prompts (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL DEFAULT '',
          prompt TEXT NOT NULL,
          negative_prompt TEXT,
          seed INTEGER,
          sampler TEXT,
          steps INTEGER,
          cfg_scale REAL,
          source_json TEXT,
          technique INTEGER NOT NULL DEFAULT 0,
          saved_at INTEGER NOT NULL DEFAULT 0
        );

        -- Contentless FTS5 index over prompt text. Insert/delete is managed
        -- explicitly by the repository layer (contentless_delete=1 allows
        -- DELETE by rowid, required since content='' stores nothing back).
        -- source_id/source_kind are part of the declared shape for future
        -- producers (jobs, community items); a contentless table cannot
        -- return them, so callers join on rowid against the backing table.
        CREATE VIRTUAL TABLE prompts_fts USING fts5(
          prompt,
          tags,
          source_id UNINDEXED,
          source_kind UNINDEXED,
          content='',
          contentless_delete=1
        );
      `)
    },
  },
]

/** Applies pending migrations. Throws when the persisted history is not a
 *  prefix of `list` — migrations are append-only, so divergence means someone
 *  edited history and the database must not be silently re-shaped. */
export function migrateDatabase(db: Database.Database, list: Migration[] = migrations): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)')
  const ids = list.map((migration) => migration.id)
  if (new Set(ids).size !== ids.length) throw new Error('The migration list contains duplicate ids.')
  const applied = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as Array<{ id: number }>
  for (let index = 0; index < applied.length; index += 1) {
    const expected = list[index]
    if (!expected || expected.id !== applied[index].id) {
      throw new Error(`Persisted migration history diverges from the code at position ${index}. Migrations are append-only.`)
    }
  }
  const runMigration = db.transaction((migration: Migration) => {
    migration.up(db)
    db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(migration.id, migration.name, Date.now())
  })
  for (let index = applied.length; index < list.length; index += 1) runMigration(list[index])
  const latest = list.length ? list[list.length - 1].id : 0
  db.pragma(`user_version = ${latest}`)
  return list.length - applied.length
}

/** Opens (and if needed creates) the studio database: WAL for concurrent
 *  readers, foreign keys enforced, and all pending migrations applied. */
export function openStudioDatabase(dbFile: string): Database.Database {
  mkdirSync(dirname(dbFile), { recursive: true })
  const db = new Database(dbFile)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  migrateDatabase(db)
  return db
}
