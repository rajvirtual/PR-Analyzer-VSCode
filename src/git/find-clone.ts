import * as path from "node:path";
import * as vscode from "vscode";
import type { PullRequestIdentity } from "../ado/pr-url.js";
import { sameRepository } from "./remote-match.js";
import { cloneUrl } from "./clone-url.js";
import { runGit } from "./run-git.js";

/**
 * Finding, or fetching, a clone of the repository a pull request belongs to.
 *
 * Looked for in three places in increasing order of cost: the open folders, the
 * folders beside them, and finally a clone of our own, which is only made after
 * the reader agrees to it.
 */

const git = runGit;

async function matchesIdentity(folder: string, identity: PullRequestIdentity): Promise<string | null> {
  try {
    const root = await git(folder, ["rev-parse", "--show-toplevel"]);
    const remotes = await git(root, ["remote", "-v"]);
    return remotes.split("\n").some((line) => sameRepository(line, identity)) ? root : null;
  } catch {
    return null;
  }
}

function searchRoots(): string[] {
  const configured = vscode.workspace
    .getConfiguration("prAnalyzer")
    .get<string[]>("repositorySearchPaths", []);

  // The parent of an open folder is a likely home for sibling clones, but only ever
  // probed at the exact repository name: enumerating a directory the reader never
  // pointed at would be slow, and would match whatever happened to be sitting there.
  const parents = (vscode.workspace.workspaceFolders ?? []).map((folder) =>
    path.dirname(folder.uri.fsPath),
  );

  return [...new Set([...configured, ...parents])];
}

export interface CloneSearch {
  root: string | null;
  /** Every path that was checked, so a miss can be explained rather than guessed at. */
  searched: string[];
}

/** A clone of this pull request's repository, if one is already on disk. */
export async function findLocalClone(identity: PullRequestIdentity): Promise<CloneSearch> {
  const searched: string[] = [];

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    searched.push(folder.uri.fsPath);
    const match = await matchesIdentity(folder.uri.fsPath, identity);
    if (match) return { root: match, searched };
  }

  for (const root of searchRoots()) {
    // Either the path is a clone itself, or it holds one named after the repository.
    for (const candidate of [path.join(root, identity.repository), root]) {
      searched.push(candidate);
      const match = await matchesIdentity(candidate, identity);
      if (match) return { root: match, searched };
    }
  }

  return { root: null, searched };
}

/**
 * Lets the reader point at their own clone, and remembers where they keep them.
 *
 * Clone layouts differ between people, so the parent of the chosen folder is added
 * to the search paths and the next repository is found without asking.
 */
async function locateClone(identity: PullRequestIdentity): Promise<string | null> {
  const [chosen] = (await vscode.window.showOpenDialog({
    title: `Where is ${identity.repository}?`,
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Use this clone",
  })) ?? [];
  if (!chosen) return null;

  const match = await matchesIdentity(chosen.fsPath, identity);
  if (!match) {
    void vscode.window.showWarningMessage(
      `That folder is not a clone of ${identity.repository}.`,
    );
    return null;
  }

  const configuration = vscode.workspace.getConfiguration("prAnalyzer");
  const existing = configuration.get<string[]>("repositorySearchPaths", []);
  const parent = path.dirname(match);
  if (!existing.includes(parent)) {
    await configuration.update(
      "repositorySearchPaths",
      [...existing, parent],
      vscode.ConfigurationTarget.Global,
    );
  }

  return match;
}

/**
 * Names a folder holding clones, before a pull request needs one.
 *
 * The same setting Locate it writes, reachable up front by anyone whose clones do
 * not sit beside the folder they have open.
 */
export async function addRepositoryFolder(): Promise<void> {
  const [chosen] = (await vscode.window.showOpenDialog({
    title: "Which folder holds your clones?",
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Search this folder",
  })) ?? [];
  if (!chosen) return;

  const configuration = vscode.workspace.getConfiguration("prAnalyzer");
  const existing = configuration.get<string[]>("repositorySearchPaths", []);
  if (existing.includes(chosen.fsPath)) {
    void vscode.window.showInformationMessage(`${chosen.fsPath} is already searched.`);
    return;
  }

  await configuration.update(
    "repositorySearchPaths",
    [...existing, chosen.fsPath],
    vscode.ConfigurationTarget.Global,
  );
  void vscode.window.showInformationMessage(
    `Clones under ${chosen.fsPath} will be found from now on.`,
  );
}

/**
 * Offers to clone the repository, and does it if the reader agrees.
 *
 * Blobs are fetched on demand rather than up front, which turns a large repository
 * from a long download into a short one; git fills in the rest as files are read.
 */
export async function offerToClone(
  identity: PullRequestIdentity,
  storage: vscode.Uri,
  searched: string[],
  onProgress?: (message: string) => void,
): Promise<string | null> {
  const destination = path.join(
    storage.fsPath,
    "clones",
    `${identity.organization}-${identity.repository}`,
  );

  // A clone made for an earlier review is reused rather than made again.
  const existing = await matchesIdentity(destination, identity);
  if (existing) {
    try {
      onProgress?.("Updating the clone…");
      await git(existing, ["fetch", "--quiet", "origin"]);
    } catch {
      // An out of date clone still beats no clone.
    }
    return existing;
  }

  // Modal so the choice waits for the reader rather than vanishing as a notification.
  const choice = await vscode.window.showInformationMessage(
    `${identity.repository} is not cloned locally. Clone it to read the whole repository during ` +
      `review — a fast blobless clone kept in the extension's storage and reused next time. ` +
      `Otherwise only the pull request's changed files can be read.`,
    { modal: true, detail: `Looked in:\n${searched.join("\n")}` },
    "Clone it",
    "Locate it…",
    "Continue without",
  );

  if (choice === "Locate it…") return locateClone(identity);
  if (choice !== "Clone it") return null;

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Cloning ${identity.repository}`,
      cancellable: false,
    },
    async () => {
      try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(destination)));
        await runGit(path.dirname(destination), [
          "clone",
          "--filter=blob:none",
          "--no-checkout",
          "--quiet",
          cloneUrl(identity),
          destination,
        ]);
        return destination;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(
          `PR Analyzer: could not clone ${identity.repository}. ${
            message.includes("Authentication") || message.includes("could not read")
              ? "Git could not authenticate without a prompt. Clone it once from a terminal, then try again."
              : message
          }`,
        );
        return null;
      }
    },
  );
}
