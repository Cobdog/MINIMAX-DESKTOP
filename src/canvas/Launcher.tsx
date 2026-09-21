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
import { Clapperboard, FileVideo, ImagePlus, MessageSquareOff, Plus, Upload } from 'lucide-react'
import { FirstRunNotice } from './FirstRunNotice'
import { FirstRunWizard } from './FirstRunWizard'
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
      {/* (R-16, Wave 3) The first-run wizard owns the fresh-home journey
          (four thin steps, skippable/resumable); the notice below stays as
          the fallback surface for every path that skips or outruns it. */}
      <FirstRunWizard />
      {/* QOL wave (rrxlw2r): model-roots-empty onboarding — the app is never
          silently dead on a fresh install; dismissible once per browser. */}
      <FirstRunNotice />
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

      {/* (R-20, Wave 3 — audit M6/m5) The launcher is the ONE prompt
          surface: the media-type toggle (each chip states its EFFECT, R-23),
          the no-dialogue policy chip (user language — the developer-speak
          "noDialogue handoff" is gone), and drop/pick. The audio engines
          moved to their one canonical home — the typed-hole produce menu;
          the prompt library lives on its titlebar button + V; the movie plan
          on its timeline button. The datasets chip precedent applies: one
          home per thing. */}
      <div className="canvas-launcher-chips" role="group" aria-label="Entry chips">
        <button type="button" className={`canvas-chip ${mediaType === 'image' ? 'active' : ''}`} data-canvas-chip="image" title="New seeds spawn as IMAGE chains — a still per take (the workbench's families)" onClick={() => setMediaType('image')}>
          <ImagePlus size={13} /> image prompt
        </button>
        <button type="button" className={`canvas-chip ${mediaType === 'video' ? 'active' : ''}`} data-canvas-chip="video" title="New seeds spawn as VIDEO chains — the derived mode follows what you later bind (R-23)" onClick={() => setMediaType('video')}>
          <FileVideo size={13} /> video prompt
        </button>
        <button
          type="button"
          className="canvas-chip"
          data-canvas-chip="noDialogue"
          title="Adds the no-dialogue policy to the prompt — the render scores the shot with no spoken lines"
          onClick={() => setPrompt((current) => current ? `${current} · no dialogue` : 'no dialogue')}
        >
          <MessageSquareOff size={13} /> no dialogue
        </button>
        <button type="button" className="canvas-chip" data-canvas-chip="drop" onClick={onPickFile}>
          <Upload size={13} /> drop / pick media
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
    </div>
  </div>
}
