import * as path from "node:path";

/**
 * Where a pull request is checked out.
 *
 * Derived from the pull request alone, so reviewing the same one twice names the same
 * directory. That is deliberate — a second review reuses the checkout rather than
 * littering — but it means an old handle and a new one can point at the same place,
 * and the old one must be disposed before the new one is made.
 */
export function worktreePath(storageFsPath: string, pullRequestId: number): string {
  return path.join(storageFsPath, "worktrees", `pr-${pullRequestId}`);
}
