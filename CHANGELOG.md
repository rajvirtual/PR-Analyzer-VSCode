# Changelog

All notable changes to PR Analyzer are recorded here.

## [0.4.2] - 2026-09-12

### Changed
- The change-complexity rating is more accurate. The model is told to weigh each file's
  +added/-removed counts and to default to "involved", and a deterministic guardrail then
  corrects ratings the change size contradicts — a change of only a handful of lines is never
  marked complex, and a very large change is never left as routine.

## [0.4.1] - 2026-09-12

### Fixed
- Files rated "involved" (ordinary logic) now get a neutral icon instead of the symbol's own
  colour, so only the red (complex) and green (routine) icons carry meaning in the Files list.

## [0.4.0] - 2026-09-11

### Added
- **Change-complexity coding in the Files list** — the ordering model now also rates how much
  review each file's change needs. Complex changes get a red icon and a "· complex" tag; routine
  ones (data models, renames, config, tests) get a green icon and "· routine", so review time
  goes where it matters. The rating also appears in each file's tooltip.

## [0.3.4] - 2026-09-11

### Changed
- The read-through is generated as plain-text sections instead of one JSON object. A reply that
  is cut off now still shows every section that finished — the way chat prose does — while
  keeping the file links and new/changed/context colours. Replies in the old JSON shape are
  still accepted.

## [0.3.3] - 2026-09-11

### Fixed
- The read-through no longer fails with "did not return a usable read-through" when the model
  writes real newlines or tabs inside a JSON string (a multi-line "example"). Stray control
  characters are escaped before the reply is parsed, which also hardens diagram and intent parsing.

## [0.3.2] - 2026-09-11

### Fixed
- The diagram no longer errors with "the model is not able to…" when a read-through or intent
  map is started while it is still drawing. Heavy model views now run one at a time — starting
  one quietly cancels the other instead of racing it for the model.

## [0.3.1] - 2026-09-11

### Fixed
- The diagram renders in colour on first open instead of needing a manual redraw — mermaid's
  first ELK render is retried once so it no longer falls back to the plain graph.

### Changed
- Removed the first-run model prompt added in 0.3.0; the always-visible status-bar model button
  is the model picker.

## [0.3.0] - 2026-09-11

### Added
- **Select model** — a command (Ctrl+Shift+P → *PR Analyzer: Select model*) to choose which
  Copilot model runs file ordering, the diagram, the read-through, Explain, and intent mapping.
- **Model indicator** — a status-bar item names the model in use and opens the picker on click.
- **First-run prompt** — a one-time nudge to pick a model, so ordering and Explain don't silently
  use the default.

## [0.2.0] - 2026-09-11

### Added
- **Map intent to evidence** — reads a pull request's description and linked work items, or a
  branch's commit subjects, and lays each intent beside the files that implement it and the
  tests that cover it.
- **Add a review note** — posts a comment back to the pull request, anchored to the file and
  line on screen.
- **Test-impact flag** — a production file changed without a matching test change is marked
  *no test* in the Files list.
- **Provenance** — every `@pr` answer names the files it read beyond the diff.
- **Coverage** — the status bar tracks how many changed files you have opened and how many were
  skipped.
- **Resume** — reopening the same change restores the file you left and what you had already
  read; no file contents are stored.
- Untracked files are included when reviewing a branch, so work can be reviewed before it is
  added.
- Limited support in untrusted workspaces: diffs and navigation work; repository-wide model
  reads wait for trust.
- **Auto-clone** — a pull request's repository is cloned automatically (a cached blobless clone)
  so the whole repository can be read, with a **Clear cached clones** command and a startup prune
  of clones left unused (`prAnalyzer.clonePruneDays`, default 15).

### Changed
- The "repository not cloned" prompt is a modal dialog that waits for your choice instead of
  disappearing.
- Pull request files are fetched with bounded concurrency and can be cancelled, so large pull
  requests load faster.
- Reviews are latest-wins: a newer review can no longer be overwritten by a slower older one,
  and a pull request refresh keeps its checkout.
- Oversize, unreadable, and binary sides are shown as such instead of appearing as an addition
  or a deletion.
- The diagram and the read-through discard a stale result when the review changes underneath
  them.

### Fixed
- Model tools are confined to the repository under review; path traversal and symlink escapes
  are refused.
- Deletion-only regions are reachable with `F7`.

### Security
- File contents and pull request text are treated as untrusted data by the model prompts.
- Dev-dependency advisories cleared (esbuild, Vitest).

## [0.1.0]

- Initial internal release: flow ordering, hunk navigation, the runtime diagram, `@pr` chat,
  the read-through, and Azure DevOps pull request review.
