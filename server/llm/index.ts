/**
 * The LLM service — provider selection, the unified assistant pipeline
 * (composer → provider), vision captioning, VRAM unload choreography, and
 * user-editable fragment persistence. server/core.ts routes call into this;
 * nothing here touches HTTP directly.
 *
 * Provider selection: settings.llamaCppUrl (llama.cpp router mode) is the
 * primary; an EMPTY/unset URL falls back to legacy Ollama, preserving the
 * pre-LLM-layer behavior exactly. A configured router URL that fails the
 * local-service (SSRF) guard is rejected — never silently used.
 */
import type { AppSettings, EnginePhase } from '../../src/types'
import type { StudioRepository } from '../repo'
import { applyFragmentOverrides, composeAssistantPrompt } from './composer'
import { SEED_FRAGMENT_ROWS, type FragmentRow } from './fragments'
import { createOllamaProvider } from './providers/ollama'
import { createRouterProvider } from './providers/router'
import { buildCompletionParams, familyManifest, inferFamily } from './registry'
import type { LlmMessage, LlmProvider } from './types'

const FRAGMENT_KV_NAME = 'llm-fragments'
const UNLOAD_MAX_WAIT_MS = 2_000

export type LlmHistoryTurn = { role: 'user' | 'assistant'; content: string; reasoning?: string }

export type LlmGenerateParams = {
  task?: string
  targetEngine?: string
  length?: string
  contentLevel?: string
  instructions?: string
  draft?: string
  /** Legacy raw prompt (no composer) — pre-provider callers. */
  prompt?: string
  history?: LlmHistoryTurn[]
  schema?: Record<string, unknown>
  thinking?: boolean
  model?: string
  /** Send the draft verbatim as the user message — no composer layers
   *  (callers whose instruction text is complete, e.g. Movie Planner's
   *  story/rules assistants). */
  raw?: boolean
}

export type LlmServiceOptions = {
  loadSettings(): Promise<AppSettings>
  repo(): StudioRepository | null
  isLocalServiceUrl(candidate: string): boolean
  logEvent(event: { kind: string; [key: string]: unknown }): void
  logFailure(stage: string, error: unknown, context?: Record<string, string | number | boolean>, level?: 'debug' | 'warn' | 'error'): void
  emitEngine(name: string, phase: EnginePhase, detail?: string, pid?: number): void
}

const SCHEMA_CONTRACT = 'Return ONLY a valid JSON object matching the schema in the request — no prose, no Markdown fence, no commentary.'

const DEFAULT_CAPTION_INSTRUCTION = 'Describe this image concretely for an AI image prompt: subject and pose, composition, environment, lighting, materials, palette, and style. One paragraph of plain descriptive text, no preamble.'

function stickyPatterns(settings: AppSettings): string[] {
  return settings.llamaStickyModels.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean)
}

export function createLlmService(options: LlmServiceOptions) {
  /** Resolves the ACTIVE provider + its endpoint from settings. Router wins
   *  when configured AND local; an empty URL is the Ollama fallback. */
  function activeProvider(settings: AppSettings): { provider: LlmProvider; error?: string } {
    const routerUrl = settings.llamaCppUrl.trim()
    if (routerUrl) {
      if (!options.isLocalServiceUrl(routerUrl)) {
        return { provider: createOllamaProvider({ baseUrl: settings.ollamaUrl }), error: 'The llama.cpp router address must be a local service address (loopback or private LAN).' }
      }
      return { provider: createRouterProvider({ baseUrl: routerUrl, logFailure: options.logFailure }) }
    }
    return { provider: createOllamaProvider({ baseUrl: settings.ollamaUrl }) }
  }

  function fragmentRows(): FragmentRow[] {
    const repo = options.repo()
    if (!repo) return SEED_FRAGMENT_ROWS
    try {
      const stored = repo.getWorkspace(FRAGMENT_KV_NAME)
      const overrides = stored && typeof stored.overrides === 'object' && stored.overrides && !Array.isArray(stored.overrides) ? stored.overrides as Record<string, unknown> : {}
      const clean: Record<string, string> = {}
      for (const key of Object.keys(overrides)) {
        if (typeof overrides[key] === 'string' && overrides[key]) clean[key] = overrides[key] as string
      }
      return applyFragmentOverrides(SEED_FRAGMENT_ROWS, clean)
    } catch (error) {
      options.logFailure('llm/fragments/load', error, undefined, 'debug')
      return SEED_FRAGMENT_ROWS
    }
  }

  /** The active chat model id: explicit setting first, else the provider's
   *  first listed model. Empty string = nothing available. */
  async function resolveActiveModel(provider: LlmProvider, settings: AppSettings): Promise<string> {
    if (provider.kind === 'router') {
      if (settings.llamaCppModel.trim()) return settings.llamaCppModel.trim()
      const models = await provider.listModels().catch(() => [])
      return models[0]?.id ?? ''
    }
    return settings.ollamaModel.trim()
  }

  /** Composes the system+user messages for an assistant request through the
   *  layered composer. Falls back to the raw legacy prompt when no task is
   *  given (pre-provider callers keep working untouched). */
  function buildMessages(params: LlmGenerateParams, settings: AppSettings, modelFamily: string) {
    if (params.raw) {
      return { legacy: true as const, messages: [{ role: 'user' as const, content: (params.draft ?? params.prompt ?? '').trim() }] }
    }
    if (!params.task && !params.draft && params.prompt) {
      return { legacy: true as const, messages: [{ role: 'user' as const, content: params.prompt.trim() }] }
    }
    const composed = composeAssistantPrompt(fragmentRows(), {
      task: params.task ?? 'refine',
      targetFamily: params.targetEngine ?? 'generic',
      contentLevel: params.contentLevel ?? settings.promptContentLevel ?? 'sfw',
      length: params.length ?? 'standard',
      llmFamily: modelFamily,
      instructions: [params.instructions?.trim(), params.schema ? SCHEMA_CONTRACT : ''].filter(Boolean).join('\n'),
      userDraft: params.draft ?? params.prompt ?? '',
    })
    const messages: LlmMessage[] = [{ role: 'system', content: composed.system }]
    for (const turn of params.history ?? []) {
      const message: LlmMessage = { role: turn.role, content: turn.content }
      // DeepSeek passback: keep prior reasoning on assistant turns.
      if (turn.role === 'assistant' && turn.reasoning) message.reasoning_content = turn.reasoning
      messages.push(message)
    }
    messages.push({ role: 'user', content: composed.user })
    return { legacy: false as const, messages }
  }

  /** Structured/JSON tasks default thinking OFF for speed; freeform respects
   *  the user's thinking-default setting unless the request overrides. */
  function thinkingFor(params: LlmGenerateParams, settings: AppSettings): boolean {
    if (typeof params.thinking === 'boolean') return params.thinking
    if (params.schema) return false
    return settings.llmThinkingDefault === 'on'
  }

  async function generate(params: LlmGenerateParams): Promise<{ response?: string; result?: unknown; reasoning?: string; model: string; provider: 'router' | 'ollama' }> {
    const settings = await options.loadSettings()
    const { provider, error } = activeProvider(settings)
    if (error) throw new Error(error)
    const model = params.model?.trim() || await resolveActiveModel(provider, settings)
    if (!model) throw new Error(provider.kind === 'router' ? 'No llama.cpp router model is available. Start the router or choose a model in Settings.' : 'No local Ollama model is configured. Choose one in Settings.')
    const family = inferFamily(model)
    const manifest = familyManifest(family)
    const { messages, legacy } = buildMessages(params, settings, family)
    const result = await provider.chat({
      model,
      messages,
      manifest,
      thinking: legacy ? false : thinkingFor(params, settings),
      ...(params.schema && provider.kind === 'ollama' ? { format: params.schema } : {}),
    })
    if (params.schema) {
      let parsed: unknown
      try {
        parsed = JSON.parse(result.content)
      } catch {
        throw new Error('The local model returned a response that was not valid JSON.')
      }
      return { result: parsed, reasoning: result.reasoning, model, provider: provider.kind }
    }
    if (!result.content.trim()) throw new Error('The local model returned an empty response.')
    return { response: result.content, reasoning: result.reasoning, model, provider: provider.kind }
  }

  /** Prepares a fabric-ready streaming request (router provider only — the
   *  fabric's llm channel is OpenAI-compatible SSE; Ollama callers use the
   *  non-streaming generate route). */
  async function prepare(params: LlmGenerateParams): Promise<{ endpoint: string; model: string; messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> {
    const settings = await options.loadSettings()
    const { provider, error } = activeProvider(settings)
    if (error) throw new Error(error)
    if (provider.kind !== 'router') throw new Error('Token streaming requires the llama.cpp router provider. Configure the router address in Settings (Ollama falls back to non-streaming).')
    const model = params.model?.trim() || await resolveActiveModel(provider, settings)
    if (!model) throw new Error('No llama.cpp router model is available. Start the router or choose a model in Settings.')
    const family = inferFamily(model)
    const { messages } = buildMessages(params, settings, family)
    // The fabric validates string content only — flatten any part arrays
    // (prepare never carries images) and cap history defensively.
    const flat = messages.map((message) => ({ role: message.role, content: typeof message.content === 'string' ? message.content : message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n') }))
    return {
      endpoint: provider.endpoint,
      model,
      messages: flat,
      options: buildCompletionParams(familyManifest(family), { thinking: thinkingFor(params, settings) }),
    }
  }

  /** Captions one image (base64 data URL) with the active vision-capable
   *  model. Gemma orders the image part FIRST (model-card best practice);
   *  other families get text first. */
  async function captionImage(request: { image: string; instruction?: string; model?: string }): Promise<{ caption: string; model: string }> {
    const settings = await options.loadSettings()
    const { provider, error } = activeProvider(settings)
    if (error) throw new Error(error)
    if (provider.kind !== 'router') throw new Error('Vision captioning requires the llama.cpp router provider with a vision-capable model (for example Gemma 4 31B-IT).')
    let model = request.model?.trim() || settings.llamaVisionModel.trim()
    if (!model) {
      const active = await resolveActiveModel(provider, settings)
      const models = await provider.listModels().catch(() => [])
      const activeEntry = models.find((entry) => entry.id === active)
      if (activeEntry?.vision) model = activeEntry.id
      else model = models.find((entry) => entry.vision)?.id ?? ''
    }
    if (!model) throw new Error('No vision-capable model is available on the llama.cpp router.')
    const manifest = familyManifest(inferFamily(model))
    const imagePart = { type: 'image_url' as const, image_url: { url: request.image } }
    const textPart = { type: 'text' as const, text: request.instruction?.trim() || DEFAULT_CAPTION_INSTRUCTION }
    const result = await provider.chat({
      model,
      messages: [{ role: 'user', content: manifest.vision.imageFirst ? [imagePart, textPart] : [textPart, imagePart] }],
      manifest,
      thinking: false,
      maxTokens: 640,
    })
    if (!result.content.trim()) throw new Error('The vision model returned an empty caption.')
    return { caption: result.content.trim(), model }
  }

  /** VRAM hygiene: unload the router's loaded, non-sticky models before a
   *  generation submits. Fire-and-forget with a hard ~2 s budget so it never
   *  blocks submission; observable on the engine channel + a log line. */
  async function unloadBeforeGeneration(): Promise<{ unloaded: string[]; skipped: string[]; reason?: string }> {
    const settings = await options.loadSettings()
    if (settings.unloadLlmOnGenerate === false) return { unloaded: [], skipped: [], reason: 'disabled' }
    const { provider } = activeProvider(settings)
    if (provider.kind !== 'router') return { unloaded: [], skipped: [], reason: 'not-router' }
    const sticky = stickyPatterns(settings)
    const loaded = (await provider.listModels().catch((error: unknown) => {
      options.logFailure('llm/unload/list', error, undefined, 'debug')
      return []
    })).filter((entry) => entry.status === 'loaded' && !sticky.some((pattern) => entry.id.toLowerCase().includes(pattern)))
    if (loaded.length === 0) return { unloaded: [], skipped: [] }
    const names = loaded.map((entry) => entry.id).join(', ')
    options.logEvent({ kind: 'llm.unload', models: names })
    options.emitEngine('llm-router', 'stopping', `unloading ${names}`)
    const unload = provider.unload(loaded.map((entry) => entry.id))
    const timeout = new Promise<{ unloaded: string[]; skipped: string[] }>((resolve) => setTimeout(() => resolve({ unloaded: [], skipped: loaded.map((entry) => entry.id) }), UNLOAD_MAX_WAIT_MS))
    const settled = await Promise.race([unload, timeout])
    options.emitEngine('llm-router', 'stopped', settled.unloaded.length ? `unloaded ${settled.unloaded.join(', ')}` : `unload still in flight for ${names}`)
    return settled
  }

  function listFragments(): { fragments: FragmentRow[] } {
    return { fragments: fragmentRows() }
  }

  function saveFragmentOverride(id: string, content: string): { saved: boolean } {
    const repo = options.repo()
    if (!repo) throw new Error('The studio database is unavailable; fragment edits cannot be saved.')
    const stored = repo.getWorkspace(FRAGMENT_KV_NAME) ?? {}
    const overrides = stored && typeof stored.overrides === 'object' && stored.overrides && !Array.isArray(stored.overrides) ? { ...(stored.overrides as Record<string, unknown>) } : {}
    if (content.trim()) overrides[id] = content
    else delete overrides[id]
    repo.saveWorkspace({ ...stored, overrides }, FRAGMENT_KV_NAME)
    return { saved: true }
  }

  return {
    activeProvider,
    resolveActiveModel,
    generate,
    prepare,
    captionImage,
    unloadBeforeGeneration,
    listFragments,
    saveFragmentOverride,
  }
}

export type LlmService = ReturnType<typeof createLlmService>
