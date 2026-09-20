/** Canonical node-ID policy for the MiniMax H3 graph.
 *
 * The numeric ids are STABLE PUBLIC CONTRACT — tests, the output-attribution
 * precedence in extractOutputFile, and persisted manifests reference them —
 * so the registry never renumbers; it only centralizes the constants so
 * transforms and probes address nodes through roles instead of magic strings.
 *
 * Block allocation (never reuse an id for a different node class):
 *   1-7      model/encoder/VAE loaders + model-chain wraps (turbo 5, shift 6, preview 7)
 *   8-9      the LoRA timeline's user-stack loaders (7twfk6o: slot 0 at 8 —
 *            rides the first-party form adapter when installed — slot 1 at 9)
 *   10-19    conditioning, sampler core, decode, publish
 *   20-28    i2v/FLF loaders, Motion-Context chain, trimmed publish
 *   30/40/50 reference image/video/audio loaders (index-suffixed)
 *   60x/65x  timeline-guide loaders (index-suffixed prefixes; the former
 *            LTX latent 2× block at 60-70 was removed 2026-09-20, Phase 0)
 *   71-72    standard preview frame publish
 *   80-84    RTX/CUDA pixel-space 2× post-process
 *   90-99    LBH latent 2D/3D two-stage hires-fix post-process
 */
export const H3 = {
  unet: '1',
  clip: '2',
  videoVae: '3',
  audioVae: '4',
  turboLora: '5',
  sigmaShift: '6',
  previewOverride: '7',
  loraStack1: '8',
  loraStack2: '9',
  conditioning: '10',
  firstFrameLoader: '20',
  lastFrameLoader: '21',
  motionLoadLatent: '24',
  motionContext: '25',
  motionTrim: '26',
  createVideoTrimmed: '27',
  saveChainLatent: '28',
  noise: '11',
  guider: '12',
  samplerSelect: '13',
  scheduler: '14',
  sampler: '15',
  decode: '16',
  audioDecode: '17',
  createVideo: '18',
  saveVideo: '19',
  previewFrame: '71',
  previewImage: '72',
  guideLoaderPrefix: '60',
  guideNodePrefix: '65',
  refImageLoaderPrefix: '30',
  refVideoLoaderPrefix: '40',
  refAudioLoaderPrefix: '50',
  rtxModel: '80',
  rtxUpscale: '81',
  rtxScale: '82',
  rtxCreateVideo: '83',
  rtxSaveVideo: '84',
  lbhSplitSigmas: '90',
  lbhSeparate: '91',
  lbhUpscale: '92',
  lbhJoin: '93',
  lbhRefineSigmas: '94',
  lbhRefineSampler: '95',
  lbhDecode: '96',
  lbhAudioDecode: '97',
  lbhCreateVideo: '98',
  lbhSaveVideo: '99',
} as const

/** Node classes of the larryvrh ComfyUI-MiniMax-H3-Turbo pack (Apache-2.0):
 * a MODEL→MODEL turbo loader and a →SAMPLER node purpose-built for 4-step
 * audio-video stepping. Presence in object_info upgrades 4-step families. */
export const LARRYVRH_TURBO_NODES = ['MiniMaxH3TurboLoRA', 'MiniMaxH3TurboSampler'] as const
