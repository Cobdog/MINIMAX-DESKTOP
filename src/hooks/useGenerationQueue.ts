/** The generation job queue: persistence, the ComfyUI history poll loop with
 *  terminal-state guards, the offline deadline sweep, and cancellation. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings, GenerationJob } from '../types'
import { isPastRunningDeadline, isTerminalStatus, reduceJobPoll, type PollObservation, type PollReduction } from '../lib/jobReducer'
import { extractOutputFile, extractOutputUrl, withTiledVideoDecode } from '../lib/workflow'
import { extractAutomatedReferenceSet, initialJobs, playableOutputUrl, recordCharacterTurntable, recordLocationWalkthrough, recordMovieOutput } from '../lib/jobRecords'
import type { LiveProgress } from '../lib/useLivePreview'

export type NoticeTone = 'error' | 'success' | 'neutral'

export function useGenerationQueue(options: {
  settings: AppSettings | null
  connected: boolean
  notify(tone: NoticeTone, text: string): void
}) {
  const { settings, connected, notify } = options
  const [jobs, setJobs] = useState<GenerationJob[]>(initialJobs)
  const [cancellingIds, setCancellingIds] = useState<Set<string>>(() => new Set())
  const cancellationRequests = useRef(new Set<string>())
  const jobsRef = useRef(jobs)
  jobsRef.current = jobs
  const pendingKey = jobs.filter((job) => job.status === 'queued' || job.status === 'running').map((job) => job.id).join(',')

  const onLiveProgress = useCallback((id: string, update: LiveProgress) => {
    if (!id) return
    setJobs((current) => current.map((j) => j.promptId === id && ['running', 'queued'].includes(j.status) ? { ...j, ...update, progress: update.progress ?? j.progress, status: 'running' } : j))
  }, [])

  useEffect(() => {
    // The submit graph is for in-memory retry only — never persisted.
    const persistable = jobs.slice(0, 100).map((job) => { const rest = { ...job }; delete rest.graph; return rest })
    localStorage.setItem('minimax.jobs', JSON.stringify(persistable))
  }, [jobs])

  useEffect(() => {
    if (!settings || !pendingKey || !connected) return
    // Applies a reduction only while the job is still non-terminal, so a stale
    // in-flight poll response can neither resurrect nor duplicate work.
    const applyReduction = (jobId: string, reduction: PollReduction) => {
      setJobs((current) => {
        let changed = false
        const next = current.map((item) => {
          if (item.id !== jobId || isTerminalStatus(item.status) || reduction.job === item) return item
          changed = true
          return reduction.job
        })
        return changed ? next : current
      })
    }
    const timer = window.setInterval(() => {
      for (const job of jobsRef.current.filter((j) => j.status === 'queued' || j.status === 'running')) {
        const promptId = job.promptId
        if (!promptId) continue
        void window.minimax.getHistory(settings.comfyUrl, promptId).then(async (history) => {
          const entry = history[promptId] as { status?: { status_str?: string; completed?: boolean; messages?: unknown[] } } | undefined
          const mediaType = job.mediaType ?? 'video'
          const outputUrl = playableOutputUrl(extractOutputUrl(history, promptId, settings.comfyUrl, mediaType))
          let observation: PollObservation
          if (entry?.status?.status_str === 'error') {
            observation = { kind: 'executionError' }
          } else if (entry?.status?.completed) {
            // Attribute the output by the exact filename ComfyUI reported —
            // never by the newest file on disk, which can belong to a
            // concurrent render and would poison library reference sets. A
            // descriptor that resolves remotely but not locally still
            // completes the job (streamed via the media proxy).
            const file = extractOutputFile(history, promptId, mediaType)
            if (file) {
              const localOutput = await window.minimax.resolveOutput(settings.outputDirectory, file)
              observation = { kind: 'completed', outputUrl: outputUrl ?? localOutput ?? '', localOutputPath: localOutput ?? undefined }
            } else {
              observation = { kind: 'completedNoLocalOutput' }
            }
          } else {
            observation = { kind: 'incomplete' }
          }
          // Queue hygiene: a failed MiniMax render gets one automatic
          // engine-reset + tiled-VAE retry before the error is surfaced —
          // most H3 failures on 16 GB cards are VRAM fragmentation that a
          // /free soft-reset clears.
          if (observation.kind === 'executionError' && !job.retriedOnce && (job.provider ?? 'minimax') === 'minimax' && job.graph) {
            try {
              await window.minimax.freeComfyMemory(settings.comfyUrl)
              const retryGraph = withTiledVideoDecode(job.graph as Record<string, { class_type: string; inputs: Record<string, unknown> }>)
              const resubmitted = await window.minimax.submitPrompt(settings.comfyUrl, retryGraph)
              setJobs((current) => current.map((item) => item.id === job.id
                ? { ...item, promptId: resubmitted.prompt_id, status: 'queued', progress: 2, progressLabel: 'Auto-retrying after engine reset (tiled VAE)', error: undefined, retriedOnce: true }
                : item))
              notify('neutral', 'A render failed — the engine was reset and the job re-queued once with tiled VAE decoding.')
              return
            } catch { /* Fall through to the normal failure handling. */ }
          }
          const reduction = reduceJobPoll(job, observation, Date.now())
          if (reduction.transitionedTo === 'completed') {
            // Re-check live state: an earlier in-flight response may have
            // already completed this job and fired these side effects.
            const current = jobsRef.current.find((item) => item.id === job.id)
            if (current && !isTerminalStatus(current.status)) {
              const remote = reduction.job.outputUrl ?? ''
              recordMovieOutput(job.movieLink, remote)
              let extractionError: string | null = null
              const local = reduction.job.localOutputPath
              if (job.characterProjectId) {
                recordCharacterTurntable(job.characterProjectId, local ?? remote)
                if (local) extractionError = await extractAutomatedReferenceSet('character', job.characterProjectId, local, job.duration, settings)
              } else if (job.locationProjectId) {
                recordLocationWalkthrough(job.locationProjectId, local ?? remote)
                if (local) extractionError = await extractAutomatedReferenceSet('location', job.locationProjectId, local, job.duration, settings)
              }
              if (extractionError) notify('error', `The video rendered, but its reference frames could not be extracted: ${extractionError}`)
            }
          }
          applyReduction(job.id, reduction)
        }).catch(() => undefined)
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [connected, notify, pendingKey, settings])

  // Deadline sweep, independent of ComfyUI connectivity: a job whose polls
  // stopped resolving (server died mid-render) must still reach a terminal
  // state instead of showing "running" forever.
  useEffect(() => {
    const timer = window.setInterval(() => {
      for (const job of jobsRef.current) {
        if (!isPastRunningDeadline(job, Date.now())) continue
        const reduction = reduceJobPoll(job, { kind: 'pollFailed' }, Date.now())
        if (reduction.transitionedTo) setJobs((current) => current.map((item) => item.id === job.id && !isTerminalStatus(item.status) ? reduction.job : item))
      }
    }, 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const cancelJob = useCallback(async (job: GenerationJob) => {
    if (!settings) return
    if (!['queued', 'running'].includes(job.status) || cancellingIds.has(job.id)) return
    cancellationRequests.current.add(job.id)
    setCancellingIds((current) => new Set(current).add(job.id))
    if (!job.promptId) {
      setJobs((current) => current.map((item) => item.id === job.id ? { ...item, status: 'cancelled', error: undefined } : item))
      notify('neutral', 'Cancelling input preparation…')
      return
    }
    try {
      const result = await window.minimax.cancelPrompt(settings.comfyUrl, job.promptId)
      if (result.cancelled) {
        setJobs((current) => current.map((item) => item.id === job.id ? { ...item, status: 'cancelled', error: undefined } : item))
        notify('success', result.state === 'pending' ? 'Queued generation removed.' : 'Running generation stopped.')
      } else {
        notify('neutral', result.state === 'finished' ? 'That generation already finished.' : 'That generation is no longer in the ComfyUI queue.')
      }
    } catch (error) {
      cancellationRequests.current.delete(job.id)
      notify('error', `Could not stop generation: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setCancellingIds((current) => { const next = new Set(current); next.delete(job.id); return next })
    }
  }, [cancellingIds, notify, settings])

  return { jobs, setJobs, jobsRef, cancellingIds, setCancellingIds, cancellationRequests, cancelJob, onLiveProgress }
}

export type GenerationQueue = ReturnType<typeof useGenerationQueue>
