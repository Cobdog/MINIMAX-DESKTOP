# Node-pack version detection — what a pack folder can honestly tell us

Task: Node-pack status board (mjhlt3k) · Date: 2026-09-19 ·
METHOD: external-doc read (docs.comfy.org, ComfyUI-Manager README) + code-read
of this repo's install machinery; fixture-measured in `scripts/test-instance.cjs` (now `tests/instance.test.js` after the vitest migration, 2026-09-20)
section (f). No upstream source trees were vendored or copied.

## The question

With an external custom-nodes folder set, the studio must read each pack's
installed version and WHO manages it — without touching the folder, and
without claiming knowledge it does not have.

## Findings

- **[DOC]** Git-based installs (ComfyUI-Manager's classic mode, and a manual
  `git clone`) leave a `.git` directory inside the pack folder — this is the
  recognizable state the Manager's own scanning keys on for git-hosted nodes.
  The checked-out commit is readable from `.git/HEAD` → refs → `packed-refs`
  (worktree-style `.git` FILES carry a `gitdir:` pointer).
- **[DOC]** Comfy Registry (CNR) installs carry the published package's
  `pyproject.toml`: a `[tool.comfy]` section (PublisherId, DisplayName…) plus
  `[project] version` — ComfyUI-Manager's scan reads this metadata to
  determine an installed node's version/state. Registry installs have NO
  `.git` (the archive is not a git checkout).
- **[COMM→DOC]** A manual clone and a Manager git-mode install are
  INDISTINGUISHABLE from the folder alone. Both are attributed "instance-side
  / managed by ComfyUI" in the studio's board, with the indistinguishability
  documented in `server/packVersioning.ts` — the discipline (never replace,
  never delete) is identical for both, so the label's practical consequence
  is the same.
- **[DOC]** Ordering two SHAs requires history: `git merge-base
  --is-ancestor` against the folder's own object store answers ahead/behind
  exactly WHEN both commits are present. The studio's registry pins cannot be
  forged into fixture history, so the ahead state is unit-proven with
  synthetic pins (dated decision, task mjhlt3k comment).
- **[DOC]** Semver ordering only means something against a TAG pin
  (`v1.0.0`-shaped); a branch pin (`main`) is a moving label with no local
  relation to any sha — unknown, never guessed.

## Ladder (implemented in `server/packVersioning.ts`; AC mjhlt3k prh8dc4)

| Rung | Artifact read | Version | Managed-by |
|---|---|---|---|
| 1 | `.studio-node.json` | exact recorded revision | studio |
| 2 | `.git` | HEAD sha (+ origin URL) | comfyui (or a hand clone — same posture) |
| 3 | `pyproject.toml` with `[tool.comfy]` | `[project] version` | comfyui (registry) |
| 4 | `pyproject.toml`, bare `[project] version` | version string | unknown |
| 5 | nothing | version unknown | unknown |

## Verdict

ADOPT (implemented). Detection is read-only, per-request, and degrades to
honest "version unknown" — an exotic folder must never blank the board.
Measured on the fixture matrix: every rung answers exactly what its artifact
says and nothing more (129-check instance suite, section f + route status
board block).

Sources: docs.comfy.org (Custom Nodes / Publishing Nodes — pyproject
`[tool.comfy]` spec, install methods), the ComfyUI-Manager README (git vs
registry install identification), verified 2026-09-19.
