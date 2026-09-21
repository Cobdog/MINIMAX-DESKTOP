import { cwd } from 'node:process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { STOCK_GRAPH_CLASSES } from '../src/lib/preflight'

/** A fake engine's full-coverage object_info (Wave 1 R-02): every STOCK
 *  class the factory graphs can emit, served with the REAL captured schemas
 *  from scripts/fixtures/engine-object-info.json (the engine-contract
 *  graduation, task 8dga2dy — a fake that serves synthetic shapes lets a
 *  schema-refusing graph pass e2e and fail on the maintainer's evening; the
 *  T=1 `length: 1` lesson, 2026-09-21), plus the test's own extras (pack
 *  classes like MiniMaxH3HybridLoader, or enum-bearing shapes; later
 *  arguments WIN). Submitting fakes serve this so the R-02 preflight diffs
 *  a graph against a registry that could actually run it — a fake that
 *  serves nothing would refuse every render.
 *
 *  Scope of the real schemas: STOCK classes only. Pack classes stay
 *  extras-driven (call sites already pass `{ MiniMaxH3HybridLoader: {} }`
 *  and their detection lanes expect absence by default). If the fixture is
 *  unreadable (cwd not the repo root, file moved), the explicit fallback is
 *  the Wave-1 lean bare-object shape — key-presence only, the rq0lsax
 *  lean-instance precedent. */
let realSchemasCache: Record<string, unknown> | null = null

function realStockSchemas(): Record<string, unknown> {
  if (realSchemasCache) return realSchemasCache
  let schemas: Record<string, unknown> = {}
  try {
    const raw = JSON.parse(readFileSync(resolve(cwd(), 'scripts/fixtures/engine-object-info.json'), 'utf8'))
    if (raw && typeof raw === 'object' && raw.nodes && typeof raw.nodes === 'object') {
      for (const className of STOCK_GRAPH_CLASSES) {
        const entry = raw.nodes[className]
        if (entry && typeof entry === 'object') schemas[className] = entry
      }
    }
  } catch {
    schemas = {} // explicit fallback: lean bare-object behavior (documented above)
  }
  realSchemasCache = schemas
  return schemas
}

export function stockObjectInfo(...extras: Array<Record<string, unknown>>): Record<string, unknown> {
  const info: Record<string, unknown> = {}
  const real = realStockSchemas()
  for (const className of STOCK_GRAPH_CLASSES) {
    // Real captured schema where the fixture has one; the bare-object floor
    // otherwise — both register the KEY (detection is key-presence only).
    info[className] = real[className] !== undefined ? real[className] : {}
  }
  for (const extra of extras) Object.assign(info, extra)
  return info
}

/** The object_info route pair every fake engine must speak (Wave 2 R-12 /
 *  A-8): the FULL registry at `/object_info`, and the TARGETED per-class
 *  form at `/object_info/{node}` — `{ "<class>": node_info }` when served,
 *  **HTTP 200 with `{}` when not** (key-miss is the absence signal, never
 *  the status; docs/devdocs/comfyui-api/index.md §4 + divergence note 4).
 *  Returns true when the request was handled.
 */
export function serveObjectInfo(url: URL, info: Record<string, unknown>, res: { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void }): boolean {
  if (url.pathname === '/object_info') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(info))
    return true
  }
  const targeted = /^\/object_info\/(.+)$/.exec(url.pathname)
  if (targeted) {
    const className = decodeURIComponent(targeted[1]!)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(className in info ? { [className]: info[className] } : {}))
    return true
  }
  return false
}

/** The /models route pair (the registry contract, Wave 2 R-12): the folder
 *  list at `/models` and the per-folder filename listing at
 *  `/models/{folder}` (404 for an unknown folder — the older-instance
 *  shape). Returns true when the request was handled. */
export function serveModelRegistry(url: URL, listings: Record<string, string[]>, res: { writeHead(status: number, headers?: Record<string, string>): void; end(body?: string): void }): boolean {
  if (url.pathname === '/models') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(Object.keys(listings)))
    return true
  }
  const folder = /^\/models\/(.+)$/.exec(url.pathname)
  if (folder) {
    const kind = decodeURIComponent(folder[1]!)
    if (!(kind in listings)) {
      res.writeHead(404)
      res.end()
      return true
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(listings[kind]))
    return true
  }
  return false
}

/** The shared H3 registry listing the e2e fakes serve — the official stack
 *  (engine-relative subpaths on the diffusion rows, proving the loaders
 *  accept exactly what /models lists) + the audio engines' files. */
export const H3_REGISTRY_LISTINGS: Record<string, string[]> = {
  diffusion_models: [
    'H3/ssd/minimax_h3_fl2va_pruned_int8_convrot.safetensors',
    'H3/ssd/minimax_h3_ref2va_pruned_int8_convrot.safetensors',
    'music3_dit_int8.safetensors',
  ],
  text_encoders: ['qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', 'music3_text_encoder_bf16.safetensors'],
  vae: ['minimax_h3_video_vae_fp16.safetensors', 'minimax_h3_audio_vae_fp32.safetensors'],
  loras: ['minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors'],
}
