/** The Queue view: every generation with live progress and cancellation.
 *  Thumbnails are static filmstrip posters (wave 2d) — no <video> mounts per
 *  row; the active preview stays text/progress as before. */
import { CircleStop, ExternalLink, FileJson, Film, History, LoaderCircle, Music2 } from 'lucide-react'
import { downloadJson, manifestFileName } from '../lib/manifest'
import type { GenerationJob } from '../types'
import { StatusBadge } from '../components/chrome'
import { FilmstripPoster } from '../components/PooledVideoCard'
import { outputPathFromMediaUrl } from '../media/httpPreview'
import { useFilmstrip } from '../media/useFilmstrip'
import { shortPrompt } from '../lib/format'

function JobVideoPoster({ outputUrl, duration, label }: { outputUrl: string; duration: number; label: string }) {
  const filmstrip = useFilmstrip(outputPathFromMediaUrl(outputUrl), duration)
  return <FilmstripPoster filmstrip={filmstrip} mode="frame" label={label}><Film size={18} /></FilmstripPoster>
}

export function JobsView({ title, note, jobs, empty, cancellingIds, onCancel }: { title: string; note: string; jobs: GenerationJob[]; empty: string; cancellingIds: Set<string>; onCancel(job: GenerationJob): Promise<void> }) {
  return <div className="standard-page"><div className="page-heading"><div><p className="eyebrow">LOCAL WORKSPACE</p><h1>{title}</h1><p>{note}</p></div></div>{jobs.length === 0 ? <div className="empty-page"><History size={28} /><strong>{empty}</strong><span>New work is saved automatically on this device.</span></div> : <div className="job-list">{jobs.map((job) => { const audio = job.mediaType === 'audio'; return <article className={`job-row ${['running', 'queued'].includes(job.status) ? 'constructing' : ''}`} key={job.id}><div className={`job-thumbnail ${audio ? 'audio' : ''}`}>{job.outputUrl ? audio ? <Music2 /> : <JobVideoPoster outputUrl={job.outputUrl} duration={job.duration} label={shortPrompt(job.prompt)} /> : job.status === 'running' ? <LoaderCircle className="spin" /> : audio ? <Music2 /> : <Film />}</div><div className="job-copy"><div><StatusBadge status={job.status} /><span>{new Date(job.createdAt).toLocaleString()}</span></div><strong>{shortPrompt(job.prompt)}</strong><small>{audio ? `ACE-Step · ${job.duration}s · audio` : `${job.width} × ${job.height} · ${job.duration}s · ${job.mode}`}</small>{job.outputUrl && audio && <audio className="job-audio" src={job.outputUrl} controls preload="metadata" />}{['running', 'queued'].includes(job.status) && <><small className="job-progress-label">{job.progressLabel ?? (job.status === 'queued' ? 'Waiting in queue' : audio ? 'Generating music locally' : 'Rendering locally')}{job.currentStep !== undefined && job.totalSteps ? ` · ${job.currentStep}/${job.totalSteps}` : ''}</small><div className="progress compact"><i style={{ width: `${job.progress}%` }} /></div></>}{job.error && <p className="job-error">{job.error}</p>}</div><div className="job-actions">{job.manifest && <button className="secondary-button" title="Download the reproducibility manifest: seed, models, sampler, graph version" onClick={() => downloadJson(manifestFileName(job), job.manifest)}><FileJson size={15} />Manifest</button>}{job.outputUrl && <a className="secondary-button" href={job.outputUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} />Open</a>}{['running', 'queued'].includes(job.status) && <button className="danger-button" disabled={cancellingIds.has(job.id)} onClick={() => void onCancel(job)}>{cancellingIds.has(job.id) ? <LoaderCircle size={15} className="spin" /> : <CircleStop size={15} />}{cancellingIds.has(job.id) ? 'Stopping…' : 'Stop'}</button>}</div></article> })}</div>}</div>
}
