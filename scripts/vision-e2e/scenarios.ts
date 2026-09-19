import { existsSync } from 'node:fs'
import http from 'node:http'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { WebSocketServer } from 'ws'

/** A real decodable 64x36 JPEG (a teal→warm diagonal gradient with a
 *  bright horizontal band) — the fake engine's sampler-preview frame
 *  payload. Deliberately STRUCTURED: a 1x1 frame painted uniformly dark and
 *  the first judged capture read the painted tile as "black/empty" (the
 *  DOM-truth assertion had proven it decoded). A visible gradient is
 *  judge-legible evidence of the paint. */
function frameJpeg(): Buffer {
  return Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAAkAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCGO496sR3HvVpPA/i4ddJ/8mIv/iqmTwV4sHXSv/JiL/4qvosXm+Vy2xNP/wADj/mfD4XJsXHelL/wF/5FaO496sJce9Tp4N8VDrpf/kxH/wDFVKnhDxQOumf+R4//AIqvmsXj8BLatD/wJf5n0uFy2tHeD+5kUdx71YjuPenp4T8TDrpv/keP/wCKqVPC3iMddO/8jR//ABVfM4vEYWW1SP3o+kwuEcd0JHce9WI7j3pE8M+IR10//wAjR/8AxVTJ4c18dbH/AMjJ/wDFV81i/ZS2kvvPpMLTpx3aJB8XvDR/5c9W/wC/Uf8A8XTx8WvDZ/5c9V/79R//ABdfP0dx71PHce9fs+I8N8np/DGX/gR8Dh84xtTdr7j30fFbw6f+XTVP+/Uf/wAXTx8UvDx/5dNT/wC/af8AxdeDx3HvU6XHvXhYjgfLaeyf3nuYfEV6m57oPidoB6Wupf8AftP/AIunD4laCf8Al11H/v2n/wAXXiKXHvU6XHvXg4jhfB09k/vPdw9B1Nz2ofEbQz/y7ah/37T/AOKp4+IWiH/l3v8A/v2n/wAVXjUdx71PHce9eFiMno09rnuYfKaVTe55zG7etTxu3rRRX9P4xH5Hg1sWEdvWp43b1oor5TGH1ODWxYjduOanjdvWiivlcYj6rBosI7etTxu3rRRXymMR9Vg0f//Z', 'base64')
}

/**
 * Vision-capture scenarios — CAPTURE ONLY, no judgment here.
 *
 * Each scenario drives the real app (engine-independent: navigation and
 * composer state only, the same surface the e2e suite exercises) and defines
 * one or more CHECKPOINTS. A checkpoint pairs a screenshot moment with a
 * RUBRIC: the written contract a vision judge (see scripts/vision-e2e/JUDGE.md)
 * verifies the captured PNG against. Rubrics are DATA — they are copied
 * verbatim into the bundle's manifest.json, so a bundle is fully
 * self-describing: image + expected contract, in one directory.
 *
 * Rubric discipline:
 *  - Encode the CURRENT intended design only — every clause below was
 *    verified against a real capture of the live UI at 1920x1080.
 *  - State what must be present AND explicitly bless the intended design
 *    choices a generic "defect hunt" would misread (dimmed disabled
 *    controls offline, dense muted sub-labels, ellipsized status tiles) so
 *    the judge does not flag the design language as bugs.
 *  - Never claim dynamic content you cannot control (engine/LLM state,
 *    harvested community prompts, persisted counts).
 *
 * Adding a scenario: append here, then `pnpm test:vision` (capture) → judge
 * → `pnpm vision:report`. Nothing else to wire.
 */

export type VisionCheckpoint = {
  /** Stable identifier — used in filenames, verdicts.json keys, and reports. */
  id: string
  label: string
  /** The expected contract the judge applies to this checkpoint's PNG. */
  rubric: string
  /** Optional per-checkpoint driver (added with the datasets-workbench
   *  scenario, sv14rt0): runs BEFORE this checkpoint's capture so ONE
   *  scenario can present several distinct states. Absent on every
   *  pre-existing scenario — the capture loop screenshots the state run()
   *  left, exactly as before. */
  drive?: (page: Page) => Promise<void>
}

export type VisionScenario = {
  id: string
  label: string
  /** Drives the app to the checkpoint state. Navigation-only, no engine. */
  run: (page: Page) => Promise<void>
  /** Optional cleanup so the shared test-home stays deterministic. */
  after?: (page: Page) => Promise<void>
  checkpoints: VisionCheckpoint[]
}

/** Chrome shared by every rubric: the intended look of the app — the CANVAS
 *  world since Phase 5 (the old shell is deleted: no left sidebar, no nav
 *  groups, no retirement badges — their absence is the design, not a
 *  regression).
 *
 *  Rubric amendment (2026-09-17, Phase 5b): the titlebar gained a "timeline
 *  V" projection button BEFORE "library V" (the §7 V-flip family grew — V now
 *  cycles timeline → library); and the Studios dock lost its Movie tab
 *  (MoviePlanner retired — plan documents + the timeline projection are the
 *  planning surface).
 *
 *  Rubric amendment (2026-09-18, QOL wave rrxlw2r): the titlebar now LEADS
 *  with the shared surface switcher — a compact bordered pill group ("canvas"
 *  and "datasets" today; more surfaces appear as they register) with the
 *  ACTIVE surface highlighted; it sits BEFORE the canvas tabs. The empty-
 *  canvas launcher may additionally carry a first-run onboarding notice (see
 *  the canvas-default-boot rubric). */
const SHELL_CONTEXT = [
  'Context for every clause: a dark-theme desktop studio app at 1920x1080 whose ONLY surface is a video canvas — a slim top titlebar over a near-black dotted-grid infinite canvas. There is NO left sidebar and NO grouped navigation: the old shell was deleted (Phase 5); do not flag its absence.',
  'Top titlebar (slim): FIRST a compact surface-switcher pill group — small linked pills reading "canvas" and "datasets" with the active surface highlighted inside a thin rounded border (QOL wave 2026-09-18) — then canvas tabs (a named tab like "Canvas <date>" with an × affordance), a pill-shaped radar button (reading "calm" or a queue count), a muted "engine offline" chip — the engine being offline in tests is CORRECT, not a defect — then small "timeline V", "library V", "studios", "diagnostics", "settings", "index ⌘K" buttons at the right.',
  'A slim contextual bottom bar spans the canvas foot; a small object counter may sit bottom-right.',
  'Dimmed/disabled controls and small muted sub-labels are the app\'s intentional dense design language, NOT contrast defects — only flag text that is genuinely unreadable against its immediate background.',
].join(' ')

export const SCENARIOS: VisionScenario[] = [
  {
    // QOL wave (rrxlw2r) — the shared surface switcher: registry-driven nav
    // chrome in BOTH titlebars. DOM truth asserted before each capture: the
    // registered surfaces (canvas + datasets + images — k9vu6t0 appended the images entry), the active one marked.
    id: 'surface-switcher',
    label: 'Surface switcher — registry-driven nav in both titlebars (QOL wave)',
    run: async (page) => {
      await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } })
      await page.goto('/')
      await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
      const switcher = page.locator('[data-surface-switcher]')
      await expect(switcher).toBeVisible()
      // k9vu6t0: the images workbench appended its registry entry — three now.
      await expect(switcher.locator('[data-surface]')).toHaveCount(3)
      await expect(switcher.locator('[data-surface="canvas"]')).toHaveAttribute('aria-current', 'page')
      await page.waitForTimeout(400)
    },
    checkpoints: [
      {
        id: 'surface-switcher-canvas-1080p',
        label: 'Canvas titlebar — the surface switcher leads (canvas active)',
        rubric: [
          SHELL_CONTEXT,
          'The titlebar\'s LEFT EDGE carries the surface switcher: a compact rounded-border pill group with three linked pills — "canvas" (with a small frame icon, highlighted as the active surface: brighter text on a raised background with a thin inner outline), "datasets" (with a small database icon, muted), and "images" (with a small image icon, muted — the H3 Image Workbench entry, k9vu6t0). It sits BEFORE the canvas tabs and must not overlap them.',
          'The switcher reads as one coherent control: same pill height, consistent 12px-scale labels, hover affordance is fine. Muted-but-readable labels are the app\'s dense design language — not a contrast defect.',
          'Defects to flag: pills of visibly different heights or misaligned baselines, the group overlapping the canvas tabs or radar, a pill clipped by the viewport edge, an ACTIVE state that is indistinguishable from the inactive one at a glance.',
        ].join(' '),
        // DOM truth at capture: this checkpoint's PNG is the CANVAS state
        // run() left (the datasets navigation is the NEXT checkpoint's
        // drive — drives run BEFORE their own capture).
        drive: async (page) => {
          await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
          await expect(page.locator('[data-surface-switcher] [data-surface="canvas"]')).toHaveAttribute('aria-current', 'page')
        },
      },
      {
        id: 'surface-switcher-datasets-1080p',
        label: 'Datasets titlebar — the same switcher, datasets active (no one-way back link)',
        rubric: [
          'Context: a dark-theme desktop studio app at 1920x1080 on the datasets surface — a full-screen workbench, NOT the canvas: no dotted-grid infinite canvas, no canvas tabs.',
          'The titlebar leads with "Dataset manager" brand text (database icon), immediately followed by the SAME surface-switcher pill group seen on the canvas titlebar — here "datasets" is the highlighted/active pill; "canvas" and "images" are the muted links ("images" opens the H3 Image Workbench, k9vu6t0). There is NO "← canvas" text link anymore (replaced by the switcher — its absence is the design, not a regression).',
          'Tab pills (library active, dashboard, export, trash) sit to the right of the switcher without overlap.',
          'Defects to flag: the switcher missing from this titlebar, both pills looking active or both muted, overlap between the switcher and the brand text or tab pills.',
        ].join(' '),
        drive: async (page) => {
          await page.locator('[data-surface-switcher] [data-surface="datasets"]').click()
          await expect(page.locator('[data-ds-root]')).toBeVisible()
          const switcher = page.locator('[data-surface-switcher]')
          await expect(switcher.locator('[data-surface="datasets"]')).toHaveAttribute('aria-current', 'page')
          await page.waitForTimeout(400)
        },
      },
    ],
    after: async (page) => {
      await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } }).catch(() => undefined)
    },
  },
  {
    // Canvas Phase 5 (task 7mcp11b) — the required NEW scenario: the app's
    // DEFAULT boot (no ?canvas param) is the canvas. The empty canvas IS the
    // launcher (§4): prompt bar + drop zone + chips + resume cards.
    id: 'canvas-default-boot',
    label: 'Canvas Phase 5 — default boot (no param): the launcher at 1080p',
    run: async (page) => {
      await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } })
      await page.goto('/')
      await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
      await page.waitForTimeout(500)
    },
    after: async (page) => {
      await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } }).catch(() => undefined)
    },
    checkpoints: [
      {
        id: 'canvas-default-boot-1080p',
        label: 'Canvas — default-boot launcher fully visible at 1920x1080 (no old shell anywhere)',
        rubric: [
          SHELL_CONTEXT,
          'Center of the canvas: a centered launcher block. Its TOP may carry the first-run onboarding notice (QOL wave 2026-09-18): a dashed-blue-bordered card titled "No models found — one setup step before the first render." with two small buttons ("Open settings — model locations", "Browse fetchable items") and an × dismiss — INTENDED guidance on the models-empty test home, never a defect. Below it a large heading "A blank canvas", a one-line subtitle mentioning describing a shot or dropping anything, and below it the PROMPT BAR — a wide dark rounded textarea (placeholder mentioning "/" to focus and Enter to spawn) with a submit button at its right reading "Spawn video seed" with a small video icon.',
          'Below the prompt bar, a CHIP ROW of small rounded pill buttons, at minimum: "image prompt", "video prompt" (one of these highlighted as the active media type), "noDialogue handoff", "drop / pick media", "Music 3", "ACE-Step", "prompt library", "studios", and "movie plan" — each with a small icon. All chips must sit fully inside the viewport with readable labels.',
          'A "Resume" section below the chips: a header row with the word "Resume" and a "new canvas" button, then either recent-canvas cards (name + date, any count) or the muted line "No other canvases yet — the first prompt creates one." — either state is correct.',
          'NO left sidebar, NO grouped navigation (Create / Queue / Library / Clip editor), NO "retired" pills anywhere — the old shell is deleted by design; any of those appearing is a REGRESSION, flag it.',
          'Defects to flag: overlapping titlebar controls, the prompt bar or chips clipped by the viewport, unreadable text mid-glyph, a pure-white or pure-black dead region covering the surface.',
        ].join(' '),
      },
    ],
  },
  {
    id: 'settings-llm-fallback',
    label: 'Settings dock — LLM router fallback state',
    run: async (page) => {
      await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } })
      await page.goto('/')
      await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
      // Phase 5: Settings is a docked floating panel opened from the
      // titlebar (the old route died with the shell).
      await page.locator('[data-canvas-settings-button]').click()
      await expect(page.locator('[data-canvas-settings-dock]')).toBeVisible()
      const llmSection = page.locator('.llm-section')
      await expect(llmSection).toBeVisible()
      // The dock body scrolls INSIDE the panel — bring the card into view.
      await llmSection.scrollIntoViewIfNeeded()
      await page.waitForTimeout(400)
    },
    after: async (page) => {
      const close = page.locator('[data-canvas-settings-close]')
      if (await close.count()) await close.click().catch(() => undefined)
    },
    checkpoints: [
      {
        id: 'settings-llm-fallback-1080p',
        label: 'Settings dock — "LLM · llama.cpp router" card in its provider-empty fallback state',
        rubric: [
          SHELL_CONTEXT,
          'A floating Settings DOCK panel over the dimmed canvas: a header strip reading "Settings — docked" with a gear icon and an × close button, and a scrollable body of section cards. The body scrolls INSIDE the panel and this capture is taken with the LLM card scrolled into view — sections above it MAY sit above the visible fold (intended scrolling, not clipping; judge only what is in frame).',
          'The "LLM · llama.cpp router" card is in frame with: title "LLM · llama.cpp router" and its explanatory sub-line; a health pill reading "Ollama fallback" (NOT "online"/"connected"/"Router · N models" — no router is configured in tests, so an online-looking pill is a bug); a labeled "Router address (router mode)" input that is EMPTY (its placeholder mentions 127.0.0.1:8080 and the Ollama fallback); a "Test connection" button.',
          'Below those: the card\'s grid of controls — checkbox rows "Unload models before generating" (checked) and "Thinking by default (freeform)" (unchecked), a "Prompt writing style" dropdown, a "Sticky models (never unload)" input, and a closing note line mentioning that nothing leaves the workstation.',
          'NO model rows: zero model ids/names listed as selectable rows in this card (phantom models with no provider behind them are a bug). A "no models / not reachable" status line is acceptable.',
          'Defects to flag: pill showing a connected state, a filled router address, model rows present, the dock clipped by the viewport edges, overlapping controls, truncated section headers.',
        ].join(' '),
      },
    ],
  },
  {
    id: 'library-empty',
    label: 'Library projection — empty state (V)',
    run: async (page) => {
      // The shared test-home database persists across runs (earlier e2e
      // seeds completed jobs and canvas documents through the storage API,
      // which has no delete route). For a deterministic EMPTY-state capture,
      // clear the jobs table directly in SQLite (WAL mode — safe alongside
      // the running server) and close the canvas session so no documents are
      // loaded — the projection lists takes across LOADED canvases only.
      const databaseFile = resolve('test-home/studio.db')
      if (existsSync(databaseFile)) {
        const db = new Database(databaseFile)
        try {
          db.exec('DELETE FROM jobs')
        } finally {
          db.close()
        }
      }
      await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } })
      await page.goto('/')
      await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
      // The titlebar library button (stable entry — V cycles the family
      // since Phase 5b: timeline first).
      await page.locator('[data-canvas-library-button]').click()
      await expect(page.locator('[data-canvas-library]')).toBeVisible()
      await page.waitForTimeout(400)
    },
    after: async (page) => {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
    },
    checkpoints: [
      {
        id: 'library-empty-1080p',
        label: 'Library projection — summoned overlay in its empty state',
        rubric: [
          SHELL_CONTEXT,
          'A modal-ish overlay panel floats centered over a dimmed canvas: a search input row at its top — a search field (placeholder about completed outputs across the session), four small filter chips reading "all", "video", "image", "audio", and an × close button at the right.',
          'The body is the EMPTY state: a single muted centered line reading "Completed outputs appear here — every take is a canvas object.".',
          'A thin footer bar at the panel\'s bottom: "0 of 0 outputs" at the left and a note line at the right mentioning "V cycles" (timeline → library → canvas) and the no-silent-failure contract.',
          'NO result rows, thumbnails, cards, or skeleton loaders anywhere in the panel.',
          'Defects to flag: any result row present, the overlay not centered or clipped by the viewport, overlapping controls, truncated labels.',
        ].join(' '),
      },
    ],
  },
  {
    // Canvas Phase 5b (task 2u0rent) — the required NEW scenario: the
    // Director Suite's timeline projection with the MEASURED gap menu open.
    // UI-driven: a real plan document is created through the overlay, two
    // segments authored, and the gap between them opens the transition menu.
    id: 'timeline-gap-menu',
    label: 'Director Suite — the timeline projection + the measured gap menu (V)',
    run: async (page) => {
      await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } })
      await page.goto('/')
      await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
      // V opens the timeline first (the §7 flip family, Phase 5b).
      await page.keyboard.press('v')
      const overlay = page.locator('[data-canvas-timeline]')
      await expect(overlay).toBeVisible()
      await overlay.locator('[data-canvas-timeline-new-plan]').click()
      await expect(overlay.locator('[data-canvas-plan-brief]')).toBeVisible({ timeout: 10_000 })
      await overlay.locator('[data-canvas-plan-add-segment]').click()
      await overlay.locator('[data-canvas-plan-add-segment]').click()
      await expect(overlay.locator('[data-canvas-segment]')).toHaveCount(2)
      await overlay.locator('[data-canvas-segment-prompt]').nth(0).fill('the drummer steps off the night train into the rain')
      await overlay.locator('[data-canvas-segment-prompt]').nth(0).blur()
      await overlay.locator('[data-canvas-segment-prompt]').nth(1).fill('the corridor lights stutter as she passes')
      await overlay.locator('[data-canvas-segment-prompt]').nth(1).blur()
      await page.waitForTimeout(400)
      await overlay.locator('[data-canvas-gap]').first().click()
      await expect(overlay.locator('[data-canvas-gap-menu]')).toBeVisible()
      await page.waitForTimeout(400)
      // DOM truth at capture time (2026-09-17, cleanup wave twmpu4m): the
      // seeded prompts MUST be in the textareas when the frame is taken —
      // pixel-verified that the raster carries them (859/344 lit px at the
      // exact rects), but they render at 9px in dark boxes and FOUR vision
      // reads called them empty. This assertion makes a real regression LOUD
      // (a failed capture) instead of judge-dependent.
      const seededPrompts = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-canvas-segment-prompt]')).map((node) => node.value))
      if (seededPrompts.length !== 2 || !seededPrompts[0]!.includes('drummer') || !seededPrompts[1]!.includes('corridor')) {
        throw new Error(`timeline-gap-menu capture: the seeded prompts are not in the DOM at capture time (got ${JSON.stringify(seededPrompts)})`)
      }
    },
    after: async (page) => {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(150)
      await page.keyboard.press('Escape')
      await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } }).catch(() => undefined)
    },
    checkpoints: [
      {
        id: 'timeline-gap-menu-1080p',
        label: 'Director Suite — timeline overlay with the measured transition menu open over a two-segment plan',
        rubric: [
          SHELL_CONTEXT,
          'A wide modal-ish overlay panel floats over the dimmed canvas: a header row reading "Timeline — plan (2 segments)" with a small total note ("2 items · 12s planned"), a "+ New plan" pill button, and an × close at the right.',
          'Below the header, a horizontal STRIP: two segment cards (titled "Segment 1" and "Segment 2", each with a muted placeholder icon area and a meta line reading "no object · 6s") separated by ONE dashed gap chip reading "Hard cut" with a small uppercase "assembly" sub-label.',
          'Over the strip, a transition MENU popover is open, titled "Transition" with an × close: FIVE stacked option cards, each with a bold name, a small uppercase mechanism pill, and a one-line verdict: (1) "Hard cut" · assembly · text mentioning "9.8 dB" and marked "current"; (2) "NLE transition" · post-production · mentions an external editor; (3) "FLF continuation splice" · in-model · mentions "36.2/34.3 dB"; (4) "Dip-to-black" · post-production · mentions a structural dip AND rendered DIMMED/disabled with a warm-toned reason line about bridge render engine work; (5) "Diegetic bridge" · in-model · also DIMMED/disabled with the engine-work reason. The disabled state of options 4–5 is INTENTIONAL honesty (queued engine work), not a defect.',
          'A small menu footer line mentioning the segment boundary and "tranche-1 measurements".',
          'Below the strip, the PLAN EDITOR: a "BRIEF" label with a wide textarea on the left, and on the right two segment rows — each with an index badge, a title input ("Segment 1"/"Segment 2"), a small "seconds" number input, a muted "no object" pill, a prompt textarea (one filled with text about a drummer stepping off a night train), and "Seed object" + "Remove" pill buttons.',
          'A thin footer bar: "V cycles · timeline → library → canvas" at the left and a note about transitions being measured choices at the right.',
          'AMPLIFICATION (2026-09-17, cleanup wave): the segment prompt text renders at 9px in dark boxes — SUBTLE, not absent. The capture driver ASSERTS both prompts are in the DOM at screenshot time (the capture would have FAILED otherwise), so both prompt textareas DO carry text: judge "empty" ONLY if a textarea interior is a perfectly uniform field with zero glyph texture; faint low-contrast glyph rows count as filled. Two prior fails here were pixel-verified misreads.',
          'Defects to flag: fewer than five menu options, an option missing its verdict line, the strip cards or menu overlapping each other illegibly, inputs clipped by the panel edge, text unreadable mid-glyph, a pure-white or pure-black dead region covering the panel.',
        ].join(' '),
      },
    ],
  },
  {
    id: 'launcher-keyboard-dialog',
    label: 'Launcher — keyboard-opened prompt library dialog with focus ring',
    run: async (page) => {
      await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } })
      await page.goto('/')
      await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
      await expect(page.locator('[data-canvas-prompt]')).toBeVisible()
      // Keyboard-only walk backward to the prompt-library chip (the same
      // route the keyboard-operability e2e takes) and open with Enter, so the
      // capture shows the dialog PLUS a genuine :focus-visible ring.
      const prompt = page.locator('[data-canvas-prompt]')
      await prompt.focus()
      for (let index = 0; index < 60; index += 1) {
        if (await page.evaluate(() => document.activeElement?.getAttribute('data-canvas-chip') === 'prompt-library')) break
        await page.keyboard.press('Shift+Tab')
      }
      await page.keyboard.press('Enter')
      await expect(page.locator('.prompt-library-modal')).toBeVisible()
      await page.waitForTimeout(400)
    },
    after: async (page) => {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(300)
    },
    checkpoints: [
      {
        id: 'launcher-keyboard-dialog-1080p',
        label: 'Launcher — prompt library dialog opened by keyboard, focus ring visible',
        rubric: [
          SHELL_CONTEXT,
          'The canvas launcher behind a dimmed modal overlay — background controls stay recognizable (titlebar, prompt bar silhouettes), never fully black.',
          'A dialog panel floats roughly centered: kicker "PROMPT LIBRARY", bold title about community & saved prompts, a one-line explainer, and a tab strip with a "Community" tab (active) and a "Saved" tab (its count varies — any count is fine).',
          'Dialog furniture: a search input row (search field plus filter dropdown/checkboxes), a "Load more" button and an attribution/footer line at the bottom when content is present, and an X close button at the panel\'s TOP-RIGHT corner — all inside the panel bounds.',
          'A keyboard-focus indicator is clearly visible: a bright green/chartreuse rectangular ring around the close (X) button.',
          'Content blessing: prompt cards in the scrollable list are dynamic harvested data — judge only their structural rendering; a card partially cut at the internal scroll boundary is intended scroll behavior, not clipping; excerpt ellipses ("...") are intended truncation.',
          'Defects to flag: no focus ring on the close button, dialog not separated from the background (no visible border/shadow), tabs or buttons clipped by the panel, overlapping text inside the dialog.',
        ].join(' '),
      },
    ],
  },
  {
    id: 'poserig-surface',
    label: 'Pose rig — IK viewport + palette-exact DWPose preview',
    run: async (page) => {
      await page.goto('/?poserig=1')
      await expect(page.locator('[data-poserig="app"]')).toBeVisible()
      await expect(page.locator('[data-poserig-preview]')).toBeVisible()
      // A non-trivial preset so both the 3D figure and the render read as a
      // posed human, not a rest stick.
      await page.locator('[data-poserig-preset="victory"]').click()
      await page.waitForTimeout(400)
    },
    checkpoints: [
      {
        id: 'poserig-1080p',
        label: 'Pose rig — 3D stick figure viewport beside the palette-exact 2D render',
        rubric: [
          'Context: a dark-theme dev surface (no app sidebar — this is the ?poserig=1 route) at 1920x1080 with three columns and a bottom timeline strip.',
          'Header: "Pose Rig" title, a small amber "DEV SURFACE — ?POSERIG=1" pill, a status line, and the note "IK pose rig → palette-exact DWPose render → Fun Control input".',
          'Left panel: a PRESETS section with 8 compact buttons (Standing, T-pose, Walking, Running, Sitting, Crouch, Reaching up, Arms raised — one highlighted as applied), a SKELETON TEMPLATE select showing "Human (DWPose 134)" (an "AP-10K quadruped (dog-type)" option exists — selectable, non-default; a one-line note under the select), an IMPORT section with a dashed "keypoint JSON" drop area, and an EXPORT section (Keypoint JSON / PNG frames buttons, a DISABLED "Server render" button — disabled is correct, a small note naming sprite/region compositing the non-human default path, plus canvas-size and duration chip rows).',
          'Center: a 3D viewport showing a HUMAN STICK FIGURE with arms raised in a V — colored joint spheres (bright saturated dots) connected by darker colored bone sticks, standing on a faint dark floor grid; a "selected:" pill near the top; a keyboard-hints bar along the bottom of the viewport.',
          'Right panel: a square black canvas preview rendering the SAME pose as a DWPose whole-body skeleton on pure black — colored limb sticks (darker, slightly desaturated versions of the joint colors), bright colored joint dots, small blue hand-dot clusters near both wrists with thin rainbow finger lines, a cluster of tiny white dots for the face, colored dots at the feet — this is a colored DWPose figure on black, NOT a photo, wireframe, or 3D mesh.',
          'The 3D figure and the 2D preview must be recognizably the SAME pose (arms up in a V).',
          'Bottom timeline: "Key (K)" and "Delete" buttons, a "frame N / 55" readout, and a track of a FEW WIDE SEGMENTS (the sparse 17n+5 grid — typically 3-4 stretched cells, NOT dense tick marks) where keyframed cells render as solid accent-green blocks and the current cell is the bright accent-FILLED cell — the current-frame indication is the fill luminance alone (an additional outline is intentionally absent: accent-on-accent would be invisible; the frame readout names the exact frame), plus a right-aligned note line reading "…keyframe(s) · grid 17n+5 · … frames @ 24 fps · hold-last beyond keys". [Amended 2026-09-17: the earlier "carries an accent outline" clause described a treatment the shipped design never rendered — two judgment rounds disagreed on it; the fill is the documented indicator.]',
          'Blessings: the preview canvas may show slight pixelation (intended image-rendering); the figure in the 3D viewport is intentionally flat-shaded without lighting; small muted sub-labels are the app\'s design language.',
          'Defects to flag: 3D viewport empty or all-black, preview canvas blank, limbs missing or single-colored (the limb palette must be multi-colored), overlapping panel content, text clipped by panels, timeline ticks missing.',
        ].join(' '),
      },
    ],
  },
  {
    // Canvas Phase 1 (task jl4ye8x) — the ?canvas=1 route: seed tile on the
    // substrate + the in-route titlebar radar. Deterministic: fresh session,
    // one prompt submit, settle. Cleanup deletes the created canvas so the
    // shared test-home stays tidy.
    id: 'canvas-phase1',
    label: 'Canvas Phase 1 — seed tile on the substrate + titlebar radar',
    run: async (page) => {
      await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } })
      await page.goto('/?canvas=1&probe=canvas')
      await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
      await page.locator('[data-canvas-prompt]').fill('a lone drummer on a night train, windows streaked with rain')
      await page.locator('[data-canvas-submit]').click()
      await expect(page.locator('[data-canvas-tile]').first()).toBeVisible({ timeout: 10_000 })
      // Phase 2 submits for real; offline that parks nothing, so the queued
      // ring comes from the gated mock link (the identical store state).
      await page.evaluate(() => (window as unknown as { __canvasScenario(name: string): unknown }).__canvasScenario('seed-mock'))
      await page.waitForTimeout(1_100) // fly-to + ring paint settle
    },
    after: async (page) => {
      // Close the session's canvases (tombstones keep test-home tidy via a
      // later trash empty; closing is enough for determinism of other specs).
      await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } }).catch(() => undefined)
    },
    checkpoints: [
      {
        id: 'canvas-phase1-1080p',
        label: 'Canvas — seed tile rendered with queued ring + radar visible at 1080p',
        rubric: [
          'Context: a dark-theme desktop studio at 1920x1080 on the ?canvas=1 canvas route — NO left sidebar (this surface replaces the shell chrome; a slim top titlebar + an infinite dotted-grid canvas below is the intended design).',
          'Top titlebar (slim, dark): left side shows one canvas tab (a name like "Canvas <date>" with an × close affordance); center-left a pill-shaped RADAR button with a pulse/activity icon reading "1 queued" (muted gray-blue styling, a queue count is expected in this scenario — CORRECT not a defect); beside it a muted "engine offline" chip (offline is the honest state in tests, CORRECT); right side an "index ⌘K" button.',
          'Canvas surface: a subtle evenly-spaced dot grid on a very dark background; ONE media tile card floating on it — a rounded dark card with a 1px border containing: a 16:9 preview area showing the prompt text on a dashed placeholder (no thumbnail yet — the seed has no take; intended), a visible status ring around the tile (border highlight — queued state, muted), small head/tail dot affordances at the tile\'s left and right edges, and a metadata strip + op-chip row ("no ops") below the preview.',
          'A floating PROPERTIES panel may be visible at the right side of the canvas (drag handle header with the tile title and a small mode pill like "text → video", stacked sections for Prompt / Engine / References / Identity / Guides / Takes, an X close button) — intended Phase-2 surface. A slim contextual bottom bar spans the canvas foot (object title, mode pill, status chip, fork button).',
          'The tile may be partially overlapped by nothing; text on the tile must be readable, not clipped mid-glyph.',
          'Defects to flag: no radar/button visible in the titlebar, no tile card on the canvas, the tile border-less or invisible against the grid, overlapping titlebar controls, empty canvas with no objects, any pure-white or pure-black dead region covering the surface.',
        ].join(' '),
      },
    ],
  },

  {
    // Canvas Phase 3 (task j5sj28v) — the op modal editor (§5.1) over the
    // canvas with a LIVE tile preview, then the completed fork semantics:
    // derived edge + near-band take strip. Deterministic: fresh session, one
    // drop, modal ops applied via the real store paths.
    id: 'canvas-phase3',
    label: 'Canvas Phase 3 — op modal editor + fork gesture',
    run: async (page) => {
      await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } })
      await page.goto('/?canvas=1')
      await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
      // A real, decodable PNG so the live preview composes over a real image.
      await page.evaluate(() => {
        const canvas = document.createElement('canvas')
        canvas.width = 64
        canvas.height = 36
        const context = canvas.getContext('2d')!
        context.fillStyle = '#2b3a55'
        context.fillRect(0, 0, 64, 36)
        context.fillStyle = '#e8b04b'
        context.fillRect(8, 8, 16, 16)
        const binary = atob(canvas.toDataURL('image/png').split(',')[1])
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
        const transfer = new DataTransfer()
        transfer.items.add(new File([bytes], 'vision-op-stack.png', { type: 'image/png' }))
        document.querySelector('[data-canvas-root]')!.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }))
      })
      const tile = page.locator('[data-canvas-tile]').first()
      await expect(tile).toBeVisible({ timeout: 10_000 })
      await page.waitForTimeout(600)
      // §7 Enter opens the op modal; a crop + a warm adjust land through the
      // real store (the tile preview re-derives live — L3).
      await tile.click()
      await page.keyboard.press('Enter')
      const modal = page.locator('.canvas-opmodal')
      await expect(modal).toBeVisible()
      await modal.locator('[data-canvas-op-add]').click()
      await modal.locator('[data-canvas-op-add="crop"]').click()
      await expect(modal.locator('[data-canvas-op-stack] .canvas-op-row')).toHaveCount(1, { timeout: 10_000 })
      await modal.locator('[data-canvas-op-add]').click()
      await modal.locator('[data-canvas-op-add="adjust"]').click()
      await expect(modal.locator('[data-canvas-op-stack] .canvas-op-row')).toHaveCount(2, { timeout: 10_000 })
      await modal.locator('[data-canvas-op-field="brightness"]').evaluate((element) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        setter.call(element, '0.45') // offset slider: 0 = neutral, +0.45 → brightness 1.45
        element.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await page.waitForTimeout(1_200) // debounced commit + live re-derive
    },
    after: async (page) => {
      await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } }).catch(() => undefined)
    },
    checkpoints: [
      {
        id: 'canvas-phase3-opmodal-1080p',
        label: 'Canvas — the op modal editor open over the substrate with a live preview + stack rows',
        rubric: [
          'Context: a dark-theme desktop studio at 1920x1080 on the ?canvas=1 canvas route behind a DIMMED MODAL BACKDROP. The canvas surface is near-black BY DESIGN (a dark abyss background with a very subtle dot grid) — under the dim the grid dots may fall below visibility; the contract is SILHOUETTES, not a void: at least one dimmed structure behind the modal (a floating panel, a tile edge, or the bottom bar strip) plus the FULLY BRIGHT top titlebar (canvas tab, radar chip, "engine offline" chip, index button) which renders above the backdrop.',
          'A large modal panel (~1000px wide, centered): header row with a title beginning "Op stack —" and a sub-line about edits being ops and bake being irreversible; an × close button at its top right.',
          'The modal body has TWO columns. LEFT: a preview stage — a rounded dark frame showing the SOURCE IMAGE visibly brightened/warmed compared to neutral (a dark blue rectangle with a gold square, clearly lighter than a dark navy) — plus a scrubber row is ABSENT (this is an image, no trim scrubber).',
          'RIGHT: an "add op" pill button with a "+", an op count line, then a STACK LIST of exactly TWO op rows — "1 crop" (a summary like "1.0×") and "2 adjust" — each row carrying small icon buttons (undo, up/down arrows) and a "bake" text button at the right; one row is highlighted as the selected editor below shows sliders labeled brightness / contrast / saturation. The sliders are SYMMETRIC: center is neutral, so the brightness thumb (set above neutral) sits RIGHT of its track\'s geometric center while contrast/saturation sit at center.',
          'Beneath the list: the selected op\'s edit panel with the three labeled range sliders, and a small muted footer line mentioning ⌘Z undo / drag to reorder / Esc.',
          'Blessings: the canvas behind is dimmed (silhouette-level); the modal may overlap the tile; dense small sub-labels are the design language; dimmed controls are intended; the op-row bake button may sit close to the modal\'s inner right padding (flush-but-present is fine, clipped-half is not).',
          'Defects to flag: modal clipped by the viewport, stack rows overlapping, sliders without labels, the brightness thumb left of center, the preview stage empty or pure black, text cut mid-glyph, NO bright structure anywhere (full void).',
        ].join(' '),
      },
    ],
  },

  {
    // Canvas Phase 4 (task 6rymbx3) — the completed canvas surface: a media
    // object with the properties panel carrying the absorbed CreateView
    // prompt surfaces, PLUS the audio engine dock (§5.4 engines-as-ops) and
    // the library projection (§7 V) summoned together — the multi-surface
    // composition the retirement wave leaves behind.
    id: 'canvas-phase4',
    label: 'Canvas Phase 4 — properties panel surfaces + audio dock + library projection',
    run: async (page) => {
      await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } })
      await page.goto('/?canvas=1')
      await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
      // The audio dock FIRST — the empty canvas shows the launcher, whose
      // Music 3 chip opens the dock (§5.4). It stays floating while the
      // object + panel arrive (selecting never closes an open dock).
      await page.locator('[data-canvas-chip="music3"]').click()
      await expect(page.locator('[data-canvas-audio-dock]')).toBeVisible()
      await page.locator('[data-canvas-audio-caption]').fill('slow cinematic ambient piano, wide reverb, 60 seconds')
      // A real, decodable PNG lands as a media object…
      await page.evaluate(() => {
        const canvas = document.createElement('canvas')
        canvas.width = 64
        canvas.height = 36
        const context = canvas.getContext('2d')!
        context.fillStyle = '#2b3a55'
        context.fillRect(0, 0, 64, 36)
        context.fillStyle = '#e8b04b'
        context.fillRect(8, 8, 16, 16)
        const binary = atob(canvas.toDataURL('image/png').split(',')[1])
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
        const transfer = new DataTransfer()
        transfer.items.add(new File([bytes], 'vision-phase4.png', { type: 'image/png' })
        )
        document.querySelector('[data-canvas-root]')!.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }))
      })
      await expect(page.locator('[data-canvas-tile]')).toHaveCount(1, { timeout: 10_000 })
      await page.waitForTimeout(500)
      // …and selecting it (a direct dispatch — the tile may sit under the
      // floating dock) opens the properties panel with the absorbed prompt
      // surfaces. Both compose: dock left, panel right.
      await page.evaluate(() => (document.querySelector('[data-canvas-tile]') as HTMLElement | null)?.click())
      await expect(page.locator('[data-canvas-properties]')).toBeVisible()
      await page.waitForTimeout(700)
    },
    after: async (page) => {
      await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } }).catch(() => undefined)
    },
    checkpoints: [
      {
        id: 'canvas-phase4-surface-1080p',
        label: 'Canvas — properties panel prompt surfaces + the Music 3 audio dock floating over the substrate',
        rubric: [
          'Context: a dark-theme desktop studio at 1920x1080 on the ?canvas=1 canvas route — slim top titlebar (canvas tab, radar chip reading "calm" or a queue count, "engine offline" chip, then small "library V", "settings", "index ⌘K" buttons at the right — ALL intended Phase-4 additions), a near-black dotted-grid canvas surface below, and a slim contextual bottom bar at the foot.',
          'ONE media tile visible on the canvas (dark rounded card, 16:9 preview showing a dark blue rectangle with a gold square, head/tail endpoint dots) — it may be partially covered by floating panels; silhouette presence is enough.',
          'A PROPERTIES panel (floating, right side): header with the object title + a mode pill; a PROMPT section with a textarea placeholder and a row of four small pill buttons beneath it (enhance / timeline / audio pass / library — muted icons + labels, possibly dimmed because no local LLM is connected in tests: dimming is CORRECT); sections below for Engine, References, Identity payload with a strength slider, Guides, Takes.',
          'A separate AUDIO DOCK panel (floating, left-of-center or left side): header with a music note icon + "Music 3 — complete song"; body with a filled multi-line caption textarea containing visible caption text about ambient piano, a Lyrics textarea (empty placeholder), a "seconds" number input showing 60, and a muted note line about the track landing as its own object; footer with a "generate song" button (may be dimmed — the engine is offline in tests, CORRECT).',
          'Blessings: floating panels may overlap the tile; dense small sub-labels are the design language; dimmed/disabled buttons are intended offline states; the bottom bar may read "generate" with a prompt input + Music 3 / ACE-Step / library chips.',
          'Defects to flag: either panel missing entirely, panels overlapping EACH OTHER so their headers cannot both be read, the caption textarea empty or clipped, unreadable text mid-glyph, a pure-white or pure-black dead region, no titlebar buttons at all.',
        ].join(' '),
      },
    ],
  },

  {
    // The structured H3 prompt editor (fh94g76): the properties panel's
    // structured mode with every box populated — the toggle, collapsible
    // boxes, subject card, flow beats with time ranges, the <d> dialogue
    // helper, and the compose preview. DOM truth asserted BEFORE capture.
    id: 'structured-prompt-editor',
    label: 'Structured H3 prompt editor — populated boxes on the properties panel',
    run: async (page) => {
      await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } })
      await page.goto('/?canvas=1')
      await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
      await page.locator('[data-canvas-prompt]').fill('a night watchman closes the observatory')
      await page.locator('[data-canvas-submit]').click()
      await expect(page.locator('[data-canvas-tile]')).toHaveCount(1, { timeout: 10_000 })
      const panel = page.locator('[data-canvas-properties]')
      await expect(panel).toBeVisible()
      // DOM truth at capture: the toggle flips to structured and EVERY box
      // renders populated (asserted BEFORE the screenshot fires).
      await panel.locator('[data-canvas-prompt-mode-toggle="structured"]').click()
      const editor = panel.locator('[data-structured-editor]')
      await expect(editor).toBeVisible()
      await expect(panel.locator('[data-canvas-prompt-mode]')).toHaveAttribute('data-canvas-prompt-mode', 'structured')
      await editor.locator('[data-structured-input="style"]').fill('Cinematic')
      await editor.locator('[data-structured-input="concept"]').fill('a night watchman closes the observatory')
      await editor.locator('[data-structured-subject-add]').click()
      await editor.locator('[data-structured-subject-name]').last().fill('Idris')
      await editor.locator('[data-structured-subject-appearance]').last().fill('a weathered keeper in a wool coat')
      await editor.locator('[data-structured-subject-wardrobe]').last().fill('a heavy brass-buttoned coat')
      await editor.locator('[data-structured-subject-features]').last().fill('a scar through one eyebrow')
      await editor.locator('[data-structured-input="setting"]').fill('a mountain observatory under clearing storm clouds')
      await editor.locator('[data-structured-input="lighting"]').fill('Cold moonlight through the dome slit')
      await editor.locator('[data-structured-input="camera"]').fill('The camera tracks him at slow speed')
      await editor.locator('[data-structured-flow-add]').click()
      await editor.locator('[data-structured-flow-text]').last().fill('he locks each dome and pockets the keys')
      await editor.locator('[data-structured-flow-add]').click()
      await editor.locator('[data-structured-flow-from]').last().fill('3')
      await editor.locator('[data-structured-flow-text]').last().fill('he pauses at the rail as the clouds break')
      await editor.locator('[data-structured-input="audio-soundscape"]').fill('Wind drops to a low moan; keys jingle once.')
      await editor.locator('[data-structured-dialogue-line]').fill('Almost dawn.')
      await editor.locator('[data-structured-dialogue-add]').click()
      await panel.locator('[data-structured-preview] summary').click()
      for (const box of ['concept', 'subjects', 'setting', 'lighting', 'style', 'camera', 'flow', 'audio']) {
        await expect(editor.locator(`[data-structured-box="${box}"]`)).toBeVisible()
      }
      await expect(editor.locator('[data-structured-flow-row]')).toHaveCount(2)
      await expect(editor.locator('[data-structured-subject]')).toHaveCount(1)
      await expect(panel.locator('[data-structured-preview] pre')).toContainText('integrated_multimodal_description:')
      await page.waitForTimeout(400)
    },
    after: async (page) => {
      await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } }).catch(() => undefined)
    },
    checkpoints: [
      {
        id: 'structured-prompt-editor-top-1080p',
        label: 'Structured editor — panel scrolled to TOP: the toggle + Concept/Subjects/Setting/Lighting boxes',
        // The panel scrolls internally; this checkpoint captures the TOP —
        // DOM truth: the scroller's offset is pinned at 0 before capture.
        drive: async (page) => {
          const panel = page.locator('[data-canvas-properties]')
          await expect(panel).toBeVisible()
          // The scroller is the Rnd PANEL ROOT itself (overflow-hidden but
          // programmatically scrollable — the body's own overflow never
          // engages because its grid row is unconstrained).
          await panel.evaluate((element) => { element.scrollTop = 0 })
          await expect.poll(async () => panel.evaluate((element) => element.scrollTop)).toBe(0)
          await expect(page.locator('[data-canvas-prompt-mode]')).toHaveAttribute('data-canvas-prompt-mode', 'structured')
          await expect(page.locator('[data-structured-box="concept"]')).toBeVisible()
        },
        rubric: [
          SHELL_CONTEXT,
          'GROUND TRUTH FOR THIS CAPTURE: the properties panel is scrolled to its TOP — the FIRST thing visible inside the panel body is the "Prompt // presets" label, IMMEDIATELY followed by the segmented freeform/structured toggle. If you can read the words "freeform" and "structured" as two adjoining small buttons near the top of the panel, the toggle clause PASSES — read carefully before judging it missing.',
          'ONE seed tile on the canvas (dark rounded card, head/tail endpoint dots). The panel header carries the object title + a "text → video" mode pill.',
          'The segmented toggle: "structured" is ACTIVE (accent-highlighted, brighter than the muted "freeform").',
          'Below the toggle, the STRUCTURED EDITOR: a vertical stack of small bordered box sections, each with a collapsible header (a chevron icon, a bold label like Concept / Subjects / Setting / Lighting, a muted hint). In view from the top: Concept, Subjects, Setting, Lighting (and possibly Style).',
          'Populated content visible: the Concept box\'s textarea contains watchman/observatory prose and its style line reads "Cinematic"; the Subjects box shows ONE dashed subject card with a name input reading "Idris", an appearance textarea about a weathered keeper in a wool coat, and wardrobe/features inputs; the Setting and Lighting boxes show readable prose (lighting mentions moonlight).',
          'Per-box assist buttons ("distill" / "enhance") appear DIMMED — no local LLM in tests, CORRECT. Chip rows (small rounded pills like "a busy city street", "golden hour") may render under the Setting/Lighting boxes.',
          'Blessings: dense small text and muted sub-labels are the design language; dimmed disabled controls are intended offline states; boxes further down (Style, Camera, Flow, Audio, Engine, References…) sit BELOW the panel\'s internal fold — their absence from THIS capture is NOT a defect (a second checkpoint covers them); the bottom bar shows the generate surface.',
          'Defects to flag: the toggle truly absent from the panel top, no box sections at all, empty textareas where populated content is described above, the subject card lacking its input fields, overlapping boxes rendering text unreadably, a pure-white or pure-black dead region.',
        ].join(' '),
      },
      {
        id: 'structured-prompt-editor-bottom-1080p',
        label: 'Structured editor — panel scrolled DOWN to Flow: beats + Audio + compose preview',
        // The same panel scrolled to the Flow box: the timeline made
        // first-class + the audio box + the preview. DOM truth: the scroller
        // is measurably past its top and the Flow rows render.
        drive: async (page) => {
          const panel = page.locator('[data-canvas-properties]')
          await expect(panel).toBeVisible()
          // FORCE the scroll on the panel ROOT (the real scroller — see the
          // top checkpoint's note); scrollIntoViewIfNeeded is a no-op for
          // internally-clipped content.
          await panel.locator('[data-structured-box="flow"]').evaluate((element) => element.scrollIntoView({ block: 'start' }))
          await expect.poll(async () => panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
          await expect(page.locator('[data-structured-flow-row]').first()).toBeVisible()
          await expect(page.locator('[data-structured-preview] pre')).toContainText('integrated_multimodal_description:')
        },
        rubric: [
          SHELL_CONTEXT,
          'GROUND TRUTH FOR THIS CAPTURE: the properties panel is scrolled DOWN into the structured editor\'s lower half — the FLOW box is at or near the top of the visible panel area. The freeform/structured toggle and the Concept/Subjects boxes are ABOVE the fold — their absence from THIS capture is NOT a defect (the first checkpoint covers them).',
          'The FLOW box (header reads "Flow" with a hint about the timeline / beats with time ranges): TWO dashed beat rows, each with TWO small side-by-side number inputs separated by a "→" (an "0 → 0" pair and a "3 → 3" pair), a textarea of readable beat prose (locking domes / pausing at the rail as the clouds break), and a small row of tiny ↑ ↓ copy trash icon buttons. A "+ beat" pill and dimmed "distill"/"enhance" buttons sit under the rows (dimmed = no local LLM in tests, CORRECT).',
          'The AUDIO box below it: labeled sub-fields "soundscape" (small uppercase label with a "→ overall_soundscape" note; filled textarea about wind and keys), "music" ("→ non_diegetic_music"), and "dialogue" containing a readable <d>[English] Almost dawn.</d> fragment; under it a compact helper row: a language select, a line input, and a "+ <d>" button.',
          'At the bottom of the visible panel: a right-aligned muted "distill into boxes…" pill (may be dimmed — CORRECT offline) and an OPEN "compose preview" block (dashed border; its summary line reads "compose preview — this exact string is submitted") showing monospace composed text that begins "integrated_multimodal_description: [Shot 1] Cinematic,".',
          'Blessings: dense small text and muted sub-labels are the design language; the beat-row icon buttons render as a compact horizontal cluster (not a column — intended); sections below (Engine, References, Identity, Guides, Takes) may sit below the fold — absence is NOT a defect; the bottom bar shows the generate surface.',
          'Defects to flag: no flow rows at all, flow rows missing their number inputs, the Audio box missing its labeled sub-fields, the dialogue line empty, the compose preview absent or empty, overlapping sections rendering text unreadably, a pure-white or pure-black dead region.',
        ].join(' '),
      },
    ],
  },

  {
    // Canvas Phase 2 (task flyuh6h) — generation on canvas: an ingested media
    // object (real blob-served poster) + the fork edge + the properties panel
    // and contextual bar. Deterministic: fresh session, one drop, one fork.
    id: 'canvas-phase2',
    label: 'Canvas Phase 2 — ingested media, fork edge, properties + contextual bar',
    run: async (page) => {
      await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } })
      await page.goto('/?canvas=1')
      await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
      // Drop a real, decodable PNG: the ingestion path stores bytes as a
      // content-addressed blob and serves the poster through the blob route.
      await page.evaluate(() => {
        const canvas = document.createElement('canvas')
        canvas.width = 64
        canvas.height = 36
        const context = canvas.getContext('2d')!
        context.fillStyle = '#2b3a55'
        context.fillRect(0, 0, 64, 36)
        context.fillStyle = '#e8b04b'
        context.fillRect(8, 8, 16, 16)
        const binary = atob(canvas.toDataURL('image/png').split(',')[1])
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
        const transfer = new DataTransfer()
        transfer.items.add(new File([bytes], 'vision-drop.png', { type: 'image/png' }))
        document.querySelector('[data-canvas-root]')!.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true }))
      })
      await expect(page.locator('[data-canvas-tile]').first()).toBeVisible({ timeout: 10_000 })
      // Fork it (decoded substrate) — a second tile + a derived edge.
      await page.keyboard.press('b')
      const forkMenu = page.locator('[data-canvas-fork-menu]')
      await expect(forkMenu).toBeVisible()
      await forkMenu.locator('[data-canvas-fork-substrate="decoded"]').click()
      await expect(page.locator('[data-canvas-tile]')).toHaveCount(2, { timeout: 10_000 })
      await expect(page.locator('[data-canvas-edge]')).toHaveCount(1)
      await page.waitForTimeout(1_100) // fly-to settle
    },
    after: async (page) => {
      await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } }).catch(() => undefined)
    },
    checkpoints: [
      {
        id: 'canvas-phase2-1080p',
        label: 'Canvas — ingested media tile with a real poster, forked chain + derived edge, properties panel open',
        rubric: [
          'Context: a dark-theme desktop studio at 1920x1080 on the ?canvas=1 canvas route — NO left sidebar; a slim top titlebar (one canvas tab, a radar pill reading "calm" or a low queue count, an "engine offline" chip, an "index ⌘K" button), an infinite dotted-grid canvas, and a slim contextual bottom bar.',
          'TWO media tile cards on the canvas: the LEFT one shows a REAL image poster (a dark blue rectangle with a gold square inside — an actually rendered <img>, not a placeholder), the RIGHT one (the fork) shows the same image or its prompt placeholder; a curved ACCENT-COLORED ARROW EDGE connects them left→right with a visible arrowhead at the fork — the derived fork edge.',
          'Each tile has small circular dot affordances at its left and right edges (the typed-hole endpoints), a status ring (idle state — muted), and a metadata strip + op-chip row ("no ops").',
          'A floating PROPERTIES panel at the right side, roughly 700px tall (or full canvas height on short screens): header with the selected chain title + a small accent mode pill (e.g. "reference → video" or "text → video") + X button; visible sections starting with "PROMPT" (a text editor area) and "ENGINE — MINIMAX H3" with tier chips (Quality / Fast · 4-step / Fast · 8-step) — deeper sections (REFERENCES / IDENTITY PAYLOAD / GUIDES / TAKES) may sit below the panel\'s internal scroll fold, which is INTENDED (the panel scrolls); a sticky ACTION ROW pinned to the panel\'s bottom edge with a small status chip and the generate button (may read disabled/dimmed — engine offline, correct). The action row must be fully visible inside the panel, never clipped.',
          'Bottom bar (chain context): the selected object title, an accent mode pill, a status chip, "no identity payload" or an identity readout, a drift chip, a takes chip, a fork button, and possibly a "1 source ↑" fork-history note.',
          'Blessings: muted/dimmed disabled controls are intended offline; dense small sub-labels are the design language; tiles may be at slightly different y positions (adjacency stacking).',
          'Defects to flag: no visible edge/arrow between the two tiles, poster area empty or a broken-image icon, properties panel overlapping the tiles so content is unreadable, bottom bar empty, any pure-white/black dead region.',
        ].join(' '),
      },
    ],
  },
  {
    // Dataset manager v1 (sv14rt0): the workbench surface at ?datasets=1 —
    // the required NEW vision scenario: gallery + crop editor + dashboard at
    // 1080p, one scenario, three states via per-checkpoint drive().
    id: 'datasets-workbench',
    label: 'Dataset manager — workbench surface (gallery, crop editor, dashboard) at 1080p',
    run: async (page) => {
      // Seed one synthetic source through the HTTP surface + wait for the
      // async decode probe, then land on the gallery.
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const { mkdirSync, mkdtempSync } = await import('node:fs')
      const { join } = await import('node:path')
      const exec = promisify(execFile)
      // Inside the server's studio home (test-home): by-reference ingest is
      // scope-gated (security wave 2) — /tmp fixtures are refused.
      mkdirSync(join(process.cwd(), 'test-home'), { recursive: true })
      const dir = mkdtempSync(join(process.cwd(), 'test-home', 'ds-vision-'))
      const clip = join(dir, 'vision-clip.mp4')
      // Unique audio (220 Hz vs the e2e suite's 440 Hz): same-bytes fixtures
      // would dedupe into one source by content hash — the identity contract
      // working as designed, not a bug.
      await exec('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=3:size=480x832:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip])
      const response = await page.request.post('/api/lan/datasets/ingest/reference', { data: { path: clip } })
      const body = await response.json()
      await expect
        .poll(async () => {
          const library = await (await page.request.get('/api/lan/datasets/library')).json()
          return library.sources.find((source: { id: string }) => source.id === body.source.id)?.probeState
        }, { timeout: 15_000 })
        .toBe('done')
      await page.request.post('/api/lan/datasets/settings', { data: { triggerToken: 'ph0t0r34l', contentClass: 'style' } })
      await page.goto('/?datasets=1')
      await expect(page.locator('[data-ds-master]', { hasText: 'vision-clip' }).first()).toBeVisible({ timeout: 10_000 })
      // Create a layer through the crop editor so the gallery shows children.
      await page.locator('[data-ds-master]', { hasText: 'vision-clip' }).first().getByRole('button', { name: /layer/ }).first().click()
      await expect(page.locator('[data-ds-editor]')).toBeVisible()
      await page.locator('[data-ds-save-layer]').click()
      await expect(page.locator('[data-ds-editor]')).toHaveCount(0)
      // Expand the master so the gallery checkpoint shows its children.
      await page.locator('[data-ds-master]', { hasText: 'vision-clip' }).first().locator('.ds-master-name').click()
      await expect(page.locator('[data-ds-layer]').first()).toBeVisible({ timeout: 10_000 })
    },
    after: async (page) => {
      await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } }).catch(() => undefined)
    },
    checkpoints: [
      {
        id: 'datasets-workbench-gallery-1080p',
        label: 'Dataset manager — gallery: master card with layer children, toolbar, titlebar',
        drive: async () => undefined,
        rubric: [
          'Context: a dark-theme desktop studio app at 1920x1080 on the ?datasets=1 route — a DIFFERENT surface from the canvas: a full-screen workbench with its own slim TITLEBAR reading "Dataset manager" followed by the shared surface-switcher pill group ("canvas" and "datasets", datasets highlighted — the QOL-wave 2026-09-18 replacement for the old one-way "← canvas" link), tab pills (library active, dashboard, export, trash), a small trigger-token readout ("trigger: ph0t0r34l"), and a small interpolator chip reading "minterpolate" (rife-ncnn-vulkan absent in tests — intended, not a defect).',
          'LEFT TOOLBAR (~240px): an "IMPORT" block with buttons "Upload from LAN", "Reference a file", "From canvas take"; a "SEARCH & FILTER" block with a search input and small filter chips (all / video / image, any caption / missing / stale); a "CURATION" block with "Dedup pass", "Batch VLM (skip hand)", "Batch draft → review queue" buttons; a "SELECTION" block with a count and a green-accented "Export…" button.',
          'RIGHT GALLERY: at least one MASTER CARD with a colorful test-pattern video poster (multi-color moving bars/squares — a real <video> poster frame, not gray), a small "video" kind badge, the file name "vision-clip.mp4", facts like "480×832 · 72f · 24.000fps", and action buttons "layer", "split scenes", "slow-mo audit".',
          'The master is EXPANDED showing its LAYER CHILD row(s): a small checkbox, layer name, a bucket badge like "480×832·72f", an "uncaptioned" italic caption line, and "crop/trim" + "caption" action buttons plus a small pin icon — the master/child model visible.',
          'Blessings: dimmed/muted secondary text and small 10px sub-labels are the intended dense design; the poster may show any frame of the test pattern.',
          'Defects to flag: empty gallery, no toolbar, unreadable overlapping text, a pure-white or dead-black region, missing titlebar tabs.',
        ].join(' '),
      },
      {
        id: 'datasets-workbench-crop-editor-1080p',
        label: 'Dataset manager — the stamp crop editor overlay: aspect spectrum, crop rect, trim',
        drive: async (page) => {
          await page.locator('[data-ds-layer]').first().getByRole('button', { name: 'crop/trim' }).click()
          await expect(page.locator('[data-ds-editor]')).toBeVisible()
          await page.waitForTimeout(400)
        },
        rubric: [
          'Context: the same ?datasets=1 workbench at 1920x1080 with a full-screen dimmed overlay and a centered EDITOR DIALOG (~1180px wide, rounded, dark) — the stamp crop editor.',
          'LEFT STAGE: a video frame area (dark background) showing the test-pattern clip; OVER it a GREEN/ACCENT-COLORED CROP RECTANGLE with a dashed or solid 2px border and an outside-area dimming, and a small size label above its top-left corner reading like "416×736" — the crop stamp.',
          'RIGHT SIDE PANEL (~300px): a "Layer name" input; the ASPECT SPECTRUM as a wrap of small chips — 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 — with ONE highlighted as active (e.g. 16:9 in accent color); a hint line mentioning drag/scroll/shift+scroll/middle-click; a monospace crop readout (x/y/w/h + ratio); a TRIM section with in/out number inputs, a range slider, and a hint that the grid target is chosen at export; a green-accented "Save layer" or "Create layer" button.',
          'The editor header shows "Edit layer — vision-clip.mp4" with dims/fps facts and a Close button.',
          'Defects to flag: no visible crop rectangle on the stage, aspect chips missing or overlapping, side panel clipped by the viewport, save button cut off.',
        ].join(' '),
      },
      {
        id: 'datasets-workbench-dashboard-1080p',
        label: 'Dataset manager — dashboard: distributions + per-trainer VRAM preflight',
        drive: async (page) => {
          const close = page.locator('[data-ds-editor] .ds-btn.ghost', { hasText: 'Close' })
          if (await close.count()) await close.click().catch(() => undefined)
          await page.getByRole('button', { name: 'dashboard' }).click()
          await expect(page.locator('[data-ds-dashboard]')).toBeVisible()
          await page.waitForTimeout(400)
        },
        rubric: [
          'Context: the same workbench with the DASHBOARD tab active at 1920x1080 — header "Balance & budget" with a refresh button.',
          'A PREFLIGHT CARD near the top: shows the worst-case item geometry (like "480×832·72f" or similar), TWO trainer projections labeled "DiffSynX" and "musubi" with GB numbers, a "binds: musubi" (or diffsynx) note, and a colored VERDICT word ("fits" green / "near-wall" amber / "over-wall" red); below it an honesty note that no canonical target distribution exists.',
          'A DISTRIBUTIONS grid of small cards: at least ASPECT (buckets like 9:16 with counts), DURATION, RESOLUTION, CONTENT CLASS, and a "caption coverage" line ("1/1 captioned" or similar with a stale count).',
          'A GUIDANCE list: bullet lines of shape-based advice (e.g. one aspect dominating, uncaptioned counts, or "no shape outliers").',
          'Blessings: distribution bars are thin accent-colored strips with 10px labels — dense by design; a single-item dataset legitimately shows one bucket dominating (that is DATA, not a defect; the guidance line about it is the surface working).',
          'Defects to flag: preflight card missing trainer names or verdict, distribution cards empty when items exist, guidance list absent, overlapping text.',
        ].join(' '),
      },
    ],
  },
  {
    // F6 live progress (maintainer decision 1a, 2026-09-18): a generating
    // tile mid-render — percent + label from targeted engine events and the
    // painted sampler-preview frame. Engine-free: a fake ComfyUI-speaking
    // WS emits the targeted stream; DOM truth is asserted at capture (the
    // timeline-gap-menu misread lesson — faint content gets pixel-verified
    // by the driver, never left to the judge).
    id: 'canvas-live-progress',
    label: 'F6 — a generating tile showing live progress + the sampler preview frame',
    run: async (page) => {
      const engine = http.createServer((req, res) => { res.writeHead(404); res.end() })
      const wss = new WebSocketServer({ noServer: true })
      engine.on('upgrade', (request, socket, head) => {
        const sid = new URL(request.url ?? '/', 'http://engine.local').searchParams.get('clientId') ?? ''
        wss.handleUpgrade(request, socket, head, (ws) => {
          ws.send(JSON.stringify({ type: 'execution_start', data: { prompt_id: 'e2e-live-1' } }))
          const timer = setInterval(() => {
            if (ws.readyState !== ws.OPEN) return
            ws.send(JSON.stringify({ type: 'progress', data: { value: 11, max: 30, prompt_id: 'e2e-live-1' } }))
            ws.send(Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 0, 0, 1]), frameJpeg()]))
          }, 400)
          ws.on('close', () => clearInterval(timer))
          void sid
        })
      })
      const enginePort = await new Promise<number>((resolve) => engine.listen(0, '127.0.0.1', () => resolve(engine.address().port)))
      const settingsResponse = await page.request.get('/api/lan/settings')
      const original = ((await settingsResponse.json()) as { settings: Record<string, unknown> }).settings
      ;(page as unknown as { __visionEngine?: { close(): Promise<void>; original: Record<string, unknown> } }).__visionEngine = {
        original,
        close: async () => {
          await new Promise<void>((resolve) => wss.close(() => resolve()))
          await new Promise<void>((resolve) => engine.close(() => resolve()))
        },
      }
      await page.request.post('/api/lan/settings', { data: { settings: { ...original, comfyUrl: `http://127.0.0.1:${enginePort}` } } })
      await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } })
      await page.goto('/?canvas=1&probe=canvas')
      await expect(page.locator('[data-canvas-root]')).toHaveAttribute('data-phase', 'ready')
      await page.locator('[data-canvas-prompt]').fill('a lantern-lit courtyard at dusk, camera drifting')
      await page.locator('[data-canvas-submit]').click()
      const tile = page.locator('[data-canvas-tile]').first()
      await expect(tile).toBeVisible({ timeout: 10_000 })
      // A running job whose promptId the engine targets (the scenario seam).
      const scenario = await page.evaluate(() => (window as unknown as { __canvasScenario(name: string): { ok: boolean; reason?: string } }).__canvasScenario('live-progress'))
      if (!scenario.ok) throw new Error(`canvas-live-progress capture: the live-progress scenario refused (${scenario.reason})`)
      await expect(tile).toHaveAttribute('data-tile-status', 'running')
      const readout = tile.locator('[data-canvas-live-readout]')
      await expect(readout).toContainText('35%', { timeout: 15_000 })
      await expect(readout).toContainText('Sampling · step 11 of 30')
      // DOM truth at capture: the preview frame is a DECODED image before
      // the screenshot fires (faint/streaky preview pixels stay judge-proof).
      const painted = await expect.poll(async () => tile.locator('[data-canvas-live-preview]').evaluate((element) => (element as HTMLImageElement).naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0)
      void painted
      await page.waitForTimeout(600)
    },
    after: async (page) => {
      const carrier = page as unknown as { __visionEngine?: { close(): Promise<void>; original: Record<string, unknown> } }
      if (carrier.__visionEngine) {
        await page.request.post('/api/lan/settings', { data: { settings: carrier.__visionEngine.original } }).catch(() => undefined)
        await carrier.__visionEngine.close()
        carrier.__visionEngine = undefined
      }
      const listed = await page.request.get('/api/lan/jobs')
      if (listed.ok()) {
        const body = await listed.json() as { jobs?: Array<Record<string, unknown>> }
        const stale = (body.jobs ?? []).filter((job) => job.status === 'queued' || job.status === 'running').map((job) => ({ ...job, status: 'cancelled' }))
        if (stale.length) await page.request.post('/api/lan/jobs', { data: { jobs: stale } })
      }
      await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } }).catch(() => undefined)
    },
    checkpoints: [
      {
        id: 'canvas-live-progress-1080p',
        label: 'F6 — a generating tile at 1920x1080: live percent + sampling label + the in-progress preview frame',
        rubric: [
          SHELL_CONTEXT,
          'One TILE centered in the canvas world: its media area shows a PAINTED PREVIEW FRAME — a smooth color GRADIENT image (teal/blue toward the left warming to orange/red toward the right) crossed by one bright YELLOW-ISH horizontal band across the middle (a synthetic 64x36 JPEG scaled up; soft/blocky upscaled pixels are EXPECTED for a mid-sampling preview, not a defect) filling the tile’s media area.',
          'At the tile’s bottom edge, a compact live READOUT strip: a percent reading "35%" in an accent/info tone, then a muted label line "Sampling · step 11 of 30".',
          'The tile’s status ring is in its RUNNING state: a pulsing info-colored border around the tile.',
          'A thin animated progress bar may also glow along the tile’s bottom — intended.',
          'The status must be MID-RENDER: the tile must NOT read idle/stale/failed, must NOT show a take strip with a canonical take, and the canvas around it is otherwise calm (launcher bar present, no error toasts).',
          'Defects to flag: a black/empty media area with NO painted frame, a readout missing the percent, a readout showing a terminal or queued-only label (like "Waiting for ComfyUI to start"), overlapping readout text, or the tile clipped by the viewport.',
        ].join(' '),
      },
    ],
  },
  {
    // H3 Image Workbench (k9vu6t0): the required NEW vision scenario — the
    // workbench surface at ?images=1 at 1080p: mode rail + preview + the
    // 9-slot reference strip, one checkpoint, DOM-truth asserted at capture.
    id: 'h3-image-workbench',
    label: 'H3 Image Workbench — the compose surface (mode rail, preview, 9-slot ref strip) at 1080p',
    run: async (page) => {
      // Seed one session chain + one landed packet take through the same
      // documents API the landing loop writes (DOM truth before capture).
      const project = await (await page.request.post('/api/lan/documents/projects', { data: { name: 'IW vision' } })).json()
      const chain = await (await page.request.post('/api/lan/documents/chains', {
        data: {
          projectId: project.project.id,
          kind: 'h3img',
          settings: {
            family: 'h3img.compose.refs',
            intent: 'a lone hiker on a granite ridge at dawn, layered mist below',
            tier: 5,
            keepDial: 0.55,
            seed: 90210,
            resolution: '1344x768',
            loras: [],
            refs: [
              { id: 'r1', role: 'subject', transport: null, keepOverride: null, note: '', source: { kind: 'file', path: '/nonexistent/identity.png', name: 'identity.png' } },
              { id: 'r2', role: 'pose', transport: 'semantic', keepOverride: null, note: '', source: { kind: 'file', path: '/nonexistent/pose.png', name: 'pose.png' } },
              { id: 'r3', role: 'lighting', transport: null, keepOverride: null, note: '', source: { kind: 'file', path: '/nonexistent/lighting.png', name: 'lighting.png' } },
            ],
            semanticOverflow: false,
            framePicks: {},
            refineEngine: '',
            poserigInbox: null,
          },
        },
      })).json()
      const output = await (await page.request.post('/api/lan/documents/outputs', { data: { chainId: chain.chain.id, substrates: ['decoded'] } })).json()
      const frames = [
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==',
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==',
      ]
      const artifacts: string[] = []
      for (let index = 0; index < frames.length; index += 1) {
        const ingested = await (await page.request.post('/api/lan/documents/blobs/ingest', { data: { data: frames[index], name: `iw-vision-frame-${index}.png`, kind: 'image' } })).json()
        artifacts.push(ingested.path)
      }
      await page.request.post('/api/lan/documents/takes', {
        data: {
          outputId: output.output.id,
          jobId: null,
          artifacts,
          metrics: {
            kind: 'image',
            duration: 0,
            width: 1344,
            height: 768,
            sourcePath: artifacts[0],
            h3img: {
              family: 'h3img.generate.packet',
              profile: 'packet',
              tier: 5,
              frames: 3,
              prompt: 'the generated contract text',
              refs: [],
              loras: [],
              seed: 90210,
              resolution: '1344x768',
              hybrid: true,
              scorer: { bestIndex: 1, reason: 'sharpest of the pool', metricBasis: 'pixel metrics only' },
              canonicalFrameIndex: 1,
            },
          },
        },
      })
      await page.request.post('/api/lan/documents/session', { data: { openProjects: [project.project.id], activeProject: project.project.id } })
      await page.goto('/?images=1')
      await expect(page.locator('[data-iw-root]')).toBeVisible()
      await expect(page.locator('[data-iw-root][data-iw-family="h3img.compose.refs"]')).toBeVisible()
      await expect(page.locator('[data-iw-ref-count]')).toHaveText('3/9')
      await expect(page.locator('[data-iw-ref-slot]')).toHaveCount(3)
      await expect(page.locator('[data-iw-frame]')).toHaveCount(3)
      await expect(page.locator('[data-iw-preview-image]')).toBeVisible()
      await page.waitForTimeout(400)
    },
    after: async (page) => {
      await page.request.post('/api/lan/documents/session', { data: { openProjects: [], activeProject: null } }).catch(() => undefined)
    },
    checkpoints: [
      {
        id: 'h3-image-workbench-compose-1080p',
        label: 'H3 Image Workbench — compose mode: mode rail, preview canvas with picked frame + scorer verdict, 9-slot reference strip',
        drive: async () => undefined,
        rubric: [
          'Context: a dark-theme desktop studio app at 1920x1080 on the ?images=1 route — a DEDICATED full-screen image workbench (a different surface from the canvas): its own slim TITLEBAR reading "H3 Image Workbench" with a "canvas" back link at the left, an engine status chip at the right reading "engine offline" (offline is CORRECT in tests — intended, not a defect), and a muted family label.',
          'MODE RAIL under the titlebar: text-mode buttons Generate / Compose / Edit / Refine / Burst / Exit, with COMPOSE highlighted in the accent color.',
          'MAIN AREA split: a large PREVIEW region on the left (a framed panel with a small colored square image — a 1x1 pixel test PNG scaled, blocky is EXPECTED — and beneath its bottom edge a muted caption line mentioning the packet family, "frame 2/3", a scorer verdict chip naming the sharpest pick, and the caption row is thin and muted by design), and a CONTROLS column on the right (~320px) containing: an "INTENT" textarea with the hiker prompt text, a collapsible "Ownership contract (generated — never hand-written)" section, a "REFERENCES" block with a "3/9" counter, a short muted note starting "9 native references", THREE small reference-slot rows each with a role select and transport select, an "add image" / "from canvas" / "from pose rig" button row, a "Keep unspecified traits" slider with a numeric value like 0.55, LoRA slots section, resolution + seed fields, a semantic-overflow checkbox labeled experimental, and a green-accented "Generate (5-frame packet)" button.',
          'FOOTER TAKE STRIP along the bottom: one take card labeled "5-frame" with a "canonical" marker and THREE small frame thumbnails in a row, the middle one highlighted with an accent border and a small star badge (the scorer pick).',
          'Blessings: dimmed/muted sub-labels, 10px dense text, disabled refine/burst buttons (engine offline / experiment gates — intended), and the tiny scaled test PNG in the preview are all the intended design, not defects.',
          'Defects to flag: no mode rail, no preview panel, an empty take strip, reference slots overlapping or clipped, the controls column cut off at the right edge, any pure-white or dead-black region.',
        ].join(' '),
      },
    ],
  },
]
