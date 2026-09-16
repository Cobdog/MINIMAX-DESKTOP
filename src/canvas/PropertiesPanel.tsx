/**
 * Canvas Phase 2 — the properties panel (the absorption surface for
 * CreateView's binding model; spec §4 properties entry, §2 identity payload).
 *
 * Per-chain settings (the unwound workspace singleton, persisted in the
 * document store): SmartPromptEditor as the universal prompt field, engine
 * params (tier off/4/8 + turbo family through the optimization registry,
 * with detection state and install guidance), the reference binding model
 * (ordered canvas-output refs + character/location library binding +
 * clothing policy), the identity payload (verbatim subject text + the
 * strength dial with its stiffness↔drift labels), and keyframe guides as
 * chain settings. The generate row validates honestly before submit.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Rnd } from 'react-rnd'
import { Dices, Play, Square, Star, X } from 'lucide-react'
import { SmartPromptEditor } from '../components/SmartPromptEditor'
import { detectOptimizations } from '../lib/graph'
import { guideFrameWarning } from '../lib/workflow'
import { useSessionStore } from '../state/sessionStore'
import { documentsApi } from './api'
import { STATUS_LABEL } from './derive'
import { effectiveMode, MODE_LABEL, readChainSettings, type CanvasChainSettings } from './generation'
import { useCanvasStore } from './store'
import type { DocumentChain } from './derive'

const RESOLUTIONS = ['1344x768', '768x1344', '768x768']
const TIERS: Array<{ value: CanvasChainSettings['turbo']; label: string; note: string }> = [
  { value: 'off', label: 'Quality', note: 'full-step native' },
  { value: '4', label: 'Fast · 4-step', note: 'turbo LoRA' },
  { value: '8', label: 'Fast · 8-step', note: 'turbo LoRA' },
]

/** Debounced persistence for panel edits: typing never hammers the document
 *  store; a chain switch or unmount flushes. */
function useDebouncedCommit<T>(value: T, skip: boolean, commit: (value: T) => void, delay = 500) {
  const commitRef = useRef(commit)
  commitRef.current = commit
  useEffect(() => {
    if (skip) return undefined
    const timer = window.setTimeout(() => commitRef.current(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, skip, delay])
}

export function PropertiesPanel() {
  const open = useCanvasStore((state) => state.inspectorOpen)
  const setInspectorOpen = useCanvasStore((state) => state.setInspectorOpen)
  const selection = useCanvasStore((state) => state.selection)
  const documents = useCanvasStore((state) => state.documents)
  const activeProjectId = useCanvasStore((state) => state.activeProjectId)
  const tiles = useCanvasStore((state) => state.tiles)
  const libraries = useCanvasStore((state) => state.libraries)
  const chainBindings = useCanvasStore((state) => state.chainBindings)
  const setChainSettings = useCanvasStore((state) => state.setChainSettings)
  const setChainIdentity = useCanvasStore((state) => state.setChainIdentity)
  const submitChain = useCanvasStore((state) => state.submitChain)
  const validateChain = useCanvasStore((state) => state.validateChain)
  const cancelChainJob = useCanvasStore((state) => state.cancelChainJob)

  const models = useSessionStore((state) => state.models)
  const info = useSessionStore((state) => state.info)

  const chainId = selection.tileIds.length === 1 ? selection.tileIds[0] : null
  const doc = activeProjectId ? documents[activeProjectId] : null
  const chain: DocumentChain | null = chainId && doc ? doc.chains.find((entry) => entry.id === chainId) ?? null : null
  const tile = chainId ? tiles.find((entry) => entry.id === chainId) ?? null : null

  const [draft, setDraft] = useState<CanvasChainSettings | null>(null)
  const [subjectText, setSubjectText] = useState('')
  const [strength, setStrength] = useState(1)
  const [submitting, setSubmitting] = useState(false)

  // The last server state THIS panel adopted or committed. A concurrent
  // document reload (a take landing, another surface editing, an identity
  // commit) must never wipe in-flight local edits: the server value is
  // adopted ONLY when it differs from what we last knew — and never while
  // the draft has moved past it.
  const knownRef = useRef<{ chainId: string; settings: string; subjectText: string; strength: number } | null>(null)
  useEffect(() => {
    if (!chain) {
      setDraft(null)
      knownRef.current = null
      return
    }
    const settings = readChainSettings(chain.settings, useSessionStore.getState().settings)
    const incomingSubject = chain.identity?.subjectText ?? ''
    const incomingStrength = chain.identity?.strength ?? 1
    const known = knownRef.current
    const serverSettings = JSON.stringify(settings)
    const chainSwitched = !known || known.chainId !== chain.id
    // Outside edits (another surface changed this chain): adopt when the
    // server state moved away from what we last committed/adopted AND the
    // local draft hasn't diverged past it (a diverged draft is the user's
    // newer truth; its own commit lands momentarily).
    const settingsChanged = !chainSwitched && known.settings !== serverSettings && JSON.stringify(draft) === known.settings
    if (chainSwitched || settingsChanged) {
      knownRef.current = { chainId: chain.id, settings: serverSettings, subjectText: incomingSubject, strength: incomingStrength }
      setDraft(settings)
      setSubjectText(incomingSubject)
      setStrength(incomingStrength)
    } else if (known && (known.subjectText !== incomingSubject || Math.abs(known.strength - incomingStrength) > 1e-9) && known.subjectText === subjectText) {
      knownRef.current = { chainId: chain.id, settings: known.settings, subjectText: incomingSubject, strength: incomingStrength }
      setSubjectText(incomingSubject)
      setStrength(incomingStrength)
    }
  }, [chain, draft, subjectText])

  useDebouncedCommit(draft, !draft || !chainId, (value) => {
    if (!chainId || !value) return
    const known = knownRef.current
    if (known && known.chainId === chainId && known.settings === JSON.stringify(value)) return // no-op edit: never reload for nothing
    if (known && known.chainId === chainId) knownRef.current = { ...known, settings: JSON.stringify(value) }
    void setChainSettings(chainId, value)
  })
  useDebouncedCommit(subjectText, !chain, (value) => {
    if (!chainId) return
    const known = knownRef.current
    if (known && known.chainId === chainId && known.subjectText === value) return
    if (known && known.chainId === chainId) knownRef.current = { ...known, subjectText: value }
    void setChainIdentity(chainId, { subjectText: value })
  }, 700)
  useDebouncedCommit(strength, !chain, (value) => {
    if (!chainId) return
    const known = knownRef.current
    if (known && known.chainId === chainId && Math.abs(known.strength - value) < 1e-9) return
    if (known && known.chainId === chainId) knownRef.current = { ...known, strength: value }
    void setChainIdentity(chainId, { strength: value })
  }, 300)

  const turboFamilies = useMemo(() => detectOptimizations(info, models).filter((entry) => entry.entry.kind === 'turbo'), [info, models])
  // Bindings + validation recompute per render on purpose: validation reads
  // the PERSISTED settings (which lag the draft by the debounce), so the
  // message updates as commits land. Both are cheap single-chain walks.
  const bindings = chainId ? chainBindings(chainId) : []
  const validation = chainId ? validateChain(chainId) : null

  if (!open || !chain || !draft || !tile) return null

  const patch = (part: Partial<CanvasChainSettings>) => setDraft((current) => current ? { ...current, ...part } : current)
  const mode = effectiveMode(draft)
  const referenceSlots = bindings.length
  const guideWarnings = draft.timelineGuides.map((guide) => guideFrameWarning(guide.seconds, draft.duration)).filter(Boolean) as string[]

  const generate = async () => {
    if (!chainId || submitting) return
    setSubmitting(true)
    try {
      // Commit the draft immediately — submit reads the persisted settings.
      await setChainSettings(chainId, draft)
      await submitChain(chainId)
    } finally {
      setSubmitting(false)
    }
  }

  return <Rnd
    className="canvas-inspector canvas-properties"
    data-canvas-inspector
    data-canvas-properties
    default={{ x: window.innerWidth - 396, y: 64, width: 356, height: Math.min(760, window.innerHeight - 140) }}
    minWidth={300}
    minHeight={240}
    bounds="parent"
    dragHandleClassName="canvas-inspector-header"
    enableResizing={{ bottom: true, bottomRight: true, right: true, bottomLeft: false, topLeft: false, topRight: false, left: false, top: false }}
  >
    <header className="canvas-inspector-header">
      <strong>{tile.title}</strong>
      <span className="canvas-properties-mode" data-canvas-mode={mode}>{MODE_LABEL[mode]}</span>
      <button type="button" aria-label="Close properties" onClick={() => setInspectorOpen(false)}><X size={13} /></button>
    </header>
    <div className="canvas-inspector-body canvas-properties-body">
      <section className="canvas-properties-section" data-canvas-section="prompt">
        <label>Prompt <span className="canvas-properties-hint">// presets</span></label>
        <SmartPromptEditor
          id={`canvas-prompt-${chain.id}`}
          value={draft.prompt}
          onChange={(prompt) => patch({ prompt })}
          placeholder="Describe the shot… type // for production presets"
          ariaLabel="Chain prompt"
        />
      </section>

      <section className="canvas-properties-section" data-canvas-section="engine">
        <label>Engine — MiniMax H3</label>
        <div className="canvas-properties-row">
          <span>tier</span>
          <div className="canvas-properties-tiers" role="radiogroup" aria-label="Speed tier">
            {TIERS.map((tier) => (
              <button
                type="button"
                key={tier.value}
                role="radio"
                aria-checked={draft.turbo === tier.value}
                className={`canvas-chip ${draft.turbo === tier.value ? 'active' : ''}`}
                data-canvas-tier={tier.value}
                onClick={() => patch({ turbo: tier.value })}
              >
                {tier.label} <small>{tier.note}</small>
              </button>
            ))}
          </div>
        </div>
        <div className="canvas-properties-row">
          <label htmlFor="canvas-turbo-family">turbo family</label>
          <select id="canvas-turbo-family" data-canvas-family value={draft.turboFamily} onChange={(event) => patch({ turboFamily: event.target.value })}>
            <option value="">auto — registry-ranked</option>
            {turboFamilies.map(({ entry, detection }) => (
              <option key={entry.id} value={entry.id}>{entry.label}{detection.available ? '' : ' (not installed)'}</option>
            ))}
          </select>
        </div>
        <div className="canvas-properties-row">
          <label htmlFor="canvas-duration">seconds</label>
          <input id="canvas-duration" data-canvas-duration type="number" min={2} max={15} step={1} value={draft.duration} onChange={(event) => patch({ duration: Math.max(2, Math.min(15, Number(event.target.value) || 6)) })} />
          <label htmlFor="canvas-resolution">size</label>
          <select id="canvas-resolution" data-canvas-resolution value={draft.resolution} onChange={(event) => patch({ resolution: event.target.value })}>
            {RESOLUTIONS.map((resolution) => <option key={resolution} value={resolution}>{resolution.replace('x', ' × ')}</option>)}
          </select>
        </div>
        <div className="canvas-properties-row">
          <label htmlFor="canvas-seed">seed</label>
          <input id="canvas-seed" data-canvas-seed type="number" min={0} value={draft.seed} onChange={(event) => patch({ seed: Math.max(0, Math.floor(Number(event.target.value) || 0)) })} />
          <button type="button" className="canvas-chip" aria-label="Randomize seed" onClick={() => patch({ seed: Math.floor(Math.random() * 1_000_000_000) })}><Dices size={12} /></button>
        </div>
      </section>

      <section className="canvas-properties-section" data-canvas-section="references">
        <label>References <span className="canvas-properties-hint">{referenceSlots} of 9 slots</span></label>
        <ol className="canvas-properties-refs" data-canvas-reference-list>
          {bindings.map((binding, index) => (
            <li key={`${binding.file.path}-${index}`} data-canvas-reference={index}>
              <span className="canvas-properties-ref-tag">&lt;Picture {index + 1}&gt;</span>
              <span className="canvas-properties-ref-label">{binding.label}</span>
            </li>
          ))}
          {!bindings.length && <li className="canvas-properties-empty">No references — the chain renders from its prompt{draft.firstFrameOutputId ? ' + first frame' : ''}.</li>}
        </ol>
        {draft.referenceOutputIds.length > 0 && (
          <div className="canvas-properties-row">
            <button
              type="button"
              className="canvas-chip"
              data-canvas-clear-refs
              onClick={() => patch({ referenceOutputIds: [] })}
            >
              clear canvas refs ({draft.referenceOutputIds.length})
            </button>
          </div>
        )}
        {libraries.characters.length > 0 && (
          <div className="canvas-properties-row">
            <label htmlFor="canvas-ref-character">character library</label>
            <select
              id="canvas-ref-character"
              data-canvas-ref-character
              value=""
              onChange={(event) => { if (event.target.value) patch({ referenceCharacterIds: draft.referenceCharacterIds.includes(event.target.value) ? draft.referenceCharacterIds.filter((id) => id !== event.target.value) : [...draft.referenceCharacterIds, event.target.value] }) }}
            >
              <option value="">bind / unbind…</option>
              {libraries.characters.map((character) => (
                <option key={character.id} value={character.id}>{character.name}{draft.referenceCharacterIds.includes(character.id) ? ' ✓' : ''}</option>
              ))}
            </select>
          </div>
        )}
        {libraries.locations.length > 0 && (
          <div className="canvas-properties-row">
            <label htmlFor="canvas-ref-location">location library</label>
            <select
              id="canvas-ref-location"
              data-canvas-ref-location
              value=""
              onChange={(event) => { if (event.target.value) patch({ referenceLocationIds: draft.referenceLocationIds.includes(event.target.value) ? draft.referenceLocationIds.filter((id) => id !== event.target.value) : [...draft.referenceLocationIds, event.target.value] }) }}
            >
              <option value="">bind / unbind…</option>
              {libraries.locations.map((location) => (
                <option key={location.id} value={location.id}>{location.name}{draft.referenceLocationIds.includes(location.id) ? ' ✓' : ''}</option>
              ))}
            </select>
          </div>
        )}
        <div className="canvas-properties-row">
          <label htmlFor="canvas-clothing">clothing policy</label>
          <select id="canvas-clothing" data-canvas-clothing value={draft.clothingPolicy} onChange={(event) => patch({ clothingPolicy: event.target.value as CanvasChainSettings['clothingPolicy'] })}>
            <option value="wardrobe">assigned wardrobe</option>
            <option value="underwear">identity underwear</option>
            <option value="unrestricted">scene prompt decides</option>
          </select>
        </div>
      </section>

      <section className="canvas-properties-section" data-canvas-section="identity">
        <label>Identity payload <span className="canvas-properties-hint">re-injected every window</span></label>
        <textarea
          data-canvas-identity-subject
          rows={2}
          placeholder="Verbatim subject text — the anchor phrases that keep this chain’s identity stable"
          value={subjectText}
          onChange={(event) => setSubjectText(event.target.value)}
        />
        <div className="canvas-properties-dial" data-canvas-identity-strength={strength}>
          <span className="canvas-properties-dial-label stiff">stiff</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={strength}
            aria-label="Identity strength"
            onChange={(event) => setStrength(Number(event.target.value))}
          />
          <span className="canvas-properties-dial-label drift">drift</span>
          <span className="canvas-properties-dial-value">{strength.toFixed(2)}</span>
        </div>
        <p className="canvas-properties-note">
          Stiff preserves the reference identity exactly; loose lets the take
          drift with the prompt. Re-anchor by forking an earlier take (B).
        </p>
      </section>

      <section className="canvas-properties-section" data-canvas-section="guides">
        <label>Keyframe guides <span className="canvas-properties-hint">AddGuide frames</span></label>
        {draft.timelineGuides.map((guide, index) => (
          <div className="canvas-properties-row" key={`${guide.file.path}-${index}`} data-canvas-guide={index}>
            <span className="canvas-properties-ref-tag">@</span>
            <input
              type="number"
              min={-draft.duration}
              max={draft.duration}
              step={0.5}
              value={guide.seconds}
              aria-label={`Guide ${index + 1} seconds`}
              onChange={(event) => patch({ timelineGuides: draft.timelineGuides.map((entry, guideIndex) => guideIndex === index ? { ...entry, seconds: Number(event.target.value) } : entry) })}
            />
            <span className="canvas-properties-ref-label">{guide.file.name}</span>
            <button type="button" aria-label={`Remove guide ${index + 1}`} onClick={() => patch({ timelineGuides: draft.timelineGuides.filter((_, guideIndex) => guideIndex !== index) })}><X size={11} /></button>
          </div>
        ))}
        {guideWarnings.map((warning) => <p key={warning} className="canvas-properties-warning" role="alert">{warning}</p>)}
        <div className="canvas-properties-row">
          <button
            type="button"
            className="canvas-chip"
            data-canvas-add-guide
            onClick={async () => {
              const picked = await window.minimax.chooseMedia('image')
              if (!picked) return
              patch({ timelineGuides: [...draft.timelineGuides, { file: { ...picked, kind: 'image' }, seconds: Math.min(draft.duration - 1, 1) }] })
            }}
          >
            + guide image
          </button>
        </div>
      </section>

      <section className="canvas-properties-section" data-canvas-section="takes">
        <label>Takes <span className="canvas-properties-hint">{tile.priors} prior{tile.priors === 1 ? '' : 's'}</span></label>
        <ul className="canvas-properties-takes" data-canvas-takes>
          {tile.takes.slice(0, 5).map((take) => (
            <li key={take.id} data-canvas-take={take.id} className={take.supersededBy ? 'prior' : 'canonical'}>
              <span>{take.id.slice(0, 8)}</span>
              {take.supersededBy
                ? <button type="button" data-canvas-take-restore={take.id} title="Make this take canonical — nothing is deleted" onClick={() => { const output = chain.outputs[0]; if (output) void documentsApi.supersedeTake({ outputId: output.id, takeId: take.id }).then(() => useCanvasStore.getState().recompute()) }}>restore</button>
                : <span className="canvas-properties-canonical"><Star size={10} fill="currentColor" /> canonical</span>}
            </li>
          ))}
          {!tile.takes.length && <li className="canvas-properties-empty">No takes yet.</li>}
        </ul>
      </section>

    </div>
      <footer className="canvas-properties-submit">
        <div className="canvas-properties-state">
          <span className="canvas-tile-ring" data-status={tile.status} /> {STATUS_LABEL[tile.status]}
        </div>
        {validation && <p className="canvas-properties-warning" data-canvas-validation role="alert">{validation}</p>}
        {tile.jobId && (tile.status === 'running' || tile.status === 'queued-gpu')
          ? <button type="button" className="canvas-properties-generate" data-canvas-cancel onClick={() => void cancelChainJob(chain.id)}><Square size={12} /> stop</button>
          : <button type="button" className="canvas-properties-generate" data-canvas-generate onClick={() => void generate()} disabled={submitting}>
            <Play size={12} /> generate · {MODE_LABEL[mode]}
          </button>}
      </footer>
  </Rnd>
}
