import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

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

// The composer scenario types a known prompt so the screenshot is comparable
// across runs; it is cleared again in `after` (the workspace persists
// server-side in the shared test-home).
const KNOWN_PROMPT = 'a lone drummer on a night train, windows streaked with rain'

/** Chrome shared by every rubric: the intended look of the app. */
const SHELL_CONTEXT = [
  'Context for every clause: a dark-theme desktop studio app at 1920x1080.',
  'Top bar: app name/logo left, GPU/VRAM meters and a red-ish "Engine offline" badge right — the engine being offline in tests is CORRECT, not a defect.',
  'Below it a dismissible amber "Model license" banner that may wrap to two lines (intended).',
  'Left sidebar (~218px) with grouped navigation — GENERATE (Create, LTX 2.5, Music, Music 3), PLAN (Create Image, Characters, Hair, Wardrobe, Accessories, Locations), REVIEW (Queue, Library, Clip editor), ADVANCED TOOLS (Movie, Settings) — plus a "Models incomplete" warning box near its bottom.',
  'Canvas-migration retirement badges: Create, LTX 2.5, Queue, Library and Clip editor carry small muted "retired" pills (greyed styling) — INTENDED Phase-3/4 markers, not defects; the views still open.',
  'Dimmed/disabled controls and small muted sub-labels are the app\'s intentional dense design language, NOT contrast defects — only flag text that is genuinely unreadable against its immediate background.',
].join(' ')

export const SCENARIOS: VisionScenario[] = [
  {
    id: 'create-composer',
    label: 'Create view composer at 1080p',
    run: async (page) => {
      await page.goto('/')
      await expect(page.getByRole('button', { name: /generate video/i })).toBeVisible()
      await page.locator('#prompt').fill(KNOWN_PROMPT)
      await page.waitForTimeout(300)
    },
    after: async (page) => {
      await page.locator('#prompt').fill('')
      await page.waitForTimeout(1_200)
    },
    checkpoints: [
      {
        id: 'create-composer-1080p',
        label: 'Create view — composer, right panel and generate bar fully visible at 1920x1080',
        rubric: [
          SHELL_CONTEXT,
          'Central column: eyebrow "LOCAL VIDEO WORKSPACE", heading "Create with MiniMax H3", a one-line subtitle, and a "Check model paths" button; below them the generation input card.',
          'Input card, top to bottom: four mode tabs — "Text" (selected/highlighted), "Image", "First + last", "Reference" — each with a small sub-label; a "Shot direction" label row with a green "Ready" badge; a large multi-line textarea containing exactly "a lone drummer on a night train, windows streaked with rain", fully readable with a character counter at its top right (e.g. "59 / 7,000 characters").',
          'Bottom row of the input card: the buttons "Enhance", "Shot timeline", "Audio pass" (rendered dimmed/disabled — the local LLM is offline in tests, which is correct) and a "Local LLM offline" indicator.',
          'Right panel ("OUTPUT" / workspace): a "Set up the studio" checklist card with numbered steps and a green "Open Settings" button; three model-status tiles that legitimately show warning states ("Not detected" / "Missing component…" — offline by design, ellipsized status text in these fixed tiles is acceptable); an "Output and quality" section with quality options and an "Output size" block (Orientation "Landscape", a resolution like "1344 × 768").',
          'Bottom of the right panel: the generate bar — a gauge icon, a resolution/duration summary (e.g. "1344 × 768" and "8s · 24 fps · 30 steps") and the "Generate video" button, which renders DISABLED (engine offline — correct, not a bug). The whole bar must be on-screen.',
          'Defects to flag: elements overlapping each other, text cut off by a container or the viewport (other than the blessed ellipsized status tiles), buttons/inputs misaligned with their labels, truly unreadable text.',
        ].join(' '),
      },
    ],
  },
  {
    id: 'settings-llm-fallback',
    label: 'Settings — LLM router fallback state',
    run: async (page) => {
      await page.goto('/')
      await page.getByRole('button', { name: /settings/i }).first().click()
      await expect(page.getByRole('heading', { name: /settings/i })).toBeVisible()
      const llmSection = page.locator('.llm-section')
      await expect(llmSection).toBeVisible()
      // The Settings page scrolls INSIDE its content container, so a fullPage
      // capture cannot reach below the fold — bring the section into view.
      await llmSection.scrollIntoViewIfNeeded()
      await page.waitForTimeout(400)
    },
    checkpoints: [
      {
        id: 'settings-llm-fallback-1080p',
        label: 'Settings — "LLM · llama.cpp router" card in its provider-empty fallback state',
        rubric: [
          SHELL_CONTEXT,
          'The Settings view: a single-column stack of section cards beside the sidebar. The page scrolls INSIDE its own container and this capture is taken with the LLM card scrolled into view — the "Settings" heading and its "Save settings" button MAY sit above the visible fold (that is intended scrolling, not clipping; judge only what is in frame).',
          'The "LLM · llama.cpp router" card is in frame with: title "LLM · llama.cpp router" and its explanatory sub-line; a health pill reading "Ollama fallback" (NOT "online"/"connected"/"Router · N models" — no router is configured in tests, so an online-looking pill is a bug); a labeled "Router address (router mode)" input that is EMPTY (its placeholder mentions 127.0.0.1:8080 and the Ollama fallback); a "Test connection" button.',
          'Below those: the card\'s grid of controls — checkbox rows "Unload models before generating" (checked) and "Thinking by default (freeform)" (unchecked), a "Prompt writing style" dropdown, a "Sticky models (never unload)" input, and a closing note line mentioning that nothing leaves the workstation.',
          'NO model rows: zero model ids/names listed as selectable rows in this card (phantom models with no provider behind them are a bug). A "no models / not reachable" status line is acceptable.',
          'Defects to flag: pill showing a connected state, a filled router address, model rows present, overlapping or clipped controls, truncated section headers.',
        ].join(' '),
      },
    ],
  },
  {
    id: 'library-empty',
    label: 'Library — empty state',
    run: async (page) => {
      // The shared test-home database persists across runs (the filmstrip e2e
      // seeds 12 completed jobs through the storage API, which has no delete
      // route). For a deterministic EMPTY-state capture, clear the jobs table
      // directly in SQLite (WAL mode — safe alongside the running server).
      const databaseFile = resolve('test-home/studio.db')
      if (existsSync(databaseFile)) {
        const db = new Database(databaseFile)
        try {
          db.exec('DELETE FROM jobs')
        } finally {
          db.close()
        }
      }
      await page.goto('/')
      await page.getByRole('button', { name: /library/i }).first().click()
      await expect(page.getByRole('heading', { name: /video library/i })).toBeVisible()
      await page.waitForTimeout(400)
    },
    checkpoints: [
      {
        id: 'library-empty-1080p',
        label: 'Library — centered empty state, no cards',
        rubric: [
          SHELL_CONTEXT,
          'The Library view: eyebrow "LOCAL LIBRARY", heading "Video library", a one-line subtitle, and a thin gradient divider.',
          'Controls row: a search input (placeholder "Search prompts..."), "Provider" dropdown ("All providers"), "Sort" dropdown ("Newest first"), a video counter showing "0" of "0 videos", an "Export manifests" button, and an "Open clip editor" button at the heading\'s top right.',
          'The body is the EMPTY state: a centered block inside a large dashed-border container, holding a history/clock-style icon, the bold line "Completed generations will appear here." and a smaller secondary line "New work is saved automatically on this device.".',
          'NO video cards, thumbnails, grid items, or skeleton loaders anywhere.',
          'Defects to flag: any card/thumbnail present, the empty state not centered, overlapping or clipped controls, truncated labels.',
        ].join(' '),
      },
    ],
  },
  {
    id: 'create-keyboard-dialog',
    label: 'Create view — keyboard-opened dialog with focus ring',
    run: async (page) => {
      await page.goto('/')
      await expect(page.locator('#prompt')).toBeVisible()
      // Keyboard-only walk backward to the prompt-library trigger (the same
      // route the keyboard-operability e2e takes) and open with Enter, so the
      // capture shows the dialog PLUS a genuine :focus-visible ring.
      const prompt = page.locator('#prompt')
      await prompt.focus()
      for (let index = 0; index < 60; index += 1) {
        if (await page.evaluate(() => document.activeElement?.classList.contains('prompt-library-open') ?? false)) break
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
        id: 'create-keyboard-dialog-1080p',
        label: 'Create view — prompt library dialog opened by keyboard, focus ring visible',
        rubric: [
          SHELL_CONTEXT,
          'The Create view behind a dimmed modal overlay — background controls stay recognizable (sidebar, heading silhouettes), never fully black.',
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
]
