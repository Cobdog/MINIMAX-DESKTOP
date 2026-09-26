/**
 * ComfyUI /prompt rejection reduction (Wave 1 R-03, audit C F1) — extracted
 * from server/core.ts as a PURE module so the reducer is unit-testable
 * against the engine's real error shapes. Everything that crosses to the
 * client passes through the sanitizer here; no raw engine text leaks — and
 * (journey sweep #6, audit F11) the composition runs through sanitizeForUser:
 * sanitized AND stripped of the `[redacted]` markers, so the Wave-1 bar
 * ("never reaches a user") holds for the whole string, not just its start.
 */
import { sanitizeForUser } from './logSanitize'

type PromptErrorShape = {
  error?: { type?: unknown; message?: unknown; details?: unknown; extra_info?: { class_type?: unknown; node_id?: unknown } }
  node_errors?: Record<string, { class_type?: unknown; errors?: Array<{ type?: unknown; details?: unknown; message?: unknown; extra_info?: { error_message?: unknown } }> }>
}

/** Reduces a ComfyUI /prompt rejection body to the structural failure signal.
 *  Two shapes, both verified against the installed ComfyUI's builders
 *  (comfy/execution.py + server.py):
 *
 *   { error: { type, message, details, extra_info: { class_type } },
 *     node_errors: {} }                       — a MISSING NODE CLASS
 *     (error.type = 'missing_node_type'; node_errors empty) or another
 *     top-level rejection. The type token + class name surface verbatim —
 *     snake_case survives sanitization by construction, which is what makes
 *     the failure taxonomy's node-missing bucket reachable.
 *
 *   { error: { type: 'prompt_outputs_failed_validation', … },
 *     node_errors: { id: { class_type, errors: [{ type, message, details }] } } }
 *                                            — per-node validation detail:
 *     node id + class + the engine's own type token + short reason, each
 *     fragment sanitized.
 *
 *  Non-JSON bodies fall through to whole-text sanitization — either way no
 *  raw engine text crosses to the client. */
export function structuralPromptError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as PromptErrorShape
    const nodeErrors = parsed.node_errors
    if (nodeErrors && typeof nodeErrors === 'object') {
      const ids = Object.keys(nodeErrors)
      const lines: string[] = []
      for (const id of ids.slice(0, 6)) {
        const entry = nodeErrors[id]
        const errors = Array.isArray(entry?.errors) ? entry.errors : []
        const first = errors[0] as { type?: unknown; details?: unknown; message?: unknown; extra_info?: { error_message?: unknown } } | undefined
        const nodeClass = typeof entry?.class_type === 'string' ? entry.class_type : ''
        // The engine's own structured tokens lead (snake_case survives
        // sanitization intact), then its short prose reason.
        const typeToken = typeof first?.type === 'string' ? first.type : ''
        const detail = typeof first?.details === 'string' ? first.details : ''
        const message = typeof first?.message === 'string' ? first.message : (typeof first?.extra_info?.error_message === 'string' ? first.extra_info.error_message : '')
        const text = sanitizeForUser([nodeClass, typeToken, detail || message].filter(Boolean).join(' · '))
        if (text) lines.push(`node ${id}: ${text}`)
      }
      if (lines.length) return `Graph validation failed — ${lines.join('; ')}${ids.length > 6 ? ` (+${ids.length - 6} more nodes)` : ''}`
    }
    const top = parsed.error
    if (top && typeof top === 'object') {
      const typeToken = typeof top.type === 'string' ? top.type : ''
      const message = typeof top.message === 'string' ? top.message : ''
      const details = typeof top.details === 'string' ? top.details : ''
      const nodeClass = typeof top.extra_info?.class_type === 'string' ? top.extra_info.class_type : ''
      const nodeId = typeof top.extra_info?.node_id === 'string' ? top.extra_info.node_id : ''
      const text = sanitizeForUser([typeToken, message, details, nodeClass, nodeId ? `node ${nodeId}` : ''].filter(Boolean).join(' · '))
      if (text) return text
    }
  } catch { /* not JSON — whole-text sanitization below */ }
  return sanitizeForUser(raw)
}
