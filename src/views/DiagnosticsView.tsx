/** The Diagnostics view — the in-app surface of the PII-scrubbed diagnostics
 *  doctrine. Everything a user might paste into an issue lives here, and it
 *  is scrubbed BY CONSTRUCTION: the report blob is built from structured
 *  fields only (versions, states, counts, node ids/classes, sanitized
 *  reasons) by the pure builder in lib/diagnosticReport, which routes every
 *  free-text fragment through the shared sanitizer.
 *
 *  Self-contained by design: every input comes from the shared zustand
 *  stores or local pure modules — no App-level prop plumbing — so the
 *  component can be docked anywhere (it must survive into the canvas
 *  redesign as a tool panel). No telemetry, no network beyond this app's
 *  own server (the local doctor + engine-status routes); the report stays
 *  on the machine until the user copies or saves it. */
import { useEffect, useMemo, useState } from 'react'
import { Activity, AlertCircle, Check, ClipboardCopy, Download, LoaderCircle, RefreshCw, ShieldCheck, Stethoscope } from 'lucide-react'
import type { ModelKind } from '../types'
import { buildDiagnosticReport, runSanitizerSelfTest, type ReportFailure } from '../lib/diagnosticReport'
import { classifyFailure } from '../lib/failureTaxonomy'
import { sanitizeErrorMessage } from '../lib/logSanitize'
import type { DoctorReport } from '../lib/doctor'
import { formatBytes } from '../lib/format'
import { useSessionStore } from '../state/sessionStore'
import { useJobsStore } from '../state/jobsStore'

const MODEL_KINDS: ModelKind[] = ['diffusion_models', 'text_encoders', 'vae', 'loras', 'vae_approx', 'clip_vision']

/** Copies text with a graceful fallback for contexts without the async
 *  clipboard (insecure origins, embedded webviews). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const helper = document.createElement('textarea')
      helper.value = text
      helper.setAttribute('readonly', '')
      helper.style.position = 'fixed'
      helper.style.opacity = '0'
      document.body.appendChild(helper)
      helper.select()
      const ok = document.execCommand('copy')
      helper.remove()
      return ok
    } catch {
      return false
    }
  }
}

/** Saves text as a local file download — no server round trip. */
function saveTextFile(text: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function osPlatform(): string {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } }
  return nav.userAgentData?.platform ?? nav.platform ?? 'unknown'
}

/** Recovers the structural node reference from a job error line produced by
 *  the failure-capture chain ("ComfyUI failed at node 84 (VAEDecodeTiled)…"). */
function nodeFromError(error: string | undefined): string | undefined {
  if (!error) return undefined
  const match = /node (\S+) \(([^)]+)\)/.exec(error)
  return match ? `${match[1]} (${match[2]})` : undefined
}

export function DiagnosticsView() {
  const settings = useSessionStore((state) => state.settings)
  const status = useSessionStore((state) => state.status)
  const models = useSessionStore((state) => state.models)
  const engineRuntime = useSessionStore((state) => state.engineRuntime)
  const jobs = useJobsStore((state) => state.jobs)

  const [doctor, setDoctor] = useState<DoctorReport | null>(null)
  const [doctorRunning, setDoctorRunning] = useState(false)
  const [selfTest] = useState(() => runSanitizerSelfTest())
  const [generatedAt, setGeneratedAt] = useState(() => Date.now())
  const [actionNote, setActionNote] = useState<string | null>(null)

  const runDoctor = async () => {
    setDoctorRunning(true)
    try {
      setDoctor(await window.minimax.runSetupDoctor())
      setActionNote(null)
    } catch (error) {
      setDoctor({ checks: [{ id: 'error', label: 'Doctor failed', status: 'fail', detail: error instanceof Error ? error.message : String(error) }], ranAt: Date.now() })
    } finally {
      setDoctorRunning(false)
    }
  }
  useEffect(() => { void runDoctor() }, [])

  useEffect(() => {
    if (!actionNote) return
    const timer = window.setTimeout(() => setActionNote(null), 4000)
    return () => window.clearTimeout(timer)
  }, [actionNote])

  const failedJobs = useMemo(() => jobs.filter((job) => job.status === 'failed'), [jobs])
  const histogram = useMemo(() => {
    const counts = new Map<string, number>()
    for (let index = 0; index < failedJobs.length; index += 1) {
      const bucket = classifyFailure(`${failedJobs[index].error ?? ''} ${nodeFromError(failedJobs[index].error) ?? ''}`)
      counts.set(bucket.id, (counts.get(bucket.id) ?? 0) + 1)
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
  }, [failedJobs])

  const report = useMemo(() => {
    if (!settings) return ''
    const system = status.stats?.system
    const device = status.stats?.devices?.[0]
    const failures: ReportFailure[] = failedJobs.map((job) => ({
      id: job.id,
      at: job.createdAt,
      provider: job.provider,
      mode: job.mode,
      mediaType: job.mediaType,
      nodeType: nodeFromError(job.error),
      reason: job.error ?? '',
    }))
    return buildDiagnosticReport({
      appVersion: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'unknown',
      osPlatform: osPlatform(),
      generatedAt,
      engine: {
        mode: settings.engine.mode,
        connected: status.connected,
        latencyMs: status.latencyMs,
        comfyVersion: system?.comfyui_version,
        testedComfyVersion: settings.testedComfyVersion,
        engineOs: system?.os,
        pythonVersion: system?.python_version,
        deviceName: device?.name,
        vramTotalBytes: device?.vram_total,
      },
      managedRuntime: settings.engine.mode === 'managed'
        ? engineRuntime ?? { state: 'unknown', logTail: [] }
        : null,
      modelScan: MODEL_KINDS.map((kind) => ({ kind, count: models.filter((model) => model.kind === kind).length })),
      jobCounts: {
        total: jobs.length,
        completed: jobs.filter((job) => job.status === 'completed').length,
        failed: failedJobs.length,
        cancelled: jobs.filter((job) => job.status === 'cancelled').length,
      },
      failures,
      doctor: doctor ? { ranAt: doctor.ranAt, checks: doctor.checks.map((check) => ({ id: check.id, label: check.label, status: check.status, detail: check.detail })) } : null,
      selfTest,
    })
  }, [doctor, engineRuntime, failedJobs, generatedAt, jobs, models, selfTest, settings, status])

  const onCopy = async () => {
    if (!report) return
    const ok = await copyText(report)
    setActionNote(ok ? 'Report copied — it is scrubbed and safe to paste anywhere.' : 'Copy failed. Select the text below and copy manually.')
  }
  const onSave = () => {
    if (!report) return
    saveTextFile(report, `minimax-diagnostics-${new Date(generatedAt).toISOString().replace(/[:.]/g, '-')}.txt`)
    setActionNote('Report saved as a local file.')
  }

  if (!settings) return <div className="standard-page diagnostics-page"><div className="page-heading"><div><p className="eyebrow">APPLICATION</p><h1>Diagnostics</h1></div></div><p className="settings-note">Loading…</p></div>

  const connectedVersion = status.stats?.system?.comfyui_version
  const drift = Boolean(connectedVersion && settings.testedComfyVersion && connectedVersion !== settings.testedComfyVersion)
  const recentFailures = failedJobs.slice(0, 10)

  return <div className="standard-page settings-page diagnostics-page">
    <div className="page-heading">
      <div><p className="eyebrow">APPLICATION</p><h1>Diagnostics</h1><p>Failure paths, engine state, and a scrubbed report you can paste anywhere — no prompt or media content is ever included.</p></div>
      <div className="diagnostics-heading-actions">
        <button className="secondary-button" onClick={() => { setGeneratedAt(Date.now()); void runDoctor() }} title="Re-read the engine, runtime, and job state, then rerun the doctor">
          <RefreshCw size={16} />Refresh
        </button>
        <button className="secondary-button" onClick={() => void onSave()} disabled={!report}><Download size={16} />Save report</button>
        <button className="primary-button" onClick={() => void onCopy()} disabled={!report}><ClipboardCopy size={16} />Copy report</button>
      </div>
    </div>
    {actionNote && <div className={`llm-test-result ${actionNote.includes('failed') ? 'fail' : 'ok'}`} role="status"><span>{actionNote}</span></div>}

    <section className="settings-section" aria-label="Engine">
      <div className="settings-heading">
        <div><Activity size={19} /><span><strong>Engine connection</strong><small>ComfyUI reachability, version, and graph compatibility.</small></span></div>
        <span className={`health-pill ${status.connected ? 'online' : ''}`}>{status.connected ? `Connected · ${status.latencyMs} ms` : 'Offline'}</span>
      </div>
      <div className={`doctor-check ${drift ? 'warn' : 'ok'}`}>
        <span>{drift ? <AlertCircle size={14} /> : <Check size={14} />}</span>
        <div>
          <strong>{drift ? 'ComfyUI updated since graph verification' : 'Graphs verified against this engine'}</strong>
          <small>
            Mode {settings.engine.mode} · engine {connectedVersion ?? 'version unknown'} · verified {settings.testedComfyVersion ?? 'not recorded yet'}
            {status.stats?.system?.os ? ` · ${status.stats.system.os}` : ''}
            {status.stats?.system?.python_version ? ` · Python ${status.stats.system.python_version}` : ''}
          </small>
        </div>
      </div>
      {status.stats?.devices?.[0] && <div className="device-strip"><Activity size={17} /><span><strong>{status.stats.devices[0].name ?? 'Compute device'}</strong><small>{status.stats.devices[0].vram_total ? `${formatBytes(status.stats.devices[0].vram_total)} VRAM · ${formatBytes(status.stats.devices[0].vram_free ?? 0)} free` : 'ComfyUI device detected'}</small></span></div>}
    </section>

    {settings.engine.mode === 'managed' && <section className="settings-section managed-engine-section" aria-label="Managed runtime">
      <div className="settings-heading">
        <div><Stethoscope size={19} /><span><strong>Managed runtime</strong><small>The studio-supervised ComfyUI process state and its (sanitized) log tail.</small></span></div>
        <span className={`health-pill ${engineRuntime?.state === 'running' ? 'online' : ''}`}>{engineRuntime?.state ?? 'unknown'}</span>
      </div>
      <p className="settings-note managed-engine-note">
        {engineRuntime
          ? <>State <strong>{engineRuntime.state}</strong>{engineRuntime.profile ? <> · profile <strong>{engineRuntime.profile}</strong></> : null}{engineRuntime.port ? <> · port {engineRuntime.port}</> : null}{engineRuntime.pid ? <> · pid {engineRuntime.pid}</> : null}{engineRuntime.adopted ? ' · adopted' : ''}{engineRuntime.health === 'unreachable' ? ' · health checks failing' : ''}</>
          : 'Waiting for the first runtime poll…'}
      </p>
      {engineRuntime?.lastError && <div className="llm-test-result fail" role="status"><AlertCircle size={14} /><span>{sanitizeErrorMessage(engineRuntime.lastError)}</span></div>}
      {engineRuntime && engineRuntime.logTail.length > 0 && <pre className="engine-log-tail" aria-label="Managed engine log tail (sanitized)">{engineRuntime.logTail.slice(-12).map((line) => sanitizeErrorMessage(line)).join('\n')}</pre>}
    </section>}

    <section className="settings-section" aria-label="Failure history">
      <div className="settings-heading">
        <div><AlertCircle size={19} /><span><strong>Recent job failures</strong><small>Which node and stage failed, the sanitized reason, and the mapped human cause — never prompt content.</small></span></div>
        <span className="health-pill">{failedJobs.length} failed</span>
      </div>
      {failedJobs.length === 0
        ? <p className="settings-note">No failed jobs recorded on this device.</p>
        : <>
          <div className="doctor-report">
            {recentFailures.map((job) => {
              const bucket = classifyFailure(`${job.error ?? ''} ${nodeFromError(job.error) ?? ''}`)
              return <div className={`doctor-check ${bucket.id === 'unknown' ? 'warn' : 'fail'}`} key={job.id}>
                <span><AlertCircle size={14} /></span>
                <div>
                  <strong>{bucket.label}{nodeFromError(job.error) ? ` · node ${nodeFromError(job.error)}` : ''}</strong>
                  <small>{new Date(job.createdAt).toLocaleString()} · {job.provider ?? 'minimax'}/{job.mode}</small>
                  <p>{sanitizeErrorMessage(job.error ?? '')}</p>
                  <p>{bucket.cause}</p>
                </div>
              </div>
            })}
          </div>
          <div className="settings-note">Histogram: {histogram.map(([id, count]) => `${id} ${count}`).join(' · ')}</div>
        </>}
    </section>

    <section className="settings-section" aria-label="Sanitizer self-test">
      <div className="settings-heading">
        <div><ShieldCheck size={19} /><span><strong>Sanitizer self-test</strong><small>Feeds canary prompt-shaped strings through the report's scrubber and proves they cannot survive.</small></span></div>
        <span className={`health-pill ${selfTest.passed ? 'online' : ''}`}>{selfTest.passed ? 'Pass' : 'Fail'}</span>
      </div>
      <p className="settings-note">{selfTest.passed
        ? `${selfTest.cases.filter((one) => one.passed).length}/${selfTest.cases.length} canary cases redacted — the report is safe to paste publicly.`
        : `Only ${selfTest.cases.filter((one) => one.passed).length}/${selfTest.cases.length} canary cases redacted — do not paste the report until this passes.`}</p>
    </section>

    <section className="settings-section setup-doctor-section" aria-label="Setup doctor">
      <div className="settings-heading">
        <div><Stethoscope size={19} /><span><strong>Setup doctor</strong><small>Local toolchain checks — FFmpeg, HTTPS tooling, engine device, attention backends.</small></span></div>
        <button className="secondary-button" onClick={() => void runDoctor()} disabled={doctorRunning}>{doctorRunning ? <LoaderCircle size={16} className="spin" /> : <Stethoscope size={16} />}{doctorRunning ? 'Checking…' : 'Run checks'}</button>
      </div>
      {doctor && <div className="doctor-report">{doctor.checks.map((check) => <div className={`doctor-check ${check.status}`} key={check.id}><span>{check.status === 'ok' ? <Check size={14} /> : <AlertCircle size={14} />}</span><div><strong>{check.label}</strong><small>{check.detail}</small>{check.recommendation && <p>{check.recommendation}</p>}</div></div>)}</div>}
    </section>

    <section className="settings-section" aria-label="Diagnostic report">
      <div className="settings-heading">
        <div><ClipboardCopy size={19} /><span><strong>Diagnostic report</strong><small>Plain text, scrubbed by construction from structured fields — versions, counts, node ids, sanitized reasons. Nothing leaves this machine unless you copy or save it.</small></span></div>
      </div>
      <pre className="engine-log-tail diagnostics-report-preview" aria-label="Diagnostic report preview">{report}</pre>
    </section>
  </div>
}
