/** H3 image workbench graph families (task k9vu6t0, spec
 * docs/specs/image-workbench-v1.md r2) — the image surface of the studio on
 * MiniMax H3: generate (frame-packet + T=1 Fast), compose (9 ordered refs),
 * the six edit families, refine engines (Krea 2 / klein), the burst lane
 * (app-side fuse + the E-IW2-gated SeedVR2 arm), and the start-frame exit.
 *
 * Built in the KREA2_EDIT_FAMILIES style (a sibling family registry —
 * n1 of the spec audit: NOT optimization-registry transforms): a family is
 * data — id, recipe pins, dials, detect(), ui guidance — and every builder is
 * a deterministic pure function over plain JSON graphs. Two contracts carry
 * over:
 *
 *  1. DETERMINISM — graphs serialize canonically (stable string ids, one
 *     node per id, inputs in declared order) so golden snapshots are the
 *     build contract (scripts/fixtures/h3img-golden.json).
 *  2. THE MAMAD8 FACTORY GUARD (spec AC8, enforced not documented): the T=1
 *     image VAE materially regresses multi-frame video decode (patch-grid
 *     ghosting, cross-frame mixing — Mamad8's own card). It is legal ONLY
 *     in single-frame graphs; any video-frame-count graph referencing it is
 *     a factory validation error (assertNoT1ImageVaeInVideoGraph, wired
 *     into buildMiniMaxWorkflow AND h3imgGraphAudit).
 *
 * Research pins: docs/research/h3-image-workbench.md (+ its §7.2 family
 * list), h3-instruction-based-editing.md §4 (the two paths, the T=1 recipe),
 * burst-frame-enhancement.md (the fuse lane, 4n+1), krea2-edit-mode.md (the
 * refine default), the official ComfyUI klein image-edit template (rev
 * installed with ComfyUI 0.34-era — template-faithful port), and the
 * scottmudge MiniMaxH3HybridLoader node read from the canonical shared
 * install (block_range_adaln 25..49 = the b25-49 hybrid).
 */
import type { ObjectInfo } from '../comfyInfo'
import type { ModelFile } from '../../types'
import type { Krea2ModelSelection } from './krea2edit'
import { buildKrea2Graph, findKrea2EditFamily } from './krea2edit'

// ---------------------------------------------------------------------------
// Node-id policy (stable contract — the image graphs' own table)
// ---------------------------------------------------------------------------

/** Canonical node ids for the H3 image families. The H3 still pipeline
 * occupies 1-16 (mirroring the video factory's blocks so the two read the
 * same); refs at 30x (loader per slot); per-frame publish pairs at 70x
 * (ImageFromBatch) / 71x (SaveImage), index-suffixed; the klein refine port
 * uses its own 1-13 base (it is a different engine's graph entirely). */
export const H3IMG = {
  unet: '1',
  clip: '2',
  videoVae: '3',
  audioVae: '4',
  lora1: '5',
  lora2: '6',
  sigmaShift: '7',
  formAdapter: '8',
  conditioning: '10',
  noise: '11',
  guider: '12',
  samplerSelect: '13',
  scheduler: '14',
  sampler: '15',
  decode: '16',
  firstFrameLoader: '20',
  refImageLoaderPrefix: '30',
  frameSelectPrefix: '70',
  frameSavePrefix: '71',
  // klein refine port (official image_flux2_klein_image_edit_9b_distilled)
  klein: {
    unet: '1',
    clip: '2',
    vae: '3',
    positive: '4',
    negative: '5',
    sampler: '6',
    latent: '7',
    noise: '8',
    guider: '9',
    samplerSelect: '10',
    scheduler: '11',
    decode: '12',
    save: '13',
    sourceLoader: '20',
    scale: '30',
    size: '31',
    encode: '32',
    refLatentPositive: '33',
    refLatentNegative: '34',
  },
} as const

/** Node classes the hybrid runtime-merge profile needs (scottmudge
 * ComfyUI_MinimaxH3HybridLoader, Apache-2.0, present on the canonical shared
 * install at a44c69b). block_range_adaln 25..49 overlays ref2va's per-block
 * adaln_proj onto fl2va — the b25-49 hybrid — merged AT LOAD (one mmap per
 * checkpoint, no duplicated multi-GB file). */
export const HYBRID_LOADER_NODE = 'MiniMaxH3HybridLoader' as const

/** Our first-party form-adapter pack's loader class (custom-nodes/
 * minimax-lora-form-adapter, MIT): projects full-width adaln LoRAs onto
 * pruned bases at load time. Always FIRST in a family's LoRA chain
 * (cross-form safety, spec §6). */
export const FORM_ADAPTER_NODE = 'MiniMaxH3LoraFormLoader' as const

// ---------------------------------------------------------------------------
// Research-pinned recipe constants (the single source — tests enforce these)
// ---------------------------------------------------------------------------

/** Every number here is pinned by the spec + its research inputs. Change one
 * only with a research-doc/spec change; the pinned-defaults test in
 * scripts/test-h3img.cjs makes silent drift impossible. */
export const H3IMG_RECIPE_PINS = {
  /** Packet tiers (spec §1: anchored 5/9/13 + directed 39). All on the
   * 4n+1 latent grid; 39 additionally sits on H3's official 17n+5 grid. */
  packetTiers: [5, 9, 13, 39] as const,
  /** The directed profile's near-still tail — the scorer's preferred frames
   * (ethanfel's "change complete by 65% of the sequence and held perfectly
   * still; score frames 34-38"). */
  directedTail: { first: 34, last: 38 } as const,
  /** T=1 Fast recipe (astropuzzo's shipped stack, verbatim): hybrid b25-49,
   * Mamad8 T=1 VAE, FL2VA turbo 8-step @0.75, detail adapter @0.5,
   * er_sde / sgm_uniform, 8 steps, sigma shifts 12/3. */
  t1: {
    frames: 1,
    steps: 8,
    sampler: 'er_sde',
    scheduler: 'sgm_uniform',
    turboStrength: 0.75,
    detailAdapterStrength: 0.5,
    shiftVideo: 12,
    shiftAudio: 3,
  },
  /** Packet default operating point on the hybrid profile: the official
   * sampler pair, full steps (turbo is the T=1 lane's acceleration). */
  packet: { sampler: 'res_multistep', scheduler: 'simple', steps: 20 },
  /** The hybrid overlay window (b25-49). */
  hybrid: { preset: 'block_range_adaln', blockStart: 25, blockEnd: 49 },
  /** The Keep dial (source_fidelity semantics, spec §5): 0.50-0.60 is the
   * documented start band for large pose/composition moves. */
  keepDial: { min: 0, max: 1, largeMoveBand: [0.5, 0.6] as const },
  /** LoRA stacking guidance (spec §6 — guidance, not enforcement). */
  lora: { slots: 2, healthyCombinedMax: 0.9, collapseRisk: 1.05 },
  /** Reference budget (spec §3): 9 native REF2VA slots, hard cap in v1. */
  refs: { max: 9 },
  /** Canvas contract: 32-px grid (H3 resolution rule). */
  canvasGrid: 32,
  /** SeedVR2 batch contract: 4n+1 frames. H3 tiers 5/9/13 map directly;
   * 20/39 TRIM HEAD-SIDE to 17/37 (drift is front-loaded — the settle and
   * the edit motion live at the head, the near-still tail the fuse feeds on
   * must survive the trim; burst research §1 + m1). */
  seedvr2: { batchContract: '4n+1', trims: { 20: 17, 39: 37 } as Record<number, number> },
  /** klein refine (official image_flux2_klein_image_edit_{4b,9b}_distilled
   * template, distilled operating point): euler, CFG 1, 4 steps, 1 MP. */
  klein: { steps: 4, cfg: 1, sampler: 'euler', megapixels: 1, upscaleMethod: 'lanczos' },
  /** Scorer weights (spec §7 first-party deterministic scorer): Laplacian
   * sharpness dominates; contrast/exposure sanity, temporal stability, and
   * color-space affinity to the subject references share the rest. */
  scorer: { sharpness: 0.5, contrast: 0.12, exposure: 0.13, stability: 0.12, refAffinity: 0.13 },
} as const

/** The Mamad8 T=1 image VAE filename pattern — the never-in-video-graphs
 * constraint keys on this (Mamad8/MiniMax-H3-Image-VAE step1597). */
export const T1_IMAGE_VAE_PATTERN = /^minimax_h3_t1_image_vae/i

/**
 * THE FACTORY GUARD (spec AC8): throws when a video-frame-count graph would
 * decode through the T=1 image VAE. The Mamad8 decoder "materially regresses
 * multi-frame video decode (patch-grid ghosting, cross-frame mixing)" —
 * substituting it into any packet or video render ships corruption that
 * still renders plausibly, so this is a hard build error, not a warning.
 * frames <= 1 (the T=1 Fast profile itself) is the only legal use. */
export function assertNoT1ImageVaeInVideoGraph(vaeName: string, frames: number): void {
  if (frames > 1 && T1_IMAGE_VAE_PATTERN.test(vaeName)) {
    throw new Error(
      `The MiniMax H3 T=1 image VAE (${vaeName}) must never decode multi-frame video — it materially regresses video decode (patch-grid ghosting, cross-frame mixing). This graph requests ${frames} frames; use the stock video VAE, or the T=1 Fast profile for single-frame output.`,
    )
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type H3ImgRefRole = 'subject' | 'pose' | 'style' | 'lighting' | 'background' | 'freeform'
export type H3ImgTransport = 'native' | 'semantic'

/** Auto-per-role transport (spec §3, decision 3) — the completed table
 * (audit m2): subject/identity AND wardrobe-class refs ride native (the
 * packs' clothing-sheet recipe is all-native); pose/style/lighting ride
 * semantic; background/environment rides semantic (the look, not the
 * pixels); freeform defaults native (full fidelity) with expert override.
 * On STOCK REF2VA every ref rides the native ref_images conditioning —
 * per-ref semantic transport needs an edit-reference pack (user-fetch lane,
 * not adopted in v1); the role still shapes the generated contract and the
 * transport still rides provenance. */
export const TRANSPORT_FOR_ROLE: Record<H3ImgRefRole, H3ImgTransport> = {
  subject: 'native',
  pose: 'semantic',
  style: 'semantic',
  lighting: 'semantic',
  background: 'semantic',
  freeform: 'native',
}

/** Slot shape (RefMod-shaped from day one, decision 9): a slot's content is
 * a raw image, a RefMod FILE (community format, read-only in v1 — the
 * factory is H8's task), or a poserig render. */
export type H3ImgRefSlot = {
  /** Uploaded engine-side image name (raw image or poserig render). */
  name?: string
  role: H3ImgRefRole
  transport: H3ImgTransport
  /** Expert per-slot transport override was applied (auto otherwise). */
  transportOverride?: boolean
  /** RefMod file content (community .safetensors) — readable, never
   * creatable in v1; honest labeling in the UI. */
  refmod?: { file: string }
  /** Free-text description feeding the ownership contract. */
  note?: string
}

export type H3ImgPathProfile = 'packet' | 't1'

export type H3ImgFamilyKind =
  | 'generate-packet'
  | 'generate-directed'
  | 'generate-t1'
  | 'compose'
  | 'edit'
  | 'refine'
  | 'burst'
  | 'exit'

export type H3ImgDial = 'keep' | 'tier' | 'seed' | 'resolution' | 'lora1' | 'lora2' | 'transport'

export type H3ImgDetection = {
  available: boolean
  /** Engine node classes required but absent. */
  missingNodes: string[]
  /** Human-readable missing weights with install pointers. */
  missingModels: string[]
  /** The hybrid runtime-merge profile resolved (else stock fallback). */
  hybrid: boolean
  /** Refinements that change HOW the family renders, not whether. */
  notes: string[]
  resolved?: Record<string, string>
}

export type H3ImgFamily = {
  id: string
  label: string
  kind: H3ImgFamilyKind
  /** Path profile the family defaults to (spec §4: packets default, T=1 the
   * explicit Fast profile). */
  profile: H3ImgPathProfile
  /** Fixed tier for directed (39); otherwise the dial picks 5/9/13. */
  tier?: 5 | 9 | 13 | 39
  /** Ref roles this family understands (the contract generator's slots). */
  roles: readonly H3ImgRefRole[]
  dials: readonly H3ImgDial[]
  detect(info: ObjectInfo | undefined, files: ModelFile[]): H3ImgDetection
  ui: {
    description: string
    warning?: string
    installHint?: string
    promptGuidance?: string
  }
}

export type H3ImgLoraSlot = { name: string; strength: number }

export type H3ImgRequest = {
  family: string
  /** The composed ownership contract exactly as it renders (the
   * composeWorkbenchPrompt output — contracts are generated, never
   * hand-written). */
  prompt: string
  width: number
  height: number
  seed: number
  /** Packet tier (packet profile only; directed pins 39). */
  tier?: 5 | 9 | 13 | 39
  /** Ordered reference slots (<=9, wired <Picture N> by order). */
  refs: H3ImgRefSlot[]
  /** Anchored source (packet I2I / edit anchor) — uploaded image name. */
  source?: string
  /** Steps override (packet profile only; T=1 is pinned). */
  steps?: number
  /** LoRA slots (<=2; the form adapter wraps slot 1 when its pack is
   * installed — always first, cross-form safety). */
  loras: H3ImgLoraSlot[]
  filenamePrefix: string
  /** Refine-engine instruction (refine families only). */
  refineInstruction?: string
}

/** Model resolution for the image families. Empty strings mark absences
 * (detection turns them into install guidance). */
export type H3ImgModelSelection = {
  fl2va: string
  ref2va: string
  textEncoder: string
  videoVae: string
  audioVae: string
  /** Mamad8 T=1 decoder — legal ONLY in single-frame graphs. */
  t1ImageVae: string
  /** FL2VA turbo LoRA (any registry-ranked family; the T=1 recipe pins an
   * 8-step family at 0.75). */
  turboLora: string
  /** Detail-adapter class LoRA (ThisIsFine-style; recipe @0.5). */
  detailAdapterLora: string
  /** Krea 2 refine-engine resolution (the default refine engine). */
  krea2: Krea2ModelSelection | null
  /** klein fast-tier refine engine (official Flux.2 klein edit trio). */
  klein: { unet: string; textEncoder: string; vae: string } | null
}

// ---------------------------------------------------------------------------
// Selection inference
// ---------------------------------------------------------------------------

function findModel(files: ModelFile[], kind: ModelFile['kind'], patterns: RegExp[]): string {
  const candidates = files.filter((file) => file.kind === kind)
  for (const pattern of patterns) {
    const match = candidates.find((file) => pattern.test(file.name))
    if (match) return match.name
  }
  return ''
}

export function inferH3ImgSelection(files: ModelFile[], krea2: Krea2ModelSelection | null = null): H3ImgModelSelection {
  return {
    fl2va: findModel(files, 'diffusion_models', [/^minimax_h3_fl2va_pruned_int8_convrot\.safetensors$/i, /^minimax_h3_fl2va.*\.safetensors$/i]),
    ref2va: findModel(files, 'diffusion_models', [/^minimax_h3_ref2va_pruned_int8_convrot\.safetensors$/i, /^minimax_h3_ref2va.*\.safetensors$/i]),
    textEncoder: findModel(files, 'text_encoders', [/^qwen3vl_32b_minimax_h3_nvfp4_awq\.safetensors$/i, /^qwen3vl_32b_minimax_h3.*\.safetensors$/i]),
    videoVae: findModel(files, 'vae', [/^minimax_h3_video_vae_fp16\.safetensors$/i, /^minimax_h3_video_vae.*\.safetensors$/i]),
    audioVae: findModel(files, 'vae', [/^minimax_h3_audio_vae_fp32\.safetensors$/i, /^minimax_h3_audio_vae.*\.safetensors$/i]),
    t1ImageVae: findModel(files, 'vae', [/^minimax_h3_t1_image_vae_step1597\.safetensors$/i, /^minimax_h3_t1_image_vae.*\.safetensors$/i, T1_IMAGE_VAE_PATTERN]),
    turboLora: findModel(files, 'loras', [/^minimax_h3_fl2v_turbo_8step.*\.safetensors$/i, /^minimax_h3_fl2v_turbo.*\.safetensors$/i, /fl2v.*8.?step|8.?step.*fl2v/i]),
    detailAdapterLora: findModel(files, 'loras', [/thisisfine/i, /^maximin.*hhh.*r2v/i, /detail.?adapter/i]),
    krea2,
    klein: {
      unet: findModel(files, 'diffusion_models', [/^flux-2-klein-9b-fp8\.safetensors$/i, /^flux.?2.?klein.?9b.*fp8.*\.safetensors$/i, /^flux.?2.?klein.*9b.*\.safetensors$/i]),
      textEncoder: findModel(files, 'text_encoders', [/^qwen_3_8b_fp8mixed\.safetensors$/i, /^qwen3.?8b.*fp8.*\.safetensors$/i, /^qwen3-8b\.safetensors$/i]),
      vae: findModel(files, 'vae', [/^full_encoder_small_decoder\.safetensors$/i]),
    },
  }
}

/** True when the klein trio resolved (empty-string aware). */
export function kleinResolved(klein: H3ImgModelSelection['klein']): boolean {
  return Boolean(klein && klein.unet && klein.textEncoder && klein.vae)
}

// ---------------------------------------------------------------------------
// Detection (availability gating + install guidance)
// ---------------------------------------------------------------------------

function infoHas(info: ObjectInfo | undefined, nodeClass: string): boolean {
  return Boolean(info && typeof info === 'object' && (info as Record<string, unknown>)[nodeClass] !== undefined)
}

function baseDetect(info: ObjectInfo | undefined, files: ModelFile[], needs: { ref2va?: boolean; t1?: boolean; turbo?: boolean; kleinNodes?: boolean }): H3ImgDetection {
  const selection = inferH3ImgSelection(files)
  const missingNodes: string[] = []
  const missingModels: string[] = []
  const notes: string[] = []
  const hybrid = infoHas(info, HYBRID_LOADER_NODE) && Boolean(selection.fl2va && selection.ref2va)
  if (!hybrid) {
    // The hybrid profile is an UPGRADE, not a requirement — stock fallback
    // runs (spec §1: "else stock with the first-frame-or-refs limitation
    // surfaced"). The loader's absence is install GUIDANCE, never a gate.
    notes.push(!infoHas(info, HYBRID_LOADER_NODE)
      ? `Hybrid profile upgrade: install the ${HYBRID_LOADER_NODE} node pack (Settings → Fetchable items) for the b25-49 runtime merge — stock runs with the first-frame-or-refs limitation.`
      : 'The hybrid loader is installed but a stock checkpoint is missing — the hybrid profile needs both fl2va and ref2va.')
  }
  if (!selection.textEncoder || !selection.videoVae || !selection.audioVae) missingModels.push('the MiniMax H3 text encoder + video/audio VAEs (Settings → Fetchable items, or place them in the model roots)')
  if (needs.ref2va && !selection.ref2va) missingModels.push('the MiniMax H3 Ref2VA checkpoint (reference conditioning)')
  if (needs.t1 && !selection.t1ImageVae) missingModels.push('the Mamad8 T=1 image VAE (minimax_h3_t1_image_vae_step1597.safetensors) — the Fast profile decodes single frames through it')
  if (needs.turbo && !selection.turboLora) missingModels.push('an FL2VA turbo LoRA (8-step family) — the T=1 recipe pins it at 0.75')
  if (needs.kleinNodes) {
    for (const nodeClass of ['EmptyFlux2LatentImage', 'Flux2Scheduler']) {
      if (!infoHas(info, nodeClass)) missingNodes.push(nodeClass)
    }
  }
  // Honest stock-fallback labeling (spec §1: "else stock with the
  // first-frame-or-refs limitation surfaced").
  if (!hybrid && !missingModels.length && !missingNodes.length) {
    notes.push(needs.ref2va
      ? 'Running on stock Ref2VA (no hybrid loader): reference conditioning works, but a first-frame anchor plus references is not available on stock — the hybrid profile makes both ride one model.'
      : 'Running on stock FL2VA (no hybrid loader): first-frame anchoring works, but references need Ref2VA — the hybrid profile makes both ride one model.')
  }
  return { available: missingNodes.length === 0 && missingModels.length === 0, missingNodes, missingModels, hybrid, notes }
}

// ---------------------------------------------------------------------------
// The families
// ---------------------------------------------------------------------------

const GENERATE_ROLES: readonly H3ImgRefRole[] = ['subject', 'style', 'freeform']
const COMPOSE_ROLES: readonly H3ImgRefRole[] = ['subject', 'pose', 'style', 'lighting', 'background', 'freeform']

export const H3IMG_FAMILIES: H3ImgFamily[] = [
  {
    id: 'h3img.generate.packet',
    label: 'Generate (frame packet)',
    kind: 'generate-packet',
    profile: 'packet',
    roles: GENERATE_ROLES,
    dials: ['tier', 'seed', 'resolution', 'lora1', 'lora2'],
    detect: (info, files) => baseDetect(info, files, {}),
    ui: {
      description: 'Text (or an anchored source) to a 5/9/13-frame packet on the hybrid profile — one take whose artifacts are the packet frames; the first-party scorer picks the best frame and you can override it on the take strip.',
      warning: 'The packet decodes through the video VAE: stills carry video-VAE smoothing (the softness ceiling). Frames vary in quality within a packet — that is expected; picking is part of the pipeline.',
      installHint: 'The hybrid profile needs the MiniMaxH3HybridLoader node pack (fetchable) plus the stock fl2va + ref2va checkpoints; without it the packet runs stock with the first-frame-or-refs limitation.',
      promptGuidance: 'Scene-style prompt: describe the whole resulting image — subject, environment, lighting, camera. The packet is one short generation; every frame decodes from the same latent.',
    },
  },
  {
    id: 'h3img.generate.packet.directed',
    label: 'Directed edit (39-frame settle)',
    kind: 'generate-directed',
    profile: 'packet',
    tier: 39,
    roles: COMPOSE_ROLES,
    dials: ['keep', 'seed', 'resolution', 'lora1', 'lora2'],
    detect: (info, files) => baseDetect(info, files, { ref2va: true }),
    ui: {
      description: 'The directed profile for structural changes (re-pose, character swap, new camera angle): a 39-frame settle where the change completes by ~65% of the sequence and the tail holds still — the scorer prefers frames 34-38.',
      warning: 'Costs a 39-frame generation. Directed edits need the video model\'s temporal context to settle into the change; a 5-frame packet is the cheap tier, not a replacement here.',
      installHint: 'Reference conditioning (Ref2VA or the hybrid) required — the source and the change targets ride the picture slots.',
      promptGuidance: 'State the change, then lock the rest: "Change complete by 65% of the sequence and held perfectly still from there" rides the generated contract automatically — your instruction names WHAT changes; the contract pins what must not.',
    },
  },
  {
    id: 'h3img.generate.t1',
    label: 'Generate (T=1 Fast)',
    kind: 'generate-t1',
    profile: 't1',
    roles: GENERATE_ROLES,
    dials: ['seed', 'resolution'],
    detect: (info, files) => baseDetect(info, files, { ref2va: true, t1: true, turbo: true }),
    ui: {
      description: 'The Fast profile: one latent frame through the Mamad8 T=1 image VAE on the hybrid b25-49 checkpoint, FL2VA turbo 8-step @0.75 + detail adapter @0.5, er_sde/sgm_uniform, shifts 12/3. Seconds-class drafts; auto-labeled "fast, structurally soft".',
      warning: 'The T=1 VAE reconstructs from a single temporal latent — outputs can stay soft and lose fine text, thin contours, hair, foliage. It is pinned to this profile and can never appear in a video graph (factory-enforced). Refine is always opt-in: a one-tap affordance follows every T=1 output.',
      installHint: 'Needs the Mamad8 T=1 image VAE (minimax_h3_t1_image_vae_step1597.safetensors — consolidated into the central model home; fetchable), an FL2VA turbo LoRA, and ideally the hybrid loader.',
      promptGuidance: 'Scene-style prompt, as Generate. With a source image the T=1 path auto-switches to Picture-1 reference conditioning (a frame-0 keyframe would fill the only output slot).',
    },
  },
  {
    id: 'h3img.compose.refs',
    label: 'Compose (9 references)',
    kind: 'compose',
    profile: 'packet',
    roles: COMPOSE_ROLES,
    dials: ['tier', 'keep', 'seed', 'resolution', 'lora1', 'lora2', 'transport'],
    detect: (info, files) => baseDetect(info, files, { ref2va: true }),
    ui: {
      description: 'Many images into one: up to 9 ordered reference slots, each with a role (subject / pose / style / lighting / background / freeform) and an auto-per-role transport (native for identity-class, semantic for look-class) with expert per-slot override. The ownership contract is generated from your roles + the Keep dial.',
      warning: 'v1 is honestly hard-9: beyond 9, compose via RefMod bundling (arrives with the RefMod factory) or curate down — the surface says so and helps you pick. Semantic-only overflow stays an expert experimental toggle, off by default. The known failure mode is merging several photos of the SAME subject into one hybrid — split roles across different subjects.',
      installHint: 'Reference conditioning (Ref2VA or the hybrid) required. Per-ref semantic transport on stock engines rides the native path for every slot — the transport still shapes the generated contract; true per-ref semantic wiring arrives with an edit-reference pack (user-fetch, not adopted in v1).',
      promptGuidance: 'Ownership contract, generated for you: every picture gets its role sentence ("Keep the identity and pose from <Picture 1>; transfer only the jacket from <Picture 2>; use the lighting from <Picture 3>"), the Keep dial sets the preservation wording for unspecified traits, and the contract closes with a change-nothing-else clause.',
    },
  },
  {
    id: 'h3img.edit.identity',
    label: 'Edit — identity / face',
    kind: 'edit',
    profile: 'packet',
    roles: ['subject', 'freeform'],
    dials: ['keep', 'seed', 'resolution', 'lora1', 'lora2', 'transport'],
    detect: (info, files) => baseDetect(info, files, { ref2va: true }),
    ui: {
      description: 'Identity transfer: the source stays Picture 1 with its pose/scene/camera/lighting locked; the donor rides a subject slot on native transport. Large identity moves prefer the directed 39-frame settle.',
      warning: 'Identity bleed across multiple identity refs is the documented failure — one donor, everything else locked, "change nothing else" closes the contract. Faces at distance go soft; a refine pass or a face-crop pass fixes it after.',
      promptGuidance: 'Contract locks: source pose, scene, camera, lighting; changes: identity, face, hair, physique as requested.',
    },
  },
  {
    id: 'h3img.edit.background',
    label: 'Edit — background',
    kind: 'edit',
    profile: 'packet',
    roles: ['background', 'subject', 'style', 'lighting'],
    dials: ['keep', 'seed', 'resolution', 'lora1', 'lora2', 'transport'],
    detect: (info, files) => baseDetect(info, files, { ref2va: true }),
    ui: {
      description: 'Background/environment swap: source as Picture 1 (subject, pose, framing locked), the environment rides a background slot on semantic transport.',
      warning: 'Under-specification causes full-shot redesigns — the #1 documented edit failure; the generated contract always says what stays. Subject edges are regenerated, not pixel-locked (edits are semantic regeneration, not inpainting).',
      promptGuidance: 'Contract locks: subject, pose, camera, subject lighting; changes: the background/environment per the background reference.',
    },
  },
  {
    id: 'h3img.edit.outfit',
    label: 'Edit — outfit',
    kind: 'edit',
    profile: 'packet',
    roles: ['subject', 'style', 'lighting'],
    dials: ['keep', 'seed', 'resolution', 'lora1', 'lora2', 'transport'],
    detect: (info, files) => baseDetect(info, files, { ref2va: true }),
    ui: {
      description: 'Outfit change: identity stays Picture 1, wardrobe refs ride subject slots on NATIVE transport (the packs\' clothing-sheet recipe: front outfit, rear construction), each scoped to "only the garment".',
      warning: 'Outfit identity bleeding into the identity ref is the failure mode — native transport plus explicit "only the jacket" scoping is the mitigation. Fit and geometry are approximated, not tailored.',
      promptGuidance: 'Contract locks: identity, face, hair, pose, scene, camera; changes: only the named garment(s) per wardrobe reference.',
    },
  },
  {
    id: 'h3img.edit.lighting',
    label: 'Edit — lighting',
    kind: 'edit',
    profile: 'packet',
    roles: ['lighting', 'subject', 'style'],
    dials: ['keep', 'seed', 'resolution', 'lora1', 'lora2', 'transport'],
    detect: (info, files) => baseDetect(info, files, { ref2va: true }),
    ui: {
      description: 'Relight: a lighting reference rides a lighting slot on semantic transport; subject/pose/scene lock and the illumination changes.',
      warning: 'Reference grading physics: references graded 16-21 L* too bright underperform — grade the reference toward what the model should render. Global relights can shift skin tone; the tone-lock op after refine caps it.',
      promptGuidance: 'Contract locks: subject, pose, scene, composition; changes: illumination per the lighting reference.',
    },
  },
  {
    id: 'h3img.edit.pose',
    label: 'Edit — pose',
    kind: 'edit',
    profile: 'packet',
    roles: ['pose', 'subject', 'style', 'lighting'],
    dials: ['keep', 'seed', 'resolution', 'lora1', 'lora2', 'transport'],
    detect: (info, files) => baseDetect(info, files, { ref2va: true }),
    ui: {
      description: 'Pose transfer by semantic pose reference: a photo, or a Poserig render (send it straight from the rig), rides a pose slot — "use the body pose and limb positions from <Picture N>". Structural pose moves prefer the directed profile.',
      warning: 'Pose+identity confusion is the failure mode: identity stays native (Picture 1), the pose ref rides semantic transport. Skeleton renders are read loosely; quadruped (AP-10K) pose refs are unmeasured on stills (E-IW1 deferred) and are labeled experimental.',
      promptGuidance: 'Contract locks: identity, wardrobe, scene, lighting, lens, framing; changes: body pose and limb positions per the pose reference.',
    },
  },
  {
    id: 'h3img.edit.freeform',
    label: 'Edit — freeform',
    kind: 'edit',
    profile: 'packet',
    roles: COMPOSE_ROLES,
    dials: ['keep', 'seed', 'resolution', 'lora1', 'lora2', 'transport'],
    detect: (info, files) => baseDetect(info, files, { ref2va: true }),
    ui: {
      description: 'Any semantic edit: your instruction plus up to 9 role-tagged references; the contract generator scopes every picture and closes with change-nothing-else.',
      warning: 'One change per pass reads more cleanly — chain passes (each re-anchoring the previous output) when a single pass cannot hold everything.',
      promptGuidance: 'Name the change, assign every picture a role, and let the Keep dial phrase the preservation of unspecified traits.',
    },
  },
  {
    id: 'h3img.refine.krea2',
    label: 'Refine — Krea 2 (quality)',
    kind: 'refine',
    profile: 'packet',
    roles: [],
    dials: ['seed'],
    detect: (info, files) => {
      const selection = inferH3ImgSelection(files)
      if (!selection.krea2) {
        return { available: false, missingNodes: [], missingModels: ['the Krea 2 refine-engine models were not resolved (pass the Krea 2 selection through inferKrea2EditModels)'], hybrid: false, notes: [] }
      }
      const missingModels: string[] = []
      if (!selection.krea2.turbo) missingModels.push('the Krea 2 Turbo checkpoint')
      if (!selection.krea2.textEncoder) missingModels.push('the Krea 2 text encoder')
      if (!selection.krea2.vae) missingModels.push('the Krea 2 VAE')
      if (!selection.krea2.identityEditLora) missingModels.push('the Krea 2 Identity Edit v1.2 LoRA')
      const missingNodes: string[] = []
      for (const nodeClass of ['Krea2EditModelPatch', 'Krea2EditGroundedEncode']) {
        if (!infoHas(info, nodeClass)) missingNodes.push(nodeClass)
      }
      return { available: missingNodes.length === 0 && missingModels.length === 0, missingNodes, missingModels, hybrid: false, notes: [] }
    },
    ui: {
      description: 'The quality refine engine: the picked frame rides Krea 2 Identity Edit (measured 6x identity preservation on-recipe) as an instructed detail pass. Always opt-in — never automatic.',
      warning: 'A refine pass is a semantic regeneration of the whole frame (identity holds, pixels move); name a defect in the instruction ("sharpen the hair, add microtexture to the foliage"), never re-describe the scene.',
      installHint: 'Settings → Fetchable items: the comfyui-krea2edit node pack + the Identity Edit v1.2 LoRA + the Krea 2 checkpoint trio.',
      promptGuidance: 'Defect-naming instruction only — the refiner supplies fine detail while the source stays authoritative for dimensions, lighting, and color.',
    },
  },
  {
    id: 'h3img.refine.klein',
    label: 'Refine — klein (fast tier)',
    kind: 'refine',
    profile: 't1',
    roles: [],
    dials: ['seed'],
    detect: (info, files) => {
      // Self-contained detection: klein is a DIFFERENT engine — it needs its
      // own trio + the core Flux2 nodes, never the H3 stack.
      const selection = inferH3ImgSelection(files)
      const missingModels: string[] = []
      if (!kleinResolved(selection.klein)) {
        if (!selection.klein?.unet) missingModels.push('the Flux.2 klein 9B checkpoint (distilled, fp8 — the official edit template\'s operating point)')
        if (!selection.klein?.textEncoder) missingModels.push('the klein text encoder (qwen_3_8b_fp8mixed)')
        if (!selection.klein?.vae) missingModels.push('the klein VAE (full_encoder_small_decoder)')
      }
      const missingNodes: string[] = []
      for (const nodeClass of ['EmptyFlux2LatentImage', 'Flux2Scheduler']) {
        if (!infoHas(info, nodeClass)) missingNodes.push(nodeClass)
      }
      const available = missingModels.length === 0 && missingNodes.length === 0
      return {
        available,
        missingNodes,
        missingModels,
        hybrid: false,
        notes: available ? ['Template-faithful port of the official image_flux2_klein_image_edit_9b_distilled template (4 steps, CFG 1, euler, 1 MP).'] : [],
      }
    },
    ui: {
      description: 'The fast refine tier (the one-tap default suggestion): a 4-step klein distilled edit pass at ~1 MP — seconds-class sharpening when the session already stages klein.',
      warning: 'Model-swap economics apply: klein is worth staging when you will refine several frames; a single refinement may prefer Krea 2 if it is already resident. Not an upscaler — it re-renders detail.',
      installHint: 'Needs the official Flux.2 klein edit trio (9B distilled fp8 + qwen_3_8b_fp8mixed + full_encoder_small_decoder) and a ComfyUI new enough for the Flux2 nodes (EmptyFlux2LatentImage / Flux2Scheduler).',
      promptGuidance: 'Short edit instruction, as Krea 2: name the defect, not the scene.',
    },
  },
  {
    id: 'h3img.burst.fuse',
    label: 'Burst-fuse (app-side)',
    kind: 'burst',
    profile: 'packet',
    roles: [],
    dials: [],
    detect: () => ({ available: true, missingNodes: [], missingModels: [], hybrid: false, notes: ['No weights, no nodes — the fidelity tier: app-side robust frequency merge with a drift gate and the never-worse-than-target fallback. Gated behind the E-IW2 experiment flag until the experiment proves defaults.'] }),
    ui: {
      description: 'Sharpen the picked frame from its packet neighbors: robust frequency merge (neighbors contribute only high-frequency bands where they align; the target keeps low frequencies), drift-gated — the only refine arm with no hallucination channel. Never-worse-than-target is the hard fallback.',
      warning: 'Experimental (E-IW2): the gain mechanism is borrowing real decoded detail from the sharpest frames and suppressing texture boiling — modest, honest, nearly free. Not a default until the experiment says so.',
      promptGuidance: 'No prompt — the fuse reads the take\'s own frame artifacts (always resident while the take is canonical; no cross-take residency dependency).',
    },
  },
  {
    id: 'h3img.burst.seedvr2',
    label: 'Burst — SeedVR2 3B (heavy arm)',
    kind: 'burst',
    profile: 'packet',
    roles: [],
    dials: [],
    detect: (info) => {
      // The numz SeedVR2 pack (Apache-2.0) is the E-IW2 arm. Its node class
      // is not vendored or adopted in v1 — the lane is availability+flag
      // gated and the graph builder refuses honestly until E-IW2 goes.
      const missingNodes = ['SeedVR2 (numz/ComfyUI-SeedVR2_VideoUpscaler node pack — vendored at E-IW2 GO, not before)']
      const present = infoHas(info, 'SeedVR2VideoUpscaler') || infoHas(info, 'seedvr2_videoupscaler')
      return {
        available: false,
        missingNodes: present ? [] : missingNodes,
        missingModels: present ? [] : ['SeedVR2 3B FP16 weights (origin-gated catalog consent at E-IW2 GO)'],
        hybrid: false,
        notes: [present ? 'The pack is installed, but the lane stays behind the E-IW2 gate + experiment flag until the experiment promotes defaults.' : 'Behind the E-IW2 gate: the app-side fuse (h3img.burst.fuse) is the v1 arm.'],
      }
    },
    ui: {
      description: 'The model arm: the packet as an image batch (5/9/13 natively; 20/39 trim head-side to 17/37) through SeedVR2 3B FP16 into a freed engine state — one-step diffusion video restoration with a generative prior.',
      warning: 'Hallucination channel open (faces/objects/text can change — the diffusion-resto caveat class), and it loads only into a FREED state (the 24 GB staging discipline). Ships behind availability + experiment flags; defaults only if E-IW2 proves them.',
      installHint: 'Nothing to install yet — E-IW2 gates the adoption (numz SeedVR2 nodes vendored at GO, Apache-2.0; weights user-fetch through the origin-gated catalog).',
    },
  },
  {
    id: 'h3img.exit.anchor',
    label: 'Start-frame exit (FL2VA anchor)',
    kind: 'exit',
    profile: 'packet',
    roles: COMPOSE_ROLES,
    dials: ['seed', 'resolution'],
    detect: (info, files) => baseDetect(info, files, {}),
    ui: {
      description: 'The workbench exit: the picked frame seeds a video chain as the FL2VA frame-latent anchor (first_frame — the measured strongest concrete anchor), consent-gated, created-never-submitted. With references riding too, the hybrid both-at-once profile makes first frame + refs work simultaneously.',
      warning: 'On stock checkpoints a first frame AND references silently drops one — the exit names the limitation and anchors through the frame unless the hybrid profile is available. Frame lands on the 32-px grid at the 768 short edge.',
      installHint: 'The hybrid loader (fetchable) upgrades the exit to both-at-once; stock exits anchor the frame only.',
      promptGuidance: 'The chain\'s prompt continues from the workbench prompt (the handoff carries prompt continuity); the image contract rides the chain manifest.',
    },
  },
]

export function findH3ImgFamily(id: string): H3ImgFamily | undefined {
  return H3IMG_FAMILIES.find((family) => family.id === id)
}

/** Availability of every family against the live engine + scan — the mode
 * rail's gating + install-guidance surface. */
export function detectH3ImgFamilies(info: ObjectInfo | undefined, files: ModelFile[]): Array<{ family: H3ImgFamily; detection: H3ImgDetection }> {
  return H3IMG_FAMILIES.map((family) => ({ family, detection: family.detect(info, files) }))
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

type Inputs = Record<string, string | number | boolean | [string, number]>

/** The ids of the per-frame publish pairs (ImageFromBatch + SaveImage). */
export function framePublishIds(count: number): Array<{ select: string; save: string }> {
  const ids: Array<{ select: string; save: string }> = []
  for (let index = 0; index < count; index += 1) {
    ids.push({ select: `${H3IMG.frameSelectPrefix}${index}`, save: `${H3IMG.frameSavePrefix}${index}` })
  }
  return ids
}

/** SeedVR2 batch trim: 5/9/13 ride as-is; 20→17 and 39→37 (head-side —
 * drift is front-loaded, the near-still tail must survive). */
export function seedvr2BatchCount(frames: number): number {
  const trim = H3IMG_RECIPE_PINS.seedvr2.trims[frames]
  return trim ?? frames
}

function validateRequest(family: H3ImgFamily, request: H3ImgRequest): number {
  if (request.prompt.trim() === '') throw new Error('The workbench prompt is empty — the ownership contract must exist (it is generated from your intent + roles).')
  if (request.refs.length > H3IMG_RECIPE_PINS.refs.max) {
    throw new Error(`Beyond 9 references is not available in v1 — the surface is honestly hard-9 (more requires RefMod bundling, which arrives with the RefMod factory). Refs given: ${request.refs.length}.`)
  }
  if (request.loras.length > H3IMG_RECIPE_PINS.lora.slots) {
    throw new Error(`At most ${H3IMG_RECIPE_PINS.lora.slots} LoRA slots per family (combined-strength guidance: healthy ≤ ~${H3IMG_RECIPE_PINS.lora.healthyCombinedMax}, collapse risk ≥ ~${H3IMG_RECIPE_PINS.lora.collapseRisk}).`)
  }
  if (request.width % H3IMG_RECIPE_PINS.canvasGrid !== 0 || request.height % H3IMG_RECIPE_PINS.canvasGrid !== 0) {
    throw new Error(`Canvas must sit on the ${H3IMG_RECIPE_PINS.canvasGrid}-px grid (got ${request.width}x${request.height}).`)
  }
  // number-typed on purpose: a runtime caller (pre-validation JS) can pass
  // anything — the includes() check below is the real gate.
  const tier: number = family.tier ?? request.tier ?? 5
  // Tier rules apply to the H3 pipeline families; refine/burst/exit are not
  // packet generations (refine emits one frame through its own engine).
  const tierBound = family.kind === 'generate-packet' || family.kind === 'generate-directed' || family.kind === 'generate-t1' || family.kind === 'compose' || family.kind === 'edit'
  if (tierBound) {
    if (family.profile === 't1') {
      if (tier !== H3IMG_RECIPE_PINS.t1.frames) throw new Error('The T=1 Fast profile generates exactly one frame.')
    } else if (!H3IMG_RECIPE_PINS.packetTiers.includes(tier as 5 | 9 | 13 | 39)) {
      throw new Error(`Packet tier must be one of ${H3IMG_RECIPE_PINS.packetTiers.join('/')} (got ${tier}).`)
    }
  }
  if (family.kind === 'compose' && request.refs.length === 0) {
    throw new Error('Compose needs at least one reference slot.')
  }
  if ((family.kind === 'edit' || family.kind === 'generate-directed') && !request.source) {
    throw new Error(`${family.label} needs the anchored source image (Picture 1).`)
  }
  if (family.kind === 'refine' && !request.refineInstruction) {
    throw new Error('Refine needs an instruction (name the defect, never re-describe the scene).')
  }
  return tier
}

/**
 * Builds one workbench graph. The H3 pipeline families (generate/compose/
 * edit/burst/exit) share the still-pipeline base — conditioning (I2V anchor
 * or R2V ordered refs), turbo/detail LoRA chain with the form adapter first,
 * the hybrid loader when available, per-frame publish. The refine families
 * delegate to their own engines (Krea 2 via buildKrea2Graph; klein via the
 * official-template port).
 */
export function buildH3ImageGraph(request: H3ImgRequest, selection: H3ImgModelSelection, info?: ObjectInfo): Record<string, { class_type: string; inputs: Inputs }> {
  const family = findH3ImgFamily(request.family)
  if (!family) throw new Error(`Unknown H3 image family '${request.family}'.`)
  const tier = validateRequest(family, request)
  if (family.id === 'h3img.refine.krea2') return buildKrea2RefineGraph(request, selection)
  if (family.id === 'h3img.refine.klein') return buildKleinRefineGraph(request, selection)
  if (family.kind === 'burst') {
    throw new Error(`${family.label}: the SeedVR2 arm is gated behind E-IW2 — the app-side fuse op (h3img.burst.fuse) is the v1 lane and runs in the app, not on the engine.`)
  }
  if (family.id === 'h3img.exit.anchor') {
    throw new Error('The exit is an app-side handoff: it seeds a video chain (first-frame anchor + optional guide machinery) through the canvas chain settings — there is no engine graph to build here.')
  }
  return buildH3StillPipeline(request, family, selection, tier, info)
}

function buildH3StillPipeline(
  request: H3ImgRequest,
  family: H3ImgFamily,
  selection: H3ImgModelSelection,
  tier: number,
  info?: ObjectInfo,
): Record<string, { class_type: string; inputs: Inputs }> {
  const graph: Record<string, { class_type: string; inputs: Inputs }> = {}
  const isT1 = family.profile === 't1'
  const useRefs = request.refs.length > 0 || family.kind === 'compose' || (isT1 && Boolean(request.source))
  const hybridAvailable = Boolean(info && (info as Record<string, unknown>)[HYBRID_LOADER_NODE] !== undefined) && Boolean(selection.fl2va && selection.ref2va)

  // --- model chain ---------------------------------------------------------
  // The hybrid profile (spec §4, decision 10): merge at load, one mmap per
  // checkpoint, no duplicated multi-GB files. Stock fallback per conditioning
  // need (refs → ref2va; anchor → fl2va), with the limitation surfaced by
  // the family detection notes.
  let modelLink: [string, number]
  if (hybridAvailable) {
    graph[H3IMG.unet] = {
      class_type: HYBRID_LOADER_NODE,
      inputs: {
        base_model: selection.fl2va,
        overlay_model: selection.ref2va,
        overlay_preset: H3IMG_RECIPE_PINS.hybrid.preset,
        block_range_start: H3IMG_RECIPE_PINS.hybrid.blockStart,
        block_range_end: H3IMG_RECIPE_PINS.hybrid.blockEnd,
        final_adaln_from_overlay: false,
        custom_overlays: '',
        custom_base: '',
        weight_dtype: 'default',
      },
    }
    modelLink = [H3IMG.unet, 0]
  } else {
    const unetName = useRefs ? selection.ref2va : selection.fl2va
    if (!unetName) throw new Error(useRefs ? 'The Ref2VA checkpoint is missing (reference conditioning needs it, or install the hybrid loader to merge both).' : 'The FL2VA checkpoint is missing.')
    graph[H3IMG.unet] = { class_type: 'UNETLoader', inputs: { unet_name: unetName, weight_dtype: 'default' } }
    modelLink = [H3IMG.unet, 0]
  }
  graph[H3IMG.clip] = { class_type: 'CLIPLoader', inputs: { clip_name: selection.textEncoder, type: 'minimax', device: 'default' } }
  graph[H3IMG.videoVae] = { class_type: 'VAELoader', inputs: { vae_name: selection.videoVae } }
  graph[H3IMG.audioVae] = { class_type: 'VAELoader', inputs: { vae_name: selection.audioVae } }

  // The T=1 Fast recipe pins its two LoRAs (turbo @0.75 + detail @0.5);
  // packet families expose the two slots as dials. Slot 1 rides the
  // first-party form adapter when its pack is installed — always first,
  // cross-form safety (a mismatched-form LoRA through the stock loader is a
  // shape error).
  const loras: H3ImgLoraSlot[] = isT1
    ? [
        ...(selection.turboLora ? [{ name: selection.turboLora, strength: H3IMG_RECIPE_PINS.t1.turboStrength }] : []),
        ...(selection.detailAdapterLora ? [{ name: selection.detailAdapterLora, strength: H3IMG_RECIPE_PINS.t1.detailAdapterStrength }] : []),
      ]
    : request.loras.filter((lora) => lora.name)
  const formAdapterAvailable = Boolean(info && (info as Record<string, unknown>)[FORM_ADAPTER_NODE] !== undefined)
  loras.slice(0, H3IMG_RECIPE_PINS.lora.slots).forEach((lora, index) => {
    const id = index === 0 ? H3IMG.lora1 : H3IMG.lora2
    if (index === 0 && formAdapterAvailable) {
      graph[id] = { class_type: FORM_ADAPTER_NODE, inputs: { model: modelLink, lora_name: lora.name, strength: lora.strength, mode: 'projected (default)', egrid_path: '' } }
    } else {
      graph[id] = { class_type: 'LoraLoaderModelOnly', inputs: { model: modelLink, lora_name: lora.name, strength_model: lora.strength } }
    }
    modelLink = [id, 0]
  })
  if (isT1 && !selection.turboLora) {
    throw new Error('The T=1 Fast profile pins an FL2VA turbo LoRA at 0.75 — none was found in the model scan.')
  }

  // Sigma shifts: the T=1 recipe pins 12/3. The turbo 8-step operating point
  // carries the same shifts (astropuzzo's stack); non-turbo packets run the
  // official unshifted path, matching the video factory's base behavior.
  if (isT1 || (loras.length > 0 && loras.some((lora) => lora.name === selection.turboLora && lora.strength === H3IMG_RECIPE_PINS.t1.turboStrength))) {
    graph[H3IMG.sigmaShift] = {
      class_type: 'MiniMaxH3SigmaShift',
      inputs: { model: modelLink, shift_video: H3IMG_RECIPE_PINS.t1.shiftVideo, shift_audio: H3IMG_RECIPE_PINS.t1.shiftAudio },
    }
    modelLink = [H3IMG.sigmaShift, 0]
  }

  // --- conditioning --------------------------------------------------------
  const conditioningInputs: Inputs = {
    clip: [H3IMG.clip, 0],
    vae: [H3IMG.videoVae, 0],
    prompt: request.prompt,
    width: request.width,
    height: request.height,
    length: tier,
  }
  if (useRefs) {
    // Ordered refs = <Picture N> by wiring order (spec §3). All slots ride
    // the native ref_images path on stock; per-ref semantic transport is a
    // recorded fact + contract shaper (see TRANSPORT_FOR_ROLE).
    conditioningInputs.audio_vae = [H3IMG.audioVae, 0]
    conditioningInputs.ref_image_size = 'max'
    const refNames: string[] = []
    // On the R2V path the SOURCE is always Picture 1 (edits/directed anchor
    // it; T=1 I2I auto-switches to Picture-1 reference conditioning — a
    // frame-0 keyframe would fill the only output slot).
    if (request.source) refNames.push(request.source)
    for (const slot of request.refs) {
      if (slot.name) refNames.push(slot.name)
      else if (slot.refmod) throw new Error('RefMod file slots read the community format but cannot render in v1 — the factory (H8) wires them into the conditioning; use a raw image or a poserig render for this slot.')
    }
    refNames.slice(0, H3IMG_RECIPE_PINS.refs.max).forEach((name, index) => {
      const loaderId = `${H3IMG.refImageLoaderPrefix}${index}`
      graph[loaderId] = { class_type: 'LoadImage', inputs: { image: name } }
      conditioningInputs[`ref_images.ref_image_${index}`] = [loaderId, 0]
    })
    if (refNames.length === 0) throw new Error('Reference conditioning needs at least one picture slot.')
    graph[H3IMG.conditioning] = { class_type: 'MiniMaxH3ReferenceToVideo', inputs: conditioningInputs }
  } else {
    if (request.source) {
      graph[H3IMG.firstFrameLoader] = { class_type: 'LoadImage', inputs: { image: request.source } }
      conditioningInputs.first_frame = [H3IMG.firstFrameLoader, 0]
    }
    graph[H3IMG.conditioning] = { class_type: 'MiniMaxH3ImageToVideo', inputs: conditioningInputs }
  }

  // --- sampler -------------------------------------------------------------
  graph[H3IMG.noise] = { class_type: 'RandomNoise', inputs: { noise_seed: request.seed } }
  graph[H3IMG.guider] = { class_type: 'BasicGuider', inputs: { model: modelLink, conditioning: [H3IMG.conditioning, 0] } }
  const sampler = isT1 ? H3IMG_RECIPE_PINS.t1.sampler : H3IMG_RECIPE_PINS.packet.sampler
  const scheduler = isT1 ? H3IMG_RECIPE_PINS.t1.scheduler : H3IMG_RECIPE_PINS.packet.scheduler
  graph[H3IMG.samplerSelect] = { class_type: 'KSamplerSelect', inputs: { sampler_name: sampler } }
  graph[H3IMG.scheduler] = {
    class_type: 'BasicScheduler',
    inputs: { model: modelLink, scheduler, steps: isT1 ? H3IMG_RECIPE_PINS.t1.steps : (request.steps ?? H3IMG_RECIPE_PINS.packet.steps), denoise: 1 },
  }
  graph[H3IMG.sampler] = {
    class_type: 'SamplerCustomAdvanced',
    inputs: { noise: [H3IMG.noise, 0], guider: [H3IMG.guider, 0], sampler: [H3IMG.samplerSelect, 0], sigmas: [H3IMG.scheduler, 0], latent_image: [H3IMG.conditioning, 1] },
  }

  // --- decode + per-frame publish ------------------------------------------
  // THE FACTORY GUARD: the T=1 VAE is legal ONLY here (single frame); the
  // video VAE decodes every packet tier. The decode choice goes through the
  // same assert the video factory uses — a multi-frame graph can never pick
  // the T1 decoder, and the T1 loader node is only emitted on this path.
  if (isT1) {
    if (!selection.t1ImageVae) {
      throw new Error('The T=1 Fast profile needs the Mamad8 T=1 image VAE (minimax_h3_t1_image_vae_step1597.safetensors) — it was not found in the model scan.')
    }
    assertNoT1ImageVaeInVideoGraph(selection.t1ImageVae, tier)
    graph[H3IMG.videoVae] = { class_type: 'VAELoader', inputs: { vae_name: selection.t1ImageVae } }
  }
  graph[H3IMG.decode] = { class_type: 'VAEDecode', inputs: { samples: [H3IMG.sampler, 0], vae: [H3IMG.videoVae, 0] } }
  for (const { select, save } of framePublishIds(tier)) {
    const index = Number(save.slice(H3IMG.frameSavePrefix.length))
    graph[select] = { class_type: 'ImageFromBatch', inputs: { image: [H3IMG.decode, 0], batch_index: index, length: 1 } }
    graph[save] = { class_type: 'SaveImage', inputs: { images: [select, 0], filename_prefix: request.filenamePrefix } }
  }
  return graph
}

/** Krea 2 refine: the picked frame + a defect-naming instruction through the
 * measured Identity Edit instruct family (the refine default — 6x
 * preservation on-recipe). */
function buildKrea2RefineGraph(request: H3ImgRequest, selection: H3ImgModelSelection): Record<string, { class_type: string; inputs: Inputs }> {
  if (!selection.krea2) throw new Error('The Krea 2 refine engine was not resolved (inferKrea2EditModels over the model scan).')
  if (!request.source) throw new Error('Krea 2 refine needs the picked frame as its source image.')
  const family = findKrea2EditFamily('krea2edit.instruct')
  if (!family) throw new Error('krea2edit.instruct is not registered — the Krea 2 refine engine composes over it.')
  const instruction = request.refineInstruction ?? request.prompt
  const base = { prompt: instruction, width: request.width, height: request.height, seed: request.seed, filenamePrefix: request.filenamePrefix }
  return buildKrea2Graph(
    { ...base, edit: { family: family.id, ...base, source: request.source } },
    selection.krea2,
  )
}

/** klein refine — template-faithful port of the official
 * image_flux2_klein_image_edit_9b_distilled template (ComfyUI workflow
 * templates, the revision shipped with the engine's venv; node classes and
 * widget values extracted from the template itself, 2026-09-18):
 * source -> ImageScaleToTotalPixels (lanczos, 1 MP) -> VAEEncode ->
 * ReferenceLatent stacked onto BOTH the positive and the zeroed negative
 * conditioning -> CFGGuider(model, pos, neg) with euler + Flux2Scheduler(4)
 * over EmptyFlux2LatentImage at the source's scaled size. */
export function buildKleinRefineGraph(request: H3ImgRequest, selection: H3ImgModelSelection): Record<string, { class_type: string; inputs: Inputs }> {
  const klein = selection.klein
  if (!kleinResolved(klein) || !klein) throw new Error('The klein refine engine needs its trio (Flux.2 klein 9B distilled fp8 + qwen_3_8b_fp8mixed + full_encoder_small_decoder) — not resolved by the model scan.')
  if (!request.source) throw new Error('klein refine needs the picked frame as its source image.')
  const k = H3IMG.klein
  const graph: Record<string, { class_type: string; inputs: Inputs }> = {
    [k.unet]: { class_type: 'UNETLoader', inputs: { unet_name: klein.unet, weight_dtype: 'default' } },
    [k.clip]: { class_type: 'CLIPLoader', inputs: { clip_name: klein.textEncoder, type: 'flux2', device: 'default' } },
    [k.vae]: { class_type: 'VAELoader', inputs: { vae_name: klein.vae } },
    [k.sourceLoader]: { class_type: 'LoadImage', inputs: { image: request.source } },
    [k.scale]: { class_type: 'ImageScaleToTotalPixels', inputs: { upscale_method: H3IMG_RECIPE_PINS.klein.upscaleMethod, megapixels: H3IMG_RECIPE_PINS.klein.megapixels, divisible_by: 1, image: [k.sourceLoader, 0] } },
    [k.size]: { class_type: 'GetImageSize', inputs: { image: [k.scale, 0] } },
    [k.positive]: { class_type: 'CLIPTextEncode', inputs: { clip: [k.clip, 0], text: request.refineInstruction ?? request.prompt } },
    [k.negative]: { class_type: 'ConditioningZeroOut', inputs: { conditioning: [k.positive, 0] } },
    [k.encode]: { class_type: 'VAEEncode', inputs: { pixels: [k.scale, 0], vae: [k.vae, 0] } },
    [k.refLatentPositive]: { class_type: 'ReferenceLatent', inputs: { conditioning: [k.positive, 0], latent: [k.encode, 0] } },
    [k.refLatentNegative]: { class_type: 'ReferenceLatent', inputs: { conditioning: [k.negative, 0], latent: [k.encode, 0] } },
    [k.latent]: { class_type: 'EmptyFlux2LatentImage', inputs: { width: [k.size, 0], height: [k.size, 1], batch_size: 1 } },
    [k.noise]: { class_type: 'RandomNoise', inputs: { noise_seed: request.seed } },
    [k.guider]: { class_type: 'CFGGuider', inputs: { model: [k.unet, 0], conditioning: [k.refLatentPositive, 0], conditioning_1: [k.refLatentNegative, 0], cfg: H3IMG_RECIPE_PINS.klein.cfg } },
    [k.samplerSelect]: { class_type: 'KSamplerSelect', inputs: { sampler_name: H3IMG_RECIPE_PINS.klein.sampler } },
    [k.scheduler]: { class_type: 'Flux2Scheduler', inputs: { steps: H3IMG_RECIPE_PINS.klein.steps, width: [k.size, 0], height: [k.size, 1] } },
    [k.sampler]: { class_type: 'SamplerCustomAdvanced', inputs: { noise: [k.noise, 0], guider: [k.guider, 0], sampler: [k.samplerSelect, 0], sigmas: [k.scheduler, 0], latent_image: [k.latent, 0] } },
    [k.decode]: { class_type: 'VAEDecode', inputs: { samples: [k.sampler, 0], vae: [k.vae, 0] } },
    [k.save]: { class_type: 'SaveImage', inputs: { images: [k.decode, 0], filename_prefix: request.filenamePrefix } },
  }
  return graph
}

// ---------------------------------------------------------------------------
// Audit — the correctness rules as executable checks
// ---------------------------------------------------------------------------

/** Video-only node classes that must never appear in a workbench still
 * graph (stills publish images; audio decode and video containers are the
 * video pipeline's business). */
export const H3IMG_FORBIDDEN_VIDEO_NODES = ['VAEDecodeAudio', 'CreateVideo', 'SaveVideo', 'VHS_VideoCombine'] as const

/**
 * Walks a built workbench graph and reports every violation: the Mamad8
 * T=1 VAE in any multi-frame context (the AC8 factory rule, re-checked on
 * the built graph — a video-graph-shaped graph carrying it is caught here
 * too), video-only nodes in still graphs, ref-slot overflow, LoRA-slot
 * overflow, and a missing per-frame publish set. Empty array = clean.
 */
export function h3imgGraphAudit(graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>, options: { frames?: number } = {}): string[] {
  const violations: string[] = []
  const nodes = Object.entries(graph)
  const classes = nodes.map(([, node]) => node.class_type)

  // The Mamad8 guard on BUILT graphs: any VAELoader naming the T1 VAE is
  // legal only when the graph publishes exactly one frame.
  const frames = options.frames ?? frameCountOfGraph(graph)
  for (const [id, node] of nodes) {
    if (node.class_type !== 'VAELoader') continue
    const name = typeof node.inputs.vae_name === 'string' ? node.inputs.vae_name : ''
    if (T1_IMAGE_VAE_PATTERN.test(name) && frames > 1) {
      violations.push(`node ${id} loads the T=1 image VAE (${name}) in a ${frames}-frame graph — the never-in-video-graphs rule (factory guard + audit).`)
    }
  }
  for (const nodeClass of H3IMG_FORBIDDEN_VIDEO_NODES) {
    if (classes.includes(nodeClass)) violations.push(`video-only node ${nodeClass} in a workbench still graph.`)
  }
  const refLoaders = nodes.filter(([id, node]) => node.class_type === 'LoadImage' && id.startsWith(H3IMG.refImageLoaderPrefix)).length
  if (refLoaders > H3IMG_RECIPE_PINS.refs.max) violations.push(`${refLoaders} picture slots exceed the 9-slot native budget.`)
  const loraLoaders = classes.filter((cls) => cls === 'LoraLoaderModelOnly' || cls === FORM_ADAPTER_NODE).length
  if (loraLoaders > H3IMG_RECIPE_PINS.lora.slots) violations.push(`${loraLoaders} LoRA loaders exceed the 2-slot family budget.`)
  const saves = classes.filter((cls) => cls === 'SaveImage').length
  if (options.frames !== undefined && saves !== options.frames) violations.push(`expected ${options.frames} per-frame SaveImage publishes, found ${saves}.`)
  return violations
}

function frameCountOfGraph(graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>): number {
  let count = 0
  for (const [id, node] of Object.entries(graph)) {
    if (node.class_type === 'ImageFromBatch' && id.startsWith(H3IMG.frameSelectPrefix)) count += 1
  }
  return count || 1
}

// ---------------------------------------------------------------------------
// VRAM staging (spec §4: 24 GB discipline) — the residency matrix
// ---------------------------------------------------------------------------

/** The staging facts per family — availability computation reads these so
 * the residency matrix is part of each family's story (audit M3): stages
 * never run concurrently; SeedVR2 loads only into a freed state; the hybrid
 * profile + one refine engine fits. */
export type StageEngine = 'h3' | 'krea2' | 'klein' | 'seedvr2' | 'app'

export const STAGE_ENGINE_OF_FAMILY: Record<string, StageEngine> = {
  'h3img.generate.packet': 'h3',
  'h3img.generate.packet.directed': 'h3',
  'h3img.generate.t1': 'h3',
  'h3img.compose.refs': 'h3',
  'h3img.edit.identity': 'h3',
  'h3img.edit.background': 'h3',
  'h3img.edit.outfit': 'h3',
  'h3img.edit.lighting': 'h3',
  'h3img.edit.pose': 'h3',
  'h3img.edit.freeform': 'h3',
  'h3img.refine.krea2': 'krea2',
  'h3img.refine.klein': 'klein',
  'h3img.burst.fuse': 'app',
  'h3img.burst.seedvr2': 'seedvr2',
  'h3img.exit.anchor': 'h3',
}
