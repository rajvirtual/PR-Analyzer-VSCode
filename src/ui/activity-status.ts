import * as vscode from "vscode";

/**
 * What the extension is doing, in the corner of the window.
 *
 * The heavy work now happens after the first paint, which is what makes the review
 * appear quickly — but it also means things keep changing under the reader with no
 * explanation. This says which of them is still running, so a list that is about to
 * re-order is not mistaken for a finished one.
 */
export class ActivityStatus {
  private readonly item: vscode.StatusBarItem;
  private readonly running = new Map<string, string>();

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "prAnalyzer.showGitLog";
  }

  /** Starts a piece of work, or relabels one already running. */
  start(id: string, label: string): void {
    this.running.set(id, label);
    this.render();
  }

  done(id: string): void {
    this.running.delete(id);
    this.render();
  }

  clear(): void {
    this.running.clear();
    this.render();
  }

  private render(): void {
    const labels = [...this.running.values()];
    if (labels.length === 0) {
      this.item.hide();
      return;
    }

    // The newest is the one the reader is waiting on; the rest are in the tooltip.
    this.item.text = `$(sync~spin) ${labels[labels.length - 1]}`;
    this.item.tooltip = new vscode.MarkdownString(
      `**AI PR Analyzer**\n\n${labels.map((label) => `- ${label}`).join("\n")}`,
    );
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
