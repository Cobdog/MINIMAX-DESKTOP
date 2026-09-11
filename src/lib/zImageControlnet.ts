/** Z-Image Turbo + Fun ControlNet Union: structure-guided stills (sketch →
 *  image) with optional union inpainting via the optional mask pin.
 *
 *  Topology verified against Comfy-Org's
 *  image_z_image_turbo_fun_union_controlnet template and the canny/depth/pose
 *  blueprints: QwenImageDiffsynthControlnet(model, model_patch, vae, image,
 *  mask?, strength) wraps the Z-Image model; the control image is
 *  preprocessed (native Canny, or a controlnet_aux single image→image node
 *  when installed) and sizes the empty latent through GetImageSize. */
import type { ComfyPrompt } from './workflow'

export type ZImageControlMode = 'canny' | 'depth' | 'pose' | 'hed' | 'mlsd'

/** Native Canny always works; the other modes need their controlnet_aux
 *  preprocessor node installed. Depth may also arrive via a Lotus subgraph —
 *  the aux node is the app-side path. */
export const CONTROL_PREPROCESSORS: Record<ZImageControlMode, { node: string; label: string; note: string }> = {
  canny: { node: 'Canny', label: 'Canny edges', note: 'Built into ComfyUI — edge-guided structure.' },
  depth: { node: 'DepthAnythingV2Preprocessor', label: 'Depth map', note: 'Needs the controlnet_aux (or Depth Anything) preprocessor nodes.' },
  pose: { node: 'DWPoseEstimator', label: 'Pose skeleton', note: 'Needs the controlnet_aux DWPose preprocessor nodes.' },
  hed: { node: 'HEDPreprocessor', label: 'HED soft edges', note: 'Needs the controlnet_aux HED preprocessor nodes.' },
  mlsd: { node: 'MLSDPreprocessor', label: 'Straight lines', note: 'Needs the controlnet_aux MLSD preprocessor nodes — architecture and interiors.' },
}

export type ZImageControlSelection = {
  model: string
  encoder: string
  vae: string
  /** Z-Image-Turbo-Fun-Controlnet-Union.safetensors in models/model_patch. */
  controlnet: string
}

export function buildZImageControlnet(options: {
  prompt: string
  seed: number
  controlImageName: string
  mode: ZImageControlMode
  strength?: number
  maskName?: string
  filenamePrefix: string
}, models: ZImageControlSelection): ComfyPrompt {
  const pre = CONTROL_PREPROCESSORS[options.mode]
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: models.model, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: models.encoder, type: 'lumina2', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: models.vae } },
    '4': { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: options.prompt } },
    '5': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } },
    '11': { class_type: 'LoadImage', inputs: { image: options.controlImageName } },
    '12': options.mode === 'canny'
      ? { class_type: 'Canny', inputs: { image: ['11', 0], low_threshold: 0.1, high_threshold: 0.32 } }
      : { class_type: pre.node, inputs: { image: ['11', 0] } },
    '13': { class_type: 'ModelPatchLoader', inputs: { model_name: models.controlnet } },
    '14': {
      class_type: 'QwenImageDiffsynthControlnet',
      inputs: {
        model: ['1', 0], model_patch: ['13', 0], vae: ['3', 0], image: ['12', 0],
        strength: options.strength ?? 1,
        ...(options.maskName ? { mask: ['17', 0] } : {}),
      },
    },
    ...(options.maskName ? { '17': { class_type: 'LoadImage', inputs: { image: options.maskName } } } : {}),
    '15': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['14', 0], shift: 3 } },
    '16': { class_type: 'GetImageSize', inputs: { image: ['12', 0] } },
    '6': { class_type: 'EmptySD3LatentImage', inputs: { width: ['16', 0], height: ['16', 1], batch_size: 1 } },
    '8': { class_type: 'KSampler', inputs: { model: ['15', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0], seed: options.seed, steps: 8, cfg: 1, sampler_name: 'res_multistep', scheduler: 'simple', denoise: 1 } },
    '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    '10': { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: options.filenamePrefix } },
  }
}
