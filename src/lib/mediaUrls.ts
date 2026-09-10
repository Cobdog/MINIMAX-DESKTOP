/**
 * Translates Electron-era media URLs into the web server's media routes.
 * Persisted state (jobs, libraries, workspaces) written before the web
 * migration may still carry minimax-media:// URLs or raw ComfyUI /view links;
 * everything playable flows through /api/lan/media now.
 */
export function webMediaUrl(value?: string): string | undefined {
  if (!value) return value
  if (value.startsWith('minimax-media://comfy')) {
    const upstream = new URLSearchParams(value.slice('minimax-media://comfy?'.length)).get('url')
    if (!upstream) return value
    try {
      const params = new URL(upstream).searchParams
      const filename = params.get('filename')
      if (!filename) return value
      const query = new URLSearchParams({ filename, subfolder: params.get('subfolder') ?? '', type: params.get('type') ?? 'output' })
      return `/api/lan/media?${query}`
    } catch { return value }
  }
  if (value.startsWith('minimax-media://local') || value.startsWith('minimax-media://selected')) {
    const path = new URL(value).searchParams.get('path')
    return path ? `/api/lan/media?source=output&path=${encodeURIComponent(path)}` : value
  }
  try {
    const url = new URL(value)
    if (url.pathname === '/view') {
      const query = new URLSearchParams({ filename: url.searchParams.get('filename') ?? '', subfolder: url.searchParams.get('subfolder') ?? '', type: url.searchParams.get('type') ?? 'output' })
      return `/api/lan/media?${query}`
    }
  } catch { /* Not a URL — return as-is. */ }
  return value
}
