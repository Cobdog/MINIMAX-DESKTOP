/**
 * Canvas Phase 1 — typed client for the Phase-0 document store routes
 * (/api/lan/documents/*, server/core.ts). Thin: no caching, no retry — the
 * canvas store owns state; every failure throws with the server's message so
 * notice routing (§4) can surface it honestly.
 */
import type { CanvasDocument, DocumentChain } from './derive'
import type { CameraState } from './camera'

/** Documents-route failure carrying its HTTP status — the conflict surface
 *  (M5) keys off it (409 = rebase-and-retry, not a user-facing error). */
export class DocumentsHttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'DocumentsHttpError'
    this.status = status
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('x-minimax-token', new URLSearchParams(window.location.search).get('token') ?? '')
  const response = await fetch(path, { ...init, headers })
  const body = await response.json().catch(() => ({})) as Record<string, unknown> & T
  if (!response.ok) throw new DocumentsHttpError(response.status, typeof body.error === 'string' ? body.error : `documents request failed (${response.status})`)
  return body
}

const post = <T>(path: string, payload: unknown): Promise<T> =>
  call<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })

export type ProjectMeta = {
  id: string
  name: string
  camera: Record<string, unknown>
  createdAt: number
  lastActiveAt: number
}

export type CanvasSession = { openProjects: string[]; activeProject: string | null }

/** Conditional full-document reads (perf wave 1): the last body + its
 *  content-hash ETag per project. The server's ETag is derived from the
 *  serialized document, so a 304 means byte-identical content — returning
 *  the remembered body is the same data a 200 would carry, minus the parse.
 *  The memo holds references the canvas store already keeps alive (the
 *  store replaces documents whole; nothing mutates them in place), so it
 *  costs a Map, not a second copy. */
const rememberedDocuments = new Map<string, { etag: string; document: CanvasDocument }>()

export type SearchHit = { source_id: string; source_kind: string }

/** One global asset-store row (§2 asset, F3 decided — above projects). */
export type DocumentAsset = {
  id: string
  kind: 'character' | 'location' | 'wardrobe' | 'refmod' | 'prompt'
  fields: Record<string, unknown>
  canonicalReferenceSet: string[] | null
  createdAt: number
  /** Trash listings carry it; live listings leave it undefined. */
  deletedAt?: number
}

/** One newer-schema project row the server refused to hydrate (M4) — the
 *  list route reports these instead of letting them poison the boot. */
export type SkippedProject = { id: string; name: string; schemaVersion: number | null; writerAppVersion: string }

export const documentsApi = {
  bootstrap: () => call<{ schemaVersion: number; appVersion: string }>('/api/lan/documents/bootstrap'),

  listProjects: async (): Promise<{ projects: ProjectMeta[]; skipped: SkippedProject[] }> => {
    const body = await call<{ projects: ProjectMeta[]; skipped?: SkippedProject[] }>('/api/lan/documents/projects')
    return { projects: body.projects ?? [], skipped: body.skipped ?? [] }
  },

  /** Conditional GET: re-reads of an unchanged document are a header
   *  exchange (304) instead of a full re-parse — the per-edit/landing
   *  reload's unchanged case is free (perf wave 1). Falls back to a plain
   *  GET on the first read of a project. */
  getProject: async (id: string): Promise<CanvasDocument> => {
    const headers = new Headers()
    const token = new URLSearchParams(window.location.search).get('token')
    if (token) headers.set('x-minimax-token', token)
    const remembered = rememberedDocuments.get(id)
    if (remembered) headers.set('if-none-match', remembered.etag)
    const response = await fetch(`/api/lan/documents/project?id=${encodeURIComponent(id)}`, { headers })
    if (response.status === 304) {
      const fresh = rememberedDocuments.get(id)?.document
      // Unreachable in practice (we only send If-None-Match when a body is
      // remembered) — but a 304 without one is a broken contract, not data.
      if (!fresh) throw new DocumentsHttpError(304, 'The server answered not-modified without a known document version — reopening.')
      return fresh
    }
    const body = await response.json().catch(() => ({})) as CanvasDocument & Record<string, unknown>
    if (!response.ok) throw new DocumentsHttpError(response.status, typeof body.error === 'string' ? body.error : `documents request failed (${response.status})`)
    const etag = response.headers.get('etag')
    if (etag) rememberedDocuments.set(id, { etag, document: body })
    return body
  },

  createProject: async (name: string) => (await post<{ project: ProjectMeta }>('/api/lan/documents/projects', { name })).project,

  /** Camera autosave + tile layout ride the project's view blob (camera_json
   *  is the schema's UI-state column; a dedicated geometry column is a
   *  flagged Phase-2 seam — the whole blob moves together). */
  updateProjectView: (id: string, view: { camera: CameraState; layout: Record<string, { x: number; y: number; w?: number }> }) =>
    post<{ project: ProjectMeta }>('/api/lan/documents/projects/update', { id, camera: view }),

  createChain: async (input: { projectId: string; kind?: string; inputSpec?: Record<string, unknown>; settings?: Record<string, unknown> }) =>
    (await post<{ chain: DocumentChain }>('/api/lan/documents/chains', input)).chain,

  updateChain: (input: { id: string; settings?: Record<string, unknown>; inputSpec?: Record<string, unknown>; lockState?: 'locked' | 'unlocked'; hopCount?: number; driftMetrics?: Record<string, unknown> | null; stale?: boolean }) =>
    post<{ chain: DocumentChain }>('/api/lan/documents/chains/update', input),

  createOutput: async (input: { chainId: string; substrates?: string[] }) =>
    (await post<{ output: { id: string } }>('/api/lan/documents/outputs', input)).output,

  appendTake: async (input: { outputId: string; jobId?: string | null; artifacts?: string[]; latentPath?: string | null; metrics?: Record<string, unknown> | null }) =>
    (await post<{ take: { id: string } }>('/api/lan/documents/takes', input)).take,

  supersedeTake: (input: { outputId: string; takeId: string }) =>
    post<{ take: { id: string } }>('/api/lan/documents/takes/supersede', input),

  upsertIdentity: (input: { chainId: string; refAssetIds?: string[]; subjectText?: string; strength?: number; perSlotStrengths?: Record<string, number> | null }) =>
    post<{ identity: Record<string, unknown> }>('/api/lan/documents/identity', input),

  addOp: async (chainId: string, kind: string, settings?: Record<string, unknown>) =>
    (await post<{ op: { id: string } }>('/api/lan/documents/ops', { chainId, kind, settings: settings ?? {} })).op,

  /** Phase 3 op-stack edits (§5.1): settings updates, ordinal permutation
   *  reorder, bake (the explicit irreversible marker), per-op undo (delete —
   *  the server refuses baked ops). */
  updateOpSettings: (id: string, settings: Record<string, unknown>) =>
    post<{ updated: boolean }>('/api/lan/documents/ops/update', { id, settings }),

  reorderOps: (chainId: string, orderedIds: string[]) =>
    post<{ ops: Array<{ id: string }> }>('/api/lan/documents/ops/reorder', { chainId, orderedIds }),

  bakeOp: (id: string) => post<{ baked: boolean }>('/api/lan/documents/ops/bake', { id }),

  deleteOp: (id: string) => post<{ deleted: number }>('/api/lan/documents/ops/delete', { id }),

  /** §2.1 control track (one per shot + optional mask) — the pose rig dock
   *  writes pose tracks; preprocessors write extracted ones. */
  addControlTrack: (input: { chainId: string; kind: string; source: string; inputRef: string; maskRef?: string | null; params?: Record<string, unknown> | null }) =>
    post<{ controlTrack: { id: string } }>('/api/lan/documents/control-tracks', input),

  /** Phase 2 media ingestion: dropped bytes → engine-visible output-dir copy
   *  + content-addressed blob row. Returns both paths. */
  ingestBlob: async (input: { dataBase64: string; name: string; kind: 'image' | 'video' | 'audio' }) =>
    post<{ path: string; blob: { relPath: string; hash: string | null; size: number | null; present: boolean } }>('/api/lan/documents/blobs/ingest', { data: input.dataBase64, name: input.name, kind: input.kind }),

  /** Remote-engine output ingest (B2): fetch a completed render's bytes from
   *  the engine's /view (through the server proxy) into the output dir +
   *  blob tree — the exact ComfyUI output descriptor, never a path. */
  ingestEngineOutput: async (input: { filename: string; subfolder?: string; type?: string; kind: 'image' | 'video' | 'audio' }) =>
    post<{ path: string; blob: { relPath: string; hash: string | null; size: number | null; present: boolean } }>('/api/lan/documents/blobs/ingest-output', input),

  /** Blob media URL for <img>/<video> sources (token rides the query — the
   *  route is in the server's query-token set exactly like /api/lan/media). */
  blobFileUrl: (relPath: string) => {
    const query = new URLSearchParams({ path: relPath })
    const token = new URLSearchParams(window.location.search).get('token')
    if (token) query.set('token', token)
    return `/api/lan/documents/blobs/file?${query}`
  },

  search: async (query: string, limit = 24, kind?: string): Promise<SearchHit[]> => {
    if (!query.trim()) return []
    const kindQuery = kind ? `&kind=${encodeURIComponent(kind)}` : ''
    return (await call<{ results?: SearchHit[] }>(`/api/lan/documents/search?q=${encodeURIComponent(query)}&limit=${limit}${kindQuery}`)).results ?? []
  },

  // ---- the global asset store (§2 asset, F3; Phase 4 canvas surface) ------

  listAssets: async (kind?: string, trash = false): Promise<DocumentAsset[]> => {
    const query = new URLSearchParams()
    if (kind) query.set('kind', encodeURIComponent(kind))
    if (trash) query.set('trash', '1')
    const suffix = query.toString() ? `?${query.toString()}` : ''
    return (await call<{ assets: DocumentAsset[] }>(`/api/lan/documents/assets${suffix}`)).assets ?? []
  },

  upsertAsset: async (input: { id?: string; kind: DocumentAsset['kind']; fields: Record<string, unknown>; canonicalReferenceSet?: string[] | null }) =>
    (await post<{ asset: { id: string; kind: string } }>('/api/lan/documents/assets', input)).asset,

  /** Projection hygiene (m5): the library projection tombstones/restores its
   *  own rows as their source entries disappear and return. */
  deleteAsset: async (id: string) =>
    (await post<{ deleted: number }>('/api/lan/documents/assets/delete', { id })).deleted,

  restoreAsset: async (id: string) =>
    (await post<{ restored: number }>('/api/lan/documents/assets/restore', { id })).restored,

  /** Consent-gated fork-into-project (§2 asset_fork): the explicit consent
   *  record — the panel's bind flow calls this BEFORE the first reference. */
  forkAsset: (input: { projectId: string; assetId: string; forkedSettings?: Record<string, unknown> }) =>
    post<{ fork: { projectId: string; assetId: string } }>('/api/lan/documents/assets/fork', { ...input, consent: true }),

  /** Phase 5b (§6): plan-document upsert — the document store's canvas_plan
   *  row (id omitted = create; hydrated plans ride getProject).
   *  expectedUpdatedAt (M5) makes updates compare-and-swap: a stale version
   *  answers 409 (DocumentsHttpError) with the current document attached. */
  upsertPlan: async (input: { projectId: string; id?: string; document: Record<string, unknown>; expectedUpdatedAt?: number }) =>
    (await post<{ plan: { id: string } }>('/api/lan/documents/plans', input)).plan,

  getSession: async (): Promise<CanvasSession> => {
    const body = await call<{ session: CanvasSession | null }>('/api/lan/documents/session')
    return body.session ?? { openProjects: [], activeProject: null }
  },

  saveSession: (session: CanvasSession) => post('/api/lan/documents/session', session),
}
