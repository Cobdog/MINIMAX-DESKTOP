/**
 * React glue for filmstrip posters: loads the sprite sheet for an
 * output-contained path, cache-first through the OPFS blob cache. Returns
 * null until loaded or when no sheet exists — posters are progressive and
 * never block a view. (Lives outside the component file so React fast
 * refresh keeps working; views and PooledVideoCard share it.)
 */
import { useEffect, useState } from 'react'
import { fetchFilmstrip } from './httpPreview'
import type { Filmstrip } from './PreviewSource'

export function useFilmstrip(path: string | null | undefined, duration?: number): Filmstrip | null {
  const [filmstrip, setFilmstrip] = useState<Filmstrip | null>(null)
  useEffect(() => {
    let cancelled = false
    setFilmstrip(null)
    if (!path || !(duration && duration > 0)) return undefined
    void fetchFilmstrip(path, duration).then((loaded) => {
      if (cancelled) {
        if (loaded) URL.revokeObjectURL(loaded.url)
        return
      }
      setFilmstrip(loaded)
    })
    return () => {
      cancelled = true
      setFilmstrip((current) => {
        if (current) URL.revokeObjectURL(current.url)
        return null
      })
    }
  }, [path, duration])
  return filmstrip
}
