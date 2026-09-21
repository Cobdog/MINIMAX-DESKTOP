/** The studio-session store (wave 2a): settings, model scan, engine
 *  connection status/object-info, Ollama model list, and GPU telemetry — the
 *  state `useStudioSession` held as React state. The hook keeps its boot-load
 *  and telemetry effects; only where the values live changed. */
import { create } from 'zustand'
import type { AppSettings, ComfyStatus, GpuTelemetry, LlmModelsResult, ManagedEngineStatus, ModelFile, OllamaModel } from '../types'
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
  /** Active LLM provider descriptor (router or Ollama fallback) from
   *  /api/lan/llm/models — drives assistant availability + model labels. */
  llm: LlmModelsResult | null
  /** Self-managed engine runtime snapshot — null unless managed mode is
   *  active (external mode never polls, so it stays null there). */
  engineRuntime: ManagedEngineStatus | null
  /** (Wave 1 R-01) The engine-watch bookkeeping the re-check loop writes:
   *  lostAt/recoveredAt timestamp the connectivity TRANSITIONS (consumers
   *  toast + fail active jobs honestly), infoEpoch counts successful
   *  object_info pulls (the pack board re-resolves its live chips on each). */
  engineWatch: { lostAt: number | null; recoveredAt: number | null; infoEpoch: number }
  setSettings(settings: AppSettings | null): void
  setModels(models: ModelFile[]): void
  setScanning(scanning: boolean): void
  setStatus(status: ComfyStatus): void
  setChecking(checking: boolean): void
  setGpu(gpu: GpuTelemetry | null): void
  setInfo(info: ObjectInfo): void
  setOllamaModels(ollamaModels: OllamaModel[]): void
  setLlm(llm: LlmModelsResult | null): void
  setEngineRuntime(engineRuntime: ManagedEngineStatus | null): void
  markEngineLost(at: number): void
  markEngineRecovered(at: number): void
  bumpInfoEpoch(): void
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
  llm: null,
  engineRuntime: null,
  engineWatch: { lostAt: null, recoveredAt: null, infoEpoch: 0 },
  setSettings: (settings) => set({ settings }),
  setModels: (models) => set({ models }),
  setScanning: (scanning) => set({ scanning }),
  setStatus: (status) => set({ status }),
  setChecking: (checking) => set({ checking }),
  setGpu: (gpu) => set({ gpu }),
  setInfo: (info) => set({ info }),
  setOllamaModels: (ollamaModels) => set({ ollamaModels }),
  setLlm: (llm) => set({ llm }),
  setEngineRuntime: (engineRuntime) => set({ engineRuntime }),
  markEngineLost: (at) => set((state) => ({ engineWatch: { ...state.engineWatch, lostAt: at, recoveredAt: null } })),
  markEngineRecovered: (at) => set((state) => ({ engineWatch: { ...state.engineWatch, lostAt: null, recoveredAt: at } })),
  bumpInfoEpoch: () => set((state) => ({ engineWatch: { ...state.engineWatch, infoEpoch: state.engineWatch.infoEpoch + 1 } })),
}))
