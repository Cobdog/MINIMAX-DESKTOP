/**
 * The camera path editor (y93rk61) — the camera compiler's first surface.
 * A StudioDialog modal opened from the structured editor's Camera box: the
 * authoring canvas (timeline + top-down orbit view + indicative framing, all
 * pure SVG — no engine), one-click move presets in the compiler's own
 * vocabulary, the H3 direction-mirror calibration toggle with its
 * screen-side contract text, read-only diagnostics, and a live compile whose
 * block lands in the Camera box through the never-lossy splice.
 *
 * The compiled preview IS the review gate: Apply writes exactly the shown
 * block (foreign box text survives), and the exact authored doc persists on
 * the structured draft so the next open is exact — the box-text parse is the
 * best-effort fallback only (flagged approximate).
 */
import { useMemo, useRef, useState } from 'react'
import { Camera, Crosshair, Move3d, Trash2 } from 'lucide-react'
import { StudioDialog } from '../ui/StudioDialog'
import {
  CAMERA_MOVE_PRESETS, applyCameraBoxText, applyCameraMovePreset, cameraBoxText, compileCameraDoc,
  parseCameraBoxText, planEndOf, readCameraPathDoc, type CameraPathDoc,
} from '../lib/cameraPath'
import {
  ELEVATION_RANGES, ORBIT_DIRECTIONS, PROFILES, directionContract, interpolatePose, validatePath,
  type CameraKeyframe,
} from '../lib/camera'

const SAMPLES = 64

/** Timeline geometry: x = time (0..planEnd → 10..630), y = azimuth mapped
 *  into the curve band (48..8, inverted — up is more azimuth). */
function timelinePoint(time: number, azimuth: number, planEnd: number, extent: { min: number; max: number }) {
  const x = 10 + (time / Math.max(planEnd, 1e-9)) * 620
  const band = 44 - 8
  const y = 48 - ((azimuth - extent.min) / Math.max(extent.max - extent.min, 1e-9)) * band
  return { x, y }
}

/** Top-down orbit geometry: the subject at (110, 100); the camera at radius
 *  (14 + distance·36)px, azimuth 0 = due south (below the subject), positive
 *  azimuth travels east (the camera's right as it aims at the subject). */
function orbitPoint(azimuth: number, distance: number) {
  const cx = 110
  const cy = 100
  const radius = 14 + distance * 36
  const radians = (azimuth * Math.PI) / 180
  return { x: cx + radius * Math.sin(radians), y: cy + radius * Math.cos(radians) }
}

export function CameraPathEditor(props: {
  open: boolean
  /** The Camera box's current text (the compile target's never-lossy base). */
  boxText: string
  /** The persisted authored doc (untrusted until readCameraPathDoc). */
  doc: unknown
  /** The chain duration in seconds — the nearest-profile hint's reference. */
  duration: number
  /** The reference-frame shape when the chain has one (image/frames/reference
   *  modes) — loop closure compiles honestly only with a connected image. */
  referenceImage: { shape: number[] } | null
  onClose(): void
  onApply(next: { boxText: string; doc: CameraPathDoc }): void
}) {
  const { open, boxText, duration, referenceImage, onClose, onApply } = props

  const exactDoc = useMemo(() => readCameraPathDoc(props.doc), [props.doc])
  const parsedBox = useMemo(() => parseCameraBoxText(boxText, duration), [boxText, duration])
  const [doc, setDoc] = useState<CameraPathDoc>(() => (exactDoc ?? parsedBox.doc))
  const [selected, setSelected] = useState<number>(() => Math.max(0, (exactDoc ?? parsedBox.doc).keyframes.length - 1))
  const [scrub, setScrub] = useState(0)
  const [dragging, setDragging] = useState<'keyframe' | 'playhead' | null>(null)
  const railRef = useRef<SVGRectElement | null>(null)

  const planEnd = planEndOf(doc.profile)
  const chainFrames = Math.max(5, Math.round(duration * 24))

  // The live compile — the product. Errors carry the compiler's own taxonomy
  // and gate Apply; diagnostics ride along read-only.
  const compile = useMemo(() => {
    try {
      const compiled = compileCameraDoc(doc, { referenceImage })
      const text = cameraBoxText(doc, { referenceImage })
      return { ok: true as const, ...compiled, boxText: text }
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
    }
  }, [doc, referenceImage])

  const signedPath: CameraKeyframe[] = useMemo(
    () => doc.keyframes.map((point) => ({ ...point, azimuth: doc.orbitDirection === 'invert H3 orbit' ? -point.azimuth : point.azimuth })),
    [doc.keyframes, doc.orbitDirection],
  )
  const mirrorCheck = useMemo(() => directionContract(signedPath), [signedPath])

  // ---- keyframe editing (validatePath is the authority; invalid edits bounce) ----
  const commitKeyframes = (next: CameraKeyframe[]) => {
    try {
      validatePath(JSON.stringify(next))
      setDoc((current) => ({ ...current, keyframes: next }))
    } catch {
      // The compiler's own contract rejects it — keep the previous state.
    }
  }
  const patchKeyframe = (index: number, part: Partial<CameraKeyframe>) => {
    commitKeyframes(doc.keyframes.map((point, pointIndex) => pointIndex === index ? { ...point, ...part } : point))
  }
  const removeKeyframe = (index: number) => {
    if (index === 0 || doc.keyframes.length <= 2) return
    commitKeyframes(doc.keyframes.filter((_, pointIndex) => pointIndex !== index))
    setSelected((current) => Math.min(current, doc.keyframes.length - 2))
  }
  const addKeyframeAt = (seconds: number) => {
    if (doc.keyframes.length >= 24) return
    const time = Math.min(0.999, Math.max(0.001, seconds / planEnd))
    const pose = interpolatePose(doc.keyframes, time, doc.interpolation)
    const next = [...doc.keyframes, { time, ...pose }].sort((a, b) => a.time - b.time)
    commitKeyframes(next)
    setSelected(next.findIndex((point) => point.time === time))
  }
  const runPreset = (id: string) => {
    const next = applyCameraMovePreset(doc, id)
    if (next) {
      setDoc(next)
      setSelected(next.keyframes.length - 1)
    }
  }

  // ---- pointer interactions (timeline) ----
  const timeFromClientX = (clientX: number) => {
    const rail = railRef.current
    if (!rail) return 0
    const rect = rail.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)))
    return ratio * planEnd
  }
  const dragKeyframeTo = (index: number, seconds: number) => {
    const lower = index === 0 ? 0 : doc.keyframes[index - 1].time + 0.001
    const upper = index === doc.keyframes.length - 1 ? 1 : doc.keyframes[index + 1].time - 0.001
    const time = Math.min(upper, Math.max(lower, seconds / planEnd))
    patchKeyframe(index, { time: Math.round(time * 10000) / 10000 })
  }

  // ---- SVG projections ----
  const azimuthExtent = useMemo(() => {
    const values = doc.keyframes.map((point) => point.azimuth)
    const min = Math.min(0, ...values)
    const max = Math.max(0, ...values)
    const pad = Math.max(10, (max - min) * 0.15)
    return { min: min - pad, max: max + pad }
  }, [doc.keyframes])
  const timelineSamples = useMemo(() => {
    const points: string[] = []
    for (let index = 0; index <= SAMPLES; index += 1) {
      const time = (index / SAMPLES) * planEnd
      const pose = interpolatePose(doc.keyframes, time / Math.max(planEnd, 1e-9), doc.interpolation)
      const point = timelinePoint(time, pose.azimuth, planEnd, azimuthExtent)
      points.push(`${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    }
    return points.join(' ')
  }, [doc.keyframes, doc.interpolation, planEnd, azimuthExtent])

  const orbitSamples = useMemo(() => {
    const points: string[] = []
    for (let index = 0; index <= SAMPLES; index += 1) {
      const pose = interpolatePose(doc.keyframes, index / SAMPLES, doc.interpolation)
      const point = orbitPoint(pose.azimuth, pose.distance)
      points.push(`${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    }
    return points.join(' ')
  }, [doc.keyframes, doc.interpolation])
  const scrubPose = interpolatePose(doc.keyframes, scrub, doc.interpolation)
  const scrubOrbit = orbitPoint(scrubPose.azimuth, scrubPose.distance)

  const keyframe = doc.keyframes[selected] ?? doc.keyframes[0]
  const elevationLimit = ELEVATION_RANGES[doc.elevationRange] ?? 30

  const apply = () => {
    if (!compile.ok) return
    onApply({ boxText: applyCameraBoxText(boxText, compile.boxText), doc })
  }

  return <StudioDialog
    open={open}
    onClose={onClose}
    backdropClassName="canvas-opmodal-backdrop"
    popupClassName="camera-path-modal"
  >
    <div className="camera-path-root" data-camera-path-editor>
    <header className="camera-path-header">
      <div>
        <strong><Camera size={13} /> Camera path — compiles into the Camera box</strong>
        <span>The authored trajectory compiles through the camera compiler (src/lib/camera) into guide-correct language.</span>
      </div>
      {!exactDoc && <em className="camera-path-approximate" data-camera-approximate>reconstructed from the box text — approximate, review the keyframes</em>}
    </header>

    <div className="camera-path-body">
      <div className="camera-path-canvas">
        <figure className="camera-path-orbit" data-camera-orbit aria-label="Top-down orbit view">
          <svg viewBox="0 0 220 200" role="img" aria-label="Top-down orbit: subject at center, camera traveling the authored path">
            <circle cx="110" cy="100" r={14 + 36} className="camera-orbit-guide" />
            <circle cx="110" cy="100" r={14 + 72} className="camera-orbit-guide" />
            <text x="150" y="52" className="camera-orbit-label">2×</text>
            <text x="132" y="86" className="camera-orbit-label">1×</text>
            <polyline points={orbitSamples} className="camera-orbit-path" />
            <g className="camera-orbit-subject">
              <circle cx="110" cy="100" r="5" />
              <line x1="110" y1="92" x2="110" y2="108" />
              <line x1="102" y1="100" x2="118" y2="100" />
            </g>
            {doc.keyframes.map((point, index) => {
              const position = orbitPoint(point.azimuth, point.distance)
              return <circle
                key={index}
                cx={position.x}
                cy={position.y}
                r={index === 0 ? 4 : 3}
                className={index === selected ? 'camera-orbit-key selected' : 'camera-orbit-key'}
                data-camera-orbit-key={index}
              />
            })}
            <line x1={scrubOrbit.x} y1={scrubOrbit.y} x2="110" y2="100" className="camera-orbit-aim" />
            <circle cx={scrubOrbit.x} cy={scrubOrbit.y} r="5" className="camera-orbit-playhead" data-camera-orbit-playhead />
          </svg>
          <figcaption>top-down · subject at center · positive azimuth → camera's right</figcaption>
        </figure>

        <figure className="camera-path-framing" data-camera-framing aria-label="Indicative framing at the playhead">
          <svg viewBox="0 0 160 90" role="img" aria-label="Indicative framing at the playhead (not a render)">
            <rect x="1" y="1" width="158" height="88" rx="4" className="camera-frame-outline" />
            <line x1="1" y1={45 - (scrubPose.elevation / 30) * 16} x2="159" y2={45 - (scrubPose.elevation / 30) * 16} className="camera-frame-horizon" />
            {(() => {
              const width = Math.min(140, 40 / Math.max(0.25, scrubPose.distance))
              const height = width * 9 / 16
              return <rect x={80 - width / 2} y={45 - height / 2} width={width} height={height} rx="3" className="camera-frame-subject" />
            })()}
          </svg>
          <figcaption>indicative framing — not a render</figcaption>
        </figure>

        <figure className="camera-path-timeline" data-camera-timeline aria-label="Camera timeline">
          <svg
            viewBox="0 0 640 92"
            role="img"
            aria-label="Camera timeline: azimuth curve above, keyframe rail below"
            onPointerMove={(event) => {
              if (dragging === 'keyframe') dragKeyframeTo(selected, timeFromClientX(event.clientX))
              else if (dragging === 'playhead') setScrub(Math.min(1, Math.max(0, timeFromClientX(event.clientX) / Math.max(planEnd, 1e-9))))
            }}
            onPointerUp={() => setDragging(null)}
            onPointerLeave={() => setDragging(null)}
          >
            <polyline points={timelineSamples} className="camera-timeline-curve" />
            <line x1="10" y1="64" x2="630" y2="64" className="camera-timeline-rail-line" />
            <text x="10" y="84" className="camera-orbit-label">0s</text>
            <text x="306" y="84" className="camera-orbit-label">{(planEnd / 2).toFixed(2)}s</text>
            <text x="600" y="84" className="camera-orbit-label">{planEnd.toFixed(2)}s</text>
            <rect
              ref={railRef}
              x="10"
              y="52"
              width="620"
              height="24"
              fill="transparent"
              data-camera-rail
              style={{ cursor: 'copy' }}
              onClick={(event) => addKeyframeAt(timeFromClientX(event.clientX))}
            />
            {doc.keyframes.map((point, index) => {
              const x = 10 + (point.time / Math.max(planEnd, 1e-9)) * 620
              return <rect
                key={index}
                x={x - 5}
                y={index === 0 ? 56 : 57}
                width="10"
                height={index === 0 ? 16 : 14}
                rx="2"
                className={index === selected ? 'camera-timeline-key selected' : 'camera-timeline-key'}
                data-camera-keyframe={index}
                style={{ cursor: index === 0 ? 'not-allowed' : 'ew-resize' }}
                onPointerDown={(event) => {
                  event.preventDefault()
                  setSelected(index)
                  if (index !== 0) {
                    setDragging('keyframe')
                    try { (event.currentTarget as SVGRectElement).setPointerCapture?.(event.pointerId) } catch { /* capture is best-effort */ }
                  }
                }}
              />
            })}
            <g data-camera-playhead style={{ cursor: 'ew-resize' }} onPointerDown={(event) => {
              event.preventDefault()
              setDragging('playhead')
              try { (event.currentTarget as SVGGElement).setPointerCapture?.(event.pointerId) } catch { /* capture is best-effort */ }
            }}>
              <line x1={10 + scrub * 620} y1="6" x2={10 + scrub * 620} y2="74" className="camera-timeline-playhead" />
              <rect x={10 + scrub * 620 - 4} y="0" width="8" height="10" rx="2" className="camera-timeline-playhead-grip" />
            </g>
          </svg>
          <figcaption>click the rail to add a keyframe · drag handles to retime · the anchor (filled) is locked</figcaption>
        </figure>
      </div>

      <div className="camera-path-controls">
        <label className="camera-path-field">
          duration profile
          <select
            data-camera-profile
            value={doc.profile}
            onChange={(event) => setDoc((current) => ({ ...current, profile: event.target.value }))}
          >
            {Object.keys(PROFILES).map((profile) => <option key={profile} value={profile}>{profile}</option>)}
          </select>
        </label>
        <p className="camera-path-note" data-camera-profile-note>
          chain {duration.toFixed(1)}s ≈ {chainFrames} frames — the compiler ships three proven profiles (the 17k+5 grid); timing below uses {(planEnd).toFixed(3)}s.
        </p>
        <label className="camera-path-field">
          interpolation
          <select data-camera-interpolation value={doc.interpolation} onChange={(event) => setDoc((current) => ({ ...current, interpolation: event.target.value === 'linear' ? 'linear' : 'smooth' }))}>
            <option value="smooth">smooth</option>
            <option value="linear">linear</option>
          </select>
        </label>
        <label className="camera-path-field">
          elevation range
          <select data-camera-elevation-range value={doc.elevationRange} onChange={(event) => setDoc((current) => ({ ...current, elevationRange: event.target.value }))}>
            {Object.keys(ELEVATION_RANGES).map((range) => <option key={range} value={range}>{range}°</option>)}
          </select>
        </label>
        <label className="camera-path-field">
          orbit calibration (H3 mirror quirk)
          <select data-camera-direction value={doc.orbitDirection} onChange={(event) => setDoc((current) => ({ ...current, orbitDirection: event.target.value }))}>
            {ORBIT_DIRECTIONS.map((direction) => <option key={direction} value={direction}>{direction}</option>)}
          </select>
        </label>
        {mirrorCheck && <p className="camera-path-mirror" data-camera-mirror>{mirrorCheck}</p>}
        <label className="camera-path-field">
          subject box (literal, optional)
          <input
            data-camera-subject-box
            placeholder="[L=0.516, T=0.148, W=0.071, H=0.249]"
            value={doc.subjectBox}
            onChange={(event) => setDoc((current) => ({ ...current, subjectBox: event.target.value }))}
          />
        </label>

        <div className="camera-path-presets" data-camera-presets>
          <span className="camera-path-presets-label"><Move3d size={11} /> one-click moves</span>
          {CAMERA_MOVE_PRESETS.map((preset) => (
            <button key={preset.id} type="button" data-camera-preset={preset.id} title={preset.hint} onClick={() => runPreset(preset.id)}>{preset.label}</button>
          ))}
        </div>

        <div className="camera-path-inspector" data-camera-inspector>
          <span className="camera-path-presets-label">
            <Crosshair size={11} /> keyframe {selected + 1} of {doc.keyframes.length} — {(keyframe.time * planEnd).toFixed(3)}s ({(keyframe.time * 100).toFixed(1)}%)
          </span>
          {selected === 0 ? (
            <p className="camera-path-note" data-camera-anchor-note>anchor — the source frame itself (time 0, azimuth 0, elevation 0, radius 1×); locked by the compiler's contract.</p>
          ) : (
            <>
              <label className="camera-path-field">
                azimuth ° (unwrapped)
                <input type="number" step={5} data-camera-field-azimuth value={keyframe.azimuth} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) patchKeyframe(selected, { azimuth: value }) }} />
              </label>
              <label className="camera-path-field">
                elevation ° (±{elevationLimit})
                <input type="range" min={-elevationLimit} max={elevationLimit} step={1} data-camera-field-elevation value={Math.max(-elevationLimit, Math.min(elevationLimit, keyframe.elevation))} onChange={(event) => patchKeyframe(selected, { elevation: Number(event.target.value) })} />
                <input type="number" min={-89} max={89} step={1} data-camera-field-elevation-value value={keyframe.elevation} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) patchKeyframe(selected, { elevation: value }) }} />
              </label>
              <label className="camera-path-field">
                radius × (0.1–4)
                <input type="range" min={0.1} max={4} step={0.05} data-camera-field-distance value={keyframe.distance} onChange={(event) => patchKeyframe(selected, { distance: Number(event.target.value) })} />
                <input type="number" min={0.1} max={4} step={0.05} data-camera-field-distance-value value={keyframe.distance} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) patchKeyframe(selected, { distance: value }) }} />
              </label>
              <button type="button" className="camera-path-delete" data-camera-keyframe-remove disabled={doc.keyframes.length <= 2} onClick={() => removeKeyframe(selected)}>
                <Trash2 size={11} /> remove keyframe
              </button>
            </>
          )}
        </div>

        {compile.ok && compile.warnings.length > 0 && (
          <ul className="camera-path-diagnostics" data-camera-diagnostics>
            {compile.warnings.map((warning, index) => <li key={index} data-camera-diagnostic={index}>{warning.en}</li>)}
          </ul>
        )}
        {!compile.ok && <p className="camera-path-error" role="alert" data-camera-error>{compile.error}</p>}
      </div>
    </div>

    <footer className="camera-path-footer">
      <div className="camera-path-compiled" data-camera-compiled-container>
        <span className="camera-path-presets-label">compiled block — Apply writes exactly this into the Camera box; other box text is preserved</span>
        <pre data-camera-compiled>{compile.ok ? compile.boxText : `compile blocked: ${compile.error}`}</pre>
      </div>
      <div className="camera-path-actions">
        <button type="button" data-camera-cancel onClick={onClose}>cancel</button>
        <button type="button" className="primary" data-camera-apply disabled={!compile.ok} onClick={apply}>apply to Camera box</button>
      </div>
    </footer>
    </div>
  </StudioDialog>
}
