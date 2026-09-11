/**
 * EngineProcess — the ONE supervision contract for Python sidecars (wave 2c).
 *
 * Every managed child the server starts — the self-managed ComfyUI runtime,
 * the LoRA trainer (ai-toolkit run.py), RefMod's extract_mod.py — goes through
 * this class. It is written ONCE, before the first sidecar ships, because
 * every behavior it pins down is fatal-if-retrofitted:
 *
 *   buffering    Python block-buffers stdout when it is not a TTY, hiding all
 *                output until exit. Every child therefore gets
 *                PYTHONUNBUFFERED=1, and python commands additionally get -u
 *                prepended (detected by executable basename).
 *   NDJSON       stdout AND stderr are parsed per line as JSON. Valid objects
 *                pass through as structured events; non-JSON lines (and valid
 *                JSON that is not an object) wrap as {level:'raw', msg}. Line
 *                splitting is byte-accurate and handles CRLF. Events flow to
 *                the onEvent callback, the pino logger (debug for raw/info,
 *                warn+ for error/fatal), and the readiness matcher.
 *   readiness    ndjson-match (first event satisfying a predicate) or
 *                http-poll (fetch against a LOCAL-ONLY URL — the server's
 *                isLocalServiceUrl guard is wired in via setUrlGuard; the
 *                default is deny-all so an unwired process fails closed).
 *                The `ready` promise resolves on success and rejects with a
 *                clear error on timeout or on exiting before ready.
 *   stop         gracefulStop() writes the quit line to stdin (children read
 *                stdin and exit cleanly), waits the grace window, then
 *                escalates to killTree(). killTree() is tree-wide:
 *                  POSIX   the child is spawned detached (new process group);
 *                          kill(-pid, SIGTERM), escalating to SIGKILL after
 *                          3 s — grandchildren that ignore SIGTERM still die.
 *                  Windows taskkill /PID <pid> /T /F via execFile — the
 *                          documented answer: it walks the whole process
 *                          tree regardless of cmd.exe shim wrappers.
 *   shims        On Windows, uv/pip install .cmd/.bat shims. Spawning those
 *                without a shell fails (EINVAL), so when the command basename
 *                ends in .cmd/.bat the child is spawned with shell:true —
 *                acceptable ONLY because taskkill /T covers the cmd.exe
 *                wrapper and every grandchild it launched. Quoting caveat:
 *                with shell:true Node joins command + args with spaces, so
 *                arguments containing spaces must arrive pre-quoted. On POSIX
 *                a shell is NEVER used (direct exec); a shim script that
 *                needs one is wrapped by the caller in an explicit `sh -c` —
 *                the process-group kill still covers it.
 *   reaping      The 'exit' handler is installed at spawn (no per-OS zombie
 *                windows), every pipe is destroyed on exit, every timer is
 *                cleared, and a static registry backs
 *                EngineProcess.shutdownAll() so the server's exit path stops
 *                everything it started (graceful first, forced second).
 *
 * Exit normalization is a settled promise + onExit callback:
 *   { code, signal, killedByUs, timedOut, durationMs } (+ error only when the
 *   process never launched, e.g. ENOENT). `timedOut` is set when the optional
 *   hard deadline (hardTimeoutMs) expires before the process exits on its own.
 *
 * Lifecycle phases ('starting' | 'ready' | 'stopped' | 'failed') are emitted
 * to the sink wired via setEngineSink — core.ts points it at the realtime
 * hub's engine channel. Nothing here imports from 'electron'.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { basename } from 'node:path'
import { logger, logEvent } from './logger'

const DEFAULT_QUIT_LINE = 'quit'
const DEFAULT_GRACE_TIMEOUT_MS = 8_000
const SIGKILL_ESCALATION_MS = 3_000
const DEFAULT_READINESS_TIMEOUT_MS = 60_000
const DEFAULT_HTTP_POLL_MS = 500
const HTTP_ATTEMPT_TIMEOUT_MS = 2_500
const KILL_TREE_SETTLE_MS = 5_000
/** A child that never emits a newline (progress bars use \r) must not grow an
 *  unbounded line buffer; past this size the remainder flushes as one raw event. */
const MAX_PENDING_LINE_BYTES = 1_048_576

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One parsed child output line: a JSON object passed through as-is, or a
 *  non-JSON line wrapped as {level:'raw', msg}. */
export type EngineEvent = { level?: string; msg?: string } & Record<string, unknown>

/** Readiness contract: ndjson-match on parsed events, an HTTP poll against a
 *  local URL, or none (ready resolves immediately after spawn). */
export type EngineReadiness =
  | { type: 'ndjson'; match: (event: EngineEvent) => boolean; timeoutMs?: number }
  | { type: 'http'; url: string; path?: string; timeoutMs?: number; pollMs?: number }
  | { type: 'none' }

export type EngineProcessConfig = {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  name: string
  /** Line written to the child's stdin by gracefulStop(). Default 'quit'. */
  gracefulQuitLine?: string
  /** How long gracefulStop() waits after the quit line before killTree().
   *  Default 8 s. */
  graceTimeoutMs?: number
  /** Hard deadline: when it expires the process is marked timedOut and
   *  tree-killed. Omit for none (a server-managed engine has no deadline). */
  hardTimeoutMs?: number
  readiness?: EngineReadiness
  /** Every parsed stdout/stderr event, in arrival order. */
  onEvent?: (event: EngineEvent) => void
  /** Fired exactly once with the normalized exit summary. */
  onExit?: (summary: EngineExitSummary) => void
}

/** Normalized exit taxonomy. `code`/`signal` come from the child's exit
 *  event; `error` is only present when the process never launched. */
export type EngineExitSummary = {
  code: number | null
  signal: NodeJS.Signals | null
  killedByUs: boolean
  timedOut: boolean
  durationMs: number
  error?: string
}

/** Lifecycle phases this supervisor emits (a subset of the wire contract's
 *  EnginePhase in src/types.ts — 'booting'/'stopping' are server-driven). */
export type EnginePhaseEvent = { name: string; phase: 'starting' | 'ready' | 'stopped' | 'failed'; detail?: string; pid?: number }

// ---------------------------------------------------------------------------
// Module-level seams (wired by createStudioServer; tests wire their own)
// ---------------------------------------------------------------------------

let engineSink: ((event: EnginePhaseEvent) => void) | null = null
/** Deny-all until the server wires its real SSRF guard: readiness probes must
 *  fail closed, never open, when the wiring is missing. */
let urlGuard: (url: string) => boolean = () => false

const liveProcesses = new Set<EngineProcess>()

function emitPhase(event: EnginePhaseEvent): void {
  if (!engineSink) return
  try {
    engineSink(event)
  } catch (error) {
    // The fabric must never take the supervisor down with it.
    logger.debug({ engine: event.name, reason: error instanceof Error ? error.message : String(error) }, 'engine.sink-error')
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Byte-accurate line splitter: splits on \n (stripping a trailing \r), keeps
 *  partial UTF-8 sequences intact across chunk boundaries by buffering bytes,
 *  and flushes an overlong newline-less remainder instead of growing forever. */
class LineSplitter {
  private pending: Buffer = Buffer.alloc(0)
  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer): void {
    let buffer = Buffer.concat([this.pending, chunk])
    let newline = buffer.indexOf(0x0a)
    while (newline >= 0) {
      const line = buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '')
      if (line.length > 0) this.onLine(line)
      buffer = buffer.subarray(newline + 1)
      newline = buffer.indexOf(0x0a)
    }
    this.pending = buffer
    if (this.pending.length > MAX_PENDING_LINE_BYTES) this.flush()
  }

  flush(): void {
    if (this.pending.length === 0) return
    const line = this.pending.toString('utf8').replace(/\r$/, '')
    this.pending = Buffer.alloc(0)
    if (line.length > 0) this.onLine(line)
  }
}

function parseEventLine(line: string): EngineEvent {
  try {
    const parsed: unknown = JSON.parse(line)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as EngineEvent
  } catch {
    // Not a JSON object — wrapped as a raw event below.
  }
  return { level: 'raw', msg: line }
}

/** python / python3 / python3.12 / python.exe / pythonw — by basename only;
 *  the unbuffered contract must not depend on PATH resolution semantics. */
function isPythonCommand(command: string): boolean {
  const name = basename(command).toLowerCase().replace(/\.(exe|com)$/, '')
  return /^python\d*(\.\d+)?$/.test(name) || name === 'pythonw'
}

/** Windows uv/pip shims: .cmd/.bat cannot be spawned directly (EINVAL). */
function isShellShim(command: string): boolean {
  return /\.(cmd|bat)$/i.test(basename(command))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
  if (timer) clearTimeout(timer)
}

function describeExit(summary: EngineExitSummary): string {
  if (summary.error) return summary.error
  if (summary.timedOut) return 'hard timeout expired'
  if (summary.signal) return `killed by ${summary.signal}`
  return `exited with code ${summary.code}`
}

// ---------------------------------------------------------------------------
// EngineProcess
// ---------------------------------------------------------------------------

export class EngineProcess {
  /** Launches a supervised child. Never throws: launch failures surface on
   *  the returned instance as a rejected `ready` promise, an `exited` promise
   *  resolving with `error` set, and a 'failed' phase. */
  static spawn(config: EngineProcessConfig): EngineProcess {
    return new EngineProcess(config)
  }

  /** Stops every live process this module started (graceful, then forced) —
   *  the server's exit path calls this so no sidecar outlives it. */
  static async shutdownAll(): Promise<EngineExitSummary[]> {
    const snapshot = [...liveProcesses]
    const outcomes = await Promise.allSettled(snapshot.map((engine) => engine.gracefulStop()))
    return outcomes.map((outcome) => (
      outcome.status === 'fulfilled'
        ? outcome.value
        : { code: null, signal: null, killedByUs: true, timedOut: false, durationMs: 0, error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) }
    ))
  }

  /** Wires lifecycle-phase emission (core.ts points this at the realtime
   *  hub's engine channel). Call once at server creation. */
  static setEngineSink(sink: (event: EnginePhaseEvent) => void): void {
    engineSink = sink
  }

  /** Wires the SSRF guard applied to http readiness probe URLs. The default
   *  is deny-all: probe URLs are rejected until the server wires its real
   *  local-only check, so supervision fails closed. */
  static setUrlGuard(guard: (url: string) => boolean): void {
    urlGuard = guard
  }

  /** Live supervised processes (telemetry/tests; not a liveness claim about
   *  the child itself). */
  static get liveCount(): number {
    return liveProcesses.size
  }

  private constructor(private readonly config: EngineProcessConfig) {
    this.quitLine = config.gracefulQuitLine ?? DEFAULT_QUIT_LINE
    this.graceTimeoutMs = config.graceTimeoutMs ?? DEFAULT_GRACE_TIMEOUT_MS
    this.startedAt = Date.now()
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = () => {
        if (this.readySettled) return
        this.readySettled = true
        this.readyAchieved = true
        clearTimer(this.readinessTimer)
        this.emitPhasePublic('ready')
        resolve()
      }
      this.rejectReady = (error: Error) => {
        if (this.readySettled) return
        this.readySettled = true
        this.readinessStopped = true
        clearTimer(this.readinessTimer)
        reject(error)
      }
    })
    // The supervisor consumes the promise internally (phase emission), so a
    // caller that never awaits `ready` cannot trip an unhandled rejection.
    void this.ready.catch(() => undefined)
    this.exited = new Promise((resolve) => { this.resolveExited = resolve })
    this.start()
  }

  readonly ready: Promise<void>
  readonly exited: Promise<EngineExitSummary>
  private readonly quitLine: string
  private readonly graceTimeoutMs: number
  private readonly startedAt: number
  // Assigned synchronously inside the promise executors above (which run
  // during construction), hence the definite-assignment assertions.
  private resolveReady!: () => void
  private rejectReady!: (error: Error) => void
  private resolveExited!: (summary: EngineExitSummary) => void

  private child: ChildProcess | null = null
  private stdoutSplitter: LineSplitter | null = null
  private stderrSplitter: LineSplitter | null = null
  private gracefulPromise: Promise<EngineExitSummary> | null = null
  private hardTimer: ReturnType<typeof setTimeout> | null = null
  private readinessTimer: ReturnType<typeof setTimeout> | null = null
  private readinessStopped = false
  private readySettled = false
  private readyAchieved = false
  private failureEmitted = false
  private settled = false
  private killedByUsFlag = false
  private timedOutFlag = false
  private spawnError: string | null = null
  private exitPid: number | null = null

  get name(): string { return this.config.name }
  get pid(): number | null { return this.child?.pid ?? this.exitPid }
  get killedByUs(): boolean { return this.killedByUsFlag }
  get timedOut(): boolean { return this.timedOutFlag }

  // ---- launch ---------------------------------------------------------------

  private start(): void {
    const config = this.config
    const useShell = isShellShim(config.command)
    const args = isPythonCommand(config.command) && config.args[0] !== '-u' ? ['-u', ...config.args] : config.args
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONUNBUFFERED: '1', ...config.env }
    let child: ChildProcess
    try {
      child = spawn(config.command, args, {
        cwd: config.cwd,
        env,
        // POSIX: a new process group so kill(-pid) reaches grandchildren.
        // Windows: no detached (a hidden console of its own buys nothing) —
        // taskkill /T is the tree-kill there.
        detached: process.platform !== 'win32',
        // .cmd/.bat shims need the shell; documented above — taskkill /T
        // covers the cmd.exe wrapper and its grandchildren.
        shell: useShell,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      this.spawnError = error instanceof Error ? error.message : String(error)
      this.settle(null, null)
      return
    }
    this.child = child
    this.exitPid = child.pid ?? null
    liveProcesses.add(this)
    // The exit handler is installed immediately at spawn: it reaps (no
    // zombies), destroys every pipe, and clears every timer — on ALL exit
    // paths, including ones nobody polls for.
    child.on('exit', (code, signal) => this.settle(code, signal))
    child.on('error', (error) => {
      if (this.settled) return // post-exit transport error (e.g. late kill EPERM)
      this.spawnError = error instanceof Error ? error.message : String(error)
      // A failed launch may never emit 'exit'; a transport error after a
      // successful launch still gets one — first settle wins either way.
      this.settle(null, null)
    })
    this.stdoutSplitter = new LineSplitter((line) => this.handleEvent(parseEventLine(line)))
    this.stderrSplitter = new LineSplitter((line) => this.handleEvent(parseEventLine(line)))
    child.stdout?.on('data', (chunk: Buffer) => this.stdoutSplitter?.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => this.stderrSplitter?.push(chunk))

    this.emitPhasePublic('starting', config.command)
    logEvent({ kind: 'engine.spawn', engine: this.name, command: config.command, pid: this.pid ?? undefined, python: isPythonCommand(config.command), shellShim: useShell })

    this.beginReadiness()
    this.beginHardDeadline()
  }

  // ---- readiness --------------------------------------------------------------

  private beginReadiness(): void {
    const readiness = this.config.readiness
    if (!readiness || readiness.type === 'none') {
      this.resolveReady()
      return
    }
    if (readiness.type === 'ndjson') {
      const timeoutMs = readiness.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
      this.readinessTimer = setTimeout(() => {
        const error = new Error(`no matching event within ${Math.round(timeoutMs / 1000)} s`)
        this.fail(error.message)
        this.rejectReady(error)
      }, timeoutMs)
      return
    }
    const probeUrl = readiness.path ? `${readiness.url.replace(/\/+$/, '')}/${readiness.path.replace(/^\/+/, '')}` : readiness.url
    if (!urlGuard(probeUrl)) {
      const error = new Error(`readiness URL rejected (local-only): ${probeUrl}`)
      this.fail(error.message)
      this.rejectReady(error)
      return
    }
    const timeoutMs = readiness.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
    const pollMs = readiness.pollMs ?? DEFAULT_HTTP_POLL_MS
    this.readinessTimer = setTimeout(() => {
      const error = new Error(`HTTP probe did not answer within ${Math.round(timeoutMs / 1000)} s (${probeUrl})`)
      this.fail(error.message)
      this.rejectReady(error)
    }, timeoutMs)
    void this.pollHttp(probeUrl, pollMs)
  }

  /** Any completed HTTP response counts as up (even a 404 — the question is
   *  "is it listening"); connection failures keep polling until the timeout. */
  private async pollHttp(probeUrl: string, pollMs: number): Promise<void> {
    while (!this.readySettled && !this.settled && !this.readinessStopped) {
      const controller = new AbortController()
      const attempt = setTimeout(() => controller.abort(), HTTP_ATTEMPT_TIMEOUT_MS)
      try {
        await fetch(probeUrl, { signal: controller.signal })
        clearTimeout(attempt)
        this.resolveReady()
        return
      } catch {
        clearTimeout(attempt)
        // Not listening yet — keep polling.
      }
      await sleep(pollMs)
    }
  }

  private beginHardDeadline(): void {
    const timeoutMs = this.config.hardTimeoutMs
    if (!timeoutMs || timeoutMs <= 0) return
    this.hardTimer = setTimeout(() => {
      if (this.settled) return
      this.timedOutFlag = true
      logger.warn({ engine: this.name, pid: this.pid ?? undefined, timeoutMs }, 'engine.hard-timeout')
      void this.killTree()
    }, timeoutMs)
  }

  // ---- event fan-out ----------------------------------------------------------

  private handleEvent(event: EngineEvent): void {
    try {
      this.config.onEvent?.(event)
    } catch (error) {
      logger.debug({ engine: this.name, reason: error instanceof Error ? error.message : String(error) }, 'engine.on-event-error')
    }
    // pino seam: raw/info at debug, warn at warn, error/fatal at error —
    // per-event lines stay invisible at the default info level.
    const level = typeof event.level === 'string' ? event.level : ''
    const line = { kind: 'engine', engine: this.name, ...event }
    if (level === 'error' || level === 'fatal') logger.error(line, 'engine')
    else if (level === 'warn') logger.warn(line, 'engine')
    else logger.debug(line, 'engine')

    const readiness = this.config.readiness
    if (readiness?.type === 'ndjson' && !this.readySettled) {
      try {
        if (readiness.match(event)) this.resolveReady()
      } catch (error) {
        logger.debug({ engine: this.name, reason: error instanceof Error ? error.message : String(error) }, 'engine.readiness-matcher-error')
      }
    }
  }

  // ---- stop paths ---------------------------------------------------------------

  /** Graceful: quit line on stdin, grace window, then killTree(). Idempotent;
   *  concurrent calls share one shutdown run. */
  gracefulStop(): Promise<EngineExitSummary> {
    if (this.settled) return this.exited
    if (!this.gracefulPromise) this.gracefulPromise = this.runGracefulStop()
    return this.gracefulPromise
  }

  private async runGracefulStop(): Promise<EngineExitSummary> {
    if (this.settled) return this.exited
    const stdin = this.child?.stdin
    if (stdin?.writable) {
      try {
        stdin.write(`${this.quitLine}\n`)
      } catch (error) {
        // Child died between the writable check and the write — the grace
        // race below still settles via its exit.
        logger.debug({ engine: this.name, reason: error instanceof Error ? error.message : String(error) }, 'engine.quit-write-failed')
      }
    }
    const graceful = await Promise.race([this.exited, sleep(this.graceTimeoutMs).then(() => 'timeout' as const)])
    if (graceful === 'timeout') await this.killTree()
    return this.exited
  }

  /** Tree-kill: POSIX process group SIGTERM then SIGKILL after 3 s; Windows
   *  taskkill /PID <pid> /T /F (kills the whole tree through any cmd.exe
   *  shim wrapper). Safe on an already-dead child. */
  async killTree(): Promise<void> {
    if (this.settled) return
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      // Already gone (the exit event is still in flight) — nothing to signal.
      await Promise.race([this.exited, sleep(KILL_TREE_SETTLE_MS)])
      return
    }
    this.killedByUsFlag = true
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: KILL_TREE_SETTLE_MS }, () => resolve())
      })
      await Promise.race([this.exited, sleep(KILL_TREE_SETTLE_MS)])
      return
    }
    const group = -Number(child.pid)
    try {
      process.kill(group, 'SIGTERM')
    } catch (error) {
      logger.debug({ engine: this.name, reason: error instanceof Error ? error.message : String(error) }, 'engine.sigterm-failed')
    }
    // Escalation watches the GROUP, not the direct child: the child can die
    // on SIGTERM instantly while a grandchild that traps/ignores SIGTERM
    // lingers — keying the escalation on the child's exit would leak it.
    // Signal-0 on the group is exactly "does any member still exist", so a
    // well-behaved tree exits early and an immune one gets the full window.
    const deadline = Date.now() + SIGKILL_ESCALATION_MS
    for (;;) {
      try {
        process.kill(group, 0)
      } catch {
        return // the whole group is gone — SIGTERM sufficed
      }
      if (Date.now() >= deadline) break
      await sleep(100)
    }
    try {
      process.kill(group, 'SIGKILL')
    } catch (error) {
      logger.debug({ engine: this.name, reason: error instanceof Error ? error.message : String(error) }, 'engine.sigkill-failed')
    }
    await Promise.race([this.exited, sleep(KILL_TREE_SETTLE_MS)])
  }

  // ---- exit settlement ----------------------------------------------------------

  private settle(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.settled) return
    this.settled = true
    const summary: EngineExitSummary = {
      code,
      signal,
      killedByUs: this.killedByUsFlag,
      timedOut: this.timedOutFlag,
      durationMs: Date.now() - this.startedAt,
      ...(this.spawnError ? { error: this.spawnError } : {}),
    }
    // Readiness bookkeeping: a process that dies (or never launches) before
    // becoming ready REJECTS — never silently resolves. settle() emits its
    // own terminal phase below, richer than a generic readiness error.
    if (!this.readySettled) {
      this.rejectReady(new Error(`${this.spawnError ? 'failed to launch' : `exited (${describeExit(summary)})`} before becoming ready`))
    }
    this.readinessStopped = true
    clearTimer(this.readinessTimer)
    clearTimer(this.hardTimer)
    // Pipe teardown: flush any newline-less tail line, then destroy all three
    // streams so nothing dangles off the parent event loop.
    this.stdoutSplitter?.flush()
    this.stderrSplitter?.flush()
    for (const stream of [this.child?.stdin, this.child?.stdout, this.child?.stderr]) {
      try {
        stream?.destroy()
      } catch {
        // Already destroyed — nothing to reclaim.
      }
    }
    // Terminal phase semantics: 'stopped' = the end was intentional (clean
    // exit, or a kill WE initiated after the grace window — the engine
    // channel's 'stopped' means "we stopped it", not "it obeyed"); 'failed'
    // = it ended for reasons nobody ordered (never became ready, crashed,
    // or the hard deadline fired on a hung engine).
    if (this.readyAchieved && !this.timedOutFlag && !this.spawnError) this.emitPhasePublic('stopped', describeExit(summary))
    else this.fail(describeExit(summary))
    logEvent({ kind: 'engine.exit', engine: this.name, code: summary.code, signal: summary.signal, killedByUs: summary.killedByUs, timedOut: summary.timedOut, durationMs: summary.durationMs, ...(summary.error ? { error: summary.error } : {}) })
    try {
      this.config.onExit?.(summary)
    } catch (error) {
      logger.debug({ engine: this.name, reason: error instanceof Error ? error.message : String(error) }, 'engine.on-exit-error')
    }
    liveProcesses.delete(this)
    this.resolveExited(summary)
  }

  /** Terminal failure phase (exit-before-ready, readiness timeout, launch
   *  failure). Guarded so at most one 'failed' is emitted per process. */
  private fail(detail: string): void {
    if (this.failureEmitted) return
    this.failureEmitted = true
    this.emitPhasePublic('failed', detail)
  }

  private emitPhasePublic(phase: EnginePhaseEvent['phase'], detail?: string): void {
    emitPhase({ name: this.name, phase, ...(detail ? { detail } : {}), ...(this.pid ? { pid: this.pid } : {}) })
  }
}
