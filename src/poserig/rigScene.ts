/** The 2.5D viewport — an imperative three.js controller (no React).
 *
 * §5.2 #2: a 3D stick figure the user orbits; drag targets projected onto a
 * user-facing plane; ORTHOGRAPHIC projection (the same basis projection.ts
 * computes) so the posed figure is exactly what the palette renderer draws.
 *
 * TRANSIENT-UPDATE DISCIPLINE (the 60fps requirement): pointer moves mutate
 * three.js objects and set a dirty flag; a rAF loop paints ONLY when dirty.
 * React is never re-rendered during interaction — the shell receives the
 * committed pose via `onCommit` on pointer-up / keyboard-op end, and live
 * readouts ride `onFrame` (direct DOM/canvas writes, no state).
 */

import * as THREE from 'three'
import { vadd, vsub, vscale } from './ik'
import { clonePose, dragJoint, mirrorPose, nudgeJoint, rotateSubtree, type RigPose } from './rig'
import { POSE_PALETTE } from './poseSpec'
import type { SkeletonTemplate } from './template'
import { flattenKeypoints, fitProjection, projectKeypoints, screenDeltaToWorld, viewBasis, type OrbitView, type ProjectedKeypoints } from './projection'

export type RigSceneOptions = {
  pose: RigPose
  view: OrbitView
  onCommit?: (pose: RigPose, reason: 'drag' | 'keyboard' | 'mirror') => void
  onSelect?: (jointId: string | null) => void
  /** Live per-frame hook (preview painting) — receives the PROJECTED
   *  keypoints of the current pose under the current view. Called only on
   *  dirty frames, never from React. */
  onFrame?: (kp: ProjectedKeypoints, view: OrbitView) => void
}

export type RigSceneHandle = {
  dispose(): void
  setPose(pose: RigPose): void
  getPose(): RigPose
  setSelected(jointId: string | null): void
  getSelected(): string | null
  setPreviewSize(width: number, height: number): void
  orbitBy(dxPixels: number, dyPixels: number): void
  zoomBy(factor: number): void
  rotateSelected(deltaRad: number): void
  nudgeSelected(dxPixels: number, dyPixels: number): void
  mirror(): void
  resetView(): void
  getView(): OrbitView
  requestFrame(): void
  projectedKeypoints(): ProjectedKeypoints
  /** A joint's pixel position in the renderer's own canvas (drag targeting
   *  for tests + UI affordances) — the exact inverse of the pick raycast. */
  screenPositionOf(jointId: string): { x: number; y: number } | null
}

const JOINT_SPHERE_RADIUS = 0.026
const BONE_RADIUS = 0.013
const PICK_RADIUS = 0.075
const ZOOM_LIMITS = { min: 0.35, max: 3.2 }

/** Derive + project the current pose at the CURRENT view onto the preview
 *  canvas geometry — the live twin of the export renderer. */
function projectCurrent(pose: RigPose, view: OrbitView, template: SkeletonTemplate, size: { width: number; height: number }): ProjectedKeypoints {
  const kp = template.deriveKeypoints(pose)
  const flat: Array<[number, number, number]> = []
  for (const p of flattenKeypoints(kp)) flat.push([p.x, p.y, p.z])
  const fit = fitProjection(flat, size.width, size.height)
  return projectKeypoints(kp, view, fit, size.width, size.height)
}

export function createRigScene(container: HTMLElement, template: SkeletonTemplate, options: RigSceneOptions): RigSceneHandle {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x050706)

  const grid = new THREE.GridHelper(4.2, 24, 0x2a332e, 0x161c18)
  grid.position.y = 0
  scene.add(grid)

  let pose: RigPose = clonePose(options.pose)
  let view: OrbitView = { ...options.view }
  let zoom = 1
  let selected: string | null = null
  let dirty = true
  let disposed = false
  const previewSize = { width: 512, height: 512 }

  // ---- meshes -------------------------------------------------------------
  const jointMeshes = new Map<string, THREE.Mesh>()
  const pickMeshes = new Map<string, THREE.Mesh>()
  const boneMeshes: Array<{ mesh: THREE.Mesh; from: string; to: string }> = []
  const limbColor = (index: number) => {
    const c = POSE_PALETTE[index % POSE_PALETTE.length]
    return (c[0] << 16) | (c[1] << 8) | c[2]
  }
  const boneColor = (index: number) => {
    const c = POSE_PALETTE[index % POSE_PALETTE.length]
    const f = (v: number) => Math.trunc(v * 0.6)
    return (f(c[0]) << 16) | (f(c[1]) << 8) | f(c[2])
  }

  for (const joint of template.joints) {
    const geometry = new THREE.SphereGeometry(JOINT_SPHERE_RADIUS, 20, 14)
    const material = new THREE.MeshBasicMaterial({ color: limbColor(joint.bodyIndex ?? 6) })
    const mesh = new THREE.Mesh(geometry, material)
    jointMeshes.set(joint.id, mesh)
    scene.add(mesh)

    const pickGeometry = new THREE.SphereGeometry(PICK_RADIUS, 10, 8)
    const pickMaterial = new THREE.MeshBasicMaterial({ visible: false })
    const pickMesh = new THREE.Mesh(pickGeometry, pickMaterial)
    pickMesh.userData.jointId = joint.id
    pickMeshes.set(joint.id, pickMesh)
    scene.add(pickMesh)
  }
  const boneGeometry = new THREE.CylinderGeometry(BONE_RADIUS, BONE_RADIUS, 1, 10)
  for (const bone of template.bones) {
    const material = new THREE.MeshBasicMaterial({ color: boneColor(bone.colorIndex) })
    const mesh = new THREE.Mesh(boneGeometry, material)
    boneMeshes.push({ mesh, from: bone.from, to: bone.to })
    scene.add(mesh)
  }

  // ---- camera -------------------------------------------------------------
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100)
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(container.clientWidth || 800, container.clientHeight || 600, false)
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  renderer.domElement.style.display = 'block'
  container.appendChild(renderer.domElement)

  const fitCamera = () => {
    const width = container.clientWidth || 800
    const height = container.clientHeight || 600
    const aspect = width / height
    const worldHeight = 2.4 * zoom
    camera.left = (-worldHeight * aspect) / 2
    camera.right = (worldHeight * aspect) / 2
    camera.top = worldHeight / 2
    camera.bottom = -worldHeight / 2
    const basis = viewBasis(view)
    const center = new THREE.Vector3(0, 0.95, 0)
    camera.position.copy(center.clone().add(new THREE.Vector3(basis.forward.x, basis.forward.y, basis.forward.z).multiplyScalar(20)))
    camera.up.set(0, 1, 0)
    camera.lookAt(center)
    camera.updateProjectionMatrix()
    renderer.setSize(width, height, false)
  }

  const syncMeshes = () => {
    for (const [id, mesh] of jointMeshes) {
      const p = pose[id]
      mesh.position.set(p.x, p.y, p.z)
      const isSel = id === selected
      mesh.scale.setScalar(isSel ? 1.9 : 1)
      const joint = template.joints.find((j) => j.id === id)
      ;(mesh.material as THREE.MeshBasicMaterial).color.setHex(isSel ? 0xffffff : limbColor(joint?.bodyIndex ?? 6))
    }
    for (const [id, mesh] of pickMeshes) {
      const p = pose[id]
      mesh.position.set(p.x, p.y, p.z)
    }
    const upAxis = new THREE.Vector3(0, 1, 0)
    for (const bone of boneMeshes) {
      const a = pose[bone.from]
      const b = pose[bone.to]
      const mid = a && b ? vadd(a, vscale(vsub(b, a), 0.5)) : { x: 0, y: 0, z: 0 }
      bone.mesh.position.set(mid.x, mid.y, mid.z)
      if (a && b) {
        const dir = vsub(b, a)
        const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z)
        bone.mesh.scale.set(1, Math.max(len, 1e-6), 1)
        const q = new THREE.Quaternion().setFromUnitVectors(upAxis, new THREE.Vector3(dir.x / len, dir.y / len, dir.z / len))
        bone.mesh.quaternion.copy(q)
      }
    }
  }

  fitCamera()
  syncMeshes()

  // ---- interaction --------------------------------------------------------
  const raycaster = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  const toNdc = (event: PointerEvent) => {
    const rect = renderer.domElement.getBoundingClientRect()
    ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    ndc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
  }
  const worldPerPixel = () => {
    const height = container.clientHeight || 600
    return (camera.top - camera.bottom) / height
  }

  let mode: 'idle' | 'orbit' | 'drag' = 'idle'
  let lastX = 0
  let lastY = 0
  let dragMoved = false

  const pointerDown = (event: PointerEvent) => {
    renderer.domElement.setPointerCapture(event.pointerId)
    toNdc(event)
    raycaster.setFromCamera(ndc, camera)
    const hits = raycaster.intersectObjects(Array.from(pickMeshes.values()), false)
    lastX = event.clientX
    lastY = event.clientY
    dragMoved = false
    if (hits.length > 0) {
      const jointId = hits[0].object.userData.jointId as string
      setSelected(jointId)
      mode = 'drag'
    } else {
      mode = 'orbit'
    }
  }

  const pointerMove = (event: PointerEvent) => {
    if (mode === 'idle') return
    const dx = event.clientX - lastX
    const dy = event.clientY - lastY
    lastX = event.clientX
    lastY = event.clientY
    if (dx === 0 && dy === 0) return
    if (mode === 'orbit') {
      view = { yaw: view.yaw - dx * 0.0075, pitch: Math.max(-1.45, Math.min(1.45, view.pitch + dy * 0.006)) }
      fitCamera()
      dirty = true
      return
    }
    if (mode === 'drag' && selected) {
      const basis = viewBasis(view)
      const delta = screenDeltaToWorld(dx, dy, basis, worldPerPixel())
      dragJoint(template, pose, selected, vadd(pose[selected], delta))
      dragMoved = true
      syncMeshes()
      dirty = true
    }
  }

  const pointerUp = (event: PointerEvent) => {
    if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId)
    if (mode === 'drag' && dragMoved) options.onCommit?.(pose, 'drag')
    mode = 'idle'
  }

  const wheel = (event: WheelEvent) => {
    event.preventDefault()
    zoom = Math.max(ZOOM_LIMITS.min, Math.min(ZOOM_LIMITS.max, zoom * (event.deltaY > 0 ? 1.09 : 1 / 1.09)))
    fitCamera()
    dirty = true
  }

  renderer.domElement.addEventListener('pointerdown', pointerDown)
  renderer.domElement.addEventListener('pointermove', pointerMove)
  renderer.domElement.addEventListener('pointerup', pointerUp)
  renderer.domElement.addEventListener('pointercancel', pointerUp)
  renderer.domElement.addEventListener('wheel', wheel, { passive: false })

  const resizeObserver = new ResizeObserver(() => {
    fitCamera()
    dirty = true
  })
  resizeObserver.observe(container)

  function setSelected(jointId: string | null) {
    selected = jointId
    syncMeshes()
    dirty = true
    options.onSelect?.(jointId)
  }

  // ---- render loop (dirty-only) -------------------------------------------
  const frame = () => {
    if (disposed) return
    if (dirty) {
      dirty = false
      renderer.render(scene, camera)
      options.onFrame?.(projectCurrent(pose, view, template, previewSize), view)
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  // ---- handle --------------------------------------------------------------
  const handle: RigSceneHandle = {
    dispose() {
      disposed = true
      resizeObserver.disconnect()
      renderer.domElement.removeEventListener('pointerdown', pointerDown)
      renderer.domElement.removeEventListener('pointermove', pointerMove)
      renderer.domElement.removeEventListener('pointerup', pointerUp)
      renderer.domElement.removeEventListener('pointercancel', pointerUp)
      renderer.domElement.removeEventListener('wheel', wheel)
      renderer.dispose()
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (mesh.geometry) mesh.geometry.dispose()
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(material)) material.forEach((m) => m.dispose())
        else material?.dispose()
      })
      if (renderer.domElement.parentElement === container) container.removeChild(renderer.domElement)
    },
    setPose(next: RigPose) {
      pose = clonePose(next)
      syncMeshes()
      dirty = true
    },
    getPose: () => pose,
    setSelected,
    getSelected: () => selected,
    setPreviewSize(width: number, height: number) {
      previewSize.width = width
      previewSize.height = height
      dirty = true
    },
    orbitBy(dxPixels: number, dyPixels: number) {
      view = { yaw: view.yaw - dxPixels * 0.0075, pitch: Math.max(-1.45, Math.min(1.45, view.pitch + dyPixels * 0.006)) }
      fitCamera()
      dirty = true
    },
    zoomBy(factor: number) {
      zoom = Math.max(ZOOM_LIMITS.min, Math.min(ZOOM_LIMITS.max, zoom * factor))
      fitCamera()
      dirty = true
    },
    rotateSelected(deltaRad: number) {
      if (!selected) return
      const basis = viewBasis(view)
      rotateSubtree(template, pose, selected, basis.forward, deltaRad)
      syncMeshes()
      dirty = true
      options.onCommit?.(pose, 'keyboard')
    },
    nudgeSelected(dxPixels: number, dyPixels: number) {
      if (!selected) return
      const basis = viewBasis(view)
      const delta = screenDeltaToWorld(dxPixels, dyPixels, basis, worldPerPixel())
      nudgeJoint(template, pose, selected, delta)
      syncMeshes()
      dirty = true
      options.onCommit?.(pose, 'keyboard')
    },
    mirror() {
      pose = mirrorPose(template, pose)
      syncMeshes()
      dirty = true
      options.onCommit?.(pose, 'mirror')
    },
    resetView() {
      view = { yaw: 0, pitch: 0.12 }
      zoom = 1
      fitCamera()
      dirty = true
    },
    getView: () => view,
    requestFrame() {
      dirty = true
    },
    projectedKeypoints: () => projectCurrent(pose, view, template, previewSize),
    screenPositionOf(jointId: string) {
      const p = pose[jointId]
      if (!p) return null
      const vector = new THREE.Vector3(p.x, p.y, p.z).project(camera)
      const rect = renderer.domElement.getBoundingClientRect()
      return {
        x: rect.left + ((vector.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - vector.y) / 2) * rect.height,
      }
    },
  }
  return handle
}
