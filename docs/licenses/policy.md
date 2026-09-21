# The Monoka license policy — decision rules, AGPLv3 compliance, maintenance

> **Read this before** adding a dependency, a node pack, a model/fetch entry,
> or vendoring/porting/replicating any third-party code. The registry row lands
> in the same commit as the change — `pnpm license:audit` fails CI otherwise
> (the lockstep check). This file is the rulebook;
> [registry.md](registry.md) is the per-component record;
> [docs/LICENSES.md](../LICENSES.md) is the consolidated notices file (the
> distribution surface); [docs/PROVENANCE.md](../PROVENANCE.md) is who we are.
>
> Charters: maintainer directives `5b19f1bb` (the license infrastructure) and
> `c5673267` (surface minimality — "do the bare minimum… where we do not have
> to license, don't") on epic 4lphxv8.

## 1. Decision rules — what we may do with what

The one-sentence version: **we vendor only what we could ship; everything
else the user fetches themselves with the license in front of them; and we
never touch all-rights-reserved code.**

| License class | Vendor / ship in repo? | Use at all? | The rule |
| --- | --- | --- | --- |
| MIT, ISC, BSD-2/3/4, Apache-2.0, Zlib, 0BSD, Unlicense, Python-2.0, BlueOak, BSL-1.0, CC0, MPL-2.0 | **Yes** — safe to vendor at a pinned revision, LICENSE in-tree, changes stated (Apache §4) | yes | The permissive floor. `audit-licenses.cjs` `VENDORABLE` set is this list minus CC-BY |
| OFL (fonts) | **Yes** — ship the font files + the OFL text; never rename the font's internal names or Reserved Font Names; never subclass (we do neither) | yes | Fonts are assets, not code — same vendor discipline, file-level |
| CC-BY-4.0 | reference + attribute, but **not vendored** (attribution must ride every copy — fragile in a repo) | yes, with attribution | borderline-permissive; treat as cited material |
| GPL-3.0 / LGPL (third-party code) | **No** — never vendored into this repo | yes, at arm's length | Two sanctioned shapes only: (a) **fetch-consent** — the user's own copy in their own instance (the fetch catalog); (b) **runtime-separate-process** — a GPL thing running beside us, communicated with over the process/HTTP boundary (the ComfyUI engine itself, ETN on the instance), which is not a combined work. Combining GPL-3.0 with AGPLv3 is *legal* (§13 final paragraph) — the policy bar is engineering, not law: vendoring third-party GPL couples our releases to contributor sets we do not control |
| GPL family npm dep | warn (audit) | only with a recorded decision | compatible-but-duties; record it in LICENSES.md before committing to one |
| Community/research/NC licenses (MiniMax H3, Krea 2, LTX-2, Qwen research, CC-BY-NC, gated datasets) — *weights and models* | **Never** — weights never enter the repo at all | yes, **user-driven fetch only** | §3's workaround doctrine. The license is surfaced at consent time before the network is touched; `flaggedLicense()` warns on no-license/GPL/CC*/qwen-research/non-commercial ids |
| NO-LICENSE (no file in the repo) | **Never** | fetch-consent only (their copy), pattern-adopt the ideas | All-rights-reserved by default. An idea is free; the bytes are not. An MIT/Apache request to the author is the cheap unlock (facok, GENKAIx precedent-notes) |
| All-rights-reserved / ARR | **never touch the bytes** | referenced-only | Includes unlicensed upstreams. Pattern-adopt at most; see PROVENANCE for the one inherited-ARR case and its measured rewrite |

**Ports and replications** are always allowed from anything short of ARR, but
they are not a loophole: a faithful port of GPL code is still GPL in origin
(enginePatch §8 records the honest two-reading analysis). Ports carry per-file
provenance headers (repo + commit), a PROVENANCE.md row, and goldens where
fidelity is load-bearing (the camera compiler precedent).

**Test fixtures of third-party tensors**: small deterministic slices are
tolerable when documented (form-adapter FIXTURES.md); anything loadable as a
model asset is not a fixture.

## 2. AGPLv3 compliance map — per distribution shape

### 2a. Local-first self-host (today)

The app runs on the user's machine; the server serves the UI over localhost
HTTP. Obligations triggered by *conveying* the repo (which we do — the public
repo is a conveyance under §4/§5):

- **LICENSE at root** (verbatim AGPLv3) — met.
- **The source IS the distribution** — no object code, so no §6
  written-offer machinery; Corresponding Source = the repository.
- **Appropriate Legal Notices (§0/§5d)**: a conveyed work with interactive UIs
  must display a convenient, prominently visible feature showing (1) an
  appropriate copyright notice and (2) no-warranty + license + how to view it.
  §0 explicitly counts a menu item. **The Settings → "License & source"
  section is that menu item — it is load-bearing, not decoration.** It stays.
- **README source-offer (§13)**: localhost-only interaction makes §13's
  *remote network interaction* mostly dormant, but the README statement +
  canonical-source link cover the operator who later exposes the port.

### 2b. The curated public Monoka repo (the Monoka-dev → Monoka curation)

Directive `262db65f`: Monoka-dev stays the working repo; Cobdog/Monoka is the
future public face, curated by PR. The curation gets a **license-check step**:

1. The PR must pass `pnpm license:audit` (it does — CI runs it) — that checks
   deps, vendored trees, pack-registry discipline, and (since the lockstep
   check) registry coverage.
2. The PR diff is scanned for new vendored/ported third-party bytes: new
   `vendor/` paths, new files with third-party provenance headers, new fetch
   catalog entries — each must carry its registry row in the same PR.
3. Nothing from the dev-only surfaces ships: the assessment workspace,
   benchmark harness internals, and dev docs stay Monoka-dev-side (already the
   plan); `docs/licenses/` is internal diligence and stays Monoka-dev-side
   too — the public repo's license surface is LICENSE + docs/LICENSES.md +
   preserved headers, nothing else.
4. The 68rnn84 fork-inheritance record (PROVENANCE final-diff statement) ships
   with the repo — it is the defensibility file.

### 2c. Network hosting (if Monoka is ever hosted for others)

§13 bites the moment a *modified* version serves remote users: the operator
must offer their Corresponding Source through the standard means (a public
repo link satisfies it). The README and the Settings section already tell
operators this. If WE ever host: the canonical repo is the source offer;
keep the two in sync. A hosted instance additionally inherits every
fetch-consent license's own terms for the *models it runs* — the community
licenses' commercial clauses are the reason the hosting question is a
maintainer decision, never a default.

### 2d. What AGPLv3 does NOT require (the anti-plastering list)

No per-file headers (decision §7, default A). No in-app license screen beyond
the one Settings section. No notices in the UI for third-party components
(notices ride the notices file + vendored LICENSE files — a user who wants
them reads docs/LICENSES.md). No output licensing — AGPL covers the Program,
not what users generate with it (the model licenses, not ours, govern
generated content; we surface those terms at consent, we do not enforce them).

## 3. The workaround doctrine — user-driven obtainment

When a license is less than ideal, the standing pattern is **user-driven
obtainment**, named: the studio never bundles the thing — it detects absence,
offers a guided fetch from the official source at a pinned (or
fetch-stamped) revision, shows the license text and the honest verdict at
consent time, waits for the click, links (never copies) into place, and keeps
the consent record tied to the *current* license (a license change upstream
invalidates stale consent). Implementation: `server/fetchCatalog.ts` +
`server/fetcher.ts` + the FetchBrowser consent dialog. This is simultaneously
the compliance mechanism (we redistribute nothing) and the C&D insurance
(registry.md §9: every fetch-consent row is minutes to delete).

Hard rules inside the doctrine: the fetcher sends no credentials (gated
datasets fail honestly, 401 — the user stages those themselves); weights
LINK, never copy (`linkNeverCopy()`); consent is per-entry, recorded
server-side, and re-earned when the license changes.

## 4. The minimal surface, made real (directive `c5673267`)

The complete distribution surface, and nothing more:

1. **LICENSE** (root) — the AGPLv3 grant.
2. **docs/LICENSES.md** — the ONE consolidated third-party notices file
   (deps, vendored, fetch-only, weights; the machine-checkable inventory).
3. **Preserved upstream license files in vendored trees** (`vendor/nodes/*/LICENSE`,
   `custom-nodes/*/LICENSE`) — checked by the audit.
4. **Per-file provenance headers on ports** (camera, enginePatch) — the
   "attribution in the code where it needs to be" part.
5. **Settings → License & source** — the AGPL §5d Appropriate-Legal-Notices
   menu item. The only in-app license surface; load-bearing, stays.
6. **The fetch-consent gate** — license + verdict before any fetch. A
   download decision, not plastering; stays (explicitly, per the directive).

**Audit of what exists today against this list:** items 1–6 all exist and are
each either required or directive-mandated. One surface exceeds the list and
is currently dormant: `src/components/LicenseNotice.tsx` (the one-time
MiniMax model-license banner) has been **unrouted since the canvas rewrite**
(README tracks it for re-mounting). No license demands it of us — the MiniMax
terms bind the user and the outputs, not this app; the fetch-consent entries
for the H3-derivative weights already surface the same terms at the moment of
download. **Recommendation (maintainer call, surfaced not decided):** do not
re-mount it as an always-on banner; if the base-H3 weights need an in-app
terms surface, fold it into their first staging/first-run moment — a decision
point the first-run wizard (W3) can absorb. Deleting the component outright
is equally consistent with the minimal-surface doctrine if the wizard route
is chosen.

## 5. Grey areas, stated honestly

These are unsettled in the industry, not merely for us. Our posture is
**documented diligence**: record the license as stated, verify at the source,
surface at consent, choose usage modes that keep every exposure reversible —
then say plainly:

- **Weights vs code copyright.** Model weights' copyrightability and the
  enforceability of click-through "community licenses" on them are
  untested. We treat the licenses as binding (conservative) while noting
  they are contract-like grants, not copyright acts.
- **Training-data provenance.** We cannot audit what a model was trained
  on; we record what its card discloses (e.g. AnyPaint's "training data not
  disclosed") and surface duties, nothing more.
- **NC output ownership.** Whether CC-BY-NC reaches generated outputs is
  contested; CC's own reading says yes for adaptations. We assume outputs
  inherit the terms (the conservative read) and surface it (YuE2's row).
- **Jurisdictional weirdness.** Qwen research license: Chinese law, Hangzhou
  courts. MiniMax territory exclusions: community-reported, not lawyer-read
  by us. Recorded as stated, not resolved.
- **The relicensing claim itself.** The no-human-authorship position on
  machine-generated upstream is guidance-based, not battle-tested; the
  measured rewrite (96.2% ours) is the hedge that does not depend on it.

**Disclaimer:** this policy and the registry are engineering diligence — the
maintainer's and agents' good-faith reading of public documents. They are not
legal advice, and no one involved is a lawyer. When money or a C&D is on the
line, get one.

## 6. Stays up to date — the maintenance charter

The registry is a living document with the same discipline as the
[devdocs MANIFEST](../devdocs/MANIFEST.md): every row carries its
verification date, and freshness is enforced by triggers, not hope.

**Verify-on triggers (the registry row is touched in the same change):**

1. **Every addition** — new dep, node pack, fetch/model entry, vendored or
   ported code, font/asset: the row lands with the change; the lockstep
   audit fails CI without it. This is the mechanical never-forget.
2. **Every pin bump or version change** — re-read the license at the new
   revision (licenses do change: Qwen 2.1 flipped the family from Apache-2.0
   to research-NC overnight; YuE2 broke its own Apache lineage at 2.0).
3. **Upstream license changes** — a license change invalidates stale
   consent (fetcher discipline) and re-flags the row for verdict review.
4. **The recurring curation passes** — the node-pack registry's quarterly
   sweep includes license/pin re-verification of every row (node-pack-registry.md
   §"quarterly"); the registry rides that cadence.
5. **A C&D or hostile relicensing event anywhere in the ecosystem** — sweep
   the affected family's rows the same day.

**Ownership:** the license audit script is the enforcement; this policy +
the conventions' License-workflow section are the process; ambiguous calls
(the Kreatine class, the Image Studio vendor-vs-port) are surfaced to the
maintainer, never decided unilaterally — and recorded here once decided.

**Regeneration:** `pnpm license:audit` re-derives the dep table (paste into
LICENSES.md §1 after dependency changes — its output is the table body) and
verifies the registry lockstep. The registry's prose verdicts are re-read,
not machine-derivable — that re-read is what the quarterly trigger is for.

## Addendum — obligations, not policing (maintainer stance, 2026-09-21)

> "What the user does is not up to me, and that is my stance on everything here, I
> don't care what people do, they are adults, they are responsible for their own
> actions. I only care about what I am legally required to abide by, that is all."

This stance governs the whole policy's interpretation. Monoka's obligations end at
the maintainer's own legal requirements: honest license display at the consent
gate, no redistribution of gated material by the app, our-side attribution and
source-offer compliance. The app INFORMS (terms shown before fetch) — it never
POLICES what users do with what they fetch or generate. Grey-zone notes in the
registry (output monetization under NC licenses, jurisdictional questions) are
informational for the user at the gate, not enforcement targets for us.
