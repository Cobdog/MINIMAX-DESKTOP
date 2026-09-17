/**
 * Canvas Phase 5b — the Director Suite pure layer (spec §6 + document-model
 * §1 `plan`): the plan-document shape, the MEASURED gap menu, and the
 * timeline projection (the chronological projection of chain outputs — the
 * V-flip family's second member, §7).
 *
 * PURE module: no React, no DOM, no stores — covered by scripts/test-canvas.cjs
 * through the VM harness (ES3 discipline: Array.from, no iterator spreads).
 *
 * Gap-menu grounding (docs/research/h3-transitions-and-latent-continuity.md,
 * tranche-1 addendum measured 2026-09-14/15 + §3 Strategy C): every entry
 * below states its measured verdict and is honest about WHERE the transition
 * physically happens — assembly (a cut), post (an NLE), or in-model (the
 * generation itself). The guided dip-to-black and the diegetic bridge need
 * AddGuide-pinned bridge-render machinery (engine work, queued Phase 6 —
 * reported, not improvised); they surface as CHOICES with that label, never
 * as buttons that pretend to execute.
 */
import type { CanvasDocument, DocumentChain, JobFact, TileStatus } from './derive'
import { tileStatus } from './derive'

// ---- the gap menu (measured) ----------------------------------------------------

export type PlanGapKind = 'cut' | 'nle' | 'flf' | 'black' | 'bridge'

export const GAP_KINDS: PlanGapKind[] = ['cut', 'nle', 'flf', 'black', 'bridge']

export type GapMechanism = 'assembly' | 'post' | 'in-model'

export const GAP_MECHANISM_LABEL: Record<GapMechanism, string> = {
  assembly: 'assembly',
  post: 'post-production',
  'in-model': 'in-model',
}

export type GapMenuEntry = {
  kind: PlanGapKind
  label: string
  mechanism: GapMechanism
  /** The measured verdict, one line (tranche 1 numbers cited where they exist). */
  verdict: string
  /** Executes today without engine work (only the FLF splice: the
   *  continuation-frame handoff — server-side ffmpeg, no generation). */
  executable: boolean
  /** The render variant needs bridge-generation machinery (engine work). */
  engineDependent: boolean
}

/** The five, in menu order — hard cut first (the measured default). */
export const GAP_MENU: GapMenuEntry[] = [
  {
    kind: 'cut',
    label: 'Hard cut',
    mechanism: 'assembly',
    verdict: 'The measured default: a 9.8 dB seam, zero GPU, no motion carry — and fresh references at the cut are a documented identity reset.',
    executable: true,
    engineDependent: false,
  },
  {
    kind: 'nle',
    label: 'NLE transition',
    mechanism: 'post',
    verdict: 'Crossfade, flash, or audio crossfade in an external editor — deterministic, never drifts, zero GPU. The cut list rides the timeline.',
    executable: true,
    engineDependent: false,
  },
  {
    kind: 'flf',
    label: 'FLF continuation splice',
    mechanism: 'in-model',
    verdict: 'The champion: the prior segment\'s final frame wires as the next segment\'s first frame — 36.2/34.3 dB joins, timeline-invisible (tranche 1, E1).',
    executable: true,
    engineDependent: false,
  },
  {
    kind: 'black',
    label: 'Dip-to-black',
    mechanism: 'post',
    verdict: 'Structural ~0.7 s dip (the temporal-VAE grid), audio-friendly — a guided black still halves the audio boundary step, but the guided variant needs a bridge render (engine work, queued).',
    executable: false,
    engineDependent: true,
  },
  {
    kind: 'bridge',
    label: 'Diegetic bridge',
    mechanism: 'in-model',
    verdict: 'Opt-in: a generated whip-pan/flash/match-cut segment pinned on both ends — bridges measured 19.1/15.9 dB (diegetic-only; E1) and identity hold is unmeasured (E7). Needs bridge-render machinery (engine work, queued).',
    executable: false,
    engineDependent: true,
  },
]

export const GAP_LABEL: Record<PlanGapKind, string> = {
  cut: 'Hard cut',
  nle: 'NLE transition',
  flf: 'FLF splice',
  black: 'Dip-to-black',
  bridge: 'Diegetic bridge',
}

export function gapMenuEntry(kind: PlanGapKind): GapMenuEntry {
  return GAP_MENU.find((entry) => entry.kind === kind) ?? GAP_MENU[0]
}

// ---- the plan document (canvas_plan.document_json; schema spec §1) --------------

/**
 * The plan document shape — the MoviePlanner inheritance per document-model
 * §1: brief, segments (chain_ref + planned duration; the cumulative range is
 * DERIVED, not stored — order is the array), gaps (kind per the schema's
 * five, keyed by the segment they follow), and per-segment reference
 * handoffs (library ids — the same ids the chain reference binding resolves;
 * the production bible itself lives in the studios + the global asset store,
 * Phase 4's model, not inside the plan).
 */
export type PlanSegment = {
  id: string
  title: string
  prompt: string
  duration: number
  /** chain_ref: the canvas chain executing this segment (null until seeded). */
  chainId: string | null
  referenceCharacterIds: string[]
  referenceLocationIds: string[]
}

export type PlanGap = { afterSegmentId: string; kind: PlanGapKind }

export type PlanDocumentData = {
  brief: string
  segments: PlanSegment[]
  gaps: PlanGap[]
}

export function newSegment(index: number): PlanSegment {
  return { id: `seg-${Date.now().toString(36)}-${index}-${Math.floor(Math.random() * 1e6).toString(36)}`, title: `Segment ${index}`, prompt: '', duration: 6, chainId: null, referenceCharacterIds: [], referenceLocationIds: [] }
}

export function newPlanDocument(brief = ''): PlanDocumentData {
  return { brief, segments: [], gaps: [] }
}

const idList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item)) : [])

/** Tolerant read of a plan document row's document_json (external data —
 *  absent keys fall back, wrong shapes never crash). */
export function readPlanDocument(raw: unknown): PlanDocumentData {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const kinds = new Set(GAP_KINDS)
  const segments = Array.isArray(record.segments)
    ? record.segments.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object').map((item, index) => ({
      id: typeof item.id === 'string' && item.id ? item.id : `seg-${index}`,
      title: typeof item.title === 'string' ? item.title : `Segment ${index + 1}`,
      prompt: typeof item.prompt === 'string' ? item.prompt : '',
      duration: typeof item.duration === 'number' && Number.isFinite(item.duration) && item.duration > 0 ? Math.min(15, item.duration) : 6,
      chainId: typeof item.chainId === 'string' && item.chainId ? item.chainId : null,
      referenceCharacterIds: idList(item.referenceCharacterIds),
      referenceLocationIds: idList(item.referenceLocationIds),
    }))
    : []
  const segmentIds = new Set(segments.map((segment) => segment.id))
  const gaps = Array.isArray(record.gaps)
    ? record.gaps.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .filter((item) => typeof item.afterSegmentId === 'string' && segmentIds.has(item.afterSegmentId))
      .filter((item) => typeof item.kind === 'string' && kinds.has(item.kind as PlanGapKind))
      .map((item) => ({ afterSegmentId: item.afterSegmentId as string, kind: item.kind as PlanGapKind }))
    : []
  return { brief: typeof record.brief === 'string' ? record.brief : '', segments, gaps }
}

/** The gap that follows a segment (a missing gap = the measured default,
 *  hard cut). */
export function gapAfter(plan: PlanDocumentData, afterSegmentId: string): PlanGap {
  return plan.gaps.find((gap) => gap.afterSegmentId === afterSegmentId) ?? { afterSegmentId, kind: 'cut' }
}

/** The end of the contiguous FLF-connected run starting at `fromIndex` —
 *  the episode boundary for the latent-chain render (a non-FLF gap ends the
 *  run: those segments are separate chains by design). */
export function episodeRunEnd(plan: PlanDocumentData, fromIndex: number): number {
  let index = fromIndex
  while (index + 1 < plan.segments.length && gapAfter(plan, plan.segments[index].id).kind === 'flf') index += 1
  return index + 1
}

// ---- the timeline projection ----------------------------------------------------

export type TimelineItemStatus = TileStatus | 'unseeded'

export type TimelineItem = {
  segmentId: string
  title: string
  prompt: string
  /** The plan's statement, seconds. */
  plannedDuration: number
  /** Cumulative planned range [start, end). */
  start: number
  end: number
  chainId: string | null
  status: TimelineItemStatus
  statusNote: string | null
  previewPath: string | null
  artifactPath: string | null
  mediaKind: 'image' | 'video' | 'audio' | null
  /** The canonical take's real duration when one exists (the honest
   *  planned-vs-rendered read). */
  renderedDuration: number | null
  stale: boolean
}

export type TimelineGapView = {
  afterSegmentId: string
  beforeSegmentId: string
  kind: PlanGapKind
  /** The FLF splice can wire NOW: the left item's canonical take is a
   *  renderable video (the 'last'-frame extraction source). */
  flfReady: boolean
}

export type TimelineProjection = {
  planId: string | null
  items: TimelineItem[]
  gaps: TimelineGapView[]
  plannedDuration: number
  renderedDuration: number
}

function itemTitle(fallbackIndex: number, prompt: string, kind: string): string {
  if (prompt) {
    const firstLine = prompt.split(/[.\n]/).map((part) => part.trim()).find(Boolean) ?? prompt
    return firstLine.length > 42 ? `${firstLine.slice(0, 41)}…` : firstLine
  }
  return `${kind} ${fallbackIndex + 1}`
}

type ChainFacts = {
  chain: DocumentChain
  status: TimelineItemStatus
  statusNote: string | null
  previewPath: string | null
  artifactPath: string | null
  mediaKind: 'image' | 'video' | 'audio' | null
  renderedDuration: number | null
  stale: boolean
}

/** The per-chain facts an item inherits (F7 — projections inherit the
 *  contracts: failure/staleness/queued ride the same status ladder as the
 *  canvas tiles). */
function chainFacts(chain: DocumentChain, jobs: ReadonlyArray<JobFact>, links: Readonly<Record<string, string>>, dismissed: ReadonlySet<string>): ChainFacts {
  const jobId = links[chain.id] ?? null
  const job = jobId ? jobs.find((entry) => entry.id === jobId) ?? null : null
  const takes = chain.outputs.flatMap((output) => output.takes)
  const canonical = takes.find((take) => take.supersededBy === null) ?? null
  const metrics = canonical?.metrics ?? null
  const kind = metrics && typeof metrics.kind === 'string' && ['image', 'video', 'audio'].includes(metrics.kind) ? metrics.kind as 'image' | 'video' | 'audio' : null
  let previewPath: string | null = null
  let artifactPath: string | null = null
  if (canonical) {
    if (metrics && typeof metrics.sourcePath === 'string' && metrics.sourcePath.startsWith('/')) previewPath = metrics.sourcePath
    else previewPath = canonical.artifacts.find((artifact) => artifact.startsWith('/')) ?? null
    artifactPath = canonical.artifacts.find((artifact) => artifact.startsWith('canvas-blobs/')) ?? null
  }
  const duration = canonical && metrics && typeof metrics.duration === 'number' && metrics.duration > 0 ? metrics.duration : null
  return {
    chain,
    status: tileStatus(chain, job, dismissed.has(chain.id)),
    statusNote: job && job.status === 'failed' ? job.error ?? 'generation failed' : null,
    previewPath,
    artifactPath,
    mediaKind: kind,
    renderedDuration: duration,
    stale: chain.stale,
  }
}

/**
 * The timeline projection (§6): WITH a plan — the plan's segments in order,
 * each carrying its chain's facts (planned vs rendered duration, the F7
 * status ladder); WITHOUT a plan — the project's chain OUTPUTS in creation
 * order (the §8-AC "chronological projection of chain outputs"), gaps
 * implicit hard cuts. Pure; the overlay and the store actions read this.
 */
export function deriveTimeline(input: {
  document: CanvasDocument
  plan: { id: string; document: unknown } | null
  jobs?: ReadonlyArray<JobFact>
  links?: Readonly<Record<string, string>>
  dismissed?: ReadonlySet<string>
}): TimelineProjection {
  const jobs = input.jobs ?? []
  const links = input.links ?? {}
  const dismissed = input.dismissed ?? new Set<string>()
  const byChain = new Map<string, ChainFacts>()
  for (const chain of input.document.chains) byChain.set(chain.id, chainFacts(chain, jobs, links, dismissed))

  if (!input.plan) {
    // Unplanned chronology: every chain with a canonical take, creation order.
    const items: TimelineItem[] = []
    let cursor = 0
    for (const chain of input.document.chains) {
      const facts = byChain.get(chain.id)!
      if (!facts.renderedDuration && !facts.previewPath && !facts.artifactPath) continue // outputs only
      const prompt = typeof chain.settings.prompt === 'string' ? chain.settings.prompt : ''
      const duration = facts.renderedDuration ?? 0
      items.push({
        segmentId: chain.id,
        title: itemTitle(items.length, prompt, chain.kind),
        prompt,
        plannedDuration: duration,
        start: cursor,
        end: cursor + duration,
        chainId: chain.id,
        status: facts.status,
        statusNote: facts.statusNote,
        previewPath: facts.previewPath,
        artifactPath: facts.artifactPath,
        mediaKind: facts.mediaKind,
        renderedDuration: facts.renderedDuration,
        stale: facts.stale,
      })
      cursor += duration
    }
    const gaps: TimelineGapView[] = []
    for (let index = 0; index + 1 < items.length; index += 1) {
      const left = byChain.get(items[index].chainId ?? '')!
      gaps.push({ afterSegmentId: items[index].segmentId, beforeSegmentId: items[index + 1].segmentId, kind: 'cut', flfReady: left.mediaKind === 'video' && Boolean(left.previewPath) })
    }
    return { planId: null, items, gaps, plannedDuration: cursor, renderedDuration: cursor }
  }

  const plan = readPlanDocument(input.plan.document)
  const items: TimelineItem[] = []
  let cursor = 0
  for (const segment of plan.segments) {
    const facts = segment.chainId ? byChain.get(segment.chainId) ?? null : null
    items.push({
      segmentId: segment.id,
      title: segment.title || itemTitle(items.length, segment.prompt, 'segment'),
      prompt: segment.prompt,
      plannedDuration: segment.duration,
      start: cursor,
      end: cursor + segment.duration,
      chainId: segment.chainId,
      status: facts ? facts.status : 'unseeded',
      statusNote: facts ? facts.statusNote : null,
      previewPath: facts ? facts.previewPath : null,
      artifactPath: facts ? facts.artifactPath : null,
      mediaKind: facts ? facts.mediaKind : null,
      renderedDuration: facts ? facts.renderedDuration : null,
      stale: facts ? facts.stale : false,
    })
    cursor += segment.duration
  }
  const gaps: TimelineGapView[] = []
  let rendered = 0
  for (const item of items) rendered += item.renderedDuration ?? 0
  for (let index = 0; index + 1 < items.length; index += 1) {
    const left = items[index].chainId ? byChain.get(items[index].chainId!) ?? null : null
    gaps.push({
      afterSegmentId: items[index].segmentId,
      beforeSegmentId: items[index + 1].segmentId,
      kind: gapAfter(plan, items[index].segmentId).kind,
      flfReady: Boolean(left && left.mediaKind === 'video' && left.previewPath),
    })
  }
  return { planId: input.plan.id, items, gaps, plannedDuration: cursor, renderedDuration: rendered }
}

/**
 * The adopt-chronology builder: chain outputs → a plan document (every chain
 * with a canonical take becomes a segment carrying its chain_ref, prompt, and
 * real duration; gaps start at the measured default). The upgrade path from
 * the unplanned projection to a persisted plan.
 */
export function planDocumentFromChains(document: CanvasDocument): PlanDocumentData {
  const segments: PlanSegment[] = []
  for (const chain of document.chains) {
    const takes = chain.outputs.flatMap((output) => output.takes)
    const canonical = takes.find((take) => take.supersededBy === null) ?? null
    if (!canonical) continue
    const prompt = typeof chain.settings.prompt === 'string' ? chain.settings.prompt : ''
    const duration = canonical.metrics && typeof canonical.metrics.duration === 'number' && canonical.metrics.duration > 0 ? canonical.metrics.duration : 6
    segments.push({
      id: `seg-${chain.id}`,
      title: itemTitle(segments.length, prompt, chain.kind),
      prompt,
      duration: Math.min(15, Math.max(2, duration)),
      chainId: chain.id,
      referenceCharacterIds: Array.isArray(chain.settings.referenceCharacterIds) ? chain.settings.referenceCharacterIds.filter((id): id is string => typeof id === 'string') : [],
      referenceLocationIds: Array.isArray(chain.settings.referenceLocationIds) ? chain.settings.referenceLocationIds.filter((id): id is string => typeof id === 'string') : [],
    })
  }
  return { brief: '', segments, gaps: [] }
}

export function formatTimelineDuration(seconds: number): string {
  const value = Math.max(0, Math.round(seconds))
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`
}
