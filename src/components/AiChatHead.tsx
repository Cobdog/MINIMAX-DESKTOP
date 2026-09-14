import { useEffect, useRef, useState } from 'react'
import { Bot, Film, Image as ImageIcon, LoaderCircle, MessageCircle, Send, Sparkles, WandSparkles, X } from 'lucide-react'
import { createId } from '../lib/createId'
import { useLlmStream } from '../lib/useLlmStream'

type ChatMode = 'prompt' | 'image' | 'video'
type ChatMessage = { id: string; role: 'user' | 'assistant'; text: string }

const modeCopy: Record<ChatMode, { label: string; placeholder: string; task: string }> = {
  prompt: { label: 'Prompt', placeholder: 'Ask for prompt help…', task: 'chat-prompt' },
  image: { label: 'Image', placeholder: 'Describe the image you want…', task: 'chat-image' },
  video: { label: 'Video', placeholder: 'Describe the shot you want…', task: 'chat-video' },
}

export function AiChatHead({ available, ollamaModel, onUseImage, onUseVideo }: {
  available: boolean
  ollamaModel: string
  onUseImage(prompt: string): void
  onUseVideo(prompt: string): void
}) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<ChatMode>('prompt')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const logRef = useRef<HTMLDivElement>(null)
  const streamTarget = useRef<HTMLSpanElement>(null)
  const llm = useLlmStream()
  const latest = [...messages].reverse().find((message) => message.role === 'assistant')

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }) }, [busy, messages])

  const send = async () => {
    const request = draft.trim()
    if (!request || !available || busy) return
    const activeMode = mode
    setDraft(''); setBusy(true)
    setMessages((current) => [...current, { id: createId(), role: 'user', text: request }])
    try {
      // Recent turns ride the composer's history — the layered system message
      // (role per mode, rules, style, contract) resolves server-side, and the
      // tokens stream into the live line below (no React state per token).
      const history = messages.slice(-6).map((message) => ({ role: message.role, content: message.text }))
      // One paint so the busy streaming line exists before tokens target it.
      await new Promise((resolvePaint) => requestAnimationFrame(() => requestAnimationFrame(resolvePaint)))
      const full = await llm.stream({
        task: modeCopy[activeMode].task,
        instructions: history.length ? `RECENT CONTEXT:\n${history.map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.content}`).join('\n')}` : undefined,
        draft: request,
        target: streamTarget.current,
      })
      setMessages((current) => [...current, { id: createId(), role: 'assistant', text: full.trim() || '(empty response)' }])
    } catch (error) {
      setMessages((current) => [...current, { id: createId(), role: 'assistant', text: `I could not reach the local assistant: ${error instanceof Error ? error.message : String(error)}` }])
    } finally { setBusy(false) }
  }

  return <div className={`ai-chat-head ${open ? 'open' : ''}`}>
    {open && <section className="ai-chat-panel" role="dialog" aria-label="AI creation assistant">
      <header><div><span><Bot size={17} /></span><div><strong>Studio copilot</strong><small>{available ? `${ollamaModel} · local` : 'Connect a local text model in Settings'}</small></div></div><button className="icon-button" onClick={() => setOpen(false)} aria-label="Close Studio copilot"><X size={17} /></button></header>
      <div className="ai-chat-modes" role="tablist" aria-label="Assistant mode">
        {(['prompt', 'image', 'video'] as const).map((item) => <button key={item} role="tab" aria-selected={mode === item} className={mode === item ? 'active' : ''} onClick={() => setMode(item)}>{item === 'prompt' ? <WandSparkles size={14} /> : item === 'image' ? <ImageIcon size={14} /> : <Film size={14} />}{modeCopy[item].label}</button>)}
      </div>
      <div className="ai-chat-log" ref={logRef} aria-live="polite">
        {messages.length === 0 && <div className="ai-chat-empty"><Sparkles size={22} /><strong>What are you making?</strong><span>Ask for an idea, an image prompt, or a complete video shot.</span></div>}
        {messages.map((message) => <article key={message.id} className={message.role}><small>{message.role === 'user' ? 'You' : 'Copilot'}</small><p>{message.text}</p></article>)}
        {busy && <article className="assistant thinking"><LoaderCircle className="spin" size={15} /><span ref={streamTarget} /></article>}
      </div>
      {latest && mode !== 'prompt' && <div className="ai-chat-handoff"><button onClick={() => mode === 'image' ? onUseImage(latest.text) : onUseVideo(latest.text)}>{mode === 'image' ? <ImageIcon size={14} /> : <Film size={14} />}Use in {mode === 'image' ? 'Create Image' : 'Create Video'}</button></div>}
      <form onSubmit={(event) => { event.preventDefault(); void send() }}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={modeCopy[mode].placeholder} disabled={busy || !available} rows={3} /><button type="submit" disabled={busy || !available || !draft.trim()} aria-label="Send message"><Send size={16} /></button></form>
    </section>}
    <button className="ai-chat-toggle" aria-expanded={open} aria-label={open ? 'Close Studio copilot' : 'Open Studio copilot'} onClick={() => setOpen((value) => !value)}>{open ? <X size={21} /> : <><MessageCircle size={22} /><span>AI</span></>}</button>
  </div>
}
