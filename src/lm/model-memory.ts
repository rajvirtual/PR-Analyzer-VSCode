import type * as vscode from "vscode";

/**
 * The model most recently used in `@pr` chat.
 *
 * VS Code exposes the chat picker's selection only as `request.model` inside a chat
 * request, so a panel cannot read it. Remembering it here lets the diagram and the
 * ordering follow the same model the reader picked, instead of diverging from it.
 *
 * Persisted, because otherwise every reload falls back to whichever model Copilot
 * happens to list first, and the choice appears to change on its own.
 */

const KEY = "prAnalyzer.lastChatModel";

let memento: vscode.Memento | undefined;
let current: { id: string; name: string } | undefined;

export function initialiseModelMemory(storage: vscode.Memento): void {
  memento = storage;
  current = storage.get<{ id: string; name: string }>(KEY);
}

export function rememberChatModel(model: { id: string; name: string }): void {
  if (current?.id === model.id) return;
  current = { id: model.id, name: model.name };
  void memento?.update(KEY, current);
}

export function rememberedChatModel(): { id: string; name: string } | undefined {
  return current;
}
