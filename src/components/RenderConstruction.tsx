import { LoaderCircle } from 'lucide-react'

export function RenderConstruction() {
  return <div className="construction-visual" aria-hidden="true">
    <div className="construction-orbit"><LoaderCircle size={22} /></div>
    <div className="construction-blocks">{Array.from({ length: 7 }, (_, index) => <i key={index} />)}</div>
  </div>
}
