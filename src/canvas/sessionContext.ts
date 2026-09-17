/**
 * Canvas Phase 4 — the route's session facade context (§8 Settings docking).
 *
 * EngineHost provides its LIVE useStudioSession values here; the SettingsDock
 * consumes them instead of mounting a second session hook (one poller per
 * surface, values shared — the D1/D2 discipline applied to the host itself).
 * Separated from EngineHost.tsx so the component file keeps fast refresh.
 */
import { createContext } from 'react'
import type { StudioSession } from '../hooks/useStudioSession'

export const CanvasSessionContext = createContext<{
  session: StudioSession
  runDiagnostics(): Promise<string | null>
} | null>(null)
