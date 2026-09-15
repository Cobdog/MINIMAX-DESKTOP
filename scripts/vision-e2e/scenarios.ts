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
          'The Settings view: single-column stack of section cards beside the sidebar, "Settings" heading with subtitle and a "Save settings" button.',
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
          'Bottom timeline: "Key (K)" and "Delete" buttons, a "frame N / 55" readout, a row of many small tick marks (grid frames) with one or two bright green keyframe markers, and a right-aligned note line.',
          'Blessings: the preview canvas may show slight pixelation (intended image-rendering); the figure in the 3D viewport is intentionally flat-shaded without lighting; small muted sub-labels are the app\'s design language.',
          'Defects to flag: 3D viewport empty or all-black, preview canvas blank, limbs missing or single-colored (the limb palette must be multi-colored), overlapping panel content, text clipped by panels, timeline ticks missing.',
        ].join(' '),
      },
    ],
  },
]
