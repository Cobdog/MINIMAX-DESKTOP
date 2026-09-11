const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
function load(path) {
  const exports = {}
  const code = ts.transpileModule(fs.readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  vm.runInNewContext(code, { exports, require, URLSearchParams, URL })
  return exports
}
const workflowModule = load('src/lib/workflow.ts')
const { frameCount, buildMiniMaxWorkflow, extractOutputUrl, extractOutputFile, outputFileFromUrl, OFFICIAL_H3_SAMPLER, OFFICIAL_H3_SCHEDULER } = workflowModule
const { buildZImage } = load('src/lib/zimage.ts')
const { buildLtx25Workflow, ltx25FrameCount, LTX25_FIRST_STAGE_SIGMAS, LTX25_REFINER_SIGMAS } = load('src/lib/ltx25Workflow.ts')
const { inferSelections, inferLtx25Selections } = load('src/lib/modelSelection.ts')
const { cropRect, fitWholeCharacter } = load('src/lib/imageCrop.ts')
const { promptPresets, searchPromptPresets } = load('src/lib/promptPresets.ts')
assert.equal(fitWholeCharacter({ path: 'character.png', name: 'Character', kind: 'image' }).crop.fit, 'contain')
assert.equal(fitWholeCharacter({ path: 'character.png', name: 'Character', kind: 'image', crop: { x: .5, y: .5, zoom: 1, fit: 'crop' } }).crop.fit, 'crop')
assert.ok(promptPresets.length >= 190)
assert.ok(searchPromptPresets('dolly zoom').some((item) => item.id === 'camera.vertigo'))
for (let seconds = 2; seconds <= 15; seconds += 0.5) {
  const frames = frameCount(seconds)
  assert.equal((frames - 5) % 17, 0)
  assert.ok(frames >= Math.round(seconds * 24))
  assert.ok(frames < Math.round(seconds * 24) + 17)
}
for (const [width, height] of [[608, 352], [352, 608], [768, 768]]) {
  for (const x of [0, 0.5, 1]) for (const y of [0, 0.5, 1]) for (const zoom of [1, 2, 4]) {
    const r = cropRect(1000, 500, width, height, { x, y, zoom, fit: 'crop' })
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 1000.0001 && r.y + r.h <= 500.0001)
    assert.ok(Math.abs(r.w / r.h - width / height) < 0.0001)
  }
}
const models = { fl2va: 'fl2va', ref2va: 'ref2va', textEncoder: 'clip', videoVae: 'video', audioVae: 'audio', fl2vLora: 'fl-lora', ref2vLora: 'ref-lora' }
for (const mode of ['text', 'image', 'frames', 'reference']) for (const duration of [2, 3, 5, 15]) {
  const g = buildMiniMaxWorkflow({ mode, width: 352, height: 608, prompt: 'neutral test', duration, seed: 123, steps: 20, turbo: '8', sampler: 'heun', scheduler: 'karras', filenamePrefix: 'test', refImageSize: 'match', upscale: { type: 'ltx', model: 'ltx-upscale', vae: 'ltx-vae' } }, models, { first: { name: 'first.png' }, last: { name: 'last.png' }, images: [{ name: 'ref.png' }], videos: [], audios: [] })
  assert.equal(g['13'].inputs.sampler_name, OFFICIAL_H3_SAMPLER)
  assert.equal(g['14'].inputs.scheduler, OFFICIAL_H3_SCHEDULER)
  assert.equal(g['14'].inputs.steps, 8)
  assert.equal(g['2'].inputs.type, 'minimax')
  assert.equal(g['18'].inputs.fps, 24)
  assert.equal(g['18'].inputs.bit_depth, 8)
  assert.equal(g['10'].inputs.width, 352)
  assert.equal(g['68'].inputs.length, frameCount(duration))
  const padded = frameCount(duration) + (g['61']?.inputs.amount ?? 0)
  assert.equal((padded - 1) % 8, 0)
  assert.equal(g['63'].class_type, 'VAELoader')
  assert.equal(g['63'].inputs.vae_name, 'ltx-vae')
  assert.equal(g['64'].class_type, 'VAEEncodeTiled')
  assert.equal(g['64'].inputs.pixels[0], g['62'] ? '62' : '16')
  assert.equal(g['65'].class_type, 'LatentUpscaleModelLoader')
  assert.equal(g['65'].inputs.model_name, 'ltx-upscale')
  assert.equal(g['66'].class_type, 'LTXVLatentUpsampler')
  assert.equal(g['66'].inputs.samples[0], '64')
  assert.equal(g['66'].inputs.upscale_model[0], '65')
  assert.equal(g['66'].inputs.vae[0], '63')
  assert.equal(g['67'].class_type, 'VAEDecodeTiled')
  assert.equal(g['67'].inputs.samples[0], '66')
  assert.equal(g['68'].inputs.image[0], '67')
  assert.equal(g['69'].inputs.audio[0], '17')
  assert.equal(g['69'].inputs.fps, 24)
  assert.ok(g['70'].inputs.filename_prefix.endsWith('_LTX25_2x'))
  assert.ok(g['19'] && g['70'])
  assert.equal(g['71'].class_type, 'ImageFromBatch')
  assert.equal(g['72'].class_type, 'PreviewImage')
  for (const node of Object.values(g)) for (const value of Object.values(node.inputs)) if (Array.isArray(value)) assert.ok(g[value[0]], `Missing linked node ${value[0]}`)
}
const fullQuality = buildMiniMaxWorkflow({ mode: 'text', width: 1344, height: 768, prompt: 'test', duration: 5, seed: 1, steps: 20, turbo: 'off', sampler: 'heun', scheduler: 'karras', filenamePrefix: 'test', refImageSize: 'match' }, models, { images: [], videos: [], audios: [] })
assert.equal(fullQuality['13'].inputs.sampler_name, OFFICIAL_H3_SAMPLER)
assert.equal(fullQuality['14'].inputs.scheduler, OFFICIAL_H3_SCHEDULER)
assert.equal(fullQuality['14'].inputs.steps, 20)

const previewGraph = buildMiniMaxWorkflow({ mode: 'reference', width: 1344, height: 768, prompt: 'test', duration: 5, seed: 1, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', filenamePrefix: 'test', refImageSize: 'match', previewOverride: { frames: 50, fps: 12, nodeType: 'MiniMaxH3PreviewOverride', vaeName: 'taeh3_decoder.safetensors', jpegQuality: 85 } }, models, { images: [{ name: 'ref.png' }], videos: [], audios: [] })
assert.equal(previewGraph['7'].class_type, 'MiniMaxH3PreviewOverride')
assert.equal(previewGraph['7'].inputs.vae_name, 'taeh3_decoder.safetensors')
assert.equal(previewGraph['7'].inputs.jpeg_quality, 85)
assert.equal(previewGraph['12'].inputs.model[0], '7')

const compatibilityTurbo = buildMiniMaxWorkflow({ mode: 'text', width: 1344, height: 768, prompt: 'test', duration: 5, seed: 1, steps: 20, turbo: '8', experimentalSampling: true, loraStrength: 0.9, sampler: 'euler', scheduler: 'beta', sigmaShift: { video: 12, audio: 4 }, filenamePrefix: 'test', refImageSize: 'match' }, models, { images: [], videos: [], audios: [] })
assert.equal(compatibilityTurbo['5'].inputs.strength_model, 0.9)
assert.equal(compatibilityTurbo['6'].class_type, 'MiniMaxH3SigmaShift')
assert.equal(compatibilityTurbo['6'].inputs.shift_video, 12)
assert.equal(compatibilityTurbo['6'].inputs.shift_audio, 4)
assert.equal(compatibilityTurbo['12'].inputs.model[0], '6')
assert.equal(compatibilityTurbo['14'].inputs.model[0], '6')
assert.equal(compatibilityTurbo['13'].inputs.sampler_name, 'euler')
assert.equal(compatibilityTurbo['14'].inputs.scheduler, 'beta')
assert.equal(compatibilityTurbo['14'].inputs.steps, 8)

const officialModels = inferSelections([
  { kind: 'diffusion_models', name: 'minimax_h3_fl2va_other.safetensors' },
  { kind: 'diffusion_models', name: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors' },
  { kind: 'diffusion_models', name: 'minimax_h3_fl2va_unsupported.gguf' },
  { kind: 'diffusion_models', name: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors' },
  { kind: 'text_encoders', name: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors' },
  { kind: 'vae', name: 'minimax_h3_video_vae_fp16.safetensors' },
  { kind: 'vae', name: 'minimax_h3_audio_vae_fp32.safetensors' },
  { kind: 'loras', name: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors' },
  { kind: 'loras', name: 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors' },
], '8')
assert.equal(officialModels.fl2va, 'minimax_h3_fl2va_pruned_int8_convrot.safetensors')
assert.equal(officialModels.ref2vLora, '')
const refFour = inferSelections([{ kind: 'loras', name: 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors' }], '4')
assert.equal(refFour.ref2vLora, 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors')

const ltxModels = { diffusion: 'ltx-distilled.safetensors', textEncoder: 'gemma4.safetensors', videoVae: 'video-vae.safetensors', audioVae: 'audio-vae.safetensors', latentUpscaler: 'latent-x2.safetensors' }
for (const mode of ['text', 'image']) for (const preset of ['quality', 'turbo']) {
  const graph = buildLtx25Workflow({ mode, preset, prompt: 'test', width: 1280, height: 736, duration: 5, seed: 42, filenamePrefix: 'ltx-test' }, ltxModels, mode === 'image' ? { name: 'first.png' } : undefined)
  assert.equal(graph['2'].inputs.type, 'ltxv')
  assert.equal(graph['8'].inputs.length, ltx25FrameCount(5))
  assert.equal(graph['12'].inputs.video_cfg, 1)
  assert.equal(graph['13'].inputs.sampler_name, 'euler_ancestral')
  assert.equal(graph['14'].inputs.sigmas, LTX25_FIRST_STAGE_SIGMAS)
  assert.equal(graph['42'].inputs.fps, 24)
  assert.equal(graph['45'].class_type, 'PreviewImage')
  assert.equal(Boolean(graph['21']), mode === 'image')
  if (mode === 'image') {
    assert.equal(graph['21'].class_type, 'ResizeImageMaskNode')
    assert.equal(graph['21'].inputs.resize_type, 'scale longer dimension')
    assert.equal(graph['21'].inputs['resize_type.longer_size'], 1536)
    assert.equal(graph['21'].inputs.scale_method, 'lanczos')
    assert.equal('resolution' in graph['21'].inputs, false)
  }
  assert.equal(Boolean(graph['31']), preset === 'quality')
  if (preset === 'quality') {
    assert.equal(graph['8'].inputs.width, 640)
    assert.equal(graph['37'].inputs.sigmas, LTX25_REFINER_SIGMAS)
  } else assert.equal(graph['8'].inputs.width, 1280)
  for (const node of Object.values(graph)) for (const value of Object.values(node.inputs)) if (Array.isArray(value)) assert.ok(graph[value[0]], `Missing LTX linked node ${value[0]}`)
}
const selectedLtx = inferLtx25Selections([
  { kind: 'diffusion_models', name: 'ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors' },
  { kind: 'text_encoders', name: 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors' },
  { kind: 'vae', name: 'ltx-2.5-video-vae-bf16.safetensors' },
  { kind: 'vae', name: 'ltx-2.5-audio-vae-bf16.safetensors' },
], ['ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors'])
assert.ok(Object.values(selectedLtx).every(Boolean))

const zimage = buildZImage('test', 1024, 1024, 7, 'z.safetensors', 'qwen.safetensors', 'ae.safetensors')
assert.equal(zimage['2'].inputs.type, 'lumina2')
assert.equal(zimage['7'].class_type, 'ModelSamplingAuraFlow')
assert.equal(zimage['7'].inputs.shift, 3)
assert.equal(zimage['8'].inputs.steps, 8)
assert.equal(zimage['8'].inputs.cfg, 1)
assert.equal(zimage['8'].inputs.sampler_name, 'res_multistep')
assert.equal(zimage['8'].inputs.scheduler, 'simple')
const rtx = buildMiniMaxWorkflow({ mode: 'text', width: 608, height: 352, prompt: 'test', duration: 2, seed: 1, steps: 20, turbo: '4', sampler: 'res_multistep', scheduler: 'simple', filenamePrefix: 'test', refImageSize: 'match', upscale: { type: 'rtx', model: 'RealESRGAN_x2.pth' } }, models, { images: [], videos: [], audios: [] })
{
  assert.equal(rtx['80'].class_type, 'UpscaleModelLoader')
  assert.equal(rtx['82'].inputs.width, 1216)
  assert.equal(rtx['82'].inputs.height, 704)
  assert.equal(rtx['83'].inputs.audio[0], '17')
  assert.ok(rtx['19'] && rtx['84'])
}
const url = extractOutputUrl({ job: { outputs: { 19: { images: [{ filename: 'original.mp4' }] }, 70: { images: [{ filename: 'upscaled.mp4' }] } } } }, 'job', 'http://localhost:8188')
assert.ok(decodeURIComponent(url).includes('upscaled.mp4'))

// P0-1: completed outputs are attributed by the exact filename ComfyUI
// reported for THAT prompt — a concurrent render's newer file on disk can
// never be credited to this job (the mtime scan is gone from the codebase).
const historyA = { promptA: { outputs: { 19: { images: [{ filename: 'A_video_00001_.mp4', subfolder: 'video', type: 'output' }] } } } }
const historyB = { promptB: { outputs: { 19: { images: [{ filename: 'B_video_00001_.mp4', subfolder: 'video', type: 'output' }] } } } }
const fileA = extractOutputFile(historyA, 'promptA')
assert.equal(fileA.filename, 'A_video_00001_.mp4')
assert.equal(fileA.subfolder, 'video')
assert.equal(fileA.type, 'output')
assert.equal(extractOutputFile(historyB, 'promptB').filename, 'B_video_00001_.mp4')
// Audio jobs pick the audio extension over stray images.
const audioFile = extractOutputFile({ promptC: { outputs: { 19: { images: [{ filename: 'still.png' }], audio: [{ filename: 'track.flac' }] } } } }, 'promptC', 'audio')
assert.equal(audioFile.filename, 'track.flac')
// The descriptor round-trips through the persisted output URL, so a stored
// job can re-resolve its exact file without ComfyUI.
const recovered = outputFileFromUrl(extractOutputUrl(historyA, 'promptA', 'http://127.0.0.1:8188'))
assert.equal(recovered.filename, fileA.filename)
assert.equal(recovered.subfolder, fileA.subfolder)
assert.equal(recovered.type, fileA.type)
assert.equal(outputFileFromUrl('minimax-media://local?path=C%3A%5Cout%5Cx.mp4'), undefined)
assert.equal(outputFileFromUrl('http://127.0.0.1:8188/view?filename=x.mp4'), undefined)

const { reduceJobPoll, isPastRunningDeadline, isTerminalStatus, NO_OUTPUT_POLL_CAP } = load('src/lib/jobReducer.ts')
const baseJob = { id: 'j1', promptId: 'p1', mode: 'text', prompt: 'test', createdAt: Date.now() - 1000, status: 'running', progress: 40, width: 608, height: 352, duration: 5 }
{
  // Happy path: completed observation with a localized output file.
  const done = reduceJobPoll(baseJob, { kind: 'completed', outputUrl: 'http://127.0.0.1:8188/view?filename=out.mp4', localOutputPath: 'C:/out/out.mp4' }, Date.now())
  assert.equal(done.transitionedTo, 'completed')
  assert.equal(done.job.status, 'completed')
  assert.equal(done.job.progress, 100)
  assert.equal(done.job.localOutputPath, 'C:/out/out.mp4')

  // P1-5: a stale poll response must not resurrect a terminal job.
  const stale = reduceJobPoll(done.job, { kind: 'incomplete' }, Date.now())
  assert.equal(stale.transitionedTo, undefined)
  assert.equal(stale.job.status, 'completed')
  const staleError = reduceJobPoll(done.job, { kind: 'executionError' }, Date.now())
  assert.equal(staleError.transitionedTo, undefined)
  assert.equal(staleError.job.status, 'completed')

  // P1-5 (side-effect gate): incomplete on a running job keeps identity for
  // already-running jobs so idle ticks do not churn React state.
  const running = { ...baseJob, status: 'running' }
  const idle = reduceJobPoll(running, { kind: 'incomplete' }, Date.now())
  assert.equal(idle.job, running)
  const queued = reduceJobPoll({ ...baseJob, status: 'queued' }, { kind: 'incomplete' }, Date.now())
  assert.equal(queued.job.status, 'running')

  // pollFailed must not fail a live job — tolerance, not brittleness.
  const tolerant = reduceJobPoll(baseJob, { kind: 'pollFailed' }, Date.now())
  assert.equal(tolerant.transitionedTo, undefined)
  assert.equal(tolerant.job.status, 'running')

  // Execution errors surface with the original wording.
  const errored = reduceJobPoll(baseJob, { kind: 'executionError' }, Date.now())
  assert.equal(errored.transitionedTo, 'failed')
  assert.ok(errored.job.error?.includes('execution error'))

  // P1-6: completed-but-no-output spins at 98% for a bounded count, then fails.
  let spinning = baseJob
  for (let i = 1; i < NO_OUTPUT_POLL_CAP; i++) {
    spinning = reduceJobPoll(spinning, { kind: 'completedNoLocalOutput' }, Date.now()).job
    assert.equal(spinning.status, 'running')
    assert.equal(spinning.progress, 98)
    assert.equal(spinning.noOutputPolls, i)
  }
  const gaveUp = reduceJobPoll(spinning, { kind: 'completedNoLocalOutput' }, Date.now())
  assert.equal(gaveUp.transitionedTo, 'failed')
  assert.ok(gaveUp.job.error?.includes('output file never appeared'))

  // P1-1: any observation past the running deadline fails the job instead of
  // leaving it "running" forever against a dead server.
  const old = { ...baseJob, createdAt: Date.now() - 61 * 60 * 1000 }
  assert.ok(isPastRunningDeadline(old, Date.now()))
  const timedOut = reduceJobPoll(old, { kind: 'pollFailed' }, Date.now())
  assert.equal(timedOut.transitionedTo, 'failed')
  assert.ok(timedOut.job.error?.includes('no completion'))
  // Terminal jobs are exempt from the deadline.
  assert.ok(!isPastRunningDeadline({ ...old, status: 'completed' }, Date.now()))
  assert.ok(isTerminalStatus('cancelled') && !isTerminalStatus('queued'))
}

// Library persistence must survive localStorage quota exhaustion (P0-2):
// first retry scrubs inline data-URL previews; total failure reports an event
// instead of throwing inside a React render.
{
  const events = []
  let quotaFailures = 0
  const storage = {
    store: new Map(),
    setItem(key, value) { if (quotaFailures-- > 0) throw new Error('The quota has been exceeded'); this.store.set(key, value) },
    getItem(key) { return this.store.get(key) ?? null },
  }
  const context = {
    exports: {},
    require,
    URLSearchParams,
    localStorage: storage,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail } },
    window: { dispatchEvent: (event) => events.push(event) },
  }
  const code = ts.transpileModule(fs.readFileSync('src/lib/libraryStorage.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  vm.runInNewContext(code, context)
  const { persistToLocalStorage, STORAGE_ERROR_EVENT } = context.exports

  quotaFailures = 0
  assert.equal(persistToLocalStorage('k1', { a: 1 }), true)
  assert.equal(storage.getItem('k1'), '{"a":1}')
  assert.equal(events.length, 0)

  quotaFailures = 1
  const mediaUrlFile = { path: 'x.png', preview: 'minimax-media://selected?path=x.png' }
  const dataUrlFile = { path: 'y.png', preview: 'data:image/png;base64,AAAA' }
  assert.equal(persistToLocalStorage('k2', [mediaUrlFile, dataUrlFile]), true)
  const stored = JSON.parse(storage.getItem('k2'))
  assert.equal(stored[0].preview, 'minimax-media://selected?path=x.png')
  assert.equal(stored[1].preview, undefined)
  assert.equal(stored[1].path, 'y.png')
  assert.equal(events.length, 1)
  assert.equal(events[0].type, STORAGE_ERROR_EVENT)

  quotaFailures = 5
  assert.equal(persistToLocalStorage('k3', { b: 2 }), false)
  assert.equal(events.length, 2)
  assert.equal(events[1].detail.key, 'k3')
}

// Shared poll kernel (P1-1/P1-7 family): transient failures are retried within
// tolerance, exhaustion and deadline surface one clear message, cancellation
// stops the watch. Async — runs the suite's tail as a promise chain.
async function runKernelTests() {
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const kernelContext = { exports: {}, require, URLSearchParams, URL, setTimeout, clearTimeout }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/promptWatch.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, kernelContext)
  const { startPollLoop } = kernelContext.exports

  // Transient failures inside tolerance are retried; the watch still completes.
  {
    let ticks = 0
    let exhausted = null
    let completed = false
    startPollLoop({
      intervalMs: 5,
      tolerance: 3,
      tick: async () => { ticks += 1; if (ticks < 3) throw new Error('transient'); completed = true; return true },
      onExhausted: (message) => { exhausted = message },
    })
    await delay(120)
    assert.equal(completed, true)
    assert.equal(exhausted, null)
    assert.equal(ticks, 3)
  }

  // Exceeding tolerance exhausts with the reachability message and stops.
  {
    let ticks = 0
    let exhausted = null
    startPollLoop({
      intervalMs: 5,
      tolerance: 2,
      tick: async () => { ticks += 1; throw new Error('down') },
      onExhausted: (message) => { exhausted = message },
    })
    await delay(150)
    assert.ok(exhausted?.includes('Could not reach ComfyUI'))
    assert.equal(ticks, 3) // tolerance 2 → third consecutive failure exhausts
    const settled = ticks
    await delay(60)
    assert.equal(ticks, settled) // stopped
  }

  // The wall-clock deadline exhausts even when every tick succeeds.
  {
    let exhausted = null
    startPollLoop({
      intervalMs: 5,
      deadlineMs: 30,
      tick: async () => false,
      onExhausted: (message) => { exhausted = message },
    })
    await delay(200)
    assert.ok(exhausted?.includes('Still rendering'))
  }

  // A successful tick resets the failure streak.
  {
    let ticks = 0
    let exhausted = null
    let completed = false
    startPollLoop({
      intervalMs: 5,
      tolerance: 2,
      tick: async () => { ticks += 1; if (ticks % 2 === 1 && ticks < 6) throw new Error('flaky'); if (ticks >= 6) { completed = true; return true } return false },
      onExhausted: (message) => { exhausted = message },
    })
    await delay(200)
    assert.equal(completed, true)
    assert.equal(exhausted, null)
  }

  // cancel() stops future ticks.
  {
    let ticks = 0
    const loop = startPollLoop({
      intervalMs: 5,
      tick: async () => { ticks += 1; return false },
      onExhausted: () => {},
    })
    await delay(20)
    loop.cancel()
    const settled = ticks
    await delay(80)
    assert.equal(ticks, settled)
  }
}


// ---- Official MiniMax prompt contracts --------------------------------------
const { BASE_CONTRACT_SECTIONS, REFERENCE_CONTRACT_SECTIONS, buildBaseContractDraft, buildReferenceContractDraft, validateContract, referenceOrderWarnings, formatCutTime, suggestCutTimes, keyframeAlignmentInstruction } = load('src/lib/promptContracts.ts')
assert.equal(BASE_CONTRACT_SECTIONS.map((section) => section.key).join('|'), 'integrated_multimodal_description|overall_soundscape|non_diegetic_music')
assert.equal(REFERENCE_CONTRACT_SECTIONS.map((section) => section.key).join('|'), 'subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music')
assert.equal(formatCutTime(3.5), '00:03.500')
assert.equal(formatCutTime(65.25), '01:05.250')
assert.equal(suggestCutTimes(10, 2).join('|'), '00:03.333|00:06.667')
assert.equal(suggestCutTimes(5, 0).length, 0)
assert.equal(keyframeAlignmentInstruction('image', 5), 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.')
assert.ok(keyframeAlignmentInstruction('frames', 8).includes('8.00 seconds'))
assert.equal(keyframeAlignmentInstruction('text', 5), '')

const baseDraft = buildBaseContractDraft({ mode: 'image', duration: 8, prompt: 'A baker shapes dough.' })
for (const section of BASE_CONTRACT_SECTIONS) assert.ok(baseDraft.includes(`${section.key}:`), `base draft missing ${section.key}`)
assert.ok(baseDraft.includes('fully referenced'), 'I2VA alignment line missing from base draft')
assert.ok(baseDraft.includes('[Shot 1] A baker shapes dough.'))
assert.equal(validateContract(baseDraft, { duration: 8, referenceMode: false }).warnings.length, 0, 'base draft should validate clean')

const bindings = [
  { label: 'Character: Ada / identity', purpose: 'character', file: { path: '/a.png', name: 'ada.png', kind: 'image' } },
  { label: 'Wardrobe: Red coat for Ada', purpose: 'wardrobe', file: { path: '/coat.png', name: 'coat.png', kind: 'image' } },
]
const refDraft = buildReferenceContractDraft({ bindings, referenceVideos: [{ path: '/v.mp4', name: 'walk.mp4', kind: 'video' }], referenceAudios: [], duration: 6, prompt: 'Ada crosses the square.' })
for (const section of REFERENCE_CONTRACT_SECTIONS) assert.ok(refDraft.includes(`${section.key}:`), `ref draft missing ${section.key}`)
assert.ok(refDraft.includes('<Subject 1> is the identity of Ada'))
assert.ok(refDraft.includes('<Video 1> is walk.mp4'))
assert.ok(refDraft.includes('[reference generation]'))
const refCheck = validateContract(refDraft, { duration: 6, referenceMode: true, definedSubjects: ['Subject 1', 'Subject 2'] })
assert.equal(refCheck.warnings.length, 0, 'ref draft should validate clean')

assert.ok(validateContract('integrated_multimodal_description: x', { duration: 5, referenceMode: false }).warnings.some((warning) => warning.includes('overall_soundscape')), 'missing-section warning expected')
const badCuts = 'integrated_multimodal_description: [Shot 1] x\n[Shot 2] At 00:06.000, y\n[Shot 3] At 00:04.000, z\noverall_soundscape: a\nnon_diegetic_music: N/A'
const cutWarnings = validateContract(badCuts, { duration: 5, referenceMode: false }).warnings
assert.ok(cutWarnings.some((warning) => warning.includes('not strictly increasing')), 'non-increasing cut expected')
assert.ok(cutWarnings.some((warning) => warning.includes('beyond the 5s duration')), 'cut beyond duration expected')
assert.ok(validateContract('subject_definitions: <Subject 1> is Ada.\nsummary: [reference generation] x\nretention_analysis: <Subject 1>: fully_preserved\ndetailed_description: <Subject 2> appears.\noverall_soundscape: a\nnon_diegetic_music: N/A', { duration: 5, referenceMode: true, definedSubjects: ['Subject 1'] }).warnings.some((warning) => warning.includes('<Subject 2> is used but not defined')), 'unresolved subject expected')

assert.equal(referenceOrderWarnings('Uses <Picture 1> then <Picture 2>.', { images: 2, videos: 0, audios: 0 }).length, 0)
assert.ok(referenceOrderWarnings('Uses <Picture 2> before <Picture 1>.', { images: 2, videos: 0, audios: 0 }).some((warning) => warning.includes('mentioned before')), 'slot-order mismatch expected')
assert.ok(referenceOrderWarnings('Uses <Picture 5>.', { images: 2, videos: 0, audios: 0 }).some((warning) => warning.includes('only 2 pictures are loaded')), 'unloaded reference expected')
assert.ok(referenceOrderWarnings('No tags here.', { images: 3, videos: 0, audios: 0 }).some((warning) => warning.includes('none mentioned')), 'unmentioned pictures expected')
assert.ok(referenceOrderWarnings('Uses <Audio 2> first, then <Audio 1>.', { images: 0, videos: 0, audios: 2 }).some((warning) => warning.includes('<Audio 2> is mentioned before')), 'audio order mismatch expected')


// ---- Local prompt library storage -------------------------------------------
{
  const store = new Map()
  const localStorageStub = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)) },
    removeItem: (key) => { store.delete(key) },
  }
  // Two-file loader: promptLibraryStorage imports ./libraryStorage, so the
  // VM context needs a require that resolves and transpiles that dependency.
  const cache = {}
  const transpileFile = (file) => ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const libRequire = (name) => {
    if (name === './libraryStorage') {
      if (!cache.libraryStorage) {
        cache.libraryStorage = {}
        vm.runInNewContext(transpileFile('src/lib/libraryStorage.ts'), { exports: cache.libraryStorage, require, console, localStorage: localStorageStub, window: { dispatchEvent: () => undefined, CustomEvent: class {}, addEventListener: () => undefined } })
      }
      return cache.libraryStorage
    }
    return require(name)
  }
  const exports2 = {}
  const CustomEventStub = class { constructor(type, init) { this.type = type; this.detail = init?.detail } }
  vm.runInNewContext(transpileFile('src/lib/promptLibraryStorage.ts'), { exports: exports2, require: libRequire, console, CustomEvent: CustomEventStub, window: { dispatchEvent: () => undefined, CustomEvent: CustomEventStub }, localStorage: localStorageStub })
  const storage = exports2
  const initial = storage.loadPromptLibrary()
  assert.equal(initial.length, 8, 'bundled technique corpus expected')
  assert.ok(initial.every((entry) => entry.technique), 'starter entries are techniques')
  assert.ok(initial.some((entry) => entry.id === 'technique.timed-beats'))
  storage.savePromptEntry({ id: 'civitai.42', label: 'City run', prompt: 'A courier sprints through neon rain, timed beats throughout.', steps: 30, sampler: 'res_multistep', source: { kind: 'civitai', itemId: '42', username: 'ada' } })
  const saved = storage.loadPromptLibrary()
  assert.equal(saved.length, 9)
  const entry = saved.find((item) => item.id === 'civitai.42')
  assert.ok(entry && entry.source.username === 'ada' && entry.steps === 30, 'saved entry round-trips metadata')
  storage.deletePromptEntry('civitai.42')
  assert.equal(storage.loadPromptLibrary().length, 8, 'delete restores corpus-only state')
}


// ---- Multiframe timeline guides (MiniMaxH3AddGuide) -------------------------
{
  const guidesGraph = buildMiniMaxWorkflow({ mode: 'reference', prompt: 'p', width: 1344, height: 768, duration: 6, seed: 1, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', refImageSize: 'match', filenamePrefix: 't', referenceImages: ['a.png'], referenceVideos: [], referenceAudios: [], timelineGuides: [{ frameIndex: 36 }, { frameIndex: 72 }, { frameIndex: 120 }] }, models, { images: [{ name: 'a.png' }], videos: [], audios: [], guides: [{ name: 'g1.png' }, { name: 'g2.png' }, { name: 'g3.png' }] })
  assert.equal(guidesGraph['650'].class_type, 'MiniMaxH3AddGuide')
  assert.equal(guidesGraph['651'].class_type, 'MiniMaxH3AddGuide')
  assert.equal(guidesGraph['652'].class_type, 'MiniMaxH3AddGuide')
  // Chain: R2V -> AG1 -> AG2 -> AG3 -> BasicGuider, shared latent, both VAEs.
  assert.equal(guidesGraph['650'].inputs.positive.join('|'), '10|0')
  assert.equal(guidesGraph['651'].inputs.positive.join('|'), '650|0')
  assert.equal(guidesGraph['652'].inputs.positive.join('|'), '651|0')
  assert.equal(guidesGraph['12'].inputs.conditioning.join('|'), '652|0')
  for (const id of ['650', '651', '652']) {
    assert.equal(guidesGraph[id].inputs.latent.join('|'), '10|1', id + ' latent')
    assert.equal(guidesGraph[id].inputs.vae.join('|'), '3|0', id + ' vae')
    assert.equal(guidesGraph[id].inputs.audio_vae.join('|'), '4|0', id + ' audio_vae')
  }
  assert.equal(guidesGraph['650'].inputs.frame_idx, 36)
  assert.equal(guidesGraph['652'].inputs.frame_idx, 120)
  assert.equal(guidesGraph['600'].class_type, 'LoadImage')
  assert.equal(guidesGraph['600'].inputs.image, 'g1.png')
  // Without guides the classic graph is unchanged.
  const classicGraph = buildMiniMaxWorkflow({ mode: 'reference', prompt: 'p', width: 1344, height: 768, duration: 6, seed: 1, steps: 20, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', refImageSize: 'match', filenamePrefix: 't', referenceImages: ['a.png'], referenceVideos: [], referenceAudios: [] }, models, { images: [{ name: 'a.png' }], videos: [], audios: [] })
  assert.equal(classicGraph['12'].inputs.conditioning.join('|'), '10|0')
  assert.equal(classicGraph['650'], undefined)
  // Frame helpers follow the official round(seconds*24) convention.
  const { frameIndexForSeconds, guideFrameWarning } = workflowModule
  assert.equal(frameIndexForSeconds(1.5), 36)
  assert.equal(frameIndexForSeconds(3), 72)
  assert.equal(frameIndexForSeconds(-2), -48)
  assert.equal(guideFrameWarning(1.5, 6), null)
  assert.equal(guideFrameWarning(5.5, 5) !== null, true, 'beyond duration warns')
  assert.equal(guideFrameWarning(-6, 5) !== null, true, 'before start warns')
}

runKernelTests().then(() => {
  console.log('PASS: official H3, LTX-2.5 and Z-Image workflows, model preference, duration/crop, previews, post-processing, output selection, job poll reduction, quota-safe library persistence, poll-loop kernel (tolerance/deadline/cancel), the official MiniMax prompt contracts (sections, cut times, ordering, reference discipline), the local prompt library storage (technique corpus + save/delete round-trip), and multiframe AddGuide chaining (topology, frame indices, classic-graph invariance)')
}, (error) => {
  console.error(error)
  process.exitCode = 1
})
