/** Studio session connection state: settings load, model scanning, ComfyUI
 *  connection/object-info, Ollama model list, and GPU telemetry.
 *
 *  Wave 2a: the VALUES live in `useSessionStore` (zustand) — this hook is the
 *  facade that keeps the boot-load and telemetry effects. Its return shape is
 *  unchanged, so existing destructuring keeps working; components that want
 *  narrow updates select directly from the store. Store actions are stable
 *  references, captured once. */
import { useCallback, useEffect } from 'react'
import type { AppSettings, ComfyStatus } from '../types'
import { onRealtimeStatus, subscribe } from '../lib/useRealtime'
import { dbg } from '../lib/dbg'
import { engineTransition, logEngineProbe, nextRecheckDelayMs } from '../lib/engineWatch'
import { useSessionStore } from '../state/sessionStore'
import type { TelemetrySample } from '../types'

/** One engine probe + its transition bookkeeping (R-01). The source names
 *  who asked: 'boot' (first check — no transition, no re-pull beyond its
 *  own), 'loop' (the re-check cadence), 'visibility' (tab came back),
 *  'manual' (Settings Test-connection / save). object_info + inventory
 *  re-pull ONLY on a disconnect→connect transition (A-8: never per tick —
 *  a loaded instance's full object_info is megabytes). */
async function runEngineCheck(url: string, source: 'boot' | 'loop' | 'visibility' | 'manual'): Promise<ComfyStatus> {
  const store = useSessionStore.getState()
  const wasConnected = source === 'boot' ? undefined : store.status.connected
  const nextStatus = await window.minimax.getComfyStatus(url)
  const transition = engineTransition(wasConnected, nextStatus.connected)
  logEngineProbe(source, url, transition, nextStatus.connected, nextStatus.latencyMs ?? 0)
  store.setStatus(nextStatus)
  if (nextStatus.connected) {
    const shouldPullInfo = transition === 'recovered' || source === 'boot' || source === 'manual'
    if (shouldPullInfo) {
      try {
        store.setInfo(await window.minimax.getObjectInfo(url))
        store.bumpInfoEpoch()
        if (transition === 'recovered') {
          // The restart-watch payload: object_info AND the model inventory
          // (the instance's own registry listing — R-12) re-pulled together.
          void window.minimax.scanModels(useSessionStore.getState().settings ?? ({} as AppSettings)).then((found) => {
            useSessionStore.getState().setModels(found)
          }).catch(() => undefined)
        }
      } catch { store.setInfo({}) }
    }
    if (transition === 'recovered') store.markEngineRecovered(Date.now())
  } else {
    store.setInfo({})
    if (transition === 'lost') store.markEngineLost(Date.now())
  }
  return nextStatus
}

/** The module-singleton loop (two surfaces mount this hook; ONE loop must
 *  run regardless — duplicate probes are harmless but duplicate transition
 *  toasts are not). Reads the CURRENT settings url every tick, so a URL
 *  change in Settings re-targets without restart. */
let engineWatchStarted = false
function ensureEngineWatchLoop(): () => void {
  if (!engineWatchStarted) {
    engineWatchStarted = true
    let timer = 0
    let probing = false
    const tick = async () => {
      if (probing) return
      probing = true
      try {
        const url = useSessionStore.getState().settings?.comfyUrl
        if (url) await runEngineCheck(url, 'loop').catch(() => undefined)
      } finally {
        probing = false
        schedule()
      }
    }
    const schedule = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(tick, nextRecheckDelayMs(useSessionStore.getState().status.connected))
    }
    const onVisibility = () => {
      if (!document.hidden) {
        window.clearTimeout(timer)
        void tick()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    schedule()
  }
  // The loop is app-lifetime by design (the session outlives surface
  // switches); the unmount hook intentionally does not stop it.
  return () => undefined
}

export function useStudioSession() {
  const settings = useSessionStore((state) => state.settings)
  const models = useSessionStore((state) => state.models)
  const scanning = useSessionStore((state) => state.scanning)
  const status = useSessionStore((state) => state.status)
  const checking = useSessionStore((state) => state.checking)
  const gpu = useSessionStore((state) => state.gpu)
  const info = useSessionStore((state) => state.info)
  const ollamaModels = useSessionStore((state) => state.ollamaModels)
  const engineMode = useSessionStore((state) => state.settings?.engine.mode)
  const { setSettings, setModels, setScanning, setChecking, setGpu, setOllamaModels, setLlm, setEngineRuntime } = useSessionStore.getState()

  const scanModels = useCallback(async (nextSettings: AppSettings, options?: { refresh?: boolean }) => {
    setScanning(true)
    if (options?.refresh) dbg('inventory.refresh', { source: 'user' })
    try {
      const found = await window.minimax.scanModels(nextSettings, options)
      setModels(found)
      // (A-DBG) The inventory epoch junction: what the registry answered.
      dbg('inventory.epoch', { refresh: Boolean(options?.refresh), files: found.length })
    } finally {
      setScanning(false)
    }
  }, [setModels, setScanning])

  const checkConnection = useCallback(async (url: string) => {
    setChecking(true)
    const next = await runEngineCheck(url, 'manual')
    setChecking(false)
    return next
  }, [setChecking])

  // R-01 (Wave 1, audits B P0-1 / C F3): the engine re-check loop. The
  // connection was a boot-time snapshot — start the engine after boot and
  // every submit still refused; kill it and the chip said connected for the
  // rest of the session. Now a module-singleton loop probes the engine on
  // the engineWatch cadence (fast when down, slow when up; immediate on
  // tab-visibility), and a connected TRANSITION re-pulls object_info + the
  // model inventory — the external restart-watch: the app notices by itself,
  // no manual Test-connection, no restart dance. This deliberately supersedes
  // the old "external mode issues not a single new request" rule (byte-parity
  // conservatism, ruled accidental by audit C).
  useEffect(ensureEngineWatchLoop, [])

  const refreshOllama = useCallback(async (nextSettings: AppSettings) => {
    try {
      const found = await window.minimax.listOllamaModels(nextSettings.ollamaUrl)
      setOllamaModels(found.filter((model) => model.local && model.family !== 'nomic-bert'))
    } catch {
      setOllamaModels([])
    }
  }, [setOllamaModels])

  // Active LLM provider (router primary, Ollama fallback): family-inferred
  // model list + the resolved active model. Assistant availability across the
  // app reads this — a configured router with models counts even when Ollama
  // has none.
  const refreshLlm = useCallback(async () => {
    try {
      setLlm(await window.minimax.listLlmModels())
    } catch {
      setLlm(null)
    }
  }, [setLlm])

  useEffect(() => {
    void window.minimax.getSettings().then((loaded) => {
      setSettings(loaded)
      void Promise.all([scanModels(loaded), runEngineCheck(loaded.comfyUrl, 'boot').catch(() => undefined), refreshOllama(loaded), refreshLlm()])
    })
  }, [refreshLlm, refreshOllama, scanModels, setSettings])

  // GPU telemetry rides the realtime fabric (wave 1): the server pushes each
  // sample while this client is subscribed, so the 4 s HTTP poll is gone. A
  // degraded-mode poll runs ONLY while the fabric is disconnected — same
  // sample source either way (the server's lazy 4 s-TTL sampler).
  useEffect(() => {
    let disposed = false
    const unsubscribe = subscribe('telemetry', (envelope) => {
      const sample = envelope.payload as TelemetrySample
      if (sample && typeof sample.available === 'boolean') setGpu(sample)
    })
    let timer = 0
    const stopFallback = () => { if (timer) { window.clearInterval(timer); timer = 0 } }
    const startFallback = () => {
      if (timer || document.hidden) return
      const refresh = () => {
        if (document.hidden) return
        void window.minimax.getGpuTelemetry().then((value) => { if (!disposed) setGpu(value) }).catch(() => { if (!disposed) setGpu({ available: false }) })
      }
      refresh()
      timer = window.setInterval(refresh, 4000)
    }
    startFallback()
    const stopStatus = onRealtimeStatus((state) => {
      if (disposed) return
      if (state.connected) stopFallback()
      else startFallback()
    })
    return () => { disposed = true; stopFallback(); unsubscribe(); stopStatus() }
  }, [setGpu])

  // Managed engine runtime (increment 1): poll ONLY while managed mode is
  // active — this poll reads the studio's OWN managed process (state,
  // log-tail, phases); external mode has no such process to ask. The
  // engine-connection loop above (R-01) now covers BOTH modes equally.
  useEffect(() => {
    if (engineMode !== 'managed') {
      setEngineRuntime(null)
      return
    }
    let disposed = false
    const refresh = () => {
      void window.minimax.getEngineStatus().then((value) => { if (!disposed) setEngineRuntime(value) }).catch(() => { if (!disposed) setEngineRuntime(null) })
    }
    refresh()
    const timer = window.setInterval(refresh, 2500)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [engineMode, setEngineRuntime])

  return {
    settings, setSettings,
    models, scanning,
    status, checking,
    gpu, info,
    ollamaModels,
    scanModels, checkConnection, refreshOllama, refreshLlm,
  }
}

export type StudioSession = ReturnType<typeof useStudioSession>
