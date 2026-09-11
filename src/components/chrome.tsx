/** App-chrome presentational pieces: titlebar meters, nav, notices, and the
 *  pipeline/status badges reused across views. */
import { Activity, AlertCircle, Check, Gauge, LoaderCircle, X } from 'lucide-react'
import type { Film } from 'lucide-react'
import type { GpuTelemetry, GenerationJob } from '../types'

export function GpuMeter({ value, engineOnline = true }: { value: GpuTelemetry | null; engineOnline?: boolean }) {
  const usage = value?.usagePercent
  const vram = value?.vramPercent
  const available = Boolean(value?.available && usage !== undefined && vram !== undefined)
  const base = available ? `${value?.name ?? 'GPU'} · ${usage}% utilization · ${vram}% VRAM (${value?.vramUsedMb ?? 0} / ${value?.vramTotalMb ?? 0} MB)` : 'GPU telemetry unavailable'
  const title = engineOnline ? base : `${base} — shown for reference only; the generation engine is offline`
  return <div className={`gpu-meter ${available ? 'available' : ''} ${engineOnline ? '' : 'suppressed'}`} title={title} aria-label={title}><Gauge size={14} /><span><small>GPU</small><strong>{available ? `${usage}%` : '—'}</strong></span><i aria-hidden="true"><b style={{ width: `${available ? usage : 0}%` }} /></i><span><small>VRAM</small><strong>{available ? `${vram}%` : '—'}</strong></span></div>
}

export function NavButton({ active, icon: Icon, label, count, itemType, onClick }: { active: boolean; icon: typeof Film; label: string; count?: number; itemType?: 'character' | 'wardrobe' | 'location'; onClick(): void }) {
  return <button className={`nav-button ${active ? 'active' : ''}`} data-item-type={itemType} aria-label={label} onClick={onClick}><Icon size={19} /><span>{label}</span>{count ? <em>{count}</em> : null}</button>
}

export function Notice({ tone, text, onClose }: { tone: 'error' | 'success' | 'neutral'; text: string; onClose(): void }) {
  return <div className={`notice ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{tone === 'error' ? <AlertCircle size={17} /> : tone === 'success' ? <Check size={17} /> : <Activity size={17} />}<span>{text}</span><button onClick={onClose} aria-label="Dismiss"><X size={16} /></button></div>
}

export function PipelineItem({ ready, label, value }: { ready: boolean; label: string; value: string }) {
  return <div className="pipeline-item"><span className={ready ? 'ready' : ''}>{ready ? <Check size={13} /> : <AlertCircle size={13} />}</span><div><strong>{label}</strong><small title={value}>{value || 'Not detected'}</small></div></div>
}

export function StatusBadge({ status }: { status: GenerationJob['status'] }) {
  return <span className={`status-badge ${status}`}>{status === 'running' && <LoaderCircle size={12} className="spin" />}{status}</span>
}
