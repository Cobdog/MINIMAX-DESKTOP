/**
 * llama.cpp ROUTER-MODE provider (the maintainer's serving stack): one
 * endpoint, many models.
 *
 *   GET  /models                → {data:[{id, status:{value}, architecture:{input_modalities}}]}
 *   POST /v1/chat/completions   → OpenAI-compatible; the `model` field routes
 *                                 (and auto-loads) the target model
 *   POST /models/unload         → {model} → {success}
 *
 * Ported from the maintainer's llama_prompt/client.py; streaming uses the
 * shared SSE parser (server/llm/sse.ts) — the same implementation the
 * realtime fabric's llm channel uses.
 */
import { buildCompletionParams, inferFamily, isVisionModel, loadFamilyManifests, stripChannelMarkup } from '../registry'
import { iterateOpenAiSse } from '../sse'
import type { LlmChatRequest, LlmChatResult, LlmModelInfo, LlmProvider, LlmStreamHandlers, UnloadResult } from '../types'

const LIST_TIMEOUT_MS = 10_000
const CHAT_TIMEOUT_MS = 180_000
const UNLOAD_TIMEOUT_MS = 30_000

export type RouterProviderOptions = {
  baseUrl: string
  /** Server-side failure logger (pino seam). */
  logFailure(stage: string, error: unknown, detail?: Record<string, unknown>, level?: 'debug' | 'warn' | 'error'): void
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: init.signal ?? controller.signal })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(detail.slice(0, 300) || `The llama.cpp router returned ${response.status}.`)
    }
    return await response.json() as Record<string, unknown>
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error(`The llama.cpp router request timed out after ${Math.round(timeoutMs / 1000)} s.`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export function createRouterProvider(options: RouterProviderOptions): LlmProvider {
  const base = options.baseUrl.replace(/\/+$/, '')
  const manifests = loadFamilyManifests()

  function bodyFor(request: LlmChatRequest, stream: boolean): Record<string, unknown> {
    const params = buildCompletionParams(request.manifest, { thinking: request.thinking, effort: request.effort, maxTokens: request.maxTokens })
    // DeepSeek reasoning passback: assistant history messages keep their
    // reasoning_content on the wire (required on thinking-mode multi-turn).
    const messages = request.messages.map((message) => {
      if (message.role === 'assistant' && typeof message.reasoning_content === 'string' && message.reasoning_content) {
        return { role: message.role, content: message.content, reasoning_content: message.reasoning_content }
      }
      return { role: message.role, content: message.content }
    })
    return { model: request.model, messages, stream, ...params }
  }

  return {
    kind: 'router',
    endpoint: base,

    async listModels() {
      const data = await fetchJson(`${base}/models`, { method: 'GET' }, LIST_TIMEOUT_MS)
      const rows = Array.isArray(data.data) ? data.data : []
      const models: LlmModelInfo[] = []
      for (const raw of rows) {
        if (!raw || typeof raw !== 'object') continue
        const entry = raw as { id?: unknown; status?: { value?: unknown }; architecture?: { input_modalities?: unknown } }
        if (typeof entry.id !== 'string' || !entry.id) continue
        const modalities = Array.isArray(entry.architecture?.input_modalities) ? entry.architecture?.input_modalities : []
        const routerVision = modalities.includes('image')
        const family = inferFamily(entry.id, manifests)
        models.push({
          id: entry.id,
          status: typeof entry.status?.value === 'string' ? entry.status.value : '',
          family,
          vision: isVisionModel(entry.id, family, typeof routerVision === 'boolean' ? routerVision : undefined, manifests),
        })
      }
      return models
    },

    async chat(request) {
      const body = bodyFor(request, false)
      const data = await fetchJson(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: request.signal,
      }, CHAT_TIMEOUT_MS)
      const choices = Array.isArray(data.choices) ? data.choices : []
      const choice = choices[0] as { message?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: unknown } | undefined
      const message = choice?.message
      const raw = typeof message?.content === 'string' ? message.content : ''
      // Defensive channel strip (Gemma can leak an empty thought channel into
      // content when the server's reasoning parse misses).
      const content = stripChannelMarkup(raw).trim()
      const result: LlmChatResult = { content, finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : undefined }
      if (typeof message?.reasoning_content === 'string' && message.reasoning_content) result.reasoning = message.reasoning_content
      return result
    },

    async chatStream(request, handlers: LlmStreamHandlers) {
      const body = bodyFor(request, true)
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: request.signal,
      })
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '')
        throw new Error(detail.slice(0, 300) || `The llama.cpp router returned ${response.status}.`)
      }
      let content = ''
      let reasoning = ''
      let finishReason: string | undefined
      for await (const event of iterateOpenAiSse(response.body)) {
        if (event.kind === 'content') {
          content += event.delta
          handlers.onToken(event.delta)
        } else if (event.kind === 'reasoning') {
          reasoning += event.delta
          handlers.onReasoning?.(event.delta)
        } else if (event.kind === 'finish') {
          finishReason = event.reason
        }
      }
      return { content: stripChannelMarkup(content).trim(), reasoning: reasoning || undefined, finishReason }
    },

    async unload(models) {
      const unloaded: string[] = []
      const skipped: string[] = []
      for (const model of models) {
        try {
          const result = await fetchJson(`${base}/models/unload`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model }),
          }, UNLOAD_TIMEOUT_MS)
          if (result.success === false) skipped.push(model)
          else unloaded.push(model)
        } catch (error) {
          options.logFailure('llm/router/unload', error, { model }, 'debug')
          skipped.push(model)
        }
      }
      return { unloaded, skipped } satisfies UnloadResult
    },

    capabilities() {
      return { streaming: true, unload: true, vision: true }
    },
  }
}
