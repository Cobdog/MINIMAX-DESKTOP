/**
 * The diagnostic report — the user-facing half of the PII-scrubbed
 * diagnostics discipline. Everything the doctrine guarantees is enforced
 * HERE, by construction:
 *
 *   - the report is built ONLY from structured fields (versions, states,
 *     counts, node ids/classes, sanitized reasons) — never from raw logs;
 *   - every string that is not from this module's own fixed vocabulary
 *     passes through sanitizeErrorMessage() on the way in (engine log-tail
 *     lines, runtime lastError, job error text, doctor details), so prompt
 *     or media semantics cannot survive into the blob;
 *   - model scan contributes COUNTS per kind — custom model file names are
 *     never included;
 *   - nothing is sent anywhere: the caller copies or saves the returned
 *     text, and it stays on the machine until the user pastes it.
 *
 * Pure and synchronous: same input → byte-identical output (proven by the
 * unit suite), no engine, no network, loads in the VM-transpiled harness.
 * The sanitizer import is the only dependency (itself dependency-free).
 */
import { sanitizeErrorMessage } from './logSanitize'
import { classifyFailure } from './failureTaxonomy'

/** Hard cap on failure rows and log-tail lines in the report — a burst of
 *  failures must not turn the paste into a wall. */
const MAX_FAILURE_ROWS = 20
const MAX_LOG_TAIL_LINES = 20

/** One recent failed render as the report records it. `reason` is the job's
 *  error text (already structural under the fixed flow, but re-sanitized
 *  here so pre-fix persisted jobs cannot leak either). */
export type ReportFailure = {
  id: string
  at: number
  provider?: string
  mode?: string
  mediaType?: string
  nodeType?: string
  reason: string
}

export type DiagnosticReportInput = {
  appVersion: string
  osPlatform: string
  generatedAt: number
  engine: {
    mode: string
    connected: boolean
    latencyMs?: number
    comfyVersion?: string
    testedComfyVersion?: string
    engineOs?: string
    pythonVersion?: string
    deviceName?: string
    vramTotalBytes?: number
  }
  managedRuntime?: {
    state: string
    profile?: string
    port?: number
    pid?: number
    health?: string
    lastError?: string
    logTail: string[]
  } | null
  /** Counts per model kind — names never enter the report. */
  modelScan: Array<{ kind: string; count: number }>
  /** Job-count summary over the same window as `failures`. */
  jobCounts: { total: number; completed: number; failed: number; cancelled: number }
  failures: ReportFailure[]
  doctor?: { ranAt: number; checks: Array<{ id: string; label: string; status: string; detail?: string }> } | null
  selfTest: SanitizerSelfTest
}

// ---- sanitizer self-test ----------------------------------------------------

/** Sentinel phrases that must NEVER survive sanitization. Distinctive by
 *  design: none of them is a keyword, an identifier shape, or a number, so
 *  the only way one survives is a sanitizer regression. */
export const SELF_TEST_SENTINELS = [
  'qzxveldra',
  'umbrella merchants',
  'waltzing',
  'Elinor',
  'Lisbon',
  'sunset over Kyoto',
]

/** Prompt-shaped canaries, including the dangerous shapes: error wrappers
 *  that quote prompt text back (the exact leak path this discipline exists
 *  to close). */
const SELF_TEST_CASES = [
  'a moonlit qzxveldra waltzes past umbrella merchants in the rain',
  'cinematic close-up of Elinor\'s weathered hands, 85mm, golden hour in Lisbon',
  'Prompt #88 failed: the encoder rejected "sunset over Kyoto" at token 7',
  'Node 84 (VAEDecodeTiled) raised: could not decode frames of moonlit qzxveldra umbrella merchants waltzing',
  'ValidationError: unexpected input \'"her silk dress billowing"\' at position 12 near sunset over Kyoto',
]

export type SanitizerSelfTestCase = { name: string; input: string; output: string; passed: boolean }
export type SanitizerSelfTest = { passed: boolean; cases: SanitizerSelfTestCase[] }

/** Runs the canary set through the pure sanitizer. Every case must keep the
 *  technical signal and lose every sentinel; a prose case must show a
 *  [redacted] marker (proof redaction engaged, not an empty string). */
export function runSanitizerSelfTest(): SanitizerSelfTest {
  const cases: SanitizerSelfTestCase[] = []
  let passed = true
  for (let index = 0; index < SELF_TEST_CASES.length; index += 1) {
    const input = SELF_TEST_CASES[index]
    const output = sanitizeErrorMessage(input)
    const clean = SELF_TEST_SENTINELS.every((sentinel) => !output.includes(sentinel))
    const engaged = output.includes('[redacted]')
    const casePassed = clean && engaged
    if (!casePassed) passed = false
    cases.push({ name: `canary-${index + 1}`, input, output, passed: casePassed })
  }
  return { passed, cases }
}

// ---- report -----------------------------------------------------------------

function iso(at: number): string {
  const date = new Date(at)
  return Number.isFinite(date.getTime()) ? date.toISOString() : 'unknown'
}

/** Version fields pass a SHAPE allow-list instead of the prose sanitizer:
 *  a digit-led single token ('0.34.4', 'v0.34.4-4a1b2c3', '3.12.7') cannot
 *  carry prompt semantics, and sanitizing it would mangle the dotted number
 *  ('0.34 [redacted] 4'). Anything else goes through the sanitizer. */
function versionToken(value: string | undefined): string {
  if (typeof value !== 'string' || value.length === 0) return ''
  return /^v?\d[\w.+-]{0,47}$/.test(value) ? value : sanitizeErrorMessage(value)
}

/** Internal single-token fields (job ids, provider/mode enums, node class
 *  names, profile ids) pass a one-token shape check instead of the prose
 *  sanitizer: a whitespace-free token cannot carry prompt semantics (the
 *  leak risk is multi-word content), and sanitizing them would eat real
 *  values the report exists to show ('minimax', 'Canny', 'default'). These
 *  values originate in the app's own state or as engine class identifiers;
 *  anything multi-word still goes through the sanitizer. */
function codeToken(value: string | undefined, fallback = ''): string {
  if (typeof value !== 'string' || value.length === 0) return fallback
  return /^[\w.:@-]{1,48}$/.test(value) ? value : sanitizeErrorMessage(value)
}

function gigabytes(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return ''
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

/** Builds the plain-text diagnostic report. Deterministic: the timestamp
 *  rides in via `generatedAt`, never from a clock read here. */
export function buildDiagnosticReport(input: DiagnosticReportInput): string {
  const lines: string[] = []
  const push = (line: string) => lines.push(line)

  push('MiniMax Studio diagnostic report')
  push(`Generated: ${iso(input.generatedAt)}`)
  push(`App: ${versionToken(input.appVersion) || 'unknown'} on ${sanitizeErrorMessage(input.osPlatform) || 'unknown'}`)
  push('PII: this report is scrubbed by construction — prompt and media content cannot appear in it.')

  // Engine ---------------------------------------------------------------
  push('')
  push('[ENGINE]')
  const engine = input.engine
  push(`Connection: ${engine.connected ? `connected (${engine.mode} mode${typeof engine.latencyMs === 'number' ? `, ${engine.latencyMs} ms` : ''})` : `offline (${engine.mode} mode)`}`)
  if (engine.comfyVersion || engine.testedComfyVersion) {
    const drift = engine.comfyVersion && engine.testedComfyVersion && engine.comfyVersion !== engine.testedComfyVersion
    push(`Engine version: ${versionToken(engine.comfyVersion) || 'unknown'} · graphs verified against: ${versionToken(engine.testedComfyVersion) || 'not recorded yet'}${drift ? ' (DRIFT — re-run the H3 Quality Test)' : ''}`)
  }
  if (engine.engineOs || engine.pythonVersion) push(`Engine platform: ${sanitizeErrorMessage(engine.engineOs ?? '?')} · Python ${versionToken(engine.pythonVersion) || '?'}`)
  if (engine.deviceName) push(`Device: ${sanitizeErrorMessage(engine.deviceName)}${engine.vramTotalBytes ? ` · ${gigabytes(engine.vramTotalBytes)} VRAM` : ''}`)

  // Managed runtime --------------------------------------------------------
  push('')
  push('[MANAGED RUNTIME]')
  const runtime = input.managedRuntime
  if (!runtime) {
    push('Not active (external engine mode — nothing is spawned or supervised).')
  } else {
    push(`State: ${codeToken(runtime.state, 'unknown')}${runtime.profile ? ` · profile: ${codeToken(runtime.profile)}` : ''}${runtime.port ? ` · port ${runtime.port}` : ''}${runtime.pid ? ` · pid ${runtime.pid}` : ''}${runtime.health && runtime.health !== 'unknown' ? ` · health ${runtime.health}` : ''}`)
    if (runtime.lastError) push(`Last error: ${sanitizeErrorMessage(runtime.lastError)}`)
    const tail = runtime.logTail.slice(-MAX_LOG_TAIL_LINES)
    if (tail.length) {
      push(`Log tail (${tail.length} line${tail.length === 1 ? '' : 's'}, sanitized):`)
      for (let index = 0; index < tail.length; index += 1) push(`  ${sanitizeErrorMessage(tail[index])}`)
    } else {
      push('Log tail: empty.')
    }
  }

  // Model scan -------------------------------------------------------------
  push('')
  push('[MODEL SCAN] (counts only — file names are never included)')
  if (input.modelScan.length === 0) {
    push('No models indexed.')
  } else {
    for (let index = 0; index < input.modelScan.length; index += 1) {
      push(`  ${codeToken(input.modelScan[index].kind)}: ${input.modelScan[index].count}`)
    }
  }

  // Failures ---------------------------------------------------------------
  push('')
  push('[JOBS]')
  const counts = input.jobCounts
  push(`Window summary: ${counts.total} tracked · ${counts.completed} completed · ${counts.failed} failed · ${counts.cancelled} cancelled`)
  push('[FAILURE HISTORY]')
  if (input.failures.length === 0) {
    push('No failed jobs recorded.')
  } else {
    const histogram = new Map<string, number>()
    for (let index = 0; index < input.failures.length; index += 1) {
      const failure = input.failures[index]
      const bucket = classifyFailure(`${failure.reason} ${failure.nodeType ?? ''}`)
      histogram.set(bucket.id, (histogram.get(bucket.id) ?? 0) + 1)
    }
    const order = Array.from(histogram.keys()).sort()
    push(`Histogram (${input.failures.length} failure${input.failures.length === 1 ? '' : 's'}):`)
    for (let index = 0; index < order.length; index += 1) {
      push(`  ${order[index]}: ${histogram.get(order[index])}`)
    }
    const rows = input.failures.slice(0, MAX_FAILURE_ROWS)
    push(`Recent (${rows.length} shown, most recent first):`)
    for (let index = 0; index < rows.length; index += 1) {
      const failure = rows[index]
      const bucket = classifyFailure(`${failure.reason} ${failure.nodeType ?? ''}`)
      push(`  ${iso(failure.at)} [${bucket.id}] ${codeToken(failure.provider, 'minimax')}/${codeToken(failure.mode, 'text')}${failure.nodeType ? ` node=${codeToken(failure.nodeType)}` : ''} ref=${codeToken(failure.id)} reason=${sanitizeErrorMessage(failure.reason) || 'unavailable'}`)
    }
    if (input.failures.length > rows.length) push(`  … ${input.failures.length - rows.length} older failure(s) omitted`)
  }

  // Setup doctor -------------------------------------------------------------
  push('')
  push('[SETUP DOCTOR]')
  if (!input.doctor) {
    push('Not run in this session (run it from the Diagnostics view to include results).')
  } else {
    push(`Ran: ${iso(input.doctor.ranAt)}`)
    for (let index = 0; index < input.doctor.checks.length; index += 1) {
      const check = input.doctor.checks[index]
      push(`  ${check.status.toUpperCase().padEnd(4)} ${codeToken(check.label, check.id)}${check.detail ? ` — ${sanitizeErrorMessage(check.detail)}` : ''}`)
    }
  }

  // Self-test ----------------------------------------------------------------
  push('')
  push('[SANITIZER SELF-TEST]')
  const self = input.selfTest
  const passedCount = self.cases.filter((one) => one.passed).length
  push(self.passed ? `PASS — ${passedCount}/${self.cases.length} canary cases scrubbed (prompt-shaped strings cannot survive into this report).` : `FAIL — only ${passedCount}/${self.cases.length} canary cases scrubbed. Do not paste this report anywhere.`)

  return `${lines.join('\n')}\n`
}
