# AI PR Analyzer — Architecture

AI PR Analyzer is a VS Code extension for reviewing a large change **in the order it runs**, rather
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
  git/          Local-branch change source, batched blob reads, clone/worktree management
  ado/          Azure DevOps change source, PR threads, URL parsing
  analysis/     Static analysis: digest, ordering signals, flow order, symbol graph,
                mermaid (deterministic), renumber, test impact, file tree, diffs
  lm/           Model interaction: prompts, model selection, tool loop, parsers, streaming,
                timing, gate
  review/       Cross-review state: checkpoint (resume + diagram cache), generation
  ui/           VS Code surfaces: files tree, diagram panel, story panel, diffs, lenses,
                activity status
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

Nothing slow sits between reading the change and showing it. The first paint is deterministic;
the language server and every model surface refine it afterwards.

```
command ─▶ change source ─▶ ChangeSet          git: one cat-file batch for every blob
                               │
                    signalsFor + flowOrder          analysis/ordering-signals.ts
                    (tokenise once, walk the
                     strongest reference first)
                               │
                          buildSteps                session.ts  → Step[]
                               │
                        ReviewSession               ◀─ FIRST PAINT
                     tree + status bar + checkpoint restore
                               │
        ┌─────────────────────────────────────┴────────────────────────────┐
  in the background                                          on demand
  orderStepsWithModel ──▶ titles + effort           diagram · read-through · Explain
  buildSymbolGraph ────▶ sharper graph            intent · @pr chat
```

1. **Change source** (`git/git-change-source.ts` or `ado/ado-change-source.ts`) reads the change
   and returns a `ChangeSet`. Untracked files are included for a branch; oversize/binary sides are
   flagged rather than shown. Git names both blobs per file with `diff --raw` and reads them all
   from **one `cat-file --batch` process** (`git/cat-file.ts`) rather than a `git show` per side.
2. **Flow order** (`analysis/ordering-signals.ts`) is deterministic and runs on the change already
   in memory: each file is tokenised **once** into identifiers, comments stripped, and every edge
   is weighted by how often the caller names the target. `flowOrder` then walks from the likeliest
   entry point, following the **strongest** reference first, so a task is followed by the handler it
   delegates to rather than by whichever neighbour most resembles another entry point.
3. **buildSteps** (`session.ts`) merges that order with static roles. The tree is now on screen.
4. **Ordering model** (`lm/order-steps.ts` + `order-prompt.ts`) runs afterwards and supplies each
   step's **title** and **effort**. Where the change has real reference edges the walk keeps
   position and the model only names the steps; with no edges to walk, the model's order is used.
   Either way the reply is **reconciled** against the real file list (`reconcileOrder`).
5. **Symbol graph** (`analysis/lsp-graph.ts`) resolves in the background and replaces the text graph
   for the on-demand surfaces.

Re-ordering never moves a file the reader opened **in this sitting**; marks restored from a
checkpoint are read history, not a position to protect (`session.ts`, `opened` vs `visited`).

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
- **Order** by execution flow, decided by the deterministic walk (`analysis/ordering-signals.ts`)
  with the model naming each step; `prAnalyzer.ordering` set to `references` skips the model call.
- **Tree** in `ui/files-tree.ts` (`StepTreeProvider`); flat or grouped by folder
  (`analysis/file-tree.ts`).
- **Test-impact flag:** a production file changed with no matching test change is marked *no test*
  (`analysis/test-impact.ts`).

### The symbol graph, and the question it asks
- `analysis/lsp-graph.ts` wants one fact: does a changed file reach another changed file? Asking
  "find all references" for every declaration made the language server search the **whole project**
  and then discarded everything outside the change. It now goes the other way — from an identifier
  **inside a changed hunk** to its definition — which the server answers locally, and only where a
  name some other changed file declares actually appears.
- Readiness is a **raced** probe rather than five sequential cold starts; the run is bounded by a
  deadline checked between items (`analysis/concurrency.ts`).

### Change-complexity colour coding
- The ordering pass (on the structure model — the main model unless overridden) rates each file
  `routine` / `involved` / `complex`; `session.ts`'s `clampEffort` corrects ratings the change size
  contradicts (a tiny change is never complex; a very large one is never routine).
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
- **Wire format:** a **fenced mermaid block** plus plain `node = path` lines (`lm/diagram-reply.ts`),
  not a JSON envelope. JSON could not be shown until the last brace arrived and cost a second round
  trip whenever a quote was mis-escaped; a closed fence is both streamable and a far more robust
  success condition, so the retry pass is gone.
- **Streaming:** the mermaid is posted into the panel as it is written, so the diagram visibly
  draws itself, then swaps to the rendered graph when the fence closes.
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
- **Streaming:** `lm/story-stream.ts` settles a section as soon as the next one starts and posts it
  to the panel, so the reader starts at the summary while later steps are still being written. It
  reuses `parseStory`, which is what keeps the streamed and finished documents identical.
- Covering the whole change legitimately needs more lookups than a single explain, so the
  read-through raises the tool budget rather than running out mid-way.

### Saying what is happening
- `ui/activity-status.ts` names the running work in the status bar — reading the change, working out
  the order, tracing what calls what, writing a step, drawing the map. Since the heavy work now
  happens **after** the first paint, a list that is about to gain titles must not look finished.
- `lm/lm-timing.ts` records each model view's phases — request sent, first token, last token,
  rendered — into the same log channel as the git calls, so "it felt slow" becomes a number that
  says which half to fix.

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

`selectStructureModel()` uses `prAnalyzer.structureModel` if set, and otherwise **the reasoning
model** — so by default ordering and the diagram run on the model you selected, and the diagram
keeps its quality. Setting `structureModel` to a lighter model is an opt-in speed override. A
status-bar item shows the reasoning model; `Select model`, `Select structure model`, and the
diagram's Model button change them.

### The tool loop (`lm/run-with-tools.ts`, `repo-tools.ts`)
The diagram, read-through, Explain, and intent all run through one bounded loop: the model streams
an answer and may call read-only repo tools (`read_file`, `find_symbol`, `search_text`), capped per
call so a whole-change read-through gets more headroom than a single-region explain. Within a round
the lookups run **in parallel**. Streamed text is handed back through `onText`, which is what lets a
caller render an answer as it is written. Tools are **sandboxed to the repository** under review
(`lm/safe-path.ts`) and gated on workspace trust; the files the model actually read are recorded for
provenance (`lm/provenance.ts`).

### Trusting nothing the model returns
- **Order** is reconciled to a real permutation (`order-prompt.ts`), and on a change with reference
  edges the deterministic walk keeps position regardless of what the model answers.
- **Diagram** is accepted only on a closed fence, then validated and renumbered; node paths are
  reconciled against the real file list and an unparseable reply falls back to the deterministic map.
- **Story** is parsed leniently and degrades on truncation.
- **JSON** replies are recovered from prose/fences and repaired for unescaped control characters
  (`lm/json.ts`).
- Change text is framed as **untrusted data** in every prompt, never instructions. A name that
  appears only in a **comment** is not treated as a call, so prose about the code cannot invent an
  edge in the graph.

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
- **Performance:** nothing slow gates the first paint — the language server and the ordering model
  both refine an already-drawn list. Blobs are read from **one** git process; the signal scan is a
  single pass over each file's identifiers rather than a regex of every file's names against every
  other file's contents, and is computed **once** per review for both the graph and the step list;
  tool lookups within a round run in parallel; drawn diagrams are cached per commit.
- **Perceived latency:** the read-through and the diagram render as they are written, so
  time-to-first-content is not time-to-last-token; the status bar names whatever is still running.
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
| How a change is read | `git/git-change-source.ts`, `git/cat-file.ts`, `ado/ado-change-source.ts`, `model/changeset.ts` |
| How the reading order is decided | `analysis/ordering-signals.ts` (`signalsFor`, `flowOrder`), then `lm/order-steps.ts` for titles and effort |
| How references are resolved | `analysis/lsp-graph.ts`, `analysis/text-graph.ts` |
| The map | `ui/diagram-panel.ts`, `lm/draw-diagram.ts`, `lm/diagram-reply.ts`, `webview/diagram.ts` |
| The read-through | `ui/story-panel.ts`, `lm/write-story.ts`, `lm/story-stream.ts`, `lm/story-prompt.ts` |
| Model plumbing | `lm/select-model.ts`, `lm/run-with-tools.ts`, `lm/model-gate.ts`, `lm/lm-timing.ts` |
| Why something is slow | the **AI PR Analyzer: Git** output channel — git calls, model phases, and the computed order |
