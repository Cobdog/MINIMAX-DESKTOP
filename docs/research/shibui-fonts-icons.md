# Shibui fonts + icons + cursor — the research pass before the Monoka style rework

> **Provenance.** Ordered 2026-09-21 by the coordinator as the research pass that PRECEDES the wave-3 style rework (R-15 visual language; remediation-plan §3 Wave 3), under maintainer directive **55857485** on epic 4lphxv8 (the aesthetic lock: shibui 渋い, sumi-ink charcoal, washi text hierarchy, vermillion single accent). A mid-pass scope addition from the maintainer (2026-09-21, relayed by the coordinator) folded in §5 — the custom cursor. No Flux task yet at writing (coordinator places this under the epic after delivery); the directive id is the traceable anchor.
> **METHOD.** Three evidence layers, tagged per claim: **[DOC]** verified in shipped code or official source (our repo; lucide.dev; jetbrains.com/lp/mono; monaspace.githubnext.com; usgraphics.com; CSS spec/MDN), **[COMM]** reputable community claim (dated), **[SPEC]** plausible-unverified. Facts marked *"measured 2026-09-21"* were taken directly from the npm registry, the GitHub Releases API, and the Google Fonts CSS API (variable-range probes + woff2 HEAD sizes) on that date. Code side: `src/styles.css`, `package.json`, `scripts/audit-licenses.cjs`, and all 38 lucide-importing files read; all 97 in-use icon names enumerated mechanically. No GPU, no engine, no UI changes.
> **Freshness.** This space moves; every version/size claim below carries its measurement date. Re-verify the npm/GitHub numbers if this doc is acted on more than a few weeks out.

---

## 0. Where we start from [DOC]

- **No bundled fonts at all.** `src/styles.css:3` bodies on `'Segoe UI Variable Text', 'Segoe UI', sans-serif` (Windows-first; Linux/macOS fall to whatever sans-serif resolves to); `:139` headings on `'Segoe UI Variable Display'`; mono is the generic `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` chain. No `@font-face`, zero woff2/ttf/otf under `src/` or `public/`. The rework introduces self-hosted fonts for the first time — no migration, only adoption.
- **The mono voice is scattered.** ~20 ad-hoc `font-family: ui-monospace, Consolas, monospace` declarations across `canvas.css` (14), `proto.css` (4), `poserig.css`, `datasets.css`, `styles.css` (2) — a tokenless mono. The font-token work consolidates these.
- **The type scale's floor is 7px.** Tokens run `--text-2xs: 7px … --text-2xl: 16px` (`styles.css:47-54`). No font survives 7px at 1080p gracefully; §4 treats this as a finding, not a given.
- **Icons: `lucide-react ^0.468.0`** (package.json:53), 97 unique icon names across 38 files [DOC, enumerated]. Full list in §2.

---

## 1. Type candidates per role (the shibui lens)

The aesthetic splits the typographic work cleanly: **the mono is the machine voice** (LLM transcripts, technical values, kbd hints, canvas readouts — the densest surfaces we have) and **the body is the human voice** (warm, washi-neutral, quiet). The pairing strategy — cool-neutral mono over warm humanist body — is itself the shibui statement: the two voices never compete. All candidates below are OFL (self-hostable, AGPLv3-compatible; §3 covers the license mechanics).

### 1a. MONOSPACE — the load-bearing choice

| | Foundry / designer | License | Variable? | Size (latin, measured 2026-09-21) | Small-size / 1080p reputation | Notes |
|---|---|---|---|---|---|---|
| **JetBrains Mono** | JetBrains, 2020– | OFL | **Yes** — wght 100–800 + italic (GF CSS API 200 on range probe) | **39 KB** woff2 variable (italic 41 KB) | Engineered for exactly this: increased x-height, taller lowercase, wider letter-spacing for code at small sizes [DOC jetbrains.com/lp/mono]; top pick in 2026 roundups [COMM devresourc.es, primetechnologiesglobal.com] | **Dotted zero** (0 ≠ O), fully distinct 1/l/I [DOC]. Ligatures live in `calt` — disable per-surface with `font-feature-settings: 'calt' 0`; an official **NL (no-ligature) variant** exists if we want zero ligatures globally [DOC]. Last GitHub release v2.304, 2023-01 [measured] — mature and quiet, not abandoned (fonts should converge). |
| **IBM Plex Mono** | IBM BX&D / Mike Abbink, 2017– | OFL | **No** — static per weight (range probes 400; single weights 200) | 14–16 KB per weight (400/600/italic measured) — 3 weights + italic ≈ 60 KB | Excellent UI track record; "hard to beat… really nice italics, which most monospaced fonts don't" [COMM HN 2025-02] | The **warm** mono — humanist, pairs natively with Plex Sans. Best italic in the field (LLM transcripts use emphasis). No variable axis has shipped despite being on IBM's roadmap since 2022 [COMM IBM/plex#462]. |
| **Monaspace** | GitHub Next + Tolga Tademir, 2023– | OFL | **Yes** — 5 subfamilies, each wght 200–800 (+ width variants) | per-subfamily variable ~40–100 KB class | **Texture healing** (calt-based density equalization) "evens out the density of monospaced type" [DOC monaspace.githubnext.com] — aimed at *reading* dense code/logs, i.e., our LLM-console case | Mixed reports: loved for reading, some find healing distracting while *typing*, ligatures controversial [COMM CodePen 2023-11]. v1.400 released 2026-03-28 [measured] — actively maintained. Bigger files; five families is temptation we don't need. |
| Berkeley Mono | U.S. Graphics (Berkeley Graphics) | **Proprietary** — n/a | No | n/a | The "quiet luxury" community darling | **REJECTED**: "Commercial licenses are not compatible with open-source apps", app embedding needs a separate license, no redistribution [DOC usgraphics.com]. Monoka is AGPLv3-when-public; the font cannot ship in the repo. |
| Geist Mono | Vercel × Basement Studio | OFL 1.1 [DOC github.com/vercel/geist-font] | Yes — 100–900 | 22 KB | Clean Swiss-neutral | Runner-up bench: excellent size economy; slightly cool/clinical for shibui warmth. |
| Spline Sans Mono / Martian Mono / Red Hat Mono | Ético / Evil Martians / Red Hat | OFL | Yes / Yes / Yes | 35 / 23 / ~30 KB | Decent | Viable but unremarkable for us; Martian is deliberately wide (values, not transcripts). |

**MONO RECOMMENDATION: JetBrains Mono (variable).** It wins on the maintainer's exact bar — dense-but-not-cramped legibility at 1080p — with the dotted-zero/1lI disambiguation the technical-values role demands, a genuine variable file at 39 KB, and the canonical Nerd-Fonts base (§1d). The neutral-cool temperature is a feature in the pairing, not a compromise. **Runner-up: IBM Plex Mono** — if the transcripts' italic emphasis matters more than one-file-many-weights, or if the whole stack goes Plex for the unified-family warmth (a legitimate alternative stack: Plex Sans + Plex Mono, both warm, mono static-only). **Third: Monaspace (Neon or Argon)** — the texture-healing reading case is real, but it's the experiment; revisit only if JetBrains Mono disappoints in the LLM console at 10–12px.

### 1b. BODY — the washi voice

| | Foundry | License | Variable? | Size (latin, measured) | Notes |
|---|---|---|---|---|---|
| **IBM Plex Sans** | IBM BX&D / Abbink–van der Laan, 2017– | OFL | **Yes** — Google Fonts serves `font-weight: 100 700` variable with unicode-range splits (measured; official IBM packages remain static-per-weight) | **44 KB** woff2 variable | Humanist warmth that matches washi; a decade of IBM Design Language use at UI sizes; design kinship with Plex Mono keeps a whole-family swap path open (the modularity contract, in type). |
| **Hanken Grotesk** | Hanken Design Co. / Alfredo Marco Pradil | OFL | Yes — 100–900 | 33 KB | Warmer, quieter grotesk; the widest weight range here (granular 500-vs-550 restraint play). Slightly less battle-tested at UI micro-sizes than Plex. |
| **Source Sans 3** | Adobe / Paul Hunt (Source Sans lineage, 2012–) | OFL | Yes — 200–900 | 28 KB | Literally designed for small-size UI legibility; the most conservative pick; least warmth. |
| Inter | Rasmus Andersson | OFL | Yes | ~30 KB class | The small-size hinting king — but cool-neutral to a fault; it would undo the washi warmth in the very tokens the rework is FOR. Bench only. |

**BODY RECOMMENDATION: IBM Plex Sans (variable).** Warm humanist + UI pedigree + a real variable build at 44 KB + the Plex-Mono swap path. **Runner-up: Hanken Grotesk** (warmer, wider range, 11 KB cheaper — a perfectly defensible swap if Plex reads too "corporate IBM" on the maintainer's screen). **Third: Source Sans 3** (small-size conservatism over warmth).

### 1c. HEADERS — restraint is the answer

**HEADERS RECOMMENDATION: the body family itself, weight 600, tracking tightened −0.5% to −1.5% by size** (`font-weight: 600; letter-spacing: -0.01em` at display sizes; less below 20px). Two families total (human grotesk + machine mono) IS the shibui move: hierarchy carried by weight, size, and ink — not by a third voice. The current code already gestures at this (`'Segoe UI Variable Display'` = same family, heavier cut [DOC styles.css:139]).
*If a distinct display voice is ever wanted*: **Hanken Grotesk 600–700** as the display cut over Plex body (the split stack), or — flagged as the one permissible flourish, recommended against by default — a quiet serif (**Source Serif 4**, OFL, variable, 119 KB latin measured; or Newsreader, 128 KB) reserved strictly for the biggest moments (the app title, the About/monozukuri prose). Three families is noise for a dense technical tool; the serif option exists to be *considered and declined*, on the record.

### 1d. THE NERD-FONTS COMPANION

**Nerd Fonts is at v3.5.1, released 2026-08-21** [measured, GitHub API]. Asset reality (measured): `JetBrainsMono.zip` = **127.77 MB**, `Monaspace.zip` = 261 MB, `NerdFontsSymbolsOnly.zip` = **2.91 MB** — shipping a full patched font is a non-starter; the symbols-only pack is the strategy (§3).
- **Base: JetBrains Mono** (matches §1a; `JetBrainsMono Nerd Font` is the canonical NF build; its double-width icon glyphs read larger/more legible than Monaspace's scaled-down single-cell icons [COMM nerd-fonts issues]) — but note the *deployment never patches our actual UI font*: the symbols pack is layered as a **fallback**, so the "base" only names the family users would install themselves for full-font contexts.
- **Coverage**: v3.5.x glyphs = Seti-UI + Powerline/Powerline-Extra + Font Awesome + Devicons + Octicons + Material Design + Font Logos + Weather [COMM nerdfonts.com cheatsheet] — everything the "powerline-ish UI glyphs plus media/transport fallbacks" criterion names. But the doctrine is: **transport/status icons in the UI are lucide's job** (drawn SVG, consistent stroke); the NF layer exists for *embedded-glyph strings* (engine log tails, terminal-ish readouts, any PUA codepoint that arrives in data), not as an icon system.

---

## 2. The icon library call

**Audit of what we use** [DOC, enumerated 2026-09-21]: 97 unique names across 38 files — the full list: Activity, AlertCircle, AlertTriangle, Aperture, ArrowDown, ArrowUp, AudioLines, Bookmark, Brush, Camera, Captions, Check, ChevronDown/Right/Up, CircleDot, Clapperboard, ClipboardCopy, Clock3, Copy, CopyPlus, Cpu, Crosshair, Database, Dices, Download, Eraser, Eye, FileJson, FileVideo, Film, FlipHorizontal2, Folder, FolderOpen, Frame, Gauge, GitBranch, GitFork, Globe, Grid2x2, HardDrive, History, Image, ImagePlus, Info, Layers, LayoutList, Library, Lightbulb, Link2, LoaderCircle, Lock, LockOpen, MapPin, Maximize2, MessageSquareOff, MessageSquareText, Minus, Move, Move3d, Music2, PackageOpen, Pause, PersonStanding, Pin, Play, Plus, Power, RefreshCw, RotateCcw, Save, Scale, Scan, Scissors, Search, Send, ServerCog, Settings, ShieldAlert, ShieldCheck, Shirt, SkipForward, SlidersHorizontal, Sparkles, Square, Star, Stethoscope, Trash2, Undo2, Unplug, Upload, Users, Video, Volume2, Wand2, WandSparkles, X.

**Coverage verdict against lucide-react 1.47.0** (measured against the shipped `dist/lucide-react.d.ts`): 3,698 declared components / 8,177 exported names including aliases; **all 97 of our icons remain importable today** — 89 as canonical names, **8 via legacy aliases** (AlertCircle, AlertTriangle, FileJson, FileVideo, FlipHorizontal2, History, Trash2, Wand2). Lucide hit 1.0 in June 2026 (brand icons removed — we use none; `aria-hidden` now the default; leaner builds) [COMM InfoQ 2026-06-23, lucide.dev]; release cadence is near-weekly (1.44→1.47 across 2026-09-10→17) [measured]. Foreseeable three-surface needs spot-check clean: canvas ops (zoom-in/out, frame, group/ungroup, magnet/snap, lasso/marquee-class selection, hand), media transport (step-back/forward, rewind, repeat/loop, volume set), rack controls (sliders, gauge, dial-class), status (wifi/wifi-off, circle-check/x/alert, badge-check, timer) — every concept present; verify exact canonical names at use time (the v0-era numbered aliases are being retired across 1.x).

**Alternates, honestly weighed** (versions measured 2026-09-21):

| Library | License | Latest | Cadence | Fit / coverage | Verdict |
|---|---|---|---|---|---|
| **lucide-react** (current) | ISC | 1.47.0 (2026-09-17) | weekly | 24px grid, 2px stroke, quiet rounded geometry — the closest existing match to shibui's 1px-line restraint; full coverage of our 97 + foreseeable needs; ESM, tree-shakes per-icon; aria-hidden default | **KEEP — upgrade `^0.468.0 → ^1.47.0`** |
| @tabler/icons-react | MIT | 3.47.0 (2026-09-18) | very active | Similar quiet 24px/2px language, ~5,900+ icons (outline+filled) [COMM]; squarer terminals | Viable alternate — but churning 38 files for a lateral move fails the smallest-change rule; revisit only on a lucide coverage wall |
| @phosphor-icons/react | MIT | 2.1.10 (2025-05-22) | **stale 16 months** [measured] | 6 weights incl. a lovely thin/light (the most shibui strokes in the field) | The weight control is real; the dormancy is disqualifying for a decade-scale app |
| @heroicons/react | MIT | 2.2.0 (2026-05-12) | Tailwind-paced | ~1,500, three styles; Tailwind-coupled vocabulary | Too small/expressive for our breadth (rack + canvas + transport + diagnostics) |
| Iconify (`@iconify/react` etc.) | MIT tooling; **per-set licenses** | n/a | meta | 100+ sets, on-demand or build-time | The per-set license surface and runtime-fetch default cut against local-first/offline boot; only worth it for one-off glyphs (e.g., a brand mark) — draw those as inline SVG instead |

**ICON RECOMMENDATION: stay on lucide-react; bump to ^1.47.0** as its own chore (typecheck-driven; do the 8-name canonical rename sweep in the same pass so nothing rides an alias slated for removal). No migration, no new dependency, thematically already right. The upgrade is the *only* action item, and it is cheap.

---

## 3. The deployment shape

**Self-hosted `@font-face`, variable-first, tokens all the way down.** The app is AGPLv3 local-first — webfont-service licensing was never on the table, and every recommendation above is OFL, which permits bundling and embedding in AGPL software provided the license text ships and the Reserved Font Name rules are respected (no renaming the files' internal names; subclassing/modifying needs a new name — we do neither).

1. **Files** — `public/fonts/` (stable URLs; Vite copies as-is): `JetBrainsMono[wght].woff2` (39 KB), `IBMPlexSans[wght].woff2` (44 KB), plus `SymbolsNerdFontMono-subset.woff2` (§3.2). Italic file(s) only when the LLM console actually styles emphasis (JBM italic variable: +41 KB). Latin subset; add `latin-ext` slices with `unicode-range` only if non-English input becomes real.
2. **The Nerd-Fonts layer, minimal** — start from `NerdFontsSymbolsOnly` (2.91 MB zip, v3.5.1), then `pyftsubset` (fontTools) to the ranges we actually render: the PUA planes' useful slices (powerline, material, octicons, FA) ≈ **~40–60 KB woff2** [SPEC — confirm at build]. It is declared *after* the primary mono and *before* the generic fallback, so only PUA codepoints fall through to it — normal text never touches NF metrics. Never bundle a full patched font (127 MB class).
3. **CSS token structure** (the retheme-as-token-swap contract — sits beside the existing `--text-*`/color tokens in `:root`):

```css
--font-body: 'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif;
--font-display: var(--font-body);            /* headers = body family, weight game */
--font-mono: 'JetBrains Mono', 'Symbols Nerd Font Mono', ui-monospace,
             SFMono-Regular, Consolas, monospace;
--font-symbols: 'Symbols Nerd Font Mono';     /* standalone glyph spans, if ever */
@font-face { font-family: 'JetBrains Mono'; src: url('/fonts/JetBrainsMono[wght].woff2')
             format('woff2-variations'); font-weight: 100 800; font-display: swap; }
```

   The ~20 scattered `ui-monospace` declarations (§0) collapse onto `var(--font-mono)`. A future retheme swaps three strings — the modularity test, applied to type.
4. **Loading** — `font-display: swap` (local disk: the swap window is one paint); `<link rel="preload">` the two workhorse woff2s in `index.html`. Variable fonts also interpolate cleanly at the canvas's fractional zoom scales, where static hinted instances only rasterize crisply at integer sizes.
5. **License mechanics** [DOC `scripts/audit-licenses.cjs` scope] — the machine gate scans npm deps (SPDX vs its allowlist) and vendored/custom-node dirs for LICENSE files; `public/fonts/` is invisible to it. So the obligation is the human one, per conventions: ship `public/fonts/OFL.txt` (both families' texts — they are separate copyright holders), and add `docs/LICENSES.md` rows for JetBrains Mono + IBM Plex Sans + the NF symbols pack (NF glyph sets are OFL/MIT-class per upstream; the subset inherits them — note sources in the row). If the maintainer prefers the strict fetchable route for fonts-as-data, the fetchCatalog can carry them — recommended against: fonts are boot-critical UI assets, not weights; a fresh local-first clone should boot complete.
6. **Estimated asset weight, whole program**: 39 (mono var) + 44 (body var) + ~50 (NF subset) ≈ **~135 KB of fonts**, +1 optional 41 KB italic, + ~8 KB of cursor PNGs (§5). For scale: under 0.03% of one model file.

---

## 4. What shibui means for the type specifically

**The moves that carry the aesthetic:**
- **Weight restraint as hierarchy.** Body lives at 300–450; headers top out at 600; 700+ exists only for numerals that must survive glance-reading (queue positions, durations). The variable files make 450 and 550 real weights, not rendering guesses — use them; a 500 that is secretly a rounded 400 is exactly the sloppiness shibui forbids.
- **Dense but never cramped.** Line-height 1.45–1.6 for transcripts; `text-wrap: pretty` nowhere critical (values must not reflow); the mono's own spacing does the density work — don't add negative tracking to monospace, ever.
- **Ink discipline.** Hierarchy comes from the washi ladder (full-washi primary → aged-washi secondary), not from hue or glow. Muted is still ink: keep secondary text at contrast that would survive a screenshot printed on paper — "calm" must not become "low contrast" (the maintainer's own bar).
- **Vermillion is the maker's mark, full stop.** The seal appears on *sealed artifacts* — canonical takes, locked chains, the "sealed by the maker" moment. It is NOT for links (links are washi-bright + underline-on-hover), NOT for focus (focus = the 1px line gaining weight and full-washi text; WCAG-visible without a drop of red), and not for cursors (§5). One accent, never decoration.
- **The 7px floor is a defect, and the rework should raise it.** [DOC styles.css:47-54] `--text-2xs: 7px` and `--text-xs: 8px` are below any font's graceful floor at 1080p — no typeface choice fixes this. Recommendation: the rework's type scale bottoms at **10px** for readable micro-labels, with 8px retained (if at all) only for glyph-count badges where a digit or two is being counted, not read. Flagged here so the style rework owns it consciously.

**The ban list (anti-patterns):**
- All-caps sprawl. Small-caps/uppercase only for ≤3-word micro-labels (status chips), always with modest tracking — never headings, never sentences.
- Letter-spacing as decoration. Tracking is optical correction at display sizes and the micro-label case above; `letter-spacing: 0.3em` on titles is the anti-shibui.
- Low-contrast mist (gray-on-charcoal past 4.5:1 for anything meant to be read).
- Three-plus type voices; italic-for-emphasis in transcripts (weight, not slant); text-shadow/glow/gradient type of any kind; center-aligned body text.

---

## 5. The custom cursor (maintainer scope addition, 2026-09-21)

**Direction — a quiet, precise family.** The cursor is chrome, not content: sumi-ink fill, 1px washi counter-outline (legible over charcoal AND over bright media), 24px grid, nothing else. **Vermillion does not get a cursor** — decided lean-no per the coordinator's framing, and the reasoning is the aesthetic itself: the seal marks *artifacts* (a sealed take), never pointers; a red cursor following every motion is the definition of decoration. The one candidate exception (vermillion cursor hovering a canonical take) was considered and rejected — the seal already lives on the artifact.

**Technical shape** (facts tagged; this is the part that silently fails if done naively):
- **PNG data-URIs, not SVG cursors.** SVG cursors rasterize at **@1x in all major engines** — never retina-sharp [COMM Tumult forums/WebKit discussions]; PNG at 1x + @2x is the crisp path. `.cur` files are IE-era baggage — skip.
- **Hotspot precision is non-negotiable.** `cursor: url(...) x y, <keyword>` — integer hotspot, and a mandatory native keyword fallback after every url [DOC CSS UI spec/MDN]. The crosshair's hotspot must sit at the exact geometric center of the reticle; a half-pixel-misaligned crosshair at canvas zoom is *worse than the native cursor* (every crop edge lands where the user didn't point).
- **Size discipline**: keep ≤32 logical px (Chromium's practical compatibility ceiling is 128 px, but platform cursor systems live at 32) [COMM MDN-adjacent]. Design on the 24px grid, 2px ink strokes; export 48px @2x with 4px strokes, same logical footprint, hotspot doubled.
- **High-DPI**: cursors render in device pixels and CSS offers no srcset for them — the standard shape is resolution-scoped rules: `@media (resolution: 2dppx) { .crop-tool { cursor: url(...@2x.png) 24 24, crosshair; } }`. This satisfies the same 1080p-AND-hiDPI bar the fonts answer.
- **Accessibility fallbacks (the set must degrade cleanly)**: (1) a persisted settings toggle "custom cursors" (default on) whose off-state returns every context to native — users on OS large-pointer/pointer-scheme settings get their scaling back, since CSS url-cursors ignore those schemes; (2) native keyword fallback after every url so any load failure degrades silently; (3) `cursor: none` is banned outright, anywhere, forever.
- **The set — five custom cursors, restraint is the aesthetic**: `default` (arrow), `pointer` (actions), `crosshair` (crop/draw/align/camera-path editing), `grab`, `grabbing`. Everything else stays NATIVE and that's the point: `text` caret, the resize edges (`ew/ns/nwse/nesw-resize`), `not-allowed`, `zoom-in/out` — native cursors are already hairline-quiet and universally learned. 5 cursors × 2 DPR = **10 PNGs ≈ 8 KB**, inlined as data-URIs or under `public/cursors/`, assigned via tokens (`--cursor-crosshair`, …) so the map lives in one place: canvas background pan → grab/grabbing; tile/rack drag → grabbing; crop/draw/align tools + node-edge binding → crosshair; buttons/links/typed-hole rows → pointer; inputs → native text; resize handles → native resize; disabled → native not-allowed.

---

## 6. The recommendation

| Call | Decision |
|---|---|
| **Mono (LLM output + technical values)** | **JetBrains Mono, variable (100–800), latin woff2, 39 KB** — dotted zero, distinct 1/l/I, x-height/spacing engineered for small-size density; `calt` off where transcripts must be verbatim |
| **Body** | **IBM Plex Sans, variable (100–700), latin woff2, 44 KB** — warm humanist washi voice; Plex-Mono swap path kept open |
| **Headers** | **The body family at 600, tracking −0.5…−1.5% by size** — two voices total; the serif display option is on record and declined |
| **Glyph pack** | **Nerd Fonts v3.5.1 Symbols-Only, pyftsubset to used ranges (~40–60 KB woff2), layered as mono-fallback**; base-family answer for full-font users: JetBrainsMono Nerd Font; UI icons are NEVER font glyphs |
| **Icon library** | **Keep lucide-react; upgrade ^0.468.0 → ^1.47.0** with the 8-name canonical sweep — coverage 97/97 + foreseeable, ISC, weekly cadence, already the right stroke language |
| **Cursor** | **5-cursor quiet family (default/pointer/crosshair/grab/grabbing), ink + 1px washi outline, 24px grid, PNG 1x/@2x via resolution media queries, hotspots integer-exact, native fallback everywhere, settings toggle, no vermillion** |
| **Deployment** | `public/fonts/` self-host + OFL.txt + `docs/LICENSES.md` rows; `--font-body/--font-display/--font-mono/--font-symbols` tokens; consolidate the ~20 ad-hoc mono declarations; preload the two workhorses; retheme = token swap |
| **Asset weight** | **≈135 KB fonts core (~176 KB with italic) + ~8 KB cursors ≈ 0.15 MB total** |

**Runners-up worth remembering:** IBM Plex Mono (warmest mono, best italics — the swap if transcripts want italic emphasis; static-only) and the full-Plex stack (Plex Sans + Plex Mono, maximum family unity at the cost of the variable mono); Hanken Grotesk (body swap-in if Plex reads too corporate — warmer, wider range, 33 KB); Monaspace Neon/Argon (the texture-healing experiment for the LLM console, if JetBrains Mono ever disappoints there); Tabler icons (the lateral-move alternate if lucide ever walls us on coverage).

**Corrections** to this document arrive as dated addenda, never silent rewrites.
