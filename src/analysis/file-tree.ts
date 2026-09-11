import type { Step } from "../model/changeset.js";

/**
 * The changed files as a folder tree, in the shape a pull request page shows them.
 *
 * Sorted alphabetically, folders before files, because that is the arrangement a
 * reviewer already recognises. It deliberately does NOT follow the reading order:
 * a flow that crosses directories and comes back cannot be both grouped and in
 * sequence, and a numbered list that is not in sequence reads as broken. The order
 * lives in the flat view, in F7, and in the diagram.
 */

export interface FileNode {
  kind: "file";
  step: Step;
}

export interface FolderNode {
  kind: "folder";
  /** Full path, so two folders sharing a name stay distinct. */
  path: string;
  /** What to show: several segments when a chain of folders holds one child each. */
  label: string;
  children: TreeNode[];
  /** Where the earliest file below this folder sits in the reading order. */
  order: number;
  lastOrder: number;
  fileCount: number;
}

export type TreeNode = FileNode | FolderNode;

interface Building {
  path: string;
  label: string;
  folders: Map<string, Building>;
  files: FileNode[];
}

export function buildFileTree(steps: Step[]): TreeNode[] {
  const root: Building = { path: "", label: "", folders: new Map(), files: [] };

  for (const step of steps) {
    const segments = step.file.path.split("/").filter(Boolean);
    const name = segments.pop();
    if (name === undefined) continue;

    let folder = root;
    for (const segment of segments) {
      let next = folder.folders.get(segment);
      if (!next) {
        next = {
          path: folder.path ? `${folder.path}/${segment}` : segment,
          label: segment,
          folders: new Map(),
          files: [],
        };
        folder.folders.set(segment, next);
      }
      folder = next;
    }
    folder.files.push({ kind: "file", step });
  }

  return finish(root).children;
}

function finish(building: Building): FolderNode {
  const children: TreeNode[] = [
    ...[...building.folders.values()].map((child) => compact(finish(child))),
    ...building.files,
  ];

  return {
    kind: "folder",
    path: building.path,
    label: building.label,
    children: children.sort(alphabetical),
    order: Math.min(...children.map(orderOf)),
    lastOrder: Math.max(...children.map(lastOrderOf)),
    fileCount: children.reduce((total, child) => total + countOf(child), 0),
  };
}

/** Folders first, then files, each by name: what every file tree does. */
function alphabetical(a: TreeNode, b: TreeNode): number {
  if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
  return nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true, sensitivity: "base" });
}

function nameOf(node: TreeNode): string {
  return node.kind === "folder"
    ? node.label
    : (node.step.file.path.split("/").pop() ?? node.step.file.path);
}

/** A chain of folders each holding one folder reads as one line, the way VS Code shows it. */
function compact(folder: FolderNode): FolderNode {
  let current = folder;
  while (current.children.length === 1 && current.children[0]!.kind === "folder") {
    const only = current.children[0] as FolderNode;
    current = { ...only, label: `${current.label}/${only.label}` };
  }
  return current;
}

export function orderOf(node: TreeNode): number {
  return node.kind === "file" ? node.step.order : node.order;
}

function lastOrderOf(node: TreeNode): number {
  return node.kind === "file" ? node.step.order : node.lastOrder;
}

function countOf(node: TreeNode): number {
  return node.kind === "file" ? 1 : node.fileCount;
}

/** Reading order is not the tree's order; F7 and the diagram keep it. */
export function flatten(nodes: TreeNode[]): Step[] {
  const steps: Step[] = [];
  for (const node of nodes) {
    if (node.kind === "file") steps.push(node.step);
    else steps.push(...flatten(node.children));
  }
  return steps;
}
