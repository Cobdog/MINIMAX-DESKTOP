# Provenance & licensing note

**License: GNU AGPLv3** (see [LICENSE](../LICENSE)). In the maintainer's words, the intent is:
*nobody gets to profit and hoard their secrets — if they use it, everyone gets the
benefits.* Donations at most, never a paywall, never SaaS. Commercial use is permitted
under AGPLv3 terms: share your source.

**Content stance:** this is a local-first creation tool with no filters, gating, or
telemetry. SFW and NSFW prompts are equally supported in the prompt systems. The tool
is not responsible for what people create with it; its authors are. No stances, no
soapboxing.

## Fork lineage, and why we license this AGPLv3

This project began as a fork of `jamesk9526/MINIMAX-DESKTOP` (upstream carried no
license file). The maintainers' assessment, on these grounds, is that the upstream
material carries no copyright that blocks this relicensing:

1. **Upstream is machine-generated.** The upstream author has publicly stated the
   repository was AI-generated. Under the U.S. Copyright Office's guidance on works
   lacking human authorship, purely machine-generated code is not copyrightable.
   The codebase itself corroborates this: a single ~2,000-line React monolith with
   74 interleaved `useState` hooks and no tests — no human engineering handprints.
2. **We are rewriting it anyway.** The fork has already been decomposed and rebuilt
   (the renderer was fully restructured; the Electron shell was replaced by a
   standalone Node server; every subsystem has been rewritten with a test harness).
   The platform restructure (canvas Phases 0–5b) has since completed: the shell,
   the View union, the Electron packaging, and the upstream monolith are deleted,
   and the measured upstream residue is 3.8% of the tree — quantified in the
   [final-diff statement below](#the-rewrite-measured--final-diff-statement-2026-09-17-task-68rnn84).

We record this reasoning openly rather than quietly: anyone forking **this** project
can evaluate it themselves. If upstream ever asserts contrary rights, the resolution
is the completion of the rewrite — the diff is the evidence.

**IANAL:** this note records the maintainers' good-faith assessment, not legal advice.

## The rewrite, measured — final-diff statement (2026-09-17, task 68rnn84)

The canvas rewrite (Phases 0–5b: `904825c` document store → `75dfeed` Director
Suite; the Phase 5 deletion wave `c61e4c5` removed the old shell, the View
union, and seven views) is complete — the canvas is the default route and the
app's only shell. This section records what the tree now is, measured against
the ARR fork base. It is the quantified form of "the diff is the evidence"
above, and the answer to *what exactly would still be upstream's if the
no-human-authorship position were ever rejected*.

**Method.** Fork base = merge-base `f58eb4b` — the upstream tip itself (James
Knox, 2026-09-09; upstream never moved again, and our side has no upstream
merges: 171 commits, all Cobdog/Aoi, 2026-09-09 → 2026-09-17). Files present
at both ends were compared by blob hash (byte-identical = inherited verbatim);
for changed files, surviving upstream lines are estimated as *base lines minus
numstat deletions*, capped at the file's current size; rename detection at 50%
similarity caught content living under new paths (exactly two hits: the
upstream `plan.md`, archived as `docs/archive/plan-v0.md` at 97% similarity,
and the Electron tsconfig skeleton behind `tsconfig.server.json`). Heuristic
honesty: a base line that survives in place counts as upstream-derived even
when surrounded by our edits, so the estimate errs **toward upstream** — the
conservative direction for a relicensing claim. Identical lines in
`pnpm-lock.yaml` are pin coincidences in a file we regenerate; they are
counted separately and excluded from the headline figure.

**Composition at HEAD (`82cf82a`), by text lines.**

| Slice | Lines | Upstream-derived | Share |
|---|---:|---:|---:|
| Whole tree (457 tracked files) | 122,794 | 6,969 | 5.7% |
| — excluding the regenerated lockfile | 119,312 | 4,516 | **3.8%** |
| Runtime code (src + server + custom-nodes + public + index.html) | 53,401 | 4,171 | 7.8% |
| src/ — the renderer | 33,833 | 4,118 | 12.2% |
| — src/canvas, poserig, prototypes, datasets, views, media, hooks, state, ui | 18,349 | 0 | 0% |
| — src/components (Studios, workspaces, modals) | 2,197 | 1,264 | 57% |
| — src/lib | 9,471 | 878 | 9% |
| — src root files (styles.css, MobileApp.tsx, types.ts, …) | 3,816 | 1,976 | 52% |
| server/ (the Node server) + custom-nodes/ (first-party pack) | 19,515 | 0 | 0% |
| vendor/ (VDN-H3) | 6,265 | 0 | 0% (third-party Apache-2.0, audited — not fork-derived) |
| Base survival: of the fork base's 16,396 text lines | — | 6,969 survive anywhere | 42.5% (41.3% ex-lockfile) |

**What the residue is, and why it remains.** The rewrite targeted architecture
— shell, navigation model, renderer fabric, server — and that material is
gone. Of the 36 base files with no successor at HEAD, the deletions include
the entire Electron shell (`electron/main.ts`, `preload.ts`,
`tsconfig.electron.json`, `scripts/launch-electron.cjs`), the old `App.tsx`
shell, the 96 KB `MoviePlanner.tsx` monolith, `browserMock.ts`, and five
feature components. What survives is working feature surface that the canvas
docked rather than rewrote — every item below is live code with current
importers (verified against the canvas tree), not orphaned files:

1. **The legacy mobile route** — `src/MobileApp.tsx` (420 lines, 388
   retained): the largest single inherited module, reachable only through the
   lazy `?mobile=1` split.
2. **The guided-Studios suite** — the Character/Hair/Wardrobe/Location/
   Accessory Studio components (each altered by exactly one line: the
   Electron-IPC → web-client seam swap), their libraries and prompt machinery
   (promptComposer 164 retained, promptPresets 90, dialogPolicy 37, the five
   `*Library.ts` files ~156), and their modals (CharacterDialogueModal 111,
   SmartPromptEditor 87, RenderSize 74, ImageCrop 34 + imageCrop.ts 43,
   ReferenceApprovalModal 29, RenderConstruction 8) — the payload behind the
   canvas `StudiosDock`.
3. **Auxiliary workflow builders and session plumbing** — `workflow.ts`
   (139 of 348), modelSelection (37 of 111), useLivePreview (27 of 127 —
   mostly rewritten), comfyInfo, createId, the zimage / ltx25Workflow /
   aceStepWorkflow graph builders, ZImageWorkspace (192 of 259) and
   AceStepWorkspace (119, verbatim).
4. **The stylesheet** — `src/styles.css` retains 1,261 of its 2,514 lines:
   the app's visual design language is the single largest inherited artifact.
5. **Shell, config, assets, docs** — index.html, `public/sw.js`, the manifest
   and icons, tsconfig, `scripts/smoke-generation.cjs` (63, verbatim),
   package.json / vite / eslint scraps, 45 lines of README, and
   `docs/archive/plan-v0.md` (the upstream author's planning doc, archived
   per the archive-don't-delete convention — upstream prose, kept for
   history, not shipped code).
6. **Lockfile coincidences** — 2,453 identical pin lines in
   `pnpm-lock.yaml`. We regenerate that file; the matches carry no authorship.

**Relicensing-readiness verdict.** Nothing new obstructs the AGPLv3 claim,
and the claim's recorded basis is now quantified: **96.2% of the tree**
(ex-lockfile) is authored in-project; every distinctive upstream artifact —
the shell, the monolith, the Electron packaging — is *deleted*, not merely
rewritten; and nothing upstream-derived exists in the server, the canvas
fabric, the document store, the pose rig, the datasets workbench, or the
first-party custom node. The position continues to rest on the two grounds
recorded above (machine-generated upstream lacking human authorship;
independent rewrite), with this section as the measurement. If the
no-human-authorship position were ever rejected, the exposure is exactly the
4.5k-line residue enumerated above, and the remedies, in order of cleanliness:

1. **Replace the residue.** Largest honest chunks first: restyle
   `styles.css` (~1.3k retained lines), retire or rebuild the mobile route
   (`MobileApp.tsx`), rewrite the Studios suite as canvas-native panels
   (~2k lines across components + prompt machinery). The aux builders and
   modals are smaller. This completes the original trajectory outright.
2. **Seek permission.** A written relicensing grant from the upstream author
   (jamesk9526) moots the question for the residue at zero engineering cost.
3. **Documented carve-outs.** Keep the residue, mark it, and scope the AGPLv3
   claim around it. Weakest option — mixed-licensing fog that every fork
   inherits — recorded for completeness, not recommended.

## Vendor and third-party handling

The complete, machine-checkable inventory — every dependency, vendored pack,
user-fetch component, and model-weight license with its obligations — lives in
[docs/LICENSES.md](LICENSES.md); `pnpm license:audit` (part of the gate and CI)
re-derives the dependency table, re-checks vendored LICENSE files, and enforces
the never-vendor-what-we-can't-ship rule below. Summary of that file's
findings: every direct dependency to date is permissive and AGPLv3-compatible
(26 verified 2026-09-14; nine additions since, all permissive, re-verified
against the npm registry 2026-09-17 — the §1 table itself is due a
regeneration pass, flagged in LICENSES.md §9); the sample of
research-doc license claims re-checked against the GitHub/HF APIs held, with
one correction recorded there (karuvanan's Director-Cut-Studio carries an MIT
LICENSE file; T8mars is precisely GPL-3.0-or-later).

- All runtime dependencies (MIT/Apache-2.0/ISC/GPL-compatible) are compatible with
  AGPLv3.
- **We never vendor code we can't ship.** Anything with a restrictive license —
  model weights under the MiniMax community license, adapters with restrictive
  terms, third-party node packs whose licenses don't allow redistribution — is
  **fetched by the user, on explicit request, from its official source**; the app
  detects absence and offers a guided fetch. The wrapper waits; it never bundles.
- Model weights are never part of this repository. Local installs are symlinked,
  never copied.
- Each vendored or fetched component keeps its own license notice intact.

### Vendored node packs (`vendor/nodes/`, tracked in `server/engineNodes.ts`)

| Payload | Source | Pinned revision | License (SPDX) | Notes |
|---|---|---|---|---|
| `vendor/nodes/ComfyUI-VDN-H3/` | `Saganaki22/ComfyUI-VDN-H3` | `3eb63496c24ca70faaf8a14b6c75fcb480e34bf1` (2026-09-12, "Fix OpenVDN adapter metadata loading and bump to 1.5.2") | Apache-2.0 | Vendored 2026-09-14 (task 3ay7wbz increment 2). Functional content verbatim; excluded at vendor time: `.git/`, `.github/`, `assets/` (demo videos), `example_workflows/*.png` (screenshots) — none functional. VDN checkpoints (~4.3 GB) are NOT vendored: they download from Hugging Face and land as links in the user's model roots. |
| `server/enginePatch.ts` patch-content constants (`RUN_BLOCKS`, `HOOK_LOOP`) + installer discipline | the maintainer's ComfyUI-VDN-H3-24GB fork, `tools/install_minimax_block_loop_hook.py` | fork @ local scratchpad (not a published pin) | Apache-2.0 (fork's license); GPL-3.0 second reading analyzed in [LICENSES.md §8](LICENSES.md) | Verbatim port with attribution (in-file header). NOT a distribution of ComfyUI: the patch applies only at runtime, on the user's machine, behind an explicit consent record, reversible from a pristine backup. We never ship a pre-patched file. |
| `src/lib/camera/` camera-path compiler | `NyckM/3d-Camera-control-H3-Minimax` (bruxosdovfx "Camera H3") | `846880de859959e801b2c506dc424bd5c8b5c6c4` (2026-09-13, README v19.1) | Apache-2.0 | Faithful TypeScript port of the compiler half (camera.py, trajectory_math.py, motion.py, diagnostics.py) with per-file provenance headers (task ving89w). A port, not a copy: no upstream bytes ship; the ComfyUI node, web editor and experimental prompt modes are deliberately not ported (the editor is a canvas-phase component per the maintainer's scope split; experiments belong to the benchmark harness). Fidelity is enforced mechanically — `pnpm test:camera` byte-compiles prompts/options/storyboards against goldens generated by the upstream Python itself (`scripts/fixtures/camera-goldens.json`, generator committed beside it). Upstream quirks (invert-H3-orbit mirroring, loop-closure eligibility, 17k+5 truncation) are preserved as quirks, not "fixed". |

License verdicts recorded by the same increment (registry entries in
`server/engineNodes.ts` carry them as data):

- **Saganaki22/ComfyUI-VDN-H3 — Apache-2.0** (LICENSE file + README statement +
  GitHub badge; verified against the cloned payload before vendoring).
- **Larryvrh/ComfyUI-MiniMax-H3-Turbo — Apache-2.0** (LICENSE file read from the
  local testbed install). Not vendored yet; user-fetch mode from a local copy.
- **facok/comfyui-krea2-controlnet — NO LICENSE FILE** (all-rights-reserved by
  default). Never vendored; user-fetch only, flagged in
  `docs/research/krea2-edit-mode.md` as a hard blocker.

## Name

The current project name is a **placeholder**, chosen to be easy to `grep`/`sed`
replace when a real name is decided.

## First-party custom node (task k271ykk, 2026-09-15)

`custom-nodes/minimax-lora-form-adapter/` is OUR code (MIT), not a vendored
third-party payload: written in-repo, registered in `server/engineNodes.ts`
as `installMode: 'first-party'`, and installed from the studio's own payload
(no network, no upstream pin). The pack's runtime assets follow the
licensing-conservative default recorded in docs/LICENSES.md §2b: zero
MiniMax-derived bytes ship — the projection encoder is derived at first use
from the user's own artifacts. Test-only golden vectors
(`tests/fixtures/h3_form_fixtures.npz`) are documented in the pack's
FIXTURES.md + LICENSES.md §2b.
