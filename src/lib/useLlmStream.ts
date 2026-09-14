/**
 * useLlmStream — token-streaming UX for every LLM consumer (prompt
 * assistant, Movie Planner assistShot, Music 3 caption rewriter, Studio
 * copilot) over the realtime fabric's llm channel.
 *
 *   provider flow   prepare (/api/lan/llm/prepare composes the layered
 *                   system message server-side + family-tuned options) →
 *                   streamLlm through the fabric (reqId-correlated token /
 *                   done / error events).
 *   fallbacks       Ollama provider or a down fabric → the non-streaming
 *                   /api/lan/llm/generate route (one delivery).
 *
 * Rendering discipline (wave-2a transient rule): token deltas NEVER enter
 * React state. The caller passes a DOM `target` element; tokens paint into a
 * single text node inside it, so a 500-token stream costs zero re-renders.
 * The returned promise resolves with the full text for the caller's
 * final state update.
 */
import { useCallback, useRef, useState } from 'react'
import type { LlmGenerateOptions, LlmStreamRequest } from '../types'
import { streamLlm, type LlmStreamHandle } from './useRealtime'

export type LlmStreamUi = {
  busy: boolean
  error: string | null
  /** Aborts the in-flight stream (fabric abort or ignore for fallback). */
  abort(): void
  /** Streams a composed assistant request. Tokens append into `target` (a
   *  live DOM element) as plain text; `onToken` observes the full text if
   *  needed. Resolves with the complete text. */
  stream(options: LlmGenerateOptions & { target?: HTMLElement | null; onToken?: (full: string, delta: string) => void }): Promise<string>
}

export function useLlmStream(): LlmStreamUi {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const handleRef = useRef<LlmStreamHandle | null>(null)

  const abort = useCallback(() => {
    handleRef.current?.abort()
    handleRef.current = null
  }, [])

  const stream = useCallback(async (options: { target?: HTMLElement | null; onToken?: (full: string, delta: string) => void } & LlmGenerateOptions): Promise<string> => {
    setBusy(true)
    setError(null)
    // One text node, mutated in place — the transient-update discipline.
    const textNode = document.createTextNode('')
    if (options.target) {
      options.target.replaceChildren(textNode)
      options.target.scrollTop = options.target.scrollHeight
    }
    let full = ''
    const onToken = (delta: string) => {
      full += delta
      textNode.data = full
      if (options.target) options.target.scrollTop = options.target.scrollHeight
      options.onToken?.(full, delta)
    }
    const providerFallback = async () => {
      // Single delivery through the non-streaming provider route.
      const response = await window.minimax.llmGenerate({
        task: options.task,
        targetEngine: options.targetEngine,
        length: options.length,
        contentLevel: options.contentLevel,
        instructions: options.instructions,
        draft: options.draft,
        history: options.history,
        thinking: options.thinking,
        model: options.model,
        raw: options.raw,
      })
      onToken(response)
      return response
    }
    try {
      let prepared: LlmStreamRequest | null = null
      try {
        prepared = await window.minimax.llmPrepareStream({
          task: options.task,
          targetEngine: options.targetEngine,
          length: options.length,
          contentLevel: options.contentLevel,
          instructions: options.instructions,
          draft: options.draft,
          history: options.history,
          thinking: options.thinking,
          model: options.model,
          raw: options.raw,
        })
      } catch {
        prepared = null // Ollama provider (no streaming) or a down route.
      }
      if (prepared) {
        const handle = streamLlm(prepared, onToken)
        handleRef.current = handle
        try {
          await handle.promise
        } catch {
          // Fabric dropped: keep whatever streamed; only an empty stream
          // retries once through the provider route.
          if (full.trim()) return full
          return providerFallback()
        } finally {
          handleRef.current = null
        }
        if (!full.trim()) throw new Error('The local model returned an empty response.')
        return full
      }
      return providerFallback()
    } catch (streamFailure) {
      const message = streamFailure instanceof Error ? streamFailure.message : String(streamFailure)
      setError(message)
      throw streamFailure
    } finally {
      setBusy(false)
    }
  }, [])

  return { busy, error, abort, stream }
}
