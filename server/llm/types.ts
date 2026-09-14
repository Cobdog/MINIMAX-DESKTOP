/**
 * The provider seam: one interface over the two local serving stacks —
 * the llama.cpp server in ROUTER MODE (primary; one endpoint, many models,
 * auto-load by the request's model field) and legacy Ollama (fallback when
 * no router URL is configured). Selection lives in server/llm/index.ts.
 */
import type { FamilyManifest } from './registry'

export type LlmContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

export type LlmMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string | LlmContentPart[]
  /** DeepSeek passback: reasoning from a previous thinking-mode turn, sent
   *  back on assistant history messages (required on tool turns in thinking
   *  mode; ignored elsewhere). */
  reasoning_content?: string
}

export type LlmChatRequest = {
  model: string
  messages: LlmMessage[]
  /** Family behavior (sampling defaults, thinking representation). */
  manifest: FamilyManifest
  /** Thinking toggle; per-task (structured tasks default OFF for speed). */
  thinking: boolean
  effort?: string
  maxTokens?: number
  /** Legacy Ollama structured output schema (format field). */
  format?: Record<string, unknown>
  signal?: AbortSignal
}

export type LlmChatResult = {
  content: string
  reasoning?: string
  finishReason?: string
}

export type LlmModelInfo = {
  id: string
  /** Router status value ('loaded' | 'unloaded' | …); empty when unknown. */
  status: string
  family: string
  vision: boolean
}

export type LlmStreamHandlers = {
  onToken(delta: string): void
  onReasoning?(delta: string): void
}

export type LlmCapabilities = { streaming: boolean; unload: boolean; vision: boolean }

export type UnloadResult = { unloaded: string[]; skipped: string[] }

export interface LlmProvider {
  readonly kind: 'router' | 'ollama'
  readonly endpoint: string
  listModels(): Promise<LlmModelInfo[]>
  chat(request: LlmChatRequest): Promise<LlmChatResult>
  /** Streams through the shared OpenAI SSE parser. Providers without native
   *  streaming (Ollama legacy) execute the full request and deliver it as one
   *  token — the interface stays uniform for callers. */
  chatStream(request: LlmChatRequest, handlers: LlmStreamHandlers): Promise<LlmChatResult>
  /** Unloads the given models (router mode); providers without unload are a
   *  no-op. Returns what was unloaded and what was intentionally skipped. */
  unload(models: string[]): Promise<UnloadResult>
  capabilities(): LlmCapabilities
  /** Ollama-only legacy seam: the byte-exact /api/generate freeform call the
   *  pre-provider /api/lan/ollama route made. */
  legacyGenerate?(model: string, prompt: string, signal?: AbortSignal): Promise<string>
  /** Ollama-only legacy seam: the byte-exact /api/chat structured call. */
  legacyChatStructured?(model: string, prompt: string, schema: Record<string, unknown>, signal?: AbortSignal): Promise<string>
}

/** Legacy prompt-assistant shapes preserved byte-for-byte: these are what the
 *  pre-provider /api/lan/ollama routes put on the wire, and the Ollama
 *  provider reproduces them exactly when it is the active provider. */
export type LegacyOllamaFreeform = { model: string; prompt: string }
export type LegacyOllamaStructured = { model: string; prompt: string; schema: Record<string, unknown> }
