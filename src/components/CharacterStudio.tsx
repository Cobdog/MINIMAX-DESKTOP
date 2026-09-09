import { useEffect, useMemo, useState } from 'react'
import { Check, Film, ImagePlus, Images, LoaderCircle, Orbit, Plus, Sparkles, Trash2, UserRound, WandSparkles, X } from 'lucide-react'
import { CHARACTER_LIBRARY_EVENT, characterReferences, loadCharacterProjects, newCharacterProject, saveCharacterProjects } from '../lib/characterLibrary'
import type { AppSettings, CharacterProject, MediaFile } from '../types'

function cleanSinglePrompt(value: string) {
  return value
    .replace(/\\\s*(?:\r?\n|$)/g, ' ')
    .replace(/[*_#`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function CharacterStudio({ settings, ollamaAvailable, onCreateWithZImage, onCreateTurntable, onNotice }: {
  settings: AppSettings
  ollamaAvailable: boolean
  onCreateWithZImage(project: CharacterProject, prompt: string): void
  onCreateTurntable(project: CharacterProject): void
  onNotice(tone: 'error' | 'success' | 'neutral', text: string): void
}) {
  const initial = useMemo(() => {
    const stored = loadCharacterProjects()
    return stored.length ? stored : [newCharacterProject()]
  }, [])
  const [projects, setProjects] = useState(initial)
  const [activeId, setActiveId] = useState(initial[0].id)
  const [videoDuration, setVideoDuration] = useState(0)
  const [splitting, setSplitting] = useState(false)
  const [assisting, setAssisting] = useState(false)
  const active = projects.find((project) => project.id === activeId) ?? projects[0]

  useEffect(() => {
    const refresh = () => {
      const next = loadCharacterProjects()
      if (next.length) setProjects(next)
    }
    window.addEventListener(CHARACTER_LIBRARY_EVENT, refresh)
    return () => window.removeEventListener(CHARACTER_LIBRARY_EVENT, refresh)
  }, [])

  const commit = (next: CharacterProject[]) => { setProjects(next); saveCharacterProjects(next) }
  const patch = (change: Partial<CharacterProject>) => commit(projects.map((project) => project.id === active.id ? { ...project, ...change, updatedAt: Date.now() } : project))
  const add = () => {
    const project = newCharacterProject(projects.length + 1)
    commit([...projects, project]); setActiveId(project.id)
  }
  const remove = () => {
    if (!window.confirm(`Delete the character project “${active.name}”? The original image and video files will remain on disk.`)) return
    const next = projects.filter((project) => project.id !== active.id)
    const fallback = next.length ? next : [newCharacterProject()]
    commit(fallback); setActiveId(fallback[0].id)
  }
  const chooseImage = async (target: 'base' | 'reference') => {
    const picked = await window.minimax.chooseMedia('image')
    if (!picked) return
    const file: MediaFile = { ...picked, kind: 'image', preview: await window.minimax.mediaUrl(picked.path) }
    patch(target === 'base' ? { baseImage: file } : {
      referenceImages: [...active.referenceImages, file],
      selectedReferencePaths: active.selectedReferencePaths === undefined ? undefined : [...active.selectedReferencePaths, file.path],
    })
  }
  const chooseTurntable = async () => {
    const picked = await window.minimax.chooseMedia('video')
    if (!picked) return
    patch({ turntableVideo: { ...picked, kind: 'video', preview: await window.minimax.mediaUrl(picked.path) } })
    setVideoDuration(0)
  }
  const enhance = async () => {
    if (!ollamaAvailable || assisting) return
    setAssisting(true)
    try {
      const result = await window.minimax.generateWithOllama(settings.ollamaUrl, settings.ollamaModel, `Rewrite the character notes below as one concise, production-ready full-body reference-image prompt. Preserve every intentional identity detail, but remove repeated facts. Include the name, ethnicity or complexion when supplied, stable face geometry, age range, hair, build, distinguishing marks, wardrobe colors and materials, recurring props, and performance baseline. End with the requested visual style and these reference-photo constraints: plain neutral studio background, even soft lighting, eye-level 50mm lens, relaxed symmetrical stance, hands visible, accurate anatomy, no text, no props unless specified, one person only. Return exactly one plain-text paragraph. Do not use Markdown, headings, field labels, bullet points, or line breaks.\n\nName: ${active.name}\nAppearance: ${active.description}\nWardrobe and props: ${active.wardrobe}\nVoice and performance: ${active.voiceNotes}\nVisual style: ${active.visualStyle}`)
      patch({ referencePrompt: cleanSinglePrompt(result) })
      onNotice('success', 'Master reference prompt refined locally with Ollama.')
    } catch (error) { onNotice('error', error instanceof Error ? error.message : String(error)) }
    finally { setAssisting(false) }
  }
  const defaultZPrompt = [
    `Full-body neutral character reference portrait of ${active.name}.`, active.description, active.wardrobe,
    `${active.visualStyle}. Plain neutral studio background, even soft lighting, eye-level 50mm lens, relaxed symmetrical stance, hands visible, accurate anatomy, no text, no props unless specified, one person only.`,
  ].filter(Boolean).join(' ')
  const zPrompt = active.referencePrompt.trim() || defaultZPrompt
  const splitTurntable = async () => {
    if (!active.turntableVideo || videoDuration <= 0 || splitting) return
    setSplitting(true)
    try {
      const positions = [0.05, 0.25, 0.5, 0.75, 0.95].map((ratio) => Math.max(0, Math.min(videoDuration - 0.04, videoDuration * ratio)))
      const extracted = await Promise.all(positions.map(async (position) => {
        const result = await window.minimax.extractVideoFrame(active.turntableVideo!.path, position, settings.outputDirectory, settings.ffmpegPath)
        return { ...result, kind: 'image' as const, preview: await window.minimax.mediaUrl(result.path) }
      }))
      patch({ referenceImages: extracted, referenceMode: 'set', selectedReferencePaths: undefined })
      onNotice('success', 'Five turntable angles were extracted into this character reference set.')
    } catch (error) { onNotice('error', error instanceof Error ? error.message : String(error)) }
    finally { setSplitting(false) }
  }

  return <div className="standard-page character-studio">
    <div className="page-heading"><div><p className="eyebrow">GLOBAL CHARACTER LIBRARY</p><h1>Character Studio</h1><p>Create reusable character identities, master images, turntables, and reference sets.</p></div><div className="heading-state"><span className={active.baseImage ? 'ok' : 'warn'}>{active.baseImage ? <Check size={15} /> : <UserRound size={15} />}{active.baseImage ? 'Master reference ready' : 'Create a master image'}</span></div></div>
    <div className="character-studio-grid">
      <aside className="character-project-list"><header><span><strong>Character projects</strong><small>{projects.length} saved globally</small></span><button onClick={add}><Plus size={14} />New</button></header><div>{projects.map((project) => <button key={project.id} className={project.id === active.id ? 'active' : ''} onClick={() => { setActiveId(project.id); setVideoDuration(0) }}>{project.baseImage?.preview ? <img src={project.baseImage.preview} alt="" /> : <span><UserRound size={18} /></span>}<span><strong>{project.name}</strong><small>{characterReferences(project).length} usable reference{characterReferences(project).length === 1 ? '' : 's'}</small></span></button>)}</div></aside>
      <section className="character-workbench">
        <header><div><UserRound size={18} /><span><strong>Identity and continuity</strong><small>These details and approved references can be imported into any movie.</small></span></div><button className="danger-button" onClick={remove}><Trash2 size={14} />Delete project</button></header>
        <div className="character-form"><label>Character name<input value={active.name} onChange={(event) => patch({ name: event.target.value, referencePrompt: '' })} /></label><label>Visual style<input value={active.visualStyle} onChange={(event) => patch({ visualStyle: event.target.value, referencePrompt: '' })} placeholder="Cinematic photorealism" /></label><label className="wide">Repeatable appearance<textarea value={active.description} onChange={(event) => patch({ description: event.target.value, referencePrompt: '' })} placeholder="Age, face geometry, complexion, eyes, hair, build, distinguishing marks…" /></label><label>Wardrobe and recurring props<textarea value={active.wardrobe} onChange={(event) => patch({ wardrobe: event.target.value, referencePrompt: '' })} /></label><label>Voice and performance baseline<textarea value={active.voiceNotes} onChange={(event) => patch({ voiceNotes: event.target.value, referencePrompt: '' })} /></label></div>
        <div className="character-assist"><span><Sparkles size={16} /><span><strong>Ollama continuity assistant</strong><small>Turns rough notes into stable identity anchors.</small></span></span><button className="secondary-button" disabled={!ollamaAvailable || assisting} onClick={() => void enhance()}>{assisting ? <LoaderCircle className="spin" size={14} /> : <WandSparkles size={14} />}Refine identity</button></div>
        <label className="character-reference-prompt"><span><strong>Master reference prompt</strong><small>One clean prompt is sent to Z-Image. You can edit it directly.</small></span><textarea aria-label="Master reference prompt" value={zPrompt} onChange={(event) => patch({ referencePrompt: event.target.value })} /></label>
        <div className="character-production-grid">
          <article><header><span><strong>1. Master reference</strong><small>Use one clear full-body image.</small></span></header><div className="character-media-stage">{active.baseImage?.preview ? <img src={active.baseImage.preview} alt={`${active.name} master reference`} /> : <div><ImagePlus size={26} /><span>No master image</span></div>}</div><footer><button className="secondary-button" onClick={() => void chooseImage('base')}><ImagePlus size={14} />Choose image</button><button className="primary-button" disabled={!active.name.trim()} onClick={() => onCreateWithZImage(active, zPrompt)}><Sparkles size={14} />Create with Z-Image</button></footer></article>
          <article><header><span><strong>2. Turntable video</strong><small>Generate a neutral 360° modeling pass.</small></span></header><div className="character-media-stage">{active.turntableVideo?.preview ? <video key={active.turntableVideo.preview} src={active.turntableVideo.preview} controls preload="metadata" onLoadedMetadata={(event) => setVideoDuration(event.currentTarget.duration)} /> : <div><Orbit size={26} /><span>No turntable video</span></div>}</div><footer><button className="secondary-button" onClick={() => void chooseTurntable()}><Film size={14} />Choose rendered video</button><button className="primary-button" disabled={!active.baseImage} onClick={() => onCreateTurntable(active)}><Orbit size={14} />Render turntable</button></footer></article>
        </div>
        <section className="character-reference-set"><header><span><strong>3. Approved references</strong><small>Choose exactly which character images are available to movies and MiniMax Reference.</small></span><button className="secondary-button" disabled={!active.turntableVideo || !videoDuration || splitting} onClick={() => void splitTurntable()}>{splitting ? <LoaderCircle className="spin" size={14} /> : <Images size={14} />}{splitting ? 'Extracting…' : 'Split into 5 angles'}</button></header><fieldset><legend>Use in movies</legend><label><input type="radio" name="character-reference-mode" checked={active.referenceMode === 'single'} onChange={() => patch({ referenceMode: 'single' })} />Single master image</label><label><input type="radio" name="character-reference-mode" checked={active.referenceMode === 'set'} onChange={() => patch({ referenceMode: 'set' })} />Selected reference images</label></fieldset><div className="character-reference-grid">{active.referenceImages.map((file, index) => { const selected = active.selectedReferencePaths === undefined || active.selectedReferencePaths.includes(file.path); return <figure className={selected ? 'selected' : ''} key={`${file.path}-${index}`}><img src={file.preview} alt={`${active.name} reference ${index + 1}`} /><figcaption><label><input type="checkbox" checked={selected} onChange={(event) => { const current = active.selectedReferencePaths ?? active.referenceImages.map((item) => item.path); patch({ referenceMode: 'set', selectedReferencePaths: event.target.checked ? [...new Set([...current, file.path])] : current.filter((path) => path !== file.path) }) }} />Use angle {index + 1}</label></figcaption><button aria-label={`Remove reference angle ${index + 1}`} onClick={() => patch({ referenceImages: active.referenceImages.filter((_, itemIndex) => itemIndex !== index), selectedReferencePaths: active.selectedReferencePaths?.filter((path) => path !== file.path) })}><X size={13} /></button></figure> })}<button className="character-add-reference" onClick={() => void chooseImage('reference')}><ImagePlus size={19} /><span>Add reference</span></button></div></section>
      </section>
    </div>
  </div>
}
