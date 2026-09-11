import * as vscode from "vscode";
import type { ChangedFile } from "../model/changeset.js";
import type { SymbolGraph } from "./flow-order.js";

/** Reference lookups are the slow part, so both breadth and total time are capped. */
const MAX_SYMBOLS_PER_FILE = 12;
const MAX_CONCURRENCY = 4;
const DEFAULT_BUDGET_MS = 25_000;

/** A language server that is still starting answers with nothing, not with an error. */
const PROBE_FILES = 5;

/**
 * Is a language server willing to describe these files right now?
 *
 * Deliberately a single quick probe rather than a wait. When the answer is no the
 * caller falls back to text signals immediately, which is far better than making
 * the reader watch a spinner for something that only sharpens the ordering.
 */
async function languageServerReady(
  repositoryRoot: string,
  files: ChangedFile[],
): Promise<boolean> {
  const candidates = files.filter((file) => file.after !== null).slice(0, PROBE_FILES);

  for (const file of candidates) {
    const uri = vscode.Uri.joinPath(vscode.Uri.file(repositoryRoot), file.path);
    const symbols = await vscode.commands
      .executeCommand<vscode.DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", uri)
      .then(
        (result) => result ?? [],
        () => [],
      );
    if (symbols.length > 0) return true;
  }

  return false;
}

const INTERESTING_KINDS = new Set([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Constructor,
  vscode.SymbolKind.Property,
  vscode.SymbolKind.Field,
]);

function flatten(symbols: vscode.DocumentSymbol[], depth = 0): vscode.DocumentSymbol[] {
  if (depth > 1) return [];
  return symbols.flatMap((symbol) => [symbol, ...flatten(symbol.children ?? [], depth + 1)]);
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function pump(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, pump));
  return results;
}

/**
 * Who calls whom, according to the language server rather than a regular expression.
 *
 * This is the ordering signal a text-only tool cannot have: real references, so a
 * file that nothing in the change calls is genuinely an entry point rather than
 * one that merely looks like it.
 */
export async function buildSymbolGraph(
  repositoryRoot: string,
  files: ChangedFile[],
  options: {
    budgetMs?: number;
    token?: vscode.CancellationToken;
    onProgress?: (message: string) => void;
  } = {},
): Promise<SymbolGraph> {
  const deadline = Date.now() + (options.budgetMs ?? DEFAULT_BUDGET_MS);
  const referencedBy = new Map<string, Set<string>>();
  const references = new Map<string, Set<string>>();
  const declares = new Map<string, string[]>();
  for (const file of files) {
    referencedBy.set(file.path, new Set());
    references.set(file.path, new Set());
    declares.set(file.path, []);
  }

  // Without a checkout there is nothing on disk for a language server to read.
  if (!repositoryRoot) {
    return { referencedBy, references, declares, resolved: false };
  }

  const ready = await languageServerReady(repositoryRoot, files);
  if (!ready) {
    return { referencedBy, references, declares, resolved: false };
  }

  const byUri = new Map<string, string>();
  for (const file of files) {
    byUri.set(
      vscode.Uri.joinPath(vscode.Uri.file(repositoryRoot), file.path).toString(),
      file.path,
    );
  }

  let anyResolved = false;

  await mapLimit(files, MAX_CONCURRENCY, async (file) => {
    if (Date.now() > deadline || options.token?.isCancellationRequested) return;
    if (file.after === null) return;

    const uri = vscode.Uri.joinPath(vscode.Uri.file(repositoryRoot), file.path);

    const symbols = await vscode.commands
      .executeCommand<vscode.DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", uri)
      .then(
        (result) => result ?? [],
        () => [],
      );
    if (symbols.length === 0) return;
    anyResolved = true;

    const declared = flatten(symbols)
      .filter((symbol) => INTERESTING_KINDS.has(symbol.kind))
      .slice(0, MAX_SYMBOLS_PER_FILE);

    declares.set(
      file.path,
      declared.map((symbol) => symbol.name),
    );

    for (const symbol of declared) {
      if (Date.now() > deadline || options.token?.isCancellationRequested) return;

      const locations = await vscode.commands
        .executeCommand<vscode.Location[]>(
          "vscode.executeReferenceProvider",
          uri,
          symbol.selectionRange.start,
        )
        .then(
          (result) => result ?? [],
          () => [],
        );

      for (const location of locations) {
        const caller = byUri.get(location.uri.toString());
        if (!caller || caller === file.path) continue;
        referencedBy.get(file.path)?.add(caller);
        references.get(caller)?.add(file.path);
      }
    }
  });

  return { referencedBy, references, declares, resolved: anyResolved };
}
