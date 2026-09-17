/**
 * Dataset manager — media probing and ffmpeg/ffprobe process wrappers.
 * Every external process runs through runTool (bounded, logged, loud errors);
 * probes never mutate anything (the source is sacred).
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type ProbeFacts = {
  kind: 'video' | 'image'
  width: number
  height: number
  /** Container/stream-claimed fps (video only). */
  fps: number | null
  /** Container-claimed duration in seconds (video only). */
  durationSec: number | null
  hasAudio: boolean
  /** Mean loudness in dBFS when audio is present (ffmpeg volumedetect). */
  dbfs: number | null
  codec: string | null
  /** Container (format) name as ffprobe reports it, e.g. "mov,mp4…" or
   *  "matroska,webm" — the content truth behind a stored file extension. */
  container: string | null
}

export type ToolOptions = {
  ffmpegPath: string
  /** Failure logger seam (core.ts logFailure). */
  logFailure(stage: string, error: unknown, detail?: Record<string, unknown>): void
}

/** Runs a binary with args, capturing stdout; rejects on non-zero exit with
 * the captured tail (never a silent success). */
export function runTool(executable: string, args: string[], timeoutMs = 120_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${executable} timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${executable} exited ${code}: ${(stderr || stdout).slice(-2000)}`))
    })
  })
}

function ffprobePath(ffmpegPath: string): string {
  return ffmpegPath.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1')
}

type FfprobeStream = {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  duration?: string
  nb_frames?: string
}

/** Probes a media file's facts (ffprobe + volumedetect for audio). */
export async function probeMedia(path: string, options: ToolOptions): Promise<ProbeFacts> {
  const probe = ffprobePath(options.ffmpegPath)
  const { stdout } = await runTool(probe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path], 60_000)
  const parsed = JSON.parse(stdout) as { streams?: FfprobeStream[]; format?: { duration?: string; format_name?: string } }
  const streams = parsed.streams ?? []
  const video = streams.find((stream) => stream.codec_type === 'video')
  const image = video && !video.avg_frame_rate?.includes('/') === false ? video : video // single fallthrough below
  void image
  if (!video) throw new Error('No video stream found — the file is not consumable media.')
  const audio = streams.find((stream) => stream.codec_type === 'audio')
  const width = video.width ?? 0
  const height = video.height ?? 0
  const rate = parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate)
  const duration = Number(video.duration ?? parsed.format?.duration ?? 'NaN')
  // A single-frame "video" stream (png/jpg in an image container, or a
  // one-frame mp4) is a STILL for every floor/rule that matters.
  const nbFrames = video.nb_frames ? Number(video.nb_frames) : NaN
  const isStill = (video.codec_name && ['mjpeg', 'png', 'webp', 'bmp', 'gif', 'tiff', 'jpeg'].includes(video.codec_name)) || (!Number.isNaN(nbFrames) && nbFrames <= 1) || (!Number.isNaN(duration) && duration > 0 && duration < 0.04)
  let dbfs: number | null = null
  if (audio) {
    try {
      const { stderr } = await runTool(options.ffmpegPath, ['-hide_banner', '-i', path, '-af', 'volumedetect', '-f', 'null', '-'], 60_000)
      const match = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(stderr)
      dbfs = match ? Number(match[1]) : null
    } catch { /* volumedetect is advisory; a failed pass must not fail import */ }
  }
  return {
    kind: isStill ? 'image' : 'video',
    width,
    height,
    fps: isStill ? null : rate,
    durationSec: isStill ? null : (Number.isNaN(duration) ? null : duration),
    hasAudio: Boolean(audio),
    dbfs,
    codec: video.codec_name ?? null,
    container: parsed.format?.format_name ?? null,
  }
}

/** Content-truth stored extension for an upload (security wave 2, LOW-3):
 *  the extension comes from what ffprobe measured in the BYTES (container,
 *  then codec), never from the client-chosen filename — a polyglot upload
 *  named payload.sh lands in the media store as payload….mp4/.jpg. The few
 *  kinds the media-serving mime map lacks (.tiff/.gif) still carry their
 *  true extension and serve as octet-stream. Pure. */
export function uploadExtensionFor(probe: ProbeFacts): string {
  const containers = probe.container ?? ''
  const names = containers.split(',').map((name) => name.trim().toLowerCase())
  const videoContainerExtensions: Array<[string, string]> = [
    ['mp4', '.mp4'], ['mov', '.mov'], ['webm', '.webm'], ['matroska', '.mkv'], ['avi', '.avi'],
  ]
  const imageCodecExtensions: Array<[string, string]> = [
    ['png', '.png'], ['mjpeg', '.jpg'], ['jpeg', '.jpg'], ['webp', '.webp'], ['bmp', '.bmp'], ['tiff', '.tiff'], ['gif', '.gif'],
  ]
  const codec = (probe.codec ?? '').toLowerCase()
  if (probe.kind === 'image') {
    for (const [name, extension] of imageCodecExtensions) if (names.includes(name) || codec === name) return extension
    return '.jpg'
  }
  for (const [name, extension] of videoContainerExtensions) if (names.includes(name)) return extension
  for (const [name, extension] of imageCodecExtensions) if (codec === name) return extension
  return '.mp4'
}

function parseRate(raw: string | undefined): number | null {
  if (!raw) return null
  const match = /^(\d+)\/(\d+)$/.exec(raw)
  if (!match) return null
  const denominator = Number(match[2])
  if (!denominator) return null
  const value = Number(match[1]) / denominator
  return Number.isFinite(value) && value > 0 ? value : null
}

/** Decoded frame count — the f56 trap's antidote. Full decode via ffprobe
 * -count_frames (slow, runs as the async background probe). */
export async function decodedFrameCount(path: string, options: ToolOptions): Promise<number> {
  const probe = ffprobePath(options.ffmpegPath)
  const { stdout } = await runTool(probe, ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', path], 600_000)
  const value = Number(stdout.trim())
  if (!Number.isFinite(value) || value < 0) throw new Error(`ffprobe reported no decoded frame count for ${path}`)
  return Math.round(value)
}

export type ExtractedFrame = { index: number; atSec: number; bytes: Buffer }

/** N-even frame extraction at ~2 fps (the spec's default VLM frame strategy:
 * family-agnostic, dodges the llama.cpp >10 s hang class). Returns JPEG bytes
 * in presentation order, downscaled to fit `maxEdge` (token economy). */
export async function extractFramesEvenly(
  path: string,
  options: ToolOptions,
  config: { durationSec: number; fromSec?: number; fps?: number; maxEdge?: number; maxFrames?: number },
): Promise<ExtractedFrame[]> {
  const fps = config.fps ?? 2
  const maxEdge = config.maxEdge ?? 448
  const maxFrames = config.maxFrames ?? 32
  const from = Math.max(0, config.fromSec ?? 0)
  const count = Math.max(1, Math.min(maxFrames, Math.round(config.durationSec * fps)))
  const times: number[] = []
  for (let index = 0; index < count; index += 1) {
    times.push(from + Math.min(config.durationSec * (index + 0.5) / count, Math.max(0, config.durationSec - 0.02)))
  }
  return extractFramesAt(path, options, times, maxEdge)
}

/** Extracts frames at exact timestamps (first/mid/last, chunk edges, or the
 * N-even set). One ffmpeg invocation per timestamp — accurate and simple. */
export async function extractFramesAt(path: string, options: ToolOptions, times: number[], maxEdge = 448): Promise<ExtractedFrame[]> {
  const dir = await mkdtemp(join(tmpdir(), 'ds-frames-'))
  try {
    const frames: ExtractedFrame[] = []
    for (let index = 0; index < times.length; index += 1) {
      const out = join(dir, `f${String(index).padStart(4, '0')}.jpg`)
      await runTool(options.ffmpegPath, ['-y', '-ss', times[index].toFixed(3), '-i', path, '-frames:v', '1', '-vf', `scale='min(${maxEdge},iw)':-2`, '-q:v', '4', out], 120_000)
      const bytes = await readFile(out)
      frames.push({ index, atSec: times[index], bytes })
    }
    return frames
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Raw grayscale pixels of a downscaled frame — the tier-1 perceptual hash
 * and the perceptual embedder both run on these (pure Node, no image deps). */
export async function extractGrayPixels(path: string, options: ToolOptions, atSec: number, size: number): Promise<Float32Array> {
  const dir = await mkdtemp(join(tmpdir(), 'ds-gray-'))
  try {
    const out = join(dir, 'gray.raw')
    // stretch (not preserve-aspect) is what makes the hash RATIO-INVARIANT:
    // cross-ratio variants of the same content hash identically.
    await runTool(options.ffmpegPath, ['-y', '-ss', atSec.toFixed(3), '-i', path, '-frames:v', '1', '-vf', `scale=${size}:${size},format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', out], 120_000)
    const bytes = await readFile(out)
    const pixels = new Float32Array(size * size)
    for (let index = 0; index < pixels.length && index < bytes.length; index += 1) pixels[index] = bytes[index]
    return pixels
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Decodes a poster/thumbnail JPEG for the gallery (a representative frame). */
export async function extractPoster(path: string, options: ToolOptions, atSec: number, maxEdge = 320): Promise<Buffer> {
  const frames = await extractFramesAt(path, options, [atSec], maxEdge)
  if (!frames.length) throw new Error('The poster frame could not be extracted.')
  return frames[0].bytes
}

/** Lists one file per directory entry — helper for tests/scale fixtures. */
export async function listDir(path: string): Promise<string[]> {
  return readdir(path)
}
