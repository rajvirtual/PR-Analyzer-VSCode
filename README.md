# PR Analyzer

Review a large change the way it was written, not the way it was filed.

A pull request of fifty files arrives as an alphabetical list. PR Analyzer orders those
files into the flow a reader should follow, opens each one at the change itself, and draws
a diagram of what the change actually does — so you can understand a branch before you
start reading it.

Built for reviewing AI-written changes, where the volume is high and the reviewer has no
memory of writing any of it.

## What it does

**Orders the change as a flow.** Files are placed in the order execution reaches them,
starting at the entry point rather than at whatever sorts first. Each step is named for
what happens there — *"Setup task entry"*, *"Resolve the capacity profile"* — not for its
file name.

**Walks changes, not files.** Next and Previous move through the hunks inside a file and
then carry on into the next file, so a fifty-file change is one continuous read.

**Draws the change.** A diagram of how the code works at runtime, with every node marked
as new, changed, or existing, so you can see where this branch touched the flow. Numbered,
so you can point at a box in review. Clicking a node opens the file behind it.

**Explains a diff in context.** `@pr` in chat explains the change on screen, and can read
the rest of the repository to do it — the definition of a method that the diff calls but
does not contain. Answers lead with the point and carry a worked example using values from
your code; where a flag has only a few states, every state is shown, including the `null`
of a nullable bool.

**Explains one change where it sits.** Every changed region carries an **Explain this**
link above it. Pressing it answers that region alone, in a comment anchored there, so the
explanation is beside the code rather than in another panel. Nothing is generated until you
ask: a change of any size would otherwise be a long wait for paragraphs you did not want.

> VS Code ships `diffEditor.codeLens` turned **off**, so these links do not appear in a diff
> until it is on. You are offered it the first time a diff opens; to turn it on later, set
> `diffEditor.codeLens` to `true`.

**Reads the whole change end to end.** The book icon opens a read-through: what the change
accomplishes, then each step of the flow in the order it runs, with the values moving through
it. Every heading opens that file's diff, so you can read the account and drop into the code
where it matters. It ends with what an operator would find before and after the change. Written once per review,
with **Write it again** for another pass, and **Stop** while it is thinking.

**Works before you push.** The default source is your branch against its merge base,
including uncommitted work. You do not need a pull request, or even a commit.

**Groups files the way the repository does.** The Files view lists changes in reading order
by default, numbered to match the flow. The tree icon switches to a folder view that reads
like the pull request page — the repository's own shape, sorted alphabetically — for when
you want to find a file by where it lives rather than when it runs.

**Shows the git it ran.** Every git command is recorded — what ran, where, how long it took,
and what git said when it failed — reachable from the terminal icon or **Show the git
commands**. When a checkout or fetch fails, the reason is a line you can read and reproduce,
not a mystery.

**Checks intent against the change.** **Map intent to evidence** reads what the change set out
to do — a pull request's description and its linked work items, or a branch's commit subjects —
and lays each intent beside the files that implement it and the tests that cover it, so a
promise made with no code or no test behind it is visible rather than buried.

**Flags what changed with no test.** A production file altered without a matching test change is
marked *no test* in the Files list, so the gap is on screen before you open anything.

**Shows what an answer read.** Every `@pr` answer ends with the files it opened beyond the diff,
so a grounded explanation reads differently from a guess.

**Keeps count of what you have seen.** The status bar tracks how many of the changed files you
have opened, and how many were left out, so a large review has a finish line.

**Remembers where you were.** Reopen the same change and it resumes at the file you left, with
the files you had already read still marked — nothing is re-read from the top.

**Adds a note to the pull request.** **Add a review note** posts a comment back to the pull
request, anchored to the file and line on screen, so a finding made here lands in the review
everyone else is reading.

## Requirements

- VS Code 1.95 or later
- GitHub Copilot, signed in — the extension uses your existing subscription
- `git` on the path

A language server for the repository's language is optional. It sharpens the reference
graph when it is running, and is skipped when it is not.

In a workspace you have not trusted, the diff and its navigation still work; reading the wider
repository for `@pr`, the diagram, the read-through, and the intent map waits until you trust it.

Reviewing a **branch** needs no account at all. Reviewing a **pull request** needs access to
Azure DevOps, either way round:

- **Your VS Code account**, if it can reach the organisation. Nothing to type.
- **A personal access token**, for organisations account sign-in cannot reach. Create one
  under *User settings → Personal access tokens* with **Code (read)**, then run
  **PR Analyzer: Sign in to Azure DevOps** and choose the token. It is kept in VS Code's
  secret storage, never in settings, and **Forget the stored Azure DevOps token** removes it.

Both `dev.azure.com` and the older `*.visualstudio.com` hosts are understood.

## Getting started

Two ways in. Neither asks you to prepare anything by hand.

**A pull request, from nothing.** Run **PR Analyzer: Review a pull request by URL** and paste
an Azure DevOps link. That is the whole setup: the repository does not have to be open,
checked out, or even cloned. A missing clone is offered, and the pull request is checked out
into a worktree of its own, removed when you move on. Your branch is never touched.

**A branch you are already on.** Open the repository and run **PR Analyzer: Review this
branch**, or press the button in the PR Analyzer view. Uncommitted work is included, so there
is nothing to push or even commit first.

Then, either way:

1. Step through with `F7` and `Shift+F7`, or the chevrons on the Files view.
2. Press the map icon to draw the diagram, or the book icon to read the change end to end.
3. Press **Explain this** above any change, or ask `@pr /explain` in chat about what is on screen.

**To review something else**, pick **Review a pull request by URL** or **Review this branch**
again from the `…` menu at the top of the Files view. The new review replaces the old one, and
the previous worktree is removed. The heading beside **Files** names what you are reading.

To read the whole repository rather than only the
changed files, a clone is looked for in three places, cheapest first:

1. Your open workspace folders.
2. `<folder>/<repository>` for each path in `prAnalyzer.repositorySearchPaths`, and beside
   each open folder. This is an exact check, not a search: no directory is listed, and
   nothing matches by accident.
3. Otherwise you are offered **Clone it**, **Locate it** — pick the folder yourself, and
   where you keep clones is remembered — or **Continue without**.

The pull request is then checked out into a temporary worktree, which is removed when you
move on. Continuing without a clone still works, with only the changed files.

## Commands

| Command | What it does |
| --- | --- |
| `PR Analyzer: Review this branch` | Reads your branch against its merge base |
| `PR Analyzer: Review a pull request by URL` | Reads an Azure DevOps pull request at its pinned commits |
| `PR Analyzer: Read this change end to end` | Opens the read-through of the whole change |
| `PR Analyzer: Map intent to evidence` | Lays each stated intent beside the files and tests that deliver it |
| `PR Analyzer: Open the map` | Draws the diagram |
| `PR Analyzer: Explain this change` | Opens chat on the change you are looking at |
| `PR Analyzer: Add a review note to the pull request` | Posts a comment on the pull request, anchored to the file and line on screen |
| `PR Analyzer: Next change, then next file` | `F7` / `Alt+Down` |
| `PR Analyzer: Previous change, then previous file` | `Shift+F7` / `Alt+Up` |
| `PR Analyzer: Group the files by folder, or flatten them` | Switches the Files view between reading order and folders |
| `PR Analyzer: Set the branch to compare against` | Overrides the detected base branch |
| `PR Analyzer: Refresh` | Re-reads the change |
| `PR Analyzer: Sign in to Azure DevOps` | Chooses the account or token used for pull requests |
| `PR Analyzer: Forget the stored Azure DevOps token` | Removes the stored token, leaving your account sign-in |
| `PR Analyzer: Add a folder to search for clones` | Teaches it where you keep clones |
| `PR Analyzer: Show the git commands` | Opens the log of every git command it ran |

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `prAnalyzer.baseRef` | *(empty)* | Branch to compare against. Empty detects `origin/HEAD`, then `origin/main`, then `origin/master` |
| `prAnalyzer.includeUncommitted` | `true` | Include working tree changes, so a branch can be reviewed before it is pushed |
| `prAnalyzer.ordering` | `model` | `model` asks a model to order the files; `references` uses the reference graph alone and spends nothing |
| `prAnalyzer.model` | *(empty)* | Model for ordering and the diagram. Empty follows the model you last used in `@pr` chat |
| `prAnalyzer.repositorySearchPaths` | `[]` | Folders holding your clones. Each is checked for a directory named after the repository. Choosing **Locate it**, or running **PR Analyzer: Add a folder to search for clones**, adds one for you |
| `prAnalyzer.filesView` | `flat` | `flat` is one numbered list in reading order, matching `F7` exactly. `folders` shows the repository's shape, sorted alphabetically like a pull request page — the reading order is not the list's order there, so the step number moves into the description. The tree icon above the list switches between them |

## Moving around the diagram

| | |
| --- | --- |
| Scroll | Wheel, trackpad, or the scrollbars |
| Zoom | `Ctrl`/`Cmd` and the wheel, or the **+** and **&minus;** buttons |
| Pan | Drag the diagram itself |

## When git goes wrong

Every git command is recorded, with the folder it ran in, how long it took, and what
git said when it failed. Open it from the toolbar button above the **Files** list, or
run **PR Analyzer: Show the git commands**. Each line is written the way you would type
it, so a failure can be reproduced in a terminal.

## What it sends, and where

The extension talks to two services, both with your existing credentials:

- **GitHub Copilot**, for ordering, the diagram, `@pr` chat, the read-through, and the intent
  map. It receives the changed files, a digest of what changed in them, whatever files the
  model then asks to read, and — for the intent map — the pull request's description and linked
  work item titles, or the branch's commit subjects.
- **Azure DevOps**, when you review a pull request by URL, to fetch that pull request's files
  and, if you map its intent, its description and linked work items; and when you add a review
  note, to post that comment back to the pull request. VS Code's own Microsoft sign-in is used,
  or a token you supplied.

Nothing is sent anywhere else, and nothing is written outside VS Code's own storage.

## How the ordering and the diagram are produced

Ordering is a model's judgement, given evidence: which files declare which symbols, and
which files reference them. Its answer is reconciled against the real file list, so an
invented path is discarded and an omitted one is appended — you always see every file
exactly once.

The diagram is drawn by a model that is given the added and removed declarations and the
rewritten conditions from each file, and can read the repository to fill in what the digest
does not show. If it returns something unparseable, a plain file map is shown instead and
the reason is reported rather than hidden.

Both cost one Copilot request each. Set `prAnalyzer.ordering` to `references` to skip the
first.

## Known limitations

- **A pull request from a repository that cannot be found or cloned** is only the files it
  changed: the model cannot read a caller or search the wider repository, and the ordering
  has less to go on.
- **Cloning needs git to authenticate without prompting.** No terminal is attached, so if
  your credential helper wants input the clone fails rather than hangs. Clone the
  repository once from a terminal and it will be found from then on.
- **A checked-out pull request is not in the workspace**, so the language server does not
  index it. Files and search work; go-to-definition accuracy comes from your own checkout.
- **Binary files are skipped**, and reported as skipped.
- **Only Azure DevOps** pull request URLs are understood.
- **Renames are detected but lightly tested.**
- The diagram costs a request each time it is drawn; it is not cached between sessions.

## Installing it

The extension is not on the Marketplace. It ships as a `.vsix` file, which installs in one
command and uses each person's own Copilot sign-in — there is nothing else to set up.

**From a build.** Every push to `main` publishes `pr-analyzer-vsix` as a build artifact.
Download it and run:

```bash
code --install-extension pr-analyzer-0.2.0.vsix
```

**From source.**

```bash
cd PR-Analyzer-VSCode
npm ci
npm run package        # writes dist/pr-analyzer-<version>.vsix
code --install-extension dist/pr-analyzer-0.2.0.vsix
```

Then reload VS Code. Working over Remote-SSH or WSL? Install it in the remote, since that
is where `git` and the repository live.

Sideloaded extensions do not auto-update, so bump `version` in `package.json` when you
publish a build worth taking, and tell people to reinstall.

## License

MIT — see [LICENSE](LICENSE).

## Development

```bash
npm install
npm run compile     # both bundles: extension host and diagram webview
npm run typecheck   # extension and webview are typechecked separately
npm test
```

Press `F5` to launch an Extension Development Host.

Logic worth testing lives outside any module that imports `vscode`, because those cannot
be loaded under the test runner. That is why ordering, diffing, digests and prompts are
plain modules with the editor kept at the edges.

The diagram prompt and the digest that feeds it are pinned by `tests/diagram-locked.test.ts`.
Prompt quality cannot be read off the code, so an accidental edit would otherwise change
the output silently. Changing them is fine — update the test in the same commit, and check
the result against a real pull request first.
