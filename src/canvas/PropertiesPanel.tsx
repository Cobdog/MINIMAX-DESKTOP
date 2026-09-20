/**
 * Canvas Phase 2 — the properties panel (the absorption surface for
 * CreateView's binding model; spec §4 properties entry, §2 identity payload).
 *
 * Per-chain settings (the unwound workspace singleton, persisted in the
 * document store): SmartPromptEditor as the universal prompt field, engine
 * params (tier off/4/8 + turbo family through the optimization registry,
 * with detection state and install guidance), the reference binding model
 * (ordered canvas-output refs + character/location library binding +
 * clothing policy), the identity payload (verbatim subject text + the
 * strength dial with its stiffness↔drift labels), and keyframe guides as
 * chain settings. The generate row validates honestly before submit.
 *
 * Phase 4 adds CreateView's remaining unique capabilities so its retirement
 * is genuine: the prompt library (PromptLibraryBrowser insert — L11's
 * properties-insert side), the local-LLM prompt tools (enhance / shot
 * timeline / audio pass with the streaming preview + suggestion flow), and
 * vision captioning of bound reference pictures — plus the global asset
 * store in the reference bindings (§2 asset, consent-gated first bind) and
 * the engine readouts for the audio + LTX-2.5 engine-ops (§5.4).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Rnd } from 'react-rnd'
import { Captions, Clock3, Dices, LoaderCircle, Play, Sparkles, Square, Star, Volume2, WandSparkles, X } from 'lucide-react'
import { SmartPromptEditor, type SmartPromptEditorHandle } from '../components/SmartPromptEditor'
import { StructuredPromptEditor } from '../components/StructuredPromptEditor'
import { PromptLibraryBrowser } from '../components/PromptLibraryBrowser'
import { detectOptimizations } from '../lib/graph'
import { inferredOverrideSlotFile, migrateLegacyModelOverrideSlots, modelFamilyInfo, overridePickOutcome, SLOT_LABELS, type ModelFamilyId, type ModelOverrideSlotName } from '../lib/modelOverrides'
import { guideFrameWarning } from '../lib/workflow'
import { buildPromptAssistantContext } from '../lib/promptComposer'
import { composeStructuredPrompt, mergeStructuredDraft, parseFlowRows, parseStructuredPrompt, type StructuredPromptDraft } from '../lib/structuredPrompt'
import { useLlmStream } from '../lib/useLlmStream'
import type { ModelOverrideSlots } from '../types'
import { useSessionStore } from '../state/sessionStore'
import { STATUS_LABEL } from './derive'
import { effectiveMode, IMAGE_ENGINES, MODE_LABEL, readChainSettings, type CanvasChainSettings } from './generation'
import {
  compileLoraTimeline, DEFAULT_TRANSITION_WINDOW, LORA_COMBINED_COLLAPSE_RISK, LORA_COMBINED_HEALTHY_MAX, LORA_SLOTS,
  newLoraRange, newLoraTimelineDoc, snapRangeBoundary,
  type LoraStackEntry, type LoraTimelineDoc,
} from './loraTimeline'
import { GAP_KINDS, GAP_LABEL, type PlanGapKind } from './plan'
import { useCanvasStore } from './store'
import type { DocumentChain } from './derive'

const RESOLUTIONS = ['1344x768', '768x1344', '768x768']
const TIERS: Array<{ value: CanvasChainSettings['turbo']; label: string; note: string }> = [
  { value: 'off', label: 'Quality', note: 'full-step native' },
  { value: '4', label: 'Fast · 4-step', note: 'turbo LoRA' },
  { value: '8', label: 'Fast · 8-step', note: 'turbo LoRA' },
]

/** Debounced persistence for panel edits: typing never hammers the document
 *  store; a chain switch or unmount flushes. */
function useDebouncedCommit<T>(value: T, skip: boolean, commit: (value: T) => void, delay = 500) {
  const commitRef = useRef(commit)
  commitRef.current = commit
  useEffect(() => {
    if (skip) return undefined
    const timer = window.setTimeout(() => commitRef.current(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, skip, delay])
}

// ---- the LoRA timeline section (7twfk6o; surface decision 2026-09-19: a
// SEPARATE properties-panel section — the ranges edit ONE chain's temporal
// LoRA application, the panel already hosts the chain's LoRA seam, and grid
// snapping makes legal boundary positions discrete enough for an inline
// rail. The compiled result is a Director Suite plan document, so the
// timeline projection (V) renders it for free.) -------------------------------

const LORA_RAIL = { pad: 6, width: 308, paintedY: 6, paintedH: 18, layoutY: 38, layoutH: 12, labelsY: 62 }

function LoraTimelineSection(props: {
  chainId: string
  duration: number
  doc: LoraTimelineDoc | null
  loraNames: string[]
  formAdapterInstalled: boolean
  onChange(next: LoraTimelineDoc | null): void
  /** Persist the panel's full draft before Apply compiles (the compiler reads
   *  the persisted chain — the generate() precedent). */
  flush(): Promise<void>
}) {
  const { chainId, duration, doc, loraNames, formAdapterInstalled, onChange, flush } = props
  const [dragRange, setDragRange] = useState<number | null>(null) // the RIGHT range's sorted index whose start is dragged
  const [applying, setApplying] = useState(false)
  const [failure, setFailure] = useState<string[]>([])
  const railRef = useRef<SVGSVGElement | null>(null)

  const timeline = doc ?? newLoraTimelineDoc()
  const clip = Math.max(2, Math.min(15, duration))
  const compile = useMemo(() => compileLoraTimeline(timeline, clip), [timeline, clip])
  const sorted = useMemo(() => timeline.ranges.slice().sort((a, b) => a.start - b.start), [timeline.ranges])

  const xOf = (seconds: number) => LORA_RAIL.pad + (Math.max(0, Math.min(clip, seconds)) / clip) * LORA_RAIL.width
  const secondsFromClientX = (clientX: number) => {
    const rail = railRef.current
    if (!rail) return 0
    const rect = rail.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)))
    return ratio * clip
  }

  const paintRange = () => {
    // The largest uncovered span gets a fresh 3s range (clamped to the span).
    const spans: Array<{ start: number; end: number }> = []
    let cursor = 0
    for (const range of sorted) {
      if (range.start > cursor + 1e-9) spans.push({ start: cursor, end: range.start })
      cursor = Math.max(cursor, range.end)
    }
    if (cursor < clip - 1e-9) spans.push({ start: cursor, end: clip })
    spans.sort((a, b) => b.end - b.start - (a.end - a.start))
    const target = spans[0]
    if (!target || target.end - target.start < 2) {
      useCanvasStore.getState().toast('neutral', 'No uncovered span is long enough to paint — drag an existing boundary instead.')
      return
    }
    const start = Number(target.start.toFixed(3))
    const end = Number(Math.min(target.end, start + 3).toFixed(3))
    const base = doc ?? newLoraTimelineDoc()
    onChange({ ...base, ranges: [...base.ranges, newLoraRange(base.ranges.length, start, end)] })
  }

  const patchRange = (id: string, part: Partial<{ start: number; end: number; loras: LoraStackEntry[] }>) =>
    onChange({ ...timeline, ranges: timeline.ranges.map((range) => range.id === id ? { ...range, ...part } : range) })

  const dragBoundaryTo = (rightIndex: number, seconds: number) => {
    const left = sorted[rightIndex - 1]
    const right = sorted[rightIndex]
    if (!left || !right) return
    const snapped = snapRangeBoundary(seconds, left.start, right.end)
    if (snapped === null) return
    const position = Number(snapped.toFixed(3))
    onChange({
      ...timeline,
      ranges: timeline.ranges.map((range) => {
        if (range.id === left.id) return { ...range, end: position }
        if (range.id === right.id) return { ...range, start: position }
        return range
      }),
    })
  }

  const setGap = (afterRangeId: string, kind: string, widthSeconds: number) => {
    const next = timeline.transitions.filter((entry) => entry.afterRangeId !== afterRangeId)
    if (kind !== 'cut') next.push({ afterRangeId, kind: kind as PlanGapKind, widthSeconds })
    onChange({ ...timeline, transitions: next })
  }

  const apply = async () => {
    if (!compile.ok || applying) return
    setApplying(true)
    setFailure([])
    try {
      await flush()
      const result = await useCanvasStore.getState().applyLoraTimeline(chainId)
      if (!result.ok && result.reasons) setFailure(result.reasons)
    } finally {
      setApplying(false)
    }
  }

  const loraOptions = [''].concat(loraNames)

  return <section className="canvas-properties-section canvas-lora-timeline" data-canvas-section="lora-timeline">
    <label>LoRA timeline <span className="canvas-properties-hint">paint ranges · 17n+5 grid</span></label>

    {/* The rail: painted ranges above, the compiled segment layout + transition
        windows below — the projection IS the review gate. */}
    <svg
      className="canvas-lora-rail" data-canvas-lora-rail viewBox="0 0 320 68" role="img"
      aria-label="LoRA timeline rail — painted ranges and the compiled segment layout"
      ref={railRef}
      onPointerMove={(event) => { if (dragRange !== null) dragBoundaryTo(dragRange, secondsFromClientX(event.clientX)) }}
      onPointerUp={() => setDragRange(null)}
      onPointerLeave={() => setDragRange(null)}
    >
      <rect x={LORA_RAIL.pad} y={LORA_RAIL.paintedY} width={LORA_RAIL.width} height={LORA_RAIL.paintedH} rx={3} className="canvas-lora-rail-base" />
      {sorted.map((range, index) => {
        const x = xOf(range.start)
        const width = Math.max(2, xOf(range.end) - x)
        return <g key={range.id} data-canvas-lora-block={index} className={range.loras.length ? 'canvas-lora-block painted' : 'canvas-lora-block empty'}>
          <rect x={x} y={LORA_RAIL.paintedY} width={width} height={LORA_RAIL.paintedH} rx={2} />
          {width > 34 && <text x={x + 4} y={LORA_RAIL.paintedY + 12}>{range.loras.length ? range.loras.map((lora) => lora.name.split('/').pop()?.replace(/\.safetensors$/i, '')).join('+') : 'base'}</text>}
          {index > 0 && <rect
            className="canvas-lora-handle"
            data-canvas-lora-handle={index}
            x={x - 3} y={LORA_RAIL.paintedY - 2} width={6} height={LORA_RAIL.paintedH + 4} rx={2}
            style={{ cursor: 'ew-resize' }}
            onPointerDown={(event) => {
              event.preventDefault()
              setDragRange(index)
              try { (event.currentTarget as SVGRectElement).setPointerCapture?.(event.pointerId) } catch { /* best-effort capture */ }
            }}
          />}
        </g>
      })}
      {compile.ok && <>
        {compile.segments.map((segment, index) => {
          const x = xOf(segment.startSeconds)
          const width = Math.max(1.5, xOf(segment.endSeconds) - x)
          return <rect key={segment.id} data-canvas-lora-seg={index} className={`canvas-lora-seg${segment.loras.length ? ' painted' : ''}`} x={x} y={LORA_RAIL.layoutY} width={width} height={LORA_RAIL.layoutH} rx={2}>
            <title>{`${segment.title} · ${segment.durationSeconds.toFixed(2)}s · ${segment.frames} frames`}</title>
          </rect>
        })}
        {compile.segments.map((segment, index) => {
          if (!segment.gapAfter || segment.gapAfter.widthSeconds <= 0) return null
          const center = xOf(segment.endSeconds)
          const halfWidth = Math.max(1.5, (segment.gapAfter.widthSeconds / clip) * LORA_RAIL.width / 2)
          return <rect key={`${segment.id}-window`} data-canvas-lora-window={index} className="canvas-lora-window" x={center - halfWidth} y={LORA_RAIL.layoutY - 2} width={halfWidth * 2} height={LORA_RAIL.layoutH + 4} rx={2}>
            <title>{`${GAP_LABEL[segment.gapAfter.kind]} window · ${segment.gapAfter.widthSeconds.toFixed(2)}s`}</title>
          </rect>
        })}
        <text x={LORA_RAIL.pad} y={LORA_RAIL.labelsY} className="canvas-lora-rail-label">0s</text>
        <text x={LORA_RAIL.pad + LORA_RAIL.width / 2} y={LORA_RAIL.labelsY} textAnchor="middle" className="canvas-lora-rail-label">{(clip / 2).toFixed(1)}s</text>
        <text x={LORA_RAIL.pad + LORA_RAIL.width} y={LORA_RAIL.labelsY} textAnchor="end" className="canvas-lora-rail-label">{clip.toFixed(1)}s</text>
      </>}
    </svg>
    <p className="canvas-properties-note">painted ranges above · compiled segments + transition windows below · drag boundaries (grid-snapped){formAdapterInstalled ? ' · slot 1 rides the form adapter' : ''}</p>

    {/* Range rows: the LoRA set + strength per painted range. */}
    <div className="canvas-lora-ranges" data-canvas-lora-ranges>
      {sorted.map((range, index) => {
        const combined = range.loras.reduce((sum, lora) => sum + lora.strength, 0)
        return <div className="canvas-lora-range" data-canvas-lora-range={index} key={range.id}>
          <div className="canvas-lora-range-slots">
            {Array.from({ length: LORA_SLOTS }, (_, slot) => {
              const entry = range.loras[slot]
              const disabled = slot > 0 && !range.loras[slot - 1]
              return <span className="canvas-lora-slot" key={slot}>
                <select
                  data-canvas-lora-name={slot}
                  aria-label={`Range ${index + 1} LoRA ${slot + 1}`}
                  value={entry?.name ?? ''}
                  disabled={disabled}
                  onChange={(event) => {
                    const name = event.target.value
                    const loras = range.loras.slice(0, LORA_SLOTS)
                    if (!name) loras.splice(slot, 1)
                    else if (slot < loras.length) loras[slot] = { name, strength: loras[slot].strength }
                    else loras.push({ name, strength: 1 })
                    patchRange(range.id, { loras })
                  }}
                >
                  {loraOptions.map((name) => <option key={name || 'none'} value={name}>{name || `LoRA ${slot + 1}…`}</option>)}
                </select>
                {entry && <input
                  type="number" min={0} max={2} step={0.05}
                  data-canvas-lora-strength={slot}
                  aria-label={`Range ${index + 1} LoRA ${slot + 1} strength`}
                  value={entry.strength}
                  onChange={(event) => {
                    const value = Number(event.target.value)
                    if (!Number.isFinite(value)) return
                    const loras = range.loras.slice(0, LORA_SLOTS)
                    loras[slot] = { name: entry.name, strength: Math.min(2, Math.max(0, value)) }
                    patchRange(range.id, { loras })
                  }}
                />}
              </span>
            })}
          </div>
          <div className="canvas-lora-range-span">
            <input type="number" min={0} max={clip} step={0.25} data-canvas-lora-start aria-label={`Range ${index + 1} start seconds`} value={range.start}
              onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) patchRange(range.id, { start: Math.min(clip, Math.max(0, value)) }) }} />
            <span>→</span>
            <input type="number" min={0} max={clip} step={0.25} data-canvas-lora-end aria-label={`Range ${index + 1} end seconds`} value={range.end}
              onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) patchRange(range.id, { end: Math.min(clip, Math.max(0, value)) }) }} />
            <span className="canvas-lora-range-note">{(range.end - range.start).toFixed(2)}s</span>
            <button type="button" className="icon-button" aria-label={`Remove range ${index + 1}`} data-canvas-lora-remove onClick={() => onChange({ ...timeline, ranges: timeline.ranges.filter((entry) => entry.id !== range.id), transitions: timeline.transitions.filter((entry) => entry.afterRangeId !== range.id) })}><X size={11} /></button>
          </div>
          {range.loras.length === LORA_SLOTS && <p className={`canvas-lora-combined${combined >= LORA_COMBINED_COLLAPSE_RISK ? ' risk' : combined > LORA_COMBINED_HEALTHY_MAX ? ' warn' : ''}`}>combined strength {combined.toFixed(2)} {combined >= LORA_COMBINED_COLLAPSE_RISK ? '· collapse-risk band' : combined > LORA_COMBINED_HEALTHY_MAX ? '· above the healthy band' : '· healthy'}</p>}
        </div>
      })}
      <div className="canvas-lora-toolbar">
        <button type="button" className="canvas-chip" data-canvas-lora-paint onClick={paintRange}>+ paint range</button>
        {doc && <button type="button" className="canvas-chip" data-canvas-lora-clear onClick={() => onChange(null)}>clear</button>}
      </div>
    </div>

    {/* Boundary transitions: the measured gap kinds + user-settable windows.
        Only non-cut choices persist (a missing record IS the cut default). */}
    {compile.ok && compile.segments.length > 1 && <div className="canvas-lora-gaps" data-canvas-lora-gaps>
      {compile.segments.slice(0, -1).map((segment, index) => {
        const gap = segment.gapAfter!
        return <div className="canvas-lora-gap" data-canvas-lora-gap={index} key={segment.id}>
          <span className="canvas-lora-gap-label" title={`${segment.title} → ${compile.segments[index + 1].title}`}>{segment.title} →</span>
          <select data-canvas-lora-gap-kind aria-label={`Transition after segment ${index + 1}`} value={gap.kind}
            onChange={(event) => setGap(segment.rangeId, event.target.value, Math.round(DEFAULT_TRANSITION_WINDOW[event.target.value as keyof typeof DEFAULT_TRANSITION_WINDOW] * 100) / 100)}>
            {GAP_KINDS.map((kind) => <option key={kind} value={kind}>{GAP_LABEL[kind]}</option>)}
          </select>
          <input type="number" min={0} max={3} step={0.05} data-canvas-lora-gap-width aria-label={`Transition window seconds after segment ${index + 1}`}
            value={gap.widthSeconds} disabled={gap.kind === 'cut'}
            onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 0) setGap(segment.rangeId, gap.kind, Math.min(3, value)) }} />
          <span className="canvas-lora-gap-note">s window</span>
        </div>
      })}
    </div>}

    {/* The live compile — the review gate. An unpainted clip shows the intro
        note (not an error — the user has not authored anything yet); once a
        range exists, every refusal reason surfaces. */}
    {compile.ok
      ? <p className="canvas-properties-note" data-canvas-lora-compile>{compile.segments.length} segment{compile.segments.length === 1 ? '' : 's'} · {compile.totalSeconds.toFixed(2)}s planned (grid-conformed){compile.warnings.length ? ` · ${compile.warnings.length} note${compile.warnings.length === 1 ? '' : 's'}` : ''}</p>
      : doc
        ? <ul className="canvas-properties-warning" data-canvas-lora-errors role="alert">{compile.reasons.map((reason, index) => <li key={index} data-canvas-lora-error={index}>{reason}</li>)}</ul>
        : <p className="canvas-properties-note">Paint LoRA ranges over this clip — the compiler generates one chain per range, grid-conformed (17n+5) and joined by measured transitions. Nothing submits until you generate.</p>}
    {compile.ok && compile.warnings.length > 0 && <ul className="canvas-lora-warnings" data-canvas-lora-warnings>{compile.warnings.map((warning, index) => <li key={index} data-canvas-lora-warning={index}>{warning}</li>)}</ul>}
    {failure.length > 0 && <ul className="canvas-properties-warning" role="alert">{failure.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
    <div className="canvas-lora-actions">
      <button type="button" className="canvas-chip primary" data-canvas-lora-apply disabled={!compile.ok || applying} title="Compile the ranges into a Director Suite plan and seed one chain per segment (nothing auto-submits)"
        onClick={() => void apply()}>{applying ? 'compiling…' : `compile → ${compile.ok ? compile.segments.length : '—'} segments`}</button>
    </div>
  </section>
}

export function PropertiesPanel() {
  const open = useCanvasStore((state) => state.inspectorOpen)
  const setInspectorOpen = useCanvasStore((state) => state.setInspectorOpen)
  const selection = useCanvasStore((state) => state.selection)
  const documents = useCanvasStore((state) => state.documents)
  const activeProjectId = useCanvasStore((state) => state.activeProjectId)
  const tiles = useCanvasStore((state) => state.tiles)
  const libraries = useCanvasStore((state) => state.libraries)
  const assets = useCanvasStore((state) => state.assets)
  const bindGlobalAsset = useCanvasStore((state) => state.bindGlobalAsset)
  const chainBindings = useCanvasStore((state) => state.chainBindings)
  const setChainSettings = useCanvasStore((state) => state.setChainSettings)
  const setChainIdentity = useCanvasStore((state) => state.setChainIdentity)
  const submitChain = useCanvasStore((state) => state.submitChain)
  const validateChain = useCanvasStore((state) => state.validateChain)
  const cancelChainJob = useCanvasStore((state) => state.cancelChainJob)

  const models = useSessionStore((state) => state.models)
  const info = useSessionStore((state) => state.info)
  const ollamaModels = useSessionStore((state) => state.ollamaModels)

  const chainId = selection.tileIds.length === 1 ? selection.tileIds[0] : null
  const doc = activeProjectId ? documents[activeProjectId] : null
  const chain: DocumentChain | null = chainId && doc ? doc.chains.find((entry) => entry.id === chainId) ?? null : null
  const tile = chainId ? tiles.find((entry) => entry.id === chainId) ?? null : null

  const [draft, setDraft] = useState<CanvasChainSettings | null>(null)
  const [subjectText, setSubjectText] = useState('')
  const [strength, setStrength] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  // Phase 4: the CreateView capabilities this panel absorbs.
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [promptingTool, setPromptingTool] = useState<'enhance' | 'timeline' | 'audio' | null>(null)
  const [promptSuggestion, setPromptSuggestion] = useState('')
  const [captioningIndex, setCaptioningIndex] = useState<number | null>(null)
  const [captionNotice, setCaptionNotice] = useState<string | null>(null)
  const promptStreamTarget = useRef<HTMLDivElement>(null)
  const promptRef = useRef<SmartPromptEditorHandle>(null)
  const llmStream = useLlmStream()

  // The last server state THIS panel adopted or committed. A concurrent
  // document reload (a take landing, another surface editing, an identity
  // commit) must never wipe in-flight local edits: the server value is
  // adopted ONLY when it differs from what we last knew — and never while
  // the draft has moved past it.
  const knownRef = useRef<{ chainId: string; settings: string; subjectText: string; strength: number } | null>(null)
  useEffect(() => {
    if (!chain) {
      setDraft(null)
      knownRef.current = null
      return
    }
    const settings = readChainSettings(chain.settings, useSessionStore.getState().settings)
    const incomingSubject = chain.identity?.subjectText ?? ''
    const incomingStrength = chain.identity?.strength ?? 1
    const known = knownRef.current
    const serverSettings = JSON.stringify(settings)
    const chainSwitched = !known || known.chainId !== chain.id
    // Outside edits (another surface changed this chain): adopt when the
    // server state moved away from what we last committed/adopted AND the
    // local draft hasn't diverged past it (a diverged draft is the user's
    // newer truth; its own commit lands momentarily).
    const settingsChanged = !chainSwitched && known.settings !== serverSettings && JSON.stringify(draft) === known.settings
    if (chainSwitched || settingsChanged) {
      knownRef.current = { chainId: chain.id, settings: serverSettings, subjectText: incomingSubject, strength: incomingStrength }
      setDraft(settings)
      setSubjectText(incomingSubject)
      setStrength(incomingStrength)
    } else if (known && (known.subjectText !== incomingSubject || Math.abs(known.strength - incomingStrength) > 1e-9) && known.subjectText === subjectText) {
      knownRef.current = { chainId: chain.id, settings: known.settings, subjectText: incomingSubject, strength: incomingStrength }
      setSubjectText(incomingSubject)
      setStrength(incomingStrength)
    }
  }, [chain, draft, subjectText])

  useDebouncedCommit(draft, !draft || !chainId, (value) => {
    if (!chainId || !value) return
    const known = knownRef.current
    if (known && known.chainId === chainId && known.settings === JSON.stringify(value)) return // no-op edit: never reload for nothing
    if (known && known.chainId === chainId) knownRef.current = { ...known, settings: JSON.stringify(value) }
    void setChainSettings(chainId, value)
  })
  useDebouncedCommit(subjectText, !chain, (value) => {
    if (!chainId) return
    const known = knownRef.current
    if (known && known.chainId === chainId && known.subjectText === value) return
    if (known && known.chainId === chainId) knownRef.current = { ...known, subjectText: value }
    void setChainIdentity(chainId, { subjectText: value })
  }, 700)
  useDebouncedCommit(strength, !chain, (value) => {
    if (!chainId) return
    const known = knownRef.current
    if (known && known.chainId === chainId && Math.abs(known.strength - value) < 1e-9) return
    if (known && known.chainId === chainId) knownRef.current = { ...known, strength: value }
    void setChainIdentity(chainId, { strength: value })
  }, 300)

  // Structured mode (fh94g76): a duration change re-clips the flow ranges —
  // recompose the concat once per duration change (never on box edits, which
  // compose inline in applyStructured).
  const lastComposedDuration = useRef<number | null>(null)
  useEffect(() => {
    if (!draft || !chainId) return
    if (draft.promptMode !== 'structured' || !draft.structured) {
      lastComposedDuration.current = null
      return
    }
    if (lastComposedDuration.current === draft.duration) return
    lastComposedDuration.current = draft.duration
    const composed = composeStructuredPrompt(draft.structured, { duration: draft.duration })
    setDraft((current) => current && current.prompt !== composed ? { ...current, prompt: composed } : current)
  }, [draft, chainId])

  // Structured mode with a missing/malformed persisted draft (legacy data):
  // the no-loss parse stands in — memoized so the parse (and its generated
  // ids) stay stable across renders while the prompt is unchanged.
  const structuredDraft = useMemo(
    () => (draft && draft.promptMode === 'structured') ? (draft.structured ?? parseStructuredPrompt(draft.prompt)) : null,
    [draft],
  )

  const turboFamilies = useMemo(() => detectOptimizations(info, models).filter((entry) => entry.entry.kind === 'turbo'), [info, models])
  // Bindings + validation recompute per render on purpose: validation reads
  // the PERSISTED settings (which lag the draft by the debounce), so the
  // message updates as commits land. Both are cheap single-chain walks.
  const bindings = chainId ? chainBindings(chainId) : []
  const validation = chainId ? validateChain(chainId) : null

  if (!open || !chain || !draft || !tile) return null

  const patch = (part: Partial<CanvasChainSettings>) => setDraft((current) => current ? { ...current, ...part } : current)
  const mode = effectiveMode(draft)
  // ---- Chain-level model overrides (task euxwdva) ----
  // The chain's engine decides the family; picks are scan-anchored and ride
  // chain.settings (settings-vs-results separation: the RESOLVED files ride
  // the take's manifest). Resolution order: this pick > the global Settings
  // pick > auto (inference).
  const modelFamilyId: ModelFamilyId = draft.mediaType === 'audio'
    ? (draft.audio.engine === 'acestep' ? 'acestep' : 'music3')
    : draft.engine === 'ltx25' ? 'ltx25' : 'minimax'
  const modelFamily = modelFamilyInfo(modelFamilyId)!
  // Legacy chains may still store a single 'checkpoint' pick — the migrated
  // view keeps it VISIBLE on its new lanes (the resolution seam applies the
  // same migration at submit time).
  const chainSlots = migrateLegacyModelOverrideSlots(modelFamilyId, draft.modelOverrides ?? {})
  const setChainModelOverride = (slot: ModelOverrideSlotName, value: string) => {
    const next: ModelOverrideSlots = { ...(draft.modelOverrides ?? {}) }
    if (value) next[slot] = value
    else delete next[slot]
    patch({ modelOverrides: next })
  }
  const referenceSlots = bindings.length
  const guideWarnings = draft.timelineGuides.map((guide) => guideFrameWarning(guide.seconds, draft.duration)).filter(Boolean) as string[]

  const generate = async () => {
    if (!chainId || submitting) return
    setSubmitting(true)
    try {
      // Commit the draft immediately — submit reads the persisted settings.
      await setChainSettings(chainId, draft)
      await submitChain(chainId)
    } finally {
      setSubmitting(false)
    }
  }

  // ---- The structured ⇄ freeform toggle (fh94g76, spec §4) ----
  // `prompt` stays the engine's single source of truth: in structured mode
  // every box edit composes into it; toggling never rewrites it (AC 1 — the
  // string only changes when a box changes).
  const setPromptMode = (next: 'freeform' | 'structured') => {
    if (!draft || draft.promptMode === next) return
    if (next === 'structured') {
      // Switching to structured starts from the parse — deterministic, never
      // lossy. When the stored draft is still the concat of the current
      // string (no freeform edits since), it restores the exact boxes.
      const stored = draft.structured
      const inSync = stored && composeStructuredPrompt(stored, { duration: draft.duration }) === draft.prompt
      patch({ promptMode: 'structured', structured: inSync ? stored : parseStructuredPrompt(draft.prompt) })
    } else {
      // Switching back yields the concat (spec §4): while structured, prompt
      // IS compose(structured) — every box edit recomposes, so the freeform
      // surface shows exactly that string.
      patch({ promptMode: 'freeform' })
    }
  }

  /** Every structured edit re-composes: the submitted string is byte-what-
   *  the-freeform-path-would-send (the concat contract). */
  const applyStructured = (next: StructuredPromptDraft) => {
    patch({ structured: next, prompt: composeStructuredPrompt(next, { duration: draft?.duration ?? 6 }) })
  }

  // ---- Phase 4: the local-LLM prompt tools (the CreateView absorption) ----
  const llmDescriptor = useSessionStore.getState().llm
  const llmAvailable = llmDescriptor ? llmDescriptor.connected && Boolean(llmDescriptor.model) : ollamaModels.length > 0

  const runPromptTool = async (tool: 'enhance' | 'timeline' | 'audio') => {
    if (!chainId || !draft || promptingTool) return
    if (!llmAvailable) {
      setCaptionNotice(null)
      useCanvasStore.getState().toast('error', 'No local text model is available. Connect the llama.cpp router or Ollama in Settings.')
      return
    }
    if (!draft.prompt.trim()) {
      useCanvasStore.getState().toast('error', 'Write a rough prompt first, then ask the local assistant to refine it.')
      return
    }
    // 2026-09-18 retirement (spec AC 4): the timeline tool no longer appends
    // prose to the prompt — it fills the Flow box of the structured editor.
    // The switch below runs the deterministic no-loss parse; the suggestion
    // panel's "fill Flow box" appends the parsed timed rows.
    if (tool === 'timeline' && draft.promptMode !== 'structured') setPromptMode('structured')
    const referenceMap = bindings.length
      ? bindings.map((binding, index) => `<Picture ${index + 1}> = ${binding.label}`)
      : undefined
    setPromptingTool(tool)
    setPromptSuggestion('')
    try {
      await new Promise((resolvePaint) => requestAnimationFrame(() => requestAnimationFrame(resolvePaint)))
      const full = await llmStream.stream({
        task: tool,
        targetEngine: 'minimax-h3',
        length: 'standard',
        instructions: buildPromptAssistantContext(tool, { duration: draft.duration, mode, referenceMap, noDialogue: draft.noDialogue }),
        draft: draft.prompt,
        target: promptStreamTarget.current,
      })
      setPromptSuggestion(full.trim())
    } catch (error) {
      useCanvasStore.getState().toast('error', error instanceof Error ? error.message : String(error))
    } finally {
      setPromptingTool(null)
    }
  }

  /** The retired timeline tool's landing: the suggestion's timed-shot text
   *  parses into flow rows (same grammar compose emits) and appends to the
   *  Flow box; the prompt recomposes. Reads state through setDraft so a
   *  concurrent box edit can never be clobbered. */
  const fillFlowFromSuggestion = () => {
    if (!promptSuggestion) return
    setDraft((current) => {
      if (!current) return current
      const base = current.promptMode === 'structured' && current.structured ? current.structured : parseStructuredPrompt(current.prompt)
      const next: StructuredPromptDraft = { ...base, flow: [...base.flow, ...parseFlowRows(promptSuggestion)] }
      return { ...current, promptMode: 'structured', structured: next, prompt: composeStructuredPrompt(next, { duration: current.duration }) }
    })
    setPromptSuggestion('')
  }

  // Vision captioning of a bound reference picture (the local vision model
  // describes it; the description inserts as a <Picture N> line).
  const captionReference = async (index: number) => {
    const binding = bindings[index]
    if (!binding || captioningIndex !== null) return
    setCaptioningIndex(index)
    setCaptionNotice(null)
    try {
      const dataUrl = await window.minimax.fileDataUrl(binding.file.path)
      const { caption, model } = await window.minimax.llmCaptionImage(dataUrl)
      promptRef.current?.insert(`<Picture ${index + 1}> ${caption}`)
      setCaptionNotice(`Described Picture ${index + 1} with ${model} — inserted into the prompt.`)
    } catch (error) {
      setCaptionNotice(error instanceof Error ? error.message : String(error))
    } finally {
      setCaptioningIndex(null)
    }
  }

  return <Rnd
    className="canvas-inspector canvas-properties"
    data-canvas-inspector
    data-canvas-properties
    default={{ x: window.innerWidth - 396, y: 64, width: 356, height: Math.min(760, window.innerHeight - 140) }}
    minWidth={300}
    minHeight={240}
    bounds="parent"
    dragHandleClassName="canvas-inspector-header"
    enableResizing={{ bottom: true, bottomRight: true, right: true, bottomLeft: false, topLeft: false, topRight: false, left: false, top: false }}
  >
    <header className="canvas-inspector-header">
      <strong>{tile.title}</strong>
      <span className="canvas-properties-mode" data-canvas-mode={mode}>{MODE_LABEL[mode]}</span>
      <button type="button" aria-label="Close properties" onClick={() => setInspectorOpen(false)}><X size={13} /></button>
    </header>
    <div className="canvas-inspector-body canvas-properties-body">
      <section className="canvas-properties-section" data-canvas-section="prompt">
        <label>Prompt <span className="canvas-properties-hint">// presets</span></label>
        {/* The structured ⇄ freeform toggle (fh94g76): a first-class co-equal
            mode — same submit path, the concat contract keeps the engine
            string identical. */}
        <div className="canvas-properties-promptmode" role="radiogroup" aria-label="Prompt mode" data-canvas-prompt-mode={draft.promptMode}>
          <button type="button" role="radio" aria-checked={draft.promptMode === 'freeform'} data-canvas-prompt-mode-toggle="freeform" className={draft.promptMode === 'freeform' ? 'active' : ''} onClick={() => setPromptMode('freeform')}>freeform</button>
          <button type="button" role="radio" aria-checked={draft.promptMode === 'structured'} data-canvas-prompt-mode-toggle="structured" className={draft.promptMode === 'structured' ? 'active' : ''} onClick={() => setPromptMode('structured')}>structured</button>
        </div>
        {draft.promptMode === 'structured' ? (
          <StructuredPromptEditor
            draft={structuredDraft!}
            duration={draft.duration}
            mode={mode}
            noDialogue={draft.noDialogue}
            composed={draft.prompt}
            llmAvailable={llmAvailable}
            llmStream={llmStream}
            referenceImageShape={(() => {
              // The camera compiler's loop-closure contract needs a connected
              // reference image; text chains have none. The shape is all the
              // pure compiler reads (imageAspect) — derive it from the chain
              // resolution for the image-bearing modes.
              if (mode === 'text') return null
              const [width, height] = (draft.resolution || '1344x768').split('x').map(Number)
              return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 ? { shape: [1, height, width, 3] } : null
            })()}
            pinSources={{
              characters: libraries.characters.map((character) => ({ id: character.id, name: character.name })),
              assets: assets.map((asset) => ({ id: asset.id, label: asset.label, kind: asset.kind })),
              identitySubjectText: chain.identity?.subjectText ?? '',
            }}
            notify={(tone, text) => useCanvasStore.getState().toast(tone, text)}
            onChange={applyStructured}
          />
        ) : (
          <SmartPromptEditor
            ref={promptRef}
            id={`canvas-prompt-${chain.id}`}
            value={draft.prompt}
            onChange={(prompt) => patch({ prompt })}
            placeholder="Describe the shot… type // for production presets"
            ariaLabel="Chain prompt"
          />
        )}
        {/* Phase 4 (§5.5 + L11): the prompt surfaces CreateView carried — the
            local-LLM tools and the community prompt library, properties-side.
            In structured mode the boxes own their content (per-box assists
            replace the whole-prompt tools); the timeline tool is retired into
            the Flow box everywhere (2026-09-18, spec AC 4). */}
        <div className="canvas-properties-prompttools" data-canvas-prompt-tools>
          {draft.promptMode === 'freeform' && (
            <>
              <button type="button" data-canvas-prompt-tool="enhance" disabled={!llmAvailable || Boolean(promptingTool)} title={!llmAvailable ? 'Connect a local text model (llama.cpp router or Ollama) in Settings — nothing leaves this workstation' : 'Rewrite the prompt for stronger MiniMax video direction'} onClick={() => void runPromptTool('enhance')}>
                {promptingTool === 'enhance' ? <LoaderCircle size={12} className="spin" /> : <WandSparkles size={12} />} enhance
              </button>
              <button type="button" data-canvas-prompt-tool="audio" disabled={!llmAvailable || Boolean(promptingTool)} title={!llmAvailable ? 'Connect a local text model in Settings' : 'Improve ambience, dialogue, and sound cues'} onClick={() => void runPromptTool('audio')}>
                {promptingTool === 'audio' ? <LoaderCircle size={12} className="spin" /> : <Volume2 size={12} />} audio pass
              </button>
            </>
          )}
          <button type="button" data-canvas-prompt-tool="timeline" disabled={!llmAvailable || Boolean(promptingTool)} title={!llmAvailable ? 'Connect a local text model in Settings' : 'Retired 2026-09-18: fills the structured editor\'s Flow box with timed beats (no longer appends prompt text)'} onClick={() => void runPromptTool('timeline')}>
            {promptingTool === 'timeline' ? <LoaderCircle size={12} className="spin" /> : <Clock3 size={12} />} timeline → Flow
          </button>
          <button type="button" data-canvas-prompt-library title="Search public Civitai generation metadata for reusable prompts" onClick={() => setLibraryOpen(true)}>
            <Sparkles size={12} /> library
          </button>
        </div>
        {promptingTool && <div className="canvas-llm-stream" ref={promptStreamTarget} role="status" aria-label="Local assistant streaming" data-canvas-llm-stream />}
        {promptSuggestion && (
          <div className="canvas-prompt-suggestion" data-canvas-prompt-suggestion role="status">
            <span className="canvas-prompt-suggestion-label">Local suggestion</span>
            <textarea aria-label="Local prompt suggestion" value={promptSuggestion} readOnly rows={3} />
            <div className="canvas-prompt-suggestion-actions">
              <button type="button" onClick={() => setPromptSuggestion('')}>dismiss</button>
              {promptingTool === 'timeline' || draft.promptMode === 'structured' ? (
                <button type="button" className="primary" data-canvas-prompt-suggestion-flow onClick={fillFlowFromSuggestion}>fill Flow box</button>
              ) : (
                <button type="button" className="primary" onClick={() => { patch({ prompt: promptSuggestion }); setPromptSuggestion('') }}>use suggestion</button>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="canvas-properties-section" data-canvas-section="engine">
        <label>Engine — {draft.mediaType === 'audio' ? (draft.audio.engine === 'music3' ? 'MiniMax Music 3' : 'ACE-Step XL 1.5') : draft.mediaType === 'image' ? (IMAGE_ENGINES.find((engine) => engine.id === draft.imageEngine) ?? IMAGE_ENGINES[0]).label : draft.engine === 'ltx25' ? 'LTX-2.5 general' : 'MiniMax H3'}</label>
        {draft.mediaType === 'image' && (
          <p className="canvas-properties-note" data-canvas-image-engine-note>
            {IMAGE_ENGINES.find((engine) => engine.id === draft.imageEngine)?.note ?? IMAGE_ENGINES[0].note} The image intent renders one H3-1F still per take; image-with-reference hands off to the workbench's Edit surface.
          </p>
        )}
        {draft.mediaType === 'audio' && (
          <div className="canvas-properties-row">
            <button type="button" className="canvas-chip" data-canvas-open-audio-dock onClick={() => useCanvasStore.getState().setAudioDock({ engine: draft.audio.engine, chainId: chain.id })}>
              edit in the audio dock…
            </button>
          </div>
        )}
        {draft.engine === 'ltx25' && draft.mediaType === 'video' && (
          <p className="canvas-properties-note" data-canvas-engine-note>
            This chain renders through the LTX-2.5 general engine (the workspace retired — the engine lives on as this op). Tier selects quality vs turbo; the first frame rides the LTX image conditioning.
          </p>
        )}
        <div className="canvas-properties-row">
          <span>tier</span>
          <div className="canvas-properties-tiers" role="radiogroup" aria-label="Speed tier">
            {TIERS.map((tier) => (
              <button
                type="button"
                key={tier.value}
                role="radio"
                aria-checked={draft.turbo === tier.value}
                className={`canvas-chip ${draft.turbo === tier.value ? 'active' : ''}`}
                data-canvas-tier={tier.value}
                onClick={() => patch({ turbo: tier.value })}
              >
                {tier.label} <small>{tier.note}</small>
              </button>
            ))}
          </div>
        </div>
        <div className="canvas-properties-row">
          <label htmlFor="canvas-turbo-family">turbo family</label>
          <select id="canvas-turbo-family" data-canvas-family value={draft.turboFamily} onChange={(event) => patch({ turboFamily: event.target.value })}>
            <option value="">auto — registry-ranked</option>
            {turboFamilies.map(({ entry, detection }) => (
              <option key={entry.id} value={entry.id}>{entry.label}{detection.available ? '' : ' (not installed)'}</option>
            ))}
          </select>
        </div>
        {/* Model overrides (euxwdva): collapsed by default — 'auto' (with
            what auto currently resolves to) is the honest default state.
            Image chains are excluded: they render through the image
            workbench, whose model selection is the h3image GLOBAL picks
            (chain-level slots here would be dead controls on that path). */}
        {draft.mediaType !== 'image' && <details className="canvas-properties-models" data-canvas-section="models">
          <summary>models <span className="canvas-properties-hint">{modelFamily.label} · auto (inferred)</span></summary>
          {modelFamily.slots.map((slot) => {
            const value = chainSlots[slot] ?? ''
            const kind = modelFamily.slotKinds[slot] ?? 'diffusion_models'
            const candidates = models.filter((model) => model.kind === kind)
            const globalPick = useSessionStore.getState().settings?.modelOverrides?.[modelFamilyId]?.[slot]
            const autoFile = inferredOverrideSlotFile(modelFamilyId, slot, models)
            // (tmz8vh7): the verdict runs on the EFFECTIVE pick — the chain's
            // own, else the global Settings one. Verdicting only the chain's
            // pick rendered a refusing GLOBAL pick as an innocent "auto —
            // global: X" label while every submit refused with no pointer to
            // where the pick lives (audit P1-1's UX wedge).
            const layer: 'chain' | 'global' | null = value ? 'chain' : globalPick ? 'global' : null
            const outcome = (value || globalPick) ? overridePickOutcome(modelFamilyId, slot, value || globalPick || '', models) : null
            return <div className="canvas-properties-row" key={slot} data-canvas-model-override={slot}>
              <label htmlFor={`canvas-model-${slot}`}>{SLOT_LABELS[slot]}</label>
              <select id={`canvas-model-${slot}`} data-canvas-model-override-select={slot} value={value} onChange={(event) => setChainModelOverride(slot, event.target.value)}>
                <option value="">{globalPick ? `auto — global: ${globalPick}` : autoFile ? `auto — ${autoFile}` : 'auto — nothing detected'}</option>
                {candidates.map((model) => <option key={model.name} value={model.name}>{model.name}</option>)}
              </select>
              {outcome?.state === 'refused' && <p className="canvas-properties-warning" data-canvas-model-override-problem role="alert">Refused {layer === 'global' ? '(the global Settings pick — clear it in Settings → Model overrides)' : '(this chain\'s pick — clear it to render on auto)'} — {outcome.reason}</p>}
              {outcome?.state === 'degraded' && <p className="canvas-properties-warning" data-canvas-model-override-problem role="status">{layer === 'global' ? 'The global Settings pick ' : 'This chain\'s pick '}{outcome.warning}</p>}
              {outcome?.state === 'applied' && outcome.warning && <p className="canvas-properties-warning" data-canvas-model-override-problem role="status">{layer === 'global' ? 'The global Settings pick ' : 'This chain\'s pick '}{outcome.warning}</p>}
            </div>
          })}
          <p className="canvas-properties-note">A pick here beats the global Settings pick, which beats auto inference. Picks are exact scanned filenames; the resolved files ride the take's manifest. The H3 lanes pin FL2VA / Ref2VA separately; the merged pick is one pre-merged checkpoint for both and wins when set. The VAE picks are decoder-specific (video / audio) — the image decoder is workbench-only.</p>
        </details>}
        <div className="canvas-properties-row">
          <label htmlFor="canvas-duration">seconds</label>
          <input id="canvas-duration" data-canvas-duration type="number" min={2} max={15} step={1} value={draft.duration} onChange={(event) => patch({ duration: Math.max(2, Math.min(15, Number(event.target.value) || 6)) })} />
          <label htmlFor="canvas-resolution">size</label>
          <select id="canvas-resolution" data-canvas-resolution value={draft.resolution} onChange={(event) => patch({ resolution: event.target.value })}>
            {RESOLUTIONS.map((resolution) => <option key={resolution} value={resolution}>{resolution.replace('x', ' × ')}</option>)}
          </select>
        </div>
        <div className="canvas-properties-row">
          <label htmlFor="canvas-seed">seed</label>
          <input id="canvas-seed" data-canvas-seed type="number" min={0} value={draft.seed} onChange={(event) => patch({ seed: Math.max(0, Math.floor(Number(event.target.value) || 0)) })} />
          <button type="button" className="canvas-chip" aria-label="Randomize seed" onClick={() => patch({ seed: Math.floor(Math.random() * 1_000_000_000) })}><Dices size={12} /></button>
        </div>
      </section>

      {/* The LoRA timeline (7twfk6o) — its OWN section (dated decision
          2026-09-19), disjoint from every other lane's panel work. Video
          chains only: painting ranges over the clip's duration. */}
      {draft.mediaType === 'video' && (
        <LoraTimelineSection
          chainId={chain.id}
          duration={draft.duration}
          doc={draft.loraTimeline}
          loraNames={models.filter((file) => file.kind === 'loras').map((file) => file.name)}
          formAdapterInstalled={Boolean(info && (info as Record<string, unknown>)['MiniMaxH3LoraFormLoader'] !== undefined)}
          onChange={(loraTimeline) => patch({ loraTimeline })}
          flush={async () => { await setChainSettings(chain.id, draft) }}
        />
      )}

      <section className="canvas-properties-section" data-canvas-section="references">
        <label>References <span className="canvas-properties-hint">{referenceSlots} of 9 slots</span></label>
        <ol className="canvas-properties-refs" data-canvas-reference-list>
          {bindings.map((binding, index) => (
            <li key={`${binding.file.path}-${index}`} data-canvas-reference={index}>
              <span className="canvas-properties-ref-tag">&lt;Picture {index + 1}&gt;</span>
              <span className="canvas-properties-ref-label">{binding.label}</span>
              {binding.file.kind === 'image' && (
                <button
                  type="button"
                  className="canvas-properties-ref-caption"
                  data-canvas-reference-caption={index}
                  disabled={captioningIndex !== null}
                  title={captioningIndex === index ? 'Describing with the local vision model…' : 'Describe this picture with the local vision model; the description inserts into the prompt'}
                  aria-label={`Caption ${binding.label}`}
                  onClick={() => void captionReference(index)}
                >
                  {captioningIndex === index ? <LoaderCircle size={11} className="spin" /> : <Captions size={11} />}
                </button>
              )}
            </li>
          ))}
          {!bindings.length && <li className="canvas-properties-empty">No references — the chain renders from its prompt{draft.firstFrameOutputId ? ' + first frame' : ''}.</li>}
        </ol>
        {captionNotice && <p className="canvas-properties-note" data-canvas-caption-notice role="status">{captionNotice}</p>}
        {draft.referenceOutputIds.length > 0 && (
          <div className="canvas-properties-row">
            <button
              type="button"
              className="canvas-chip"
              data-canvas-clear-refs
              onClick={() => patch({ referenceOutputIds: [] })}
            >
              clear canvas refs ({draft.referenceOutputIds.length})
            </button>
          </div>
        )}
        {libraries.characters.length > 0 && (
          <div className="canvas-properties-row">
            <label htmlFor="canvas-ref-character">character library</label>
            <select
              id="canvas-ref-character"
              data-canvas-ref-character
              value=""
              onChange={(event) => { if (event.target.value) patch({ referenceCharacterIds: draft.referenceCharacterIds.includes(event.target.value) ? draft.referenceCharacterIds.filter((id) => id !== event.target.value) : [...draft.referenceCharacterIds, event.target.value] }) }}
            >
              <option value="">bind / unbind…</option>
              {libraries.characters.map((character) => (
                <option key={character.id} value={character.id}>{character.name}{draft.referenceCharacterIds.includes(character.id) ? ' ✓' : ''}</option>
              ))}
            </select>
          </div>
        )}
        {libraries.locations.length > 0 && (
          <div className="canvas-properties-row">
            <label htmlFor="canvas-ref-location">location library</label>
            <select
              id="canvas-ref-location"
              data-canvas-ref-location
              value=""
              onChange={(event) => { if (event.target.value) patch({ referenceLocationIds: draft.referenceLocationIds.includes(event.target.value) ? draft.referenceLocationIds.filter((id) => id !== event.target.value) : [...draft.referenceLocationIds, event.target.value] }) }}
            >
              <option value="">bind / unbind…</option>
              {libraries.locations.map((location) => (
                <option key={location.id} value={location.id}>{location.name}{draft.referenceLocationIds.includes(location.id) ? ' ✓' : ''}</option>
              ))}
            </select>
          </div>
        )}
        {/* Phase 4 (§2 asset, F3): the GLOBAL asset store — the first bind of
            an asset into this project records the consent-gated fork (lineage
            home), then its curated reference set rides the picture budget. */}
        {assets.length > 0 && (
          <div className="canvas-properties-row">
            <label htmlFor="canvas-ref-asset">global assets</label>
            <select
              id="canvas-ref-asset"
              data-canvas-ref-asset
              value=""
              title="Global store (above projects) — binding forks the asset into this project with lineage, once, on first use"
              onChange={(event) => { const assetId = event.target.value; if (assetId && chainId) void bindGlobalAsset(chainId, assetId) }}
            >
              <option value="">bind / unbind…</option>
              {assets.map((asset) => (
                <option key={asset.id} value={asset.id}>{asset.kind === 'location' ? 'Location' : 'Character'} · {asset.label}{draft.referenceAssetIds.includes(asset.id) ? ' ✓' : ''}</option>
              ))}
            </select>
          </div>
        )}
        {draft.referenceAssetIds.length > 0 && (
          <div className="canvas-properties-row">
            <button type="button" className="canvas-chip" data-canvas-clear-assets onClick={() => patch({ referenceAssetIds: [] })}>
              clear asset refs ({draft.referenceAssetIds.length})
            </button>
          </div>
        )}
        <div className="canvas-properties-row">
          <label htmlFor="canvas-clothing">clothing policy</label>
          <select id="canvas-clothing" data-canvas-clothing value={draft.clothingPolicy} onChange={(event) => patch({ clothingPolicy: event.target.value as CanvasChainSettings['clothingPolicy'] })}>
            <option value="wardrobe">assigned wardrobe</option>
            <option value="underwear">identity underwear</option>
            <option value="unrestricted">scene prompt decides</option>
          </select>
        </div>
      </section>

      <section className="canvas-properties-section" data-canvas-section="identity">
        <label>Identity payload <span className="canvas-properties-hint">re-injected every window</span></label>
        <p className="canvas-properties-anchor" data-canvas-identity-anchor>
          anchor · {referenceSlots ? `${referenceSlots} bound picture${referenceSlots === 1 ? '' : 's'}` : 'no reference set'}
          {chain?.identity?.refAssetIds?.length ? ` · ${chain.identity.refAssetIds.length} asset ref${chain.identity.refAssetIds.length === 1 ? '' : 's'}` : ''}
          {chain?.identity?.refmodIds?.length ? ` · ${chain.identity.refmodIds.length} RefMod${chain.identity.refmodIds.length === 1 ? '' : 's'}` : ''}
        </p>
        <textarea
          data-canvas-identity-subject
          rows={2}
          placeholder="Verbatim subject text — the anchor phrases that keep this chain’s identity stable"
          value={subjectText}
          onChange={(event) => setSubjectText(event.target.value)}
        />
        <div className="canvas-properties-dial" data-canvas-identity-strength={strength}>
          <span className="canvas-properties-dial-label stiff">stiff</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={strength}
            aria-label="Identity strength"
            onChange={(event) => setStrength(Number(event.target.value))}
          />
          <span className="canvas-properties-dial-label drift">drift</span>
          <span className="canvas-properties-dial-value">{strength.toFixed(2)}</span>
        </div>
        <p className="canvas-properties-note">
          Stiff preserves the reference identity exactly; loose lets the take
          drift with the prompt. Re-anchor by forking an earlier take (B).
        </p>
      </section>

      <section className="canvas-properties-section" data-canvas-section="guides">
        <label>Keyframe guides <span className="canvas-properties-hint">AddGuide frames</span></label>
        {draft.timelineGuides.map((guide, index) => (
          <div className="canvas-properties-row" key={`${guide.file.path}-${index}`} data-canvas-guide={index}>
            <span className="canvas-properties-ref-tag">@</span>
            <input
              type="number"
              min={-draft.duration}
              max={draft.duration}
              step={0.5}
              value={guide.seconds}
              aria-label={`Guide ${index + 1} seconds`}
              onChange={(event) => patch({ timelineGuides: draft.timelineGuides.map((entry, guideIndex) => guideIndex === index ? { ...entry, seconds: Number(event.target.value) } : entry) })}
            />
            <span className="canvas-properties-ref-label">{guide.file.name}</span>
            <button type="button" aria-label={`Remove guide ${index + 1}`} onClick={() => patch({ timelineGuides: draft.timelineGuides.filter((_, guideIndex) => guideIndex !== index) })}><X size={11} /></button>
          </div>
        ))}
        {guideWarnings.map((warning) => <p key={warning} className="canvas-properties-warning" role="alert">{warning}</p>)}
        <div className="canvas-properties-row">
          <button
            type="button"
            className="canvas-chip"
            data-canvas-add-guide
            onClick={async () => {
              const picked = await window.minimax.chooseMedia('image')
              if (!picked) return
              patch({ timelineGuides: [...draft.timelineGuides, { file: { ...picked, kind: 'image' }, seconds: Math.min(draft.duration - 1, 1) }] })
            }}
          >
            + guide image
          </button>
        </div>
      </section>

      <section className="canvas-properties-section" data-canvas-section="takes">
        <label>Takes <span className="canvas-properties-hint">{tile.priors} prior{tile.priors === 1 ? '' : 's'}</span></label>
        <ul className="canvas-properties-takes" data-canvas-takes>
          {tile.takes.slice(0, 5).map((take) => (
            <li key={take.id} data-canvas-take={take.id} className={take.supersededBy ? 'prior' : 'canonical'}>
              <span>{take.id.slice(0, 8)}</span>
              {take.supersededBy
                ? <button type="button" data-canvas-take-restore={take.id} title="Make this take canonical — nothing is deleted; unlocked downstream forks go stale" onClick={() => { void useCanvasStore.getState().switchCanonical(chain.id, take.id) }}>restore</button>
                : <span className="canvas-properties-canonical"><Star size={10} fill="currentColor" /> canonical</span>}
            </li>
          ))}
          {!tile.takes.length && <li className="canvas-properties-empty">No takes yet.</li>}
        </ul>
      </section>

    </div>
      {libraryOpen && <PromptLibraryBrowser onClose={() => setLibraryOpen(false)} onInsert={(prompt) => {
        // AC 5: in structured mode a library entry loads as a BOX-SET — the
        // same best-effort parse the round-trip uses, append-merged so an
        // insert can never drop existing box content.
        if (draft.promptMode === 'structured' && draft.structured) {
          applyStructured(mergeStructuredDraft(draft.structured, parseStructuredPrompt(prompt)))
          useCanvasStore.getState().toast('neutral', 'Library entry parsed into the boxes — best-effort, nothing replaced.')
        } else {
          promptRef.current?.insert(prompt)
        }
      }} />}
      <footer className="canvas-properties-submit">
        <div className="canvas-properties-state">
          <span className="canvas-tile-ring" data-status={tile.status} /> {STATUS_LABEL[tile.status]}
        </div>
        {validation && <p className="canvas-properties-warning" data-canvas-validation role="alert">{validation}</p>}
        {tile.jobId && (tile.status === 'running' || tile.status === 'queued-gpu')
          ? <button type="button" className="canvas-properties-generate" data-canvas-cancel onClick={() => void cancelChainJob(chain.id)}><Square size={12} /> stop</button>
          : <button type="button" className="canvas-properties-generate" data-canvas-generate onClick={() => void generate()} disabled={submitting}>
            <Play size={12} /> generate · {MODE_LABEL[mode]}
          </button>}
      </footer>
  </Rnd>
}
