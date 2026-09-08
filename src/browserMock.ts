import type { AppSettings, DesktopApi, ModelFile } from './types'

const modelRoot = 'C:\\Users\\James\\Documents\\ComfyUI\\models'
const settings: AppSettings = {
  comfyUrl: 'http://127.0.0.1:8188',
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen3:latest',
  modelRoot,
  paths: {
    diffusion_models: `${modelRoot}\\diffusion_models`,
    text_encoders: `${modelRoot}\\text_encoders`,
    vae: `${modelRoot}\\vae`,
    loras: `${modelRoot}\\loras`,
    vae_approx: `${modelRoot}\\vae_approx`,
    clip_vision: `${modelRoot}\\clip_vision`,
  },
  outputDirectory: 'C:\\Users\\James\\Documents\\ComfyUI\\output',
  ffmpegPath: 'C:\\FFMPEG\\bin\\ffmpeg.exe',
  generationDefaults: {
    resolution: '1344x768', duration: 5, turbo: 'off', steps: 20,
    sampler: 'res_multistep', scheduler: 'simple', experimentalSampling: false,
    refImageSize: 'match', livePreview: true, sigmaShiftMode: 'model', shiftVideo: 12, shiftAudio: 3, loraStrength: 1,
  },
}

const examples: Array<[ModelFile['kind'], string, number]> = [
  ['diffusion_models', 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', 20_970_379_616],
  ['diffusion_models', 'minimax_h3_ref2va_pruned_int8_convrot.safetensors', 20_970_379_616],
  ['text_encoders', 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', 15_687_142_551],
  ['vae', 'minimax_h3_video_vae_fp16.safetensors', 5_207_808_496],
  ['vae', 'minimax_h3_audio_vae_fp32.safetensors', 605_254_808],
  ['vae_approx', 'taeh3_decoder.safetensors', 39_458_084],
  ['loras', 'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors', 1_956_192_992],
  ['loras', 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors', 1_956_193_000],
  ['loras', 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors', 1_956_193_000],
  ['loras', 'minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors', 1_956_193_000],
  ['diffusion_models', 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors', 22_000_000_000],
  ['text_encoders', 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors', 12_000_000_000],
  ['vae', 'ltx-2.5-video-vae-bf16.safetensors', 2_000_000_000],
  ['vae', 'ltx-2.5-audio-vae-bf16.safetensors', 800_000_000],
]

const ltxNodes = ['LTXVConditioning', 'LTXVEmptyLatentAudio', 'LTXVDualCFGGuider', 'LTXVLatentUpsampler', 'LTXVAudioVAEDecode', 'ManualSigmas']

export function installBrowserMock() {
  if (window.minimax) return
  let current = structuredClone(settings)
  const api: DesktopApi = {
    getObjectInfo: async () => Object.fromEntries([
      ...ltxNodes.map((name) => [name, { input: { required: {} } }]),
      ['LatentUpscaleModelLoader', { input: { required: { model_name: ['COMBO', { options: ['ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors'] }] } } }],
    ]),
    uploadImageData: async () => { throw new Error('Open the desktop app to upload images.') },
    getOutputImage: async () => { throw new Error('Open the desktop app to retrieve images.') },
    getSettings: async () => current,
    saveSettings: async (next) => (current = next),
    chooseDirectory: async () => null,
    chooseMedia: async () => null,
    scanModels: async () => examples.map(([kind, name, bytes]) => ({ kind, name, bytes, path: `${current.paths[kind]}\\${name}` })),
    getComfyStatus: async () => ({ connected: false, latencyMs: 2, error: 'Preview mode' }),
    submitPrompt: async () => { throw new Error('Desktop bridge is unavailable in browser preview.') },
    getQueue: async () => ({}),
    getHistory: async () => ({}),
    cancelPrompt: async () => ({ cancelled: true, state: 'running' }),
    uploadInput: async () => { throw new Error('Desktop bridge is unavailable in browser preview.') },
    fileDataUrl: async () => '',
    mediaUrl: async (path) => path,
    extractVideoFrame: async () => { throw new Error('Open the desktop app to extract video frames.') },
    joinVideos: async () => { throw new Error('Open the desktop app to join videos.') },
    showOutput: async () => undefined,
    findLatestOutput: async () => null,
    listOllamaModels: async () => [
      { name: 'qwen3:latest', size: 5_225_388_164, family: 'qwen3', parameterSize: '8.2B', local: true },
      { name: 'llama3.1:8b', size: 4_920_753_328, family: 'llama', parameterSize: '8.0B', local: true },
    ],
    generateWithOllama: async () => 'A cinematic wide shot with deliberate subject motion, controlled camera movement, natural lighting, and synchronized environmental audio.',
    generateStructuredWithOllama: async (_url, _model, prompt, schema) => {
      const properties = schema.properties as Record<string, unknown> | undefined
      if (properties?.reply) {
        const buildAssets = /Create the recurring characters/i.test(prompt)
        const buildStory = /Build a complete story treatment/i.test(prompt)
        const buildShots = /Turn the story into connected scenes/i.test(prompt)
        const contextMatch = prompt.match(/PROJECT CONTEXT: (.+)\n\nFILMMAKER:/)
        const currentContext = contextMatch ? JSON.parse(contextMatch[1]) as { project: Record<string, unknown>; characters?: Array<{ id: string }> } : { project: {} }
        const currentProject = currentContext.project
        return {
          reply: buildAssets ? '## Production bible created\n- Added **Mara Vale** as the continuity anchor.\n- Added `North Relay Station` as the recurring set.\n\nReview the new cards before adding reference images.' : buildStory ? '## Story treatment created\nA courier crosses a flooded city before sunrise, carrying the final radio capable of reconnecting the evacuation fleet.' : buildShots ? '## Shot plan created\n- Added an opening scene and a production-ready MiniMax establishing shot.\n- Later connected scenes can inherit its final frame.' : '## Continuity approach\n- Carry the prior scene’s **last frame** into the connected shot.\n- Preserve wardrobe, screen direction, lighting, and motion momentum.',
          changes: buildAssets ? ['Created character Mara Vale.', 'Created location North Relay Station.'] : buildStory ? ['Created a complete story treatment.'] : buildShots ? ['Created the opening scene.', 'Created its establishing shot.'] : [], focusAreas: buildAssets ? ['bible'] : buildStory ? ['setup'] : ['shots'],
          projectPatch: {
            title: currentProject.title ?? 'Untitled movie', targetRuntime: currentProject.targetRuntime ?? 60,
            computeBudgetMinutes: currentProject.computeBudgetMinutes ?? 120, aspectRatio: currentProject.aspectRatio ?? '16:9',
            genre: currentProject.genre ?? '', visualStyle: currentProject.visualStyle ?? '', quality: currentProject.quality ?? 'balanced',
            reviewGate: currentProject.reviewGate ?? 'scene', story: buildStory ? 'A courier crosses a flooded city before sunrise, carrying the final radio capable of reconnecting the evacuation fleet. Pursued across collapsing rooftops, she reaches the harbor tower and transmits just as dawn breaks.' : currentProject.story ?? '', visualRules: currentProject.visualRules ?? '',
          },
          characterUpserts: buildAssets ? [{ id: 'new-mara', name: 'Mara Vale', description: 'A weathered pilot in her late thirties with cropped black hair and a narrow scar above her left eyebrow.', wardrobe: 'Faded charcoal flight jacket, rust-red scarf, utility belt, brass compass.', voiceNotes: 'Low warm alto with a measured pace.' }] : [], characterDeletes: [],
          locationUpserts: buildAssets ? [{ id: 'new-relay', name: 'North Relay Station', description: 'An isolated concrete relay station with oxidized antenna ribs, amber work lights, and a cracked blue orientation stripe.' }] : [], locationDeletes: [],
          sceneUpserts: buildShots ? [{ id: 'new-opening', title: 'Flooded crossing', summary: 'The courier enters the drowned city and commits to the dangerous route.', locationId: '', transition: 'cut' }] : [], sceneDeletes: [],
          shotUpserts: buildShots ? [{ id: 'new-establishing', sceneId: 'new-opening', title: 'City at first light', prompt: 'Wide cinematic view of a lone courier crossing a flooded avenue before sunrise, skiffs drifting between dark towers, slow crane movement forward, cold blue ambient light with distant amber windows, wind and water synchronized.', dialogue: '', duration: 6, mode: currentContext.characters?.[0] ? 'reference' : 'text', characterIds: currentContext.characters?.[0] ? [currentContext.characters[0].id] : [] }] : [], shotDeletes: [],
        }
      }
      if (properties?.wardrobe) return { name: 'Mara Vale', description: 'A weathered pilot in her late thirties with cropped black hair, a narrow scar above her left eyebrow, and a steady watchful posture.', wardrobe: 'Faded charcoal flight jacket, rust-red scarf, utility belt, brass compass.', voiceNotes: 'Low warm alto, measured pace, dry delivery that tightens under pressure.' }
      if (properties?.description && !properties?.scenes) return { name: 'North Relay Station', description: 'An isolated concrete relay station on a wind-cut plateau, with a circular control room, oxidized antenna ribs, amber work lights, and a cracked blue orientation stripe running through every corridor.' }
      return { scenes: [{ title: 'Opening', summary: 'The story begins.', location: 'Primary location', shots: [{ title: 'Establishing shot', duration: 5, prompt: 'A cinematic establishing shot introduces the location with controlled camera movement and natural synchronized ambience.', dialogue: '', mode: 'text', characters: [] }] }] }
    },
    getLanStatus: async () => ({ running: true, url: `${location.origin}/?mobile=1&token=browser-preview`, port: Number(location.port) }),
    rotateLanToken: async () => ({ running: true, url: `${location.origin}/?mobile=1&token=browser-preview`, port: Number(location.port) }),
  }
  window.minimax = api
}
