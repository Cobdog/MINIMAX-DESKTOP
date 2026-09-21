import type { ModelFile, ModelKind, ModelSelection } from '../types'
import { dbg } from './dbg'
import { turboLoraPatterns } from './graph'

/** The registry lists engine-relative SUBPATHS ("H3/ssd/x.safetensors");
 *  the inference anchors speak family tokens that live in the FILENAME.
 *  Every ladder regex is therefore tested against the basename — the
 *  registry row's full name is returned verbatim (exactly what the graph
 *  loader accepts). (Wave 2 R-12: anchors re-targeted at registry subpaths.) */
function basenameOf(name: string) {
  const clean = name.replace(/\\/g, '/')
  const slash = clean.lastIndexOf('/')
  return slash === -1 ? clean : clean.slice(slash + 1)
}

/** Size-class preference tokens (Wave 2 R-12 — A-B3(c) folded): when several
 *  registry files match one ladder tier, the smaller-quant artifact wins —
 *  the official stacks and the GPU-tier guidance both anchor on these. The
 *  registry reports no byte sizes, so the class is read from the filename's
 *  own quant/quality tokens: earlier entries score higher, a hit is a
 *  case-insensitive substring of the basename. */
const SIZE_CLASS_PREFER = ['pruned', 'int8', 'convrot', 'nvfp4', 'awq', 'comfyui', 'ema', 'bf16', 'fp16', 'fp32']

function sizeClassScore(candidate: string) {
  let score = 0
  for (let index = 0; index < SIZE_CLASS_PREFER.length; index += 1) {
    if (candidate.toLowerCase().includes(SIZE_CLASS_PREFER[index]!)) score += SIZE_CLASS_PREFER.length - index
  }
  return score
}

/** Best-of tier: higher size-class score, then the SHORTER basename (fewer
 *  extraneous tokens = closer to the official artifact), then alphabetical
 *  for determinism. */
function bestOfTier(files: ModelFile[]) {
  return [...files].sort((a, b) => {
    const baseA = basenameOf(a.name)
    const baseB = basenameOf(b.name)
    const score = sizeClassScore(baseB) - sizeClassScore(baseA)
    if (score !== 0) return score
    const length = baseA.length - baseB.length
    if (length !== 0) return length
    return baseA.localeCompare(baseB)
  })[0]
}

/** One slot's inference over the registry listing: the ordered regex ladder
 *  (first tier WITH a match wins — the registry's own ranking), each tier
 *  tested against the basename and ranked within by size class. When no
 *  tier matches and a fallback NEEDLE is given, any registry file whose
 *  basename contains the needle is a candidate (the loosened anchor: a
 *  renamed quant, community repack, or subpathed file still auto-resolves);
 *  the same ranking picks among them. Empty string when nothing resolves.
 *
 *  Exported as THE family inference engine (Wave 2): the video ladder here,
 *  the workbench's inferH3ImgSelection, and the audio engines' ladders all
 *  resolve registry rows through this one function — no drifted copies. */
export function findRegistryModel(files: ModelFile[], kind: ModelKind, expressions: RegExp | RegExp[], fallbackNeedle?: string) {
  const candidates = files.filter((file) => file.kind === kind)
  for (const expression of Array.isArray(expressions) ? expressions : [expressions]) {
    const matches = candidates.filter((file) => expression.test(basenameOf(file.name)))
    if (matches.length) {
      const picked = bestOfTier(matches).name
      dbg('inventory.infer', { kind, picked, tier: String(expression), of: candidates.length })
      return picked
    }
  }
  if (fallbackNeedle) {
    const needle = fallbackNeedle.toLowerCase()
    const matches = candidates.filter((file) => basenameOf(file.name).toLowerCase().includes(needle))
    if (matches.length) {
      const picked = bestOfTier(matches).name
      dbg('inventory.infer', { kind, picked, tier: `fallback:${fallbackNeedle}`, of: candidates.length })
      return picked
    }
  }
  dbg('inventory.infer', { kind, picked: '', tier: 'none', of: candidates.length })
  return ''
}

function findModel(files: ModelFile[], kind: ModelKind, expressions: RegExp | RegExp[], fallbackNeedle?: string) {
  return findRegistryModel(files, kind, expressions, fallbackNeedle)
}

export function inferSelections(files: ModelFile[], turbo: 'off' | '4' | '8', family?: string): ModelSelection {
  const find = (kind: ModelKind, expressions: RegExp | RegExp[], fallbackNeedle?: string) => findModel(files, kind, expressions, fallbackNeedle)
  return {
    fl2va: find('diffusion_models', [/^minimax_h3_fl2va_pruned_int8_convrot\.safetensors$/i, /^minimax_h3_fl2va.*\.safetensors$/i], 'fl2va'),
    ref2va: find('diffusion_models', [/^minimax_h3_ref2va_pruned_int8_convrot\.safetensors$/i, /^minimax_h3_ref2va.*\.safetensors$/i], 'ref2va'),
    textEncoder: find('text_encoders', [/^qwen3vl_32b_minimax_h3_nvfp4_awq\.safetensors$/i, /^qwen3vl_32b_minimax_h3.*\.safetensors$/i], 'qwen3vl'),
    videoVae: find('vae', [/^minimax_h3_video_vae_fp16\.safetensors$/i, /^minimax_h3_video_vae.*\.safetensors$/i], 'video_vae'),
    audioVae: find('vae', [/^minimax_h3_audio_vae_fp32\.safetensors$/i, /^minimax_h3_audio_vae.*\.safetensors$/i], 'audio_vae'),
    // The H3 preview TAE ships under two names: Kijai's original
    // vae_approx/taeh3.safetensors (the fetchable catalog entry) and the
    // preview-override pack's taeh3_decoder.safetensors. The engine's native
    // previewer matches any vae_approx file starting with "taeh3" — this
    // selection feeds the graph-side override node, so both names resolve
    // (the explicit decoder name stays preferred).
    previewVae: find('vae_approx', [/^taeh3_decoder\.safetensors$/i, /^taeh3\.safetensors$/i], 'taeh3'),
    // Turbo inference is family-ranked through the optimization registry:
    // official weights first, then lightx2v newest-first, with an explicit
    // family choice (registry entry id) constraining the patterns to it.
    // The registry owns these patterns — deliberately NO substring fallback
    // here (a wrong-tier turbo pick is worse than none; the escape hatch is
    // the explicit family pick or an override).
    fl2vLora: find('loras', turboLoraPatterns('fl2v', turbo, family)),
    // Reference mode: the official 4-step LoRA (ComfyUI's template pair), or
    // the 8-step fast tier when 8-step reference mode is requested — ranked
    // larryvrh v4_step600_ema first per the 2026-09-15 bake-off (task
    // muwufpp), lightx2v Ref2VA 8-step as the measured runner-up.
    ref2vLora: find('loras', turboLoraPatterns('ref2v', turbo, family)),
  }
}
