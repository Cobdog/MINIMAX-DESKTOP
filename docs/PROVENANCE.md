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

## Name

The current project name is a **placeholder**, chosen to be easy to `grep`/`sed`
replace when a real name is decided.
