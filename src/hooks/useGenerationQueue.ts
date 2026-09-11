/** The generation job queue: persistence, the ComfyUI history poll loop with
 *  terminal-state guards, the offline deadline sweep, and cancellation.
 *
 *  Wave 1: durable storage lives in the server's SQLite database (POST
 *  /api/lan/jobs per-job upserts). The localStorage snapshot still paints
 *  instantly at boot and serves as the degraded-mode fallback write when the
 *  API is unreachable.
 *
 *  Wave 2a: `jobs` and `cancellingIds` live in `useJobsStore` (zustand) —
 *  every setJobs call site kept its exact value/updater form, and the store
 *  actions are stable references (safe for flows to capture). The poll loop,
 *  deadline sweep, retry, and persistence logic below are UNCHANGED; only
 *  where the state lives moved. `jobsRef` still mirrors the list for the
 *  interval-driven loops — via a store subscription rather than a render
 *  assignment, so the loops always read the latest list even when no
 *  component re-rendered in between. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings, GenerationJob } from '../types'
import { isPastRunningDeadline, isTerminalStatus, reduceJobPoll, type PollObservation, type PollReduction } from '../lib/jobReducer'
import { extractOutputFile, extractOutputUrl, withTiledVideoDecode } from '../lib/workflow'
import { extractAutomatedReferenceSet, hydrateLoadedJobs, playableOutputUrl, recordCharacterSheetImages, recordCharacterTurntable, recordLocationWalkthrough, recordMovieOutput } from '../lib/jobRecords'
import { fetchServerJobs, saveServerJobs, serverStorageMigrationDone } from '../lib/serverStorage'
import type { LiveProgress } from '../lib/useLivePreview'
import { subscribe } from '../lib/useRealtime'
import { useJobsStore } from '../state/jobsStore'
import { useDebouncedPersist } from './useDebouncedPersist'

export type NoticeTone = 'error' | 'success' | 'neutral'

export function useGenerationQueue(options: {
  settings: AppSettings | null
  connected: boolean
  notify(tone: NoticeTone, text: string): void
}) {
  const { settings, connected, notify } = options
  const jobs = useJobsStore((state) => state.jobs)
  const cancellingIds = useJobsStore((state) => state.cancellingIds)
  // Stable store actions — captured once, never go stale.
  const { setJobs, setCancellingIds } = useJobsStore.getState()
  const [storageBootDone, setStorageBootDone] = useState(false)
  const cancellationRequests = useRef(new Set<string>())
  const jobsRef = useRef(jobs)
  useEffect(() => useJobsStore.subscribe((state) => { jobsRef.current = state.jobs }), [])
  const pendingKey = jobs.filter((job) => job.status === 'queued' || job.status === 'running').map((job) => job.id).join(',')

  // Boot load: the server store is authoritative. The localStorage snapshot
  // (already in state) paints instantly for a pre-migration first boot; the
  // server answer then replaces it. An empty server answer only clears the
  // list when the migration marker proves the copy already happened —
  // otherwise the local list stands until the migration POSTs land. A fetch
  // failure (server down) keeps the local list so the app keeps working.
  useEffect(() => {
    let disposed = false
    const failSafe = window.setTimeout(() => { if (!disposed) setStorageBootDone(true) }, 3000)
    void fetchServerJobs()
      .then((loaded) => {
        if (disposed) return
        if (loaded.length > 0) setJobs(hydrateLoadedJobs(loaded))
        else if (serverStorageMigrationDone()) setJobs([])
      })
      .catch(() => undefined)
      .finally(() => { if (!disposed) setStorageBootDone(true) })
    return () => { disposed = true; window.clearTimeout(failSafe) }
  }, [setJobs])

  const onLiveProgress = useCallback((id: string, update: LiveProgress) => {
    if (!id) return
    setJobs((current) => current.map((j) => j.promptId === id && ['running', 'queued'].includes(j.status) ? { ...j, ...update, progress: update.progress ?? j.progress, status: 'running' } : j))
  }, [setJobs])

  // Persistence is debounced (1 s trailing): during a live render the poll
  // loop and progress events update `jobs` several times per second. The
  // write reads jobsRef.current at flush time, so it always persists the
  // latest complete job list (never a partially-built one), and the debounce
  // hook flushes on pagehide/beforeunload/unmount so a normal close loses
  // nothing. Writes wait for the boot load so a stale local snapshot cannot
  // overwrite the server's newer state before we have read it.
  //
  // Multi-tab model: per-job upsert, latest-write-wins PER JOB ID at the
  // server — two tabs POST overlapping sets and each job keeps whichever
  // write landed last (the whole-list replace of the localStorage era is
  // gone, so one tab can no longer erase another tab's jobs). True
  // cross-tab live sync arrives with the realtime fabric.
  const persistJobs = useDebouncedPersist(1000)
  useEffect(() => {
    if (!storageBootDone) return
    persistJobs(() => {
      // The submit graph is for in-memory retry only — never persisted.
      const persistable = jobsRef.current.slice(0, 100).map((job) => { const rest = { ...job }; delete rest.graph; return rest })
      void saveServerJobs(persistable).catch(() => {
        // Degraded mode: mirror to the legacy store so a boot while the API
        // is unreachable still finds the history (the boot loader reads it
        // when the server answer fails).
        try { localStorage.setItem('minimax.jobs', JSON.stringify(persistable)) } catch { /* Quota: the next debounced write retries. */ }
      })
    })
  }, [jobs, persistJobs, storageBootDone])

  // The fabric resync path (below) triggers one immediate sweep through this
  // ref; declared before the poll effect that assigns it.
  const sweepRef = useRef<(() => void) | null>(null)
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
    const sweep = () => {
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
              const imageDescriptor = job.mediaType === 'image' ? extractOutputFile(history, promptId, mediaType) : undefined
              if (job.characterProjectId && imageDescriptor) {
                extractionError = await recordCharacterSheetImages(job.characterProjectId, imageDescriptor, settings)
              } else if (job.characterProjectId) {
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
    }
    sweepRef.current = sweep
    const timer = window.setInterval(sweep, 1000)
    return () => { sweepRef.current = null; window.clearInterval(timer) }
  }, [connected, notify, pendingKey, setJobs, settings])

  // Realtime fabric resync (wave 1): a per-channel sequence gap means the
  // server dropped envelopes (bounded overflow) — one immediate history sweep
  // re-reconciles any missed progress. The 1s poll loop above STAYS untouched
  // as the reconciliation path: its terminal-state guards remain the safety
  // net, and demoting the poll is a LATER decision, only after the fabric
  // proves out in real use.
  useEffect(() => subscribe('job', (envelope) => {
    if (envelope.type === 'resync') sweepRef.current?.()
  }), [])

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
  }, [setJobs])

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
  }, [cancellingIds, notify, setCancellingIds, setJobs, settings])

  return { jobs, setJobs, jobsRef, cancellingIds, setCancellingIds, cancellationRequests, cancelJob, onLiveProgress }
}

export type GenerationQueue = ReturnType<typeof useGenerationQueue>
