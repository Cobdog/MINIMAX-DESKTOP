/**
 * Canvas Phase 1 — typed client for the Phase-0 document store routes
 * (/api/lan/documents/*, server/core.ts). Thin: no caching, no retry — the
 * canvas store owns state; every failure throws with the server's message so
 * notice routing (§4) can surface it honestly.
 */
import type { CanvasDocument, DocumentChain } from './derive'
import type { CameraState } from './camera'

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('x-minimax-token', new URLSearchParams(window.location.search).get('token') ?? '')
  const response = await fetch(path, { ...init, headers })
  const body = await response.json().catch(() => ({})) as Record<string, unknown> & T
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `documents request failed (${response.status})`)
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

export type SearchHit = { source_id: string; source_kind: string }

export const documentsApi = {
  bootstrap: () => call<{ schemaVersion: number; appVersion: string }>('/api/lan/documents/bootstrap'),

  listProjects: async () => (await call<{ projects: ProjectMeta[] }>('/api/lan/documents/projects')).projects,

  getProject: (id: string) => call<CanvasDocument>(`/api/lan/documents/project?id=${encodeURIComponent(id)}`),

  createProject: async (name: string) => (await post<{ project: ProjectMeta }>('/api/lan/documents/projects', { name })).project,

  /** Camera autosave + tile layout ride the project's view blob (camera_json
   *  is the schema's UI-state column; a dedicated geometry column is a
   *  flagged Phase-2 seam — the whole blob moves together). */
  updateProjectView: (id: string, view: { camera: CameraState; layout: Record<string, { x: number; y: number; w?: number }> }) =>
    post<{ project: ProjectMeta }>('/api/lan/documents/projects/update', { id, camera: view }),

  createChain: async (input: { projectId: string; kind?: string; inputSpec?: Record<string, unknown>; settings?: Record<string, unknown> }) =>
    (await post<{ chain: DocumentChain }>('/api/lan/documents/chains', input)).chain,

  addOp: (chainId: string, kind: string, settings?: Record<string, unknown>) =>
    post<{ op: { id: string } }>('/api/lan/documents/ops', { chainId, kind, settings: settings ?? {} }),

  search: async (query: string, limit = 24): Promise<SearchHit[]> => {
    if (!query.trim()) return []
    return (await call<{ results?: SearchHit[] }>(`/api/lan/documents/search?q=${encodeURIComponent(query)}&limit=${limit}`)).results ?? []
  },

  getSession: async (): Promise<CanvasSession> => {
    const body = await call<{ session: CanvasSession | null }>('/api/lan/documents/session')
    return body.session ?? { openProjects: [], activeProject: null }
  },

  saveSession: (session: CanvasSession) => post('/api/lan/documents/session', session),
}
