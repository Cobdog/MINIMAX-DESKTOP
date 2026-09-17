/** The location walkthrough as an H3 Ref2V request (canvas Phase 4, task
 * 6rymbx3 — the LTX-vs-H3 verdict's keep-utilities-only directive: the
 * general LTX-2.5 workspace greyed out; LocationStudio, its last LTX-only
 * consumer, migrates to MiniMax H3 reference-to-video).
 *
 * PURE module: the walkthrough prompt construction extracted verbatim from
 * the old App wiring (which built it inline for generateLtx), re-targeted at
 * lib/h3Submit's H3RenderRequest with the approved image as <Picture 1> —
 * the same shape a canvas fork with substrate=decoded produces. Covered by
 * scripts/test-canvas.cjs through the VM harness.
 */
import type { H3RenderRequest } from './h3Submit'
import type { LocationProject, MediaFile } from '../types'

/** The survey camera presets (the LocationStudio guided builder's set). */
export const WALKTHROUGH_CAMERAS = [
  { id: 'wide-reveal', name: 'Wide reveal', note: 'Establishing view, then slow reveal', prompt: 'Use only wide and extra-wide shots with an 18–24mm lens. Begin with a complete establishing view, then move slowly and smoothly to reveal the environment’s spatial relationships. Never use close-ups.' },
  { id: 'perimeter', name: 'Perimeter survey', note: 'Wide orbit around the location', prompt: 'Use only wide shots with a 20–24mm lens. Travel slowly around the outer perimeter in one continuous stabilized arc, keeping the whole environment readable while revealing each side and every major landmark. Never use close-ups.' },
  { id: 'high-survey', name: 'High survey', note: 'Wide descending overview', prompt: 'Use only wide aerial-style shots with a 20–24mm lens. Start high enough to read the complete geography, descend gradually, and finish in a broad eye-level establishing view while keeping all landmarks spatially consistent. Never use close-ups.' },
] as const

export type WalkthroughOptions = { duration?: number; cameraLanguage?: string }

/** The walkthrough direction text — verbatim the old App wiring's
 *  construction (environment-mode aware), shared by every surface.
 *  `cameraLanguage` is the full camera-direction text (the LocationStudio
 *  guided builder passes its survey preset verbatim). */
export function locationWalkthroughPrompt(project: Pick<LocationProject, 'name' | 'description' | 'atmosphere' | 'timeOfDay' | 'continuityAnchors' | 'visualStyle' | 'environmentMode'>, options: WalkthroughOptions = {}): string {
  const walkthroughDirection = project.environmentMode === 'nature'
    ? `Comprehensive cinematic natural-landscape survey of ${project.name}. Begin with a wide establishing view, then move slowly through the terrain in one continuous stabilized path. Deliberately reveal landforms, vegetation zones, water features, rock formations, horizon lines, and their spatial relationships. Preserve the exact terrain, ecology, vegetation placement, lighting, weather, and geography from the first frame. Untouched nature only: no buildings, cabins, houses, ruins, roads, streets, bridges, fences, signs, vehicles, power lines, utility poles, constructed paths, or other human-made objects.`
    : `Comprehensive cinematic location walkthrough reference video of ${project.name}. Begin with a wide establishing view, then move slowly along the perimeter in one continuous stabilized path. Deliberately pan through every important zone and spatial connection, revealing entrances, landmarks, surfaces, fixtures, terrain, and object placement. Preserve exactly the same architecture, dimensions, materials, lighting, weather, and geography from the first frame.`
  const locationProfile = [project.description, project.atmosphere && `Atmosphere and lighting: ${project.atmosphere}.`, project.timeOfDay && `Time and weather: ${project.timeOfDay}.`, project.continuityAnchors && `Fixed continuity anchors: ${project.continuityAnchors}.`, project.visualStyle && `Visual treatment: ${project.visualStyle}.`].filter(Boolean).join(' ')
  const cameraLanguage = options.cameraLanguage ?? WALKTHROUGH_CAMERAS[0].prompt
  const clarityDirection = 'Maintain crisp, sharp frames with a fast shutter and slow stabilized camera movement. No motion blur, temporal smearing, ghosting, rolling-shutter distortion, speed ramps, whip pans, or rapid camera movement.'
  return `${walkthroughDirection} Location description: ${locationProfile} Camera language: ${cameraLanguage} Image clarity: ${clarityDirection} No cuts, no teleporting, no layout changes, no duplicated objects, no people as focal subjects, no dialogue, no text, no logos.`
}

/** The H3 Ref2V request the walkthrough submits: the approved image rides
 *  <Picture 1> (reference mode), the direction is the composed prompt. The
 *  canvas equivalent is a substrate=decoded fork of the approved image with
 *  the image bound as a reference. */
export function locationWalkthroughRequest(
  project: Parameters<typeof locationWalkthroughPrompt>[0],
  approvedImage: MediaFile,
  seed: number,
  options: WalkthroughOptions = {},
): H3RenderRequest {
  return {
    mode: 'reference',
    prompt: locationWalkthroughPrompt(project, options),
    width: 1344,
    height: 768,
    duration: Math.max(2, Math.min(15, options.duration ?? 10)),
    seed,
    steps: 30,
    turbo: 'off',
    turboLoader: 'auto',
    experimentalSampling: false,
    loraStrength: 1,
    sampler: 'res_multistep',
    scheduler: 'simple',
    refImageSize: 'match',
    upscale: { mode: 'off', model: '', vae: '', lbhModel: '', missingNodes: [] },
    rtxModel: '',
    firstFrame: null,
    lastFrame: null,
    referenceImages: [approvedImage],
    referenceVideos: [],
    referenceAudios: [],
    timelineGuides: [],
    livePreview: { enabled: false, mode: 'standard' },
    filenamePrefix: 'video/MiniMax_location_walkthrough',
  }
}
