/** Media playback and input widgets shared across views. */
import { useEffect, useState } from 'react'
import { AlertCircle, LoaderCircle, RefreshCw, Scissors, SkipForward, Upload, X } from 'lucide-react'
import type { GenerationJob, MediaFile } from '../types'

export function VideoPlayer({ src, onDuration }: { src: string; onDuration?(duration: number): void }) {
  const [failure, setFailure] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => setFailure(''), [src])

  if (failure) {
    return <div className="playback-error" role="alert"><AlertCircle size={25} /><strong>Video could not be decoded</strong><span>{failure}</span><button className="secondary-button" onClick={() => { setFailure(''); setAttempt((value) => value + 1) }}><RefreshCw size={15} />Retry playback</button></div>
  }

  return <video key={`${src}-${attempt}`} src={src} controls autoPlay loop playsInline preload="auto" onLoadedMetadata={(event) => onDuration?.(event.currentTarget.duration)} onCanPlay={(event) => void event.currentTarget.play().catch(() => undefined)} onError={(event) => { const mediaError = event.currentTarget.error; setFailure(mediaError?.message || `Electron media error ${mediaError?.code ?? 'unknown'}`) }} />
}

export function VideoContinuationControls({ job, duration, onContinue }: { job: GenerationJob; duration: number; onContinue(job: GenerationJob, position: number | 'last'): Promise<void> }) {
  const max = Math.max(.1, duration - .05)
  const [position, setPosition] = useState(Math.min(5, max))
  const [busy, setBusy] = useState<'last' | 'time' | null>(null)
  useEffect(() => setPosition(Math.min(5, max)), [job.id, max])
  const run = async (at: number | 'last') => { setBusy(at === 'last' ? 'last' : 'time'); try { await onContinue(job, at) } finally { setBusy(null) } }
  return <section className="video-continuation" aria-labelledby="video-continuation-title"><div><span><strong id="video-continuation-title">Extend this shot</strong><small>Extract one exact frame and use it as the next I2V starting image. This clip is not rendered again.</small></span><button className="primary-button" disabled={Boolean(busy)} onClick={() => void run('last')}>{busy === 'last' ? <LoaderCircle className="spin" size={14} /> : <SkipForward size={14} />}Continue from last frame</button></div><label><span><strong>Choose an earlier handoff</strong><small>Useful when the best transition occurs before the clip ends.</small></span><input type="range" min="0" max={max} step="0.1" value={Math.min(position, max)} onChange={(event) => setPosition(Number(event.target.value))} /><output>{position.toFixed(1)}s</output><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void run(position)}>{busy === 'time' ? <LoaderCircle className="spin" size={14} /> : <Scissors size={14} />}Use this frame</button></label></section>
}

export function MediaDrop({ label, note, file, onChoose, onRemove }: { label: string; note: string; file: MediaFile | null; onChoose(): void; onRemove(): void }) {
  return <div className={`media-drop ${file ? 'has-file' : ''}`}>{file?.preview ? <img src={file.preview} alt="" /> : null}<div className="media-drop-content"><span className="upload-icon"><Upload size={19} /></span><strong>{file?.name ?? label}</strong><small>{file ? 'Ready to use' : note}</small><button onClick={onChoose}>{file ? 'Replace' : 'Choose image'}</button></div>{file && <button className="remove-media" onClick={onRemove} aria-label={`Remove ${label}`}><X size={15} /></button>}</div>
}
