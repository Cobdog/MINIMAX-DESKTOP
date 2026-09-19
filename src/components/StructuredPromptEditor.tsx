/**
 * The structured H3 prompt editor (fh94g76, spec
 * docs/specs/structured-prompt-editor.md): one collapsible, optional box per
 * prompt part, building up independently — subjects as repeating cards (with
 * library/identity pins), the Flow box as the first-class beat/shot list
 * (time ranges + warnings, subsuming the retired timeline tool), and the
 * Audio box with the guide's <d> dialogue formatting helper. Every box
 * carries vocabulary chips and its own local-LLM assist (distill / enhance,
 * the same router path the freeform tools use). The compose preview shows the
 * exact string the concat contract submits.
 */
import { useRef, useState, type ReactNode } from 'react'
import { Camera, ChevronDown, ChevronRight, Copy, CopyPlus, LoaderCircle, Sparkles, Trash2, WandSparkles } from 'lucide-react'
import type { GenerationMode } from '../types'
import type { LlmStreamUi } from '../lib/useLlmStream'
import { CameraPathEditor } from './CameraPathEditor'
import {
  appendChipText, buildBoxAssistContext, buildStructuredParseInstructions, flowRowWarnings, flowRowsToAssistText, parseFlowRows, readStructuredDraft,
  STRUCTURED_BOXES, STRUCTURED_CHIPS, structuredId, structuredParseSchema, subjectCardsToAssistText, subjectLinesToCards, wrapDialogueLine,
  type StructuredBoxId, type StructuredPromptDraft, type StructuredSubjectCard,
} from '../lib/structuredPrompt'

type TextBoxId = 'concept' | 'setting' | 'lighting' | 'style' | 'camera'
const TEXT_BOXES: TextBoxId[] = ['concept', 'setting', 'lighting', 'style', 'camera']
const DIALOGUE_LANGUAGES = ['English', 'Chinese', 'Spanish', 'French', 'German', 'Japanese', 'Korean']

export type StructuredPinSource = {
  characters: Array<{ id: string; name: string }>
  assets: Array<{ id: string; label: string; kind: 'character' | 'location' }>
  identitySubjectText: string
}

export function StructuredPromptEditor(props: {
  draft: StructuredPromptDraft
  duration: number
  mode: GenerationMode
  noDialogue: boolean
  composed: string
  llmAvailable: boolean
  llmStream: LlmStreamUi
  pinSources: StructuredPinSource
  /** The reference-frame shape when the chain carries one (image/frames/
   *  reference modes) — the camera path editor compiles loop closure only
   *  against a connected reference image (the compiler's own contract). */
  referenceImageShape?: { shape: number[] } | null
  notify(tone: 'error' | 'success' | 'neutral', text: string): void
  onChange(next: StructuredPromptDraft): void
}) {
  const { draft, duration, mode, noDialogue, composed, llmAvailable, llmStream, pinSources, referenceImageShape, notify, onChange } = props
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [cameraPathOpen, setCameraPathOpen] = useState(false)
  const [assisting, setAssisting] = useState<StructuredBoxId | null>(null)
  const [suggestion, setSuggestion] = useState<{ box: StructuredBoxId; text: string } | null>(null)
  const [parsing, setParsing] = useState(false)
  const [parseReview, setParseReview] = useState<StructuredPromptDraft | null>(null)
  const [dialogueLanguage, setDialogueLanguage] = useState('English')
  const [dialogueLine, setDialogueLine] = useState('')
  const streamTarget = useRef<HTMLDivElement>(null)

  const patch = (part: Partial<StructuredPromptDraft>) => onChange({ ...draft, ...part })
  const toggleBox = (id: StructuredBoxId) => setCollapsed((current) => ({ ...current, [id]: !current[id] }))

  // ---- per-box assist (distill / enhance — the local router, as today) ----
  const boxAssistText = (box: StructuredBoxId): string => {
    if (box === 'subjects') return subjectCardsToAssistText(draft.subjects)
    if (box === 'flow') return flowRowsToAssistText(draft.flow)
    if (box === 'audio') return [draft.audio.soundscape, draft.audio.music, draft.audio.dialogue].filter(Boolean).join('\n\n')
    return draft[box]
  }

  const runAssist = async (box: StructuredBoxId, kind: 'distill' | 'enhance') => {
    if (assisting) return
    if (!llmAvailable) {
      notify('error', 'No local text model is available. Connect the llama.cpp router or Ollama in Settings.')
      return
    }
    if (!boxAssistText(box).trim()) {
      notify('error', 'Write rough content in the box first, then ask the local assistant to refine it.')
      return
    }
    setAssisting(box)
    setSuggestion(null)
    try {
      await new Promise((resolvePaint) => requestAnimationFrame(() => requestAnimationFrame(resolvePaint)))
      const full = await llmStream.stream({
        task: kind === 'distill' ? 'box-distill' : 'box-enhance',
        targetEngine: 'minimax-h3',
        length: 'concise',
        instructions: buildBoxAssistContext(box, { duration, mode, noDialogue }),
        draft: boxAssistText(box),
        target: streamTarget.current,
      })
      setSuggestion({ box, text: full.trim() })
    } catch (error) {
      notify('error', error instanceof Error ? error.message : String(error))
    } finally {
      setAssisting(null)
    }
  }

  const adoptSuggestion = (append: boolean) => {
    if (!suggestion) return
    const { box, text } = suggestion
    if (TEXT_BOXES.includes(box as TextBoxId)) {
      patch({ [box]: text } as Partial<StructuredPromptDraft>)
    } else if (box === 'subjects') {
      const cards = subjectLinesToCards(text)
      patch({ subjects: append ? [...draft.subjects, ...cards] : cards })
    } else if (box === 'flow') {
      // Timed-shot suggestions split through the same [Shot N] At MM:SS.mmm
      // grammar compose emits — markers become from-times.
      const parsedRows = parseFlowRows(text)
      patch({ flow: append ? [...draft.flow, ...parsedRows] : parsedRows })
    } else if (box === 'audio') {
      patch({ audio: { ...draft.audio, soundscape: text } })
    }
    setSuggestion(null)
  }

  const assistButtons = (box: StructuredBoxId) => (
    <>
      <button
        type="button"
        data-structured-assist={`distill-${box}`}
        disabled={!llmAvailable || Boolean(assisting)}
        title={!llmAvailable ? 'Connect a local text model in Settings' : 'Distill rough notes in this box into guide-correct content'}
        onClick={() => void runAssist(box, 'distill')}
      >
        {assisting === box ? <LoaderCircle size={11} className="spin" /> : <Sparkles size={11} />} distill
      </button>
      <button
        type="button"
        data-structured-assist={`enhance-${box}`}
        disabled={!llmAvailable || Boolean(assisting)}
        title={!llmAvailable ? 'Connect a local text model in Settings' : 'Rewrite this box in guide-correct vocabulary'}
        onClick={() => void runAssist(box, 'enhance')}
      >
        {assisting === box ? <LoaderCircle size={11} className="spin" /> : <WandSparkles size={11} />} enhance
      </button>
    </>
  )

  const chipsRow = (box: 'setting' | 'lighting' | 'style' | 'camera' | 'audio', apply: (next: string) => void, current: string) => (
    <div className="structured-chips" data-structured-chips={box}>
      {STRUCTURED_CHIPS[box].map((chip) => (
        <button
          type="button"
          key={chip.label}
          data-structured-chip={chip.label}
          title={chip.insertion}
          onClick={() => apply(appendChipText(current, chip.insertion))}
        >
          {chip.label}
        </button>
      ))}
    </div>
  )

  const boxHeader = (id: StructuredBoxId, label: string, hint: string, meta?: string) => (
    <button type="button" className="structured-box-header" data-structured-box-header={id} aria-expanded={!collapsed[id]} onClick={() => toggleBox(id)}>
      {collapsed[id] ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
      <strong>{label}</strong>
      <small>{hint}</small>
      {meta && <em>{meta}</em>}
    </button>
  )

  const textBox = (id: TextBoxId, label: string, hint: string, placeholder: string, chips?: 'setting' | 'lighting' | 'style' | 'camera', extraTools?: ReactNode, meta?: string) => (
    <section className="structured-box" data-structured-box={id} data-structured-empty={draft[id].trim() ? undefined : 'true'}>
      {boxHeader(id, label, hint, meta)}
      {!collapsed[id] && (
        <div className="structured-box-body">
          <textarea
            aria-label={`${label} box`}
            data-structured-input={id}
            rows={id === 'concept' ? 2 : 3}
            placeholder={placeholder}
            value={draft[id]}
            onChange={(event) => patch({ [id]: event.target.value } as Partial<StructuredPromptDraft>)}
          />
          {chips && chipsRow(chips, (next) => patch({ [id]: next } as Partial<StructuredPromptDraft>), draft[id])}
          <div className="structured-box-tools">
            {assistButtons(id)}
            {extraTools}
          </div>
        </div>
      )}
    </section>
  )

  // ---- the subjects box (cards + library/identity pins) ----
  const pinSubject = (value: string) => {
    if (!value) return
    let card: StructuredSubjectCard | null = null
    if (value === 'identity') {
      const text = pinSources.identitySubjectText.trim()
      if (!text) {
        notify('neutral', 'This chain has no identity payload text to pin yet — write the anchor text in the Identity section first.')
        return
      }
      card = { id: structuredId('subject'), name: 'Identity anchor', appearance: text, wardrobe: '', features: '', pinnedIdentity: true }
    } else if (value.startsWith('character:')) {
      const id = value.slice('character:'.length)
      const character = pinSources.characters.find((entry) => entry.id === id)
      if (!character) return
      card = { id: structuredId('subject'), name: character.name, appearance: `${character.name}, pinned from the character library reference`, wardrobe: '', features: '', pinnedAssetId: character.id }
    } else if (value.startsWith('asset:')) {
      const id = value.slice('asset:'.length)
      const asset = pinSources.assets.find((entry) => entry.id === id)
      if (!asset) return
      card = { id: structuredId('subject'), name: asset.label, appearance: `${asset.label}, pinned from the global ${asset.kind} asset reference`, wardrobe: '', features: '', pinnedAssetId: asset.id }
    }
    if (card) patch({ subjects: [...draft.subjects, card] })
  }

  const patchCard = (index: number, part: Partial<StructuredSubjectCard>) => {
    patch({ subjects: draft.subjects.map((card, cardIndex) => cardIndex === index ? { ...card, ...part } : card) })
  }

  // ---- the flow box (the timeline, first-class) ----
  const warnings = flowRowWarnings(draft.flow, duration)
  const patchRow = (index: number, part: Partial<{ from: number; to: number; text: string }>) => {
    patch({ flow: draft.flow.map((row, rowIndex) => rowIndex === index ? { ...row, ...part } : row) })
  }
  const moveRow = (index: number, delta: -1 | 1) => {
    const target = index + delta
    if (target < 0 || target >= draft.flow.length) return
    const rows = [...draft.flow]
    const [row] = rows.splice(index, 1)
    rows.splice(target, 0, row)
    patch({ flow: rows })
  }

  const addDialogueLine = () => {
    const wrapped = wrapDialogueLine(dialogueLine, dialogueLanguage)
    if (!wrapped) return
    patch({ audio: { ...draft.audio, dialogue: [draft.audio.dialogue.trim(), wrapped].filter(Boolean).join('\n') } })
    setDialogueLine('')
  }

  return <div className="structured-editor" data-structured-editor data-structured-mode="structured">
    {STRUCTURED_BOXES.map((box) => {
      if (box.id === 'concept') return <div key={box.id}>{textBox('concept', box.label, box.hint, 'The one-line idea — e.g. an i2v continuation of the café scene…')}</div>
      if (box.id === 'setting') return <div key={box.id}>{textBox('setting', box.label, box.hint, 'Environment, location, era, atmosphere…', 'setting')}</div>
      if (box.id === 'lighting') return <div key={box.id}>{textBox('lighting', box.label, box.hint, 'Light language — source, quality, direction…', 'lighting')}</div>
      if (box.id === 'style') return <div key={box.id}>{textBox('style', box.label, box.hint, 'Live-action, cinematic, 2D-animated…', 'style')}</div>
      if (box.id === 'camera') {
        return <div key={box.id}>
          {textBox(
            'camera', box.label, box.hint, 'Motion type + amplitude + speed as natural English — or author a compiled path…', 'camera',
            <button
              type="button"
              data-structured-camera-path-edit
              title="Open the camera path editor — author keyframes, compile through the camera compiler, land the guide-correct block here"
              onClick={() => setCameraPathOpen(true)}
            >
              <Camera size={11} /> edit path
            </button>,
            draft.cameraPath ? 'compiled path' : undefined,
          )}
          {cameraPathOpen && (
            <CameraPathEditor
              open
              boxText={draft.camera}
              doc={draft.cameraPath}
              duration={duration}
              referenceImage={referenceImageShape ?? null}
              onClose={() => setCameraPathOpen(false)}
              onApply={(next) => {
                onChange({ ...draft, camera: next.boxText, cameraPath: next.doc })
                setCameraPathOpen(false)
              }}
            />
          )}
        </div>
      }
      if (box.id === 'subjects') {
        return <section className="structured-box" key={box.id} data-structured-box="subjects" data-structured-empty={draft.subjects.length ? undefined : 'true'}>
          {boxHeader('subjects', box.label, box.hint, `${draft.subjects.length} card${draft.subjects.length === 1 ? '' : 's'}`)}
          {!collapsed.subjects && (
            <div className="structured-box-body">
              {draft.subjects.map((card, index) => (
                <div className="structured-subject" key={card.id} data-structured-subject={index}>
                  <div className="structured-subject-head">
                    <input
                      aria-label={`Subject ${index + 1} name`}
                      data-structured-subject-name={index}
                      placeholder="name / role"
                      value={card.name}
                      onChange={(event) => patchCard(index, { name: event.target.value })}
                    />
                    <button type="button" aria-label={`Remove subject ${index + 1}`} data-structured-subject-remove={index} onClick={() => patch({ subjects: draft.subjects.filter((_, cardIndex) => cardIndex !== index) })}>
                      <Trash2 size={11} />
                    </button>
                  </div>
                  {(card.pinnedIdentity || card.pinnedAssetId) && <span className="structured-pin-badge" data-structured-pin-badge>{card.pinnedIdentity ? 'identity payload' : 'library pin'}</span>}
                  <textarea
                    aria-label={`Subject ${index + 1} appearance`}
                    data-structured-subject-appearance={index}
                    rows={2}
                    placeholder="appearance"
                    value={card.appearance}
                    onChange={(event) => patchCard(index, { appearance: event.target.value })}
                  />
                  <input
                    aria-label={`Subject ${index + 1} wardrobe`}
                    data-structured-subject-wardrobe={index}
                    placeholder="wardrobe"
                    value={card.wardrobe}
                    onChange={(event) => patchCard(index, { wardrobe: event.target.value })}
                  />
                  <input
                    aria-label={`Subject ${index + 1} features`}
                    data-structured-subject-features={index}
                    placeholder="distinctive features"
                    value={card.features}
                    onChange={(event) => patchCard(index, { features: event.target.value })}
                  />
                </div>
              ))}
              <div className="structured-box-tools">
                <button type="button" data-structured-subject-add onClick={() => patch({ subjects: [...draft.subjects, { id: structuredId('subject'), name: '', appearance: '', wardrobe: '', features: '' }] })}>
                  + subject card
                </button>
                <select
                  aria-label="Pin a subject from the library or identity payload"
                  data-structured-subject-pin
                  value=""
                  onChange={(event) => { pinSubject(event.target.value); event.target.value = '' }}
                >
                  <option value="">pin from…</option>
                  {pinSources.identitySubjectText.trim() && <option value="identity">the chain identity payload</option>}
                  {pinSources.characters.map((character) => <option key={character.id} value={`character:${character.id}`}>character · {character.name}</option>)}
                  {pinSources.assets.map((asset) => <option key={asset.id} value={`asset:${asset.id}`}>{asset.kind === 'location' ? 'location' : 'character'} asset · {asset.label}</option>)}
                </select>
                {assistButtons('subjects')}
              </div>
            </div>
          )}
        </section>
      }
      if (box.id === 'flow') {
        return <section className="structured-box" key={box.id} data-structured-box="flow" data-structured-empty={draft.flow.length ? undefined : 'true'}>
          {boxHeader('flow', box.label, `${box.hint} · ${duration}s`, `${draft.flow.length} beat${draft.flow.length === 1 ? '' : 's'}`)}
          {!collapsed.flow && (
            <div className="structured-box-body">
              {draft.flow.map((row, index) => (
                <div key={row.id} className="structured-flow-row" data-structured-flow-row={index}>
                  <div className="structured-flow-times">
                    <input
                      type="number"
                      min={0}
                      max={duration}
                      step={0.5}
                      aria-label={`Beat ${index + 1} start seconds`}
                      data-structured-flow-from={index}
                      value={row.from}
                      onChange={(event) => patchRow(index, { from: Number(event.target.value) })}
                    />
                    <span>→</span>
                    <input
                      type="number"
                      min={0}
                      max={duration}
                      step={0.5}
                      aria-label={`Beat ${index + 1} end seconds (${index === 0 ? 'to ≤ from = a moment' : 'to ≤ from = a moment'})`}
                      data-structured-flow-to={index}
                      value={row.to}
                      onChange={(event) => patchRow(index, { to: Number(event.target.value) })}
                    />
                  </div>
                  <textarea
                    aria-label={`Beat ${index + 1} description`}
                    data-structured-flow-text={index}
                    rows={2}
                    placeholder="what happens in this window — action, state change, camera change, reference moment"
                    value={row.text}
                    onChange={(event) => patchRow(index, { text: event.target.value })}
                  />
                  <div className="structured-flow-row-tools">
                    <button type="button" aria-label={`Move beat ${index + 1} up`} data-structured-flow-up={index} disabled={index === 0} onClick={() => moveRow(index, -1)}>↑</button>
                    <button type="button" aria-label={`Move beat ${index + 1} down`} data-structured-flow-down={index} disabled={index === draft.flow.length - 1} onClick={() => moveRow(index, 1)}>↓</button>
                    <button type="button" aria-label={`Duplicate beat ${index + 1}`} data-structured-flow-duplicate={index} onClick={() => patch({ flow: [...draft.flow.slice(0, index + 1), { ...row, id: structuredId('flow') }, ...draft.flow.slice(index + 1)] })}><CopyPlus size={11} /></button>
                    <button type="button" aria-label={`Remove beat ${index + 1}`} data-structured-flow-remove={index} onClick={() => patch({ flow: draft.flow.filter((_, rowIndex) => rowIndex !== index) })}><Trash2 size={11} /></button>
                  </div>
                </div>
              ))}
              {warnings.map((entry, index) => <p key={`${entry.rowId}-${index}`} className="structured-warning" role="alert" data-structured-flow-warning={index}>{entry.warning}</p>)}
              <div className="structured-box-tools">
                <button type="button" data-structured-flow-add onClick={() => patch({ flow: [...draft.flow, { id: structuredId('flow'), from: draft.flow.length ? draft.flow[draft.flow.length - 1].from : 0, to: draft.flow.length ? draft.flow[draft.flow.length - 1].from : 0, text: '' }] })}>
                  + beat
                </button>
                {assistButtons('flow')}
              </div>
            </div>
          )}
        </section>
      }
      // audio
      return <section className="structured-box" key={box.id} data-structured-box="audio" data-structured-empty={(draft.audio.soundscape || draft.audio.music || draft.audio.dialogue).trim() ? undefined : 'true'}>
        {boxHeader('audio', box.label, box.hint)}
        {!collapsed.audio && (
          <div className="structured-box-body">
            <label className="structured-audio-label">soundscape <small>→ overall_soundscape</small></label>
            <textarea
              aria-label="Soundscape box"
              data-structured-input="audio-soundscape"
              rows={2}
              placeholder="Ambience and physical sounds across the video…"
              value={draft.audio.soundscape}
              onChange={(event) => patch({ audio: { ...draft.audio, soundscape: event.target.value } })}
            />
            {chipsRow('audio', (next) => patch({ audio: { ...draft.audio, soundscape: next } }), draft.audio.soundscape)}
            <label className="structured-audio-label">music <small>→ non_diegetic_music</small></label>
            <textarea
              aria-label="Music box"
              data-structured-input="audio-music"
              rows={2}
              placeholder="Audience-only score — instrumentation, tempo, dynamics… (empty = N/A)"
              value={draft.audio.music}
              onChange={(event) => patch({ audio: { ...draft.audio, music: event.target.value } })}
            />
            <label className="structured-audio-label">dialogue <small>&lt;d&gt;[Language] …&lt;/d&gt;</small></label>
            <textarea
              aria-label="Dialogue box"
              data-structured-input="audio-dialogue"
              rows={2}
              placeholder={'One line per spoken line, e.g. The woman (S1) says: <d>[English] I get off at the next station.</d>'}
              value={draft.audio.dialogue}
              onChange={(event) => patch({ audio: { ...draft.audio, dialogue: event.target.value } })}
            />
            <div className="structured-dialogue-helper" data-structured-dialogue-helper>
              <select aria-label="Dialogue language" data-structured-dialogue-language value={dialogueLanguage} onChange={(event) => setDialogueLanguage(event.target.value)}>
                {DIALOGUE_LANGUAGES.map((language) => <option key={language} value={language}>{language}</option>)}
              </select>
              <input
                aria-label="New dialogue line"
                data-structured-dialogue-line
                placeholder="a spoken line to format…"
                value={dialogueLine}
                onChange={(event) => setDialogueLine(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addDialogueLine() } }}
              />
              <button type="button" data-structured-dialogue-add onClick={addDialogueLine} disabled={!dialogueLine.trim()}>+ &lt;d&gt;</button>
            </div>
            <div className="structured-box-tools">
              {assistButtons('audio')}
            </div>
          </div>
        )}
      </section>
    })}

    {assisting && <div className="canvas-llm-stream" ref={streamTarget} role="status" aria-label="Local assistant streaming" data-structured-llm-stream />}
    {suggestion && (
      <div className="canvas-prompt-suggestion structured-suggestion" data-structured-suggestion={suggestion.box} role="status">
        <span className="canvas-prompt-suggestion-label">Local suggestion — {STRUCTURED_BOXES.find((box) => box.id === suggestion.box)?.label ?? suggestion.box} box</span>
        <textarea aria-label="Local box suggestion" value={suggestion.text} readOnly rows={3} />
        <div className="canvas-prompt-suggestion-actions">
          <button type="button" onClick={() => setSuggestion(null)}>dismiss</button>
          {suggestion.box === 'flow' || suggestion.box === 'subjects' ? <button type="button" onClick={() => adoptSuggestion(true)}>append rows</button> : null}
          <button type="button" className="primary" onClick={() => adoptSuggestion(false)}>{suggestion.box === 'flow' || suggestion.box === 'subjects' ? 'replace' : 'use suggestion'}</button>
        </div>
      </div>
    )}

    {parseReview && (
      <div className="canvas-prompt-suggestion structured-parse-review" data-structured-parse-review role="status">
        <span className="canvas-prompt-suggestion-label">Distilled into boxes — review before adopting</span>
        <ul>
          {STRUCTURED_BOXES.map((box) => {
            const summary = box.id === 'subjects'
              ? `${parseReview.subjects.length} card${parseReview.subjects.length === 1 ? '' : 's'}`
              : box.id === 'flow'
                ? `${parseReview.flow.length} beat${parseReview.flow.length === 1 ? '' : 's'}`
                : box.id === 'audio'
                  ? [parseReview.audio.soundscape, parseReview.audio.music, parseReview.audio.dialogue].filter(Boolean).length || 0
                  : parseReview[box.id].trim().length
            const text = typeof summary === 'number' ? `${summary} character${summary === 1 ? '' : 's'}` : summary
            return <li key={box.id} data-structured-parse-review-box={box.id}><strong>{box.label}</strong><span>{text || 'empty'}</span></li>
          })}
        </ul>
        <div className="canvas-prompt-suggestion-actions">
          <button type="button" onClick={() => setParseReview(null)}>dismiss</button>
          <button type="button" className="primary" onClick={() => { onChange(parseReview); setParseReview(null) }}>adopt boxes</button>
        </div>
      </div>
    )}

    <div className="structured-parse-tool">
      <button
        type="button"
        data-structured-distill
        disabled={!llmAvailable || parsing}
        title={!llmAvailable ? 'Connect a local text model in Settings' : 'Ask the local model to split the current prompt into the finer boxes — reviewed before adopting'}
        onClick={async () => {
          if (!llmAvailable || parsing) return
          setParsing(true)
          setParseReview(null)
          try {
            const result = await window.minimax.llmGenerateStructured({
              task: 'parse-structured',
              targetEngine: 'minimax-h3',
              length: 'concise',
              instructions: buildStructuredParseInstructions(),
              draft: composed,
              schema: structuredParseSchema as unknown as Record<string, unknown>,
            })
            const next = readStructuredDraft(result)
            if (!next || (!next.concept && !next.subjects.length && !next.flow.length)) {
              notify('error', 'The local model could not distill this prompt into boxes — the current boxes are unchanged.')
              return
            }
            setParseReview(next)
          } catch (error) {
            notify('error', error instanceof Error ? error.message : String(error))
          } finally {
            setParsing(false)
          }
        }}
      >
        {parsing ? <LoaderCircle size={11} className="spin" /> : <Sparkles size={11} />} distill into boxes…
      </button>
    </div>

    <details className="structured-preview" data-structured-preview>
      <summary><Copy size={11} /> compose preview — this exact string is submitted</summary>
      <pre aria-label="Composed prompt preview">{composed}</pre>
    </details>
  </div>
}
