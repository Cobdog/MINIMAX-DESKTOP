/**
 * Engine launch profiles (increment 2 of task 3ay7wbz). A profile is pure
 * data — { env, hooks, portPolicy } — that the RuntimeManager resolves at
 * launch: its env is injected into the spawn environment, its hook steps run
 * before the spawn (the consent-patch tier is the first hook kind), and its
 * reserved ports widen the allocator's skip-list.
 *
 * The seeded profiles are 'default' (stock launch, nothing extra) and 'vdn'
 * (the VDN optimization stack). The vdn profile deliberately carries NO env
 * by default: the ~20 upstream VDN_H3_* variables are lab/ablation toggles
 * read at runtime by the custom node, not launch requirements — the profile
 * exposes only the seam a user would actually set (research: task 8y09lhg
 * §1.2(b)). What the vdn stack DOES need beyond stock is the LongCache
 * block-loop patch, so the profile asks for it as a pre-launch hook; the
 * patch itself is consent-gated and version-gated and degrades gracefully
 * (VDN-proper works without LongCache) — see server/enginePatch.ts.
 *
 * Stored profiles are USER INPUT and validated hard here: env names must be
 * legal identifiers, and a blocklist of process-critical variables (PATH,
 * SYSTEMROOT, LD_PRELOAD, …) is refused rather than passed through — a
 * profile that broke the spawn path would brick the managed engine with a
 * confusing ENOENT instead of a clear refusal.
 */
import type { AppSettings, EngineLaunchProfile } from '../src/types'

/** Env vars a profile may never override: they decide process resolution and
 *  loading for the spawn itself, not the engine. */
const FORBIDDEN_ENV_KEYS = new Set([
  'PATH', 'PATHEXT', 'COMSPEC', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
  'LD_LIBRARY_PATH', 'LD_PRELOAD', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES',
  'PYTHONHOME', 'PYTHONEXECUTABLE', 'NODE_PATH',
])

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const ENV_VALUE_MAX_CHARS = 2_000
const MAX_PROFILE_VARS = 32

export const DEFAULT_PROFILE_ID = 'default'

/** The studio's seeded profiles. Stored user profiles overlay these by id;
 *  unknown stored ids are dropped (never executed). */
export const DEFAULT_ENGINE_PROFILES: Record<string, EngineLaunchProfile> = {
  default: {
    label: 'Default',
    description: 'Stock launch — no extra environment, no pre-launch hooks.',
    env: {},
    hooks: [],
    portPolicy: {},
  },
  vdn: {
    label: 'VDN',
    description: 'VDN optimization stack. Carries no environment by default (upstream VDN_H3_* variables are runtime lab toggles read by the node — set one here only if you mean it) and asks for the LongCache block-loop patch, which still requires your explicit consent and a layout-verified ComfyUI version.',
    env: {},
    hooks: [{ kind: 'patch', patchId: 'longcache-block-loop' }],
    portPolicy: {},
  },
}

export type ResolvedProfile = {
  id: string
  profile: EngineLaunchProfile
  /** Dropped env keys (forbidden or malformed) — surfaced, never silent. */
  droppedEnv: string[]
  /** Unknown hook patch ids in a stored profile — surfaced, never executed. */
  droppedHooks: number[]
  /** Set when the configured profile id does not exist (typo) — the launch
   *  falls back to the default profile and says so. */
  warning?: string
}

/** Validates one stored profile against the shape the runtime will execute.
 *  Anything malformed degrades to the corresponding stock field, with the
 *  damage reported — a corrupt settings file must not become a weird launch
 *  environment. */
export function normalizeStoredProfile(id: string, raw: unknown, knownPatchIds: ReadonlySet<string>): { profile: EngineLaunchProfile; droppedEnv: string[]; droppedHooks: number[] } {
  const base = DEFAULT_ENGINE_PROFILES[id] ?? { label: id, description: 'User-defined launch profile.', env: {}, hooks: [], portPolicy: {} }
  const source = (raw ?? {}) as Partial<EngineLaunchProfile>
  const droppedEnv: string[] = []
  const env: Record<string, string> = {}
  if (source.env && typeof source.env === 'object') {
    for (const [key, value] of Object.entries(source.env)) {
      // Reserved names are matched case-insensitively: overriding PATH/Path
      // alike would break the spawn resolution, not the engine.
      if (!ENV_NAME_PATTERN.test(key) || FORBIDDEN_ENV_KEYS.has(key.toUpperCase())) {
        droppedEnv.push(key)
        continue
      }
      if (Object.keys(env).length >= MAX_PROFILE_VARS) {
        droppedEnv.push(key)
        continue
      }
      env[key] = typeof value === 'string' ? value.slice(0, ENV_VALUE_MAX_CHARS) : String(value)
    }
  }
  const hooks: EngineLaunchProfile['hooks'] = []
  const droppedHooks: number[] = []
  if (Array.isArray(source.hooks)) {
    source.hooks.forEach((hook, index) => {
      if (hook && typeof hook === 'object' && (hook as { kind?: unknown }).kind === 'patch' && typeof (hook as { patchId?: unknown }).patchId === 'string' && knownPatchIds.has((hook as { patchId: string }).patchId)) {
        hooks.push({ kind: 'patch', patchId: (hook as { patchId: string }).patchId })
      } else {
        droppedHooks.push(index)
      }
    })
  }
  const reserve = Array.isArray(source.portPolicy?.reserve)
    ? source.portPolicy.reserve.filter((port): port is number => Number.isInteger(port) && port >= 1024 && port <= 65535).slice(0, 16)
    : base.portPolicy.reserve
  return {
    profile: {
      label: typeof source.label === 'string' && source.label.trim() ? source.label.trim().slice(0, 60) : base.label,
      description: typeof source.description === 'string' ? source.description.slice(0, 400) : base.description,
      env,
      hooks,
      portPolicy: reserve ? { reserve } : {},
    },
    droppedEnv,
    droppedHooks,
  }
}

/** Merges stored profiles over the seeds. Returns the validated record the
 *  settings keep, plus everything dropped (caller decides where to surface
 *  it — one log line; the Settings UI shows the surviving set only). */
export function mergeEngineProfiles(stored: unknown, knownPatchIds: ReadonlySet<string>): { profiles: Record<string, EngineLaunchProfile>; dropped: string[] } {
  const profiles: Record<string, EngineLaunchProfile> = {}
  const dropped: string[] = []
  const raw = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>
  const ids = new Set([...Object.keys(DEFAULT_ENGINE_PROFILES), ...Object.keys(raw)])
  for (const id of ids) {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-_.]{0,40}$/.test(id)) {
      dropped.push(`profile id "${id}"`)
      continue
    }
    const { profile, droppedEnv, droppedHooks } = normalizeStoredProfile(id, raw[id], knownPatchIds)
    profiles[id] = profile
    for (const key of droppedEnv) dropped.push(`${id}.env["${key}"]`)
    for (const index of droppedHooks) dropped.push(`${id}.hooks[${index}]`)
  }
  return { profiles, dropped }
}

/** Resolves the active profile for a launch: the configured id when it
 *  exists, else the default profile with a warning (a typo must never
 *  produce a silently stock launch). */
export function resolveActiveProfile(settings: AppSettings): ResolvedProfile {
  const configured = settings.engine.profile
  const profile = settings.engine.profiles[configured]
  if (profile) return { id: configured, profile, droppedEnv: [], droppedHooks: [] }
  return {
    id: DEFAULT_PROFILE_ID,
    profile: settings.engine.profiles[DEFAULT_PROFILE_ID] ?? DEFAULT_ENGINE_PROFILES[DEFAULT_PROFILE_ID],
    droppedEnv: [],
    droppedHooks: [],
    warning: `Launch profile "${configured}" does not exist — launching with the default profile.`,
  }
}
