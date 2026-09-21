import { STOCK_GRAPH_CLASSES } from '../src/lib/preflight'

/** A fake engine's full-coverage object_info (Wave 1 R-02): every STOCK
 *  class the factory graphs can emit, served as the lean bare-object shape
 *  (detection is key-presence only — the rq0lsax lean-instance precedent),
 *  plus the test's own extras (pack classes like MiniMaxH3HybridLoader, or
 *  enum-bearing shapes; later arguments WIN). Submitting fakes serve this
 *  so the R-02 preflight diffs a graph against a registry that could
 *  actually run it — a fake that serves nothing would refuse every render.
 */
export function stockObjectInfo(...extras: Array<Record<string, unknown>>): Record<string, unknown> {
  const info: Record<string, unknown> = {}
  for (const className of STOCK_GRAPH_CLASSES) info[className] = {}
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
