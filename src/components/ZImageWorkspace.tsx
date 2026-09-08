import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Check, CircleStop, Dices, ImagePlus, LoaderCircle, Sparkles, WandSparkles } from 'lucide-react'
import { buildZImage } from '../lib/zimage'
import { choices, type ObjectInfo } from '../lib/comfyInfo'
import { RenderSize } from './RenderSize'
import type { MediaFile } from '../types'

type StoredWorkspace = {
  prompt: string
  resolution: string
  model: string
  encoder: string
  vae: string
  seed: number
}

const defaults: StoredWorkspace = {
  prompt: '',
  resolution: '1344x768',
  model: 'z_image_turbo_bf16.safetensors',
  encoder: 'qwen_3_4b.safetensors',
  vae: 'ae.safetensors',
  seed: Math.floor(Math.random() * 1_000_000_000),
}

function readWorkspace(): StoredWorkspace {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem('minimax.zimage-workspace') ?? '{}') } }
  catch { return defaults }
}

export function ZImageWorkspace({
  url, info, connected, ollamaAvailable, ollamaUrl, ollamaModel, onUse,
}: {
  url: string
  info: ObjectInfo
  connected: boolean
  ollamaAvailable: boolean
  ollamaUrl: string
  ollamaModel: string
  onUse(file: MediaFile, resolution: string): void
}) {
  const initial = useMemo(readWorkspace, [])
  const [prompt, setPrompt] = useState(initial.prompt)
  const [resolution, setResolution] = useState(initial.resolution)
  const [model, setModel] = useState(initial.model)
  const [encoder, setEncoder] = useState(initial.encoder)
  const [vae, setVae] = useState(initial.vae)
  const [seed, setSeed] = useState(initial.seed)
  const [job, setJob] = useState<{ id: string; url: string } | null>(null)
  const [result, setResult] = useState<MediaFile | null>(null)
  const [busy, setBusy] = useState(false)
  const [assisting, setAssisting] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)

  useEffect(() => {
    localStorage.setItem('minimax.zimage-workspace', JSON.stringify({ prompt, resolution, model, encoder, vae, seed }))
  }, [encoder, model, prompt, resolution, seed, vae])

  useEffect(() => {
    if (!job) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const history = await window.minimax.getHistory(job.url, job.id)
        const entry = history[job.id] as { status?: { status_str: string }; outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }> } | undefined
        if (entry?.status?.status_str === 'error') throw new Error('Z-Image failed. Check the selected components and ComfyUI log.')
        const image = Object.values(entry?.outputs ?? {}).flatMap((output) => output.images ?? [])[0]
        if (image) {
          const preview = await window.minimax.getOutputImage(job.url, image)
          if (!disposed) {
            setResult({ path: '', name: image.filename, preview, kind: 'image' })
            setJob(null); setBusy(false); setError(false); setMessage('Frame complete and ready to use.')
          }
          return
        }
        if (!disposed) setMessage('Rendering the first frame in ComfyUI…')
      } catch (caught) {
        if (!disposed) { setMessage(caught instanceof Error ? caught.message : String(caught)); setError(true); setBusy(false); setJob(null) }
        return
      }
      if (!disposed) timer = setTimeout(poll, 2000)
    }
    void poll()
    return () => { disposed = true; clearTimeout(timer) }
  }, [job])

  const available = choices(info, 'UNETLoader', 'unet_name').includes(model)
    && choices(info, 'CLIPLoader', 'clip_name').includes(encoder)
    && choices(info, 'VAELoader', 'vae_name').includes(vae)
  const fields = [
    { label: 'Z-Image model', value: model, set: setModel, node: 'UNETLoader', field: 'unet_name' },
    { label: 'Text encoder', value: encoder, set: setEncoder, node: 'CLIPLoader', field: 'clip_name' },
    { label: 'Image VAE', value: vae, set: setVae, node: 'VAELoader', field: 'vae_name' },
  ]

  const create = async () => {
    if (!connected || !available || !prompt.trim()) return
    setBusy(true); setResult(null); setError(false); setMessage('Submitting Z-Image Turbo workflow…')
    try {
      const [width, height] = resolution.split('x').map(Number)
      const response = await window.minimax.submitPrompt(url, buildZImage(prompt.trim(), width, height, seed, model, encoder, vae))
      setJob({ id: response.prompt_id, url })
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : String(caught)); setError(true); setBusy(false)
    }
  }

  const cancel = async () => {
    if (!job) return
    try {
      await window.minimax.cancelPrompt(job.url, job.id)
      setMessage('Frame generation cancelled.'); setError(false)
    } catch (caught) {
      setMessage(`Could not cancel: ${caught instanceof Error ? caught.message : String(caught)}`); setError(true)
    } finally { setJob(null); setBusy(false) }
  }

  const enhance = async () => {
    if (!ollamaAvailable || !prompt.trim() || assisting) return
    setAssisting(true); setError(false); setMessage('Asking the local prompt assistant…')
    try {
      const instruction = `Rewrite this as one polished still-image prompt for Z-Image Turbo. Preserve the subject and intent while improving composition, lens, lighting, environment, texture, color, and clarity. Do not describe motion, sound, timelines, or multiple shots. Return only the finished prompt.\n\nDRAFT:\n${prompt.trim()}`
      setPrompt(await window.minimax.generateWithOllama(ollamaUrl, ollamaModel, instruction))
      setMessage('Prompt enhanced locally. Review it before generating.')
    } catch (caught) { setMessage(caught instanceof Error ? caught.message : String(caught)); setError(true) }
    finally { setAssisting(false) }
  }

  return <div className="standard-page zimage-workspace">
    <div className="page-heading">
      <div><p className="eyebrow">LOCAL IMAGE WORKSPACE</p><h1>Create a first frame</h1><p>Design a still with Z-Image Turbo, then send it directly to MiniMax I2V.</p></div>
      <div className="heading-state"><span className={connected && available ? 'ok' : 'warn'}>{connected && available ? <Check size={15} /> : <AlertCircle size={15} />}{connected ? available ? 'Z-Image ready' : 'Select installed models' : 'Engine offline'}</span></div>
    </div>

    <div className="zimage-workspace-grid">
      <section className="zimage-composer">
        <div className="field-group">
          <div className="field-label"><label htmlFor="zimage-prompt">Image prompt</label><span>{prompt.length.toLocaleString()} characters</span></div>
          <textarea id="zimage-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe the subject, environment, composition, lens, lighting, color, and opening-frame details…" disabled={busy} />
          <div className="zimage-prompt-actions"><button className="secondary-button" onClick={() => void enhance()} disabled={busy || assisting || !ollamaAvailable || !prompt.trim()} title={ollamaAvailable ? `Enhance with ${ollamaModel}` : 'Configure Ollama in Settings'}>{assisting ? <LoaderCircle size={15} className="spin" /> : <WandSparkles size={15} />}Enhance with Ollama</button><small>{ollamaAvailable ? `${ollamaModel} · local` : 'Ollama unavailable'}</small></div>
        </div>

        <RenderSize value={resolution} onChange={setResolution} />
        <div className="zimage-seed-row"><label>Seed<input type="number" min="0" max="999999999999" value={seed} disabled={busy} onChange={(event) => setSeed(Number(event.target.value))} /></label><button className="secondary-button" disabled={busy} onClick={() => setSeed(Math.floor(Math.random() * 1_000_000_000))}><Dices size={15} />Randomize</button></div>

        <details className="zimage-model-settings">
          <summary>Model components <small>Advanced</small></summary>
          <div className="zimage-models">{fields.map((field) => <label key={field.label}>{field.label}<select value={field.value} disabled={busy} onChange={(event) => field.set(event.target.value)}>{!choices(info, field.node, field.field).includes(field.value) && <option value={field.value}>{field.value} · unavailable</option>}{choices(info, field.node, field.field).map((name) => <option key={name}>{name}</option>)}</select></label>)}</div>
          {!available && <p className="field-help">Choose Z-Image components registered with ComfyUI. Their safetensor folders remain controlled from Settings.</p>}
        </details>

        {message && <div className={`zimage-message ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>{busy && <LoaderCircle size={16} className="spin" />}<span>{message}</span></div>}
        <div className="zimage-generate-bar">{busy && <button className="danger-button" onClick={() => void cancel()}><CircleStop size={16} />Cancel</button>}<button className="primary-button" disabled={busy || !connected || !available || !prompt.trim()} onClick={() => void create()}>{busy ? <LoaderCircle size={18} className="spin" /> : <Sparkles size={18} />}{busy ? 'Creating frame…' : 'Create first frame'}</button></div>
      </section>

      <aside className="zimage-preview-panel">
        <div className="panel-heading"><div><span>OUTPUT</span><strong>First-frame preview</strong></div>{result && <span className="zimage-complete"><Check size={13} />Ready</span>}</div>
        <div className="zimage-preview-stage">{result?.preview ? <img src={result.preview} alt="Generated Z-Image first frame" /> : busy ? <div className="render-state"><LoaderCircle className="spin" /><strong>Creating your frame</strong><span>{resolution.replace('x', ' × ')}</span></div> : <div className="empty-preview"><div className="preview-icon"><ImagePlus size={28} /></div><strong>Your first frame will appear here</strong><span>Describe the still, select a canvas, and generate it locally.</span></div>}</div>
        <div className="zimage-preview-actions"><span>{result ? `${result.name} · ${resolution.replace('x', ' × ')}` : 'Saved to ComfyUI · MiniMax_first_frames'}</span><button className="primary-button" disabled={!result} onClick={() => result && onUse(result, resolution)}><ImagePlus size={16} />Use in MiniMax I2V</button></div>
      </aside>
    </div>
  </div>
}
