/**
 * Canvas Phase 5b — the timeline projection (§6, the Director Suite): the
 * chronological projection of chain outputs, summoned by V (the flip family's
 * second member) or the titlebar button. NOT a permanent panel — a summonable
 * surface exactly like the library projection.
 *
 * Two regimes, one projection:
 *  - WITH a plan document (canvas_plan): the plan's segments in order, each
 *    carrying its chain's facts (planned vs rendered duration, the F7 status
 *    ladder — projections inherit the contracts), the plan editor beneath
 *    (brief + segments + per-segment reference handoffs), and the MEASURED
 *    gap menu between segments (hard cut / NLE / FLF splice / dip-to-black /
 *    diegetic bridge — verdicts from docs/research/h3-transitions, honest
 *    about assembly vs post vs in-model; only the FLF splice executes today,
 *    the render variants are labeled engine work, queued).
 *  - WITHOUT a plan: the project's chain outputs in creation order (the
 *    honest unplanned chronology; gaps implicit hard cuts) + the
 *    adopt-chronology upgrade ("Plan this chronology").
 */
import { useMemo } from 'react'
import { Film, Image as ImageIcon, LayoutList, Link2, Music2, Plus, Scissors, X } from 'lucide-react'
import { documentsApi } from './api'
import { STATUS_LABEL } from './derive'
import { deriveTimeline, GAP_LABEL, GAP_MECHANISM_LABEL, GAP_MENU, readPlanDocument, type PlanGapKind } from './plan'
import { useCanvasStore } from './store'
import { useJobsStore } from '../state/jobsStore'

const STATUS_TONE: Record<string, string> = {
  idle: 'var(--muted-2)',
  'queued-gpu': 'var(--accent)',
  running: 'var(--accent)',
  stale: 'var(--warning)',
  failed: 'var(--danger, #e5484d)',
  unseeded: 'var(--muted-2)',
}

function KindIcon({ kind }: { kind: 'video' | 'image' | 'audio' | null }) {
  if (kind === 'audio') return <Music2 size={13} />
  if (kind === 'image') return <ImageIcon size={13} />
  if (kind === 'video') return <Film size={13} />
  return <Scissors size={13} />
}

export function TimelineOverlay() {
  const open = useCanvasStore((state) => state.timelineOpen)
  const timelinePlanId = useCanvasStore((state) => state.timelinePlanId)
  const documents = useCanvasStore((state) => state.documents)
  const activeProjectId = useCanvasStore((state) => state.activeProjectId)
  const libraries = useCanvasStore((state) => state.libraries)
  const chainJobs = useCanvasStore((state) => state.chainJobs)
  const dismissedFailures = useCanvasStore((state) => state.dismissedFailures)
  const gapMenu = useCanvasStore((state) => state.gapMenu)
  const jobs = useJobsStore((state) => state.jobs)

  const document = activeProjectId ? documents[activeProjectId] ?? null : null
  const plans = useMemo(() => document?.plans ?? [], [document])
  const planRow = useMemo(
    () => plans.find((plan) => plan.id === timelinePlanId) ?? plans[0] ?? null,
    [plans, timelinePlanId],
  )
  const projection = useMemo(() => document
    ? deriveTimeline({
      document,
      plan: planRow ? { id: planRow.id, document: planRow.document } : null,
      jobs,
      links: chainJobs,
      dismissed: new Set(dismissedFailures),
    })
    : { planId: null, items: [], gaps: [], plannedDuration: 0, renderedDuration: 0 }, [document, planRow, jobs, chainJobs, dismissedFailures])
  const plan = planRow ? readPlanDocument(planRow.document) : null
  const store = useCanvasStore.getState

  if (!open) return null

  const close = () => store().setTimelineOpen(false)
  const navigate = (chainId: string) => {
    store().select(chainId)
    store().requestCamera({ kind: 'fly', tileId: chainId })
    close()
  }
  const seedSegment = async (segmentId: string) => {
    if (!planRow) return
    const chainId = await store().seedSegmentChain(planRow.id, segmentId)
    if (chainId) store().toast('success', 'Segment seeded as a canvas object — review and generate from its panel or the row below. Nothing auto-executes.')
  }
  const generateSegment = async (segmentId: string) => {
    if (!planRow) return
    // The submit ladder's early refusals (settings loading, no object) do
    // not notify inside the core — surface them here; the rarer
    // engine-ladder refusal may double-toast, which is cosmetic.
    const result = await store().submitSegment(planRow.id, segmentId)
    if (!result.ok && result.message) store().toast('error', result.message)
  }
  const openGapMenu = (afterSegmentId: string) => {
    if (!planRow) return
    store().setGapMenu({ planId: planRow.id, afterSegmentId })
  }
  const chooseGap = async (kind: PlanGapKind) => {
    if (!gapMenu) return
    await store().setPlanGap(gapMenu.planId, gapMenu.afterSegmentId, kind)
  }

  // The latent-episode trigger: the first FLF-connected run of ≥2 seeded
  // segments (the scene-chain successor).
  const episodeStart = plan ? plan.segments.findIndex((segment, index) => {
    if (!segment.chainId) return false
    const next = plan.segments[index + 1]
    return Boolean(next && next.chainId && plan.gaps.some((gap) => gap.afterSegmentId === segment.id && gap.kind === 'flf'))
  }) : -1

  const openGap = projection.gaps.find((gap) => gap.afterSegmentId === gapMenu?.afterSegmentId)
  const openGapRight = plan ? plan.segments.find((segment) => segment.id === gapMenu?.afterSegmentId) : undefined

  return <div className="canvas-index-overlay" data-canvas-timeline role="dialog" aria-label="Timeline" onClick={close}>
    <div className="canvas-timeline-panel" onClick={(event) => event.stopPropagation()}>
      <header className="canvas-index-input canvas-timeline-header">
        <LayoutList size={15} />
        <strong className="canvas-timeline-title">{planRow ? `Timeline — plan (${plan ? plan.segments.length : 0} segments)` : 'Timeline — chain outputs (unplanned chronology)'}</strong>
        <span className="canvas-timeline-total">{projection.items.length} items · {Math.round(projection.plannedDuration)}s planned{projection.renderedDuration ? ` · ${Math.round(projection.renderedDuration)}s rendered` : ''}</span>
        {plans.length > 1 && <select
          className="canvas-timeline-plan-select"
          aria-label="Plan"
          value={planRow?.id ?? ''}
          onChange={(event) => useCanvasStore.setState({ timelinePlanId: event.target.value })}
        >
          {plans.map((entry, index) => <option key={entry.id} value={entry.id}>Plan {index + 1} — {readPlanDocument(entry.document).segments.length} segments</option>)}
        </select>}
        {!planRow && document && document.chains.some((chain) => chain.outputs.some((output) => output.takes.length)) && (
          <button type="button" className="canvas-chip" data-canvas-timeline-adopt onClick={() => void store().adoptChronology()}>Plan this chronology</button>
        )}
        <button type="button" className="canvas-chip" data-canvas-timeline-new-plan onClick={() => void store().createPlan()}><Plus size={12} /> New plan</button>
        <button type="button" className="icon-button" aria-label="Close timeline" data-canvas-timeline-close onClick={close}><X size={14} /></button>
      </header>

      {/* The strip: items + the measured gaps between them. */}
      <div className="canvas-timeline-strip" data-canvas-timeline-strip>
        {projection.items.map((item) => {
          const gap = projection.gaps.find((entry) => entry.afterSegmentId === item.segmentId)
          return <div className="canvas-timeline-slot" key={item.segmentId}>
            <button type="button" className="canvas-timeline-item" data-canvas-timeline-item={item.segmentId} onClick={() => item.chainId && navigate(item.chainId)} disabled={!item.chainId}>
              {item.artifactPath && item.mediaKind === 'image' && <img className="canvas-timeline-poster" src={documentsApi.blobFileUrl(item.artifactPath)} alt="" />}
              {item.artifactPath && item.mediaKind === 'video' && <video className="canvas-timeline-poster" src={documentsApi.blobFileUrl(item.artifactPath)} muted preload="metadata" />}
              {!item.artifactPath && item.previewPath && <video className="canvas-timeline-poster" src={item.previewPath} muted preload="metadata" />}
              {!item.artifactPath && !item.previewPath && <span className="canvas-timeline-poster empty"><KindIcon kind={item.mediaKind} /></span>}
              <span className="canvas-timeline-item-title">{item.title}</span>
              <span className="canvas-timeline-item-meta">
                <i style={{ background: STATUS_TONE[item.status] ?? 'var(--muted-2)' }} data-canvas-timeline-item-status={item.status} />
                {item.status === 'unseeded' ? 'no object' : STATUS_LABEL[item.status]}
                {' · '}{item.plannedDuration}s{item.renderedDuration != null ? ` · rendered ${Math.round(item.renderedDuration)}s` : ''}
              </span>
            </button>
            {gap && (planRow
              ? <button type="button" className={`canvas-timeline-gap kind-${gap.kind}`} data-canvas-gap={gap.afterSegmentId} onClick={() => openGapMenu(gap.afterSegmentId)} title={`${GAP_LABEL[gap.kind]} — click to change the transition`}>
                  <span className="canvas-timeline-gap-kind">{GAP_LABEL[gap.kind]}</span>
                  <span className="canvas-timeline-gap-mechanism">{GAP_MECHANISM_LABEL[GAP_MENU.find((entry) => entry.kind === gap.kind)?.mechanism ?? 'assembly']}</span>
                </button>
              : <span className="canvas-timeline-gap implicit" data-canvas-gap={gap.afterSegmentId}><span className="canvas-timeline-gap-kind">Hard cut</span><span className="canvas-timeline-gap-mechanism">implicit</span></span>)}
          </div>
        })}
        {!projection.items.length && <div className="canvas-timeline-empty" data-canvas-timeline-empty>
          {planRow ? 'No segments yet — add the first below.' : 'Chain outputs appear here in creation order — drop or generate media, then plan the chronology.'}
        </div>}
      </div>

      {/* The measured gap menu (§6): five entries, verdicts from the
          transitions research, honest mechanism labels. */}
      {gapMenu && openGap && (
        <div className="canvas-gap-menu" data-canvas-gap-menu role="menu" aria-label="Transition">
          <header>
            <strong>Transition</strong>
            <span>{GAP_LABEL[openGap.kind]} · choose the measured path</span>
            <button type="button" className="icon-button" aria-label="Close transition menu" data-canvas-gap-close onClick={() => store().setGapMenu(null)}><X size={12} /></button>
          </header>
          {GAP_MENU.map((entry) => {
            const flfBlocked = entry.kind === 'flf' && !openGap.flfReady
            const disabled = entry.engineDependent || flfBlocked
            const reason = entry.engineDependent
              ? 'needs bridge-render machinery — engine work, queued (the choice is recorded; the render lands with it)'
              : flfBlocked
                ? 'render the LEFT segment first — the splice wires from its final rendered frame'
                : null
            return <button
              key={entry.kind}
              type="button"
              role="menuitem"
              className={`canvas-gap-option ${openGap.kind === entry.kind ? 'active' : ''}`}
              data-canvas-gap-option={entry.kind}
              disabled={disabled}
              title={reason ?? entry.verdict}
              onClick={() => void chooseGap(entry.kind)}
            >
              <span className="canvas-gap-option-head">
                <strong>{entry.label}</strong>
                <span className="canvas-gap-option-mechanism" data-canvas-gap-mechanism={entry.mechanism}>{GAP_MECHANISM_LABEL[entry.mechanism]}</span>
                {openGap.kind === entry.kind && <span className="canvas-gap-option-current">current</span>}
              </span>
              <span className="canvas-gap-option-verdict" data-canvas-gap-verdict>{entry.verdict}</span>
              {reason && <span className="canvas-gap-option-reason">{reason}</span>}
            </button>
          })}
          <footer>{openGapRight ? `between “${projection.items.find((item) => item.segmentId === openGap.afterSegmentId)?.title ?? ''}” and the next segment` : ''} — verdicts: tranche-1 measurements</footer>
        </div>
      )}

      {/* The plan editor (the MoviePlanner inheritance, on the document store). */}
      {planRow && plan && <div className="canvas-timeline-editor" data-canvas-plan-editor>
        <label className="canvas-timeline-brief">
          <span>Brief</span>
          <textarea data-canvas-plan-brief defaultValue={plan.brief} placeholder="The film this plan produces — story, rules, intent…" onBlur={(event) => { if (event.target.value !== plan.brief) void store().updatePlanDocument(planRow.id, (current) => ({ ...current, brief: event.target.value })) }} />
        </label>
        <div className="canvas-plan-segments" data-canvas-plan-segments>
          {plan.segments.map((segment, index) => {
            const item = projection.items.find((entry) => entry.segmentId === segment.id)
            return <div className="canvas-plan-segment" data-canvas-segment={segment.id} key={segment.id}>
              <div className="canvas-plan-segment-head">
                <span className="canvas-plan-segment-index">{index + 1}</span>
                <input data-canvas-segment-title defaultValue={segment.title} aria-label="Segment title" onBlur={(event) => { if (event.target.value !== segment.title) void store().updatePlanSegment(planRow.id, segment.id, { title: event.target.value }) }} />
                <label className="canvas-plan-segment-duration">seconds<input data-canvas-segment-duration type="number" min={2} max={15} defaultValue={segment.duration} onBlur={(event) => { const value = Math.max(2, Math.min(15, Number(event.target.value) || segment.duration)); if (value !== segment.duration) void store().updatePlanSegment(planRow.id, segment.id, { duration: value }) }} /></label>
                {segment.chainId
                  ? <span className="canvas-plan-segment-state" data-canvas-segment-state={item?.status ?? 'idle'}>{item && item.status !== 'unseeded' ? STATUS_LABEL[item.status] : 'idle'}</span>
                  : <span className="canvas-plan-segment-state muted">no object</span>}
              </div>
              <textarea data-canvas-segment-prompt defaultValue={segment.prompt} placeholder="This segment's prompt — subject, action, camera, light…" onBlur={(event) => { if (event.target.value !== segment.prompt) void store().updatePlanSegment(planRow.id, segment.id, { prompt: event.target.value }) }} />
              <div className="canvas-plan-segment-refs" aria-label="Reference handoffs">
                {libraries.characters.map((character) => (
                  <button key={character.id} type="button" className={`canvas-chip canvas-plan-ref ${segment.referenceCharacterIds.includes(character.id) ? 'active' : ''}`} data-canvas-segment-ref-character={character.id}
                    onClick={() => void store().updatePlanSegment(planRow.id, segment.id, { referenceCharacterIds: segment.referenceCharacterIds.includes(character.id) ? segment.referenceCharacterIds.filter((id) => id !== character.id) : [...segment.referenceCharacterIds, character.id] })}>{character.name}</button>
                ))}
                {libraries.locations.map((location) => (
                  <button key={location.id} type="button" className={`canvas-chip canvas-plan-ref ${segment.referenceLocationIds.includes(location.id) ? 'active' : ''}`} data-canvas-segment-ref-location={location.id}
                    onClick={() => void store().updatePlanSegment(planRow.id, segment.id, { referenceLocationIds: segment.referenceLocationIds.includes(location.id) ? segment.referenceLocationIds.filter((id) => id !== location.id) : [...segment.referenceLocationIds, location.id] })}>{location.name}</button>
                ))}
              </div>
              <div className="canvas-plan-segment-actions">
                {!segment.chainId && <button type="button" className="canvas-chip" data-canvas-segment-seed disabled={!segment.prompt.trim()} onClick={() => void seedSegment(segment.id)}>Seed object</button>}
                {segment.chainId && <button type="button" className="canvas-chip" data-canvas-segment-generate onClick={() => void generateSegment(segment.id)}>Generate</button>}
                <button type="button" className="canvas-chip" data-canvas-segment-remove onClick={() => void store().removePlanSegment(planRow.id, segment.id)}>Remove</button>
              </div>
            </div>
          })}
          <div className="canvas-plan-segment-toolbar">
            <button type="button" className="canvas-chip" data-canvas-plan-add-segment onClick={() => void store().addPlanSegment(planRow.id)}><Plus size={12} /> Add segment</button>
            <button type="button" className="canvas-chip" data-canvas-plan-episode disabled={episodeStart < 0} title={episodeStart < 0 ? 'Needs two seeded segments joined by an FLF gap' : 'Render the FLF-connected run as ONE latent-chained episode (Motion-Context); every take lands on its own object'}
              onClick={() => void store().submitPlanEpisode(planRow.id, plan.segments[episodeStart].id)}><Link2 size={12} /> Render FLF run as latent chain</button>
          </div>
        </div>
      </div>}
      {!planRow && <footer className="canvas-timeline-footer"><span>V cycles · timeline → library → canvas</span><span>projections inherit the no-silent-failure contract</span></footer>}
      {planRow && <footer className="canvas-timeline-footer"><span>V cycles · timeline → library → canvas</span><span>transitions are measured choices — FLF executes; the bridge renders are labeled engine work</span></footer>}
    </div>
  </div>
}
