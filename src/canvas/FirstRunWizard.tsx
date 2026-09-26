/**
 * The first-run wizard (remediation R-16, Wave 3 — tg52kaq). The audit's B2:
 * first run dumped every setup decision at once inside a 15k-px settings
 * document (the notice's CTAs scroll-hacked ~9,000 px into it — the timing
 * hack itself was evidence the destination didn't fit). Four THIN steps:
 *
 *   1. ENGINE — the connection (external URL with a consent-gated common-port
 *      probe, or managed), per R-24: the port is an explicit choice, not a
 *      silent 8188 convention.
 *   2. REGISTRY — the engine's own model inventory readout + the stack
 *      verdict (registry-only, R-12: no path entry — a readout + refresh).
 *   3. PACKS — the node-pack board summary (pre-validated chips).
 *   4. FIRST PROMPT — one prompt spawns the first canvas chain.
 *
 * Skippable (skip = done-for-now, never a nag) and RESUMABLE (progress in
 * localStorage, reopens at the saved step). The FirstRunNotice STAYS as the
 * fallback surface (its latch is keep-listed) — the wizard absorbs the
 * journey, the notice catches whatever path skipped it.
 */
import { useEffect, useMemo, useState } from 'react'
import { Check, HardDrive, LoaderCircle, RefreshCw, Sparkles, X } from 'lucide-react'
import { useContext } from 'react'
import { dbg } from '../lib/dbg'
import { h3StackReport } from '../lib/h3Stack'
import { useSessionStore } from '../state/sessionStore'
import { useCanvasStore } from './store'
import { CanvasSessionContext } from './sessionContext'
import { WIZARD_REOPEN_EVENT } from './FirstRunNotice'

const WIZARD_KEY = 'minimax.wizard'

/** Fired on every wizard-state write — the FirstRunNotice listens instead of
 *  polling (it shows the moment the wizard stops presenting). */
export const WIZARD_STATE_EVENT = 'minimax:wizard-state'

type WizardState = { step: number; done: boolean; skipped: boolean }

function readWizard(): WizardState {
  try {
    const raw = localStorage.getItem(WIZARD_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<WizardState>
      if (typeof parsed.step === 'number') return { step: parsed.step, done: parsed.done === true, skipped: parsed.skipped === true }
    }
  } catch { /* fall through to the fresh state */ }
  return { step: 0, done: false, skipped: false }
}

function writeWizard(state: WizardState): void {
  try { localStorage.setItem(WIZARD_KEY, JSON.stringify(state)) } catch { /* private mode — this session only */ }
  try { window.dispatchEvent(new Event(WIZARD_STATE_EVENT)) } catch { /* no window in tests */ }
}

/** The probe list for the engine step (R-24): 8188 is ComfyUI's canonical
 * default (kept as the shipped default — a fresh user's own install almost
 * certainly lives there); 8189+ are the studio/testbed conventions. The
 * probe is EXPLICIT (the button is the consent — nothing probes on its own). */
const COMMON_PORTS = [8188, 8189, 8190, 8191, 8192]

const STEP_TITLES = ['Engine', 'Models', 'Node packs', 'First prompt']

export function FirstRunWizard() {
  const context = useContext(CanvasSessionContext)
  const models = useSessionStore((state) => state.models)
  const scanning = useSessionStore((state) => state.scanning)
  const status = useSessionStore((state) => state.status)
  const settings = useSessionStore((state) => state.settings)
  const setSettings = useSessionStore((state) => state.setSettings)
  const engineInfo = useSessionStore((state) => state.info)
  const submitPrompt = useCanvasStore((state) => state.submitPrompt)
  const setSettingsDock = useCanvasStore((state) => state.setSettingsDock)
  const setLibraryDock = useCanvasStore((state) => state.setLibraryDock)

  const [state, setState] = useState<WizardState>(() => ({ ...readWizard() }))
  const [sawScan, setSawScan] = useState(false)
  useEffect(() => { if (scanning) setSawScan(true) }, [scanning])

  // (R-16) The step-3 pack summary: the board's own listing, summarized.
  const [packSummary, setPackSummary] = useState<{ active: number; total: number } | null>(null)
  useEffect(() => {
    if (state.step !== 2) return
    let cancelled = false
    void window.minimax.listEngineNodePacks().then((result) => {
      if (cancelled) return
      const packs = result.packs
      setPackSummary({ active: packs.filter((pack) => pack.instanceState === 'active').length, total: packs.length })
    }).catch(() => setPackSummary(null))
    return () => { cancelled = true }
  }, [state.step])

  const patch = (part: Partial<WizardState>) => {
    setState((current) => {
      const next = { ...current, ...part }
      writeWizard(next)
      return next
    })
  }

  // The notice's "Resume setup" CTA (the fallback surface reopening the
  // journey): reset skipped/done and present from the engine step.
  useEffect(() => {
    const reopen = () => setState((current) => {
      const next = { ...current, step: 0, done: false, skipped: false }
      writeWizard(next)
      return next
    })
    window.addEventListener(WIZARD_REOPEN_EVENT, reopen)
    return () => window.removeEventListener(WIZARD_REOPEN_EVENT, reopen)
  }, [])

  // (R-29) The stack verdict folds the ENGINE side too: object_info says
  // whether the instance actually serves the H3 core node classes.
  const stack = useMemo(() => (settings ? h3StackReport(models, settings.modelOverrides?.minimax, engineInfo) : null), [models, settings, engineInfo])

  // Show while the journey is neither completed nor skipped (journey sweep
  // #9, reality audit 2026-09-25 F1/C5): the OLD guard keyed visibility on
  // registry EMPTINESS (`models.length > 0`), so the wizard vanished the
  // instant the engine connected — steps 2-4 were unreachable for exactly
  // the connected-at-boot user (the maintainer's shape), and "resumable"
  // (R-16) was false in every connected path. Visibility is now keyed on
  // wizard COMPLETION; the way back in is Settings → Setup (the reopen
  // resets done/skipped exactly like the notice's Resume CTA). The
  // scan-settled latch never flashes pre-scan.
  // The session machinery (scan/check callbacks) rides the canvas session
  // context — the wizard lives on the canvas route where EngineHost provides
  if (!context || !sawScan || scanning || state.done || state.skipped || !settings) return null
  const { scanModels, checkConnection } = context.session

  const close = () => patch({ done: true })
  const step = Math.min(state.step, 3)

  const body = (() => {
    if (step === 0) return <EngineStep settings={settings} setSettings={setSettings} status={status} checkConnection={checkConnection} />
    if (step === 1) return <RegistryStep models={models} scanning={scanning} stack={stack} onRefresh={() => void scanModels(settings, { refresh: true })} />
    if (step === 2) return <PacksStep summary={packSummary} onOpenPacks={() => setSettingsDock(true)} onOpenLibrary={() => setLibraryDock(true)} />
    return <PromptStep onDone={(prompt) => { patch({ done: true }); if (prompt.trim()) void submitPrompt(prompt, 'video') }} />
  })()

  return <div className="canvas-wizard" role="dialog" aria-label="First-run setup wizard" data-canvas-wizard data-wizard-step={step}>
    <header className="canvas-wizard-header">
      <strong>Set up the studio <span className="canvas-wizard-step">{step + 1} of 4 — {STEP_TITLES[step]}</span></strong>
      <button type="button" className="canvas-wizard-skip" data-wizard-skip onClick={() => patch({ skipped: true })}>Skip for now</button>
      <button type="button" className="canvas-wizard-close" aria-label="Close the setup wizard" data-wizard-close onClick={close}><X size={14} /></button>
    </header>
    <div className="canvas-wizard-body">{body}</div>
    <footer className="canvas-wizard-footer">
      <ol className="canvas-wizard-progress" aria-label="Wizard progress">
        {STEP_TITLES.map((title, index) => (
          <li key={title} className={index === step ? 'current' : index < step ? 'past' : ''} data-wizard-progress={index}>{title}</li>
        ))}
      </ol>
      <div className="canvas-wizard-actions">
        {step > 0 && <button type="button" className="canvas-chip" data-wizard-back onClick={() => patch({ step: step - 1 })}>Back</button>}
        {step < 3 && <button type="button" className="canvas-chip primary" data-wizard-next onClick={() => patch({ step: step + 1 })}>Next — {STEP_TITLES[step + 1]}</button>}
      </div>
    </footer>
  </div>
}

/** Step 1 — the engine connection (R-24: the port is a choice). */
function EngineStep(props: {
  settings: NonNullable<ReturnType<typeof useSessionStore.getState>['settings']>
  setSettings(value: NonNullable<ReturnType<typeof useSessionStore.getState>['settings']>): void
  status: ReturnType<typeof useSessionStore.getState>['status']
  checkConnection(url: string): Promise<unknown>
}) {
  const { settings, setSettings, status, checkConnection } = props
  const [probing, setProbing] = useState(false)
  const [reachable, setReachable] = useState<Array<{ port: number; latencyMs: number }>>([])
  const [checkedUrl, setCheckedUrl] = useState<string | null>(null)

  const probe = async () => {
    setProbing(true)
    setReachable([])
    try {
      const found: Array<{ port: number; latencyMs: number }> = []
      for (const port of COMMON_PORTS) {
        const url = `http://127.0.0.1:${port}`
        try {
          const probeStatus = await window.minimax.getComfyStatus(url)
          if (probeStatus.connected) found.push({ port, latencyMs: probeStatus.latencyMs ?? 0 })
          // (A-DBG) The probe verdict per port — click-consented, one burst
          // per Test press; the connected case is summarized below.
          dbg('wizard.probe', { port, connected: probeStatus.connected, latencyMs: probeStatus.latencyMs })
        } catch (error) {
          dbg('wizard.probe', { port, connected: false, error: error instanceof Error ? error.message : String(error) })
        }
      }
      // (A-DBG) The burst summary: what the wizard will offer as one-click.
      dbg('wizard', { step: 'engine', reachable: found.map((entry) => entry.port) })
      setReachable(found)
    } finally {
      setProbing(false)
    }
  }

  return <div className="canvas-wizard-step" data-wizard-engine>
    <p className="canvas-wizard-lede">Point the studio at a ComfyUI engine. Nothing is scanned or configured manually — the engine's own registry is the model source of truth.</p>
    <div className="canvas-wizard-row">
      <label htmlFor="wizard-comfy-url">Engine address</label>
      <input
        id="wizard-comfy-url"
        data-wizard-comfy-url
        value={settings.comfyUrl}
        placeholder="http://127.0.0.1:8188 — ComfyUI's default port"
        onChange={(event) => setSettings({ ...settings, comfyUrl: event.target.value })}
      />
      <button type="button" className="canvas-chip" data-wizard-test disabled={probing} onClick={() => { setCheckedUrl(settings.comfyUrl); void checkConnection(settings.comfyUrl) }}>
        {probing ? <LoaderCircle size={12} className="spin" /> : <RefreshCw size={12} />} Test
      </button>
    </div>
    {checkedUrl === settings.comfyUrl && (status.connected
      ? <p className="canvas-wizard-ok" data-wizard-connected><Check size={13} /> Engine reachable{status.stats?.devices?.[0]?.name ? ` — ${status.stats.devices[0].name}` : ''}.</p>
      : <p className="canvas-wizard-warn" data-wizard-unreachable>Not reachable at {settings.comfyUrl}{status.error ? ` — ${status.error}` : ''}. Start the engine and test again, or continue and connect later.</p>)}
    <div className="canvas-wizard-row">
      <span className="canvas-wizard-hint">Not sure of the port? The probe asks each common port for a heartbeat — you click, it asks; nothing probes on its own.</span>
      <button type="button" className="canvas-chip" data-wizard-probe onClick={() => void probe()} disabled={probing}>
        {probing ? <LoaderCircle size={12} className="spin" /> : null} Probe common ports
      </button>
    </div>
    {reachable.length > 0 && (
      <ul className="canvas-wizard-ports" data-wizard-ports>
        {reachable.map(({ port, latencyMs }) => (
          <li key={port}>
            <button type="button" className="canvas-chip" data-wizard-port={port} onClick={() => { const url = `http://127.0.0.1:${port}`; setSettings({ ...settings, comfyUrl: url }); setCheckedUrl(url); void checkConnection(url) }}>
              <Check size={12} /> :{port} <small>{latencyMs} ms</small>
            </button>
          </li>
        ))}
      </ul>
    )}
    <p className="canvas-wizard-note">Prefer the studio to launch its own engine? That lives in Settings → Setup → Managed engine — this wizard only needs an address to try.</p>
  </div>
}

/** Step 2 — the registry readout + stack verdict (post-directive: NO path entry). */
function RegistryStep(props: { models: ReturnType<typeof useSessionStore.getState>['models']; scanning: boolean; stack: ReturnType<typeof h3StackReport> | null; onRefresh(): void }) {
  const { models, scanning, stack, onRefresh } = props
  const counts = useMemo(() => {
    const byKind = new Map<string, number>()
    for (const model of models) byKind.set(model.kind, (byKind.get(model.kind) ?? 0) + 1)
    return [...byKind.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [models])
  return <div className="canvas-wizard-step" data-wizard-registry>
    <p className="canvas-wizard-lede">The connected engine's own model registry — everything it can see, nothing it can't. Add weights where the engine reads them, then refresh.</p>
    {counts.length === 0
      ? <p className="canvas-wizard-warn" data-wizard-no-models><HardDrive size={13} /> The engine lists no models yet. You can fetch the validated stack through the library (next-next step's packs, or Settings), or place weights where the engine reads them and refresh.</p>
      : <ul className="canvas-wizard-models" data-wizard-model-kinds>
        {counts.map(([kind, count]) => <li key={kind} data-wizard-model-kind={kind}><strong>{kind.replace(/_/g, ' ')}</strong><span>{count}</span></li>)}
      </ul>}
    {stack && <p className={`canvas-wizard-${stack.validated || stack.ready ? 'ok' : 'warn'}`} data-wizard-stack={stack.validated ? 'validated' : stack.ready ? 'custom' : 'incomplete'}>
      {stack.validated
        ? <><Check size={13} /> The validated official H3 stack is complete.</>
        : stack.nodes.missing.length > 0
          ? `The engine does not serve the studio's core render nodes (${stack.nodes.missing.map((item) => item.className).join(', ')}) — weights cannot fix this. Update ComfyUI (or install the missing node packs), restart the engine, then refresh.`
          : stack.ready
            ? 'Custom stack detected — every component the graphs load is present; output may differ from the validated set.'
            : stack.rows.some((row) => row.refusal)
              ? 'A component was found but refused (wrong class) — the row names the reason. Clear or fix the pick in Settings → Model overrides.'
              : 'The H3 stack is incomplete — make the missing components visible to the engine (any name shape the pickers recognize resolves), then refresh.'}
    </p>}
    <div className="canvas-wizard-row">
      <button type="button" className="canvas-chip" data-wizard-refresh onClick={onRefresh} disabled={scanning}>
        {scanning ? <LoaderCircle size={12} className="spin" /> : <RefreshCw size={12} />} Refresh from the engine
      </button>
    </div>
  </div>
}

/** Step 3 — the pack board summary (pre-validated chips; remediation is one click deep). */
function PacksStep(props: { summary: { active: number; total: number } | null; onOpenPacks(): void; onOpenLibrary(): void }) {
  const { summary, onOpenPacks, onOpenLibrary } = props
  return <div className="canvas-wizard-step" data-wizard-packs>
    <p className="canvas-wizard-lede">Node packs the studio can place for you — detection always reads the connected engine's live registry, and each row installs with one consented click.</p>
    {summary === null
      ? <p className="canvas-wizard-warn" data-wizard-packs-unknown>The pack board could not be listed (the engine is offline or still loading) — it stays available in Settings → Setup → Node packs.</p>
      : <p className="canvas-wizard-ok" data-wizard-packs-summary>{summary.active} of {summary.total} packs active on the engine{summary.active < summary.total ? ' — the missing ones can be fetched or installed from their rows.' : '.'}</p>}
    <div className="canvas-wizard-row">
      <button type="button" className="canvas-chip" data-wizard-open-packs onClick={onOpenPacks}>Open the pack board (Settings)</button>
      <button type="button" className="canvas-chip" data-wizard-open-library onClick={onOpenLibrary}>Open the library — get models</button>
    </div>
  </div>
}

/** Step 4 — the first prompt: the whole point. */
function PromptStep(props: { onDone(prompt: string): void }) {
  const [prompt, setPrompt] = useState('')
  return <div className="canvas-wizard-step" data-wizard-prompt>
    <p className="canvas-wizard-lede">Describe one shot. The chain lands on the canvas; generate when you're ready — a refused engine says so honestly.</p>
    <textarea
      data-wizard-prompt-input
      rows={3}
      value={prompt}
      placeholder="A lighthouse over a black sea, slow push-in, no dialogue"
      onChange={(event) => setPrompt(event.target.value)}
      onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); props.onDone(prompt) } }}
    />
    <div className="canvas-wizard-row">
      <button type="button" className="canvas-chip primary" data-wizard-finish disabled={!prompt.trim()} onClick={() => props.onDone(prompt)}>
        <Sparkles size={12} /> Create the first chain
      </button>
    </div>
  </div>
}
