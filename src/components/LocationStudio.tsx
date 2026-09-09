import { useEffect, useMemo, useState } from 'react'
import { Check, CircleStop, Film, ImagePlus, Images, LoaderCircle, MapPin, Orbit, Plus, Sparkles, Trash2, X } from 'lucide-react'
import { choices, type ObjectInfo } from '../lib/comfyInfo'
import { buildZImage } from '../lib/zimage'
import { loadLocationProjects, locationReferences, newLocationProject, saveLocationProjects, LOCATION_LIBRARY_EVENT } from '../lib/locationLibrary'
import type { AppSettings, GenerationJob, LocationProject, MediaFile } from '../types'
import { ReferenceApprovalModal } from './ReferenceApprovalModal'

export function LocationStudio({ settings, info, connected, automationJob, onNotice, onCreateWalkthrough }: {
  settings: AppSettings
  info: ObjectInfo
  connected: boolean
  automationJob?: GenerationJob
  onNotice(tone: 'error' | 'success' | 'neutral', text: string): void
  onCreateWalkthrough(project: LocationProject): void
}) {
  const initial = useMemo(() => { const saved = loadLocationProjects(); return saved.length ? saved : [newLocationProject()] }, [])
  const [projects, setProjects] = useState(initial)
  const [activeId, setActiveId] = useState(initial[0].id)
  const [job, setJob] = useState<{ id: string; url: string; locationId: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [splitting, setSplitting] = useState(false)
  const [videoDuration, setVideoDuration] = useState(0)
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  const [candidate, setCandidate] = useState<{ locationId: string; file: MediaFile } | null>(null)
  const active = projects.find((project) => project.id === activeId) ?? projects[0]
  const activeAutomation = automationJob?.locationProjectId === active.id ? automationJob : undefined
  const commit = (next: LocationProject[]) => { setProjects(next); saveLocationProjects(next) }
  const patchById = (id: string, change: Partial<LocationProject>) => setProjects((current) => { const next = current.map((project) => project.id === id ? { ...project, ...change, updatedAt: Date.now() } : project); saveLocationProjects(next); return next })
  const patch = (change: Partial<LocationProject>) => patchById(active.id, change)
  useEffect(() => { const refresh = () => { const next = loadLocationProjects(); if (next.length) setProjects(next) }; window.addEventListener(LOCATION_LIBRARY_EVENT, refresh); return () => window.removeEventListener(LOCATION_LIBRARY_EVENT, refresh) }, [])

  const prompt = active.referencePrompt.trim() || [
    `Cinematic establishing reference image for ${active.name}.`, active.description,
    active.atmosphere && `Atmosphere: ${active.atmosphere}.`, active.timeOfDay && `Time of day and weather: ${active.timeOfDay}.`,
    `${active.visualStyle}. Wide, clear view of the full location, stable architectural and environmental details, coherent geography, no people as the focal subject, no text, no logos.`,
  ].filter(Boolean).join(' ')
  const zModel = choices(info, 'UNETLoader', 'unet_name').find((name) => /z[_-]?image.*turbo/i.test(name)) ?? 'z_image_turbo_bf16.safetensors'
  const zEncoder = choices(info, 'CLIPLoader', 'clip_name').find((name) => /qwen[_-]?3[_-]?4b/i.test(name)) ?? 'qwen_3_4b.safetensors'
  const zVae = choices(info, 'VAELoader', 'vae_name').find((name) => /^ae\.safetensors$/i.test(name)) ?? 'ae.safetensors'
  const zReady = connected && choices(info, 'UNETLoader', 'unet_name').includes(zModel) && choices(info, 'CLIPLoader', 'clip_name').includes(zEncoder) && choices(info, 'VAELoader', 'vae_name').includes(zVae)
  const chooseImage = async (target: 'base' | 'reference' = 'reference') => {
    const picked = await window.minimax.chooseMedia('image'); if (!picked) return
    const file: MediaFile = { ...picked, kind: 'image', preview: await window.minimax.mediaUrl(picked.path) }
    patch(target === 'base' ? { baseImage: file } : { referenceImages: [...active.referenceImages, file], selectedReferencePaths: active.selectedReferencePaths === undefined ? undefined : [...active.selectedReferencePaths, file.path] })
  }
  const chooseWalkthrough = async () => { const picked = await window.minimax.chooseMedia('video'); if (!picked) return; patch({ walkthroughVideo: { ...picked, kind: 'video', preview: await window.minimax.mediaUrl(picked.path) } }); setVideoDuration(0) }
  const createMaster = async () => {
    if (!zReady || busy || !prompt.trim()) return
    setBusy(true); setError(false); setMessage('Submitting the location reference to Z-Image Turbo…')
    try { const response = await window.minimax.submitPrompt(settings.comfyUrl, buildZImage(prompt, 1344, 768, Math.floor(Math.random() * 1_000_000_000), zModel, zEncoder, zVae)); setJob({ id: response.prompt_id, url: settings.comfyUrl, locationId: active.id }); setMessage('Constructing the location reference in ComfyUI…') }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); setError(true); setBusy(false) }
  }
  const cancel = async () => { if (!job) return; try { await window.minimax.cancelPrompt(job.url, job.id); setMessage('Location-reference render cancelled.') } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); setError(true) } finally { setJob(null); setBusy(false) } }
  useEffect(() => {
    if (!job) return
    let disposed = false; let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const history = await window.minimax.getHistory(job.url, job.id)
        const entry = history[job.id] as { status?: { status_str?: string }; outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }> } | undefined
        if (entry?.status?.status_str === 'error') throw new Error('Location-reference generation failed. Check the ComfyUI log.')
        const image = Object.values(entry?.outputs ?? {}).flatMap((output) => output.images ?? [])[0]
        if (image) { const preview = await window.minimax.getOutputImage(job.url, image); const saved = await window.minimax.saveComfyOutputImage(job.url, image, settings.outputDirectory); if (!disposed) { setCandidate({ locationId: job.locationId, file: { ...saved, preview, kind: 'image' } }); setBusy(false); setJob(null); setError(false); setMessage('Location reference ready for approval.') }; return }
      } catch (reason) { if (!disposed) { setMessage(reason instanceof Error ? reason.message : String(reason)); setError(true); setBusy(false); setJob(null) }; return }
      if (!disposed) timer = setTimeout(poll, 2000)
    }
    void poll(); return () => { disposed = true; clearTimeout(timer) }
  }, [job, onNotice, settings.outputDirectory])
  const extractWalkthrough = async () => {
    if (!active.walkthroughVideo || !videoDuration || splitting) return
    setSplitting(true)
    try {
      const positions = [0.05, .25, .5, .75, .95].map((ratio) => Math.max(0, Math.min(videoDuration - .04, videoDuration * ratio)))
      const files = await Promise.all(positions.map(async (position) => { const result = await window.minimax.extractVideoFrame(active.walkthroughVideo!.path, position, settings.outputDirectory, settings.ffmpegPath); return { ...result, kind: 'image' as const, preview: await window.minimax.mediaUrl(result.path) } }))
      patch({ referenceImages: files, referenceMode: 'set', selectedReferencePaths: undefined }); onNotice('success', 'Five walkthrough frames were extracted into this location reference set.')
    } catch (reason) { onNotice('error', reason instanceof Error ? reason.message : String(reason)) } finally { setSplitting(false) }
  }
  const add = () => { const project = newLocationProject(projects.length + 1); commit([...projects, project]); setActiveId(project.id) }
  const remove = () => { if (!window.confirm(`Delete location “${active.name}”? Original media remains on disk.`)) return; const next = projects.filter((project) => project.id !== active.id); const fallback = next.length ? next : [newLocationProject()]; commit(fallback); setActiveId(fallback[0].id) }
  const selected = locationReferences(active)
  const approveCandidate = () => {
    if (!candidate) return
    const project = loadLocationProjects().find((item) => item.id === candidate.locationId)
    if (!project) { setCandidate(null); return }
    patchById(project.id, { baseImage: candidate.file })
    setCandidate(null); setMessage('Master approved. Preparing the walkthrough…')
    onCreateWalkthrough({ ...project, baseImage: candidate.file })
  }
  return <><div className="standard-page character-studio location-studio">
    <div className="page-heading"><div><p className="eyebrow">GLOBAL LOCATION LIBRARY</p><h1>Location Studio</h1><p>Create reusable places, walkthroughs, and approved reference views.</p></div><div className="heading-state"><span className={active.baseImage ? 'ok' : 'warn'}>{active.baseImage ? <Check size={15} /> : <MapPin size={15} />}{active.baseImage ? 'Master reference ready' : 'Create a location reference'}</span></div></div>
    <div className="character-studio-grid"><aside className="character-project-list"><header><span><strong>Locations</strong><small>{projects.length} saved globally</small></span><button onClick={add}><Plus size={14} />New</button></header><div>{projects.map((project) => <button key={project.id} className={project.id === active.id ? 'active' : ''} onClick={() => { setActiveId(project.id); setVideoDuration(0) }}>{project.baseImage?.preview ? <img src={project.baseImage.preview} alt="" /> : <span><MapPin size={18} /></span>}<span><strong>{project.name}</strong><small>{locationReferences(project).length} usable reference{locationReferences(project).length === 1 ? '' : 's'}</small></span></button>)}</div></aside>
      <section className="character-workbench"><header><div><MapPin size={18} /><span><strong>Place and continuity</strong><small>Stable world details that can be reused across shots and movies.</small></span></div><button className="danger-button" onClick={remove}><Trash2 size={14} />Delete location</button></header>
        <div className="character-setup-grid"><section className="character-setup-panel"><div className="character-section-heading"><span><MapPin size={15} /></span><div><strong>Location profile</strong><small>Describe the fixed details of this environment.</small></div><em>{active.name.trim() ? 'Saved locally' : 'Name required'}</em></div><div className="character-form"><label>Location name<input value={active.name} onChange={(event) => patch({ name: event.target.value, referencePrompt: '' })} /></label><label>Visual style<input value={active.visualStyle} onChange={(event) => patch({ visualStyle: event.target.value, referencePrompt: '' })} /></label><label className="wide">Architecture and layout<textarea value={active.description} onChange={(event) => patch({ description: event.target.value, referencePrompt: '' })} placeholder="Building, landscape, materials, landmarks, rooms, street layout…" /></label><label>Atmosphere and lighting<textarea value={active.atmosphere} onChange={(event) => patch({ atmosphere: event.target.value, referencePrompt: '' })} placeholder="Mood, practical lights, color palette, weather…" /></label><label>Time, weather, and continuity<textarea value={active.timeOfDay} onChange={(event) => patch({ timeOfDay: event.target.value, referencePrompt: '' })} placeholder="Dusk after rain, overcast afternoon, persistent signs…" /></label></div></section>
          <section className="character-setup-panel character-prompt-panel"><div className="character-section-heading"><span><Sparkles size={15} /></span><div><strong>Master prompt</strong><small>The exact Z-Image prompt for this location.</small></div><em>{prompt.length.toLocaleString()} characters</em></div><label className="character-reference-prompt"><span><strong>Editable render prompt</strong><small>Changes apply to the next master reference.</small></span><textarea value={prompt} onChange={(event) => patch({ referencePrompt: event.target.value })} /></label></section></div>
        <div className="character-production-heading"><span>Reference production</span><small>Build the place, walk through it, then approve the useful views.</small><em>{Number(Boolean(active.baseImage)) + Number(Boolean(active.walkthroughVideo)) + Number(selected.length > 0)} of 3 ready</em></div>
        <div className="character-production-grid"><article className="character-master-card"><header><span><strong>1. Master reference</strong><small>Generate a clear establishing view.</small></span><span className={`master-engine-state ${zReady ? 'ready' : ''}`}>{zReady ? <Check size={12} /> : <MapPin size={12} />}{zReady ? 'Z-Image ready' : 'Z-Image unavailable'}</span></header><div className="character-media-stage">{active.baseImage?.preview ? <img src={active.baseImage.preview} alt={`${active.name} master reference`} /> : busy ? <div><LoaderCircle className="spin" size={26} /><span>Creating master reference…</span></div> : <div><ImagePlus size={26} /><span>No master image</span></div>}</div>{message && <div className={`character-master-message ${error ? 'error' : ''}`}>{busy && <LoaderCircle className="spin" size={13} />}<span>{message}</span></div>}<footer><button className="secondary-button" disabled={busy} onClick={() => void chooseImage('base')}><ImagePlus size={14} />Choose existing</button>{busy && <button className="danger-button" onClick={() => void cancel()}><CircleStop size={14} />Cancel</button>}<button className="primary-button" disabled={busy || !zReady || !active.name.trim()} onClick={() => void createMaster()}><Sparkles size={14} />{busy ? 'Creating…' : active.baseImage ? 'Regenerate master' : 'Create master'}</button></footer></article>
          <article><header><span><strong>2. Walkthrough video</strong><small>Survey every wall, corner, landmark, and spatial connection.</small></span>{activeAutomation && <span className={`status-badge ${activeAutomation.status}`}>{activeAutomation.status}</span>}</header><div className="character-media-stage">{active.walkthroughVideo?.preview ? <video key={active.walkthroughVideo.preview} src={active.walkthroughVideo.preview} controls preload="metadata" onLoadedMetadata={(event) => setVideoDuration(event.currentTarget.duration)} /> : activeAutomation && ['queued', 'running'].includes(activeAutomation.status) ? <div><LoaderCircle className="spin" size={26} /><span>{activeAutomation.progressLabel ?? 'Rendering walkthrough…'} · {Math.round(activeAutomation.progress)}%</span></div> : <div><Orbit size={26} /><span>No walkthrough video</span></div>}</div><footer><button className="secondary-button" onClick={() => void chooseWalkthrough()}><Film size={14} />Choose rendered video</button><button className="primary-button" disabled={!active.baseImage || Boolean(activeAutomation && ['queued', 'running'].includes(activeAutomation.status))} onClick={() => onCreateWalkthrough(active)}><Orbit size={14} />{activeAutomation && ['queued', 'running'].includes(activeAutomation.status) ? 'Rendering…' : 'Render full walkthrough'}</button></footer></article></div>
        <section className="character-reference-set"><header><span><strong>3. Approved location references</strong><small>Selected views are available for reference renders and future movies.</small></span><button className="secondary-button" disabled={!active.walkthroughVideo || !videoDuration || splitting} onClick={() => void extractWalkthrough()}>{splitting ? <LoaderCircle className="spin" size={14} /> : <Images size={14} />}{splitting ? 'Extracting…' : 'Extract 5 views'}</button></header><fieldset><legend>Use in renders</legend><label><input type="radio" name="location-reference-mode" checked={active.referenceMode === 'single'} onChange={() => patch({ referenceMode: 'single' })} />Single master image</label><label><input type="radio" name="location-reference-mode" checked={active.referenceMode === 'set'} onChange={() => patch({ referenceMode: 'set' })} />Selected reference views</label></fieldset><div className="character-reference-grid">{active.referenceImages.map((file, index) => { const checked = active.selectedReferencePaths === undefined || active.selectedReferencePaths.includes(file.path); return <figure className={checked ? 'selected' : ''} key={`${file.path}-${index}`}><img src={file.preview} alt={`${active.name} reference ${index + 1}`} /><figcaption><label><input type="checkbox" checked={checked} onChange={(event) => { const current = active.selectedReferencePaths ?? active.referenceImages.map((item) => item.path); patch({ referenceMode: 'set', selectedReferencePaths: event.target.checked ? [...new Set([...current, file.path])] : current.filter((path) => path !== file.path) }) }} />Use view {index + 1}</label></figcaption><button aria-label={`Remove reference view ${index + 1}`} onClick={() => patch({ referenceImages: active.referenceImages.filter((_, itemIndex) => itemIndex !== index), selectedReferencePaths: active.selectedReferencePaths?.filter((path) => path !== file.path) })}><X size={13} /></button></figure> })}<button className="character-add-reference" onClick={() => void chooseImage()}><ImagePlus size={19} /><span>Add reference</span></button></div></section>
      </section></div>
  </div>{candidate && <ReferenceApprovalModal title="Approve location master" description="Inspect the geography, architecture, lighting, and recurring landmarks before continuing." image={candidate.file.preview ?? ''} approveLabel="Approve & make walkthrough" nextStep="Approval saves this master, queues the walkthrough in the background, then imports the video and five room views here." approveStartsGeneration onClose={() => setCandidate(null)} onRetry={() => { setCandidate(null); void createMaster() }} onApprove={approveCandidate} />}</>
}
