/** One-time, dismissible notice for the MiniMax H3 community license: region
 *  restrictions reported by the community and the commercial-use requirement.
 *  Shown until acknowledged; the acknowledgement is per-browser. Renders in
 *  the first paint (synchronous localStorage read) so downstream one-shot
 *  layout measurements already account for it. */
import { useState } from 'react'
import { Scale, X } from 'lucide-react'

const ACK_KEY = 'minimax.license-ack'

export function LicenseNotice() {
  const [visible, setVisible] = useState(() => {
    try { return localStorage.getItem(ACK_KEY) !== '1' } catch { return true }
  })

  if (!visible) return null
  const dismiss = () => {
    try { localStorage.setItem(ACK_KEY, '1') } catch { /* Non-fatal: it will show again next visit. */ }
    setVisible(false)
  }
  return (
    <div className="license-notice" role="note" aria-label="Model license notice">
      <Scale size={16} />
      <span>
        <strong>Model license.</strong>
        MiniMax H3 weights carry MiniMax&apos;s community license. Community reporting says it excludes the EU, UK, South Korea, and the United States, and that local commercial use requires a MiniMax license sold through Comfy. Generated outputs follow the same terms. Verify the current license for your region on the MiniMax model card before publishing or selling work.
      </span>
      <button type="button" aria-label="Dismiss license notice" onClick={dismiss}><X size={14} /></button>
    </div>
  )
}
