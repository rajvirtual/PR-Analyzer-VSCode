/**
 * What the reviewer is reading.
 *
 * A change set is deliberately host-independent: a local branch produces one, and
 * an Azure DevOps pull request will produce the same shape, so everything
 * downstream works for both without knowing which it was given.
 */

export type ChangeType = "add" | "edit" | "delete" | "rename";

/** Why a side has no text even though the change type implies it should have some. */
export type SideUnavailable = "unreadable" | "too-large" | "binary";

export interface ChangedFile {
  /** Repository-relative, forward slashes. */
  path: string;
  changeType: ChangeType;
  /** Set when the file was renamed, so the diff can be shown against its old self. */
  previousPath?: string;
  /** Null when the file is being added. */
  before: string | null;
  /** Null when the file is being deleted. */
  after: string | null;
  /** Set when `before` is null for a reason other than the file being added. */
  beforeUnavailable?: SideUnavailable;
  /** Set when `after` is null for a reason other than the file being deleted. */
  afterUnavailable?: SideUnavailable;
}

export interface ChangeSet {
  repositoryRoot: string;
  /** Shown to the reader, for example "feature/x vs origin/main". */
  label: string;
  baseRef: string;
  mergeBase: string;
  /** The commit the change was read at, when one is pinned. */
  headCommit?: string;
  files: ChangedFile[];
  /** Files that were skipped, and why, so nothing disappears silently. */
  skipped: { path: string; reason: string }[];
}

/** How much careful review a file's change needs, as rated by the model. */
export type Effort = "routine" | "involved" | "complex";

/** One file, positioned in the order a reader should meet it. */
export interface Step {
  id: string;
  order: number;
  file: ChangedFile;
  /** Why the file sits here, derived from static signals rather than a model. */
  role: string;
  /** What happens at this point in the flow, when a model has named it. */
  title?: string;
  /** How demanding the change is to review, when a model has rated it. */
  effort?: Effort;
}

/** What to show in place of a side that could not be read. */
export function unavailableNote(reason: SideUnavailable): string {
  switch (reason) {
    case "too-large":
      return "‹file too large to display›";
    case "binary":
      return "‹binary file›";
    case "unreadable":
      return "‹file could not be read›";
  }
}
