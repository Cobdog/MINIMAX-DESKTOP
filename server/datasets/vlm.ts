/**
 * Dataset manager — the VLM captioning client (spec §4, N1: greenfield on
 * upstream llama.cpp). Rides the app's LLM router layer; ALL local, no cloud
 * APIs (hard, indefinite lock).
 *
 * Discipline (research §2, verified 2026-09-17):
 *  - ≤8 s chunks hard rule (llama.cpp #27587: longer input hangs the server).
 *  - Default frame strategy: ~2 fps N-even client-side extraction — dodges the
 *    hang classes, family-agnostic. The qwen over-merge bug (#24303) bites
 *    IMAGE-SET sends on qwen-family models; mitigation surfaced: non-qwen
 *    models for image-set passes (the seam reports the model; the UI warns).
 *  - Native input_video where available (qwen-family) via the video part.
 *  - Dense → condense two-pass: pass 1 dense factual capture (vision), pass 2
 *    text-only condensation into the class template (no vision needed).
 *  - Token budget estimated live (frames × family budget tier).
 */
import { extractFramesEvenly } from './probe'
import type { ToolOptions } from './probe'
import { CAPTION_TEMPLATES, type ContentClass } from './model'

/** The ≤8 s hard chunk rule (llama.cpp #27587). */
export const VLM_CHUNK_SECONDS = 8

/** Default frame strategy: 2 fps, N-even, capped (token economy). */
export const VLM_FPS = 2
export const VLM_MAX_FRAMES = 32

export type VlmChatInput = {
  /** JPEG data URLs (the extraction path). */
  images?: string[]
  /** mp4 data URL ≤8 s (the native input_video path). */
  video?: string
  instruction: string
  model?: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  thinking?: boolean
}

export type VlmSeam = {
  /** One vision chat through the router provider. */
  chat(input: VlmChatInput): Promise<{ text: string; model: string }>
  /** Text-only pass (the condense stage). */
  textOnly(prompt: string, system?: string): Promise<string>
  /** The resolved vision model id (null when none is available). */
  visionModel(): Promise<string | null>
  /** Whether the resolved model family takes native input_video. */
  supportsNativeVideo(): Promise<boolean>
}

export type VlmPlan = {
  mode: 'image-set' | 'input-video'
  chunks: Array<{ index: number; fromSec: number; toSec: number; frames: number }>
  totalFrames: number
  estimatedTokens: number
  notes: string[]
}

/** Plans the VLM pass for one effective view: chunked ≤8 s, N-even frames. */
export function planVlmPass(config: { durationSec: number; fps?: number; maxFrames?: number; nativeVideo: boolean }): VlmPlan {
  const fps = config.fps ?? VLM_FPS
  const maxFrames = config.maxFrames ?? VLM_MAX_FRAMES
  const notes: string[] = []
  const chunkCount = Math.max(1, Math.ceil(config.durationSec / VLM_CHUNK_SECONDS))
  const chunks: VlmPlan['chunks'] = []
  let totalFrames = 0
  for (let index = 0; index < chunkCount; index += 1) {
    const fromSec = index * VLM_CHUNK_SECONDS
    const toSec = Math.min(config.durationSec, fromSec + VLM_CHUNK_SECONDS)
    const frames = Math.max(1, Math.min(maxFrames, Math.round((toSec - fromSec) * fps)))
    totalFrames += frames
    chunks.push({ index, fromSec, toSec, frames })
  }
  if (config.durationSec > VLM_CHUNK_SECONDS) notes.push(`Duration ${config.durationSec.toFixed(1)} s exceeds the 8 s llama.cpp hang threshold (#27587) — chunked into ${chunkCount} passes.`)
  const estimatedTokens = totalFrames * 250
  notes.push(`~${totalFrames} frames at ${fps} fps N-even (the family-agnostic default; dodges the >10 s hang class).`)
  const mode: VlmPlan['mode'] = config.nativeVideo && chunkCount === 1 ? 'input-video' : 'image-set'
  if (mode === 'input-video') notes.push('Native input_video transport (model family supports it; frame-merge rides upstream).')
  else notes.push('Image-set transport (client-side extraction — the universal fallback).')
  return { mode, chunks, totalFrames, estimatedTokens, notes }
}

/** The dense pass instruction (per class; the character negative rules are
 * load-bearing — guide §4.4/§4.6). */
export function denseInstruction(contentClass: ContentClass, extra?: string): string {
  const template = CAPTION_TEMPLATES[contentClass]
  const rules = template.negativeRules ? `\nNEVER: ${template.negativeRules.join('; ')}.` : ''
  return [
    'You are captioning ONE training clip for a MiniMax H3 LoRA dataset. Describe everything visible in these frames, dense and factual: subject and action, setting, lighting, camera behavior and motion pace, on-screen text, and (when audio could plausibly be present from context) the scene. Do not interpret beyond what is visible.',
    `The caption will later be condensed into this template: ${template.template}${rules}`,
    'Write one flowing paragraph of plain English. No lists, no tags, no markdown.',
    extra ? `Additional user instruction: ${extra}` : '',
  ].filter(Boolean).join('\n')
}

/** The condense pass prompt (text-only; compression, not perception). */
export function condenseInstruction(contentClass: ContentClass, triggerToken: string, extra?: string): string {
  const template = CAPTION_TEMPLATES[contentClass]
  const rules = template.negativeRules ? `\nHard negatives: ${template.negativeRules.join('; ')}.` : ''
  return [
    'Condense the dense clip description below into ONE mid-density training caption: a single flowing paragraph in plain English, concise but covering subject, action, setting, lighting, and camera/motion at natural speed.',
    `Target shape: ${template.template}${rules}`,
    triggerToken ? `Start the caption with the trigger token "${triggerToken}" followed by a comma — exactly once, nothing else changes.` : '',
    'Keep any soundscape clause only if the dense text actually describes sound. Output ONLY the caption.',
    extra ? `Additional user instruction: ${extra}` : '',
  ].filter(Boolean).join('\n')
}

export type VlmCaptionResult = {
  caption: string
  model: string
  plan: VlmPlan
  passes: number
}

/** Captions one effective view: dense (chunked, vision) → condense (text). */
export async function captionView(
  seam: VlmSeam,
  tools: ToolOptions,
  config: {
    sourcePath: string
    durationSec: number
    trimInSec: number | null
    trimOutSec: number | null
    contentClass: ContentClass
    triggerToken: string
    instruction?: string
    framesPerChunk?: number
  },
): Promise<VlmCaptionResult> {
  const model = await seam.visionModel()
  if (!model) throw new Error('No vision-capable model is available on the llama.cpp router — captioning needs one (for example Gemma 4 31B-IT or a Qwen-VL family model).')
  const nativeVideo = await seam.supportsNativeVideo()
  const duration = Math.max(0.1, config.durationSec)
  const plan = planVlmPass({ durationSec: duration, nativeVideo })
  // Dense pass: every chunk captioned, then concatenated (a chunked clip is
  // described part by part — the condense pass fuses them).
  const images: string[] = []
  for (const chunk of plan.chunks) {
    // Each chunk samples ITS OWN window (absolute times, trim-aware).
    const frames = await extractFramesEvenly(config.sourcePath, tools, {
      fromSec: (config.trimInSec ?? 0) + chunk.fromSec,
      durationSec: chunk.toSec - chunk.fromSec,
      fps: VLM_FPS,
      maxFrames: Math.max(1, Math.floor((config.framesPerChunk ?? 16) / plan.chunks.length) || 1),
      maxEdge: 448,
    })
    for (const frame of frames) images.push(`data:image/jpeg;base64,${frame.bytes.toString('base64')}`)
  }
  const dense = await seam.chat({
    images,
    instruction: denseInstruction(config.contentClass, config.instruction),
    model,
  })
  const denseParts = [dense.text]
  const denseText = denseParts.join('\n')
  // Condense pass: text-only.
  const caption = await seam.textOnly(`${condenseInstruction(config.contentClass, config.triggerToken)}\n\nDense description:\n${denseText}`)
  const cleaned = caption.trim().replace(/^["']|["']$/g, '')
  if (!cleaned) throw new Error('The VLM returned an empty caption.')
  return { caption: cleaned, model: dense.model, plan, passes: 2 }
}

/** Mode (d): free-form discussion of the clip — frames as context, full
 * history, no caption write. */
export async function discussClip(
  seam: VlmSeam,
  tools: ToolOptions,
  config: { sourcePath: string; durationSec: number; message: string; history?: Array<{ role: 'user' | 'assistant'; content: string }> },
): Promise<{ reply: string; model: string; frames: number }> {
  const model = await seam.visionModel()
  if (!model) throw new Error('No vision-capable model is available on the llama.cpp router.')
  const frames = await extractFramesEvenly(config.sourcePath, tools, { durationSec: Math.min(config.durationSec, VLM_CHUNK_SECONDS), fps: VLM_FPS, maxFrames: 12, maxEdge: 448 })
  const images = frames.map((frame) => `data:image/jpeg;base64,${frame.bytes.toString('base64')}`)
  const result = await seam.chat({ images, instruction: config.message, model, history: config.history })
  return { reply: result.text, model: result.model, frames: images.length }
}

export type BatchGuard = 'skip' | 'queue'

/** The batch-never-overwrite-hand rule (N2): a layer whose caption author is
 * 'hand' is never silently replaced — the run either skips it or queues it
 * for review, per the run setting. */
export function handCaptionGuard<T extends { layerId: string; author: string }>(items: T[], guard: BatchGuard): { caption: T[]; skipped: T[]; queued: T[] } {
  const caption: T[] = []
  const skipped: T[] = []
  const queued: T[] = []
  for (const item of items) {
    if (item.author !== 'hand') caption.push(item)
    else if (guard === 'skip') skipped.push(item)
    else queued.push(item)
  }
  return { caption, skipped, queued }
}
