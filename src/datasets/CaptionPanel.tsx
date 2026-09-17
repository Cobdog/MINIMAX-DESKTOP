/**
 * Dataset manager — the caption editor (spec §4): per-LAYER captions with
 * live trigger-token validation, authorship + history, the stale flow, and
 * the VLM modal carrying the four automation modes (single caption/recaption,
 * free-form discussion; batch modes live on the layer list).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { History, LoaderCircle, MessageSquareText, ShieldAlert, Sparkles } from 'lucide-react'
import { datasetsApi, type LibraryLayer, type TriggerVerdict } from './api'

type Props = {
  layer: LibraryLayer
  onClose(): void
  onChanged(): void
}

type HistoryEntry = { text: string; author: string; authorModel: string | null; recordedAt: number }

export function CaptionPanel({ layer, onClose, onChanged }: Props) {
  const [text, setText] = useState(layer.caption?.text ?? '')
  const [validation, setValidation] = useState<TriggerVerdict | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [history, setHistory] = useState<HistoryEntry[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // VLM modal state
  const [vlmOpen, setVlmOpen] = useState(false)
  const [vlmInstruction, setVlmInstruction] = useState('')
  const [vlmBusy, setVlmBusy] = useState(false)
  const [vlmError, setVlmError] = useState<string | null>(null)
  // Free-form discussion state (mode d)
  const [chat, setChat] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([])
  const [chatInput, setChatInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const debounce = useRef<number | null>(null)

  // Live trigger validation (debounced; the same rule the export gate runs).
  useEffect(() => {
    if (debounce.current) window.clearTimeout(debounce.current)
    debounce.current = window.setTimeout(() => {
      datasetsApi.validateCaption(text).then(setValidation).catch(() => setValidation(null))
    }, 300)
    return () => {
      if (debounce.current) window.clearTimeout(debounce.current)
    }
  }, [text])

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await datasetsApi.setCaption(layer.id, text)
      setSavedAt(Date.now())
      onChanged()
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setBusy(false)
    }
  }

  const runVlm = async () => {
    setVlmBusy(true)
    setVlmError(null)
    try {
      const result = await datasetsApi.vlmCaption(layer.id, vlmInstruction.trim() || undefined)
      setText(result.caption)
      onChanged()
    } catch (vlmError) {
      setVlmError(vlmError instanceof Error ? vlmError.message : String(vlmError))
    } finally {
      setVlmBusy(false)
    }
  }

  const sendChat = async () => {
    if (!chatInput.trim()) return
    const message = chatInput
    setChatInput('')
    setChatBusy(true)
    setChat((current) => [...current, { role: 'user', content: message }])
    try {
      const result = await datasetsApi.vlmDiscuss(layer.id, message, chat.slice(-12))
      setChat((current) => [...current, { role: 'assistant', content: result.reply }])
    } catch (chatError) {
      setChat((current) => [...current, { role: 'assistant', content: chatError instanceof Error ? chatError.message : String(chatError) }])
    } finally {
      setChatBusy(false)
    }
  }

  const loadHistory = async () => {
    if (history) {
      setHistory(null)
      return
    }
    try {
      const result = await datasetsApi.captionHistory(layer.id)
      setHistory(result.history)
    } catch (historyError) {
      setError(historyError instanceof Error ? historyError.message : String(historyError))
    }
  }

  const stale = layer.caption?.stale
  const authorLabel = useMemo(() => {
    if (!layer.caption) return 'uncaptioned'
    return layer.caption.author === 'hand' ? 'hand-written' : `VLM (${layer.caption.author})`
  }, [layer.caption])

  return <div className="ds-caption-panel" data-ds-caption>
    <header className="ds-caption-head">
      <div>
        <h3>Caption — {layer.name || `layer ${layer.id.slice(0, 8)}`}</h3>
        <p className="ds-sub">{authorLabel}{layer.caption?.reviewState === 'queued' ? ' · review queued' : ''}{stale ? ' · STALE' : ''}</p>
      </div>
      <div className="ds-caption-actions">
        <button type="button" className="ds-btn ghost" onClick={() => setVlmOpen((open) => !open)}><Sparkles size={13} /> VLM</button>
        <button type="button" className="ds-btn ghost" onClick={loadHistory}><History size={13} /> {history ? 'Hide history' : 'History'}</button>
        <button type="button" className="ds-btn ghost" onClick={onClose}>Close</button>
      </div>
    </header>
    {stale && <p className="ds-stale-note" data-ds-stale><ShieldAlert size={13} /> {layer.caption?.stale ? 'This caption is STALE — the layer\'s view changed after captioning. Recaption (or accept explicitly at export).' : ''}</p>}
    <textarea
      className="ds-caption-textarea"
      value={text}
      onChange={(event) => setText(event.target.value)}
      rows={6}
      placeholder="One flowing paragraph, natural language only. Trigger token first, exactly once."
      data-ds-caption-textarea
    />
    <div className="ds-caption-foot">
      {validation && !validation.ok
        ? <ul className="ds-validation" data-ds-validation>
            {validation.issues.map((issue) => <li key={issue}>{issue}</li>)}
          </ul>
        : <p className="ds-validation ok" data-ds-validation-ok>Trigger format OK — single rare token, exactly once, first.</p>}
      {error && <p className="ds-error">{error}</p>}
      {savedAt && !busy && !error && <p className="ds-status">Saved (hand-written; batch VLM will never silently overwrite it).</p>}
      <button type="button" className="ds-btn primary" onClick={save} disabled={busy} data-ds-save-caption>
        {busy ? <LoaderCircle className="spin" size={13} /> : null} Save caption
      </button>
    </div>
    {history && history.length > 0 && <div className="ds-history" data-ds-history>
      {history.map((entry, index) => (
        <div key={index} className="ds-history-entry">
          <span className="ds-history-meta">{entry.author === 'hand' ? 'hand' : `VLM${entry.authorModel ? ` · ${entry.authorModel}` : ''}`} · {new Date(entry.recordedAt).toLocaleString()}</span>
          <p>{entry.text}</p>
        </div>
      ))}
    </div>}
    {vlmOpen && <div className="ds-vlm-modal" data-ds-vlm>
      <div className="ds-vlm-box">
        <header>
          <h3><MessageSquareText size={14} /> Local VLM — caption this clip, or discuss it</h3>
          <button type="button" className="ds-btn ghost" onClick={() => setVlmOpen(false)}>×</button>
        </header>
        <section>
          <h4>Caption / recaption (dense → condense, on the llama.cpp router)</h4>
          <p className="ds-hint">Pass 1 describes the frames densely; pass 2 condenses into the class template — both local.</p>
          <textarea value={vlmInstruction} onChange={(event) => setVlmInstruction(event.target.value)} rows={3} placeholder="Optional instruction (e.g. 'mention the lighting and the camera push-in')" />
          {vlmError && <p className="ds-error">{vlmError}</p>}
          <button type="button" className="ds-btn primary" onClick={runVlm} disabled={vlmBusy} data-ds-vlm-caption>
            {vlmBusy ? <LoaderCircle className="spin" size={13} /> : null} Caption this clip
          </button>
        </section>
        <section className="ds-chat">
          <h4>Free-form discussion (no caption write)</h4>
          <div className="ds-chat-log">
            {chat.map((turn, index) => <p key={index} className={turn.role}>{turn.content}</p>)}
            {chatBusy && <p className="assistant pending">thinking…</p>}
          </div>
          <div className="ds-chat-row">
            <input value={chatInput} onChange={(event) => setChatInput(event.target.value)} placeholder="Ask about this clip…" onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void sendChat()
              }
            }} />
            <button type="button" className="ds-btn" onClick={sendChat} disabled={chatBusy}>Ask</button>
          </div>
        </section>
      </div>
    </div>}
  </div>
}
