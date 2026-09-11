/** H3 Contact Sheet (matlowai/ComfyUI-H3-ContactSheet + Turnaround LoRA):
 *  five coordinated views of a subject in one pass through the H3 video DiT.
 *  Topology verified against the repo's example API workflow — H3ContactSheet
 *  emits both the conditioning and the latent; H3ContactSheetDecode returns
 *  [views, sheet] image batches. */
import type { ModelFile } from '../types'

export type ContactSheetSelection = {
  ref2va: string
  textEncoder: string
  videoVae: string
  turnaroundLora: string
}

export type ContactSheetOptions = {
  prompt: string
  /** Per-view pixel size (256–2048, snapped to 32). 512 is the LoRA's
   *  training size; 1024–2048 trade speed for identity detail. */
  size: number
  steps?: number
  seed: number
  /** ComfyUI input name of the uploaded reference image. */
  referenceName: string
  filenamePrefix: string
}

/** The five-view turnaround LoRA ships under several training-run names
 *  (five_view_512_s1500 “a1500” and siblings on matlod/minimax-h3-turnaround). */
export function inferContactSheetSelection(models: ModelFile[], ref2va: string, textEncoder: string, videoVae: string): ContactSheetSelection {
  const loras = models.filter((model) => model.kind === 'loras')
  return {
    ref2va, textEncoder, videoVae,
    turnaroundLora: loras.find((m) => /five[_-]?view|turnaround/i.test(m.name))?.name ?? '',
  }
}

export function buildContactSheetWorkflow(options: ContactSheetOptions, models: ContactSheetSelection): Record<string, { class_type: string; inputs: Record<string, unknown> }> {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: models.ref2va, weight_dtype: 'default' } },
    '5': { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: models.turnaroundLora, strength_model: 1, model: ['1', 0] } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: models.textEncoder, type: 'minimax', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: models.videoVae } },
    '4': { class_type: 'LoadImage', inputs: { image: options.referenceName } },
    '10': { class_type: 'H3ContactSheet', inputs: { clip: ['2', 0], vae: ['3', 0], prompt: options.prompt, ref_image: ['4', 0], size: Math.min(2048, Math.max(256, Math.round(options.size / 32) * 32)) } },
    '12': { class_type: 'BasicGuider', inputs: { model: ['5', 0], conditioning: ['10', 0] } },
    '14': { class_type: 'BasicScheduler', inputs: { model: ['5', 0], scheduler: 'simple', steps: options.steps ?? 28, denoise: 1 } },
    '13': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
    '11': { class_type: 'RandomNoise', inputs: { noise_seed: options.seed } },
    '15': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['11', 0], guider: ['12', 0], sampler: ['13', 0], sigmas: ['14', 0], latent_image: ['10', 1] } },
    '16': { class_type: 'H3ContactSheetDecode', inputs: { vae: ['3', 0], samples: ['15', 0] } },
    // Views first: output attribution scans in node order, and the five
    // coordinated views are what the character reference set wants. The
    // combined sheet remains in ComfyUI's output folder.
    '18': { class_type: 'SaveImage', inputs: { images: ['16', 0], filename_prefix: `${options.filenamePrefix}_views` } },
    '19': { class_type: 'SaveImage', inputs: { images: ['16', 1], filename_prefix: `${options.filenamePrefix}_sheet` } },
  }
}
