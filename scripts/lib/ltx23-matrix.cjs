'use strict'
/** Shared golden-matrix definition for the LTX-2.3 utility probes in
 * scripts/test-registry.cjs — the ltx23 counterpart of
 * lib/krea2edit-matrix.cjs.
 *
 * Every entry names a buildLtx23UtilityGraph invocation whose CURRENT output
 * is snapshotted into scripts/fixtures/ltx23-golden.json by
 * `node scripts/test-registry.cjs --update-golden`. The test then rebuilds
 * each config and requires canonical equality — a topology change is a
 * golden diff, reviewed like any contract change.
 *
 * Extra invariants riding on this matrix:
 *  - TOPOLOGY AUDIT: every built graph must pass ltx23TopologyAudit (the
 *    template invariants: cropped-guide decodes, original-audio mux rules,
 *    two-stage ManualSigmas ladders, guide discipline);
 *  - TEMPLATE CENSUS: each family's class multiset must equal the official
 *    template's census with EXACTLY the documented deviation deltas (D1–D8
 *    in src/lib/graph/ltx23.ts) — anything else is silent topology drift;
 *  - TEMPLATE-PINNED VALUES: sigmas ladders, LoRA strengths, sampler
 *    settings and seeds are data-checked against the templates.
 *
 * Configs are deterministic: fixed seeds, fixed prefixes, no clocks. Model
 * filenames are the official templates' own widget values (verified against
 * the HF sources the templates embed in properties.models, 2026-09-15). */

/** The remove family runs the template's bf16 dev pin; outpaint + ia2v run
 *  the fp8 pin; obscura runs the Kijai split stack. Each config carries the
 *  template-exact subset its family requires. */
const MODELS = {
  checkpoint: 'ltx-2.3-22b-dev.safetensors',
  checkpointFp8: 'ltx-2.3-22b-dev-fp8.safetensors',
  transformer: 'ltx-2.3-22b-dev_transformer_only_bf16.safetensors',
  textEncoder: 'gemma_3_12B_it.safetensors',
  textEncoderFp4: 'gemma_3_12B_it_fp4_mixed.safetensors',
  textProjection: 'ltx-2.3_text_projection_bf16.safetensors',
  videoVae: 'LTX23_video_vae_bf16.safetensors',
  audioVae: 'LTX23_audio_vae_bf16.safetensors',
  latentUpscaler: 'ltx-2.3-spatial-upscaler-x2-1.1.safetensors',
  distilled384_1_1: 'ltx-2.3-22b-distilled-lora-384-1.1.safetensors',
  distilled384: 'ltx-2.3-22b-distilled-lora-384.safetensors',
  distilledRank111: 'ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors',
  subtitlesLora: 'ltx2.3-ic-subtitles-remove-general.safetensors',
  watermarkLora: 'ltx2.3-ic-watermark-remove-general.safetensors',
  archivalLora: 'ltx-2.3-dearchive-lora_weights_step_05000.safetensors',
  obscuraLora: 'ltx23-obscura_remova.safetensors',
  outpaintLora: 'ltx-2.3-22b-ic-lora-outpaint.safetensors',
}

const REMOVE_MODELS = (lora) => ({
  checkpoint: MODELS.checkpoint,
  textEncoder: MODELS.textEncoder,
  latentUpscaler: MODELS.latentUpscaler,
  subtitlesRemoveLora: lora === 'subtitles' ? MODELS.subtitlesLora : 'other-tool.safetensors',
  watermarkRemoveLora: lora === 'watermark' ? MODELS.watermarkLora : 'other-tool.safetensors',
  archivalLora: lora === 'archival' ? MODELS.archivalLora : 'other-tool.safetensors',
})

const VIDEO = { name: 'input_subtitles-2.mp4', type: 'input' }
const IMAGE = { name: 'cactus_man.png', type: 'input' }
const AUDIO = { name: 'ltx_23_audio.mp3', type: 'input' }

const matrix = []

// 1. The remove family — one 43-node two-stage topology, three LoRA presets.
matrix.push({ name: 'remove-subtitles-default', request: { tool: 'remove-subtitles', seed: 424242, filenamePrefix: 'ltx23/test-subtitles', video: VIDEO }, models: REMOVE_MODELS('subtitles') })
matrix.push({ name: 'remove-subtitles-portrait-1088x1920-prompt', request: { tool: 'remove-subtitles', seed: 7, filenamePrefix: 'ltx23/test-subtitles-portrait', video: { name: 'burned_captions.mp4' }, width: 1088, height: 1920, prompt: 'Remove the burned-in captions and reconstruct the water underneath.' }, models: REMOVE_MODELS('subtitles') })
matrix.push({ name: 'remove-watermark-default', request: { tool: 'remove-watermark', seed: 1, filenamePrefix: 'ltx23/test-watermark', video: { name: 'input_remove_watermark-1.mp4' } }, models: REMOVE_MODELS('watermark') })
matrix.push({ name: 'restore-archival-default', request: { tool: 'restore-archival', seed: 797718031774635, filenamePrefix: 'ltx23/test-archival', video: { name: 'input_dearchive.mp4' } }, models: REMOVE_MODELS('archival') })

// 2. Obscura Remova — the split-stack single-pass KSampler family.
matrix.push({
  name: 'remove-object-default',
  request: { tool: 'remove-object', seed: 1086065193067454, filenamePrefix: 'ltx23/test-obscura', video: { name: 'input_playing_the_piano.mp4' } },
  models: {
    transformer: MODELS.transformer,
    textEncoder: MODELS.textEncoderFp4,
    textProjection: MODELS.textProjection,
    videoVae: MODELS.videoVae,
    audioVae: MODELS.audioVae,
    obscuraLora: MODELS.obscuraLora,
    distilledLora: MODELS.distilled384_1_1,
  },
})
matrix.push({
  name: 'remove-object-portrait-704x1280',
  request: { tool: 'remove-object', seed: 5, filenamePrefix: 'ltx23/test-obscura-portrait', video: { name: 'crystal.mp4' }, width: 704, height: 1280, prompt: 'Remove the crystal glass from the foreground.' },
  models: {
    transformer: MODELS.transformer,
    textEncoder: MODELS.textEncoderFp4,
    textProjection: MODELS.textProjection,
    videoVae: MODELS.videoVae,
    audioVae: MODELS.audioVae,
    obscuraLora: 'LTX23_Obscura_Remova_v1.safetensors',
    distilledLora: MODELS.distilled384_1_1,
  },
})

// 3. Outpaint — the aspect-pad half-res-grid family.
matrix.push({
  name: 'outpaint-default-9x16',
  request: { tool: 'outpaint', seed: 617176731516609, filenamePrefix: 'ltx23/test-outpaint', video: { name: 'ltx2.3_video_outpainting_input.mp4' } },
  models: { checkpoint: MODELS.checkpointFp8, textEncoder: MODELS.textEncoder, distilledLora: MODELS.distilled384, outpaintLora: MODELS.outpaintLora },
})
matrix.push({
  name: 'outpaint-square-1x1-prompt',
  request: { tool: 'outpaint', seed: 11, filenamePrefix: 'ltx23/test-outpaint-square', video: { name: 'widescreen.mp4' }, aspectW: 1, aspectH: 1, prompt: 'a continuation of the sunlit meadow in every direction' },
  models: { checkpoint: MODELS.checkpointFp8, textEncoder: MODELS.textEncoder, distilledLora: MODELS.distilled384, outpaintLora: MODELS.outpaintLora },
})

// 4. img+audio→video — the core-only two-stage lip-sync family.
matrix.push({
  name: 'ia2v-default',
  request: { tool: 'ia2v', seed: 225158785956033, filenamePrefix: 'ltx23/test-ia2v', image: IMAGE, audio: AUDIO },
  models: { checkpoint: MODELS.checkpointFp8, textEncoder: MODELS.textEncoderFp4, latentUpscaler: MODELS.latentUpscaler, distilledLora: MODELS.distilledRank111 },
})
matrix.push({
  name: 'ia2v-portrait-4s-offset',
  request: { tool: 'ia2v', seed: 9, filenamePrefix: 'ltx23/test-ia2v-portrait', image: { name: 'portrait.png' }, audio: { name: 'line.wav' }, width: 1088, height: 1920, durationSeconds: 4, fps: 25, audioStartSeconds: 1.5, prompt: 'The news anchor reads the headline, one hand gesturing at the chart.' },
  models: { checkpoint: MODELS.checkpointFp8, textEncoder: MODELS.textEncoderFp4, latentUpscaler: MODELS.latentUpscaler, distilledLora: MODELS.distilledRank111 },
})

/** The official templates' generation-subgraph class censuses (extracted
 *  from the template JSONs 2026-09-15) with the documented deviation deltas
 *  applied — the built graphs must match these multisets EXACTLY. Deltas
 *  reference the D-numbers in src/lib/graph/ltx23.ts. */
const EXPECTED_CENSUS = {
  remove: {
    source: 'template_ltx2_3_lora_remove_subtitles_from_video.json — subgraph "Video Generation (LTX-2.3 Remove Subtitles)" (43 nodes)',
    deltas: '− Note/MarkdownNote (annotations) − LTXVAudioVAEDecode (D5 dangling) + LoadVideo/SaveVideo (D2 mux, template root level)',
    census: { CFGGuider: 2, CLIPTextEncode: 2, CheckpointLoaderSimple: 1, ComfyMathExpression: 1, CreateVideo: 1, EmptyLTXVLatentVideo: 1, GetImageSizeAndCount: 1, GetVideoComponents: 1, KSamplerSelect: 2, LTXAVTextEncoderLoader: 1, LTXAddVideoICLoRAGuide: 2, LTXFloatToInt: 1, LTXICLoRALoaderModelOnly: 1, LTXVAudioVAEEncode: 1, LTXVAudioVAELoader: 1, LTXVConcatAVLatent: 2, LTXVConditioning: 1, LTXVCropGuides: 2, LTXVEmptyLatentAudio: 1, LTXVLatentUpsampler: 1, LTXVSeparateAVLatent: 2, LTXVSetAudioRefTokens: 2, LTXVTiledVAEDecode: 1, LatentUpscaleModelLoader: 1, LoadVideo: 1, ManualSigmas: 2, RandomNoise: 2, ResizeImageMaskNode: 2, SamplerCustomAdvanced: 2, SaveVideo: 1 },
  },
  obscura: {
    source: 'template_ltx2_3_obscura_remova_lora_remove_object_from_video.json — subgraph "Video Generation (LTX-2.3 Obscura Remova LoRA)" (30 nodes)',
    deltas: '− ImageStitch/ImageFromBatch/PreviewAny/second CreateVideo (D1 comparison) − PrimitiveInt + ComfyNumberConvert (D6 literals) − VHS_GetImageCount + GetImageSize (D2 → GetImageSizeAndCount) + LoadVideo/SaveVideo (D2)',
    census: { CLIPTextEncode: 2, ComfyMathExpression: 1, CreateVideo: 1, DualCLIPLoader: 1, EmptyLTXVLatentVideo: 1, GetImageSizeAndCount: 1, GetVideoComponents: 1, KSampler: 1, LTXAddVideoICLoRAGuide: 1, LTXVAudioVAEDecode: 1, LTXVConcatAVLatent: 1, LTXVConditioning: 1, LTXVCropGuides: 1, LTXVEmptyLatentAudio: 1, LTXVSeparateAVLatent: 1, LoadVideo: 1, LoraLoaderModelOnly: 2, ResizeImageMaskNode: 1, SaveVideo: 1, UNETLoader: 1, VAEDecode: 1, VAELoaderKJ: 2 },
  },
  outpaint: {
    source: 'template_ltx2_3_lora_video_outpainting.json — subgraph "LTX 2.3 - Video Outpainting" (42 nodes)',
    deltas: '− ImageConcanate + one Float32ColorCorrect + VHS_VideoCombine + VAEDecodeTiled(dangling) (D1/D5 comparison) − VHS_LoadVideo/VHS_VideoInfo/VHS_VideoInfo (D2) − CM_FloatToInt (D3 → ComfyNumberConvert) − LoadImage/LTXVPreprocess/LTXVImgToVideoConditionOnly/Primitive* (D5 bypassed identity + D6) + LoadVideo/SaveVideo/GetVideoComponents/GetImageSizeAndCount (D2)',
    census: { CFGGuider: 1, CLIPTextEncode: 2, CheckpointLoaderSimple: 1, ComfyMathExpression: 3, ComfyNumberConvert: 1, CreateVideo: 1, EmptyLTXVLatentVideo: 1, Float32ColorCorrect: 1, GetImageSize: 1, GetImageSizeAndCount: 1, GetVideoComponents: 1, ImagePadKJ: 1, KSamplerSelect: 1, LTXAVTextEncoderLoader: 1, LTXAddVideoICLoRAGuide: 1, LTXVAudioVAELoader: 1, LTXVConcatAVLatent: 1, LTXVConditioning: 1, LTXVCropGuides: 1, LTXVEmptyLatentAudio: 1, LTXVSeparateAVLatent: 1, LoadVideo: 1, LoraLoaderModelOnly: 2, ManualSigmas: 1, RandomNoise: 1, ResizeImageMaskNode: 2, SamplerCustomAdvanced: 1, SaveVideo: 1, VAEDecode: 1 },
  },
  ia2v: {
    source: 'video_ltx2_3_ia2v.json — subgraph "Video Generation (LTX-2.3)" (53 nodes)',
    deltas: '− LoraLoader/TextGenerateLTX2Prompt/ComfySwitchNode/PreviewAny (D4 prompt enhancement) − Primitive*/Reroute (D6 literals) + LoadAudio/SaveVideo (template root level)',
    census: { CFGGuider: 2, CLIPTextEncode: 2, CheckpointLoaderSimple: 1, ComfyMathExpression: 3, CreateVideo: 1, EmptyLTXVLatentVideo: 1, KSamplerSelect: 2, LTXAVTextEncoderLoader: 1, LTXVAudioVAEDecode: 1, LTXVAudioVAEEncode: 1, LTXVAudioVAELoader: 1, LTXVConcatAVLatent: 2, LTXVConditioning: 1, LTXVCropGuides: 1, LTXVImgToVideoInplace: 2, LTXVLatentUpsampler: 1, LTXVPreprocess: 1, LTXVSeparateAVLatent: 2, LatentUpscaleModelLoader: 1, LoadAudio: 1, LoadImage: 1, LoraLoaderModelOnly: 1, ManualSigmas: 2, RandomNoise: 2, ResizeImageMaskNode: 2, SamplerCustomAdvanced: 2, SaveVideo: 1, SetLatentNoiseMask: 1, SolidMask: 1, TrimAudioDuration: 1, VAEDecodeTiled: 1 },
  },
}

module.exports = { LTX23_MATRIX: matrix, LTX23_MODELS: MODELS, LTX23_EXPECTED_CENSUS: EXPECTED_CENSUS }
