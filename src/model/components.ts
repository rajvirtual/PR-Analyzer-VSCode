import * as path from "node:path";
import type { ChangeSet, Component } from "./changeset.js";

/**
 * Which repository a path in the change belongs to.
 *
 * This is the one seam a review spanning several pull requests needs. A change without
 * components is a single repository, and every answer here is exactly what the code
 * assumed before components existed: the path is already repository-relative and the
 * root is the change set's own.
 */

export interface Located {
  /** Absent for a single-repository change. */
  component?: Component;
  /** The repository the path lives in, or empty when there is no checkout. */
  root: string;
  /** The path within that repository. */
  localPath: string;
}

export function isFeature(changeSet: ChangeSet | null | undefined): boolean {
  return Boolean(changeSet?.components && changeSet.components.length > 0);
}

export function locate(changeSet: ChangeSet, changePath: string): Located {
  if (!changeSet.components?.length) {
    return { root: changeSet.repositoryRoot, localPath: changePath };
  }
  for (const component of changeSet.components) {
    const prefix = `${component.name}/`;
    if (changePath.startsWith(prefix)) {
      return { component, root: component.repositoryRoot, localPath: changePath.slice(prefix.length) };
    }
  }
  return { root: "", localPath: changePath };
}

/** The file on disk for a path in the change, when there is a checkout to hold it. */
export function diskPath(changeSet: ChangeSet, changePath: string): string | null {
  const { root, localPath } = locate(changeSet, changePath);
  return root ? path.join(root, localPath) : null;
}

/**
 * The inverse of `diskPath`: a document path turned back into the change's naming.
 *
 * Unchanged for a single repository, where matching already works on the tail of the
 * path. A component's checkout is named for its pull request rather than its
 * repository, so there the prefix has to be put back explicitly.
 */
export function toChangePath(changeSet: ChangeSet, documentPath: string): string {
  if (!changeSet.components?.length) return documentPath;
  for (const component of changeSet.components) {
    if (!component.repositoryRoot) continue;
    const relative = path.relative(component.repositoryRoot, documentPath);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return `${component.name}/${relative.split(path.sep).join("/")}`;
    }
  }
  return documentPath;
}

/** What the model's repository tools may read, per component. */
export interface ToolRoot {
  name: string;
  root: string;
}

export function toolRoots(changeSet: ChangeSet): ToolRoot[] | undefined {
  return changeSet.components?.map((component) => ({
    name: component.name,
    root: component.repositoryRoot,
  }));
}
