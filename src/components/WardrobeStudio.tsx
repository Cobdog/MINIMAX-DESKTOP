import { useEffect, useMemo, useState } from 'react'
import { Check, CircleStop, ImagePlus, LoaderCircle, Plus, Shirt, Sparkles, Trash2, X } from 'lucide-react'
import { choices, type ObjectInfo } from '../lib/comfyInfo'
import { buildZImage } from '../lib/zimage'
import { loadWardrobeProjects, newWardrobeProject, saveWardrobeProjects, wardrobeReferences, WARDROBE_LIBRARY_EVENT } from '../lib/wardrobeLibrary'
import type { AppSettings, MediaFile, WardrobeProject } from '../types'
import { ReferenceApprovalModal } from './ReferenceApprovalModal'

export function WardrobeStudio({ settings, info, connected, onNotice }: { settings: AppSettings; info: ObjectInfo; connected: boolean; onNotice(tone: 'error' | 'success' | 'neutral', text: string): void }) {
  const initial = useMemo(() => { const stored = loadWardrobeProjects(); return stored.length ? stored : [newWardrobeProject()] }, [])
  const [projects, setProjects] = useState(initial)
  const [activeId, setActiveId] = useState(initial[0].id)
  const [job, setJob] = useState<{ id: string; url: string; wardrobeId: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  const [candidate, setCandidate] = useState<{ wardrobeId: string; file: MediaFile } | null>(null)
  const active = projects.find((project) => project.id === activeId) ?? projects[0]
  const commit = (next: WardrobeProject[]) => { setProjects(next); saveWardrobeProjects(next) }
  const patch = (change: Partial<WardrobeProject>) => commit(projects.map((project) => project.id === active.id ? { ...project, ...change, updatedAt: Date.now() } : project))
  const patchById = (id: string, change: Partial<WardrobeProject>) => setProjects((current) => { const next = current.map((project) => project.id === id ? { ...project, ...change, updatedAt: Date.now() } : project); saveWardrobeProjects(next); return next })
  useEffect(() => { const refresh = () => { const next = loadWardrobeProjects(); if (next.length) setProjects(next) }; window.addEventListener(WARDROBE_LIBRARY_EVENT, refresh); return () => window.removeEventListener(WARDROBE_LIBRARY_EVENT, refresh) }, [])

  const defaultPrompt = [`Wardrobe reference sheet for ${active.name}.`, active.description, active.colors && `Colors: ${active.colors}.`, active.materials && `Materials and construction: ${active.materials}.`, `${active.visualStyle}. Create one coherent four-panel fashion reference sheet of the exact same complete outfit on a featureless neutral mannequin: panel 1 straight front view, panel 2 left side profile, panel 3 right side profile, panel 4 straight back view. Keep the garments, colors, pattern placement, fit, accessories, footwear, proportions, and construction identical in every panel. Full body visible from neckline to footwear in each panel, accurate fabric texture and seams, evenly spaced panels, plain neutral studio background, even soft lighting, no person identity, no text, no labels, no logos unless specified.`].filter(Boolean).join(' ')
  const renderPrompt = active.referencePrompt.trim() || defaultPrompt
  const zModel = choices(info, 'UNETLoader', 'unet_name').find((name) => /z[_-]?image.*turbo/i.test(name)) ?? 'z_image_turbo_bf16.safetensors'
  const zEncoder = choices(info, 'CLIPLoader', 'clip_name').find((name) => /qwen[_-]?3[_-]?4b/i.test(name)) ?? 'qwen_3_4b.safetensors'
  const zVae = choices(info, 'VAELoader', 'vae_name').find((name) => /^ae\.safetensors$/i.test(name)) ?? 'ae.safetensors'
  const zReady = connected && choices(info, 'UNETLoader', 'unet_name').includes(zModel) && choices(info, 'CLIPLoader', 'clip_name').includes(zEncoder) && choices(info, 'VAELoader', 'vae_name').includes(zVae)
  const chooseImage = async () => { const picked = await window.minimax.chooseMedia('image'); if (!picked) return; const file: MediaFile = { ...picked, kind: 'image', preview: await window.minimax.mediaUrl(picked.path) }; patch({ referenceImages: [...active.referenceImages, file], selectedReferencePaths: [...new Set([...(active.selectedReferencePaths ?? active.referenceImages.map((item) => item.path)), file.path])] }) }
  const createReference = async () => {
    if (!zReady || busy || !renderPrompt.trim()) return
    setBusy(true); setError(false); setMessage('Submitting the wardrobe reference to Z-Image Turbo…')
    try { const response = await window.minimax.submitPrompt(settings.comfyUrl, buildZImage(renderPrompt, 1024, 1024, Math.floor(Math.random() * 1_000_000_000), zModel, zEncoder, zVae)); setJob({ id: response.prompt_id, url: settings.comfyUrl, wardrobeId: active.id }); setMessage('Constructing the wardrobe reference in ComfyUI…') }
    catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); setError(true); setBusy(false) }
  }
  const cancel = async () => { if (!job) return; try { await window.minimax.cancelPrompt(job.url, job.id); setMessage('Wardrobe render cancelled.') } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); setError(true) } finally { setJob(null); setBusy(false) } }
  useEffect(() => {
    if (!job) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const history = await window.minimax.getHistory(job.url, job.id)
        const entry = history[job.id] as { status?: { status_str?: string }; outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }> } | undefined
        if (entry?.status?.status_str === 'error') throw new Error('Wardrobe generation failed. Check the ComfyUI log.')
        const image = Object.values(entry?.outputs ?? {}).flatMap((output) => output.images ?? [])[0]
        if (image) {
          const preview = await window.minimax.getOutputImage(job.url, image)
          const saved = await window.minimax.saveComfyOutputImage(job.url, image, settings.outputDirectory)
          if (!disposed) { setCandidate({ wardrobeId: job.wardrobeId, file: { ...saved, preview, kind: 'image' } }); setJob(null); setBusy(false); setError(false); setMessage('Wardrobe sheet ready for approval.') }
          return
        }
      } catch (reason) { if (!disposed) { setMessage(reason instanceof Error ? reason.message : String(reason)); setError(true); setBusy(false); setJob(null) }; return }
      if (!disposed) timer = setTimeout(poll, 2000)
    }
    void poll(); return () => { disposed = true; clearTimeout(timer) }
  }, [job, onNotice, settings.outputDirectory])

  const add = () => { const project = newWardrobeProject(projects.length + 1); commit([...projects, project]); setActiveId(project.id) }
  const remove = () => { if (!window.confirm(`Delete wardrobe “${active.name}”? Image files remain on disk.`)) return; const next = projects.filter((project) => project.id !== active.id); const fallback = next.length ? next : [newWardrobeProject()]; commit(fallback); setActiveId(fallback[0].id) }
  const selected = wardrobeReferences(active)
  const approveCandidate = () => {
    if (!candidate) return
    const project = loadWardrobeProjects().find((item) => item.id === candidate.wardrobeId)
    if (!project) { setCandidate(null); return }
    patchById(project.id, { referenceImages: [...project.referenceImages, candidate.file], selectedReferencePaths: [...new Set([...(project.selectedReferencePaths ?? project.referenceImages.map((item) => item.path)), candidate.file.path])] })
    setCandidate(null); setMessage('Wardrobe sheet approved.'); onNotice('success', 'Wardrobe sheet added to the approved reference set.')
  }
  return <><div className="standard-page wardrobe-studio"><div className="page-heading"><div><p className="eyebrow">GLOBAL WARDROBE LIBRARY</p><h1>Wardrobe Studio</h1><p>Create reusable clothing references and assign them to character profiles.</p></div><div className="heading-state"><span className={selected.length ? 'ok' : 'warn'}>{selected.length ? <Check size={15} /> : <Shirt size={15} />}{selected.length ? `${selected.length} approved reference${selected.length === 1 ? '' : 's'}` : 'Create a wardrobe reference'}</span></div></div><div className="character-studio-grid"><aside className="character-project-list"><header><span><strong>Wardrobes</strong><small>{projects.length} saved globally</small></span><button onClick={add}><Plus size={14} />New</button></header><div>{projects.map((project) => <button key={project.id} className={project.id === active.id ? 'active' : ''} onClick={() => setActiveId(project.id)}>{project.referenceImages[0]?.preview ? <img src={project.referenceImages[0].preview} alt="" /> : <span><Shirt size={18} /></span>}<span><strong>{project.name}</strong><small>{wardrobeReferences(project).length} approved image{wardrobeReferences(project).length === 1 ? '' : 's'}</small></span></button>)}</div></aside><section className="character-workbench"><header><div><Shirt size={18} /><span><strong>Wardrobe design</strong><small>Garment references remain separate from character identity.</small></span></div><button className="danger-button" onClick={remove}><Trash2 size={14} />Delete wardrobe</button></header><div className="wardrobe-workspace"><section className="character-setup-panel"><div className="character-section-heading"><span><Shirt size={15} /></span><div><strong>Design profile</strong><small>Describe a repeatable outfit and its physical construction.</small></div></div><div className="character-form"><label>Wardrobe name<input value={active.name} onChange={(event) => patch({ name: event.target.value, referencePrompt: '' })} /></label><label>Visual style<input value={active.visualStyle} onChange={(event) => patch({ visualStyle: event.target.value, referencePrompt: '' })} /></label><label className="wide">Garments and accessories<textarea value={active.description} onChange={(event) => patch({ description: event.target.value, referencePrompt: '' })} placeholder="Jacket, shirt, trousers, shoes, jewelry, recurring accessories…" /></label><label>Colors and pattern<textarea value={active.colors} onChange={(event) => patch({ colors: event.target.value, referencePrompt: '' })} /></label><label>Materials and construction<textarea value={active.materials} onChange={(event) => patch({ materials: event.target.value, referencePrompt: '' })} /></label></div></section><section className="character-setup-panel wardrobe-render-panel"><div className="character-section-heading"><span><Sparkles size={15} /></span><div><strong>Z-Image reference</strong><small>Creates front, left, right, and back views of one outfit.</small></div><em>{zReady ? 'Ready' : 'Unavailable'}</em></div><label className="character-reference-prompt"><span><strong>Editable render prompt</strong><small>No character identity is introduced here.</small></span><textarea value={renderPrompt} onChange={(event) => patch({ referencePrompt: event.target.value })} /></label>{message && <div className={`character-master-message ${error ? 'error' : ''}`}>{busy && <LoaderCircle className="spin" size={13} />}<span>{message}</span></div>}<footer><button className="secondary-button" disabled={busy} onClick={() => void chooseImage()}><ImagePlus size={14} />Add existing</button>{busy && <button className="danger-button" onClick={() => void cancel()}><CircleStop size={14} />Cancel</button>}<button className="primary-button" disabled={busy || !zReady || !active.name.trim()} onClick={() => void createReference()}><Sparkles size={14} />{busy ? 'Creating…' : 'Create 4-view sheet'}</button></footer></section></div><section className="character-reference-set wardrobe-reference-set"><header><span><strong>Approved wardrobe references</strong><small>Selected images are appended after character identity pictures.</small></span><button className="secondary-button" onClick={() => void chooseImage()}><ImagePlus size={14} />Add image</button></header><div className="character-reference-grid">{active.referenceImages.map((file, index) => { const checked = active.selectedReferencePaths === undefined || active.selectedReferencePaths.includes(file.path); return <figure className={checked ? 'selected' : ''} key={`${file.path}-${index}`}><img src={file.preview} alt={`${active.name} wardrobe reference ${index + 1}`} /><figcaption><label><input type="checkbox" checked={checked} onChange={(event) => { const current = active.selectedReferencePaths ?? active.referenceImages.map((item) => item.path); patch({ selectedReferencePaths: event.target.checked ? [...new Set([...current, file.path])] : current.filter((path) => path !== file.path) }) }} />Use image {index + 1}</label></figcaption><button aria-label={`Remove wardrobe reference ${index + 1}`} onClick={() => patch({ referenceImages: active.referenceImages.filter((_, itemIndex) => itemIndex !== index), selectedReferencePaths: active.selectedReferencePaths?.filter((path) => path !== file.path) })}><X size={13} /></button></figure> })}<button className="character-add-reference" onClick={() => void chooseImage()}><ImagePlus size={19} /><span>Add reference</span></button></div></section></section></div></div>{candidate && <ReferenceApprovalModal title="Approve wardrobe sheet" description="Check all garment views for matching construction, pattern placement, colors, and accessories." image={candidate.file.preview ?? ''} approveLabel="Approve wardrobe" nextStep="Approval adds this four-view sheet to the wardrobe’s selected reference images." onClose={() => setCandidate(null)} onRetry={() => { setCandidate(null); void createReference() }} onApprove={approveCandidate} />}</>
}
