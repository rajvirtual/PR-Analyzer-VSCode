import * as vscode from "vscode";

/**
 * The setting that decides whether the Explain links are visible at all.
 *
 * VS Code ships diffEditor.codeLens off, and a review is read almost entirely in a
 * diff, so the links are invisible where they are most wanted. Asked once, because
 * turning on a global editor setting is the reader's decision and not ours.
 */

const ASKED = "prAnalyzer.askedDiffCodeLens";

export async function offerDiffCodeLens(state: vscode.Memento): Promise<void> {
  if (state.get<boolean>(ASKED)) return;

  const editor = vscode.workspace.getConfiguration("editor");
  const diff = vscode.workspace.getConfiguration("diffEditor");
  if (diff.get<boolean>("codeLens", false)) return;

  // Nothing we can offer helps while lenses are off everywhere.
  const offEverywhere = !editor.get<boolean>("codeLens", true);

  const choice = await vscode.window.showInformationMessage(
    offEverywhere
      ? "Explain links sit above each change, but CodeLens is turned off in your editor."
      : "Explain links sit above each change, but VS Code hides CodeLens in diffs.",
    { detail: "PR Analyzer", modal: false },
    "Turn it on",
    "Not now",
    "Never ask",
  );

  if (choice === "Turn it on") {
    if (offEverywhere) await editor.update("codeLens", true, vscode.ConfigurationTarget.Global);
    await diff.update("codeLens", true, vscode.ConfigurationTarget.Global);
  }

  // Not now stays askable; the reader may simply not have wanted it mid-review.
  if (choice && choice !== "Not now") await state.update(ASKED, true);
}
