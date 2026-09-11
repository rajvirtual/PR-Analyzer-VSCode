# Changelog

All notable changes to PR Analyzer are recorded here.

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
