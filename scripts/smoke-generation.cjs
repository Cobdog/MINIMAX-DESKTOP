const fs = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')
const assert = require('node:assert/strict')
function moduleAt(file) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const exports = {}
  vm.runInNewContext(code, { exports, require, URLSearchParams })
  return exports
}
const { buildZImage } = moduleAt('src/lib/zimage.ts')
const { buildMiniMaxWorkflow, frameCount } = moduleAt('src/lib/workflow.ts')
const { choices } = moduleAt('src/lib/comfyInfo.ts')
const base = 'http://127.0.0.1:8188'
async function api(path, body) {
  const res = await fetch(base + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}
async function run(prompt) {
  const client = `minimax-smoke-${Date.now()}`
  const ws = new WebSocket(`ws://127.0.0.1:8188/ws?clientId=${client}`)
  let previews = 0, progress = 0, singleFrames = 0
  ws.onmessage = ({ data }) => {
    if (typeof data !== 'string') previews++
    else {
      const message = JSON.parse(data)
      if (message.type === 'progress') progress++
      if (message.type === 'executed' && message.data?.output?.images?.length) singleFrames += message.data.output.images.length
    }
  }
  const { prompt_id: id } = await api('/prompt', { prompt, client_id: client })
  console.log('submitted', id)
  try {
    for (let i = 0; i < 600; i++) {
      const entry = (await api(`/history/${id}`))[id]
      if (entry?.status.status_str === 'error') throw new Error(JSON.stringify(entry.status.messages))
      if (entry?.status.completed) { console.log('completed', id, { previews, progress, singleFrames }, JSON.stringify(entry.outputs)); return entry }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    throw new Error(`Timed out; job remains on server: ${id}`)
  } finally { ws.close() }
}
async function main() {
  const info = await api('/object_info')
  const upscaleVae = choices(info, 'VAELoader', 'vae_name').find((n) => /ltx-2\.5.*video.*vae/i.test(n))
  const image = await run(buildZImage('A red ceramic teapot on a wooden table, soft daylight, still life photograph', 256, 256, 123, 'z_image_turbo_bf16.safetensors', 'qwen_3_4b.safetensors', 'ae.safetensors'))
  const file = image.outputs['10'].images[0]
  const params = new URLSearchParams(file)
  const bytes = await (await fetch(`${base}/view?${params}`)).arrayBuffer()
  const form = new FormData()
  form.append('image', new Blob([bytes], { type: 'image/png' }), `minimax-smoke-${Date.now()}.png`)
  const upload = await (await fetch(`${base}/upload/image`, { method: 'POST', body: form })).json()
  const graph = buildMiniMaxWorkflow({ mode: 'text', prompt: 'test', width: 256, height: 256, duration: 1, seed: 123, steps: 8, turbo: 'off', sampler: 'res_multistep', scheduler: 'simple', filenamePrefix: 'MiniMax_tests/upscale', referenceImages: [], referenceVideos: [], referenceAudios: [], upscale: { type: 'ltx', model: 'ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors', vae: upscaleVae } }, {}, { images: [], videos: [], audios: [] })
  // Test the actual postprocessor on a short repeated image, without a full MiniMax render.
  for (let id = 1; id <= 19; id++) delete graph[String(id)]
  graph['80'] = { class_type: 'LoadImage', inputs: { image: upload.name } }
  graph['16'] = { class_type: 'RepeatImageBatch', inputs: { image: ['80', 0], amount: frameCount(1) } }
  delete graph['69'].inputs.audio
  assert.equal(graph['68'].inputs.length, frameCount(1))
  await run(graph)
}
main().catch((e) => { console.error(e); process.exit(1) })
