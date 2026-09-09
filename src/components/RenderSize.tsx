const sizes: Record<string, string[]> = {
  landscape: ['608x352', '736x416', '768x448', '864x480', '960x544', '1024x576', '1056x608', '1152x640', '1216x672', '1280x736', '1344x768'],
  portrait: ['352x608', '416x736', '448x768', '480x864', '544x960', '576x1024', '608x1056', '640x1152', '672x1216', '736x1280', '768x1344'],
  square: ['512x512', '640x640', '768x768'],
}

export function RenderSize({ value, onChange, provider = 'minimax' }: { value: string; onChange(value: string): void; provider?: 'minimax' | 'ltx25' }) {
  const [w, h] = value.split('x').map(Number)
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

function qualityLabel(size: string) {
  const [width, height] = size.split('x').map(Number)
  const short = Math.min(width, height)
  if (short >= 768) return 'Native quality'
  if (short >= 640) return 'Balanced'
  if (short >= 480) return 'Preview'
  return 'Draft'
}
