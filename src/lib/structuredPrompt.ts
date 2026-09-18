/**
 * The structured H3 prompt editor's model + contracts (fh94g76, spec
 * docs/specs/structured-prompt-editor.md). Boxes per prompt part build up
 * independently; ONE concat function composes them into the exact string the
 * freeform surface would submit; ONE deterministic parse splits a freeform
 * prompt back into boxes without ever dropping text.
 *
 * Guide provenance (docs/library/minimax-h3-prompt-guide-base.md, pinned at
 * MiniMaxAI/MiniMax-H3 sha 42ed227): §2.2 the three core fields, §4.1 the
 * style-led [Shot 1] opening, §4.2 shot/cut timing ("[Shot N] At MM:SS.mmm"),
 * §4.3 the camera-motion vocabulary, §4.4 speakers + <d> dialogue, §4.6/§4.7
 * the soundscape/music fields. This module is PURE (types-only imports) so
 * the VM test harness loads it directly, like camera/derive.
 */
import type { GenerationMode } from '../types'

// ---------------------------------------------------------------------------
// The draft model
// ---------------------------------------------------------------------------

/** One subject card — one repeating character/prop per card. `pinnedAssetId`
 *  / `pinnedIdentity` record the pin provenance (display-only; compose treats
 *  every card's text identically). */
export type StructuredSubjectCard = {
  id: string
  name: string
  appearance: string
  wardrobe: string
  features: string
  pinnedAssetId?: string
  pinnedIdentity?: boolean
}

/** One flow row: a beat/shot. `to <= from` means a MOMENT (spec §3); ranges
 *  are clipped to the job duration at compose time. */
export type StructuredFlowRow = {
  id: string
  from: number
  to: number
  text: string
}

export type StructuredAudioBox = {
  /** Ambience / physical-sound lines → overall_soundscape. */
  soundscape: string
  /** Audience-only score → non_diegetic_music. */
  music: string
  /** Dialogue lines (each carries the guide's <d> formatting). */
  dialogue: string
}

export type StructuredPromptDraft = {
  concept: string
  subjects: StructuredSubjectCard[]
  setting: string
  lighting: string
  style: string
  camera: string
  flow: StructuredFlowRow[]
  audio: StructuredAudioBox
}

export type StructuredBoxId = 'concept' | 'subjects' | 'setting' | 'lighting' | 'style' | 'camera' | 'flow' | 'audio'

/** The blessed box list (spec §2) — compose order follows this table. */
export const STRUCTURED_BOXES: Array<{ id: StructuredBoxId; label: string; hint: string }> = [
  { id: 'concept', label: 'Concept', hint: 'the one-line idea / task type' },
  { id: 'subjects', label: 'Subjects', hint: 'one card per subject' },
  { id: 'setting', label: 'Setting', hint: 'environment, era, atmosphere' },
  { id: 'lighting', label: 'Lighting', hint: 'light language per the guide' },
  { id: 'style', label: 'Style', hint: 'visual style / medium' },
  { id: 'camera', label: 'Camera', hint: 'shots and movement vocabulary' },
  { id: 'flow', label: 'Flow', hint: 'the timeline — beats with time ranges' },
  { id: 'audio', label: 'Audio', hint: 'soundscape · music · <d> dialogue' },
]

let idSeq = 0
/** Stable-enough local ids (draft state only — never persisted semantically). */
export function structuredId(prefix: string) {
  idSeq += 1
  return `${prefix}-${Date.now().toString(36)}-${idSeq}`
}

export function emptyStructuredDraft(): StructuredPromptDraft {
  return {
    concept: '', subjects: [], setting: '', lighting: '', style: '', camera: '',
    flow: [],
    audio: { soundscape: '', music: '', dialogue: '' },
  }
}

export function structuredDraftIsEmpty(draft: StructuredPromptDraft) {
  return !draft.concept.trim()
    && !draft.subjects.some((card) => card.name.trim() || card.appearance.trim() || card.wardrobe.trim() || card.features.trim())
    && !draft.setting.trim() && !draft.lighting.trim() && !draft.style.trim() && !draft.camera.trim()
    && !draft.flow.some((row) => row.text.trim())
    && !draft.audio.soundscape.trim() && !draft.audio.music.trim() && !draft.audio.dialogue.trim()
}

// ---------------------------------------------------------------------------
// Sentence assembly helpers (shared by compose)
// ---------------------------------------------------------------------------

const TERMINAL = /[.!?…:;)"']$/

/** Joins non-empty trimmed parts with ', ' and terminates with '.' unless the
 *  last part already ends in terminal punctuation. Empty parts contribute
 *  nothing (the spec's empty-box rule, at part granularity). */
function sentence(parts: Array<string | undefined>): string {
  const present = parts.map((part) => (part ?? '').trim()).filter(Boolean)
  if (!present.length) return ''
  const joined = present.join(', ')
  return TERMINAL.test(joined) ? joined : `${joined}.`
}

/** The guide's cut-time label: "At MM:SS.mmm" with exactly three decimals
 *  (guide §4.2 — strictly increasing, inside the duration). */
export function flowCutLabel(seconds: number): string {
  const totalMillis = Math.max(0, Math.round(seconds * 1000))
  const minutes = Math.floor(totalMillis / 60_000)
  const wholeSeconds = Math.floor((totalMillis % 60_000) / 1000)
  const millis = totalMillis % 1000
  return `At ${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
}

/** Clips a flow row's range into [0, duration] (spec §3). */
export function clipFlowRow(row: StructuredFlowRow, duration: number): { from: number; to: number } {
  const from = Math.min(Math.max(row.from, 0), duration)
  const to = Math.min(Math.max(row.to, 0), duration)
  return { from, to: Math.max(to, from) }
}

/** One subject card → its defining sentence (subjects are DEFINED before use,
 *  spec §4: cards render ahead of the scene/flow prose). */
export function subjectSentence(card: StructuredSubjectCard): string {
  const details = [card.appearance.trim(), card.wardrobe.trim() ? `wearing ${card.wardrobe.trim()}` : '', card.features.trim()].filter(Boolean)
  const name = card.name.trim()
  if (!details.length) return sentence([name])
  return name ? `${name}: ${sentence(details)}` : sentence(details)
}

// ---------------------------------------------------------------------------
// The concat contract (§4) — the load-bearing function
// ---------------------------------------------------------------------------

export type ComposeContext = {
  /** The job duration in seconds — flow ranges clip to it. */
  duration?: number
}

/**
 * Composes the structured draft into the prompt string the freeform surface
 * would submit. Grammar (golden-pinned, from the captured base guide):
 *
 *   integrated_multimodal_description: [Shot 1] {style}, {concept}.
 *     {subject sentences} {setting}. {lighting}. {camera}. {flow row 1}.
 *     [Shot 2] At 00:03.500, {flow row 2}. {dialogue lines}
 *
 *   overall_soundscape: {soundscape}
 *
 *   non_diegetic_music: {music | N/A}
 *
 * - The FIRST rendered flow row continues [Shot 1]; every later row opens its
 *   own "[Shot N] At MM:SS.mmm," cut (guide §4.2).
 * - Dialogue (guide §4.4) stays inside the description, after the flow; the
 *   soundscape never repeats it (guide §4.6).
 * - Empty boxes contribute NOTHING (spec §2) — an all-empty draft composes to
 *   '' and the soundscape/music fields only appear when their box has text
 *   (music alone absent → "N/A" only when the soundscape field is emitted,
 *   matching the guide's completed-prompt shape without inventing content).
 */
export function composeStructuredPrompt(draft: StructuredPromptDraft, context: ComposeContext = {}): string {
  const duration = context.duration
  // The opening of [Shot 1]: style leads, then the concept (guide §4.1 —
  // "[Shot 1] Live-action, cinematic, a medium-wide shot frames…").
  const opening = [draft.style.trim(), draft.concept.trim()].filter(Boolean).join(', ')
  const definitions = draft.subjects.map(subjectSentence).filter(Boolean)
  const scene = sentence([draft.setting])
  const light = sentence([draft.lighting])
  const camera = sentence([draft.camera])

  const renderedRows: Array<{ label: string; text: string }> = []
  let shotNumber = 1
  for (const row of draft.flow) {
    const text = row.text.trim()
    if (!text) continue
    if (shotNumber === 1) renderedRows.push({ label: '', text })
    else {
      const clipped = duration === undefined ? row.from : clipFlowRow(row, duration).from
      renderedRows.push({ label: `[Shot ${shotNumber}] ${flowCutLabel(clipped)}`, text })
    }
    shotNumber += 1
  }

  const dialogueLines = draft.audio.dialogue.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)

  const descriptionParts = [
    opening ? (TERMINAL.test(opening) ? opening : `${opening}.`) : '',
    ...definitions,
    scene,
    light,
    camera,
    ...renderedRows.map((row) => {
      const text = row.text.trim()
      if (!row.label) return TERMINAL.test(text) ? text : `${text}.`
      const labeled = `${row.label}, ${text}`
      return TERMINAL.test(text) ? labeled : `${labeled}.`
    }),
    ...dialogueLines,
  ].filter(Boolean)

  const sections: string[] = []
  // Guide §4.1: the description opens with "[Shot 1]" — the style-led opening
  // and the first rendered flow row both live inside that shot.
  if (descriptionParts.length) sections.push(`integrated_multimodal_description: [Shot 1] ${descriptionParts.join(' ')}`)
  const soundscape = draft.audio.soundscape.trim()
  if (soundscape) {
    sections.push(`overall_soundscape: ${soundscape}`)
    sections.push(`non_diegetic_music: ${draft.audio.music.trim() || 'N/A'}`)
  } else if (draft.audio.music.trim()) {
    sections.push(`non_diegetic_music: ${draft.audio.music.trim()}`)
  }
  return sections.join('\n\n')
}

// ---------------------------------------------------------------------------
// The deterministic round-trip parse (§4) — best-effort, NEVER lossy
// ---------------------------------------------------------------------------

/** The guide §4.1 style openers (plus the camera-preset style families) — a
 *  leading run of these (comma-joined) splits off into the Style box. */
const STYLE_OPENERS = ['live-action', 'cinematic', '2d-animated', '3d cg', 'claymation', 'watercolor', 'vintage film', 'photorealistic', 'documentary realism', 'commercial']
const STYLE_PREFIX = new RegExp(`^\\s*((?:${STYLE_OPENERS.join('|')})(?:\\s*,\\s*(?:${STYLE_OPENERS.join('|')}))*)\\s*,?\\s*`, 'i')
const DIALOGUE_SPAN = /<d>[\s\S]*?<\/d>/gi
// NON-CAPTURING on purpose: this pattern feeds String.split, where a capture
// group would leak the captured digits into the result array.
const SHOT_SPLIT = /\[Shot\s+\d+\]/gi
const CUT_TIME = /^At\s+(\d{1,2}):(\d{2})\.(\d{3})\s*,?\s*/i

/** Splits the leading style run off a prose opening ("" when absent). */
function splitStyleOpening(prose: string): { style: string; rest: string } {
  const match = prose.match(STYLE_PREFIX)
  if (!match) return { style: '', rest: prose }
  return { style: match[1].trim(), rest: prose.slice(match[0].length) }
}

/** Extracts one labeled field ("label:" at a line start, case-insensitive).
 *  Returns the field body, the remaining text, and whether the label was
 *  found at all. */
function extractField(text: string, field: string): { body: string; rest: string; found: boolean } {
  const pattern = new RegExp(`^\\s*${field}\\s*:\\s*`, 'im')
  const match = text.match(pattern)
  if (!match) return { body: '', rest: text, found: false }
  const after = text.slice(match.index! + match[0].length)
  // The field runs to the next labeled field (any of the three) or the end.
  const endMatch = after.match(/^\s*(integrated_multimodal_description|overall_soundscape|non_diegetic_music)\s*:/im)
  const body = endMatch ? after.slice(0, endMatch.index) : after
  const rest = `${text.slice(0, match.index)}${endMatch ? after.slice(endMatch.index) : ''}`
  return { body: body.trim(), rest: rest.replace(/^\s+|\s+$/g, ''), found: true }
}

/**
 * Parses a freeform prompt into boxes, best-effort and WITHOUT ANY LLM:
 * labeled fields split out; the description splits on [Shot N] markers with
 * "At MM:SS.mmm" cut times becoming flow-row `from`s; <d> spans lift into the
 * Audio box's dialogue; a leading style run splits into Style. EVERYTHING
 * unclassifiable lands in Concept — the parse NEVER drops text (AC 1's
 * no-loss guarantee is deterministic, never LLM-dependent). Subject cards and
 * the setting/lighting/camera split are the LLM distiller's job (reviewed
 * before adopting).
 */
export function parseStructuredPrompt(text: string): StructuredPromptDraft {
  const draft = emptyStructuredDraft()
  const source = text ?? ''
  if (!source.trim()) return draft

  const musicField = extractField(source, 'non_diegetic_music')
  const soundscapeField = extractField(musicField.rest, 'overall_soundscape')
  const descriptionField = extractField(soundscapeField.rest, 'integrated_multimodal_description')
  draft.audio.music = musicField.body === 'N/A' || musicField.body === 'n/a' ? '' : musicField.body
  draft.audio.soundscape = soundscapeField.body

  // Anything BEFORE the description label (e.g. an I2VA first-frame
  // instruction) is preserved verbatim in Concept — the parse never drops it.
  // With NO labeled fields at all, the whole text is the description body
  // (plain freeform prose).
  let body = descriptionField.found ? descriptionField.body : descriptionField.rest.trim()
  const preamble = descriptionField.found ? descriptionField.rest.trim() : ''
  const preambleSentences = preamble ? [preamble] : []

  // Dialogue lifts out of the body into the Audio box — as the guide writes
  // it: the speaker phrase + the <d> span form ONE dialogue line, so the
  // sentence containing the span lifts whole (never a dangling "says:").
  const dialogueSpans: Array<{ start: number; end: number; line: string }> = []
  let dialogueMatch: RegExpExecArray | null
  DIALOGUE_SPAN.lastIndex = 0
  while ((dialogueMatch = DIALOGUE_SPAN.exec(body)) !== null) {
    let sentenceStart = body.lastIndexOf('\n', dialogueMatch.index - 1) + 1
    for (let index = dialogueMatch.index - 1; index >= sentenceStart; index -= 1) {
      const character = body[index]
      if (character === '.' || character === '!' || character === '?') { sentenceStart = index + 1; break }
    }
    while (sentenceStart < dialogueMatch.index && /\s/.test(body[sentenceStart])) sentenceStart += 1
    const lead = body.slice(sentenceStart, dialogueMatch.index).trim()
    dialogueSpans.push({ start: sentenceStart, end: dialogueMatch.index + dialogueMatch[0].length, line: lead ? `${lead} ${dialogueMatch[0].trim()}` : dialogueMatch[0].trim() })
  }
  if (dialogueSpans.length) {
    for (let index = dialogueSpans.length - 1; index >= 0; index -= 1) {
      body = body.slice(0, dialogueSpans[index].start) + body.slice(dialogueSpans[index].end)
    }
    body = body.replace(/[ \t]+/g, ' ').replace(/ {2,}/g, ' ')
  }
  draft.audio.dialogue = dialogueSpans.map((span) => span.line).join('\n')

  // Split the body into [Shot N] segments; "At MM:SS.mmm" prefixes become
  // the later rows' from-times. Prose BEFORE the first marker reads as the
  // Concept; the first marker's content is the opening beat — its leading
  // style run splits into Style, the remainder is that beat's text.
  const segments = body.split(SHOT_SPLIT)
  const hasMarkers = segments.length > 1
  const preMarker = (segments[0] ?? '').trim()
  if (!hasMarkers) {
    const styleSplit = splitStyleOpening(preMarker)
    draft.style = styleSplit.style
    draft.concept = [...preambleSentences, styleSplit.rest.trim()].filter(Boolean).join(' ')
    return draft
  }
  draft.concept = [...preambleSentences, preMarker].filter(Boolean).join(' ')
  const styleSplit = splitStyleOpening((segments[1] ?? '').trim())
  draft.style = styleSplit.style
  if (styleSplit.rest) draft.flow.push({ id: structuredId('flow'), from: 0, to: 0, text: styleSplit.rest })
  for (let index = 2; index < segments.length; index += 1) {
    const raw = segments[index].trim()
    if (!raw) continue
    const cut = raw.match(CUT_TIME)
    const from = cut ? Number(cut[1]) * 60 + Number(cut[2]) + Number(`0.${cut[3]}`) : 0
    const rowText = (cut ? raw.slice(cut[0].length) : raw).trim()
    draft.flow.push({ id: structuredId('flow'), from, to: from, text: rowText })
  }
  return draft
}

/** Append-merge (library box-sets, spec AC 5): text boxes join with a blank
 *  line, cards/rows append. Never replaces — a merge can only ADD content. */
export function mergeStructuredDraft(current: StructuredPromptDraft, incoming: StructuredPromptDraft): StructuredPromptDraft {
  const joinText = (a: string, b: string) => [a.trim(), b.trim()].filter(Boolean).join('\n')
  return {
    concept: joinText(current.concept, incoming.concept),
    subjects: [...current.subjects, ...incoming.subjects],
    setting: joinText(current.setting, incoming.setting),
    lighting: joinText(current.lighting, incoming.lighting),
    style: joinText(current.style, incoming.style),
    camera: joinText(current.camera, incoming.camera),
    flow: [...current.flow, ...incoming.flow],
    audio: {
      soundscape: joinText(current.audio.soundscape, incoming.audio.soundscape),
      music: joinText(current.audio.music, incoming.audio.music),
      dialogue: joinText(current.audio.dialogue, incoming.audio.dialogue),
    },
  }
}

// ---------------------------------------------------------------------------
// Persistence guard
// ---------------------------------------------------------------------------

const str = (value: unknown) => (typeof value === 'string' ? value : '')
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/** Reads a persisted structured draft (chain settings are untrusted JSON):
 *  every field guarded; anything malformed reads as its empty default. Returns
 *  null when the value is not an object. */
export function readStructuredDraft(raw: unknown): StructuredPromptDraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const audio = (value.audio && typeof value.audio === 'object' && !Array.isArray(value.audio) ? value.audio : {}) as Record<string, unknown>
  const card = (entry: unknown): StructuredSubjectCard | null => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    const item = entry as Record<string, unknown>
    if (!str(item.name).trim() && !str(item.appearance).trim() && !str(item.wardrobe).trim() && !str(item.features).trim()) return null
    return {
      id: str(item.id) || structuredId('subject'),
      name: str(item.name), appearance: str(item.appearance), wardrobe: str(item.wardrobe), features: str(item.features),
      ...(str(item.pinnedAssetId) ? { pinnedAssetId: str(item.pinnedAssetId) } : {}),
      ...(item.pinnedIdentity === true ? { pinnedIdentity: true } : {}),
    }
  }
  const row = (entry: unknown): StructuredFlowRow | null => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    const item = entry as Record<string, unknown>
    if (!str(item.text).trim()) return null
    return { id: str(item.id) || structuredId('flow'), from: num(item.from), to: num(item.to), text: str(item.text) }
  }
  return {
    concept: str(value.concept),
    subjects: Array.isArray(value.subjects) ? value.subjects.map(card).filter((entry): entry is StructuredSubjectCard => entry !== null) : [],
    setting: str(value.setting),
    lighting: str(value.lighting),
    style: str(value.style),
    camera: str(value.camera),
    flow: Array.isArray(value.flow) ? value.flow.map(row).filter((entry): entry is StructuredFlowRow => entry !== null) : [],
    audio: { soundscape: str(audio.soundscape), music: str(audio.music), dialogue: str(audio.dialogue) },
  }
}

// ---------------------------------------------------------------------------
// Vocabulary chips (spec §2 — from the captured guides + the preset corpus)
// ---------------------------------------------------------------------------

/** The camera chips are the guide §4.3 motion-type table VERBATIM (the same
 *  move names the camera compiler plans around — docs/library/
 *  minimax-h3-prompt-guide-base.md §4.3); each inserts its natural-English
 *  prose form. Amplitude/speed modifiers append per the guide's dimensions. */
export const STRUCTURED_CHIPS: Record<'setting' | 'lighting' | 'style' | 'camera' | 'audio', Array<{ label: string; insertion: string }>> = {
  setting: [
    { label: 'city street', insertion: 'a busy city street' },
    { label: 'café', insertion: 'a small café' },
    { label: 'train carriage', insertion: 'a train carriage' },
    { label: 'coastal village', insertion: 'a quiet coastal village' },
    { label: 'forest clearing', insertion: 'a forest clearing' },
    { label: 'rooftop', insertion: 'a rooftop at height' },
    { label: 'workshop', insertion: 'a cluttered workshop' },
    { label: 'night market', insertion: 'a night market' },
    { label: 'era: near-future', insertion: 'a near-future era' },
    { label: 'era: 1970s', insertion: 'a 1970s period setting' },
  ],
  lighting: [
    { label: 'golden hour', insertion: 'warm golden-hour light' },
    { label: 'overcast', insertion: 'soft overcast daylight' },
    { label: 'neon dusk', insertion: 'neon light at dusk' },
    { label: 'moonlight', insertion: 'cool moonlight' },
    { label: 'candlelight', insertion: 'flickering candlelight' },
    { label: 'window daylight', insertion: 'soft window daylight' },
    { label: 'side light', insertion: 'dramatic side light' },
    { label: 'high key', insertion: 'high-key lighting' },
    { label: 'low key', insertion: 'low-key lighting with deep shadows' },
    { label: 'silhouette', insertion: 'backlit silhouette' },
  ],
  style: [
    { label: 'Live-action', insertion: 'Live-action' },
    { label: 'Cinematic', insertion: 'Cinematic' },
    { label: '2D-animated', insertion: '2D-animated' },
    { label: '3D CG', insertion: '3D CG' },
    { label: 'claymation', insertion: 'Claymation' },
    { label: 'watercolor', insertion: 'Watercolor' },
    { label: 'vintage film', insertion: 'Vintage film' },
  ],
  camera: [
    ...(['Static Shot', 'Push In', 'Pull Out', 'Zoom In', 'Zoom Out', 'Pan Left', 'Pan Right', 'Truck Left', 'Truck Right', 'Tilt Up', 'Tilt Down', 'Pedestal Up', 'Pedestal Down', 'Arc Shot', 'Tracking Shot', 'POV', 'Shake Slightly'] as const).map((move) => ({
      label: move,
      insertion: `the camera ${move === 'Static Shot' ? 'holds a static shot' : move === 'POV' ? 'frames the subject\'s point of view' : move === 'Shake Slightly' ? 'shakes slightly' : ({
        'Push In': 'pushes in', 'Pull Out': 'pulls out', 'Zoom In': 'zooms in', 'Zoom Out': 'zooms out',
        'Pan Left': 'pans left', 'Pan Right': 'pans right', 'Truck Left': 'trucks left', 'Truck Right': 'trucks right',
        'Tilt Up': 'tilts up', 'Tilt Down': 'tilts down', 'Pedestal Up': 'pedestals up', 'Pedestal Down': 'pedestals down',
        'Arc Shot': 'arcs around the subject', 'Tracking Shot': 'tracks the moving subject',
      } as Record<string, string>)[move]}`,
    })),
    { label: 'large amplitude', insertion: 'with large amplitude' },
    { label: 'small amplitude', insertion: 'with small amplitude' },
    { label: 'slow speed', insertion: 'at slow speed' },
    { label: 'fast speed', insertion: 'at fast speed' },
  ],
  audio: [
    { label: 'room tone', insertion: 'quiet room tone continues throughout' },
    { label: 'rain', insertion: 'steady rain taps on nearby surfaces' },
    { label: 'city ambience', insertion: 'distant traffic and city ambience' },
    { label: 'footsteps', insertion: 'footsteps synchronized to each visible step' },
    { label: 'sparse piano', insertion: 'sparse piano notes at a slow tempo' },
    { label: 'low strings', insertion: 'sustained low strings underneath' },
    { label: 'no music', insertion: 'N/A' },
  ],
}

// ---------------------------------------------------------------------------
// Flow-row warnings (the timeline-guides convention rides along)
// ---------------------------------------------------------------------------

/** The official frame math (workflow.ts convention): round(seconds × 24) —
 *  mirrored here so this module stays import-light for the VM harness. */
function frameIndexOf(seconds: number) {
  return Math.round(seconds * 24)
}

export function flowRowWarnings(rows: StructuredFlowRow[], duration: number): Array<{ rowId: string; warning: string }> {
  const warnings: Array<{ rowId: string; warning: string }> = []
  const total = Math.max(5, Math.round(duration * 24))
  let previousFrom: number | null = null
  for (const row of rows) {
    if (!row.text.trim()) continue
    const index = frameIndexOf(row.from)
    if (row.from < 0 || index >= total) warnings.push({ rowId: row.id, warning: `The ${row.from.toFixed(1)}s beat lands outside the ${duration}s clip — move it inside.` })
    if (row.to > duration) warnings.push({ rowId: row.id, warning: `The beat's ${row.to.toFixed(1)}s end is past the ${duration}s duration — it clips at ${duration}s.` })
    if (previousFrom !== null && row.from <= previousFrom) warnings.push({ rowId: row.id, warning: `This beat starts at ${row.from.toFixed(1)}s, not after the previous beat's ${previousFrom.toFixed(1)}s — cut times must strictly increase.` })
    previousFrom = row.from
  }
  return warnings
}

// ---------------------------------------------------------------------------
// The LLM contracts (per-box assist + the reviewed round-trip distill)
// ---------------------------------------------------------------------------

const BOX_GUIDE_VOCABULARY: Record<StructuredBoxId, string> = {
  concept: 'a single concrete sentence naming the idea and task type (t2v, i2v continuation, style piece) — no camera, no audio',
  subjects: 'one subject per card: name/role, appearance, wardrobe, distinctive features — identity anchors, never actions',
  setting: 'environment, location, era, atmosphere — depictable specifics only',
  lighting: 'light language per the guide: source, quality, direction, and how it shapes the subjects',
  style: 'the visual style / medium (Live-action, Cinematic, 2D-animated, 3D CG, claymation, watercolor, vintage film)',
  camera: 'camera motion as natural English: motion type + amplitude + speed (e.g. "the camera pushes in with small amplitude at slow speed")',
  flow: 'ordered beats with time ranges, each describing only what happens in its window',
  audio: 'ambience lines, audience-only music description, and dialogue in <d>[Language] …</d> formatting',
}

/** The [context] layer for a per-box assist request. */
export function buildBoxAssistContext(box: StructuredBoxId, context: { duration: number; mode: GenerationMode; noDialogue?: boolean }) {
  return [
    `You are refining ONE box of a structured MiniMax H3 video prompt: the ${box} box — it carries ${BOX_GUIDE_VOCABULARY[box]}.`,
    `Return ONLY the finished text for this box — no preamble, no quotes, no markdown, no repetition of other boxes' content.`,
    `Effective duration: ${context.duration} seconds. Effective generation route: ${context.mode}.`,
    context.noDialogue && box === 'audio' ? 'Audio constraint: no spoken dialogue, narration, voice-over, singing, or lip-sync — ambience only.' : '',
  ].filter(Boolean).join('\n\n')
}

/** The reviewed round-trip distill: instructions + JSON schema for
 *  llmGenerateStructured. The deterministic parse always runs first (no-loss
 *  without any model); the distill redistributes prose into the finer boxes
 *  and is ADOPTED only through explicit review. */
export function buildStructuredParseInstructions() {
  return [
    'Split the provided freeform MiniMax H3 video prompt into structured box fields.',
    'Subjects become cards (name, appearance, wardrobe, distinctive features). Flow becomes ordered rows with numeric from/to seconds inside the duration; a beat with no end is a moment (to equals from).',
    'Dialogue lines keep their exact <d>[Language] …</d> bytes in the dialogue field. Never invent, summarize, translate, or drop content — every fact in the prompt must survive in exactly one field.',
    'Return only the JSON object.',
  ].join('\n\n')
}

export const structuredParseSchema = {
  type: 'object',
  properties: {
    concept: { type: 'string' },
    subjects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          appearance: { type: 'string' },
          wardrobe: { type: 'string' },
          features: { type: 'string' },
        },
      },
    },
    setting: { type: 'string' },
    lighting: { type: 'string' },
    style: { type: 'string' },
    camera: { type: 'string' },
    flow: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'number' },
          to: { type: 'number' },
          text: { type: 'string' },
        },
      },
    },
    audio: {
      type: 'object',
      properties: {
        soundscape: { type: 'string' },
        music: { type: 'string' },
        dialogue: { type: 'string' },
      },
    },
  },
} as const

/** Wraps a bare line as guide-formatted dialogue (§4.4). */
export function wrapDialogueLine(line: string, language = 'English') {
  const trimmed = line.trim()
  if (!trimmed) return ''
  if (/^<d>[\s\S]*<\/d>$/i.test(trimmed)) return trimmed
  return `<d>[${language}] ${trimmed}</d>`
}

/** Appends a chip's insertion to a box's text: modifier insertions ("with
 *  large amplitude", "at slow speed") join with a space (they qualify the
 *  preceding phrase); vocabulary insertions join with ", ". */
export function appendChipText(current: string, insertion: string): string {
  const base = current.trim()
  if (!base) return insertion
  const glue = /^(with|at)\s/i.test(insertion) ? ' ' : ', '
  return `${base}${glue}${insertion}`
}

/** The Flow box's assist draft text: the timed-shot prose form the timeline
 *  tool emits (and parseStructuredPrompt splits back into rows). */
export function flowRowsToAssistText(rows: StructuredFlowRow[]): string {
  return rows
    .filter((row) => row.text.trim())
    .map((row, index) => (index === 0 ? row.text.trim() : `[Shot ${index + 1}] ${flowCutLabel(row.from)}, ${row.text.trim()}`))
    .join('\n')
}

/** The Subjects box's assist draft text: one line per card. */
export function subjectCardsToAssistText(cards: StructuredSubjectCard[]): string {
  return cards
    .map((card) => [card.name.trim(), card.appearance.trim(), card.wardrobe.trim(), card.features.trim()].filter(Boolean).join(': '))
    .filter(Boolean)
    .join('\n')
}

/** The reverse of subjectCardsToAssistText (assist adoption): one card per
 *  non-empty line; a leading "Name:" prefixes the name, the rest of the line
 *  reads as the appearance. */
export function subjectLinesToCards(lines: string): StructuredSubjectCard[] {
  return lines
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const split = line.match(/^([^:]{1,60}):\s*(.*)$/)
      return {
        id: structuredId('subject'),
        name: split ? split[1].trim() : '',
        appearance: split ? split[2].trim() : line,
        wardrobe: '',
        features: '',
      }
    })
}

/** Splits a timed-shot assist text (the timeline tool's output grammar —
 *  "[Shot N] At MM:SS.mmm, …") into flow rows. Leading prose before the
 *  first marker becomes the opening beat; with no markers each non-empty
 *  line is a beat from 0s. */
export function parseFlowRows(text: string): StructuredFlowRow[] {
  const marker = /\[Shot\s+\d+\]\s+(?:At\s+(\d{1,2}):(\d{2})\.(\d{3}))?\s*,?\s*/gi
  const matches: Array<{ index: number; end: number; from: number }> = []
  let match: RegExpExecArray | null
  while ((match = marker.exec(text)) !== null) {
    matches.push({ index: match.index, end: match.index + match[0].length, from: match[1] ? Number(match[1]) * 60 + Number(match[2]) + Number(`0.${match[3]}`) : 0 })
  }
  const rows: StructuredFlowRow[] = []
  if (!matches.length) {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed) rows.push({ id: structuredId('flow'), from: 0, to: 0, text: trimmed })
    }
    return rows
  }
  const leading = text.slice(0, matches[0].index).trim()
  if (leading) rows.push({ id: structuredId('flow'), from: 0, to: 0, text: leading })
  matches.forEach((current, index) => {
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length
    const rowText = text.slice(current.end, end).trim()
    if (rowText) rows.push({ id: structuredId('flow'), from: current.from, to: current.from, text: rowText })
  })
  return rows
}
