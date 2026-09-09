const sizes: Record<string, string[]> = {
  landscape: ['608x352', '736x416', '768x448', '864x480', '960x544', '1024x576', '1056x608', '1152x640', '1216x672', '1280x736', '1344x768'],
  portrait: ['352x608', '416x736', '448x768', '480x864', '544x960', '576x1024', '608x1056', '640x1152', '672x1216', '736x1280', '768x1344'],
  square: ['512x512', '640x640', '768x768'],
}

const imageSizes: Record<string, string[]> = {
  '16:9': ['1024x576', '1344x768', '1536x864', '1920x1080'],
  '3:2': ['1024x672', '1152x768', '1536x1024', '1920x1280'],
  '4:3': ['1024x768', '1280x960', '1536x1152', '1920x1440'],
  '1:1': ['768x768', '1024x1024', '1536x1536'],
  '4:5': ['768x960', '1024x1280', '1536x1920'],
  '3:4': ['768x1024', '960x1280', '1152x1536', '1440x1920'],
  '2:3': ['672x1024', '768x1152', '1024x1536', '1280x1920'],
  '9:16': ['576x1024', '768x1344', '864x1536', '1080x1920'],
}

export function RenderSize({ value, onChange, provider = 'minimax' }: { value: string; onChange(value: string): void; provider?: 'minimax' | 'ltx25' | 'zimage' }) {
  const [w, h] = value.split('x').map(Number)
  if (provider === 'zimage') {
    const ratio = Object.entries(imageSizes).find(([, options]) => options.includes(value))?.[0] ?? (w === h ? '1:1' : w > h ? '16:9' : '9:16')
    const area = w * h
    return <fieldset className="render-size image-render-size"><legend>Image canvas</legend>
      <label>Aspect ratio<select value={ratio} onChange={(event) => {
        const options = imageSizes[event.target.value]
        onChange(options.reduce((best, option) => {
          const [ow, oh] = option.split('x').map(Number)
          const [bw, bh] = best.split('x').map(Number)
          return Math.abs(ow * oh - area) < Math.abs(bw * bh - area) ? option : best
        }))
      }}>{Object.keys(imageSizes).map((option) => <option key={option} value={option}>{imageRatioLabel(option)}</option>)}</select></label>
      <label>Resolution<select value={value} onChange={(event) => onChange(event.target.value)}>{imageSizes[ratio].map((size) => <option key={size} value={size}>{size.replace('x', ' × ')} · {imageQualityLabel(size)}</option>)}</select></label>
      <p className="field-help">Z-Image canvas · {(area / 1e6).toFixed(2)} megapixels. Larger canvases use more VRAM and take longer to render.</p>
    </fieldset>
  }
  const orientation = w === h ? 'square' : w > h ? 'landscape' : 'portrait'
  return <fieldset className="render-size"><legend>Output size</legend>
    <label>Orientation<select value={orientation} onChange={(e) => {
      const next = e.target.value
      onChange(next === 'square' ? '768x768' : orientation === 'square' ? sizes[next][2] : `${h}x${w}`)
    }}><option value="landscape">Landscape</option><option value="portrait">Portrait</option><option value="square">Square</option></select></label>
    <label>Resolution<select value={value} onChange={(e) => onChange(e.target.value)}>{sizes[orientation].map((size) => <option key={size} value={size}>{size.replace('x', ' × ')}{provider === 'minimax' ? ` · ${qualityLabel(size)}` : ''}</option>)}</select></label>
    <p className="field-help">{provider === 'ltx25' ? '32-pixel aligned for LTX‑2.5. Quality mode generates at half size before the official latent 2× refinement stage.' : '32-pixel aligned and kept inside MiniMax H3’s official native canvas. Input crops follow this size.'} {(w * h / 1e6).toFixed(2)} megapixels{provider === 'minimax' && (value === '1344x768' || value === '768x1344') ? ' · native 768p' : ''}</p>
  </fieldset>
}

function imageRatioLabel(ratio: string) {
  if (ratio === '16:9') return 'Widescreen · 16:9'
  if (ratio === '3:2') return 'Photo landscape · 3:2'
  if (ratio === '4:3') return 'Classic landscape · 4:3'
  if (ratio === '1:1') return 'Square · 1:1'
  if (ratio === '4:5') return 'Portrait · 4:5'
  if (ratio === '3:4') return 'Classic portrait · 3:4'
  if (ratio === '2:3') return 'Photo portrait · 2:3'
  return 'Vertical · 9:16'
}

function imageQualityLabel(size: string) {
  const [width, height] = size.split('x').map(Number)
  const pixels = width * height
  if (pixels >= 2_000_000) return 'Maximum'
  if (pixels >= 1_300_000) return 'High'
  if (pixels >= 900_000) return 'Standard'
  return 'Fast'
}

function qualityLabel(size: string) {
  const [width, height] = size.split('x').map(Number)
  const short = Math.min(width, height)
  if (short >= 768) return 'Native quality'
  if (short >= 640) return 'Balanced'
  if (short >= 480) return 'Preview'
  return 'Draft'
}
