import * as vscode from "vscode";
import type { Step } from "../model/changeset.js";
import type { ReviewSession } from "../session.js";
import { analyzeTestImpact } from "../analysis/test-impact.js";
import {
  buildFileTree,
  type FileNode,
  type FolderNode,
  type TreeNode,
} from "../analysis/file-tree.js";

const CHANGE_TYPE_LETTER: Record<string, string> = {
  add: "A",
  edit: "M",
  delete: "D",
  rename: "R",
};

export class StepTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private session: ReviewSession | null = null;
  private roots: TreeNode[] = [];
  private uncovered = new Set<string>();
  private readonly parents = new Map<TreeNode, TreeNode | undefined>();
  private readonly byStep = new Map<string, FileNode>();
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  setSession(session: ReviewSession | null): void {
    this.session = session;
    // Production files whose behaviour changed with no matching test change, flagged
    // in the list so a reviewer sees the gap without opening anything.
    this.uncovered = new Set(session ? analyzeTestImpact(session.changeSet.files).uncovered : []);
    this.rebuild();
  }

  /** Builds the tree again, which the grouping switch needs and a step move does not. */
  refresh(): void {
    this.rebuild();
  }

  /** Redraws the existing nodes, keeping the identities reveal depends on. */
  touch(): void {
    this.changed.fire(undefined);
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (element) return element.kind === "folder" ? element.children : [];
    return this.roots;
  }

  getParent(element: TreeNode): TreeNode | undefined {
    return this.parents.get(element);
  }

  /** The node standing for a step, so the view can select what the reader moved to. */
  nodeForStep(stepId: string): TreeNode | undefined {
    return this.byStep.get(stepId);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    return node.kind === "folder"
      ? folderItem(node)
      : fileItem(node.step, this.session, grouped(), this.uncovered.has(node.step.file.path));
  }

  private rebuild(): void {
    const steps = this.session?.steps ?? [];
    this.roots = grouped()
      ? buildFileTree(steps)
      : steps.map((step) => ({ kind: "file", step }) as TreeNode);

    this.parents.clear();
    this.byStep.clear();
    this.index(this.roots, undefined);
    this.changed.fire(undefined);
  }

  private index(nodes: TreeNode[], parent: TreeNode | undefined): void {
    for (const node of nodes) {
      this.parents.set(node, parent);
      if (node.kind === "file") this.byStep.set(node.step.id, node);
      else this.index(node.children, node);
    }
  }
}

function grouped(): boolean {
  return (
    vscode.workspace.getConfiguration("prAnalyzer").get<string>("filesView", "flat") ===
    "folders"
  );
}

function folderItem(folder: FolderNode): vscode.TreeItem {
  const item = new vscode.TreeItem(folder.label, vscode.TreeItemCollapsibleState.Expanded);
  item.description = `${folder.fileCount} file${folder.fileCount === 1 ? "" : "s"}`;
  item.tooltip = folder.path;
  item.iconPath = vscode.ThemeIcon.Folder;
  item.contextValue = "prAnalyzer.folder";
  item.id = `folder:${folder.path}`;
  return item;
}

function fileItem(
  step: Step,
  session: ReviewSession | null,
  inFolders: boolean,
  uncovered: boolean,
): vscode.TreeItem {
  const name = step.file.path.split("/").pop() ?? step.file.path;

  // Numbering a list that is not in that order reads as a fault, so the number leads
  // the label only where the list really does run 1..n.
  const item = new vscode.TreeItem(
    inFolders ? name : `${step.order}. ${name}`,
    vscode.TreeItemCollapsibleState.None,
  );

  const hunks = countHunks(session, step);
  const title = step.title ?? dirOf(step.file.path);
  const gap = uncovered ? "  \u00b7  no test" : "";
  item.description = inFolders
    ? `step ${step.order} \u00b7 ${title}${hunks}${gap}`
    : `${title}${hunks}${gap}`;
  item.tooltip = new vscode.MarkdownString(
    [
      `**${step.file.path}**`,
      "",
      step.title ? `${step.order}. ${step.title}` : `Step ${step.order}`,
      "",
      `${step.role} \u00b7 ${step.file.changeType}`,
      ...(uncovered ? ["", "_Changed with no matching test change._"] : []),
    ].join("\n"),
  );
  item.resourceUri = vscode.Uri.file(step.file.path);
  item.iconPath = new vscode.ThemeIcon(iconFor(step.role));
  item.contextValue = "prAnalyzer.step";
  item.id = `step:${step.id}`;
  item.command = {
    command: "prAnalyzer.openStep",
    title: "Open",
    arguments: [step.id],
  };

  return item;
}

function countHunks(session: ReviewSession | null, step: Step): string {
  if (!session) return "";
  const isCurrent = session.currentStep?.id === step.id;
  if (!isCurrent) return "";
  const { hunk, hunks } = session.position;
  return hunks > 0 ? `  \u00b7  change ${Math.max(hunk, 1)}/${hunks}` : "";
}

function dirOf(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.slice(-2).join("/") || ".";
}

function iconFor(role: string): string {
  switch (role) {
    case "configuration":
      return "settings-gear";
    case "contract":
      return "symbol-interface";
    case "test":
      return "beaker";
    case "documentation":
      return "book";
    default:
      return "symbol-method";
  }
}

export { CHANGE_TYPE_LETTER };
