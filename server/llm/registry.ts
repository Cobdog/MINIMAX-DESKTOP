/**
 * Model family registry — Jan-style JSON manifests shipped in the repo at
 * server/llm/families/*.json. A manifest describes one family's wire
 * behavior: sampling defaults, thinking representation (DeepSeek top-level
 * object vs Gemma chat_template_kwargs vs none), vision support and prompt
 * format, plus deployment notes. Adding a family later = one JSON file; no
 * code change.
 *
 * Unknown models infer their family from name patterns (deepseek → deepseek,
 * gemma → gemma, …) with a sensible `other` default.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logFailure } from '../logger'

export type ThinkingStyle = 'top-level' | 'chat-template-kwargs' | 'none'

export type FamilyManifest = {
  family: string
  displayName: string
  match: string[]
  sampling: { temperature?: number; top_p?: number; top_k?: number; maxTokens?: number }
  templateKwargs: Record<string, unknown>
  thinking: { style: ThinkingStyle; field: string; efforts: string[]; defaultEffort: string; reasoningField: string }
  thinkingBudgetTokens: number
  vision: { familyDefault: boolean; match: string[]; imageFirst: boolean; notation: string }
  notes: string
}

/** The embedded fallback used when the families directory cannot be read —
 *  the server must keep serving (family inference degrades to `other`) rather
 *  than crash on a missing file. */
const FALLBACK_MANIFESTS: FamilyManifest[] = [{
  family: 'other',
  displayName: 'Other',
  match: [],
  sampling: { temperature: 0.7, top_p: 0.95, maxTokens: 2048 },
  templateKwargs: {},
  thinking: { style: 'none', field: '', efforts: [], defaultEffort: '', reasoningField: '' },
  thinkingBudgetTokens: 0,
  vision: { familyDefault: false, match: ['vl', 'vision', 'image'], imageFirst: false, notation: 'OpenAI image_url parts.' },
  notes: 'Fallback manifest (the families directory was unreadable).',
}]

function isManifestShape(value: unknown): value is FamilyManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const manifest = value as Partial<FamilyManifest>
  return typeof manifest.family === 'string' && Boolean(manifest.family)
    && typeof manifest.displayName === 'string'
    && (!manifest.match || Array.isArray(manifest.match))
    && (!manifest.sampling || typeof manifest.sampling === 'object')
    && (!manifest.thinking || typeof manifest.thinking === 'object')
}

let cache: Map<string, FamilyManifest> | null = null

/** Loads every manifest in server/llm/families (memoized; family key →
 *  manifest). Malformed files are skipped with a logged reason — one bad
 *  JSON must not take the LLM layer down. */
export function loadFamilyManifests(): Map<string, FamilyManifest> {
  if (cache) return cache
  const loaded = new Map<string, FamilyManifest>()
  try {
    const directory = join(__dirname, 'families')
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.json')) continue
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(directory, name), 'utf8'))
        if (isManifestShape(parsed)) loaded.set(parsed.family, parsed)
        else logFailure('llm/registry/manifest', new Error(`${name} is not a family manifest`), undefined, 'warn')
      } catch (error) {
        logFailure('llm/registry/manifest', error, { file: name }, 'warn')
      }
    }
  } catch (error) {
    logFailure('llm/registry/dir', error, undefined, 'warn')
  }
  if (loaded.size === 0) for (const manifest of FALLBACK_MANIFESTS) loaded.set(manifest.family, manifest)
  if (!loaded.has('other')) loaded.set('other', FALLBACK_MANIFESTS[0])
  cache = loaded
  return loaded
}

/** Test hook: drops the memoized manifests so the next load re-reads disk. */
export function resetFamilyManifestCache() {
  cache = null
}

/** Infers a model's family from its name: the manifest whose match token
 *  appears in the (lowercased) model name wins — longest token first so
 *  'deepseek-vl' style compounds resolve deterministically. Unknown names
 *  fall back to `other`. */
export function inferFamily(modelName: string, manifests = loadFamilyManifests()): string {
  const name = modelName.toLowerCase()
  let bestFamily = 'other'
  let bestLength = -1
  for (const manifest of manifests.values()) {
    for (const token of manifest.match) {
      const lower = token.toLowerCase()
      if (lower && name.includes(lower) && lower.length > bestLength) {
        bestFamily = manifest.family
        bestLength = lower.length
      }
    }
  }
  return bestFamily
}

export function familyManifest(family: string, manifests = loadFamilyManifests()): FamilyManifest {
  return manifests.get(family) ?? manifests.get('other') ?? FALLBACK_MANIFESTS[0]
}

/** Vision capability: the router's input_modalities hint wins when present;
 *  otherwise the family default plus a vision-pattern name match decides. */
export function isVisionModel(modelName: string, family: string, routerHint?: boolean, manifests = loadFamilyManifests()): boolean {
  if (typeof routerHint === 'boolean') return routerHint
  const manifest = familyManifest(family, manifests)
  if (manifest.vision.familyDefault) return true
  const name = modelName.toLowerCase()
  return manifest.vision.match.some((token) => token && name.includes(token.toLowerCase()))
}

// ---- request assembly --------------------------------------------------------

export type CompletionParamsInput = { thinking: boolean; effort?: string; maxTokens?: number }

/** Builds the family-specific completion parameters for a request: sampling
 *  defaults from the manifest plus the family's thinking representation.
 *
 *  DeepSeek wire rules (from the maintainer's deepseek-harness): thinking is
 *  a TOP-LEVEL {type:'enabled'|'disabled'} object — the string 'off' is not a
 *  valid value — and reasoning_effort is one of low|high|max.
 *
 *  Gemma: thinking rides chat_template_kwargs.enable_thinking; when enabled,
 *  the thinking budget (2048) is ADDED to max_tokens. */
export function buildCompletionParams(manifest: FamilyManifest, input: CompletionParamsInput): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  if (typeof manifest.sampling.temperature === 'number') params.temperature = manifest.sampling.temperature
  if (typeof manifest.sampling.top_p === 'number') params.top_p = manifest.sampling.top_p
  if (typeof manifest.sampling.top_k === 'number') params.top_k = manifest.sampling.top_k
  params.max_tokens = (typeof input.maxTokens === 'number' && input.maxTokens > 0 ? input.maxTokens : manifest.sampling.maxTokens ?? 2048)
    + (input.thinking ? manifest.thinkingBudgetTokens : 0)
  if (manifest.thinking.style === 'top-level') {
    params.thinking = { type: input.thinking ? 'enabled' : 'disabled' }
    if (input.thinking) {
      const effort = input.effort && manifest.thinking.efforts.includes(input.effort) ? input.effort : manifest.thinking.defaultEffort
      if (effort) params.reasoning_effort = effort
    }
  } else if (manifest.thinking.style === 'chat-template-kwargs') {
    params.chat_template_kwargs = { ...manifest.templateKwargs, enable_thinking: input.thinking }
  } else if (Object.keys(manifest.templateKwargs).length > 0) {
    params.chat_template_kwargs = { ...manifest.templateKwargs }
  }
  return params
}

/** Gemma's canonical thinking-strip macro (chat template strip_thinking):
 *  split on the closer `<channel|>`; for each segment drop everything from
 *  the opener `<|channel>` onward; concatenate the rest. Safe when thinking
 *  is OFF — Gemma still emits an empty `<|channel>thought\n<channel|>` block.
 *  Non-Gemma content passes through unchanged. */
export function stripChannelMarkup(text: string): string {
  if (!text.includes('<channel|>')) return text
  let out = ''
  const parts = text.split('<channel|>')
  for (const part of parts) {
    const opener = part.indexOf('<|channel>')
    out += opener >= 0 ? part.slice(0, opener) : part
  }
  return out.trim()
}
