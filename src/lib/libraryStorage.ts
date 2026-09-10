export const STORAGE_ERROR_EVENT = 'minimax-storage-error'

export type StorageErrorDetail = { key: string; message: string }

/** Serializes without inline data-URL previews — the degraded but
 *  reconstructible shape used to retry after a quota failure. */
function scrubbedJson(value: unknown): string {
  return JSON.stringify(value, (key, contents) => (key === 'preview' && typeof contents === 'string' && contents.startsWith('data:')) ? undefined : contents)
}

function report(detail: StorageErrorDetail) {
  window.dispatchEvent(new CustomEvent(STORAGE_ERROR_EVENT, { detail }))
}

/** Persists a value to localStorage, surviving quota exhaustion. On the first
 *  failure it retries once with inline data-URL previews scrubbed (they are
 *  multi-megabyte base64 images reconstructible from their file paths); only a
 *  second failure is reported, via STORAGE_ERROR_EVENT, which App.tsx surfaces
 *  as a user-visible notice instead of an uncaught throw during render. */
export function persistToLocalStorage(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    try {
      localStorage.setItem(key, scrubbedJson(value))
    } catch (error) {
      report({ key, message: error instanceof Error ? error.message : String(error) })
      return false
    }
    report({ key, message: 'Saved without inline image previews to stay within browser storage limits.' })
    return true
  }
}
