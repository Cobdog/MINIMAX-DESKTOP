/**
 * OpenAI-compatible SSE parsing — the ONE streaming-parse implementation,
 * shared by the realtime fabric's llm channel (server/realtime.ts) and the
 * router provider's chatStream. Extracted from the fabric's original inline
 * loop so both consumers parse identically.
 *
 * DeepSeek thinking rules honored here (deepseek-harness): the FIRST thinking
 * chunk carries reasoning_content:"" which must NOT open a reasoning block —
 * only non-empty reasoning deltas surface. Visible content and reasoning are
 * distinct event kinds so a consumer can stream content while accumulating
 * reasoning for multi-turn passback.
 */

export type OpenAiSseEvent =
  | { kind: 'content'; delta: string }
  | { kind: 'reasoning'; delta: string }
  | { kind: 'finish'; reason: string }
  | { kind: 'end' }

type SseChunk = { choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: unknown }> }

/** Iterates one OpenAI-compatible SSE body: yields content/reasoning deltas
 *  and the finish reason as they arrive, then a final `{kind:'end'}` when the
 *  `[DONE]` sentinel is seen. Malformed data lines are skipped (the original
 *  fabric behavior). The caller owns cancellation: aborting the fetch makes
 *  the read throw. */
export async function* iterateOpenAiSse(body: ReadableStream<Uint8Array>): AsyncGenerator<OpenAiSseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return
      buffer += decoder.decode(chunk.value, { stream: true })
      let newlineIndex: number
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '')
        buffer = buffer.slice(newlineIndex + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') {
          yield { kind: 'end' }
          return
        }
        let parsed: SseChunk
        try { parsed = JSON.parse(data) as SseChunk } catch { continue }
        const choice = parsed.choices?.[0]
        if (!choice) continue
        // Reasoning first: thinking mode interleaves it before text. The
        // empty-string first chunk must not surface as a delta.
        const reasoning = choice.delta?.reasoning_content
        if (typeof reasoning === 'string' && reasoning.length > 0) yield { kind: 'reasoning', delta: reasoning }
        const content = choice.delta?.content
        if (typeof content === 'string' && content.length > 0) yield { kind: 'content', delta: content }
        if (typeof choice.finish_reason === 'string' && choice.finish_reason) yield { kind: 'finish', reason: choice.finish_reason }
      }
    }
  } finally {
    // Early exit (end sentinel, consumer break, or an aborted read): drop the
    // lock and best-effort cancel so the upstream connection closes.
    try {
      void reader.cancel().catch(() => undefined)
    } catch {
      /* already released */
    }
  }
}
