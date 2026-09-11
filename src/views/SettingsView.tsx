/** The Settings view: engine connection, validated H3 stack report,
 *  generation defaults, Ollama, model locations, and output/clip paths. */
import { useState } from 'react'
import { GitBranch } from 'lucide-react'
import { Activity, AlertCircle, Check, ChevronDown, Folder, FolderOpen, Gauge, HardDrive, LoaderCircle, RefreshCw, Save, SlidersHorizontal, Sparkles, Stethoscope } from 'lucide-react'
import type { AppSettings, ComfyStatus, ModelFile, ModelKind, OllamaModel, UpscaleMode } from '../types'
import { choices, type ObjectInfo } from '../lib/comfyInfo'
import type { h3StackReport } from '../lib/h3Stack'
import { SelectField, NumberField } from '../components/form'
import { formatBytes } from '../lib/format'
import type { DoctorReport } from '../lib/doctor'

export function SettingsView({ settings, setSettings, info, models, h3Report, scanning, status, checking, diagnosticRunning, ollamaModels, onRefreshOllama, onScan, onCheck, onSave, onApplyDefaults, onRunDiagnostics }: { settings: AppSettings; setSettings(value: AppSettings): void; info: ObjectInfo; models: ModelFile[]; h3Report: ReturnType<typeof h3StackReport>; scanning: boolean; status: ComfyStatus; checking: boolean; diagnosticRunning: boolean; ollamaModels: OllamaModel[]; onRefreshOllama(): void; onScan(): void; onCheck(): void; onSave(): void; onApplyDefaults(): void; onRunDiagnostics(): void }) {
  const pathRows: Array<{ kind: ModelKind; label: string; note: string }> = [
    { kind: 'diffusion_models', label: 'Diffusion models', note: 'FL2VA and Ref2VA checkpoints' },
    { kind: 'text_encoders', label: 'Text encoders', note: 'Qwen3-VL MiniMax encoder' },
    { kind: 'vae', label: 'VAE models', note: 'Video and audio decoders' },
    { kind: 'loras', label: 'LoRAs', note: '4-step and 8-step turbo adapters' },
    { kind: 'vae_approx', label: 'Preview models', note: 'Tiny H3 preview decoder' },
    { kind: 'clip_vision', label: 'Vision encoders', note: 'Optional reference encoders' },
  ]
  const defaults = settings.generationDefaults
  const updateDefaults = (patch: Partial<AppSettings['generationDefaults']>) => setSettings({ ...settings, generationDefaults: { ...defaults, ...patch } })
  const applyPreset = (preset: 'quality' | 'official-turbo' | 'preview') => {
    const common = { resolution: '1344x768', duration: 5, steps: 30, loraStrength: 1, shiftVideo: 12, upscaleMode: 'off' as const }
    if (preset === 'quality') updateDefaults({ ...common, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', experimentalSampling: false, sigmaShiftMode: 'model', shiftAudio: 3 })
    else if (preset === 'official-turbo') updateDefaults({ ...common, turbo: '8', sampler: 'res_multistep', scheduler: 'simple', experimentalSampling: false, sigmaShiftMode: 'model', shiftAudio: 3 })
    else updateDefaults({ ...common, resolution: '864x480', turbo: '8', sampler: 'res_multistep', scheduler: 'simple', experimentalSampling: false, sigmaShiftMode: 'model', shiftAudio: 3 })
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
  const gpuTiers: Array<{ id: NonNullable<AppSettings['gpuTier']>; label: string; guidance: string }> = [
    { id: '8', label: '8 GB', guidance: 'Pruned INT4 diffusion + INT4 text encoder · 864×480 · 5 s · one render at a time. GGUF only if INT4 is unavailable (ComfyUI manages dynamic VRAM better with safetensors).' },
    { id: '16', label: '16 GB', guidance: 'Pruned INT8/Q4 diffusion + INT4/INT8 text encoder · 1344×768 · 5 s first · queue one at a time. Tiled VAE covers the auto-retry path.' },
    { id: '24', label: '24 GB', guidance: 'Q5 or pruned INT8 diffusion + INT8 text encoder · 1344×768 · up to 10 s · comfortable queueing. INT8 is the best-tested community tier.' },
    { id: 'blackwell', label: 'Blackwell', guidance: 'NVFP4 diffusion + NVFP4-AWQ text encoder · native resolution/duration headroom · SageAttention and Sol-Attn give the largest speedups here.' },
  ]
  return <div className="standard-page settings-page"><div className="page-heading"><div><p className="eyebrow">APPLICATION</p><h1>Settings</h1><p>Point the studio at your existing local engine and model folders.</p></div><button className="primary-button" onClick={onSave}><Save size={17} />Save settings</button></div>
    <section className="settings-section"><div className="settings-heading"><div><Activity size={19} /><span><strong>ComfyUI engine</strong><small>The desktop app communicates only with this local address.</small></span></div><span className={`health-pill ${status.connected ? 'online' : ''}`}>{status.connected ? 'Connected' : 'Offline'}</span></div><div className="connection-row"><div className="field-group grow"><label htmlFor="comfy-url">Server URL</label><input id="comfy-url" value={settings.comfyUrl} onChange={(event) => setSettings({ ...settings, comfyUrl: event.target.value })} /></div><button className="secondary-button test-button" onClick={onCheck} disabled={checking}>{checking ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}Test connection</button></div>{status.connected && status.stats?.devices?.[0] && <div className="device-strip"><Gauge size={17} /><span><strong>{status.stats.devices[0].name ?? 'Compute device'}</strong><small>{status.stats.devices[0].vram_total ? `${formatBytes(status.stats.devices[0].vram_total)} VRAM · ${formatBytes(status.stats.devices[0].vram_free ?? 0)} free` : 'ComfyUI device detected'}</small></span></div>}</section>
    <section className="settings-section h3-stack-section">
      <div className="settings-heading"><div><Gauge size={19} /><span><strong>H3 engine stack</strong><small>Compares the selected files with the validated official ComfyUI stack.</small></span></div><span className={`health-pill ${h3Report.validated ? 'online' : ''}`}>{h3Report.validated ? 'Validated' : h3Report.ready ? 'Custom' : 'Incomplete'}</span></div>
      <div className="h3-stack-list">{h3Report.rows.map((row) => <div key={row.label} className={row.validated ? 'validated' : 'custom'}><span>{row.validated ? <Check size={14} /> : <AlertCircle size={14} />}</span><div><strong>{row.label}</strong><small title={row.selected || row.expected}>{row.selected || `Missing · expected ${row.expected}`}</small></div><em>{row.validated ? 'Recommended' : row.selected ? 'Non-standard' : 'Missing'}</em></div>)}</div>
      {!h3Report.validated && <p className="settings-warning"><AlertCircle size={15} />Some components differ from the validated H3 stack. Generation remains available, but output quality may differ.</p>}
      <div className="diagnostic-action"><span><strong>Fixed quality comparison</strong><small>Queues Native Quality and Turbo 8 at 1344 × 768, 5 seconds, seed 12345, with no upscale.</small></span><button className="secondary-button" disabled={!status.connected || diagnosticRunning || !h3Report.ready} onClick={onRunDiagnostics}>{diagnosticRunning ? <LoaderCircle className="spin" size={15} /> : <Activity size={15} />}{diagnosticRunning ? 'Queuing tests…' : 'Run H3 Quality Test'}</button></div>
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
    <section className="settings-section gpu-tier-section">
      <div className="settings-heading"><div><Gauge size={19} /><span><strong>GPU tier guidance</strong><small>Community quant and workload recommendations per VRAM tier. Stored with settings; guidance only.</small></span></div></div>
      <div className="preset-row" aria-label="GPU tiers">
        {gpuTiers.map((tier) => <button type="button" className={settings.gpuTier === tier.id ? 'tier-selected' : ''} key={tier.id} onClick={() => setSettings({ ...settings, gpuTier: tier.id })}><strong>{tier.label}</strong><small>{tier.guidance}</small></button>)}
      </div>
    </section>
    <section className="settings-section generation-defaults-section">
      <div className="settings-heading"><div><SlidersHorizontal size={19} /><span><strong>Generation defaults</strong><small>Choose the starting values for the main Create workspace.</small></span></div><button className="secondary-button" onClick={onApplyDefaults}>Apply to Create</button></div>
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
        <SelectField label="Default post-render upscale" value={defaults.upscaleMode} onChange={(upscaleMode) => updateDefaults({ upscaleMode: upscaleMode as UpscaleMode })} options={[["off", 'Off · recommended for diagnosis'], ["ltx", 'LTX 2.5 latent · 2×'], ["rtx", 'RTX/CUDA frames · 2× · experimental']]} />
        <label className="settings-check"><input type="checkbox" checked={defaults.livePreview} onChange={(event) => updateDefaults({ livePreview: event.target.checked })} /><span><strong>Live preview by default</strong><small>Uses ComfyUI progress and preview events.</small></span></label>
      </div>
      <details className="experimental-settings"><summary><AlertCircle size={15} /><span><strong>Experimental sampling</strong><small>Custom samplers, shifts, LoRA strength, and 4-step FL2V can make output less stable.</small></span><ChevronDown size={15} /></summary><div className="generation-defaults-grid"><label className="settings-check"><input type="checkbox" checked={defaults.experimentalSampling} onChange={(event) => updateDefaults({ experimentalSampling: event.target.checked })} /><span><strong>Enable custom sampler</strong><small>Otherwise res_multistep + simple is forced.</small></span></label><SelectField label="Experimental Turbo override" value={defaults.turbo} onChange={(turbo) => updateDefaults({ turbo: turbo as 'off' | '4' | '8' })} options={[["off", 'Off'], ["8", 'Official 8-step'], ["4", '4-step preview testing']]} /><NumberField label="Turbo LoRA strength" value={defaults.loraStrength} min={0} max={2} step={0.05} onChange={(loraStrength) => updateDefaults({ loraStrength })} /><SelectField label="Sampler" value={defaults.experimentalSampling ? defaults.sampler : 'res_multistep'} disabled={!defaults.experimentalSampling} onChange={(sampler) => updateDefaults({ sampler })} options={samplerOptions.map((value) => [value, value])} /><SelectField label="Scheduler" value={defaults.experimentalSampling ? defaults.scheduler : 'simple'} disabled={!defaults.experimentalSampling} onChange={(scheduler) => updateDefaults({ scheduler })} options={schedulerOptions.map((value) => [value, value])} /><SelectField label="Sigma shifts" value={defaults.sigmaShiftMode} onChange={(sigmaShiftMode) => updateDefaults({ sigmaShiftMode: sigmaShiftMode as 'model' | 'custom' })} options={[["model", 'Native model defaults · 12 / 3'], ["custom", 'Custom MiniMaxH3SigmaShift node']]} /><NumberField label="Video sigma shift" value={defaults.shiftVideo} min={0.01} max={100} step={0.01} disabled={defaults.sigmaShiftMode !== 'custom'} onChange={(shiftVideo) => updateDefaults({ shiftVideo })} /><NumberField label="Audio sigma shift" value={defaults.shiftAudio} min={0.01} max={100} step={0.01} disabled={defaults.sigmaShiftMode !== 'custom'} onChange={(shiftAudio) => updateDefaults({ shiftAudio })} /></div></details>
      {warnedSampler && <p className="settings-warning"><AlertCircle size={15} />This sampler is on the compatibility-risk list you supplied. Test a short clip before committing to a final render.</p>}
      <p className="settings-note">The production path is 1344 × 768, 30 steps, res_multistep + simple, CFG 1, denoise 1, 24 fps, native 12/3 shifts, and upscale off. Custom sampling is intentionally separated because it complicates quality diagnosis.</p>
    </section>
    <section className="settings-section ollama-section">
      <div className="settings-heading">
        <div><Sparkles size={19} /><span><strong>Ollama prompt assistant</strong><small>Uses only text models installed on this computer.</small></span></div>
        <span className={`health-pill ${ollamaModels.length > 0 ? 'online' : ''}`}>{ollamaModels.length > 0 ? `${ollamaModels.length} local` : 'Offline'}</span>
      </div>
      <div className="ollama-grid">
        <div className="field-group"><label htmlFor="ollama-url">Ollama URL</label><input id="ollama-url" value={settings.ollamaUrl} onChange={(event) => setSettings({ ...settings, ollamaUrl: event.target.value })} /></div>
        <div className="field-group"><label htmlFor="ollama-model">Local model</label><div className="select-wrap"><select id="ollama-model" value={settings.ollamaModel} onChange={(event) => setSettings({ ...settings, ollamaModel: event.target.value })} disabled={ollamaModels.length === 0}>{ollamaModels.length === 0 ? <option value="">No local text models detected</option> : ollamaModels.map((model) => <option value={model.name} key={model.name}>{model.name}{model.parameterSize ? ` · ${model.parameterSize}` : ''}</option>)}</select><ChevronDown size={15} /></div></div>
        <button className="secondary-button test-button" onClick={onRefreshOllama}><RefreshCw size={16} />Refresh models</button>
      </div>
      <p className="settings-note">Prompts go directly to the local Ollama server. Embedding and cloud-backed models are excluded.</p>
    </section>
    <section className="settings-section"><div className="settings-heading"><div><HardDrive size={19} /><span><strong>Model locations</strong><small>Files are indexed in place and are never moved or copied.</small></span></div><button className="secondary-button" onClick={onScan} disabled={scanning}>{scanning ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}{scanning ? 'Scanning…' : 'Rescan'}</button></div><div className="path-table">{pathRows.map((row) => { const count = models.filter((model) => model.kind === row.kind).length; return <div className="path-row" key={row.kind}><div className="path-kind"><Folder size={17} /><span><strong>{row.label}</strong><small>{row.note}</small></span></div><div className="path-input"><input value={settings.paths[row.kind]} onChange={(event) => setSettings({ ...settings, paths: { ...settings.paths, [row.kind]: event.target.value } })} /></div><span className="file-count">{count} files</span></div>})}</div></section>
    <section className="settings-section"><div className="settings-heading"><div><FolderOpen size={19} /><span><strong>Output & clip tools</strong><small>Completed videos, extracted frames, and editor exports stay local.</small></span></div></div><div className="connection-row"><div className="field-group grow"><label htmlFor="output-path">Output directory</label><input id="output-path" value={settings.outputDirectory} onChange={(event) => setSettings({ ...settings, outputDirectory: event.target.value })} /></div></div><div className="connection-row clip-tool-path"><div className="field-group grow"><label htmlFor="ffmpeg-path">FFmpeg executable</label><input id="ffmpeg-path" value={settings.ffmpegPath} onChange={(event) => setSettings({ ...settings, ffmpegPath: event.target.value })} /></div></div><p className="settings-note">The clip editor uses FFmpeg for frame extraction, trim points, joining, and full-project export.</p></section>
  </div>
}
