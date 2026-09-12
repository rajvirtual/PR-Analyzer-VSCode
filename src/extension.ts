import * as vscode from "vscode";
import * as path from "node:path";
import type { ChangeSet } from "./model/changeset.js";
import { buildChangeSet, GitError } from "./git/git-change-source.js";
import { runGit } from "./git/run-git.js";
import { buildPullRequestChangeSet, fetchPullRequestIntent, AdoError } from "./ado/ado-change-source.js";
import { createThread } from "./ado/pr-threads.js";
import { createPullRequestWorktree, type Worktree } from "./git/pr-worktree.js";
import { addRepositoryFolder, findLocalClone, offerToClone } from "./git/find-clone.js";
import { pruneOldClones, clearAllClones } from "./git/clone-store.js";
import { parsePullRequestUrl, PullRequestUrlError } from "./ado/pr-url.js";
import { buildSteps, ReviewSession, type Hunk } from "./session.js";
import { buildSymbolGraph } from "./analysis/lsp-graph.js";
import { orderFromGraph, type SymbolGraph } from "./analysis/flow-order.js";
import { hasEdges, textSymbolGraph } from "./analysis/text-graph.js";
import { orderStepsWithModel } from "./lm/order-steps.js";
import { pickModel, pickStructureModel, selectModel } from "./lm/select-model.js";
import {
  beginExclusiveModelWork,
  clearExclusiveModelWork,
  registerExclusiveModelWork,
} from "./lm/model-gate.js";
import {
  AFTER_SCHEME,
  BEFORE_SCHEME,
  ChangeContentProvider,
  uriFor,
} from "./ui/change-content-provider.js";
import { StepTreeProvider } from "./ui/files-tree.js";
import type { TreeNode } from "./analysis/file-tree.js";
import { GitLog } from "./ui/git-log.js";
import { HunkLensProvider } from "./ui/hunk-lens.js";
import { InlineExplainer } from "./ui/inline-explain.js";
import { offerDiffCodeLens } from "./ui/code-lens-setting.js";
import { StoryPanel } from "./ui/story-panel.js";
import { writeStory } from "./lm/write-story.js";
import { writeIntent } from "./lm/write-intent.js";
import { assembleIntentText, renderIntentMarkdown } from "./lm/intent-prompt.js";
import type { Story } from "./lm/story-prompt.js";
import { initialiseAdoAuth, signIn, signOut } from "./ado/ado-auth.js";
import { DiagramPanel } from "./ui/diagram-panel.js";
import { registerChatParticipant } from "./chat/participant.js";
import { initialiseModelMemory } from "./lm/model-memory.js";
import { Generation } from "./review/generation.js";
import {
  initialiseCheckpoints,
  loadCheckpoint,
  loadDiagram,
  saveCheckpoint,
  saveDiagram,
} from "./review/checkpoint.js";

let session: ReviewSession | null = null;
let graph: SymbolGraph = { references: new Map(), referencedBy: new Map(), resolved: false };
let statusBar: vscode.StatusBarItem;
let modelBar: vscode.StatusBarItem;
let tree: StepTreeProvider;
let treeView: vscode.TreeView<TreeNode>;
let content: ChangeContentProvider;
let extensionUri: vscode.Uri;
let storageUri: vscode.Uri;
let worktree: Worktree | null = null;
let gitLog: GitLog;
let lenses: HunkLensProvider;
let inlineExplainer: InlineExplainer;
let workspaceState: vscode.Memento;
let story: Story | null = null;
const loads = new Generation();
let loadTokens: vscode.CancellationTokenSource | null = null;

export function activate(context: vscode.ExtensionContext): void {
  extensionUri = context.extensionUri;
  storageUri = context.globalStorageUri;
  // Reclaim clones left unused for a while, so the cache self-limits. Zero disables it.
  const pruneDays = vscode.workspace
    .getConfiguration("prAnalyzer")
    .get<number>("clonePruneDays", 15);
  if (pruneDays > 0) void pruneOldClones(storageUri, pruneDays);
  initialiseModelMemory(context.globalState);
  initialiseCheckpoints(context.globalState);
  workspaceState = context.globalState;
  initialiseAdoAuth(context.secrets);
  tree = new StepTreeProvider();
  // A registered provider cannot be told what to select; only a view can.
  treeView = vscode.window.createTreeView("prAnalyzer.files", {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  content = new ChangeContentProvider();
  gitLog = new GitLog();
  lenses = new HunkLensProvider();
  inlineExplainer = new InlineExplainer();
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "prAnalyzer.next";
  // A second item names the model everything runs on, so the choice is visible and one click away.
  modelBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  modelBar.command = "prAnalyzer.selectModel";

  context.subscriptions.push(
    statusBar,
    modelBar,
    content,
    gitLog,
    gitLog.listen(),
    inlineExplainer,
    vscode.languages.registerCodeLensProvider(
      [{ scheme: AFTER_SCHEME }, { scheme: "file" }],
      lenses,
    ),
    treeView,
    vscode.workspace.registerTextDocumentContentProvider(BEFORE_SCHEME, content),
    vscode.workspace.registerTextDocumentContentProvider(AFTER_SCHEME, content),
    vscode.commands.registerCommand("prAnalyzer.reviewBranch", reviewBranch),
    vscode.commands.registerCommand("prAnalyzer.reviewPullRequest", reviewPullRequest),
    vscode.commands.registerCommand("prAnalyzer.refresh", refresh),
    vscode.commands.registerCommand("prAnalyzer.openStep", openStep),
    vscode.commands.registerCommand("prAnalyzer.next", () => move("next")),
    vscode.commands.registerCommand("prAnalyzer.previous", () => move("previous")),
    vscode.commands.registerCommand("prAnalyzer.setBaseRef", setBaseRef),
    vscode.commands.registerCommand("prAnalyzer.addRepositoryFolder", addRepositoryFolder),
    vscode.commands.registerCommand("prAnalyzer.toggleFilesView", toggleFilesView),
    vscode.commands.registerCommand("prAnalyzer.signIn", signInToAzureDevOps),
    vscode.commands.registerCommand("prAnalyzer.signOut", signOutOfAzureDevOps),
    vscode.commands.registerCommand("prAnalyzer.showGitLog", () => gitLog.show()),
    vscode.commands.registerCommand("prAnalyzer.explainChange", explainChange),
    vscode.commands.registerCommand("prAnalyzer.explainHunk", explainHunk),
    vscode.commands.registerCommand("prAnalyzer.showDiagram", showDiagram),
    vscode.commands.registerCommand("prAnalyzer.showStory", () => void showStory(false)),
    vscode.commands.registerCommand("prAnalyzer.mapIntent", mapIntent),
    vscode.commands.registerCommand("prAnalyzer.addNote", addNote),
    vscode.commands.registerCommand("prAnalyzer.clearClones", clearClones),
    vscode.commands.registerCommand("prAnalyzer.selectModel", () => void pickModel()),
    vscode.commands.registerCommand(
      "prAnalyzer.selectStructureModel",
      () => void pickStructureModel(),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("prAnalyzer.model")) void refreshModelIndicator();
    }),
    vscode.window.onDidChangeActiveTextEditor(updateDiffContext),
  );

  registerChatParticipant(context, () => session);
  void refreshModelIndicator();
}

export function deactivate(): void {
  session = null;
  void discardWorktree();
}

/** A checkout outlives nothing: it goes as soon as the review it served does. */
async function discardWorktree(): Promise<void> {
  const previous = worktree;
  worktree = null;
  await previous?.dispose();
}

function workspaceFolder(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const owner = vscode.workspace.getWorkspaceFolder(active);
    if (owner) return owner.uri.fsPath;
  }
  return folders[0].uri.fsPath;
}

let lastSource: { kind: "branch" } | { kind: "pull-request"; url: string } | null = null;

async function refresh(): Promise<void> {
  const source = lastSource;
  if (source?.kind === "pull-request") {
    // The same enrichment as the first review, so a refresh keeps its checkout
    // rather than falling back to only the changed files.
    await discardWorktree();
    await load(pullRequestFetch(source.url));
    return;
  }
  await reviewBranch();
}

async function signInToAzureDevOps(): Promise<void> {
  try {
    if (await signIn()) {
      void vscode.window.showInformationMessage("Signed in to Azure DevOps.");
    }
  } catch (error) {
    void vscode.window.showErrorMessage(
      `PR Analyzer: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function signOutOfAzureDevOps(): Promise<void> {
  await signOut();
  void vscode.window.showInformationMessage(
    "Forgot the stored Azure DevOps token. Your VS Code account sign-in is untouched.",
  );
}

/** Removes the cached clones and worktrees kept for pull request review. */
async function clearClones(): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    "Remove the clones and worktrees PR Analyzer caches for reviewing pull requests? " +
      "They are re-created on the next review.",
    { modal: true },
    "Clear",
  );
  if (choice !== "Clear") return;

  await discardWorktree();
  const removed = await clearAllClones(storageUri);
  void vscode.window.showInformationMessage(
    removed > 0
      ? `Cleared ${removed} cached clone${removed === 1 ? "" : "s"}.`
      : "No cached clones to clear.",
  );
}

async function toggleFilesView(): Promise<void> {
  const config = vscode.workspace.getConfiguration("prAnalyzer");
  const next = config.get<string>("filesView", "flat") === "folders" ? "flat" : "folders";
  await config.update("filesView", next, vscode.ConfigurationTarget.Global);
  tree.refresh();
  // Regrouping builds new nodes, so the selection has to be put back on the new one.
  if (session?.currentStep) void selectInTree(session.currentStep.id);
}

async function reviewBranch(): Promise<void> {
  const cwd = workspaceFolder();
  if (!cwd) {
    void vscode.window.showErrorMessage("Open a folder before reviewing a branch.");
    return;
  }

  const config = vscode.workspace.getConfiguration("prAnalyzer");
  lastSource = { kind: "branch" };
  await discardWorktree();

  await load(() =>
    buildChangeSet({
      cwd,
      baseRef: config.get<string>("baseRef", ""),
      includeUncommitted: config.get<boolean>("includeUncommitted", true),
    }),
  );
}

async function reviewPullRequest(): Promise<void> {
  const url = await vscode.window.showInputBox({
    title: "Review an Azure DevOps pull request",
    placeHolder: "https://dev.azure.com/org/project/_git/repo/pullrequest/12345",
    prompt: "Paste the pull request URL",
    ignoreFocusOut: true,
  });
  if (!url) return;

  lastSource = { kind: "pull-request", url };
  // Before, not after: a worktree is named for its pull request, so reviewing the same
  // one again would otherwise delete the checkout just made for it.
  await discardWorktree();

  await load(pullRequestFetch(url));
}

/** Fetches a pull request, checking it out beside a clone when one can be found. */
function pullRequestFetch(
  url: string,
): (report: (message: string) => void, token: vscode.CancellationToken) => Promise<ChangeSet> {
  return async (report, token) => {
    const changeSet = await buildPullRequestChangeSet(url, report, token);

    // With a clone to hand, check the pull request out so the whole repository is
    // readable rather than only the files it happened to change.
    report("Looking for a checkout…");
    const search = await findLocalClone(changeSet.identity);
    const clone =
      search.root ??
      (await offerToClone(changeSet.identity, storageUri, search.searched, report));

    if (clone && changeSet.headCommit) {
      const checkout = await createPullRequestWorktree({
        clone,
        identity: changeSet.identity,
        commit: changeSet.headCommit,
        storage: storageUri,
        onProgress: report,
      });
      if (checkout) {
        worktree = checkout;
        return { ...changeSet, repositoryRoot: checkout.path };
      }
    }

    return changeSet;
  };
}

/** One path for both sources: fetch, order, then open the first step. */
async function load(
  fetch: (
    report: (message: string) => void,
    token: vscode.CancellationToken,
  ) => Promise<ChangeSet>,
): Promise<void> {
  const config = vscode.workspace.getConfiguration("prAnalyzer");
  gitLog.startRun(new Date().toLocaleTimeString());

  // A newer review supersedes an older one: cancel its work, and refuse to let
  // whatever it eventually returns overwrite the review that replaced it.
  loadTokens?.cancel();
  loadTokens?.dispose();
  const tokens = new vscode.CancellationTokenSource();
  loadTokens = tokens;
  const ticket = loads.next();
  const current = (): boolean => loads.isCurrent(ticket);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "PR Analyzer", cancellable: false },
    async (progress) => {
      try {
        const changeSet = await fetch((message) => progress.report({ message }), tokens.token);
        if (!current()) return;

        if (changeSet.files.length === 0) {
          void vscode.window.showInformationMessage("Nothing changed to review.");
          setSession(null);
          return;
        }

        progress.report({ message: "Tracing how the files call each other…" });
        let built = await buildSymbolGraph(changeSet.repositoryRoot, changeSet.files, {
          onProgress: (message) => progress.report({ message }),
        });
        if (!current()) return;

        // The language server sharpens the graph but is not required for one.
        if (!hasEdges(built)) built = textSymbolGraph(changeSet.files);

        const graphOrder = orderFromGraph(changeSet.files, built);

        let order = graphOrder.map((file) => ({ path: file, title: undefined as string | undefined }));
        let note: string | undefined;

        if (config.get<string>("ordering", "model") === "model") {
          progress.report({ message: "Asking the model for the reading order…" });
          const outcome = await orderStepsWithModel({
            files: changeSet.files,
            graph: built,
            fallbackOrder: graphOrder,
            token: tokens.token,
          });
          if (!current()) return;
          order = outcome.steps;
          note = outcome.note ?? note;
        }

        graph = built;
        setSession(new ReviewSession(changeSet, buildSteps(changeSet, order)));
        content.setChangeSet(changeSet);

        // Pick up where this exact change was last left, if it was seen before.
        const saved = loadCheckpoint(changeSet);
        if (saved && session) session.restore(saved);

        if (note) {
          void vscode.window
            .showWarningMessage(`PR Analyzer: ${note}`, "Refresh")
            .then((choice) => {
              if (choice === "Refresh") void refresh();
            });
        }
        if (changeSet.skipped.length > 0) {
          void vscode.window.showWarningMessage(
            `${changeSet.skipped.length} file(s) skipped: ${changeSet.skipped
              .slice(0, 3)
              .map((entry) => `${entry.path} (${entry.reason})`)
              .join(", ")}`,
          );
        }

        const start = session?.currentStep ?? session?.steps[0];
        if (start) await openStep(start.id);
      } catch (error) {
        if (!current()) return;
        setSession(null);
        const message =
          error instanceof GitError ||
          error instanceof AdoError ||
          error instanceof PullRequestUrlError
            ? error.message
            : String(error);

        // A git failure is rarely self-explaining; the commands that led to it are.
        const actions = gitLog.failureCount > 0 ? ["Show git commands"] : [];
        void vscode.window
          .showErrorMessage(`PR Analyzer: ${message}`, ...actions)
          .then((choice) => {
            if (choice === "Show git commands") gitLog.show();
          });
      }
    },
  );
}

function setSession(next: ReviewSession | null): void {
  session = next;
  tree.setSession(next);
  lenses.setSession(next);
  // An explanation belongs to the change it described, not to whatever replaced it.
  inlineExplainer.clear();
  story = null;
  // Naming the source makes it plain which review replaced which.
  treeView.description = next?.changeSet.label;
  void vscode.commands.executeCommand("setContext", "prAnalyzer.active", next !== null);
  // A review may have settled on a model (e.g. the last @pr pick); keep the indicator honest.
  void refreshModelIndicator();
  if (!next) {
    content.setChangeSet(null);
    statusBar.hide();
    return;
  }
  updateStatusBar();
}

function updateStatusBar(): void {
  if (!session) {
    statusBar.hide();
    return;
  }
  const { step, steps, hunk, hunks } = session.position;
  const changePart = hunks > 0 ? `  ·  change ${Math.max(hunk, 1)}/${hunks}` : "";
  statusBar.text = `$(git-pull-request) Step ${step}/${steps}${changePart}  $(chevron-down)`;
  const coverage = session.coverage();
  const omittedPart = coverage.omitted > 0 ? `, ${coverage.omitted} omitted` : "";
  statusBar.tooltip = new vscode.MarkdownString(
    `**${session.changeSet.label}**\n\n` +
      `Seen ${coverage.visited} of ${coverage.files} files${omittedPart}.\n\n` +
      "Click, or press `F7`, for the next change — continuing into the next file when this one is done.\n\n" +
      "The diff editor's own arrows stay within this file.",
  );
  statusBar.show();
}

async function refreshModelIndicator(): Promise<void> {
  const configured = vscode.workspace
    .getConfiguration("prAnalyzer")
    .get<string>("model", "")
    .trim();
  // Prefer the model actually resolved for the run; fall back to the setting, then a generic label.
  let label = configured;
  try {
    const model = await selectModel();
    if (model) label = model.name;
  } catch {
    // The model list may not be ready yet at activation; the setting or generic label still helps.
  }
  modelBar.text = `$(sparkle) ${label || "Model"}`;
  modelBar.tooltip = new vscode.MarkdownString(
    "**PR Analyzer model**\n\n" +
      "Used for the read-through, Explain, and intent. Ordering and the diagram use the\n" +
      "structure model instead.\n\n" +
      "Click to choose a different model.",
  );
  modelBar.show();
}

async function openStep(stepId?: string): Promise<void> {
  if (!session) return;
  if (stepId && !session.selectStep(stepId)) return;
  await revealCurrent({ fileChanged: true });
}

async function move(direction: "next" | "previous"): Promise<void> {
  if (!session) {
    void vscode.window.showInformationMessage("Run PR Analyzer: Review this branch first.");
    return;
  }

  const from = session.currentStep?.id;
  const moved = direction === "next" ? session.next() : session.previous();
  if (!moved) {
    void vscode.window.setStatusBarMessage(
      direction === "next" ? "End of the change" : "Start of the change",
      1500,
    );
    return;
  }

  await revealCurrent({ fileChanged: session.currentStep?.id !== from });
}

async function revealCurrent(options: { fileChanged?: boolean } = {}): Promise<void> {
  const step = session?.currentStep;
  if (!step || !session) return;

  const root = session.changeSet.repositoryRoot;
  // A pull request has no checkout, so the modified side is virtual too.
  const afterUri = root
    ? vscode.Uri.file(path.join(root, step.file.path))
    : uriFor(step.file.path, "after");
  const title = `${step.file.path} (${step.order}/${session.steps.length})`;

  if (options.fileChanged !== false || !showingStep(step.file.path)) {
    if (step.file.changeType === "add") {
      await vscode.window.showTextDocument(afterUri, { preview: true });
    } else if (step.file.changeType === "delete") {
      await vscode.window.showTextDocument(uriFor(step.file.path, "before"), { preview: true });
    } else {
      await vscode.commands.executeCommand(
        "vscode.diff",
        uriFor(step.file.previousPath ?? step.file.path, "before"),
        afterUri,
        title,
        { preview: true },
      );
      void offerDiffCodeLens(workspaceState);
    }
  }

  revealHunk(afterUri);
  tree.touch();
  void selectInTree(step.id);
  updateStatusBar();
  saveCheckpoint(session.changeSet, {
    currentPath: session.currentPath(),
    visited: session.visitedPaths(),
  });
  DiagramPanel.highlight(step.id);
  updateDiffContext(vscode.window.activeTextEditor);
}

/** Moves the selection to the file being read, opening the folders holding it. */
async function selectInTree(stepId: string): Promise<void> {
  const node = tree.nodeForStep(stepId);
  if (!node) return;
  try {
    // Focus stays in the editor: the reader is reading, not picking from a list.
    await treeView.reveal(node, { select: true, focus: false, expand: true });
  } catch {
    // Reveal throws while the view is hidden, which is not a reason to stop navigating.
  }
}

/** True when an editor for this step's file is already on screen. */
function showingStep(relativePath: string): boolean {
  return vscode.window.visibleTextEditors.some(
    (editor) =>
      editor.document.uri.fsPath.endsWith(relativePath) ||
      editor.document.uri.query === relativePath,
  );
}

function revealHunk(afterUri: vscode.Uri): void {
  const hunk = session?.currentHunk();
  if (!hunk) return;

  // In a diff the focused editor may be the base side, so target the modified one.
  const editor =
    vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.toString() === afterUri.toString(),
    ) ?? vscode.window.activeTextEditor;
  if (!editor) return;

  const lastLine = Math.max(0, editor.document.lineCount - 1);
  const start = Math.min(lastLine, Math.max(0, hunk.startLine - 1));
  const end = Math.min(lastLine, Math.max(start, hunk.endLine - 1));
  const range = new vscode.Range(start, 0, end, 0);

  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  editor.selection = new vscode.Selection(range.start, range.start);
}

function updateDiffContext(editor: vscode.TextEditor | undefined): void {
  const isReviewDiff =
    editor?.document.uri.scheme === BEFORE_SCHEME ||
    editor?.document.uri.scheme === AFTER_SCHEME ||
    Boolean(session);
  void vscode.commands.executeCommand("setContext", "prAnalyzer.isReviewDiff", isReviewDiff);
}

function showDiagram(): void {
  if (!session) {
    void vscode.window.showInformationMessage("Run PR Analyzer: Review this branch first.");
    return;
  }
  DiagramPanel.show(
    extensionUri,
    session.steps,
    session.changeSet.files,
    graph,
    session.changeSet.repositoryRoot,
    (stepId) => void openStep(stepId),
    {
      load: () => (session ? loadDiagram(session.changeSet) : undefined),
      save: (diagram) => {
        if (session) saveDiagram(session.changeSet, diagram);
      },
    },
  );
  DiagramPanel.highlight(session.currentStep?.id ?? null);
}

async function showStory(regenerate: boolean): Promise<void> {
  if (!session) {
    void vscode.window.showInformationMessage("Run PR Analyzer: Review this branch first.");
    return;
  }

  const tokens = new vscode.CancellationTokenSource();
  const panel = StoryPanel.show({
    extensionUri,
    open: (path) => {
      const step = session?.steps.find((candidate) => candidate.file.path === path);
      if (step) void openStep(step.id);
    },
    regenerate: () => void showStory(true),
    cancel: () => tokens.cancel(),
  });

  // Written once per review: reopening the panel is not a reason to pay again.
  if (story && !regenerate) {
    panel.show(story, "");
    return;
  }

  // Hold the model exclusively only now — re-showing a cached read-through must not
  // cancel a diagram that is still drawing.
  registerExclusiveModelWork(tokens);

  let model = "";
  panel.busy("Reading the whole change…", model);

  const outcome = await writeStory({
    steps: session.steps,
    files: session.changeSet.files,
    repositoryRoot: session.changeSet.repositoryRoot,
    onProgress: (message) => panel.busy(message, model),
    onModel: (name) => {
      model = name;
      panel.busy("Reading the whole change…", name);
    },
    token: tokens.token,
  });
  clearExclusiveModelWork(tokens);

  if (outcome.story) {
    story = outcome.story;
    panel.show(outcome.story, model);
  } else if (tokens.token.isCancellationRequested) {
    panel.failed("Stopped.");
  } else {
    panel.failed(outcome.reason ?? "The read-through could not be written.");
  }
}

async function explainChange(): Promise<void> {
  if (!session) {
    void vscode.window.showInformationMessage("Run PR Analyzer: Review this branch first.");
    return;
  }
  await vscode.commands.executeCommand("workbench.action.chat.open", { query: "@pr /explain" });
}

/** Maps the change's stated intent to the files that implement it and the tests that cover it. */
async function mapIntent(): Promise<void> {
  if (!session) {
    void vscode.window.showInformationMessage("Run PR Analyzer: Review this branch first.");
    return;
  }
  const changeSet = session.changeSet;
  const tokens = beginExclusiveModelWork();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "PR Analyzer: mapping intent…",
      cancellable: true,
    },
    async (progress, token) => {
      token.onCancellationRequested(() => tokens.cancel());
      try {
        let intent = "";
        if (lastSource?.kind === "pull-request") {
          progress.report({ message: "Reading the pull request…" });
          const fetched = await fetchPullRequestIntent(
            parsePullRequestUrl(lastSource.url),
            tokens.token,
          );
          intent = assembleIntentText(fetched);
        } else {
          // A branch has no description; its commit subjects are the nearest thing to intent.
          try {
            intent = await runGit(changeSet.repositoryRoot, [
              "log",
              "--format=%s",
              `${changeSet.mergeBase}..HEAD`,
            ]);
          } catch {
            intent = "";
          }
        }

        progress.report({ message: "Mapping intent to the change…" });
        const outcome = await writeIntent({
          intent,
          files: changeSet.files,
          repositoryRoot: changeSet.repositoryRoot,
          onProgress: (message) => progress.report({ message }),
          token: tokens.token,
        });

        if (!outcome.map) {
          void vscode.window.showWarningMessage(
            `PR Analyzer: ${outcome.reason ?? "Could not map the intent."}`,
          );
          return;
        }

        const document = await vscode.workspace.openTextDocument({
          content: renderIntentMarkdown(outcome.map, changeSet.label),
          language: "markdown",
        });
        await vscode.window.showTextDocument(document, { preview: true });
      } finally {
        clearExclusiveModelWork(tokens);
        tokens.dispose();
      }
    },
  );
}

/** Posts a review note to the pull request, anchored to the file and line on screen. */
async function addNote(): Promise<void> {
  if (!session) {
    void vscode.window.showInformationMessage("Run PR Analyzer: Review this branch first.");
    return;
  }
  const source = lastSource;
  if (source?.kind !== "pull-request") {
    void vscode.window.showInformationMessage(
      "A branch has no pull request to comment on. Review a pull request to add a note.",
    );
    return;
  }

  const step = session.currentStep;
  const note = await vscode.window.showInputBox({
    title: "Add a review note to this pull request",
    prompt: step ? `Posts a comment on ${step.file.path}` : "Posts a comment on the pull request",
    placeHolder: "Your note…",
    ignoreFocusOut: true,
  });
  if (!note?.trim()) return;

  const anchor = step
    ? { filePath: step.file.path, line: session.currentHunk()?.startLine ?? 1 }
    : undefined;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "PR Analyzer: posting the note…" },
    async () => {
      try {
        await createThread(parsePullRequestUrl(source.url), note.trim(), anchor);
        void vscode.window.showInformationMessage("Posted your note to the pull request.");
      } catch (error) {
        void vscode.window.showErrorMessage(
          `PR Analyzer: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}

async function explainHunk(uri?: vscode.Uri, hunk?: Hunk): Promise<void> {
  if (!session || !uri || !hunk) return;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "PR Analyzer: explaining…" },
    (_progress, token) => inlineExplainer.explain(session!, uri, hunk, token),
  );
}

async function setBaseRef(): Promise<void> {
  const config = vscode.workspace.getConfiguration("prAnalyzer");
  const value = await vscode.window.showInputBox({
    title: "Compare this branch against",
    value: config.get<string>("baseRef", ""),
    placeHolder: "origin/main — leave empty to detect automatically",
  });
  if (value === undefined) return;
  await config.update("baseRef", value, vscode.ConfigurationTarget.Workspace);
  await reviewBranch();
}
