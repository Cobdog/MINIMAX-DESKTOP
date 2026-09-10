/** Studio session connection state: settings load, model scanning, ComfyUI
 *  connection/object-info, Ollama model list, and GPU telemetry polling. */
import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, ComfyStatus, GpuTelemetry, ModelFile, OllamaModel } from '../types'
import type { ObjectInfo } from '../lib/comfyInfo'

export function useStudioSession() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [models, setModels] = useState<ModelFile[]>([])
  const [scanning, setScanning] = useState(false)
  const [status, setStatus] = useState<ComfyStatus>({ connected: false, latencyMs: 0 })
  const [checking, setChecking] = useState(false)
  const [gpu, setGpu] = useState<GpuTelemetry | null>(null)
  const [info, setInfo] = useState<ObjectInfo>({})
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([])

  const scanModels = useCallback(async (nextSettings: AppSettings) => {
    setScanning(true)
    try {
      const found = await window.minimax.scanModels(nextSettings)
      setModels(found)
    } finally {
      setScanning(false)
    }
  }, [])

  const checkConnection = useCallback(async (url: string) => {
    setChecking(true)
    const nextStatus = await window.minimax.getComfyStatus(url)
    setStatus(nextStatus)
    if (nextStatus.connected) {
      try { setInfo(await window.minimax.getObjectInfo(url)) } catch { setInfo({}) }
    } else setInfo({})
    setChecking(false)
    return nextStatus
  }, [])

  const refreshOllama = useCallback(async (nextSettings: AppSettings) => {
    try {
      const found = await window.minimax.listOllamaModels(nextSettings.ollamaUrl)
      setOllamaModels(found.filter((model) => model.local && model.family !== 'nomic-bert'))
    } catch {
      setOllamaModels([])
    }
  }, [])

  useEffect(() => {
    void window.minimax.getSettings().then((loaded) => {
      setSettings(loaded)
      void Promise.all([scanModels(loaded), checkConnection(loaded.comfyUrl), refreshOllama(loaded)])
    })
  }, [checkConnection, refreshOllama, scanModels])

  useEffect(() => {
    let disposed = false
    const refresh = () => {
      if (document.hidden) return
      void window.minimax.getGpuTelemetry().then((value) => { if (!disposed) setGpu(value) }).catch(() => { if (!disposed) setGpu({ available: false }) })
    }
    refresh()
    const timer = window.setInterval(refresh, 4000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [])

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
