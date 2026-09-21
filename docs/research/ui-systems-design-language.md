# UI systems & design language — the full design-system research pass

> **Status:** research capture for the shibui style rework + the Control Center / Workbench spec rounds. Directive 49966214 (epic 4lphxv8) is the charter; this document feeds remediation-plan §6 DA-5 (the rack-primitive question), the wave-3 style rework, and the two post-foundation surface specs.
> **Dated:** 2026-09-21, researched at main HEAD `0fddde7`.
> **Method:** every claim about OUR code was verified by reading it this session (file:line anchors at this HEAD); every library claim was verified against the npm registry and GitHub TODAY (dates inline) — this space moves monthly.
> **Dependency (resolved):** the font/icon/cursor pass landed as `docs/research/shibui-fonts-icons.md` (commit `423d667`) while this document was being finalized. The type stack is that document's territory and a FOUNDATION LAYER here: **JetBrains Mono** (mono), **IBM Plex Sans** (body; headers = same family at weight 600 with tightened tracking), self-hosted OFL `@font-face`, and **lucide-react stays, bumped to ^1.47.0** (8 legacy-alias names to canonicalize). Where this document touches type or icons it cites those calls; it does not re-derive them.

**The charter (maintainer, verbatim):** "I don't want 500 libraries where we only use each for one thing, but I also don't want to handroll everything. A full toolbox of robust libraries and frameworks to build whatever we want cheaply and easily is king. Reusing components and code is also king." The success test: future building requires "a lot less choices, and a lot less duplication, avoiding decomposition in the future" — fast but accurate.

**The aesthetic (directive 55857485, settled — never re-litigated):** SHIBUI (渋い) — quiet, unobtrusive sophistication; restraint in what's allowed to be loud; never a zen garden. Sumi-ink warm charcoal base, washi warm-neutral text hierarchy, **vermillion (朱) as the single accent** meaning "the maker's mark / sealed" (canonical takes, locked chains), faint oiled-wood warmth on dock/panel chrome, 1px lines stay, restrained shadows, one-accent-never-decoration.

**The architecture (directives dbbc10fc + a6eeb426, settled):** three surfaces — WIRING (the infinite canvas), CONTROL (the rack), CREATION (the workbench) — as workstations in one workshop, modular to the core: pulling a tool out must be as easy as buying a new one.

---

## 1. The concern map — the enumeration, solved one by one

The maintainer's nine, plus the nine a dense three-surface creation tool actually needs (each addition justified in one line). Current state verified in code; the solution is named here and specified in §4–§6.

### 1.1 The maintainer's enumeration

| # | Concern | What it means HERE (verified current state) | Where the answer lives |
|---|---|---|---|
| C1 | **Responsive views** | Desktop-first density with real narrow-viewport bugs in the record: docks sailing off-screen (dockGeometry.ts clamps, added 2026-09-19), the programmatically-scrolled-root slide (canvas.css:7–14, `overflow: clip` fix), the 680px/900px media-query blocks (styles.css:371–404). Three surfaces = three responsive stories today: canvas (viewport-anchored), datasets/workbench (`position: fixed; inset: 0` apps, datasets.css:6 / workbench.css:5), docks (react-rnd clamped). | §4.1 placement rules + §6 per-zone; the canvas substrate is FIT for wiring (keep-list, remediation §6 DA-6); Control/Workbench get grid/rack-native responsiveness |
| C2 | **Modal & popup handling** | StudioDialog (base-ui Dialog: focus trap/restore, Escape, aria, scroll lock) is the settled modal layer — but only 3 call sites use it. FOUR hand-rolled modal backdrops bypass it in the two newest surfaces: `.iw-dialog-backdrop` (workbench.css:132, z 50), `.ds-editor-overlay` (datasets.css:80, z 60), `.ds-caption-overlay` (datasets.css:111, z 60), `.ds-vlm-modal` (datasets.css:124, z 70) — none carry the focus/Escape behavior the wave-2b work centralized. Popups: three hand-rolled popover patterns (`.smart-insert-menu` styles.css:170, `.canvas-bar-opmenu-pop` canvas.css:221, `.canvas-opmodal-addmenu` canvas.css:456) each hand-manage outside-click differently. | §2 base-ui expansion (Dialog/Popover/Menu/ContextMenu) + §5 StudioModal |
| C3 | **Lightboxes** | None exists. The canvas op-modal (canvas.css:437) and clip-modal approximate review surfaces; the workbench needs real ones (zoom/pan media review, multi-image comparison for takes/reference sheets). | §2 YARL + §5 StudioLightbox |
| C4 | **Window sorting, pinning & docking** | The lived system: 5 react-rnd consumers (PropertiesPanel, SettingsDock, DiagnosticsDock, AudioDock, PoseRigDock), a monotonic raise counter (`store.ts:790` dockZ:60 → `raiseDock` increments unbounded), a cascade contract (+180/+48 steps, dockGeometry.ts), and the scroll-clip bug class (react-rnd writes `display:inline-block` inline, beating the dock's grid — every dock carries `display: grid !important`, canvas.css:158/492/507/517). The Control Center's rack needs snap/grid/clustering that react-rnd does not give. | §2 dockview call (DA-5's answer) + §6.2 |
| C5 | **Overflow discipline** (dropdowns, text, chips) | The record: node-pack-row overflowing the 420px dock so buttons were unreachable (styles.css:592–598 M9 fix), the 15,147px settings scroll (Audit A B1), chips wrapping ad hoc. Truncation is per-component hand-rolled `text-overflow: ellipsis` (~40 instances, no title discipline). Dropdowns: 30 native `<select>`s across 11 files — inconsistent chevrons, no keyboard typeahead, no overflow strategy when option text is long. | §4.2 text-layout rules + §5 StudioSelect/Chip |
| C6 | **Z-layering** | A token ladder EXISTS (styles.css:67–76: sticky 10 → dropdown 40 → modal 50 → modal-raised 60 → overlay 70 → toast 75 → overlay-raised 80 → dialog-top 90 → max 100) — but only 9 `var(--z-*)` usages vs ~30 raw magic numbers across canvas.css (2,3,30,40,50,55,60,70), datasets.css (40,60,60,70), workbench.css (40,50,60). THE LIVED INCIDENT: the fetch-consent dialog rendering BEHIND the docked Settings (modal 50 under react-rnd docks 60) — fixed by raising consent to 90 (styles.css:646–654, the documented workaround). | §3 the canon |
| C7 | **Component text layouts** | A de-facto hierarchy exists but is unnamed: `strong` (base) + `small` (base, muted-2) pairs everywhere, uppercase-2xs eyebrows with .04–.16em tracking, the dense 7–16px ramp (styles.css:45–54), the M12 guidance floor (≥10px for onboarding prose, styles.css:315–318). Every surface re-derives it; the workbench/datasets additionally rebuild controls at 9–11px with their own literal fallbacks (`var(--text-2xs, 11px)` — workbench.css:19, datasets.css:37 etc.). | §4.2 |
| C8 | **CSS architecture** | Hand CSS, single-line dense rules, tokens-only color discipline ENFORCED by a custom stylelint plugin (`minimax/no-raw-colors`, stylelint.config.mjs) + a verified codemod (scripts/css-token-codemod.cjs) — but the codemod's FILES list covers only styles.css + guided-studio.css; canvas.css/datasets.css/workbench.css were never folded (hence the fallback-literal pattern). Six CSS files, ~4,300 lines, zero CSS-in-JS. | §4.5 + §7 |
| C9 | **Loaders/progress/skeletons** (animated, jank-free) | Existing: `.spin`, `.progress` (+compact), `.fetch-progress-bar` (determinate + indeterminate keyframe), the canvas tile status ring + sliding progress (canvas.css:68–78), the construction animation (styles.css:232–236), the live F6 preview painter. All CSS/compositor-based. NO skeleton loader exists anywhere. Reduced-motion: a blanket kill switch exists (styles.css:406–408) — it also kills state-conveying animations (progress), which needs refinement. | §4.4 motion rules + §5 ProgressBar/Skeleton |

### 1.2 The additions — what a dense three-surface creation tool actually needs

| # | Concern | Why it's load-bearing here (one line each) | Current state |
|---|---|---|---|
| C10 | **Focus management / focus-visible canon** | The keyboard-first wave started (focus-ring token, styles.css:77–79, 102) but three surfaces of dense chrome need one canon or keyboard users drown differently per surface. | Partial: one global :focus-visible rule; dialogs get traps via base-ui; hand-rolled overlays (C2) get nothing |
| C11 | **Keyboard command surface** | The prototypes define a rich map (J/K cycle, B branch, P pin, R rerun, digits jump — migration-map §7 Q2) and `kbd` hints already render (canvas.css:35); the summonable index (IndexOverlay) is the palette seed — unwritten canon = per-surface drift. | IndexOverlay hand-rolled; kbd styled 4 different ways; no global shortcut registry |
| C12 | **Empty states** | Every zone's first-run and every filtered-to-zero list needs the honest-empty pattern; FirstRunNotice's latch is keep-listed — the PATTERN should be shared, today it's per-surface prose. | ~8 scattered empty styles (`.prompt-library-empty`, `.canvas-timeline-empty`, `.canvas-opmodal-empty`, `.canvas-index-empty`, `.ds-*`…) — all hand-rolled |
| C13 | **Toast/notification architecture** | THREE toast systems exist (`.notice` fixed top-center styles.css:500, `.canvas-toasts` absolute bottom-left canvas.css:187, `.iw-toasts` fixed bottom-right workbench.css:129) — the attention-model routing policy (durable-on-object vs radar vs ambient toast, migration-map row 4) was designed but never built as one seam. | 3 systems, `notify()` seam unified for flows |
| C14 | **Drag affordances** | d3-zoom camera + react-rnd docks + typed-hole wiring gestures + the future rack drag + chip-drag to docks: users need to SEE what grabs, and the modularity contract needs consistent handles. | grab cursors + header-drag handles are per-dock convention |
| C15 | **Scroll containers under virtualization** | The scroll-clip bug class (R-04's `!important` grid fixes) + useWindowedList's measured-window math both live INSIDE scroll containers; virtualized lists under docks/panels is where the next clip bug breeds. | useWindowedList (canvas overlays, 137 lines, measured pitch); no dynamic-height virtualization |
| C16 | **Color/contrast tokens for status severity** | Status is semantic vocabulary across every surface (idle/queued/running/stale/failed tile rings, ok/warn/muted/info pack chips, doctor ok/warn/fail) — currently spread across `--danger/--warning/--color-info` + the legacy `--spectrum-*` rainbow + inline tints; shibui's one-accent law NEEDS severity to be non-accent. | Ring/chip states exist (canvas.css:69–73, styles.css:611–614); severity tokens don't |
| C17 | **Reduced-motion discipline** | The blanket rule exists; the discipline needs the WHEN-moved rules + state-substitution for killed animations (an indeterminate progress that freezes to 0% under reduced motion conveys nothing). | Blanket kill switch only (styles.css:406–408) |
| C18 | **Print / light variants** — **evaluated and REJECTED** | A fixed-dark studio creation tool with projector-facing canvas: a light theme would double every token decision for zero workflow; print has no document-shaped use (manifests export as files). One line of record so it isn't re-litigated. | `color-scheme: dark` (styles.css:2) |

---

## 2. The toolbox — the library calls

### 2.1 The verdict table

| Library | Version verified (date) | License | Call | Serves (≥2 concerns) |
|---|---|---|---|---|
| **@base-ui/react** | 1.8.0 (published 2026-09-04; repo active 2026-09-21) | MIT | **KEEP + MASSIVELY EXPAND** — stays THE primitive layer | C2 modals/popups/menus, C5 selects, C9 progress, C13 toasts, C15 scroll areas, C7 fields/forms, C10 focus (behavior comes with it), C12/disclosure — see §2.2 |
| **react-rnd** | 10.5.3 (2026-03-10) — matches installed | MIT | **KEEP** for the bounded wiring docks (DA-5: "the wiring-surface docks stay react-rnd") | C4 docks (5 consumers), C14 drag affordances |
| **dockview-react** (wraps zero-dep `dockview`) | 8.3.1 (2026-09-10; repo active 2026-09-18) | MIT | **ADD** — the rack primitive for Control Center + Workbench panel management (the DA-5 answer) | C4 sorting/pinning/docking (pinned tabs, floating groups, popout windows — v8 features), C1 persistent serialized layouts, C14 rack drag |
| **@tanstack/react-virtual** | 3.14.13 (2026-09-14) | MIT | **ADD** — dynamic-height + grid virtualization | C15 (workbench media grids, LLM console log, dataset tables, prompt-library results), absorbs useWindowedList's general role over time |
| **yet-another-react-lightbox** | 3.32.2 (2026-07-30) | MIT | **ADD** — the lightbox | C3 (workbench media review, canvas tile inspect, take/reference-sheet comparison) |
| lucide-react | installed 0.468.0; latest 1.47.0 (2026-09-17, ISC) | ISC | **KEEP, bump to ^1.47.0** — the font pass's settled call (all 97 of our icons importable; 8 legacy aliases to canonicalize in the bump); the usage canon is §5.4 | icons everywhere |
| d3-zoom (+selection/transition) | installed | ISC | **KEEP** — the canvas camera is FIT (keep-list) | C14 camera gestures |

**The number: FIVE interactive-UI libraries** (base-ui, react-rnd, dockview, tanstack-virtual, YARL) plus two domain tools already present (lucide for glyphs, d3-zoom for the camera). Defense of the count: three of the five are already in `package.json`; the two additions map one-to-one onto the two post-foundation surfaces the maintainer has already committed to (Control needs the rack; Workbench needs virtualized media + a real lightbox); every entry serves ≥2 concerns from §1; all MIT/ISC — permissive deps inside an AGPLv3 local-first app are compatible (AGPL obligations attach to our code, not the deps; confirmed compatible for self-hosting). Nothing enters that serves one concern — that's the "500 libraries" filter working.

### 2.2 The base-ui coverage audit (the load-bearing finding)

We adopted base-ui in wave 2b for exactly two primitives: Dialog (StudioDialog.tsx:16) and Tabs (StudioTabs.tsx:13). **The installed 1.8.0 exports ~50 component modules — verified by listing `node_modules/@base-ui/react/`** — and the coverage against our concern map is near-total:

| Our concern | Base UI 1.8.0 answer | Stability evidence (changelog at HEAD) |
|---|---|---|
| Modals (C2) | `dialog`, `alert-dialog`, `drawer` | dialog since rc; alert-dialog/drawer stable through 1.x |
| Popups & menus (C2) | `popover`, `menu`, `context-menu`, `menubar` | context-menu sections in changelog since 1.1; menu fixes ongoing in 1.8.0 |
| Dropdowns (C5) | `select`, `combobox`, `autocomplete` | all in 1.8.0 changelog (active fixes: readOnly browsing, group a11y) |
| Toasts (C13) | `toast` (Provider/Viewport/Title/Description/Action/Close parts) | toast sections in every changelog since v1.0.0 |
| Progress (C9) | `progress`, `meter` | progress + meter sections since 1.2/1.3 |
| Scroll containers (C15) | `scroll-area` | since 1.1, active fixes in 1.8.0 (focus-steal fix #5430) |
| Fields & forms (C7) | `field`, `form`, `input`, `number-field`, `fieldset`, `otp-field` | field/form fixes throughout 1.8.0 |
| Disclosure (C12, R-18) | `accordion`, `collapsible` | stable |
| Toggle-class controls | `checkbox`, `checkbox-group`, `radio`, `radio-group`, `switch`, `slider`, `toggle`, `toggle-group` | stable |
| Hover/truncation support (C5) | `tooltip`, `preview-card` | preview-card since 1.1 |
| Bars | `toolbar`, `navigation-menu`, `separator`, `avatar`, `button` | toolbar since beta.5, stable |

(Also exported: `csp-provider`, `direction-provider`, `merge-props`, `use-render`, `unstable-use-media-query` — the last is the only unstable-marked API.)

**The conclusion: base-ui STAYS and becomes what it was bought to be.** It replaces three would-be additions — sonner (its Toast covers our toast concern), any progress library (Progress/Meter), and any popover/menu re-hand-rolling. The adoption gap is not coverage, it's OURS: 2 of ~50 modules used while 30 native selects and four hand-rolled modal backdrops persist. The migration path (§7) closes that gap surface by surface.

### 2.3 The rejected calls (recorded so they aren't re-litigated)

- **motion / framer-motion (13.4.0, 2026-09-16, MIT)** — REJECTED for the style rework. The restraint aesthetic argues for less: our entire motion inventory is opacity/transform micro-moves and short keyframe loops (spin, pulse, slide, notice-enter, fetch-indeterminate — all compositor-only, all in two CSS files), already covered by CSS + the reduced-motion kill switch. A ~40 KB runtime for easings shibui forbids us from using violates the charter. **Re-evaluation trigger:** the Control Center spec calls for rack reflow animation beyond CSS grid transitions (dockview ships its own transitions — evaluate those first).
- **sonner (2.0.8, 2026-08-09, MIT)** — REJECTED: base-ui Toast is already installed and token-styled by us.
- **cmdk (1.1.1, 2025-03-14)** — REJECTED: our summonable index is domain-specific (it zooms the camera to canvas regions — IndexOverlay's row→note contract is ours); it composes from base-ui Dialog + Input; cmdk would drag four @radix-ui deps into a base-ui-only tree. Stale-ish publishes besides.
- **@dnd-kit/core (6.3.1, npm published 2024-12-05 — 21 months stale on the registry despite repo commits 2026-09-12)** — REJECTED for now: dockview owns rack drag, d3-zoom owns canvas drag, and nothing else in the concern map needs generic sortable DnD. **Re-evaluation trigger:** the Workbench spec wants cross-surface asset drag-to-canvas with free-form drop targets (then re-check release cadence first).
- **react-virtuoso (4.18.14, 2026-09-20, MIT)** — REJECTED in favor of @tanstack/react-virtual: virtuoso ships its own DOM/markup, which fights the house rule StudioDialog established (behavior from the library, visuals from hand CSS); tanstack is the headless equivalent (virtual-core + thin adapter, our markup, our tokens).
- **Full component kits (Mantine / Chakra / shadcn)** — REJECTED: the primitive layer is settled; a kit re-introduces the 500-libraries problem inside one package, and shibui would fight every kit default.

### 2.4 The DA-5 answer, stated plainly

**Adopt dockview for the Control Center rack and the Workbench's panel management. Do NOT port the canvas substrate to it — the substrate is FIT (keep-list DA-6: one CSS-transform root, d3-zoom as the sole gesture writer, rAF transforms, signature-gated culling). The wiring docks stay react-rnd** (five consumers, clamped geometry, the cascade contract — dockGeometry.ts — all working). The two managers coexist because they solve different problems: react-rnd = bounded floating panels over a world; dockview = a compositional grid of docked/pinned/floating panels that IS the surface. The DockShell component (§5.2) is what makes them read as one family — same header band, same chrome, same tokens, mounted inside either manager.

---

## 3. The z-layering canon

### 3.1 The evidence (why a canon and not conventions)

1. **The consent-behind-settings incident** (the named lesson): the standard modal layer (z 50) rendered UNDER the react-rnd docks (z 60), so a fetch consent fired from the docked Settings appeared behind it. The fix raised the consent's two layers to `--z-dialog-top: 90` — a documented per-variant workaround (styles.css:646–654) that only exists because **docks sat above modals in the first place**.
2. **The raise counter escapes the ladder**: `dockZ: 60` with `raiseDock()` incrementing without bound (store.ts:790, 1268–1271). After ~10 raises a dock sits above `--z-overlay: 70`; after ~15 above `--z-toast: 75` — every dock grab silently climbs the fixed tiers. The consent incident was this bug's first visible symptom.
3. **The ladder exists but is bypassed**: 9 `var(--z-*)` usages vs ~30 raw literals (canvas.css 2/3/30/40/50/55/60/70; datasets.css 40/60/60/70; workbench.css 40/50/60/5; styles.css 1/2/30) — each surface re-derives its own stack, which is how collisions get born.

### 3.2 The canon (the single ordered ladder)

Remapped from the existing tokens — the numbers move, the tiers get names, and the ORDER is the law:

| Tier | Token | Value | Meaning | Evidence it must cover |
|---|---|---|---|---|
| 0 | `--z-substrate` | 0 | The canvas world, tiles, edges — in-world stacking by DOM order, never z | canvas-world/tiles (canvas.css:43,56) |
| 10 | `--z-surface-chrome` | 10 | Sticky headers, in-surface raised content, drop veils, bottom bar | notice-sticky 10, bottombar 30, dropping veil 30 → this band |
| 20 | `--z-tile-live` | 20 | In-tile overlays (live preview, failure strips) | canvas-tile-live z 2, endpoint z 3 |
| 30 | `--z-panel` | 30 | Floating react-rnd docks & inspectors — **the raise counter lives INSIDE this band: 30 + (n mod 5)** | canvas-inspector 40, poserig/audio 55 |
| 40 | `--z-popover` | 40 | Popovers, menus, selects, tooltips — portal layers anchored to triggers | dropdown 40 today |
| 50 | `--z-modal` | 50 | Blocking modals (StudioDialog) — **always above every dock** | modal 50 |
| 55 | `--z-modal-stacked` | 55 | A modal opened from a modal (consent from a browser dialog) | modal-raised 60 |
| 60 | `--z-overlay` | 60 | Surface-covering overlays: summonable index, lightbox | index-overlay 50, YARL |
| 70 | `--z-toast` | 70 | Toasts — visible above everything a user acts on | toast 75 |
| 80 | `--z-top-interrupt` | 80 | Top-layer interruptions (license gate, crash-level consent) — the fetch-consent precedent's real home | dialog-top 90 |
| 90 | `--z-debug` | 90 | The debug suite's overlay (directive c250ab36) — diagnostic chrome outranks product chrome by design | max 100 |

**The rule: additions are impossible without amending the canon.** A new layer = a PR to this document + a token in `:root` — no raw numbers. Enforcement follows the proven house pattern: a `minimax/no-raw-z-index` stylelint plugin (sibling of `minimax/no-raw-colors`, stylelint.config.mjs) permitting only `var(--z-*)` in `z-index`, plus a codemod leg in scripts/css-token-codemod.cjs covering ALL SIX CSS files (its current FILES list stops at guided-studio.css — that gap is how the drift happened).

**The incident dissolves under the canon:** docks at band 30 sit below modals at 50 — the fetch-consent `z-dialog-top: 90` override (styles.css:653–654) deletes; consent is a plain modal. The dock raise counter, confined to 30–35, can never climb into the modal band again.

---

## 4. The style-guide skeleton — placements + the design language

### 4.1 Spacing & placement

- **Grid:** the 4px grid (`--space-1..10`, styles.css:57–66) is the law; off-grid values are removal scope as surfaces are touched. Section padding standardizes on `--space-3` (12px) for panel bodies, `--space-2` (8px) for control rows, `--space-4` (16px) for page-level surfaces.
- **Gutters:** 12px between sibling controls, 8px inside a control cluster (label+input), 16px between sections. One gutter scale, no per-surface derivation.
- **Panel width ladder:** min 320 / default 720 / max `viewport − 24` — dockGeometry.ts's clamps, promoted from dock defaults to the universal panel contract (C1's narrow-viewport floor).
- **The cascade contract stays** (dockGeometry.ts:13–19): opened-later panels step (+180, +48) so every header band remains reachable; generalized to any floating-surface manager (dockview floating groups inherit the step via default position math).
- **Alignment:** every floating surface's header is a fixed 40px band (the y-step rationale) — icon+title+subtitle left, actions right, drag handle = the whole band. Bottom bars are 44px. Tile chrome insets 10px.

### 4.2 Component text layout rules

- **The hierarchy (formalizing what exists):** `strong` = `--text-base`+600 weight for row labels; `small` = `--text-base` muted-2 for captions; eyebrows/group labels = `--text-2xs`, 650–700 weight, uppercase, .04em tracking (canvas-menu-group-label is the exemplar); **JetBrains Mono** for every technical value, file path, and LLM output (the font pass's mono call).
- **The density contract:** the dense ramp (7–16px) is INTENTIONAL for expert chrome; the M12 guidance floor (≥10px for onboarding prose, styles.css:315–318) generalizes to: any sentence a first-run user must read ≥ `--text-md`. Values/units get tabular-nums (already the canvas convention).
- **Truncation ladder:** (1) single-line ellipsis at every fixed-width label; (2) `title` attribute ALWAYS alongside (the discipline missing in ~40 current ellipsis sites); (3) tooltip for anything needing richer content; (4) PreviewCard (base-ui) where hovering should show the real thing (a take, a model card); (5) the lightbox for full media. Never `overflow-wrap: anywhere` on labels — that's for error text and paths only (current convention, kept).
- **Chip anatomy (C5):** ONE pill geometry — padding 2px 7px, radius 999px, `--text-2xs`, 600–700 weight, uppercase only for STATUS vocabulary. Variants are semantic, not decorative: status (severity-mapped), license (ok/warn), tag, filter (interactive). Overflow: chips wrap (flex-wrap) — they never clip or scroll horizontally; a chip row that would exceed its container collapses to a `+N` chip with a popover (the pattern the node-pack-title row already gropes toward, styles.css:601).

### 4.3 The shared component anatomy — what makes everything read as one family

Every floating surface (dock, panel, modal, menu, lightbox chrome) shares:

1. **The header band** (§4.1) — same height, same typography, same 1px bottom line.
2. **The body** — `grid-template-rows: auto minmax(0, 1fr)` with the scroll container INSIDE (the R-04 lesson encoded as structure: a react-rnd child that isn't a constrained grid becomes an unscrollable clip — canvas.css:154–157, 490–517's `!important` fixes are the scar tissue; DockShell absorbs the fix once).
3. **1px line borders** (`--line` resting, `--line-strong` on hover/raised), radius ladder 12px surfaces / 8px controls / 7px inner / 999px pills.
4. **The shadow ladder:** restrained, two steps — `0 12px 30px rgba(0,0,0,.35)` resting floats, `0 18px 48px rgba(0,0,0,.5)` raised/modals (the two values already dominant in canvas.css). Never colored shadows (the spectrum glow era ends).
5. **The oiled-wood chrome:** panel/dock headers carry the faint warm surface (the shibui lock's dock warmth) — ONE header surface token, not per-surface tints.
6. **Status is severity, never accent** (C16): `--status-idle/queued/running/stale/failed/ok/warn/info` tokens, mapped from the existing ring vocabulary (canvas.css:69–73) — the tile ring, pack chips, doctor rows, and engine dots all read them. The `--spectrum-*` rainbow system (styles.css:414–453: page-heading gradient, mode-tab tints, spectrum-bordered buttons) is **removal scope** — it is the anti-shibui, and every colored-glow utility it enables dies with it.

### 4.4 Motion rules (the restraint canon)

- **Durations:** 90ms micro-feedback (hover, chip lift), 150–160ms enters (notice-enter is 160ms — keep), 400ms for progress-width easing (`.progress i`, keep). Nothing else animates duration-wise; nothing exceeds 500ms.
- **Easings:** `ease` for state loops, `ease-out` for enters, `ease-in-out` for slides. No springs, no bounces, no staggers.
- **Compositor-only:** opacity and transform, always (the existing inventory complies — spin, pulse, slide, float are all transform/opacity).
- **What is allowed to move:** enters/exits, hover feedback, loading indication, the live preview painter (rAF, store-driven — the TransientProbe discipline), user-driven drags. **What is never allowed:** autonomous layout shifts, parallax, attention-seeking loops on static content, auto-carousels. Restraint in what's allowed to be loud — never a zen garden.
- **Reduced-motion (C17):** the blanket kill switch stays as the backstop, but state-conveying animations substitute instead of freezing: indeterminate progress becomes a static half-filled bar with a text phase (already partially true — fetch progress carries a phase label), running rings become solid severity borders, the notice-enter animation drops (position unchanged). Rule: no information may live ONLY in motion.

### 4.5 CSS architecture (C8)

- **What stays:** hand CSS, single-line house format, tokens-only colors (the stylelint plugin), no CSS-in-JS, no Tailwind/utility layer (a utility system would be a second paradigm for zero duplication win — the component library IS the dedup mechanism).
- **What changes:** (1) the codemod's FILES list extends to canvas.css / datasets.css / workbench.css / surfaces.css — killing the `var(--token, literal-fallback)` pattern (a fallback literal means "I don't trust the token layer to load" — fix by making tokens the always-loaded base layer, which main.tsx already guarantees); (2) file ownership becomes layer-mapped: `styles.css` = tokens + global + shared components, per-zone CSS = zone composites only, `src/ui/*.css` = primitive wrappers (new); (3) the z-canon plugin (§3.2).
- **The dead-CSS discipline stays:** the Phase-3→5 historical-comment precedent (styles.css:677–683) — removed surfaces' rules are deleted with the surface, git is the archive.

---

## 5. The component library architecture

### 5.1 The layering

```
L0  Design tokens            src/styles.css :root (+ zone token blocks)     — the shibui palette lives HERE
L1  Primitive wrappers       src/ui/Studio*.tsx + Studio*.css               — behavior from base-ui/dockview/YARL,
                                                                               visuals from hand CSS (the StudioDialog rule)
L2  Shared components        src/components/                                — Button, Chip, Field, DockShell, StudioModal,
                                                                               ProgressBar, Skeleton, EmptyState, StatusDot,
                                                                               Kbd, Lightbox, ToastHost…
L3  Zone composites          src/canvas/ · src/images/ · src/datasets/ ·    — consume L2+L1 only; never reach past them
                               (future) src/control/
```

**The wrapper rule (the modularity contract's UI expression):** every third-party primitive is consumed exclusively through an `src/ui/Studio*` wrapper that binds tokens and classes — StudioDialog and StudioTabs are the precedent. Swapping the primitive layer (or upgrading base-ui across a breaking major) becomes a wrapper-directory change, never a zone-composite hunt. A zone composite importing `@base-ui/react` directly is a lint error (eslint no-restricted-imports rule, same enforcement pattern as the CSS plugins).

### 5.2 The component inventory mapped to existing surfaces — the dedup win

| Shared component | Absorbs (verified duplicates) | Zone consumers |
|---|---|---|
| **StudioModal** (L1, on base-ui Dialog) | `.iw-dialog-backdrop`+`.iw-dialog` (workbench.css:132–141), `.ds-editor-overlay` (datasets.css:80), `.ds-caption-overlay` (:111), `.ds-vlm-modal` (:124) — four hand-rolled modal systems WITHOUT focus/Escape/aria; plus the 3 existing StudioDialog sites keep working | all zones |
| **ToastHost + notify router** (L1, on base-ui Toast) | `.notice` (styles.css:241,500), `.canvas-toasts` (canvas.css:187), `.iw-toasts` (workbench.css:129) — three toast systems; the router implements the attention-model policy: durable failure → on-object + radar; ambient info → toast | all zones |
| **DockShell** (L2) | the five react-rnd docks' repeated header/body/footer markup (canvas-inspector / poserig / audio / settings dock headers, canvas.css:159/493/507/517) — one shell carrying the `!important` display fix, the drag handle, the raise-on-grab, the 40px band | wiring docks + Control rack panels (mounted inside dockview) |
| **Chip** (L2) | `.canvas-chip`, `.canvas-op-chip`, `.canvas-take-chip`, `.node-pack-license`, `.node-pack-mode`, `.node-pack-installed(.ok/.warn/.muted/.info)`, `.llm-family-badge`, `.prompt-library-technique-badge`, `.health-pill`, `.canvas-bar-*` pills — ~10 pill dialects | all zones |
| **Button / IconButton** (L2) | `.primary-button`, `.secondary-button`, `.icon-button`, `.canvas-properties-generate`, `.iw-dialog footer button(.primary)`, `.iw-exit-choices button`, `.ds-*` buttons — ≥6 button dialects; variants: primary (vermillion), secondary, ghost, danger | all zones |
| **StudioSelect / StudioCombobox** (L1) | 30 native `<select>`s across 11 files — one styled select with typeahead, keyboard, long-option overflow; the Settings model-override 26-dropdown wall and every properties-panel picker become instances | all zones |
| **Field / Input / NumberField** (L1) | `.field-group`, `.ds-field`, `.iw-controls` inputs, `.path-input`, `.number-input` | all zones |
| **ProgressBar** (L1, on base-ui Progress) | `.progress(.compact)`, `.fetch-progress-bar` (+indeterminate), `.canvas-tile-progress` — one determinate/indeterminate pair, severity-tintable | all zones |
| **Skeleton** (L2, new) | nothing exists — the loading-state half of C12 | workbench gallery, fetch browser, library overlays |
| **EmptyState** (L2) | `.prompt-library-empty`, `.canvas-timeline-empty`, `.canvas-opmodal-empty`, `.canvas-index-empty`, `.canvas-properties-empty`, `.smart-insert-empty`, `.ds-*` empties — the honest-empty pattern (one sentence + one action) as one component | all zones |
| **StatusIndicator** (L2) | `.status-dot` (×3 bars), the tile status ring vocabulary, engine-chip states — severity-token-driven (C16) | all zones |
| **Kbd** (L2) | four hand-styled kbd rules (styles.css:177, canvas.css:35, canvas.css:487, +datasets) | keyboard surface |
| **StudioCollapsible / StudioAccordion** (L1) | the four `<details>` uses (experimental-settings, properties-models, structured-preview, gpu tiers) — R-18's progressive-disclosure primitive | settings, properties |
| **StudioLightbox** (L1, on YARL) | nothing exists (C3) | workbench, canvas inspect |
| **StudioTabs** (L1, exists) | stays; absorbs `.prompt-library-tabs` + `.mode-tabs` styling dialects | settings, properties, workbench |

**The biggest single dedup win: the modal layer.** Four parallel hand-rolled modal implementations in the two NEWEST surfaces (built AFTER StudioDialog centralized the behavior) — each a fresh focus-trap/Escape/aria omission waiting to become the next consent incident, each with its own z-index guess (50/60/60/70 — three different values for the same concept). StudioModal absorbs all four and the toast trio follows as the second-largest (three notification systems with three positions, three visual dialects, and no shared routing policy).

### 5.3 Living documentation — the recommendation: a lean in-app gallery, NOT Storybook

A registered surface at `?gallery=1` (the surfaces registry's append-one-entry pattern, src/surfaces/registry.ts) rendering every L1/L2 component against live tokens, with states (default/hover/focus-visible/disabled/loading/empty/error) and the severity/accent swatches. Justification: single-maintainer + agent workshop — Storybook is a second toolchain (its own dev-dep tree, build, CI leg, and upgrade track) roughly the size of our entire UI dependency budget, serving a documentation workflow built for multi-contributor design teams; the in-app gallery is e2e-assertable by the EXISTING vision-capture pipeline (scenarios are data), renders against the real tokens (no drift), and costs one lazy route. **Storybook re-trigger:** external contributors arrive at the public Monoka repo.

### 5.4 The glyph guide (folded on top of the font pass's settled icon call)

- **Size canon:** 16px default in dense chrome and rows, 19px section heads (settings-heading), 14px inline-in-button, 26px+ only in modal headers. One size per context, no free choice.
- **Stroke:** default weight everywhere; weight changes are not a styling tool.
- **Names-as-vocabulary:** recurring concepts get ONE icon, recorded in the gallery: engine/CPU, fetch=Download, refresh=RefreshCw (RotateCcw is NOT also "refresh"), consent/license=Scale, running=LoaderCircle+spin, danger/destructive=Trash2, close=X, settings gear… (seeded from verified current usage in Radar.tsx, FetchBrowser.tsx, settings headings). New icons enter through the gallery's vocabulary table, not ad hoc.
- **Color:** icons inherit text color; severity icons take severity tokens; accent-colored icons only at maker's-mark moments. Never decorative tinting.

---

## 6. The per-zone requirement sheets (feeds the spec rounds — does not replace them)

### 6.1 WIRING — the infinite canvas

- **Semantic-zoom text bands:** three bands formalized from the substrate's culling behavior — FAR (poster + status ring only; text hidden), MID (poster + label + meta), NEAR (full chrome: ops, takes, latent strip). Band thresholds are tokens (`--zoom-band-far/mid/near`), not scattered literals; the tile component is the only reader.
- **Tile chrome:** the anatomy in canvas.css:56–114 is the spec seed — poster (16:9), header band, meta line, op chips, take chips, status ring, progress, failure strip. DockShell's body rule applies: nothing in a tile may overflow its border-radius clip.
- **Context menus:** the typed-hole menus (the keep-listed "best information scent in the app") adopt base-ui Menu for keyboard/focus behavior while keeping the availability-gated row anatomy + fetch affordances verbatim (EndpointMenu/options). The consume-side gating (R-22) lands in the spec round.
- **Minimap/radar:** the Radar chip aggregates (running/attention counts, click zooms to trouble); a true minimap is a Control-Center-adjacent question, not wiring's — recorded for that spec.
- **Dock geometry:** clamps + cascade + DockShell; the raise counter confined to the panel band (§3.2).

### 6.2 CONTROL — the rack (dockview)

- **Tiles:** snap/grid/cluster via dockview's grid + groups; rack tiles are VIEWS over server truth (DA-2: reads everything, edits nothing) — preview displays, live dials, cluster labels.
- **Live status at a glance:** every rack tile carries the StatusIndicator vocabulary; running previews pulse on the severity ring, never on accent.
- **Lock-and-cascade states:** the vermillion discipline's home — a locked chain shows the seal (canonical takes, sealed handoffs); cascade-from-here actions read as maker's-mark moments.
- **Persistence:** serialized dockview layouts = the workspace state (one of dockview's core features); the modularity contract's removal test applies per panel (a rack panel is removable = a registry entry, the surfaces-registry pattern).

### 6.3 CREATION — the workbench

- **Media grids:** tanstack-virtual grid mode, virtualized from the start (the gallery is the canonical output home — it grows monotonically); PooledVideoCard/FilmstripPoster remain the media renderers (keep-list).
- **Lightboxes:** StudioLightbox for take comparison (multi-image), full-res inspect, reference-sheet review; keyboard-driven (arrows/zoom/pan) per the keyboard canon.
- **Editors:** crop/inpaint/outpaint surfaces on StudioModal + the op-modal's stage pattern (canvas.css:445 — crosshair painting, mask overlay, scrub); every editor is consent-gated on destructive steps (the ReferenceApprovalModal lineage).
- **LLM console:** streaming log window = virtualized append-only list with stick-to-bottom (tanstack), JetBrains Mono (the font pass's mono), zero-render painting (useLlmStream's discipline).
- **Timelines:** the timeline projection (Director lineage) + LoRA rail stay canvas-side; the workbench's timelines are AUTHORING surfaces (motion graphs, dataset ranges) on the same rail component.
- **Progress everywhere:** every long op (fetch, train, render, export) shows ProgressBar determinate-or-indeterminate + phase text; skeletons for first-load surfaces (the gallery, the library).

---

## 7. The migration path — from today's CSS + scattered components to the library

Ordered so the app never breaks; composes with Wave 3 (R-15..R-24 IA changes) by the rule: **Wave 3 owns WHAT lives where; this path owns WHAT things are made of.** Where both touch a surface, the Wave-3 task builds with the library directly (SettingsView's redesign uses StudioSelect/StudioCollapsible rather than pre-deduping dying markup).

| Step | Contents | Risk | Verify |
|---|---|---|---|
| **0 — Token swap** (the shibui commit) | New semantic tokens land in `:root` as the shibui palette (`--ink-*` surfaces, `--paper-*` text, `--vermillion`, `--status-*` severity set, `--chrome-wood` header surface) ALIASED onto the existing names (`--accent: var(--vermillion)` etc.) — the app re-skins in one commit without touching a single rule; the `--spectrum-*` block + its consumers delete; z-canon tokens land alongside old names (aliases, no renumber yet) | Low (values-only) | vision-capture diff before/after; stylelint; existing suites |
| **1 — Wrapper layer** (pure addition) | `src/ui/` gains StudioPopover, StudioMenu, StudioContextMenu, StudioSelect, StudioCombobox, StudioToast, StudioProgress, StudioCollapsible, StudioTooltip — each on base-ui, each with its tokens-only CSS file; zero consumers changed | Zero (dead code until used) | typecheck; a wrapper smoke test in the vitest suite |
| **2 — Z-canon enforcement** | Docks remap 60→band 30 (raise counter clamped `30+(n mod 5)`); the fetch-consent `z-dialog-top` override deletes (docks now sit under modals); the `minimax/no-raw-z-index` plugin lands with an allowlist for in-world stacking (tile-live/endpoint tiers); codemod FILES extended to all six CSS files | Small, contained | the consent e2e flow (fetch consent visible above docks — the incident's regression test); full e2e |
| **3 — Dedup absorption** (one surface per PR) | Order (avoiding Wave-3 conflict zones first): (a) workbench modals → StudioModal; (b) datasets overlays → StudioModal; (c) toast trio → ToastHost+router; (d) chip/button dialect collapse in canvas chrome; (e) SettingsView/PropertiesPanel conversions ride WITH R-15/R-18 (their tasks) | Medium — behavior gains (focus/Escape) can surface latent bugs | per-surface e2e + keyboard walk (focus-visible canon applied) |
| **4 — Shared-component promotion + gallery** | `src/components/` library formalized (L2 inventory §5.2); `?gallery=1` surface registered; eslint no-restricted-imports blocks zone-level `@base-ui/react` imports | Low | gallery e2e (vision); lint |
| **5 — Zone adoption** | Control Center and Workbench specs BUILD from L1/L2 on day one (this is why the pass precedes the spec rounds); dockview + tanstack-virtual + YARL enter `package.json` at first Control/Workbench build, not before (no shelf-ware deps) | N/A (new surfaces) | their own spec acceptance bars |

**useWindowedList's fate:** stays for the canvas overlays (uniform-cell assumption holds there, it is proven at 300+ objects — the perf-profile fix); the workbench's dynamic-height needs go to tanstack; if the two ever overlap in one surface, tanstack wins and the hook retires with its overlay.

---

## Appendix — verification record

**Codebase (read this session, at HEAD `0fddde7`):** src/styles.css (690 ln — tokens, z-ladder, consent workaround :646–654, M12 floor :315, reduced-motion :406, spectrum :414–453); src/canvas/canvas.css (657 ln — dock `!important` scars :158/492/507/517, tile anatomy :56–114, typed-hole menus :226–250); src/ui/StudioDialog.tsx + StudioTabs.tsx (the wrapper precedent); src/canvas/dockGeometry.ts (clamps + cascade); src/canvas/store.ts:790,1268 (dockZ counter); src/canvas/useWindowedList.ts (137 ln, measured pitch); src/components/FetchBrowser.tsx (consent flow); src/surfaces/registry.ts (append-one-entry); src/images/workbench.css + src/datasets/datasets.css (the four hand-rolled modals, the toast trio, fallback-literal pattern); stylelint.config.mjs + scripts/css-token-codemod.cjs (the enforcement pattern + its FILES gap); package.json. Flux: directive 49966214 (charter), 55857485 (shibui lock), dbbc10fc/a6eeb426 (surfaces/modularity); remediation-plan §6 DA-5/DA-6; Audit A punch list uf6ze42.

**Libraries (npm registry + GitHub, checked 2026-09-21):** @base-ui/react 1.8.0 (2026-09-04, MIT, ~50 modules — verified by listing the installed package; repo pushed 2026-09-21; 1.0 launched Feb 2026 per InfoQ coverage); dockview / dockview-react 8.3.1 (2026-09-10, MIT, zero-dep core, repo pushed 2026-09-18; v8: pinned tabs, multi-row tabs, floating groups, popouts, serialized layouts); @tanstack/react-virtual 3.14.13 (2026-09-14, MIT); yet-another-react-lightbox 3.32.2 (2026-07-30, MIT, zero deps); react-rnd 10.5.3 (2026-03-10, MIT); lucide-react 1.47.0 (2026-09-17, ISC); motion/framer-motion 13.4.0 (2026-09-16 — rejected on fit, not health); sonner 2.0.8 (2026-08-09 — rejected, covered); cmdk 1.1.1 (2025-03-14 — rejected); @dnd-kit/core 6.3.1 (**npm last published 2024-12-05** despite repo activity 2026-09-12 — the staleness datum behind its rejection); react-virtuoso 4.18.14 (2026-09-20 — rejected on architecture fit).

Sources: [Base UI](https://base-ui.com) · [Base UI releases](https://github.com/mui/base-ui/releases) · [InfoQ — MUI Releases Base UI 1](https://www.infoq.com) · [Dockview](https://dockview.dev) · [Dockview v8 what's new](https://dockview.dev/docs/releases/whats-new/whats-new-v8) · [dockview on GitHub](https://github.com/dockview/dockview) · npm registry (version/date/license data above, resolved 2026-09-21) · [dnd-kit on GitHub](https://github.com/clauderic/dnd-kit)
