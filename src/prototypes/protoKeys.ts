/** Keyboard wiring for the prototypes: window-level keys that never fire
 *  while typing in a field. (Lives outside PrototypeShell.tsx so that file
 *  stays components-only for fast refresh.) */
import { useEffect } from 'react'

export function useProtoKeys(handler: (event: KeyboardEvent) => void) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
      handler(event)
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [handler])
}
