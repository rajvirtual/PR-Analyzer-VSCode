import * as vscode from "vscode";
import * as path from "node:path";
import { readdir, stat } from "node:fs/promises";
import { currentBranch, repositoryRoot } from "./git-change-source.js";

export interface RepositoryChoice {
  root: string;
  branch?: string;
}

/** The slice of the built-in git extension's API this needs. */
interface GitApi {
  repositories: { rootUri: vscode.Uri; state: { HEAD?: { name?: string } } }[];
}

/** Enough to find the repositories sitting side by side in a workspace folder, not a crawl. */
const MAX_CHILDREN_CHECKED = 200;

/** What VS Code's own git support has already found, nested repositories included. */
async function fromGitExtension(): Promise<RepositoryChoice[]> {
  const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>("vscode.git");
  if (!extension) return [];
  try {
    const exports = extension.isActive ? extension.exports : await extension.activate();
    return exports.getAPI(1).repositories.map((repository) => ({
      root: repository.rootUri.fsPath,
      branch: repository.state.HEAD?.name,
    }));
  } catch {
    // Git support can be switched off; the folders below are still worth offering.
    return [];
  }
}

async function isRepository(folder: string): Promise<boolean> {
  try {
    await stat(path.join(folder, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** Each workspace folder, and the repositories directly inside it. */
async function fromWorkspaceFolders(): Promise<string[]> {
  const found: string[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== "file") continue;
    const root = folder.uri.fsPath;
    try {
      found.push(await repositoryRoot(root));
    } catch {
      // A folder that is not a repository may still hold several.
    }
    try {
      const children = await readdir(root, { withFileTypes: true });
      for (const child of children.slice(0, MAX_CHILDREN_CHECKED)) {
        if (!child.isDirectory() || child.name.startsWith(".")) continue;
        const candidate = path.join(root, child.name);
        if (await isRepository(candidate)) found.push(candidate);
      }
    } catch {
      // Unreadable folders are simply not offered.
    }
  }
  return found;
}

/** Every repository the workspace offers, each named once. */
export async function listRepositories(): Promise<RepositoryChoice[]> {
  const byRoot = new Map<string, RepositoryChoice>();
  for (const choice of await fromGitExtension()) byRoot.set(path.resolve(choice.root), choice);
  for (const root of await fromWorkspaceFolders()) {
    const key = path.resolve(root);
    if (!byRoot.has(key)) byRoot.set(key, { root: key });
  }
  return [...byRoot.values()].sort((a, b) =>
    path.basename(a.root).localeCompare(path.basename(b.root)),
  );
}

/**
 * Asks which repository to review, the way `cd` would pick one: each repository found in
 * the workspace, with its checked-out branch, or any folder on disk.
 */
export async function pickRepository(current?: string): Promise<string | undefined> {
  type Item = vscode.QuickPickItem & { root?: string; browse?: boolean };

  const quickPick = vscode.window.createQuickPick<Item>();
  quickPick.title = "Review a branch in which repository?";
  quickPick.placeholder = "Pick a repository; its checked-out branch is reviewed";
  quickPick.matchOnDetail = true;
  quickPick.busy = true;
  const browse: Item = {
    label: "$(folder-opened) Browse…",
    detail: "Choose any folder inside a git repository",
    browse: true,
    alwaysShow: true,
  };
  quickPick.items = [browse];
  quickPick.show();

  void listRepositories().then(async (repositories) => {
    const items = await Promise.all(
      repositories.map(async (repository): Promise<Item> => {
        const branch =
          repository.branch ?? (await currentBranch(repository.root).catch(() => undefined));
        const reviewing = current && path.resolve(current) === path.resolve(repository.root);
        return {
          label: `$(repo) ${path.basename(repository.root)}`,
          description: [branch ? `$(git-branch) ${branch}` : "", reviewing ? "· reviewing now" : ""]
            .filter(Boolean)
            .join(" "),
          detail: repository.root,
          root: repository.root,
        };
      }),
    );
    quickPick.items = [...items, { label: "", kind: vscode.QuickPickItemKind.Separator }, browse];
    quickPick.busy = false;
  });

  const picked = await new Promise<Item | undefined>((resolve) => {
    quickPick.onDidAccept(() => resolve(quickPick.selectedItems[0]));
    quickPick.onDidHide(() => resolve(undefined));
  });
  quickPick.dispose();

  if (!picked) return undefined;
  if (!picked.browse) return picked.root;

  const folders = await vscode.window.showOpenDialog({
    title: "Review the branch checked out in…",
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Review this repository",
    defaultUri: current ? vscode.Uri.file(current) : vscode.workspace.workspaceFolders?.[0]?.uri,
  });
  return folders?.[0]?.fsPath;
}
