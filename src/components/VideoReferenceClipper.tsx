import { useEffect, useRef, useState } from 'react'
import { CirclePlay, LoaderCircle, Scissors, X } from 'lucide-react'
import type { MediaFile } from '../types'

type Props = {
  source: MediaFile
  onClose(): void
  onCreate(start: number, end: number): Promise<void>
}

const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value))
const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}.${String(Math.round((seconds % 1) * 10))}`

export function VideoReferenceClipper({ source, onClose, onCreate }: Props) {
  const video = useRef<HTMLVideoElement>(null)
  const lastPlayheadUpdate = useRef(0)
  const [duration, setDuration] = useState(0)
  const [start, setStart] = useState(source.clip?.start ?? 0)
  const [end, setEnd] = useState(source.clip?.end ?? 15)
  const [playhead, setPlayhead] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const length = Math.max(0, end - start)
  const valid = duration > 0 && length >= 2 && length <= 15 && end <= duration + 0.01

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [busy, onClose])

  const seek = (position: number) => {
    const next = clamp(position, 0, duration || position)
    if (video.current) video.current.currentTime = next
    setPlayhead(next)
  }
  const setIn = () => {
    const next = clamp(playhead, 0, Math.max(0, end - 2))
    setStart(next)
  }
  const setOut = () => {
    const next = clamp(playhead, start + 2, Math.min(duration, start + 15))
    setEnd(next)
  }

  return <div className="video-clipper-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <section className="video-clipper" role="dialog" aria-modal="true" aria-labelledby="video-clipper-title">
      <header>
        <div><Scissors size={19} /><span><strong id="video-clipper-title">Create a video reference clip</strong><small>Choose the exact section MiniMax should study. Your original video stays unchanged.</small></span></div>
        <button className="icon-button" onClick={onClose} disabled={busy} aria-label="Close video clipper"><X size={18} /></button>
      </header>
      <div className="video-clipper-body">
        <div className="video-clipper-player">
          <video key={source.preview} ref={video} src={source.preview} controls playsInline preload="auto" onLoadedMetadata={(event) => {
            const total = event.currentTarget.duration
            setDuration(total)
            const initialStart = clamp(source.clip?.start ?? 0, 0, Math.max(0, total - 2))
            const initialEnd = clamp(source.clip?.end ?? Math.min(15, total), initialStart + Math.min(2, total), total)
            setStart(initialStart); setEnd(initialEnd); setPlayhead(initialStart); event.currentTarget.currentTime = initialStart
          }} onLoadedData={() => setError('')} onTimeUpdate={(event) => {
            const now = performance.now()
            if (event.currentTarget.paused || now - lastPlayheadUpdate.current >= 100) {
              lastPlayheadUpdate.current = now
              setPlayhead(event.currentTarget.currentTime)
            }
          }} onError={() => setError('This video cannot be previewed by Electron. Try converting it to MP4 (H.264/AAC) first.')} />
          <div className="video-source-name"><CirclePlay size={14} /><span title={source.name}>{source.name}</span><output>{duration ? time(duration) : 'Reading video…'}</output></div>
        </div>
        <div className="video-clipper-controls">
          <div className="clip-selection-heading"><span><strong>Selected reference</strong><small>Ref2V accepts a focused 2–15 second section.</small></span><output className={valid ? '' : 'invalid'}>{length.toFixed(1)} seconds</output></div>
          <label>Playhead<input type="range" min="0" max={duration || 15} step="0.04" value={playhead} disabled={!duration} onChange={(event) => seek(Number(event.target.value))} /><output>{time(playhead)}</output></label>
          <div className="clip-in-out">
            <label>Start<input type="number" min="0" max={Math.max(0, end - 2)} step="0.04" value={Number(start.toFixed(2))} onChange={(event) => { const next = clamp(Number(event.target.value), 0, Math.max(0, end - 2)); setStart(next); seek(next) }} /></label>
            <button className="secondary-button" disabled={!duration} onClick={setIn}>Set start to playhead</button>
            <label>End<input type="number" min={start + 2} max={Math.min(duration || 15, start + 15)} step="0.04" value={Number(end.toFixed(2))} onChange={(event) => { const next = clamp(Number(event.target.value), start + 2, Math.min(duration || start + 15, start + 15)); setEnd(next); seek(next) }} /></label>
            <button className="secondary-button" disabled={!duration} onClick={setOut}>Set end to playhead</button>
          </div>
          <div className="clip-range-track" aria-hidden="true"><span style={{ left: `${duration ? (start / duration) * 100 : 0}%`, right: `${duration ? 100 - (end / duration) * 100 : 0}%` }} /></div>
          {!valid && duration > 0 && <p className="clip-validation" role="status">Choose a section between 2 and 15 seconds.</p>}
          {error && <p className="clip-validation" role="alert">{error}</p>}
        </div>
      </div>
      <footer><span>The new MP4 is saved in your output folder and used only as a reference.</span><div><button className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button" disabled={!valid || busy} onClick={async () => { setBusy(true); setError(''); try { await onCreate(start, end) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setBusy(false) } }}>{busy ? <LoaderCircle className="spin" size={15} /> : <Scissors size={15} />}{busy ? 'Creating clip…' : 'Create reference clip'}</button></div></footer>
    </section>
  </div>
}
