import type * as vscode from "vscode";
import type { ChangeSet } from "../model/changeset.js";

/**
 * Where a reader had reached in a review, kept so reopening the same change resumes
 * rather than restarts.
 *
 * Keyed by the repository and the commit the change was pinned at, and recorded by
 * file path rather than step number — the reading order can change between sessions,
 * so a positional index would point at a different file. No file contents are stored.
 */
export interface Checkpoint {
  currentPath: string | null;
  visited: string[];
}

const PREFIX = "prAnalyzer.checkpoint.";

/** A stable key for a review: the repository and the commit it was read at. */
export function checkpointKey(changeSet: ChangeSet): string {
  const commit = changeSet.headCommit ?? changeSet.mergeBase;
  return `${PREFIX}${changeSet.repositoryRoot}@${commit}`;
}

let store: vscode.Memento | undefined;

export function initialiseCheckpoints(memento: vscode.Memento): void {
  store = memento;
}

export function saveCheckpoint(changeSet: ChangeSet, checkpoint: Checkpoint): void {
  void store?.update(checkpointKey(changeSet), checkpoint);
}

export function loadCheckpoint(changeSet: ChangeSet): Checkpoint | undefined {
  return store?.get<Checkpoint>(checkpointKey(changeSet));
}
