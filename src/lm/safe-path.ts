import * as path from "node:path";

/**
 * Keeps a model's file access inside the repository it is reviewing.
 *
 * The paths handed to read_file and the results of a symbol search are influenced by
 * the change under review, which can be hostile. These checks are the boundary: a path
 * that climbs out, names an absolute location, or resolves through a symlink to somewhere
 * else is refused before anything is read.
 */

/** A repository-relative path, normalised, or null when it does not stay inside. */
export function containedRelativePath(relative: string): string | null {
  if (!relative || relative.includes("\0")) return null;

  const forward = relative.replace(/\\/g, "/");
  if (forward.startsWith("/")) return null;
  // A drive-qualified path is absolute on Windows however this platform reads it.
  if (/^[a-zA-Z]:/.test(forward)) return null;

  const normalised = path.posix.normalize(forward);
  if (normalised === "." || normalised === "..") return null;
  if (normalised.startsWith("../")) return null;

  return normalised;
}

/** True when candidate is root itself or lexically beneath it. */
export function isUnder(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The absolute path a relative one names inside root, or null when it escapes. */
export function containedPath(root: string, relative: string): string | null {
  const safe = containedRelativePath(relative);
  if (safe === null) return null;

  const full = path.resolve(root, safe);
  return isUnder(root, full) ? full : null;
}

/**
 * The real path of an existing file, only if it truly lives inside root.
 *
 * Catches the symlink that a lexical check cannot: a path that stays inside on paper but
 * points, once resolved, at a file elsewhere on disk. Null when it escapes or is absent.
 */
export async function realpathWithin(root: string, full: string): Promise<string | null> {
  const { realpath } = await import("node:fs/promises");
  try {
    const realRoot = await realpath(root);
    const realFull = await realpath(full);
    return isUnder(realRoot, realFull) ? realFull : null;
  } catch {
    return null;
  }
}
