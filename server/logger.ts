/**
 * The pino logging seam — the one place server-side diagnostics flow through.
 *
 * Posture (PII-scrubbed BY DESIGN): JSON to stdout, level info, nothing ever
 * leaves the machine. Everything that reaches this module is already
 * structural — failure path (file:line:function), reason (sanitized message),
 * stage, ref — because messages and stacks pass through the pure sanitizer
 * first. The redact paths below are a SAFETY NET for accidental fields a
 * future call site might attach (e.g. `logEvent({kind, prompt})`); they are
 * not a substitute for sanitizing at the source.
 */
import { randomBytes } from 'node:crypto'
import pino from 'pino'
import { sanitizeError } from './logSanitize'

const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
const requestedLevel = process.env.MINIMAX_LOG_LEVEL ?? ''
const level = LOG_LEVELS.has(requestedLevel) ? requestedLevel : 'info'

export const logger = pino({
  level,
  redact: {
    // One level of wildcard is what pino supports; cover the field names that
    // would carry prompt/media semantics if ever passed verbatim.
    paths: [
      'prompt', '*.prompt',
      'text', '*.text',
      'caption', '*.caption',
      'negativePrompt', '*.negativePrompt',
      'lyrics', '*.lyrics',
      'description', '*.description',
      'content', '*.content',
      'query', '*.query',
      'body', '*.body',
    ],
    censor: '[redacted]',
  },
})

/** Structured event line: logEvent({kind: 'lan.server', port, secure}). */
export function logEvent(event: { kind: string; [key: string]: unknown }) {
  logger.info(event, event.kind)
}

export type FailureLevel = 'fatal' | 'error' | 'warn' | 'debug'

/** Records a failure with the message/stack routed through the sanitizer:
 *  only {stage, errorName, reason, path} (+ any structural context) is
 *  written. `level` defaults to 'error'; 'debug' is for tolerated swallows
 *  (SSE reconnects, optional engine probes) that only show with
 *  MINIMAX_LOG_LEVEL=debug. */
export function logFailure(stage: string, error: unknown, context?: Record<string, string | number | boolean>, level: FailureLevel = 'error') {
  const detail = sanitizeError(error)
  const payload: Record<string, unknown> = { stage, errorName: detail.name, reason: detail.reason, path: detail.path }
  if (context) {
    const keys = Object.keys(context)
    for (let index = 0; index < keys.length; index += 1) payload[keys[index]] = context[keys[index]]
  }
  const write = level === 'fatal' ? logger.fatal.bind(logger)
    : level === 'warn' ? logger.warn.bind(logger)
    : level === 'debug' ? logger.debug.bind(logger)
    : logger.error.bind(logger)
  write(payload, 'failure')
}

/** Short correlation id echoed to the client in structural 500 bodies so a
 *  user report ("it said ref a1b2c3d4") finds the matching server log line. */
export function failureRef(): string {
  return randomBytes(4).toString('hex')
}
