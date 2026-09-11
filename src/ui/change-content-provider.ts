import * as vscode from "vscode";
import { unavailableNote, type ChangeSet } from "../model/changeset.js";

export const BEFORE_SCHEME = "pr-analyzer-before";
export const AFTER_SCHEME = "pr-analyzer-after";

/**
 * Serves both sides of each diff from the change set.
 *
 * The base side is always virtual so it stays pinned while the working tree moves.
 * The modified side is virtual too when reviewing a pull request, where there is
 * no checkout to read from.
 */
export class ChangeContentProvider implements vscode.TextDocumentContentProvider {
  private changeSet: ChangeSet | null = null;
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  setChangeSet(changeSet: ChangeSet | null): void {
    this.changeSet = changeSet;
    if (!changeSet) return;
    for (const file of changeSet.files) {
      this.changed.fire(uriFor(file.path, "before"));
      this.changed.fire(uriFor(file.path, "after"));
    }
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const path = uri.query || uri.path.replace(/^\//, "");
    const file = this.changeSet?.files.find((candidate) => candidate.path === path);
    if (!file) return "";
    if (uri.scheme === AFTER_SCHEME) {
      return file.after ?? (file.afterUnavailable ? unavailableNote(file.afterUnavailable) : "");
    }
    return file.before ?? (file.beforeUnavailable ? unavailableNote(file.beforeUnavailable) : "");
  }

  dispose(): void {
    this.changed.dispose();
  }
}

/** The path is carried in the query so the URI keeps a usable name and extension. */
export function uriFor(path: string, side: "before" | "after"): vscode.Uri {
  return vscode.Uri.from({
    scheme: side === "before" ? BEFORE_SCHEME : AFTER_SCHEME,
    path: `/${path}`,
    query: path,
  });
}
