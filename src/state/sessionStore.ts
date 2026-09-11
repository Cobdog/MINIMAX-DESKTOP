/** The studio-session store (wave 2a): settings, model scan, engine
 *  connection status/object-info, Ollama model list, and GPU telemetry — the
 *  state `useStudioSession` held as React state. The hook keeps its boot-load
 *  and telemetry effects; only where the values live changed. */
import { create } from 'zustand'
import type { AppSettings, ComfyStatus, GpuTelemetry, ModelFile, OllamaModel } from '../types'
import type { ObjectInfo } from '../lib/comfyInfo'

export type SessionState = {
  settings: AppSettings | null
  models: ModelFile[]
  scanning: boolean
  status: ComfyStatus
  checking: boolean
  gpu: GpuTelemetry | null
  info: ObjectInfo
  ollamaModels: OllamaModel[]
  setSettings(settings: AppSettings | null): void
  setModels(models: ModelFile[]): void
  setScanning(scanning: boolean): void
  setStatus(status: ComfyStatus): void
  setChecking(checking: boolean): void
  setGpu(gpu: GpuTelemetry | null): void
  setInfo(info: ObjectInfo): void
  setOllamaModels(ollamaModels: OllamaModel[]): void
}

export const useSessionStore = create<SessionState>()((set) => ({
  settings: null,
  models: [],
  scanning: false,
  status: { connected: false, latencyMs: 0 },
  checking: false,
  gpu: null,
  info: {},
  ollamaModels: [],
  setSettings: (settings) => set({ settings }),
  setModels: (models) => set({ models }),
  setScanning: (scanning) => set({ scanning }),
  setStatus: (status) => set({ status }),
  setChecking: (checking) => set({ checking }),
  setGpu: (gpu) => set({ gpu }),
  setInfo: (info) => set({ info }),
  setOllamaModels: (ollamaModels) => set({ ollamaModels }),
}))
