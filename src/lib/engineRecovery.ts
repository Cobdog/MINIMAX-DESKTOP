/** The engine-probe CONSEQUENCE flow (truth-surface sweep #2, task 68e9k17
 * — audit M1/C1). What useStudioSession's runEngineCheck did inline lives
 * here, dependency-injected, so the whole transition matrix — what gets
 * pulled, with which options, and when the resync bookkeeping lands — is
 * provable without React or an engine (tests/enginewatch.test.js (a4)
 * drives it with a recording harness; tests/resync.test.js drives it over
 * HTTP against the real server + the environment-mirror fake engine).
 *
 * The flow, per probe (decisions in engineWatch.ts, wiring here):
 *   - probe status; log the junction; publish it.
 *   - CONNECTED:
 *     - boot/manual/recovered pull object_info (A-8: never per steady tick).
 *     - RECOVERED re-syncs the model inventory WITH REFRESH, then records
 *       the outcome — the toast speaks only after the listing landed (or
 *       names the failure).
 *     - a STEADY tick runs the LIGHT drift check (models-only listing, no
 *       object_info): a registry that changed with connectivity never
 *       dropping — the invisible restart the audit's mirror walk hit, where
 *       the engine came back between two probes and no transition fired —
 *       re-syncs within one cadence.
 *   - DISCONNECTED: clear object_info; mark the loss (R-01's contract).
 *
 * Failure honesty: a resync that throws records ok:false and never replaces
 * the store's inventory (an error-shaped return is a failure, not data).
 */
import type { AppSettings, ComfyStatus, ModelFile } from '../types'
import type { ObjectInfo } from './comfyInfo'
import { dbg } from './dbg'
import {
  engineTransition, inventoryDrifted, logEngineProbe, RECOVERY_RESYNC_OPTIONS,
  type InventoryResyncCause, type InventoryResyncRecord, type LightInventory,
} from './engineWatch'

export type EngineProbeSource = 'boot' | 'loop' | 'visibility' | 'manual'

/** The bridge the renderer's DesktopApi provides (the web apiClient's
 *  shapes; every method signature matches window.minimax exactly). */
export type EngineRecoveryBridge = {
  getComfyStatus(url: string): Promise<ComfyStatus>
  getObjectInfo(url: string): Promise<ObjectInfo>
  scanModels(settings: AppSettings, options?: { refresh?: boolean }): Promise<ModelFile[]>
  /** The light models-only listing; null when it cannot be judged (route
   *  absent, engine flapped mid-ask). Optional: a bridge without it simply
   *  never drift-checks (the transition path still re-syncs). */
  lightInventory?(settings: AppSettings): Promise<LightInventory | null>
}

/** The store surface the flow needs — the zustand session store's methods,
 *  thin enough to fake in a test. */
export type EngineRecoveryStore = {
  status(): { connected: boolean }
  settings(): AppSettings | null
  models(): ModelFile[]
  setStatus(status: ComfyStatus): void
  setInfo(info: ObjectInfo): void
  bumpInfoEpoch(): void
  setModels(models: ModelFile[]): void
  markEngineLost(at: number): void
  markEngineRecovered(at: number): void
  markInventoryResync(record: InventoryResyncRecord): void
}

export type EngineRecoveryDeps = { bridge: EngineRecoveryBridge; store: EngineRecoveryStore }

/** One re-sync: full inventory pull with refresh semantics, store update,
 *  outcome recorded. A failure keeps the current inventory and records
 *  ok:false — the surfaces' wording follows the record, never the attempt. */
async function resyncInventory(deps: EngineRecoveryDeps, cause: InventoryResyncCause, settings: AppSettings): Promise<void> {
  try {
    const found = await deps.bridge.scanModels(settings, RECOVERY_RESYNC_OPTIONS)
    deps.store.setModels(found)
    // (A-DBG) The re-sync junction: what the registry answered, and why we
    // asked — the drift/recovery split is the triage transcript's spine.
    dbg('inventory.resync', { cause, refresh: true, files: found.length })
    deps.store.markInventoryResync({ at: Date.now(), ok: true, files: found.length, cause })
  } catch (error) {
    dbg('inventory.resync', { cause, refresh: true, failed: String(error) })
    deps.store.markInventoryResync({ at: Date.now(), ok: false, files: 0, cause })
  }
}

/** One engine probe + its transition bookkeeping (R-01's flow, extracted;
 *  see the module header for the contract). */
export async function runEngineCheck(deps: EngineRecoveryDeps, url: string, source: EngineProbeSource): Promise<ComfyStatus> {
  const { bridge, store } = deps
  const wasConnected = source === 'boot' ? undefined : store.status().connected
  const nextStatus = await bridge.getComfyStatus(url)
  const transition = engineTransition(wasConnected, nextStatus.connected)
  logEngineProbe(source, url, transition, nextStatus.connected, nextStatus.latencyMs ?? 0)
  store.setStatus(nextStatus)
  if (nextStatus.connected) {
    const shouldPullInfo = transition === 'recovered' || source === 'boot' || source === 'manual'
    if (shouldPullInfo) {
      try {
        store.setInfo(await bridge.getObjectInfo(url))
        store.bumpInfoEpoch()
      } catch {
        store.setInfo({})
      }
    }
    if (transition === 'recovered') {
      // The restart-watch payload: object_info AND the model inventory
      // (the instance's own registry listing — R-12) re-pulled together,
      // with refresh semantics, and the outcome RECORDED before any
      // surface claims it.
      const settings = store.settings() ?? ({} as AppSettings)
      await resyncInventory(deps, 'recovery', settings)
      store.markEngineRecovered(Date.now())
    } else if (transition === 'steady' && source !== 'boot') {
      // The invisible-restart guard: the light, models-only listing (no
      // object_info — A-8's megabytes stay out of the cadence) against the
      // store's inventory. Drift re-syncs; agreement costs six tiny GETs.
      const settings = store.settings() ?? ({} as AppSettings)
      const light = bridge.lightInventory ? await bridge.lightInventory(settings).catch(() => null) : null
      if (inventoryDrifted(store.models(), light)) {
        await resyncInventory(deps, 'drift', settings)
      }
    }
  } else {
    store.setInfo({})
    if (transition === 'lost') store.markEngineLost(Date.now())
  }
  return nextStatus
}
