import * as vscode from "vscode";
import type { ChangedFile } from "../model/changeset.js";
import { hunksOf } from "../session.js";
import { mapWithConcurrency } from "./concurrency.js";
import type { SymbolGraph } from "./flow-order.js";

/** Lookups are the slow part, so both breadth and total time are capped. */
const MAX_LOOKUPS_PER_FILE = 12;
const MAX_CONCURRENCY = 4;
const DEFAULT_BUDGET_MS = 25_000;

/** A language server that is still starting answers with nothing, not with an error. */
const PROBE_FILES = 5;
const PROBE_TIMEOUT_MS = 1_500;

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;

async function documentSymbols(uri: vscode.Uri): Promise<vscode.DocumentSymbol[]> {
  return await vscode.commands
    .executeCommand<vscode.DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", uri)
    .then(
      (result) => result ?? [],
      () => [],
    );
}

/**
 * Is a language server willing to describe these files right now?
 *
 * The probes race rather than queue: the answer is the same either way, and asking a
 * cold server five times in a row is five cold starts before the graph even begins.
 */
async function languageServerReady(
  repositoryRoot: string,
  files: ChangedFile[],
): Promise<boolean> {
  const candidates = files.filter((file) => file.after !== null).slice(0, PROBE_FILES);
  if (candidates.length === 0) return false;

  const probes = candidates.map(async (file) => {
    const uri = vscode.Uri.joinPath(vscode.Uri.file(repositoryRoot), file.path);
    const symbols = await documentSymbols(uri);
    if (symbols.length === 0) throw new Error("no symbols");
    return true;
  });

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("timed out")), PROBE_TIMEOUT_MS);
  });

  return await Promise.race([Promise.any(probes), timeout]).then(
    () => true,
    () => false,
  );
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

/** Where a name another changed file declares is used, inside this file's changed lines. */
function lookupPoints(file: ChangedFile, declaredElsewhere: Set<string>): vscode.Position[] {
  const text = file.after;
  if (!text) return [];

  const lines = text.split("\n");
  const points: vscode.Position[] = [];
  const seen = new Set<string>();

  for (const hunk of hunksOf(file)) {
    for (let line = hunk.startLine; line <= hunk.endLine; line += 1) {
      const content = lines[line - 1];
      if (content === undefined) continue;

      for (const match of content.matchAll(IDENTIFIER)) {
        const name = match[0];
        if (seen.has(name) || !declaredElsewhere.has(name)) continue;
        seen.add(name);
        points.push(new vscode.Position(line - 1, match.index ?? 0));
        if (points.length >= MAX_LOOKUPS_PER_FILE) return points;
      }
    }
  }

  return points;
}

function targetUri(target: vscode.Location | vscode.LocationLink): vscode.Uri {
  return "targetUri" in target ? target.targetUri : target.uri;
}

/**
 * Who calls whom, according to the language server rather than a regular expression.
 *
 * It asks the cheap question. "Find all references" searches the whole project for
 * every declaration and then discards everything outside the change — which is the
 * only part that was ever wanted. Going the other way, from an identifier in a changed
 * line to its definition, is a lookup the server can answer locally, and it is only
 * asked where a name some other changed file declares actually appears.
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

  // Checked by the pool between items, so a spent budget stops the run rather than
  // spinning through every file that is left.
  const spent = (): boolean =>
    Date.now() > deadline || (options.token?.isCancellationRequested ?? false);

  if (!(await languageServerReady(repositoryRoot, files))) {
    return { referencedBy, references, declares, resolved: false };
  }

  const uriOf = (file: ChangedFile): vscode.Uri =>
    vscode.Uri.joinPath(vscode.Uri.file(repositoryRoot), file.path);

  const byUri = new Map<string, string>();
  for (const file of files) byUri.set(uriOf(file).toString(), file.path);

  options.onProgress?.("Reading what each file declares…");
  const readable = files.filter((file) => file.after !== null);
  const symbolLists = await mapWithConcurrency(
    readable,
    MAX_CONCURRENCY,
    (file) => documentSymbols(uriOf(file)),
    spent,
  );

  let anyResolved = false;
  const owners = new Map<string, Set<string>>();
  for (const [index, file] of readable.entries()) {
    const symbols = symbolLists[index] ?? [];
    if (symbols.length === 0) continue;
    anyResolved = true;

    const named = flatten(symbols)
      .filter((symbol) => INTERESTING_KINDS.has(symbol.kind))
      .map((symbol) => symbol.name);

    declares.set(file.path, named.slice(0, MAX_LOOKUPS_PER_FILE));
    for (const name of named) {
      const paths = owners.get(name);
      if (paths) paths.add(file.path);
      else owners.set(name, new Set([file.path]));
    }
  }

  if (!anyResolved) {
    return { referencedBy, references, declares, resolved: false };
  }

  options.onProgress?.("Following the changed lines to what they call…");
  await mapWithConcurrency(
    readable,
    MAX_CONCURRENCY,
    async (file) => {
      const elsewhere = new Set<string>();
      for (const [name, paths] of owners) {
        if (paths.size > 1 || !paths.has(file.path)) elsewhere.add(name);
      }

      for (const position of lookupPoints(file, elsewhere)) {
        if (spent()) return;

        const targets = await vscode.commands
          .executeCommand<
            (vscode.Location | vscode.LocationLink)[]
          >("vscode.executeDefinitionProvider", uriOf(file), position)
          .then(
            (result) => result ?? [],
            () => [],
          );

        for (const target of targets) {
          const declaredIn = byUri.get(targetUri(target).toString());
          if (!declaredIn || declaredIn === file.path) continue;
          references.get(file.path)?.add(declaredIn);
          referencedBy.get(declaredIn)?.add(file.path);
        }
      }
    },
    spent,
  );

  return { referencedBy, references, declares, resolved: anyResolved };
}
