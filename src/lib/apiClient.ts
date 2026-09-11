import type { AppSettings, DesktopApi, MediaKind, PromptLibraryItem } from '../types'

/**
 * HTTP implementation of the DesktopApi bridge, used when the renderer runs in
 * a plain browser against the app's own web server (the migration target —
 * see docs/migration.md). Selected in src/main.tsx when the Electron preload
 * is absent. Method signatures mirror the Electron bridge exactly so no
 * component code changes; the server is authoritative for service URLs,
 * output directory, and the ffmpeg executable, so those arguments are
 * accepted and ignored.
 *
 * Media references: `MediaFile.path` values created by this client are
 * `comfy-input:<subfolder>/<name>` strings for user-uploaded picks (uploaded
 * to ComfyUI's input tree at selection time); output-derived files keep their
 * server-contained paths. Both resolve through /api/lan/media.
 */

const TOKEN_PARAM = 'token'

function authToken() {
  return new URLSearchParams(window.location.search).get(TOKEN_PARAM) ?? ''
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

/** User-picked files are addressed by their ComfyUI input-tree location. */
function comfyInputReference(file: { name: string; subfolder?: string; type?: string }) {
  return `comfy-input:${file.subfolder ? `${file.subfolder}/` : ''}${file.name}`
}

function parseComfyInputReference(path: string): { filename: string; subfolder?: string; type?: string } | null {
  if (!path.startsWith('comfy-input:')) return null
  const remainder = path.slice('comfy-input:'.length)
  const separator = remainder.lastIndexOf('/')
  const filename = separator >= 0 ? remainder.slice(separator + 1) : remainder
  const subfolder = separator >= 0 ? remainder.slice(0, separator) : undefined
  if (!filename) return null
  return { filename, subfolder: subfolder || undefined, type: 'input' }
}

/** Translates a renderer media reference into the server's video-source form. */
function videoSource(source: string): unknown {
  const input = parseComfyInputReference(source)
  if (input) return { comfy: input }
  if (source.startsWith('minimax-media://local')) {
    const path = new URL(source).searchParams.get('path')
    return { output: path ?? '' }
  }
  if (source.startsWith('minimax-media://comfy')) {
    const upstream = new URL(source).searchParams.get('url')
    const query = upstream ? new URL(upstream).searchParams : null
    return { comfy: query ? { filename: query.get('filename') ?? '', subfolder: query.get('subfolder') || undefined, type: query.get('type') || undefined } : undefined }
  }
  return { output: source }
}

const ACCEPT_MAP: Record<MediaKind, string> = {
  image: 'image/png,image/jpeg,image/webp',
  video: 'video/mp4,video/webm,video/quicktime',
  audio: 'audio/mpeg,audio/wav,audio/ogg,audio/mp4',
}

function pickLocalFile(kind: MediaKind): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = ACCEPT_MAP[kind]
    input.style.display = 'none'
    input.addEventListener('change', () => {
      input.remove()
      resolve(input.files?.[0] ?? null)
    }, { once: true })
    document.body.appendChild(input)
    input.click()
  })
}

async function readFileAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(String(reader.result)), { once: true })
    reader.addEventListener('error', () => reject(new Error('The file could not be read.')), { once: true })
    reader.readAsDataURL(blob)
  })
}

export function createWebApiClient(): DesktopApi {
  let cachedBootstrap: { at: number; value: Record<string, unknown> } | null = null
  const bootstrap = async () => {
    if (!cachedBootstrap || Date.now() - cachedBootstrap.at > 10_000) {
      cachedBootstrap = { at: Date.now(), value: await apiFetch<Record<string, unknown>>('/api/lan/bootstrap') }
    }
    return cachedBootstrap.value
  }

  return {
    async getSettings() {
      return (await apiFetch<{ settings: AppSettings }>('/api/lan/settings')).settings
    },
    async saveSettings(settings: AppSettings) {
      return (await postJson<{ settings: AppSettings }>('/api/lan/settings', { settings })).settings
    },
    async getGpuTelemetry() {
      return apiFetch('/api/lan/telemetry')
    },
    async chooseDirectory() {
      // Server-side paths are edited as text in the web UI; there is no
      // native folder picker in a browser.
      return null
    },
    async chooseMedia(kind: MediaKind) {
      const picked = await pickLocalFile(kind)
      if (!picked) return null
      const data = await readFileAsDataUrl(picked)
      const uploaded = await postJson<{ name: string; subfolder?: string }>('/api/lan/upload-media', { data, name: picked.name })
      return { path: comfyInputReference({ name: uploaded.name, subfolder: uploaded.subfolder, type: 'input' }), name: uploaded.name }
    },
    async scanModels() {
      return (await bootstrap()).models as never
    },
    async getComfyStatus(url: string) {
      const query = url ? `?url=${encodeURIComponent(url)}` : ''
      return apiFetch(`/api/lan/comfy-status${query}`)
    },
    async getObjectInfo() {
      return apiFetch('/api/lan/object-info')
    },
    async submitPrompt(_url: string, prompt: unknown, clientId?: string) {
      return postJson('/api/lan/prompt', { prompt, clientId })
    },
    async getHistory(_url: string, promptId: string) {
      const body = await apiFetch<{ history?: Record<string, unknown> }>(`/api/lan/history/${encodeURIComponent(promptId)}`)
      return body.history ?? {}
    },
    async cancelPrompt(_url: string, promptId: string) {
      await postJson('/api/lan/cancel', { promptId })
      return { cancelled: true, state: 'finished' as const }
    },
    async uploadInput(_url: string, filePath: string) {
      const input = parseComfyInputReference(filePath)
      if (input) return { name: input.filename, subfolder: input.subfolder, type: 'input' }
      const uploaded = await postJson<{ name: string; subfolder?: string; type?: string }>('/api/lan/upload-output', { path: filePath })
      return uploaded
    },
    async uploadImageData(_url: string, data: string) {
      return postJson('/api/lan/upload', { data })
    },
    async saveComfyOutputImage(_url: string, file: { filename: string; subfolder?: string; type?: string }) {
      return postJson('/api/lan/outputs/save-image', file)
    },
    async listOllamaModels() {
      const names = (await bootstrap()).ollamaModels as string[]
      return names.map((name) => ({ name, size: 0, family: '', parameterSize: '', local: true }))
    },
    async generateWithOllama(_url: string, _model: string, prompt: string) {
      const body = await postJson<{ response: string }>('/api/lan/ollama', { prompt })
      return body.response
    },
    async generateStructuredWithOllama(_url: string, _model: string, prompt: string, schema: Record<string, unknown>) {
      const body = await postJson<{ result: unknown }>('/api/lan/ollama/structured', { prompt, schema })
      return body.result
    },
    async fileDataUrl(filePath: string) {
      const response = await fetch(`/api/lan/media?${new URLSearchParams(mediaQuery(filePath))}`, { headers: { 'x-minimax-token': authToken() } })
      if (!response.ok) throw new Error('The media file is unavailable.')
      return readFileAsDataUrl(await response.blob())
    },
    async mediaUrl(filePath: string) {
      const query = new URLSearchParams(mediaQuery(filePath))
      // Media URLs are consumed by <img>/<video> sources, which cannot set
      // headers — the token rides in the query for those routes only.
      const token = authToken()
      if (token) query.set('token', token)
      return `/api/lan/media?${query}`
    },
    async extractVideoFrame(source: string, position: number | 'last') {
      return postJson('/api/lan/video/frame', { source: videoSource(source), position })
    },
    async extractVideoFrames(source: string, positions: number[]) {
      const body = await postJson<{ frames: Array<{ path: string; name: string }> }>('/api/lan/video/frames', { source: videoSource(source), positions })
      return body.frames
    },
    async trimVideo(source: string, start: number, end: number) {
      return postJson('/api/lan/video/trim', { source: videoSource(source), start, end })
    },
    async joinVideos(clips: Array<{ source: string; start?: number; end?: number }>) {
      return postJson('/api/lan/video/join', { clips: clips.map((clip) => ({ source: videoSource(clip.source), start: clip.start, end: clip.end })) })
    },
    async resolveOutput(_outputDirectory: string, file: { filename: string; subfolder?: string; type?: string }) {
      const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? '', type: file.type ?? 'output' })
      const body = await apiFetch<{ url: string } | { error: string }>(`/api/lan/outputs/resolve?${query}`)
      return 'url' in body ? body.url : null
    },
    async syncMobileCharacters(characters: unknown[]) {
      return postJson('/api/lan/characters', { characters })
    },
    async freeComfyMemory() {
      return postJson<{ freed: boolean }>('/api/lan/free', {})
    },
    async runSetupDoctor() {
      return apiFetch<Awaited<ReturnType<DesktopApi['runSetupDoctor']>>>('/api/lan/doctor')
    },
    async listPromptLibrary(query: { text?: string; limit?: number; cursor?: string; nsfw?: boolean; sort?: string; scope?: 'h3' | 'all' }) {
      const search = new URLSearchParams()
      if (query.text) search.set('query', query.text)
      if (query.limit) search.set('limit', String(query.limit))
      if (query.cursor) search.set('cursor', query.cursor)
      search.set('nsfw', query.nsfw ? 'true' : 'false')
      if (query.sort) search.set('sort', query.sort)
      if (query.scope === 'all') search.set('scope', 'all')
      return apiFetch<{ items: PromptLibraryItem[]; cursor?: string }>(`/api/lan/prompt-library?${search}`)
    },
  }
}

function mediaQuery(filePath: string): Record<string, string> {
  const input = parseComfyInputReference(filePath)
  if (input) return { filename: input.filename, subfolder: input.subfolder ?? '', type: 'input' }
  return { source: 'output', path: filePath }
}

/** Installs the HTTP bridge as window.minimax when no preload bridge exists. */
export function installWebApiClient() {
  if (window.minimax) return false
  window.minimax = createWebApiClient()
  return true
}
