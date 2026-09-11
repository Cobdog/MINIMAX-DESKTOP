/** Trailing-debounce wrapper around a localStorage write, with a
 *  close/navigation flush so a normal page exit never loses the pending
 *  write. `persist(write)` replaces the pending write and restarts the timer,
 *  so whatever flushes — the timer, `pagehide`/`beforeunload`, or the final
 *  unmount cleanup — always runs the LATEST scheduled write, never a stale
 *  closure. A hard crash may lose up to `delayMs` of changes (accepted). */
import { useCallback, useEffect, useRef } from 'react'

export function useDebouncedPersist(delayMs: number) {
  const pendingWrite = useRef<(() => void) | null>(null)
  const timerRef = useRef(0)

  const flush = useCallback(() => {
    if (!pendingWrite.current) return
    const write = pendingWrite.current
    pendingWrite.current = null
    window.clearTimeout(timerRef.current)
    write()
  }, [])

  const persist = useCallback((write: () => void) => {
    pendingWrite.current = write
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(flush, delayMs)
  }, [delayMs, flush])

  useEffect(() => {
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
      flush()
    }
  }, [flush])

  return persist
}
