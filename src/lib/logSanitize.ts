/**
 * Pure error sanitizer for the PII-scrubbed diagnostics discipline.
 *
 * Logs record the failure PATH and REASON — node ids, class names, file
 * paths, HTTP statuses, stages, timings — NEVER prompt or media semantics.
 * "We care that it failed on a node because we didn't parse a comma — not
 * what the user asked for."
 *
 * This module is DELIBERATELY dependency-free (zero imports, no globals
 * beyond the language itself) so it loads cleanly in the repo's
 * VM-transpiled unit-test harness (scripts/test-workflows.cjs `load()`),
 * which provides only {exports, require, URLSearchParams, URL, console}.
 * It is the single source of truth for both trees:
 *
 *   src/…                     — imported by the renderer (ErrorBoundary)
 *   server/logSanitize.ts     — re-exports this module for the pino seam
 *
 * Implementation notes: no `matchAll`, no iterator spreads, no for..of over
 * iterables — the unit-test harness transpiles to an ES3-ish target where
 * those silently no-op. A regex `exec` loop and array joins only.
 */

/** Fallback title the error boundary renders (asserted by the unit suite). */
export const ERROR_FALLBACK_TITLE = 'This view hit an error'

export type SanitizedError = { name: string; reason: string; path: string }

const REDACTED = '[redacted]'

/** Hard cap on any sanitized string — a corrupted multi-megabyte message must
 *  not flood the log line (or the boundary fallback). */
const MAX_SANITIZED_LENGTH = 200

/** Technical vocabulary — error kinds, protocols, failure verbs. These carry
 *  the REASON; free-form prose does not. Compiled to per-character character
 *  classes so matching is case-insensitive WITHOUT the regex 'i' flag: the
 *  flag would also case-fold the structural alternatives above (e.g. the
 *  class-name shape would degrade to "any word"). */
const KEYWORDS = [
  'node', 'nodes', 'timeout', 'timed out', 'failed', 'failing', 'fail', 'failure', 'failures',
  'error', 'errors', 'invalid', 'unexpected', 'parse', 'parsing', 'parsed', 'syntax', 'position',
  'status', 'code', 'exit', 'connection', 'refused', 'reset', 'aborted', 'abort', 'denied',
  'forbidden', 'unauthorized', 'missing', 'unsupported', 'deprecated', 'overflow', 'oom',
  'out of memory', 'cuda', 'gpu', 'vram', 'http', 'https', 'ws', 'websocket', 'sse', 'cors',
  'ssrf', 'uri', 'url', 'ip', 'dns', 'tls', 'ssl', 'json', 'xml', 'html', 'csv', 'api', 'ipc',
  'rpc', 'oserror', 'runtimeerror', 'typeerror', 'rangeerror', 'syntaxerror', 'referenceerror',
  'evalerror', 'promise', 'comfyui', 'comfy', 'workflow', 'workflows', 'ffmpeg', 'ffprobe',
  'openssl', 'python', 'ollama', 'enoent', 'eacces', 'econnrefused', 'etimedout', 'epipe',
  'traversal', 'token', 'tokens', 'retry', 'retries', 'exhausted', 'deadline', 'stack', 'trace',
  'handshake', 'upgrade', 'shutdown', 'restart', 'cancelled', 'canceled', 'skipped', 'dropped',
]

function keywordPattern(word: string): string {
  return word.replace(/[a-z]/g, (ch) => `[${ch.toUpperCase()}${ch}]`)
}

// Ordered alternation of "known-safe technical fragment" shapes. Everything
// that matches survives verbatim; every run of anything else collapses to a
// single [redacted] marker. Order matters: the most specific shapes first so
// e.g. a file path is not half-eaten by a weaker alternative. The combined
// pattern is case-SENSITIVE (see KEYWORDS for how vocabulary still matches
// any casing).
const KEEP_SOURCES = [
  // 1. File names with technical extensions (paths ending in a file).
  /[A-Za-z_][\w./\\-]*\.(?:py|tsx?|jsx?|mjs|cjs|json|safetensors|pt|pth|gguf|onnx|bin|mp4|webm|mov|mkv|flac|wav|mp3|ogg|m4a|opus|png|jpe?g|webp|bmp|gif|txt|log|csv|ya?ml|toml|ini|cfg|conf|exe|dll|so|dylib|pem|crt)\b/.source,
  // 2. Windows absolute paths (C:\Users\…\video.mp4 without an extension too).
  /[A-Za-z]:\\(?:[\w.@-]+\\)*[\w.@-]+/.source,
  // 3. POSIX paths with two or more segments (/api/lan/prompt, /home/u/out).
  //    Two-plus avoids treating prose like "his/her" as a path.
  /\/[\w.@-]+(?:\/[\w.@-]+)+/.source,
  // 4. IPv4 addresses with an optional port.
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d{1,5})?\b/.source,
  // 5. UUIDs (ComfyUI prompt/job ids).
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/.source,
  // 6. Class-name-ish identifiers: a capital … a lowercase … another capital
  //    (VAEDecodeTiled, KSamplerSelect, MiniMaxH3PreviewOverride, ComfyUI).
  //    Plain English ("Cannot", "The") has no internal case transition and
  //    is dropped.
  /[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*/.source,
  // 7. snake_case identifiers (load_draft, my_counter).
  /\b[A-Za-z_][A-Za-z0-9]*_[A-Za-z0-9_]+\b/.source,
  // 8. Dotted property paths (settings.gpuTier, error.message, node.inputs).
  /[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)+/.source,
  // 9. Technical vocabulary (case-insensitive via keywordPattern).
  '\\b(?:' + KEYWORDS.map(keywordPattern).join('|') + ')\\b',
  // 10. Bare numbers — node ids ('13', '84'), HTTP statuses ('500'),
  //     byte positions, timings, exit codes.
  /\d+(?:\.\d+)?/.source,
].join('|')

/** Reduces an arbitrary error message to failure-path signal: technical
 *  fragments survive, free-form user text collapses to `[redacted]`, and the
 *  result is capped at MAX_SANITIZED_LENGTH. */
export function sanitizeErrorMessage(message: string): string {
  if (typeof message !== 'string' || message.length === 0) return ''
  const pattern = new RegExp(KEEP_SOURCES, 'g')
  const parts: string[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(message)) !== null) {
    const gap = message.slice(cursor, match.index)
    if (gap.trim().length > 0) parts.push(REDACTED)
    parts.push(match[0])
    cursor = match.index + match[0].length
  }
  if (message.slice(cursor).trim().length > 0) parts.push(REDACTED)
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_SANITIZED_LENGTH)
}

/** First stack frame reduced to `file:line[:function]` — the failure PATH.
 *  Duck-typed on purpose: errors crossing realms (VM harness, iframes) fail
 *  instanceof checks but still carry name/message/stack. */
export function sanitizeError(error: unknown): SanitizedError {
  let name = 'Error'
  let message = ''
  let stack = ''
  if (error !== null && typeof error === 'object') {
    const holder = error as { name?: unknown; message?: unknown; stack?: unknown }
    if (typeof holder.name === 'string' && holder.name) name = holder.name
    if (typeof holder.message === 'string') message = holder.message
    if (typeof holder.stack === 'string') stack = holder.stack
  } else if (typeof error === 'string') {
    name = 'string'
    message = error
  } else if (error !== undefined) {
    name = typeof error
    message = String(error)
  }
  return { name, reason: sanitizeErrorMessage(message), path: firstStackPath(stack) }
}

function firstStackPath(stack: string): string {
  if (!stack) return ''
  const lines = stack.split('\n')
  for (let index = 0; index < lines.length; index++) {
    // V8 shapes: "at fn (file:1:2)", "at Object.<anonymous> (file:1:2)",
    // "at async fn (file:1:2)", "at file:1:2".
    const frame = /^\s*at\s+(?:(\S+)\s+\()?([^()]+?):(\d+):(\d+)\)?\s*$/.exec(lines[index])
    if (frame) {
      const file = frame[2]
      const line = frame[3]
      const fn = frame[1] ? frame[1].replace(/^async\s+/, '') : ''
      return fn ? `${file}:${line}:${fn}` : `${file}:${line}`
    }
  }
  return ''
}
