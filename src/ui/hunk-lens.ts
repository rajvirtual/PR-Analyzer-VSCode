import * as vscode from "vscode";
import { hunksOf } from "../session.js";
import type { ReviewSession } from "../session.js";
import { matchChangedFile } from "../analysis/match-file.js";

/**
 * An "explain this" above every changed region.
 *
 * A lens rather than an overlay: the editor positions it, so it cannot flicker or
 * fight the mouse the way a hand-drawn chip did. It costs nothing until pressed,
 * which is the point — a model call per region, on a change of any size, would be
 * minutes of waiting for paragraphs nobody asked to read.
 */
export class HunkLensProvider implements vscode.CodeLensProvider {
  private session: ReviewSession | null = null;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  setSession(session: ReviewSession | null): void {
    this.session = session;
    this.changed.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const file = this.fileFor(document);
    if (!file?.after) return [];

    const hunks = hunksOf(file);
    return hunks.map((hunk, index) => {
      // A hunk's line numbers are one-based on the modified side.
      const line = Math.max(0, hunk.startLine - 1);
      const range = new vscode.Range(line, 0, line, 0);
      return new vscode.CodeLens(range, {
        title: hunks.length > 1 ? `$(sparkle) Explain change ${index + 1}` : "$(sparkle) Explain this",
        command: "prAnalyzer.explainHunk",
        arguments: [document.uri, hunk],
      });
    });
  }

  /** The changed file this document shows, whether it is the real one or ours. */
  private fileFor(document: vscode.TextDocument) {
    const files = this.session?.changeSet.files;
    if (!files) return undefined;
    return matchChangedFile(
      files,
      document.uri.scheme === "file" ? document.uri.fsPath : document.uri.path,
    );
  }
}
