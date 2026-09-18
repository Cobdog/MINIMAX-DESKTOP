/**
 * H3 Image Workbench — the session model (task k9vu6t0, spec §2).
 *
 * PURE module: the workbench session is a document-store object — a canvas
 * chain of kind 'h3img' whose SETTINGS carry the session state (family,
 * intent, ordered ref slots with roles/transports, Keep dial + per-picture
 * overrides, LoRA slots, seed, resolution, expert toggles) and whose
 * OUTPUTS/TAKES are the generations: ONE take per generation whose
 * ARTIFACTS are the N packet frames (5-39 frame artifacts inside a single
 * take — never N takes: no canonical pollution, the packet evicts/exports
 * as one unit).
 *
 * The canonical pick is a pointer WITHIN the take: the scorer's verdict +
 * auto-pick ride the take's immutable metrics (provenance); manual picks
 * are session state (settings.framePicks[takeId]) — the projection resolves
 * the effective pointer. Refine and burst-fuse land as NEW takes
 * (metrics.h3img.parentTakeId links the provenance chain). Tone-lock rides
 * the op stack (kind 'h3img.tone-lock').
 *
 * No React, no DOM, no stores — covered by scripts/test-h3img.cjs through
 * the VM harness.
 */
import { TRANSPORT_FOR_ROLE, findH3ImgFamily } from '../lib/graph/h3image'
import type { H3ImgRefRole, H3ImgTransport } from '../lib/graph/h3image'
import { composeWorkbenchPrompt } from '../lib/h3imageContract'
import type { DocumentTake } from '../canvas/derive'

export const H3IMG_CHAIN_KIND = 'h3img'
export const H3IMG_OP_TONE_LOCK = 'h3img.tone-lock'
export const H3IMG_OP_BURST_FUSE = 'h3img.burst-fuse'

/** Where a ref slot's content comes from. RefMod-shaped from day one
 * (decision 9): a slot reads existing RefMod FILES but cannot create them
 * (the factory is H8's task) — honest labeling. */
export type SessionRefSource =
  | { kind: 'file'; path: string; name: string; preview?: string }
  | { kind: 'canvas'; outputId: string; takeId: string | null }
  | { kind: 'refmod'; file: string }
  | { kind: 'poserig'; path: string; name: string; preview?: string }

export type SessionRefSlot = {
  id: string
  role: H3ImgRefRole
  /** null = auto-per-role (the transport map); an expert override sets it. */
  transport: H3ImgTransport | null
  /** Per-picture Keep-dial override (null = the global dial). */
  keepOverride: number | null
  note: string
  source: SessionRefSource
}

export type WorkbenchSessionSettings = {
  family: string
  /** The user's intent — the contract is generated from it (never stored
   * hand-written; the composed prompt re-derives deterministically). */
  intent: string
  tier: 5 | 9 | 13 | 39
  keepDial: number
  seed: number
  resolution: string
  /** 2 LoRA slots (form-adapter always first — handled at graph build). */
  loras: Array<{ name: string; strength: number }>
  refs: SessionRefSlot[]
  /** Expert experimental toggles (default OFF, labeled experimental). */
  semanticOverflow: boolean
  /** Manual canonical-frame picks (session state): takeId -> frame index.
   * Absent = the scorer's auto-pick in take metrics wins. */
  framePicks: Record<string, number>
  /** The preferred refine engine for the one-tap affordance ('' = auto:
   * klein suggested when available, Krea 2 the quality pairing). */
  refineEngine: 'klein' | 'krea2' | ''
  /** Poserig handoff inbox (the rig surface stashes a render for the
   * workbench; consumed on read). */
  poserigInbox: { path: string; name: string } | null
}

export function sessionSettingsDefaults(): WorkbenchSessionSettings {
  return {
    family: 'h3img.generate.packet',
    intent: '',
    tier: 5,
    keepDial: 0.55,
    seed: Math.floor(Math.random() * 1_000_000_000),
    resolution: '1344x768',
    loras: [],
    refs: [],
    semanticOverflow: false,
    framePicks: {},
    refineEngine: '',
    poserigInbox: null,
  }
}

const refSource = (raw: unknown): SessionRefSource | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (record.kind === 'file' && typeof record.path === 'string') return { kind: 'file', path: record.path, name: typeof record.name === 'string' ? record.name : record.path.split('/').pop() ?? record.path, ...(typeof record.preview === 'string' ? { preview: record.preview } : {}) }
  if (record.kind === 'canvas' && typeof record.outputId === 'string') return { kind: 'canvas', outputId: record.outputId, takeId: typeof record.takeId === 'string' ? record.takeId : null }
  if (record.kind === 'refmod' && typeof record.file === 'string') return { kind: 'refmod', file: record.file }
  if (record.kind === 'poserig' && typeof record.path === 'string') return { kind: 'poserig', path: record.path, name: typeof record.name === 'string' ? record.name : record.path.split('/').pop() ?? record.path, ...(typeof record.preview === 'string' ? { preview: record.preview } : {}) }
  return null
}

const ROLES: H3ImgRefRole[] = ['subject', 'pose', 'style', 'lighting', 'background', 'freeform']

/** Tolerant read of chain.settings → WorkbenchSessionSettings (documents
 * are external data; absent/wrong fields fall back per-key, never a
 * crash). */
export function readSessionSettings(raw: Record<string, unknown> | null | undefined): WorkbenchSessionSettings {
  const base = sessionSettingsDefaults()
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const str = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback)
  const num = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
  const family = str(record.family, base.family)
  const refs: SessionRefSlot[] = Array.isArray(record.refs)
    ? record.refs.filter((slot): slot is Record<string, unknown> => Boolean(slot) && typeof slot === 'object' && !Array.isArray(slot)).map((slot, index) => {
      const role = ROLES.includes(slot.role as H3ImgRefRole) ? slot.role as H3ImgRefRole : 'freeform'
      const transport = slot.transport === 'native' || slot.transport === 'semantic' ? slot.transport : null
      const source = refSource(slot.source) ?? { kind: 'file' as const, path: '', name: '' }
      return {
        id: typeof slot.id === 'string' && slot.id ? slot.id : `ref-${index}-${Date.now()}`,
        role,
        transport,
        keepOverride: typeof slot.keepOverride === 'number' && Number.isFinite(slot.keepOverride) ? Math.max(0, Math.min(1, slot.keepOverride)) : null,
        note: str(slot.note, ''),
        source,
      }
    })
    : []
  const loras: WorkbenchSessionSettings['loras'] = Array.isArray(record.loras)
    ? record.loras.filter((lora): lora is Record<string, unknown> => Boolean(lora) && typeof lora === 'object' && !Array.isArray(lora)).map((lora) => ({ name: str(lora.name, ''), strength: Math.max(0, Math.min(2, num(lora.strength, 1))) })).filter((lora) => lora.name)
    : []
  const framePicks: Record<string, number> = {}
  const picksRaw = record.framePicks
  if (picksRaw && typeof picksRaw === 'object' && !Array.isArray(picksRaw)) {
    for (const key of Object.keys(picksRaw as Record<string, unknown>)) {
      const value = (picksRaw as Record<string, unknown>)[key]
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) framePicks[key] = value
    }
  }
  const tier = record.tier === 5 || record.tier === 9 || record.tier === 13 || record.tier === 39 ? record.tier : base.tier
  const inbox = record.poserigInbox && typeof record.poserigInbox === 'object' && !Array.isArray(record.poserigInbox)
    ? (() => {
      const candidate = record.poserigInbox as Record<string, unknown>
      return typeof candidate.path === 'string' && typeof candidate.name === 'string' ? { path: candidate.path, name: candidate.name } : null
    })()
    : null
  return {
    ...base,
    family: findH3ImgFamily(family) ? family : base.family,
    intent: str(record.intent, base.intent),
    tier,
    keepDial: Math.max(0, Math.min(1, num(record.keepDial, base.keepDial))),
    seed: Math.max(0, Math.floor(num(record.seed, base.seed))),
    resolution: str(record.resolution, base.resolution),
    loras: loras.slice(0, 2),
    refs: refs.slice(0, 9),
    semanticOverflow: record.semanticOverflow === true,
    framePicks,
    refineEngine: record.refineEngine === 'klein' || record.refineEngine === 'krea2' ? record.refineEngine : '',
    poserigInbox: inbox,
  }
}

/** The effective transport of a slot: expert override > auto-per-role. */
export function effectiveTransport(slot: SessionRefSlot): H3ImgTransport {
  return slot.transport ?? TRANSPORT_FOR_ROLE[slot.role]
}

/** True when any slot carries an expert transport override (surfaced in the
 * UI + provenance). */
export function hasTransportOverrides(refs: SessionRefSlot[]): boolean {
  return refs.some((slot) => slot.transport !== null)
}

/** Composes the generation-time contract from the session (the pure
 * composeWorkbenchPrompt over session state). */
export function sessionContract(settings: WorkbenchSessionSettings, options: { sourceAnchored?: boolean } = {}): string {
  const family = findH3ImgFamily(settings.family)
  const anchoredDefault = family?.kind === 'edit' || family?.kind === 'generate-directed'
  const sourceAnchored = options.sourceAnchored ?? anchoredDefault
  const directed = settings.family === 'h3img.generate.packet.directed'
  const keepOverrides: Record<number, number> = {}
  settings.refs.forEach((slot, index) => {
    if (slot.keepOverride !== null) keepOverrides[index + (sourceAnchored ? 2 : 1)] = slot.keepOverride
  })
  return composeWorkbenchPrompt({
    familyId: settings.family,
    instruction: settings.intent,
    refs: settings.refs.map((slot) => ({ role: slot.role, note: slot.note })),
    sourceAnchored,
    keepDial: settings.keepDial,
    keepOverrides,
    tier: directed ? 39 : settings.tier,
  })
}

// ---- take projections ---------------------------------------------------------

/** The frame provenance riding a generation take's metrics (h3img key). */
export type H3ImgTakeProvenance = {
  family: string
  profile: 'packet' | 't1'
  tier: number
  frames: number
  prompt: string
  refs: Array<{ role: H3ImgRefRole; transport: H3ImgTransport; name?: string }>
  loras: Array<{ name: string; strength: number }>
  seed: number
  resolution: string
  hybrid: boolean
  /** The scorer's verdict summary (null when the scorer could not run —
   * honest, the UI falls back to pick-by-eye). */
  scorer: { bestIndex: number; reason: string; metricBasis: string } | null
  /** The auto-picked canonical frame (scorer; 0 when no scorer). */
  canonicalFrameIndex: number
  /** Take ops (refine / burst-fuse) link their source take. */
  parentTakeId?: string
  op?: 'refine' | 'burst-fuse'
  engine?: string
}

export type FrameArtifact = {
  index: number
  /** Output-contained absolute artifact path (when landed locally). */
  path: string | null
  /** Content-addressed blob artifact (relative), when registered. */
  blob: string | null
}

/** Reads one take's h3img provenance (tolerant — takes are external data). */
export function takeProvenance(take: DocumentTake | null): H3ImgTakeProvenance | null {
  const record = take?.metrics?.h3img
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null
  const raw = record as Record<string, unknown>
  if (typeof raw.family !== 'string') return null
  const str = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback)
  const num = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
  const refs = Array.isArray(raw.refs)
    ? raw.refs.filter((ref): ref is Record<string, unknown> => Boolean(ref) && typeof ref === 'object').map((ref) => ({
      role: (ROLES.includes(ref.role as H3ImgRefRole) ? ref.role : 'freeform') as H3ImgRefRole,
      transport: (ref.transport === 'native' || ref.transport === 'semantic' ? ref.transport : 'native') as H3ImgTransport,
      ...(typeof ref.name === 'string' ? { name: ref.name } : {}),
    }))
    : []
  const loras = Array.isArray(raw.loras)
    ? raw.loras.filter((lora): lora is Record<string, unknown> => Boolean(lora) && typeof lora === 'object').map((lora) => ({ name: str(lora.name), strength: num(lora.strength, 1) })).filter((lora) => lora.name)
    : []
  const scorer = raw.scorer && typeof raw.scorer === 'object' && !Array.isArray(raw.scorer)
    ? (() => {
      const candidate = raw.scorer as Record<string, unknown>
      return typeof candidate.bestIndex === 'number' && typeof candidate.reason === 'string'
        ? { bestIndex: candidate.bestIndex, reason: candidate.reason, metricBasis: str(candidate.metricBasis, 'pixel metrics') }
        : null
    })()
    : null
  return {
    family: raw.family,
    profile: raw.profile === 't1' ? 't1' : 'packet',
    tier: num(raw.tier, 0),
    frames: num(raw.frames, 0),
    prompt: str(raw.prompt),
    refs,
    loras,
    seed: num(raw.seed, 0),
    resolution: str(raw.resolution),
    hybrid: raw.hybrid === true,
    scorer,
    canonicalFrameIndex: Math.max(0, Math.floor(num(raw.canonicalFrameIndex, 0))),
    ...(typeof raw.parentTakeId === 'string' ? { parentTakeId: raw.parentTakeId } : {}),
    ...(typeof raw.op === 'string' ? { op: raw.op as 'refine' | 'burst-fuse' } : {}),
    ...(typeof raw.engine === 'string' ? { engine: raw.engine } : {}),
  }
}

/** The take's frame artifacts, ordered by frame index. */
export function takeFrames(take: DocumentTake | null): FrameArtifact[] {
  if (!take) return []
  const provenance = takeProvenance(take)
  const count = provenance?.frames && provenance.frames > 0 ? provenance.frames : take.artifacts.length
  const frames: FrameArtifact[] = []
  for (let index = 0; index < count; index += 1) {
    const artifact = take.artifacts[index] ?? null
    frames.push({
      index,
      path: artifact && artifact.startsWith('/') ? artifact : null,
      blob: artifact && artifact.startsWith('canvas-blobs/') ? artifact : null,
    })
  }
  return frames
}

/** The servable URL of one frame artifact (blob file route preferred — the
 * verified content-addressed bytes; output media URL as fallback). */
export function frameUrl(frame: FrameArtifact, token?: string | null): string | null {
  const query = (params: Record<string, string>) => {
    const search = new URLSearchParams(params)
    if (token) search.set('token', token)
    return `?${search.toString()}`
  }
  if (frame.blob) return `/api/lan/documents/blobs/file${query({ path: frame.blob })}`
  if (frame.path) return `/api/lan/media${query({ source: 'output', path: frame.path })}`
  return null
}

/** The EFFECTIVE canonical frame of a take: the manual session pick beats
 * the scorer's auto-pick (always overridable). */
export function canonicalFrameIndex(take: DocumentTake | null, framePicks: Record<string, number>): number {
  if (!take) return 0
  const pick = framePicks[take.id]
  if (typeof pick === 'number' && pick >= 0) return pick
  return takeProvenance(take)?.canonicalFrameIndex ?? 0
}

/** True when this chain is a workbench session. */
export function isWorkbenchChain(chain: { kind: string } | null | undefined): boolean {
  return chain?.kind === H3IMG_CHAIN_KIND
}
