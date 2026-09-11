/**
 * Repository layer over the studio database: pure functions over the
 * better-sqlite3 handle, prepared once per server. The HTTP routes in
 * core.ts validate shapes BEFORE anything reaches here; this layer owns
 * persistence semantics — per-job upserts (never whole-list replace),
 * terminal-transition events, explicit FTS insert/delete management, and
 * whole-document workspace last-write-wins.
 */
import { openStudioDatabase } from './db'
import { TECHNIQUE_CORPUS, type SavedPromptEntry } from '../src/lib/promptCorpus'

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const WORKSPACE_CREATE = 'create'

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

/** Builds a SAFE FTS5 MATCH expression from arbitrary user input. Every
 *  character that carries FTS5 syntax (" * ( ) and whitespace) is stripped
 *  from tokens, and each token is emitted as a quoted prefix phrase — a
 *  quoted phrase can never terminate early, so the expression is injection
 *  proof by construction. Returns '' when nothing survives (the caller skips
 *  MATCH entirely rather than matching everything). */
export function ftsMatchExpression(raw: string): string {
  const tokens = str(raw).split(/["*()]+/).map((token) => token.trim()).filter((token) => token.length > 0)
  return tokens.map((token) => `"${token}"*`).join(' AND ')
}

/** Opens the database, applies migrations, and returns the repository. Used
 *  by createStudioServer; a thrown error must degrade to 503 routes, never a
 *  crashed server. */
export function createStudioRepository(dbFile: string) {
  const db = openStudioDatabase(dbFile)
  const statements = {
    selectJobStatus: db.prepare('SELECT status FROM jobs WHERE id = ?'),
    upsertJob: db.prepare(`
      INSERT INTO jobs (id, provider, media_type, mode, status, prompt, params_json, created_at, updated_at, error, width, height, duration, output_url)
      VALUES (@id, @provider, @media_type, @mode, @status, @prompt, @params_json, @created_at, @updated_at, @error, @width, @height, @duration, @output_url)
      ON CONFLICT(id) DO UPDATE SET
        provider = excluded.provider, media_type = excluded.media_type, mode = excluded.mode, status = excluded.status,
        prompt = excluded.prompt, params_json = excluded.params_json, updated_at = excluded.updated_at, error = excluded.error,
        width = excluded.width, height = excluded.height, duration = excluded.duration, output_url = excluded.output_url
    `),
    nextEventSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM job_events WHERE job_id = ?'),
    insertJobEvent: db.prepare('INSERT INTO job_events (job_id, seq, ts, type, payload_json) VALUES (?, ?, ?, ?, ?)'),
    listJobs: db.prepare('SELECT * FROM jobs ORDER BY created_at DESC, rowid ASC LIMIT ?'),
    upsertAsset: db.prepare(`
      INSERT INTO assets (id, kind, path, mime, bytes, width, height, duration_ms, fps, frame_count, sha256, created_at)
      VALUES (@id, @kind, @path, @mime, @bytes, @width, @height, @duration_ms, @fps, @frame_count, @sha256, @created_at)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind, path = excluded.path, mime = excluded.mime, bytes = excluded.bytes, width = excluded.width,
        height = excluded.height, duration_ms = excluded.duration_ms, fps = excluded.fps, frame_count = excluded.frame_count,
        sha256 = excluded.sha256
    `),
    upsertProject: db.prepare(`
      INSERT INTO projects (id, name, kind, data_json, updated_at) VALUES (@id, @name, @kind, @data_json, @updated_at)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, data_json = excluded.data_json, updated_at = excluded.updated_at
    `),
    listProjects: db.prepare('SELECT * FROM projects ORDER BY updated_at DESC, rowid ASC'),
    deleteProject: db.prepare('DELETE FROM projects WHERE id = ?'),
    getWorkspace: db.prepare('SELECT data_json FROM workspace_state WHERE name = ?'),
    saveWorkspace: db.prepare(`
      INSERT INTO workspace_state (name, data_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at
    `),
    upsertSavedPrompt: db.prepare(`
      INSERT INTO saved_prompts (id, label, prompt, negative_prompt, seed, sampler, steps, cfg_scale, source_json, technique, saved_at)
      VALUES (@id, @label, @prompt, @negative_prompt, @seed, @sampler, @steps, @cfg_scale, @source_json, @technique, @saved_at)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label, prompt = excluded.prompt, negative_prompt = excluded.negative_prompt, seed = excluded.seed,
        sampler = excluded.sampler, steps = excluded.steps, cfg_scale = excluded.cfg_scale, source_json = excluded.source_json,
        technique = excluded.technique, saved_at = excluded.saved_at
    `),
    savedPromptRowid: db.prepare('SELECT rowid FROM saved_prompts WHERE id = ?'),
    deleteSavedPromptRow: db.prepare('DELETE FROM saved_prompts WHERE id = ?'),
    ftsInsert: db.prepare('INSERT INTO prompts_fts (rowid, prompt, tags, source_id, source_kind) VALUES (?, ?, ?, ?, ?)'),
    ftsDelete: db.prepare('DELETE FROM prompts_fts WHERE rowid = ?'),
    searchPrompts: db.prepare(`
      SELECT sp.* FROM prompts_fts JOIN saved_prompts sp ON sp.rowid = prompts_fts.rowid
      WHERE prompts_fts MATCH ? ORDER BY rank LIMIT ?
    `),
    listPrompts: db.prepare(`
      SELECT * FROM saved_prompts ORDER BY technique DESC, CASE WHEN technique = 1 THEN rowid ELSE -saved_at END ASC LIMIT ?
    `),
  }

  const appendJobEvent = db.transaction((jobId: string, type: string, payload: Record<string, unknown>) => {
    const seq = (statements.nextEventSeq.get(jobId) as { seq: number }).seq
    statements.insertJobEvent.run(jobId, seq, Date.now(), type, JSON.stringify(payload))
  })

  function jobParams(job: Record<string, unknown>) {
    // The submit graph is for in-memory retry only — stripped again here so a
    // legacy caller can never persist it.
    const params = { ...job }
    delete params.graph
    const now = Date.now()
    return {
      id: str(job.id),
      provider: str(job.provider) || null,
      media_type: str(job.mediaType) || null,
      mode: str(job.mode),
      status: str(job.status),
      prompt: str(job.prompt),
      params_json: JSON.stringify(params),
      created_at: intOrNull(job.createdAt) ?? now,
      updated_at: now,
      error: str(job.error) || null,
      width: intOrNull(job.width),
      height: intOrNull(job.height),
      duration: num(job.duration),
      output_url: str(job.outputUrl) || null,
    }
  }

  function hydrateJob(row: Record<string, unknown>) {
    const base: Record<string, unknown> = {
      id: row.id,
      provider: row.provider ?? undefined,
      mediaType: row.media_type ?? undefined,
      mode: row.mode,
      status: row.status,
      prompt: row.prompt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      error: row.error ?? undefined,
      width: row.width ?? 0,
      height: row.height ?? 0,
      duration: row.duration ?? 0,
      outputUrl: row.output_url ?? undefined,
    }
    let params: Record<string, unknown> = {}
    try {
      params = JSON.parse(str(row.params_json) || '{}') as Record<string, unknown>
      if (!params || typeof params !== 'object' || Array.isArray(params)) params = {}
    } catch { /* Corrupted params_json: the column projection still answers. */ }
    const merged = { ...base, ...params }
    delete merged.graph
    return merged
  }

  function promptParams(entry: Record<string, unknown>) {
    return {
      id: str(entry.id),
      label: str(entry.label),
      prompt: str(entry.prompt),
      negative_prompt: str(entry.negativePrompt) || null,
      seed: intOrNull(entry.seed),
      sampler: str(entry.sampler) || null,
      steps: intOrNull(entry.steps),
      cfg_scale: num(entry.cfgScale),
      source_json: entry.source && typeof entry.source === 'object' ? JSON.stringify(entry.source) : null,
      technique: entry.technique ? 1 : 0,
      saved_at: intOrNull(entry.savedAt) ?? 0,
    }
  }

  function hydratePrompt(row: Record<string, unknown>): SavedPromptEntry {
    let source: SavedPromptEntry['source']
    try {
      const parsed = JSON.parse(str(row.source_json) || '') as SavedPromptEntry['source']
      if (parsed && typeof parsed === 'object') source = parsed
    } catch { /* No source metadata on this entry. */ }
    return {
      id: str(row.id),
      label: str(row.label),
      prompt: str(row.prompt),
      negativePrompt: str(row.negativePrompt) || undefined,
      seed: row.seed === null ? undefined : Number(row.seed),
      sampler: str(row.sampler) || undefined,
      steps: row.steps === null ? undefined : Number(row.steps),
      cfgScale: row.cfg_scale === null ? undefined : Number(row.cfg_scale),
      source,
      technique: Boolean(row.technique),
      savedAt: Number(row.saved_at) || 0,
    }
  }

  /** Upserts saved_prompts and keeps the FTS index in sync explicitly
   *  (contentless table: no triggers possible, delete-then-insert by rowid). */
  const upsertSavedPrompt = db.transaction((entry: Record<string, unknown>) => {
    const params = promptParams(entry)
    if (!params.id || !params.prompt) return
    statements.upsertSavedPrompt.run(params)
    const row = statements.savedPromptRowid.get(params.id) as { rowid: number } | undefined
    if (!row) return
    statements.ftsDelete.run(row.rowid)
    statements.ftsInsert.run(row.rowid, params.prompt, params.label, params.id, 'saved_prompt')
  })

  const deleteSavedPrompt = db.transaction((id: string) => {
    const row = statements.savedPromptRowid.get(id) as { rowid: number } | undefined
    if (!row) return 0
    statements.ftsDelete.run(row.rowid)
    statements.deleteSavedPromptRow.run(id)
    return 1
  })

  // Idempotent technique seeding on every boot: keyed by id, so user entries
  // are untouched and corpus text refreshes with app upgrades.
  const seedTechniques = db.transaction(() => {
    for (const entry of TECHNIQUE_CORPUS) upsertSavedPrompt(entry)
  })
  seedTechniques()

  return {
    close: () => db.close(),

    /** Per-job upsert keyed by id — NEVER a whole-list replace. Two clients
     *  (or tabs) writing overlapping sets each win per job: the newest write
     *  per id survives and the other tab's jobs are never lost. Terminal
     *  transitions append a job_events row (the realtime fabric writes the
     *  running tail later; terminal + failure records start now). */
    upsertJobs: db.transaction((jobs: Array<Record<string, unknown>>) => {
      let saved = 0
      for (const job of jobs) {
        const params = jobParams(job)
        if (!params.id) continue
        const previous = statements.selectJobStatus.get(params.id) as { status: string } | undefined
        statements.upsertJob.run(params)
        if (TERMINAL_STATUSES.has(params.status) && (!previous || previous.status !== params.status)) {
          appendJobEvent(params.id, 'status', { from: previous?.status ?? null, to: params.status, error: params.error ?? undefined })
        }
        saved += 1
      }
      return saved
    }),

    listJobs: (limit = 100) => (statements.listJobs.all(Math.max(1, Math.min(500, Math.trunc(limit) || 100))) as Array<Record<string, unknown>>).map(hydrateJob),

    /** Frame-indexed asset metadata upsert (media bytes live on disk). */
    upsertAsset: (asset: Record<string, unknown>) => {
      statements.upsertAsset.run({
        id: str(asset.id),
        kind: str(asset.kind),
        path: str(asset.path),
        mime: str(asset.mime) || null,
        bytes: intOrNull(asset.bytes),
        width: intOrNull(asset.width),
        height: intOrNull(asset.height),
        duration_ms: intOrNull(asset.durationMs),
        fps: num(asset.fps),
        frame_count: intOrNull(asset.frameCount),
        sha256: str(asset.sha256) || null,
        created_at: Date.now(),
      })
    },

    upsertProject: (project: { id: string; name: string; kind?: string; data: Record<string, unknown> }) => {
      statements.upsertProject.run({ id: project.id, name: project.name, kind: project.kind ?? 'movie', data_json: JSON.stringify(project.data), updated_at: Date.now() })
    },

    listProjects: () => (statements.listProjects.all() as Array<Record<string, unknown>>).map((row) => {
      let data: Record<string, unknown> = {}
      try { data = JSON.parse(str(row.data_json)) as Record<string, unknown> } catch { /* Skip unreadable payload. */ }
      return { id: row.id, name: row.name, kind: row.kind, data, updatedAt: row.updated_at }
    }),

    deleteProject: (id: string) => statements.deleteProject.run(id).changes,

    getWorkspace: (name = WORKSPACE_CREATE): Record<string, unknown> | null => {
      const row = statements.getWorkspace.get(name) as { data_json: string } | undefined
      if (!row) return null
      try {
        const parsed = JSON.parse(row.data_json) as Record<string, unknown>
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
      } catch { return null }
    },

    saveWorkspace: (data: Record<string, unknown>, name = WORKSPACE_CREATE) => {
      statements.saveWorkspace.run(name, JSON.stringify(data), Date.now())
    },

    upsertPrompts: db.transaction((entries: Array<Record<string, unknown>>) => {
      for (const entry of entries) upsertSavedPrompt(entry)
      return entries.length
    }),

    deletePrompt: (id: string) => deleteSavedPrompt(id),

    /** FTS search over saved prompts. An empty/whitespace query lists the
     *  library instead (techniques in corpus order, then saved newest first).
     *  The MATCH expression is built by ftsMatchExpression — never pass user
     *  text to MATCH untreated. */
    searchPrompts: (query: string, limit = 100): SavedPromptEntry[] => {
      const capped = Math.max(1, Math.min(500, Math.trunc(limit) || 100))
      const match = ftsMatchExpression(query)
      if (!match) return (statements.listPrompts.all(capped) as Array<Record<string, unknown>>).map(hydratePrompt)
      try {
        return (statements.searchPrompts.all(match, capped) as Array<Record<string, unknown>>).map(hydratePrompt)
      } catch (error) {
        // A malformed MATCH must never 500 the search route; the fts
        // expression builder rules this out, but the guard keeps a future
        // tokenizer change from becoming an outage.
        void error
        return []
      }
    },
  }
}

export type StudioRepository = ReturnType<typeof createStudioRepository>
