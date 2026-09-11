/**
 * The realtime event fabric (wave 1) — the product's nervous system.
 *
 *   transport   ONE WebSocket per client at /ws (token via ?token=, checked
 *               through the same constant-time gate the HTTP routes use),
 *               SSE v2 fallback carrying the JSON channels only (previews
 *               degrade to base64 there — SSE is the fallback, not the
 *               primary).
 *   channels    job | telemetry | llm | engine | system (JSON, typed envelope
 *               `{ch, type, seq, ts, payload}` with per-channel monotonic seq
 *               per connection) + preview (binary frames, compact header, no
 *               base64 on the WS path).
 *   fan-in      ONE upstream ComfyUI WebSocket shared across every client:
 *               lazy-connect on the first job/preview subscriber, linger then
 *               disconnect on the last unsubscribe, reconnect with backoff.
 *               Events are normalized once and fanned out.
 *  backpressure per-client send accounting via bufferedAmount: JSON channels
 *               queue (bounded, oldest-dropped, with a system.overflow notice
 *               once the queue drains); preview frames are drop-oldest always
 *               — a stale preview frame is worthless, only the newest pending
 *               frame per job is ever sent.
 *
 * Everything pure (normalizer, framing, hashing, the outbox) is exported for
 * unit tests. Nothing in this file may import from 'electron'.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import WebSocket, { WebSocketServer } from 'ws'
import type { GpuTelemetry, JobLifecycleEvent, LlmStreamRequest, PreviewMime, RealtimeChannel, RealtimeEnvelope } from '../src/types'
import { logEvent, logFailure } from './logger'

export const REALTIME_WS_PATH = '/ws'

/** Binary-preview mime codes: the index into this tuple is the wire byte. */
export const PREVIEW_MIME_CODES: readonly PreviewMime[] = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4']

export function previewMimeCode(mime: string): number {
  return PREVIEW_MIME_CODES.indexOf(mime as PreviewMime)
}

/** FNV-1a 32-bit of a job key (promptId). The 4-byte hash in the preview
 *  frame header correlates frames with jobs without paying string bytes per
 *  frame; the client computes the same hash (src/lib/useRealtime.ts). */
export function hashJobKey(key: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Wire format of a preview frame: [0x01][4-byte job-key hash, 0 = unknown]
 *  [mime-code byte][payload bytes]. 6-byte header, no base64 anywhere. */
export function encodePreviewFrame(jobHash: number, mime: string, payload: Buffer): Buffer | null {
  const code = previewMimeCode(mime)
  if (code < 0) return null
  const header = Buffer.alloc(6)
  header[0] = 0x01
  header.writeUInt32BE(jobHash >>> 0, 1)
  header[5] = code
  return Buffer.concat([header, payload])
}

export function decodePreviewFrame(frame: Buffer): { jobHash: number; mime: PreviewMime; payload: Buffer } | null {
  if (frame.length < 7 || frame[0] !== 0x01) return null
  const code = frame[5]
  if (code >= PREVIEW_MIME_CODES.length) return null
  return { jobHash: frame.readUInt32BE(1), mime: PREVIEW_MIME_CODES[code], payload: frame.subarray(6) }
}

/** Parses an upstream ComfyUI binary message into a preview payload. ComfyUI
 *  has shipped two framings; both are handled:
 *    modern — [u32 version=1][u32 type (1=jpeg preview, 2=png)] then the
 *             image at offset 8, EXCEPT animated preview frames which carry a
 *             24-byte animation block and start at offset 32 (matches the
 *             browser-side parser the direct-WS path used);
 *    legacy — 8-byte event name + 16-byte mime (null-padded) + payload —
 *             exactly what the legacy SSE bridge parsed.
 *  Returns null for anything that is not a recognizable preview. */
export function parseUpstreamBinary(buffer: Buffer): { event: string; mime: string; payload: Buffer } | null {
  if (buffer.length < 9) return null
  if (buffer.readUInt32BE(0) === 1) {
    const kind = buffer.readUInt32BE(4)
    if (kind === 1 || kind === 2) {
      const animated = buffer.length > 32 && kind === 1 && buffer.readUInt32BE(8) === 1 && buffer.readUInt16BE(32) === 0xffd8
      if (animated) return { event: 'preview', mime: 'image/jpeg', payload: buffer.subarray(32) }
      return { event: 'preview', mime: kind === 2 ? 'image/png' : 'image/jpeg', payload: buffer.subarray(8) }
    }
    return null
  }
  const event = buffer.subarray(0, 8).toString('utf8').replace(/\0.*$/, '')
  const mime = buffer.subarray(8, 24).toString('utf8').replace(/\0.*$/, '')
  if (!event) return null
  return { event, mime: mime || 'image/jpeg', payload: buffer.subarray(24) }
}

export type NormalizedUpstream = {
  events: JobLifecycleEvent[]
  /** Set when the event was an H3 preview override: the image arrives base64
   *  inside a JSON event; the hub decodes it ONCE here and forwards it as a
   *  binary frame — the base64 never crosses the client wire on the WS path. */
  previewFrame: { promptId: string; mime: string; base64: string } | null
}

/** Pure normalizer: one parsed ComfyUI WS JSON message -> typed job-channel
 *  events (+ an optional preview descriptor). `activePromptId` is the prompt
 *  the shared upstream currently sees executing — ComfyUI omits prompt_id on
 *  `progress` (and some terminal events), and normalizing the correlation
 *  ONCE server-side is what lets every client match by promptId. Unknown
 *  event types normalize to nothing: the legacy SSE bridge still carries
 *  them verbatim for old clients; the fabric is typed by design. */
export function normalizeComfyEvent(message: unknown, activePromptId = ''): NormalizedUpstream {
  if (!message || typeof message !== 'object') return { events: [], previewFrame: null }
  const raw = message as { type?: unknown; data?: Record<string, unknown> }
  const data = (raw.data && typeof raw.data === 'object' ? raw.data : {}) as Record<string, unknown>
  const type = typeof raw.type === 'string' ? raw.type : ''
  const promptId = typeof data.prompt_id === 'string' && data.prompt_id ? data.prompt_id : activePromptId
  const startedId = typeof data.prompt_id === 'string' && data.prompt_id ? data.prompt_id : ''
  switch (type) {
    case 'execution_start':
      if (!startedId) return { events: [], previewFrame: null }
      return { events: [{ type: 'execution_start', promptId: startedId }], previewFrame: null }
    case 'executing':
      return { events: [{ type: 'executing', promptId, node: typeof data.node === 'string' ? data.node : null }], previewFrame: null }
    case 'progress': {
      const value = Number(data.value)
      const max = Number(data.max)
      if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return { events: [], previewFrame: null }
      return { events: [{ type: 'progress', promptId, value: Math.max(0, value), max }], previewFrame: null }
    }
    case 'executed': {
      const output = (data.output && typeof data.output === 'object' ? data.output : {}) as { images?: unknown }
      const images = Array.isArray(output.images)
        ? output.images.slice(0, 12).flatMap((item) => {
            if (!item || typeof item !== 'object' || typeof (item as { filename?: unknown }).filename !== 'string') return []
            const file = item as { filename: string; subfolder?: unknown; type?: unknown }
            return [{ filename: file.filename, subfolder: typeof file.subfolder === 'string' ? file.subfolder : undefined, type: typeof file.type === 'string' ? file.type : undefined }]
          })
        : []
      return { events: [{ type: 'executed', promptId, node: typeof data.node === 'string' ? data.node : '', images }], previewFrame: null }
    }
    case 'execution_cached': {
      const nodes = Array.isArray(data.nodes) ? data.nodes.filter((item): item is string => typeof item === 'string').slice(0, 64) : []
      return { events: [{ type: 'execution_cached', promptId, nodes }], previewFrame: null }
    }
    case 'execution_error':
      return {
        events: [
          { type: 'execution_error', promptId, nodeType: typeof data.node_type === 'string' ? data.node_type : undefined, errorMessage: typeof data.exception_message === 'string' ? data.exception_message.slice(0, 400) : undefined },
          { type: 'job_done', promptId, outcome: 'error' as const },
        ],
        previewFrame: null,
      }
    case 'execution_success':
      return { events: [{ type: 'execution_success', promptId }, { type: 'job_done', promptId, outcome: 'success' as const }], previewFrame: null }
    case 'interrupted':
    case 'execution_interrupted':
      return { events: [{ type: 'interrupted', promptId }, { type: 'job_done', promptId, outcome: 'interrupted' as const }], previewFrame: null }
    case 'status': {
      const status = data.status && typeof data.status === 'object' ? (data.status as { exec_info?: { queue_remaining?: unknown } }) : undefined
      const queueRemaining = Number(status?.exec_info?.queue_remaining)
      return { events: [{ type: 'queue_status', promptId, queueRemaining: Number.isFinite(queueRemaining) ? queueRemaining : undefined }], previewFrame: null }
    }
    case 'minimax_h3_preview_override': {
      const image = typeof data.image === 'string' ? data.image : ''
      const mime = typeof data.mime === 'string' ? data.mime : 'image/jpeg'
      const fps = Number(data.fps)
      const step = Number(data.step)
      const total = Number(data.total)
      const events: JobLifecycleEvent[] = [{
        type: 'preview_meta',
        promptId,
        mime,
        fps: Number.isFinite(fps) ? fps : undefined,
        step: Number.isFinite(step) ? step : undefined,
        totalSteps: Number.isFinite(total) ? total : undefined,
      }]
      if (!image || !promptId || !/^(?:image\/(?:jpeg|png|webp)|video\/mp4)$/.test(mime)) return { events, previewFrame: null }
      return { events, previewFrame: { promptId, mime, base64: image } }
    }
    default:
      return { events: [], previewFrame: null }
  }
}

/** Bounded, backpressure-aware outbound queue for one client. Pure (testable):
 *  the sink is anything with send() + bufferedAmount — a ws socket or an SSE
 *  response wrapper. Policies:
 *    JSON    — while congested (bufferedAmount above the high-water mark)
 *              envelopes queue FIFO up to jsonLimit; beyond that the OLDEST
 *              drop and the drop count accumulates until the hub drains the
 *              queue and informs the client via a system.overflow notice.
 *    preview — ALWAYS newest-wins per job hash: a congested or slow client
 *              keeps at most one pending frame per job, replaced by every
 *              newer frame for that job (a stale preview frame is worthless).
 *  Envelope seq numbers are assigned by the hub at ENQUEUE time, so dropped
 *  envelopes surface as client-visible sequence gaps -> resync. */
export type OutboxSink = { send(data: string | Buffer): void; readonly bufferedAmount: number }

export class ClientOutbox {
  private jsonQueue: string[] = []
  private jsonDropped = 0
  private pendingPreviews = new Map<number, Buffer>()
  private pumping = false
  private readonly jsonLimit: number
  private readonly highWaterBytes: number

  constructor(private sink: OutboxSink, options?: { jsonLimit?: number; highWaterBytes?: number }) {
    this.jsonLimit = options?.jsonLimit ?? 64
    this.highWaterBytes = options?.highWaterBytes ?? 1_048_576
  }

  queueJson(serialized: string): void {
    this.jsonQueue.push(serialized)
    if (this.jsonQueue.length > this.jsonLimit) { this.jsonQueue.shift(); this.jsonDropped += 1 }
  }

  queuePreview(jobHash: number, frame: Buffer): void {
    this.pendingPreviews.set(jobHash, frame)
  }

  /** Drop count accumulated during congestion, for the hub's overflow notice. */
  consumeDropped(): number {
    const dropped = this.jsonDropped
    this.jsonDropped = 0
    return dropped
  }

  get pending(): number {
    return this.jsonQueue.length + this.pendingPreviews.size
  }

  /** True when the sink is too full to absorb more right now. */
  get congested(): boolean {
    return this.sink.bufferedAmount > this.highWaterBytes
  }

  /** Flushes what the sink can absorb: queued JSON first, then the newest
   *  preview per job. Safe to call any time; a no-op when nothing is pending. */
  pump(): boolean {
    if (this.pumping) return false
    this.pumping = true
    let sent = false
    try {
      while (!this.congested) {
        if (this.jsonQueue.length > 0) {
          this.sink.send(this.jsonQueue.shift()!)
          sent = true
          continue
        }
        if (this.pendingPreviews.size > 0) {
          const jobHash = this.pendingPreviews.keys().next().value as number
          this.sink.send(this.pendingPreviews.get(jobHash)!)
          this.pendingPreviews.delete(jobHash)
          sent = true
          continue
        }
        break
      }
    } finally {
      this.pumping = false
    }
    return sent
  }
}

type SubscribableChannel = 'job' | 'telemetry' | 'preview' | 'engine' | 'system'
const SUBSCRIBABLE: readonly SubscribableChannel[] = ['job', 'telemetry', 'preview', 'engine', 'system']

type ClientLlmStream = { controller: AbortController; inactivity: ReturnType<typeof setTimeout> }

type RealtimeClient = {
  id: string
  kind: 'ws' | 'sse'
  outbox: ClientOutbox
  subs: Set<SubscribableChannel>
  seq: Map<RealtimeChannel, number>
  close: () => void
  isAlive: boolean
  ping?: () => void
  llmStreams: Map<string, ClientLlmStream>
}

export type RealtimeHubOptions = {
  /** Token gate: `presented` is the ?token= value (WS) or the header/query
   *  value (SSE). Constant-time comparison lives in the caller. */
  authorize(presented: string | undefined): boolean
  /** The configured ComfyUI origin, re-resolved on every upstream connect so
   *  runtime settings changes are honored without a server restart. */
  comfyUrl(): Promise<string>
  /** Lazy GPU sampler (wave 0a): shared 4s-TTL cache + in-flight coalescing. */
  readTelemetry(): Promise<GpuTelemetry>
  /** SSRF guard for user-supplied LLM endpoints (local routers only). */
  isLocalServiceUrl(candidate: string): boolean
}

export type RealtimeHub = ReturnType<typeof createRealtimeHub>

const UPSTREAM_LINGER_MS = 10_000
const UPSTREAM_BACKOFF_CAP_MS = 15_000
const WS_PING_INTERVAL_MS = 30_000
const DRAIN_TICK_MS = 150
const TELEMETRY_INTERVAL_MS = 4_000
const SSE_HEARTBEAT_MS = 15_000
const LLM_INACTIVITY_MS = 120_000
const LLM_MAX_CONCURRENT_PER_CLIENT = 4

export function createRealtimeHub(options: RealtimeHubOptions) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_048_576 })
  const clients = new Set<RealtimeClient>()

  // ---- upstream ComfyUI link (ONE shared across every client) -------------
  const upstream = {
    socket: null as WebSocket | null,
    wanted: false,
    linger: null as ReturnType<typeof setTimeout> | null,
    retry: null as ReturnType<typeof setTimeout> | null,
    attempt: 0,
    activePromptId: '',
  }

  function connectUpstream() {
    if (upstream.socket || upstream.retry || !upstream.wanted) return
    void options.comfyUrl().then((comfyUrl) => {
      if (upstream.socket || upstream.retry || !upstream.wanted || !comfyUrl) return
      const host = comfyUrl.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '')
      if (!host) return
      const socket = new WebSocket(`ws://${host}/ws`)
      socket.binaryType = 'nodebuffer'
      upstream.socket = socket
      socket.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
        if (isBinary || looksBinary(buffer)) handleUpstreamBinary(buffer)
        else handleUpstreamText(buffer.toString('utf8'))
      })
      socket.on('error', (error: Error) => {
        logFailure('realtime/upstream', error, undefined, 'debug')
        socket.close()
      })
      // A ComfyUI restart must not freeze every connected client: reconnect
      // with backoff while interest remains (the legacy SSE bridge reconnected
      // too, on a fixed cadence; the cap bounds the retry storm the perf
      // audit flagged).
      socket.on('close', () => {
        if (upstream.socket === socket) {
          upstream.socket = null
          upstream.activePromptId = ''
        }
        if (upstream.wanted) {
          const delay = Math.min(UPSTREAM_BACKOFF_CAP_MS, 1000 * 2 ** upstream.attempt)
          upstream.attempt += 1
          upstream.retry = setTimeout(() => { upstream.retry = null; connectUpstream() }, delay)
        }
      })
    }).catch((error: unknown) => {
      logFailure('realtime/upstream-resolve', error, undefined, 'debug')
      if (upstream.wanted) {
        upstream.retry = setTimeout(() => { upstream.retry = null; connectUpstream() }, 3000)
      }
    })
  }

  function looksBinary(buffer: Buffer) {
    // Text frames are JSON (printable first byte); preview frames never are.
    const first = buffer[0]
    return first !== undefined && (first < 0x20 || first > 0x7e) && first !== 0x09
  }

  function handleUpstreamText(text: string) {
    let message: unknown
    try { message = JSON.parse(text) } catch { return }
    const normalized = normalizeComfyEvent(message, upstream.activePromptId)
    for (const event of normalized.events) {
      if (event.type === 'execution_start') upstream.activePromptId = event.promptId
      else if (event.type === 'executing' && event.node) upstream.activePromptId = event.promptId
      pushChannel('job', event.type, event)
    }
    const frame = normalized.previewFrame
    if (frame) pushPreviewFrame(hashJobKey(frame.promptId), frame.mime, Buffer.from(frame.base64, 'base64'))
  }

  function handleUpstreamBinary(buffer: Buffer) {
    const parsed = parseUpstreamBinary(buffer)
    if (!parsed || parsed.payload.length === 0) return
    // Binary preview frames carry no prompt id — they belong to the prompt the
    // shared upstream currently sees executing (correlated once, server-side).
    pushPreviewFrame(upstream.activePromptId ? hashJobKey(upstream.activePromptId) : 0, parsed.mime, parsed.payload)
  }

  function refreshUpstreamInterest() {
    let wanted = false
    for (const client of clients) {
      if (client.subs.has('job') || client.subs.has('preview')) { wanted = true; break }
    }
    upstream.wanted = wanted
    if (wanted) {
      if (upstream.linger) { clearTimeout(upstream.linger); upstream.linger = null }
      connectUpstream()
    } else if (upstream.socket && !upstream.linger) {
      // Linger so a client that flaps (StrictMode double-mount, a quick view
      // switch) does not tear the shared upstream down and back up.
      upstream.linger = setTimeout(() => {
        upstream.linger = null
        upstream.socket?.close()
      }, UPSTREAM_LINGER_MS)
    }
  }

  // ---- outbound fan-out ----------------------------------------------------
  function envelopeFor(client: RealtimeClient, ch: RealtimeChannel, type: string, payload: unknown): RealtimeEnvelope {
    const seq = (client.seq.get(ch) ?? 0) + 1
    client.seq.set(ch, seq)
    return { ch, type, seq, ts: Date.now(), payload }
  }

  function deliver(client: RealtimeClient, ch: RealtimeChannel, type: string, payload: unknown) {
    client.outbox.queueJson(JSON.stringify(envelopeFor(client, ch, type, payload)))
    settleOverflow(client)
    client.outbox.pump()
  }

  /** Queues the drop notice once a congested episode drains (never while
   *  still congested — the notice would drop too). */
  function settleOverflow(client: RealtimeClient) {
    if (client.outbox.pending > 0 || client.outbox.congested) return
    const dropped = client.outbox.consumeDropped()
    if (dropped > 0) client.outbox.queueJson(JSON.stringify(envelopeFor(client, 'system', 'overflow', { dropped })))
  }

  function pushChannel(ch: SubscribableChannel, type: string, payload: unknown) {
    for (const client of clients) {
      if (client.subs.has(ch)) deliver(client, ch, type, payload)
    }
  }

  function pushPreviewFrame(jobHash: number, mime: string, bytes: Buffer) {
    const frame = encodePreviewFrame(jobHash, mime, bytes)
    if (!frame) return
    for (const client of clients) {
      if (!client.subs.has('preview')) continue
      if (client.kind === 'ws') {
        client.outbox.queuePreview(jobHash, frame)
        client.outbox.pump()
      } else {
        // SSE fallback: previews degrade to base64 (SSE has no binary frames).
        deliver(client, 'preview', 'frame', { jobHash, mime, data: bytes.toString('base64') })
      }
    }
  }

  // ---- telemetry pub/sub over the wave-0a lazy sampler ---------------------
  let telemetryTimer: ReturnType<typeof setInterval> | null = null

  function telemetryTick() {
    void options.readTelemetry().then((sample) => {
      pushChannel('telemetry', 'sample', { ...sample, at: Date.now() })
    }).catch((error: unknown) => logFailure('realtime/telemetry', error, undefined, 'debug'))
  }

  function refreshTelemetryInterest() {
    let wanted = false
    for (const client of clients) {
      if (client.subs.has('telemetry')) { wanted = true; break }
    }
    if (wanted && !telemetryTimer) {
      telemetryTimer = setInterval(telemetryTick, TELEMETRY_INTERVAL_MS)
      telemetryTick()
    } else if (!wanted && telemetryTimer) {
      // No free-running sampler with nobody watching.
      clearInterval(telemetryTimer)
      telemetryTimer = null
    }
  }

  // ---- client lifecycle ----------------------------------------------------
  function registerClient(client: RealtimeClient) {
    clients.add(client)
    deliver(client, 'system', 'hello', { transport: client.kind, channels: SUBSCRIBABLE, serverTime: Date.now() })
  }

  function unregisterClient(client: RealtimeClient) {
    if (!clients.has(client)) return
    clients.delete(client)
    for (const stream of client.llmStreams.values()) stream.controller.abort(new Error('client disconnected'))
    client.llmStreams.clear()
    refreshUpstreamInterest()
    refreshTelemetryInterest()
  }

  function applySubscription(client: RealtimeClient, message: { type?: unknown; ch?: unknown }) {
    if (typeof message.ch !== 'string') return
    const channel = message.ch as SubscribableChannel
    if (!SUBSCRIBABLE.includes(channel)) return
    if (message.type === 'sub') client.subs.add(channel)
    else if (message.type === 'unsub') client.subs.delete(channel)
    else return
    deliver(client, 'system', 'ack', { ch: channel, subscribed: client.subs.has(channel) })
    refreshUpstreamInterest()
    refreshTelemetryInterest()
  }

  // ---- llm channel: OpenAI-compatible streaming through the fabric --------
  function parseLlmRequest(message: Record<string, unknown>): { request: LlmStreamRequest } | { error: string } {
    const payload = (message.payload && typeof message.payload === 'object' ? message.payload : null) as Record<string, unknown> | null
    if (!payload) return { error: 'An LLM request payload is required.' }
    if (typeof payload.endpoint !== 'string' || !payload.endpoint) return { error: 'An endpoint is required.' }
    if (!options.isLocalServiceUrl(payload.endpoint)) return { error: 'Only local service addresses can stream LLM completions.' }
    if (typeof payload.model !== 'string' || !payload.model || payload.model.length > 200) return { error: 'A model name is required.' }
    if (!Array.isArray(payload.messages) || payload.messages.length === 0 || payload.messages.length > 64) return { error: 'Between 1 and 64 messages are required.' }
    const messages: Array<{ role: string; content: string }> = []
    for (const raw of payload.messages) {
      if (!raw || typeof raw !== 'object') return { error: 'Each message needs a role and content.' }
      const entry = raw as { role?: unknown; content?: unknown }
      if (typeof entry.role !== 'string' || !entry.role || entry.role.length > 24 || typeof entry.content !== 'string' || entry.content.length > 100_000) {
        return { error: 'Each message needs a role and string content.' }
      }
      messages.push({ role: entry.role, content: entry.content })
    }
    const request: LlmStreamRequest = { endpoint: payload.endpoint.replace(/\/+$/, ''), model: payload.model, messages }
    if (payload.options !== undefined) {
      if (!payload.options || typeof payload.options !== 'object' || Array.isArray(payload.options)) return { error: 'Options must be an object.' }
      request.options = payload.options as Record<string, unknown>
    }
    if (JSON.stringify(request).length > 512_000) return { error: 'The LLM request is too large.' }
    return { request }
  }

  function handleLlmMessage(client: RealtimeClient, message: Record<string, unknown>) {
    const reqId = typeof message.reqId === 'string' ? message.reqId : ''
    if (!reqId || reqId.length > 80) return
    const existing = client.llmStreams.get(reqId)
    if (message.type === 'abort') {
      if (existing) existing.controller.abort(new Error('client abort'))
      else deliver(client, 'llm', 'done', { reqId, aborted: true })
      return
    }
    if (message.type !== 'generate') return
    const parsed = parseLlmRequest(message)
    if ('error' in parsed) {
      deliver(client, 'llm', 'error', { reqId, error: parsed.error })
      return
    }
    if (existing) existing.controller.abort(new Error('superseded request'))
    if (client.llmStreams.size >= LLM_MAX_CONCURRENT_PER_CLIENT) {
      deliver(client, 'llm', 'error', { reqId, error: `At most ${LLM_MAX_CONCURRENT_PER_CLIENT} concurrent LLM streams are allowed.` })
      return
    }
    const controller = new AbortController()
    const stream: ClientLlmStream = { controller, inactivity: setTimeout(() => controller.abort(new Error('upstream stalled')), LLM_INACTIVITY_MS) }
    client.llmStreams.set(reqId, stream)
    void runLlmStream(client, reqId, parsed.request, stream)
  }

  async function runLlmStream(client: RealtimeClient, reqId: string, request: LlmStreamRequest, stream: ClientLlmStream) {
    // A superseded or aborted stream finishes silently: its reqId may already
    // belong to a newer request, and a late done/error must not collide.
    const finish = (type: 'done' | 'error', payload: Record<string, unknown>) => {
      clearTimeout(stream.inactivity)
      if (client.llmStreams.get(reqId) !== stream) return
      client.llmStreams.delete(reqId)
      if (clients.has(client)) deliver(client, 'llm', type, { reqId, ...payload })
    }
    const bumpInactivity = () => {
      clearTimeout(stream.inactivity)
      stream.inactivity = setTimeout(() => stream.controller.abort(new Error('upstream stalled')), LLM_INACTIVITY_MS)
    }
    try {
      const body = { ...request.options, model: request.model, messages: request.messages, stream: true }
      const response = await fetch(`${request.endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: stream.controller.signal,
      })
      if (!response.ok || !response.body) {
        const detail = response.body ? (await response.text().catch(() => '')).slice(0, 400) : ''
        finish('error', { error: detail || `The LLM endpoint returned ${response.status}.` })
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let finishReason: string | undefined
      let sawDone = false
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bumpInactivity()
        buffer += decoder.decode(chunk.value, { stream: true })
        let newlineIndex: number
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newlineIndex).replace(/\r$/, '')
          buffer = buffer.slice(newlineIndex + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') { sawDone = true; continue }
          let parsed: { choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }> }
          try { parsed = JSON.parse(data) } catch { continue }
          const choice = parsed.choices?.[0]
          if (typeof choice?.finish_reason === 'string' && choice.finish_reason) finishReason = choice.finish_reason
          const delta = choice?.delta?.content
          if (typeof delta === 'string' && delta) deliver(client, 'llm', 'token', { reqId, delta })
        }
      }
      const aborted = stream.controller.signal.aborted
      if (!aborted && !sawDone && !finishReason) {
        finish('error', { error: 'The LLM endpoint closed the stream without completing.' })
        return
      }
      finish('done', { aborted, finishReason })
    } catch (error) {
      if (stream.controller.signal.aborted) {
        finish('done', { aborted: true })
        return
      }
      logFailure('realtime/llm', error, undefined, 'debug')
      finish('error', { error: error instanceof Error && error.message ? error.message.slice(0, 300) : 'The LLM stream failed.' })
    }
  }

  // ---- transports ----------------------------------------------------------
  function attachWebSocket(server: Server) {
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', 'http://minimax.local')
      if (url.pathname !== REALTIME_WS_PATH) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      // The token gate mirrors the HTTP routes: for WS the token arrives as a
      // ?token= query param (browsers cannot set headers on WebSocket). An
      // unauthorized upgrade is refused before the handshake completes.
      if (!options.authorize(url.searchParams.get('token') ?? undefined)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(request, socket, head, (upgraded) => {
        const ws = upgraded as WebSocket
        const sink: OutboxSink = {
          send: (data) => { if (ws.readyState === WebSocket.OPEN) ws.send(data) },
          get bufferedAmount() { return ws.bufferedAmount },
        }
        const client: RealtimeClient = {
          id: randomUUID(),
          kind: 'ws',
          outbox: new ClientOutbox(sink),
          subs: new Set(),
          seq: new Map(),
          isAlive: true,
          llmStreams: new Map(),
          close: () => { try { ws.terminate() } catch { /* already gone */ } },
          ping: () => { client.isAlive = false; try { ws.ping() } catch { /* closing */ } },
        }
        ws.on('pong', () => { client.isAlive = true })
        ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
          if (isBinary) return
          const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
          let message: Record<string, unknown>
          try { message = JSON.parse(text) as Record<string, unknown> } catch { return }
          if (message.ch === 'llm') { handleLlmMessage(client, message); return }
          applySubscription(client, message)
        })
        ws.on('close', () => unregisterClient(client))
        ws.on('error', () => unregisterClient(client))
        registerClient(client)
      })
    })
  }

  /** SSE v2 fallback: JSON channels only; `channels` is a comma list fixed at
   *  connect (EventSource cannot send subscriptions) and previews, when
   *  requested, degrade to base64. The same outbox governs backpressure. */
  function handleSse(request: IncomingMessage, response: ServerResponse, search: URLSearchParams) {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    const heartbeat = setInterval(() => { response.write(': keepalive\n\n') }, SSE_HEARTBEAT_MS)
    let congested = false
    const sink: OutboxSink = {
      // SSE wire format: every event is a `data: <json>\n\n` block — an
      // EventSource (or raw reader) only dispatches framed events.
      send: (data) => { if (!response.writableEnded) congested = response.write(`data: ${String(data)}\n\n`) === false || congested },
      get bufferedAmount() { return response.destroyed ? Number.MAX_SAFE_INTEGER : congested ? 1_048_577 : 0 },
    }
    response.on('drain', () => { congested = false })
    const requested = (search.get('channels') ?? 'job,telemetry,engine,system').split(',')
    const subs = new Set<SubscribableChannel>()
    for (const raw of requested) {
      const channel = raw.trim() as SubscribableChannel
      if (SUBSCRIBABLE.includes(channel)) subs.add(channel)
    }
    const client: RealtimeClient = {
      id: randomUUID(),
      kind: 'sse',
      outbox: new ClientOutbox(sink),
      subs,
      seq: new Map(),
      isAlive: true,
      llmStreams: new Map(),
      close: () => { clearInterval(heartbeat); response.destroy() },
    }
    registerClient(client)
    refreshUpstreamInterest()
    refreshTelemetryInterest()
    request.on('close', () => {
      clearInterval(heartbeat)
      unregisterClient(client)
    })
  }

  let drainTicker: ReturnType<typeof setInterval> | null = null
  let pingTimer: ReturnType<typeof setInterval> | null = null

  return {
    attach(server: Server) {
      if (drainTicker || pingTimer) this.close()
      attachWebSocket(server)
      logEvent({ kind: 'realtime.hub', wsPath: REALTIME_WS_PATH })
      drainTicker = setInterval(() => {
        for (const client of clients) {
          settleOverflow(client)
          if (client.outbox.pending > 0) client.outbox.pump()
        }
      }, DRAIN_TICK_MS)
      pingTimer = setInterval(() => {
        for (const client of clients) {
          if (client.kind !== 'ws' || !client.ping) continue
          if (!client.isAlive) { client.close(); unregisterClient(client); continue }
          client.ping()
        }
      }, WS_PING_INTERVAL_MS)
    },
    /** SSE v2 endpoint handler (the HTTP route performs auth before this). */
    handleSse,
    /** Settings changed (e.g. a new ComfyUI address): drop the shared
     *  upstream so the next connect resolves the fresh URL. Subscribers
     *  remain, so the close handler reconnects immediately with backoff. */
    invalidateUpstream() {
      if (upstream.linger) { clearTimeout(upstream.linger); upstream.linger = null }
      upstream.socket?.close()
    },
    /** Reserved engine channel emitter (wave 2c managed runtime): the payload
     *  shape is frozen now, the sidecar wiring lands with it. */
    emitEngine(phase: string, detail?: string, pid?: number) {
      pushChannel('engine', 'lifecycle', { phase, detail, pid, at: Date.now() })
    },
    close() {
      if (drainTicker) clearInterval(drainTicker)
      if (pingTimer) clearInterval(pingTimer)
      if (telemetryTimer) clearInterval(telemetryTimer)
      drainTicker = null
      pingTimer = null
      telemetryTimer = null
      if (upstream.linger) clearTimeout(upstream.linger)
      if (upstream.retry) clearTimeout(upstream.retry)
      upstream.linger = null
      upstream.retry = null
      upstream.wanted = false
      upstream.socket?.close()
      upstream.socket = null
      for (const client of clients) client.close()
      clients.clear()
      wss.close()
    },
    status() {
      return { clients: clients.size, upstream: upstream.socket ? 'connected' : upstream.wanted ? 'connecting' : 'idle', telemetry: telemetryTimer ? 'running' : 'idle' }
    },
  }
}
