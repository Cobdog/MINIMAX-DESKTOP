/** Studio session connection state: settings load, model scanning, ComfyUI
 *  connection/object-info, Ollama model list, and GPU telemetry.
 *
 *  Wave 2a: the VALUES live in `useSessionStore` (zustand) — this hook is the
 *  facade that keeps the boot-load and telemetry effects. Its return shape is
 *  unchanged, so existing destructuring keeps working; components that want
 *  narrow updates select directly from the store. Store actions are stable
 *  references, captured once. */
import { useCallback, useEffect } from 'react'
import type { AppSettings } from '../types'
import { onRealtimeStatus, subscribe } from '../lib/useRealtime'
import { useSessionStore } from '../state/sessionStore'
import type { TelemetrySample } from '../types'

export function useStudioSession() {
  const settings = useSessionStore((state) => state.settings)
  const models = useSessionStore((state) => state.models)
  const scanning = useSessionStore((state) => state.scanning)
  const status = useSessionStore((state) => state.status)
  const checking = useSessionStore((state) => state.checking)
  const gpu = useSessionStore((state) => state.gpu)
  const info = useSessionStore((state) => state.info)
  const ollamaModels = useSessionStore((state) => state.ollamaModels)
  const { setSettings, setModels, setScanning, setStatus, setChecking, setGpu, setInfo, setOllamaModels } = useSessionStore.getState()

  const scanModels = useCallback(async (nextSettings: AppSettings) => {
    setScanning(true)
    try {
      const found = await window.minimax.scanModels(nextSettings)
      setModels(found)
    } finally {
      setScanning(false)
    }
  }, [setModels, setScanning])

  const checkConnection = useCallback(async (url: string) => {
    setChecking(true)
    const nextStatus = await window.minimax.getComfyStatus(url)
    setStatus(nextStatus)
    if (nextStatus.connected) {
      try { setInfo(await window.minimax.getObjectInfo(url)) } catch { setInfo({}) }
    } else setInfo({})
    setChecking(false)
    return nextStatus
  }, [setChecking, setInfo, setStatus])

  const refreshOllama = useCallback(async (nextSettings: AppSettings) => {
    try {
      const found = await window.minimax.listOllamaModels(nextSettings.ollamaUrl)
      setOllamaModels(found.filter((model) => model.local && model.family !== 'nomic-bert'))
    } catch {
      setOllamaModels([])
    }
  }, [setOllamaModels])

  useEffect(() => {
    void window.minimax.getSettings().then((loaded) => {
      setSettings(loaded)
      void Promise.all([scanModels(loaded), checkConnection(loaded.comfyUrl), refreshOllama(loaded)])
    })
  }, [checkConnection, refreshOllama, scanModels, setSettings])

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

  return {
    settings, setSettings,
    models, scanning,
    status, checking,
    gpu, info,
    ollamaModels,
    scanModels, checkConnection, refreshOllama,
  }
}

export type StudioSession = ReturnType<typeof useStudioSession>
