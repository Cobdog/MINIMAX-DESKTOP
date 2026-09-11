/**
 * OPFS blob cache (wave 2d): navigator.storage.getDirectory() backed key →
 * blob storage for content-derived artifacts — filmstrip sheets and captured
 * posters. The browser's HTTP cache already revalidates these by ETag; OPFS
 * keeps them reachable across sessions even when the HTTP cache evicts, and
 * lets paint skip the network on repeat views.
 *
 * Failure model: GRACEFUL NO-OP. OPFS is unavailable in some contexts
 * (private windows, old browsers, storage disabled). Every entry point
 * catches and degrades — getCachedBlob resolves null, putBlob resolves
 * without writing — so callers never need a fallback branch of their own.
 */

const directoryName = 'minimax-media-cache'
let directoryPromise: Promise<FileSystemDirectoryHandle | null> | null = null

/** Sanitizes a cache key into a single OPFS file name (the flat cache has no
 *  subdirectories; ':' and '/' are common in media keys and never legal in
 *  OPFS names on all platforms). */
function cacheFileName(key: string): string {
  let hash = 0
  for (let index = 0; index < key.length; index += 1) {
    hash = (Math.imul(31, hash) + key.charCodeAt(index)) | 0
  }
  return `blob-${Math.abs(hash).toString(36)}-${key.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-96)}`
}

function openCacheDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (!directoryPromise) {
    directoryPromise = (async () => {
      try {
        if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null
        return await navigator.storage.getDirectory().then((root) => root.getDirectoryHandle(directoryName, { create: true }))
      } catch {
        return null
      }
    })()
  }
  return directoryPromise
}

/** Resolves the cached blob for `key`, or null when absent/OPFS unavailable.
 *  Corrupt entries are deleted rather than returned — a half-written blob
 *  must never surface as a broken thumbnail. */
export async function getCachedBlob(key: string): Promise<Blob | null> {
  const directory = await openCacheDirectory()
  if (!directory) return null
  try {
    const handle = await directory.getFileHandle(cacheFileName(key))
    const file = await handle.getFile()
    if (file.size === 0) {
      await directory.removeEntry(cacheFileName(key)).catch(() => undefined)
      return null
    }
    return file
  } catch {
    return null
  }
}

/** Stores `blob` under `key`. Never throws; a failed write only costs the
 *  next read a network fetch. */
export async function putBlob(key: string, blob: Blob): Promise<void> {
  const directory = await openCacheDirectory()
  if (!directory) return
  try {
    const handle = await directory.getFileHandle(cacheFileName(key), { create: true })
    // createWritable() atomically swaps the file in on close() — a reader
    // mid-write keeps seeing the previous (complete) blob.
    const writable = await handle.createWritable()
    await writable.write(blob)
    await writable.close()
  } catch {
    /* Storage full or blocked: the HTTP cache still backs the artifact. */
  }
}
