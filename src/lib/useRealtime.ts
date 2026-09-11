/**
 * The realtime fabric client (wave 1) — a module-level singleton, not a React
 * context: ONE WebSocket to the app's own server regardless of host (the old
 * same-host-direct-to-ComfyUI path in useLivePreview is retired), with an SSE
 * fallback only after the WebSocket fails twice (proxy-hostile environments).
 *
 *   subscribe(ch, handler)  -> unsubscribe fn; handlers receive typed
 *                              envelopes `{ch, type, seq, ts, payload}`.
 *   onPreviewFrame(jobKey)  -> binary frames ONLY — they never enter React
 *                              state. The callback receives raw bytes; the
 *                              consumer paints (createImageBitmap + rAF) into
 *                              a DOM element directly (Wave-2a discipline).
 *   streamLlm(request)      -> OpenAI-compatible token streaming through the
 *                              server's llm channel (SSRF-guarded endpoints).
 *
 * Per-channel `seq` gap detection: a gap means the server dropped envelopes
 * (bounded queue overflow) — a synthetic `{type:'resync', ch}` reaches that
 * channel's handlers so consumers re-fetch authoritative state (for `job`,
 * one immediate history poll; see useGenerationQueue).
 */
import type { LlmStreamRequest, PreviewMime, RealtimeEnvelope, RealtimeJsonChannel } from '../types'
import { createId } from './createId'

const WS_BACKOFF_FLOOR_MS = 1_000
const WS_BACKOFF_CAP_MS = 15_000
const WS_FAILURES_BEFORE_SSE = 2

/** FNV-1a 32-bit — mirrors server/realtime.ts hashJobKey so both sides
 *  correlate preview frames with job keys without string bytes per frame. */
export function hashJobKey(key: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

const PREVIEW_MIME_CODES: readonly PreviewMime[] = ['image/jpeg', 'image/png', 'image/webp', 'video/mp4']

function decodePreviewFrame(frame: ArrayBuffer): { jobHash: number; mime: PreviewMime; bytes: ArrayBuffer } | null {
  if (frame.byteLength < 7) return null
  const view = new DataView(frame)
  if (view.getUint8(0) !== 0x01) return null
  const code = view.getUint8(5)
  if (code >= PREVIEW_MIME_CODES.length) return null
  return { jobHash: view.getUint32(1), mime: PREVIEW_MIME_CODES[code], bytes: frame.slice(6) }
}

export type RealtimeTransport = 'ws' | 'sse' | 'offline'
export type RealtimeStatus = { transport: RealtimeTransport; connected: boolean }

type ChannelHandler = (envelope: RealtimeEnvelope) => void
type FrameHandler = (bytes: ArrayBuffer, mime: PreviewMime) => void

const channelHandlers = new Map<string, Set<ChannelHandler>>()
const frameHandlers = new Map<number, Set<FrameHandler>>()
const statusHandlers = new Set<(status: RealtimeStatus) => void>()

let status: RealtimeStatus = { transport: 'offline', connected: false }
let started = false
let wsFailures = 0
let demotedToSse = false
let backoffMs = WS_BACKOFF_FLOOR_MS
let socket: WebSocket | null = null
let source: EventSource | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | undefined
const subscribedChannels = new Set<RealtimeJsonChannel>()
const previewInterest = new Set<number>()
const lastSeq = new Map<string, number>()
const diagnostics = { received: { job: 0, telemetry: 0, llm: 0, engine: 0, system: 0, preview: 0 }, resyncs: 0 }

function setStatus(next: RealtimeStatus) {
  status = next
  for (const handler of Array.from(statusHandlers)) {
    try { handler(next) } catch { /* consumer errors never break the fabric */ }
  }
}

function emitResync(channel: string) {
  diagnostics.resyncs += 1
  const handlers = channelHandlers.get(channel)
  if (!handlers) return
  const envelope: RealtimeEnvelope = { ch: channel as RealtimeEnvelope['ch'], type: 'resync', seq: -1, ts: Date.now(), payload: { ch: channel } }
  for (const handler of Array.from(handlers)) {
    try { handler(envelope) } catch { /* see above */ }
  }
}

function dispatch(envelope: RealtimeEnvelope) {
  const previous = lastSeq.get(envelope.ch)
  if (typeof previous === 'number' && envelope.seq > previous + 1) emitResync(envelope.ch)
  if (typeof envelope.seq === 'number' && envelope.seq > 0) lastSeq.set(envelope.ch, envelope.seq)
  const counted = diagnostics.received as Record<string, number>
  if (typeof counted[envelope.ch] === 'number') counted[envelope.ch] += 1
  const handlers = channelHandlers.get(envelope.ch)
  if (!handlers) return
  for (const handler of Array.from(handlers)) {
    try { handler(envelope) } catch { /* see above */ }
  }
}

function dispatchFrame(jobHash: number, bytes: ArrayBuffer, mime: PreviewMime) {
  diagnostics.received.preview += 1
  const handlers = frameHandlers.get(jobHash)
  if (!handlers) return
  for (const handler of Array.from(handlers)) {
    try { handler(bytes, mime) } catch { /* see above */ }
  }
}

function authToken() {
  try { return new URLSearchParams(window.location.search).get('token') ?? '' } catch { return '' }
}

function fabricUrl(path: string, extra?: URLSearchParams) {
  const secure = window.location.protocol === 'https:'
  const params = extra ?? new URLSearchParams()
  const token = authToken()
  if (token) params.set('token', token)
  const query = params.toString()
  return `${secure ? 'wss' : 'ws'}://${window.location.host}${path}${query ? `?${query}` : ''}`
}

function sseChannels(): string {
  const wanted = new Set<string>(subscribedChannels)
  if (previewInterest.size > 0) wanted.add('preview')
  if (wanted.size === 0) return 'job,telemetry,engine,system'
  return Array.from(wanted).filter((channel) => channel !== 'llm').join(',')
}

function openSse() {
  closeSocket()
  const url = `/api/lan/realtime?channels=${encodeURIComponent(sseChannels())}`
  const token = authToken()
  const addressed = token ? `${url}&token=${encodeURIComponent(token)}` : url
  source = new EventSource(addressed)
  source.onopen = () => { backoffMs = WS_BACKOFF_FLOOR_MS; setStatus({ transport: 'sse', connected: true }) }
  source.onmessage = (event: MessageEvent<string>) => {
    let envelope: RealtimeEnvelope
    try { envelope = JSON.parse(event.data) as RealtimeEnvelope } catch { return }
    if (envelope.ch === 'preview' && envelope.type === 'frame') {
      const payload = envelope.payload as { jobHash?: number; mime?: string; data?: string }
      if (typeof payload.jobHash !== 'number' || typeof payload.data !== 'string') return
      const binary = Uint8Array.from(atob(payload.data), (character) => character.charCodeAt(0))
      dispatchFrame(payload.jobHash, binary.buffer, (payload.mime as PreviewMime) ?? 'image/jpeg')
      return
    }
    dispatch(envelope)
  }
  source.onerror = () => {
    setStatus({ transport: 'sse', connected: false })
    // CLOSED means the browser gave up on reconnecting — take over with our
    // own backoff (CONNECTING is the browser's built-in retry; leave it be).
    if (source?.readyState === EventSource.CLOSED) {
      source.close()
      source = null
      scheduleReconnect()
    }
  }
}

function closeSocket() {
  if (socket) { socket.onclose = null; socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.close(); socket = null }
  if (source) { source.onopen = null; source.onmessage = null; source.onerror = null; source.close(); source = null }
}

function failPendingLlm(reason: string) {
  for (const pending of Array.from(pendingLlm.values())) pending.reject(new Error(reason))
  pendingLlm.clear()
}

function openWs() {
  closeSocket()
  try {
    socket = new WebSocket(fabricUrl('/ws'))
  } catch {
    wsFailures += 1
    maybeDemoteOrRetry()
    return
  }
  socket.binaryType = 'arraybuffer'
  socket.onopen = () => {
    wsFailures = 0
    backoffMs = WS_BACKOFF_FLOOR_MS
    lastSeq.clear()
    setStatus({ transport: 'ws', connected: true })
    for (const channel of subscribedChannels) socket?.send(JSON.stringify({ type: 'sub', ch: channel }))
    if (previewInterest.size > 0) socket?.send(JSON.stringify({ type: 'sub', ch: 'preview' }))
  }
  socket.onmessage = (event: MessageEvent) => {
    if (typeof event.data === 'string') {
      let envelope: RealtimeEnvelope
      try { envelope = JSON.parse(event.data) as RealtimeEnvelope } catch { return }
      if (envelope.ch === 'llm') { dispatchLlmEnvelope(envelope); return }
      dispatch(envelope)
      return
    }
    if (event.data instanceof ArrayBuffer) {
      const frame = decodePreviewFrame(event.data)
      if (frame) dispatchFrame(frame.jobHash, frame.bytes, frame.mime)
    }
  }
  socket.onclose = () => {
    setStatus({ transport: demotedToSse ? 'sse' : 'ws', connected: false })
    failPendingLlm('The realtime connection closed mid-stream.')
    wsFailures += 1
    maybeDemoteOrRetry()
  }
  socket.onerror = () => {
    setStatus({ transport: status.transport, connected: false })
  }
}

function maybeDemoteOrRetry() {
  if (!started) return
  if (!demotedToSse && wsFailures >= WS_FAILURES_BEFORE_SSE) demotedToSse = true
  scheduleReconnect()
}

function scheduleReconnect() {
  if (!started || reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined
    if (demotedToSse) openSse()
    else openWs()
  }, backoffMs)
  backoffMs = Math.min(WS_BACKOFF_CAP_MS, backoffMs * 2)
}

function ensureStarted() {
  if (started) return
  started = true
  openWs()
}

function resubscribeForSse() {
  // SSE subscriptions are fixed at connect time: adding a channel while on
  // the fallback transport means reconnecting with the extended list.
  if (status.transport === 'sse' && started) openSse()
}

// ---- public API -------------------------------------------------------------

/** Subscribes a handler to a JSON channel. Returns the unsubscribe function. */
export function subscribe(handlerChannel: RealtimeJsonChannel, handler: ChannelHandler): () => void {
  let handlers = channelHandlers.get(handlerChannel)
  if (!handlers) { handlers = new Set(); channelHandlers.set(handlerChannel, handlers) }
  handlers.add(handler)
  subscribedChannels.add(handlerChannel)
  ensureStarted()
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'sub', ch: handlerChannel }))
  else resubscribeForSse()
  return () => {
    const current = channelHandlers.get(handlerChannel)
    if (!current) return
    current.delete(handler)
    if (current.size === 0) {
      // The server-side subscription lives only while somebody listens: drop
      // the channel so a reconnect does not resubscribe to a dead consumer
      // (which would pin the shared upstream open with nobody watching).
      channelHandlers.delete(handlerChannel)
      subscribedChannels.delete(handlerChannel)
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'unsub', ch: handlerChannel }))
    }
  }
}

/** Registers a binary-preview-frame listener for one job key (promptId).
 *  Frames never enter React state — paint them straight into a DOM element
 *  (see the CreateView live preview) so continuous previews stay off the
 *  render path. Returns the unsubscribe function. */
export function onPreviewFrame(jobKey: string, handler: FrameHandler): () => void {
  const key = hashJobKey(jobKey)
  let handlers = frameHandlers.get(key)
  if (!handlers) { handlers = new Set(); frameHandlers.set(key, handlers) }
  handlers.add(handler)
  previewInterest.add(key)
  ensureStarted()
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'sub', ch: 'preview' }))
  else resubscribeForSse()
  return () => {
    const current = frameHandlers.get(key)
    if (!current) return
    current.delete(handler)
    if (current.size === 0) {
      frameHandlers.delete(key)
      previewInterest.delete(key)
      if (frameHandlers.size === 0 && socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'unsub', ch: 'preview' }))
    }
  }
}

/** Connection-status listener (fires immediately with the current status). */
export function onRealtimeStatus(handler: (status: RealtimeStatus) => void): () => void {
  statusHandlers.add(handler)
  ensureStarted()
  handler(status)
  return () => { statusHandlers.delete(handler) }
}

// ---- llm streaming -----------------------------------------------------------

type PendingLlm = {
  onToken: (delta: string) => void
  resolve: (value: { aborted: boolean; finishReason?: string }) => void
  reject: (error: Error) => void
}
const pendingLlm = new Map<string, PendingLlm>()

function dispatchLlmEnvelope(envelope: RealtimeEnvelope) {
  const payload = envelope.payload as { reqId?: string; delta?: string; error?: string; aborted?: boolean; finishReason?: string }
  if (typeof payload.reqId !== 'string') return
  const pending = pendingLlm.get(payload.reqId)
  if (!pending) return
  diagnostics.received.llm += 1
  if (envelope.type === 'token' && typeof payload.delta === 'string') pending.onToken(payload.delta)
  else if (envelope.type === 'done') {
    pendingLlm.delete(payload.reqId)
    pending.resolve({ aborted: Boolean(payload.aborted), finishReason: payload.finishReason })
  } else if (envelope.type === 'error') {
    pendingLlm.delete(payload.reqId)
    pending.reject(new Error(typeof payload.error === 'string' ? payload.error : 'The LLM stream failed.'))
  }
}

export type LlmStreamHandle = { promise: Promise<{ aborted: boolean; finishReason?: string }>; abort(): void }

/** Streams an OpenAI-compatible chat completion through the server's llm
 *  channel. The endpoint must pass the server's local-service (SSRF) guard.
 *  Requires the WebSocket transport — SSE (the fallback) has no uplink. */
export function streamLlm(request: LlmStreamRequest, onToken: (delta: string) => void): LlmStreamHandle {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    const handle: LlmStreamHandle = { promise: Promise.reject(new Error('The realtime connection is not available for LLM streaming.')), abort: () => undefined }
    handle.promise.catch(() => undefined)
    return handle
  }
  const reqId = createId()
  let settle: (value: { aborted: boolean; finishReason?: string }) => void = () => undefined
  let reject: (error: Error) => void = () => undefined
  const promise = new Promise<{ aborted: boolean; finishReason?: string }>((resolve, reject2) => {
    settle = resolve
    reject = reject2
  })
  pendingLlm.set(reqId, { onToken, resolve: settle, reject })
  socket.send(JSON.stringify({ ch: 'llm', type: 'generate', reqId, payload: request }))
  return {
    promise,
    abort: () => { if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ch: 'llm', type: 'abort', reqId })) },
  }
}

/** Diagnostics for tests and the doctor view; never used for control flow. */
export function realtimeDiagnostics(): RealtimeStatus & { received: Record<string, number>; resyncs: number } {
  return { ...status, received: { ...diagnostics.received }, resyncs: diagnostics.resyncs }
}

if (typeof window !== 'undefined') {
  // E2E + doctor observability: proves the fabric connected and channels are
  // flowing without reaching into module internals.
  Object.defineProperty(window, '__minimaxRealtime', { configurable: true, get: () => realtimeDiagnostics() })
}
