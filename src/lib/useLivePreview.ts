import { useEffect, useState } from 'react'

export function useLivePreview(url: string | undefined, enabled: boolean, onProgress: (id: string, progress: number) => void) {
  const [clientId] = useState(() => crypto.randomUUID())
  const [preview, setPreview] = useState<{ promptId: string; url: string } | null>(null)
  const [connected, setConnected] = useState(false)
  useEffect(() => {
    if (!url || !enabled) { setConnected(false); setPreview(null); return }
    let stopped = false, active = '', blobUrl = ''
    let socket: WebSocket
    let timer: ReturnType<typeof setTimeout>
    const connect = () => {
      const address = new URL(url)
      address.protocol = address.protocol === 'https:' ? 'wss:' : 'ws:'
      address.pathname = `${address.pathname.replace(/\/$/, '')}/ws`
      address.search = new URLSearchParams({ clientId }).toString()
      socket = new WebSocket(address)
      socket.binaryType = 'arraybuffer'
      socket.onopen = () => setConnected(true)
      socket.onerror = () => setConnected(false)
      socket.onclose = () => { setConnected(false); if (!stopped) timer = setTimeout(connect, 3000) }
      socket.onmessage = (event) => {
        if (typeof event.data === 'string') {
          const msg = JSON.parse(event.data) as { type: string; data: { prompt_id?: string; value?: number; max?: number; output?: { images?: Array<{ filename: string; subfolder?: string; type?: string }> } } }
          if (msg.type === 'execution_start') { active = msg.data.prompt_id ?? ''; setPreview(null) }
          if (msg.type === 'progress' && msg.data.max) onProgress(msg.data.prompt_id ?? active, Math.min(95, ((msg.data.value ?? 0) / msg.data.max) * 95))
          if (msg.type === 'executed' && msg.data.output?.images?.[0]) {
            const file = msg.data.output.images[0]
            const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? '', type: file.type ?? 'temp' })
            const upstream = `${url.replace(/\/+$/, '')}/view?${query}`
            setPreview({ promptId: msg.data.prompt_id ?? active, url: `minimax-media://comfy?url=${encodeURIComponent(upstream)}` })
          }
        } else if (event.data instanceof ArrayBuffer && event.data.byteLength > 8 && active) {
          const header = new DataView(event.data)
          if (header.getUint32(0) !== 1) return
          const mime = header.getUint32(4) === 2 ? 'image/png' : 'image/jpeg'
          if (blobUrl) URL.revokeObjectURL(blobUrl)
          blobUrl = URL.createObjectURL(new Blob([event.data.slice(8)], { type: mime }))
          setPreview({ promptId: active, url: blobUrl })
        }
      }
    }
    try { connect() } catch { setConnected(false) }
    return () => { stopped = true; clearTimeout(timer); socket?.close(); if (blobUrl) URL.revokeObjectURL(blobUrl) }
  }, [url, clientId, enabled, onProgress])
  return { clientId, preview, connected }
}
