import { useEffect, useState } from 'react'
import { createId } from './createId'

export type LiveProgress = { progress?: number; label: string; currentStep?: number; totalSteps?: number }
export type LivePreview = {
  promptId: string
  url: string
  mime: string
  animated: boolean
  fps?: number
  step?: number
  totalSteps?: number
}

function previewBlob(base64: string, mime: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: mime })
}

export function useLivePreview(url: string | undefined, enabled: boolean, onProgress: (id: string, update: LiveProgress) => void) {
  const [clientId] = useState(createId)
  const [preview, setPreview] = useState<LivePreview | null>(null)
  const [connected, setConnected] = useState(false)
  useEffect(() => {
    if (!url || !enabled) { setConnected(false); setPreview(null); return }
    let stopped = false, active = '', blobUrl = ''
    let socket: WebSocket
    let timer: ReturnType<typeof setTimeout>
    const replacePreview = (next: LivePreview) => {
      if (blobUrl) URL.revokeObjectURL(blobUrl)
      blobUrl = next.url.startsWith('blob:') ? next.url : ''
      setPreview(next)
    }
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
          let msg: { type: string; data: { prompt_id?: string; node?: string | null; value?: number; max?: number; image?: string; mime?: string; fps?: number; step?: number; total?: number; output?: { images?: Array<{ filename: string; subfolder?: string; type?: string }> } } }
          try { msg = JSON.parse(event.data) } catch { return }
          const promptId = msg.data.prompt_id ?? active
          if (msg.type === 'execution_start') {
            active = msg.data.prompt_id ?? ''
            if (blobUrl) URL.revokeObjectURL(blobUrl)
            blobUrl = ''
            setPreview(null)
            onProgress(active, { progress: 1, label: 'Starting workflow' })
          }
          if (msg.type === 'execution_cached') onProgress(promptId, { label: 'Reusing cached model data' })
          if (msg.type === 'executing' && msg.data.node) onProgress(promptId, { label: 'Loading or processing workflow stage' })
          if (msg.type === 'progress' && msg.data.max) {
            const currentStep = Math.max(0, msg.data.value ?? 0)
            const totalSteps = msg.data.max
            onProgress(promptId, { progress: Math.min(95, (currentStep / totalSteps) * 95), label: `Sampling · step ${currentStep} of ${totalSteps}`, currentStep, totalSteps })
          }
          if (msg.type === 'execution_success') onProgress(promptId, { progress: 98, label: 'Finalizing saved output' })
          if (msg.type === 'minimax_h3_preview_override' && msg.data.image && active) {
            const mime = msg.data.mime ?? 'image/jpeg'
            if (!/^(?:image\/(?:jpeg|png|webp)|video\/mp4)$/.test(mime)) return
            const nextUrl = URL.createObjectURL(previewBlob(msg.data.image, mime))
            replacePreview({
              promptId: active,
              url: nextUrl,
              mime,
              animated: mime === 'image/webp' || mime === 'video/mp4',
              fps: msg.data.fps,
              step: msg.data.step,
              totalSteps: msg.data.total,
            })
          }
          if (msg.type === 'executed' && msg.data.output?.images?.[0]) {
            const file = msg.data.output.images[0]
            const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? '', type: file.type ?? 'temp' })
            const upstream = `${url.replace(/\/+$/, '')}/view?${query}`
            replacePreview({ promptId: msg.data.prompt_id ?? active, url: `minimax-media://comfy?url=${encodeURIComponent(upstream)}`, mime: 'image/jpeg', animated: false })
          }
        } else if (event.data instanceof ArrayBuffer && event.data.byteLength > 8 && active) {
          const header = new DataView(event.data)
          if (header.getUint32(0) !== 1) return
          const animatedH3Frame = event.data.byteLength > 32 && header.getUint32(4) === 1 && header.getUint32(8) === 1 && header.getUint16(32) === 0xffd8
          const imageOffset = animatedH3Frame ? 32 : 8
          const mime = !animatedH3Frame && header.getUint32(4) === 2 ? 'image/png' : 'image/jpeg'
          const nextUrl = URL.createObjectURL(new Blob([event.data.slice(imageOffset)], { type: mime }))
          replacePreview({ promptId: active, url: nextUrl, mime, animated: false })
        }
      }
    }
    try { connect() } catch { setConnected(false) }
    return () => { stopped = true; clearTimeout(timer); socket?.close(); if (blobUrl) URL.revokeObjectURL(blobUrl) }
  }, [url, clientId, enabled, onProgress])
  return { clientId, preview, connected }
}
