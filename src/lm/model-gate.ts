import * as vscode from "vscode";

// The model serves one heavy view at a time. A second request racing the first is what
// surfaces "the model is not able to…", so starting one stops the one still running.
let active: vscode.CancellationTokenSource | null = null;

/** Cancels any running heavy model op and makes this source the current one. */
export function registerExclusiveModelWork(source: vscode.CancellationTokenSource): void {
  if (active && active !== source) active.cancel();
  active = source;
}

/** A fresh cancellation source already registered as the current op. */
export function beginExclusiveModelWork(): vscode.CancellationTokenSource {
  const source = new vscode.CancellationTokenSource();
  registerExclusiveModelWork(source);
  return source;
}

/** Releases the slot if this op still holds it. The caller owns disposal. */
export function clearExclusiveModelWork(source: vscode.CancellationTokenSource): void {
  if (active === source) active = null;
}
