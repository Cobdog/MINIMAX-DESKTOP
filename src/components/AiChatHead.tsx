import { useEffect, useRef, useState } from 'react'
import { Bot, Film, Image as ImageIcon, LoaderCircle, MessageCircle, Send, Sparkles, WandSparkles, X } from 'lucide-react'

type ChatMode = 'prompt' | 'image' | 'video'
type ChatMessage = { id: string; role: 'user' | 'assistant'; text: string }

const modeCopy: Record<ChatMode, { label: string; placeholder: string; instruction: string }> = {
  prompt: { label: 'Prompt', placeholder: 'Ask for prompt help…', instruction: 'Act as a concise local creative copilot. Answer the request directly and help improve prompts for visual generation.' },
  image: { label: 'Image', placeholder: 'Describe the image you want…', instruction: 'Turn the request into one polished production-ready still-image prompt. Include subject, environment, composition, lens, lighting, texture, color, and exclusions when useful. Do not include motion, sound, or multiple shots. Return only the prompt.' },
  video: { label: 'Video', placeholder: 'Describe the shot you want…', instruction: 'Turn the request into one production-ready single-shot video prompt. Use this order: subject and starting state, environment, chronological action, framing and angle, lens, camera movement, lighting, visual treatment, continuity, and ambient sound. Avoid cuts and montages. Return only the prompt.' },
}

export function AiChatHead({ available, ollamaUrl, ollamaModel, onUseImage, onUseVideo }: {
  available: boolean
  ollamaUrl: string
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
  const latest = [...messages].reverse().find((message) => message.role === 'assistant')

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' }) }, [busy, messages])

  const send = async () => {
    const request = draft.trim()
    if (!request || !available || busy) return
    const activeMode = mode
    setDraft(''); setBusy(true)
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'user', text: request }])
    try {
      const context = messages.slice(-6).map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`).join('\n')
      const response = await window.minimax.generateWithOllama(ollamaUrl, ollamaModel, `${modeCopy[activeMode].instruction}\n\n${context ? `RECENT CONTEXT:\n${context}\n\n` : ''}REQUEST:\n${request}`)
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', text: response.trim() }])
    } catch (error) {
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', text: `I could not reach the local assistant: ${error instanceof Error ? error.message : String(error)}` }])
    } finally { setBusy(false) }
  }

  return <div className={`ai-chat-head ${open ? 'open' : ''}`}>
    {open && <section className="ai-chat-panel" role="dialog" aria-label="AI creation assistant">
      <header><div><span><Bot size={17} /></span><div><strong>Studio copilot</strong><small>{available ? `${ollamaModel} · local` : 'Configure Ollama in Settings'}</small></div></div><button className="icon-button" onClick={() => setOpen(false)} aria-label="Close Studio copilot"><X size={17} /></button></header>
      <div className="ai-chat-modes" role="tablist" aria-label="Assistant mode">
        {(['prompt', 'image', 'video'] as const).map((item) => <button key={item} role="tab" aria-selected={mode === item} className={mode === item ? 'active' : ''} onClick={() => setMode(item)}>{item === 'prompt' ? <WandSparkles size={14} /> : item === 'image' ? <ImageIcon size={14} /> : <Film size={14} />}{modeCopy[item].label}</button>)}
      </div>
      <div className="ai-chat-log" ref={logRef} aria-live="polite">
        {messages.length === 0 && <div className="ai-chat-empty"><Sparkles size={22} /><strong>What are you making?</strong><span>Ask for an idea, an image prompt, or a complete video shot.</span></div>}
        {messages.map((message) => <article key={message.id} className={message.role}><small>{message.role === 'user' ? 'You' : 'Copilot'}</small><p>{message.text}</p></article>)}
        {busy && <article className="assistant thinking"><LoaderCircle className="spin" size={15} /><span>Thinking locally…</span></article>}
      </div>
      {latest && mode !== 'prompt' && <div className="ai-chat-handoff"><button onClick={() => mode === 'image' ? onUseImage(latest.text) : onUseVideo(latest.text)}>{mode === 'image' ? <ImageIcon size={14} /> : <Film size={14} />}Use in {mode === 'image' ? 'Create Image' : 'Create Video'}</button></div>}
      <form onSubmit={(event) => { event.preventDefault(); void send() }}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={modeCopy[mode].placeholder} disabled={busy || !available} rows={3} /><button type="submit" disabled={busy || !available || !draft.trim()} aria-label="Send message"><Send size={16} /></button></form>
    </section>}
    <button className="ai-chat-toggle" aria-expanded={open} aria-label={open ? 'Close Studio copilot' : 'Open Studio copilot'} onClick={() => setOpen((value) => !value)}>{open ? <X size={21} /> : <><MessageCircle size={22} /><span>AI</span></>}</button>
  </div>
}
