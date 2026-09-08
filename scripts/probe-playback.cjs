// Read-only media diagnostic against the app's explicitly enabled local debug port.
async function main() {
  const port = process.env.MINIMAX_DEBUG_PORT ?? '9231'
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl)
  const url = process.argv[2]
  if (!url) throw new Error('Pass a media URL')
  const expression = `new Promise(resolve => {
    const video = document.createElement('video'); video.muted = true; video.preload = 'auto';
    const finish = () => { const state = { ready: video.readyState, duration: video.duration, width: video.videoWidth, height: video.videoHeight, error: video.error?.message, code: video.error?.code }; video.removeAttribute('src'); video.load(); resolve(state) };
    video.onloadeddata = finish; video.onerror = finish; setTimeout(finish, 15000);
    video.src = ${JSON.stringify(url)}; video.load();
  })`
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
  ws.onmessage = ({ data }) => { const msg = JSON.parse(data); if (msg.id === 1) { console.log(JSON.stringify(msg.result)); ws.close(); process.exit(msg.result?.result?.value?.ready >= 2 ? 0 : 1) } }
  setTimeout(() => process.exit(2), 20000)
}
main().catch((e) => { console.error(e.message); process.exit(1) })
