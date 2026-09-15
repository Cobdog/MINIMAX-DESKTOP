/** IK primitives for the pose rig — analytic two-bone + FABRIK.
 *
 * PURE MATH ONLY: no three.js, no DOM, no imports — this module is loaded by
 * the node unit suite through scripts/lib/ts-vm.cjs, which transpiles to an
 * ES3-era target (no iterator spreads / matchAll — see that file's header).
 *
 * Design (fun-control-input-surface.md §5.2): limbs are two-bone chains
 * (shoulder→elbow→wrist, hip→knee→ankle) — an analytic solver is exact and
 * O(1). The spine-neck chain is FABRIK (base pinned at midHip) — bone lengths
 * are preserved to float epsilon and reachable targets are hit within the
 * given tolerance. No general solver, no physics (§5.2 non-goals).
 */

export type Vec3 = { x: number; y: number; z: number }

export function v3(x: number, y: number, z: number): Vec3 {
  return { x, y, z }
}

export function vadd(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }
}

export function vsub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

export function vscale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s }
}

export function vlen(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z)
}

export function vdist(a: Vec3, b: Vec3): number {
  return vlen(vsub(a, b))
}

export function vnorm(a: Vec3): Vec3 {
  const l = vlen(a)
  if (l < 1e-12) return { x: 0, y: 0, z: 0 }
  return { x: a.x / l, y: a.y / l, z: a.z / l }
}

export function vdot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

export function vcross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

/** Rotates `p` about `origin` by `angle` radians around the world-space
 *  `axis` (Rodrigues' formula) — used by the keyboard "rotate subtree" op. */
export function rotateAroundAxis(p: Vec3, origin: Vec3, axis: Vec3, angle: number): Vec3 {
  const k = vnorm(axis)
  const d = vsub(p, origin)
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const kCross = vcross(k, d)
  const kDot = vdot(k, d)
  return {
    x: origin.x + d.x * cos + kCross.x * sin + k.x * kDot * (1 - cos),
    y: origin.y + d.y * cos + kCross.y * sin + k.y * kDot * (1 - cos),
    z: origin.z + d.z * cos + kCross.z * sin + k.z * kDot * (1 - cos),
  }
}

/** Mirrors a point across the sagittal plane (x → −x). The rig's symmetry
 *  plane is x = 0 (character faces +z, its left = +x). */
export function mirrorX(p: Vec3): Vec3 {
  return { x: -p.x, y: p.y, z: p.z }
}

// ---------------------------------------------------------------------------
// Analytic two-bone IK (limbs)
// ---------------------------------------------------------------------------

export type TwoBoneResult = {
  /** Solved middle-joint position (elbow / knee). */
  mid: Vec3
  /** Solved end-effector position. Equals `target` when reachable; clamped
   *  onto the root→target ray at full extension when not. */
  end: Vec3
  /** True when |target − root| ≤ l1 + l2 (the exact pose was attainable). */
  reached: boolean
}

/** Classic exact two-bone solution. The middle joint is placed on the side
 *  of the root→end line that `pole` points to (elbows back, knees forward).
 *  Degenerate input (zero-length bones, target on the root) is clamped, never
 *  NaN — the rig must stay well-formed during drags. */
export function solveTwoBone(root: Vec3, target: Vec3, l1: number, l2: number, pole: Vec3): TwoBoneResult {
  const safeL1 = Math.max(l1, 1e-9)
  const safeL2 = Math.max(l2, 1e-9)
  const toTarget = vsub(target, root)
  const distance = vlen(toTarget)
  const maxReach = safeL1 + safeL2

  // Unreachable (or degenerate direction): full extension toward the target.
  if (distance < 1e-9 || distance >= maxReach - 1e-9) {
    const dir = distance < 1e-9 ? v3(0, -1, 0) : vscale(toTarget, 1 / distance)
    const end = vadd(root, vscale(dir, Math.min(distance, maxReach)))
    // Straight chain: mid at l1 along the direction.
    const mid = vadd(root, vscale(dir, safeL1))
    return { mid, end, reached: distance <= maxReach + 1e-9 }
  }

  const dir = vscale(toTarget, 1 / distance)
  // Law of cosines: distance from root to the projection of the mid joint.
  const a = (safeL1 * safeL1 - safeL2 * safeL2 + distance * distance) / (2 * distance)
  const h = Math.sqrt(Math.max(0, safeL1 * safeL1 - a * a))

  // Bend axis: pole projected off the root→end line. If the pole is parallel
  // to the line, fall back to world-up, then world-forward — always valid.
  let bend = vsub(pole, vscale(dir, vdot(pole, dir)))
  if (vlen(bend) < 1e-6) {
    bend = vsub(v3(0, 1, 0), vscale(dir, dir.y))
    if (vlen(bend) < 1e-6) bend = vsub(v3(0, 0, 1), vscale(dir, dir.z))
  }
  bend = vnorm(bend)

  const mid = vadd(vadd(root, vscale(dir, a)), vscale(bend, h))
  return { mid, end: { x: target.x, y: target.y, z: target.z }, reached: true }
}

// ---------------------------------------------------------------------------
// FABRIK (spine-neck chain)
// ---------------------------------------------------------------------------

export type FabrikResult = {
  /** Solved chain, same length as the input. points[0] stays pinned. */
  points: Vec3[]
  /** Distance between the chain end and the requested target after solving. */
  error: number
}

/** FABRIK over one pinned chain. Bone lengths are preserved exactly (each
 *  pass re-normalizes to the recorded rest lengths); the base never moves;
 *  targets beyond total reach straighten the chain toward the target (the
 *  documented FABRIK far-target behavior) instead of stretching bones. */
export function solveFabrik(chain: Vec3[], target: Vec3, tolerance = 1e-6, maxIterations = 16): FabrikResult {
  const n = chain.length
  if (n < 2) return { points: chain.slice(), error: n === 1 ? vdist(chain[0], target) : 0 }

  const lengths: number[] = []
  for (let i = 0; i < n - 1; i += 1) lengths.push(vdist(chain[i], chain[i + 1]))
  const total = lengths.reduce((sum, l) => sum + l, 0)

  const points = chain.slice()
  const base = { x: points[0].x, y: points[0].y, z: points[0].z }
  const baseToTarget = vsub(target, base)
  const targetDistance = vlen(baseToTarget)

  // Out of reach: fully extend toward the target (lengths preserved).
  if (targetDistance >= total - 1e-9) {
    const dir = targetDistance < 1e-9 ? v3(0, 1, 0) : vscale(baseToTarget, 1 / targetDistance)
    let acc = 0
    points[0] = base
    for (let i = 0; i < n - 1; i += 1) {
      acc += lengths[i]
      points[i + 1] = vadd(base, vscale(dir, acc))
    }
    return { points, error: vdist(points[n - 1], target) }
  }

  let error = vdist(points[n - 1], target)
  let iteration = 0
  while (error > tolerance && iteration < maxIterations) {
    iteration += 1
    // Backward pass: end at the target, pull the rest toward it.
    points[n - 1] = { x: target.x, y: target.y, z: target.z }
    for (let i = n - 2; i >= 0; i -= 1) {
      const l = vdist(points[i], points[i + 1])
      const ratio = l < 1e-12 ? 0 : lengths[i] / l
      points[i] = vadd(points[i + 1], vscale(vsub(points[i], points[i + 1]), ratio))
    }
    // Forward pass: re-pin the base, push the rest outward.
    points[0] = base
    for (let i = 0; i < n - 1; i += 1) {
      const l = vdist(points[i], points[i + 1])
      const ratio = l < 1e-12 ? 0 : lengths[i] / l
      points[i + 1] = vadd(points[i], vscale(vsub(points[i + 1], points[i]), ratio))
    }
    error = vdist(points[n - 1], target)
  }
  return { points, error }
}
