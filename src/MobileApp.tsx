import { useEffect, useMemo, useRef, useState } from 'react'
import { CircleStop, Download, Film, Image as ImageIcon, LoaderCircle, Play, RefreshCw, Smartphone, Sparkles, WandSparkles, X } from 'lucide-react'
import { ImageCrop } from './components/ImageCrop'
import { RenderSize } from './components/RenderSize'
import { prepareImage } from './lib/imageCrop'
import { inferLtx25Selections, inferSelections } from './lib/modelSelection'
import { buildMiniMaxWorkflow } from './lib/workflow'
import { buildLtx25Workflow } from './lib/ltx25Workflow'
import type { MediaFile, ModelFile } from './types'

type Bootstrap = { connected: boolean; latencyMs: number; models: ModelFile[]; upscalers?: string[]; ltxModel?: string; ltxVae?: string; ollamaModels?: string[]; ollamaModel?: string; error?: string }
type MobileStatus = 'ready' | 'uploading' | 'queued' | 'rendering' | 'complete' | 'error'
type MobileUpscale = 'off' | 'ltx' | 'rtx'
type MobileProvider = 'minimax' | 'ltx25'
type InstallPrompt = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

type StoredMobileWorkspace = Partial<{ mode: 'text' | 'image'; prompt: string; resolution: string; duration: number; quality: 'quality' | 'turbo'; upscale: MobileUpscale; rtxModel: string }>

function readMobileWorkspace(provider: MobileProvider = 'minimax') {
  try { return JSON.parse(localStorage.getItem(provider === 'ltx25' ? 'ltx25.mobile-workspace' : 'minimax.mobile-workspace') ?? '{}') as StoredMobileWorkspace }
  catch { return {} }
}

const queryToken = new URLSearchParams(location.search).get('token') ?? ''
if (queryToken) localStorage.setItem('minimax.lan-token', queryToken)
const token = queryToken || localStorage.getItem('minimax.lan-token') || ''

async function lanFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (token === 'browser-preview') {
    if (path === '/api/lan/bootstrap') return { connected: true, latencyMs: 7, models: previewModels, upscalers: ['4x-UltraSharp.pth'], ltxModel: 'ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors', ltxVae: 'ltx-2.5-video-vae-bf16.safetensors', ollamaModels: ['qwen3:latest'], ollamaModel: 'qwen3:latest' } as T
    throw new Error('Generation is available from the QR link shown in the desktop app.')
  }
  const response = await fetch(path, { ...init, headers: { ...init?.headers, 'x-minimax-token': token } })
  const data = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(data.error || `MiniMax Studio returned ${response.status}.`)
  return data
}

export default function MobileApp() {
  const initialProvider = useMemo(() => localStorage.getItem('mobile.active-provider') === 'ltx25' ? 'ltx25' as const : 'minimax' as const, [])
  const stored = useMemo(() => readMobileWorkspace(initialProvider), [initialProvider])
  const [provider, setProvider] = useState<MobileProvider>(initialProvider)
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null)
  const [mode, setMode] = useState<'text' | 'image'>(stored.mode ?? 'text')
  const [prompt, setPrompt] = useState(stored.prompt ?? '')
  const [frame, setFrame] = useState<MediaFile | null>(null)
  const [resolution, setResolution] = useState(stored.resolution ?? '768x448')
  const [duration, setDuration] = useState(stored.duration ?? 5)
  const [quality, setQuality] = useState<'quality' | 'turbo'>(stored.quality ?? 'turbo')
  const [upscale, setUpscale] = useState<MobileUpscale>(stored.upscale ?? 'off')
  const [rtxModel, setRtxModel] = useState(stored.rtxModel ?? '')
  const [status, setStatus] = useState<MobileStatus>('ready')
  const [message, setMessage] = useState('')
  const [outputUrl, setOutputUrl] = useState('')
  const [livePreview, setLivePreview] = useState('')
  const [progress, setProgress] = useState(0)
  const [promptId, setPromptId] = useState('')
  const [assistantInstruction, setAssistantInstruction] = useState('')
  const [assisting, setAssisting] = useState(false)
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null)
  const cancelled = useRef(false)
  const models = useMemo(() => bootstrap?.models ?? [], [bootstrap?.models])
  const turbo = quality === 'turbo' ? '8' as const : 'off' as const
  const selection = useMemo(() => inferSelections(models, turbo), [models, turbo])
  const ltxSelection = useMemo(() => inferLtx25Selections(models, bootstrap?.ltxModel ? [bootstrap.ltxModel] : []), [bootstrap?.ltxModel, models])
  const miniMaxReady = Boolean(selection.fl2va && selection.textEncoder && selection.videoVae && selection.audioVae && (turbo === 'off' || selection.fl2vLora))
  const ltxReady = Boolean(ltxSelection.diffusion && ltxSelection.textEncoder && ltxSelection.videoVae && ltxSelection.audioVae && ltxSelection.latentUpscaler)
  const modelReady = provider === 'ltx25' ? ltxReady : miniMaxReady
  const renderDuration = provider === 'ltx25' ? Math.min(duration, 10) : duration

  useEffect(() => {
    if (!rtxModel && bootstrap?.upscalers?.length) setRtxModel(bootstrap.upscalers[0])
  }, [bootstrap?.upscalers, rtxModel])

  useEffect(() => {
    localStorage.setItem(provider === 'ltx25' ? 'ltx25.mobile-workspace' : 'minimax.mobile-workspace', JSON.stringify({ mode, prompt, resolution, duration, quality, upscale, rtxModel }))
    localStorage.setItem('mobile.active-provider', provider)
  }, [duration, mode, prompt, provider, quality, resolution, rtxModel, upscale])

  const changeProvider = (next: MobileProvider) => {
    if (next === provider || ['uploading', 'queued', 'rendering'].includes(status)) return
    const nextWorkspace = readMobileWorkspace(next)
    setProvider(next)
    setMode(nextWorkspace.mode ?? 'text')
    setPrompt(nextWorkspace.prompt ?? '')
    setResolution(nextWorkspace.resolution ?? (next === 'ltx25' ? '1280x736' : '768x448'))
    setDuration(nextWorkspace.duration ?? 5)
    setQuality(nextWorkspace.quality ?? (next === 'ltx25' ? 'quality' : 'turbo'))
    setUpscale(next === 'ltx25' ? 'off' : nextWorkspace.upscale ?? 'off')
    setOutputUrl(''); setLivePreview(''); setProgress(0); setPromptId(''); setMessage(''); setStatus('ready')
  }

  const refresh = async () => {
    try { setBootstrap(await lanFetch<Bootstrap>('/api/lan/bootstrap')); setMessage('') }
    catch (error) { setBootstrap({ connected: false, latencyMs: 0, models: [], error: error instanceof Error ? error.message : String(error) }) }
  }

  useEffect(() => { void refresh() }, [])
  useEffect(() => {
    const capture = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPrompt) }
    window.addEventListener('beforeinstallprompt', capture)
    if ('serviceWorker' in navigator && window.isSecureContext) void navigator.serviceWorker.register('/sw.js')
    return () => window.removeEventListener('beforeinstallprompt', capture)
  }, [])

  const chooseFrame = (file?: File) => {
    if (!file) return
    if (!file.type.startsWith('image/')) { setMessage('Choose a PNG, JPG, or WebP image.'); return }
    if (file.size > 24 * 1024 * 1024) { setMessage('Choose an image smaller than 24 MB.'); return }
    const reader = new FileReader()
    reader.onload = () => { setFrame({ path: file.name, name: file.name, kind: 'image', preview: String(reader.result) }); setMode('image'); setMessage('') }
    reader.readAsDataURL(file)
  }

  const runAssistant = async (task: 'enhance' | 'timeline' | 'audio' | 'custom') => {
    if (!prompt.trim() || assisting || !bootstrap?.ollamaModels?.length) return
    const direction = task === 'enhance'
      ? `Rewrite this into one polished ${provider === 'ltx25' ? 'LTX-2.5' : 'MiniMax H3'} video prompt with precise subject action, camera, lighting, physical motion, pacing, and synchronized audio.`
      : task === 'timeline'
        ? `Rewrite this as a concise time-coded sequence lasting exactly ${renderDuration} seconds. Preserve continuity and include camera and audio cues.`
        : task === 'audio'
          ? 'Preserve the visuals and improve dialogue, ambience, sound effects, music, spatial audio placement, and timing.'
          : assistantInstruction.trim()
    if (!direction) { setMessage('Tell the assistant what you want changed.'); return }
    setAssisting(true); setMessage('Ollama is refining the prompt on your desktop…')
    try {
      const result = await lanFetch<{ response: string }>('/api/lan/ollama', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: `${direction}\nReturn only the revised generation prompt.\n\nDRAFT:\n${prompt.trim()}` }),
      })
      setPrompt(result.response); setAssistantInstruction(''); setMessage('Prompt updated by your local Ollama model.')
    } catch (error) { setStatus('error'); setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setAssisting(false) }
  }

  const openPreviewStream = (clientId: string) => {
    if (token === 'browser-preview') return { source: null, ready: Promise.resolve() }
    const source = new EventSource(`/api/lan/events?${new URLSearchParams({ token, clientId })}`)
    let markReady: () => void = () => undefined
    const ready = new Promise<void>((resolve) => { markReady = resolve })
    source.onmessage = (event) => {
      try {
        const update = JSON.parse(event.data) as { type?: string; data?: { value?: number; max?: number; image?: string; output?: { images?: Array<{ filename: string; subfolder?: string; type?: string }> } } }
        if (update.type === 'stream_ready') markReady()
        if (update.type === 'progress' && update.data?.max) setProgress(Math.min(95, Math.round(((update.data.value ?? 0) / update.data.max) * 95)))
        if (update.type === 'preview' && update.data?.image) setLivePreview(update.data.image)
        const image = update.type === 'executed' ? update.data?.output?.images?.[0] : undefined
        if (image) setLivePreview(`/api/lan/media?${new URLSearchParams({ token, filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'temp' })}`)
      } catch { /* Ignore unrelated ComfyUI events. */ }
    }
    source.onerror = () => markReady()
    return { source, ready }
  }

  const generate = async () => {
    if (!prompt.trim()) return setMessage('Describe the video you want to create.')
    if (!bootstrap?.connected) return setMessage('The desktop app cannot reach ComfyUI.')
    if (!modelReady) return setMessage(`The required ${provider === 'ltx25' ? 'LTX‑2.5' : 'MiniMax H3'} models are not available on the desktop.`)
    if (mode === 'image' && !frame) return setMessage('Choose a first frame for I2V.')
    if (provider === 'minimax' && upscale === 'ltx' && !ltxReady) return setMessage('The LTX 2.5 spatial upscaler is not available in ComfyUI.')
    if (upscale === 'rtx' && !rtxModel) return setMessage('Choose an RTX/CUDA frame upscaler first.')
    setOutputUrl(''); setLivePreview(''); setProgress(2); setPromptId(''); setStatus(mode === 'image' ? 'uploading' : 'queued'); setMessage(mode === 'image' ? 'Preparing and uploading your crop…' : `Building the ${provider === 'ltx25' ? 'LTX‑2.5' : 'MiniMax'} workflow…`)
    const clientId = crypto.randomUUID()
    const previewStream = openPreviewStream(clientId)
    cancelled.current = false
    try {
      await Promise.race([previewStream.ready, new Promise<void>((resolve) => setTimeout(resolve, 1500))])
      const [width, height] = resolution.split('x').map(Number)
      const first = mode === 'image' && frame ? await lanFetch<{ name: string; subfolder?: string; type?: string }>('/api/lan/upload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: await prepareImage(frame, width, height) }) }) : undefined
      const seed = Math.floor(Math.random() * 1_000_000_000)
      const postProcess = upscale === 'ltx' ? { type: 'ltx' as const, model: bootstrap.ltxModel!, vae: bootstrap.ltxVae! } : upscale === 'rtx' ? { type: 'rtx' as const, model: rtxModel } : undefined
      const graph = provider === 'ltx25'
        ? buildLtx25Workflow({ mode, prompt: prompt.trim(), width, height, duration: renderDuration, seed, preset: quality, filenamePrefix: `video/LTX_2.5_Mobile_${Date.now()}` }, ltxSelection, first)
        : buildMiniMaxWorkflow({ mode, prompt: prompt.trim(), width, height, duration: renderDuration, seed, steps: 20, turbo, sampler: 'res_multistep', scheduler: 'simple', upscale: postProcess, refImageSize: 'match', filenamePrefix: `video/MiniMax_Mobile_${Date.now()}`, firstFrame: frame?.path, referenceImages: [], referenceVideos: [], referenceAudios: [] }, selection, { first, images: [], videos: [], audios: [] })
      const queued = await lanFetch<{ prompt_id: string }>('/api/lan/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: graph, clientId }) })
      setPromptId(queued.prompt_id)
      setStatus('rendering'); setMessage(`Rendering with ${provider === 'ltx25' ? 'LTX‑2.5' : 'MiniMax H3'} on your desktop GPU. You can keep this page open.`)
      for (let attempt = 0; attempt < 1800; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        if (cancelled.current) { previewStream.source?.close(); return }
        const result = await lanFetch<{ finished: boolean; error?: string; output?: { filename: string; subfolder?: string; type?: string } }>(`/api/lan/history/${encodeURIComponent(queued.prompt_id)}`)
        if (!result.finished) continue
        if (result.error) throw new Error(result.error)
        if (!result.output) throw new Error('ComfyUI finished without returning a video file.')
        const query = new URLSearchParams({ token, filename: result.output.filename, subfolder: result.output.subfolder ?? '', type: result.output.type ?? 'output' })
        setOutputUrl(`/api/lan/media?${query}`); setProgress(100); setStatus('complete'); setMessage('Video complete. Preview or download it below.'); previewStream.source?.close(); return
      }
      throw new Error('The mobile page stopped waiting for this generation. Check the desktop queue.')
    } catch (error) { previewStream.source?.close(); if (!cancelled.current) { setStatus('error'); setMessage(error instanceof Error ? error.message : String(error)) } }
  }

  const cancel = async () => {
    if (!promptId) return
    try { await lanFetch('/api/lan/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ promptId }) }); cancelled.current = true; setPromptId(''); setStatus('ready'); setProgress(0); setMessage('Generation cancelled.') }
    catch (error) { setStatus('error'); setMessage(error instanceof Error ? error.message : String(error)) }
  }

  return <main className="mobile-app">
    <header className="mobile-header"><span className="brand-mark"><Film size={18} /></span><span><strong>MiniMax Studio</strong><small>LAN companion</small></span><button aria-label="Refresh desktop connection" onClick={() => void refresh()}><RefreshCw size={17} /></button></header>
    <section className="mobile-hero"><div><p>LOCAL CREATE</p><h1>Generate from your phone</h1><span>MiniMax H3 and LTX‑2.5 run on the desktop’s ComfyUI engine. Files stay on your network.</span></div><i className={bootstrap?.connected ? 'online' : ''}>{bootstrap?.connected ? `Connected · ${bootstrap.latencyMs} ms` : 'Offline'}</i></section>
    <section className="mobile-create-panel">
      <div className="mobile-provider" role="tablist" aria-label="Video provider"><button role="tab" aria-selected={provider === 'minimax'} disabled={status === 'uploading' || status === 'queued' || status === 'rendering'} onClick={() => changeProvider('minimax')}><strong>MiniMax H3</strong><small>Flexible video + references</small></button><button role="tab" aria-selected={provider === 'ltx25'} disabled={status === 'uploading' || status === 'queued' || status === 'rendering'} onClick={() => changeProvider('ltx25')}><strong>LTX‑2.5</strong><small>Native T2V and I2V</small></button></div>
      <div className={`mobile-provider-status ${modelReady ? 'ready' : ''}`}><span />{modelReady ? `${provider === 'ltx25' ? 'LTX‑2.5' : 'MiniMax'} pipeline ready` : `${provider === 'ltx25' ? 'LTX‑2.5 components missing' : 'MiniMax components missing'}`}</div>
      <div className="mobile-mode-tabs" role="tablist" aria-label="Generation mode"><button role="tab" aria-selected={mode === 'text'} onClick={() => setMode('text')}><WandSparkles size={18} /><span><strong>Text to video</strong><small>Describe a shot</small></span></button><button role="tab" aria-selected={mode === 'image'} onClick={() => setMode('image')}><ImageIcon size={18} /><span><strong>Image to video</strong><small>Animate one frame</small></span></button></div>
      <label className="mobile-prompt">Prompt<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Subject, action, camera movement, lighting, dialogue, and sound…" /></label>
      <details className="mobile-assistant"><summary><span><Sparkles size={16} /><strong>Ollama prompt assistant</strong></span><small>{bootstrap?.ollamaModels?.length ? `${bootstrap.ollamaModel} · local` : 'Unavailable'}</small></summary><div><div className="mobile-assistant-tools"><button disabled={assisting || !prompt.trim() || !bootstrap?.ollamaModels?.length} onClick={() => void runAssistant('enhance')}>Enhance</button><button disabled={assisting || !prompt.trim() || !bootstrap?.ollamaModels?.length} onClick={() => void runAssistant('timeline')}>Shot timing</button><button disabled={assisting || !prompt.trim() || !bootstrap?.ollamaModels?.length} onClick={() => void runAssistant('audio')}>Audio pass</button></div><label>Ask for a specific change<textarea value={assistantInstruction} onChange={(event) => setAssistantInstruction(event.target.value)} placeholder="Make the camera movement gentler and preserve the subject’s face…" /></label><button className="secondary-button" disabled={assisting || !prompt.trim() || !assistantInstruction.trim() || !bootstrap?.ollamaModels?.length} onClick={() => void runAssistant('custom')}>{assisting ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}Apply instruction</button></div></details>
      {mode === 'image' && <div className="mobile-frame"><div className="mobile-section-head"><span><strong>First frame</strong><small>Automatically cropped to the selected output size</small></span>{frame && <button onClick={() => setFrame(null)} aria-label="Remove first frame"><X size={16} /></button>}</div>{frame ? <><img src={frame.preview} alt="Selected first frame" /><ImageCrop label="First frame" file={frame} resolution={resolution} onChange={setFrame} /></> : <label className="mobile-file-picker"><ImageIcon size={25} /><strong>Choose an image</strong><span>PNG, JPG, or WebP</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => chooseFrame(event.target.files?.[0])} /></label>}</div>}
      <RenderSize value={resolution} onChange={setResolution} provider={provider} />
      <div className="mobile-options"><label>Duration<span><input aria-label="Duration" type="range" min="3" max={provider === 'ltx25' ? 10 : 15} value={renderDuration} onChange={(event) => setDuration(Number(event.target.value))} /><output>{renderDuration}s</output></span></label><label>Render quality<select value={quality} onChange={(event) => setQuality(event.target.value as 'quality' | 'turbo')}><option value="turbo">{provider === 'ltx25' ? 'Turbo · distilled single-stage 8' : 'Balanced · 8-step turbo'}</option><option value="quality">{provider === 'ltx25' ? 'Quality · official two-stage 8 + 3' : 'Quality · 20 steps'}</option></select></label></div>
      {provider === 'minimax' && <fieldset className="mobile-upscale"><legend>Post-render upscale</legend><div><label><input type="radio" name="mobile-upscale" checked={upscale === 'off'} onChange={() => setUpscale('off')} />Off</label><label><input type="radio" name="mobile-upscale" checked={upscale === 'ltx'} disabled={!ltxReady} onChange={() => setUpscale('ltx')} />LTX 2.5 · 2×</label><label><input type="radio" name="mobile-upscale" checked={upscale === 'rtx'} disabled={!bootstrap?.upscalers?.length} onChange={() => setUpscale('rtx')} />RTX/CUDA frames · 2×</label></div>{upscale === 'rtx' && <select aria-label="RTX upscale model" value={rtxModel} onChange={(event) => setRtxModel(event.target.value)}>{(bootstrap?.upscalers ?? []).map((name) => <option key={name}>{name}</option>)}</select>}<small>{upscale === 'off' ? 'Keep the native MiniMax output.' : `Saves both the original and ${upscale === 'ltx' ? 'temporally aware LTX' : 'frame-upscaled'} 2× video.`}</small></fieldset>}
      {(livePreview || status === 'rendering') && <section className="mobile-live-preview"><div><strong>Live preview</strong><span>{progress}%</span></div>{livePreview ? <img src={livePreview} alt="Current ComfyUI generation preview" /> : <div><LoaderCircle className="spin" /><span>Waiting for the first preview frame…</span></div>}<progress max="100" value={progress}>{progress}%</progress></section>}
      {message && <div className={`mobile-message ${status}`} role="status">{status === 'uploading' || status === 'queued' || status === 'rendering' ? <LoaderCircle className="spin" size={17} /> : null}<span>{message}</span></div>}
      <div className="mobile-generate-actions">{promptId && (status === 'queued' || status === 'rendering') && <button className="mobile-cancel" onClick={() => void cancel()}><CircleStop size={18} />Cancel</button>}<button className="mobile-generate" disabled={status === 'uploading' || status === 'queued' || status === 'rendering'} onClick={() => void generate()}>{status === 'uploading' || status === 'queued' || status === 'rendering' ? <LoaderCircle className="spin" size={19} /> : <Play size={19} fill="currentColor" />}Generate video</button></div>
    </section>
    {outputUrl && <section className="mobile-output"><div><strong>Your video</strong><span>Rendered with {provider === 'ltx25' ? 'LTX‑2.5' : 'MiniMax H3'}</span></div><video src={outputUrl} controls playsInline /><a href={`${outputUrl}&download=1`} download><Download size={18} />Download video</a></section>}
    <section className="mobile-install"><Smartphone size={20} /><span><strong>Keep it on your home screen</strong><small>{window.isSecureContext ? 'Install MiniMax Mobile for an app-like workspace.' : 'Use the browser menu to add a shortcut. Verified PWA installation and offline caching require trusted HTTPS.'}</small></span>{installPrompt && <button onClick={() => { void installPrompt.prompt(); setInstallPrompt(null) }}>Install</button>}</section>
  </main>
}

const previewModels: ModelFile[] = [
  { name: 'minimax_h3_fl2va_preview.safetensors', path: '', kind: 'diffusion_models', bytes: 1 },
  { name: 'qwen3vl_32b_minimax_h3_preview.safetensors', path: '', kind: 'text_encoders', bytes: 1 },
  { name: 'minimax_h3_video_vae_preview.safetensors', path: '', kind: 'vae', bytes: 1 },
  { name: 'minimax_h3_audio_vae_preview.safetensors', path: '', kind: 'vae', bytes: 1 },
  { name: 'minimax_h3_fl2v_turbo_8step_preview.safetensors', path: '', kind: 'loras', bytes: 1 },
  { name: 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors', path: '', kind: 'diffusion_models', bytes: 1 },
  { name: 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors', path: '', kind: 'text_encoders', bytes: 1 },
  { name: 'ltx-2.5-video-vae-bf16.safetensors', path: '', kind: 'vae', bytes: 1 },
  { name: 'ltx-2.5-audio-vae-bf16.safetensors', path: '', kind: 'vae', bytes: 1 },
]
