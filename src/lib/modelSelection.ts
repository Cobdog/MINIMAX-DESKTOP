import type { Ltx23ModelSelection, Ltx25ModelSelection, ModelFile, ModelKind, ModelSelection } from '../types'
import { turboLoraPatterns } from './graph'

function findModel(files: ModelFile[], kind: ModelKind, expressions: RegExp | RegExp[]) {
  const candidates = files.filter((file) => file.kind === kind)
  for (const expression of Array.isArray(expressions) ? expressions : [expressions]) {
    const match = candidates.find((file) => expression.test(file.name))
    if (match) return match.name
  }
  return ''
}

export function inferSelections(files: ModelFile[], turbo: 'off' | '4' | '8', family?: string): ModelSelection {
  const find = (kind: ModelKind, expressions: RegExp | RegExp[]) => findModel(files, kind, expressions)
  return {
    fl2va: find('diffusion_models', [/^minimax_h3_fl2va_pruned_int8_convrot\.safetensors$/i, /^minimax_h3_fl2va.*\.safetensors$/i]),
    ref2va: find('diffusion_models', [/^minimax_h3_ref2va_pruned_int8_convrot\.safetensors$/i, /^minimax_h3_ref2va.*\.safetensors$/i]),
    textEncoder: find('text_encoders', [/^qwen3vl_32b_minimax_h3_nvfp4_awq\.safetensors$/i, /^qwen3vl_32b_minimax_h3.*\.safetensors$/i]),
    videoVae: find('vae', [/^minimax_h3_video_vae_fp16\.safetensors$/i, /^minimax_h3_video_vae.*\.safetensors$/i]),
    audioVae: find('vae', [/^minimax_h3_audio_vae_fp32\.safetensors$/i, /^minimax_h3_audio_vae.*\.safetensors$/i]),
    previewVae: find('vae_approx', /^taeh3_decoder\.safetensors$/i),
    // Turbo inference is family-ranked through the optimization registry:
    // official weights first, then lightx2v newest-first, with an explicit
    // family choice (registry entry id) constraining the patterns to it.
    fl2vLora: find('loras', turboLoraPatterns('fl2v', turbo, family)),
    // Reference mode: the official 4-step LoRA (ComfyUI's template pair), or
    // the 8-step fast tier when 8-step reference mode is requested — ranked
    // larryvrh v4_step600_ema first per the 2026-09-15 bake-off (task
    // muwufpp), lightx2v Ref2VA 8-step as the measured runner-up.
    ref2vLora: find('loras', turboLoraPatterns('ref2v', turbo, family)),
  }
}

export function inferLtx25Selections(files: ModelFile[], latentUpscalers: string[]): Ltx25ModelSelection {
  return {
    diffusion: findModel(files, 'diffusion_models', [
      /^ltx-2\.5-22b-distilled-transformer-comfy-int8-convrot\.safetensors$/i,
      /^ltx-2\.5-22b-distilled-transformer-nvfp4\.safetensors$/i,
      /^ltx-2\.5-22b-distilled-transformer.*\.safetensors$/i,
    ]),
    textEncoder: findModel(files, 'text_encoders', [
      /^gemma4-12b-with-proj-ltx-2\.5-comfy-int8-convrot\.safetensors$/i,
      /^gemma4-12b-with-proj-ltx-2\.5.*\.safetensors$/i,
    ]),
    videoVae: findModel(files, 'vae', /^ltx-2\.5-video-vae.*\.safetensors$/i),
    audioVae: findModel(files, 'vae', /^ltx-2\.5-audio-vae.*\.safetensors$/i),
    latentUpscaler: latentUpscalers.find((name) => /^ltx-2\.5-latent-spatial-upscaler-x2.*\.safetensors$/i.test(name)) ?? '',
  }
}

/** LTX-2.3 utility-family inference (task 068xwy3). A different generation
 *  from the 2.5 workspace: the official template_ltx2_3_* tools run on the
 *  22B DEV checkpoint (a single-file ComfyUI checkpoint carrying the
 *  diffusion model, video VAE, audio VAE and text projection — loaded via
 *  CheckpointLoaderSimple / LTXVAudioVAELoader / LTXAVTextEncoderLoader
 *  ckpt_name), so the checkpoint and the latent upscaler resolve through
 *  ENGINE combo lists (the models/checkpoints and models/latent_upscale_models
 *  folders are outside the six scanner kinds), while the Gemma text encoder
 *  and every LoRA resolve through the directory scan. Filenames are the
 *  official templates' own widget values (verified against the HF sources
 *  the templates embed in properties.models, 2026-09-15). */
export function inferLtx23Selections(
  files: ModelFile[],
  engine: { checkpoints: string[]; latentUpscalers: string[] },
): Ltx23ModelSelection {
  const checkpoint = findIn(engine.checkpoints, [
    /^ltx-2\.3-22b-dev\.safetensors$/i,
    /^ltx-2\.3-22b-dev-fp8\.safetensors$/i,
    /^ltx-2\.3-22b-dev.*\.safetensors$/i,
  ])
  return {
    checkpoint,
    // The Obscura Remova tool is the one family on SPLIT weights (the Kijai
    // transformer-only cut + text projection + separate bf16 VAEs) rather
    // than the single-file checkpoint.
    transformer: findModel(files, 'diffusion_models', /^ltx-2\.3-22b-dev_transformer_only.*\.safetensors$/i),
    textEncoder: findModel(files, 'text_encoders', [
      /^gemma_3_12B_it\.safetensors$/i,
      /^gemma_3_12B_it_fp4_mixed\.safetensors$/i,
      /^gemma_3_12B_it.*\.safetensors$/i,
    ]),
    textProjection: findModel(files, 'text_encoders', /^ltx-2\.3_text_projection.*\.safetensors$/i),
    videoVae: findModel(files, 'vae', /^LTX23_video_vae.*\.safetensors$/i),
    audioVae: findModel(files, 'vae', /^LTX23_audio_vae.*\.safetensors$/i),
    latentUpscaler: findIn(engine.latentUpscalers, /^ltx-2\.3-spatial-upscaler-x2-1\.1\.safetensors$/i) || findIn(engine.latentUpscalers, /^ltx-2\.3-spatial-upscaler-x2.*\.safetensors$/i),
    // Distilled-acceleration LoRA: three official filename variants exist
    // (the two Lightricks -384 cuts and the Comfy-Org rank-111 repack the
    // IA2V template pairs with); any of them satisfies the distilled slot.
    distilledLora: findModel(files, 'loras', [
      /^ltx-2\.3-22b-distilled-lora-384-1\.1\.safetensors$/i,
      /^ltx-2\.3-22b-distilled-lora-384\.safetensors$/i,
      /^ltx_2\.3_22b_distilled_1\.1_lora_.*\.safetensors$/i,
    ]),
    subtitlesRemoveLora: findModel(files, 'loras', /^ltx2\.3-ic-subtitles-remove-general\.safetensors$/i),
    watermarkRemoveLora: findModel(files, 'loras', /^ltx2\.3-ic-watermark-remove-general\.safetensors$/i),
    archivalLora: findModel(files, 'loras', [
      /^ltx-2\.3-dearchive-lora_weights_step_05000\.safetensors$/i,
      /^lora_weights_step_05000\.safetensors$/i,
    ]),
    obscuraLora: findModel(files, 'loras', [/^ltx23-obscura_remova\.safetensors$/i, /^LTX23_Obscura_Remova_v1\.safetensors$/i]),
    outpaintLora: findModel(files, 'loras', /^ltx-2\.3-22b-ic-lora-outpaint\.safetensors$/i),
  }
}

function findIn(names: string[], expressions: RegExp | RegExp[]): string {
  for (const expression of Array.isArray(expressions) ? expressions : [expressions]) {
    const match = names.find((name) => expression.test(name))
    if (match) return match
  }
  return ''
}
