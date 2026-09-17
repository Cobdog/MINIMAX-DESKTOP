/**
 * Canvas Phase 2 — the engine/session host for the canvas route.
 *
 * The canvas route mounts OUTSIDE the old App shell (main.tsx), so the hooks
 * that keep the SHARED zustand stores alive — useStudioSession (settings,
 * model scan, engine status, object-info), useGenerationQueue (persistence,
 * the ComfyUI history poll, deadline sweep, cancellation), useLivePreview
 * (the event socket + submit clientId) — mount here instead. Both surfaces
 * therefore read/write the SAME stores (spec §8 D1/D2): one queue, one
 * engine session, one flows core.
 *
 * The workspace facade (useCreateWorkspace) is deliberately NOT mounted: the
 * canvas keeps its generation state per chain in the document store — the
 * singleton unwind. The old CreateView keeps its own workspace untouched.
 */
import { useEffect, type ReactNode } from 'react'
import { useStudioSession } from '../hooks/useStudioSession'
import { useGenerationQueue } from '../hooks/useGenerationQueue'
import { useLivePreview } from '../lib/useLivePreview'
import { inferSelections } from '../lib/modelSelection'
import { submitH3DiagnosticPair } from '../lib/h3Diagnostics'
import { CHARACTER_LIBRARY_EVENT } from '../lib/characterLibrary'
import { WARDROBE_LIBRARY_EVENT } from '../lib/wardrobeLibrary'
import { LOCATION_LIBRARY_EVENT } from '../lib/locationLibrary'
import { useSessionStore } from '../state/sessionStore'
import { useJobsStore } from '../state/jobsStore'
import { useCanvasStore, engineBridge } from './store'
import { CanvasSessionContext } from './sessionContext'

export function CanvasEngineHost({ children }: { children?: ReactNode }) {
  const toast = useCanvasStore((state) => state.toast)
  const notify = (tone: 'error' | 'success' | 'neutral', text: string) => toast(tone, text)

  // Shared session + queue: the same hooks the old App root mounts, pointed
  // at the same stores — mounting them here is what makes the canvas's
  // submissions flow through the real queue machinery.
  const session = useStudioSession()
  const queue = useGenerationQueue({ settings: session.settings, connected: session.status.connected, notify })
  const live = useLivePreview(session.settings?.comfyUrl, true, queue.onLiveProgress)

  // Register the bridge the store's submit path reads at call time.
  engineBridge.clientId = live.clientId
  engineBridge.cancellationRequests = queue.cancellationRequests
  engineBridge.cancelJob = (job) => void queue.cancelJob(job)

  // Mirror the honest engine facts into the canvas store (radar chip, bar,
  // menus) — model readiness follows the base H3 selection.
  useEffect(() => {
    const unsubscribe = useSessionStore.subscribe((state) => {
      const selection = inferSelections(state.models, 'off')
      const ready = Boolean(state.status.connected && selection.fl2va && selection.ref2va && selection.textEncoder && selection.videoVae && selection.audioVae)
      const current = useCanvasStore.getState().engine
      if (current.connected !== state.status.connected || current.modelReady !== ready) {
        useCanvasStore.getState().setEngineFacts({ connected: state.status.connected, modelReady: ready })
      }
    })
    return unsubscribe
  }, [])

  // Library events refresh the canvas's reference bindings (the same events
  // the old workspace facade listens to — one library, both surfaces) and
  // re-project the global asset store (Phase 4).
  useEffect(() => {
    const refresh = () => {
      useCanvasStore.getState().refreshLibraries()
      void useCanvasStore.getState().syncLibraryAssets()
    }
    window.addEventListener(CHARACTER_LIBRARY_EVENT, refresh)
    window.addEventListener(WARDROBE_LIBRARY_EVENT, refresh)
    window.addEventListener(LOCATION_LIBRARY_EVENT, refresh)
    return () => {
      window.removeEventListener(CHARACTER_LIBRARY_EVENT, refresh)
      window.removeEventListener(WARDROBE_LIBRARY_EVENT, refresh)
      window.removeEventListener(LOCATION_LIBRARY_EVENT, refresh)
    }
  }, [])

  const runDiagnostics = async () => {
    const state = useSessionStore.getState()
    if (!state.settings) return 'Studio settings are still loading.'
    return submitH3DiagnosticPair(
      { settings: state.settings, connected: state.status.connected, models: state.models, info: state.info, clientId: engineBridge.clientId },
      {
        notify: (tone, text) => useCanvasStore.getState().toast(tone, text),
        setJobs: (update) => useJobsStore.getState().setJobs(update),
      },
    )
  }

  return <CanvasSessionContext.Provider value={{ session, runDiagnostics }}>
    {children}
  </CanvasSessionContext.Provider>
}
