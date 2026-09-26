import type { MediaFile } from '../types'

export const defaultCrop = { x: 0.5, y: 0.5, zoom: 1, fit: 'crop' as const }
export const defaultCharacterCrop = { x: 0.5, y: 0.5, zoom: 1, fit: 'contain' as const }

export function fitWholeCharacter(file: MediaFile): MediaFile {
  return file.crop ? file : { ...file, crop: { ...defaultCharacterCrop } }
}

export function cropRect(sw: number, sh: number, width: number, height: number, crop = defaultCrop as NonNullable<MediaFile['crop']>) {
  const scale = Math.max(width / sw, height / sh) * Math.max(1, crop.zoom)
  const w = width / scale
  const h = height / scale
  return { x: Math.max(0, sw - w) * Math.max(0, Math.min(1, crop.x)), y: Math.max(0, sh - h) * Math.max(0, Math.min(1, crop.y)), w, h }
}

export async function drawPreparedImage(canvas: HTMLCanvasElement, file: MediaFile, width: number, height: number) {
  if (!file.preview) throw new Error(`No preview available for ${file.name}. Choose the image again.`)
  const img = new Image()
  img.src = file.preview
  await img.decode()
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, height)
  ctx.imageSmoothingQuality = 'high'
  const crop = file.crop ?? defaultCrop
  if (crop.fit === 'contain') {
    const scale = Math.min(width / img.naturalWidth, height / img.naturalHeight)
    const w = img.naturalWidth * scale, h = img.naturalHeight * scale
    ctx.drawImage(img, (width - w) / 2, (height - h) / 2, w, h)
  } else {
    const rect = cropRect(img.naturalWidth, img.naturalHeight, width, height, crop)
    ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, width, height)
  }
}

export async function prepareImage(file: MediaFile, width: number, height: number) {
  const canvas = document.createElement('canvas')
  await drawPreparedImage(canvas, file, width, height)
  return canvas.toDataURL('image/png')
}

/** The reference-prep scale (maintainer ruling 2026-09-26, directive 1e363ec0
 *  item 5): the reference's LONGEST edge scales to the selected resolution's
 *  longest side; the aspect ratio is preserved exactly. Pure — the unit suite
 *  asserts the ruling here (a 2:1 portrait at a 16:9 resolution → 672x1344:
 *  longest side matched, AR kept, zero crop). */
export function referenceScale(sw: number, sh: number, targetLongestSide: number) {
  const safeTarget = Number.isFinite(targetLongestSide) && targetLongestSide > 0 ? targetLongestSide : Math.max(sw, sh)
  const scale = safeTarget / Math.max(sw, sh)
  return { width: Math.max(1, Math.round(sw * scale)), height: Math.max(1, Math.round(sh * scale)) }
}

/** A stored crop's zoom/pan selects a REGION of the reference (an
 *  aspect-PRESERVING window: the region keeps the image's own ratio), never
 *  a cover-crop to a target ratio. The fit mode is ignored on the reference
 *  path — 'contain' letterboxing is exactly what the ruling retires. */
export function referenceRegion(sw: number, sh: number, crop = defaultCrop as NonNullable<MediaFile['crop']>) {
  const zoom = Math.min(8, Math.max(1, Number.isFinite(crop.zoom) ? crop.zoom : 1))
  const w = sw / zoom
  const h = sh / zoom
  return { x: Math.max(0, sw - w) * Math.max(0, Math.min(1, crop.x)), y: Math.max(0, sh - h) * Math.max(0, Math.min(1, crop.y)), w, h }
}

/** Paints a reference: the full extent (or the crop's zoom region) with its
 *  longest edge at targetLongestSide. Never cropped to a target ratio, never
 *  letterboxed — the engine's conditioning takes unconstrained IMAGE refs
 *  and scales them itself (MiniMaxH3ReferenceToVideo ref_image_size), so the
 *  true aspect is exactly what it wants to see. */
export async function drawReferenceImage(canvas: HTMLCanvasElement, file: MediaFile, targetLongestSide: number) {
  if (!file.preview) throw new Error(`No preview available for ${file.name}. Choose the image again.`)
  const img = new Image()
  img.src = file.preview
  await img.decode()
  const region = referenceRegion(img.naturalWidth, img.naturalHeight, file.crop ?? defaultCrop)
  const target = referenceScale(region.w, region.h, targetLongestSide)
  canvas.width = target.width
  canvas.height = target.height
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, region.x, region.y, region.w, region.h, 0, 0, target.width, target.height)
}

export async function prepareReferenceImage(file: MediaFile, targetLongestSide: number) {
  const canvas = document.createElement('canvas')
  await drawReferenceImage(canvas, file, targetLongestSide)
  return canvas.toDataURL('image/png')
}
