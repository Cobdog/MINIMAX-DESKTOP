import { useEffect } from 'react'
import { Check, RefreshCw, Sparkles, X } from 'lucide-react'

export function ReferenceApprovalModal({ title, description, image, approveLabel, nextStep, approveStartsGeneration = false, onRetry, onApprove, onClose }: {
  title: string
  description: string
  image: string
  approveLabel: string
  nextStep?: string
  approveStartsGeneration?: boolean
  onRetry(): void
  onApprove(): void
  onClose(): void
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return <div className="modal-backdrop reference-approval-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="reference-approval-modal" role="dialog" aria-modal="true" aria-labelledby="reference-approval-title">
      <header><div><span><Sparkles size={18} /></span><div><strong id="reference-approval-title">{title}</strong><small>{description}</small></div></div><button onClick={onClose} aria-label="Close reference review"><X size={18} /></button></header>
      <div className="reference-approval-preview"><img src={image} alt="Generated reference awaiting approval" /></div>
      <div className="reference-approval-status"><Check size={16} /><span><strong>Ready for review</strong><small>{nextStep ?? 'Approve to add this result to the reference library.'}</small></span></div>
      <footer><button className="secondary-button" onClick={onClose}>Keep current</button><button className="secondary-button generation-button" onClick={onRetry}><RefreshCw size={14} />Retry</button><button className={`primary-button ${approveStartsGeneration ? 'generation-button' : ''}`} autoFocus onClick={onApprove}><Check size={14} />{approveLabel}</button></footer>
    </section>
  </div>
}
