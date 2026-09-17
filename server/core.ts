/**
 * The MiniMax Studio server core — every capability that is not Electron:
 * settings persistence, model scanning, the ComfyUI/Ollama proxy, ffmpeg
 * operations, GPU telemetry, and the HTTP API + static hosting that the web
 * renderer consumes. Both entry points share this module:
 *
 *   server/index.ts   — the standalone web server (the migration target)
 *   electron/main.ts  — the Electron shell (kept working until decommission)
 *
 * Nothing in this file may import from 'electron'.
 */
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { networkInterfaces, tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import WebSocket from 'ws'
import { FILMSTRIP_CELL_WIDTH, FILMSTRIP_FPS, filmstripLayout } from '../src/media/filmstripLayout'
import type { AppSettings, GpuTelemetry, LanStatus, ModelKind } from '../src/types'
import { failureRef, logEvent, logFailure } from './logger'
import { sanitizeEngineLogLine, sanitizeErrorMessage } from './logSanitize'
import { createStudioRepository, type StudioRepository } from './repo'
import { CANVAS_SCHEMA_VERSION, CanvasSchemaVersionError, DocumentsRuleError, PlanConflictError } from './documents'
import { exportProjectArchive, importProjectArchive } from './documentArchive'
import { createRealtimeHub, type RealtimeHub } from './realtime'
import { EngineProcess } from './engineProcess'
import { RuntimeManager, RuntimeConfigError } from './runtime'
import { ENGINE_PATCH_IDS, revertEnginePatch, ENGINE_PATCHES } from './enginePatch'
import { mergeEngineProfiles } from './engineProfiles'
import { checkAllNodePacks, findNodePack, installNodePack, isUsableCheckout, resolveVendorRoot, uninstallNodePack } from './engineNodes'
import { h3FormForScannedFile } from './modelForms'
import { FETCH_ENTRY_IDS, findFetchEntry } from './fetchCatalog'
import { FetchManager, transportForEnvironment } from './fetcher'
import { createLlmService, type LlmService } from './llm'
import { createRouterProvider } from './llm/providers/router'
import { familyManifest, inferFamily } from './llm/registry'
import { evaluateRequestGuard } from './requestGuard'
import { planVlmPass } from './datasets/vlm'
import { CLIP_CONSENT_ID, CLIP_LICENSE_SPDX, CLIP_MODEL_ID } from './datasets/curation'

export type StudioServerPaths = {
  settingsFile: string
  lanTokenFile: string
  tempDirectory: string
  documentsDirectory: string
  staticRoot: string
}

export type StudioServer = ReturnType<typeof createStudioServer>

const ltxUpscaleRequiredNodes = ['VAEEncodeTiled', 'LatentUpscaleModelLoader', 'LTXVLatentUpsampler', 'VAEDecodeTiled', 'ImageFromBatch', 'RepeatImageBatch', 'ImageBatch']
const ltxNativeRequiredNodes = ['LTXVConditioning', 'LTXVEmptyLatentAudio', 'EmptyLTXVLatentVideo', 'LTXVDualCFGGuider', 'LTXVSeparateAVLatent', 'LTXVConcatAVLatent', 'LTXVLatentUpsampler', 'LTXVAudioVAEDecode', 'ManualSigmas', 'VAEDecodeTiled', 'CLIPTextEncode', 'KSamplerSelect', 'SamplerCustomAdvanced']

const modelKinds: ModelKind[] = ['diffusion_models', 'text_encoders', 'vae', 'loras', 'vae_approx', 'clip_vision']
const modelExtensions = new Set(['.safetensors', '.pt', '.pth', '.gguf', '.onnx'])
const mediaExtensions = new Set(['.mp4', '.webm', '.mov', '.mkv'])

const mediaMimeTypes: Record<string, string> = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.flac': 'audio/flac', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.opus': 'audio/opus',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp',
}

function readGpuTelemetry(): Promise<GpuTelemetry> {
  return new Promise((resolvePromise) => {
    const child = spawn('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { windowsHide: true })
    let output = ''
    let settled = false
    const finish = (value: GpuTelemetry) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise(value)
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

/** Lazy sampler over readGpuTelemetry: each polling client asks every 4 s, so
 *  a cached sample with a matching TTL answers most requests without spawning
 *  nvidia-smi, while an idle server (nobody asking) spawns nothing at all —
 *  no free-running interval. Concurrent misses share one in-flight probe. */
const gpuTelemetryTtlMs = 4_000
let gpuTelemetrySample: { at: number; value: GpuTelemetry } | null = null
let gpuTelemetryInFlight: Promise<GpuTelemetry> | null = null

function readGpuTelemetrySampled(): Promise<GpuTelemetry> {
  if (gpuTelemetrySample && Date.now() - gpuTelemetrySample.at < gpuTelemetryTtlMs) return Promise.resolve(gpuTelemetrySample.value)
  if (!gpuTelemetryInFlight) {
    gpuTelemetryInFlight = readGpuTelemetry().then((value) => {
      gpuTelemetrySample = { at: Date.now(), value }
      return value
    }).finally(() => { gpuTelemetryInFlight = null })
  }
  return gpuTelemetryInFlight
}

function runFfmpeg(executable: string, args: string[]) {
  return new Promise<void>((resolvePromise, reject) => {
    const configured = executable.trim().replace(/^(["'])|(["'])$/g, '') || 'ffmpeg'
    const executableInFolder = join(configured, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
    const resolvedExecutable = existsSync(executableInFolder) ? executableInFolder : configured
    const child = spawn(resolvedExecutable, args, { windowsHide: true })
    let errorText = ''
    child.stderr.on('data', (chunk) => { errorText += String(chunk) })
    child.on('error', (error) => reject(new Error(`FFmpeg could not be started. Install FFmpeg or set its location in Settings.\n${error.message}`)))
    child.on('close', (code) => { if (code === 0) resolvePromise(); else reject(new Error(errorText.trim() || `FFmpeg exited with code ${code}.`)) })
  })
}

/** Probes a media file's duration with ffprobe (ffprobe ships next to ffmpeg
 *  in every standard install; the path is derived from the configured ffmpeg
 *  location). Any failure resolves null — callers fall back to their own
 *  duration hint. */
function probeMediaDurationSeconds(ffmpegExecutable: string, input: string): Promise<number | null> {
  return new Promise((resolve) => {
    const configured = ffmpegExecutable.trim().replace(/^(["'])|(["'])$/g, '') || 'ffmpeg'
    const probeName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
    const inConfiguredFolder = join(configured, probeName)
    const besideBinary = join(dirname(configured), probeName)
    const executable = existsSync(inConfiguredFolder) ? inConfiguredFolder : existsSync(besideBinary) ? besideBinary : probeName
    execFile(executable, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', input], { windowsHide: true, timeout: 15_000 }, (error, stdout) => {
      if (error) return resolve(null)
      const parsed = Number.parseFloat(String(stdout).trim().split(/\r?\n/)[0] ?? '')
      resolve(Number.isFinite(parsed) && parsed > 0 ? parsed : null)
    })
  })
}

function cleanUrl(url: string) {
  return url.trim().replace(/\/+$/, '')
}


/** Hard timeout for ComfyUI/Ollama calls: a hung engine socket must not hold
 *  server requests open forever. 60 s because /object_info legitimately runs
 *  slow on a cold first load. */
const COMFY_FETCH_TIMEOUT_MS = 60_000

async function comfyFetch(url: string, path: string, init?: RequestInit) {
  // SSRF guard (security hardening 1): every outbound service fetch goes
  // through this funnel, so the local-only rule is enforced once here —
  // settings.comfyUrl is no longer the exempt URL it once was.
  if (!isLocalServiceUrl(url)) throw new Error('The configured service address is not a local (loopback or private-LAN) address. Set a local engine URL in Settings.')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), COMFY_FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(`${cleanUrl(url)}${path}`, { ...init, signal: controller.signal })
    if (!response.ok) {
      const message = await response.text().catch(() => '')
      throw new Error(message || `ComfyUI returned ${response.status}`)
    }
    const contentType = response.headers.get('content-type') ?? ''
    return contentType.includes('application/json') ? response.json() : response.text()
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error(`ComfyUI request to ${path} timed out after ${Math.round(COMFY_FETCH_TIMEOUT_MS / 1000)} s.`)
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

/** Reduces a ComfyUI /prompt rejection body to the structural failure signal:
 *  per-node validation detail (node id + the engine's short reason, each
 *  fragment sanitized). Non-JSON bodies fall through to whole-text
 *  sanitization — either way no raw engine text crosses to the client. */
function structuralPromptError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as {
      node_errors?: Record<string, { errors?: Array<{ details?: unknown; extra_info?: { error_message?: unknown } }> }>
    }
    const nodeErrors = parsed.node_errors
    if (nodeErrors && typeof nodeErrors === 'object') {
      const ids = Object.keys(nodeErrors)
      const lines: string[] = []
      for (const id of ids.slice(0, 6)) {
        const errors = Array.isArray(nodeErrors[id]?.errors) ? nodeErrors[id].errors : []
        const first = errors[0] as { details?: unknown; extra_info?: { error_message?: unknown } } | undefined
        const detail = typeof first?.details === 'string' ? first.details : ''
        const message = typeof first?.extra_info?.error_message === 'string' ? first.extra_info.error_message : ''
        const text = sanitizeErrorMessage([detail, message].filter(Boolean).join(': '))
        if (text) lines.push(`node ${id}: ${text}`)
      }
      if (lines.length) return `Graph validation failed — ${lines.join('; ')}${ids.length > 6 ? ` (+${ids.length - 6} more nodes)` : ''}`
    }
  } catch { /* not JSON — whole-text sanitization below */ }
  return sanitizeErrorMessage(raw)
}

function comfyChoices(info: Record<string, unknown>, node: string, field: string) {
  const definition = info[node] as { input?: { required?: Record<string, unknown[]> } } | undefined
  const values = definition?.input?.required?.[field]?.[0]
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string') : []
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

/** A request body that is not valid JSON (audit minor, cleanup wave): the
 *  answer is a 400 naming the problem — never an opaque structural 500. */
class MalformedJsonBodyError extends Error {
  constructor() {
    super('The request body is not valid JSON.')
    this.name = 'MalformedJsonBodyError'
  }
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
  const text = Buffer.concat(chunks).toString('utf8') || '{}'
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new MalformedJsonBodyError()
  }
}

/** Shape-first validation for persisted job records (wave 1 storage): the
 *  scalar projection columns must be present with the right primitive types;
 *  everything else rides inside params_json untouched. Mirrors GenerationJob. */
function isStoredJobShape(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const job = value as Record<string, unknown>
  return typeof job.id === 'string' && job.id.length > 0 && job.id.length <= 200
    && typeof job.mode === 'string' && typeof job.status === 'string' && typeof job.prompt === 'string'
    && typeof job.createdAt === 'number' && Number.isFinite(job.createdAt)
    && typeof job.width === 'number' && Number.isFinite(job.width)
    && typeof job.height === 'number' && Number.isFinite(job.height)
    && typeof job.duration === 'number' && Number.isFinite(job.duration)
}

/** Minimal shape check for saved-prompt entries: id + prompt text; the
 *  repository coerces the optional metadata fields. */
function isPromptEntryShape(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 200
    && typeof entry.prompt === 'string' && entry.prompt.length > 0 && entry.prompt.length <= 50_000
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
  else if (entry?.outputs?.['99']) visit(entry.outputs['99'])
  else if (entry?.outputs?.['70']) visit(entry.outputs['70'])
  else if (entry?.outputs) visit(entry.outputs)
  return files.find((file) => kind === 'image' ? /\.(png|jpe?g|webp)$/i.test(file.filename) : /\.(mp4|webm|mov|mkv)$/i.test(file.filename))
}

/** Default LAN posture (2026-09-10 decision): open, like ComfyUI itself.
 *  Token gating stays available for hostile networks via --token or
 *  MINIMAX_LAN_TOKEN=1. */
function lanAuthRequired() {
  return process.argv.includes('--token') || /^(1|true|yes)$/i.test(process.env.MINIMAX_LAN_TOKEN ?? '')
}

/** Constant-time token comparison; digests are compared so token length is
 *  not leaked through comparison timing either. */
function tokenMatches(candidate: string | undefined, expected: string) {
  if (!candidate || !expected) return false
  const candidateDigest = createHash('sha256').update(candidate).digest()
  const expectedDigest = createHash('sha256').update(expected).digest()
  return timingSafeEqual(candidateDigest, expectedDigest)
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

/** Resolves a ComfyUI-reported output file inside the configured output
 *  directory. Attributing outputs by exact filename — instead of scanning for
 *  the newest file — is what keeps concurrent renders from being credited to
 *  the wrong job (and the wrong character library entry). */
/** Content-Security-Policy for the SPA document. ws:/wss: are required for
 *  the realtime fabric's /ws upgrade (and, over TLS, its secure twin). */
const CONTENT_SECURITY_POLICY = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"

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

/** Local file response for the privileged protocol (Electron shell) with
 *  Range support. The HTTP twin is serveLocalMediaHttp. */
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

/** Generates a self-signed certificate with openssl on first run and returns
 *  it with a SHA-256 fingerprint the user can verify against the console or
 *  a paired device. Returns null when openssl is unavailable (HTTP fall-
 *  back — the token-free default posture tolerates it; PWA install does not).
 */
async function ensureSelfSignedCertificate(directory: string, lanIp: string): Promise<{ certPem: string; keyPem: string; fingerprint: string } | null> {
  const certPath = join(directory, 'self-signed-cert.pem')
  const keyPath = join(directory, 'self-signed-key.pem')
  const fingerprintPath = join(directory, 'self-signed-fingerprint.txt')
  try {
    const existing = await Promise.all([readFile(certPath, 'utf8'), readFile(keyPath, 'utf8'), readFile(fingerprintPath, 'utf8')])
    if (existing[0] && existing[1] && existing[2]) return { certPem: existing[0], keyPem: existing[1], fingerprint: existing[2].trim() }
  } catch { /* Generate on first run. */ }
  try {
    await mkdir(directory, { recursive: true })
    await new Promise<void>((resolve, reject) => {
      execFile('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', keyPath, '-out', certPath, '-days', '3650',
        '-subj', '/CN=MiniMax Studio',
        '-addext', `subjectAltName=IP:${lanIp},IP:127.0.0.1,DNS:localhost`,
      ], { windowsHide: true }, (error) => { if (error) reject(error); else resolve() })
    })
    const [certPem, keyPem] = await Promise.all([readFile(certPath, 'utf8'), readFile(keyPath, 'utf8')])
    const fingerprint = await new Promise<string>((resolve, reject) => {
      execFile('openssl', ['x509', '-in', certPath, '-noout', '-fingerprint', '-sha256'], { windowsHide: true }, (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout.trim().replace(/^.*=/, '').replace(/:/g, '').toLowerCase())
      })
    })
    await writeFile(keyPath, keyPem, { encoding: 'utf8', mode: 0o600 })
    await writeFile(fingerprintPath, fingerprint, 'utf8')
    return { certPem, keyPem, fingerprint }
  } catch {
    return null
  }
}

export function createStudioServer(paths: StudioServerPaths) {
  let lanToken = ''
  let mobileCharacterLibrary: unknown[] = []
  let lanServer: Server | null = null
  let lanStatus: LanStatus = { running: false }
  // Origin-guard allowlist mirror (security hardening 1): refreshed whenever
  // settings load or save so both the HTTP handler and the WS upgrade path
  // (which must answer synchronously) see the same policy.
  let currentHostAllowlist: string[] = []

  // Studio database (wave 1 storage): better-sqlite3 with FTS5 in the same
  // home as settings.json. An open failure is DEGRADED, not fatal — the
  // storage routes below answer 503 with a logged reason while everything
  // else (SPA, settings, engine proxy) keeps working.
  let studioRepo: StudioRepository | null = null
  try {
    studioRepo = createStudioRepository(join(dirname(paths.settingsFile), 'studio.db'), {
      // Blob-registration scoping (security hardening 1): the live output
      // directory joins the studio home as a legal blob source.
      allowedSourceRoots: () => [join(loadSettingsCached().outputDirectory)],
    })
    logEvent({ kind: 'db.ready', file: 'studio.db' })
  } catch (error) {
    logFailure('db/open', error, undefined, 'error')
  }

  // Canvas Phase 0 (docs/specs/canvas-document-model.md): the document store
  // runs beside the old surface. The §6 legacy import runs ONCE on first
  // canvas boot — i.e. the first /api/lan/documents route hit — so a studio
  // that never opens the canvas never pays for it. A failed import leaves no
  // marker and retries on the next attempt (deterministic ids keep it clean).
  let documentsImportEnsured = false
  const ensureDocumentsImported = () => {
    if (!studioRepo || documentsImportEnsured) return
    documentsImportEnsured = true
    try {
      const report = studioRepo.documents.importLegacy({ characters: mobileCharacterLibrary })
      if (!report.alreadyImported) logEvent({ kind: 'documents.legacy-import', ...report.counts })
    } catch (error) {
      documentsImportEnsured = false
      logFailure('documents/legacy-import', error)
    }
  }

  // Realtime event fabric (wave 1): ONE WebSocket per client (plus an SSE v2
  // fallback) carrying job/telemetry/llm/engine/system channels and binary
  // preview frames, fanned out from ONE shared upstream ComfyUI socket. The
  // auth gate reuses the HTTP routes' constant-time token check; the GPU
  // sampler is the wave-0a lazy reader (no free-running interval without
  // subscribers); the SSRF guard keeps LLM streaming pointed at local routers.
  let realtimeComfyUrl = ''
  const realtimeHub: RealtimeHub = createRealtimeHub({
    authorize: (presented) => !lanAuthRequired() || tokenMatches(presented, lanToken),
    allowUpgrade: (request) => evaluateRequestGuard(request, {
      apiPathPrefix: '/api/lan',
      extraHostAllowlist: currentHostAllowlist,
      socketEncrypted: Boolean((request.socket as { encrypted?: boolean }).encrypted),
    }).allowed,
    comfyUrl: async () => (await loadSettings()).comfyUrl,
    readTelemetry: () => readGpuTelemetrySampled(),
    isLocalServiceUrl,
  })

  // EngineProcess supervision (wave 2c): sidecar lifecycle phases ride the
  // fabric's engine channel, and http readiness probes reuse the SAME
  // local-only SSRF guard the LLM channel enforces (the module default is
  // deny-all until this wiring runs, so probes fail closed, never open).
  // Phase detail is sanitized at this seam: engine stderr can echo input
  // values, and the PII-scrub doctrine (failure path/reason, never prompt
  // semantics) applies to the fabric exactly as it does to the logs.
  EngineProcess.setEngineSink((event) => realtimeHub.emitEngine(event.name, event.phase, event.detail ? sanitizeErrorMessage(event.detail) : event.detail, event.pid))
  EngineProcess.setUrlGuard(isLocalServiceUrl)

  // LLM layer (v2 wave): provider selection (llama.cpp router primary,
  // Ollama fallback), the layered prompt composer, vision captioning, and
  // VRAM unload choreography. Unload events surface on the SAME engine
  // channel the sidecars use, so one subscription observes both.
  const llm: LlmService = createLlmService({
    loadSettings,
    repo: () => studioRepo,
    isLocalServiceUrl,
    logEvent,
    logFailure,
    emitEngine: (name, phase, detail, pid) => realtimeHub.emitEngine(name, phase, detail, pid),
  })

  // Self-managed engine runtime (increment 1): supervises a ComfyUI the
  // studio launches itself from a user-nominated checkout, over the same
  // EngineProcess contract. When a managed engine becomes ready, managed
  // mode re-points comfyUrl at it — every existing seam (generation, the
  // realtime hub, the proxy) then just works. External mode never triggers
  // any of this.
  const runtime = new RuntimeManager({
    homeDirectory: dirname(paths.settingsFile),
    loadSettings,
    logEvent,
    logFailure,
    isLocalServiceUrl,
    onRunning: (url) => {
      void (async () => {
        const current = await loadSettings()
        if (current.engine.mode === 'managed' && current.comfyUrl !== url) await saveSettings({ ...current, comfyUrl: url })
      })().catch((error: unknown) => logFailure('engine/repoint-url', error, undefined, 'warn'))
    },
  })

  // Local-first fetcher (task hgjbea2): the ONLY place the studio touches
  // the internet. Consent is checked inside the manager (not the route), the
  // transport is the fixed-host HTTPS one (or the mock when the test env
  // var is set), and progress rides the fabric's system channel so the
  // Settings surface renders live download state.
  const fetcher = new FetchManager({
    homeDirectory: dirname(paths.settingsFile),
    loadSettings,
    logEvent,
    logFailure,
    transport: transportForEnvironment(),
    onProgress: (progress) => realtimeHub.emitSystem('fetch', progress),
  })

  function defaultSettings(): AppSettings {
    const root = join(paths.documentsDirectory, 'ComfyUI', 'models')
    return {
      comfyUrl: 'http://127.0.0.1:8188',
      ollamaUrl: 'http://127.0.0.1:11434',
      ollamaModel: 'qwen3:latest',
      modelRoot: root,
      paths: Object.fromEntries(modelKinds.map((kind) => [kind, join(root, kind)])) as Record<ModelKind, string>,
      outputDirectory: join(paths.documentsDirectory, 'ComfyUI', 'output'),
      ffmpegPath: existsSync('C:\\FFMPEG\\bin\\ffmpeg.exe') ? 'C:\\FFMPEG\\bin\\ffmpeg.exe' : 'ffmpeg',
      generationDefaults: {
        resolution: '1344x768', duration: 5, turbo: 'off', steps: 30,
        sampler: 'res_multistep', scheduler: 'simple', experimentalSampling: false,
        refImageSize: 'match', livePreview: true, sigmaShiftMode: 'model', shiftVideo: 12, shiftAudio: 3, loraStrength: 1, upscaleMode: 'off',
      },
      // LLM layer defaults: no router configured → exact Ollama-only behavior;
      // unload-on-generate is ON by default (VRAM hygiene), thinking OFF
      // (structured tasks are always off; freeform respects this default).
      llamaCppUrl: '',
      llamaCppModel: '',
      llamaVisionModel: '',
      llamaStickyModels: '',
      unloadLlmOnGenerate: true,
      llmThinkingDefault: 'off',
      promptContentLevel: 'sfw',
      // Managed engine runtime (increment 1): external default = today's
      // behavior, exactly. Nothing spawns, polls, or re-points unless the
      // user switches the mode AND nominates a checkout. Increment 2 adds
      // launch profiles (default/vdn seeds) and an EMPTY patch-consent
      // ledger — no patch may ever apply without a recorded consent.
      engine: { mode: 'external', checkoutPath: '', pythonPath: '', portPreference: 0, autoStart: false, profile: 'default', profiles: mergeEngineProfiles({}, ENGINE_PATCH_IDS).profiles, patches: {} },
      // Local-first fetcher (task hgjbea2): an EMPTY consent ledger — the
      // network is never touched without a recorded, license-matching
      // consent for a catalog id.
      fetch: { consents: {} },
      // Origin guard (security hardening 1): extra Host names the LAN server
      // may answer for (custom hostnames; IP literals, localhost and *.local
      // are always allowed). Empty by default — nobody needs to opt in to be
      // rebinding-protected.
      lanHostAllowlist: [],
    }
  }

  /** Path-shape rules (security hardening 1): everything the studio SPAWNS
   *  (ffmpeg, managed-engine python) or WRITES THROUGH (output directory)
   *  must be absolute when set at all — a relative path resolves against an
   *  unpredictable cwd, which is both a bug and an attack surface. The bare
   *  'ffmpeg' default (PATH-resolved) is the one sanctioned non-absolute
   *  value. Empty means "auto" for python/checkout. Returns a problem
   *  description per offending field; empty array = shape is fine. */
  function settingsPathProblems(candidate: Partial<AppSettings>): string[] {
    const problems: string[] = []
    const isAbsoluteOrEmpty = (value: string) => !value || isAbsolute(value)
    if (!isAbsoluteOrEmpty(String(candidate.outputDirectory ?? ''))) problems.push('outputDirectory must be an absolute path.')
    const ffmpeg = String(candidate.ffmpegPath ?? '')
    if (ffmpeg && !isAbsolute(ffmpeg) && /[/\\]/.test(ffmpeg)) problems.push('ffmpegPath must be an absolute path (or the bare "ffmpeg" to resolve via PATH).')
    if (!isAbsoluteOrEmpty(String(candidate.engine?.pythonPath ?? ''))) problems.push('engine.pythonPath must be an absolute path.')
    if (!isAbsoluteOrEmpty(String(candidate.engine?.checkoutPath ?? ''))) problems.push('engine.checkoutPath must be an absolute path.')
    if (!isAbsoluteOrEmpty(String(candidate.modelRoot ?? ''))) problems.push('modelRoot must be an absolute path.')
    for (const kind of modelKinds) {
      if (!isAbsoluteOrEmpty(String(candidate.paths?.[kind] ?? ''))) problems.push(`paths.${kind} must be an absolute path.`)
    }
    return problems
  }

  function normalizeSettings(raw: Partial<AppSettings>): AppSettings {
    const defaults = defaultSettings()
    const generationDefaults = { ...defaults.generationDefaults, ...raw.generationDefaults }
    generationDefaults.steps = Math.max(16, Math.min(30, Number(generationDefaults.steps) || 30))
    if (raw.generationDefaults?.steps === 20) generationDefaults.steps = 30
    const stringField = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback)
    // Path-shape backstop (security hardening 1): a hostile or corrupted
    // settings.json must not smuggle relative spawn/write paths past the
    // load path (the WRITE route refuses them loudly; this coerces what is
    // already on disk, with one log line per drop so it is never silent).
    const shapeProblems = settingsPathProblems(raw)
    const sanitized: Partial<AppSettings> = { ...raw }
    if (shapeProblems.some((problem) => problem.startsWith('outputDirectory'))) sanitized.outputDirectory = defaults.outputDirectory
    if (shapeProblems.some((problem) => problem.startsWith('ffmpegPath'))) sanitized.ffmpegPath = defaults.ffmpegPath
    if (shapeProblems.some((problem) => problem.startsWith('engine.pythonPath'))) sanitized.engine = { ...(sanitized.engine ?? defaults.engine), pythonPath: '' }
    if (shapeProblems.some((problem) => problem.startsWith('engine.checkoutPath'))) sanitized.engine = { ...(sanitized.engine ?? defaults.engine), checkoutPath: '' }
    if (shapeProblems.some((problem) => problem.startsWith('modelRoot'))) sanitized.modelRoot = defaults.modelRoot
    if (shapeProblems.some((problem) => problem.includes(`paths.`))) sanitized.paths = { ...defaults.paths, ...raw.paths }
    if (sanitized.paths) {
      for (const kind of modelKinds) {
        if (sanitized.paths[kind] && !isAbsolute(sanitized.paths[kind])) sanitized.paths = { ...sanitized.paths, [kind]: defaults.paths[kind] }
      }
    }
    if (shapeProblems.length) logEvent({ kind: 'settings.path-shape-coerced', problems: shapeProblems.length })
    return {
      ...defaults,
      ...sanitized,
      paths: { ...defaults.paths, ...sanitized.paths },
      generationDefaults,
      llamaCppUrl: stringField(raw.llamaCppUrl, defaults.llamaCppUrl).trim(),
      llamaCppModel: stringField(raw.llamaCppModel, defaults.llamaCppModel).trim(),
      llamaVisionModel: stringField(raw.llamaVisionModel, defaults.llamaVisionModel).trim(),
      llamaStickyModels: stringField(raw.llamaStickyModels, defaults.llamaStickyModels).trim(),
      unloadLlmOnGenerate: raw.unloadLlmOnGenerate === undefined ? defaults.unloadLlmOnGenerate : raw.unloadLlmOnGenerate !== false,
      llmThinkingDefault: raw.llmThinkingDefault === 'on' ? 'on' : 'off',
      promptContentLevel: raw.promptContentLevel === 'nsfw' || raw.promptContentLevel === 'suggestive' ? raw.promptContentLevel : 'sfw',
      engine: {
        mode: sanitized.engine?.mode === 'managed' ? 'managed' : 'external',
        checkoutPath: stringField(sanitized.engine?.checkoutPath, '').trim(),
        pythonPath: stringField(sanitized.engine?.pythonPath, '').trim(),
        portPreference: Number.isInteger(raw.engine?.portPreference) && (raw.engine?.portPreference as number) >= 1024 && (raw.engine?.portPreference as number) <= 65535 ? raw.engine?.portPreference as number : 0,
        autoStart: raw.engine?.autoStart === true,
        // Launch profiles (increment 2): stored profiles overlay the seeds;
        // malformed ids/keys/hooks are DROPPED with one log line — a corrupt
        // settings file must not become a weird launch environment.
        profile: typeof raw.engine?.profile === 'string' && raw.engine.profile.trim() ? raw.engine.profile.trim().slice(0, 40) : 'default',
        profiles: (() => {
          const merged = mergeEngineProfiles(raw.engine?.profiles, ENGINE_PATCH_IDS)
          if (merged.dropped.length) logEvent({ kind: 'engine.profiles-normalized', dropped: merged.dropped })
          return merged.profiles
        })(),
        // Consent ledger: only well-formed records for KNOWN patches survive.
        patches: (() => {
          const ledger: NonNullable<AppSettings['engine']['patches']> = {}
          const rawLedger = (raw.engine?.patches && typeof raw.engine.patches === 'object' ? raw.engine.patches : {}) as Record<string, unknown>
          for (const id of Object.keys(rawLedger)) {
            if (!ENGINE_PATCH_IDS.has(id)) continue
            const record = rawLedger[id] as { consented?: unknown; at?: unknown; comfyVersion?: unknown } | null
            if (record && typeof record === 'object') {
              ledger[id] = {
                consented: record.consented === true,
                ...(typeof record.at === 'number' ? { at: record.at } : {}),
                ...(typeof record.comfyVersion === 'string' ? { comfyVersion: record.comfyVersion } : {}),
              }
            }
          }
          return ledger
        })(),
      },
      // Fetcher consent ledger (task hgjbea2): only well-formed records for
      // KNOWN catalog ids survive, and each records the license it
      // acknowledged — a catalog license change invalidates the consent.
      // (Security wave 2: the dataset CLIP embedder records its consent in
      // the same ledger under its own stable id — its download is performed
      // by transformers.js itself, not the fetch engine, so it is not a
      // catalog entry; the license-match rule applies to it identically.)
      fetch: {
        consents: (() => {
          const ledger: NonNullable<AppSettings['fetch']['consents']> = {}
          const rawLedger = (raw.fetch?.consents && typeof raw.fetch.consents === 'object' ? raw.fetch.consents : {}) as Record<string, unknown>
          for (const id of Object.keys(rawLedger)) {
            if (!FETCH_ENTRY_IDS.has(id) && id !== CLIP_CONSENT_ID) continue
            const record = rawLedger[id] as { consented?: unknown; at?: unknown; licenseSpdx?: unknown } | null
            if (record && typeof record === 'object' && typeof record.licenseSpdx === 'string' && record.licenseSpdx) {
              ledger[id] = {
                consented: record.consented === true,
                licenseSpdx: record.licenseSpdx,
                ...(typeof record.at === 'number' ? { at: record.at } : {}),
              }
            }
          }
          return ledger
        })(),
      },
      // Origin-guard allowlist (security hardening 1): lowercase, portless,
      // bounded — the Host check treats these as extra allowed names.
      lanHostAllowlist: (Array.isArray(raw.lanHostAllowlist) ? raw.lanHostAllowlist : [])
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim().toLowerCase().slice(0, 253))
        .filter(Boolean)
        .slice(0, 32),
    }
  }

  // Settings cache: every LAN request (including each media Range seek) needs
  // the settings, and reading + parsing settings.json per request showed up in
  // the perf audit. The file is only ever written through saveSettings in this
  // process, so an in-memory copy invalidated on save keeps the exact same
  // semantics (a concurrent external edit of settings.json is not a supported
  // flow; restart to pick one up).
  let settingsCache: AppSettings | null = null

  /** Synchronous peek for closures that cannot await (the blob-scope
   *  resolver). Answers the cache when warm, defaults before the first load —
   *  every API path that registers blobs has already awaited loadSettings. */
  function loadSettingsCached(): AppSettings {
    return settingsCache ?? defaultSettings()
  }

  async function loadSettings(): Promise<AppSettings> {
    if (settingsCache) return settingsCache
    try {
      settingsCache = normalizeSettings(JSON.parse(await readFile(paths.settingsFile, 'utf8')) as Partial<AppSettings>)
    } catch (error) {
      // First run (no file yet) or a corrupted settings.json — either way we
      // fall back to defaults; the debug line records which, because a
      // silently discarded settings file is exactly the comma-we-didn't-parse
      // class of failure the diagnostics seam exists for.
      logFailure('settings/load', error, undefined, 'debug')
      settingsCache = defaultSettings()
    }
    currentHostAllowlist = settingsCache.lanHostAllowlist ?? []
    return settingsCache
  }

  async function saveSettings(settings: AppSettings) {
    currentHostAllowlist = settings.lanHostAllowlist ?? []
    await mkdir(dirname(paths.settingsFile), { recursive: true })
    // Write-then-rename so a crash mid-write can never leave settings.json half
    // written — loadSettings treats unparseable content as "reset to defaults",
    // which would silently discard every configured path.
    const staged = `${paths.settingsFile}.tmp`
    await writeFile(staged, JSON.stringify(settings, null, 2), 'utf8')
    await rename(staged, paths.settingsFile)
    settingsCache = settings
    // A changed ComfyUI address must re-point the fabric's shared upstream on
    // the next connect, not stay pinned to the origin from boot time.
    if (settings.comfyUrl !== realtimeComfyUrl) {
      realtimeComfyUrl = settings.comfyUrl
      realtimeHub.invalidateUpstream()
    }
    return settings
  }

  async function saveLanToken(token: string) {
    await mkdir(dirname(paths.lanTokenFile), { recursive: true })
    await writeFile(paths.lanTokenFile, token, { encoding: 'utf8', mode: 0o600 })
  }

  async function loadLanToken() {
    try {
      const stored = (await readFile(paths.lanTokenFile, 'utf8')).trim()
      if (/^[a-f0-9]{32}$/i.test(stored)) return stored
    } catch { /* Create the persistent token on first launch. */ }
    const created = randomUUID().replace(/-/g, '')
    await saveLanToken(created)
    return created
  }

  async function scanDirectory(root: string, kind: ModelKind) {
    const results: Array<{ name: string; path: string; kind: ModelKind; bytes: number; h3Form?: string }> = []
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
        // Symlinks resolve through stat (the central-registry layout is
        // link-never-copy: most models on a shared install are symlinks, and
        // a Dirent type test alone hides them). Dangling links throw in the
        // stat below and are skipped like any unreadable entry.
        let linked: 'file' | 'dir' | null = null
        if (entry.isSymbolicLink()) {
          try {
            const resolved = await stat(fullPath)
            linked = resolved.isDirectory() ? 'dir' : resolved.isFile() ? 'file' : null
          } catch {
            linked = null
          }
        }
        if (entry.isDirectory() || linked === 'dir') {
          if (!entry.name.startsWith('.')) pending.push(fullPath)
        } else if ((entry.isFile() || linked === 'file') && modelExtensions.has(extname(entry.name).toLowerCase())) {
          // Skip unreadable files instead of rejecting the whole scan — one
          // EACCES entry must not blank the model list.
          try {
            const info = await stat(fullPath)
            // H3 adaln form tag (task k271ykk): header-only read, one call
            // per scanned file; an unreadable/exotic header degrades to "no
            // tag", never to a failed scan. Diffusion models tag curve/full;
            // LoRAs tag adaln-free/curve-adaln/full-width-adaln.
            const h3Form = await h3FormForScannedFile(fullPath, kind)
            results.push({ name: entry.name, path: fullPath, kind, bytes: info.size, ...(h3Form ? { h3Form } : {}) })
          } catch { /* Unreadable entry; leave it out. */ }
        }
      }
    }
    return results
  }

  async function scanModels(settings: AppSettings) {
    const groups = await Promise.all(modelKinds.map((kind) => scanDirectory(settings.paths[kind], kind)))
    return groups.flat().sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Permissive source resolution for the Electron bridge: raw paths,
   *  minimax-media:// URLs, and ComfyUI /view URLs (downloaded to temp). */
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
      if (!isLocalServiceUrl(configured.origin)) throw new Error('The configured ComfyUI address is not a local service address.')
      const target = new URL(upstream)
      if (target.origin !== configured.origin || target.pathname !== '/view') throw new Error('The video address is outside the configured ComfyUI server.')
      const temporary = join(paths.tempDirectory, `minimax-clip-${randomUUID()}.mp4`)
      const response = await fetch(target)
      if (!response.ok) throw new Error('The ComfyUI video could not be downloaded.')
      await writeFile(temporary, Buffer.from(await response.arrayBuffer()))
      return temporary
    }
    throw new Error('The video source is not supported.')
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
        // Canvas blob references resolve through the verified content-
        // addressed tree (the m3 wrong-file guard: renders extract frames
        // from the take's registered blob, not a stale absolute path).
        if (spec.output.startsWith('canvas-blobs/')) {
          const resolved = studioRepo?.documents.resolveBlobFile(spec.output)
          if (!resolved) throw new Error('The requested blob is unavailable.')
          return resolved.absPath
        }
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
        if (!isLocalServiceUrl(settings.comfyUrl)) throw new Error('The configured ComfyUI address is not a local service address.')
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

  /** Saves a ComfyUI-generated image into the output directory's character
   *  reference folder (shared by the IPC bridge and the LAN route). */
  async function saveOutputImage(file: { filename: string; subfolder?: string; type?: string }, outputDirectory: string, comfyUrl: string) {
    if (file.filename.includes('/') || file.filename.includes('\\')) throw new Error('A valid output file reference is required.')
    if (!isLocalServiceUrl(comfyUrl)) throw new Error('The configured ComfyUI address is not a local service address.')
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? '', type: file.type ?? 'output' })
    const response = await fetch(`${cleanUrl(comfyUrl)}/view?${query}`)
    if (!response.ok) throw new Error('The generated image is unavailable from ComfyUI.')
    const directory = join(outputDirectory, 'MiniMax Character References')
    await mkdir(directory, { recursive: true })
    const extension = extname(file.filename) || '.png'
    const target = join(directory, `character-${Date.now()}-${randomUUID().slice(0, 8)}${extension}`)
    await writeFile(target, Buffer.from(await response.arrayBuffer()))
    return { path: target, name: basename(target) }
  }

  // Shared ffmpeg operations — both the IPC bridge and the LAN routes call
  // these with an already-resolved local input path.
  async function extractVideoFrameAt(input: string, position: number | 'last', outputDirectory: string, ffmpegPath: string) {
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
  }

  async function extractVideoFramesAt(input: string, positions: number[], outputDirectory: string, ffmpegPath: string) {
    if (positions.length === 0 || positions.length > 100 || positions.some((position) => !Number.isFinite(position) || position < 0)) {
      throw new Error('Choose between 1 and 100 valid frame bookmarks.')
    }
    const framesDirectory = join(outputDirectory, 'MiniMax Studio Frames')
    await mkdir(framesDirectory, { recursive: true })
    const batchId = Date.now()
    const outputs: Array<{ path: string; name: string }> = []
    for (let index = 0; index < positions.length; index += 1) {
      const position = positions[index]
      const name = `frame_at_${position.toFixed(2).replace('.', '-')}_${batchId}_${index + 1}.png`
      const output = join(framesDirectory, name)
      await runFfmpeg(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-ss', String(position), '-i', input, '-map', '0:v:0', '-frames:v', '1', '-update', '1', '-y', output])
      const extracted = await stat(output).catch(() => null)
      if (!extracted?.size) throw new Error(`FFmpeg did not produce the bookmarked frame at ${position.toFixed(3)} seconds.`)
      outputs.push({ path: output, name })
    }
    return outputs
  }

  async function trimVideoAt(input: string, start: number, end: number, outputDirectory: string, ffmpegPath: string) {
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
  }

  async function joinVideosAt(inputs: string[], clips: Array<{ start?: unknown; end?: unknown }>, outputDirectory: string, ffmpegPath: string) {
    const directory = join(outputDirectory, 'video')
    await mkdir(directory, { recursive: true })
    const listPath = join(paths.tempDirectory, `minimax-concat-${randomUUID()}.txt`)
    const escapePath = (path: string) => path.replace(/\\/g, '/').replace(/'/g, "'\\''")
    const list = inputs.map((path, index) => {
      const clip = clips[index]
      const start = Number(clip.start)
      const end = Number(clip.end)
      return [`file '${escapePath(path)}'`, Number.isFinite(start) && start > 0 ? `inpoint ${start}` : '', Number.isFinite(end) && end > (Number.isFinite(start) ? start : 0) ? `outpoint ${end}` : ''].filter(Boolean).join('\n')
    }).join('\n')
    await writeFile(listPath, list, 'utf8')
    const output = join(directory, `MiniMax_Joined_${Date.now()}.mp4`)
    await runFfmpeg(ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-map', '0', '-c', 'copy', '-movflags', '+faststart', output])
    return { path: output, name: basename(output) }
  }

  // ---- Filmstrip sprite sheets (wave 2d) -----------------------------------
  // One server-generated PNG per output video — the thumbnail substrate for
  // Library cards, Queue rows, and the ClipEditor bin/timeline, replacing a
  // <video> mount per item (the HTTP/1.1 6-connection ceiling). The layout
  // math is shared with the client through src/media/filmstripLayout.ts so
  // cols/rows/frameCount agree on both sides. Sheets are cached in a
  // dot-folder next to the existing frames directory (nothing user-visible),
  // content-addressed by the source's path hash, invalidated when the source
  // is newer than the sheet, and single-flown: concurrent first requests
  // share ONE ffmpeg run through the in-flight map.
  type FilmstripSheet = { path: string; cols: number; rows: number; frameCount: number; sourceMtimeMs: number; sourceBytes: number }
  let filmstripGenerationCount = 0
  const filmstripsInFlight = new Map<string, Promise<FilmstripSheet>>()

  async function generateFilmstripSheet(input: string, outputDirectory: string, ffmpegPath: string, durationHint: number | null): Promise<FilmstripSheet> {
    const root = resolve(outputDirectory)
    const source = await stat(input)
    if (!source.isFile()) throw new Error('The media file is unavailable.')
    const duration = durationHint && durationHint > 0 ? durationHint : (await probeMediaDurationSeconds(ffmpegPath, input)) ?? 5
    const layout = filmstripLayout(duration)
    const cacheDirectory = join(root, 'MiniMax Studio Frames', '.filmstrips')
    await mkdir(cacheDirectory, { recursive: true })
    const sourceKey = createHash('sha256').update(relative(root, input) || basename(input)).digest('hex').slice(0, 12)
    const sheetPath = join(cacheDirectory, `${basename(input, extname(input))}.${sourceKey}.${layout.cols}x${layout.rows}.png`)
    const cached = await stat(sheetPath).catch(() => null)
    if (cached?.isFile() && cached.size > 0 && cached.mtimeMs >= source.mtimeMs) {
      return { path: sheetPath, cols: layout.cols, rows: layout.rows, frameCount: layout.frameCount, sourceMtimeMs: source.mtimeMs, sourceBytes: source.size }
    }
    filmstripGenerationCount += 1
    logEvent({ kind: 'filmstrip.generate', file: basename(sheetPath), cols: layout.cols, rows: layout.rows })
    await runFfmpeg(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-ss', '0', '-i', input, '-map', '0:v:0',
      '-vf', `fps=${layout.fps},scale=${FILMSTRIP_CELL_WIDTH}:-2,tile=${layout.cols}x${layout.rows}`,
      '-frames:v', '1', '-y', sheetPath,
    ])
    const generated = await stat(sheetPath).catch(() => null)
    if (!generated?.size) throw new Error('FFmpeg completed without producing a filmstrip sheet. Check that the clip contains a video stream.')
    return { path: sheetPath, cols: layout.cols, rows: layout.rows, frameCount: layout.frameCount, sourceMtimeMs: source.mtimeMs, sourceBytes: source.size }
  }

  /** Single-flight wrapper: concurrent requests for the same input path
   *  (three cards thumbnailing the same render, or the attribution warm
   *  start racing the first GET) share one generation promise. */
  function getFilmstripSheet(input: string, outputDirectory: string, ffmpegPath: string, durationHint: number | null): Promise<FilmstripSheet> {
    const pending = filmstripsInFlight.get(input)
    if (pending) return pending
    const run = generateFilmstripSheet(input, outputDirectory, ffmpegPath, durationHint)
      .finally(() => { filmstripsInFlight.delete(input) })
    filmstripsInFlight.set(input, run)
    return run
  }

  async function cancelPromptAt(comfyUrl: string, promptId: string) {
    if (!promptId) throw new Error('A ComfyUI prompt ID is required to cancel a generation.')
    const queue = await comfyFetch(comfyUrl, '/queue') as { queue_running?: unknown[][]; queue_pending?: unknown[][] }
    const running = (queue.queue_running ?? []).some((item) => item[1] === promptId)
    const pending = (queue.queue_pending ?? []).some((item) => item[1] === promptId)
    if (running) {
      await comfyFetch(comfyUrl, '/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt_id: promptId }) })
      return { cancelled: true, state: 'running' as const }
    }
    if (pending) {
      await comfyFetch(comfyUrl, '/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: [promptId] }) })
      return { cancelled: true, state: 'pending' as const }
    }
    const history = await comfyFetch(comfyUrl, `/history/${encodeURIComponent(promptId)}`) as Record<string, unknown>
    return { cancelled: false, state: promptId in history ? 'finished' as const : 'unknown' as const }
  }

  async function uploadFileAt(comfyUrl: string, filePath: string, subfolder = 'minimax-desktop') {
    const bytes = await readFile(filePath)
    const form = new FormData()
    form.append('image', new Blob([bytes]), basename(filePath))
    form.append('type', 'input')
    form.append('subfolder', subfolder)
    form.append('overwrite', 'true')
    return comfyFetch(comfyUrl, '/upload/image', { method: 'POST', body: form })
  }

  /** HTTP (non-protocol) local file serving with Range support, for the LAN
   *  API. HEAD answers with the exact GET headers (Content-Length, Range
   *  metadata) and no body, so players can probe seekability cheaply. */
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
    if (request.method === 'HEAD') return response.end()
    createReadStream(filePath, { start, end }).pipe(response)
  }

  async function proxyLanMedia(request: IncomingMessage, response: ServerResponse, search: URLSearchParams) {
    const filename = search.get('filename') ?? ''
    if (!filename || filename.includes('/') || filename.includes('\\')) return sendJson(response, 400, { error: 'Invalid output filename.' })
    // Subfolders may nest (video/…) but must not traverse or escape.
    const requestedSubfolder = search.get('subfolder') ?? ''
    if (requestedSubfolder && (isAbsolute(requestedSubfolder) || requestedSubfolder.split(/[\\/]/).includes('..'))) return sendJson(response, 400, { error: 'Invalid output subfolder.' })
    const settings = await loadSettings()
    if (!isLocalServiceUrl(settings.comfyUrl)) return sendJson(response, 400, { error: 'The configured ComfyUI address is not a local service address.' })
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

  function streamLanEvents(request: IncomingMessage, response: ServerResponse, search: URLSearchParams, comfyUrl: string) {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 15_000)
    let socket: WebSocket | null = null
    const forward = (data: unknown) => response.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`)
    const connect = () => {
      if (!isLocalServiceUrl(comfyUrl)) { forward({ type: 'error', error: 'The configured ComfyUI address is not a local service address.' }); return }
      const clientId = search.get('clientId') ?? ''
      const target = new URL(cleanUrl(comfyUrl))
      socket = new WebSocket(`${target.origin.replace(/^http/, 'ws')}/ws${clientId ? `?clientId=${encodeURIComponent(clientId)}` : ''}`)
      socket.binaryType = 'nodebuffer'
      socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) {
          const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
          const event = buffer.subarray(0, 8).toString('utf8')
          const mime = buffer.subarray(8, 24).toString('utf8').replace(/\0.*$/, '')
          const payload = buffer.subarray(24)
          forward({ type: 'preview', event, mime, data: payload.toString('base64') })
        } else {
          const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
          try { forward(JSON.parse(text)) } catch { forward(text) }
        }
      })
      socket.on('error', (error: Error) => { logFailure('events/socket', error, undefined, 'debug'); socket?.close() })
      // A ComfyUI restart must not freeze every connected stream: reconnect
      // the upstream while the SSE client is still here.
      socket.on('close', () => { if (!response.writableEnded) retry = setTimeout(connect, 3000) })
    }
    let retry: ReturnType<typeof setTimeout> | undefined
    connect()
    request.on('close', () => { clearInterval(heartbeat); clearTimeout(retry); socket?.close() })
  }

  /** Setup doctor: verifies the local toolchain (ffmpeg, openssl), probes
   *  ComfyUI for device/python/attention-node availability, and returns exact
   *  recommendations. Read-only. */
  async function runSetupDoctor(settings: AppSettings) {
    const checks: Array<{ id: string; label: string; status: 'ok' | 'warn' | 'fail'; detail: string; recommendation?: string }> = []
    const configuredFfmpeg = settings.ffmpegPath.trim().replace(/^(["'])|(["'])$/g, '') || 'ffmpeg'
    const ffmpegPath = existsSync(join(configuredFfmpeg, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')) ? join(configuredFfmpeg, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') : configuredFfmpeg
    const ffmpeg = await new Promise<{ found: boolean; version: string }>((resolve) => {
      execFile(ffmpegPath, ['-version'], { windowsHide: true, timeout: 8000 }, (error, stdout) => {
        if (error) resolve({ found: false, version: '' })
        else resolve({ found: true, version: stdout.split(/\r?\n/, 1)[0] ?? '' })
      })
    })
    checks.push(ffmpeg.found
      ? { id: 'ffmpeg', label: 'FFmpeg', status: 'ok', detail: ffmpeg.version }
      : { id: 'ffmpeg', label: 'FFmpeg', status: 'fail', detail: `Not found at "${settings.ffmpegPath}".`, recommendation: 'Clip tools need FFmpeg. Install it (winget/choco/apt/brew) or set the exact path to the executable in Settings.' })
    const openssl = await new Promise<boolean>((resolve) => {
      execFile('openssl', ['version'], { windowsHide: true, timeout: 8000 }, (error) => resolve(!error))
    })
    checks.push(openssl
      ? { id: 'openssl', label: 'OpenSSL (HTTPS)', status: 'ok', detail: 'Available — the server can issue its LAN certificate.' }
      : { id: 'openssl', label: 'OpenSSL (HTTPS)', status: 'warn', detail: 'openssl not found on PATH.', recommendation: 'Without openssl the server falls back to plain HTTP: no PWA install, and tokens would travel in cleartext on hostile networks.' })
    try {
      const stats = await comfyFetch(settings.comfyUrl, '/system_stats') as {
        system?: { python_version?: string; os?: string }
        devices?: Array<{ name?: string; vram_total?: number; vram_free?: number }>
      }
      const device = stats.devices?.[0]
      checks.push({
        id: 'comfy', label: 'ComfyUI engine', status: 'ok',
        detail: `${device?.name ?? 'device'} · ${device?.vram_total ? `${(device.vram_total / 1024 ** 3).toFixed(1)} GB VRAM (${device?.vram_free !== undefined ? `${(device.vram_free / 1024 ** 3).toFixed(1)} GB free` : 'usage unknown'})` : 'VRAM unknown'} · Python ${stats.system?.python_version ?? '?'} on ${stats.system?.os ?? '?'}`,
      })
      const vramGb = (device?.vram_total ?? 0) / 1024 ** 3
      if (device && vramGb > 0 && vramGb < 18) {
        checks.push({ id: 'vram-tier', label: 'VRAM tier guidance', status: 'warn', detail: `${vramGb.toFixed(1)} GB detected.`, recommendation: 'Community tiers for ~16 GB cards: pruned INT8/Q4 quant of the diffusion model + INT4 text encoder, 1344×768, 5 s first; queue one render at a time and let the auto-retry handle OOM resets.' })
      }
      const info = await comfyFetch(settings.comfyUrl, '/object_info').catch((error: unknown) => { logFailure('doctor/object-info', error, undefined, 'debug'); return {} }) as Record<string, unknown>
      const attentionNodes = Object.keys(info).filter((name) => /blocksparse|sage|triton|flash/i.test(name))
      checks.push(attentionNodes.length
        ? { id: 'attention', label: 'Attention backends', status: 'ok', detail: `Detected nodes: ${attentionNodes.slice(0, 6).join(', ')}${attentionNodes.length > 6 ? ` (+${attentionNodes.length - 6} more)` : ''}.` }
        : { id: 'attention', label: 'Attention backends', status: 'warn', detail: 'No SageAttention/Triton/Flash-related nodes detected in ComfyUI.', recommendation: 'Optional speed-up: installing SageAttention (~2× on supported GPUs) or the Sol-Attn nodes (15–20%) shortens H3 renders. Not required for correctness.' })
    } catch (error) {
      checks.push({ id: 'comfy', label: 'ComfyUI engine', status: 'fail', detail: error instanceof Error ? error.message : String(error), recommendation: 'Start ComfyUI and confirm the server URL in Settings; engine-dependent checks were skipped.' })
    }
    return { checks, ranAt: Date.now() }
  }

  /** rife-ncnn-vulkan on PATH when present (dataset-manager A1: shipped
   * default is minterpolate; RIFE is the availability-gated preference).
   * Resolved lazily once per server process. */
  let rifeBinaryCache: string | null | undefined
  function rifeBinary(): Promise<string | null> {
    if (rifeBinaryCache !== undefined) return Promise.resolve(rifeBinaryCache)
    return new Promise((resolve) => {
      execFile('which', ['rife-ncnn-vulkan'], (error: Error | null, stdout: string) => {
        rifeBinaryCache = error ? null : stdout.trim() || null
        resolve(rifeBinaryCache)
      })
    })
  }

  /** Dataset bake/export destination containment (security wave 2, MEDIUM-1):
 *  every destination — relative or absolute — must land INSIDE the user's
 *  output directory, asserted post-normalization (the relative() discipline:
 *  a "../.." body or an absolute path elsewhere used to walk anywhere, and
 *  the export writes caption-controlled .txt/.jsonl rows and config files
 *  that overwrite on collision). Relative bodies resolve under the output
 *  directory; absolute paths are accepted only when they contain inside it
 *  too. Refusals are loud and name the resolved escape. */
function resolveDatasetFolder(raw: string, settings: AppSettings, defaultName: string): string {
  const trimmed = raw.slice(0, 4000)
  if (trimmed.includes('\0')) throw new Error('The destination path contains a null byte.')
  const root = resolve(settings.outputDirectory)
  const resolved = trimmed && isAbsolute(trimmed) ? resolve(trimmed) : resolve(join(root, trimmed || defaultName))
  const rel = relative(root, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Refusing the export destination "${trimmed}": it resolves to "${resolved}", which escapes the studio output directory (${root}). Destinations must stay inside it.`)
  }
  return resolved
}

/** Provenance fields from an ingest body (fields only, no ceremony — §2.2). */
  function provenanceFromBody(body: Record<string, unknown>) {
    return {
      originNote: typeof body.originNote === 'string' ? body.originNote.slice(0, 2000) : undefined,
      originDate: typeof body.originDate === 'string' ? body.originDate.slice(0, 40) : undefined,
      aiGenerated: body.aiGenerated === true ? true : undefined,
      consentNote: typeof body.consentNote === 'string' ? body.consentNote.slice(0, 2000) : undefined,
    }
  }

  /** The dataset manager's VLM seam: the llama.cpp router provider wrapped
   * for multi-image chats, text-only passes, and native input_video
   * (qwen-family). No cloud — the hard lock. */
  function datasetVlmSeam(): import('./datasets/vlm').VlmSeam {
    return {
      async chat(input) {
        const current = await loadSettings()
        const { provider, error } = llm.activeProvider(current)
        if (error) throw new Error(error)
        if (provider.kind !== 'router') throw new Error('Dataset VLM captioning requires the llama.cpp router provider with a vision-capable model.')
        let model = input.model?.trim() || current.llamaVisionModel.trim()
        if (!model) {
          const models = await provider.listModels().catch(() => [])
          model = models.find((entry) => entry.vision)?.id ?? ''
        }
        if (!model) throw new Error('No vision-capable model is available on the llama.cpp router.')
        const manifest = familyManifest(inferFamily(model))
        const imageFirst = manifest.vision.imageFirst
        const parts: Array<Record<string, unknown>> = []
        if (input.video) parts.push({ type: 'input_video', input_video: { url: input.video } })
        for (const image of input.images ?? []) parts.push({ type: 'image_url', image_url: { url: image } })
        parts.push({ type: 'text', text: input.instruction })
        const content = imageFirst ? [...parts.slice(0, -1).reverse(), parts[parts.length - 1]] : parts
        const messages: Array<{ role: string; content: unknown }> = (input.history ?? []).map((turn) => ({ role: turn.role, content: turn.content }))
        messages.push({ role: 'user', content })
        const result = await provider.chat({ model, messages: messages as never, manifest, thinking: false, maxTokens: 1024 })
        if (!result.content.trim()) throw new Error('The vision model returned an empty response.')
        return { text: result.content.trim(), model }
      },
      async textOnly(prompt, system) {
        const current = await loadSettings()
        const { provider, error } = llm.activeProvider(current)
        if (error) throw new Error(error)
        if (provider.kind !== 'router') throw new Error('The condense pass requires the llama.cpp router provider.')
        const model = current.llamaCppModel.trim() || (await llm.resolveActiveModel(provider, current))
        const manifest = familyManifest(inferFamily(model))
        const messages: Array<{ role: string; content: unknown }> = system
          ? [{ role: 'system', content: system }, { role: 'user', content: prompt }]
          : [{ role: 'user', content: prompt }]
        const result = await provider.chat({ model, messages: messages as never, manifest, thinking: false, maxTokens: 768 })
        return result.content.trim()
      },
      async visionModel() {
        const current = await loadSettings()
        const { provider } = llm.activeProvider(current)
        if (provider.kind !== 'router') return null
        if (current.llamaVisionModel.trim()) return current.llamaVisionModel.trim()
        const models = await provider.listModels().catch(() => [])
        return models.find((entry) => entry.vision)?.id ?? null
      },
      async supportsNativeVideo() {
        const model = await this.visionModel()
        return Boolean(model && inferFamily(model).includes('qwen'))
      },
    }
  }

  async function handleLanRequest(request: IncomingMessage, response: ServerResponse) {
    // Route (pathname only — never the query, which can carry user text) for
    // the structural 500 body and the log stage if anything below throws.
    let route = 'unknown'
    try {
      const url = new URL(request.url ?? '/', 'http://minimax.local')
      route = url.pathname
      // Origin/Host/content-type gate (security hardening 1) — runs BEFORE
      // auth and before any route work: a disallowed Host (DNS rebinding) or
      // a foreign Origin (cross-site request through the maintainer's
      // browser) never reaches a handler, and state-changing API requests
      // must carry application/json (no-cors cross-site POSTs can only be
      // text/plain). Same-origin SPA traffic is unaffected by construction.
      const guard = evaluateRequestGuard(request, {
        apiPathPrefix: '/api/lan',
        extraHostAllowlist: currentHostAllowlist,
        socketEncrypted: Boolean((request.socket as { encrypted?: boolean }).encrypted),
      })
      if (!guard.allowed) {
        const detail = guard.reason === 'host' ? 'disallowed Host header' : guard.reason === 'origin' ? 'cross-origin request refused' : 'state-changing requests require an application/json content type'
        logEvent({ kind: 'lan.request-refused', reason: guard.reason, method: request.method ?? '' })
        return sendJson(response, 403, { error: `Request refused: ${detail}.` })
      }
      if (url.pathname.startsWith('/api/lan/')) {
        if (lanAuthRequired()) {
          // Header token for fetch-able routes; the query parameter is only
          // honored where the browser cannot set headers at all (EventSource,
          // and <img>/<video> src on the media route). Constant-time compare.
          const header = request.headers['x-minimax-token']
          const headerToken = Array.isArray(header) ? header[0] : header
          // The filmstrip GET joins the browser-native group: <img> posters
          // cannot set headers either. Query tokens stay GET-only there.
          const queryTokenAllowed = url.pathname === '/api/lan/events' || url.pathname === '/api/lan/realtime' || url.pathname === '/api/lan/media' || (url.pathname === '/api/lan/assets/filmstrip' && request.method === 'GET') || (url.pathname === '/api/lan/documents/blobs/file' && request.method === 'GET') || (url.pathname === '/api/lan/datasets/media' && request.method === 'GET')
          const presented = headerToken ?? (queryTokenAllowed ? url.searchParams.get('token') ?? undefined : undefined)
          if (!tokenMatches(presented, lanToken)) return sendJson(response, 401, { error: 'This link is no longer authorized. Request a fresh link with the current access token.' })
        }
        const settings = await loadSettings()
        if (url.pathname === '/api/lan/bootstrap' && request.method === 'GET') {
          const groups = await Promise.all(modelKinds.map((kind) => scanDirectory(settings.paths[kind], kind)))
          const started = Date.now()
          try {
            await comfyFetch(settings.comfyUrl, '/system_stats')
            const info = await comfyFetch(settings.comfyUrl, '/object_info').catch((error: unknown) => { logFailure('bootstrap/object-info', error, undefined, 'debug'); return {} }) as Record<string, unknown>
            const upscalers = comfyChoices(info, 'UpscaleModelLoader', 'model_name')
            const latentUpscalers = comfyChoices(info, 'LatentUpscaleModelLoader', 'model_name')
            const vaes = comfyChoices(info, 'VAELoader', 'vae_name')
            const ltxUpscaleMissing = ltxUpscaleRequiredNodes.filter((node) => !info[node])
            const ltxNativeMissing = ltxNativeRequiredNodes.filter((node) => !info[node])
            const ollama = await comfyFetch(settings.ollamaUrl, '/api/tags').catch((error: unknown) => { logFailure('bootstrap/ollama', error, undefined, 'debug'); return { models: [] } }) as { models?: Array<{ name?: string; size?: number; remote_model?: string }> }
            const ollamaModels = (ollama.models ?? []).filter((item) => item.name && !item.remote_model && item.size !== 342).map((item) => item.name as string)
            // Model paths are stripped: the renderer matches by name and kind, and
            // full filesystem paths are a recon leak to anyone who can reach the API.
            // The h3Form tag (when detected) rides along for LoRA×base guidance.
            const models = groups.flat().map((model) => ({ name: model.name, kind: model.kind, bytes: model.bytes, ...(model.h3Form ? { h3Form: model.h3Form } : {}) }))
            return sendJson(response, 200, { connected: true, latencyMs: Date.now() - started, models, upscalers, ltxModel: latentUpscalers.find((name) => /ltx-2\.5.*spatial.*x2/i.test(name)) ?? '', ltxVae: vaes.find((name) => /ltx-2\.5.*video.*vae/i.test(name)) ?? '', ltxUpscaleReady: ltxUpscaleMissing.length === 0, ltxUpscaleMissing, ltxNativeReady: ltxNativeMissing.length === 0, ltxNativeMissing, ollamaModels, ollamaModel: settings.ollamaModel })
          } catch (error) {
            return sendJson(response, 200, { connected: false, latencyMs: Date.now() - started, models: groups.flat().map((model) => ({ name: model.name, kind: model.kind, bytes: model.bytes, ...(model.h3Form ? { h3Form: model.h3Form } : {}) })), error: error instanceof Error ? error.message : String(error) })
          }
        }
        if (url.pathname === '/api/lan/characters' && request.method === 'GET') return sendJson(response, 200, { characters: mobileCharacterLibrary })
        if (url.pathname === '/api/lan/characters' && request.method === 'POST') {
          const body = await readJson(request, 36_000_000)
          mobileCharacterLibrary = Array.isArray(body.characters) ? body.characters : []
          return sendJson(response, 200, { synced: mobileCharacterLibrary.length })
        }
        // ---- Studio storage (wave 1): jobs / projects / workspace / FTS ---
        // SQLite-backed persistence for the renderer's durable state. All
        // POST bodies are validated shape-first like the sibling routes; all
        // writes are upserts keyed by id (never whole-store replaces).
        if (url.pathname === '/api/lan/jobs' && request.method === 'GET') {
          if (!studioRepo) return sendJson(response, 503, { error: 'The studio database is unavailable; job history cannot be read.' })
          return sendJson(response, 200, { jobs: studioRepo.listJobs(100) })
        }
        if (url.pathname === '/api/lan/jobs' && request.method === 'POST') {
          if (!studioRepo) return sendJson(response, 503, { error: 'The studio database is unavailable; job history cannot be saved.' })
          const body = await readJson(request, 12_000_000)
          const jobs = Array.isArray(body.jobs) ? body.jobs : []
          if (jobs.length < 1 || jobs.length > 100) return sendJson(response, 400, { error: 'Provide between 1 and 100 jobs per request.' })
          if (!jobs.every((job) => isStoredJobShape(job))) return sendJson(response, 400, { error: 'Each job needs id, mode, status, prompt, createdAt, width, height, and duration.' })
          return sendJson(response, 200, { saved: studioRepo.upsertJobs(jobs) })
        }
        if (url.pathname === '/api/lan/projects' && request.method === 'GET') {
          if (!studioRepo) return sendJson(response, 503, { error: 'The studio database is unavailable; projects cannot be read.' })
          return sendJson(response, 200, { projects: studioRepo.listProjects() })
        }
        if (url.pathname === '/api/lan/projects' && request.method === 'POST') {
          if (!studioRepo) return sendJson(response, 503, { error: 'The studio database is unavailable; projects cannot be saved.' })
          const body = await readJson(request, 8_000_000)
          const projects = Array.isArray(body.projects) ? body.projects : []
          if (projects.length < 1 || projects.length > 200) return sendJson(response, 400, { error: 'Provide between 1 and 200 projects per request.' })
          for (const project of projects) {
            const record = project as Record<string, unknown>
            if (!record || typeof record !== 'object' || Array.isArray(record)) return sendJson(response, 400, { error: 'Each project needs id, name, and a data object.' })
            if (typeof record.id !== 'string' || !record.id || record.id.length > 200 || typeof record.name !== 'string' || !record.data || typeof record.data !== 'object' || Array.isArray(record.data)) {
              return sendJson(response, 400, { error: 'Each project needs id, name, and a data object.' })
            }
            studioRepo.upsertProject({ id: record.id, name: record.name, kind: typeof record.kind === 'string' && record.kind ? record.kind.slice(0, 40) : 'movie', data: record.data as Record<string, unknown> })
          }
          return sendJson(response, 200, { saved: projects.length })
        }
        if (url.pathname === '/api/lan/projects/delete' && request.method === 'POST') {
          if (!studioRepo) return sendJson(response, 503, { error: 'The studio database is unavailable; projects cannot be deleted.' })
          const body = await readJson(request, 10_000)
          const id = typeof body.id === 'string' ? body.id : ''
          if (!id || id.length > 200) return sendJson(response, 400, { error: 'A project id is required.' })
          return sendJson(response, 200, { deleted: studioRepo.deleteProject(id) })
        }
        if (url.pathname === '/api/lan/workspace' && request.method === 'GET') {
          if (!studioRepo) return sendJson(response, 503, { error: 'The studio database is unavailable; the workspace cannot be read.' })
          return sendJson(response, 200, { workspace: studioRepo.getWorkspace() })
        }
        if (url.pathname === '/api/lan/workspace' && request.method === 'POST') {
          if (!studioRepo) return sendJson(response, 503, { error: 'The studio database is unavailable; the workspace cannot be saved.' })
          const body = await readJson(request, 2_000_000)
          if (!body.workspace || typeof body.workspace !== 'object' || Array.isArray(body.workspace)) return sendJson(response, 400, { error: 'A workspace object is required.' })
          studioRepo.saveWorkspace(body.workspace as Record<string, unknown>)
          return sendJson(response, 200, { saved: true })
        }
        // FTS5 search over the saved prompt library. The user query is
        // sanitized into a quoted-prefix MATCH expression inside the repo —
        // FTS5 syntax injection through MATCH is real and never reaches the
        // parser untreated.
        if (url.pathname === '/api/lan/search/prompts' && request.method === 'GET') {
          if (!studioRepo) return sendJson(response, 503, { error: 'The studio database is unavailable; prompts cannot be searched.' })
          const query = url.searchParams.get('q') ?? ''
          const limit = Number(url.searchParams.get('limit'))
          return sendJson(response, 200, { entries: studioRepo.searchPrompts(query.slice(0, 400), Number.isInteger(limit) && limit >= 1 && limit <= 500 ? limit : 100) })
        }
        if (url.pathname === '/api/lan/prompts' && request.method === 'POST') {
          if (!studioRepo) return sendJson(response, 503, { error: 'The studio database is unavailable; prompts cannot be saved.' })
          const body = await readJson(request, 4_000_000)
          const entries = Array.isArray(body.entries) ? body.entries : []
          if (entries.length < 1 || entries.length > 200) return sendJson(response, 400, { error: 'Provide between 1 and 200 prompt entries per request.' })
          if (!entries.every((entry) => isPromptEntryShape(entry))) return sendJson(response, 400, { error: 'Each prompt entry needs an id and a prompt.' })
          return sendJson(response, 200, { saved: studioRepo.upsertPrompts(entries) })
        }
        if (url.pathname === '/api/lan/prompts/delete' && request.method === 'POST') {
          if (!studioRepo) return sendJson(response, 503, { error: 'The studio database is unavailable; prompts cannot be deleted.' })
          const body = await readJson(request, 10_000)
          const id = typeof body.id === 'string' ? body.id : ''
          if (!id || id.length > 200) return sendJson(response, 400, { error: 'A prompt id is required.' })
          return sendJson(response, 200, { deleted: studioRepo.deletePrompt(id) })
        }
        // ---- Canvas document store (Phase 0) ---------------------------------
        // /api/lan/documents/* — minimal CRUD for projects/chains/outputs/
        // takes/assets/ops/identity/control tracks/plans/session + retention
        // (prune/gc/trash) + §6 legacy import + §7 archive + §4 FTS search.
        // The canvas UI (next phase) consumes these; no UI ships here. All
        // bodies validated shape-first; unknown-newer documents refuse with a
        // loud 400 naming the writing app version (§2/F9); the old storage
        // routes above are untouched.
        if (url.pathname.startsWith('/api/lan/documents')) {
          if (!studioRepo) return sendJson(response, 503, { error: 'The studio database is unavailable; canvas documents cannot be accessed.' })
          const documents = studioRepo.documents
          ensureDocumentsImported()
          // Unknown-newer versions are a LOUD refusal (400), never a silent
          // downgrade; plan write conflicts answer 409 with the current
          // document (the clean rebase surface); everything else propagates
          // to the structural 500.
          const documentsFailure = (error: unknown): ReturnType<typeof sendJson> | null => {
            if (error instanceof CanvasSchemaVersionError) {
              return sendJson(response, 400, {
                error: error.message,
                schemaVersion: { found: error.found, supported: error.supported, writerAppVersion: error.writerAppVersion },
              })
            }
            if (error instanceof PlanConflictError) {
              return sendJson(response, 409, {
                error: error.message,
                conflict: { planId: error.planId, currentUpdatedAt: error.currentUpdatedAt, currentDocument: error.currentDocument },
              })
            }
            // Business-rule refusals (audit minor, cleanup wave): a missing
            // target answers 404, a state refusal answers 400 — both with
            // the reason, never an opaque 500.
            if (error instanceof DocumentsRuleError) {
              return sendJson(response, error.status, { error: error.message })
            }
            return null
          }
          const idFrom = (body: Record<string, unknown>) => (typeof body.id === 'string' && body.id && body.id.length <= 400 ? body.id : null)
          const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
          const stringArray = (value: unknown): string[] | null => (Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length <= 4096) ? value : null)

          if (url.pathname === '/api/lan/documents/bootstrap' && request.method === 'GET') {
            return sendJson(response, 200, { schemaVersion: CANVAS_SCHEMA_VERSION, appVersion: documents.appVersion, legacyImport: documents.legacyImportStatus() })
          }
          if (url.pathname === '/api/lan/documents/projects' && request.method === 'GET') {
            const trash = url.searchParams.get('trash') === '1'
            try {
              // Version-refusal isolation (M4): rows this build cannot open
              // are skipped and reported per row — one newer-schema project
              // degrades ITSELF, never the boot's whole project list.
              const listing = trash ? documents.listTrashedProjects() : documents.listProjects()
              return sendJson(response, 200, { projects: listing.projects, skipped: listing.skipped })
            } catch (error) {
              const mapped = documentsFailure(error)
              if (mapped) return mapped
              throw error
            }
          }
          if (url.pathname === '/api/lan/documents/projects' && request.method === 'POST') {
            const body = await readJson(request, 100_000)
            const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : ''
            if (!name) return sendJson(response, 400, { error: 'A project name is required.' })
            try {
              return sendJson(response, 200, { project: documents.createProject({ name, camera: isRecord(body.camera) ? body.camera : {}, settingsDefaults: isRecord(body.settingsDefaults) ? body.settingsDefaults : {} }) })
            } catch (error) {
              const mapped = documentsFailure(error)
              if (mapped) return mapped
              throw error
            }
          }
          if (url.pathname === '/api/lan/documents/project' && request.method === 'GET') {
            const id = url.searchParams.get('id') ?? ''
            if (!id || id.length > 400) return sendJson(response, 400, { error: 'A project id is required.' })
            try {
              // Perf wave 1: the fail-closed read cache (documents.ts) — a
              // hit serves the pre-serialized body without re-hydrating, and
              // a matching If-None-Match answers 304 with no body at all
              // (the SPA's conditional re-fetch rides this). The
              // x-minimax-document-cache header is the debug/test affordance.
              const cached = documents.getProjectDocumentCached(id)
              if (!cached) return sendJson(response, 404, { error: `No project with id ${id}.` })
              const ifNoneMatch = request.headers['if-none-match']
              const matched = Array.isArray(ifNoneMatch) ? ifNoneMatch[0] : ifNoneMatch
              if (matched === cached.etag || matched === `W/${cached.etag}` || matched === '*') {
                response.writeHead(304, { etag: cached.etag, 'cache-control': 'no-store' })
                return response.end()
              }
              response.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
                etag: cached.etag,
                'x-minimax-document-cache': cached.cached ? 'hit' : 'miss',
              })
              return response.end(cached.json)
            } catch (error) {
              const mapped = documentsFailure(error)
              if (mapped) return mapped
              throw error
            }
          }
          if (url.pathname === '/api/lan/documents/projects/update' && request.method === 'POST') {
            const body = await readJson(request, 2_000_000)
            const id = idFrom(body)
            if (!id) return sendJson(response, 400, { error: 'A project id is required.' })
            try {
              if (typeof body.name === 'string' && body.name.trim()) documents.renameProject(id, body.name.trim().slice(0, 200))
              if (isRecord(body.camera)) documents.setProjectCamera(id, body.camera)
              if (isRecord(body.settingsDefaults)) documents.setProjectSettingsDefaults(id, body.settingsDefaults)
              return sendJson(response, 200, { project: documents.getProject(id) })
            } catch (error) {
              const mapped = documentsFailure(error)
              if (mapped) return mapped
              throw error
            }
          }
          if (url.pathname === '/api/lan/documents/projects/delete' && request.method === 'POST') {
            const body = await readJson(request, 10_000)
            const id = idFrom(body)
            if (!id) return sendJson(response, 400, { error: 'A project id is required.' })
            return sendJson(response, 200, { deleted: documents.tombstoneProject(id) })
          }
          if (url.pathname === '/api/lan/documents/projects/restore' && request.method === 'POST') {
            const body = await readJson(request, 10_000)
            const id = idFrom(body)
            if (!id) return sendJson(response, 400, { error: 'A project id is required.' })
            return sendJson(response, 200, { restored: documents.restoreProject(id) })
          }
          if (url.pathname === '/api/lan/documents/chains' && request.method === 'GET') {
            if (url.searchParams.get('trash') !== '1') return sendJson(response, 400, { error: 'Chain listing is by project document; only ?trash=1 is standalone.' })
            return sendJson(response, 200, { chains: documents.listTrashedChains(url.searchParams.get('projectId') ?? undefined) })
          }
          if (url.pathname === '/api/lan/documents/chains' && request.method === 'POST') {
            const body = await readJson(request, 2_000_000)
            const projectId = typeof body.projectId === 'string' ? body.projectId : ''
            if (!projectId || projectId.length > 400) return sendJson(response, 400, { error: 'A projectId is required.' })
            try {
              return sendJson(response, 200, {
                chain: documents.createChain({
                  projectId,
                  kind: typeof body.kind === 'string' && body.kind ? body.kind.slice(0, 60) : undefined,
                  inputSpec: isRecord(body.inputSpec) ? body.inputSpec : {},
                  settings: isRecord(body.settings) ? body.settings : {},
                  lockState: body.lockState === 'locked' ? 'locked' : undefined,
                }),
              })
            } catch (error) {
              const mapped = documentsFailure(error)
              if (mapped) return mapped
              throw error
            }
          }
          if (url.pathname === '/api/lan/documents/chains/update' && request.method === 'POST') {
            const body = await readJson(request, 2_000_000)
            const id = idFrom(body)
            if (!id) return sendJson(response, 400, { error: 'A chain id is required.' })
            const update: Record<string, unknown> = { id }
            if (isRecord(body.settings)) update.settings = body.settings
            if (body.lockState === 'locked' || body.lockState === 'unlocked') update.lockState = body.lockState
            if (typeof body.hopCount === 'number' && Number.isFinite(body.hopCount)) update.hopCount = body.hopCount
            if (isRecord(body.driftMetrics) || body.driftMetrics === null) update.driftMetrics = body.driftMetrics
            if (isRecord(body.inputSpec)) update.inputSpec = body.inputSpec
            try {
              const chain = documents.updateChain(update as Parameters<typeof documents.updateChain>[0])
              if (body.stale === true || body.stale === false) documents.setChainStale(id, body.stale)
              return sendJson(response, 200, { chain: body.stale === undefined ? chain : documents.getChain(id) })
            } catch (error) {
              const mapped = documentsFailure(error)
              if (mapped) return mapped
              throw error
            }
          }
          if (url.pathname === '/api/lan/documents/chains/delete' && request.method === 'POST') {
            const body = await readJson(request, 10_000)
            const id = idFrom(body)
            if (!id) return sendJson(response, 400, { error: 'A chain id is required.' })
            return sendJson(response, 200, { deleted: documents.tombstoneChain(id) })
          }
          if (url.pathname === '/api/lan/documents/chains/restore' && request.method === 'POST') {
            const body = await readJson(request, 10_000)
            const id = idFrom(body)
            if (!id) return sendJson(response, 400, { error: 'A chain id is required.' })
            return sendJson(response, 200, { restored: documents.restoreChain(id) })
          }
          if (url.pathname === '/api/lan/documents/outputs' && request.method === 'GET') {
            const chainId = url.searchParams.get('chainId') ?? ''
            if (!chainId || chainId.length > 400) return sendJson(response, 400, { error: 'A chainId is required.' })
            return sendJson(response, 200, { outputs: documents.listOutputs(chainId) })
          }
          if (url.pathname === '/api/lan/documents/outputs' && request.method === 'POST') {
            const body = await readJson(request, 100_000)
            const chainId = typeof body.chainId === 'string' ? body.chainId : ''
            if (!chainId || chainId.length > 400) return sendJson(response, 400, { error: 'A chainId is required.' })
            const substrates = stringArray(body.substrates)
            try {
              return sendJson(response, 200, { output: documents.createOutput({ chainId, substrates: substrates ?? [] }) })
            } catch (error) {
              const mapped = documentsFailure(error)
              if (mapped) return mapped
              throw error
            }
          }
          if (url.pathname === '/api/lan/documents/takes' && request.method === 'GET') {
            const outputId = url.searchParams.get('outputId') ?? ''
            if (!outputId || outputId.length > 400) return sendJson(response, 400, { error: 'An outputId is required.' })
            return sendJson(response, 200, { takes: documents.listTakes(outputId), canonicalTakeId: documents.canonicalTake(outputId)?.id ?? null })
          }
          if (url.pathname === '/api/lan/documents/takes' && request.method === 'POST') {
            const body = await readJson(request, 2_000_000)
            const outputId = typeof body.outputId === 'string' ? body.outputId : ''
            if (!outputId || outputId.length > 400) return sendJson(response, 400, { error: 'An outputId is required.' })
            const artifacts = stringArray(body.artifacts)
            if (body.artifacts !== undefined && !artifacts) return sendJson(response, 400, { error: 'artifacts must be an array of paths.' })
            try {
              return sendJson(response, 200, {
                take: documents.appendTake({
                  outputId,
                  jobId: typeof body.jobId === 'string' && body.jobId ? body.jobId : null,
                  artifacts: artifacts ?? [],
                  latentPath: typeof body.latentPath === 'string' && body.latentPath ? body.latentPath : null,
                  metrics: isRecord(body.metrics) ? body.metrics : null,
                  contentHash: typeof body.contentHash === 'string' && body.contentHash ? body.contentHash : null,
                }),
              })
            } catch (error) {
              const mapped = documentsFailure(error)
              if (mapped) return mapped
              throw error
            }
          }
          if (url.pathname === '/api/lan/documents/takes/supersede' && request.method === 'POST') {
            const body = await readJson(request, 10_000)
            const outputId = typeof body.outputId === 'string' ? body.outputId : ''
            const takeId = typeof body.takeId === 'string' && body.takeId && body.takeId.length <= 400 ? body.takeId : null
            if (!outputId || !takeId) return sendJson(response, 400, { error: 'An outputId and takeId are required.' })
            try {
              return sendJson(response, 200, { take: documents.supersedeTake({ outputId, takeId }) })
            } catch (error) {
              const mapped = documentsFailure(error)
              if (mapped) return mapped
              throw error
            }
          }
          if (url.pathname === '/api/lan/documents/ops' && request.method === 'GET') {
            const chainId = url.searchParams.get('chainId') ?? ''
            if (!chainId || chainId.length > 400) return sendJson(response, 400, { error: 'A chainId is required.' })
            return sendJson(response, 200, { ops: documents.ops(chainId) })
          }
          if (url.pathname === '/api/lan/documents/ops' && request.method === 'POST') {
            const body = await readJson(request, 500_000)
            const chainId = typeof body.chainId === 'string' ? body.chainId : ''
            const kind = typeof body.kind === 'string' ? body.kind.trim().slice(0, 60) : ''
            if (!chainId || chainId.length > 400 || !kind) return sendJson(response, 400, { error: 'A chainId and an op kind are required.' })
            try {
              return sendJson(response, 200, { op: documents.addOp({ chainId, kind, settings: isRecord(body.settings) ? body.settings : {} }) })
            } catch (error) {
              const mapped = documentsFailure(error)
              if (mapped) return mapped
              throw error
            }
          }
          if (url.pathname === '/api/lan/documents/ops/update' && request.method === 'POST') {
            const body = await readJson(request, 500_000)
            const id = idFrom(body)
            if (!id || !isRecord(body.settings)) return sendJson(response, 400, { error: 'An op id and a settings object are required.' })
            try {
              documents.updateOpSettings(id, body.settings)
              return sendJson(response, 200, { updated: true })
            } catch (error) {
              const mapped = documentsFailure(error)
              if (mapped) return mapped
              throw error
            }
          }
          if (url.pathname === '/api/lan/documents/ops/reorder' && request.method === 'POST') {
            const body = await readJson(request, 100_000)
            const chainId = typeof body.chainId === 'string' ? body.chainId : ''
            const orderedIds = stringArray(body.orderedIds)
            if (!chainId || chainId.length > 400 || !orderedIds) return sendJson(response, 400, { error: 'A chainId and an orderedIds array are required.' })
            try {
              documents.reorderOps(chainId, orderedIds)
              return sendJson(response, 200, { ops: documents.ops(chainId) })
            } catch (error) {
              const mapped = documentsFailure(error)
              if (mapped) return mapped
              throw error
            }
          }
          if (url.pathname === '/api/lan/documents/ops/bake' && request.method === 'POST') {
            const body = await readJson(request, 10_000)
            const id = idFrom(body)
            if (!id) return sendJson(response, 400, { error: 'An op id is required.' })
            try {
              documents.bakeOp(id)
              return sendJson(response, 200, { baked: true })
            } catch (error) {
              const mapped = documentsFailure(error)
              if (mapped) return mapped
              throw error
            }
          }
          if (url.pathname === '/api/lan/documents/ops/delete' && request.method === 'POST') {
            const body = await readJson(request, 10_000)
            const id = idFrom(body)
            if (!id) return sendJson(response, 400, { error: 'An op id is required.' })
            try {
              return sendJson(response, 200, { deleted: documents.deleteOp(id) })
            } catch (error) {
              const mapped = documentsFailure(error)
              if (mapped) return mapped
              throw error
            }
          }
          if (url.pathname === '/api/lan/documents/identity' && request.method === 'POST') {
            const body = await readJson(request, 500_000)
            const chainId = typeof body.chainId === 'string' ? body.chainId : ''
            if (!chainId || chainId.length > 400) return sendJson(response, 400, { error: 'A chainId is required.' })
            const refAssetIds = body.refAssetIds === undefined ? undefined : stringArray(body.refAssetIds) ?? undefined
            if (body.refAssetIds !== undefined && !refAssetIds) return sendJson(response, 400, { error: 'refAssetIds must be an array of asset ids.' })
            try {
              return sendJson(response, 200, {
                identity: documents.upsertIdentity({
                  chainId,
                  refAssetIds,
                  refmodIds: body.refmodIds === undefined ? undefined : stringArray(body.refmodIds) ?? undefined,
                  subjectText: typeof body.subjectText === 'string' ? body.subjectText.slice(0, 20_000) : undefined,
                  strength: typeof body.strength === 'number' && Number.isFinite(body.strength) ? body.strength : undefined,
                  perSlotStrengths: isRecord(body.perSlotStrengths) ? (body.perSlotStrengths as Record<string, number>) : undefined,
                }),
              })
            } catch (error) {
              const mapped = documentsFailure(error)
              if (mapped) return mapped
              throw error
            }
          }
          if (url.pathname === '/api/lan/documents/control-tracks' && request.method === 'POST') {
            const body = await readJson(request, 500_000)
            const chainId = typeof body.chainId === 'string' ? body.chainId : ''
            const kind = typeof body.kind === 'string' ? body.kind.trim().slice(0, 40) : ''
            const source = typeof body.source === 'string' ? body.source.trim().slice(0, 40) : ''
            const inputRef = typeof body.inputRef === 'string' ? body.inputRef.slice(0, 4096) : ''
            if (!chainId || !kind || !source || !inputRef) return sendJson(response, 400, { error: 'A chainId, kind, source, and inputRef are required.' })
            try {
              return sendJson(response, 200, {
                controlTrack: documents.addControlTrack({
                  chainId, kind, source, inputRef,
                  maskRef: typeof body.maskRef === 'string' && body.maskRef ? body.maskRef.slice(0, 4096) : null,
                  params: isRecord(body.params) ? body.params : null,
                }),
              })
            } catch (error) {
              const mapped = documentsFailure(error)
              if (mapped) return mapped
              throw error
            }
          }
          if (url.pathname === '/api/lan/documents/control-tracks/delete' && request.method === 'POST') {
            const body = await readJson(request, 10_000)
            const id = idFrom(body)
            if (!id) return sendJson(response, 400, { error: 'A control track id is required.' })
            return sendJson(response, 200, { deleted: documents.deleteControlTrack(id) })
          }
          if (url.pathname === '/api/lan/documents/assets' && request.method === 'GET') {
            const kind = url.searchParams.get('kind') ?? undefined
            const scopedKind = kind && kind.length <= 40 ? kind : undefined
            if (url.searchParams.get('trash') === '1') return sendJson(response, 200, { assets: documents.listTrashedAssets(scopedKind) })
            return sendJson(response, 200, { assets: documents.listAssets(scopedKind) })
          }
          if (url.pathname === '/api/lan/documents/assets' && request.method === 'POST') {
            const body = await readJson(request, 8_000_000)
            const kind = typeof body.kind === 'string' ? body.kind : ''
            if (!kind || !isRecord(body.fields)) return sendJson(response, 400, { error: 'An asset kind and a fields object are required.' })
            const referenceSet = body.canonicalReferenceSet === undefined || body.canonicalReferenceSet === null ? null : stringArray(body.canonicalReferenceSet)
            if (referenceSet === null && body.canonicalReferenceSet !== undefined && body.canonicalReferenceSet !== null) return sendJson(response, 400, { error: 'canonicalReferenceSet must be an array of paths.' })
            try {
              return sendJson(response, 200, {
                asset: documents.upsertAsset({
                  id: typeof body.id === 'string' && body.id ? body.id : undefined,
                  kind,
                  fields: body.fields,
                  canonicalReferenceSet: referenceSet,
                }),
              })
            } catch (error) {
              const mapped = documentsFailure(error)
              if (mapped) return mapped
              throw error
            }
          }
          if (url.pathname === '/api/lan/documents/assets/delete' && request.method === 'POST') {
            const body = await readJson(request, 10_000)
            const id = idFrom(body)
            if (!id) return sendJson(response, 400, { error: 'An asset id is required.' })
            return sendJson(response, 200, { deleted: documents.tombstoneAsset(id) })
          }
          if (url.pathname === '/api/lan/documents/assets/restore' && request.method === 'POST') {
            const body = await readJson(request, 10_000)
            const id = idFrom(body)
            if (!id) return sendJson(response, 400, { error: 'An asset id is required.' })
            return sendJson(response, 200, { restored: documents.restoreAsset(id) })
          }
          if (url.pathname === '/api/lan/documents/assets/fork' && request.method === 'POST') {
            const body = await readJson(request, 500_000)
            const projectId = typeof body.projectId === 'string' ? body.projectId : ''
            const assetId = typeof body.assetId === 'string' ? body.assetId : ''
            if (!projectId || !assetId) return sendJson(response, 400, { error: 'A projectId and an assetId are required.' })
            if (body.consent !== true) return sendJson(response, 400, { error: 'Forking a global asset into a project requires explicit consent.' })
            try {
              return sendJson(response, 200, {
                fork: documents.forkAssetIntoProject({
                  projectId,
                  assetId,
                  forkedSettings: isRecord(body.forkedSettings) ? body.forkedSettings : {},
                  consent: true,
                }),
              })
            } catch (error) {
              const mapped = documentsFailure(error)
              if (mapped) return mapped
              throw error
            }
          }
          if (url.pathname === '/api/lan/documents/plans' && request.method === 'POST') {
            const body = await readJson(request, 8_000_000)
            const projectId = typeof body.projectId === 'string' ? body.projectId : ''
            if (!projectId || projectId.length > 400 || !isRecord(body.document)) return sendJson(response, 400, { error: 'A projectId and a plan document are required.' })
            // Optimistic concurrency (M5): expectedUpdatedAt (ms epoch, the
            // hydrated plan row's updatedAt) makes this a compare-and-swap;
            // a stale version answers 409 + the current document.
            const expectedUpdatedAt = typeof body.expectedUpdatedAt === 'number' && Number.isFinite(body.expectedUpdatedAt) ? Math.trunc(body.expectedUpdatedAt) : undefined
            try {
              return sendJson(response, 200, { plan: documents.upsertPlan({ projectId, id: typeof body.id === 'string' && body.id ? body.id : undefined, document: body.document, ...(expectedUpdatedAt !== undefined ? { expectedUpdatedAt } : {}) }) })
            } catch (error) {
              const mapped = documentsFailure(error)
              if (mapped) return mapped
              throw error
            }
          }
          if (url.pathname === '/api/lan/documents/session' && request.method === 'GET') {
            return sendJson(response, 200, { session: documents.getSession() })
          }
          if (url.pathname === '/api/lan/documents/session' && request.method === 'POST') {
            const body = await readJson(request, 100_000)
            const openProjects = stringArray(body.openProjects)
            if (!openProjects) return sendJson(response, 400, { error: 'openProjects must be an array of project ids.' })
            const activeProject = typeof body.activeProject === 'string' && body.activeProject ? body.activeProject : null
            return sendJson(response, 200, { session: documents.saveSession({ openProjects, activeProject }) })
          }
          // Retention (§3): session-scoped prune (defaults to the session's
          // open projects), mark-and-sweep GC, and the explicit trash empty.
          if (url.pathname === '/api/lan/documents/prune' && request.method === 'POST') {
            const body = await readJson(request, 100_000)
            const requested = stringArray(body.projectIds)
            const projectIds = requested ?? documents.getSession().openProjects
            if (!projectIds.length) return sendJson(response, 400, { error: 'No open projects in the session; pass projectIds explicitly.' })
            return sendJson(response, 200, { pruned: documents.pruneProjects(projectIds) })
          }
          if (url.pathname === '/api/lan/documents/gc' && request.method === 'POST') {
            return sendJson(response, 200, { gc: documents.sweep() })
          }
          if (url.pathname === '/api/lan/documents/trash/empty' && request.method === 'POST') {
            const body = await readJson(request, 10_000)
            if (body.confirm !== 'empty-trash') return sendJson(response, 400, { error: 'Emptying the trash is destructive; send confirm:"empty-trash".' })
            return sendJson(response, 200, { emptied: documents.emptyTrash() })
          }
          if (url.pathname === '/api/lan/documents/blobs/relink' && request.method === 'POST') {
            const body = await readJson(request, 100_000)
            const roots = stringArray(body.roots)
            if (!roots || !roots.length) return sendJson(response, 400, { error: 'An array of nominated roots is required.' })
            return sendJson(response, 200, { relink: documents.relinkBlobs(roots) })
          }
          // Canvas Phase 2 media ingestion: dropped bytes → an engine-visible
          // copy inside the output directory (uploads + filmstrips + frame
          // extraction all operate on output-contained paths) → a
          // content-addressed blob row (hash on ingest, invariant 9). The
          // take that lands afterwards re-registers the same file — the blob
          // tree dedupes by hash.
          if (url.pathname === '/api/lan/documents/blobs/ingest' && request.method === 'POST') {
            const body = await readJson(request, 180_000_000)
            const data = typeof body.data === 'string' ? body.data : ''
            const rawName = typeof body.name === 'string' ? body.name : ''
            const kind = body.kind === 'image' || body.kind === 'video' || body.kind === 'audio' ? body.kind : ''
            if (!kind) return sendJson(response, 400, { error: 'A media kind (image / video / audio) is required.' })
            if (!rawName) return sendJson(response, 400, { error: 'A file name is required.' })
            if (!data || data.length < 8) return sendJson(response, 400, { error: 'The dropped file carried no bytes.' })
            let bytes: Buffer
            try {
              bytes = Buffer.from(data, 'base64')
            } catch {
              return sendJson(response, 400, { error: 'The dropped bytes are not valid base64.' })
            }
            if (!bytes.length) return sendJson(response, 400, { error: 'The dropped file decoded to zero bytes.' })
            const extension = extname(rawName).toLowerCase().slice(0, 8) || (kind === 'image' ? '.png' : kind === 'audio' ? '.mp3' : '.mp4')
            const safeStem = basename(rawName, extname(rawName)).replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80) || 'dropped'
            const folder = join(settings.outputDirectory, 'canvas-media')
            const outputPath = join(folder, `${safeStem}-${randomUUID().slice(0, 8)}${extension}`)
            try {
              await mkdir(folder, { recursive: true })
              await writeFile(outputPath, bytes)
              const blob = documents.registerBlobFile(kind, outputPath)
              logEvent({ kind: 'documents.blob-ingest', bytes: bytes.length, hash: blob.hash ? 'present' : 'missing' })
              return sendJson(response, 200, { path: outputPath, blob })
            } catch (error) {
              return sendJson(response, 500, { error: `The dropped media could not be stored: ${error instanceof Error ? error.message : String(error)}` })
            }
          }
          // Remote-engine output ingest (B2): a completed job whose output
          // never resolved to a LOCAL file (external ComfyUI, or a
          // subfolder/output-dir mismatch) is fetched from the engine's /view
          // through the same proxy the media route uses, landed as an
          // output-dir copy + content-addressed blob — the render becomes
          // durable instead of dying with the engine's output rotation.
          if (url.pathname === '/api/lan/documents/blobs/ingest-output' && request.method === 'POST') {
            const body = await readJson(request, 100_000)
            const filename = typeof body.filename === 'string' ? body.filename : ''
            const subfolder = typeof body.subfolder === 'string' ? body.subfolder : ''
            const kind = body.kind === 'image' || body.kind === 'video' || body.kind === 'audio' ? body.kind : ''
            if (!kind) return sendJson(response, 400, { error: 'A media kind (image / video / audio) is required.' })
            // The exact filename/subfolder validation the media proxy applies
            // (proxyLanMedia) — an output descriptor, never a path.
            if (!filename || filename.includes('/') || filename.includes('\\')) return sendJson(response, 400, { error: 'Invalid output filename.' })
            if (subfolder && (isAbsolute(subfolder) || subfolder.split(/[\\/]/).includes('..'))) return sendJson(response, 400, { error: 'Invalid output subfolder.' })
            const fileType = body.type === 'input' ? 'input' : 'output'
            try {
              const query = new URLSearchParams({ filename, subfolder, type: fileType })
              const upstream = await fetch(`${cleanUrl(settings.comfyUrl)}/view?${query}`)
              if (!upstream.ok || !upstream.body) return sendJson(response, 502, { error: 'The engine output could not be fetched — the engine may be unreachable or the output rotated away.' })
              const bytes = Buffer.from(await upstream.arrayBuffer())
              if (!bytes.length) return sendJson(response, 400, { error: 'The engine output carried no bytes.' })
              const extension = extname(filename).toLowerCase().slice(0, 8) || (kind === 'image' ? '.png' : kind === 'audio' ? '.mp3' : '.mp4')
              const safeStem = basename(filename, extname(filename)).replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80) || 'engine-output'
              const folder = join(settings.outputDirectory, 'canvas-media')
              const outputPath = join(folder, `${safeStem}-${randomUUID().slice(0, 8)}${extension}`)
              await mkdir(folder, { recursive: true })
              await writeFile(outputPath, bytes)
              const blob = documents.registerBlobFile(kind, outputPath)
              logEvent({ kind: 'documents.blob-ingest', bytes: bytes.length, hash: blob.hash ? 'present' : 'missing' })
              return sendJson(response, 200, { path: outputPath, blob })
            } catch (error) {
              return sendJson(response, 502, { error: `The engine output could not be stored: ${error instanceof Error ? error.message : String(error)}` })
            }
          }
          // Blob media serving for canvas previews: <img>/<video> sources
          // cannot set headers, so this read-only media route is in the
          // query-token set exactly like /api/lan/media.
          if (url.pathname === '/api/lan/documents/blobs/file' && (request.method === 'GET' || request.method === 'HEAD')) {
            const relPath = url.searchParams.get('path') ?? ''
            const resolved = documents.resolveBlobFile(relPath)
            if (!resolved) return sendJson(response, 404, { error: 'The media file is unavailable.' })
            return serveLocalMediaHttp(request, response, resolved.absPath)
          }
          // Archive (§7): export = zip (manifest + document rows + blob tree);
          // import refuses unknown-newer versions loudly.
          if (url.pathname === '/api/lan/documents/export' && request.method === 'GET') {
            const id = url.searchParams.get('id') ?? ''
            if (!id || id.length > 400) return sendJson(response, 400, { error: 'A project id is required.' })
            try {
              const { archive, manifest } = exportProjectArchive(documents, id)
              const safeName = manifest.projectName.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 80) || 'project'
              response.writeHead(200, {
                'content-type': 'application/zip',
                'content-disposition': `attachment; filename="${safeName}.canvas.zip"`,
                'content-length': String(archive.length),
                'x-canvas-schema-version': String(manifest.schemaVersion),
              })
              return void response.end(archive)
            } catch (error) {
              const mapped = documentsFailure(error)
              if (mapped) return mapped
              throw error
            }
          }
          if (url.pathname === '/api/lan/documents/import' && request.method === 'POST') {
            const body = await readJson(request, 200_000_000)
            const archiveBase64 = typeof body.archiveBase64 === 'string' ? body.archiveBase64 : ''
            if (!archiveBase64 || archiveBase64.length < 100) return sendJson(response, 400, { error: 'An archiveBase64 zip payload is required.' })
            let archive: Buffer
            try {
              archive = Buffer.from(archiveBase64, 'base64')
            } catch {
              return sendJson(response, 400, { error: 'The archive payload is not valid base64.' })
            }
            try {
              return sendJson(response, 200, { import: importProjectArchive(documents, archive) })
            } catch (error) {
              // Archive problems are user-actionable (corrupt zip, unknown
              // version, taken project id): loud 400s with the reason, never
              // the generic structural 500.
              const mapped = documentsFailure(error)
              if (mapped) return mapped
              return sendJson(response, 400, { error: error instanceof Error ? error.message : 'The archive could not be imported.' })
            }
          }
          // §6 legacy import: auto-ran on first documents access; this route
          // re-runs it for library entries that sync after boot (idempotent:
          // jobs/workspace/prompts are marker-gated, characters upsert by id).
          if (url.pathname === '/api/lan/documents/import/legacy' && request.method === 'POST') {
            const body = await readJson(request, 36_000_000)
            const characters = Array.isArray(body.characters) ? body.characters : mobileCharacterLibrary
            try {
              return sendJson(response, 200, { import: documents.importLegacy({ characters, force: true }) })
            } catch (error) {
              const mapped = documentsFailure(error)
              if (mapped) return mapped
              throw error
            }
          }
          if (url.pathname === '/api/lan/documents/search' && request.method === 'GET') {
            const query = (url.searchParams.get('q') ?? '').slice(0, 400)
            const kind = url.searchParams.get('kind') ?? undefined
            const limit = Number(url.searchParams.get('limit'))
            return sendJson(response, 200, {
              results: documents.search(query, kind && kind.length <= 20 ? kind : undefined, Number.isInteger(limit) && limit >= 1 && limit <= 200 ? limit : 50),
            })
          }
          if (url.pathname === '/api/lan/documents/jobs/state' && request.method === 'POST') {
            const body = await readJson(request, 100_000)
            const id = idFrom(body)
            if (!id) return sendJson(response, 400, { error: 'A job id is required.' })
            const queue = body.gpuQueueState === 'active' || body.gpuQueueState === 'queued_for_gpu' || body.gpuQueueState === null ? body.gpuQueueState : undefined
            if (body.gpuQueueState !== undefined && queue === undefined) return sendJson(response, 400, { error: 'gpuQueueState must be active, queued_for_gpu, or null.' })
            const failure = body.failure === null || body.failure === undefined
              ? undefined
              : isRecord(body.failure) && typeof body.failure.stage === 'string' && typeof body.failure.reason === 'string'
                ? { stage: body.failure.stage.slice(0, 100), reason: body.failure.reason.slice(0, 2000), ref: typeof body.failure.ref === 'string' ? body.failure.ref.slice(0, 200) : undefined }
                : 'invalid'
            if (failure === 'invalid') return sendJson(response, 400, { error: 'failure must be {stage, reason, ref?} or null.' })
            try {
              return sendJson(response, 200, { job: documents.setJobState({ id, gpuQueueState: queue, planRef: typeof body.planRef === 'string' ? body.planRef.slice(0, 400) : body.planRef === null ? null : undefined, failure: failure === undefined ? undefined : (failure as { stage: string; reason: string; ref?: string } | null) }) })
            } catch (error) {
              const mapped = documentsFailure(error)
              if (mapped) return mapped
              throw error
            }
          }
          return sendJson(response, 404, { error: 'Unknown canvas documents route.' })
        }
        if (url.pathname === '/api/lan/upload-output' && request.method === 'POST') {
          const body = await readJson(request, 10_000)
          const requested = typeof body.path === 'string' ? body.path : ''
          // Canvas blob references (canvas-blobs/…) resolve through the
          // document store's verified tree — imported/verified content is
          // uploadable to the engine without a volatile output-dir copy, and
          // the VERIFIED blob always wins over a stale absolute path
          // (wrong-file substitution guard, m3).
          if (requested.startsWith('canvas-blobs/')) {
            const resolved = studioRepo?.documents.resolveBlobFile(requested)
            if (!resolved) return sendJson(response, 404, { error: 'The referenced blob is unavailable.' })
            return sendJson(response, 200, await uploadFileAt(settings.comfyUrl, resolved.absPath, typeof body.subfolder === 'string' && body.subfolder ? body.subfolder : 'minimax-desktop'))
          }
          const root = resolve(settings.outputDirectory)
          const candidate = requested ? resolve(requested) : root
          const containment = relative(root, candidate)
          if (!requested || containment.startsWith('..') || isAbsolute(containment) || !existsSync(candidate)) return sendJson(response, 403, { error: 'The file is outside the configured output directory.' })
          return sendJson(response, 200, await uploadFileAt(settings.comfyUrl, candidate, typeof body.subfolder === 'string' && body.subfolder ? body.subfolder : 'minimax-desktop'))
        }
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
          // VRAM hygiene (pre-submit hook): when the router provider has
          // loaded models and unload-on-generate is on (default), unload them
          // BEFORE the graph lands. Bounded to ~2 s so a slow router can never
          // block the submission itself; observable on the engine channel.
          await llm.unloadBeforeGeneration().catch((unloadFailure: unknown) => {
            logFailure('llm/unload-before-generate', unloadFailure, undefined, 'debug')
          })
          try {
            const result = await comfyFetch(settings.comfyUrl, '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: body.prompt, client_id: clientId }) })
            return sendJson(response, 200, result)
          } catch (upstream) {
            // The upstream body is EXTERNAL text (a ComfyUI validation or
            // server error — it can echo input values): it never reaches the
            // client raw. The structural 400 carries the sanitized reason
            // (node ids, classes, statuses survive) plus a log-correlation
            // ref, matching the structural-500 contract one layer up.
            const ref = failureRef()
            logFailure('comfy/prompt', upstream, { ref })
            const raw = upstream instanceof Error ? upstream.message : String(upstream)
            return sendJson(response, 400, { error: structuralPromptError(raw) || 'The engine rejected the prompt.', stage: 'comfy/prompt', ref })
          }
        }
        // LEGACY (wave 0 SSE bridge): one upstream ComfyUI WebSocket per SSE
        // client, binary previews base64-wrapped. Kept functional through
        // wave 1 so existing remote clients keep working; new clients use the
        // realtime fabric (/ws + /api/lan/realtime). Retire after the fabric
        // proves out in real use.
        if (url.pathname === '/api/lan/events' && request.method === 'GET') return streamLanEvents(request, response, url.searchParams, settings.comfyUrl)
        // Realtime fabric — SSE v2 fallback: the typed JSON channels only
        // (previews degrade to base64 here; WS is the primary transport).
        if (url.pathname === '/api/lan/realtime' && request.method === 'GET') return realtimeHub.handleSse(request, response, url.searchParams)
        // LEGACY prompt-assistant routes — now delegated to the ACTIVE LLM
        // provider (llama.cpp router when configured, Ollama otherwise). The
        // Ollama provider reproduces the previous wire behavior exactly.
        if (url.pathname === '/api/lan/ollama' && request.method === 'POST') {
          const body = await readJson(request, 80_000)
          const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
          if (!prompt || prompt.length > 50_000) return sendJson(response, 400, { error: 'A shorter prompt-assistant request is required.' })
          const { provider, error: providerError } = llm.activeProvider(settings)
          if (providerError) return sendJson(response, 400, { error: providerError })
          const model = provider.kind === 'router' ? (settings.llamaCppModel.trim() || (await llm.resolveActiveModel(provider, settings))) : settings.ollamaModel
          if (!model) return sendJson(response, 400, { error: 'No local text model is configured. Check the LLM section in Settings.' })
          try {
            const result = provider.kind === 'router'
              ? await provider.chat({ model, messages: [{ role: 'user', content: prompt }], manifest: familyManifest(inferFamily(model)), thinking: false })
              : { content: await provider.legacyGenerate!(model, prompt) }
            if (!result.content) return sendJson(response, 502, { error: 'The local model returned an empty response.' })
            return sendJson(response, 200, { response: result.content })
          } catch (providerFailure) {
            return sendJson(response, 502, { error: providerFailure instanceof Error ? providerFailure.message : String(providerFailure) })
          }
        }
        if (url.pathname === '/api/lan/ollama/structured' && request.method === 'POST') {
          const body = await readJson(request, 1_000_000)
          const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
          if (!prompt || prompt.length > 50_000) return sendJson(response, 400, { error: 'A structured prompt is required.' })
          if (!body.schema || typeof body.schema !== 'object' || Array.isArray(body.schema)) return sendJson(response, 400, { error: 'A JSON schema is required.' })
          try {
            const generated = await llm.generate({ prompt, schema: body.schema as Record<string, unknown> })
            return sendJson(response, 200, { result: generated.result })
          } catch (providerFailure) {
            return sendJson(response, 502, { error: providerFailure instanceof Error ? providerFailure.message : String(providerFailure) })
          }
        }
        // ---- Dataset manager (sv14rt0, docs/specs/dataset-manager-v1.md) ----
        // /api/lan/datasets/* — import/browse/layers/captions/VLM/curation/
        // dashboard/bake/export. All bodies validated shape-first; the media
        // GET is query-token-allowed (it feeds <img>/<video> elements).
        if (url.pathname.startsWith('/api/lan/datasets')) {
          if (!studioRepo) return sendJson(response, 503, { error: 'The studio database is unavailable; the dataset manager cannot be accessed.' })
          const manager = studioRepo.datasets
          // CLIP-consent state (LOW-2): the curation pass may download the
          // CLIP weights only behind a recorded, license-matching consent in
          // the fetch-consent ledger — same rule shape the fetcher enforces.
          const clipConsentRecord = settings.fetch.consents[CLIP_CONSENT_ID]
          const clipConsented = clipConsentRecord?.consented === true && clipConsentRecord.licenseSpdx === CLIP_LICENSE_SPDX
          studioRepo.setDatasetTools({ ffmpegPath: settings.ffmpegPath || 'ffmpeg', logFailure, logEvent, clipConsentGranted: clipConsented })
          const clipConsentInfo = () => ({
            consented: clipConsented,
            id: CLIP_CONSENT_ID,
            model: CLIP_MODEL_ID,
            licenseSpdx: CLIP_LICENSE_SPDX,
            note: clipConsented
              ? 'CLIP embeddings are enabled (consent recorded).'
              : 'CLIP embeddings are consent-gated off — the perceptual fallback ran instead. The first CLIP load downloads model weights from huggingface.co, so it happens only behind a recorded consent (POST /api/lan/datasets/clip/consent).',
          })
          // rife-ncnn-vulkan availability (A1-final: shipped-default minterpolate; RIFE preferred when present).
          const rifePath: string | null = await rifeBinary()
          const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
          const fail = (error: unknown, status = 500) => sendJson(response, status, { error: error instanceof Error ? error.message : String(error) })
          const idParam = (name: string, maximum = 400) => {
            const value = url.searchParams.get(name) ?? ''
            return value && value.length <= maximum ? value : null
          }

          if (url.pathname === '/api/lan/datasets/bootstrap' && request.method === 'GET') {
            return sendJson(response, 200, { settings: manager.store.getSettings(), aspects: manager.store.listAspects(), rifeAvailable: Boolean(rifePath), exports: manager.listExports() })
          }
          if (url.pathname === '/api/lan/datasets/library' && request.method === 'GET') {
            return sendJson(response, 200, manager.library())
          }
          if (url.pathname === '/api/lan/datasets/search' && request.method === 'GET') {
            const query = url.searchParams.get('q') ?? ''
            return sendJson(response, 200, { hits: manager.store.searchLayers(query.slice(0, 400)) })
          }
          if (url.pathname === '/api/lan/datasets/ingest/reference' && request.method === 'POST') {
            const body = await readJson(request, 100_000)
            const path = typeof body.path === 'string' ? body.path.trim() : ''
            if (!path || path.length > 4000) return sendJson(response, 400, { error: 'An absolute file path is required.' })
            try {
              const result = await manager.ingestReference(path, provenanceFromBody(body))
              return sendJson(response, 200, { source: result.source, deduped: result.deduped, refusal: result.refusal })
            } catch (error) { return fail(error, 400) }
          }
          if (url.pathname === '/api/lan/datasets/ingest/upload' && request.method === 'POST') {
            const body = await readJson(request, 200_000_000)
            const name = typeof body.name === 'string' ? body.name : ''
            const data = typeof body.data === 'string' ? body.data : ''
            if (!name || !data) return sendJson(response, 400, { error: 'A file name and base64 data are required.' })
            let bytes: Buffer
            try { bytes = Buffer.from(data, 'base64') } catch { return sendJson(response, 400, { error: 'The upload bytes are not valid base64.' }) }
            try {
              const result = await manager.ingestUpload(name, bytes, provenanceFromBody(body))
              return sendJson(response, 200, { source: result.source, deduped: result.deduped, refusal: result.refusal })
            } catch (error) { return fail(error, 400) }
          }
          // Canvas bridge, direction 1 (§11): a take/media file becomes a referenced source.
          if (url.pathname === '/api/lan/datasets/ingest/canvas' && request.method === 'POST') {
            const body = await readJson(request, 100_000)
            const path = typeof body.path === 'string' ? body.path.trim() : ''
            if (!path || path.length > 4000) return sendJson(response, 400, { error: 'A canvas media path is required.' })
            try {
              const result = await manager.ingestFromCanvas(path, { originNote: `Canvas take — ${new Date().toISOString().slice(0, 10)}` })
              return sendJson(response, 200, { source: result.source, deduped: result.deduped, refusal: result.refusal })
            } catch (error) { return fail(error, 400) }
          }
          if (url.pathname === '/api/lan/datasets/health' && request.method === 'POST') {
            const body = await readJson(request, 20_000).catch(() => ({}) as Record<string, unknown>)
            const ids = Array.isArray(body.sourceIds) ? body.sourceIds.filter((id: unknown) => typeof id === 'string') : undefined
            return sendJson(response, 200, await manager.store.checkHealth(ids))
          }
          if (url.pathname === '/api/lan/datasets/relink' && request.method === 'POST') {
            const body = await readJson(request, 20_000)
            const sourceId = typeof body.sourceId === 'string' ? body.sourceId : ''
            const path = typeof body.path === 'string' ? body.path.trim() : ''
            if (!sourceId || !path) return sendJson(response, 400, { error: 'A sourceId and a picked file path are required.' })
            try { return sendJson(response, 200, await manager.store.relinkSource(sourceId, path)) } catch (error) { return fail(error, 400) }
          }
          if (url.pathname === '/api/lan/datasets/probe' && request.method === 'POST') {
            const body = await readJson(request, 20_000)
            const sourceId = typeof body.sourceId === 'string' ? body.sourceId : ''
            if (!sourceId) return sendJson(response, 400, { error: 'A sourceId is required.' })
            await manager.store.runDecodeProbe(sourceId)
            return sendJson(response, 200, { source: manager.store.getSource(sourceId) })
          }
          if (url.pathname === '/api/lan/datasets/sources/provenance' && request.method === 'POST') {
            const body = await readJson(request, 200_000)
            const sourceId = typeof body.sourceId === 'string' ? body.sourceId : ''
            if (!sourceId) return sendJson(response, 400, { error: 'A sourceId is required.' })
            try {
              const source = manager.store.setProvenance(sourceId, {
                originNote: typeof body.originNote === 'string' ? body.originNote : undefined,
                originDate: typeof body.originDate === 'string' ? body.originDate : undefined,
                aiGenerated: body.aiGenerated === true ? true : body.aiGenerated === false ? false : undefined,
                consentNote: typeof body.consentNote === 'string' ? body.consentNote : undefined,
              })
              return sendJson(response, 200, { source })
            } catch (error) { return fail(error, 400) }
          }
          if (url.pathname === '/api/lan/datasets/sources/trash' && request.method === 'POST') {
            const body = await readJson(request, 20_000)
            const sourceId = typeof body.sourceId === 'string' ? body.sourceId : ''
            if (!sourceId) return sendJson(response, 400, { error: 'A sourceId is required.' })
            try {
              const result = await manager.store.trashSource(sourceId)
              logEvent({ kind: 'datasets.trash-source', id: sourceId, ...result })
              return sendJson(response, 200, result)
            } catch (error) { return fail(error, 400) }
          }
          if (url.pathname === '/api/lan/datasets/sources/restore' && request.method === 'POST') {
            const body = await readJson(request, 20_000)
            const sourceId = typeof body.sourceId === 'string' ? body.sourceId : ''
            if (!sourceId) return sendJson(response, 400, { error: 'A sourceId is required.' })
            try { return sendJson(response, 200, await manager.store.restoreSource(sourceId)) } catch (error) { return fail(error, 400) }
          }
          if (url.pathname === '/api/lan/datasets/trash/empty' && request.method === 'POST') {
            const result = await manager.store.emptyTrash()
            logEvent({ kind: 'datasets.trash-empty', ...result })
            return sendJson(response, 200, result)
          }
          // Source media serving for the workbench (video streaming w/ Range,
          // image bytes) — the crop editor previews the ORIGINAL and applies
          // crop/trim visually; the bake applies them for real. Trashed
          // sources stop serving (audit HIGH-1 sub-oracle: the trash view
          // must be the only surface that sees them).
          if (url.pathname === '/api/lan/datasets/media' && (request.method === 'GET' || request.method === 'HEAD')) {
            const sourceId = idParam('source')
            if (!sourceId) return sendJson(response, 400, { error: 'A source id is required.' })
            const source = manager.store.getSource(sourceId)
            if (!source) return sendJson(response, 404, { error: 'No source with that id.' })
            if (source.trashedAt) return sendJson(response, 410, { error: 'The source is in the trash — restore it to serve its media.' })
            if (source.health === 'missing') return sendJson(response, 410, { error: 'The source file is MISSING — re-link it by content hash.' })
            return serveLocalMediaHttp(request, response, source.absPath)
          }
          if (url.pathname === '/api/lan/datasets/layers' && request.method === 'POST') {
            const body = await readJson(request, 100_000)
            const sourceId = typeof body.sourceId === 'string' ? body.sourceId : ''
            if (!sourceId) return sendJson(response, 400, { error: 'A sourceId is required.' })
            try {
              const layer = manager.store.createLayer({
                sourceId,
                name: typeof body.name === 'string' ? body.name : '',
                crop: isRecord(body.crop) ? { x: Number(body.crop.x) || 0, y: Number(body.crop.y) || 0, w: Number(body.crop.w) || 0, h: Number(body.crop.h) || 0 } : null,
                trim: body.trim && isRecord(body.trim) ? { inFrame: body.trim.inFrame === null ? null : Number(body.trim.inFrame), outFrame: body.trim.outFrame === null ? null : Number(body.trim.outFrame) } : null,
                contentClass: body.contentClass === 'style' || body.contentClass === 'character' || body.contentClass === 'motion' ? body.contentClass : null,
              })
              return sendJson(response, 200, { layer })
            } catch (error) { return fail(error, 400) }
          }
          if (url.pathname === '/api/lan/datasets/layers/update' && request.method === 'POST') {
            const body = await readJson(request, 100_000)
            const layerId = typeof body.layerId === 'string' ? body.layerId : ''
            if (!layerId) return sendJson(response, 400, { error: 'A layerId is required.' })
            try {
              const layer = manager.store.updateLayerGeometry(layerId, {
                name: typeof body.name === 'string' ? body.name : undefined,
                crop: 'crop' in body ? (isRecord(body.crop) ? { x: Number(body.crop.x) || 0, y: Number(body.crop.y) || 0, w: Number(body.crop.w) || 0, h: Number(body.crop.h) || 0 } : null) : undefined,
                trim: 'trim' in body ? (body.trim && isRecord(body.trim) ? { inFrame: body.trim.inFrame === null ? null : Number(body.trim.inFrame), outFrame: body.trim.outFrame === null ? null : Number(body.trim.outFrame) } : null) : undefined,
                contentClass: body.contentClass === 'style' || body.contentClass === 'character' || body.contentClass === 'motion' ? body.contentClass : body.contentClass === null ? null : undefined,
              })
              return sendJson(response, 200, { layer })
            } catch (error) { return fail(error, 400) }
          }
          if (url.pathname === '/api/lan/datasets/layers/trash' && request.method === 'POST') {
            const body = await readJson(request, 20_000)
            const layerId = typeof body.layerId === 'string' ? body.layerId : ''
            if (!layerId) return sendJson(response, 400, { error: 'A layerId is required.' })
            return sendJson(response, 200, { layer: manager.store.trashLayer(layerId) })
          }
          if (url.pathname === '/api/lan/datasets/layers/restore' && request.method === 'POST') {
            const body = await readJson(request, 20_000)
            const layerId = typeof body.layerId === 'string' ? body.layerId : ''
            if (!layerId) return sendJson(response, 400, { error: 'A layerId is required.' })
            return sendJson(response, 200, { layer: manager.store.restoreLayer(layerId) })
          }
          if (url.pathname === '/api/lan/datasets/layers/class' && request.method === 'POST') {
            const body = await readJson(request, 20_000)
            const layerId = typeof body.layerId === 'string' ? body.layerId : ''
            const contentClass = body.contentClass === 'style' || body.contentClass === 'character' || body.contentClass === 'motion' ? body.contentClass : null
            if (!layerId) return sendJson(response, 400, { error: 'A layerId is required.' })
            return sendJson(response, 200, { layer: manager.store.setLayerClass(layerId, contentClass) })
          }
          if (url.pathname === '/api/lan/datasets/layers/slowmo' && request.method === 'POST') {
            const body = await readJson(request, 20_000)
            const layerId = typeof body.layerId === 'string' ? body.layerId : ''
            const disposition = body.disposition === 'retime' || body.disposition === 'caption' || body.disposition === 'exclude' ? body.disposition : null
            if (!layerId) return sendJson(response, 400, { error: 'A layerId is required.' })
            return sendJson(response, 200, { layer: manager.store.setLayerSlowmo(layerId, disposition) })
          }
          if (url.pathname === '/api/lan/datasets/captions' && request.method === 'POST') {
            const body = await readJson(request, 200_000)
            const layerId = typeof body.layerId === 'string' ? body.layerId : ''
            const text = typeof body.text === 'string' ? body.text : ''
            if (!layerId) return sendJson(response, 400, { error: 'A layerId is required.' })
            try { return sendJson(response, 200, { layer: manager.store.setCaption(layerId, text, 'hand') }) } catch (error) { return fail(error, 400) }
          }
          if (url.pathname === '/api/lan/datasets/captions/history' && request.method === 'GET') {
            const layerId = idParam('layerId')
            if (!layerId) return sendJson(response, 400, { error: 'A layerId is required.' })
            return sendJson(response, 200, { history: manager.store.captionHistory(layerId), validation: manager.validateTriggerFor(manager.store.getLayer(layerId)?.caption?.text ?? '') })
          }
          if (url.pathname === '/api/lan/datasets/captions/validate' && request.method === 'POST') {
            const body = await readJson(request, 100_000)
            const text = typeof body.text === 'string' ? body.text : ''
            return sendJson(response, 200, manager.validateTriggerFor(text))
          }
          if (url.pathname === '/api/lan/datasets/captions/review' && request.method === 'POST') {
            const body = await readJson(request, 20_000)
            const layerId = typeof body.layerId === 'string' ? body.layerId : ''
            const reviewState = body.reviewState === 'queued' || body.reviewState === 'approved' ? body.reviewState : null
            if (!layerId) return sendJson(response, 400, { error: 'A layerId is required.' })
            manager.store.setCaptionReview(layerId, reviewState)
            return sendJson(response, 200, { layer: manager.store.getLayer(layerId) })
          }
          if (url.pathname === '/api/lan/datasets/settings' && request.method === 'GET') {
            return sendJson(response, 200, { settings: manager.store.getSettings() })
          }
          if (url.pathname === '/api/lan/datasets/settings' && request.method === 'POST') {
            const body = await readJson(request, 100_000)
            const settings = manager.store.saveSettings({
              triggerToken: typeof body.triggerToken === 'string' ? body.triggerToken : undefined,
              contentClass: body.contentClass === 'style' || body.contentClass === 'character' || body.contentClass === 'motion' ? body.contentClass : undefined,
              audioPolicy: isRecord(body.audioPolicy) ? {
                expectSoundscapeClauses: body.audioPolicy.expectSoundscapeClauses === true,
                blankReplaceExisting: body.audioPolicy.blankReplaceExisting === true,
              } : undefined,
            })
            return sendJson(response, 200, { settings })
          }
          if (url.pathname === '/api/lan/datasets/aspects' && request.method === 'GET') {
            return sendJson(response, 200, { aspects: manager.store.listAspects() })
          }
          if (url.pathname === '/api/lan/datasets/aspects/toggle' && request.method === 'POST') {
            const body = await readJson(request, 20_000)
            const id = typeof body.id === 'string' ? body.id : ''
            if (!id) return sendJson(response, 400, { error: 'An aspect id is required.' })
            try { return sendJson(response, 200, { aspects: manager.store.setAspectEnabled(id, body.enabled !== false) }) } catch (error) { return fail(error, 400) }
          }
          if (url.pathname === '/api/lan/datasets/aspects/add' && request.method === 'POST') {
            const body = await readJson(request, 20_000)
            const label = typeof body.label === 'string' ? body.label : ''
            const ratio = Number(body.ratio)
            if (!label || !Number.isFinite(ratio)) return sendJson(response, 400, { error: 'A label and a numeric w/h ratio are required.' })
            try { return sendJson(response, 200, { aspects: manager.store.addCustomAspect(label, ratio) }) } catch (error) { return fail(error, 400) }
          }
          if (url.pathname === '/api/lan/datasets/aspects/delete' && request.method === 'POST') {
            const body = await readJson(request, 20_000)
            const id = typeof body.id === 'string' ? body.id : ''
            if (!id) return sendJson(response, 400, { error: 'An aspect id is required.' })
            try { return sendJson(response, 200, { aspects: manager.store.deleteAspect(id) }) } catch (error) { return fail(error, 400) }
          }
          if (url.pathname === '/api/lan/datasets/dedup' && request.method === 'POST') {
            try {
              const result = await manager.runDedupPass()
              return sendJson(response, 200, { ...result, clipConsent: clipConsentInfo() })
            } catch (error) { return fail(error) }
          }
          if (url.pathname === '/api/lan/datasets/triage' && request.method === 'POST') {
            const body = await readJson(request, 40_000_000)
            const data = typeof body.image === 'string' ? body.image : ''
            if (!data || data.length < 16) return sendJson(response, 400, { error: 'A base64 reference image is required.' })
            let bytes: Buffer
            try { bytes = Buffer.from(data.replace(/^data:[^;]+;base64,/, ''), 'base64') } catch { return sendJson(response, 400, { error: 'The reference bytes are not valid base64.' }) }
            if (!bytes.length) return sendJson(response, 400, { error: 'The reference image decoded to zero bytes.' })
            try {
              const result = await manager.referenceTriage(bytes, Number(body.limit) || 50)
              return sendJson(response, 200, { ...result, clipConsent: clipConsentInfo() })
            } catch (error) { return fail(error) }
          }
          // CLIP consent record (LOW-2): records or withdraws the user's
          // acknowledgement for the curation pass's CLIP weight download
          // (Apache-2.0, huggingface.co) in the settings fetch-consent ledger.
          if (url.pathname === '/api/lan/datasets/clip/consent' && request.method === 'POST') {
            const body = await readJson(request, 10_000).catch(() => ({}) as Record<string, unknown>)
            const consented = body.consented === true
            const consents = { ...settings.fetch.consents }
            if (consented) consents[CLIP_CONSENT_ID] = { consented: true, licenseSpdx: CLIP_LICENSE_SPDX, at: Date.now() }
            else delete consents[CLIP_CONSENT_ID]
            await saveSettings({ ...settings, fetch: { consents } })
            logEvent({ kind: 'datasets.clip-consent', entry: CLIP_CONSENT_ID, consented, license: CLIP_LICENSE_SPDX, model: CLIP_MODEL_ID })
            return sendJson(response, 200, { consented, model: CLIP_MODEL_ID, licenseSpdx: CLIP_LICENSE_SPDX })
          }
          if (url.pathname === '/api/lan/datasets/similar' && request.method === 'GET') {
            const layerId = idParam('layerId')
            if (!layerId) return sendJson(response, 400, { error: 'A layerId is required.' })
            return sendJson(response, 200, { results: manager.findSimilar(layerId) })
          }
          if (url.pathname === '/api/lan/datasets/audit/slowmo' && request.method === 'POST') {
            const body = await readJson(request, 20_000)
            const sourceId = typeof body.sourceId === 'string' ? body.sourceId : ''
            if (!sourceId) return sendJson(response, 400, { error: 'A sourceId is required.' })
            try { return sendJson(response, 200, await manager.auditSourceSlowMo(sourceId)) } catch (error) { return fail(error) }
          }
          if (url.pathname === '/api/lan/datasets/scenes/propose' && request.method === 'POST') {
            const body = await readJson(request, 20_000)
            const sourceId = typeof body.sourceId === 'string' ? body.sourceId : ''
            if (!sourceId) return sendJson(response, 400, { error: 'A sourceId is required.' })
            try { return sendJson(response, 200, { proposals: await manager.proposeSceneSplits(sourceId) }) } catch (error) { return fail(error, 400) }
          }
          if (url.pathname === '/api/lan/datasets/scenes/accept' && request.method === 'POST') {
            const body = await readJson(request, 100_000)
            const sourceId = typeof body.sourceId === 'string' ? body.sourceId : ''
            const frames = Array.isArray(body.frames) ? body.frames.map((frame: unknown) => Math.round(Number(frame))).filter((frame: number) => Number.isFinite(frame) && frame >= 0) : null
            if (!sourceId || !frames) return sendJson(response, 400, { error: 'A sourceId and a frames array are required.' })
            manager.store.proposeCuts(sourceId, frames, frames.map(() => true))
            return sendJson(response, 200, { cuts: manager.store.cutsFor(sourceId) })
          }
          if (url.pathname === '/api/lan/datasets/scenes/split' && request.method === 'POST') {
            const body = await readJson(request, 20_000)
            const sourceId = typeof body.sourceId === 'string' ? body.sourceId : ''
            if (!sourceId) return sendJson(response, 400, { error: 'A sourceId is required.' })
            try { return sendJson(response, 200, { children: manager.splitAtCuts(sourceId) }) } catch (error) { return fail(error, 400) }
          }
          if (url.pathname === '/api/lan/datasets/vlm/plan' && request.method === 'POST') {
            const body = await readJson(request, 20_000)
            const layerId = typeof body.layerId === 'string' ? body.layerId : ''
            if (!layerId) return sendJson(response, 400, { error: 'A layerId is required.' })
            const layer = manager.store.getLayer(layerId)
            const source = layer ? manager.store.getSource(layer.sourceId) : null
            if (!layer || !source) return sendJson(response, 404, { error: 'No layer with that id.' })
            const fps = source.probe.fps ?? 24
            const duration = ((layer.trim?.outFrame ?? source.decodedFrames ?? (source.probe.durationSec ?? 1) * fps) - (layer.trim?.inFrame ?? 0)) / fps
            const model = settings.llamaVisionModel.trim() || null
            const nativeVideo = model ? inferFamily(model).includes('qwen') : false
            return sendJson(response, 200, { plan: planVlmPass({ durationSec: Math.max(0.1, duration), nativeVideo }), model })
          }
          if (url.pathname === '/api/lan/datasets/vlm/caption' && request.method === 'POST') {
            const body = await readJson(request, 100_000)
            const layerId = typeof body.layerId === 'string' ? body.layerId : ''
            if (!layerId) return sendJson(response, 400, { error: 'A layerId is required.' })
            try { return sendJson(response, 200, await manager.captionLayer(datasetVlmSeam(), layerId, typeof body.instruction === 'string' ? body.instruction.slice(0, 4000) : undefined)) } catch (error) { return fail(error, 400) }
          }
          if (url.pathname === '/api/lan/datasets/vlm/batch' && request.method === 'POST') {
            const body = await readJson(request, 200_000)
            const layerIds = Array.isArray(body.layerIds) ? body.layerIds.filter((id: unknown) => typeof id === 'string') : []
            if (!layerIds.length || layerIds.length > 500) return sendJson(response, 400, { error: 'Provide between 1 and 500 layer ids.' })
            const guard = body.guard === 'queue' ? 'queue' : 'skip'
            try { return sendJson(response, 200, await manager.captionBatch(datasetVlmSeam(), layerIds, { instruction: typeof body.instruction === 'string' ? body.instruction.slice(0, 4000) : undefined, guard })) } catch (error) { return fail(error, 400) }
          }
          if (url.pathname === '/api/lan/datasets/vlm/discuss' && request.method === 'POST') {
            const body = await readJson(request, 200_000)
            const layerId = typeof body.layerId === 'string' ? body.layerId : ''
            const message = typeof body.message === 'string' ? body.message.slice(0, 20_000) : ''
            if (!layerId || !message.trim()) return sendJson(response, 400, { error: 'A layerId and a message are required.' })
            const history = Array.isArray(body.history) ? (body.history as Array<Record<string, unknown>>).slice(0, 24).flatMap((turn) => {
              if (!turn || typeof turn !== 'object' || (turn.role !== 'user' && turn.role !== 'assistant') || typeof turn.content !== 'string') return []
              return [{ role: turn.role as 'user' | 'assistant', content: turn.content.slice(0, 20_000) }]
            }) : undefined
            try { return sendJson(response, 200, await manager.discuss(datasetVlmSeam(), layerId, message, history)) } catch (error) { return fail(error, 400) }
          }
          if (url.pathname === '/api/lan/datasets/dashboard' && request.method === 'GET') {
            return sendJson(response, 200, manager.dashboard())
          }
          if (url.pathname === '/api/lan/datasets/bake' && request.method === 'POST') {
            const body = await readJson(request, 100_000)
            const layerId = typeof body.layerId === 'string' ? body.layerId : ''
            if (!layerId) return sendJson(response, 400, { error: 'A layerId is required.' })
            try {
              const folder = resolveDatasetFolder(typeof body.folder === 'string' ? body.folder.trim() : '', settings, 'dataset-bakes')
              const outcome = await manager.bakeLayer(layerId, {
                outputFolder: folder,
                gridTarget: Number.isFinite(Number(body.gridTarget)) ? Number(body.gridTarget) : null,
                acceptChanged: body.acceptChanged === true,
              })
              return sendJson(response, 200, { outcome })
            } catch (error) { return fail(error, 400) }
          }
          if (url.pathname === '/api/lan/datasets/export' && request.method === 'POST') {
            const body = await readJson(request, 200_000)
            const shape = body.shape === 'musubi' || body.shape === 'diffsynx' || body.shape === 'external' ? body.shape : null
            const trainer = body.trainer === 'musubi' ? 'musubi' : 'diffsynx'
            const layerIds = Array.isArray(body.layerIds) ? body.layerIds.filter((id: unknown) => typeof id === 'string') : []
            if (!shape) return sendJson(response, 400, { error: 'An export shape (musubi / diffsynx / external) is required.' })
            if (!layerIds.length) return sendJson(response, 400, { error: 'Select at least one layer to export.' })
            try {
              const folder = resolveDatasetFolder(typeof body.folder === 'string' ? body.folder.trim() : '', settings, 'dataset-exports')
              const result = await manager.exportDataset({ shape, trainer, folder, layerIds, gridTarget: Number.isFinite(Number(body.gridTarget)) ? Number(body.gridTarget) : null, acceptWarnings: body.acceptWarnings === true })
              logEvent({ kind: 'datasets.export', shape, items: result.written.length, refused: result.refused.length })
              return sendJson(response, 200, result)
            } catch (error) { return fail(error, 400) }
          }
          if (url.pathname === '/api/lan/datasets/exports' && request.method === 'GET') {
            return sendJson(response, 200, { exports: manager.listExports() })
          }
          // Canvas bridge, direction 2 (§11): a dataset layer pinned as a
          // reference asset for op stacks — returns the reference descriptor
          // the canvas consumes (media URL + caption + geometry).
          if (url.pathname === '/api/lan/datasets/canvas/pin' && request.method === 'POST') {
            const body = await readJson(request, 20_000)
            const layerId = typeof body.layerId === 'string' ? body.layerId : ''
            if (!layerId) return sendJson(response, 400, { error: 'A layerId is required.' })
            const layer = manager.store.getLayer(layerId)
            if (!layer) return sendJson(response, 404, { error: 'No layer with that id.' })
            return sendJson(response, 200, {
              pin: {
                layerId: layer.id,
                media: `/api/lan/datasets/media?source=${layer.sourceId}`,
                crop: layer.crop,
                trim: layer.trim,
                caption: layer.caption?.text ?? '',
                name: layer.name || `dataset layer ${layer.id.slice(0, 8)}`,
              },
            })
          }
          return sendJson(response, 404, { error: `Unknown dataset-manager route ${url.pathname}.` })
        }
        // ---- LLM layer routes (v2 wave) --------------------------------------
        // Model listing from the ACTIVE provider, shaped for the client:
        // family inference, vision capability, router status, active flag.
        // An optional ?url= probes a CANDIDATE endpoint (Settings' Test
        // connection) through the same local-only SSRF guard.
        if (url.pathname === '/api/lan/llm/models' && request.method === 'GET') {
          const candidate = url.searchParams.get('url')
          const target = candidate && candidate.trim() ? candidate.trim() : settings.llamaCppUrl.trim()
          const started = Date.now()
          if (!target) {
            // No router configured: the Ollama fallback, surfaced with the
            // same shape so the Settings UI renders one model list either way.
            try {
              const models = await llm.activeProvider(settings).provider.listModels()
              return sendJson(response, 200, { provider: 'ollama' as const, endpoint: settings.ollamaUrl, model: settings.ollamaModel, connected: true, latencyMs: Date.now() - started, models: models.map((entry) => ({ id: entry.id, family: entry.family, familyLabel: familyManifest(entry.family).displayName, vision: entry.vision, status: entry.status, active: entry.id === settings.ollamaModel })) })
            } catch (providerFailure) {
              return sendJson(response, 200, { provider: 'ollama' as const, endpoint: settings.ollamaUrl, model: settings.ollamaModel, connected: false, latencyMs: Date.now() - started, error: providerFailure instanceof Error ? providerFailure.message : String(providerFailure), models: [] })
            }
          }
          if (!isLocalServiceUrl(target)) return sendJson(response, 400, { error: 'Only local service addresses can be tested.' })
          const router = createRouterProvider({ baseUrl: target, logFailure })
          try {
            const models = await router.listModels()
            const active = settings.llamaCppUrl.trim() === target ? (settings.llamaCppModel.trim() || models[0]?.id || '') : (settings.llamaCppModel.trim() || models[0]?.id || '')
            return sendJson(response, 200, { provider: 'router' as const, endpoint: target, model: active, connected: true, latencyMs: Date.now() - started, models: models.map((entry) => ({ id: entry.id, family: entry.family, familyLabel: familyManifest(entry.family).displayName, vision: entry.vision, status: entry.status, active: entry.id === active })) })
          } catch (providerFailure) {
            return sendJson(response, 200, { provider: 'router' as const, endpoint: target, model: '', connected: false, latencyMs: Date.now() - started, error: providerFailure instanceof Error ? providerFailure.message : String(providerFailure), models: [] })
          }
        }
        // Unified generate (non-streaming): composer-shaped assistant
        // requests AND legacy raw prompts; optional schema switches to a
        // structured result with thinking forced off for speed.
        if (url.pathname === '/api/lan/llm/generate' && request.method === 'POST') {
          const body = await readJson(request, 2_000_000)
          const prompt = typeof body.prompt === 'string' ? body.prompt.slice(0, 50_000) : undefined
          const draft = typeof body.draft === 'string' ? body.draft.slice(0, 50_000) : undefined
          if (!prompt && !draft) return sendJson(response, 400, { error: 'A draft or prompt is required.' })
          const history = Array.isArray(body.history) ? (body.history as Array<Record<string, unknown>>).slice(0, 24).flatMap((turn) => {
            if (!turn || typeof turn !== 'object' || (turn.role !== 'user' && turn.role !== 'assistant') || typeof turn.content !== 'string') return []
            return [{ role: turn.role as 'user' | 'assistant', content: turn.content.slice(0, 50_000), ...(typeof turn.reasoning === 'string' && turn.reasoning ? { reasoning: turn.reasoning.slice(0, 100_000) } : {}) }]
          }) : undefined
          try {
            const generated = await llm.generate({
              task: typeof body.task === 'string' ? body.task.slice(0, 64) : undefined,
              targetEngine: typeof body.targetEngine === 'string' ? body.targetEngine.slice(0, 64) : undefined,
              length: typeof body.length === 'string' ? body.length.slice(0, 16) : undefined,
              contentLevel: typeof body.contentLevel === 'string' ? body.contentLevel.slice(0, 16) : undefined,
              instructions: typeof body.instructions === 'string' ? body.instructions.slice(0, 20_000) : undefined,
              draft,
              prompt,
              history,
              schema: body.schema && typeof body.schema === 'object' && !Array.isArray(body.schema) ? body.schema as Record<string, unknown> : undefined,
              thinking: body.thinking === true ? true : body.thinking === false ? false : undefined,
              model: typeof body.model === 'string' ? body.model.slice(0, 200) : undefined,
              raw: body.raw === true,
            })
            if (generated.result !== undefined) return sendJson(response, 200, { result: generated.result, model: generated.model, provider: generated.provider })
            return sendJson(response, 200, { response: generated.response, reasoning: generated.reasoning, model: generated.model, provider: generated.provider })
          } catch (providerFailure) {
            return sendJson(response, 502, { error: providerFailure instanceof Error ? providerFailure.message : String(providerFailure) })
          }
        }
        // Streaming prep: returns a fabric-ready llm request (endpoint, model,
        // composed messages, family-tuned options) the client forwards
        // through the realtime llm channel. Router provider only.
        if (url.pathname === '/api/lan/llm/prepare' && request.method === 'POST') {
          const body = await readJson(request, 1_000_000)
          const draft = typeof body.draft === 'string' ? body.draft.slice(0, 50_000) : undefined
          if (!draft && typeof body.prompt !== 'string') return sendJson(response, 400, { error: 'A draft is required.' })
          try {
            const prepared = await llm.prepare({
              task: typeof body.task === 'string' ? body.task.slice(0, 64) : undefined,
              targetEngine: typeof body.targetEngine === 'string' ? body.targetEngine.slice(0, 64) : undefined,
              length: typeof body.length === 'string' ? body.length.slice(0, 16) : undefined,
              contentLevel: typeof body.contentLevel === 'string' ? body.contentLevel.slice(0, 16) : undefined,
              instructions: typeof body.instructions === 'string' ? body.instructions.slice(0, 20_000) : undefined,
              draft: draft ?? (typeof body.prompt === 'string' ? body.prompt.slice(0, 50_000) : ''),
              thinking: body.thinking === true ? true : body.thinking === false ? false : undefined,
              model: typeof body.model === 'string' ? body.model.slice(0, 200) : undefined,
              raw: body.raw === true,
            })
            return sendJson(response, 200, prepared)
          } catch (providerFailure) {
            return sendJson(response, 400, { error: providerFailure instanceof Error ? providerFailure.message : String(providerFailure) })
          }
        }
        // Vision captioning: one base64 image → descriptive line, with the
        // active vision-capable model (Gemma image-part-first when family is
        // gemma; <image> notation documented for vision-exp families).
        if (url.pathname === '/api/lan/llm/vision' && request.method === 'POST') {
          const body = await readJson(request, 36_000_000)
          const image = typeof body.image === 'string' ? body.image : ''
          if (!/^data:image\/(?:png|jpeg|webp);base64,/.test(image.slice(0, 40)) || image.length > 35_000_000) return sendJson(response, 400, { error: 'A base64 image data URL is required.' })
          try {
            const captioned = await llm.captionImage({
              image,
              instruction: typeof body.instruction === 'string' ? body.instruction.slice(0, 4_000) : undefined,
              model: typeof body.model === 'string' ? body.model.slice(0, 200) : undefined,
            })
            return sendJson(response, 200, captioned)
          } catch (providerFailure) {
            return sendJson(response, 502, { error: providerFailure instanceof Error ? providerFailure.message : String(providerFailure) })
          }
        }
        // User-editable composer fragments: factory seeds + persisted
        // overrides (workspace_state kv, smallest surface).
        if (url.pathname === '/api/lan/llm/fragments' && request.method === 'GET') {
          return sendJson(response, 200, llm.listFragments())
        }
        if (url.pathname === '/api/lan/llm/fragments' && request.method === 'POST') {
          const body = await readJson(request, 200_000)
          const id = typeof body.id === 'string' ? body.id.trim() : ''
          const content = typeof body.content === 'string' ? body.content : ''
          if (!id || id.length > 200 || content.length > 20_000) return sendJson(response, 400, { error: 'A fragment id and content are required.' })
          try {
            llm.saveFragmentOverride(id, content)
            return sendJson(response, 200, { saved: true })
          } catch (saveFailure) {
            return sendJson(response, 503, { error: saveFailure instanceof Error ? saveFailure.message : String(saveFailure) })
          }
        }
        // ---- Managed engine runtime (increment 1) ----------------------------
        // Status is a cheap snapshot + lazy health sample; start/stop are
        // idempotent (a start while starting/running reports already: true
        // and NEVER double-spawns — the port is probed before any spawn).
        if (url.pathname === '/api/lan/engine/status' && request.method === 'GET') {
          // Security hardening 1: the log tail is scrubbed AT THIS BOUNDARY —
          // the manager's ring (and the on-disk log) keep full diagnostic
          // text for the LOCAL user, while what crosses the LAN answers the
          // PII-scrub doctrine (failure path/reason, never prompt semantics;
          // engine tracebacks can echo input values).
          const status = await runtime.status()
          return sendJson(response, 200, { ...status, logTail: status.logTail.map(sanitizeEngineLogLine) })
        }
        if (url.pathname === '/api/lan/engine/start' && request.method === 'POST') {
          if (settings.engine.mode !== 'managed') return sendJson(response, 400, { error: 'Switch the engine to managed mode in Settings before launching.' })
          try {
            const started = await runtime.start()
            return sendJson(response, 200, { ...(await runtime.status()), already: started.already })
          } catch (startFailure) {
            const message = startFailure instanceof Error ? startFailure.message : String(startFailure)
            logFailure('engine/start', startFailure, { managed: true }, 'warn')
            const snapshot = await runtime.status().catch(() => null)
            return sendJson(response, startFailure instanceof RuntimeConfigError ? 400 : 502, { error: message, ...(snapshot ?? {}) })
          }
        }
        if (url.pathname === '/api/lan/engine/stop' && request.method === 'POST') {
          return sendJson(response, 200, await runtime.stop())
        }
        // ---- Vendored node packs (increment 2, AC zzdfklo slice) ------------
        // custom_nodes/ is ComfyUI's sanctioned extension seam: list is
        // read-only for everyone; install/uninstall act on the configured
        // checkout (managed or the user's own — their consent, their disk)
        // and only ever inside custom_nodes/<pack name>.
        if (url.pathname === '/api/lan/engine/nodes' && request.method === 'GET') {
          const checkout = isUsableCheckout(settings.engine.checkoutPath) ? settings.engine.checkoutPath : null
          return sendJson(response, 200, { packs: await checkAllNodePacks(checkout, resolveVendorRoot()) })
        }
        if (url.pathname === '/api/lan/engine/nodes/install' && request.method === 'POST') {
          const body = await readJson(request, 10_000)
          const pack = findNodePack(typeof body.id === 'string' ? body.id : '')
          if (!pack) return sendJson(response, 400, { error: 'Unknown node pack id.' })
          if (!isUsableCheckout(settings.engine.checkoutPath)) {
            return sendJson(response, 400, { error: 'Set a valid ComfyUI checkout (with main.py) in the managed engine settings first.' })
          }
          const sourceDirectory = typeof body.sourceDirectory === 'string' ? body.sourceDirectory : undefined
          const result = await installNodePack(pack, { checkout: settings.engine.checkoutPath, sourceDirectory })
          if (!result.installed && !result.alreadyInstalled) {
            return sendJson(response, 400, { error: result.notes.join(' ') || 'The pack could not be installed.', pack: result.status })
          }
          logEvent({ kind: 'engine.node-pack-installed', pack: pack.id, revision: pack.pinnedRevision })
          return sendJson(response, 200, { pack: result.status, notes: result.notes })
        }
        if (url.pathname === '/api/lan/engine/nodes/uninstall' && request.method === 'POST') {
          const body = await readJson(request, 10_000)
          const pack = findNodePack(typeof body.id === 'string' ? body.id : '')
          if (!pack) return sendJson(response, 400, { error: 'Unknown node pack id.' })
          if (!isUsableCheckout(settings.engine.checkoutPath)) {
            return sendJson(response, 400, { error: 'Set a valid ComfyUI checkout (with main.py) in the managed engine settings first.' })
          }
          const removed = await uninstallNodePack(pack, settings.engine.checkoutPath)
          if (!removed.removed) return sendJson(response, 404, { error: removed.reason ?? 'The pack is not installed.' })
          logEvent({ kind: 'engine.node-pack-uninstalled', pack: pack.id })
          return sendJson(response, 200, { pack: await checkAllNodePacks(settings.engine.checkoutPath, resolveVendorRoot()).then((packs) => packs.find((entry) => entry.id === pack.id)) })
        }
        // ---- Local-first fetcher (task hgjbea2) --------------------------------
        // The only network-touching routes in the app. catalog is pure
        // local state; consent RECORDS an explicit user acknowledgement
        // (license text is surfaced by the caller BEFORE this is called);
        // start refuses without a matching consent — the check is enforced
        // again inside the FetchManager, so no caller can bypass it; remove
        // takes back the studio's placements only.
        if (url.pathname === '/api/lan/fetch/catalog' && request.method === 'GET') {
          return sendJson(response, 200, { entries: await fetcher.catalogStatus() })
        }
        if (url.pathname === '/api/lan/fetch/consent' && request.method === 'POST') {
          const body = await readJson(request, 10_000)
          const entry = findFetchEntry(typeof body.id === 'string' ? body.id : '')
          if (!entry) return sendJson(response, 400, { error: 'Unknown fetchable item id.' })
          const consented = body.consented === true
          const consents = { ...settings.fetch.consents }
          if (consented) consents[entry.id] = { consented: true, licenseSpdx: entry.licenseSpdx, at: Date.now() }
          else delete consents[entry.id]
          await saveSettings({ ...settings, fetch: { consents } })
          logEvent({ kind: 'fetcher.consent', entry: entry.id, consented, license: entry.licenseSpdx })
          return sendJson(response, 200, { entries: await fetcher.catalogStatus() })
        }
        if (url.pathname === '/api/lan/fetch/start' && request.method === 'POST') {
          const body = await readJson(request, 10_000)
          const started = await fetcher.start(typeof body.id === 'string' ? body.id : '', {
            destinationDir: typeof body.destinationDir === 'string' ? body.destinationDir : undefined,
          })
          if (!started.started) return sendJson(response, started.reason === 'Unknown fetchable item id.' ? 400 : started.reason === 'A fetch for this item is already running.' ? 409 : 403, { error: started.reason })
          return sendJson(response, 200, { started: true, id: started.id })
        }
        if (url.pathname === '/api/lan/fetch/remove' && request.method === 'POST') {
          const body = await readJson(request, 10_000)
          const removed = await fetcher.remove(typeof body.id === 'string' ? body.id : '')
          if (!removed.removed) return sendJson(response, 404, { error: removed.reason ?? 'The item could not be removed.' })
          return sendJson(response, 200, { removed: true, notes: removed.notes, entries: await fetcher.catalogStatus() })
        }
        // ---- Consent patch tier: revert restores the pristine backup -------
        // (managed checkout only; revert is always safe — it undoes us.)
        if (url.pathname === '/api/lan/engine/patch/revert' && request.method === 'POST') {
          const body = await readJson(request, 10_000)
          const patch = ENGINE_PATCHES.find((candidate) => candidate.id === body.id)
          if (!patch) return sendJson(response, 400, { error: 'Unknown patch id.' })
          if (!isUsableCheckout(settings.engine.checkoutPath)) {
            return sendJson(response, 400, { error: 'Set a valid ComfyUI checkout (with main.py) in the managed engine settings first.' })
          }
          try {
            const reverted = await revertEnginePatch(patch, settings.engine.checkoutPath)
            if (!reverted.reverted) return sendJson(response, 409, { error: reverted.reason ?? 'The patch could not be reverted.' })
            logEvent({ kind: 'engine.patch-reverted', patch: patch.id })
            return sendJson(response, 200, { reverted: true, patch: patch.id })
          } catch (revertFailure) {
            return sendJson(response, 502, { error: revertFailure instanceof Error ? revertFailure.message : String(revertFailure) })
          }
        }
        if (url.pathname === '/api/lan/cancel' && request.method === 'POST') {
          const body = await readJson(request, 10_000)
          const promptId = typeof body.promptId === 'string' ? body.promptId : ''
          if (!promptId) return sendJson(response, 400, { error: 'A prompt ID is required.' })
          // The honest verdict rides through (M5′): {cancelled:false,
          // state:'finished'} tells the client the render COMPLETED — the job
          // must not be marked cancelled (it still lands as a take).
          const result = await cancelPromptAt(settings.comfyUrl, promptId)
          return sendJson(response, 200, result)
        }
        if (url.pathname.startsWith('/api/lan/history/') && request.method === 'GET') {
          const promptId = decodeURIComponent(url.pathname.slice('/api/lan/history/'.length))
          const history = await comfyFetch(settings.comfyUrl, `/history/${encodeURIComponent(promptId)}`) as Record<string, unknown>
          const output = historyOutput(history, promptId, url.searchParams.get('kind') === 'image' ? 'image' : 'video')
          const entry = history[promptId] as { status?: { status_str?: string } } | undefined
          return sendJson(response, 200, { finished: Boolean(entry), error: entry?.status?.status_str === 'error' ? 'ComfyUI reported an execution error. Check the desktop console for the failed node.' : undefined, output, history })
        }
        // Settings read: the editor's own data source. Unlike /bootstrap
        // (which strips model paths — pure recon), these path fields are
        // FUNCTIONAL: the SPA round-trips them (the settings editor, the
        // fetch browser, the studio bridges), so they cannot be redacted
        // without breaking the write path. The recon audience that mattered
        // — foreign websites and DNS-rebinding readers — is closed by the
        // origin/Host gate above; remaining readers are the same-origin SPA
        // and accepted-posture LAN peers.
        if (url.pathname === '/api/lan/settings' && request.method === 'GET') return sendJson(response, 200, { settings })
        if (url.pathname === '/api/lan/settings' && request.method === 'POST') {
          const body = await readJson(request, 200_000)
          const raw = body.settings && typeof body.settings === 'object' ? body.settings as Partial<AppSettings> : null
          if (!raw || typeof raw.comfyUrl !== 'string' || typeof raw.outputDirectory !== 'string') return sendJson(response, 400, { error: 'A settings object with service URLs is required.' })
          // Security hardening 1: settings are the crown-jewel write (they
          // repoint spawned binaries, the output tree, and every outbound
          // service URL), so shape and SSRF rules are enforced at the write
          // boundary, loudly.
          const pathProblems = settingsPathProblems(raw)
          if (pathProblems.length) return sendJson(response, 400, { error: pathProblems.join(' ') })
          for (const [name, url] of [['comfyUrl', raw.comfyUrl], ['ollamaUrl', raw.ollamaUrl], ['llamaCppUrl', raw.llamaCppUrl]] as const) {
            if (url && !isLocalServiceUrl(url)) return sendJson(response, 400, { error: `${name} must be a local (loopback or private-LAN) address.` })
          }
          // Warn-not-silent on well-formed but nonexistent paths: the save
          // succeeds (paths are routinely configured ahead of the software
          // being installed), but the response names every miss.
          const warnings: string[] = []
          const noteMissing = (label: string, value: string) => { if (value && isAbsolute(value) && !existsSync(value)) warnings.push(`${label} does not exist yet: ${value}`) }
          noteMissing('outputDirectory', raw.outputDirectory)
          noteMissing('ffmpegPath', raw.ffmpegPath ?? '')
          noteMissing('engine.pythonPath', raw.engine?.pythonPath ?? '')
          noteMissing('engine.checkoutPath', raw.engine?.checkoutPath ?? '')
          if (warnings.length) logEvent({ kind: 'settings.missing-paths', count: warnings.length })
          const saved = await saveSettings(normalizeSettings(raw))
          // Leaving managed mode is an explicit user action: stop the engine
          // the studio started (adopted strays included — stop re-verifies
          // before signalling anything). Fire-and-forget so the save never
          // blocks on a 3 s grace window; the status route reports the end.
          if (settings.engine.mode === 'managed' && saved.engine.mode !== 'managed') {
            void runtime.stop().catch((stopFailure: unknown) => logFailure('engine/stop-on-mode-flip', stopFailure, undefined, 'warn'))
          }
          return sendJson(response, 200, { settings: saved, ...(warnings.length ? { warnings } : {}) })
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
        if (url.pathname === '/api/lan/telemetry' && request.method === 'GET') return sendJson(response, 200, await readGpuTelemetrySampled())
        if (url.pathname === '/api/lan/doctor' && request.method === 'GET') return sendJson(response, 200, await runSetupDoctor(settings))
        if (url.pathname === '/api/lan/free' && request.method === 'POST') {
          // Queue-hygiene soft reset: unload models and return VRAM to the pool.
          // Honest verdict (audit minor): an upstream failure must NEVER
          // surface as {freed:true} — the auto-retry path would re-submit
          // believing VRAM was freed. Failure answers 502 + {freed:false}
          // with the reason; the bridge throws on non-2xx, so the retry's
          // catch skips the resubmit and the original error surfaces.
          try {
            await comfyFetch(settings.comfyUrl, '/free', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }) })
            return sendJson(response, 200, { freed: true })
          } catch (error) {
            logFailure('comfy/free', error, undefined, 'debug')
            return sendJson(response, 502, { freed: false, error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)) })
          }
        }
        if (url.pathname === '/api/lan/prompt-library' && request.method === 'GET') {
          // Pinned-host proxy to Civitai's public images API (withMeta=true).
          // The host is fixed — never user-supplied — so this is a deliberate
          // exception to the local-only service rule, and no credentials are
          // forwarded. Allowlisted parameters only.
          const upstream = new URL('https://civitai.com/api/v1/images')
          upstream.searchParams.set('withMeta', 'true')
          const text = url.searchParams.get('query') ?? ''
          if (text) upstream.searchParams.set('query', text.slice(0, 200))
          const limit = Number(url.searchParams.get('limit'))
          if (Number.isInteger(limit) && limit >= 1 && limit <= 50) upstream.searchParams.set('limit', String(limit))
          const cursor = url.searchParams.get('cursor')
          if (cursor && cursor.length <= 200) upstream.searchParams.set('cursor', cursor)
          const nsfw = url.searchParams.get('nsfw') === 'true'
          upstream.searchParams.set('nsfw', nsfw ? 'true' : 'false')
          // Scope to the H3 base model by default so harvested prompts are
          // actually written for this engine (the community already uses
          // MiniMax's official contract fields); 'all' opts out explicitly.
          if (url.searchParams.get('scope') !== 'all') upstream.searchParams.set('baseModels', 'MiniMax H3')
          const sort = url.searchParams.get('sort')
          if (sort && ['Most Reactions', 'Most Comments', 'Newest', 'Oldest'].includes(sort)) upstream.searchParams.set('sort', sort)
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 12_000)
          try {
            const upstreamResponse = await fetch(upstream, { signal: controller.signal, headers: { accept: 'application/json' } })
            if (!upstreamResponse.ok) return sendJson(response, 502, { error: `The prompt library is unavailable (Civitai returned ${upstreamResponse.status}).` })
            const result = await upstreamResponse.json() as {
              items?: Array<Record<string, unknown>>; metadata?: { nextCursor?: string }
            }
            const items = (result.items ?? []).map((raw) => {
              const meta = (raw.meta ?? {}) as Record<string, unknown>
              return {
                id: typeof raw.id === 'number' || typeof raw.id === 'string' ? String(raw.id) : '',
                prompt: typeof meta.prompt === 'string' ? meta.prompt : '',
                negativePrompt: typeof meta.negativePrompt === 'string' ? meta.negativePrompt : undefined,
                seed: typeof meta.seed === 'number' ? meta.seed : undefined,
                sampler: typeof meta.sampler === 'string' ? meta.sampler : undefined,
                steps: typeof meta.steps === 'number' ? meta.steps : undefined,
                cfgScale: typeof meta.cfgScale === 'number' ? meta.cfgScale : undefined,
                width: typeof meta.Size === 'string' ? Number(meta.Size.split('x')[0]) || undefined : undefined,
                height: typeof meta.Size === 'string' ? Number(meta.Size.split('x')[1]) || undefined : undefined,
                username: typeof raw.username === 'string' ? raw.username : undefined,
                stats: typeof raw.stats === 'object' && raw.stats ? raw.stats as { voteCount?: number; commentCount?: number } : undefined,
              }
            }).filter((item) => item.prompt && item.prompt.length > 24 && !/^https?:\/\//i.test(item.prompt.trim())).slice(0, 50)
            return sendJson(response, 200, { items, cursor: result.metadata?.nextCursor })
          } catch (error) {
            return sendJson(response, 502, { error: error instanceof Error && error.name === 'AbortError' ? 'The prompt library request timed out.' : 'The prompt library could not be reached.' })
          } finally {
            clearTimeout(timeout)
          }
        }
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
          try { return sendJson(response, 200, await saveOutputImage(file, settings.outputDirectory, settings.comfyUrl)) } catch (error) { return sendJson(response, 502, { error: error instanceof Error ? error.message : String(error) }) }
        }
        if (url.pathname === '/api/lan/video/frame' && request.method === 'POST') {
          const body = await readJson(request, 200_000)
          const position = body.position === 'last' ? 'last' as const : Number(body.position)
          if (position !== 'last' && (!Number.isFinite(position) || position < 0)) return sendJson(response, 400, { error: 'A valid frame position is required.' })
          try {
            const input = await resolveLanVideoSource(body.source)
            const result = await extractVideoFrameAt(input, position, settings.outputDirectory, settings.ffmpegPath)
            return sendJson(response, 200, { ...result, url: `/api/lan/media?source=output&path=${encodeURIComponent(result.path)}` })
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
            const frames = await extractVideoFramesAt(input, positions, settings.outputDirectory, settings.ffmpegPath)
            return sendJson(response, 200, { frames: frames.map((frame) => ({ ...frame, url: `/api/lan/media?source=output&path=${encodeURIComponent(frame.path)}` })) })
          } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) }
        }
        if (url.pathname === '/api/lan/video/trim' && request.method === 'POST') {
          const body = await readJson(request, 200_000)
          try {
            const input = await resolveLanVideoSource(body.source)
            const result = await trimVideoAt(input, Number(body.start), Number(body.end), settings.outputDirectory, settings.ffmpegPath)
            return sendJson(response, 200, { ...result, url: `/api/lan/media?source=output&path=${encodeURIComponent(result.path)}` })
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
            const result = await joinVideosAt(inputs, clips, settings.outputDirectory, settings.ffmpegPath)
            return sendJson(response, 200, { ...result, url: `/api/lan/media?source=output&path=${encodeURIComponent(result.path)}` })
          } catch (error) { return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) }
        }
        // Filmstrip sheets (wave 2d): GET/HEAD serves the sprite PNG for an
        // output-contained video, generating it lazily on first request.
        // Long cache with a content-derived ETag (source mtime+size): a
        // re-render changes the ETag and regenerates the sheet. The layout
        // and generation-count headers are debug/test affordances.
        if (url.pathname === '/api/lan/assets/filmstrip' && (request.method === 'GET' || request.method === 'HEAD')) {
          const requested = url.searchParams.get('path') ?? ''
          const durationParam = Number(url.searchParams.get('duration'))
          const root = resolve(settings.outputDirectory)
          const candidate = requested ? resolve(requested) : root
          const containment = relative(root, candidate)
          if (!requested || containment.startsWith('..') || isAbsolute(containment)) return sendJson(response, 403, { error: 'Filmstrips are generated only for files inside the output directory.' })
          if (!existsSync(candidate)) return sendJson(response, 404, { error: 'The media file is unavailable.' })
          if (!mediaExtensions.has(extname(candidate).toLowerCase())) return sendJson(response, 400, { error: 'Filmstrips are generated for video files.' })
          try {
            const sheet = await getFilmstripSheet(candidate, settings.outputDirectory, settings.ffmpegPath, Number.isFinite(durationParam) && durationParam > 0 ? durationParam : null)
            const etag = `"fs-${Math.round(sheet.sourceMtimeMs)}-${sheet.sourceBytes}"`
            const headers: Record<string, string> = {
              'content-type': 'image/png',
              'cache-control': 'private, max-age=86400',
              etag,
              'x-minimax-filmstrip-cols': String(sheet.cols),
              'x-minimax-filmstrip-rows': String(sheet.rows),
              'x-minimax-filmstrip-frame-count': String(sheet.frameCount),
              'x-minimax-filmstrip-generations': String(filmstripGenerationCount),
            }
            const ifNoneMatch = request.headers['if-none-match']
            if ((Array.isArray(ifNoneMatch) ? ifNoneMatch[0] : ifNoneMatch) === etag) {
              response.writeHead(304, headers)
              return response.end()
            }
            const details = await stat(sheet.path)
            headers['content-length'] = String(details.size)
            response.writeHead(200, headers)
            if (request.method === 'HEAD') return response.end()
            return createReadStream(sheet.path).pipe(response)
          } catch (error) {
            return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
          }
        }
        // Filmstrip attribution hook: the queue calls this the moment a video
        // job lands a local output path. Registers the frame-indexed asset
        // record (fps 24 / frame_count = duration × 24 — an APPROXIMATION
        // from the job record until real probing lands) and warm-starts the
        // sheet. Registration is best-effort; generation failure never fails
        // the call.
        if (url.pathname === '/api/lan/assets/filmstrip' && request.method === 'POST') {
          const body = await readJson(request, 10_000)
          const requested = typeof body.path === 'string' ? body.path : ''
          const root = resolve(settings.outputDirectory)
          const candidate = requested ? resolve(requested) : root
          const containment = relative(root, candidate)
          if (!requested || containment.startsWith('..') || isAbsolute(containment)) return sendJson(response, 403, { error: 'Assets are registered only for files inside the output directory.' })
          if (!existsSync(candidate)) return sendJson(response, 404, { error: 'The media file is unavailable.' })
          if (!mediaExtensions.has(extname(candidate).toLowerCase())) return sendJson(response, 400, { error: 'Only video outputs can be registered.' })
          const details = await stat(candidate)
          if (!details.isFile()) return sendJson(response, 404, { error: 'The media file is unavailable.' })
          const duration = typeof body.duration === 'number' && Number.isFinite(body.duration) && body.duration > 0
            ? body.duration
            : (await probeMediaDurationSeconds(settings.ffmpegPath, candidate)) ?? 0
          const frameCount = Math.max(0, Math.round(duration * FILMSTRIP_FPS))
          if (studioRepo) {
            try {
              studioRepo.upsertAsset({
                id: candidate,
                kind: 'video',
                path: candidate,
                mime: mediaMimeTypes[extname(candidate).toLowerCase()] ?? 'video/mp4',
                bytes: details.size,
                width: typeof body.width === 'number' && Number.isFinite(body.width) ? body.width : undefined,
                height: typeof body.height === 'number' && Number.isFinite(body.height) ? body.height : undefined,
                durationMs: Math.round(duration * 1000),
                fps: FILMSTRIP_FPS,
                frameCount,
              })
            } catch (error) {
              logFailure('assets/register', error, { file: basename(candidate) }, 'warn')
            }
          }
          void getFilmstripSheet(candidate, settings.outputDirectory, settings.ffmpegPath, duration > 0 ? duration : null)
            .catch((error: unknown) => { logFailure('filmstrip/generate', error, { file: basename(candidate) }, 'debug') })
          return sendJson(response, 200, { path: candidate, registered: Boolean(studioRepo), fps: FILMSTRIP_FPS, frameCount, duration })
        }
        // HEAD is accepted alongside GET for the output-contained path (same
        // headers, no body); the upstream ComfyUI proxy path stays GET-only.
        if (url.pathname === '/api/lan/media' && (request.method === 'GET' || request.method === 'HEAD')) {
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

      const distRoot = normalize(paths.staticRoot)
      const requested = url.pathname === '/' || url.pathname === '/mobile' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '')
      const filePath = normalize(join(distRoot, requested))
      if (!(filePath === distRoot || filePath.startsWith(distRoot + sep)) || !existsSync(filePath)) {
        const fallback = join(distRoot, 'index.html')
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': CONTENT_SECURITY_POLICY }); return createReadStream(fallback).pipe(response)
      }
      const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }
      const headers: Record<string, string> = {
        'content-type': mime[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
        // Content-hashed /assets/ files are immutable; index.html must always
        // revalidate so a new deploy is picked up on the next reload.
        'cache-control': requested === 'index.html' ? 'no-cache' : requested.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=86400',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'content-security-policy': CONTENT_SECURITY_POLICY,
        'vary': 'Accept-Encoding',
      }
      // Precompressed companions (scripts/compress-dist.cjs emits .br/.gz at
      // build time) are served when the client accepts them — zero runtime
      // compression cost. Brotli wins over gzip; content-type stays the
      // ORIGINAL file's.
      let servedPath = filePath
      const acceptEncodingHeader = request.headers['accept-encoding']
      const encodings = (Array.isArray(acceptEncodingHeader) ? acceptEncodingHeader.join(',') : acceptEncodingHeader ?? '').toLowerCase().split(',').map((part) => part.split(';')[0].trim())
      if (encodings.includes('br') && existsSync(`${filePath}.br`)) {
        servedPath = `${filePath}.br`
        headers['content-encoding'] = 'br'
      } else if ((encodings.includes('gzip') || encodings.includes('*')) && existsSync(`${filePath}.gz`)) {
        servedPath = `${filePath}.gz`
        headers['content-encoding'] = 'gzip'
      }
      response.writeHead(200, headers)
      createReadStream(servedPath).pipe(response)
    } catch (error) {
      // Malformed request bodies are the CLIENT's error, not a structural
      // failure: 400 with the reason, no correlation-ref ceremony.
      if (error instanceof MalformedJsonBodyError) {
        logFailure(route, error, { method: request.method ?? '' }, 'debug')
        if (response.headersSent) {
          response.destroy()
          return
        }
        return sendJson(response, 400, { error: error.message, stage: route })
      }
      // Last-resort handler: the client gets a STRUCTURAL body (fixed
      // message + route + ref) — raw internals never cross the wire. The
      // sanitized failure path/reason lands server-side, keyed by the same
      // ref the client saw.
      const ref = failureRef()
      logFailure(route, error, { method: request.method ?? '', ref })
      if (response.headersSent) {
        // Mid-stream failure (SSE/media pipe): the status line is gone, so
        // the only honest signal is cutting the connection.
        response.destroy()
        return
      }
      sendJson(response, 500, { error: 'Request failed.', stage: route, ref })
    }
  }

  async function startLanServer() {
    const configuredPort = Number(process.env.MINIMAX_LAN_PORT)
    const port = Number.isInteger(configuredPort) && configuredPort >= 1024 && configuredPort <= 65535 ? configuredPort : 4178
    // Settings load BEFORE listen: the origin guard's host allowlist (and the
    // whole settings cache) must be warm when the first request arrives, so a
    // custom-hostname setup is never refused by a cold cache.
    await loadSettings()
    lanToken = await loadLanToken()
    const address = lanAddress()
    // HTTPS by default (PWA install, and no cleartext tokens on hostile LANs);
    // --no-https / MINIMAX_NO_HTTPS=1 falls back to plain HTTP, as does a
    // missing openssl.
    const httpsPreferred = !process.argv.includes('--no-https') && !/^(1|true|yes)$/i.test(process.env.MINIMAX_NO_HTTPS ?? '')
    const certificate = httpsPreferred ? await ensureSelfSignedCertificate(dirname(paths.lanTokenFile), address) : null
    return new Promise<void>((resolvePromise) => {
      const handler = (request: IncomingMessage, response: ServerResponse) => void handleLanRequest(request, response)
      const server = certificate
        ? createHttpsServer({ cert: certificate.certPem, key: certificate.keyPem }, handler)
        : createHttpServer(handler)
      lanServer = server
      server.once('error', (error) => { lanStatus = { running: false, port, error: error.message, secure: false }; resolvePromise() })
      server.listen(port, '0.0.0.0', () => {
        // The realtime fabric rides the SAME server (WS upgrade at /ws; SSE
        // v2 through the /api/lan/realtime route below).
        realtimeHub.attach(server)
        const origin = `${certificate ? 'https' : 'http'}://${address}:${port}`
        lanStatus = { running: true, port, secure: Boolean(certificate), certificateFingerprint: certificate?.fingerprint, url: `${origin}/?mobile=1`, desktopUrl: `${origin}/?desktop=1` }
        logEvent({ kind: 'lan.server', port, secure: Boolean(certificate) })
        // Boot posture: AFTER the server is listening (routes can answer
        // while a slow engine boots), reconcile the managed runtime — adopt
        // a healthy recorded instance instead of double-spawning.
        void runtime.reconcileOnBoot().catch((error: unknown) => logFailure('engine/reconcile', error, undefined, 'warn'))
        resolvePromise()
      })
    })
  }

  function stopLanServer() {
    realtimeHub.close()
    // No supervised sidecar outlives the server that started it: graceful
    // quit line first, forced tree-kill for whatever ignores it. The runtime
    // marks the shutdown intentional FIRST so the exit settles 'stopped' and
    // the recorded state file is cleared (a crash, by contrast, leaves it —
    // the next boot adopts the orphan instead of double-spawning).
    runtime.prepareForShutdown()
    void EngineProcess.shutdownAll()
    lanServer?.close()
    lanServer = null
    lanStatus = { running: false }
  }

  return {
    loadSettings,
    saveSettings,
    normalizeSettings,
    defaultSettings,
    scanModels,
    readGpuTelemetry,
    comfyFetch,
    historyOutput,
    resolveOutputFile,
    resolveVideoSource,
    saveOutputImage,
    uploadFileAt,
    cancelPromptAt,
    extractVideoFrameAt,
    extractVideoFramesAt,
    trimVideoAt,
    joinVideosAt,
    localMediaResponse,
    serveLocalMediaHttp,
    handleLanRequest,
    startLanServer,
    stopLanServer,
    lanAddress,
    /** The realtime event fabric (wave 1): WS at /ws, SSE v2 at
     *  /api/lan/realtime; emitEngine is the wave-2c sidecar seam. */
    realtime: realtimeHub,
    /** Self-managed ComfyUI runtime (increment 1): start/stop/status +
     *  boot reconcile. External mode never fires its side effects. */
    runtime,
    status: () => lanStatus,
    syncCharacters: (characters: unknown[]) => { mobileCharacterLibrary = Array.isArray(characters) ? characters : []; return { synced: mobileCharacterLibrary.length } },
    rotateToken: async () => {
      lanToken = randomUUID().replace(/-/g, '')
      await saveLanToken(lanToken)
      if (lanStatus.running) {
        // Scheme follows the actual listener (HTTPS by default): an http://
        // link under TLS is dead on arrival and teaches users to paste
        // certificate warnings away.
        const scheme = lanStatus.secure ? 'https' : 'http'
        const origin = `${scheme}://${lanAddress()}:${lanStatus.port ?? 4178}`
        lanStatus = { ...lanStatus, url: `${origin}/?mobile=1&token=${lanToken}`, desktopUrl: `${origin}/?desktop=1&token=${lanToken}` }
      }
      return lanStatus
    },
  }
}
