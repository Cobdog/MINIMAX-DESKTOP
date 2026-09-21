/** The Settings view: engine connection, managed engine runtime, validated
 *  H3 stack report, generation defaults, the LLM layer (llama.cpp router +
 *  Ollama fallback), model locations, and output/clip paths. */
import { useEffect, useState } from 'react'
import { GitBranch, Wand2 } from 'lucide-react'
import { Activity, AlertCircle, Check, ChevronDown, Cpu, Eye, Folder, FolderOpen, Gauge, HardDrive, Info, Layers, LoaderCircle, Power, RefreshCw, Save, Scale, ServerCog, SlidersHorizontal, Sparkles, Stethoscope, Unplug } from 'lucide-react'
import type { AppSettings, ComfyStatus, LlmModelsResult, ModelFile, ModelKind, NodePackStatus, OllamaModel, UpscaleMode } from '../types'
import { choices, type ObjectInfo } from '../lib/comfyInfo'
import { inferredOverrideSlotFile, MODEL_FAMILIES, overridePickOutcome, SLOT_LABELS, type ModelOverrideSlotName } from '../lib/modelOverrides'
import { detectKrea2EditFamilies, detectOptimizations, KREA2_RECIPE_PINS } from '../lib/graph'
import type { h3StackReport } from '../lib/h3Stack'
import { SelectField, NumberField } from '../components/form'
import { formatBytes } from '../lib/format'
import type { DoctorReport } from '../lib/doctor'
import { FetchBrowser } from '../components/FetchBrowser'
import { useSessionStore } from '../state/sessionStore'

/** Inline directory-path feedback (maintainer flag 2026-09-19: "changing a
 *  directory location does not validate the path"). Debounced stat through
 *  the server's /api/lan/fs/check — exists-as-directory ✓, missing ⚠ (the
 *  field still saves; the note names the consequence), file ⚠, error ⚠. */
function PathCheckNote({ path }: { path: string }) {
  const [state, setState] = useState<'idle' | 'checking' | 'ok' | 'missing' | 'file' | 'error'>('idle')
  const [detail, setDetail] = useState('')
  useEffect(() => {
    const trimmed = path.trim()
    if (!trimmed || !trimmed.startsWith('/')) { setState('idle'); setDetail(''); return }
    setState('checking')
    const timer = setTimeout(() => {
      void window.minimax.checkPath(trimmed).then((result) => {
        if (result.error) { setState('error'); setDetail(result.error); return }
        if (!result.exists) { setState('missing'); return }
        setState(result.directory ? 'ok' : 'file')
      }).catch((error: unknown) => { setState('error'); setDetail(error instanceof Error ? error.message : String(error)) })
    }, 500)
    return () => clearTimeout(timer)
  }, [path])
  if (state === 'idle') return null
  return <p className={`settings-note path-check ${state}`} role="status">{state === 'checking' ? 'Checking path…'
    : state === 'ok' ? <><Check size={13} /> Directory found.</>
    : state === 'missing' ? <><AlertCircle size={13} /> No such directory yet — nothing scans here until it exists. Saves as typed.</>
    : state === 'file' ? <><AlertCircle size={13} /> That path is a file, not a directory.</>
    : <><AlertCircle size={13} /> {detail || 'Path check failed.'}</>}</p>
}

export function SettingsView({ settings, setSettings, info, infoEpoch = 0, models, h3Report, scanning, status, checking, diagnosticRunning, ollamaModels, onRefreshOllama, onScan, onCheck, onSave, onRunDiagnostics }: { settings: AppSettings; setSettings(value: AppSettings): void; info: ObjectInfo; infoEpoch?: number; models: ModelFile[]; h3Report: ReturnType<typeof h3StackReport>; scanning: boolean; status: ComfyStatus; checking: boolean; diagnosticRunning: boolean; ollamaModels: OllamaModel[]; onRefreshOllama(): void; onScan(): void; onCheck(): void; onSave(): void | Promise<void>; onRunDiagnostics(): void }) {
  const pathRows: Array<{ kind: ModelKind; label: string; note: string }> = [
    { kind: 'diffusion_models', label: 'Diffusion models', note: 'FL2VA and Ref2VA checkpoints' },
    { kind: 'text_encoders', label: 'Text encoders', note: 'Qwen3-VL MiniMax encoder' },
    { kind: 'vae', label: 'VAE models', note: 'Video and audio decoders' },
    { kind: 'loras', label: 'LoRAs', note: '4-step and 8-step turbo adapters' },
    { kind: 'vae_approx', label: 'Preview models', note: 'Tiny H3 preview decoder' },
    { kind: 'clip_vision', label: 'Vision encoders', note: 'Optional reference encoders' },
  ]
  // Optimization registry: turbo families detected on this engine (which
  // family/steps each installed LoRA belongs to) — surfaced next to the
  // validated-stack report so provenance is visible without generating.
  const detectedTurboFamilies = detectOptimizations(info, models)
    .filter(({ entry, detection }) => entry.kind === 'turbo' && detection.available)
  // Krea 2 edit families (task t8u00uu): availability-gated per-workflow edit
  // graphs over the factory data — the picker below stays a thin surface.
  const krea2EditModes = detectKrea2EditFamilies(info, models)
  const editModesReady = krea2EditModes.filter(({ detection }) => detection.available).length
  const [selectedKrea2EditMode, setSelectedKrea2EditMode] = useState('krea2edit.instruct')
  const defaults = settings.generationDefaults
  const updateDefaults = (patch: Partial<AppSettings['generationDefaults']>) => setSettings({ ...settings, generationDefaults: { ...defaults, ...patch } })
  // Model overrides (task euxwdva): one pick per family + slot; clearing a
  // slot (or the last slot of a family) removes the key entirely so saved
  // settings stay tidy — empty is auto, never an explicit ''.
  const setModelOverride = (familyId: string, slot: ModelOverrideSlotName, value: string) => {
    const families: NonNullable<AppSettings['modelOverrides']> = { ...(settings.modelOverrides ?? {}) }
    const next = { ...(families[familyId] ?? {}) }
    if (value) next[slot] = value
    else delete next[slot]
    if (Object.keys(next).length) families[familyId] = next
    else delete families[familyId]
    setSettings({ ...settings, modelOverrides: families })
  }
  const applyPreset = (preset: 'quality' | 'official-turbo' | 'preview') => {
    const common = { resolution: '1344x768', duration: 5, steps: 30, loraStrength: 1, shiftVideo: 12, upscaleMode: 'off' as const }
    if (preset === 'quality') updateDefaults({ ...common, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', experimentalSampling: false, sigmaShiftMode: 'model', shiftAudio: 3 })
    else if (preset === 'official-turbo') updateDefaults({ ...common, turbo: '8', sampler: 'res_multistep', scheduler: 'simple', experimentalSampling: false, sigmaShiftMode: 'model', shiftAudio: 3 })
    else updateDefaults({ ...common, resolution: '864x480', turbo: '8', sampler: 'res_multistep', scheduler: 'simple', experimentalSampling: false, sigmaShiftMode: 'model', shiftAudio: 3 })
  }
  // B2 (review 2026-09-19): "Apply to Create" silently replaced user-tuned
  // values with a hardcoded set — the maintainer's silent-data-loss class.
  // The defaults object has no "unset" state, so merge-only-unset cannot fit;
  // the honest shape is an explicit reset that NAMES every delta it will
  // change (the house window.confirm idiom) and refuses to run silently.
  const recommendedDeltaNotes = (Object.keys(RECOMMENDED_DEFAULTS) as Array<keyof typeof RECOMMENDED_DEFAULTS>)
    .filter((key) => defaults[key] !== RECOMMENDED_DEFAULTS[key])
    .map((key) => `${DEFAULT_FIELD_LABELS[key]}: ${String(defaults[key])} → ${String(RECOMMENDED_DEFAULTS[key])}`)
  const resetToRecommended = () => {
    if (!recommendedDeltaNotes.length) return
    if (!window.confirm(`Reset generation defaults to the recommended set?\n\nThis replaces your tuned values:\n${recommendedDeltaNotes.join('\n')}\n\nExisting canvas chains keep their own settings.`)) return
    updateDefaults({ ...RECOMMENDED_DEFAULTS })
  }
  const samplerOptions = [...new Set([defaults.sampler, 'res_multistep', 'euler', 'gradient_estimation', 'ipndm', 'deis', 'heun', ...choices(info, 'KSamplerSelect', 'sampler_name')])]
  const schedulerOptions = [...new Set([defaults.scheduler, 'simple', 'beta', 'normal', ...choices(info, 'BasicScheduler', 'scheduler')])]
  const warnedSampler = ['euler_ancestral', 'lcm', 'dpmpp_3m_sde'].includes(defaults.sampler)
  const [doctor, setDoctor] = useState<DoctorReport | null>(null)
  const [doctorRunning, setDoctorRunning] = useState(false)
  const runDoctor = async () => {
    setDoctorRunning(true)
    try { setDoctor(await window.minimax.runSetupDoctor()) } catch (error) { setDoctor({ checks: [{ id: 'error', label: 'Doctor failed', status: 'fail', detail: error instanceof Error ? error.message : String(error) }], ranAt: Date.now() }) } finally { setDoctorRunning(false) }
  }

  // ---- LLM layer (llama.cpp router primary, Ollama fallback) ----------------
  const [llmList, setLlmList] = useState<LlmModelsResult | null>(null)
  const [llmTesting, setLlmTesting] = useState(false)
  // The URL last tested — the debounced re-test below skips no-op runs so
  // typing in the router field re-verifies quietly without thrashing.
  const [llmTestedUrl, setLlmTestedUrl] = useState<string | null>(null)
  const testLlm = async (candidate: string) => {
    setLlmTesting(true)
    setLlmTestedUrl(candidate)
    try { setLlmList(await window.minimax.listLlmModels(candidate)) } catch (error) {
      setLlmList({ provider: candidate.trim() ? 'router' : 'ollama', endpoint: candidate, model: '', models: [], connected: false, latencyMs: 0, error: error instanceof Error ? error.message : String(error) })
    } finally { setLlmTesting(false) }
  }
  useEffect(() => { void testLlm('') /* current settings on mount */ }, [])
  // Feedback while editing the address: after a quiet pause, re-test the
  // endpoint so the pill/result/list reflect what was typed (the Test
  // button stays for an immediate check).
  useEffect(() => {
    if (settings.llamaCppUrl === llmTestedUrl) return
    const timer = setTimeout(() => { void testLlm(settings.llamaCppUrl) }, 600)
    return () => clearTimeout(timer)
  }, [settings.llamaCppUrl, llmTestedUrl])
  // The model the NEXT call will use — the server-side `active` in llmList
  // reflects what the router has LOADED, which lags the pick in router mode
  // (the model loads per call). The pick drives the UI; the badge stays for
  // the loaded state.
  const llmSelectedModel = settings.llamaCppModel.trim()

  // ---- Managed engine runtime (increment 1) ---------------------------------
  // Runtime state rides the session store (the hook polls it ONLY while
  // managed mode is active); start/stop act through the bridge and persist
  // the current form first — the launch uses exactly what is on screen.
  const engineRuntime = useSessionStore((state) => state.engineRuntime)
  const [engineBusy, setEngineBusy] = useState(false)
  const [engineActionError, setEngineActionError] = useState<string | null>(null)
  const updateEngine = (patch: Partial<AppSettings['engine']>) => setSettings({ ...settings, engine: { ...settings.engine, ...patch } })
  const startEngine = async () => {
    setEngineBusy(true)
    setEngineActionError(null)
    try {
      const saved = await window.minimax.saveSettings(settings)
      setSettings(saved.settings)
      bumpPackSaveTick() // the persisted form just changed the pack target too
      await window.minimax.startManagedEngine()
      setSettings(await window.minimax.getSettings()) // comfyUrl re-pointed server-side on success
    } catch (error) {
      setEngineActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setEngineBusy(false)
    }
  }
  const stopEngine = async () => {
    setEngineBusy(true)
    setEngineActionError(null)
    try { await window.minimax.stopManagedEngine() } catch (error) {
      setEngineActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setEngineBusy(false)
    }
  }
  // ---- Launch profiles + patch consent + vendored node packs (increment 2) --
  const profileIds = Object.keys(settings.engine.profiles)
  const activeProfile = settings.engine.profiles[settings.engine.profile] ?? settings.engine.profiles.default
  const profileEnvEntries = Object.entries(activeProfile?.env ?? {})
  const setProfileEnv = (entries: Array<[string, string]>) => updateEngine({ profiles: { ...settings.engine.profiles, [settings.engine.profile]: { ...activeProfile, env: Object.fromEntries(entries.filter(([name]) => name.trim())) } } })
  const activePatchHooks = (activeProfile?.hooks ?? []).filter((hook) => hook.kind === 'patch')
  const patchConsent = (patchId: string, consented: boolean) => updateEngine({ patches: { ...settings.engine.patches, [patchId]: { consented, at: consented ? Date.now() : undefined } } })
  const [nodePacks, setNodePacks] = useState<NodePackStatus[] | null>(null)
  const [nodePackBusy, setNodePackBusy] = useState<string | null>(null)
  const [nodePackError, setNodePackError] = useState<string | null>(null)
  const [nodePackRefreshing, setNodePackRefreshing] = useState(false)
  const [nodePackSource, setNodePackSource] = useState<Record<string, string>>({})
  /** One-click fetch deep-link from a pack row (task 9om4bi9): focuses the
   *  FetchBrowser's catalog entry — the same mechanism the canvas menu rows
   *  use. Consumed by FetchBrowser, then cleared here. */
  const [packFetchFocus, setPackFetchFocus] = useState<string[] | null>(null)
  const refreshNodePacks = async (options?: { refresh?: boolean }) => {
    try { setNodePacks((await window.minimax.listEngineNodePacks(options)).packs) } catch { /* listed on next action; errors surface there */ }
  }
  /** The board's manual Refresh (task mjhlt3k, AC-2): the pack rows re-GET
   *  with the probe cache dropped (fresh targeted object_info asks — Wave 2
   *  A-8) and the model inventory re-pulls with the USER refresh semantics
   *  (engine-side /refresh best-effort + a fresh listing read — R-12). The
   *  auto-refresh effects only fire on settings changes; this is the "I
   *  changed something behind the studio's back" trigger. */
  const refreshPackBoard = async () => {
    setNodePackRefreshing(true)
    try {
      await Promise.all([refreshNodePacks({ refresh: true }), Promise.resolve(onScan())])
    } finally {
      setNodePackRefreshing(false)
    }
  }
  // Pack refresh after SAVE (review B1, 2026-09-19): the server resolves the
  // install target from its OWN persisted settings, which only change when a
  // save lands — the field deps below fire earlier, while the server still
  // holds the old values. The tick bumps once the save settles (success OR
  // failure — the refresh is a cheap GET) so the chips re-resolve without a
  // field re-edit.
  const [packSaveTick, setPackSaveTick] = useState(0)
  const bumpPackSaveTick = () => setPackSaveTick((tick) => tick + 1)
  // (R-01) infoEpoch: every successful object_info re-pull (boot, manual
  // check, engine recovery) re-resolves the live pack chips — an engine that
  // came back flips "absent" rows to "active" here without a manual Refresh.
  useEffect(() => { void refreshNodePacks() }, [settings.engine.checkoutPath, settings.engine.externalCustomNodesDir, settings.engine.mode, packSaveTick, infoEpoch])
  const saveAndRefreshPacks = async () => {
    try { await onSave() } finally { bumpPackSaveTick() }
  }
  const runNodePackAction = async (id: string, action: () => Promise<NodePackStatus>) => {
    setNodePackBusy(id)
    setNodePackError(null)
    try {
      await action()
      await refreshNodePacks()
    } catch (error) {
      setNodePackError(error instanceof Error ? error.message : String(error))
    } finally {
      setNodePackBusy(null)
    }
  }
  const gpuTiers: Array<{ id: NonNullable<AppSettings['gpuTier']>; label: string; guidance: string }> = [
    { id: '8', label: '8 GB', guidance: 'Pruned INT4 diffusion + INT4 text encoder · 864×480 · 5 s · one render at a time. GGUF only if INT4 is unavailable (ComfyUI manages dynamic VRAM better with safetensors).' },
    { id: '16', label: '16 GB', guidance: 'Pruned INT8/Q4 diffusion + INT4/INT8 text encoder · 1344×768 · 5 s first · queue one at a time. Tiled VAE covers the auto-retry path.' },
    { id: '24', label: '24 GB', guidance: 'Q5 or pruned INT8 diffusion + INT8 text encoder · 1344×768 · up to 10 s · comfortable queueing. INT8 is the best-tested community tier.' },
    { id: 'blackwell', label: 'Blackwell', guidance: 'NVFP4 diffusion + NVFP4-AWQ text encoder · native resolution/duration headroom · SageAttention and Sol-Attn give the largest speedups here.' },
  ]
  return <div className="standard-page settings-page"><div className="page-heading"><div><p className="eyebrow">APPLICATION</p><h1>Settings</h1><p>Point the studio at your existing local engine and model folders.</p></div><button className="primary-button" data-save-settings onClick={() => void saveAndRefreshPacks()}><Save size={17} />Save settings</button></div>
    <section className="settings-section"><div className="settings-heading"><div><Activity size={19} /><span><strong>ComfyUI engine</strong><small>The desktop app communicates only with this local address.</small></span></div><span className={`health-pill ${status.connected ? 'online' : ''}`}>{status.connected ? 'Connected' : 'Offline'}</span></div><div className="connection-row"><div className="field-group grow"><label htmlFor="comfy-url">Server URL</label><input id="comfy-url" value={settings.comfyUrl} onChange={(event) => setSettings({ ...settings, comfyUrl: event.target.value })} /></div><button className="secondary-button test-button" onClick={onCheck} disabled={checking}>{checking ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}Test connection</button></div>
    {/* M3 (review 2026-09-19): the status route's `error` used to be dead
        weight — a failed test showed only the stale "Offline" pill with no
        acknowledgment the test ran or why it failed. Render the reason with
        the address that was tried. */}
    {!status.connected && status.error && <div className="llm-test-result fail" role="status" data-comfy-status-error><AlertCircle size={14} /><span>Could not reach {settings.comfyUrl} — {status.error}</span></div>}
    {status.connected && status.stats?.devices?.[0] && <div className="device-strip"><Gauge size={17} /><span><strong>{status.stats.devices[0].name ?? 'Compute device'}</strong><small>{status.stats.devices[0].vram_total ? `${formatBytes(status.stats.devices[0].vram_total)} VRAM · ${formatBytes(status.stats.devices[0].vram_free ?? 0)} free` : 'ComfyUI device detected'}</small></span></div>}</section>
    <section className="settings-section managed-engine-section" aria-label="Managed engine">
      <div className="settings-heading">
        <div><ServerCog size={19} /><span><strong>Managed engine</strong><small>The studio launches and supervises its own ComfyUI from a checkout you nominate. External mode keeps the connection above.</small></span></div>
        <span className={`health-pill ${engineRuntime?.state === 'running' ? 'online' : ''}`}>{settings.engine.mode === 'managed' ? (engineRuntime ? engineRuntime.state : 'managed') : 'external'}</span>
      </div>
      <div className="preset-row" aria-label="Engine mode">
        <button type="button" className={settings.engine.mode !== 'managed' ? 'tier-selected' : ''} onClick={() => updateEngine({ mode: 'external' })}><strong>External</strong><small>Use the ComfyUI address above — the studio never launches an engine.</small></button>
        <button type="button" className={settings.engine.mode === 'managed' ? 'tier-selected' : ''} onClick={() => updateEngine({ mode: 'managed' })}><strong>Managed</strong><small>The studio starts, configures, and stops its own instance. Ports stay clear of 8188/8189.</small></button>
      </div>
      {settings.engine.mode === 'external' && <>
        {/* External-instance integration (task 9om4bi9): the studio does not
            launch this engine — point it at the instance's own custom_nodes
            folder and node packs install/clone into it (same pinned-revision
            and foreign-refusal discipline as the managed checkout). */}
        <div className="connection-row"><div className="field-group grow"><label htmlFor="external-custom-nodes">External custom nodes folder</label><input id="external-custom-nodes" data-external-custom-nodes value={settings.engine.externalCustomNodesDir} placeholder="/path/to/ComfyUI/custom_nodes — pack installs land here" onChange={(event) => updateEngine({ externalCustomNodesDir: event.target.value })} /><PathCheckNote path={settings.engine.externalCustomNodesDir} /></div></div>
        <p className="settings-note managed-engine-note" data-external-custom-nodes-note>External mode keeps the connection above as the engine. With a custom nodes folder set, the node packs below install into it — from a local copy here, or one consented fetch of the pinned revision (Fetchable items). Model inventory is pulled from the instance itself, so no local model roots are required.</p>
      </>}
      {settings.engine.mode === 'managed' && <>
        <div className="connection-row"><div className="field-group grow"><label htmlFor="managed-checkout">ComfyUI checkout (existing)</label><input id="managed-checkout" value={settings.engine.checkoutPath} placeholder="/path/to/ComfyUI — must contain main.py" onChange={(event) => updateEngine({ checkoutPath: event.target.value })} /><PathCheckNote path={settings.engine.checkoutPath} /></div></div>
        <p className="settings-note managed-engine-note">No checkout yet? The <strong>Fetchable items</strong> section below can fetch the reference ComfyUI revision (v0.34.0, GPL-3.0, consent-gated) and then nominate it here with one click.</p>
        <div className="connection-row">
          <div className="field-group grow"><label htmlFor="managed-python">Python executable</label><input id="managed-python" value={settings.engine.pythonPath} placeholder="empty = python3 (python on Windows)" onChange={(event) => updateEngine({ pythonPath: event.target.value })} /></div>
          <div className="field-group"><label htmlFor="managed-port">Preferred port</label><input id="managed-port" type="number" min={0} max={65535} value={settings.engine.portPreference || ''} placeholder="auto" onChange={(event) => updateEngine({ portPreference: Number(event.target.value) || 0 })} /></div>
          <label className="settings-check managed-autostart"><input type="checkbox" checked={settings.engine.autoStart} onChange={(event) => updateEngine({ autoStart: event.target.checked })} /><span><strong>Start with the server</strong><small>Boot adopts a healthy running instance instead of double-starting.</small></span></label>
        </div>
        <div className="connection-row">
          <div className="field-group"><label htmlFor="managed-profile">Launch profile</label>
            <select id="managed-profile" value={settings.engine.profile} onChange={(event) => updateEngine({ profile: event.target.value })}>
              {profileIds.map((id) => <option key={id} value={id}>{settings.engine.profiles[id].label}</option>)}
            </select>
          </div>
          <p className="settings-note managed-engine-note">{activeProfile?.description}</p>
        </div>
        <div className="profile-env-editor">
          <div className="profile-env-heading"><strong>Profile environment</strong><button type="button" className="secondary-button" onClick={() => setProfileEnv([...profileEnvEntries, ['', '']])}><SlidersHorizontal size={14} />Add variable</button></div>
          {profileEnvEntries.length === 0 && <p className="settings-note">No variables set. The VDN_H3_* toggles are runtime lab switches read by the node itself — add one here only if you mean to set it for every launch.</p>}
          {profileEnvEntries.map(([name, value], index) => (
            <div className="connection-row profile-env-row" key={index}>
              <div className="field-group"><label htmlFor={`profile-env-name-${index}`}>Name</label><input id={`profile-env-name-${index}`} value={name} placeholder="VDN_H3_…" onChange={(event) => setProfileEnv(profileEnvEntries.map((entry, at) => at === index ? [event.target.value, entry[1]] : entry))} /></div>
              <div className="field-group grow"><label htmlFor={`profile-env-value-${index}`}>Value</label><input id={`profile-env-value-${index}`} value={value} onChange={(event) => setProfileEnv(profileEnvEntries.map((entry, at) => at === index ? [entry[0], event.target.value] : entry))} /></div>
              <button type="button" className="secondary-button icon-only" aria-label="Remove variable" onClick={() => setProfileEnv(profileEnvEntries.filter((_, at) => at !== index))}><Unplug size={14} /></button>
            </div>
          ))}
        </div>
        {activePatchHooks.length > 0 && <div className="profile-patch-consent">
          {activePatchHooks.map((hook) => (
            <label className="settings-check" key={hook.patchId}>
              <input type="checkbox" checked={settings.engine.patches[hook.patchId]?.consented === true} onChange={(event) => patchConsent(hook.patchId, event.target.checked)} />
              <span><strong>Consent: {hook.patchId === 'longcache-block-loop' ? 'VDN LongCache block-loop hook' : hook.patchId}</strong><small>Lets the studio patch comfy/ldm/minimax/model.py before launch (pristine backup kept; layout- and version-gated; refuses on anything unrecognized). Unchecked = never patched — VDN still works, you just lose the LongCache tail cache.</small></span>
            </label>
          ))}
          {activePatchHooks.some((hook) => settings.engine.patches[hook.patchId]?.consented) && <button type="button" className="secondary-button" onClick={() => { void activePatchHooks.filter((hook) => settings.engine.patches[hook.patchId]?.consented).map((hook) => window.minimax.revertEnginePatch(hook.patchId).then(() => refreshNodePacks()).catch((error: unknown) => setNodePackError(error instanceof Error ? error.message : String(error)))) }}>Revert patched files from backup</button>}
        </div>}
        <div className="connection-row managed-engine-actions">
          <button className="secondary-button" onClick={() => void startEngine()} disabled={engineBusy || engineRuntime?.state === 'running' || engineRuntime?.state === 'starting'}>{engineBusy ? <LoaderCircle size={16} className="spin" /> : <Power size={16} />}Start engine</button>
          <button className="secondary-button" onClick={() => void stopEngine()} disabled={engineBusy || (engineRuntime?.state !== 'running' && engineRuntime?.state !== 'starting' && engineRuntime?.state !== 'failed')}>Stop engine</button>
          {engineRuntime && <p className="settings-note managed-engine-note">State <strong>{engineRuntime.state}</strong>{engineRuntime.url ? <> · <strong>{engineRuntime.url}</strong></> : null}{engineRuntime.pid ? <> · pid {engineRuntime.pid}</> : null}{engineRuntime.adopted ? ' · adopted' : ''}{engineRuntime.health === 'unreachable' ? ' · health checks failing' : ''}</p>}
        </div>
        {engineRuntime?.warning && <div className="llm-test-result fail" role="status"><AlertCircle size={14} /><span>{engineRuntime.warning}</span></div>}
        {engineRuntime?.lastError && <div className="llm-test-result fail" role="status"><AlertCircle size={14} /><span>{engineRuntime.lastError}</span></div>}
        {engineActionError && <div className="llm-test-result fail" role="status"><AlertCircle size={14} /><span>{engineActionError}</span></div>}
        {engineRuntime && engineRuntime.logTail.length > 0 && <pre className="engine-log-tail" aria-label="Managed engine log tail">{engineRuntime.logTail.slice(-12).join('\n')}</pre>}
        <p className="settings-note">Start persists the current form, mirrors your model folders into the checkout as extra_model_paths.yaml (weights are never copied), and points the studio at the launched instance. Stopping is graceful-then-forced; the log tail above shows the engine's own output.</p>
      </>}
    </section>
    <section className="settings-section node-packs-section" aria-label="Node packs">
      <div className="settings-heading">
        <div><GitBranch size={19} /><span><strong>Node packs</strong><small>Custom nodes the studio can place into the engine's custom-node folder — the managed checkout's custom_nodes/, or the external custom nodes folder above (the target is detected from the mode; nothing asks you to point at one). Vendored at a pinned revision (license-verified), fetched with your consent, or installed from the studio's own payload. Weights are linked, never copied. The status badge is version-aware and LIVE: it reads the folder's own markers (studio marker, git checkout, Comfy-Registry pyproject) plus the connected instance's node list.</small></span></div>
        <button type="button" className="secondary-button" data-node-pack-refresh onClick={() => void refreshPackBoard()} disabled={nodePackRefreshing || scanning} title="Re-pull the instance's model inventory and node list, re-scan the custom-nodes folder, and re-resolve every row">{nodePackRefreshing || scanning ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}Refresh</button>
      </div>
      <div className="node-pack-list">
        {(nodePacks ?? []).map((pack) => {
          const chip = nodePackChip(pack)
          // AC-1 path-prompt gate: the local-source input exists ONLY for a
          // pack with no network/payload source (no fetch-catalog entry —
          // empty in today's registry) that has a usable target and no
          // folder yet. Everything else installs without a path: payload
          // rows place directly, network rows go through Fetch… — the
          // VDN/turbo precedent.
          const needsLocalSource = pack.installMode === 'user-fetch' && !pack.hasNetworkSource && pack.targetKind !== 'none' && pack.folderState === 'missing' && !pack.installed
          const versionText = nodePackVersionText(pack)
          return (
          <div className="node-pack-row" key={pack.id}>
            <div className="node-pack-main">
              <div className="node-pack-title"><strong>{pack.name}</strong><span className={`node-pack-license ${pack.licenseSpdx === 'NO-LICENSE' ? 'warn' : ''}`}>{pack.licenseSpdx}</span><span className="node-pack-mode">{pack.installMode === 'vendor' ? (pack.vendored ? 'vendored' : 'vendor payload missing') : pack.installMode === 'first-party' ? 'first-party' : 'user-fetch'}</span><span className={`node-pack-installed ${chip.tone}`} data-node-pack-chip={chip.label}>{chip.label}</span>{versionText && <span className="node-pack-version" data-node-pack-version={versionText}>{versionText}</span>}</div>
              {pack.managedNotice && <small className="node-pack-managed-notice" role="status"><Info size={13} />{pack.managedNotice}</small>}
              <small>{pack.description}</small>
              <small className="node-pack-meta">{pack.repoUrl} @ {pack.pinnedRevision.slice(0, 12)}{pack.note ? ` — ${pack.note}` : ''}</small>
            </div>
            <div className="node-pack-actions">
              {needsLocalSource && <input className="node-pack-source" placeholder="local repo directory (absolute)" value={nodePackSource[pack.id] ?? ''} onChange={(event) => setNodePackSource({ ...nodePackSource, [pack.id]: event.target.value })} aria-label={`Local source directory for ${pack.name}`} />}
              {pack.installMode === 'user-fetch' && pack.hasNetworkSource && pack.targetKind !== 'none' && pack.folderState !== 'foreign' && <button type="button" className="secondary-button" title={pack.versionRelation === 'differs' ? `Refetch the pinned revision of ${pack.name} (consent-gated) — the installed copy differs from the pin` : `Fetch the pinned revision of ${pack.name} (consent-gated)`} onClick={() => {
                setPackFetchFocus([`pack:${pack.id}`])
                document.querySelector('.fetch-section')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
              }} data-node-pack-fetch={pack.id}>Fetch…</button>}
              {(pack.installMode !== 'user-fetch' || needsLocalSource) && <button type="button" className="secondary-button" title={pack.folderState === 'foreign' ? 'Already present — placed outside the studio; the studio never replaces or deletes it' : undefined} disabled={nodePackBusy === pack.id || pack.availability === 'unavailable' || pack.folderState === 'foreign' || (needsLocalSource && !nodePackSource[pack.id]?.trim())} onClick={() => void runNodePackAction(pack.id, () => window.minimax.installEngineNodePack(pack.id, nodePackSource[pack.id]?.trim() || undefined))}>{nodePackBusy === pack.id ? <LoaderCircle size={14} className="spin" /> : null}Install</button>}
              <button type="button" className="secondary-button" disabled={!pack.installed || nodePackBusy === pack.id} onClick={() => void runNodePackAction(pack.id, () => window.minimax.uninstallEngineNodePack(pack.id))}>Uninstall</button>
            </div>
          </div>
          )
        })}
        {nodePacks === null && <p className="settings-note">Loading node-pack registry…</p>}
      </div>
      {nodePackError && <div className="llm-test-result fail" role="status"><AlertCircle size={14} /><span>{nodePackError}</span></div>}
      <p className="settings-note">Uninstall deletes only folders the studio placed (a marker install) — never a pack that was already there: pre-existing folders in the target are reported as "present — not studio-managed" (or "managed by ComfyUI" when the folder carries a git checkout or a Comfy-Registry pyproject), refused for install-over, and never deleted. A revision bump refetches at the pin. "Restart to activate" means the files are in place but the running instance has not loaded them yet. Packs without a license are never vendored — they install only through the consent-gated fetcher below.</p>
    </section>
    {/* (R-10, audit C F4) Fetch completion refreshes the PACK board too — a
        fetched pack auto-installs and its chip must flip without the board's
        own Refresh click; onScan alone left the models scan stale-chip pair. */}
    <FetchBrowser settings={settings} setSettings={setSettings} onAfterFetch={() => { onScan(); void refreshNodePacks() }} onAdoptCheckout={(path) => updateEngine({ checkoutPath: path })} focusEntryIds={packFetchFocus ?? undefined} onFocusConsumed={() => setPackFetchFocus(null)} />
    <section className="settings-section h3-stack-section">
      <div className="settings-heading"><div><Gauge size={19} /><span><strong>H3 engine stack</strong><small>Compares the selected files with the validated official ComfyUI stack.</small></span></div><span className={`health-pill ${h3Report.validated ? 'online' : ''}`}>{h3Report.validated ? 'Validated' : h3Report.ready ? 'Custom' : 'Incomplete'}</span></div>
      <div className="h3-stack-list">{h3Report.rows.map((row) => <div key={row.label} className={row.validated ? 'validated' : 'custom'}><span>{row.validated ? <Check size={14} /> : <AlertCircle size={14} />}</span><div><strong>{row.label}</strong><small title={row.selected || row.expected}>{row.selected || `Missing · expected ${row.expected}`}</small></div><em>{row.override ? 'Override' : row.validated ? 'Recommended' : row.selected ? 'Non-standard' : 'Missing'}</em></div>)}</div>
      <div className="h3-stack-list">{detectedTurboFamilies.length ? detectedTurboFamilies.map(({ entry, detection }) => <div key={entry.id} className="validated"><span><Check size={14} /></span><div><strong>{entry.label}</strong><small title={detection.model ?? entry.ui.installHint}>{detection.model ?? entry.ui.installHint}</small></div><em>{entry.pairing?.steps ?? '?'} steps{entry.pairing?.samplerNode ? ' · larryvrh-ready' : ''}</em></div>) : <div className="custom"><span><AlertCircle size={14} /></span><div><strong>No turbo families detected</strong><small>Install an official or community turbo LoRA into ComfyUI/models/loras, then rescan.</small></div><em>Missing</em></div>}</div>
      {!h3Report.validated && <p className="settings-warning"><AlertCircle size={15} />Some components differ from the validated H3 stack. Generation remains available, but output quality may differ.</p>}
      <div className="diagnostic-action"><span><strong>Fixed quality comparison</strong><small>Queues Native Quality and Turbo 8 at 1344 × 768, 5 seconds, seed 12345, with no upscale.</small></span><button className="secondary-button" disabled={!status.connected || diagnosticRunning || !h3Report.ready} onClick={onRunDiagnostics}>{diagnosticRunning ? <LoaderCircle className="spin" size={15} /> : <Activity size={15} />}{diagnosticRunning ? 'Queuing tests…' : 'Run H3 Quality Test'}</button></div>
    </section>
    <section className="settings-section model-overrides-section" aria-label="Model overrides">
      <div className="settings-heading"><div><Layers size={19} /><span><strong>Model overrides</strong><small>Pin the exact checkpoint, text encoder, or VAE per engine family — for files the name-pattern inference can never find (a community merge, a renamed quant). Auto keeps the inferred pick; a per-chain pick (the chain's properties panel) beats these, which beat auto. The H3 families expose FL2VA / Ref2VA / merged checkpoint lanes; the VAE picks split by decoder — video, audio, and (the workbench only) the T=1 image decoder.</small></span></div></div>
      <div className="model-override-list">
        {MODEL_FAMILIES.map((family) => {
          const current = settings.modelOverrides?.[family.id] ?? {}
          return <div className="model-override-family" key={family.id} data-model-override-family={family.id}>
            <div className="model-override-family-head"><strong>{family.label}</strong><small>{family.note}</small></div>
            {family.slots.map((slot) => {
              const value = current[slot] ?? ''
              const kind = family.slotKinds[slot] ?? 'diffusion_models'
              const candidates = models.filter((model) => model.kind === kind)
              const autoFile = inferredOverrideSlotFile(family.id, slot, models)
              const outcome = value ? overridePickOutcome(family.id, slot, value, models) : null
              return <div className={`model-override-row${outcome?.state === 'refused' ? ' refused' : outcome?.state === 'degraded' ? ' degraded' : ''}`} key={slot} data-model-override-slot={slot}>
                <div className="model-override-slot"><strong>{SLOT_LABELS[slot]}</strong><small>{candidates.length} {kind.replace(/_/g, ' ')} file{candidates.length === 1 ? '' : 's'} on the connected engine</small></div>
                <div className="select-wrap">
                  <select aria-label={`${family.label} — ${SLOT_LABELS[slot]}`} value={value} onChange={(event) => setModelOverride(family.id, slot, event.target.value)}>
                    <option value="">auto (inferred){autoFile ? ` — ${autoFile}` : ' — nothing detected'}</option>
                    {candidates.map((model) => <option key={model.name} value={model.name}>{model.name}</option>)}
                  </select>
                  <ChevronDown size={15} />
                </div>
                {outcome?.state === 'refused' && <p className="model-override-problem" data-model-override-problem role="alert">Refused — {outcome.reason} Clear the pick to render on auto.</p>}
                {outcome?.state === 'degraded' && <p className="model-override-problem" data-model-override-problem role="status">{outcome.warning}</p>}
                {outcome?.state === 'applied' && outcome.warning && <p className="model-override-problem" data-model-override-problem role="status">{outcome.warning}</p>}
              </div>
            })}
          </div>
        })}
      </div>
      <p className="settings-note">Picks are exact names from the connected engine's model registry — the engine-relative subpath the graph loader accepts. A pick the registry later stops listing falls back to auto with a warning at render time; a pick the family cannot load (wrong folder, a cross-class VAE) refuses the render with the reason — never a doomed graph. The registry lists filenames only, so nothing about a file's internals is verified app-side: the engine loads the pick or fails loudly with a readable error. The H3 families pin FL2VA and Ref2VA per render lane; the merged pick is ONE pre-merged checkpoint for both lanes and wins when set. VAE slots are decoder-specific (video / audio / image): a pick whose filename marks another decoder class refuses — the T=1 image decoder is legal only on the workbench's image-VAE slot, never in a video graph.</p>
    </section>
    <section className="settings-section setup-doctor-section">
      <div className="settings-heading"><div><Stethoscope size={19} /><span><strong>Setup doctor</strong><small>Verifies FFmpeg, HTTPS tooling, the engine device, and attention backends — with exact fixes.</small></span></div><button className="secondary-button" onClick={() => void runDoctor()} disabled={doctorRunning}>{doctorRunning ? <LoaderCircle size={16} className="spin" /> : <Stethoscope size={16} />}{doctorRunning ? 'Checking…' : 'Run checks'}</button></div>
      {doctor && <div className="doctor-report">{doctor.checks.map((check) => <div className={`doctor-check ${check.status}`} key={check.id}><span>{check.status === 'ok' ? <Check size={14} /> : <AlertCircle size={14} />}</span><div><strong>{check.label}</strong><small>{check.detail}</small>{check.recommendation && <p>{check.recommendation}</p>}</div></div>)}</div>}
    </section>
    <section className="settings-section graph-compat-section">
      <div className="settings-heading"><div><GitBranch size={19} /><span><strong>Graph compatibility</strong><small>The ComfyUI version this studio's graph families were last verified against.</small></span></div></div>
      {(() => {
        const connected = status.stats?.system?.comfyui_version
        const tested = settings.testedComfyVersion
        const newer = Boolean(connected && tested && connected !== tested)
        return <div className={`doctor-check ${newer ? 'warn' : 'ok'}`}><span>{newer ? <AlertCircle size={14} /> : <Check size={14} />}</span><div><strong>{newer ? 'ComfyUI updated since verification' : 'Graphs verified against this engine'}</strong><small>{connected ? `Connected engine: ${connected}. ` : 'Engine offline — version unknown. '}{tested ? `Graphs last verified against: ${tested}.` : 'No verification recorded yet; it is captured on the next successful connection.'}{newer ? ' Node changes in newer ComfyUI builds can break graphs — re-run the H3 Quality Test before trusting new renders, then the record updates on save.' : ''}</small></div></div>
      })()}
    </section>
    <section className="settings-section krea2-edit-section" aria-label="Krea 2 edit modes">
      <div className="settings-heading"><div><Wand2 size={19} /><span><strong>Krea 2 edit modes</strong><small>Per-workflow edit graphs over the resident Krea 2 checkpoint pair — availability-gated here; the canvas redesign owns the real editing UI.</small></span></div><span className={`health-pill ${editModesReady === krea2EditModes.length ? 'online' : ''}`}>{editModesReady} of {krea2EditModes.length} ready</span></div>
      <div className="preset-row" aria-label="Edit mode picker">
        {krea2EditModes.map(({ family, detection }) => <button type="button" className={selectedKrea2EditMode === family.id ? 'tier-selected' : ''} key={family.id} onClick={() => setSelectedKrea2EditMode(family.id)}><strong>{family.label}</strong><small>{detection.available ? `${family.checkpoint === 'raw' ? 'RAW' : 'Turbo'} · ${family.recipe.steps} steps · CFG ${family.recipe.cfg}` : 'Needs setup'}</small></button>)}
      </div>
      {(() => {
        const selected = krea2EditModes.find(({ family }) => family.id === selectedKrea2EditMode) ?? krea2EditModes[0]
        if (!selected) return null
        const { family, detection } = selected
        const dialCopy: Record<string, string> = {
          groundingPx: `grounding_px ${KREA2_RECIPE_PINS.groundingPx.default} (dial ${KREA2_RECIPE_PINS.groundingPx.min}–${KREA2_RECIPE_PINS.groundingPx.max}: lower = stronger edits, higher = stronger identity)`,
          refBoost: `ref_boost ${KREA2_RECIPE_PINS.refBoost.default} (likeness; UI cap ${KREA2_RECIPE_PINS.refBoost.uiCap} — above ${KREA2_RECIPE_PINS.refBoost.removalBreakAbove} breaks removals)`,
          refBoostA: 'ref_boost_a — the same likeness dial for the scene reference',
          fitMode: `fit geometry '${KREA2_RECIPE_PINS.fitMode.default}' ('${KREA2_RECIPE_PINS.fitMode.legacy}' only for older weights)`,
          steps: `steps ${family.recipe.steps} (band ${KREA2_RECIPE_PINS.turboStepsBand.min}–${KREA2_RECIPE_PINS.turboStepsBand.max})`,
          cfg: 'CFG — above 1 the negative is grounded automatically (empty prompt + same image)',
          mask: 'mask: white generates, black is preserved (Mask Editor)',
          padding: `padding per side on a ${KREA2_RECIPE_PINS.anypaint.paddingStep}px grid; mask + padding in one request = mixed`,
        }
        const missing = [...detection.missingNodes.map((nodeClass) => `node ${nodeClass} (node pack)`), ...detection.missingModels]
        return <div className={`doctor-check ${detection.available ? 'ok' : 'warn'}`}>
          <span>{detection.available ? <Check size={14} /> : <AlertCircle size={14} />}</span>
          <div>
            <strong>{family.label}{detection.available && detection.resolved ? ` — ${detection.resolved.diffusion} + ${detection.resolved.lora}` : ''}</strong>
            <small>{family.ui.description}</small>
            <p>{family.recipe.sampler}+{family.recipe.scheduler} · LoRA @{family.recipe.loraStrength} · {family.recipeTriple.carrier}</p>
            {family.ui.promptGuidance && <p>Prompting: {family.ui.promptGuidance}</p>}
            <p>Dials: {family.dials.map((dial) => dialCopy[dial]).filter(Boolean).join(' · ') || 'pinned recipe — no dials'}</p>
            {family.ui.warning && <p>{family.ui.warning}</p>}
            {missing.length > 0 && <p>Missing: {missing.join('; ')}. {family.ui.installHint}</p>}
          </div>
        </div>
      })()}
    </section>
    <section className="settings-section gpu-tier-section">
      <div className="settings-heading"><div><Gauge size={19} /><span><strong>GPU tier guidance</strong><small>Community quant and workload recommendations per VRAM tier. Stored with settings; guidance only.</small></span></div></div>
      <div className="preset-row" aria-label="GPU tiers">
        {gpuTiers.map((tier) => <button type="button" className={settings.gpuTier === tier.id ? 'tier-selected' : ''} key={tier.id} onClick={() => setSettings({ ...settings, gpuTier: tier.id })}><strong>{tier.label}</strong><small>{tier.guidance}</small></button>)}
      </div>
    </section>
    <section className="settings-section generation-defaults-section">
      <div className="settings-heading"><div><SlidersHorizontal size={19} /><span><strong>Generation defaults</strong><small>Choose the starting values for the main Create workspace — every NEW chain starts from them.</small></span></div><button className="secondary-button" data-apply-defaults disabled={!recommendedDeltaNotes.length} title={recommendedDeltaNotes.length ? `Sets tuned defaults back to the recommended set — asks first, naming every change (currently: ${recommendedDeltaNotes.length})` : 'Already at the recommended set'} onClick={resetToRecommended}>Reset to recommended</button></div>
      <div className="preset-row" aria-label="Generation presets">
        <button type="button" onClick={() => applyPreset('quality')}><strong>Native Quality</strong><small>1344 × 768 · 30 steps · no upscale</small></button>
        <button type="button" onClick={() => applyPreset('official-turbo')}><strong>Turbo 8</strong><small>Native canvas · official LoRA 1.0</small></button>
        <button type="button" onClick={() => applyPreset('preview')}><strong>Preview</strong><small>864 × 480 · official Turbo 8</small></button>
      </div>
      <div className="generation-defaults-grid">
        <SelectField label="Default resolution" value={defaults.resolution} onChange={(resolution) => updateDefaults({ resolution })} options={['608x352', '864x480', '1056x608', '1344x768', '768x1344', '768x768'].map((value) => [value, value.replace('x', ' × ')])} />
        <NumberField label="Default duration (seconds)" value={defaults.duration} min={2} max={15} step={0.5} onChange={(duration) => updateDefaults({ duration })} />
        <SelectField label="Default quality" value={defaults.turbo === '4' ? '8' : defaults.turbo} onChange={(turbo) => updateDefaults({ turbo: turbo as 'off' | '8', ...(turbo === 'off' ? { steps: 30 } : {}) })} options={[["off", 'Native quality · 30 steps'], ["8", 'Official Turbo 8']]} />
        <NumberField label="Full-quality steps" value={defaults.steps} min={16} max={30} onChange={(steps) => updateDefaults({ steps })} />
        <SelectField label="Reference image fidelity" value={defaults.refImageSize} onChange={(refImageSize) => updateDefaults({ refImageSize: refImageSize as 'match' | 'max' })} options={[["match", 'Match output · faster'], ["max", 'Maximum identity · slower']]} />
        <SelectField label="Default post-render upscale" value={defaults.upscaleMode} onChange={(upscaleMode) => updateDefaults({ upscaleMode: upscaleMode as UpscaleMode })} options={[["off", 'Off · recommended for diagnosis'], ["rtx", 'RTX/CUDA frames · 2× · experimental']]} />
        <label className="settings-check"><input type="checkbox" checked={defaults.livePreview} onChange={(event) => updateDefaults({ livePreview: event.target.checked })} /><span><strong>Live preview by default</strong><small>Uses ComfyUI progress and preview events.</small></span></label>
      </div>
      <details className="experimental-settings"><summary><AlertCircle size={15} /><span><strong>Experimental sampling</strong><small>Custom samplers, shifts, LoRA strength, and 4-step FL2V can make output less stable.</small></span><ChevronDown size={15} /></summary><div className="generation-defaults-grid"><label className="settings-check"><input type="checkbox" checked={defaults.experimentalSampling} onChange={(event) => updateDefaults({ experimentalSampling: event.target.checked })} /><span><strong>Enable custom sampler</strong><small>Otherwise res_multistep + simple is forced.</small></span></label><SelectField label="Experimental Turbo override" value={defaults.turbo} onChange={(turbo) => updateDefaults({ turbo: turbo as 'off' | '4' | '8' })} options={[["off", 'Off'], ["8", 'Official 8-step'], ["4", '4-step preview testing']]} /><NumberField label="Turbo LoRA strength" value={defaults.loraStrength} min={0} max={2} step={0.05} onChange={(loraStrength) => updateDefaults({ loraStrength })} /><SelectField label="Sampler" value={defaults.experimentalSampling ? defaults.sampler : 'res_multistep'} disabled={!defaults.experimentalSampling} onChange={(sampler) => updateDefaults({ sampler })} options={samplerOptions.map((value) => [value, value])} /><SelectField label="Scheduler" value={defaults.experimentalSampling ? defaults.scheduler : 'simple'} disabled={!defaults.experimentalSampling} onChange={(scheduler) => updateDefaults({ scheduler })} options={schedulerOptions.map((value) => [value, value])} /><SelectField label="Sigma shifts" value={defaults.sigmaShiftMode} onChange={(sigmaShiftMode) => updateDefaults({ sigmaShiftMode: sigmaShiftMode as 'model' | 'custom' })} options={[["model", 'Native model defaults · 12 / 3'], ["custom", 'Custom MiniMaxH3SigmaShift node']]} /><NumberField label="Video sigma shift" value={defaults.shiftVideo} min={0.01} max={100} step={0.01} disabled={defaults.sigmaShiftMode !== 'custom'} onChange={(shiftVideo) => updateDefaults({ shiftVideo })} /><NumberField label="Audio sigma shift" value={defaults.shiftAudio} min={0.01} max={100} step={0.01} disabled={defaults.sigmaShiftMode !== 'custom'} onChange={(shiftAudio) => updateDefaults({ shiftAudio })} /></div></details>
      {warnedSampler && <p className="settings-warning"><AlertCircle size={15} />This sampler is on the compatibility-risk list you supplied. Test a short clip before committing to a final render.</p>}
      <p className="settings-note">The production path is 1344 × 768, 30 steps, res_multistep + simple, CFG 1, denoise 1, 24 fps, native 12/3 shifts, and upscale off. Custom sampling is intentionally separated because it complicates quality diagnosis.</p>
    </section>
    <section className="settings-section llm-section" aria-label="LLM router">
      <div className="settings-heading">
        <div><Cpu size={19} /><span><strong>LLM · llama.cpp router</strong><small>One router endpoint serves every text model (DeepSeek, Gemma, Qwen…). Empty address keeps the Ollama fallback below.</small></span></div>
        <span className={`health-pill ${llmList?.connected && llmList.provider === 'router' ? 'online' : ''}`}>{llmList?.provider === 'router' ? (llmList.connected ? `Router · ${llmList.models.length} models` : 'Router offline') : 'Ollama fallback'}</span>
      </div>
      <div className="connection-row">
        <div className="field-group grow"><label htmlFor="llm-router-url">Router address (router mode)</label><input id="llm-router-url" value={settings.llamaCppUrl} placeholder="http://127.0.0.1:8080 — empty = Ollama fallback" onChange={(event) => setSettings({ ...settings, llamaCppUrl: event.target.value })} /></div>
        <button className="secondary-button test-button" onClick={() => void testLlm(settings.llamaCppUrl)} disabled={llmTesting}>{llmTesting ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}Test connection</button>
      </div>
      {llmList && <div className={`llm-test-result ${llmList.connected ? 'ok' : 'fail'}`} role="status">
        {llmList.connected
          ? <><Check size={14} /><span>{llmList.provider === 'router' ? 'Router reachable' : 'Ollama reachable'} · {llmList.models.length} model{llmList.models.length === 1 ? '' : 's'} · {llmList.latencyMs} ms{llmList.model ? ` · active: ${llmList.model}` : ''}</span></>
          : <><AlertCircle size={14} /><span>{llmList.error || 'No models listed — check the address and that the server runs in router mode.'}</span></>}
      </div>}
      {llmList && llmList.models.length > 0 && <div className="llm-model-list" aria-label="Router models">
        {llmList.models.map((model) => {
          const selected = llmSelectedModel ? llmSelectedModel === model.id : model.active
          return (
          <button type="button" key={model.id} aria-pressed={selected} className={`llm-model-row ${selected ? 'active' : ''}`} onClick={() => setSettings({ ...settings, llamaCppModel: model.id })} title={selected ? 'Selected chat model (used on the next call; saves with Save settings)' : `Make ${model.id} the selected chat model`}>
            <span className={`llm-family-badge family-${model.family}`}>{model.family}</span>
            <span className="llm-model-name">{model.id}</span>
            <span className="llm-model-flags">{model.vision && <em title="Vision-capable (image input)"><Eye size={13} /> vision</em>}{model.status && <em className="llm-model-status">{model.status}</em>}{selected && <em className="llm-model-active"><Check size={13} /> selected</em>}</span>
          </button>
          )
        })}
      </div>}
      {llmList && llmList.connected && llmList.models.length > 0 && (llmSelectedModel
        ? <p className="settings-note" role="status">Next call uses <strong>{llmSelectedModel}</strong>{llmList.model && llmList.model !== llmSelectedModel ? ` (router currently has ${llmList.model} loaded — it loads per call)` : ''}. Saved with Save settings.</p>
        : <p className="settings-note">No model picked — the router decides per call. Pick a row above to pin one.</p>)}
      <div className="generation-defaults-grid">
        <label className="settings-check"><input type="checkbox" checked={settings.unloadLlmOnGenerate} onChange={(event) => setSettings({ ...settings, unloadLlmOnGenerate: event.target.checked })} /><span><strong><Unplug size={14} /> Unload models before generating</strong><small>Frees VRAM by unloading non-sticky router models when a render submits (≈2 s budget, never blocks the queue).</small></span></label>
        <label className="settings-check"><input type="checkbox" checked={settings.llmThinkingDefault === 'on'} onChange={(event) => setSettings({ ...settings, llmThinkingDefault: event.target.checked ? 'on' : 'off' })} /><span><strong>Thinking by default (freeform)</strong><small>Structured/JSON requests always run thinking-off for speed; this sets the default for freeform enhancement.</small></span></label>
        <SelectField label="Prompt writing style" value={settings.promptContentLevel} onChange={(promptContentLevel) => setSettings({ ...settings, promptContentLevel: promptContentLevel as AppSettings['promptContentLevel'] })} options={[['sfw', 'SFW · concrete visual'], ['suggestive', 'Suggestive · sensual mood'], ['nsfw', 'NSFW · explicit and precise']]} />
        <div className="field-group"><label htmlFor="llm-sticky-models">Sticky models (never unload)</label><input id="llm-sticky-models" value={settings.llamaStickyModels} placeholder="comma-separated ids or substrings" onChange={(event) => setSettings({ ...settings, llamaStickyModels: event.target.value })} /></div>
        {/* M8 (review 2026-09-19): llamaVisionModel was wired server-side
            (datasets captioning + vision scenarios) with no UI anywhere —
            settable only by hand-editing settings.json. The row names the
            resolution order honestly; the datalist offers the router's
            vision-capable models when it is reachable. */}
        <div className="field-group"><label htmlFor="llm-vision-model">Vision model (router)</label><input id="llm-vision-model" data-llm-vision-model value={settings.llamaVisionModel} placeholder="empty = first vision-capable router model" list="llm-vision-model-options" onChange={(event) => setSettings({ ...settings, llamaVisionModel: event.target.value })} /><datalist id="llm-vision-model-options">{(llmList?.models ?? []).filter((model) => model.vision).map((model) => <option key={model.id} value={model.id} />)}</datalist></div>
      </div>
      <p className="settings-note">Router mode auto-loads the requested model per call and {settings.unloadLlmOnGenerate ? 'unloads non-sticky models before each render' : 'keeps models resident between calls'}. Gemma needs the server started with --jinja. The vision model serves image and video captioning (the dataset manager) and vision scenarios — empty picks the first vision-capable router model. Nothing leaves this workstation.</p>
    </section>
    <section className="settings-section ollama-section">
      <div className="settings-heading">
        <div><Sparkles size={19} /><span><strong>Ollama prompt assistant</strong><small>Fallback provider — active while no router address is set above. Uses only text models installed on this computer.</small></span></div>
        <span className={`health-pill ${ollamaModels.length > 0 && !settings.llamaCppUrl.trim() ? 'online' : ''}`}>{settings.llamaCppUrl.trim() ? 'Fallback (router active)' : ollamaModels.length > 0 ? `${ollamaModels.length} local` : 'Offline'}</span>
      </div>
      <div className="ollama-grid">
        <div className="field-group"><label htmlFor="ollama-url">Ollama URL</label><input id="ollama-url" value={settings.ollamaUrl} onChange={(event) => setSettings({ ...settings, ollamaUrl: event.target.value })} /></div>
        <div className="field-group"><label htmlFor="ollama-model">Local model</label><div className="select-wrap"><select id="ollama-model" value={settings.ollamaModel} onChange={(event) => setSettings({ ...settings, ollamaModel: event.target.value })} disabled={ollamaModels.length === 0}>{ollamaModels.length === 0 ? <option value="">No local text models detected</option> : ollamaModels.map((model) => <option value={model.name} key={model.name}>{model.name}{model.parameterSize ? ` · ${model.parameterSize}` : ''}</option>)}</select><ChevronDown size={15} /></div></div>
        <button className="secondary-button test-button" onClick={onRefreshOllama}><RefreshCw size={16} />Refresh models</button>
      </div>
      <p className="settings-note">Prompts go directly to the local Ollama server. Embedding and cloud-backed models are excluded.</p>
    </section>
    <section className="settings-section"><div className="settings-heading"><div><HardDrive size={19} /><span><strong>Model inventory</strong><small>The connected engine's own registry is the model source of truth (instance-invisible = nonexistent) — there is no local folder list and no manual pointing. Refresh asks the engine to re-scan its folders and reads the listing again.</small></span></div><button className="secondary-button" onClick={onScan} disabled={scanning}>{scanning ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}{scanning ? 'Refreshing…' : 'Refresh from engine'}</button></div><div className="path-table">{pathRows.map((row) => { const kindModels = models.filter((model) => model.kind === row.kind); return <div className="path-row" key={row.kind}><div className="path-kind"><Folder size={17} /><span><strong>{row.label}</strong><small>{row.note}</small></span></div><span className="file-count" data-model-kind-count={row.kind}>{kindModels.length} file{kindModels.length === 1 ? '' : 's'} on the engine</span></div> })}{models.length === 0 && <div className="path-row"><div className="path-kind"><Folder size={17} /><span><strong>No models listed</strong><small>{status.connected ? 'The engine serves none of these folders yet — add weights where the engine reads them, then Refresh.' : 'The engine is offline — the registry is the only model source, so nothing can be listed until it connects.'}</small></span></div><span className="file-count">0 files</span></div>}</div></section>
    <section className="settings-section"><div className="settings-heading"><div><FolderOpen size={19} /><span><strong>Input &amp; output</strong><small>Renders and prepared media stay local, under the app folder by default.</small></span></div></div><div className="connection-row"><div className="field-group grow"><label htmlFor="input-path">Input directory</label><input id="input-path" data-input-path value={settings.inputDirectory} onChange={(event) => setSettings({ ...settings, inputDirectory: event.target.value })} /><PathCheckNote path={settings.inputDirectory} /></div></div><div className="connection-row"><div className="field-group grow"><label htmlFor="output-path">Output directory</label><input id="output-path" value={settings.outputDirectory} onChange={(event) => setSettings({ ...settings, outputDirectory: event.target.value })} /><PathCheckNote path={settings.outputDirectory} /></div></div><div className="connection-row clip-tool-path"><div className="field-group grow"><label htmlFor="ffmpeg-path">FFmpeg executable</label><input id="ffmpeg-path" value={settings.ffmpegPath} onChange={(event) => setSettings({ ...settings, ffmpegPath: event.target.value })} /></div></div><p className="settings-note">Unset, both default under the app's own data folder (<code>&lt;app&gt;/data/input</code>, <code>&lt;app&gt;/data/output</code>) — nothing lands in Documents. An absolute path you set is kept as-is. The clip editor uses FFmpeg for frame extraction, trim points, joining, and full-project export.</p></section>
    <section className="settings-section license-source-section" aria-label="License and source">
      <div className="settings-heading"><div><Scale size={19} /><span><strong>License &amp; source</strong><small>This app is free software — its source belongs to everyone who uses it.</small></span></div></div>
      <p className="settings-note">MiniMax Studio is licensed under the <strong>GNU AGPLv3</strong> (<a href="https://github.com/Cobdog/MINIMAX-DESKTOP/blob/main/LICENSE" target="_blank" rel="noreferrer">full text</a>). The corresponding source lives at <a href="https://github.com/Cobdog/MINIMAX-DESKTOP" target="_blank" rel="noreferrer">github.com/Cobdog/MINIMAX-DESKTOP</a> — if you run a modified copy for others over a network, share your source with them. Third-party components and model-weight licenses are inventoried in <a href="https://github.com/Cobdog/MINIMAX-DESKTOP/blob/main/docs/LICENSES.md" target="_blank" rel="noreferrer">docs/LICENSES.md</a>.</p>
    </section>
  </div>
}

/** The recommended generation-defaults baseline (review B2, 2026-09-19) —
 *  ONE constant for the reset affordance, replacing the hardcoded set the
 *  old dock's "Apply to Create" pushed. Duration is unified to 5: the
 *  Native Quality preset below, the server factory default, and the GPU-tier
 *  guidance all say 5 — the old copy's 6 was the outlier. Fields NOT listed
 *  here (reference size, live preview) are never touched by a reset. */
const RECOMMENDED_DEFAULTS: Partial<AppSettings['generationDefaults']> = {
  resolution: '1344x768', duration: 5, steps: 30, turbo: 'off', sampler: 'res_multistep',
  scheduler: 'simple', experimentalSampling: false, sigmaShiftMode: 'model',
  shiftVideo: 12, shiftAudio: 3, loraStrength: 1, upscaleMode: 'off',
}

/** Human labels for the delta list the reset confirm names. */
const DEFAULT_FIELD_LABELS: Record<keyof AppSettings['generationDefaults'], string> = {
  resolution: 'resolution', duration: 'duration (s)', steps: 'steps', turbo: 'turbo',
  sampler: 'sampler', scheduler: 'scheduler', experimentalSampling: 'custom sampling',
  sigmaShiftMode: 'sigma-shift mode', shiftVideo: 'video shift', shiftAudio: 'audio shift',
  loraStrength: 'LoRA strength', upscaleMode: 'upscale', refImageSize: 'reference image size',
  livePreview: 'live preview',
}

/** The status badge for one node-pack row (task mjhlt3k — the version-aware
 *  matrix over the 9om4bi9 presence discipline). Precedence: a FOLDER that
 *  exists carries the badge (presence + attribution + version — the thing
 *  the maintainer reads at a glance), with the live instance verdict as a
 *  "· live" suffix; a folder-less pack served by the connected instance is
 *  "installed on instance" (version unknowable from here — the instance
 *  serves the classes but its disk is not ours to read). A studio-marker
 *  install at the pin is "installed @ pin"; a drifted marker is "outdated"
 *  (markers only record revisions that WERE the pin — the registry moved).
 *  A foreign folder carrying a git checkout or a Comfy-Registry pyproject
 *  is "managed by ComfyUI" (info tone — calm, not an alarm); any other
 *  foreign folder keeps the honest "present — not studio-managed". */
function nodePackChip(pack: NodePackStatus): { label: string; tone: string } {
  const liveSuffix = pack.instanceState === 'active' ? ' · live' : ''
  if (pack.installed) {
    const atPin = pack.versionRelation !== 'differs'
    const base = atPin ? 'installed @ pin' : 'outdated'
    return pack.instanceState === 'absent'
      ? { label: `${base} — restart engine to activate`, tone: 'warn' }
      : { label: base + liveSuffix, tone: atPin ? 'ok' : 'warn' }
  }
  if (pack.folderState === 'foreign') {
    if (pack.versionInfo?.managedBy === 'comfyui') return { label: 'managed by ComfyUI' + liveSuffix, tone: 'info' }
    return pack.targetKind === 'external'
      ? { label: 'present — not studio-managed' + liveSuffix, tone: 'warn' }
      : { label: 'foreign folder' + liveSuffix, tone: 'warn' }
  }
  // (A foreign folder already returned above — reaching here means no
  // folder is present, so the live instance is the only install evidence.)
  if (pack.instanceState === 'active') return { label: 'installed on instance', tone: 'ok' }
  if (pack.targetKind === 'none') return { label: 'no install target', tone: 'muted' }
  return { label: 'missing', tone: 'muted' }
}

/** The version string beside the badge (AC-3): the discovered revision (sha
 *  shortened) or registry version, with its relation to the pin when one
 *  was determinable. Empty when nothing was discoverable — the honest
 *  "version unknown" is simply no string. */
function nodePackVersionText(pack: NodePackStatus): string {
  const version = pack.versionInfo?.version
  if (!version) return ''
  const shown = /^[0-9a-f]{40}$/i.test(version) ? version.slice(0, 12) : version
  const relation = pack.versionRelation
  const suffix = relation === 'ahead-of-pin' ? ' · ahead of pin'
    : relation === 'behind-pin' ? ' · behind pin'
      : relation === 'differs' ? ' · differs from pin'
        : relation === 'at-pin' && pack.versionInfo?.managedBy === 'comfyui' ? ' · at pin'
          : ''
  return shown + suffix
}
