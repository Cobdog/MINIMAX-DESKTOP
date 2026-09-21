/**
 * H3 Image Workbench — the dedicated surface (task k9vu6t0, spec §2:
 * the ?datasets=1 precedent). Own lazy route at ?images=1: the mode rail
 * (Generate packet/T=1/directed, Compose, the six Edit families, Refine,
 * Burst gated, Exit), the preview canvas, the 9-slot reference strip with
 * roles + auto-per-role transports + expert override, the Keep dial with
 * per-picture overrides, 2 LoRA slots (form-adapter first, guidance), the
 * TAKE STRIP as the pick surface (frame artifacts of one take; the
 * first-party scorer's verdict; manual pick = the canonical frame pointer),
 * the always-opt-in one-tap Refine affordance with engine pairing, the
 * consent-gated canvas handoffs both ways, and the start-frame exit.
 *
 * The session is a canvas chain of kind 'h3img' in the ACTIVE project (the
 * document-store object, spec §2) — generations land as packet takes
 * through the shared landing loop; nothing here re-implements queueing.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ImagePlus, Layers, LoaderCircle, Lock, Send, Settings, Sparkles, Wand2 } from 'lucide-react'
import { useStudioSession } from '../hooks/useStudioSession'
import { useGenerationQueue } from '../hooks/useGenerationQueue'
import { useLivePreview } from '../lib/useLivePreview'
import { useSessionStore } from '../state/sessionStore'
import { submitH3DiagnosticPair } from '../lib/h3Diagnostics'
import { SettingsDock } from '../canvas/SettingsDock'
import { LibraryDock } from '../components/LibraryDock'
import { RemediationDock } from '../canvas/RemediationDock'
import { CanvasSessionContext } from '../canvas/sessionContext'
import { useJobsStore } from '../state/jobsStore'
import { useCanvasStore, engineBridge } from '../canvas/store'
import { documentsApi } from '../canvas/api'
import type { DocumentChain, DocumentTake } from '../canvas/derive'
import type { MediaFile } from '../types'
import { submitWorkbenchGeneration, workbenchAvailability } from './submit'
import type { ResolvedRef } from './submit'
import { burstFuse } from '../lib/h3imageOps'
import { createStageExecutor } from '../lib/h3imageStaging'
import { H3IMG_OP_TONE_LOCK, canonicalFrameIndex, frameUrl, isWorkbenchChain, readSessionSettings, sessionContract, takeFrames, takeProvenance } from './session'
import type { SessionRefSlot, WorkbenchSessionSettings } from './session'
import { BEYOND_NINE_GUIDANCE, keepDialHint } from '../lib/h3imageContract'
import { H3IMG_RECIPE_PINS, STOCK_SAMPLED_FRAMES, TRANSPORT_FOR_ROLE, findH3ImgFamily, packetTierLabel } from '../lib/graph/h3image'
import type { H3ImgRefRole } from '../lib/graph/h3image'
import { mediaForOutput, buildOutputIndex } from '../canvas/generation'
import { chainSettingsDefaults } from '../canvas/generation'
import { CANVAS_EDIT_HANDOFF_KEY, handoffPreviewUrl } from '../canvas/stillIntent'
import { SurfaceSwitcher } from '../surfaces/SurfaceSwitcher'
import './workbench.css'

const ROLES: H3ImgRefRole[] = ['subject', 'pose', 'style', 'lighting', 'background', 'freeform']

/** The E-IW2 experiment gate (burst lane) — off until the experiment
 * promotes defaults; a localStorage opt-in exists for the experiment run. */
export const IW_EXPERIMENTS_KEY = 'h3img-experiments'

function experimentsEnabled(): boolean {
  try {
    return window.localStorage.getItem(IW_EXPERIMENTS_KEY) === 'on'
  } catch {
    return false
  }
}

/** The engine/session host for the workbench route (the CanvasEngineHost
 * pattern: the shared hooks keep one queue, one engine session — mounted
 * outside the canvas shell). (R-21, Wave 3) the host PROVIDES the session
 * context so the docked Settings + Library surfaces mount HERE too —
 * opening settings from the workbench no longer replaces the view. */
function WorkbenchEngineHost({ children }: { children: ReactNode }) {
  const toast = useCanvasStore((state) => state.toast)
  const notify = useCallback((tone: 'error' | 'success' | 'neutral', text: string) => toast(tone, text), [toast])
  const session = useStudioSession()
  const queue = useGenerationQueue({ settings: session.settings, connected: session.status.connected, notify })
  const live = useLivePreview(session.settings?.comfyUrl, true, queue.onLiveProgress)
  engineBridge.clientId = live.clientId
  engineBridge.cancellationRequests = queue.cancellationRequests
  engineBridge.cancelJob = (job) => void queue.cancelJob(job)
  const runDiagnostics = async () => {
    const state = useSessionStore.getState()
    if (!state.settings) return 'Studio settings are still loading.'
    return submitH3DiagnosticPair(
      { settings: state.settings, connected: state.status.connected, models: state.models, info: state.info, clientId: engineBridge.clientId },
      {
        notify: (tone2, text) => useCanvasStore.getState().toast(tone2, text),
        setJobs: (update) => useJobsStore.getState().setJobs(update),
      },
    )
  }
  return <CanvasSessionContext.Provider value={{ session, runDiagnostics }}>
    {children}
    <SettingsDock />
    <LibraryDock />
    <RemediationDock />
  </CanvasSessionContext.Provider>
}

const MODE_GROUPS: Array<{ mode: string; label: string; families: string[] }> = [
  { mode: 'generate', label: 'Generate', families: ['h3img.generate.packet', 'h3img.generate.packet.directed', 'h3img.generate.t1'] },
  { mode: 'compose', label: 'Compose', families: ['h3img.compose.refs'] },
  { mode: 'edit', label: 'Edit', families: ['h3img.edit.identity', 'h3img.edit.background', 'h3img.edit.outfit', 'h3img.edit.lighting', 'h3img.edit.pose', 'h3img.edit.freeform'] },
  { mode: 'refine', label: 'Refine', families: ['h3img.refine.krea2', 'h3img.refine.klein'] },
  { mode: 'burst', label: 'Burst', families: ['h3img.burst.fuse', 'h3img.burst.seedvr2'] },
  { mode: 'exit', label: 'Exit', families: ['h3img.exit.anchor'] },
]

export function WorkbenchApp() {
  return (
    <WorkbenchEngineHost>
      <WorkbenchSurface />
    </WorkbenchEngineHost>
  )
}

function WorkbenchSurface() {
  const boot = useCanvasStore((state) => state.boot)
  const phase = useCanvasStore((state) => state.phase)
  const activeProjectId = useCanvasStore((state) => state.activeProjectId)
  const documents = useCanvasStore((state) => state.documents)
  const toasts = useCanvasStore((state) => state.toasts)
  const sessionState = useSessionStore()
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sourceFile, setSourceFile] = useState<{ path: string; name: string; preview?: string } | null>(null)
  const [refineInstruction, setRefineInstruction] = useState('')
  const [exitOpen, setExitOpen] = useState(false)
  const [canvasPickerOpen, setCanvasPickerOpen] = useState(false)
  const [experiments, setExperiments] = useState(experimentsEnabled())
  const fileInput = useRef<HTMLInputElement | null>(null)
  const sourceInput = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    void boot()
  }, [boot])
  // jobsStore ticks drive the shared landing loop + tile recompute.
  useEffect(() => useJobsStore.subscribe(() => useCanvasStore.getState().recompute()), [])

  const doc = activeProjectId ? documents[activeProjectId] ?? null : null
  const sessionChain = useMemo(() => doc?.chains.find((chain) => isWorkbenchChain(chain)) ?? null, [doc])

  // Session bootstrap: the workbench session is a chain of kind 'h3img' in
  // the active project — created on first open (the user's explicit act of
  // opening the workbench in this project).
  const ensureSession = useCallback(async () => {
    if (!doc) return null
    const existing = doc.chains.find((chain) => isWorkbenchChain(chain))
    if (existing) return existing
    try {
      const chain = await documentsApi.createChain({
        projectId: doc.project.id,
        kind: 'h3img',
        settings: { family: 'h3img.generate.packet', intent: '', tier: 5, keepDial: 0.55, seed: Math.floor(Math.random() * 1_000_000_000), resolution: '1344x768', loras: [], refs: [], semanticOverflow: false, framePicks: {}, refineEngine: '', poserigInbox: null } as unknown as Record<string, unknown>,
      })
      await useCanvasStore.getState().reloadActiveDocument()
      return chain
    } catch (error) {
      setNotice(`The workbench session could not be created: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }, [doc])

  useEffect(() => {
    if (phase === 'ready' && doc && !sessionChain) void ensureSession()
  }, [phase, doc, sessionChain, ensureSession])

  // No open canvas: opening the workbench IS the consent to create its home
  // canvas (the seedChain precedent — a surface that needs a project makes
  // one rather than dead-ending on a spinner).
  useEffect(() => {
    if (phase === 'ready' && !doc) void useCanvasStore.getState().createCanvas()
  }, [phase, doc])

  const settings = useMemo(() => readSessionSettings(sessionChain?.settings), [sessionChain])
  const availability = useMemo(() => (sessionState.models.length || sessionState.status.connected ? workbenchAvailability({ info: sessionState.info, models: sessionState.models }) : []), [sessionState.models, sessionState.info, sessionState.status.connected])
  const detectionOf = useCallback((familyId: string) => availability.find((entry) => entry.family.id === familyId)?.detection ?? null, [availability])

  const patchSettings = useCallback(async (patch: Partial<WorkbenchSessionSettings>) => {
    if (!sessionChain) return
    const next = { ...readSessionSettings(sessionChain.settings), ...patch }
    try {
      await documentsApi.updateChain({ id: sessionChain.id, settings: next as unknown as Record<string, unknown> })
      await useCanvasStore.getState().reloadActiveDocument()
    } catch (error) {
      setNotice(`The session could not be saved: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [sessionChain])

  // The takes of the session (the pick surface), newest-first.
  const takes = useMemo(() => {
    if (!sessionChain) return [] as DocumentTake[]
    return sessionChain.outputs.flatMap((output) => output.takes).sort((a, b) => b.createdAt - a.createdAt)
  }, [sessionChain])
  const [selectedTakeId, setSelectedTakeId] = useState<string | null>(null)
  const selectedTake = useMemo(() => takes.find((take) => take.id === selectedTakeId) ?? takes.find((take) => take.supersededBy === null) ?? takes[0] ?? null, [takes, selectedTakeId])
  const selectedProvenance = takeProvenance(selectedTake)
  const frames = useMemo(() => takeFrames(selectedTake), [selectedTake])
  const effectivePick = canonicalFrameIndex(selectedTake, settings.framePicks)
  const family = findH3ImgFamily(settings.family)

  // The composer preview (generated, read-only — never hand-written).
  const contract = useMemo(() => sessionContract(settings, { sourceAnchored: Boolean(sourceFile) && (family?.kind === 'edit' || family?.kind === 'generate-directed') }), [settings, sourceFile, family])

  // Ref slot management -------------------------------------------------------
  const addFileRef = useCallback((file: File) => {
    const preview = URL.createObjectURL(file)
    void (async () => {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        let binary = ''
        const chunk = 0x8000
        for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
        const ingested = await documentsApi.ingestBlob({ dataBase64: btoa(binary), name: file.name, kind: 'image' })
        const current = readSessionSettings(sessionChain?.settings)
        if (current.refs.length >= 9) {
          setNotice(BEYOND_NINE_GUIDANCE)
          return
        }
        const slot: SessionRefSlot = {
          id: `ref-${Date.now()}`,
          // Smart default from the source: poserig renders default to pose.
          role: /poserig|pose/i.test(file.name) ? 'pose' : 'subject',
          transport: null,
          keepOverride: null,
          note: '',
          source: { kind: 'file', path: ingested.path, name: file.name, preview },
        }
        await patchSettings({ refs: [...current.refs, slot] })
      } catch (error) {
        setNotice(`The reference could not be added: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  }, [sessionChain, patchSettings])

  // The anchored source: bytes land through the blob ingest so the path is
  // uploadable (an object URL is not a filesystem path).
  const pickSource = useCallback(async (file: File) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      let binary = ''
      const chunk = 0x8000
      for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
      const ingested = await documentsApi.ingestBlob({ dataBase64: btoa(binary), name: file.name, kind: 'image' })
      setSourceFile({ path: ingested.path, name: file.name, preview: `/api/lan/documents/blobs/file?path=${encodeURIComponent(ingested.blob.relPath)}` })
    } catch (error) {
      setNotice(`The source image could not be added: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [])

  // Poserig handoff inbox (the rig surface stashes a render for the workbench).
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem('h3img-poserig-handoff')
      if (!raw) return
      const parsed = JSON.parse(raw) as { path: string; name: string }
      window.localStorage.removeItem('h3img-poserig-handoff')
      const current = readSessionSettings(sessionChain?.settings)
      if (current.refs.length >= 9) {
        setNotice(BEYOND_NINE_GUIDANCE)
        return
      }
      void patchSettings({ refs: [...current.refs, { id: `ref-${Date.now()}`, role: 'pose', transport: null, keepOverride: null, note: 'poserig render', source: { kind: 'poserig', path: parsed.path, name: parsed.name } }] })
    } catch {
      /* a malformed handoff is dropped silently — it is a convenience key */
    }
  }, [sessionChain, patchSettings])

  // Canvas image+control handoff (34afx79, dated decision 2026-09-19): the
  // canvas's stills intent with a BOUND image routes HERE — the Edit surface
  // with the image anchored as the source (Picture 1). The canvas ships no
  // control-stills graph; reference/canny-style image work is this surface's
  // job (the ControlNet-Union-on-Z-Image path retired with Z-Image). Unlike
  // the poserig inbox, this consumes ONLY once the session chain exists — a
  // first-open handoff survives the session bootstrap instead of being read
  // and dropped before it can land.
  useEffect(() => {
    if (!sessionChain) return
    try {
      const raw = window.localStorage.getItem(CANVAS_EDIT_HANDOFF_KEY)
      if (!raw) return
      window.localStorage.removeItem(CANVAS_EDIT_HANDOFF_KEY)
      const parsed = JSON.parse(raw) as { path: string; name: string; intent: string }
      if (typeof parsed.path !== 'string' || !parsed.path) return
      setSourceFile({ path: parsed.path, name: typeof parsed.name === 'string' && parsed.name ? parsed.name : parsed.path.split('/').pop() ?? 'source.png', preview: handoffPreviewUrl(parsed.path) })
      void patchSettings({ family: 'h3img.edit.freeform', intent: typeof parsed.intent === 'string' ? parsed.intent : '' })
      setNotice('Canvas handoff: the bound image is anchored as the Edit source (Picture 1) — name the change in the intent box, then generate.')
    } catch {
      /* a malformed handoff is dropped silently — it is a convenience key */
    }
  }, [sessionChain, patchSettings])

  // The resolved refs for submission (canvas slots resolve through the
  // document's output index; file/poserig slots carry their paths).
  const resolveRefs = useCallback((): ResolvedRef[] => {
    if (!doc) return []
    const index = buildOutputIndex(doc)
    return settings.refs.flatMap((slot) => {
      if (slot.source.kind === 'canvas') {
        const entry = index.get(slot.source.outputId)
        const resolved = mediaForOutput(entry, slot.source.takeId)
        if (!resolved) return []
        return [{ media: resolved.media, role: slot.role, transport: slot.transport ?? TRANSPORT_FOR_ROLE[slot.role], note: slot.note }]
      }
      if (slot.source.kind === 'refmod') return [] // read-only in v1 — never submitted
      return [{ media: { path: slot.source.path, name: slot.source.name, kind: 'image' }, role: slot.role, transport: slot.transport ?? TRANSPORT_FOR_ROLE[slot.role], note: slot.note }]
    })
  }, [doc, settings.refs])

  // Generation ----------------------------------------------------------------
  const generate = useCallback(async () => {
    if (!sessionChain || !sessionState.settings) {
      if (!sessionState.settings) setNotice('Studio settings are still loading.')
      return
    }
    setBusy(true)
    try {
      await submitWorkbenchGeneration(
        {
          chainId: sessionChain.id,
          settings,
          refs: resolveRefs(),
          source: sourceFile ? { path: sourceFile.path, name: sourceFile.name, kind: 'image', ...(sourceFile.preview ? { preview: sourceFile.preview } : {}) } : null,
        },
        {
          settings: sessionState.settings!,
          connected: sessionState.status.connected,
          models: sessionState.models,
          info: sessionState.info,
          clientId: engineBridge.clientId,
        },
        {
          notify: (tone, text) => useCanvasStore.getState().toast(tone, text),
          setJobs: (update) => useJobsStore.getState().setJobs(update),
          cancellationRequests: engineBridge.cancellationRequests,
        },
      )
    } finally {
      setBusy(false)
    }
  }, [sessionChain, settings, resolveRefs, sourceFile, sessionState])

  // Refine (always opt-in) ----------------------------------------------------
  const refine = useCallback(async (engine: 'klein' | 'krea2') => {
    if (!sessionChain || !selectedTake) return
    const frame = frames[effectivePick]
    const framePath = frame?.path ?? frame?.blob
    if (!framePath) {
      setNotice('The picked frame has no landed artifact to refine yet.')
      return
    }
    // An output-contained path uploads by path; a blob-only artifact (its
    // absolute copy may be gone) uploads as bytes through the image-data
    // route — either way the engine sees the exact frame.
    let uploadable: MediaFile
    if (frame?.path) {
      uploadable = { path: frame.path, name: `frame-${effectivePick}.png`, kind: 'image' }
    } else {
      const blobUrl = `/api/lan/documents/blobs/file?path=${encodeURIComponent(framePath)}`
      const blob = await (await fetch(blobUrl)).blob()
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.readAsDataURL(blob)
      })
      uploadable = { path: dataUrl, name: `frame-${effectivePick}.png`, kind: 'image', preview: dataUrl }
    }
    if (!refineInstruction.trim()) {
      setNotice('Name the defect to refine (e.g. "sharpen the hair, keep everything else").')
      return
    }
    if (!sessionState.settings) {
      setNotice('Studio settings are still loading.')
      return
    }
    setBusy(true)
    try {
      // VRAM staging (spec §4): the refine stage frees the generation
      // engine first — Generate → /free → Refine.
      const executor = createStageExecutor(() => window.minimax.freeComfyMemory(sessionState.settings?.comfyUrl ?? ''))
      await executor.run(
        [{ familyId: settings.family, label: 'generate' }, { familyId: engine === 'krea2' ? 'h3img.refine.krea2' : 'h3img.refine.klein', label: 'refine' }],
        async (stage) => {
          if (stage.familyId !== 'h3img.refine.krea2' && stage.familyId !== 'h3img.refine.klein') return null
          await submitWorkbenchGeneration(
            {
              chainId: sessionChain.id,
              settings: { ...settings, family: stage.familyId },
              refs: [],
              source: uploadable,
              refine: { engine, instruction: refineInstruction.trim(), frame: uploadable, parentTakeId: selectedTake.id },
            },
            {
              settings: sessionState.settings!,
              connected: sessionState.status.connected,
              models: sessionState.models,
              info: sessionState.info,
              clientId: engineBridge.clientId,
            },
            {
              notify: (tone, text) => useCanvasStore.getState().toast(tone, text),
              setJobs: (update) => useJobsStore.getState().setJobs(update),
              cancellationRequests: engineBridge.cancellationRequests,
            },
          )
          return null
        },
      )
    } finally {
      setBusy(false)
    }
  }, [sessionChain, selectedTake, frames, effectivePick, refineInstruction, settings, sessionState])

  // Burst-fuse (app-side, gated) ----------------------------------------------
  const runBurstFuse = useCallback(async () => {
    if (!experiments) {
      setNotice('The burst lane is gated behind the E-IW2 experiment (off by default; defaults only if the experiment proves them).')
      return
    }
    if (!sessionChain || !selectedTake) return
    const provenance = takeProvenance(selectedTake)
    if (!provenance || provenance.frames < 2) {
      setNotice('Burst-fuse needs a packet take with at least two frames (the T=1 path has no neighbors).')
      return
    }
    setBusy(true)
    try {
      const decode = async (url: string) => {
        const blob = await (await fetch(url)).blob()
        const bitmap = await createImageBitmap(blob)
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const context = canvas.getContext('2d')
        if (!context) throw new Error('no 2d context')
        context.drawImage(bitmap, 0, 0)
        const data = context.getImageData(0, 0, bitmap.width, bitmap.height)
        return { image: { width: bitmap.width, height: bitmap.height, data: data.data }, canvas }
      }
      const targetIndex = effectivePick
      const decodedFrames = [] as Array<{ image: { width: number; height: number; data: ImageData['data'] }; canvas: HTMLCanvasElement }>
      for (const frame of frames) {
        const url = frameUrl(frame, new URLSearchParams(window.location.search).get('token'))
        if (!url) continue
        decodedFrames.push(await decode(url))
      }
      if (decodedFrames.length < 2) {
        setNotice('The packet frames could not be decoded for the fuse.')
        return
      }
      const fused = burstFuse(decodedFrames[targetIndex]?.image ?? decodedFrames[0].image, decodedFrames.map((entry) => entry.image).filter((_entry, index) => index !== targetIndex))
      if (fused.report.fallback) {
        setNotice(`Never-worse fallback fired (coverage ${(fused.report.coverage * 100).toFixed(0)}% under the gate) — the picked frame is unchanged, nothing was fused.`)
        return
      }
      // Encode + land as a new take (provenance-linked to the packet take).
      const out = document.createElement('canvas')
      out.width = fused.image.width
      out.height = fused.image.height
      out.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(fused.image.data as Uint8ClampedArray), fused.image.width, fused.image.height), 0, 0)
      const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('the fused frame could not be encoded')
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let binary = ''
      const chunk = 0x8000
      for (let index = 0; index < bytes.length; index += chunk) binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
      const ingested = await documentsApi.ingestBlob({ dataBase64: btoa(binary), name: `burst-fused-${Date.now()}.png`, kind: 'image' })
      let outputId = sessionChain.outputs[0]?.id ?? null
      if (!outputId) outputId = (await documentsApi.createOutput({ chainId: sessionChain.id, substrates: ['decoded'] })).id
      await documentsApi.appendTake({
        outputId,
        artifacts: [ingested.path],
        metrics: {
          kind: 'image',
          sourcePath: ingested.path,
          h3img: {
            family: 'h3img.burst.fuse',
            profile: 'packet',
            tier: 1,
            frames: 1,
            prompt: provenance.prompt,
            refs: [],
            loras: [],
            seed: provenance.seed,
            resolution: provenance.resolution,
            hybrid: false,
            canonicalFrameIndex: 0,
            scorer: null,
            parentTakeId: selectedTake.id,
            op: 'burst-fuse',
            engine: 'app',
            fuseReport: fused.report,
          },
        },
      })
      await useCanvasStore.getState().reloadActiveDocument()
      useCanvasStore.getState().toast('success', `Burst-fused (coverage ${(fused.report.coverage * 100).toFixed(0)}%) — the fused frame landed as a new take.`)
    } catch (error) {
      setNotice(`Burst-fuse failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }, [experiments, sessionChain, selectedTake, frames, effectivePick])

  // Canvas handoffs (consent-gated) --------------------------------------------
  const pinFrameToCanvas = useCallback(async (): Promise<string | null> => {
    if (!doc || !selectedTake) return null
    const frame = frames[effectivePick]
    // The landed frame may be an output-contained path OR its registered
    // content-addressed blob (appendTake swaps in-scope artifacts to blob
    // rel paths) — both are real, servable artifacts.
    const framePath = frame?.path ?? frame?.blob ?? null
    if (!framePath) {
      setNotice('The picked frame has no landed artifact yet.')
      return null
    }
    try {
      const chain = await documentsApi.createChain({
        projectId: doc.project.id,
        kind: 'media',
        inputSpec: { fresh: { media: { name: `workbench-frame-${effectivePick}.png`, kind: 'image', path: framePath } } },
        settings: { name: `workbench frame (${family?.label ?? 'workbench'})`, mediaType: 'image' },
      })
      const output = await documentsApi.createOutput({ chainId: chain.id, substrates: ['decoded'] })
      await documentsApi.appendTake({ outputId: output.id, artifacts: [framePath], metrics: { kind: 'image', name: `workbench-frame-${effectivePick}.png`, sourcePath: framePath } })
      await useCanvasStore.getState().reloadActiveDocument()
      useCanvasStore.getState().toast('success', 'The picked frame is pinned on the canvas as a media object — reference it anywhere.')
      return output.id
    } catch (error) {
      setNotice(`The frame could not be pinned: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }, [doc, selectedTake, frames, effectivePick, family])

  // The start-frame exit: consent-gated, created-never-submitted.
  const [exitPlan, setExitPlan] = useState<'anchor' | 'anchor-plus-refs' | null>(null)
  const runExit = useCallback(async () => {
    if (!doc || !exitPlan) return
    setBusy(true)
    try {
      const pinnedOutputId = await pinFrameToCanvas()
      if (!pinnedOutputId) return
      const defaults = chainSettingsDefaults(sessionState.settings)
      const nextSettings = {
        ...defaults,
        prompt: contract,
        duration: defaults.duration,
        // The frame rides FIRST_FRAME (the FL2VA frame-latent anchor — the
        // measured strongest concrete anchor). anchor-plus-refs rides the
        // reference slots too: hybrid both-at-once when available, else the
        // stock first-frame-or-refs limitation is named.
        firstFrameOutputId: pinnedOutputId,
        ...(exitPlan === 'anchor-plus-refs' ? { referenceOutputIds: settings.refs.flatMap((slot) => slot.source.kind === 'canvas' ? [slot.source.outputId] : []) } : {}),
      }
      await documentsApi.createChain({ projectId: doc.project.id, kind: 'generate', settings: nextSettings as unknown as Record<string, unknown> })
      await useCanvasStore.getState().reloadActiveDocument()
      useCanvasStore.getState().toast('success', 'The video chain is seeded from this frame — created and selected, never submitted. Open the canvas to direct it.')
      setExitOpen(false)
      setExitPlan(null)
    } finally {
      setBusy(false)
    }
  }, [doc, exitPlan, pinFrameToCanvas, sessionState.settings, contract, settings.refs])

  const hybridAvailable = detectionOf('h3img.exit.anchor')?.hybrid ?? false

  // Render ---------------------------------------------------------------------
  if (phase !== 'ready' || !doc) {
    return <div className="iw-root iw-boot" data-iw-root><LoaderCircle className="spin" /><span>Opening the workbench…</span></div>
  }
  if (!sessionChain) {
    return <div className="iw-root iw-boot" data-iw-root><LoaderCircle className="spin" /><span>Creating the workbench session…</span></div>
  }

  const token = new URLSearchParams(window.location.search).get('token')
  const t1Take = selectedProvenance?.profile === 't1'
  const kleinDetection = detectionOf('h3img.refine.klein')
  const krea2Detection = detectionOf('h3img.refine.krea2')
  const suggestedEngine: 'klein' | 'krea2' = kleinDetection?.available ? 'klein' : 'krea2'
  const combinedLoraStrength = settings.loras.reduce((acc, lora) => acc + lora.strength, 0)

  return (
    <div className="iw-root" data-iw-root data-iw-family={settings.family}>
      <header className="iw-header">
        {/* Both review waves (union): the registry-driven surface switcher
            (d6iy68r M1 — Alt+1..9 live, one way to reach a surface) PLUS
            the settings deep-link (g5x37k8 M2 — this surface has its own
            session host but no docked settings panel; one click opens the
            dock on the canvas). */}
        <SurfaceSwitcher />
        <button type="button" className="iw-back" data-iw-settings-button onClick={() => useCanvasStore.getState().setSettingsDock(true)} title="Settings — docked right here (R-21: opening it never leaves this surface)"><Settings size={14} /> settings</button>
        <strong>H3 Image Workbench</strong>
        <span className={`iw-engine ${sessionState.status.connected ? 'ok' : 'warn'}`} data-iw-engine={sessionState.status.connected ? 'on' : 'off'}>
          {sessionState.status.connected ? 'engine online' : 'engine offline'}
        </span>
        <span className="iw-mode-note" data-iw-mode-note>{family?.label}</span>
      </header>

      <nav className="iw-mode-rail" aria-label="Workbench modes" data-iw-mode-rail>
        {MODE_GROUPS.map((group) => (
          <div key={group.mode} className={`iw-mode ${group.families.includes(settings.family) ? 'active' : ''}`} data-iw-mode={group.mode}>
            <button type="button" onClick={() => void patchSettings({ family: group.families[0] })}>{group.label}</button>
            {group.families.length > 1 && group.families.includes(settings.family) && (
              <div className="iw-mode-families">
                {group.families.map((familyId) => {
                  const entry = findH3ImgFamily(familyId)
                  const detection = detectionOf(familyId)
                  const gated = familyId === 'h3img.burst.seedvr2' || familyId === 'h3img.burst.fuse'
                  return (
                    <button
                      key={familyId}
                      type="button"
                      className={`iw-family ${settings.family === familyId ? 'active' : ''} ${detection?.available ? '' : 'unavailable'}`}
                      data-iw-family-button={familyId}
                      title={detection?.available ? entry?.ui.description : (entry?.ui.installHint ?? 'unavailable')}
                      onClick={() => void patchSettings({ family: familyId })}
                    >
                      {entry?.label ?? familyId}
                      {gated && <em className="iw-gated">E-IW2</em>}
                      {!detection?.available && <em className="iw-unavailable">unavailable</em>}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        ))}
      </nav>

      <main className="iw-main">
        <section className="iw-preview" data-iw-preview>
          {selectedTake ? (
            <>
              <figure className="iw-canvas">
                {(() => {
                  const url = frameUrl(frames[effectivePick] ?? null, token)
                  return url ? <img src={url} alt={`Picked frame ${effectivePick + 1}`} data-iw-preview-image /> : <span className="iw-empty-frame">The picked frame is not resident (evicted or not yet landed).</span>
                })()}
                <figcaption data-iw-preview-caption>
                  {selectedProvenance ? `${selectedProvenance.family} · ${selectedProvenance.profile === 't1' ? 'T=1 fast' : `${selectedProvenance.tier}-frame packet`} · frame {effectivePick + 1}/${selectedProvenance.frames}${selectedProvenance.hybrid ? ' · hybrid' : ''}` : 'take'}
                  {selectedProvenance?.scorer && <em className="iw-scorer" data-iw-scorer title={selectedProvenance.scorer.reason}>scorer pick: {selectedProvenance.scorer.bestIndex + 1} — {selectedProvenance.scorer.reason}</em>}
                  {selectedProvenance?.scorer === null && selectedProvenance.frames > 1 && <em className="iw-scorer none" data-iw-scorer-none title="The scorer could not run at landing">unscored — pick by eye</em>}
                </figcaption>
              </figure>
              {/* Refine is ALWAYS opt-in (decision-6 amendment) — a prominent
                  one-tap affordance on T=1 outputs, present on every take. */}
              <div className="iw-affordances" data-iw-affordances>
                <div className="iw-refine" data-iw-refine>
                  <label className="iw-refine-input">
                    <Wand2 size={13} />
                    <input
                      value={refineInstruction}
                      onChange={(event) => setRefineInstruction(event.target.value)}
                      placeholder={t1Take ? 'Fast draft landed — name a defect to refine (opt-in, never automatic)' : 'Name a defect to refine (opt-in)'}
                      data-iw-refine-instruction
                    />
                  </label>
                  <div className="iw-refine-engines">
                    <button type="button" className="iw-refine-tap" data-iw-refine-tap="klein" disabled={busy || !kleinDetection?.available} title={kleinDetection?.available ? 'klein — the fast tier (4-step distilled, ~seconds at 1MP)' : (kleinDetection?.missingModels.join('; ') || 'unavailable')} onClick={() => void refine('klein')}>
                      <Sparkles size={12} /> Refine — klein (fast){suggestedEngine === 'klein' ? ' · suggested' : ''}
                    </button>
                    <button type="button" className="iw-refine-tap quality" data-iw-refine-tap="krea2" disabled={busy || !krea2Detection?.available} title={krea2Detection?.available ? 'Krea 2 Identity Edit — the quality engine (measured 6× preservation)' : (krea2Detection?.missingModels.join('; ') || 'unavailable')} onClick={() => void refine('krea2')}>
                      <Sparkles size={12} /> Refine — Krea 2 (quality)
                    </button>
                    {t1Take && <em className="iw-t1-note" data-iw-t1-note>T=1 output — structurally soft by profile; refining is your call.</em>}
                    {(!kleinDetection?.available || !krea2Detection?.available) && <em className="iw-engine-note">{!kleinDetection?.available && 'klein unavailable. '}{!krea2Detection?.available && 'Krea 2 unavailable.'} The affordance says so — never a silent skip.</em>}
                  </div>
                </div>
                <div className="iw-burst-row" data-iw-burst>
                  <button type="button" className={`iw-burst ${experiments ? '' : 'gated'}`} data-iw-burst-fuse disabled={busy || !experiments} title={experiments ? 'Robust frequency merge of the packet neighbors — never-worse-than-target fallback' : 'Gated behind the E-IW2 experiment (defaults only if it proves them)'} onClick={() => void runBurstFuse()}>
                    <Layers size={12} /> Burst-fuse from packet {experiments ? '' : '(E-IW2 gated)'}
                  </button>
                  <button type="button" className="iw-tone-lock" data-iw-tone-lock title="Add the tone-lock op to the session's op stack — the source keeps tone, the refine output contributes detail" onClick={() => void addToneLockOp(sessionChain)}>
                    <Lock size={12} /> tone-lock op
                  </button>
                  {!experiments && (
                    <button type="button" className="iw-experiments-toggle" data-iw-experiments-toggle title="Enable the E-IW2 experiment lane (off by default; defaults only if the experiment proves them)" onClick={() => {
                      try { window.localStorage.setItem(IW_EXPERIMENTS_KEY, 'on') } catch { /* the lane stays off without storage */ }
                      setExperiments(true)
                    }}>enable experiments</button>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="iw-preview-empty" data-iw-preview-empty>
              <ImagePlus size={28} />
              <span>No generation yet — describe what you want and generate. The packet lands here as ONE take; its frames line up on the take strip below.</span>
            </div>
          )}
        </section>

        <aside className="iw-controls">
          <label className="iw-intent">
            <span>Intent</span>
            <textarea
              value={settings.intent}
              onChange={(event) => void patchSettings({ intent: event.target.value })}
              placeholder={family?.ui.promptGuidance ?? 'Describe the whole resulting image…'}
              data-iw-intent
            />
          </label>

          <details className="iw-contract" data-iw-contract open={false}>
            <summary>Ownership contract (generated — never hand-written)</summary>
            <pre data-iw-contract-text>{contract}</pre>
          </details>

          {family?.ui.warning && <p className="iw-warning" data-iw-family-warning>{family.ui.warning}</p>}
          {!detectionOf(settings.family)?.available && (
            <div className="iw-unavailable-note" data-iw-unavailable>
              <p>
                {detectionOf(settings.family)?.missingModels.join('; ') || detectionOf(settings.family)?.missingNodes.join('; ') || 'unavailable'}
                {family?.ui.installHint ? ` — ${family.ui.installHint}` : ''}
              </p>
              {/* (R-19) The unavailable family is never a dead end at the
                  choice point: the Library is one click away (weights and
                  node packs, license verdicts on every row). */}
              <button type="button" className="canvas-chip" data-iw-open-library
                title="Open the library — the missing weights and packs are fetchable there with consent"
                onClick={() => useCanvasStore.getState().setLibraryDock(true)}>
                Get the missing pieces…
              </button>
            </div>
          )}

          {(family?.kind === 'edit' || family?.kind === 'generate-directed') && (
            <div className="iw-source" data-iw-source>
              <span>Anchored source (Picture 1)</span>
              {sourceFile ? (
                <figure>
                  {sourceFile.preview ? <img src={sourceFile.preview} alt="source" /> : <span>{sourceFile.name}</span>}
                  <figcaption data-iw-source-name>{sourceFile.name} <button type="button" onClick={() => setSourceFile(null)}>remove</button></figcaption>
                </figure>
              ) : <button type="button" onClick={() => sourceInput.current?.click()} data-iw-source-pick>Choose the source image</button>}
            </div>
          )}

          <div className="iw-refs" data-iw-refs>
            <header>
              <strong>References</strong>
              <span className="iw-ref-count" data-iw-ref-count>{settings.refs.length}/9</span>
            </header>
            <p className="iw-refs-note">{BEYOND_NINE_GUIDANCE}</p>
            <div className="iw-ref-strip" data-iw-ref-strip>
              {settings.refs.map((slot, index) => (
                <div className="iw-ref-slot" key={slot.id} data-iw-ref-slot={index}>
                  <div className="iw-ref-thumb">
                    {slot.source.kind === 'canvas' ? <span className="iw-canvas-tag" title="canvas reference"><Layers size={14} /></span> : slot.source.kind === 'refmod' ? <span className="iw-refmod-tag">RefMod</span> : slot.source.kind === 'poserig' ? <span className="iw-poserig-tag">rig</span> : null}
                  </div>
                  <select value={slot.role} data-iw-ref-role={index} onChange={(event) => void patchSettings({ refs: settings.refs.map((entry, i) => i === index ? { ...entry, role: event.target.value as H3ImgRefRole } : entry) })} aria-label={`Reference ${index + 1} role`}>
                    {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                  </select>
                  <select value={slot.transport ?? 'auto'} data-iw-ref-transport={index} onChange={(event) => void patchSettings({ refs: settings.refs.map((entry, i) => i === index ? { ...entry, transport: event.target.value === 'auto' ? null : event.target.value as 'native' | 'semantic', transportOverride: event.target.value !== 'auto' } : entry) })} aria-label={`Reference ${index + 1} transport`}>
                    <option value="auto">auto ({TRANSPORT_FOR_ROLE[slot.role]})</option>
                    <option value="native">native</option>
                    <option value="semantic">semantic</option>
                  </select>
                  <input
                    className="iw-ref-keep"
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={slot.keepOverride ?? ''}
                    placeholder="keep"
                    data-iw-ref-keep={index}
                    title="Per-picture Keep override (empty = the global dial)"
                    onChange={(event) => void patchSettings({ refs: settings.refs.map((entry, i) => i === index ? { ...entry, keepOverride: event.target.value === '' ? null : Number(event.target.value) } : entry) })}
                  />
                  <button type="button" className="iw-ref-remove" aria-label={`Remove reference ${index + 1}`} onClick={() => void patchSettings({ refs: settings.refs.filter((_entry, i) => i !== index) })}>×</button>
                </div>
              ))}
              {settings.refs.length < 9 && (
                <div className="iw-ref-add">
                  <button type="button" onClick={() => fileInput.current?.click()} data-iw-ref-add-file>add image</button>
                  <button type="button" onClick={() => setCanvasPickerOpen(true)} data-iw-ref-add-canvas>from canvas</button>
                  <a href="?poserig=1&send=iw" data-iw-ref-add-poserig title="Open the pose rig; its export sends the render back here as a pose reference">from pose rig</a>
                </div>
              )}
            </div>
          </div>

          <label className="iw-keep" data-iw-keep>
            <span>Keep unspecified traits <em data-iw-keep-value>{settings.keepDial.toFixed(2)}</em></span>
            <input type="range" min={0} max={1} step={0.01} value={settings.keepDial} data-iw-keep-dial onChange={(event) => void patchSettings({ keepDial: Number(event.target.value) })} />
            <small data-iw-keep-hint>{keepDialHint(settings.keepDial)}</small>
          </label>

          <div className="iw-loras" data-iw-loras>
            <header><strong>LoRA slots</strong><span className="iw-lora-note" data-iw-lora-guidance title={`Combined ${combinedLoraStrength.toFixed(2)} — healthy ≤ ~${H3IMG_RECIPE_PINS.lora.healthyCombinedMax}; collapse risk ≥ ~${H3IMG_RECIPE_PINS.lora.collapseRisk}`}>combined {combinedLoraStrength.toFixed(2)} {combinedLoraStrength >= H3IMG_RECIPE_PINS.lora.collapseRisk ? '· collapse risk' : combinedLoraStrength > H3IMG_RECIPE_PINS.lora.healthyCombinedMax ? '· above the healthy band' : '· healthy'}</span></header>
            <small>Slot 1 rides the form adapter first (cross-form safety) when its node pack is installed.</small>
            {settings.loras.map((lora, index) => (
              <div className="iw-lora-slot" key={index} data-iw-lora-slot={index}>
                <select value={lora.name} data-iw-lora-name={index} onChange={(event) => void patchSettings({ loras: settings.loras.map((entry, i) => i === index ? { ...entry, name: event.target.value } : entry) })} aria-label={`LoRA ${index + 1}`}>
                  <option value="">— none —</option>
                  {sessionState.models.filter((model) => model.kind === 'loras').map((model) => <option key={model.name} value={model.name}>{model.name}</option>)}
                </select>
                <input type="number" min={0} max={2} step={0.05} value={lora.strength} data-iw-lora-strength={index} onChange={(event) => void patchSettings({ loras: settings.loras.map((entry, i) => i === index ? { ...entry, strength: Number(event.target.value) } : entry) })} aria-label={`LoRA ${index + 1} strength`} />
              </div>
            ))}
            {settings.loras.length < 2 && <button type="button" data-iw-lora-add onClick={() => void patchSettings({ loras: [...settings.loras, { name: '', strength: 1 }] })}>+ LoRA slot</button>}
          </div>

          <div className="iw-row">
            {family?.profile === 'packet' && family.kind !== 'generate-directed' && (
              <label className="iw-tier" data-iw-tier>
                <span>Packet tier</span>
                <select value={settings.tier} title={STOCK_SAMPLED_FRAMES[settings.tier] !== undefined && STOCK_SAMPLED_FRAMES[settings.tier] !== settings.tier ? `Stock nodes snap this tier to a ${STOCK_SAMPLED_FRAMES[settings.tier]}-frame sample (17n+5 grid) — only 5 and 39 are native grid points. Exact 9/13 needs the H3 Image Studio pack's latent ladder.` : undefined} onChange={(event) => void patchSettings({ tier: Number(event.target.value) as 5 | 9 | 13 | 39 })}>
                  {[5, 9, 13].map((tier) => <option key={tier} value={tier}>{packetTierLabel(tier)}</option>)}
                </select>
              </label>
            )}
            <label className="iw-resolution" data-iw-resolution>
              <span>Resolution</span>
              <select value={settings.resolution} onChange={(event) => void patchSettings({ resolution: event.target.value })}>
                {['1344x768', '768x1344', '768x768'].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label className="iw-seed" data-iw-seed>
              <span>Seed</span>
              <input type="number" min={0} value={settings.seed} onChange={(event) => void patchSettings({ seed: Number(event.target.value) })} />
            </label>
          </div>

          <label className="iw-overflow" data-iw-overflow title="Semantic-only overflow beyond 9 — expert-experimental, off by default (demoted per decision 4)">
            <input type="checkbox" checked={settings.semanticOverflow} onChange={(event) => void patchSettings({ semanticOverflow: event.target.checked })} />
            <span>semantic overflow <em>experimental</em></span>
          </label>

          <button
            type="button"
            className="iw-generate"
            data-iw-generate
            disabled={busy || !detectionOf(settings.family)?.available}
            title={detectionOf(settings.family)?.available ? 'Generate' : (detectionOf(settings.family)?.missingModels.join('; ') || detectionOf(settings.family)?.missingNodes.join('; ') || 'unavailable')}
            onClick={() => void generate()}
          >
            {busy ? <LoaderCircle className="spin" size={13} /> : <Sparkles size={13} />}
            Generate {family?.profile === 't1' ? '(T=1 fast — structurally soft)' : `(${family?.kind === 'generate-directed' ? '39-frame packet' : packetTierLabel(settings.tier)})`}
          </button>
          <p className="iw-staging-note" data-iw-staging>Staging: Generate → free → Refine/Burst → free → Exit (24 GB discipline — stages never run concurrently).</p>

          <div className="iw-handoffs" data-iw-handoffs>
            <button type="button" className="iw-pin" data-iw-pin disabled={!selectedTake} onClick={() => void pinFrameToCanvas()} title="Pin the picked frame to the canvas as a media object (consent-gated: this explicit action)">
              <Send size={12} /> Pin frame to canvas
            </button>
            <button type="button" className="iw-exit" data-iw-exit disabled={!selectedTake} onClick={() => setExitOpen(true)} title="Seed a video chain anchored on this frame (created, never submitted)">
              <Send size={12} /> Start-frame exit →
            </button>
          </div>
        </aside>
      </main>

      <footer className="iw-take-strip" data-iw-take-strip aria-label="Takes — the pick surface">
        {takes.length === 0 && <span className="iw-takes-empty">No takes yet.</span>}
        {takes.map((take) => {
          const provenance = takeProvenance(take)
          const takeFramesList = takeFrames(take)
          const pick = canonicalFrameIndex(take, settings.framePicks)
          const isRefineTake = provenance?.op === 'refine'
          const isFuseTake = provenance?.op === 'burst-fuse'
          return (
            <div key={take.id} className={`iw-take ${take.id === selectedTake?.id ? 'selected' : ''} ${take.supersededBy === null ? 'canonical' : 'prior'}`} data-iw-take={take.id} data-iw-take-kind={isRefineTake ? 'refine' : isFuseTake ? 'burst-fuse' : provenance?.profile === 't1' ? 't1' : 'packet'}>
              <header>
                <button type="button" className="iw-take-select" onClick={() => setSelectedTakeId(take.id)} title="Show this take in the preview">
                  {isRefineTake ? 'refine' : isFuseTake ? 'burst-fused' : provenance?.profile === 't1' ? 'T=1' : `${provenance?.tier ?? '?'}-frame`}
                </button>
                {provenance?.parentTakeId && <em className="iw-lineage" title={`Provenance-linked to take ${provenance.parentTakeId}`}>↳ linked</em>}
                {take.supersededBy === null ? <em className="iw-canonical-marker">canonical</em> : <em className="iw-prior-marker">prior</em>}
              </header>
              <div className="iw-frames" data-iw-frames>
                {takeFramesList.map((frame) => {
                  const url = frameUrl(frame, token)
                  return (
                    <button
                      type="button"
                      key={`${take.id}-${frame.index}`}
                      className={`iw-frame ${frame.index === pick ? 'picked' : ''} ${provenance?.scorer && provenance.scorer.bestIndex === frame.index ? 'scorer' : ''}`}
                      data-iw-frame={frame.index}
                      title={provenance?.scorer && provenance.scorer.bestIndex === frame.index ? `Scorer pick — ${provenance.scorer.reason}` : `Frame ${frame.index + 1} — click to pick`}
                      onClick={() => void patchSettings({ framePicks: { ...settings.framePicks, [take.id]: frame.index } }).then(() => setSelectedTakeId(take.id))}
                    >
                      {url ? <img src={url} alt={`Frame ${frame.index + 1}`} /> : <span className="iw-frame-evicted">evicted</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </footer>

      {canvasPickerOpen && (
        <CanvasRefPicker
          doc={doc}
          onClose={() => setCanvasPickerOpen(false)}
          onPick={async (outputId, takeId) => {
            const current = readSessionSettings(sessionChain.settings)
            if (current.refs.length >= 9) {
              setNotice(BEYOND_NINE_GUIDANCE)
              return
            }
            await patchSettings({ refs: [...current.refs, { id: `ref-${Date.now()}`, role: 'subject', transport: null, keepOverride: null, note: 'canvas take', source: { kind: 'canvas', outputId, takeId } }] })
            setCanvasPickerOpen(false)
          }}
        />
      )}

      {exitOpen && (
        <div className="iw-dialog-backdrop" data-iw-exit-dialog>
          <div className="iw-dialog">
            <h3>Start-frame exit</h3>
            <p>Seed a video chain from the picked frame — <strong>created and selected, never submitted</strong>. The frame rides the FL2VA first-frame anchor (the measured strongest concrete anchor).</p>
            <div className="iw-exit-choices">
              <button type="button" data-iw-exit-choice="anchor" onClick={() => setExitPlan('anchor')} disabled={busy}>Anchor only (first frame)</button>
              <button type="button" data-iw-exit-choice="anchor-plus-refs" onClick={() => setExitPlan('anchor-plus-refs')} disabled={busy}>Anchor + canvas references</button>
            </div>
            <p className={`iw-exit-note ${hybridAvailable ? '' : 'warn'}`} data-iw-exit-hybrid>
              {hybridAvailable
                ? 'The hybrid profile is available: first frame AND references ride one model (both-at-once).'
                : 'Stock checkpoints silently drop one of (first frame | references) — the exit anchors the FRAME and names the limitation; install the hybrid loader (Settings → Fetchable items) for both-at-once.'}
            </p>
            <footer>
              <button type="button" className="secondary" onClick={() => setExitOpen(false)}>Cancel</button>
              <button type="button" className="primary" data-iw-exit-confirm disabled={!exitPlan || busy} onClick={() => void runExit()}><Send size={12} /> Seed the chain</button>
            </footer>
          </div>
        </div>
      )}

      {notice && (
        <div className="iw-notice" role="status" data-iw-notice onClick={() => setNotice(null)}>
          <span>{notice}</span>
          <button type="button" aria-label="Dismiss">×</button>
        </div>
      )}
      <div className="canvas-toasts iw-toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`canvas-toast ${toast.tone}`} data-canvas-toast={toast.tone}>
            <span>{toast.text}</span>
            <button type="button" aria-label="Dismiss" onClick={() => useCanvasStore.getState().dismissToast(toast.id)}>×</button>
          </div>
        ))}
      </div>

      <input ref={fileInput} type="file" accept="image/*" className="iw-file-input" onChange={(event) => { const file = event.target.files?.[0]; if (file) addFileRef(file); event.target.value = '' }} />
      <input ref={sourceInput} type="file" accept="image/*" className="iw-file-input" onChange={(event) => { const file = event.target.files?.[0]; if (file) void pickSource(file); event.target.value = '' }} />
    </div>
  )
}

/** Adds the tone-lock op to the session chain's stack (the app-side op). */
async function addToneLockOp(chain: DocumentChain): Promise<void> {
  try {
    await documentsApi.addOp(chain.id, H3IMG_OP_TONE_LOCK)
    useCanvasStore.getState().toast('success', 'tone-lock op added to the session stack — it applies at export/handoff.')
  } catch (error) {
    useCanvasStore.getState().toast('error', `The tone-lock op could not be added: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The canvas → workbench reference picker (consent = the explicit pick). */
function CanvasRefPicker({ doc, onClose, onPick }: { doc: { chains: DocumentChain[] }; onClose: () => void; onPick: (outputId: string, takeId: string | null, previewUrl: string | null) => void }) {
  const entries = useMemo(() => {
    const index = buildOutputIndex(doc)
    return Array.from(index.entries()).flatMap(([outputId, entry]) => {
      const resolved = mediaForOutput(entry)
      if (!resolved || resolved.media.kind !== 'image') return []
      const blob = entry.take?.artifacts.find((artifact) => artifact.startsWith('canvas-blobs/')) ?? null
      const preview = blob ? `/api/lan/documents/blobs/file?path=${encodeURIComponent(blob)}` : resolved.media.preview ?? null
      return [{ outputId, takeId: entry.take?.id ?? null, label: resolved.media.name, preview, chainTitle: chainPromptOf(entry.chain) }]
    })
  }, [doc])
  return (
    <div className="iw-dialog-backdrop" data-iw-canvas-picker>
      <div className="iw-dialog">
        <h3>Use a canvas image as a reference</h3>
        <p>The pick is the consent: the take becomes a reference slot (its bytes never move).</p>
        <div className="iw-canvas-refs">
          {entries.length === 0 && <span className="iw-takes-empty">No image takes on this canvas yet.</span>}
          {entries.map((entry) => (
            <button key={entry.outputId} type="button" className="iw-canvas-ref" data-iw-canvas-ref={entry.outputId} onClick={() => onPick(entry.outputId, entry.takeId, entry.preview)}>
              {entry.preview ? <img src={entry.preview} alt={entry.label} /> : <span className="iw-frame-evicted">no preview</span>}
              <span>{entry.label}</span>
            </button>
          ))}
        </div>
        <footer>
          <button type="button" className="secondary" onClick={onClose}>Cancel</button>
        </footer>
      </div>
    </div>
  )
}

function chainPromptOf(chain: { inputSpec: Record<string, unknown>; settings: Record<string, unknown> }): string {
  const fresh = chain.inputSpec && typeof chain.inputSpec.fresh === 'object' ? (chain.inputSpec.fresh as Record<string, unknown>) : null
  if (fresh && typeof fresh.prompt === 'string' && fresh.prompt) return fresh.prompt
  if (typeof chain.settings.prompt === 'string') return chain.settings.prompt
  return 'canvas take'
}
