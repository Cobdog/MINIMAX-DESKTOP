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
   The remaining upstream-derived components are queued for replacement by the
   platform restructure. The end state shares no substantial similarity with
   upstream.

We record this reasoning openly rather than quietly: anyone forking **this** project
can evaluate it themselves. If upstream ever asserts contrary rights, the resolution
is the completion of the rewrite — the diff is the evidence.

**IANAL:** this note records the maintainers' good-faith assessment, not legal advice.

## Vendor and third-party handling

The complete, machine-checkable inventory — every dependency, vendored pack,
user-fetch component, and model-weight license with its obligations — lives in
[docs/LICENSES.md](LICENSES.md); `pnpm license:audit` (part of the gate and CI)
re-derives the dependency table, re-checks vendored LICENSE files, and enforces
the never-vendor-what-we-can't-ship rule below. Summary of that file's
findings (verified 2026-09-14): all 26 direct dependencies are permissive
(MIT × 23, Apache-2.0 × 2, ISC × 1) and AGPLv3-compatible; the sample of
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
