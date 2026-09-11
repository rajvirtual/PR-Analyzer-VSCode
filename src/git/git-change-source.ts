import type { ChangeSet, ChangedFile, ChangeType, SideUnavailable } from "../model/changeset.js";
import { runGitRaw } from "./run-git.js";

/** Large enough for a source file, small enough that a stray blob cannot stall the UI. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** One side of a change: its text, a reason it is missing, or a plain absence. */
type SideRead = { text: string } | { unavailable: SideUnavailable } | { absent: true };

function sideOf(read: SideRead): { content: string | null; unavailable?: SideUnavailable } {
  if ("text" in read) return { content: read.text };
  if ("unavailable" in read) return { content: null, unavailable: read.unavailable };
  return { content: null };
}

export class GitError extends Error {}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    return await runGitRaw(cwd, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GitError(`git ${args.join(" ")} failed: ${message}`);
  }
}

export async function repositoryRoot(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
}

export async function currentBranch(cwd: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Picks the branch this work departed from, preferring what the remote considers default. */
export async function detectBaseRef(cwd: string, configured: string): Promise<string> {
  if (configured) return configured;

  try {
    const head = (await git(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])).trim();
    if (head) return head.replace("refs/remotes/", "");
  } catch {
    // A repository cloned without origin/HEAD is normal; fall through to the candidates.
  }

  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    if (await refExists(cwd, candidate)) return candidate;
  }
  throw new GitError("could not find a branch to compare against; set prAnalyzer.baseRef");
}

function parseChangeType(status: string): ChangeType {
  if (status.startsWith("A")) return "add";
  if (status.startsWith("D")) return "delete";
  if (status.startsWith("R")) return "rename";
  return "edit";
}

/** `git show` fails for a path that does not exist at that commit, which is not an error here. */
async function showAtCommit(cwd: string, commit: string, path: string): Promise<SideRead> {
  try {
    const text = await git(cwd, ["show", `${commit}:${path}`]);
    return looksBinary(text) ? { unavailable: "binary" } : { text };
  } catch {
    return { absent: true };
  }
}

async function readWorkingTree(cwd: string, path: string): Promise<SideRead> {
  const { readFile, lstat } = await import("node:fs/promises");
  const nodePath = await import("node:path");
  const full = nodePath.join(cwd, path);
  try {
    const info = await lstat(full);
    // A changed symlink is never dereferenced: its target may be anywhere on disk.
    if (info.isSymbolicLink()) return { unavailable: "unreadable" };
    if (!info.isFile()) return { absent: true };
    if (info.size > MAX_FILE_BYTES) return { unavailable: "too-large" };
    const text = await readFile(full, "utf8");
    return looksBinary(text) ? { unavailable: "binary" } : { text };
  } catch {
    return { absent: true };
  }
}

function looksBinary(content: string): boolean {
  return content.includes("\u0000");
}

/**
 * Everything this branch changed, including work that has not been committed.
 *
 * Diffing the merge base against the working tree — rather than against HEAD —
 * is what lets a change be reviewed before it is committed or pushed.
 */
export async function buildChangeSet(options: {
  cwd: string;
  baseRef?: string;
  includeUncommitted?: boolean;
}): Promise<ChangeSet> {
  const root = await repositoryRoot(options.cwd);
  const baseRef = await detectBaseRef(root, options.baseRef ?? "");
  const mergeBase = (await git(root, ["merge-base", baseRef, "HEAD"])).trim();
  const branch = await currentBranch(root);
  const includeUncommitted = options.includeUncommitted ?? true;

  // Omitting `...HEAD` compares against the working tree, so uncommitted work is included.
  const range = includeUncommitted ? [mergeBase] : [`${mergeBase}...HEAD`];
  const raw = await git(root, ["diff", "--name-status", "-M", ...range]);

  const files: ChangedFile[] = [];
  const skipped: { path: string; reason: string }[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0];
    const changeType = parseChangeType(status);
    const path = changeType === "rename" ? parts[2] : parts[1];
    const previousPath = changeType === "rename" ? parts[1] : undefined;
    if (!path) continue;

    const beforeRead: SideRead =
      changeType === "add" ? { absent: true } : await showAtCommit(root, mergeBase, previousPath ?? path);
    const afterRead: SideRead =
      changeType === "delete"
        ? { absent: true }
        : includeUncommitted
          ? await readWorkingTree(root, path)
          : await showAtCommit(root, "HEAD", path);

    const before = sideOf(beforeRead);
    const after = sideOf(afterRead);

    // A binary side cannot be diffed as text, so the file is skipped but named.
    if (before.unavailable === "binary" || after.unavailable === "binary") {
      skipped.push({ path, reason: "binary" });
      continue;
    }
    // Nothing readable on either side, and no reason worth surfacing.
    if (before.content === null && after.content === null && !before.unavailable && !after.unavailable) {
      skipped.push({ path, reason: "no readable content on either side" });
      continue;
    }

    files.push({
      path,
      changeType,
      previousPath,
      before: before.content,
      after: after.content,
      beforeUnavailable: before.unavailable,
      afterUnavailable: after.unavailable,
    });
  }

  // Files the working tree has but git is not tracking yet are the point of reviewing
  // before a commit, so they are included as additions rather than left invisible.
  if (includeUncommitted) await addUntracked(root, files, skipped);

  return {
    repositoryRoot: root,
    label: `${branch} vs ${baseRef}`,
    baseRef,
    mergeBase,
    files,
    skipped,
  };
}

/** Adds working-tree files git is not tracking yet, as additions, skipping binaries. */
async function addUntracked(
  root: string,
  files: ChangedFile[],
  skipped: { path: string; reason: string }[],
): Promise<void> {
  const listed = await git(root, ["ls-files", "--others", "--exclude-standard"]);
  for (const line of listed.split("\n")) {
    const path = line.trim();
    if (!path || files.some((file) => file.path === path)) continue;

    const side = sideOf(await readWorkingTree(root, path));
    if (side.unavailable === "binary") {
      skipped.push({ path, reason: "binary" });
      continue;
    }
    if (side.content === null && !side.unavailable) continue;

    files.push({
      path,
      changeType: "add",
      before: null,
      after: side.content,
      afterUnavailable: side.unavailable,
    });
  }
}
