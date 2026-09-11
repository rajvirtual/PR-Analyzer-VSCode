import type { ChangedFile } from "../model/changeset.js";

/**
 * Which changed file a document is showing.
 *
 * The same file arrives by three routes: a real path in a checkout, a real path in
 * a worktree somewhere else entirely, and one of our virtual documents. Matching on
 * the tail of the path covers all three, anchored at a separator so that
 * Partition.cs cannot satisfy a request for DataPartition.cs.
 */
export function matchChangedFile(
  files: readonly ChangedFile[],
  documentPath: string,
): ChangedFile | undefined {
  const normalised = documentPath.replace(/\\/g, "/").replace(/^\//, "");

  return files.find(
    (file) => normalised === file.path || normalised.endsWith(`/${file.path}`),
  );
}
