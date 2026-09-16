// Environment capture + the baseline-change policy (AC: environment-change
// policy — baseline re-run trigger when GPU/driver/ComfyUI moves, recorded,
// not guessed).
import { execFileSync } from 'node:child_process'
import { exists, readJson } from './util.mjs'

export const KEY_AXES = ['gpu', 'driver', 'comfyui', 'quant']

/** Capture the current environment block. Live queries (nvidia-smi, the
 * 8189 testbed /system_stats) with honest 'unknown' fallbacks — offline
 * (CI, dry-runs) never throws. */
export async function captureEnvironment({ comfyUrl = process.env.BENCH_COMFY_URL ?? 'http://127.0.0.1:8189', testbedDir = process.env.BENCH_TESTBED } = {}) {
  const env = {
    id: null, // assigned when recorded / compared
    gpu: 'unknown',
    driver: 'unknown',
    comfyui: 'unknown',
    quant: [],
    adapters: [],
    capturedAt: new Date().toISOString(),
    source: 'captured',
  }
  try {
    const out = execFileSync('nvidia-smi',
      ['--query-gpu=name,driver_version', '--format=csv,noheader'], {
        encoding: 'utf8', timeout: 5000,
      }).trim().split('\n')[0]
    const [gpu, driver] = out.split(',').map((s) => s.trim())
    env.gpu = gpu || 'unknown'
    env.driver = driver || 'unknown'
  } catch { /* nvidia-smi absent (CI) — recorded as unknown */ }
  try {
    const res = await fetch(`${comfyUrl}/system_stats`, { signal: AbortSignal.timeout(3000) })
    if (res.ok) {
      const stats = await res.json()
      const v = stats?.system?.comfyui_version ?? stats?.system?.version
      if (v) env.comfyui = String(v)
    }
  } catch { /* testbed down — recorded as unknown */ }
  if (testbedDir && exists(testbedDir)) env.testbedDir = testbedDir
  return env
}

/** Compare two environment blocks. Returns { changed: [axes], same: [axes] }
 * over the KEY axes (gpu/driver/comfyui/quant). 'unknown' never counts as a
 * change by itself — a capture that could not see an axis cannot rebaseline
 * on it (recorded, not guessed). */
export function compareEnvironments(a, b) {
  const changed = []
  const same = []
  for (const axis of KEY_AXES) {
    const va = JSON.stringify(a?.[axis] ?? null)
    const vb = JSON.stringify(b?.[axis] ?? null)
    if (va === vb) { same.push(axis); continue }
    if (va === '"unknown"' || vb === '"unknown"') { same.push(axis); continue }
    changed.push(axis)
  }
  return { changed, same }
}

/** The baseline gate: given the registry's baseline environment and a freshly
 * captured one, decide whether a run may append COMPARABLE rows, must re-run
 * incumbents first (--rebaseline), or is on an unknown axis. */
export function baselineVerdict(baselineEnv, captured) {
  const { changed } = compareEnvironments(baselineEnv, captured)
  if (changed.length === 0) return { ok: true, changed: [] }
  return {
    ok: false,
    changed,
    reason: `environment moved on ${changed.join(', ')} — verdicts are deltas vs the ` +
      `incumbent baseline; re-run the suite incumbents under the new environment ` +
      `first (benchmarks/run.mjs --suite <s> --rebaseline), then benchmark the ` +
      `candidate. Recorded axes: ${changed.map((c) => `${c}: ${JSON.stringify(baselineEnv?.[c])} -> ${JSON.stringify(captured[c])}`).join('; ')}`,
  }
}

export function loadBaselineEnvironment(registry) {
  const id = registry.baselineEnvironmentId
  const found = (registry.environments ?? []).find((e) => e.id === id)
  return found ?? null
}

export function readRegistryEnv(file) {
  return readJson(file)
}
