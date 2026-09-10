import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, protocol } from 'electron'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces, tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import WebSocket from 'ws'

type ModelKind = 'diffusion_models' | 'text_encoders' | 'vae' | 'loras' | 'vae_approx' | 'clip_vision'

type GenerationDefaults = {
  resolution: string
  duration: number
  turbo: 'off' | '4' | '8'
  steps: number
  sampler: string
  scheduler: string
  experimentalSampling: boolean
  refImageSize: 'match' | 'max'
  livePreview: boolean
  sigmaShiftMode: 'model' | 'custom'
  shiftVideo: number
  shiftAudio: number
  loraStrength: number
  upscaleMode: 'off' | 'ltx' | 'rtx'
}

type AppSettings = {
  comfyUrl: string
  ollamaUrl: string
  ollamaModel: string
  modelRoot: string
  paths: Record<ModelKind, string>
  outputDirectory: string
  ffmpegPath: string
  generationDefaults: GenerationDefaults
}

type LanStatus = { running: boolean; url?: string; desktopUrl?: string; port?: number; error?: string }
type GpuTelemetry = { available: boolean; name?: string; usagePercent?: number; vramPercent?: number; vramUsedMb?: number; vramTotalMb?: number }
const ltxUpscaleRequiredNodes = ['VAEEncodeTiled', 'LatentUpscaleModelLoader', 'LTXVLatentUpsampler', 'VAEDecodeTiled', 'ImageFromBatch', 'RepeatImageBatch', 'ImageBatch']
const ltxNativeRequiredNodes = ['LTXVConditioning', 'LTXVEmptyLatentAudio', 'EmptyLTXVLatentVideo', 'LTXVDualCFGGuider', 'LTXVSeparateAVLatent', 'LTXVConcatAVLatent', 'LTXVLatentUpsampler', 'LTXVAudioVAEDecode', 'ManualSigmas', 'VAEDecodeTiled', 'CLIPTextEncode', 'KSamplerSelect', 'SamplerCustomAdvanced']
let lanToken = ''
let mobileCharacterLibrary: unknown[] = []
let lanServer: Server | null = null
let lanStatus: LanStatus = { running: false }

function readGpuTelemetry(): Promise<GpuTelemetry> {
  return new Promise((resolve) => {
    const child = spawn('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { windowsHide: true })
    let output = ''
    let settled = false
    const finish = (value: GpuTelemetry) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => { child.kill(); finish({ available: false }) }, 1800)
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.on('error', () => finish({ available: false }))
    child.on('close', (code) => {
      if (code !== 0 || !output.trim()) { finish({ available: false }); return }
      const [name = 'GPU', usage = '', used = '', total = ''] = output.trim().split(/\r?\n/, 1)[0].split(',').map((part) => part.trim())
      const usagePercent = Number(usage)
      const vramUsedMb = Number(used)
      const vramTotalMb = Number(total)
      finish({ available: true, name, usagePercent: Number.isFinite(usagePercent) ? usagePercent : undefined, vramUsedMb: Number.isFinite(vramUsedMb) ? vramUsedMb : undefined, vramTotalMb: Number.isFinite(vramTotalMb) ? vramTotalMb : undefined, vramPercent: vramTotalMb > 0 ? Math.round(vramUsedMb / vramTotalMb * 100) : undefined })
    })
  })
}

const modelKinds: ModelKind[] = ['diffusion_models', 'text_encoders', 'vae', 'loras', 'vae_approx', 'clip_vision']
const modelExtensions = new Set(['.safetensors', '.pt', '.pth', '.gguf', '.onnx'])
const mediaExtensions = new Set(['.mp4', '.webm', '.mov', '.mkv'])
const audioExtensions = new Set(['.flac', '.wav', '.mp3', '.ogg', '.m4a', '.aac', '.opus'])
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])
const selectedMediaExtensions = new Set([...mediaExtensions, ...audioExtensions, ...imageExtensions])

const mediaMimeTypes: Record<string, string> = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.flac': 'audio/flac', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.opus': 'audio/opus',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp',
}

async function localMediaResponse(filePath: string, request: Request) {
  const details = await stat(filePath)
  if (!details.isFile() || details.size === 0) return new Response('Media file is empty', { status: 404 })
  const size = details.size
  const range = request.headers.get('range')
  let start = 0
  let end = size - 1
  let status = 200
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim())
    if (!match) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
    if (match[1]) start = Number(match[1])
    if (match[2]) end = Number(match[2])
    if (!match[1] && match[2]) {
      const suffixLength = Math.min(size, Number(match[2]))
      start = size - suffixLength
      end = size - 1
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
    }
    end = Math.min(end, size - 1)
    status = 206
  }
  const headers = new Headers({
    'accept-ranges': 'bytes',
    'content-length': String(end - start + 1),
    'content-type': mediaMimeTypes[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'private, max-age=3600',
  })
  if (status === 206) headers.set('content-range', `bytes ${start}-${end}/${size}`)
  if (request.method === 'HEAD') return new Response(null, { status, headers })
  const stream = createReadStream(filePath, { start, end })
  return new Response(Readable.toWeb(stream) as ReadableStream, { status, headers })
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'minimax-media', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

function defaultSettings(): AppSettings {
  const root = join(app.getPath('documents'), 'ComfyUI', 'models')
  return {
    comfyUrl: 'http://127.0.0.1:8188',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'qwen3:latest',
    modelRoot: root,
    paths: Object.fromEntries(modelKinds.map((kind) => [kind, join(root, kind)])) as Record<ModelKind, string>,
    outputDirectory: join(app.getPath('documents'), 'ComfyUI', 'output'),
    ffmpegPath: existsSync('C:\\FFMPEG\\bin\\ffmpeg.exe') ? 'C:\\FFMPEG\\bin\\ffmpeg.exe' : 'ffmpeg',
    generationDefaults: {
      resolution: '1344x768', duration: 5, turbo: 'off', steps: 30,
      sampler: 'res_multistep', scheduler: 'simple', experimentalSampling: false,
      refImageSize: 'match', livePreview: true, sigmaShiftMode: 'model', shiftVideo: 12, shiftAudio: 3, loraStrength: 1, upscaleMode: 'off',
    },
  }
}

function finalOllamaAnswer(value: string) {
  let answer = value.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '').replace(/<analysis\b[^>]*>[\s\S]*?<\/analysis>/gi, '')
  const unclosedThink = answer.search(/<(?:think|analysis)\b[^>]*>/i)
  if (unclosedThink >= 0) answer = answer.slice(0, unclosedThink)
  return answer.replace(/<\/?(?:think|analysis)\b[^>]*>/gi, '').trim()
}

function settingsPath() {
  return join(app.getPath('userData'), 'settings.json')
}

function lanTokenPath() {
  return join(app.getPath('userData'), 'lan-access-token.txt')
}

async function saveLanToken(token: string) {
  await mkdir(dirname(lanTokenPath()), { recursive: true })
  await writeFile(lanTokenPath(), token, 'utf8')
}

async function loadLanToken() {
  try {
    const stored = (await readFile(lanTokenPath(), 'utf8')).trim()
    if (/^[a-f0-9]{32}$/i.test(stored)) return stored
  } catch { /* Create the persistent token on first launch. */ }
  const created = randomUUID().replace(/-/g, '')
  await saveLanToken(created)
  return created
}

function normalizeSettings(raw: Partial<AppSettings>): AppSettings {
  const defaults = defaultSettings()
  const generationDefaults = { ...defaults.generationDefaults, ...raw.generationDefaults }
  generationDefaults.steps = Math.max(16, Math.min(30, Number(generationDefaults.steps) || 30))
  if (raw.generationDefaults?.steps === 20) generationDefaults.steps = 30
  return { ...defaults, ...raw, paths: { ...defaults.paths, ...raw.paths }, generationDefaults }
}

async function loadSettings(): Promise<AppSettings> {
  try {
    return normalizeSettings(JSON.parse(await readFile(settingsPath(), 'utf8')) as Partial<AppSettings>)
  } catch {
    return defaultSettings()
  }
}

async function saveSettings(settings: AppSettings) {
  await mkdir(dirname(settingsPath()), { recursive: true })
  // Write-then-rename so a crash mid-write can never leave settings.json half
  // written — loadSettings treats unparseable content as "reset to defaults",
  // which would silently discard every configured path.
  const staged = `${settingsPath()}.tmp`
  await writeFile(staged, JSON.stringify(settings, null, 2), 'utf8')
  await rename(staged, settingsPath())
  return settings
}

async function scanDirectory(root: string, kind: ModelKind) {
  const results: Array<{ name: string; path: string; kind: ModelKind; bytes: number }> = []
  if (!root || !existsSync(root)) return results
  const pending = [normalize(root)]
  while (pending.length) {
    const current = pending.pop()!
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) pending.push(fullPath)
      } else if (entry.isFile() && modelExtensions.has(extname(entry.name).toLowerCase())) {
        // Skip unreadable files instead of rejecting the whole scan — one
        // EACCES entry must not blank the model list.
        try {
          const info = await stat(fullPath)
          results.push({ name: entry.name, path: fullPath, kind, bytes: info.size })
        } catch { /* Unreadable entry; leave it out. */ }
      }
    }
  }
  return results
}

/** Resolves a ComfyUI-reported output file inside the configured output
 *  directory. Attributing outputs by exact filename — instead of scanning for
 *  the newest file — is what keeps concurrent renders from being credited to
 *  the wrong job (and the wrong character library entry). */
function resolveOutputFile(outputDirectory: string, file: { filename: string; subfolder?: string; type?: string }) {
  if (!outputDirectory || !file.filename) return null
  if (file.type && file.type !== 'output') return null
  const relativePath = file.subfolder ? join(file.subfolder, file.filename) : file.filename
  if (isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) return null
  const root = resolve(outputDirectory)
  const candidate = resolve(root, relativePath)
  const containment = relative(root, candidate)
  if (containment.startsWith('..') || isAbsolute(containment)) return null
  return existsSync(candidate) ? candidate : null
}

/** Default LAN posture (2026-09-10 decision): open, like ComfyUI itself.
 *  Token gating stays available for hostile networks via --token or
 *  MINIMAX_LAN_TOKEN=1. */
function lanAuthRequired() {
  return process.argv.includes('--token') || /^(1|true|yes)$/i.test(process.env.MINIMAX_LAN_TOKEN ?? '')
}

/** SSRF guard for user-supplied service URLs: only loopback or private-LAN
 *  origins may be probed; anything else is rejected. */
function isLocalServiceUrl(candidate: string) {
  try {
    const target = new URL(candidate)
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return false
    const host = target.hostname.toLowerCase()
    if (host === 'localhost' || host === '::1' || host === '[::1]') return true
    return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  } catch { return false }
}

/** Resolves a video source for LAN API callers. Accepted forms: an explicit
 *  { output: <contained path> } or { comfy: { filename, subfolder?, type? } }
 *  descriptor, or a legacy minimax-media:// URL from the Electron era. The
 *  result is always a local file path (ComfyUI inputs are downloaded to the
 *  OS temp dir first). */
async function resolveLanVideoSource(source: unknown): Promise<string> {
  if (typeof source === 'string' && source.startsWith('minimax-media://')) {
    const parsed = new URL(source)
    if (parsed.hostname === 'local') return resolveLanVideoSource({ output: parsed.searchParams.get('path') ?? '' })
    if (parsed.hostname === 'comfy') {
      const upstream = parsed.searchParams.get('url')
      const query = upstream ? new URL(upstream).searchParams : null
      return resolveLanVideoSource({ comfy: query ? { filename: query.get('filename') ?? '', subfolder: query.get('subfolder') || undefined, type: query.get('type') || undefined } : undefined })
    }
    throw new Error('Unsupported media source.')
  }
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    const spec = source as { output?: unknown; comfy?: unknown }
    if (typeof spec.output === 'string' && spec.output) {
      const root = resolve((await loadSettings()).outputDirectory)
      const candidate = resolve(spec.output)
      const containment = relative(root, candidate)
      if (containment.startsWith('..') || isAbsolute(containment) || !existsSync(candidate)) throw new Error('The requested output file is unavailable.')
      return candidate
    }
    if (spec.comfy && typeof spec.comfy === 'object') {
      const file = spec.comfy as { filename?: unknown; subfolder?: unknown; type?: unknown }
      if (typeof file.filename !== 'string' || !file.filename || file.filename.includes('/') || file.filename.includes('\\')) throw new Error('A valid ComfyUI file reference is required.')
      const settings = await loadSettings()
      const subfolder = typeof file.subfolder === 'string' && file.subfolder && !file.subfolder.includes('..') ? file.subfolder : ''
      const type = file.type === 'input' || file.type === 'temp' ? file.type : 'output'
      const query = new URLSearchParams({ filename: file.filename, subfolder, type })
      const upstream = await fetch(`${cleanUrl(settings.comfyUrl)}/view?${query}`)
      if (!upstream.ok) throw new Error('The ComfyUI media file is unavailable.')
      const target = join(tmpdir(), `minimax-source-${randomUUID()}${extname(file.filename)}`)
      await writeFile(target, Buffer.from(await upstream.arrayBuffer()))
      return target
    }
  }
  throw new Error('A media source is required.')
}

/** HTTP (non-protocol) local file serving with Range support, for the LAN API. */
async function serveLocalMediaHttp(request: IncomingMessage, response: ServerResponse, filePath: string) {
  const details = await stat(filePath).catch(() => null)
  if (!details?.isFile() || details.size === 0) return sendJson(response, 404, { error: 'The media file is unavailable.' })
  const size = details.size
  let start = 0
  let end = size - 1
  let status = 200
  const range = typeof request.headers.range === 'string' ? request.headers.range : ''
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim())
    if (!match) { response.writeHead(416, { 'content-range': `bytes */${size}` }); return response.end() }
    if (match[1]) start = Number(match[1])
    if (match[2]) end = Number(match[2])
    if (!match[1] && match[2]) { start = size - Math.min(size, Number(match[2])); end = size - 1 }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
      response.writeHead(416, { 'content-range': `bytes */${size}` }); return response.end()
    }
    end = Math.min(end, size - 1)
    status = 206
  }
  const headers: Record<string, string> = {
    'accept-ranges': 'bytes',
    'content-length': String(end - start + 1),
    'content-type': mediaMimeTypes[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'private, max-age=3600',
  }
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${size}`
  response.writeHead(status, headers)
  createReadStream(filePath, { start, end }).pipe(response)
}

/** Saves a ComfyUI-generated image into the output directory's character
 *  reference folder (the web twin of the comfy:save-output-image bridge). */
async function saveLanOutputImage(file: { filename: string; subfolder?: string; type?: string }) {
  if (!file.filename || file.filename.includes('/') || file.filename.includes('\\')) throw new Error('A valid output file reference is required.')
  const settings = await loadSettings()
  const subfolder = file.subfolder && !file.subfolder.includes('..') ? file.subfolder : ''
  const query = new URLSearchParams({ filename: file.filename, subfolder, type: file.type ?? 'output' })
  const upstream = await fetch(`${cleanUrl(settings.comfyUrl)}/view?${query}`)
  if (!upstream.ok) throw new Error('The generated image is unavailable from ComfyUI.')
  const directory = join(settings.outputDirectory, 'MiniMax Character References')
  await mkdir(directory, { recursive: true })
  const extension = extname(file.filename) || '.png'
  const target = join(directory, `character-${Date.now()}-${randomUUID().slice(0, 8)}${extension}`)
  await writeFile(target, Buffer.from(await upstream.arrayBuffer()))
  return { path: target, name: basename(target) }
}

function cleanUrl(url: string) {
  return url.trim().replace(/\/+$/, '')
}

async function comfyFetch(url: string, path: string, init?: RequestInit) {
  const response = await fetch(`${cleanUrl(url)}${path}`, init)
  if (!response.ok) {
    const message = await response.text().catch(() => '')
    throw new Error(message || `ComfyUI returned ${response.status}`)
  }
  const contentType = response.headers.get('content-type') ?? ''
  return contentType.includes('application/json') ? response.json() : response.text()
}

function lanAddress() {
  const candidates = Object.entries(networkInterfaces()).flatMap(([name, entries]) => (entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => {
      const privateAddress = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address)
      const preferredAdapter = /wi-?fi|wireless|ethernet/i.test(name)
      const virtualAdapter = /virtual|vethernet|wsl|docker|vmware|vpn|tailscale|hamachi/i.test(name)
      return { address: entry.address, score: (privateAddress ? 4 : 0) + (preferredAdapter ? 2 : 0) - (virtualAdapter ? 5 : 0) }
    }))
  return candidates.sort((left, right) => right.score - left.score)[0]?.address ?? '127.0.0.1'
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

function comfyChoices(info: Record<string, unknown>, node: string, field: string) {
  const definition = info[node] as { input?: { required?: Record<string, unknown[]> } } | undefined
  const values = definition?.input?.required?.[field]?.[0]
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string') : []
}

function streamLanEvents(request: IncomingMessage, response: ServerResponse, search: URLSearchParams, comfyUrl: string) {
  const clientId = search.get('clientId') ?? ''
  if (!/^[a-f0-9-]{16,64}$/i.test(clientId)) return sendJson(response, 400, { error: 'A valid preview client ID is required.' })
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
  response.write(': connected\n\n')
  const address = new URL(cleanUrl(comfyUrl))
  address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:'
  address.pathname = `${address.pathname.replace(/\/$/, '')}/ws`
  address.search = new URLSearchParams({ clientId }).toString()
  const socket = new WebSocket(address)
  const send = (value: unknown) => { if (!response.destroyed) response.write(`data: ${JSON.stringify(value)}\n\n`) }
  socket.on('open', () => send({ type: 'stream_ready', data: {} }))
  socket.on('message', (data, binary) => {
    if (!binary) {
      try { send(JSON.parse(data.toString())) } catch { /* Ignore malformed ComfyUI status messages. */ }
      return
    }
    const buffer = Buffer.from(data as Buffer)
    if (buffer.length <= 8 || buffer.readUInt32BE(0) !== 1) return
    const animatedH3Frame = buffer.length > 32 && buffer.readUInt32BE(4) === 1 && buffer.readUInt32BE(8) === 1 && buffer.readUInt16BE(32) === 0xffd8
    const imageOffset = animatedH3Frame ? 32 : 8
    const mime = !animatedH3Frame && buffer.readUInt32BE(4) === 2 ? 'image/png' : 'image/jpeg'
    send({ type: 'preview', data: { image: `data:${mime};base64,${buffer.subarray(imageOffset).toString('base64')}` } })
  })
  socket.on('error', (error) => send({ type: 'preview_error', data: { message: error.message } }))
  const heartbeat = setInterval(() => { if (!response.destroyed) response.write(': keepalive\n\n') }, 15_000)
  request.once('close', () => { clearInterval(heartbeat); socket.close() })
}

async function readJson(request: IncomingMessage, maximumBytes = 36_000_000) {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > maximumBytes) throw new Error('Request is too large.')
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
}

function historyOutput(history: Record<string, unknown>, promptId: string, kind: 'video' | 'image' = 'video') {
  const entry = history[promptId] as { outputs?: Record<string, unknown> } | undefined
  const files: Array<{ filename: string; subfolder?: string; type?: string }> = []
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit)
    if (!value || typeof value !== 'object') return
    const item = value as Record<string, unknown>
    if (typeof item.filename === 'string') files.push({ filename: item.filename, subfolder: typeof item.subfolder === 'string' ? item.subfolder : undefined, type: typeof item.type === 'string' ? item.type : undefined })
    Object.values(item).forEach(visit)
  }
  if (entry?.outputs?.['84']) visit(entry.outputs['84'])
  else if (entry?.outputs?.['70']) visit(entry.outputs['70'])
  else if (entry?.outputs) visit(entry.outputs)
  return files.find((file) => kind === 'image' ? /\.(png|jpe?g|webp)$/i.test(file.filename) : /\.(mp4|webm|mov|mkv)$/i.test(file.filename))
}

async function proxyLanMedia(request: IncomingMessage, response: ServerResponse, search: URLSearchParams) {
  const filename = search.get('filename') ?? ''
  if (!filename || filename.includes('/') || filename.includes('\\')) return sendJson(response, 400, { error: 'Invalid output filename.' })
  const settings = await loadSettings()
  const query = new URLSearchParams({ filename, subfolder: search.get('subfolder') ?? '', type: search.get('type') ?? 'output' })
  const upstream = await fetch(`${cleanUrl(settings.comfyUrl)}/view?${query}`, { headers: typeof request.headers.range === 'string' ? { Range: request.headers.range } : undefined })
  if (!upstream.ok || !upstream.body) return sendJson(response, upstream.status, { error: 'The generated video is unavailable.' })
  const headers: Record<string, string> = { 'content-type': upstream.headers.get('content-type') ?? 'video/mp4', 'accept-ranges': upstream.headers.get('accept-ranges') ?? 'bytes' }
  const length = upstream.headers.get('content-length')
  if (length) headers['content-length'] = length
  const contentRange = upstream.headers.get('content-range')
  if (contentRange) headers['content-range'] = contentRange
  if (search.get('download') === '1') headers['content-disposition'] = `attachment; filename="${basename(filename)}"`
  response.writeHead(upstream.status, headers)
  Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(response)
}

async function handleLanRequest(request: IncomingMessage, response: ServerResponse) {
  try {
    const url = new URL(request.url ?? '/', 'http://minimax.local')
    if (url.pathname.startsWith('/api/lan/')) {
      if (lanAuthRequired()) {
        const token = request.headers['x-minimax-token'] ?? url.searchParams.get('token')
        if (token !== lanToken) return sendJson(response, 401, { error: 'This LAN link is no longer authorized. Open the current sharing panel again.' })
      }
      const settings = await loadSettings()
      if (url.pathname === '/api/lan/bootstrap' && request.method === 'GET') {
        const groups = await Promise.all(modelKinds.map((kind) => scanDirectory(settings.paths[kind], kind)))
        const started = Date.now()
        try {
          await comfyFetch(settings.comfyUrl, '/system_stats')
          const info = await comfyFetch(settings.comfyUrl, '/object_info').catch(() => ({})) as Record<string, unknown>
          const upscalers = comfyChoices(info, 'UpscaleModelLoader', 'model_name')
          const latentUpscalers = comfyChoices(info, 'LatentUpscaleModelLoader', 'model_name')
          const vaes = comfyChoices(info, 'VAELoader', 'vae_name')
          const ltxUpscaleMissing = ltxUpscaleRequiredNodes.filter((node) => !info[node])
          const ltxNativeMissing = ltxNativeRequiredNodes.filter((node) => !info[node])
          const ollama = await comfyFetch(settings.ollamaUrl, '/api/tags').catch(() => ({ models: [] })) as { models?: Array<{ name?: string; size?: number; remote_model?: string }> }
          const ollamaModels = (ollama.models ?? []).filter((item) => item.name && !item.remote_model && item.size !== 342).map((item) => item.name as string)
          return sendJson(response, 200, { connected: true, latencyMs: Date.now() - started, models: groups.flat(), upscalers, ltxModel: latentUpscalers.find((name) => /ltx-2\.5.*spatial.*x2/i.test(name)) ?? '', ltxVae: vaes.find((name) => /ltx-2\.5.*video.*vae/i.test(name)) ?? '', ltxUpscaleReady: ltxUpscaleMissing.length === 0, ltxUpscaleMissing, ltxNativeReady: ltxNativeMissing.length === 0, ltxNativeMissing, ollamaModels, ollamaModel: settings.ollamaModel })
        } catch (error) {
          return sendJson(response, 200, { connected: false, latencyMs: Date.now() - started, models: groups.flat(), error: error instanceof Error ? error.message : String(error) })
        }
      }
      if (url.pathname === '/api/lan/characters' && request.method === 'GET') return sendJson(response, 200, { characters: mobileCharacterLibrary })
      if (url.pathname === '/api/lan/upload' && request.method === 'POST') {
        const body = await readJson(request)
        const data = typeof body.data === 'string' ? body.data : ''
        if (!data.startsWith('data:image/png;base64,') || data.length > 35_000_000) return sendJson(response, 400, { error: 'Invalid prepared image.' })
        const form = new FormData()
        form.append('image', new Blob([Buffer.from(data.split(',')[1], 'base64')], { type: 'image/png' }), `mobile-frame-${randomUUID()}.png`)
        form.append('type', 'input'); form.append('subfolder', 'minimax-mobile')
        return sendJson(response, 200, await comfyFetch(settings.comfyUrl, '/upload/image', { method: 'POST', body: form }))
      }
      if (url.pathname === '/api/lan/upload-media' && request.method === 'POST') {
        const body = await readJson(request, 180_000_000)
        const data = typeof body.data === 'string' ? body.data : ''
        const name = typeof body.name === 'string' ? basename(body.name).replace(/[^a-z0-9._-]/gi, '_') : ''
        const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.+)$/is.exec(data)
        if (!match || !name || data.length > 175_000_000) return sendJson(response, 400, { error: 'Invalid reference media.' })
        const allowed = /^(image\/(png|jpeg|webp)|video\/(mp4|webm|quicktime)|audio\/(mpeg|wav|x-wav|ogg|mp4))$/i
        if (!allowed.test(match[1])) return sendJson(response, 400, { error: 'Unsupported reference media type.' })
        const form = new FormData()
        form.append('image', new Blob([Buffer.from(match[2], 'base64')], { type: match[1] }), name)
        form.append('type', 'input'); form.append('subfolder', 'minimax-mobile-references'); form.append('overwrite', 'true')
        return sendJson(response, 200, await comfyFetch(settings.comfyUrl, '/upload/image', { method: 'POST', body: form }))
      }
      if (url.pathname === '/api/lan/prompt' && request.method === 'POST') {
        const body = await readJson(request, 5_000_000)
        if (!body.prompt || typeof body.prompt !== 'object') return sendJson(response, 400, { error: 'A ComfyUI workflow is required.' })
        const clientId = typeof body.clientId === 'string' && /^[a-f0-9-]{16,64}$/i.test(body.clientId) ? body.clientId : randomUUID()
        const result = await comfyFetch(settings.comfyUrl, '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: body.prompt, client_id: clientId }) })
        return sendJson(response, 200, result)
      }
      if (url.pathname === '/api/lan/events' && request.method === 'GET') return streamLanEvents(request, response, url.searchParams, settings.comfyUrl)
      if (url.pathname === '/api/lan/ollama' && request.method === 'POST') {
        const body = await readJson(request, 80_000)
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
        if (!prompt || prompt.length > 50_000) return sendJson(response, 400, { error: 'A shorter prompt-assistant request is required.' })
        const data = await comfyFetch(settings.ollamaUrl, '/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: settings.ollamaModel, prompt, stream: false, think: false, options: { temperature: 0.6, num_predict: 1200 } }) }) as { response?: string; error?: string }
        if (!data.response) return sendJson(response, 502, { error: data.error || 'Ollama returned an empty response.' })
        const answer = finalOllamaAnswer(data.response)
        if (!answer) return sendJson(response, 502, { error: 'Ollama returned reasoning without a final answer.' })
        return sendJson(response, 200, { response: answer })
      }
      if (url.pathname === '/api/lan/cancel' && request.method === 'POST') {
        const body = await readJson(request, 10_000)
        const promptId = typeof body.promptId === 'string' ? body.promptId : ''
        if (!promptId) return sendJson(response, 400, { error: 'A prompt ID is required.' })
        const queue = await comfyFetch(settings.comfyUrl, '/queue') as { queue_running?: unknown[][]; queue_pending?: unknown[][] }
        const running = (queue.queue_running ?? []).some((item) => item[1] === promptId)
        if (running) await comfyFetch(settings.comfyUrl, '/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt_id: promptId }) })
        else await comfyFetch(settings.comfyUrl, '/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: [promptId] }) })
        return sendJson(response, 200, { cancelled: true })
      }
      if (url.pathname.startsWith('/api/lan/history/') && request.method === 'GET') {
        const promptId = decodeURIComponent(url.pathname.slice('/api/lan/history/'.length))
        const history = await comfyFetch(settings.comfyUrl, `/history/${encodeURIComponent(promptId)}`) as Record<string, unknown>
        const output = historyOutput(history, promptId, url.searchParams.get('kind') === 'image' ? 'image' : 'video')
        const entry = history[promptId] as { status?: { status_str?: string } } | undefined
        return sendJson(response, 200, { finished: Boolean(entry), error: entry?.status?.status_str === 'error' ? 'ComfyUI reported an execution error. Check the desktop console for the failed node.' : undefined, output })
      }
      if (url.pathname === '/api/lan/settings' && request.method === 'GET') return sendJson(response, 200, { settings })
      if (url.pathname === '/api/lan/settings' && request.method === 'POST') {
        const body = await readJson(request, 200_000)
        const raw = body.settings && typeof body.settings === 'object' ? body.settings as Partial<AppSettings> : null
        if (!raw || typeof raw.comfyUrl !== 'string' || typeof raw.outputDirectory !== 'string') return sendJson(response, 400, { error: 'A settings object with service URLs is required.' })
        return sendJson(response, 200, { settings: await saveSettings(normalizeSettings(raw)) })
      }
      if (url.pathname === '/api/lan/object-info' && request.method === 'GET') {
        return sendJson(response, 200, await comfyFetch(settings.comfyUrl, '/object_info'))
      }
      if (url.pathname === '/api/lan/comfy-status' && request.method === 'GET') {
        const candidate = url.searchParams.get('url') ?? settings.comfyUrl
        if (!isLocalServiceUrl(candidate)) return sendJson(response, 400, { error: 'Only local service addresses can be tested.' })
        const started = Date.now()
        try {
          const stats = await comfyFetch(candidate, '/system_stats')
          return sendJson(response, 200, { connected: true, latencyMs: Date.now() - started, stats })
        } catch (error) {
          return sendJson(response, 200, { connected: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) })
        }
      }
      if (url.pathname === '/api/lan/ollama/structured' && request.method === 'POST') {
        const body = await readJson(request, 1_000_000)
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
        if (!prompt || prompt.length > 50_000) return sendJson(response, 400, { error: 'A structured prompt is required.' })
        if (!body.schema || typeof body.schema !== 'object' || Array.isArray(body.schema)) return sendJson(response, 400, { error: 'A JSON schema is required.' })
        const data = await comfyFetch(settings.ollamaUrl, '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: settings.ollamaModel, messages: [{ role: 'user', content: prompt }], stream: false, think: false, format: body.schema, options: { temperature: 0.2, num_predict: 6000 } }),
        }) as { message?: { content?: string }; error?: string }
        const content = data.message?.content ? finalOllamaAnswer(data.message.content) : ''
        if (!content) return sendJson(response, 502, { error: data.error || 'Ollama returned an empty response.' })
        try { return sendJson(response, 200, { result: JSON.parse(content) }) } catch { return sendJson(response, 502, { error: 'Ollama returned a response that was not valid JSON.' }) }
      }
      if (url.pathname === '/api/lan/telemetry' && request.method === 'GET') return sendJson(response, 200, await readGpuTelemetry())
      if (url.pathname === '/api/lan/outputs/resolve' && request.method === 'GET') {
        const file = { filename: url.searchParams.get('filename') ?? '', subfolder: url.searchParams.get('subfolder') || undefined, type: url.searchParams.get('type') || undefined }
        const path = resolveOutputFile(settings.outputDirectory, file)
        if (!path) return sendJson(response, 404, { error: 'The output file was not found in the output directory.' })
        return sendJson(response, 200, { path, url: `/api/lan/media?source=output&path=${encodeURIComponent(path)}` })
      }
      if (url.pathname === '/api/lan/outputs/save-image' && request.method === 'POST') {
        const body = await readJson(request, 10_000)
        const file = typeof body.filename === 'string' ? { filename: body.filename, subfolder: typeof body.subfolder === 'string' ? body.subfolder : undefined, type: typeof body.type === 'string' ? body.type : undefined } : null
        if (!file?.filename) return sendJson(response, 400, { error: 'An output file reference is required.' })
        try { return sendJson(response, 200, await saveLanOutputImage(file)) } catch (error) { return sendJson(response, 502, { error: error instanceof Error ? error.message : String(error) }) }
      }
      if (url.pathname === '/api/lan/video/frame' && request.method === 'POST') {
        const body = await readJson(request, 200_000)
        const position = body.position === 'last' ? 'last' as const : Number(body.position)
        if (position !== 'last' && (!Number.isFinite(position) || position < 0)) return sendJson(response, 400, { error: 'A valid frame position is required.' })
        try {
          const input = await resolveLanVideoSource(body.source)
          const framesDirectory = join(settings.outputDirectory, 'MiniMax Studio Frames')
          await mkdir(framesDirectory, { recursive: true })
          const label = position === 'last' ? 'last' : `at_${Math.max(0, position).toFixed(2).replace('.', '-')}`
          const name = `frame_${label}_${Date.now()}.png`
          const output = join(framesDirectory, name)
          const seek = position === 'last' ? ['-sseof', '-0.15'] : ['-ss', String(Math.max(0, position))]
          await runFfmpeg(settings.ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...seek, '-i', input, '-map', '0:v:0', '-frames:v', '1', '-update', '1', '-y', output])
          const extracted = await stat(output).catch(() => null)
          if (!extracted?.size) return sendJson(response, 500, { error: 'FFmpeg completed without producing a frame. Check that the clip contains a video stream.' })
          return sendJson(response, 200, { path: output, name, url: `/api/lan/media?source=output&path=${encodeURIComponent(output)}` })
        } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) }
      }
      if (url.pathname === '/api/lan/video/frames' && request.method === 'POST') {
        const body = await readJson(request, 200_000)
        const positions = Array.isArray(body.positions) ? body.positions.map(Number) : []
        if (positions.length === 0 || positions.length > 100 || positions.some((position) => !Number.isFinite(position) || position < 0)) {
          return sendJson(response, 400, { error: 'Choose between 1 and 100 valid frame bookmarks.' })
        }
        try {
          const input = await resolveLanVideoSource(body.source)
          const framesDirectory = join(settings.outputDirectory, 'MiniMax Studio Frames')
          await mkdir(framesDirectory, { recursive: true })
          const batchId = Date.now()
          const outputs: Array<{ path: string; name: string; url: string }> = []
          for (let index = 0; index < positions.length; index += 1) {
            const position = positions[index]
            const name = `frame_at_${position.toFixed(2).replace('.', '-')}_${batchId}_${index + 1}.png`
            const output = join(framesDirectory, name)
            await runFfmpeg(settings.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-ss', String(position), '-i', input, '-map', '0:v:0', '-frames:v', '1', '-update', '1', '-y', output])
            const extracted = await stat(output).catch(() => null)
            if (!extracted?.size) return sendJson(response, 500, { error: `FFmpeg did not produce the bookmarked frame at ${position.toFixed(3)} seconds.` })
            outputs.push({ path: output, name, url: `/api/lan/media?source=output&path=${encodeURIComponent(output)}` })
          }
          return sendJson(response, 200, { frames: outputs })
        } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) }
      }
      if (url.pathname === '/api/lan/video/trim' && request.method === 'POST') {
        const body = await readJson(request, 200_000)
        const from = Number(body.start)
        const to = Number(body.end)
        const length = to - from
        if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || length < 2 || length > 15) {
          return sendJson(response, 400, { error: 'Reference clips must be between 2 and 15 seconds long.' })
        }
        try {
          const input = await resolveLanVideoSource(body.source)
          const directory = join(settings.outputDirectory, 'MiniMax Studio Reference Clips')
          await mkdir(directory, { recursive: true })
          const name = `Reference_Clip_${Date.now()}.mp4`
          const output = join(directory, name)
          await runFfmpeg(settings.ffmpegPath, [
            '-hide_banner', '-loglevel', 'error', '-ss', from.toFixed(3), '-i', input, '-t', length.toFixed(3),
            '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
            '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y', output,
          ])
          const created = await stat(output).catch(() => null)
          if (!created?.size) return sendJson(response, 500, { error: 'FFmpeg completed without producing a reference clip.' })
          return sendJson(response, 200, { path: output, name, url: `/api/lan/media?source=output&path=${encodeURIComponent(output)}` })
        } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) }
      }
      if (url.pathname === '/api/lan/video/join' && request.method === 'POST') {
        const body = await readJson(request, 5_000_000)
        const clips = Array.isArray(body.clips) ? body.clips as Array<Record<string, unknown>> : []
        if (clips.length < 2 || clips.length > 100) return sendJson(response, 400, { error: 'Provide between 2 and 100 clips to join.' })
        // Concat-directive injection guard: in/out points are numeric and
        // non-negative before they ever reach the ffmpeg list file.
        for (const clip of clips) {
          if (!clip || typeof clip !== 'object') return sendJson(response, 400, { error: 'Each clip needs a media source.' })
          for (const key of ['start', 'end']) {
            const value = clip[key]
            if (value !== undefined && (!Number.isFinite(Number(value)) || Number(value) < 0)) return sendJson(response, 400, { error: 'Clip in/out points must be non-negative numbers of seconds.' })
          }
        }
        try {
          const inputs = await Promise.all(clips.map((clip) => resolveLanVideoSource(clip.source)))
          const directory = join(settings.outputDirectory, 'video')
          await mkdir(directory, { recursive: true })
          const listPath = join(tmpdir(), `minimax-concat-${randomUUID()}.txt`)
          const escapePath = (path: string) => path.replace(/\\/g, '/').replace(/'/g, "'\\''")
          const list = inputs.map((path, index) => {
            const clip = clips[index]
            const start = Number(clip.start)
            const end = Number(clip.end)
            return [`file '${escapePath(path)}'`, Number.isFinite(start) && start > 0 ? `inpoint ${start}` : '', Number.isFinite(end) && end > (Number.isFinite(start) ? start : 0) ? `outpoint ${end}` : ''].filter(Boolean).join('\n')
          }).join('\n')
          await writeFile(listPath, list, 'utf8')
          const output = join(directory, `MiniMax_Joined_${Date.now()}.mp4`)
          await runFfmpeg(settings.ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-map', '0', '-c', 'copy', '-movflags', '+faststart', output])
          return sendJson(response, 200, { path: output, name: basename(output), url: `/api/lan/media?source=output&path=${encodeURIComponent(output)}` })
        } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) }
      }
      if (url.pathname === '/api/lan/media' && request.method === 'GET') {
        if (url.searchParams.get('source') === 'output') {
          const requested = url.searchParams.get('path') ?? ''
          const root = resolve(settings.outputDirectory)
          const candidate = requested ? resolve(requested) : root
          const containment = relative(root, candidate)
          if (!requested || containment.startsWith('..') || isAbsolute(containment)) return sendJson(response, 403, { error: 'Media is outside the configured output directory.' })
          if (!existsSync(candidate)) return sendJson(response, 404, { error: 'The media file is unavailable.' })
          return serveLocalMediaHttp(request, response, candidate)
        }
        return proxyLanMedia(request, response, url.searchParams)
      }
      return sendJson(response, 404, { error: 'Unknown mobile API route.' })
    }

    const distRoot = normalize(join(__dirname, '..', 'dist'))
    const requested = url.pathname === '/' || url.pathname === '/mobile' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const filePath = normalize(join(distRoot, requested))
    if (!(filePath === distRoot || filePath.startsWith(`${distRoot}\\`)) || !existsSync(filePath)) {
      const fallback = join(distRoot, 'index.html')
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }); return createReadStream(fallback).pipe(response)
    }
    const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }
    response.writeHead(200, { 'content-type': mime[extname(filePath).toLowerCase()] ?? 'application/octet-stream', 'cache-control': requested === 'index.html' ? 'no-cache' : 'public, max-age=86400', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' })
    createReadStream(filePath).pipe(response)
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
  }
}

async function startLanServer() {
  const configuredPort = Number(process.env.MINIMAX_LAN_PORT)
  const port = Number.isInteger(configuredPort) && configuredPort >= 1024 && configuredPort <= 65535 ? configuredPort : 4178
  lanToken = await loadLanToken()
  return new Promise<void>((resolve) => {
    lanServer = createServer((request, response) => void handleLanRequest(request, response))
    lanServer.once('error', (error) => { lanStatus = { running: false, port, error: error.message }; resolve() })
    lanServer.listen(port, '0.0.0.0', () => {
      const origin = `http://${lanAddress()}:${port}`
      lanStatus = { running: true, port, url: `${origin}/?mobile=1&token=${lanToken}`, desktopUrl: `${origin}/?desktop=1&token=${lanToken}` }
      resolve()
    })
  })
}

function runFfmpeg(executable: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const configured = executable.trim().replace(/^(["'])|(["'])$/g, '') || 'ffmpeg'
    const executableInFolder = join(configured, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
    const resolvedExecutable = existsSync(executableInFolder) ? executableInFolder : configured
    const child = spawn(resolvedExecutable, args, { windowsHide: true })
    let errorText = ''
    child.stderr.on('data', (chunk) => { errorText = `${errorText}${chunk}`.slice(-8000) })
    child.once('error', (error) => reject(new Error(`Could not start FFmpeg: ${error.message}`)))
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg failed (${code}). ${errorText.split('\n').slice(-5).join(' ')}`)))
  })
}

async function resolveVideoSource(source: string) {
  if (!source.startsWith('minimax-media:')) {
    if (!existsSync(source) || !mediaExtensions.has(extname(source).toLowerCase())) throw new Error('The selected video file is unavailable.')
    return source
  }
  const parsed = new URL(source)
  if (parsed.hostname === 'local' || parsed.hostname === 'selected') {
    const path = parsed.searchParams.get('path') ?? ''
    if (!existsSync(path) || !mediaExtensions.has(extname(path).toLowerCase())) throw new Error('The selected video file is unavailable.')
    return path
  }
  if (parsed.hostname === 'comfy') {
    const upstream = parsed.searchParams.get('url')
    if (!upstream) throw new Error('The ComfyUI video address is missing.')
    const configured = new URL(cleanUrl((await loadSettings()).comfyUrl))
    const target = new URL(upstream)
    if (target.origin !== configured.origin || target.pathname !== '/view') throw new Error('The video is outside the configured ComfyUI server.')
    const response = await fetch(target)
    if (!response.ok) throw new Error(`Could not retrieve the ComfyUI video (${response.status}).`)
    const temporary = join(app.getPath('temp'), `minimax-clip-${randomUUID()}.mp4`)
    await writeFile(temporary, Buffer.from(await response.arrayBuffer()))
    return temporary
  }
  throw new Error('Unsupported video source.')
}

function createWindow() {
  nativeTheme.themeSource = 'dark'
  const window = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 860,
    minHeight: 620,
    backgroundColor: '#0d100f',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#101412', symbolColor: '#d9e2dc', height: 42 },
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  window.setMenuBarVisibility(false)
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) void window.loadURL(devUrl)
  else void window.loadFile(join(__dirname, '..', 'dist', 'index.html'))
}

app.whenReady().then(async () => {
  await startLanServer()
  protocol.handle('minimax-media', async (request) => {
    const requestUrl = new URL(request.url)
    if (requestUrl.hostname === 'comfy') {
      const target = requestUrl.searchParams.get('url')
      if (!target) return new Response('Missing ComfyUI media URL', { status: 400 })
      const configuredUrl = new URL(cleanUrl((await loadSettings()).comfyUrl))
      const targetUrl = new URL(target)
      if (targetUrl.origin !== configuredUrl.origin || targetUrl.pathname !== '/view') {
        return new Response('Media URL is outside the configured ComfyUI server', { status: 403 })
      }
      const upstream = await net.fetch(targetUrl.toString(), { headers: request.headers })
      const headers = new Headers(upstream.headers)
      headers.delete('content-security-policy')
      headers.delete('content-disposition')
      headers.set('access-control-allow-origin', '*')
      return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers })
    }

    const requestedPath = requestUrl.searchParams.get('path')
    if (!requestedPath) return new Response('Missing media path', { status: 400 })
    if (requestUrl.hostname === 'selected') {
      if (!existsSync(requestedPath) || !selectedMediaExtensions.has(extname(requestedPath).toLowerCase())) return new Response('Selected media is unavailable', { status: 404 })
      return localMediaResponse(requestedPath, request)
    }
    const configured = normalize((await loadSettings()).outputDirectory)
    const candidate = normalize(requestedPath)
    const relative = candidate.toLowerCase().startsWith(`${configured.toLowerCase()}\\`) || candidate.toLowerCase() === configured.toLowerCase()
    if (!relative || !existsSync(candidate)) return new Response('Media is outside the configured output directory', { status: 403 })
    return localMediaResponse(candidate, request)
  })
  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('system:gpu-telemetry', () => readGpuTelemetry())
  ipcMain.handle('lan:status', () => lanStatus)
  ipcMain.handle('lan:sync-characters', (_event, characters: unknown[]) => { mobileCharacterLibrary = Array.isArray(characters) ? characters : []; return { synced: mobileCharacterLibrary.length } })
  ipcMain.handle('lan:rotate-token', async () => {
    lanToken = randomUUID().replace(/-/g, '')
    await saveLanToken(lanToken)
    if (lanStatus.running) {
      const origin = `http://${lanAddress()}:${lanStatus.port ?? 4178}`
      lanStatus = { ...lanStatus, url: `${origin}/?mobile=1&token=${lanToken}`, desktopUrl: `${origin}/?desktop=1&token=${lanToken}` }
    }
    return lanStatus
  })
  ipcMain.handle('settings:save', (_event, settings: AppSettings) => saveSettings(settings))
  ipcMain.handle('dialog:directory', async (_event, initialPath?: string) => {
    const result = await dialog.showOpenDialog({
      defaultPath: initialPath && existsSync(initialPath) ? initialPath : undefined,
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('dialog:media', async (_event, type: 'image' | 'video' | 'audio') => {
    const filters = {
      image: { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
      video: { name: 'Videos', extensions: ['mp4', 'mov', 'mkv', 'webm'] },
      audio: { name: 'Audio', extensions: ['wav', 'mp3', 'flac', 'm4a', 'ogg'] },
    }
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [filters[type]] })
    return result.canceled ? null : { path: result.filePaths[0], name: basename(result.filePaths[0]) }
  })
  ipcMain.handle('models:scan', async (_event, settings: AppSettings) => {
    const groups = await Promise.all(modelKinds.map((kind) => scanDirectory(settings.paths[kind], kind)))
    return groups.flat().sort((a, b) => a.name.localeCompare(b.name))
  })
  ipcMain.handle('comfy:status', async (_event, url: string) => {
    const started = Date.now()
    try {
      const stats = await comfyFetch(url, '/system_stats')
      return { connected: true, latencyMs: Date.now() - started, stats }
    } catch (error) {
      return { connected: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('comfy:submit', (_event, url: string, prompt: unknown, clientId?: string) =>
    comfyFetch(url, '/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: clientId ?? randomUUID() }),
    }),
  )
  ipcMain.handle('comfy:queue', (_event, url: string) => comfyFetch(url, '/queue'))
  ipcMain.handle('comfy:info', (_event, url: string) => comfyFetch(url, '/object_info'))
  ipcMain.handle('comfy:upload-data', async (_event, url: string, data: string) => {
    if (!data.startsWith('data:image/png;base64,') || data.length > 64_000_000) throw new Error('Invalid prepared image.')
    const form = new FormData()
    form.append('image', new Blob([Buffer.from(data.split(',')[1], 'base64')], { type: 'image/png' }), `frame-${randomUUID()}.png`)
    form.append('type', 'input')
    form.append('subfolder', 'minimax-desktop')
    return comfyFetch(url, '/upload/image', { method: 'POST', body: form })
  })
  ipcMain.handle('comfy:output-image', async (_event, url: string, file: { filename: string; subfolder?: string; type?: string }) => {
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? '', type: file.type ?? 'output' })
    const response = await fetch(`${cleanUrl(url)}/view?${query}`)
    if (!response.ok) throw new Error(`Image download failed (${response.status}).`)
    const mime = response.headers.get('content-type')?.split(';')[0] ?? ''
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new Error('ComfyUI did not return a supported image.')
    return `data:${mime};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`
  })
  ipcMain.handle('comfy:save-output-image', async (_event, url: string, file: { filename: string; subfolder?: string; type?: string }, requestedOutput: string) => {
    const settings = await loadSettings()
    const outputDirectory = normalize(requestedOutput)
    if (outputDirectory.toLowerCase() !== normalize(settings.outputDirectory).toLowerCase()) throw new Error('Character images must be saved inside the configured output folder.')
    const query = new URLSearchParams({ filename: basename(file.filename), subfolder: file.subfolder ?? '', type: file.type ?? 'output' })
    const response = await fetch(`${cleanUrl(url)}/view?${query}`)
    if (!response.ok) throw new Error(`Character image download failed (${response.status}).`)
    const mime = response.headers.get('content-type')?.split(';')[0] ?? ''
    const extension = mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : mime === 'image/png' ? '.png' : ''
    if (!extension) throw new Error('ComfyUI did not return a supported character image.')
    const directory = join(outputDirectory, 'MiniMax Character References')
    await mkdir(directory, { recursive: true })
    const target = join(directory, `character-${Date.now()}-${randomUUID().slice(0, 8)}${extension}`)
    await writeFile(target, Buffer.from(await response.arrayBuffer()))
    return { path: target, name: basename(target) }
  })
  ipcMain.handle('comfy:history', (_event, url: string, promptId: string) => comfyFetch(url, `/history/${encodeURIComponent(promptId)}`))
  ipcMain.handle('comfy:cancel', async (_event, url: string, promptId: string) => {
    if (!promptId || typeof promptId !== 'string') throw new Error('A ComfyUI prompt ID is required to cancel a generation.')
    const queue = await comfyFetch(url, '/queue') as { queue_running?: unknown[][]; queue_pending?: unknown[][] }
    const running = (queue.queue_running ?? []).some((item) => item[1] === promptId)
    const pending = (queue.queue_pending ?? []).some((item) => item[1] === promptId)
    if (running) {
      await comfyFetch(url, '/interrupt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt_id: promptId }),
      })
      return { cancelled: true, state: 'running' as const }
    }
    if (pending) {
      await comfyFetch(url, '/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: [promptId] }),
      })
      return { cancelled: true, state: 'pending' as const }
    }
    const history = await comfyFetch(url, `/history/${encodeURIComponent(promptId)}`) as Record<string, unknown>
    return { cancelled: false, state: promptId in history ? 'finished' as const : 'unknown' as const }
  })
  ipcMain.handle('outputs:resolve', (_event, outputDirectory: string, file: { filename: string; subfolder?: string; type?: string }) => {
    const path = resolveOutputFile(outputDirectory, file)
    return path ? `minimax-media://local?path=${encodeURIComponent(path)}` : null
  })
  ipcMain.handle('comfy:upload', async (_event, url: string, filePath: string, subfolder = 'minimax-desktop') => {
    const bytes = await readFile(filePath)
    const form = new FormData()
    form.append('image', new Blob([bytes]), basename(filePath))
    form.append('type', 'input')
    form.append('subfolder', subfolder)
    form.append('overwrite', 'true')
    return comfyFetch(url, '/upload/image', { method: 'POST', body: form })
  })
  ipcMain.handle('ollama:list', async (_event, url: string) => {
    const data = await comfyFetch(url, '/api/tags') as { models?: Array<{ name: string; size?: number; remote_model?: string; details?: { family?: string; parameter_size?: string } }> }
    return (data.models ?? []).map((model) => ({
      name: model.name,
      size: model.size ?? 0,
      family: model.details?.family ?? '',
      parameterSize: model.details?.parameter_size ?? '',
      local: !model.remote_model && model.size !== 342,
    }))
  })
  ipcMain.handle('ollama:generate', async (_event, url: string, model: string, prompt: string) => {
    const data = await comfyFetch(url, '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false, think: false, options: { temperature: 0.65, num_predict: 1200 } }),
    }) as { response?: string; error?: string }
    if (!data.response) throw new Error(data.error || 'Ollama returned an empty response.')
    const answer = finalOllamaAnswer(data.response)
    if (!answer) throw new Error('Ollama returned reasoning without a final answer.')
    return answer
  })
  ipcMain.handle('ollama:structured', async (_event, url: string, model: string, prompt: string, schema: Record<string, unknown>) => {
    const data = await comfyFetch(url, '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        think: false,
        format: schema,
        options: { temperature: 0.2, num_predict: 6000 },
      }),
    }) as { message?: { content?: string }; error?: string }
    const content = data.message?.content ? finalOllamaAnswer(data.message.content) : ''
    if (!content) throw new Error(data.error || 'Ollama returned an empty movie plan.')
    try { return JSON.parse(content) }
    catch { throw new Error('Ollama returned a movie plan that was not valid JSON.') }
  })
  ipcMain.handle('file:data-url', async (_event, filePath: string) => {
    const extension = extname(filePath).toLowerCase()
    const mime = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg'
    return `data:${mime};base64,${(await readFile(filePath)).toString('base64')}`
  })
  ipcMain.handle('file:media-url', (_event, filePath: string) => {
    if (!existsSync(filePath) || !selectedMediaExtensions.has(extname(filePath).toLowerCase())) throw new Error('The selected media is unavailable.')
    return `minimax-media://selected?path=${encodeURIComponent(filePath)}`
  })
  ipcMain.handle('video:frame', async (_event, source: string, position: number | 'last', outputDirectory: string, ffmpegPath: string) => {
    const input = await resolveVideoSource(source)
    const framesDirectory = join(outputDirectory, 'MiniMax Studio Frames')
    await mkdir(framesDirectory, { recursive: true })
    const label = position === 'last' ? 'last' : `at_${Math.max(0, position).toFixed(2).replace('.', '-')}`
    const name = `frame_${label}_${Date.now()}.png`
    const output = join(framesDirectory, name)
    const seek = position === 'last' ? ['-sseof', '-0.15'] : ['-ss', String(Math.max(0, position))]
    await runFfmpeg(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...seek, '-i', input, '-map', '0:v:0', '-frames:v', '1', '-update', '1', '-y', output])
    const extracted = await stat(output).catch(() => null)
    if (!extracted?.size) throw new Error('FFmpeg completed without producing a frame. Check that the clip contains a video stream.')
    return { path: output, name }
  })
  ipcMain.handle('video:frames', async (_event, source: string, positions: number[], outputDirectory: string, ffmpegPath: string) => {
    if (!Array.isArray(positions) || positions.length === 0 || positions.length > 100 || positions.some((position) => !Number.isFinite(position) || position < 0)) {
      throw new Error('Choose between 1 and 100 valid frame bookmarks.')
    }
    const input = await resolveVideoSource(source)
    const framesDirectory = join(outputDirectory, 'MiniMax Studio Frames')
    await mkdir(framesDirectory, { recursive: true })
    const batchId = Date.now()
    const outputs: Array<{ path: string; name: string }> = []
    for (let index = 0; index < positions.length; index += 1) {
      const position = positions[index]
      const label = `at_${position.toFixed(2).replace('.', '-')}`
      const name = `frame_${label}_${batchId}_${index + 1}.png`
      const output = join(framesDirectory, name)
      await runFfmpeg(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-ss', String(position), '-i', input, '-map', '0:v:0', '-frames:v', '1', '-update', '1', '-y', output])
      const extracted = await stat(output).catch(() => null)
      if (!extracted?.size) throw new Error(`FFmpeg did not produce the bookmarked frame at ${position.toFixed(3)} seconds.`)
      outputs.push({ path: output, name })
    }
    return outputs
  })
  ipcMain.handle('video:trim', async (_event, source: string, start: number, end: number, outputDirectory: string, ffmpegPath: string) => {
    const input = await resolveVideoSource(source)
    const from = Number(start)
    const to = Number(end)
    const length = to - from
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || length < 2 || length > 15) {
      throw new Error('Reference clips must be between 2 and 15 seconds long.')
    }
    const directory = join(outputDirectory, 'MiniMax Studio Reference Clips')
    await mkdir(directory, { recursive: true })
    const name = `Reference_Clip_${Date.now()}.mp4`
    const output = join(directory, name)
    await runFfmpeg(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-ss', from.toFixed(3), '-i', input, '-t', length.toFixed(3),
      '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-y', output,
    ])
    const created = await stat(output).catch(() => null)
    if (!created?.size) throw new Error('FFmpeg completed without producing a reference clip.')
    return { path: output, name }
  })
  ipcMain.handle('video:join', async (_event, clips: Array<{ source: string; start?: number; end?: number }>, outputDirectory: string, ffmpegPath: string) => {
    if (!Array.isArray(clips) || clips.length < 2) throw new Error('Add at least two clips to join.')
    const inputs = await Promise.all(clips.map((clip) => resolveVideoSource(clip.source)))
    const directory = join(outputDirectory, 'video')
    await mkdir(directory, { recursive: true })
    const listPath = join(app.getPath('temp'), `minimax-concat-${randomUUID()}.txt`)
    const escapePath = (path: string) => path.replace(/\\/g, '/').replace(/'/g, "'\\''")
    const list = inputs.map((path, index) => {
      const clip = clips[index]
      return [`file '${escapePath(path)}'`, clip.start && clip.start > 0 ? `inpoint ${clip.start}` : '', clip.end && clip.end > (clip.start ?? 0) ? `outpoint ${clip.end}` : ''].filter(Boolean).join('\n')
    }).join('\n')
    await writeFile(listPath, list, 'utf8')
    const output = join(directory, `MiniMax_Joined_${Date.now()}.mp4`)
    await runFfmpeg(ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-map', '0', '-c', 'copy', '-movflags', '+faststart', output])
    return { path: output, url: `minimax-media://local?path=${encodeURIComponent(output)}` }
  })
  ipcMain.handle('shell:show-output', async (_event, outputPath: string) => {
    if (!existsSync(outputPath)) await mkdir(outputPath, { recursive: true })
    const { shell } = await import('electron')
    shell.showItemInFolder(join(outputPath, '.'))
  })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((error) => {
  // A throw anywhere in startup (token write, protocol registration, window
  // creation) previously left a running process with no window.
  dialog.showErrorBox('MiniMax Studio failed to start', `Startup failed before the window could open:\n\n${error instanceof Error ? error.stack ?? error.message : String(error)}\n\nThe application will close.`)
  app.quit()
})

app.on('window-all-closed', () => {
  lanServer?.close()
  if (process.platform !== 'darwin') app.quit()
})
