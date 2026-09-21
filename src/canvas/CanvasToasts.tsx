/**
 * The shared toast strip (extracted from CanvasApp for R-21, Wave 3): the
 * canvas store's toasts are GLOBAL zustand state, and every surface that
 * mounts a store-acting panel (the settings dock, the library dock) needs
 * the strip visible or its notifications silently vanish. One component,
 * mounted by each surface alongside its docks.
 */
import { useCanvasStore } from './store'

export function CanvasToasts() {
  const toasts = useCanvasStore((state) => state.toasts)
  return <div className="canvas-toasts" aria-live="polite">
    {toasts.map((toast) => (
      <div key={toast.id} className={`canvas-toast ${toast.tone}`} data-canvas-toast={toast.tone}>
        <span>{toast.text}</span>
        <button type="button" aria-label="Dismiss" onClick={() => useCanvasStore.getState().dismissToast(toast.id)}>×</button>
      </div>
    ))}
  </div>
}
