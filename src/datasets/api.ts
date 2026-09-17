/**
 * Dataset manager — typed client for the /api/lan/datasets/* routes. Thin,
 * like canvas/api.ts: no caching, no retry; every failure throws with the
 * server's message so the workbench can surface it honestly.
 */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('x-minimax-token', new URLSearchParams(window.location.search).get('token') ?? '')
  const response = await fetch(path, { ...init, headers })
  const body = await response.json().catch(() => ({})) as Record<string, unknown> & T
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `datasets request failed (${response.status})`)
  return body
}

const post = <T>(path: string, payload: unknown): Promise<T> =>
  call<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })

export type ProbeFacts = {
  kind: 'video' | 'image'
  width: number
  height: number
  fps: number | null
  durationSec: number | null
  hasAudio: boolean
  dbfs: number | null
  codec: string | null
}

export type CropRect = { x: number; y: number; w: number; h: number }

export type LibraryLayer = {
  id: string
  name: string
  crop: CropRect | null
  trim: { inFrame: number | null; outFrame: number | null }
  origin: 'manual' | 'scene-split' | 'canvas-bridge'
  contentClass: 'style' | 'character' | 'motion' | null
  slowmoDisposition: 'retime' | 'caption' | 'exclude' | null
  interpolated: boolean
  clusterId: string | null
  clusterNo: number | null
  caption: { text: string; author: string; stale: boolean; reviewState: string | null } | null
  bucket: { label: string; wall: 'ok' | 'warn' | 'stop' }
  media: string
}

export type LibrarySource = {
  id: string
  kind: 'video' | 'image'
  name: string
  ingestPath: 'reference' | 'upload'
  probe: ProbeFacts
  decodedFrames: number | null
  probeState: 'pending' | 'probing' | 'done' | 'failed'
  health: 'healthy' | 'missing' | 'changed'
  healthDetail: string | null
  floor: { verdict: 'ok' | 'warn' | 'refuse'; reason: string | null }
  provenance: { originNote: string; originDate: string | null; aiGenerated: boolean; consentNote: string }
  createdAt: number
  layers: LibraryLayer[]
}

export type LibraryPayload = {
  sources: LibrarySource[]
  trashed: { sources: Array<{ id: string; name: string; ingestPath: 'reference' | 'upload'; layers: number }> }
}

export type AspectEntry = { id: string; label: string; ratio: number; official: boolean; enabled: boolean; position: number }

export type DatasetSettings = {
  triggerToken: string
  contentClass: 'style' | 'character' | 'motion'
  audioPolicy: { expectSoundscapeClauses: boolean; blankReplaceExisting: boolean }
}

export type TriggerVerdict = { ok: boolean; issues: string[] }

export type DashboardPayload = {
  items: number
  distributions: {
    aspect: Array<{ key: string; count: number }>
    duration: Array<{ key: string; count: number }>
    resolution: Array<{ key: string; count: number }>
    contentClass: Array<{ key: string; count: number }>
    captionCoverage: { captioned: number; total: number; stale: number }
  }
  guidance: string[]
  preflight: null | {
    worstLayerId: string
    item: string
    diffsynxGb: number
    musubiGb: number
    binds: 'diffsynx' | 'musubi'
    wall: number
    warn: number
    verdict: 'fits' | 'near-wall' | 'over-wall'
    geometry: 'ok' | 'warn' | 'stop'
  }
}

export type ExportResultPayload = {
  exportId: string
  folder: string
  shape: string
  written: Array<{ layerId: string; video: string; captionSidecar: string; wav: string }>
  refused: Array<{ layerId: string; reasons: string[] }>
  gateReport: Array<{ item: string; gate: number; name: string; tier: string; reason: string }>
  recipe: Record<string, unknown>
  validated: { musubiConfig: string; diffsynxDryLoad: string }
}

export type VlmPlanPayload = {
  plan: { mode: string; chunks: Array<{ index: number; fromSec: number; toSec: number; frames: number }>; totalFrames: number; estimatedTokens: number; notes: string[] }
  model: string | null
}

/** CLIP consent state (security wave 2): the curation pass downloads CLIP
 *  weights from huggingface.co only behind a recorded consent; the dedup /
 *  triage responses carry this so the UI can offer the choice honestly. */
export type ClipConsentInfo = {
  consented: boolean
  id: string
  model: string
  licenseSpdx: string
  note: string
}

export const datasetsApi = {
  bootstrap: () => call<{ settings: DatasetSettings; aspects: AspectEntry[]; rifeAvailable: boolean; exports: Array<{ id: string; shape: string; folder: string; itemCount: number; createdAt: number }> }>('/api/lan/datasets/bootstrap'),
  library: () => call<LibraryPayload>('/api/lan/datasets/library'),
  search: async (query: string) => (await call<{ hits: Array<{ layerId: string | null; sourceId: string; kind: string }> }>(`/api/lan/datasets/search?q=${encodeURIComponent(query)}`)).hits,
  ingestReference: (path: string, provenance?: Record<string, unknown>) => post<{ source: LibrarySource & Record<string, unknown>; deduped: boolean; refusal?: { verdict: string; reason: string } }>('/api/lan/datasets/ingest/reference', { path, ...provenance }),
  ingestUpload: (name: string, dataBase64: string, provenance?: Record<string, unknown>) => post<{ source: LibrarySource & Record<string, unknown>; deduped: boolean; refusal?: { verdict: string; reason: string } }>('/api/lan/datasets/ingest/upload', { name, data: dataBase64, ...provenance }),
  ingestCanvas: (path: string) => post<{ source: LibrarySource & Record<string, unknown>; deduped: boolean; refusal?: { verdict: string; reason: string } }>('/api/lan/datasets/ingest/canvas', { path }),
  health: (sourceIds?: string[]) => post<{ checked: number; missing: number; changed: number }>('/api/lan/datasets/health', sourceIds ? { sourceIds } : {}),
  relink: (sourceId: string, path: string) => post<{ relinked: boolean; reason?: string }>('/api/lan/datasets/relink', { sourceId, path }),
  probe: async (sourceId: string) => (await post<{ source: LibrarySource & Record<string, unknown> }>('/api/lan/datasets/probe', { sourceId })).source,
  setProvenance: (sourceId: string, provenance: Record<string, unknown>) => post<{ source: LibrarySource & Record<string, unknown> }>('/api/lan/datasets/sources/provenance', { sourceId, ...provenance }),
  trashSource: (sourceId: string) => post<{ trashed: boolean; layersAffected: number; captionsAffected: number }>('/api/lan/datasets/sources/trash', { sourceId }),
  restoreSource: (sourceId: string) => post<{ restored: boolean }>('/api/lan/datasets/sources/restore', { sourceId }),
  emptyTrash: () => post<{ dropped: number; bytesDeleted: number }>('/api/lan/datasets/trash/empty', {}),
  createLayer: (input: { sourceId: string; name?: string; crop?: CropRect | null; trim?: { inFrame: number | null; outFrame: number | null } | null; contentClass?: string | null }) => post<{ layer: LibraryLayer & Record<string, unknown> }>('/api/lan/datasets/layers', input),
  updateLayer: (layerId: string, update: Record<string, unknown>) => post<{ layer: LibraryLayer & Record<string, unknown> }>('/api/lan/datasets/layers/update', { layerId, ...update }),
  trashLayer: (layerId: string) => post<{ layer: unknown }>('/api/lan/datasets/layers/trash', { layerId }),
  restoreLayer: (layerId: string) => post<{ layer: unknown }>('/api/lan/datasets/layers/restore', { layerId }),
  setLayerClass: (layerId: string, contentClass: string | null) => post<{ layer: unknown }>('/api/lan/datasets/layers/class', { layerId, contentClass }),
  setLayerSlowmo: (layerId: string, disposition: string | null) => post<{ layer: unknown }>('/api/lan/datasets/layers/slowmo', { layerId, disposition }),
  setCaption: async (layerId: string, text: string) => (await post<{ layer: LibraryLayer & Record<string, unknown> }>('/api/lan/datasets/captions', { layerId, text })).layer,
  captionHistory: (layerId: string) => call<{ history: Array<{ text: string; author: string; authorModel: string | null; recordedAt: number }>; validation: TriggerVerdict }>(`/api/lan/datasets/captions/history?layerId=${encodeURIComponent(layerId)}`),
  validateCaption: (text: string) => post<TriggerVerdict>('/api/lan/datasets/captions/validate', { text }),
  setCaptionReview: (layerId: string, reviewState: string | null) => post<{ layer: unknown }>('/api/lan/datasets/captions/review', { layerId, reviewState }),
  settings: () => call<{ settings: DatasetSettings }>('/api/lan/datasets/settings'),
  saveSettings: async (update: Record<string, unknown>) => (await post<{ settings: DatasetSettings }>('/api/lan/datasets/settings', update)).settings,
  aspects: async () => (await call<{ aspects: AspectEntry[] }>('/api/lan/datasets/aspects')).aspects,
  setAspectEnabled: async (id: string, enabled: boolean) => (await post<{ aspects: AspectEntry[] }>('/api/lan/datasets/aspects/toggle', { id, enabled })).aspects,
  addAspect: async (label: string, ratio: number) => (await post<{ aspects: AspectEntry[] }>('/api/lan/datasets/aspects/add', { label, ratio })).aspects,
  deleteAspect: async (id: string) => (await post<{ aspects: AspectEntry[] }>('/api/lan/datasets/aspects/delete', { id })).aspects,
  runDedup: () => post<{ tier1Clusters: number; tier2Clusters: number; embedBackend: string; clipConsent: ClipConsentInfo }>('/api/lan/datasets/dedup', {}),
  triage: (imageBase64: string, limit?: number) => post<{ backend: string; results: Array<{ layerId: string; score: number }>; clipConsent: ClipConsentInfo }>('/api/lan/datasets/triage', { image: imageBase64, limit }),
  clipConsent: (consented: boolean) => post<{ consented: boolean; model: string; licenseSpdx: string }>('/api/lan/datasets/clip/consent', { consented }),
  similar: async (layerId: string) => (await call<{ results: Array<{ layerId: string; score: number }> }>(`/api/lan/datasets/similar?layerId=${encodeURIComponent(layerId)}`)).results,
  auditSlowMo: (sourceId: string) => post<{ suspect: boolean; reasons: string[] }>('/api/lan/datasets/audit/slowmo', { sourceId }),
  proposeScenes: async (sourceId: string) => (await post<{ proposals: Array<{ frameNo: number; atSec: number }> }>('/api/lan/datasets/scenes/propose', { sourceId })).proposals,
  acceptCuts: (sourceId: string, frames: number[]) => post<{ cuts: Array<{ frameNo: number; accepted: boolean }> }>('/api/lan/datasets/scenes/accept', { sourceId, frames }),
  splitAtCuts: (sourceId: string) => post<{ children: LibraryLayer[] }>('/api/lan/datasets/scenes/split', { sourceId }),
  vlmPlan: (layerId: string) => post<VlmPlanPayload>('/api/lan/datasets/vlm/plan', { layerId }),
  vlmCaption: (layerId: string, instruction?: string) => post<{ layerId: string; caption: string; model: string }>('/api/lan/datasets/vlm/caption', { layerId, instruction }),
  vlmBatch: (layerIds: string[], run: { instruction?: string; guard: 'skip' | 'queue' }) => post<{ captioned: string[]; skipped: string[]; queuedForReview: string[]; errors: Array<{ layerId: string; error: string }> }>('/api/lan/datasets/vlm/batch', { layerIds, ...run }),
  vlmDiscuss: (layerId: string, message: string, history?: Array<{ role: 'user' | 'assistant'; content: string }>) => post<{ reply: string; model: string; frames: number }>('/api/lan/datasets/vlm/discuss', { layerId, message, history }),
  dashboard: () => call<DashboardPayload>('/api/lan/datasets/dashboard'),
  bake: (layerId: string, config: { folder?: string; gridTarget?: number | null; acceptChanged?: boolean }) => post<{ outcome: { state: string; outputPath: string | null; gridTarget: number; decodedFrames: number | null; fpsMode: string; error?: string } }>('/api/lan/datasets/bake', { layerId, ...config }),
  export: (request: { shape: string; trainer: string; folder: string; layerIds: string[]; gridTarget?: number | null; acceptWarnings?: boolean }) => post<ExportResultPayload>('/api/lan/datasets/export', request),
  pinToCanvas: (layerId: string) => post<{ pin: { layerId: string; media: string; crop: CropRect | null; trim: unknown; caption: string; name: string } }>('/api/lan/datasets/canvas/pin', { layerId }),
}

export function mediaUrlFor(sourceId: string): string {
  const token = new URLSearchParams(window.location.search).get('token')
  return `/api/lan/datasets/media?source=${encodeURIComponent(sourceId)}${token ? `&token=${encodeURIComponent(token)}` : ''}`
}
