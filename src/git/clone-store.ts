import * as path from "node:path";
import * as vscode from "vscode";

/**
 * Housekeeping for the cached clones the pull request review keeps in the extension's
 * storage. Clones are reused across reviews and so accumulate; a usage marker lets old
 * ones be pruned, and a clear command reclaims all of it at once.
 */

const USAGE_MARKER = ".pr-analyzer-lastused";

export function clonesRoot(storage: vscode.Uri): string {
  return path.join(storage.fsPath, "clones");
}

export function worktreesRoot(storage: vscode.Uri): string {
  return path.join(storage.fsPath, "worktrees");
}

/** Records that a clone was just used, so the prune leaves recent ones alone. */
export async function touchUsage(cloneDir: string): Promise<void> {
  try {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(cloneDir, USAGE_MARKER), new Date().toISOString(), "utf8");
  } catch {
    // A missing timestamp only means the clone looks older than it is; not worth failing over.
  }
}

/** Removes cached clones not used within the last `maxAgeDays`. */
export async function pruneOldClones(storage: vscode.Uri, maxAgeDays: number): Promise<void> {
  const { readdir, stat, rm } = await import("node:fs/promises");
  const root = clonesRoot(storage);

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return; // Nothing cached yet.
  }

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  for (const name of entries) {
    const dir = path.join(root, name);
    try {
      let usedAt: number;
      try {
        usedAt = (await stat(path.join(dir, USAGE_MARKER))).mtimeMs;
      } catch {
        usedAt = (await stat(dir)).mtimeMs; // A clone from before markers existed.
      }
      if (usedAt < cutoff) await rm(dir, { recursive: true, force: true });
    } catch {
      // One unremovable clone should not stop the rest being pruned.
    }
  }
}

/** Deletes every cached clone and worktree; returns how many clones were removed. */
export async function clearAllClones(storage: vscode.Uri): Promise<number> {
  const { readdir, rm } = await import("node:fs/promises");

  let count = 0;
  try {
    count = (await readdir(clonesRoot(storage))).length;
  } catch {
    // No clones directory means nothing to count.
  }

  await rm(clonesRoot(storage), { recursive: true, force: true }).catch(() => undefined);
  await rm(worktreesRoot(storage), { recursive: true, force: true }).catch(() => undefined);
  return count;
}
