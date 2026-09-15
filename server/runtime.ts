/**
 * RuntimeManager — the self-managed ComfyUI runtime (increment 1 of task
 * 3ay7wbz). Owns spawn/stop/status + boot posture detection for a ComfyUI
 * process the studio launches ITSELF, from a checkout the user nominates
 * (clone-on-demand is a later increment).
 *
 *   supervision   Everything process-shaped delegates to the wave-2c
 *                EngineProcess contract: PYTHONUNBUFFERED + NDJSON line
 *                parsing, POSIX process-group tree-kill / Windows taskkill
 *                /T /F, exit handlers installed at spawn, and registration
 *                in the static registry the server's exit path drains. This
 *                module adds the engine-specific state machine on top:
 *                stopped → starting → running → stopping → (stopped|failed).
 *
 *   stopping      ComfyUI has NO stdin quit protocol and NO clean HTTP
 *                shutdown. gracefulStop() therefore writes the quit line
 *                anyway (ignored, harmless — the contract's grace window is
 *                the courtesy), then escalates to the tree-kill after a 3 s
 *                grace. Every stop path resolves: graceful → escalate → a
 *                failed state WITH a reason if even the escalation could not
 *                reap the tree (never a hang, never a silent skip).
 *
 *   ports         Allocation scans upward from 8191 and hard-skips 8188 and
 *                8189 — the user's live instances (prior art in this repo's
 *                history: an unknown process on a needed port is REPORTED,
 *                never killed; the allocator just takes the next port). Each
 *                candidate is verified free twice before spawn: a TCP bind
 *                probe (is anything listening) and a /system_stats HTTP
 *                probe (is a ComfyUI-shaped thing answering) — the HTTP
 *                probe is the no-double-spawn guarantee.
 *
 *   mirroring     Config mirroring v1 generates extra_model_paths.yaml INTO
 *                the nominated checkout only, pointing at the user's REAL
 *                model roots from settings.paths. Weights are never copied.
 *                Only validated absolute existing directories are emitted —
 *                relative paths, traversal, and nonexistent roots are
 *                rejected. A pre-existing foreign yaml is preserved once as
 *                extra_model_paths.yaml.pre-studio (our rewrites carry a
 *                generated marker and never re-back-up).
 *
 *   boot posture  A state file (<home>/engine/runtime-state.json) records
 *                port/pid/argv/checkout. On boot, reconcile() probes the
 *                recorded port: healthy AND the pid still matches the
 *                recorded signature → ADOPT (no double spawn); healthy but
 *                unverifiable → leave it alone, report, start elsewhere;
 *                dead → clear the record and (when autoStart) start fresh.
 *                Adoption never trusts a bare pid: an adopted stop
 *                re-verifies the process signature (/proc/<pid>/cmdline +
 *                cwd on POSIX, tasklist image name on Windows) before any
 *                signal — a process we cannot verify is never signalled.
 *
 *   health        No free-running interval: /system_stats is sampled lazily
 *                by status() behind a short TTL, mirroring the GPU
 *                telemetry sampler philosophy (nobody asking → no probes).
 *
 * External mode never reaches this module's side effects: core.ts only
 * calls start/stop/reconcile through managed-mode gates, so external is
 * byte-for-byte the pre-runtime behavior.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, readFile, readlink, rename, stat, writeFile } from 'node:fs/promises'
import { createServer as createTcpServer } from 'node:net'
import { basename, isAbsolute, join, normalize, resolve } from 'node:path'
import { EngineProcess, type EngineEvent, type EngineExitSummary } from './engineProcess'
import { logger } from './logger'
import { fetchExtraModelRoots } from './fetchCatalog'
import { resolveActiveProfile } from './engineProfiles'
import { ENGINE_PATCHES, applyEnginePatch, checkEnginePatch, type PatchCheck } from './enginePatch'
import type { AppSettings, EngineLaunchHook, ManagedEngineHealth, ManagedEngineState, ManagedEngineStatus, ModelKind } from '../src/types'

/** The user's live ComfyUI instances — never allocated, never signalled. */
export const RESERVED_ENGINE_PORTS = [8188, 8189]
export const DEFAULT_PORT_SCAN_START = 8191
/** How many candidates the upward scan considers before giving up. */
const PORT_SCAN_SPAN = 100
/** Courtesy window after the (ignored-by-ComfyUI) quit line before the tree-kill. */
const STOP_GRACE_MS = 3_000
/** How long an adopted process gets after SIGTERM before SIGKILL escalation. */
const ADOPTED_STOP_GRACE_MS = 3_000
const ADOPTED_KILL_SETTLE_MS = 3_000
/** Readiness budget: heavy custom-node sets legitimately take a while to boot. */
const DEFAULT_READY_TIMEOUT_MS = 120_000
/** Lazy /system_stats sample TTL while running. */
const HEALTH_SAMPLE_TTL_MS = 5_000
const HTTP_PROBE_TIMEOUT_MS = 500
const LOG_RING_LINES = 400
const LOG_TAIL_LINES = 40
const LOG_ROTATE_BYTES = 2_000_000
const LOG_LINE_MAX_CHARS = 2_000
/** Header line stamped into every yaml we generate (also the ours-vs-foreign marker). */
const YAML_MARKER = '# Generated by MiniMax Studio — managed engine config mirroring.'

/** User-input problems (bad checkout, bad python, no free port) — surfaced as
 *  400s by the routes; everything else is a runtime failure (502). */
export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeConfigError'
  }
}

// ---------------------------------------------------------------------------
// Config mirroring v1 — extra_model_paths.yaml generation (pure + testable)
// ---------------------------------------------------------------------------

/** ComfyUI folder-configuration keys for the studio's model kinds (the
 *  settings keys are already ComfyUI folder names). */
const MODEL_FOLDER_KEYS: Record<ModelKind, string> = {
  diffusion_models: 'diffusion_models',
  text_encoders: 'text_encoders',
  vae: 'vae',
  loras: 'loras',
  vae_approx: 'vae_approx',
  clip_vision: 'clip_vision',
}

/** Validates one configured model root for YAML emission: absolute, free of
 *  traversal after normalization, and present on disk. Returns the resolved
 *  absolute path, or null when the root must NOT be emitted. */
export function validateModelRoot(candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null
  const trimmed = candidate.trim()
  if (!trimmed || !isAbsolute(trimmed)) return null
  const resolved = normalize(resolve(trimmed))
  // resolve() already collapses traversal — a surviving '..' segment means
  // something pathological; refuse rather than emit it.
  if (resolved.split(/[\\/]+/).includes('..')) return null
  return existsSync(resolved) ? resolved : null
}

/** Renders the yaml document. JSON string-escaping is valid YAML
 *  double-quoted-scalar escaping, so Windows backslash paths survive intact. */
export function renderExtraModelPathsYaml(roots: Array<{ key: string; path: string }>): string {
  const lines = [
    YAML_MARKER,
    '# Rewritten on every managed start. A pre-existing foreign file was preserved',
    '# once as extra_model_paths.yaml.pre-studio (first generation only).',
    '# Weights are NEVER copied — these roots are indexed in place.',
  ]
  for (const root of roots) {
    lines.push(`${root.key}:`)
    lines.push(`    - ${JSON.stringify(root.path)}`)
  }
  return `${lines.join('\n')}\n`
}

/** Where the generated yaml lives: INSIDE the nominated checkout, nowhere else. */
export function extraModelPathsTarget(checkoutPath: string): string {
  return join(resolve(checkoutPath), 'extra_model_paths.yaml')
}

export type ExtraModelPathsResult = { written: boolean; roots: string[]; skipped: ModelKind[] }

/** Generates extra_model_paths.yaml into the checkout from settings.paths —
 *  plus the fetcher's extra model roots (model_patches, vdn, …) once they
 *  exist on disk, so fetched weights are visible to the managed instance
 *  without ever copying bytes. Invalid roots are skipped (reported), never
 *  emitted; a foreign existing file is backed up exactly once; the write
 *  itself is tmp+rename atomic. */
export async function writeExtraModelPathsConfig(checkoutPath: string, settings: AppSettings): Promise<ExtraModelPathsResult> {
  const seen = new Set<string>()
  const roots: Array<{ key: string; path: string }> = []
  const skipped: ModelKind[] = []
  for (const kind of Object.keys(MODEL_FOLDER_KEYS) as ModelKind[]) {
    const valid = validateModelRoot(settings.paths[kind])
    if (!valid || seen.has(valid)) {
      if (!valid) skipped.push(kind)
      continue
    }
    seen.add(valid)
    roots.push({ key: MODEL_FOLDER_KEYS[kind], path: valid })
  }
  // Fetcher roots (task hgjbea2): only folders that exist are emitted — an
  // empty configured tree mirrors as nothing until the first fetch creates
  // it. The keys are ComfyUI folder names (yaml loader adds unknown keys).
  // Settings without a usable modelRoot (pre-fetcher fixtures) mirror none.
  if (typeof settings.modelRoot === 'string' && settings.modelRoot.trim()) {
    for (const rootName of fetchExtraModelRoots()) {
      const valid = validateModelRoot(join(settings.modelRoot, rootName))
      if (!valid || seen.has(valid)) continue
      seen.add(valid)
      roots.push({ key: rootName, path: valid })
    }
  }
  if (roots.length === 0) return { written: false, roots: [], skipped }

  const target = extraModelPathsTarget(checkoutPath)
  if (existsSync(target)) {
    const existing = await readFile(target, 'utf8').catch(() => '')
    if (!existing.split(/\r?\n/, 1)[0]?.includes('MiniMax Studio')) {
      // Foreign file: preserve the ORIGINAL once. A backup that already
      // exists is never clobbered by a later foreign file — the first
      // generation remains the user's untouched baseline.
      const backup = `${target}.pre-studio`
      if (!existsSync(backup)) await rename(target, backup).catch(() => undefined)
    }
  }
  const staged = `${target}.studio-tmp`
  await writeFile(staged, renderExtraModelPathsYaml(roots), 'utf8')
  await rename(staged, target)
  return { written: true, roots: roots.map((root) => root.path), skipped }
}

// ---------------------------------------------------------------------------
// Port allocation (pure-ish + testable)
// ---------------------------------------------------------------------------

function tcpPortFree(port: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const probe = createTcpServer()
    const settle = (value: boolean) => { probe.close(() => undefined); resolveProbe(value) }
    probe.once('error', () => settle(false))
    probe.listen(port, '127.0.0.1', () => settle(true))
  })
}

/** Any completed HTTP answer (even an error status) means the port is
 *  occupied by something ComfyUI-shaped enough to respect. */
async function httpPortOccupied(port: number, timeoutMs = HTTP_PROBE_TIMEOUT_MS): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    await fetch(`http://127.0.0.1:${port}/system_stats`, { signal: controller.signal })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** probeSystemStats as a boolean occupancy check with a caller-set timeout. */
export async function probeEngineHealth(port: number, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/system_stats`, { signal: controller.signal })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export type PortAllocationOptions = { startPort?: number; preference?: number; extraReserved?: number[] }

/** Scans upward from startPort (default 8191), hard-skipping the reserved
 *  user ports plus any the ACTIVE PROFILE reserves, requiring BOTH a free
 *  TCP bind AND no HTTP responder on each candidate. A valid preference is
 *  tried first and falls through to the scan when occupied. Returns null
 *  when the span is exhausted. */
export async function allocatePort(options: PortAllocationOptions = {}): Promise<number | null> {
  const startPort = options.startPort ?? DEFAULT_PORT_SCAN_START
  const candidates: number[] = []
  const preference = options.preference ?? 0
  const reserved = new Set([...RESERVED_ENGINE_PORTS, ...(options.extraReserved ?? [])])
  if (Number.isInteger(preference) && preference >= 1024 && preference <= 65535) candidates.push(preference)
  for (let offset = 0; offset < PORT_SCAN_SPAN; offset += 1) candidates.push(startPort + offset)
  for (const candidate of candidates) {
    if (reserved.has(candidate)) continue
    if (candidate < 1024 || candidate > 65535) continue
    if (!(await tcpPortFree(candidate))) continue
    if (await httpPortOccupied(candidate)) continue
    return candidate
  }
  return null
}

// ---------------------------------------------------------------------------
// Adopted-process verification (the never-kill-what-you-cant-verify rule)
// ---------------------------------------------------------------------------

type RuntimeStateFile = {
  version: 1
  port: number
  pid: number
  command: string
  args: string[]
  startedAt: number
  checkout: string
  /** Launch profile the engine was spawned under (boot posture record). */
  profile?: string
}

/** process.kill(pid, 0) liveness probe; EPERM = alive but not ours to signal. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Verifies a recorded pid is still THE managed engine before any signal.
 *  POSIX: /proc/<pid>/cmdline must contain the recorded main script and
 *  --port value (cwd cross-checked best-effort). Windows: the tasklist image
 *  name must match the recorded executable. Anything else — PID reuse, an
 *  unrelated squatter, an unsupported platform — refuses (returns false). */
async function verifyAdoptedProcess(record: RuntimeStateFile): Promise<boolean> {
  if (!isAlive(record.pid)) return false
  if (process.platform === 'win32') {
    const expected = basename(record.command).toLowerCase().replace(/\.(exe|com)$/, '')
    return await new Promise<boolean>((resolveVerify) => {
      execFile('tasklist', ['/FI', `PID eq ${record.pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5_000 }, (error, stdout) => {
        if (error) return resolveVerify(false)
        const image = String(stdout).split(',', 2)[0]?.replace(/^"|"$/g, '') ?? ''
        resolveVerify(image.toLowerCase().replace(/\.(exe|com)$/, '') === expected)
      })
    })
  }
  if (process.platform !== 'linux') return false // darwin has no /proc: refuse rather than guess
  try {
    const cmdline = (await readFile(`/proc/${record.pid}/cmdline`, 'utf8')).replace(/\0/g, ' ')
    const script = basename(record.args[0] ?? '')
    const portToken = String(record.port)
    if (!script || !cmdline.includes(script) || !cmdline.includes(portToken)) return false
    // cwd is corroborating evidence only: a moved/renamed checkout must not
    // block stopping an engine we can identify by argv.
    const cwd = await readlink(`/proc/${record.pid}/cwd`).catch(() => null)
    if (cwd && record.checkout && resolve(cwd) !== resolve(record.checkout)) {
      logger.debug({ pid: record.pid, cwd, checkout: record.checkout }, 'runtime.adopted-cwd-mismatch')
    }
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// RuntimeManager
// ---------------------------------------------------------------------------

export type RuntimeManagerOptions = {
  homeDirectory: string
  loadSettings: () => Promise<AppSettings>
  logEvent: (event: { kind: string } & Record<string, unknown>) => void
  logFailure: (stage: string, error: unknown, context?: Record<string, string | number | boolean>, level?: 'fatal' | 'error' | 'warn' | 'debug') => void
  isLocalServiceUrl: (url: string) => boolean
  /** Fired each time a managed engine becomes ready (spawned or adopted) —
   *  core.ts re-points settings.comfyUrl at the managed instance. */
  onRunning?: (url: string, port: number) => void | Promise<void>
  /** Readiness budget override (tests). */
  readyTimeoutMs?: number
  /** Scan start override (tests; production: 8191). */
  startPort?: number
}

type RuntimeSnapshot = {
  state: ManagedEngineState
  /** Launch profile the live process runs under (set at spawn/adopt — a
   *  settings change never rewrites what a running engine was launched
   *  with). Absent while stopped. */
  profile?: string
  port?: number
  pid?: number
  adopted?: boolean
  stray?: boolean
  startedAt?: number
  lastError?: string
  warning?: string
  /** Patch-tier posture from the last launch decision (layout + gate per
   *  patch; refreshed on every start attempt, cached between them). */
  patches?: PatchCheck[]
}

export class RuntimeManager {
  private readonly engineDirectory: string
  private readonly stateFilePath: string
  private readonly logFilePath: string
  private snapshot: RuntimeSnapshot = { state: 'stopped' }
  private engine: EngineProcess | null = null
  private adoptedRecord: RuntimeStateFile | null = null
  private stopIntentional = false
  private startInFlight: Promise<{ status: ManagedEngineStatus; already: boolean }> | null = null
  private stopInFlight: Promise<ManagedEngineStatus> | null = null
  private healthSample: { at: number; value: ManagedEngineHealth } | null = null
  private readonly logRing: string[] = []
  private logBytesWritten = -1

  constructor(private readonly options: RuntimeManagerOptions) {
    this.engineDirectory = join(options.homeDirectory, 'engine')
    this.stateFilePath = join(this.engineDirectory, 'runtime-state.json')
    this.logFilePath = join(this.engineDirectory, 'logs', 'managed-engine.log')
  }

  // ---- status ---------------------------------------------------------------

  /** Snapshot + lazy /system_stats sample. Safe to call as often as liked:
   *  while not running it answers from memory, and while running probes at
   *  most once per HEALTH_SAMPLE_TTL_MS. */
  async status(): Promise<ManagedEngineStatus> {
    const settings = await this.options.loadSettings()
    let health: ManagedEngineHealth = 'unknown'
    if (this.snapshot.state === 'running' && this.snapshot.port) {
      if (!this.healthSample || Date.now() - this.healthSample.at > HEALTH_SAMPLE_TTL_MS) {
        const ok = await probeEngineHealth(this.snapshot.port, 1_500)
        this.healthSample = { at: Date.now(), value: ok ? 'ok' : 'unreachable' }
      }
      health = this.healthSample.value
      // An ADOPTED engine has no exit handler in this process — a health
      // failure plus a dead pid is the honest moment to mark it failed.
      if (health === 'unreachable' && this.adoptedRecord && !isAlive(this.adoptedRecord.pid)) {
        this.adoptedRecord = null
        this.snapshot = { ...this.snapshot, state: 'failed', pid: undefined, lastError: 'the adopted engine is no longer running' }
        await this.removeStateFile()
      }
    }
    const { state, port, pid, adopted, stray, startedAt, lastError, warning, profile, patches } = this.snapshot
    return {
      mode: settings.engine.mode,
      state,
      ...(profile ? { profile } : {}),
      ...(port ? { port, url: `http://127.0.0.1:${port}` } : {}),
      ...(pid ? { pid } : {}),
      ...(adopted ? { adopted } : {}),
      ...(stray ? { stray } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(lastError ? { lastError } : {}),
      ...(warning ? { warning } : {}),
      ...(patches ? { patches } : {}),
      health,
      logTail: this.logRing.slice(-LOG_TAIL_LINES),
    }
  }

  // ---- start ----------------------------------------------------------------

  /** Idempotent-ish launch. Concurrent calls single-flight; a call while
   *  starting/running reports `already: true` WITHOUT a second spawn (the
   *  allocated port is re-probed by the in-flight start only). Config
   *  problems throw RuntimeConfigError; failure to become ready throws after
   *  the failed engine is reaped. */
  start(): Promise<{ status: ManagedEngineStatus; already: boolean }> {
    if (this.startInFlight) return this.startInFlight
    if (this.stopInFlight) {
      this.startInFlight = this.stopInFlight.then(() => this.runStart()).finally(() => { this.startInFlight = null })
      return this.startInFlight
    }
    this.startInFlight = this.runStart().finally(() => { this.startInFlight = null })
    return this.startInFlight
  }

  private async runStart(): Promise<{ status: ManagedEngineStatus; already: boolean }> {
    if (this.snapshot.state === 'running' || this.snapshot.state === 'starting') {
      return { status: await this.status(), already: true }
    }
    const settings = await this.options.loadSettings()
    const checkout = this.validateCheckout(settings)
    const command = this.resolveCommand(settings)

    // Launch profile (increment 2): env injection + pre-launch hook steps +
    // port policy. Resolution problems degrade to the default profile WITH a
    // warning — a typo never produces a silently stock launch, and dropped
    // env keys are named, never silent.
    const resolved = resolveActiveProfile(settings)
    const warnings: string[] = this.snapshot.warning ? [this.snapshot.warning] : []
    if (resolved.warning) warnings.push(resolved.warning)
    for (const key of resolved.droppedEnv) warnings.push(`Launch-profile env var "${key}" was dropped (forbidden or malformed name).`)

    // Pre-launch hook steps (the consent-patch tier) run BEFORE the port is
    // taken: their outcomes are part of the launch posture.
    const patchChecks = await this.runLaunchHooks(resolved.profile.hooks, settings, checkout, command, warnings)

    const port = await allocatePort({ startPort: this.options.startPort, preference: settings.engine.portPreference, extraReserved: resolved.profile.portPolicy.reserve })
    if (port === null) {
      this.snapshot = { state: 'failed', lastError: `No free port found scanning ${this.options.startPort ?? DEFAULT_PORT_SCAN_START}+ (reserved: ${RESERVED_ENGINE_PORTS.join(', ')}).` }
      throw new RuntimeConfigError(this.snapshot.lastError!)
    }

    // Config mirroring v1 + the VRAM warning are both BEST-EFFORT with
    // honest reporting: neither may block or fail the launch, but neither
    // may fail silently either — both land in status.warning. A warning the
    // PREVIOUS snapshot carried (e.g. the boot squatter note) survives the
    // restart attempt instead of being wiped by it.
    try {
      const mirrored = await writeExtraModelPathsConfig(checkout, settings)
      if (!mirrored.written) warnings.push(`extra_model_paths.yaml not regenerated: no valid model roots (${mirrored.skipped.join(', ') || 'none configured'}).`)
    } catch (mirrorFailure) {
      this.options.logFailure('engine/mirror-config', mirrorFailure, { checkout: basename(checkout) }, 'warn')
      warnings.push('extra_model_paths.yaml could not be written; the managed engine uses its own model folders.')
    }
    const contention = await this.checkExternalLoad(settings, port)
    if (contention) warnings.push(contention)

    this.snapshot = { state: 'starting', profile: resolved.id, patches: patchChecks, port, startedAt: Date.now(), ...(warnings.length ? { warning: warnings.join(' ') } : {}) }
    this.adoptedRecord = null
    this.recordLogLine(`studio: launching managed engine on port ${port} from ${checkout} (profile: ${resolved.id})`)

    const args = ['main.py', '--listen', '127.0.0.1', '--port', String(port), '--disable-auto-launch']
    this.stopIntentional = false
    const engine = EngineProcess.spawn({
      command,
      args,
      cwd: checkout,
      name: 'comfyui-managed',
      graceTimeoutMs: STOP_GRACE_MS,
      env: resolved.profile.env,
      readiness: { type: 'http', url: `http://127.0.0.1:${port}`, path: 'system_stats', timeoutMs: this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS, pollMs: 500 },
      onEvent: (event) => this.recordLogEvent(event),
      onExit: (summary) => this.handleExit(summary),
    })
    this.engine = engine
    this.options.logEvent({ kind: 'runtime.start', port, checkout, command, pid: engine.pid ?? undefined })

    try {
      await engine.ready
    } catch (readyFailure) {
      // Exit-before-ready, launch error, or readiness timeout. The first two
      // leave nothing to reap (handleExit has usually already fired and
      // nulled this.engine — hence the captured local); a readiness TIMEOUT
      // leaves a live-but-useless engine that must NOT outlive the attempt.
      // The failed state is set BEFORE the reap so the exit maps to it, not
      // to an ordered 'stopped'.
      const reason = readyFailure instanceof Error ? readyFailure.message : String(readyFailure)
      this.snapshot = { ...this.snapshot, state: 'failed', lastError: reason, ...(engine.pid !== null ? { pid: engine.pid } : {}) }
      this.stopIntentional = true
      await engine.gracefulStop().catch(() => undefined)
      throw new Error(`The managed engine did not become ready: ${reason}`)
    }

    // Race guard: the engine can die in the instant between `ready` settling
    // and this assignment — handleExit then owns the terminal state and this
    // start must report failure instead of overwriting it with 'running'.
    if (this.snapshot.state !== 'starting') {
      throw new Error(`The managed engine did not become ready: ${this.snapshot.lastError ?? 'it exited immediately after becoming ready'}`)
    }
    this.snapshot = { ...this.snapshot, state: 'running', pid: engine.pid ?? undefined }
    await this.writeStateFile({
      version: 1, port, pid: engine.pid ?? 0, command, args, startedAt: this.snapshot.startedAt ?? Date.now(), checkout, profile: resolved.id,
    })
    this.healthSample = null
    this.options.logEvent({ kind: 'runtime.ready', port, pid: engine.pid ?? undefined })
    try {
      await this.options.onRunning?.(`http://127.0.0.1:${port}`, port)
    } catch (callbackFailure) {
      this.options.logFailure('runtime/on-running', callbackFailure, undefined, 'debug')
    }
    return { status: await this.status(), already: false }
  }

  /** The nominated checkout is USER INPUT: absolute, existing directory that
   *  actually contains a ComfyUI main.py — validated before any spawn. */
  private validateCheckout(settings: AppSettings): string {
    const configured = settings.engine.checkoutPath.trim()
    if (!configured) throw new RuntimeConfigError('Set the ComfyUI checkout path in Settings before launching the managed engine.')
    const checkout = resolve(configured)
    if (!isAbsolute(checkout) || checkout.split(/[\\/]+/).includes('..')) throw new RuntimeConfigError(`The checkout path must be absolute: "${configured}".`)
    if (!existsSync(checkout)) throw new RuntimeConfigError(`The ComfyUI checkout does not exist: "${checkout}".`)
    if (!existsSync(join(checkout, 'main.py'))) throw new RuntimeConfigError(`"${checkout}" does not look like a ComfyUI checkout (main.py is missing).`)
    return checkout
  }

  /** Configured python executable, or the platform default when left blank.
   *  Absolute values are existence-checked for a better error than ENOENT;
   *  bare names are PATH lookups the spawn itself will validate. */
  private resolveCommand(settings: AppSettings): string {
    const configured = settings.engine.pythonPath.trim()
    const command = configured || (process.platform === 'win32' ? 'python' : 'python3')
    if (command.includes('/') || command.includes('\\')) {
      if (!existsSync(command)) throw new RuntimeConfigError(`The python executable does not exist: "${command}".`)
    }
    return command
  }

  /** Pre-launch hook steps (increment 2: the consent-patch tier). Each hook
   *  is best-effort with honest reporting — a refused or failed patch
   *  DEGRADES (the engine launches unpatched; VDN still works without
   *  LongCache), never blocks a launch, and never fails silently. Consent
   *  is checked HERE, before anything touches a file: no consent record
   *  means no apply, full stop. Returns the patch posture for the snapshot
   *  (layout + version gate + backup state per patch). */
  private async runLaunchHooks(hooks: EngineLaunchHook[], settings: AppSettings, checkout: string, pythonCommand: string, warnings: string[]): Promise<PatchCheck[]> {
    const posture: PatchCheck[] = []
    const consentLedger = settings.engine.patches ?? {}
    for (const hook of hooks) {
      if (hook.kind !== 'patch') continue
      const patch = ENGINE_PATCHES.find((candidate) => candidate.id === hook.patchId)
      if (!patch) {
        warnings.push(`Launch hook "${hook.patchId}" is not a known patch — skipped.`)
        continue
      }
      const consent = consentLedger[patch.id]
      let check: PatchCheck
      try {
        check = await checkEnginePatch(patch, checkout, settings.testedComfyVersion)
      } catch (checkFailure) {
        // Even a patch CHECK failing (unreadable target, permissions) must
        // degrade, not block: warn + launch unpatched.
        warnings.push(`${patch.label}: could not inspect the target (${checkFailure instanceof Error ? checkFailure.message : String(checkFailure)}) — not applied (${patch.degradesTo}).`)
        continue
      }
      posture.push(check)
      if (!consent?.consented) {
        warnings.push(`${patch.label}: consent not given — not applied (${patch.degradesTo}).`)
        this.recordLogLine(`studio: patch ${patch.id} skipped (no consent recorded)`)
        continue
      }
      if (check.layout === 'missing') {
        warnings.push(`${patch.label}: the target file is absent from this checkout — not applied (${patch.degradesTo}).`)
        continue
      }
      if (check.layout === 'patched') {
        this.recordLogLine(`studio: patch ${patch.id} already present`)
        continue
      }
      if (!check.versionGate.ok) {
        const version = check.versionGate.version ?? 'unknown'
        warnings.push(`${patch.label}: ComfyUI ${version} is outside the verified set (${patch.testedComfyVersions.join(', ')}) — not applied (${patch.degradesTo}).`)
        this.recordLogLine(`studio: patch ${patch.id} refused by the version gate (ComfyUI ${version})`)
        continue
      }
      if (check.layout === 'unknown') {
        warnings.push(`${patch.label}: the block-loop layout in this checkout is not recognized — refused, no file was changed (${patch.degradesTo}).`)
        this.recordLogLine(`studio: patch ${patch.id} refused (unrecognized layout; no file was changed)`)
        continue
      }
      try {
        const applied = await applyEnginePatch(patch, checkout, { pythonCommand })
        if (applied.applied) {
          this.recordLogLine(`studio: patch ${patch.id} applied (validated: ${applied.validation}${applied.backup ? `, backup ${basename(applied.backup)}` : ''})`)
          this.options.logEvent({ kind: 'runtime.patch-applied', patch: patch.id, validation: applied.validation })
        } else if (applied.already) {
          this.recordLogLine(`studio: patch ${patch.id} already present`)
        } else {
          warnings.push(`${patch.label}: ${applied.reason ?? 'not applied'} (${patch.degradesTo}).`)
        }
      } catch (patchFailure) {
        warnings.push(`${patch.label}: apply failed (${patchFailure instanceof Error ? patchFailure.message : String(patchFailure)}) — not applied (${patch.degradesTo}).`)
        this.options.logFailure('runtime/patch-apply', patchFailure, { patch: patch.id }, 'warn')
      }
    }
    return posture
  }

  /** Best-effort VRAM contention note (never a block): any OTHER local
   *  ComfyUI (the configured external URL + the reserved user ports) with
   *  jobs in its queue produces a warning string. All failures are silent —
   *  this is advisory only. */
  private async checkExternalLoad(settings: AppSettings, managedPort: number): Promise<string | null> {
    const candidates = new Set<string>()
    for (const url of [settings.comfyUrl, ...RESERVED_ENGINE_PORTS.map((port) => `http://127.0.0.1:${port}`)]) {
      const trimmed = url.trim().replace(/\/+$/, '')
      if (trimmed && trimmed !== `http://127.0.0.1:${managedPort}` && this.options.isLocalServiceUrl(trimmed)) candidates.add(trimmed)
    }
    const busy = await Promise.all([...candidates].map(async (url) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 1_200)
      try {
        const response = await fetch(`${url}/queue`, { signal: controller.signal })
        if (!response.ok) return null
        const queue = await response.json() as { queue_running?: unknown[]; queue_pending?: unknown[] }
        const depth = (queue.queue_running?.length ?? 0) + (queue.queue_pending?.length ?? 0)
        return depth > 0 ? `${url} has ${depth} job${depth === 1 ? '' : 's'} in flight` : null
      } catch {
        return null
      } finally {
        clearTimeout(timer)
      }
    }))
    const noted = busy.filter((entry): entry is string => entry !== null)
    return noted.length ? `VRAM contention likely — ${noted.join('; ')}.` : null
  }

  // ---- stop -----------------------------------------------------------------

  /** Idempotent stop. Spawned: graceful-then-tree-kill via EngineProcess.
   *  Adopted: verify-then-signal (SIGTERM→SIGKILL / taskkill /T /F). All
   *  paths resolve; an unverifiable or unkillable adopted process resolves
   *  failed WITH the reason instead of hanging or guessing. */
  stop(): Promise<ManagedEngineStatus> {
    if (this.stopInFlight) return this.stopInFlight
    this.stopInFlight = this.runStop().finally(() => { this.stopInFlight = null })
    return this.stopInFlight
  }

  private async runStop(): Promise<ManagedEngineStatus> {
    if (this.snapshot.state === 'stopped') return this.status()
    if (this.snapshot.state === 'stopping') return this.status()
    if (this.startInFlight) {
      // A concurrent start is mid-spawn; let it settle first so we stop the
      // real engine instead of racing a spawn we would then leak.
      await this.startInFlight.catch(() => undefined)
    }
    if (!this.engine && !this.adoptedRecord) {
      this.snapshot = { ...this.snapshot, state: 'stopped' }
      await this.removeStateFile()
      return this.status()
    }
    this.snapshot = { ...this.snapshot, state: 'stopping' }
    this.recordLogLine('studio: stopping managed engine')
    if (this.engine) {
      await this.stopEngineProcess('user-stop')
    } else if (this.adoptedRecord) {
      const record = this.adoptedRecord
      this.adoptedRecord = null
      try {
        await this.stopAdopted(record)
        this.snapshot = { ...this.snapshot, state: 'stopped', pid: undefined }
        this.options.logEvent({ kind: 'runtime.stopped', port: record.port, adopted: true })
      } catch (stopFailure) {
        const reason = stopFailure instanceof Error ? stopFailure.message : String(stopFailure)
        this.snapshot = { ...this.snapshot, state: 'failed', lastError: `stop failed: ${reason}` }
        this.options.logFailure('runtime/stop-adopted', stopFailure, { pid: record.pid }, 'warn')
      }
    }
    await this.removeStateFile()
    return this.status()
  }

  /** Shared reaper for OUR spawned process: marks the exit intentional (so
   *  handleExit maps it to 'stopped', not 'failed') and waits for the
   *  contract's full graceful→escalate sequence, which always resolves. */
  private async stopEngineProcess(reason: 'user-stop' | 'start-failure' | 'server-shutdown'): Promise<void> {
    const engine = this.engine
    if (!engine) return
    this.stopIntentional = true
    const summary = await engine.gracefulStop()
    if (reason !== 'server-shutdown') {
      this.engine = null
      this.snapshot = { ...this.snapshot, pid: undefined }
      this.options.logEvent({ kind: 'runtime.stopped', reason, code: summary.code, signal: summary.signal ?? undefined, killedByUs: summary.killedByUs })
    }
  }

  /** Signals a process this manager did NOT spawn — ONLY after the recorded
   *  signature re-verifies. POSIX signals the pid directly (SIGTERM, then
   *  SIGKILL); Windows taskkills the tree. Anything unverifiable throws
   *  before any signal leaves this process. */
  private async stopAdopted(record: RuntimeStateFile): Promise<void> {
    if (!isAlive(record.pid)) return
    const verified = await verifyAdoptedProcess(record)
    if (!verified) {
      throw new Error(`pid ${record.pid} no longer matches the recorded managed engine — it was NOT signalled`)
    }
    if (process.platform === 'win32') {
      await new Promise<void>((resolveKill) => {
        execFile('taskkill', ['/PID', String(record.pid), '/T', '/F'], { windowsHide: true, timeout: ADOPTED_KILL_SETTLE_MS * 2 }, () => resolveKill())
      })
      await this.waitForDeath(record.pid, ADOPTED_KILL_SETTLE_MS)
      if (isAlive(record.pid)) throw new Error(`taskkill did not reap pid ${record.pid}`)
      return
    }
    process.kill(record.pid, 'SIGTERM')
    if (await this.waitForDeath(record.pid, ADOPTED_STOP_GRACE_MS)) return
    process.kill(record.pid, 'SIGKILL')
    if (await this.waitForDeath(record.pid, ADOPTED_KILL_SETTLE_MS)) return
    throw new Error(`pid ${record.pid} survived SIGTERM and SIGKILL`)
  }

  private async waitForDeath(pid: number, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      if (!isAlive(pid)) return true
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 100))
    }
    return !isAlive(pid)
  }

  // ---- exit handling + shutdown ----------------------------------------------

  private handleExit(summary: EngineExitSummary): void {
    const intentional = this.stopIntentional || this.snapshot.state === 'stopping'
    const alreadyFailed = this.snapshot.state === 'failed'
    this.engine = null
    if (alreadyFailed) {
      // runStart's failure path set the state + reason BEFORE reaping; the
      // exit is the expected bookkeeping tail, not new information.
      this.snapshot = { ...this.snapshot, pid: undefined }
    } else if (intentional) {
      // Ordered by us (user stop, server shutdown): 'stopped' is the honest
      // terminal state even when the tree-kill did the work — the engine
      // channel's 'stopped' means "we stopped it".
      this.snapshot = { ...this.snapshot, state: 'stopped', pid: undefined }
    } else {
      const reason = summary.error ?? (summary.signal ? `killed by ${summary.signal}` : `exited with code ${summary.code}`)
      this.snapshot = { ...this.snapshot, state: 'failed', pid: undefined, lastError: this.snapshot.state === 'starting' ? `${reason} (before becoming ready)` : reason }
      this.options.logFailure('runtime/unexpected-exit', new Error(reason), summary.code !== null ? { code: summary.code } : undefined, 'warn')
    }
    this.stopIntentional = false
    void this.removeStateFile()
  }

  /** Server exit path (core.stopLanServer): marks the pending shutdown
   *  intentional BEFORE EngineProcess.shutdownAll() fires the exits, so the
   *  state lands on 'stopped' and the state file is cleared. An ADOPTED
   *  engine is not in EngineProcess's registry — it gets the same
   *  verify-then-signal stop here (fire-and-forget: the signals leave
   *  immediately; the reap polling may not outlive the process). */
  prepareForShutdown(): void {
    if (this.snapshot.state === 'running' || this.snapshot.state === 'starting') {
      this.stopIntentional = true
      this.snapshot = { ...this.snapshot, state: 'stopping' }
    }
    const adopted = this.adoptedRecord
    this.adoptedRecord = null
    if (adopted) {
      void this.stopAdopted(adopted).catch((error: unknown) => {
        this.options.logFailure('runtime/shutdown-adopted', error, { pid: adopted.pid }, 'warn')
      })
    }
    void this.removeStateFile()
  }

  // ---- boot posture -----------------------------------------------------------

  /** Boot reconcile: if the recorded managed instance is healthy on its port
   *  AND still verifiably that process → adopt (no double spawn). Healthy
   *  but unverifiable → untouched + reported (start elsewhere when
   *  autoStart). Dead → clear the record; fresh start when autoStart. */
  async reconcileOnBoot(): Promise<void> {
    if (this.snapshot.state === 'running' || this.snapshot.state === 'starting' || this.stopInFlight) return
    const settings = await this.options.loadSettings()
    const record = await this.readStateFile()
    if (!record) {
      if (settings.engine.mode === 'managed' && settings.engine.autoStart) {
        await this.start().catch((error: unknown) => {
          this.options.logFailure('runtime/boot-start', error, undefined, 'warn')
        })
      }
      return
    }
    const healthy = await probeEngineHealth(record.port, 1_500)
    if (healthy && await verifyAdoptedProcess(record)) {
      this.adoptedRecord = record
      this.snapshot = {
        state: 'running',
        ...(record.profile ? { profile: record.profile } : {}),
        port: record.port,
        pid: record.pid,
        adopted: true,
        stray: settings.engine.mode !== 'managed',
        startedAt: record.startedAt,
      }
      this.healthSample = null
      this.recordLogLine(`studio: adopted running managed engine on port ${record.port} (pid ${record.pid})`)
      this.options.logEvent({ kind: 'runtime.adopted', port: record.port, pid: record.pid, stray: this.snapshot.stray })
      if (!this.snapshot.stray) {
        try {
          await this.options.onRunning?.(`http://127.0.0.1:${record.port}`, record.port)
        } catch (callbackFailure) {
          this.options.logFailure('runtime/on-running', callbackFailure, undefined, 'debug')
        }
      }
      return
    }
    // Unusable record: clear it. A healthy-but-unverifiable responder on the
    // recorded port is somebody ELSE'S process — reported, never touched.
    if (healthy) {
      this.snapshot = { state: 'stopped', warning: `Port ${record.port} is held by an unknown process — it was not adopted and not signalled.` }
      this.options.logEvent({ kind: 'runtime.boot-squatter', port: record.port })
    } else {
      this.snapshot = { state: 'stopped' }
    }
    await this.removeStateFile()
    if (settings.engine.mode === 'managed' && settings.engine.autoStart) {
      await this.start().catch((error: unknown) => {
        this.options.logFailure('runtime/boot-start', error, undefined, 'warn')
      })
    }
  }

  // ---- logging + state file -----------------------------------------------------

  private recordLogEvent(event: EngineEvent): void {
    const level = typeof event.level === 'string' && event.level ? event.level : 'raw'
    const extras: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(event)) {
      if (key !== 'level' && key !== 'msg') extras[key] = value
    }
    const extraText = Object.keys(extras).length ? ` ${JSON.stringify(extras)}` : ''
    const message = typeof event.msg === 'string' && event.msg ? event.msg : JSON.stringify(event)
    this.recordLogLine(`${level}: ${message}${extraText}`)
  }

  private recordLogLine(line: string): void {
    const stamped = `${new Date().toISOString()} ${line.slice(0, LOG_LINE_MAX_CHARS)}`
    this.logRing.push(stamped)
    if (this.logRing.length > LOG_RING_LINES) this.logRing.splice(0, this.logRing.length - LOG_RING_LINES)
    void this.appendLogLine(stamped)
  }

  /** Ring-buffer-to-disk: every line appends to the managed log; past
   *  LOG_ROTATE_BYTES the file rotates to .1 (one generation kept) so the
   *  on-disk tail is bounded without unbounded growth. */
  private async appendLogLine(line: string): Promise<void> {
    try {
      if (this.logBytesWritten < 0) {
        await mkdir(join(this.engineDirectory, 'logs'), { recursive: true })
        this.logBytesWritten = (await stat(this.logFilePath).catch(() => null))?.size ?? 0
      }
      const payload = `${line}\n`
      if (this.logBytesWritten + payload.length > LOG_ROTATE_BYTES) {
        await rename(this.logFilePath, `${this.logFilePath}.1`).catch(() => undefined)
        this.logBytesWritten = 0
      }
      await appendFile(this.logFilePath, payload, 'utf8')
      this.logBytesWritten += payload.length
    } catch (error) {
      logger.debug({ reason: error instanceof Error ? error.message : String(error) }, 'runtime.log-append-failed')
    }
  }

  private async readStateFile(): Promise<RuntimeStateFile | null> {
    try {
      const raw = JSON.parse(await readFile(this.stateFilePath, 'utf8')) as RuntimeStateFile
      if (raw && raw.version === 1 && Number.isInteger(raw.port) && Number.isInteger(raw.pid) && typeof raw.checkout === 'string') return raw
    } catch { /* absent or corrupt: no recorded posture */ }
    return null
  }

  private async writeStateFile(record: RuntimeStateFile): Promise<void> {
    try {
      await mkdir(this.engineDirectory, { recursive: true })
      const staged = `${this.stateFilePath}.tmp`
      await writeFile(staged, JSON.stringify(record, null, 2), 'utf8')
      await rename(staged, this.stateFilePath)
    } catch (error) {
      this.options.logFailure('runtime/state-write', error, undefined, 'warn')
    }
  }

  private async removeStateFile(): Promise<void> {
    try {
      if (existsSync(this.stateFilePath)) await rename(this.stateFilePath, `${this.stateFilePath}.last`).catch(() => undefined)
    } catch { /* nothing recorded */ }
  }
}
