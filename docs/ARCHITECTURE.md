# PR Analyzer — Architecture

PR Analyzer is a VS Code extension for reviewing a large change **in the order it runs**, rather
than the order a diff lists files. It works the same for a local branch and an Azure DevOps pull
request, augments the review with model-driven surfaces (a runtime map, a read-through, inline
explanations, intent mapping), and treats every model reply as untrusted, reconciling or parsing
it against the real change before showing anything.

This document maps the features to the code and the principles behind them.

---

## 1. Layered architecture

The source is organised so a change source, an analysis, and a surface never reach across each
other — everything meets at the host-independent data model.

```
src/
  model/        Host-independent data: ChangeSet, ChangedFile, Step, Effort
  git/          Local-branch change source, clone/worktree management
  ado/          Azure DevOps change source, PR threads, URL parsing
  analysis/     Static analysis: digest, ordering signals, flow order, symbol graph,
                mermaid (deterministic), renumber, test impact, file tree, diffs
  lm/           Model interaction: prompts, model selection, tool loop, parsers, gate
  review/       Cross-review state: checkpoint (resume + diagram cache), generation
  ui/           VS Code surfaces: files tree, diagram panel, story panel, diffs, lenses
  webview/      The diagram renderer (mermaid + ELK), sandboxed in the webview
  chat/         The @pr chat participant
  session.ts    ReviewSession: steps, position, coverage, hunk walking
  extension.ts  Activation, commands, orchestration, status bar
```

**Dependency direction:** `ui` / `chat` / `webview` → `lm` / `analysis` / `review` → `model`.
Change sources (`git`, `ado`) produce a `ChangeSet` and nothing downstream knows which it was.

---

## 2. Core data model (`model/changeset.ts`)

| Type | Purpose |
|------|---------|
| `ChangeSet` | A whole review: repository root, base ref, merge base, pinned commit, `ChangedFile[]`, and skipped files. Produced identically by a branch or a PR. |
| `ChangedFile` | One file: path, change type, before/after text (nullable), and a `SideUnavailable` reason (`unreadable` / `too-large` / `binary`) so a missing side is shown as such, not as an addition or deletion. |
| `Step` | One file positioned in reading order: `order`, static `role`, model `title`, and model `effort` (change complexity). |
| `Effort` | `routine` \| `involved` \| `complex` — how much review a file's change needs. |

The `ChangeSet` is deliberately host-independent, which is what lets one pipeline serve both a
local branch and an ADO PR.

---

## 3. The review pipeline

```
command ─▶ change source ─▶ ChangeSet
                               │
                     buildSymbolGraph (LSP)         analysis/lsp-graph.ts
                               │
             orderStepsWithModel (structure model)  lm/order-steps.ts
             + effort rating + churn guardrail      lm/order-prompt.ts, session.ts
                               │
                          buildSteps                session.ts  → Step[]
                               │
                        ReviewSession               session.ts
                     tree + status bar + checkpoint restore
                               │
        on demand: diagram · read-through · Explain · intent · @pr chat
```

1. **Change source** (`git/git-change-source.ts` or `ado/ado-change-source.ts`) reads the change
   and returns a `ChangeSet`. Untracked files are included for a branch; oversize/binary sides are
   flagged rather than shown.
2. **Symbol graph** (`analysis/lsp-graph.ts`) asks the language server for declarations and
   references, parallelised across files (`mapLimit`) and deadline-bounded, with a text-based
   fallback when no language server answers.
3. **Ordering** (`lm/order-steps.ts` + `order-prompt.ts`) asks the **structure model** to lay the
   files out as execution flow, using the reference graph and a per-file change digest as evidence,
   and to rate each file's `effort`. The reply is **reconciled** against the real file list
   (`reconcileOrder`) so an invented, missing, or repeated path can never change what is shown.
4. **buildSteps** (`session.ts`) merges the model order/title/effort with static roles, and applies
   a **churn guardrail** (`clampEffort`) so an obviously-wrong rating is corrected.
5. **ReviewSession** drives the tree, the status bar, and hunk navigation; the checkpoint restores
   where the reader left off.

---

## 4. Features and how they are implemented

### Review a branch or a pull request
- **Commands:** `prAnalyzer.reviewBranch`, `prAnalyzer.reviewPullRequest`.
- **Branch** → `git/git-change-source.ts` (diff against the base ref, untracked via `ls-files`).
- **PR** → `ado/ado-change-source.ts` (bounded-concurrency fetch, capped before processing).
- **Auto-clone:** a PR whose repo is not on disk is cloned as a cached blobless clone
  (`git/find-clone.ts`, `git/clone-store.ts`), reused and pruned after `clonePruneDays`.
  Per-PR checkouts use throwaway worktrees (`git/pr-worktree.ts`).

### Ordered steps (the Files list)
- **Order** by execution flow (`lm/order-steps.ts`), with a deterministic reference-graph order as
  the fallback and `prAnalyzer.ordering` to force it.
- **Tree** in `ui/files-tree.ts` (`StepTreeProvider`); flat or grouped by folder
  (`analysis/file-tree.ts`).
- **Test-impact flag:** a production file changed with no matching test change is marked *no test*
  (`analysis/test-impact.ts`).

### Change-complexity colour coding
- The ordering model rates each file `routine` / `involved` / `complex`; `session.ts`'s
  `clampEffort` corrects ratings the change size contradicts (a tiny change is never complex; a
  very large one is never routine).
- `ui/files-tree.ts` colours the icon — **red** complex, **green** routine, neutral involved — with
  a text tag and tooltip, so the meaning is never carried by colour alone.

### Native diffs and hunk navigation
- `ui/change-content-provider.ts` serves before/after virtual documents; steps open a real diff.
- `session.ts` (`hunksOf`, `position`, next/previous) walks the changes within a file before moving
  on; `HunkLensProvider` and `F7` reach every region, including deletion-only ones.

### Runtime diagram (the map)
- `ui/diagram-panel.ts` owns the webview; `webview/diagram.ts` renders mermaid with the ELK layout.
- **Model draw** (`lm/draw-diagram.ts` + `diagram-prompt.ts`) lets the **structure model** read the
  repo via tools, then returns mermaid whose nodes are class-tagged `new` / `changed` / `context`
  (the colours). `analysis/renumber.ts` renumbers nodes to follow the arrows.
- **Deterministic fallback** (`analysis/mermaid.ts`) draws a plain, always-valid map when the model
  reply won't parse.
- **Resilience:** the first ELK render is retried once (loader race); a parse failure removes
  mermaid's error graphic and falls back to the plain map instead of showing "Syntax error".
- **Caching:** a successful draw is stored per commit (`review/checkpoint.ts`), so reopening a
  reviewed change is instant; Redraw always draws fresh.

### Read-through (the story)
- `ui/story-panel.ts` + `lm/write-story.ts` + `story-prompt.ts`. The **reasoning model** writes the
  change as one continuous read, section by section, with jump-to-file links and new/changed/context
  colours.
- The wire format is **lenient plain-text sections**, not one JSON object, so a reply cut off
  mid-way still renders every section that finished — with the old JSON shape kept as a fallback.

### Explain, intent, and @pr chat
- **Explain** (`ui/inline-explain.ts` + `lm/explain-prompt.ts`): a CodeLens explains a change or a
  hunk inline, using the tool loop.
- **Intent mapping** (`lm/write-intent.ts` + `intent-prompt.ts`): reads a PR description / linked
  work items (or a branch's commit subjects) and lays each intent beside the files that implement it
  and the tests that cover it.
- **@pr chat** (`chat/participant.ts`): free-form Q&A; uses the model from the chat picker and
  remembers it (`lm/model-memory.ts`).

### Add a review note
- `extension.ts` (`addNote`) posts a PR comment anchored to the file and line on screen, via
  `ado/pr-threads.ts` and `ado/thread-payload.ts`.

### Resume and coverage
- `review/checkpoint.ts` records the current file and which files were visited, per repository and
  commit — **paths, never contents** — so reopening resumes rather than restarts.
- `session.ts` tracks coverage (files seen / skipped), shown in the status bar.

---

## 5. Model interaction (`lm/`)

### Model selection (`lm/select-model.ts`)
Two roles, each resolved independently and never hard-coded to a specific model:

| Role | Function | Setting | Used by |
|------|----------|---------|---------|
| **Reasoning** | `selectModel()` | `prAnalyzer.model` | read-through, Explain, intent |
| **Structure** | `selectStructureModel()` | `prAnalyzer.structureModel` | ordering, diagram |
| Chat | (chat picker) | — | `@pr` |

`selectStructureModel()` resolves the setting if present, else picks the **fastest-looking
available** model by a vendor-agnostic name heuristic (`mini`, `haiku`, `flash`, `lite`, …), else
falls back to the reasoning model — so it speeds up when a small model exists and never breaks when
one does not. A status-bar item shows the reasoning model; `Select model` and `Select structure
model` (and the diagram's Model button) change them.

### The tool loop (`lm/run-with-tools.ts`, `repo-tools.ts`)
The diagram, read-through, Explain, and intent all run through one bounded loop: the model streams
an answer and may call read-only repo tools (`read_file`, `find_symbol`, `search_text`), capped at
`MAX_TOOL_ROUNDS` / `MAX_TOOL_CALLS`. Within a round the lookups run **in parallel**. Tools are
**sandboxed to the repository** under review (`lm/safe-path.ts`) and gated on workspace trust; the
files the model actually read are recorded for provenance (`lm/provenance.ts`).

### Trusting nothing the model returns
- **Order** is reconciled to a real permutation (`order-prompt.ts`).
- **Diagram** is validated and renumbered; an unparseable one falls back to the deterministic map.
- **Story** is parsed leniently and degrades on truncation.
- **JSON** replies are recovered from prose/fences and repaired for unescaped control characters
  (`lm/json.ts`).
- Change text is framed as **untrusted data** in every prompt, never instructions.

### Concurrency and cancellation (`lm/model-gate.ts`)
Heavy model views are **single-flight**: starting the diagram, read-through, or intent cancels the
others (`beginExclusiveModelWork`). In addition, a draw is cancelled when the map is **redrawn**,
**closed**, or **tabbed away from**, and the previous review's work is cancelled when a new one
loads — so model calls never pile up or run for something the reader has left.

---

## 6. Cross-cutting concerns

- **Latest-wins** (`review/generation.ts`): a slower, older result can never overwrite the review
  that replaced it.
- **Graceful degradation:** every model surface has a deterministic or partial fallback (plain map,
  reference-graph order, partial read-through), so a model hiccup degrades a surface, never the run.
- **Security:** repo tools are path-sandboxed and trust-gated; no secrets in code; PR/diff text is
  untrusted input to prompts.
- **Privacy:** persisted state stores file paths and a cached diagram, never file contents.
- **Performance:** the symbol graph is parallel + deadline-bounded; tool lookups within a round run
  in parallel; ordering and the diagram use a faster structure model; drawn diagrams are cached per
  commit.
- **Accessibility:** the webview supports keyboard navigation, focus management, and `aria-live`
  status; tree colour is always paired with a text tag.

---

## 7. Build, test, release

- **Bundling:** esbuild builds the extension and the webview into `media/` (`npm run compile` /
  `package`).
- **Type checking:** `tsc --noEmit` for the extension and, separately, for `src/webview`.
- **Tests:** Vitest, Node-only. Modules that import `vscode` are not unit-tested by design; their
  logic is factored into pure modules (`analysis/`, `lm/` parsers, `session.ts`) that are.
- **Release:** a `v*` tag triggers GitHub Actions, which builds on a runner with public-registry
  access and publishes the VSIX to the latest release.

---

## 8. Where to start reading

| To understand… | Start at |
|----------------|----------|
| The whole flow | `extension.ts` (activation + commands) → `session.ts` |
| How a change is read | `git/git-change-source.ts`, `ado/ado-change-source.ts`, `model/changeset.ts` |
| How order + complexity are decided | `lm/order-steps.ts`, `lm/order-prompt.ts`, `session.ts` (`buildSteps`, `clampEffort`) |
| The map | `ui/diagram-panel.ts`, `lm/draw-diagram.ts`, `webview/diagram.ts` |
| The read-through | `ui/story-panel.ts`, `lm/write-story.ts`, `lm/story-prompt.ts` |
| Model plumbing | `lm/select-model.ts`, `lm/run-with-tools.ts`, `lm/model-gate.ts` |
