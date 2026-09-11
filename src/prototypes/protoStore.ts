/** Wave 3 — the SHARED mock project behind all three UI-direction prototypes.
 *
 *  One zustand store so the artist flips Shot Bench / Stage / Score against
 *  the SAME document: takes pinned in A are pinned in C, re-runs queued in B
 *  advance the queue strip everywhere. No server calls, no generation
 *  wiring — "Generate" is a timer that walks queue items through
 *  queued → running → done (or an honest, repeatable failure).
 *
 *  The document model is deliberately the datablock shape the UX report
 *  landed on: shots own an ordered modifier stack; takes are immutable
 *  render records of a shot at one param set; dependency edges between
 *  shots (continuity) drive cache staleness — an upstream change marks ONLY
 *  downstream takes stale.
 */
import { create } from 'zustand'

export type ProtoDirection = 'bench' | 'stage' | 'score'
export type TakeStatus = 'fresh' | 'stale' | 'rendering'
export type QueueStatus = 'queued' | 'running' | 'done' | 'failed'

export type TakeParams = {
  promptStrength: number
  seed: number
  steps: number
  turbo: 'off' | '4' | '8'
  guidance: number
}

export type Take = {
  id: string
  shotId: string
  label: string
  params: TakeParams
  status: TakeStatus
  pinned: boolean
  /** Set when this take was duplicated from another (the branch gesture). */
  branchedFrom: string | null
  /** Visual variation while the media is one shared sample clip. */
  filter: string
  rate: number
}

export type OpKind = 'prompt' | 'model' | 'seed' | 'upscale' | 'repair'
export type ShotOp = { id: string; kind: OpKind; enabled: boolean; summary: string }

export type Shot = {
  id: string
  name: string
  startBeat: number
  beats: number
  /** Live step count — Operate→Settings edits this in place. */
  steps: number
  /** Ordered modifier stack — prompt → model → seed/LoRA → upscale → repair. */
  ops: ShotOp[]
  /** Continuity edges: this shot continues from these shots' endings. */
  dependsOn: string[]
}

export type QueueItem = {
  id: string
  label: string
  status: QueueStatus
  progress: number
  error: string | null
  /** Takes that flip to fresh when this item completes. */
  takeIds: string[]
  /** Progress at which a retry fails again (the honest-failure demo). */
  failAt: number | null
}

export type LibraryAsset = {
  id: string
  kind: 'image' | 'audio'
  name: string
  meta: string
}

export type StageSelection =
  | { kind: 'shot'; id: string }
  | { kind: 'image'; id: string }
  | { kind: 'audio'; id: string }

export type StageTransform = { scale: number; rotate: number; opacity: number }

export const CLIP_TAKES = 7

const take = (
  id: string, shotId: string, label: string, params: TakeParams,
  look: number, extras: Partial<Take> = {},
): Take => ({
  id, shotId, label, params, status: 'fresh', pinned: false, branchedFrom: null,
  // Distinct looks over the one sample clip: a CSS filter for the eye, a
  // playback rate for the feel, and a frame offset used by the poster
  // generator so every take's poster is genuinely a different frame.
  filter: LOOKS[look].filter, rate: LOOKS[look].rate,
  ...extras,
})

/** Ordered visual identities for takes — index-stable, deterministic. */
export const LOOKS = [
  { filter: 'none', rate: 1 },
  { filter: 'saturate(1.45) contrast(1.12)', rate: 1.18 },
  { filter: 'hue-rotate(185deg) saturate(1.25)', rate: 0.84 },
  { filter: 'sepia(.5) contrast(1.18) brightness(1.06)', rate: 1.32 },
  { filter: 'hue-rotate(320deg) saturate(.8) brightness(1.1)', rate: 1.05 },
  { filter: 'hue-rotate(90deg) saturate(1.1) contrast(.95)', rate: 0.95 },
  { filter: 'saturate(.65) brightness(.88) contrast(1.25)', rate: 1.1 },
]

const ops = (seed: number, prompt: string): ShotOp[] => [
  { id: 'prompt', kind: 'prompt', enabled: true, summary: prompt },
  { id: 'model', kind: 'model', enabled: true, summary: 'MiniMax H3 · I2V' },
  { id: 'seed', kind: 'seed', enabled: true, summary: `seed ${seed} · turbo-lora 0.8` },
  { id: 'upscale', kind: 'upscale', enabled: false, summary: '×2 SeedVR2' },
  { id: 'repair', kind: 'repair', enabled: false, summary: 'face refine · light' },
]

const initialShots: Shot[] = [
  { id: 'shot-1', name: 'Rain street — wide push-in', startBeat: 0, beats: 8, steps: 30, dependsOn: [], ops: ops(128441, 'rain-slick street, neon reflections, slow push') },
  { id: 'shot-2', name: 'Drummer — close-up, strobe', startBeat: 8, beats: 8, steps: 30, dependsOn: [], ops: ops(5511, 'drummer lit by strobe, sweat, tight framing') },
  { id: 'shot-3', name: 'Alley sprint', startBeat: 16, beats: 8, steps: 35, dependsOn: ['shot-2'], ops: ops(77701, 'sprint down flooded alley, continues from prior ending') },
  { id: 'shot-4', name: 'Roofline — dawn', startBeat: 24, beats: 8, steps: 25, dependsOn: [], ops: ops(40404, 'city roofline, first light, wide static') },
]

const initialTakes: Take[] = [
  take('s1t1', 'shot-1', 'T1', { promptStrength: 6.5, seed: 128441, steps: 30, turbo: 'off', guidance: 1.0 }, 0),
  take('s1t2', 'shot-1', 'T2', { promptStrength: 6.5, seed: 128441, steps: 40, turbo: 'off', guidance: 1.0 }, 1),
  take('s1t3', 'shot-1', 'T3', { promptStrength: 6.5, seed: 90210, steps: 40, turbo: '4', guidance: 1.2 }, 2),
  take('s1t4', 'shot-1', 'T4', { promptStrength: 7.5, seed: 90210, steps: 40, turbo: '4', guidance: 1.2 }, 3),
  take('s2t1', 'shot-2', 'T1', { promptStrength: 6.0, seed: 5511, steps: 30, turbo: 'off', guidance: 1.0 }, 4),
  take('s2t2', 'shot-2', 'T2', { promptStrength: 6.0, seed: 5512, steps: 30, turbo: 'off', guidance: 1.0 }, 5),
  take('s3t1', 'shot-3', 'T1', { promptStrength: 7.0, seed: 77701, steps: 35, turbo: 'off', guidance: 1.1 }, 1),
  take('s4t1', 'shot-4', 'T1', { promptStrength: 5.5, seed: 40404, steps: 25, turbo: '8', guidance: 0.9 }, 6),
]

const OOM_ERROR = 'CUDA out of memory during latent encode (node VAEEncodeTiled, 1536×864, tile 512). Free VRAM or reduce tile size — the engine kept every earlier job in the batch.'

const initialQueue: QueueItem[] = [
  { id: 'q-done', label: 'shot-4 · T1 — final pass', status: 'done', progress: 100, error: null, takeIds: [], failAt: null },
  { id: 'q-fail', label: 'shot-2 · T1 upscale ×2 (SeedVR2)', status: 'failed', progress: 61, error: OOM_ERROR, takeIds: [], failAt: 61 },
  { id: 'q-run', label: 'shot-1 · T3 — refine pass', status: 'running', progress: 34, error: null, takeIds: [], failAt: null },
]

export const libraryAssets: LibraryAsset[] = [
  { id: 'lib-plate', kind: 'image', name: 'Neon alley — plate', meta: '1536 × 864 · PNG' },
  { id: 'lib-stems', kind: 'audio', name: 'Rains on Glass — stems', meta: '92 BPM · 4 stems · 1:32' },
]

// ---------------------------------------------------------------------------
// Derived helpers (pure — shared by all three views)

export const takesOfShot = (takes: Take[], shotId: string): Take[] =>
  takes.filter((entry) => entry.shotId === shotId)

/** Shots that transitively continue from `shotId` (plus the shot itself). */
export const downstreamShots = (shots: Shot[], shotId: string): string[] => {
  const found = new Set<string>([shotId])
  let grew = true
  while (grew) {
    grew = false
    for (const shot of shots) {
      if (shot.dependsOn.some((parent) => found.has(parent)) && !found.has(shot.id)) {
        found.add(shot.id)
        grew = true
      }
    }
  }
  return Array.from(found)
}

export type ParamDiffRow = { field: string; from: string; to: string }

const PARAM_FIELDS: Array<{ key: keyof TakeParams; label: string; format: (value: string | number) => string }> = [
  { key: 'promptStrength', label: 'prompt strength', format: (v) => String(v) },
  { key: 'seed', label: 'seed', format: (v) => String(v) },
  { key: 'steps', label: 'steps', format: (v) => String(v) },
  { key: 'turbo', label: 'turbo', format: (v) => String(v) },
  { key: 'guidance', label: 'guidance', format: (v) => (typeof v === 'number' ? v.toFixed(1) : v) },
]

/** The param-diff between adjacent takes — the A1111 X/Y/Z plot as a first-class view. */
export const diffTakes = (previous: Take, current: Take): ParamDiffRow[] => {
  const rows: ParamDiffRow[] = []
  for (const field of PARAM_FIELDS) {
    const from = previous.params[field.key] as string | number
    const to = current.params[field.key] as string | number
    if (from !== to) {
      rows.push({ field: field.label, from: field.format(from), to: field.format(to) })
    }
  }
  return rows
}

// ---------------------------------------------------------------------------
// Queue engine — a module-scoped ticker, alive only while something runs.

type ProtoState = {
  direction: ProtoDirection
  shots: Shot[]
  takes: Take[]
  queue: QueueItem[]
  posters: Record<string, string>
  /** Shot Bench / Score current shot. */
  selectedShotId: string
  /** Current take index within the selected shot (Shot Bench cycling). */
  benchTakeIndex: number
  /** Stage: the selected object + per-object mock render activity. */
  stageSelection: StageSelection | null
  stageView: { x: number; y: number; z: number }
  stageRender: Record<string, number>
  stageTransforms: Record<string, StageTransform>
  stageTakeIndex: Record<string, number>
  /** Score: projection + tree expansion. */
  scoreProjection: 'timeline' | 'graph'
  scoreExpanded: Record<string, boolean>
  scoreHoverShot: string | null
  // ---- actions
  setDirection(direction: ProtoDirection): void
  setPoster(id: string, url: string): void
  selectShot(shotId: string): void
  cycleTake(delta: number): void
  setBenchTakeIndex(index: number): void
  toggleOp(shotId: string, opId: string): void
  setSeed(shotId: string, seed: number): void
  setShotPrompt(shotId: string, prompt: string): void
  setShotSteps(shotId: string, steps: number): void
  rerunStale(shotId: string): void
  branchTake(shotId: string, takeId: string): void
  pinTake(shotId: string, takeId: string): void
  enqueue(label: string, options?: { takeIds?: string[]; failAt?: number }): void
  retryQueueItem(id: string): void
  dismissQueueItem(id: string): void
  selectStageObject(selection: StageSelection | null): void
  setStageView(view: { x: number; y: number; z: number }): void
  kickStageRender(objectId: string): void
  setStageTransform(id: string, transform: StageTransform): void
  cycleStageTake(shotId: string, delta: number): void
  setScoreProjection(projection: 'timeline' | 'graph'): void
  toggleScoreNode(id: string): void
  setScoreHoverShot(shotId: string | null): void
}

let queueTicker: number | null = null
let queueTicket = 0

const ensureTicker = () => {
  if (queueTicker !== null || typeof window === 'undefined') return
  queueTicker = window.setInterval(tickQueue, 140)
}

/** Called once when a prototype mounts: the seeded running item starts
 *  advancing so the queue reads as ALIVE from the first frame. */
export const ensureQueueAlive = () => {
  ensureTicker()
  tickQueue()
}

const stopTicker = () => {
  if (queueTicker !== null && typeof window !== 'undefined') {
    window.clearInterval(queueTicker)
    queueTicker = null
  }
}

/** One tick of mock work: promote queued → running, advance running items,
 *  complete or fail them, and settle takes ONLY on the completion
 *  transition — an item that finished last tick must never keep re-freshing
 *  takes a later param change marked stale again. */
const tickQueue = () => {
  const queue = useProtoStore.getState().queue.map((item) => ({ ...item }))
  const finishedTakeIds: string[] = []
  const failedTakeIds: string[] = []
  const renderingTakeIds: string[] = []
  let changed = false

  for (const item of queue) {
    if (item.status !== 'running') continue
    item.progress = Math.min(100, item.progress + 2 + Math.random() * 4)
    if (item.failAt !== null && item.progress >= item.failAt) {
      item.status = 'failed'
      item.progress = item.failAt
      failedTakeIds.push(...item.takeIds)
      changed = true
    } else if (item.progress >= 100) {
      item.status = 'done'
      item.progress = 100
      finishedTakeIds.push(...item.takeIds)
      changed = true
    } else {
      changed = true
    }
  }

  const running = queue.filter((item) => item.status === 'running').length
  if (running < 2) {
    const next = queue.find((item) => item.status === 'queued')
    if (next) {
      next.status = 'running'
      next.progress = 0
      renderingTakeIds.push(...next.takeIds)
      changed = true
    }
  }

  if (changed) {
    useProtoStore.setState((current) => ({
      queue,
      takes: current.takes.map((entry) => {
        if (finishedTakeIds.includes(entry.id)) return entry.status === 'fresh' ? entry : { ...entry, status: 'fresh' }
        if (failedTakeIds.includes(entry.id)) return entry.status === 'stale' ? entry : { ...entry, status: 'stale' }
        if (renderingTakeIds.includes(entry.id)) return entry.status === 'rendering' ? entry : { ...entry, status: 'rendering' }
        return entry
      }),
    }))
  }

  if (!useProtoStore.getState().queue.some((item) => item.status === 'queued' || item.status === 'running')) stopTicker()
}

/** Marks every fresh take in `shotIds` stale — the deferred-commit surface. */
const markStale = (shotIds: string[]) => {
  useProtoStore.setState((current) => ({
    takes: current.takes.map((entry) =>
      shotIds.includes(entry.shotId) && entry.status === 'fresh' ? { ...entry, status: 'stale' } : entry),
  }))
}

/** Direction comes from the URL (?proto=) — this chunk only loads under a
 *  valid proto param, so the store never guesses. */
const directionFromUrl = (): ProtoDirection => {
  if (typeof window === 'undefined') return 'bench'
  const value = new URLSearchParams(window.location.search).get('proto')
  return value === 'stage' || value === 'score' ? value : 'bench'
}

export const useProtoStore = create<ProtoState>()((set) => ({
  direction: directionFromUrl(),
  shots: initialShots,
  takes: initialTakes,
  queue: initialQueue,
  posters: {},
  selectedShotId: 'shot-1',
  benchTakeIndex: 0,
  stageSelection: null,
  stageView: { x: 24, y: 18, z: 0.82 },
  stageRender: {},
  stageTransforms: { 'lib-plate': { scale: 1, rotate: 0, opacity: 1 }, 'lib-stems': { scale: 0.8, rotate: 0, opacity: 1 } },
  stageTakeIndex: {},
  scoreProjection: 'timeline',
  scoreExpanded: { 'shot-1': true, 'shot-2': true },
  scoreHoverShot: null,

  setDirection: (direction) => {
    set({ direction })
    // Keep the URL in sync so a reload (or a shared link) lands on the same
    // direction; replaceState never remounts anything.
    try {
      const url = new URL(window.location.href)
      url.searchParams.set('proto', direction)
      window.history.replaceState(null, '', url)
    } catch {
      /* URL sync is a convenience, never a gate. */
    }
  },
  setPoster: (id, url) => set((state) => ({ posters: { ...state.posters, [id]: url } })),

  selectShot: (shotId) => set({ selectedShotId: shotId, benchTakeIndex: 0 }),

  cycleTake: (delta) => set((state) => {
    const count = takesOfShot(state.takes, state.selectedShotId).length
    if (count === 0) return {}
    const index = (state.benchTakeIndex + delta + count) % count
    return { benchTakeIndex: index < 0 ? index + count : index }
  }),
  setBenchTakeIndex: (index) => set({ benchTakeIndex: Math.max(0, index) }),

  toggleOp: (shotId, opId) => {
    set((state) => ({
      shots: state.shots.map((shot) => shot.id === shotId
        ? { ...shot, ops: shot.ops.map((op) => (op.id === opId ? { ...op, enabled: !op.enabled } : op)) }
        : shot),
    }))
    markStale(downstreamShots(useProtoStore.getState().shots, shotId))
  },

  setSeed: (shotId, seed) => {
    set((state) => ({
      shots: state.shots.map((shot) => shot.id === shotId
        ? { ...shot, ops: shot.ops.map((op) => (op.kind === 'seed' ? { ...op, summary: `seed ${seed} · turbo-lora 0.8` } : op)) }
        : shot),
    }))
    markStale(downstreamShots(useProtoStore.getState().shots, shotId))
  },

  setShotPrompt: (shotId, prompt) => {
    set((state) => ({
      shots: state.shots.map((shot) => shot.id === shotId
        ? { ...shot, ops: shot.ops.map((op) => (op.kind === 'prompt' ? { ...op, summary: prompt } : op)) }
        : shot),
    }))
    markStale(downstreamShots(useProtoStore.getState().shots, shotId))
  },

  setShotSteps: (shotId, steps) => {
    set((state) => ({
      shots: state.shots.map((shot) => shot.id === shotId ? { ...shot, steps } : shot),
    }))
    markStale(downstreamShots(useProtoStore.getState().shots, shotId))
  },

  rerunStale: (shotId) => {
    const state = useProtoStore.getState()
    const stale = takesOfShot(state.takes, shotId).filter((entry) => entry.status === 'stale')
    if (stale.length === 0) return
    const shot = state.shots.find((entry) => entry.id === shotId)
    useProtoStore.getState().enqueue(`Re-run · ${shot?.name ?? shotId} · ${stale.length} stale take${stale.length > 1 ? 's' : ''}`, {
      takeIds: stale.map((entry) => entry.id),
    })
  },

  branchTake: (shotId, takeId) => {
    const state = useProtoStore.getState()
    const source = state.takes.find((entry) => entry.id === takeId)
    if (!source) return
    const siblings = takesOfShot(state.takes, shotId)
    const nextIndex = siblings.length
    const look = LOOKS[nextIndex % LOOKS.length]
    const branched: Take = {
      ...source,
      id: `${shotId}-b${nextIndex + 1}`,
      label: `T${nextIndex + 1}`,
      branchedFrom: source.label,
      pinned: false,
      status: 'stale',
      filter: look.filter,
      rate: look.rate,
      params: { ...source.params, seed: source.params.seed + 1 },
    }
    set((current) => ({ takes: [...current.takes, branched] }))
    useProtoStore.getState().enqueue(`Branch · ${source.label} → ${branched.label} (${shotId})`, { takeIds: [branched.id] })
  },

  pinTake: (shotId, takeId) => set((state) => ({
    takes: state.takes.map((entry) => {
      if (entry.shotId !== shotId) return entry
      return { ...entry, pinned: entry.id === takeId ? !entry.pinned : false }
    }),
  })),

  enqueue: (label, options) => {
    queueTicket += 1
    set((state) => ({
      queue: [...state.queue, {
        id: `q-${queueTicket}`,
        label,
        status: 'queued',
        progress: 0,
        error: null,
        takeIds: options?.takeIds ?? [],
        failAt: options?.failAt ?? null,
      }],
    }))
    ensureTicker()
  },

  retryQueueItem: (id) => {
    set((state) => ({
      queue: state.queue.map((item) => item.id === id
        ? { ...item, status: 'queued', progress: 0, error: null }
        : item),
    }))
    ensureTicker()
  },

  dismissQueueItem: (id) => set((state) => ({ queue: state.queue.filter((item) => item.id !== id) })),

  selectStageObject: (selection) => set({ stageSelection: selection }),
  setStageView: (view) => set({ stageView: view }),
  /** Restarts the object's mock render overlay (Operate→Settings: the change
   *  IS the run — no dialog, the object shows its own progress). */
  kickStageRender: (objectId) => {
    set((state) => ({ stageRender: { ...state.stageRender, [objectId]: Date.now() } }))
  },
  setStageTransform: (id, transform) => set((state) => ({
    stageTransforms: { ...state.stageTransforms, [id]: transform },
  })),
  cycleStageTake: (shotId, delta) => set((state) => {
    const count = takesOfShot(state.takes, shotId).length
    if (count === 0) return {}
    const current = state.stageTakeIndex[shotId] ?? 0
    const next = ((current + delta) % count + count) % count
    return { stageTakeIndex: { ...state.stageTakeIndex, [shotId]: next } }
  }),

  setScoreProjection: (projection) => set({ scoreProjection: projection }),
  toggleScoreNode: (id) => set((state) => ({ scoreExpanded: { ...state.scoreExpanded, [id]: !state.scoreExpanded[id] } })),
  setScoreHoverShot: (shotId) => set({ scoreHoverShot: shotId }),
}))

/** The project's tempo — the Score's ruler is music-first. */
export const BPM = 92
export const TOTAL_BEATS = 32
