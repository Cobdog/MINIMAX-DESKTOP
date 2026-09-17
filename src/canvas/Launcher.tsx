/**
 * Canvas Phase 2 — the launcher (§4: "the empty canvas is the launcher").
 *
 * Prompt bar + drop-anything zone + the L15-confirmed minimal chips (image
 * prompt / video prompt / noDialogue handoff / drop) + resume cards (the
 * multi-canvas session — camera restored on open). Submitting the first
 * prompt spawns the seed tile AT the prompt bar (spatial-queue contract c)
 * and submits the REAL H3 render through the shared flows core — the
 * launcher comes alive, no mode switch; a refused engine surfaces honestly.
 */
import { useEffect, useRef, useState } from 'react'
import { AudioLines, Clapperboard, FileVideo, ImagePlus, Layers, MessageSquareOff, Music2, Plus, Sparkles, Upload, Users } from 'lucide-react'
import { PromptLibraryBrowser } from '../components/PromptLibraryBrowser'
import { useCanvasStore } from './store'

export function Launcher({ onPickFile }: { onPickFile(): void }) {
  const projects = useCanvasStore((state) => state.projects)
  const activeProjectId = useCanvasStore((state) => state.activeProjectId)
  const activeDocument = useCanvasStore((state) => (state.activeProjectId ? state.documents[state.activeProjectId] : null))
  const openProject = useCanvasStore((state) => state.openProject)
  const createCanvas = useCanvasStore((state) => state.createCanvas)
  const submitPrompt = useCanvasStore((state) => state.submitPrompt)

  const [prompt, setPrompt] = useState('')
  const [mediaType, setMediaType] = useState<'video' | 'image'>('video')
  const [submitting, setSubmitting] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // The launcher owns the global `/` focus (§7): typing starts here.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === '/' && document.activeElement !== inputRef.current && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const target = event.target as HTMLElement | null
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
        event.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const submit = async () => {
    if (!prompt.trim() || submitting) return
    setSubmitting(true)
    try {
      await submitPrompt(prompt, mediaType)
      setPrompt('')
    } finally {
      setSubmitting(false)
    }
  }

  const resumeCards = projects.filter((project) => project.id !== activeProjectId).slice(0, 6)

  return <div className="canvas-launcher" data-canvas-launcher>
    <div className="canvas-launcher-inner">
      <h1>{activeDocument ? activeDocument.project.name : 'A blank canvas'}</h1>
      <p className="canvas-launcher-sub">
        {activeDocument && activeDocument.chains.length
          ? 'This canvas has objects — drop or prompt anywhere to add more.'
          : 'Describe a shot, or drop anything — the canvas is already the app.'}
      </p>

      <div className="canvas-promptbar" data-canvas-promptbar>
        <textarea
          ref={inputRef}
          value={prompt}
          data-canvas-prompt
          placeholder="Describe the shot…  (/ to focus · Enter to spawn)"
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submit()
            }
          }}
        />
        <button
          type="button"
          className="canvas-promptbar-submit"
          data-canvas-submit
          disabled={!prompt.trim() || submitting}
          onClick={() => void submit()}
        >
          {mediaType === 'image' ? <ImagePlus size={14} /> : <FileVideo size={14} />}
          {mediaType === 'image' ? 'Spawn image seed' : 'Spawn video seed'}
        </button>
      </div>

      <div className="canvas-launcher-chips" role="group" aria-label="Entry chips">
        <button type="button" className={`canvas-chip ${mediaType === 'image' ? 'active' : ''}`} data-canvas-chip="image" onClick={() => setMediaType('image')}>
          <ImagePlus size={13} /> image prompt
        </button>
        <button type="button" className={`canvas-chip ${mediaType === 'video' ? 'active' : ''}`} data-canvas-chip="video" onClick={() => setMediaType('video')}>
          <FileVideo size={13} /> video prompt
        </button>
        <button
          type="button"
          className="canvas-chip"
          data-canvas-chip="noDialogue"
          title="The chain's no-dialogue policy composes into the render prompt (silent score emission)"
          onClick={() => setPrompt((current) => current ? `${current} · no dialogue` : 'no dialogue')}
        >
          <MessageSquareOff size={13} /> noDialogue handoff
        </button>
        <button type="button" className="canvas-chip" data-canvas-chip="drop" onClick={onPickFile}>
          <Upload size={13} /> drop / pick media
        </button>
        {/* §5.4 (Phase 4): the audio engines arrive as typed-hole selections —
            Music 3 and ACE-Step dock as panels, their tracks land as objects. */}
        <button type="button" className="canvas-chip" data-canvas-chip="music3" title="MiniMax Music 3 — complete songs as audio objects" onClick={() => useCanvasStore.getState().setAudioDock({ engine: 'music3' })}>
          <AudioLines size={13} /> Music 3
        </button>
        <button type="button" className="canvas-chip" data-canvas-chip="acestep" title="ACE-Step XL 1.5 — music tracks as audio objects" onClick={() => useCanvasStore.getState().setAudioDock({ engine: 'acestep' })}>
          <Music2 size={13} /> ACE-Step
        </button>
        {/* §5.5 (L11): launcher-adjacent prompt library — the browser opens
            beside the bar; a pick fills it. */}
        <button type="button" className="canvas-chip" data-canvas-chip="prompt-library" title="Search public Civitai generation metadata for reusable prompts" onClick={() => setLibraryOpen(true)}>
          <Sparkles size={13} /> prompt library
        </button>
        {/* Phase 5: the kept authoring surfaces dock from the launcher too
            (dated decisions in StudiosDock.tsx). The movie-plan chip re-pointed
            2026-09-17 (Phase 5b): MoviePlanner retired — the planning surface
            is the timeline projection + plan documents (V). */}
        <button type="button" className="canvas-chip" data-canvas-chip="studios" title="Asset authoring studios — characters, hair, wardrobe, accessories, locations" onClick={() => useCanvasStore.getState().setStudiosDock({ tab: 'characters' })}>
          <Users size={13} /> studios
        </button>
        {/* Dataset manager workbench (sv14rt0): its own surface at
            ?datasets=1 — import/crop/caption/curate/export training sets.
            The bridge is two explicit actions (canvas take → source here;
            dataset layer → canvas reference there). */}
        <a className="canvas-chip" data-canvas-chip="datasets" href="?datasets=1" title="Dataset manager — training-set prep workbench">
          <Layers size={13} /> datasets
        </a>
        <button type="button" className="canvas-chip" data-canvas-chip="movie" title="The timeline projection — the plan chronology + measured transitions (the Director Suite)" onClick={() => useCanvasStore.getState().setTimelineOpen(true)}>
          <Clapperboard size={13} /> movie plan
        </button>
      </div>

      <div className="canvas-launcher-resume" aria-label="Resume a canvas">
        <header>
          <strong>Resume</strong>
          <button type="button" className="canvas-chip" data-canvas-new onClick={() => void createCanvas()}>
            <Plus size={13} /> new canvas
          </button>
        </header>
        {resumeCards.length ? (
          <ul>
            {resumeCards.map((project) => (
              <li key={project.id}>
                <button type="button" className="canvas-resume-card" data-canvas-resume={project.id} onClick={() => void openProject(project.id)}>
                  <Clapperboard size={15} />
                  <span className="canvas-resume-name">{project.name}</span>
                  <span className="canvas-resume-date">{new Date(project.lastActiveAt).toLocaleString()}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="canvas-launcher-norecent">No other canvases yet — the first prompt creates one.</p>
        )}
      </div>
      {libraryOpen && <PromptLibraryBrowser onClose={() => setLibraryOpen(false)} onInsert={(entry) => { setPrompt(entry); window.setTimeout(() => inputRef.current?.focus(), 0) }} />}
    </div>
  </div>
}
