import { useEffect, useState } from 'react'
import type { JobLifecycleEvent, PreviewMime } from '../types'
import { createId } from './createId'
import { webMediaUrl } from './mediaUrls'
import { onPreviewFrame, onRealtimeStatus, subscribe } from './useRealtime'

export type LiveProgress = { progress?: number; label: string; currentStep?: number; totalSteps?: number }
export type LivePreview = {
  promptId: string
  url: string
  mime: string
  animated: boolean
  fps?: number
  step?: number
  totalSteps?: number
}

/**
 * Thin adapter over the realtime fabric (wave 1). Public interface unchanged:
 * `useLivePreview(comfyUrl, enabled, onProgress) -> { clientId, preview,
 * connected }` — CreateView/Ltx25Workspace keep their props. Internally the
 * transport is gone: ONE fabric connection to the app's own server carries
 * the job channel (normalized ComfyUI lifecycle) and binary preview frames.
 *
 * `preview` is METADATA plus a legacy-compat object-URL feed, coalesced to
 * one update per animation frame (newest frame only) because Ltx25Workspace
 * still renders `<img src={preview.url}>`. CreateView paints preview frames
 * through onPreviewFrame directly — bytes that never enter React state (the
 * Wave-2a transient discipline); the compat feed here retires when LTX
 * rewires to the same painter.
 */
export function useLivePreview(url: string | undefined, enabled: boolean, onProgress: (id: string, update: LiveProgress) => void) {
  const [clientId] = useState(createId)
  const [preview, setPreview] = useState<LivePreview | null>(null)
  const [connected, setConnected] = useState(false)
  useEffect(() => {
    if (!enabled) { setConnected(false); setPreview(null); return }
    let stopped = false
    let active = ''
    let blobUrl = ''
    let raf = 0
    let meta: { mime: string; animated: boolean; fps?: number; step?: number; totalSteps?: number } | null = null

    const replacePreview = (next: LivePreview) => {
      if (blobUrl && blobUrl !== next.url) URL.revokeObjectURL(blobUrl)
      blobUrl = next.url.startsWith('blob:') ? next.url : ''
      setPreview(next)
    }

    // Legacy-compat frame feed (see the doc comment): newest frame per rAF.
    const stopFrames = { current: null as null | (() => void) }
    const followFrames = (promptKey: string) => {
      stopFrames.current?.()
      stopFrames.current = null
      if (!promptKey) return
      stopFrames.current = onPreviewFrame(promptKey, (bytes: ArrayBuffer, mime: PreviewMime) => {
        if (stopped) return
        const blob = new Blob([bytes], { type: mime })
        if (raf) cancelAnimationFrame(raf)
        raf = requestAnimationFrame(() => {
          raf = 0
          if (stopped) return
          replacePreview({
            promptId: promptKey,
            url: URL.createObjectURL(blob),
            mime,
            animated: meta?.mime === mime ? meta.animated : mime === 'image/webp' || mime === 'video/mp4',
            fps: meta?.fps,
            step: meta?.step,
            totalSteps: meta?.totalSteps,
          })
        })
      })
    }

    const unsubscribeJob = subscribe('job', (envelope) => {
      if (envelope.type === 'resync') return // the queue hook owns reconciliation
      const event = envelope.payload as JobLifecycleEvent
      if (!event || typeof event.type !== 'string') return
      if (event.type === 'execution_start') {
        active = event.promptId
        meta = null
        if (blobUrl) URL.revokeObjectURL(blobUrl)
        blobUrl = ''
        setPreview(null)
        followFrames(active)
        onProgress(active, { progress: 1, label: 'Starting workflow' })
        return
      }
      const promptId = event.promptId || active
      if (!promptId) return
      // Mid-render join (page loaded while a render was already executing):
      // start following that prompt's frames without resetting state.
      if (promptId !== active) { active = promptId; followFrames(active) }
      if (event.type === 'execution_cached') onProgress(promptId, { label: 'Reusing cached model data' })
      if (event.type === 'executing' && event.node) onProgress(promptId, { label: 'Loading or processing workflow stage' })
      if (event.type === 'progress') {
        onProgress(promptId, { progress: Math.min(95, (event.value / event.max) * 95), label: `Sampling · step ${event.value} of ${event.max}`, currentStep: event.value, totalSteps: event.max })
      }
      if (event.type === 'preview_meta') {
        const animated = event.mime === 'image/webp' || event.mime === 'video/mp4'
        meta = { mime: event.mime, animated, fps: event.fps, step: event.step, totalSteps: event.totalSteps }
        setPreview((current) => current && current.promptId === promptId ? { ...current, mime: event.mime, animated, fps: event.fps, step: event.step, totalSteps: event.totalSteps } : current)
      }
      if (event.type === 'executed' && event.images.length > 0) {
        const file = event.images[0]
        const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? '', type: file.type ?? 'temp' })
        const upstream = `${(url ?? '').replace(/\/+$/, '')}/view?${query}`
        replacePreview({ promptId: event.promptId, url: webMediaUrl(`minimax-media://comfy?url=${encodeURIComponent(upstream)}`) ?? upstream, mime: 'image/jpeg', animated: false })
      }
      if (event.type === 'execution_success') onProgress(promptId, { progress: 98, label: 'Finalizing saved output' })
      if (event.type === 'execution_error') onProgress(promptId, { label: 'Execution failed — finishing up' })
      if (event.type === 'interrupted') onProgress(promptId, { label: 'Generation interrupted' })
    })
    const stopStatus = onRealtimeStatus((status) => setConnected(status.connected))

    return () => {
      stopped = true
      if (raf) cancelAnimationFrame(raf)
      stopFrames.current?.()
      unsubscribeJob()
      stopStatus()
      if (blobUrl) URL.revokeObjectURL(blobUrl)
    }
  }, [url, enabled, onProgress])
  return { clientId, preview, connected }
}
