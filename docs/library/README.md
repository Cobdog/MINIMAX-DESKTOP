# Research library — full-copy captures of load-bearing external docs

> Created by hygiene pass 2 (2026-09-16, Flux zbn31xs). Links rot and pages
> change; the sources our research and code lean on get FULL COPIES here,
> each with a provenance header (source URL, fetch date, pinned revision,
> license note) and a "local reliance" line saying what in OUR tree depends
> on it.

## Why copies, not links

Every capture below was among the most-cited external URLs in
`docs/research/` and `docs/specs/` when the library was seeded (citation
counts recorded per file). When a source page silently changes, a bare link
gives us no way to notice — the copy freezes the version our conclusions
were drawn against, and the header pins exactly which version that was.

## The captures

| Capture | Source | Pinned at | License | Cited by |
| --- | --- | --- | --- | --- |
| [minimax-h3-prompt-guide-base.md](minimax-h3-prompt-guide-base.md) | HF `MiniMaxAI/MiniMax-H3` docs | sha `42ed227` | MiniMax community license (`other`) | promptPolicies, research prompting sections |
| [minimax-h3-prompt-guide-ref.md](minimax-h3-prompt-guide-ref.md) | HF `MiniMaxAI/MiniMax-H3` docs | sha `42ed227` | MiniMax community license (`other`) | reference binding/ordering, R2V composition |
| [comfyui-minimax-h3-overview.md](comfyui-minimax-h3-overview.md) | docs.comfy.org H3 overview | unversioned site | none stated on-page | resolution/duration grids, SageAttention advice |
| [comfyui-minimax-h3-native.md](comfyui-minimax-h3-native.md) | docs.comfy.org H3 native workflows | unversioned site | none stated on-page | latent-chaining research (most-cited URL, 17×) |
| [comfyui-h3-motion-context-readme.md](comfyui-h3-motion-context-readme.md) | GitHub `NikoDemon80/ComfyUI-H3-Motion-Context` | main @ `5335715` | **GPL-3.0** (repo) | chaining design patterns (12×) |

## Protocol (how to add a capture)

1. **Threshold:** a source becomes a capture when our research or code leans
   on it repeatedly — not for one-off citations (those stay as links in the
   research doc with evidence tags).
2. **Full copy, fetched raw.** Fetch the raw/served markdown (HF `raw/`
   URLs, docs sites' `.md` alternates, GitHub raw), not a rendered scrape.
   The body below the header stays VERBATIM — no edits, no rewrites.
3. **Provenance header on every file:** source URL, fetch date, pinned
   revision (commit sha where the host has one; say "unversioned site"
   where it doesn't), license note, and a "local reliance" line naming what
   in our tree depends on it.
4. **License discipline (absolute):** these are INTERNAL REFERENCE COPIES
   ONLY — never shipped in any distributable, never vendored into
   `vendor/nodes/`, never copied into source. The license gate doctrine
   applies to the library too: GPL-3.0 and NO-LICENSE sources may be READ
   here but never redistributed by us; permissive sources still don't get
   copied into code without going through `docs/LICENSES.md` /
   `docs/PROVENANCE.md`. Every header states the license verdict.
5. **3–5 captures per pass.** The structure matters more than the backfill;
   grow the library opportunistically as research touches new load-bearing
   sources.

## The SOURCE-OF-TRUTH CHECK (run when it matters)

Before relying on a captured fact for non-trivial work — building,
benchmarking, graph-writing — check the capture against the live source and
ask exactly three questions:

1. **Did it change?** Diff the live page against the capture. If it moved:
   record a DATED ADDENDUM at the bottom of the library copy (what changed,
   when, whether it affects us) AND, if the finding shifts anything we
   concluded, a dated addendum in the relevant `docs/research/*.md`. Never
   silently replace the captured body — the frozen version is the record of
   what we knew when.
2. **Was it superseded?** Is there now a better method, node, or guide that
   makes the captured one obsolete? If yes: same addendum treatment, and
   consider whether a NEW capture is warranted (respecting the per-pass
   budget).
3. **Did something impossible become possible?** The captured doc may
   document a limitation (resolution caps, no mid-chain control, license
   gaps) that upstream has since lifted. An impossibility lifting is the
   strongest trigger of all for re-research — record it the same way.

This check is the library-side half of THE FRESHNESS DOCTRINE in
`CLAUDE.md`; the doctrine says WHEN to be suspicious, this file says what
to do about it.
