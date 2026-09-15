import * as path from "node:path";
import * as vscode from "vscode";
import type { PullRequestIdentity } from "../ado/pr-url.js";
import { runGit } from "./run-git.js";
import { worktreePath } from "./worktree-path.js";

/**
 * A checkout of the pull request, taken from a clone the reader already has.
 *
 * Without one, a pull request is only the files it changed: the model cannot read a
 * caller, grep for a usage, or see anything the change did not touch. A worktree
 * costs a fetch and some disk, and is removed when the review moves on.
 */

const git = runGit;

export interface Worktree {
  path: string;
  dispose(): Promise<void>;
}

/**
 * Checks the pull request out beside the reader's clone, sharing its object store.
 *
 * Returns null rather than throwing: a missing checkout weakens the review, it does
 * not stop it.
 */
export async function createPullRequestWorktree(input: {
  clone: string;
  identity: PullRequestIdentity;
  commit: string;
  storage: vscode.Uri;
  onProgress?: (message: string) => void;
}): Promise<Worktree | null> {
  const { clone, identity, commit, storage, onProgress } = input;
  const target = worktreePath(storage.fsPath, identity.pullRequestId);

  try {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target)));

    // The commit is usually absent from a clone that has not fetched this pull request.
    let available = true;
    try {
      await git(clone, ["cat-file", "-e", `${commit}^{commit}`]);
    } catch {
      available = false;
    }

    if (!available) {
      onProgress?.(`Fetching pull request ${identity.pullRequestId}…`);
      try {
        await git(clone, [
          "fetch",
          "--quiet",
          "origin",
          `refs/pull/${identity.pullRequestId}/merge`,
        ]);
      } catch {
        await git(clone, ["fetch", "--quiet", "origin", commit]);
      }
    }

    // A previous review of the same pull request may have left one behind.
    await removeWorktree(clone, target);

    onProgress?.("Checking the pull request out…");
    await git(clone, ["worktree", "add", "--detach", "--quiet", target, commit]);

    // Proves the tree is really on disk: pointing the review at a directory that is
    // not there turns every file into "could not be opened", with nothing to explain it.
    const head = await git(target, ["rev-parse", "HEAD"]);
    if (!head.startsWith(commit.slice(0, 7))) return null;

    return {
      path: target,
      dispose: async () => {
        await removeWorktree(clone, target);
      },
    };
  } catch {
    return null;
  }
}

/** Asking first keeps a routine "nothing to remove" out of the log as a failure. */
async function isWorktree(clone: string, target: string): Promise<boolean> {
  try {
    const listed = await git(clone, ["worktree", "list", "--porcelain"]);
    return listed
      .split("\n")
      .some((line) => line.startsWith("worktree ") && line.slice("worktree ".length).trim() === target);
  } catch {
    return false;
  }
}

async function removeWorktree(clone: string, target: string): Promise<void> {
  if (await isWorktree(clone, target)) {
    try {
      await git(clone, ["worktree", "remove", "--force", target]);
    } catch {
      // Nothing there, which is the state we wanted anyway.
    }
  }
  try {
    await git(clone, ["worktree", "prune"]);
  } catch {
    // Pruning is tidiness, not correctness.
  }
}
