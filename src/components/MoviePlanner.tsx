import { useEffect, useMemo, useState } from 'react'
import { BookOpen, Check, ChevronDown, ChevronRight, CirclePause, CirclePlay, Clapperboard, Clock3, Film, ImagePlus, LoaderCircle, MapPin, MessageSquare, Pencil, Plus, Send, SkipBack, SkipForward, Sparkles, Trash2, Users, X } from 'lucide-react'
import type { AppSettings, GenerationMode, MediaFile, MovieCharacter, MovieChatArea, MovieLocation, MovieProject, MovieScene, MovieShot } from '../types'

type PlannerStep = 'setup' | 'bible' | 'shots' | 'preview'

const plannerSchema: Record<string, unknown> = {
  type: 'object', properties: { scenes: { type: 'array', minItems: 1, maxItems: 24, items: {
    type: 'object', properties: {
      title: { type: 'string' }, summary: { type: 'string' }, location: { type: 'string' },
      shots: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'object', properties: {
        title: { type: 'string' }, duration: { type: 'number', minimum: 2, maximum: 15 }, prompt: { type: 'string' },
        dialogue: { type: 'string' }, mode: { type: 'string', enum: ['text', 'image', 'frames', 'reference'] },
        characters: { type: 'array', items: { type: 'string' } },
      }, required: ['title', 'duration', 'prompt', 'dialogue', 'mode', 'characters'] } },
    }, required: ['title', 'summary', 'location', 'shots'],
  } } }, required: ['scenes'],
}
const characterSchema: Record<string, unknown> = { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, wardrobe: { type: 'string' }, voiceNotes: { type: 'string' } }, required: ['name', 'description', 'wardrobe', 'voiceNotes'] }
const locationSchema: Record<string, unknown> = { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } }, required: ['name', 'description'] }
const movieChatSchema: Record<string, unknown> = {
  type: 'object', properties: {
    reply: { type: 'string' }, changes: { type: 'array', items: { type: 'string' } },
    focusAreas: { type: 'array', items: { type: 'string', enum: ['setup', 'bible', 'shots', 'preview'] } },
    projectPatch: { type: 'object', properties: { title: { type: 'string' }, targetRuntime: { type: 'number' }, computeBudgetMinutes: { type: 'number' }, aspectRatio: { type: 'string', enum: ['16:9', '9:16', '1:1'] }, genre: { type: 'string' }, visualStyle: { type: 'string' }, quality: { type: 'string', enum: ['preview', 'balanced', 'maximum'] }, reviewGate: { type: 'string', enum: ['shot', 'scene', 'batch'] }, story: { type: 'string' }, visualRules: { type: 'string' } }, required: ['title', 'targetRuntime', 'computeBudgetMinutes', 'aspectRatio', 'genre', 'visualStyle', 'quality', 'reviewGate', 'story', 'visualRules'] },
    characterUpserts: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, wardrobe: { type: 'string' }, voiceNotes: { type: 'string' } }, required: ['id', 'name', 'description', 'wardrobe', 'voiceNotes'] } },
    characterDeletes: { type: 'array', items: { type: 'string' } },
    locationUpserts: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } }, required: ['id', 'name', 'description'] } },
    locationDeletes: { type: 'array', items: { type: 'string' } },
    sceneUpserts: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' }, locationId: { type: 'string' }, transition: { type: 'string', enum: ['connected', 'cut'] } }, required: ['id', 'title', 'summary', 'locationId', 'transition'] } },
    sceneDeletes: { type: 'array', items: { type: 'string' } },
    shotUpserts: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, sceneId: { type: 'string' }, title: { type: 'string' }, prompt: { type: 'string' }, dialogue: { type: 'string' }, duration: { type: 'number' }, mode: { type: 'string', enum: ['text', 'image', 'frames', 'reference'] }, characterIds: { type: 'array', items: { type: 'string' } } }, required: ['id', 'sceneId', 'title', 'prompt', 'dialogue', 'duration', 'mode', 'characterIds'] } },
    shotDeletes: { type: 'array', items: { type: 'string' } },
  }, required: ['reply', 'changes', 'focusAreas', 'projectPatch', 'characterUpserts', 'characterDeletes', 'locationUpserts', 'locationDeletes', 'sceneUpserts', 'sceneDeletes', 'shotUpserts', 'shotDeletes'],
}

function makeProject(index = 1): MovieProject {
  const now = Date.now()
  return { id: crypto.randomUUID(), title: index === 1 ? 'Untitled movie' : `Movie ${index}`, createdAt: now, updatedAt: now, status: 'planning', targetRuntime: 60, computeBudgetMinutes: 120, aspectRatio: '16:9', genre: '', visualStyle: '', quality: 'balanced', reviewGate: 'scene', story: '', visualRules: '', characters: [], locations: [], scenes: [], chatMessages: [] }
}

function loadProjects(): MovieProject[] {
  try {
    const stored = JSON.parse(localStorage.getItem('minimax.movie-projects') ?? '[]') as Partial<MovieProject>[]
    const projects = stored.filter((item) => item.id && item.title).map((item, index) => ({
      ...makeProject(index + 1), ...item,
      characters: (item.characters ?? []).map((character) => ({ ...character, referenceImages: character.referenceImages ?? [] })),
      locations: (item.locations ?? []).map((location) => ({ ...location, referenceImages: location.referenceImages ?? [] })),
      scenes: (item.scenes ?? []).map((scene, sceneIndex) => ({ ...scene, transition: scene.transition ?? (sceneIndex === 0 ? 'cut' : 'connected'), shots: scene.shots ?? [] })),
      chatMessages: item.chatMessages ?? [],
    })) as MovieProject[]
    return projects.length ? projects : [makeProject()]
  } catch { return [makeProject()] }
}

export function MoviePlanner({ settings, ollamaAvailable, ollamaModel, onOpenShot, onNotice }: {
  settings: AppSettings; ollamaAvailable: boolean; ollamaModel: string
  onOpenShot(shot: MovieShot, aspectRatio: MovieProject['aspectRatio'], references: MediaFile[], context: { projectId: string; sceneId: string; continuationSource?: string }): void
  onNotice(tone: 'error' | 'success' | 'neutral', text: string): void
}) {
  const [projects, setProjects] = useState<MovieProject[]>(loadProjects)
  const [projectId, setProjectId] = useState(() => projects[0].id)
  const [step, setStep] = useState<PlannerStep>('setup')
  const [planning, setPlanning] = useState(false)
  const [assisting, setAssisting] = useState<string | null>(null)
  const [chatInput, setChatInput] = useState('')
  const [chatting, setChatting] = useState(false)
  const [previewIndex, setPreviewIndex] = useState(0)
  const [characterDraft, setCharacterDraft] = useState<MovieCharacter | null>(null)
  const [locationDraft, setLocationDraft] = useState<MovieLocation | null>(null)
  const [expandedScenes, setExpandedScenes] = useState<string[]>(() => projects[0].scenes[0] ? [projects[0].scenes[0].id] : [])
  const [expandedShots, setExpandedShots] = useState<string[]>([])
  const project = projects.find((item) => item.id === projectId) ?? projects[0]
  const plannedSeconds = useMemo(() => project.scenes.reduce((total, scene) => total + scene.shots.reduce((sum, shot) => sum + shot.duration, 0), 0), [project.scenes])
  const shotCount = project.scenes.reduce((total, scene) => total + scene.shots.length, 0)
  const renderedClips = useMemo(() => project.scenes.flatMap((scene, sceneIndex) => scene.shots.map((shot, shotIndex) => ({ scene, sceneIndex, shot, shotIndex })).filter((item) => item.shot.outputUrl)), [project.scenes])

  useEffect(() => {
    if (!characterDraft && !locationDraft) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setCharacterDraft(null); setLocationDraft(null) } }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [characterDraft, locationDraft])

  useEffect(() => {
    setPreviewIndex((value) => Math.min(value, Math.max(0, renderedClips.length - 1)))
  }, [project.id, renderedClips.length])

  const commit = (all: MovieProject[]) => { setProjects(all); localStorage.setItem('minimax.movie-projects', JSON.stringify(all)) }
  const update = (change: (current: MovieProject) => MovieProject) => commit(projects.map((item) => item.id === project.id ? { ...change(item), updatedAt: Date.now() } : item))
  const updateScene = (id: string, change: Partial<MovieScene>) => update((value) => ({ ...value, scenes: value.scenes.map((item) => item.id === id ? { ...item, ...change } : item) }))
  const updateShot = (sceneId: string, shotId: string, change: Partial<MovieShot>) => update((value) => ({ ...value, scenes: value.scenes.map((scene) => scene.id === sceneId ? { ...scene, shots: scene.shots.map((shot) => shot.id === shotId ? { ...shot, ...change } : shot) } : scene) }))
  const addScene = () => {
    const id = crypto.randomUUID()
    update((value) => ({ ...value, scenes: [...value.scenes, { id, title: `Scene ${value.scenes.length + 1}`, summary: '', locationId: value.locations[0]?.id ?? '', transition: value.scenes.length ? 'connected' : 'cut', shots: [] }] }))
    setExpandedScenes((value) => [...value, id])
  }
  const addShot = (sceneId: string) => update((value) => ({ ...value, scenes: value.scenes.map((scene) => scene.id === sceneId ? { ...scene, shots: [...scene.shots, makeShot(scene.shots.length + 1)] } : scene) }))

  const requireOllama = () => {
    if (ollamaAvailable) return true
    onNotice('error', 'No local Ollama text model is available. Manual editing remains available.')
    return false
  }
  const runTextAssistant = async (key: string, request: string, apply: (result: string) => void) => {
    if (!requireOllama()) return
    setAssisting(key)
    try {
      const result = (await window.minimax.generateWithOllama(settings.ollamaUrl, ollamaModel, request)).trim()
      if (!result) throw new Error('Ollama returned an empty response.')
      apply(result); onNotice('success', `Updated locally with ${ollamaModel}. Review the result before continuing.`)
    } catch (error) { onNotice('error', error instanceof Error ? error.message : String(error)) }
    finally { setAssisting(null) }
  }
  const assistStory = () => {
    if (!project.story.trim()) { onNotice('error', 'Write a short premise first so Ollama has a direction to develop.'); return }
    void runTextAssistant('story', ['Rewrite the supplied premise as a concise, production-ready film treatment. Preserve all stated facts and ending. Add clear dramatic beats and only necessary dialogue. Return only the treatment.', `Genre: ${project.genre || 'unspecified'}`, `Visual style: ${project.visualStyle || 'unspecified'}`, `Target runtime: ${project.targetRuntime} seconds`, `Premise: ${project.story}`].join('\n\n'), (story) => update((value) => ({ ...value, story })))
  }
  const assistRules = () => void runTextAssistant('rules', [
    'Create a compact continuity bible for this AI-generated film. Cover palette, lighting, lenses, camera movement, aspect ratio, recurring props, wardrobe continuity, time of day, and changes to avoid. Return only practical rules.',
    `Story: ${project.story || 'No story supplied'}`, `Style: ${project.visualStyle || 'unspecified'}`, `Aspect: ${project.aspectRatio}`,
    `Characters: ${JSON.stringify(project.characters.map(({ name, description, wardrobe, voiceNotes }) => ({ name, description, wardrobe, voiceNotes })))}`,
    `Locations: ${JSON.stringify(project.locations.map(({ name, description }) => ({ name, description })))}`,
  ].join('\n\n'), (visualRules) => update((value) => ({ ...value, visualRules })))

  const assistCharacter = async () => {
    if (!characterDraft || !requireOllama()) return
    setAssisting('character')
    try {
      const raw = await window.minimax.generateStructuredWithOllama(settings.ollamaUrl, ollamaModel, ['Create or improve one recurring movie character. Make the appearance visually specific and repeatable between AI video shots. Wardrobe and voice must be concise continuity anchors. Return only the requested data.', `Film: ${project.title}`, `Genre: ${project.genre || 'unspecified'}`, `Style: ${project.visualStyle || 'unspecified'}`, `Story: ${project.story || 'No story supplied'}`, `Existing character notes: ${JSON.stringify(characterDraft)}`].join('\n\n'), characterSchema) as Partial<MovieCharacter>
      setCharacterDraft((value) => value ? { ...value, name: text(raw.name) || value.name, description: text(raw.description) || value.description, wardrobe: text(raw.wardrobe) || value.wardrobe, voiceNotes: text(raw.voiceNotes) || value.voiceNotes } : value)
      onNotice('success', `Character draft improved locally with ${ollamaModel}.`)
    } catch (error) { onNotice('error', error instanceof Error ? error.message : String(error)) }
    finally { setAssisting(null) }
  }
  const assistLocation = async () => {
    if (!locationDraft || !requireOllama()) return
    setAssisting('location')
    try {
      const raw = await window.minimax.generateStructuredWithOllama(settings.ollamaUrl, ollamaModel, ['Create or improve one recurring movie location. Describe stable architecture, geography, layout, materials, lighting sources, atmosphere, and repeatable landmarks for visual continuity. Return only the requested data.', `Film: ${project.title}`, `Genre: ${project.genre || 'unspecified'}`, `Style: ${project.visualStyle || 'unspecified'}`, `Story: ${project.story || 'No story supplied'}`, `Existing location notes: ${JSON.stringify(locationDraft)}`].join('\n\n'), locationSchema) as Partial<MovieLocation>
      setLocationDraft((value) => value ? { ...value, name: text(raw.name) || value.name, description: text(raw.description) || value.description } : value)
      onNotice('success', `Location draft improved locally with ${ollamaModel}.`)
    } catch (error) { onNotice('error', error instanceof Error ? error.message : String(error)) }
    finally { setAssisting(null) }
  }
  const addDraftReference = async (kind: 'character' | 'location') => {
    try {
      const picked = await window.minimax.chooseMedia('image')
      if (!picked) return
      const file: MediaFile = { ...picked, kind: 'image', preview: await window.minimax.mediaUrl(picked.path) }
      if (kind === 'character') setCharacterDraft((value) => value ? { ...value, referenceImages: [...value.referenceImages, file] } : value)
      else setLocationDraft((value) => value ? { ...value, referenceImages: [...value.referenceImages, file] } : value)
    } catch (error) { onNotice('error', error instanceof Error ? error.message : String(error)) }
  }
  const saveCharacter = () => {
    if (!characterDraft?.name.trim()) { onNotice('error', 'Give the character a name before saving.'); return }
    update((value) => ({ ...value, characters: value.characters.some((item) => item.id === characterDraft.id) ? value.characters.map((item) => item.id === characterDraft.id ? characterDraft : item) : [...value.characters, characterDraft] })); setCharacterDraft(null)
  }
  const saveLocation = () => {
    if (!locationDraft?.name.trim()) { onNotice('error', 'Give the location a name before saving.'); return }
    update((value) => ({ ...value, locations: value.locations.some((item) => item.id === locationDraft.id) ? value.locations.map((item) => item.id === locationDraft.id ? locationDraft : item) : [...value.locations, locationDraft] })); setLocationDraft(null)
  }
  const assistShot = (scene: MovieScene, shot: MovieShot) => {
    const location = project.locations.find((item) => item.id === scene.locationId)
    const characters = project.characters.filter((item) => shot.characterIds.includes(item.id))
    void runTextAssistant(`shot:${shot.id}`, ['Rewrite this as one production-ready MiniMax H3 video prompt. Be literal and chronological. Include exact subject identity, action, environment, camera framing and movement, lighting, physical continuity, synchronized sound, and exact dialogue. Do not add commentary.', `Scene: ${scene.title} — ${scene.summary}`, `Location: ${location ? `${location.name}: ${location.description}` : 'unspecified'}`, `Characters: ${JSON.stringify(characters.map(({ name, description, wardrobe, voiceNotes }) => ({ name, description, wardrobe, voiceNotes })))}`, `Continuity rules: ${project.visualRules || 'none'}`, `Duration: ${shot.duration} seconds`, `Generation route: ${shot.mode}`, `Dialogue: ${shot.dialogue || 'none'}`, `Current prompt: ${shot.prompt || 'none'}`].join('\n\n'), (prompt) => updateShot(scene.id, shot.id, { prompt }))
  }

  const sendMovieChat = async (suggestedQuestion?: string) => {
    const question = (suggestedQuestion ?? chatInput).trim()
    if (!question || chatting || !requireOllama()) return
    setChatting(true)
    try {
      const context = {
        project: { title: project.title, targetRuntime: project.targetRuntime, computeBudgetMinutes: project.computeBudgetMinutes, aspectRatio: project.aspectRatio, genre: project.genre, visualStyle: project.visualStyle, quality: project.quality, reviewGate: project.reviewGate, story: project.story, visualRules: project.visualRules },
        characters: project.characters.map(({ id, name, description, wardrobe, voiceNotes }) => ({ id, name, description, wardrobe, voiceNotes })),
        locations: project.locations.map(({ id, name, description }) => ({ id, name, description })),
        scenes: project.scenes.map((scene) => ({ id: scene.id, title: scene.title, summary: scene.summary, locationId: scene.locationId, transition: scene.transition, shots: scene.shots.map(({ id, title, duration, prompt, dialogue, mode, characterIds, stage }) => ({ id, title, duration, prompt, dialogue, mode, characterIds, stage })) })),
        recentConversation: project.chatMessages.slice(-20).map(({ role, content }) => ({ role, content })),
      }
      const raw = await window.minimax.generateStructuredWithOllama(settings.ollamaUrl, ollamaModel, [
        'You are the persistent copilot and production designer for one AI movie project. You know the complete project context below. Answer the filmmaker directly and maintain story, character, location, camera, dialogue, and shot continuity.',
        'You can build every editable area: project setup and story, production bible, characters, locations, scenes, and MiniMax shots. Use an existing ID to revise an item. To create an item, use a temporary ID beginning with new- and reuse that exact temporary ID anywhere it is referenced in this response. Use delete arrays only when deletion was explicitly requested.',
        'If the filmmaker asks for a change, return the complete unchanged projectPatch plus only the upserts/deletes needed, and briefly list each applied change. If they only ask a question, return the project fields unchanged and every operation array empty. Preserve all unrequested content. Keep MiniMax prompts literal and chronological. Reply using concise Markdown: short headings, bold terms, bullets, and inline code are supported. Set focusAreas to the workspace areas the filmmaker should review.',
        `PROJECT CONTEXT: ${JSON.stringify(context)}`, `FILMMAKER: ${question}`,
      ].join('\n\n'), movieChatSchema) as MovieChatResult
      const changes = Array.isArray(raw.changes) ? raw.changes.map(text).filter(Boolean) : []
      const hasOperations = hasMovieChatOperations(raw)
      const appliedChanges = changes.length ? changes : hasOperations ? ['Updated the requested movie project areas.'] : []
      const areas = normalizeChatAreas(raw.focusAreas, raw)
      update((value) => {
        const changed = changes.length || hasOperations ? applyMovieChatOperations(value, raw) : value
        return { ...changed, chatMessages: [...value.chatMessages, { id: crypto.randomUUID(), role: 'user' as const, content: question, createdAt: Date.now() }, { id: crypto.randomUUID(), role: 'assistant' as const, content: text(raw.reply) || 'I reviewed the project.', createdAt: Date.now() + 1, appliedChanges, areas }].slice(-100) }
      })
      setChatInput('')
    } catch (error) { onNotice('error', `Movie copilot: ${error instanceof Error ? error.message : String(error)}`) }
    finally { setChatting(false) }
  }

  const buildPlan = async () => {
    if (!project.story.trim()) { onNotice('error', 'Add the story before building a shot plan.'); setStep('setup'); return }
    if (!requireOllama()) return
    if (project.scenes.length && !window.confirm('Replace the current scene and shot plan? Your production bible will be kept.')) return
    const request = ['Create a practical shot plan for a locally generated AI film. Return only data matching the provided JSON schema.', `Target finished runtime: ${project.targetRuntime} seconds. Every shot must be 2 to 15 seconds. Keep the total close to the target.`, 'Use text mode only for establishing or non-recurring subjects. Use reference for recurring characters. Use image for a locked opening composition and frames only when both endpoints are important.', 'Prompts must be literal, chronological MiniMax H3 directions including subject, action, camera, lighting, and synchronized audio. Put exact spoken words in dialogue and repeat them in the prompt.', `PROJECT: ${JSON.stringify({ title: project.title, genre: project.genre, visualStyle: project.visualStyle, aspectRatio: project.aspectRatio, story: project.story, visualRules: project.visualRules, characters: project.characters.map(({ name, description, wardrobe, voiceNotes }) => ({ name, description, wardrobe, voiceNotes })), locations: project.locations.map(({ name, description }) => ({ name, description })) })}`].join('\n\n')
    setPlanning(true)
    try {
      const raw = await window.minimax.generateStructuredWithOllama(settings.ollamaUrl, ollamaModel, request, plannerSchema)
      const scenes = normalizePlan(raw, project)
      if (!scenes.length) throw new Error('Ollama did not produce any usable scenes.')
      update((value) => ({ ...value, scenes })); setExpandedScenes(scenes[0] ? [scenes[0].id] : []); setStep('shots'); onNotice('success', `Created ${scenes.reduce((total, scene) => total + scene.shots.length, 0)} editable shots. Nothing was sent to ComfyUI.`)
    } catch (error) { onNotice('error', error instanceof Error ? error.message : String(error)) }
    finally { setPlanning(false) }
  }
  const assistantButton = (key: string, label: string, action: () => void) => <button className="assistant-button" disabled={Boolean(assisting) || !ollamaAvailable} title={!ollamaAvailable ? 'Connect a local Ollama model in Settings' : `Use ${ollamaModel}`} onClick={action}>{assisting === key ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}{assisting === key ? 'Working locally…' : label}</button>

  return <div className="standard-page movie-page">
    <div className="movie-planner-shell"><div className="movie-planner-main">
    <div className="page-heading"><div><p className="eyebrow">GUIDED PRODUCTION</p><h1>Movie planner</h1><p>Shape the story, lock continuity, then hand off one reviewed shot at a time.</p></div><div className="movie-heading-actions"><span className={`movie-save-state ${project.status}`}><Check size={13} />Saved locally</span><button className="secondary-button" onClick={() => update((value) => ({ ...value, status: value.status === 'paused' ? 'planning' : 'paused' }))}>{project.status === 'paused' ? <CirclePlay size={15} /> : <CirclePause size={15} />}{project.status === 'paused' ? 'Resume project' : 'Pause project'}</button></div></div>
    <div className="movie-project-bar"><label>Movie project<select value={project.id} onChange={(event) => { const next = projects.find((item) => item.id === event.target.value); setProjectId(event.target.value); setExpandedScenes(next?.scenes[0] ? [next.scenes[0].id] : []); setExpandedShots([]); setStep('setup') }}>{projects.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label><button className="secondary-button" onClick={() => { const next = makeProject(projects.length + 1); commit([...projects, next]); setProjectId(next.id); setExpandedScenes([]); setExpandedShots([]); setStep('setup') }}><Plus size={15} />New movie</button><label className="movie-title-field">Project title<input value={project.title} onChange={(event) => update((value) => ({ ...value, title: event.target.value }))} /></label></div>
    <div className="movie-summary-strip"><div><Clock3 size={16} /><span><strong>{formatDuration(plannedSeconds)} / {formatDuration(project.targetRuntime)}</strong><small>planned runtime</small></span></div><div><Clapperboard size={16} /><span><strong>{project.scenes.length} scenes · {shotCount} shots</strong><small>editable plan</small></span></div><div><Sparkles size={16} /><span><strong>{project.computeBudgetMinutes} minute budget</strong><small>{ollamaAvailable ? `${ollamaModel} ready` : 'manual planning available'}</small></span></div><div className="runtime-meter"><i style={{ width: `${Math.min(100, project.targetRuntime ? plannedSeconds / project.targetRuntime * 100 : 0)}%` }} /></div></div>
    {project.status === 'paused' && <div className="movie-paused"><CirclePause size={16} /><span><strong>Project paused</strong><small>Your plan remains editable, but future automated production passes will not queue work.</small></span></div>}
    <nav className="movie-steps" aria-label="Movie planning stages"><button className={step === 'setup' ? 'active' : ''} onClick={() => setStep('setup')}><span>1</span><div><strong>Story setup</strong><small>Creative brief</small></div></button><button className={step === 'bible' ? 'active' : ''} onClick={() => setStep('bible')}><span>2</span><div><strong>Production bible</strong><small>People and places</small></div></button><button className={step === 'shots' ? 'active' : ''} onClick={() => setStep('shots')}><span>3</span><div><strong>Shot plan</strong><small>Scenes and handoff</small></div></button><button className={step === 'preview' ? 'active' : ''} onClick={() => setStep('preview')}><span>4</span><div><strong>Movie preview</strong><small>{renderedClips.length} finished clips</small></div></button></nav>

    {step === 'setup' && <section className="movie-stage"><div className="movie-stage-heading"><div><BookOpen size={18} /><span><strong>Creative brief</strong><small>Start with the story. Production limits are grouped below to keep this page focused.</small></span></div></div><div className="movie-brief-layout"><div className="movie-story-field"><div className="field-heading"><label htmlFor="movie-story">Story, outline, or screenplay</label>{assistantButton('story', 'Develop with Ollama', assistStory)}</div><textarea id="movie-story" value={project.story} onChange={(event) => update((value) => ({ ...value, story: event.target.value }))} placeholder="Begin with a short premise, or paste a complete outline. Include the ending and any dialogue that must be preserved…" /></div><div className="movie-direction-fields"><label>Genre<input value={project.genre} onChange={(event) => update((value) => ({ ...value, genre: event.target.value }))} placeholder="Science fiction, drama…" /></label><label>Visual direction<textarea value={project.visualStyle} onChange={(event) => update((value) => ({ ...value, visualStyle: event.target.value }))} placeholder="Grounded realism, 35mm, restrained handheld camera…" /></label></div></div><details className="movie-production-settings"><summary><span><strong>Production limits</strong><small>{project.targetRuntime}s · {project.aspectRatio} · {project.quality} · review by {project.reviewGate}</small></span><ChevronDown size={16} /></summary><div className="movie-form-grid compact-grid"><label>Target runtime (seconds)<input type="number" min="10" max="3600" value={project.targetRuntime} onChange={(event) => update((value) => ({ ...value, targetRuntime: clamp(Number(event.target.value), 10, 3600) }))} /></label><label>Compute budget (minutes)<input type="number" min="10" max="100000" value={project.computeBudgetMinutes} onChange={(event) => update((value) => ({ ...value, computeBudgetMinutes: clamp(Number(event.target.value), 10, 100000) }))} /></label><label>Aspect ratio<select value={project.aspectRatio} onChange={(event) => update((value) => ({ ...value, aspectRatio: event.target.value as MovieProject['aspectRatio'] }))}><option value="16:9">Landscape · 16:9</option><option value="9:16">Portrait · 9:16</option><option value="1:1">Square · 1:1</option></select></label><label>Quality target<select value={project.quality} onChange={(event) => update((value) => ({ ...value, quality: event.target.value as MovieProject['quality'] }))}><option value="preview">Preview</option><option value="balanced">Balanced</option><option value="maximum">Maximum</option></select></label><label>Review gate<select value={project.reviewGate} onChange={(event) => update((value) => ({ ...value, reviewGate: event.target.value as MovieProject['reviewGate'] }))}><option value="shot">Review every shot</option><option value="scene">Review every scene</option><option value="batch">Review small batches</option></select></label></div></details><div className="movie-stage-actions"><span>{project.story.trim() ? 'Creative brief saved locally.' : 'Add a premise before continuing.'}</span><button className="primary-button" disabled={!project.story.trim()} onClick={() => setStep('bible')}>Continue to bible<ChevronRight size={16} /></button></div></section>}

    {step === 'bible' && <section className="movie-stage"><div className="movie-stage-heading"><div><Users size={18} /><span><strong>Production bible</strong><small>Create movie-ready people and places without crowding the main workspace.</small></span></div></div><div className="bible-rules"><div className="field-heading"><label htmlFor="visual-rules">Global continuity and camera rules</label>{assistantButton('rules', 'Draft rules with Ollama', assistRules)}</div><textarea id="visual-rules" value={project.visualRules} onChange={(event) => update((value) => ({ ...value, visualRules: event.target.value }))} placeholder="Lighting, palette, lenses, camera motion, prohibited changes, recurring props…" /></div><div className="bible-columns"><AssetCollection title="Characters" subtitle={`${project.characters.length} recurring subjects`} empty="Create recurring cast members here. Each saved character becomes a reusable movie card." onAdd={() => setCharacterDraft(blankCharacter())}>{project.characters.map((character) => <AssetCard key={character.id} icon="character" name={character.name} description={character.description} references={character.referenceImages} onEdit={() => setCharacterDraft(structuredClone(character))} onRemove={() => { if (window.confirm(`Remove ${character.name} from the production bible?`)) update((value) => ({ ...value, characters: value.characters.filter((item) => item.id !== character.id) })) }} />)}</AssetCollection><AssetCollection title="Locations" subtitle={`${project.locations.length} recurring sets`} empty="Create recognizable sets here. Each saved location becomes a reusable movie card." onAdd={() => setLocationDraft(blankLocation())}>{project.locations.map((location) => <AssetCard key={location.id} icon="location" name={location.name} description={location.description} references={location.referenceImages} onEdit={() => setLocationDraft(structuredClone(location))} onRemove={() => { if (window.confirm(`Remove ${location.name} from the production bible?`)) update((value) => ({ ...value, locations: value.locations.filter((item) => item.id !== location.id) })) }} />)}</AssetCollection></div><div className="movie-stage-actions"><span>{project.characters.length} characters and {project.locations.length} locations saved.</span><button className="primary-button" onClick={() => setStep('shots')}>Continue to shots<ChevronRight size={16} /></button></div></section>}

    {step === 'shots' && <section className="movie-stage shot-stage"><div className="movie-stage-heading"><div><Clapperboard size={18} /><span><strong>Scenes and shots</strong><small>Each scene is a summary card. Open only the scene or shot you need.</small></span></div><div className="shot-plan-actions"><button className="secondary-button" onClick={addScene}><Plus size={15} />Add scene</button><button className="primary-button" disabled={planning || !ollamaAvailable || !project.story.trim()} onClick={() => void buildPlan()}>{planning ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}{planning ? 'Planning locally…' : 'Build with Ollama'}</button></div></div>{!ollamaAvailable && <div className="movie-inline-warning">Ollama is offline. Manual scene and shot editing remains available.</div>}{project.scenes.length === 0 ? <div className="shot-plan-empty"><Clapperboard size={28} /><strong>No shots planned</strong><span>Use local Ollama or add a scene manually. No ComfyUI work will start.</span></div> : <div className="scene-list">{project.scenes.map((scene, sceneIndex) => {
      const sceneOpen = expandedScenes.includes(scene.id)
      const sceneLocation = project.locations.find((item) => item.id === scene.locationId)
      const sceneSeconds = scene.shots.reduce((total, shot) => total + shot.duration, 0)
      const castNames = project.characters.filter((character) => scene.shots.some((shot) => shot.characterIds.includes(character.id))).map((character) => character.name)
      const routes = [...new Set(scene.shots.map((shot) => routeName(shot.mode)))]
      const previousScene = project.scenes[sceneIndex - 1]
      const continuationSource = previousScene?.shots[previousScene.shots.length - 1]?.outputUrl
      const connected = sceneIndex > 0 && scene.transition === 'connected'
      return <article className={`scene-card ${sceneOpen ? 'open' : ''}`} key={scene.id}><button className="scene-card-summary" aria-expanded={sceneOpen} aria-controls={`scene-body-${scene.id}`} onClick={() => setExpandedScenes((value) => value.includes(scene.id) ? value.filter((id) => id !== scene.id) : [...value, scene.id])}><span className="scene-index">{String(sceneIndex + 1).padStart(2, '0')}</span><span className="scene-summary-copy"><strong>{scene.title || `Scene ${sceneIndex + 1}`}</strong><span>{scene.summary || 'No scene summary yet.'}</span><small>{sceneLocation?.name || 'Location not set'} · {scene.shots.length} shot{scene.shots.length === 1 ? '' : 's'} · {formatDuration(sceneSeconds)}</small></span><span className="scene-card-facts"><span>{connected ? continuationSource ? 'Connected · frame ready' : 'Connected · waiting for frame' : sceneIndex ? 'Hard cut' : 'Opening scene'}</span><span>{routes.length ? routes.join(' + ') : 'No routes'} · {castNames.length ? castNames.join(', ') : 'No cast assigned'}</span></span><ChevronDown className="scene-card-chevron" size={17} /></button>{sceneOpen && <div className="scene-card-body" id={`scene-body-${scene.id}`}><div className="scene-editor"><div><label>Scene title<input aria-label={`Scene ${sceneIndex + 1} title`} value={scene.title} onChange={(event) => updateScene(scene.id, { title: event.target.value })} /></label><label>Scene summary<textarea aria-label={`${scene.title} summary`} value={scene.summary} onChange={(event) => updateScene(scene.id, { summary: event.target.value })} placeholder="What changes in this scene?" /></label></div><label>Location<select value={scene.locationId} onChange={(event) => updateScene(scene.id, { locationId: event.target.value })}><option value="">Unspecified</option>{project.locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}</select></label>{sceneIndex > 0 && <label>Connection<select value={scene.transition} onChange={(event) => updateScene(scene.id, { transition: event.target.value as MovieScene['transition'] })}><option value="connected">Continue previous frame</option><option value="cut">Hard cut / new image</option></select></label>}<button className="secondary-button danger-button" onClick={() => { if (window.confirm(`Remove ${scene.title} and all its shots?`)) update((value) => ({ ...value, scenes: value.scenes.filter((item) => item.id !== scene.id) })) }}><Trash2 size={14} />Remove scene</button></div>{connected && <div className={`scene-continuity ${continuationSource ? 'ready' : 'waiting'}`}><span><strong>Automatic last-frame continuation</strong><small>{continuationSource ? `${previousScene.title}'s final rendered frame will become this scene's first frame.` : `Render ${previousScene.title}'s final shot first. This scene will stay blocked from handoff until that frame exists.`}</small></span><span>{continuationSource ? 'Ready' : 'Waiting'}</span></div>}<div className="shot-list">{scene.shots.map((shot, shotIndex) => {
          const expanded = expandedShots.includes(shot.id)
          const shotReferences = uniqueMedia([...project.characters.filter((item) => shot.characterIds.includes(item.id)).flatMap((item) => item.referenceImages), ...(project.locations.find((item) => item.id === scene.locationId)?.referenceImages ?? [])])
          const needsContinuation = connected && shotIndex === 0
          const handoffBlocked = needsContinuation && !continuationSource
          return <div className={`movie-shot ${expanded ? 'expanded' : ''}`} key={shot.id}><div className="shot-number">{sceneIndex + 1}.{shotIndex + 1}</div><div className="shot-summary"><input aria-label="Shot title" value={shot.title} onChange={(event) => updateShot(scene.id, shot.id, { title: event.target.value })} /><span>{shot.prompt || 'No prompt yet'}</span><small>{shot.outputUrl ? 'Rendered' : shot.dialogue ? 'Dialogue added' : 'No dialogue'} · {shot.duration}s · {needsContinuation ? 'Frame continuation' : routeName(shot.mode)} · {shot.characterIds.length} cast</small></div><div className="shot-row-actions"><button className="secondary-button" onClick={() => setExpandedShots((value) => value.includes(shot.id) ? value.filter((id) => id !== shot.id) : [...value, shot.id])}><Pencil size={14} />{expanded ? 'Close details' : 'Edit details'}</button><button className="primary-button" disabled={!shot.prompt.trim() || handoffBlocked} title={handoffBlocked ? `Render ${previousScene.title}'s final shot first` : undefined} onClick={() => onOpenShot(needsContinuation ? { ...shot, mode: 'image' } : shot, project.aspectRatio, shotReferences, { projectId: project.id, sceneId: scene.id, continuationSource: needsContinuation ? continuationSource : undefined })}>{handoffBlocked ? 'Waiting for prior scene' : 'Open in Create'}{!handoffBlocked && <ChevronRight size={14} />}</button><button className="icon-button" aria-label={`Remove ${shot.title}`} onClick={() => updateScene(scene.id, { shots: scene.shots.filter((item) => item.id !== shot.id) })}><Trash2 size={14} /></button></div>{expanded && <div className="shot-details"><div className="field-heading"><label htmlFor={`prompt-${shot.id}`}>MiniMax prompt</label>{assistantButton(`shot:${shot.id}`, 'Improve prompt', () => assistShot(scene, shot))}</div><textarea id={`prompt-${shot.id}`} value={shot.prompt} onChange={(event) => updateShot(scene.id, shot.id, { prompt: event.target.value })} placeholder="Subject, action, camera, light, and sound…" /><label>Exact dialogue<input value={shot.dialogue} onChange={(event) => updateShot(scene.id, shot.id, { dialogue: event.target.value })} placeholder="Exact spoken words, if any" /></label>{project.characters.length > 0 && <fieldset className="shot-cast-picker"><legend>Characters in this shot</legend><div>{project.characters.map((character) => <label key={character.id}><input type="checkbox" checked={shot.characterIds.includes(character.id)} onChange={(event) => updateShot(scene.id, shot.id, { characterIds: event.target.checked ? [...shot.characterIds, character.id] : shot.characterIds.filter((id) => id !== character.id) })} /><span>{character.name}</span></label>)}</div></fieldset>}<div className="shot-detail-settings"><label>Seconds<input type="number" min="2" max="15" step="1" value={shot.duration} onChange={(event) => updateShot(scene.id, shot.id, { duration: clamp(Number(event.target.value), 2, 15) })} /></label><label>Generation route<select disabled={needsContinuation} value={needsContinuation ? 'image' : shot.mode} onChange={(event) => updateShot(scene.id, shot.id, { mode: event.target.value as GenerationMode })}><option value="text">Text to video</option><option value="image">Image to video</option><option value="frames">First + last frames</option><option value="reference">Reference to video</option></select></label></div>{needsContinuation && <small className="continuity-note">This route is locked to image-to-video because the previous scene supplies its first frame.</small>}</div>}</div>
        })}</div><button className="add-shot-button" onClick={() => addShot(scene.id)}><Plus size={14} />Add shot</button></div>}</article>
      })}</div>}</section>}
    {step === 'preview' && <MoviePreview clips={renderedClips} activeIndex={previewIndex} setActiveIndex={setPreviewIndex} />}
    </div><MovieCopilot project={project} input={chatInput} setInput={setChatInput} chatting={chatting} ollamaAvailable={ollamaAvailable} onSend={(question) => void sendMovieChat(question)} onNavigate={setStep} /></div>

    {characterDraft && <AssetModal title={project.characters.some((item) => item.id === characterDraft.id) ? 'Edit character' : 'Create character'} subtitle="Build a repeatable cast member for this movie." onClose={() => setCharacterDraft(null)} onSave={saveCharacter} saveDisabled={!characterDraft.name.trim()}><div className="asset-assistant-callout"><span><Sparkles size={15} /><span><strong>Ollama character assistant</strong><small>Uses your story and visual direction. Nothing leaves your computer.</small></span></span>{assistantButton('character', 'Create with Ollama', () => void assistCharacter())}</div><div className="asset-modal-form"><label>Character name<input autoFocus value={characterDraft.name} onChange={(event) => setCharacterDraft({ ...characterDraft, name: event.target.value })} placeholder="Name or production label" /></label><label>Repeatable appearance<textarea value={characterDraft.description} onChange={(event) => setCharacterDraft({ ...characterDraft, description: event.target.value })} placeholder="Age range, face, hair, build, distinctive features…" /></label><label>Wardrobe and props<textarea value={characterDraft.wardrobe} onChange={(event) => setCharacterDraft({ ...characterDraft, wardrobe: event.target.value })} placeholder="Default clothing, colors, wear, recurring objects…" /></label><label>Voice and performance<textarea value={characterDraft.voiceNotes} onChange={(event) => setCharacterDraft({ ...characterDraft, voiceNotes: event.target.value })} placeholder="Tone, accent, cadence, emotional baseline…" /></label></div><ReferencePicker files={characterDraft.referenceImages} onAdd={() => void addDraftReference('character')} onRemove={(index) => setCharacterDraft({ ...characterDraft, referenceImages: characterDraft.referenceImages.filter((_, itemIndex) => itemIndex !== index) })} /></AssetModal>}
    {locationDraft && <AssetModal title={project.locations.some((item) => item.id === locationDraft.id) ? 'Edit location' : 'Create location'} subtitle="Define a reusable set for this movie." onClose={() => setLocationDraft(null)} onSave={saveLocation} saveDisabled={!locationDraft.name.trim()}><div className="asset-assistant-callout"><span><Sparkles size={15} /><span><strong>Ollama location assistant</strong><small>Turns a rough idea into repeatable production details.</small></span></span>{assistantButton('location', 'Create with Ollama', () => void assistLocation())}</div><div className="asset-modal-form"><label>Location name<input autoFocus value={locationDraft.name} onChange={(event) => setLocationDraft({ ...locationDraft, name: event.target.value })} placeholder="Set or place name" /></label><label>Set, lighting, and atmosphere<textarea value={locationDraft.description} onChange={(event) => setLocationDraft({ ...locationDraft, description: event.target.value })} placeholder="Architecture, layout, materials, landmarks, light sources, time of day…" /></label></div><ReferencePicker files={locationDraft.referenceImages} onAdd={() => void addDraftReference('location')} onRemove={(index) => setLocationDraft({ ...locationDraft, referenceImages: locationDraft.referenceImages.filter((_, itemIndex) => itemIndex !== index) })} /></AssetModal>}
  </div>
}

type RenderedMovieClip = { scene: MovieScene; sceneIndex: number; shot: MovieShot; shotIndex: number }
type MovieChatResult = {
  reply?: unknown; changes?: unknown[]
  focusAreas?: unknown[]
  projectPatch?: Partial<Pick<MovieProject, 'title' | 'targetRuntime' | 'computeBudgetMinutes' | 'aspectRatio' | 'genre' | 'visualStyle' | 'quality' | 'reviewGate' | 'story' | 'visualRules'>>
  characterUpserts?: Array<Partial<Pick<MovieCharacter, 'id' | 'name' | 'description' | 'wardrobe' | 'voiceNotes'>>>
  characterDeletes?: unknown[]
  locationUpserts?: Array<Partial<Pick<MovieLocation, 'id' | 'name' | 'description'>>>
  locationDeletes?: unknown[]
  sceneUpserts?: Array<Partial<Pick<MovieScene, 'id' | 'title' | 'summary' | 'locationId' | 'transition'>>>
  sceneDeletes?: unknown[]
  shotUpserts?: Array<Partial<Pick<MovieShot, 'id' | 'title' | 'prompt' | 'dialogue' | 'duration' | 'mode' | 'characterIds'>> & { sceneId?: unknown }>
  shotDeletes?: unknown[]
}

function MovieCopilot({ project, input, setInput, chatting, ollamaAvailable, onSend, onNavigate }: { project: MovieProject; input: string; setInput(value: string): void; chatting: boolean; ollamaAvailable: boolean; onSend(question?: string): void; onNavigate(area: PlannerStep): void }) {
  const starters = ['Build a complete story treatment from my current idea.', 'Create the recurring characters and locations this movie needs.', 'Turn the story into connected scenes and production-ready MiniMax shots.']
  return <aside className="movie-copilot" aria-label="Movie copilot"><header><span><MessageSquare size={16} /><span><strong>Movie copilot</strong><small>Whole-project builder · local Ollama</small></span></span><i className={ollamaAvailable ? 'online' : ''}>{ollamaAvailable ? 'Ready' : 'Offline'}</i></header><div className="movie-chat-log" aria-live="polite">{project.chatMessages.length === 0 ? <div className="movie-chat-empty"><Sparkles size={22} /><strong>Build the movie from here</strong><span>Chat can create and revise your brief, production bible, cast, locations, scenes, dialogue, and shot prompts.</span><div>{starters.map((starter) => <button key={starter} disabled={!ollamaAvailable || chatting} onClick={() => onSend(starter)}>{starter}</button>)}</div></div> : project.chatMessages.map((message) => <article className={`movie-chat-message ${message.role}`} key={message.id}><span>{message.role === 'user' ? 'You' : 'Copilot'}</span><SmartMarkup value={message.content} />{message.areas && message.areas.length > 0 && <nav className="chat-area-links" aria-label="Review updated movie areas">{message.areas.map((area) => <button key={area} onClick={() => onNavigate(area)}>{areaLabel(area)}<ChevronRight size={12} /></button>)}</nav>}{message.appliedChanges && message.appliedChanges.length > 0 && <details open><summary>{message.appliedChanges.length} change{message.appliedChanges.length === 1 ? '' : 's'} applied</summary><ul>{message.appliedChanges.map((change, index) => <li key={`${change}-${index}`}>{change}</li>)}</ul></details>}</article>)}</div><form onSubmit={(event) => { event.preventDefault(); onSend() }}><label htmlFor="movie-chat-input">Build or revise this movie</label><textarea id="movie-chat-input" value={input} onChange={(event) => setInput(event.target.value)} disabled={chatting} placeholder="Create two characters, three connected scenes, and detailed MiniMax prompts…" onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSend() } }} /><div><small>Enter to send · Shift+Enter for a new line</small><button className="primary-button" disabled={!input.trim() || chatting || !ollamaAvailable} type="submit">{chatting ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}{chatting ? 'Building…' : 'Send'}</button></div></form></aside>
}

function MoviePreview({ clips, activeIndex, setActiveIndex }: { clips: RenderedMovieClip[]; activeIndex: number; setActiveIndex(value: number): void }) {
  const active = clips[activeIndex]
  if (!active) return <section className="movie-stage movie-preview"><div className="movie-stage-heading"><div><Film size={18} /><span><strong>Movie preview</strong><small>Finished movie-linked clips appear here automatically in story order.</small></span></div></div><div className="movie-preview-empty"><Film size={30} /><strong>No finished movie clips yet</strong><span>Render a shot opened from this movie project. Its completed clip will be placed on this timeline without joining the source files.</span></div></section>
  return <section className="movie-stage movie-preview"><div className="movie-stage-heading"><div><Film size={18} /><span><strong>Movie preview</strong><small>{clips.length} finished clip{clips.length === 1 ? '' : 's'} · story order</small></span></div></div><div className="movie-preview-stage"><video key={active.shot.id} src={active.shot.outputUrl} controls autoPlay={activeIndex > 0} onEnded={() => { if (activeIndex < clips.length - 1) setActiveIndex(activeIndex + 1) }} /><div><strong>{active.scene.title} · {active.shot.title}</strong><span>Scene {active.sceneIndex + 1}, shot {active.shotIndex + 1} · {active.shot.duration}s · {routeName(active.shot.mode)}</span></div><nav aria-label="Movie preview controls"><button className="secondary-button" disabled={activeIndex === 0} onClick={() => setActiveIndex(Math.max(0, activeIndex - 1))}><SkipBack size={14} />Previous</button><span>{activeIndex + 1} / {clips.length}</span><button className="secondary-button" disabled={activeIndex === clips.length - 1} onClick={() => setActiveIndex(Math.min(clips.length - 1, activeIndex + 1))}>Next<SkipForward size={14} /></button></nav></div><div className="movie-clip-timeline" role="list" aria-label="Finished movie clips">{clips.map((clip, index) => <button role="listitem" className={index === activeIndex ? 'active' : ''} key={clip.shot.id} onClick={() => setActiveIndex(index)}><span>{clip.sceneIndex + 1}.{clip.shotIndex + 1}</span><strong>{clip.shot.title}</strong><small>{clip.scene.title} · {clip.shot.duration}s</small></button>)}</div></section>
}

function normalizeProjectPatch(raw: MovieChatResult['projectPatch'], current: MovieProject): Partial<MovieProject> {
  if (!raw) return {}
  return {
    title: typeof raw.title === 'string' ? raw.title : current.title,
    targetRuntime: clamp(Number(raw.targetRuntime), 10, 3600), computeBudgetMinutes: clamp(Number(raw.computeBudgetMinutes), 10, 100000),
    aspectRatio: ['16:9', '9:16', '1:1'].includes(raw.aspectRatio ?? '') ? raw.aspectRatio : current.aspectRatio,
    genre: typeof raw.genre === 'string' ? raw.genre : current.genre, visualStyle: typeof raw.visualStyle === 'string' ? raw.visualStyle : current.visualStyle,
    quality: ['preview', 'balanced', 'maximum'].includes(raw.quality ?? '') ? raw.quality : current.quality,
    reviewGate: ['shot', 'scene', 'batch'].includes(raw.reviewGate ?? '') ? raw.reviewGate : current.reviewGate,
    story: typeof raw.story === 'string' ? raw.story : current.story, visualRules: typeof raw.visualRules === 'string' ? raw.visualRules : current.visualRules,
  }
}
function normalizeChatAreas(raw: unknown[] | undefined, result?: MovieChatResult): MovieChatArea[] {
  const allowed: MovieChatArea[] = ['setup', 'bible', 'shots', 'preview']
  const areas = (raw ?? []).filter((area): area is MovieChatArea => allowed.includes(area as MovieChatArea))
  if (result?.characterUpserts?.length || result?.characterDeletes?.length || result?.locationUpserts?.length || result?.locationDeletes?.length) areas.push('bible')
  if (result?.sceneUpserts?.length || result?.sceneDeletes?.length || result?.shotUpserts?.length || result?.shotDeletes?.length) areas.push('shots')
  return [...new Set(areas)]
}

function hasMovieChatOperations(raw: MovieChatResult) {
  return [raw.characterUpserts, raw.characterDeletes, raw.locationUpserts, raw.locationDeletes, raw.sceneUpserts, raw.sceneDeletes, raw.shotUpserts, raw.shotDeletes].some((items) => Array.isArray(items) && items.length > 0)
}

function applyMovieChatOperations(current: MovieProject, raw: MovieChatResult): MovieProject {
  let next: MovieProject = { ...current, ...normalizeProjectPatch(raw.projectPatch, current) }
  if (!hasMovieChatOperations(raw)) return next

  const characterDeletes = new Set((raw.characterDeletes ?? []).map(text).filter(Boolean))
  const locationDeletes = new Set((raw.locationDeletes ?? []).map(text).filter(Boolean))
  const sceneDeletes = new Set((raw.sceneDeletes ?? []).map(text).filter(Boolean))
  const shotDeletes = new Set((raw.shotDeletes ?? []).map(text).filter(Boolean))
  const characterAliases = new Map<string, string>()
  const locationAliases = new Map<string, string>()
  const sceneAliases = new Map<string, string>()

  let characters = current.characters.filter((item) => !characterDeletes.has(item.id))
  for (const rawCharacter of raw.characterUpserts ?? []) {
    const suppliedId = text(rawCharacter.id)
    const existing = characters.find((character) => character.id === suppliedId)
    const id = existing?.id ?? crypto.randomUUID()
    if (suppliedId) characterAliases.set(suppliedId, id)
    const name = text(rawCharacter.name) || existing?.name || ''
    if (!name) continue
    const character: MovieCharacter = { id, name, description: text(rawCharacter.description) || existing?.description || '', wardrobe: text(rawCharacter.wardrobe) || existing?.wardrobe || '', voiceNotes: text(rawCharacter.voiceNotes) || existing?.voiceNotes || '', referenceImages: existing?.referenceImages ?? [] }
    characters = existing ? characters.map((item) => item.id === id ? character : item) : [...characters, character]
  }

  let locations = current.locations.filter((item) => !locationDeletes.has(item.id))
  for (const rawLocation of raw.locationUpserts ?? []) {
    const suppliedId = text(rawLocation.id)
    const existing = locations.find((location) => location.id === suppliedId)
    const id = existing?.id ?? crypto.randomUUID()
    if (suppliedId) locationAliases.set(suppliedId, id)
    const name = text(rawLocation.name) || existing?.name || ''
    if (!name) continue
    const location: MovieLocation = { id, name, description: text(rawLocation.description) || existing?.description || '', referenceImages: existing?.referenceImages ?? [] }
    locations = existing ? locations.map((item) => item.id === id ? location : item) : [...locations, location]
  }

  let scenes = current.scenes.filter((scene) => !sceneDeletes.has(scene.id)).map((scene) => ({ ...scene, locationId: locationDeletes.has(scene.locationId) ? '' : scene.locationId, shots: scene.shots.filter((shot) => !shotDeletes.has(shot.id)).map((shot) => ({ ...shot, characterIds: shot.characterIds.filter((id) => !characterDeletes.has(id)) })) }))
  for (const rawScene of raw.sceneUpserts ?? []) {
    const suppliedId = text(rawScene.id)
    const existing = scenes.find((scene) => scene.id === suppliedId)
    const id = existing?.id ?? crypto.randomUUID()
    if (suppliedId) sceneAliases.set(suppliedId, id)
    const title = text(rawScene.title) || existing?.title || ''
    if (!title) continue
    const requestedLocation = locationAliases.get(text(rawScene.locationId)) ?? text(rawScene.locationId)
    const locationId = locations.some((location) => location.id === requestedLocation) ? requestedLocation : existing?.locationId ?? ''
    const transition = rawScene.transition === 'cut' || rawScene.transition === 'connected' ? rawScene.transition : existing?.transition ?? (scenes.length ? 'connected' : 'cut')
    const scene: MovieScene = { id, title, summary: text(rawScene.summary) || existing?.summary || '', locationId, transition, shots: existing?.shots ?? [] }
    scenes = existing ? scenes.map((item) => item.id === id ? scene : item) : [...scenes, scene]
  }

  const modes: GenerationMode[] = ['text', 'image', 'frames', 'reference']
  for (const rawShot of raw.shotUpserts ?? []) {
    const suppliedId = text(rawShot.id)
    const existingScene = scenes.find((scene) => scene.shots.some((shot) => shot.id === suppliedId))
    const existing = existingScene?.shots.find((shot) => shot.id === suppliedId)
    const requestedSceneId = sceneAliases.get(text(rawShot.sceneId)) ?? text(rawShot.sceneId)
    const targetSceneId = scenes.some((scene) => scene.id === requestedSceneId) ? requestedSceneId : existingScene?.id
    if (!targetSceneId) continue
    const id = existing?.id ?? crypto.randomUUID()
    const title = text(rawShot.title) || existing?.title || ''
    if (!title) continue
    const rawCharacterIds = Array.isArray(rawShot.characterIds) ? rawShot.characterIds.map(text) : existing?.characterIds ?? []
    const characterIds = [...new Set(rawCharacterIds.map((characterId) => characterAliases.get(characterId) ?? characterId).filter((characterId) => characters.some((character) => character.id === characterId)))]
    const shot: MovieShot = { ...existing, id, title, prompt: text(rawShot.prompt) || existing?.prompt || '', dialogue: text(rawShot.dialogue) || existing?.dialogue || '', duration: rawShot.duration === undefined ? existing?.duration ?? 5 : clamp(Number(rawShot.duration), 2, 15), mode: modes.includes(rawShot.mode as GenerationMode) ? rawShot.mode as GenerationMode : existing?.mode ?? 'text', characterIds, stage: existing?.stage ?? 'planned' }
    if (existing && existingScene?.id === targetSceneId) scenes = scenes.map((scene) => scene.id === targetSceneId ? { ...scene, shots: scene.shots.map((item) => item.id === id ? shot : item) } : scene)
    else {
      scenes = scenes.map((scene) => ({ ...scene, shots: scene.shots.filter((item) => item.id !== id) }))
      scenes = scenes.map((scene) => scene.id === targetSceneId ? { ...scene, shots: [...scene.shots, shot] } : scene)
    }
  }

  scenes = scenes.map((scene, index) => ({ ...scene, transition: index === 0 ? 'cut' : scene.transition, locationId: locations.some((location) => location.id === scene.locationId) ? scene.locationId : '', shots: scene.shots.map((shot) => ({ ...shot, characterIds: shot.characterIds.filter((id) => characters.some((character) => character.id === id)) })) }))
  next = { ...next, characters, locations, scenes }
  return next
}

function SmartMarkup({ value }: { value: string }) {
  return <div className="chat-markup">{value.split(/\r?\n/).map((line, index) => {
    const heading = line.match(/^#{1,3}\s+(.+)/)
    const bullet = line.match(/^[-*]\s+(.+)/)
    if (!line.trim()) return <span className="chat-markup-space" key={index} />
    if (heading) return <strong className="chat-markup-heading" key={index}>{inlineMarkup(heading[1])}</strong>
    if (bullet) return <span className="chat-markup-bullet" key={index}><i>•</i><span>{inlineMarkup(bullet[1])}</span></span>
    return <p key={index}>{inlineMarkup(line)}</p>
  })}</div>
}

function inlineMarkup(value: string) {
  return value.split(/(\*\*.*?\*\*|`.*?`)/g).filter(Boolean).map((part, index) => part.startsWith('**') && part.endsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong> : part.startsWith('`') && part.endsWith('`') ? <code key={index}>{part.slice(1, -1)}</code> : part)
}

function areaLabel(area: MovieChatArea) { return area === 'setup' ? 'Review story' : area === 'bible' ? 'Review bible' : area === 'shots' ? 'Review shots' : 'Open preview' }

function AssetCollection({ title, subtitle, empty, onAdd, children }: { title: string; subtitle: string; empty: string; onAdd(): void; children: React.ReactNode }) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children)
  return <section className="bible-column"><div className="bible-column-heading"><div><strong>{title}</strong><small>{subtitle}</small></div><button onClick={onAdd}><Plus size={14} />Create</button></div>{hasChildren ? <div className="asset-card-grid">{children}</div> : <div className="bible-empty">{empty}</div>}</section>
}
function AssetCard({ icon, name, description, references, onEdit, onRemove }: { icon: 'character' | 'location'; name: string; description: string; references: MediaFile[]; onEdit(): void; onRemove(): void }) {
  return <article className="movie-asset-card"><button className="asset-card-main" onClick={onEdit}>{references[0]?.preview ? <img src={references[0].preview} alt="" /> : <span className="asset-placeholder">{icon === 'character' ? <Users size={20} /> : <MapPin size={20} />}</span>}<span className="asset-card-copy"><strong>{name}</strong><span>{description || `Add ${icon === 'character' ? 'appearance and performance' : 'set and atmosphere'} details`}</span><small>{references.length} reference image{references.length === 1 ? '' : 's'}</small></span></button><div className="asset-card-actions"><button onClick={onEdit}><Pencil size={13} />Edit</button><button aria-label={`Remove ${name}`} onClick={onRemove}><Trash2 size={13} /></button></div></article>
}
function AssetModal({ title, subtitle, onClose, onSave, saveDisabled, children }: { title: string; subtitle: string; onClose(): void; onSave(): void; saveDisabled: boolean; children: React.ReactNode }) {
  return <div className="modal-backdrop movie-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="movie-asset-modal" role="dialog" aria-modal="true" aria-labelledby="asset-modal-title"><header><div><span>MOVIE ASSET</span><strong id="asset-modal-title">{title}</strong><small>{subtitle}</small></div><button aria-label="Close dialog" onClick={onClose}><X size={17} /></button></header><div className="movie-modal-body">{children}</div><footer><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={saveDisabled} onClick={onSave}>Save to movie</button></footer></section></div>
}
function ReferencePicker({ files, onAdd, onRemove }: { files: MediaFile[]; onAdd(): void; onRemove(index: number): void }) {
  return <section className="asset-references"><div><span><strong>Reference images</strong><small>Use clear, consistent views. Files stay in their current locations.</small></span><button className="secondary-button" onClick={onAdd}><ImagePlus size={14} />Add image</button></div>{files.length ? <div className="reference-thumb-grid">{files.map((file, index) => <figure key={`${file.path}-${index}`}><img src={file.preview} alt={file.name} /><figcaption title={file.name}>{file.name}</figcaption><button aria-label={`Remove ${file.name}`} onClick={() => onRemove(index)}><X size={13} /></button></figure>)}</div> : <div className="reference-empty"><ImagePlus size={19} /><span>No references added. You can still save and add them later.</span></div>}</section>
}

function blankCharacter(): MovieCharacter { return { id: crypto.randomUUID(), name: '', description: '', wardrobe: '', voiceNotes: '', referenceImages: [] } }
function blankLocation(): MovieLocation { return { id: crypto.randomUUID(), name: '', description: '', referenceImages: [] } }
function makeShot(index: number): MovieShot { return { id: crypto.randomUUID(), title: `Shot ${index}`, duration: 5, prompt: '', dialogue: '', mode: 'text', characterIds: [], stage: 'planned' } }
function normalizePlan(raw: unknown, project: MovieProject): MovieScene[] {
  const value = raw as { scenes?: Array<{ title?: unknown; summary?: unknown; location?: unknown; shots?: Array<{ title?: unknown; duration?: unknown; prompt?: unknown; dialogue?: unknown; mode?: unknown; characters?: unknown }> }> }
  if (!Array.isArray(value?.scenes)) return []
  const modes: GenerationMode[] = ['text', 'image', 'frames', 'reference']
  return value.scenes.slice(0, 24).map((scene, sceneIndex) => {
    const locationName = text(scene.location)
    const locationId = project.locations.find((item) => item.name.toLowerCase() === locationName.toLowerCase())?.id ?? ''
    const shots = Array.isArray(scene.shots) ? scene.shots.slice(0, 16).map((shot, shotIndex) => {
      const names = Array.isArray(shot.characters) ? shot.characters.map(text) : []
      return { id: crypto.randomUUID(), title: text(shot.title) || `Shot ${shotIndex + 1}`, duration: clamp(Number(shot.duration) || 5, 2, 15), prompt: text(shot.prompt), dialogue: text(shot.dialogue), mode: modes.includes(shot.mode as GenerationMode) ? shot.mode as GenerationMode : 'text', characterIds: project.characters.filter((character) => names.some((name) => name.toLowerCase() === character.name.toLowerCase())).map((character) => character.id), stage: 'planned' as const }
    }).filter((shot) => shot.prompt) : []
    return { id: crypto.randomUUID(), title: text(scene.title) || `Scene ${sceneIndex + 1}`, summary: text(scene.summary), locationId, transition: sceneIndex === 0 ? 'cut' as const : 'connected' as const, shots }
  }).filter((scene) => scene.shots.length)
}
function routeName(mode: GenerationMode) { return ({ text: 'T2V', image: 'I2V', frames: 'First + last', reference: 'Ref2V' } as const)[mode] }
function uniqueMedia(files: MediaFile[]) { return files.filter((file, index) => files.findIndex((item) => item.path === file.path) === index) }
function text(value: unknown) { return typeof value === 'string' ? value.trim() : '' }
function clamp(value: number, minimum: number, maximum: number) { return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum)) }
function formatDuration(seconds: number) { const value = Math.max(0, Math.round(seconds)); return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}` }
