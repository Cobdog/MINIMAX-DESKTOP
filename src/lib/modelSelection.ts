import type { ModelFile, ModelKind, ModelSelection } from '../types'
import { dbg } from './dbg'
import { turboLoraPatterns } from './graph'

/** The registry lists engine-relative SUBPATHS ("H3/ssd/x.safetensors");
 *  the inference anchors speak family tokens that live in the FILENAME.
 *  Every ladder regex is therefore tested against the basename — the
 *  registry row's full name is returned verbatim (exactly what the graph
 *  loader accepts). (Wave 2 R-12: anchors re-targeted at registry subpaths.)
 *  Exported (sweep #1, 68e9k17): every registry-reading surface resolves
 *  files by basename through this ONE helper — the stack report included —
 *  so no surface can drift back to full-name compares. */
export function basenameOf(name: string) {
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

/** ---------------------------------------------------------------------------
 *  THE TE DIMENSION-CLASS GUARD (task eyzcev5 — a new class of the R-12
 *  invariant). The crash it kills is real, from the maintainer's 2026-09-22
 *  session: the loosened anchors above take "best available", and when only
 *  a 4B-class qwen3vl was visible the 'qwen3vl' fallback needle resolved it
 *  into an H3 graph whose token refiner demands the 32B-class — the render
 *  died 27 s in, at preprocess_text_embeds:
 *
 *    mat1 and mat2 shapes cannot be multiplied (171x2560 and 5120x5376)
 *
 *  2560 is the 4B's hidden width, 5120 the 32B's — the log is its own
 *  dimension evidence. The invariant: instance-invisible = nonexistent
 *  (R-12) gets a sibling — WRONG DIMENSION CLASS = UNUSABLE. A visible file
 *  the family cannot consume refuses at validate with the named reason;
 *  it never reroutes (a correct pick resolves exactly as before) and never
 *  submits-and-crashes at the engine.
 *
 *  WHY THE SEAM, NOT THE ENGINE-CONTRACT LAYER (assessed, task AC iuu9keq):
 *  engineContract.ts mirrors the engine's SCHEMA gate (validate_inputs) —
 *  and this failure class is schema-INVISIBLE: CLIPLoader's clip_name combo
 *  accepts any listed filename (the capture fixture carries both TE names
 *  as legal), and the mismatch surfaces only inside execution as a
 *  weight-shape error. object_info serves no tensor dimensions, so a
 *  contract-level check would need a dims oracle the engine does not
 *  provide — the family expectation is OURS. The seam check is therefore
 *  the only honest home, and the cheaper one.
 *
 *  Classification is by the FILENAME's own size token (the registry lists
 *  names only, exactly like the VAE decoder-class markers in
 *  modelOverrides.ts): '32b' → 5120-dim, '8b' → 4096, '4b' → 2560. A name
 *  with NO known token is UNCLASSIFIED — it applies, the engine stays the
 *  final arbiter (no false refusals on community renames). Evidence per
 *  class: the crash log above (2560 vs 5120) + the official model cards /
 *  template pairings (Qwen3-VL-32B hidden 5120; the klein 9B template's
 *  qwen_3_8b 4096; the klein 4B template's qwen_3_4b and the 4B qwen3vl
 *  2560) — read from the templates shipped in the canonical shared install
 *  (comfyui_workflow_templates_json, rev installed with v0.34-era), see
 *  docs/research/h3-te-dimension-classes.md.
 * ------------------------------------------------------------------------- */
export type TeDimClassId = '32b' | '8b' | '4b'

/** The classes the classifier can name — the filename token is the id. */
export const TE_DIM_CLASSES: Readonly<Record<TeDimClassId, { hiddenDim: number; label: string }>> = {
  '32b': { hiddenDim: 5120, label: 'the 32B-class (5120-dim) qwen3vl' },
  '8b': { hiddenDim: 4096, label: 'the 8B-class (4096-dim) Qwen3 companion' },
  '4b': { hiddenDim: 2560, label: 'the 4B-class (2560-dim) qwen3vl/Qwen3' },
}

/** The filename's own size-class token, basename truth (subpaths classify);
 *  null when the name carries no KNOWN token — unclassified, never guessed.
 *  Quant tokens do not false-match: 'int8'/'fp8' carry no digit-b pair. */
export function teDimClassOf(name: string): TeDimClassId | null {
  const match = /(\d{1,2}b)/i.exec(basenameOf(name))
  const token = match ? match[1]!.toLowerCase() : ''
  return token === '32b' || token === '8b' || token === '4b' ? token : null
}

/** One family's TE dimension-class expectation — family-registry data
 *  (task AC buzirkv), enforced at the resolution seam. `accepts` lists the
 *  classes the family can consume; `makeVisible` is the canonical artifact
 *  the refusal names (WHAT TO MAKE VISIBLE, per the root cause: the trap
 *  fires when the right one is invisible). */
export type TeDimClassExpectation = {
  familyLabel: string
  accepts: readonly TeDimClassId[]
  makeVisible: string
  evidence: string
}

/** The H3 stack's one TE expectation, shared by both override families
 *  (the video family and the image workbench run the same TE ladder). */
const H3_TE_EXPECTATION: TeDimClassExpectation = {
  familyLabel: 'the MiniMax H3 stack',
  accepts: ['32b'],
  makeVisible: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  evidence: "the maintainer's 2026-09-22 crash log (mat1 171x2560 × mat2 5120x5376 at preprocess_text_embeds — the token refiner consumes the 32B's 5120-dim hidden state) + the Qwen3-VL-32B model card",
}

/** Per-family TE dimension-class expectations. klein: the small-Qwen3
 *  companion class — its official templates pair 9B↔qwen_3_8b_fp8mixed
 *  (4096-dim; this repo's port) and 4B↔qwen_3_4b (2560-dim), so BOTH small
 *  classes are legal there and the 32B-class is the wrong-family pick in
 *  the reverse direction; within-small pairing precision (4B vs 8B) is the
 *  anchored ladder's + the engine's, not the name classifier's. music3 has
 *  NO row: its TE ladder is fully anchored (no substring fallback), so the
 *  loosened-anchor crash class cannot fire there — absence = inert. */
export const FAMILY_TE_DIM_CLASS: Readonly<Partial<Record<'minimax' | 'h3image' | 'klein' | string, TeDimClassExpectation>>> = {
  minimax: H3_TE_EXPECTATION,
  h3image: H3_TE_EXPECTATION,
  klein: {
    familyLabel: 'the klein refine engine',
    accepts: ['4b', '8b'],
    makeVisible: 'qwen_3_8b_fp8mixed.safetensors',
    evidence: 'the official ComfyUI klein templates read from the canonical shared install: image_flux2_klein_image_edit_9b_distilled pairs qwen_3_8b_fp8mixed (4096-dim), the 4b variant pairs qwen_3_4b (2560-dim)',
  },
}

/** The shared refusal (one message source for every enforcement point — the
 *  override seam, the video ladder's validate rung, and the workbench's
 *  detection): names the picked file, its class, the family's need, and the
 *  artifact to make visible. Null = proceed (no expectation for the family,
 *  no class token in the name, or the class is accepted). */
export function teDimClassRefusal(familyKey: string, fileName: string): string | null {
  const expectation = FAMILY_TE_DIM_CLASS[familyKey]
  if (!expectation || !fileName) return null
  const classId = teDimClassOf(fileName)
  if (!classId || expectation.accepts.includes(classId)) return null
  const picked = TE_DIM_CLASSES[classId]
  const needed = expectation.accepts.map((id) => TE_DIM_CLASSES[id].label).join(' or ')
  dbg('teclass', { verdict: 'refuse', family: familyKey, file: basenameOf(fileName), class: classId, accepts: expectation.accepts.join('|') })
  return `'${basenameOf(fileName)}' is a ${classId.toUpperCase()}-class text encoder (${picked.hiddenDim}-dim) — ${expectation.familyLabel} needs ${needed}, and a mismatched encoder crashes the render at the engine's text-embedding stage instead of failing cleanly. Make ${expectation.makeVisible} visible to the instance (or pick it for this family) instead.`
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
