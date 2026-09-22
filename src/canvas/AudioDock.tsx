/**
 * Canvas Phase 4 — the audio engine dock (§5.4 engines-as-ops: Music 3
 * arrives as a typed-hole selection; no per-engine destination views).
 *
 * A react-rnd floating panel (the pose-rig-dock pattern) opened from the
 * produce menu. It creates an audio CHAIN in the document store carrying
 * the engine + its request options (rerun-stable settings), then
 * submitChain executes through the shared core (lib/music3Submit.ts). The
 * finished track lands as a take on its chain, searchable in the library
 * projection like every output. (The ACE-Step dock arm was removed with
 * the engine, 2026-09-21 — nn5ld47.)
 */
import { useState } from 'react'
import { Rnd } from 'react-rnd'
import { AudioLines, Play, X } from 'lucide-react'
import { useCanvasStore } from './store'

export function AudioDock() {
  const dock = useCanvasStore((state) => state.audioDock)
  const setAudioDock = useCanvasStore((state) => state.setAudioDock)
  const createAudioChain = useCanvasStore((state) => state.createAudioChain)
  const setChainSettings = useCanvasStore((state) => state.setChainSettings)
  const submitChain = useCanvasStore((state) => state.submitChain)
  const validateChain = useCanvasStore((state) => state.validateChain)
  const validateAudioDraft = useCanvasStore((state) => state.validateAudioDraft)
  const selection = useCanvasStore((state) => state.selection)
  const documents = useCanvasStore((state) => state.documents)
  const activeProjectId = useCanvasStore((state) => state.activeProjectId)

  const [caption, setCaption] = useState('')
  const [lyrics, setLyrics] = useState('')
  const [duration, setDuration] = useState(60)
  const [submitting, setSubmitting] = useState(false)

  if (!dock) return null
  const engine = dock.engine
  // The dock adopts the SELECTED chain only when it is already an audio
  // chain (never silently convert a video/image chain); otherwise the submit
  // creates a fresh chain — the typed-hole selection.
  const selectedChainId = selection.tileIds.length === 1 ? selection.tileIds[0] : null
  const selectedIsAudio = (() => {
    if (!selectedChainId || !activeProjectId) return false
    const chain = documents[activeProjectId]?.chains.find((entry) => entry.id === selectedChainId)
    return chain?.settings?.mediaType === 'audio'
  })()
  const targetChainId = dock.chainId ?? (selectedIsAudio ? selectedChainId : null)
  // A selected audio chain validates through its persisted settings; a fresh
  // draft through the same ladders submitChain will run (honest inline).
  const validation = targetChainId ? validateChain(targetChainId) : validateAudioDraft(engine, caption)

  const submit = async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      let chainId = targetChainId
      if (!chainId) {
        chainId = await createAudioChain(engine, caption.trim())
        if (!chainId) return
      }
      await setChainSettings(chainId, {
        prompt: caption.trim(),
        mediaType: 'audio',
        audio: { engine, caption: caption.trim(), lyrics, duration, seed: Math.floor(Math.random() * 1_000_000_000) },
      })
      const result = await submitChain(chainId)
      if (result.ok) setAudioDock(null)
    } finally {
      setSubmitting(false)
    }
  }

  return <Rnd
    className="canvas-audio-dock"
    data-canvas-audio-dock
    data-canvas-audio-engine={engine}
    default={{ x: 96, y: 120, width: 400, height: 560 }}
    minWidth={320}
    minHeight={300}
    bounds="parent"
    dragHandleClassName="canvas-inspector-header"
    enableResizing={{ bottom: true, bottomRight: true, right: true, bottomLeft: false, topLeft: false, topRight: false, left: false, top: false }}
  >
    <header className="canvas-inspector-header">
      <AudioLines size={13} />
      <strong>Music 3 — complete song</strong>
      <button type="button" aria-label="Close audio dock" data-canvas-audio-close onClick={() => setAudioDock(null)}><X size={13} /></button>
    </header>
    <div className="canvas-inspector-body">
      <section className="canvas-properties-section">
        <label>Caption sections</label>
        <textarea
          data-canvas-audio-caption
          rows={2}
          value={caption}
          placeholder="genre, mood, instrumentation, structure…"
          onChange={(event) => setCaption(event.target.value)}
        />
      </section>
      <section className="canvas-properties-section">
        <label>Lyrics</label>
        <textarea
          data-canvas-audio-lyrics
          rows={2}
          value={lyrics}
          placeholder="lyric sections (optional)…"
          onChange={(event) => setLyrics(event.target.value)}
        />
      </section>
      <section className="canvas-properties-section">
        <div className="canvas-properties-row">
          <label htmlFor="canvas-audio-duration">seconds</label>
          <input id="canvas-audio-duration" data-canvas-audio-duration type="number" min={10} max={300} step={5} value={duration} onChange={(event) => setDuration(Math.max(10, Math.min(300, Number(event.target.value) || 60)))} />
        </div>
      </section>
      {validation && <p className="canvas-properties-warning" data-canvas-audio-validation role="alert">{validation}</p>}
      <p className="canvas-properties-note">
        The track lands as its own object — a take you can fork, reference, and find in the library (V).
      </p>
    </div>
    <footer className="canvas-properties-submit">
      <button type="button" className="canvas-properties-generate" data-canvas-audio-submit onClick={() => void submit()} disabled={submitting || Boolean(validation)}>
        <Play size={12} /> generate song
      </button>
    </footer>
  </Rnd>
}
