/**
 * Legacy Ollama provider — wraps the EXACT route logic the /api/lan/ollama
 * routes used before the provider seam existed (same endpoints, same bodies,
 * same answer stripping), so the empty-router-URL fallback preserves today's
 * behavior byte-for-byte. Also serves composed chat requests (unified
 * /api/lan/llm/generate) through /api/chat.
 */
import { inferFamily, isVisionModel, loadFamilyManifests } from '../registry'
import type { LlmModelInfo, LlmProvider, LlmStreamHandlers, UnloadResult } from '../types'

const REQUEST_TIMEOUT_MS = 120_000

/** The pre-provider answer stripper, unchanged: remove <think>/<analysis>
 *  blocks (closed or dangling) then stray tags, and trim. */
export function finalOllamaAnswer(value: string) {
  let answer = value.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '').replace(/<analysis\b[^>]*>[\s\S]*?<\/analysis>/gi, '')
  const unclosedThink = answer.search(/<(?:think|analysis)\b[^>]*>/i)
  if (unclosedThink >= 0) answer = answer.slice(0, unclosedThink)
  return answer.replace(/<\/?(?:think|analysis)\b[^>]*>/gi, '').trim()
}

export type OllamaProviderOptions = {
  baseUrl: string
}

async function ollamaFetch(url: string, path: string, init: RequestInit): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}${path}`, { ...init, signal: init.signal ?? controller.signal })
    if (!response.ok) {
      const message = await response.text().catch(() => '')
      throw new Error(message.slice(0, 300) || `Ollama returned ${response.status}`)
    }
    return await response.json() as Record<string, unknown>
  } finally {
    clearTimeout(timer)
  }
}

export function createOllamaProvider(options: OllamaProviderOptions): LlmProvider {
  const base = options.baseUrl
  const manifests = loadFamilyManifests()

  /** Legacy freeform generate — the exact /api/lan/ollama body. */
  async function legacyGenerate(model: string, prompt: string, signal?: AbortSignal): Promise<string> {
    const data = await ollamaFetch(base, '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false, think: false, options: { temperature: 0.6, num_predict: 1200 } }),
      signal,
    }) as { response?: string; error?: string }
    if (!data.response) throw new Error(typeof data.error === 'string' && data.error ? data.error : 'Ollama returned an empty response.')
    const answer = finalOllamaAnswer(data.response)
    if (!answer) throw new Error('Ollama returned reasoning without a final answer.')
    return answer
  }

  /** Legacy structured chat — the exact /api/lan/ollama/structured body. */
  async function legacyChatStructured(model: string, prompt: string, schema: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const data = await ollamaFetch(base, '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false, think: false, format: schema, options: { temperature: 0.2, num_predict: 6000 } }),
      signal,
    }) as { message?: { content?: string }; error?: string }
    const content = typeof data.message?.content === 'string' ? finalOllamaAnswer(data.message.content) : ''
    if (!content) throw new Error(typeof data.error === 'string' && data.error ? data.error : 'Ollama returned an empty response.')
    return content
  }

  return {
    kind: 'ollama',
    endpoint: base,

    async listModels() {
      const data = await ollamaFetch(base, '/api/tags', { method: 'GET' })
      // Same filter the bootstrap route applies: named local models only
      // (remote_model entries are proxies; size 342 is the embedding stub).
      const rows = Array.isArray(data.models) ? data.models : []
      const models: LlmModelInfo[] = []
      for (const raw of rows) {
        if (!raw || typeof raw !== 'object') continue
        const entry = raw as { name?: unknown; size?: unknown; remote_model?: unknown }
        if (typeof entry.name !== 'string' || !entry.name) continue
        if (entry.remote_model || entry.size === 342) continue
        const family = inferFamily(entry.name, manifests)
        models.push({ id: entry.name, status: '', family, vision: isVisionModel(entry.name, family, undefined, manifests) })
      }
      return models
    },

    async chat(request) {
      // Single user message with no system layer and no schema → the legacy
      // /api/generate path (byte-identical wire behavior for the fallback).
      const simple = request.messages.length === 1 && request.messages[0].role === 'user' && typeof request.messages[0].content === 'string' && !request.format
      if (simple) {
        const answer = await legacyGenerate(request.model, request.messages[0].content as string, request.signal)
        return { content: answer, finishReason: 'stop' }
      }
      const data = await ollamaFetch(base, '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
          stream: false,
          think: false,
          ...(request.format ? { format: request.format } : {}),
          // Structured requests keep the legacy 0.2 temperature.
          options: { temperature: request.format ? 0.2 : 0.6, num_predict: 6000 },
        }),
        signal: request.signal,
      }) as { message?: { content?: string }; error?: string }
      const content = typeof data.message?.content === 'string' ? finalOllamaAnswer(data.message.content) : ''
      if (!content) throw new Error(typeof data.error === 'string' && data.error ? data.error : 'Ollama returned an empty response.')
      return { content, finishReason: 'stop' }
    },

    async chatStream(request, handlers: LlmStreamHandlers) {
      // Ollama's NDJSON streaming would be a SECOND streaming implementation;
      // the seam's contract is one — so the legacy provider executes the full
      // request and delivers it as a single token. Callers get the same
      // interface; progressive rendering simply does not happen on Ollama.
      const result = await this.chat(request)
      handlers.onToken(result.content)
      return result
    },

    async unload() {
      // Ollama keeps models resident by design (keep_alive); no unload verb.
      return { unloaded: [], skipped: [] } satisfies UnloadResult
    },

    capabilities() {
      return { streaming: false, unload: false, vision: false }
    },

    /** Route-facing legacy helpers (used by /api/lan/ollama delegation). */
    legacyGenerate,
    legacyChatStructured,
  }
}
