async function main() {
  const pages = await (await fetch('http://127.0.0.1:9231/json')).json()
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl)
  const expression = `(async () => {
    const api = window.minimax;
    const url = 'http://127.0.0.1:8188';
    const info = await api.getObjectInfo(url);
    const preview = await api.getOutputImage(url, {filename:'ZImage_00002_.png',subfolder:'MiniMax_first_frames',type:'output'});
    const source = new Image(); source.src = preview; await source.decode();
    const canvas = document.createElement('canvas'); canvas.width = 352; canvas.height = 608;
    const context = canvas.getContext('2d'); context.fillStyle = '#000'; context.fillRect(0, 0, 352, 608);
    const scale = Math.max(352 / source.naturalWidth, 608 / source.naturalHeight) * 2;
    const cropWidth = 352 / scale, cropHeight = 608 / scale;
    context.drawImage(source, source.naturalWidth - cropWidth, 0, cropWidth, cropHeight, 0, 0, 352, 608);
    const data = canvas.toDataURL('image/png');
    const uploaded = await api.uploadImageData(url,data);
    const received = await api.getOutputImage(url,{filename:uploaded.name,subfolder:uploaded.subfolder,type:'input'});
    const img = new Image(); img.src=received; await img.decode();
    const upscaleLabel = [...document.querySelectorAll('label')].find((label) => label.textContent.includes('Upscale MiniMax video'));
    const result = {cropWidth:img.naturalWidth,cropHeight:img.naturalHeight,uploaded:uploaded.name,hasLtxNode:!!info.LTXVLatentUpsampler,hasZImageNodes:!!info.ModelSamplingAuraFlow,upscaleControlEnabled:upscaleLabel ? !upscaleLabel.querySelector('input').disabled : false,bodyWidth:document.body.clientWidth,mainScroll:document.querySelector('main').scrollWidth,mainWidth:document.querySelector('main').clientWidth};
    if(result.cropWidth!==352 || result.cropHeight!==608 || !result.upscaleControlEnabled) throw new Error('Renderer integration check failed');
    return result;
  })()`
  ws.onopen = () => ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}))
  ws.onmessage = ({data}) => { const msg=JSON.parse(data); if(msg.id===1) { console.log(JSON.stringify(msg.result)); ws.close(); process.exit(msg.result?.exceptionDetails ? 1 : 0) } }
  setTimeout(()=>process.exit(2),30000)
}
main().catch((e)=>{console.error(e);process.exit(1)})
