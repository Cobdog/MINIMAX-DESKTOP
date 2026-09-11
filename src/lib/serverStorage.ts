/** Server-backed storage access (wave 1 substrate): generation jobs, the
 *  Create workspace, movie projects, and the saved prompt library live in
 *  the studio's SQLite database behind the LAN API routes.
 *
 *  This module is deliberately SELF-CONTAINED — type-only imports, fetch +
 *  localStorage + console globals — so the storage test can drive the
 *  migration logic in a plain VM against fixture localStorage JSON.
 *
 *  Migration policy: COPY, NEVER DESTROY. On boot (after settings load),
 *  migrateLocalData() reads the four legacy localStorage stores, POSTs them
 *  to the server, VERIFIES the server really has them (counts + spot-check
 *  of the first and last job ids), and only then sets the marker. The
 *  localStorage originals are never deleted or modified — they are orphaned
 *  in place, and cleanup happens after a burn-in period in a later task. A
 *  failed migration sets no marker: the app keeps working on localStorage
 *  for this boot and the copy retries on the next boot. */
import type { GenerationJob, MovieProject } from '../types'
import type { SavedPromptEntry } from './promptCorpus'
import type { PersistedWorkspace } from './workspace'

const MIGRATION_MARKER = 'minimax.data-migrated'
const LEGACY_JOBS_KEY = 'minimax.jobs'
const LEGACY_WORKSPACE_KEY = 'minimax.workspace'
const LEGACY_PROJECTS_KEY = 'minimax.movie-projects'
const LEGACY_PROMPTS_KEY = 'minimax.prompt-library'

function authToken() {
  return new URLSearchParams(window.location.search).get('token') ?? ''
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('x-minimax-token', authToken())
  const response = await fetch(path, { ...init, headers })
  const body = await response.json().catch(() => ({})) as Record<string, unknown> & T
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `Request failed (${response.status})`)
  return body
}

function postJson<T>(path: string, payload: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
}

/** True once the one-time localStorage→SQLite copy has been verified. */
export function serverStorageMigrationDone(): boolean {
  try {
    return localStorage.getItem(MIGRATION_MARKER) === '1'
  } catch {
    return false
  }
}

export async function fetchServerJobs(): Promise<GenerationJob[]> {
  const body = await apiFetch<{ jobs?: GenerationJob[] }>('/api/lan/jobs')
  return Array.isArray(body.jobs) ? body.jobs : []
}

export function saveServerJobs(jobs: GenerationJob[]): Promise<unknown> {
  return postJson('/api/lan/jobs', { jobs })
}

export async function fetchServerWorkspace(): Promise<PersistedWorkspace | null> {
  const body = await apiFetch<{ workspace?: PersistedWorkspace | null }>('/api/lan/workspace')
  return body.workspace && typeof body.workspace === 'object' ? body.workspace : null
}

export function saveServerWorkspace(workspace: PersistedWorkspace): Promise<unknown> {
  return postJson('/api/lan/workspace', { workspace })
}

export async function fetchServerProjects(): Promise<MovieProject[]> {
  const body = await apiFetch<{ projects?: Array<Record<string, unknown>> }>('/api/lan/projects')
  const projects = Array.isArray(body.projects) ? body.projects : []
  return projects
    .filter((project) => project && typeof project === 'object' && project.data && typeof project.data === 'object' && !Array.isArray(project.data))
    .map((project) => project.data as MovieProject)
}

export function saveServerProjects(projects: MovieProject[]): Promise<unknown> {
  return postJson('/api/lan/projects', { projects: projects.map((project) => ({ id: project.id, name: project.title, kind: 'movie', data: project })) })
}

export function deleteServerProject(id: string): Promise<unknown> {
  return postJson('/api/lan/projects/delete', { id })
}

export async function searchSavedPrompts(query: string, limit = 200): Promise<SavedPromptEntry[]> {
  const search = new URLSearchParams({ q: query, limit: String(limit) })
  const body = await apiFetch<{ entries?: SavedPromptEntry[] }>(`/api/lan/search/prompts?${search}`)
  return Array.isArray(body.entries) ? body.entries : []
}

export function saveServerPromptEntries(entries: SavedPromptEntry[]): Promise<unknown> {
  return postJson('/api/lan/prompts', { entries })
}

export function deleteServerPromptEntry(id: string): Promise<unknown> {
  return postJson('/api/lan/prompts/delete', { id })
}

// ---- One-time localStorage → server migration --------------------------------

function readJson(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null')
  } catch {
    return null
  }
}

/** Normalizes a legacy job to the persisted shape the API validates (old
 *  records can predate width/height); the localStorage original is never
 *  touched — this works on a copy. */
function normalizedJob(entry: unknown): GenerationJob | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const job = entry as Record<string, unknown>
  const id = typeof job.id === 'string' ? job.id : ''
  if (!id) return null
  const numberOr = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
  return {
    ...(job as unknown as GenerationJob),
    id,
    mode: (typeof job.mode === 'string' ? job.mode : 'text') as GenerationJob['mode'],
    status: (typeof job.status === 'string' ? job.status : 'failed') as GenerationJob['status'],
    prompt: typeof job.prompt === 'string' ? job.prompt : '',
    createdAt: numberOr(job.createdAt, Date.now()),
    progress: numberOr(job.progress, 0),
    width: numberOr(job.width, 0),
    height: numberOr(job.height, 0),
    duration: numberOr(job.duration, 0),
  }
}

function normalizedProject(entry: unknown): MovieProject | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const project = entry as Record<string, unknown>
  return typeof project.id === 'string' && project.id && typeof project.title === 'string' ? entry as MovieProject : null
}

function normalizedPrompt(entry: unknown): SavedPromptEntry | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const prompt = entry as Record<string, unknown>
  if (prompt.technique) return null // techniques are seeded server-side; no copy needed
  return typeof prompt.id === 'string' && prompt.id && typeof prompt.prompt === 'string' && prompt.prompt.length > 8 ? entry as SavedPromptEntry : null
}

export type MigrationOutcome = { migrated: boolean; reason?: string }

export async function migrateLocalData(): Promise<MigrationOutcome> {
  if (serverStorageMigrationDone()) return { migrated: true, reason: 'already-migrated' }
  const jobs = (readJson(LEGACY_JOBS_KEY) as unknown[] | null ?? []).map(normalizedJob).filter(Boolean) as GenerationJob[]
  const workspace = readJson(LEGACY_WORKSPACE_KEY) as Record<string, unknown> | null
  const projects = (readJson(LEGACY_PROJECTS_KEY) as unknown[] | null ?? []).map(normalizedProject).filter(Boolean) as MovieProject[]
  const prompts = (readJson(LEGACY_PROMPTS_KEY) as unknown[] | null ?? []).map(normalizedPrompt).filter(Boolean) as SavedPromptEntry[]
  if (!jobs.length && !workspace && !projects.length && !prompts.length) {
    // Fresh install with nothing to copy: the marker still goes down so the
    // boot loaders stop consulting the legacy stores.
    try { localStorage.setItem(MIGRATION_MARKER, '1') } catch { /* Storage blocked; retry next boot. */ }
    return { migrated: true, reason: 'nothing-to-migrate' }
  }
  try {
    // Copy (the server caps at 100 jobs per request; the legacy store only
    // ever kept the newest 100, so one batch covers it).
    if (jobs.length) await saveServerJobs(jobs.slice(0, 100))
    if (workspace && Object.keys(workspace).length) await saveServerWorkspace(workspace as unknown as PersistedWorkspace)
    if (projects.length) await saveServerProjects(projects.slice(0, 200))
    if (prompts.length) await saveServerPromptEntries(prompts.slice(0, 200))
    // VERIFY before committing the marker: counts + spot-check the first and
    // last job ids. Without this a half-applied copy could be marked done.
    if (jobs.length) {
      const stored = await fetchServerJobs()
      if (stored.length < jobs.length) throw new Error(`verification found ${stored.length} of ${jobs.length} jobs`)
      const storedIds = new Set(stored.map((job) => job.id))
      if (!storedIds.has(jobs[0].id) || !storedIds.has(jobs[jobs.length - 1].id)) throw new Error('verification spot-check failed')
    }
  } catch (error) {
    // Structural log only (counts/ids, never prompt text). No marker is set:
    // the app keeps running on localStorage this boot and retries next boot.
    console.warn('[studio-storage] migration deferred until next boot', error instanceof Error ? error.message : String(error))
    return { migrated: false }
  }
  try { localStorage.setItem(MIGRATION_MARKER, '1') } catch { return { migrated: false, reason: 'marker-write-failed' } }
  return { migrated: true }
}
