/** The pose-rig dev surface — mounted ONLY at `?poserig=1` (main.tsx lazy
 *  chunk, the ?proto= precedent). Pre-canvas: testable and demoable NOW;
 *  final integration belongs to the canvas redesign (§5.2 of
 *  docs/specs/canvas-ui-v1.md — this module must stay self-contained).
 *
 * Layout: [presets/import/template] [3D viewport] [palette-exact preview +
 * readouts] over a [keyframe timeline]. The 3D scene and the 2D preview are
 * imperative (rigScene + paintDrawOps): pointer interaction NEVER re-renders
 * React — state updates happen on commit (drag end / keyboard op / preset
 * apply / keyframe ops).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PersonStanding, Play, Plus, Square, Trash2, Download, FileJson, Image as ImageIcon, RotateCcw, FlipHorizontal2, Camera } from 'lucide-react'
import { PRESETS, presetToPose } from './presets'
import { DEFAULT_TEMPLATE_ID, HUMAN_TEMPLATE, TEMPLATES, templateById } from './template'
import { clonePose, type RigPose } from './rig'
import {
  addKeyframe, createRestPose, createTimeline, deleteKeyframe, exportAp10kJson, exportOpenPoseJson, frameCount, gridFrames,
  makeRenderer, MAX_TOTAL_FRAMES, moveKeyframe, parseOpenPoseJson, poseFromFrame, samplePose, snapToGrid, SERVER_RENDER_BRIDGE,
  type PoseTimeline,
} from './poseModel'
import { buildDrawOps, paintDrawOps } from './drawPose'
import { createRigScene, type RigSceneHandle } from './rigScene'
import type { ProjectedKeypoints } from './projection'
import './poserig.css'

const CANVAS_PRESETS = [
  { label: '512 × 512', width: 512, height: 512 },
  { label: '480 × 832 (9:16)', width: 480, height: 832 },
  { label: '832 × 480 (16:9)', width: 832, height: 480 },
  { label: '576 × 1024 (9:16)', width: 576, height: 1024 },
  { label: '1024 × 576 (16:9)', width: 1024, height: 576 },
] as const

const DURATIONS = [1, 2, 3, 5, 8, 15] as const

export default function PoseRigApp() {
  // E-FC1: human-134 stays the DEFAULT; AP-10K is a first-class selectable
  // alternative (never the initial rig), labeled with its measured adherence.
  const [templateId, setTemplateId] = useState(DEFAULT_TEMPLATE_ID)
  const template = templateById(templateId) ?? HUMAN_TEMPLATE
  const [timeline, setTimeline] = useState<PoseTimeline>(() => createTimeline(template, 2))
  const [currentFrame, setCurrentFrame] = useState(5)
  const [selectedJoint, setSelectedJoint] = useState<string | null>(null)
  const [lastPose, setLastPose] = useState<RigPose>(() => presetToPose(PRESETS[0], template))
  const [playing, setPlaying] = useState(false)
  const [status, setStatus] = useState('ready — drag a joint')

  const viewportRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<RigSceneHandle | null>(null)
  const frameReadoutRef = useRef<HTMLSpanElement>(null)
  const playStateRef = useRef({ playing: false, frame: 5, timeline })

  const canvas = timeline.canvas

  // ---- 2D preview painter (transient: called by the scene's rAF) ---------
  const paintPreview = useCallback((kp: ProjectedKeypoints) => {
    const canvasEl = previewRef.current
    if (!canvasEl) return
    if (canvasEl.width !== canvas.width || canvasEl.height !== canvas.height) {
      canvasEl.width = canvas.width
      canvasEl.height = canvas.height
    }
    const ctx = canvasEl.getContext('2d')
    if (!ctx) return
    paintDrawOps(ctx, buildDrawOps(kp), canvas.width, canvas.height)
  }, [canvas.width, canvas.height])

  // ---- scene lifecycle -----------------------------------------------------
  useEffect(() => {
    const container = viewportRef.current
    if (!container) return
    const scene = createRigScene(container, template, {
      pose: template.presetSet === 'human' ? presetToPose(PRESETS[0], template) : createRestPose(template),
      view: timeline.view,
      onSelect: (jointId) => setSelectedJoint(jointId),
      onCommit: (pose, reason) => {
        setLastPose(clonePose(pose))
        if (reason !== 'drag') setStatus(`committed (${reason})`)
      },
      onFrame: (kp) => paintPreview(kp),
    })
    scene.setPreviewSize(canvas.width, canvas.height)
    sceneRef.current = scene
    return () => {
      sceneRef.current = null
      scene.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the scene remounts on TEMPLATE switch (joints/IK differ per template); canvas-size changes ride setPreviewSize below
  }, [template])

  useEffect(() => {
    sceneRef.current?.setPreviewSize(canvas.width, canvas.height)
  }, [canvas.width, canvas.height])

  // ---- keyboard ------------------------------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return
      const scene = sceneRef.current
      if (!scene) return
      const nudgeStep = event.shiftKey ? 18 : 6
      switch (event.key) {
        case 'ArrowLeft': scene.nudgeSelected(-nudgeStep, 0); event.preventDefault(); break
        case 'ArrowRight': scene.nudgeSelected(nudgeStep, 0); event.preventDefault(); break
        case 'ArrowUp': scene.nudgeSelected(0, -nudgeStep); event.preventDefault(); break
        case 'ArrowDown': scene.nudgeSelected(0, nudgeStep); event.preventDefault(); break
        case '[': scene.rotateSelected((-5 * Math.PI) / 180); event.preventDefault(); break
        case ']': scene.rotateSelected((5 * Math.PI) / 180); event.preventDefault(); break
        case 'm': case 'M': scene.mirror(); setStatus('pose mirrored (M)'); event.preventDefault(); break
        case 'r': case 'R': scene.resetView(); setStatus('view reset (R)'); event.preventDefault(); break
        case 'k': case 'K': captureKeyframe(); event.preventDefault(); break
        case ',': stepFrame(-1); event.preventDefault(); break
        case '.': stepFrame(1); event.preventDefault(); break
        case 'Escape': scene.setSelected(null); break
        default: break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ---- timeline helpers ------------------------------------------------------
  const grid = useMemo(() => gridFrames(timeline.totalFrames), [timeline.totalFrames])

  const loadPose = useCallback((pose: RigPose) => {
    sceneRef.current?.setPose(pose)
    setLastPose(clonePose(pose))
  }, [])

  const captureKeyframe = useCallback(() => {
    const pose = sceneRef.current?.getPose() ?? lastPose
    setTimeline((prev) => addKeyframe(prev, currentFrame, clonePose(pose)))
    setStatus(`keyframe set at f${snapToGrid(currentFrame, timeline.totalFrames)} (K)`)
  }, [currentFrame, lastPose, timeline.totalFrames])

  const gotoFrame = useCallback((frame: number) => {
    const snapped = snapToGrid(frame, timeline.totalFrames)
    setCurrentFrame(snapped)
    playStateRef.current.frame = snapped
    if (frameReadoutRef.current) frameReadoutRef.current.textContent = String(snapped)
    loadPose(samplePose(timeline, snapped, template))
  }, [timeline, template, loadPose])

  const stepFrame = useCallback((delta: number) => {
    const index = grid.indexOf(snapToGrid(playStateRef.current.frame, timeline.totalFrames))
    const next = Math.max(0, Math.min(grid.length - 1, index + delta))
    gotoFrame(grid[next])
  }, [grid, gotoFrame, timeline.totalFrames])

  // ---- interpolation preview (transient: scene.setPose per rAF) ------------
  useEffect(() => { playStateRef.current.timeline = timeline; playStateRef.current.playing = playing }, [timeline, playing])

  useEffect(() => {
    if (!playing) return
    let raf = 0
    let lastTime = performance.now()
    let accumulator = 0
    const tick = (now: number) => {
      const state = playStateRef.current
      if (!state.playing) return
      accumulator += (now - lastTime) / 1000
      lastTime = now
      const frameDelta = accumulator * 24
      if (frameDelta >= 1) {
        let frame = state.frame + Math.floor(frameDelta)
        accumulator -= Math.floor(frameDelta) / 24
        if (frame > state.timeline.totalFrames - 1) frame = 0
        state.frame = frame
        if (frameReadoutRef.current) frameReadoutRef.current.textContent = String(frame)
        sceneRef.current?.setPose(samplePose(state.timeline, frame, template))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, template])

  // ---- actions ---------------------------------------------------------------
  // Template switch (E-FC1: AP-10K selectable, never the default). Poses and
  // keyframes are joint-id keyed PER TEMPLATE, so a switch resets authored
  // keyframes to the new template's rest pose while keeping canvas size,
  // duration, and view.
  const changeTemplate = useCallback((id: string) => {
    const next = templateById(id)
    if (!next || next.status !== 'shipped' || id === templateId) return
    setTemplateId(id)
    setSelectedJoint(null)
    setTimeline((prev) => ({ ...createTimeline(next), totalFrames: prev.totalFrames, canvas: prev.canvas, view: prev.view }))
    setLastPose(createRestPose(next))
    setStatus(
      next.output === 'ap10k'
        ? `template: ${next.label} — keypoint JSON targets the AP-10K estimator format (17 keypoints)`
        : `template: ${next.label}`,
    )
  }, [templateId])

  const applyPreset = useCallback((presetId: string) => {
    const preset = PRESETS.find((entry) => entry.id === presetId)
    if (!preset) return
    loadPose(presetToPose(preset, template))
    setStatus(`preset applied: ${preset.label}`)
  }, [template, loadPose])

  const setDuration = useCallback((seconds: number) => {
    const total = Math.min(frameCount(seconds), MAX_TOTAL_FRAMES)
    setTimeline((prev) => ({ ...prev, totalFrames: total }))
    setStatus(`duration ${seconds}s → ${total} frames (17n+5 grid, ≤${MAX_TOTAL_FRAMES})`)
  }, [])

  const setCanvas = useCallback((width: number, height: number) => {
    setTimeline((prev) => ({ ...prev, canvas: { width, height } }))
  }, [])

  const importJson = useCallback(async (file: File) => {
    try {
      // Loud, early rejection — human-format JSON silently lifted onto a
      // quadruped would fill every joint from REST (wrong pose, no error).
      if (template.output === 'ap10k') {
        setStatus('import: keypoint-JSON pose transfer is human-134 only — AP-10K import is a follow-up')
        return
      }
      const text = await file.text()
      const parsed = parseOpenPoseJson(JSON.parse(text))
      if ('error' in parsed) {
        setStatus(`import rejected: ${parsed.error}`)
        return
      }
      const pose = poseFromFrame(parsed.frames[0], template)
      if (!pose) {
        setStatus('import rejected: no usable person')
        return
      }
      loadPose(pose)
      setStatus(`imported ${parsed.frames.length} frame(s) — body of frame 0 lifted to the rig (flat depth)`)
    } catch (error) {
      setStatus(`import failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [template, loadPose])

  // ---- export ------------------------------------------------------------------
  const exportJson = useCallback(() => {
    const renderer = makeRenderer(template, timeline.view, timeline.canvas)
    if (template.output === 'ap10k') {
      // E-FC1: the AP-10K template's keypoint JSON targets the AP-10K
      // estimator format (version 'ap10k', animals[17×3]) — NOT OpenPose-134.
      const frames = exportAp10kJson(timeline, template, renderer)
      const blob = new Blob([JSON.stringify(frames)], { type: 'application/json' })
      triggerDownload(blob, `poserig-ap10k-${timeline.canvas.width}x${timeline.canvas.height}.json`)
      setStatus(`exported ${frames.length} keypoint frames (AP-10K 17, estimator format)`)
      return frames
    }
    const frames = exportOpenPoseJson(timeline, template, renderer)
    const blob = new Blob([JSON.stringify(frames)], { type: 'application/json' })
    triggerDownload(blob, `poserig-keypoints-${timeline.canvas.width}x${timeline.canvas.height}.json`)
    setStatus(`exported ${frames.length} keypoint frames (OpenPose-134)`)
    return frames
  }, [template, timeline])

  const renderSheetDataUrl = useCallback((): string => {
    const renderer = makeRenderer(template, timeline.view, timeline.canvas)
    const perRow = Math.min(8, timeline.totalFrames)
    const rows = Math.ceil(timeline.totalFrames / perRow)
    const sheet = document.createElement('canvas')
    sheet.width = perRow * timeline.canvas.width
    sheet.height = rows * timeline.canvas.height
    const ctx = sheet.getContext('2d')
    if (!ctx) return ''
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, sheet.width, sheet.height)
    for (let frame = 0; frame < timeline.totalFrames; frame += 1) {
      const kp = renderer(samplePose(timeline, frame, template))
      const tile = document.createElement('canvas')
      tile.width = timeline.canvas.width
      tile.height = timeline.canvas.height
      const tileCtx = tile.getContext('2d')
      if (!tileCtx) continue
      paintDrawOps(tileCtx, buildDrawOps(kp), tile.width, tile.height)
      ctx.drawImage(tile, (frame % perRow) * timeline.canvas.width, Math.floor(frame / perRow) * timeline.canvas.height)
    }
    return sheet.toDataURL('image/png')
  }, [template, timeline])

  const exportPng = useCallback(() => {
    const dataUrl = renderSheetDataUrl()
    if (!dataUrl) return
    const blob = dataUrlToBlob(dataUrl)
    triggerDownload(blob, `poserig-frames-${timeline.totalFrames}f-${timeline.canvas.width}x${timeline.canvas.height}.png`)
    setStatus(`exported ${timeline.totalFrames} rendered frames as a contact sheet`)
  }, [renderSheetDataUrl, timeline])

  // ---- e2e test hook (deterministic, versioned) -----------------------------
  useEffect(() => {
    const hook = {
      version: 1,
      pose: () => sceneRef.current?.getPose(),
      timeline: () => timeline,
      applyPreset,
      exportJson,
      gotoFrame,
      view: () => sceneRef.current?.getView(),
      /** The scene's projected keypoints on the preview canvas geometry. */
      projected: () => sceneRef.current?.projectedKeypoints(),
      /** A joint's pixel position in the 3D VIEWPORT canvas (drag target). */
      jointScreenPos: (jointId: string) => sceneRef.current?.screenPositionOf(jointId) ?? null,
      /** Sample the live preview canvas at pixel coordinates. */
      samplePreview: (x: number, y: number): Array<number> => {
        const canvasEl = previewRef.current
        const ctx = canvasEl?.getContext('2d')
        if (!ctx || !canvasEl) return [-1, -1, -1]
        const data = ctx.getImageData(Math.trunc(x), Math.trunc(y), 1, 1).data
        return [data[0], data[1], data[2]]
      },
      /** Paint arbitrary keypoints through the SAME renderer (pixel tests).
       *  Returns height rows of width [r,g,b] triplets. */
      renderKeypointsPixels: (kp: unknown, width: number, height: number): Array<Array<Array<number>>> => {
        const tile = document.createElement('canvas')
        tile.width = width
        tile.height = height
        const ctx = tile.getContext('2d')
        if (!ctx) return []
        paintDrawOps(ctx, buildDrawOps(kp as never), width, height)
        const image = ctx.getImageData(0, 0, width, height).data
        const rows: Array<Array<Array<number>>> = []
        for (let y = 0; y < height; y += 1) {
          const row: Array<Array<number>> = []
          for (let x = 0; x < width; x += 1) {
            const i = (y * width + x) * 4
            row.push([image[i], image[i + 1], image[i + 2]])
          }
          rows.push(row)
        }
        return rows
      },
      /** Deterministic export artifact (contact sheet) as a data URL. */
      renderSheetDataUrl,
    }
    Object.assign(window as unknown as Record<string, unknown>, { __poserig: hook })
    return () => { delete (window as unknown as Record<string, unknown>).__poserig }
  })

  const selectedLabel = selectedJoint ? template.joints.find((joint) => joint.id === selectedJoint)?.label ?? selectedJoint : 'none'

  return (
    <div className="poserig-root" data-poserig="app">
      <header className="poserig-header">
        <div className="poserig-brand">
          <strong>Pose Rig</strong>
          <span className="poserig-flag">dev surface — ?poserig=1</span>
        </div>
        <div className="poserig-status" data-poserig-status>{status}</div>
        <div className="poserig-header-note">IK pose rig → palette-exact DWPose render → Fun Control input</div>
      </header>

      <div className="poserig-main">
        <aside className="poserig-panel poserig-panel-left">
          <section>
            <h3>Presets</h3>
            {template.presetSet === 'human' ? (
              <div className="poserig-presets">
                {PRESETS.map((preset) => (
                  <button key={preset.id} type="button" data-poserig-preset={preset.id} onClick={() => applyPreset(preset.id)} title={preset.hint}>
                    <PersonStanding size={14} />
                    <span>{preset.label}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="poserig-note">the human preset library does not apply here — pose the quadruped directly (drag joints, IK) or keyframe its rest pose.</p>
            )}
          </section>

          <section>
            <h3>Skeleton template</h3>
            <select data-poserig-template value={templateId} onChange={(event) => changeTemplate(event.target.value)}>
              {TEMPLATES.map((entry) => (
                <option
                  key={entry.id}
                  value={entry.id}
                  disabled={entry.status !== 'shipped'}
                  title={entry.status === 'pending' ? entry.pendingNote ?? '' : entry.note ?? ''}
                >
                  {entry.label}{entry.status === 'pending' ? ' — disabled' : ''}
                </option>
              ))}
            </select>
            <p className="poserig-note" data-poserig-template-note>
              {template.status === 'pending' ? template.pendingNote : template.note}
            </p>
          </section>

          <section>
            <h3>Import</h3>
            <label className="poserig-file">
              <FileJson size={14} />
              <span>keypoint JSON (SDPose/OpenPose)</span>
              <input
                type="file"
                accept="application/json,.json"
                data-poserig-import
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void importJson(file)
                  event.target.value = ''
                }}
              />
            </label>
            <p className="poserig-note">pose-transfer from extracted video (§4 matrix) — body skeleton lifted flat; hands/face re-derived.</p>
          </section>

          <section>
            <h3>Export</h3>
            <div className="poserig-export">
              <button type="button" data-poserig-export-json onClick={exportJson}>
                <Download size={14} /><span>Keypoint JSON</span>
              </button>
              <button type="button" data-poserig-export-png onClick={exportPng}>
                <ImageIcon size={14} /><span>PNG frames</span>
              </button>
              <button type="button" data-poserig-export-server disabled title={`version-pinned OFF (E-FC0.5): __value__ is undocumented engine API — verified against ${SERVER_RENDER_BRIDGE.verifiedAgainst}; client render is the default`}>
                <Camera size={14} /><span>Server render</span>
              </button>
            </div>
            <p className="poserig-note">
              non-human default path = sprite/region compositing — E-FC1 measured it BEST in class (1.4–2× tighter than AP-10K skeletons); reference: the tranche scripts in test-results/experiments/efc1/scripts. Skeleton templates are the explicit-pose alternative.
            </p>
            <div className="poserig-canvas-picker">
              {CANVAS_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  data-poserig-canvas={`${preset.width}x${preset.height}`}
                  className={preset.width === canvas.width && preset.height === canvas.height ? 'active' : ''}
                  onClick={() => setCanvas(preset.width, preset.height)}
                >{preset.label}</button>
              ))}
            </div>
            <div className="poserig-canvas-picker">
              {DURATIONS.map((seconds) => (
                <button
                  key={seconds}
                  type="button"
                  data-poserig-duration={seconds}
                  className={timeline.totalFrames === frameCount(seconds) ? 'active' : ''}
                  onClick={() => setDuration(seconds)}
                >{seconds}s</button>
              ))}
            </div>
          </section>
        </aside>

        <div className="poserig-viewport-wrap">
          <div ref={viewportRef} className="poserig-viewport" data-poserig-viewport />
          <div className="poserig-hints">
            <span><kbd>drag joint</kbd> IK</span>
            <span><kbd>drag space</kbd> orbit</span>
            <span><kbd>wheel</kbd> zoom</span>
            <span><kbd>←→↑↓</kbd> nudge (⇧ ×3)</span>
            <span><kbd>[ ]</kbd> rotate subtree</span>
            <span><kbd>M</kbd> mirror</span>
            <span><kbd>R</kbd> reset view</span>
          </div>
          <div className="poserig-selection">selected: <strong data-poserig-selected>{selectedLabel}</strong></div>
        </div>

        <aside className="poserig-panel poserig-panel-right">
          <section>
            <h3>Palette-exact render</h3>
            <div className="poserig-preview-wrap">
              <canvas ref={previewRef} className="poserig-preview" data-poserig-preview width={canvas.width} height={canvas.height} />
            </div>
            <p className="poserig-note">
              {template.output === 'ap10k'
                ? `AP-10K contract: 17 full-color limb lines · width 5 · no joint dots · black bg · ${canvas.width}×${canvas.height}`
                : `§3 contract: 18-color limbs ×0.6 · r4 joints · HSV hands · white face dots · feet on · black bg · ${canvas.width}×${canvas.height}`}
            </p>
          </section>
          <section>
            <h3>Controls</h3>
            <div className="poserig-controls">
              <button type="button" onClick={() => { setPlaying((prev) => !prev); }} data-poserig-play>
                {playing ? <Square size={14} /> : <Play size={14} />}
                <span>{playing ? 'Stop' : 'Play preview'}</span>
              </button>
              <button type="button" onClick={() => sceneRef.current?.mirror()}><FlipHorizontal2 size={14} /><span>Mirror (M)</span></button>
              <button type="button" onClick={() => sceneRef.current?.resetView()}><RotateCcw size={14} /><span>Reset view (R)</span></button>
            </div>
          </section>
        </aside>
      </div>

      <footer className="poserig-timeline" data-poserig-timeline>
        <div className="poserig-timeline-actions">
          <button type="button" onClick={captureKeyframe} data-poserig-addkey><Plus size={13} /><span>Key (K)</span></button>
          <button
            type="button"
            data-poserig-delkey
            disabled={!timeline.keyframes.some((entry) => entry.frame === snapToGrid(currentFrame, timeline.totalFrames))}
            onClick={() => {
              setTimeline((prev) => deleteKeyframe(prev, snapToGrid(currentFrame, prev.totalFrames)))
              setStatus(`keyframe removed at f${snapToGrid(currentFrame, timeline.totalFrames)}`)
            }}
          ><Trash2 size={13} /><span>Delete</span></button>
          <span className="poserig-frame-readout">frame <span data-poserig-frame ref={frameReadoutRef}>{currentFrame}</span> / {timeline.totalFrames - 1}</span>
        </div>
        <div className="poserig-timeline-track">
          {grid.map((frame) => {
            const keyframe = timeline.keyframes.find((entry) => entry.frame === frame)
            return (
              <button
                key={frame}
                type="button"
                className={[
                  'poserig-tick',
                  keyframe ? 'has-key' : '',
                  frame === snapToGrid(currentFrame, timeline.totalFrames) ? 'current' : '',
                ].join(' ')}
                data-poserig-tick={frame}
                data-key={keyframe ? '1' : undefined}
                title={keyframe ? `f${frame} — keyframe` : `f${frame}`}
                onClick={() => gotoFrame(frame)}
                onPointerDown={(event) => {
                  if (!keyframe || event.button !== 0) return
                  const track = event.currentTarget.parentElement
                  if (!track) return
                  event.preventDefault()
                  const total = timeline.totalFrames
                  const onMove = (move: PointerEvent) => {
                    const rect = track.getBoundingClientRect()
                    const fraction = Math.max(0, Math.min(1, (move.clientX - rect.left) / rect.width))
                    const target = snapToGrid(GRID_MIN + fraction * (total - GRID_MIN), total)
                    if (target !== snapToGrid(currentFrame, total)) {
                      setCurrentFrame(target)
                      playStateRef.current.frame = target
                    }
                  }
                  const onUp = (up: PointerEvent) => {
                    window.removeEventListener('pointermove', onMove)
                    window.removeEventListener('pointerup', onUp)
                    const rect = track.getBoundingClientRect()
                    const fraction = Math.max(0, Math.min(1, (up.clientX - rect.left) / rect.width))
                    const target = snapToGrid(GRID_MIN + fraction * (total - GRID_MIN), total)
                    setTimeline((prev) => moveKeyframe(prev, frame, target))
                    setStatus(`keyframe f${frame} → f${target}`)
                  }
                  window.addEventListener('pointermove', onMove)
                  window.addEventListener('pointerup', onUp)
                }}
              />
            )
          })}
        </div>
        <div className="poserig-timeline-note">{timeline.keyframes.length} keyframe(s) · grid 17n+5 · {timeline.totalFrames} frames @ 24 fps · hold-last beyond keys</div>
      </footer>
    </div>
  )
}

const GRID_MIN = 5

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 5_000)
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(',')
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? 'application/octet-stream'
  const binary = atob(body)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}
