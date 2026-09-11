import * as vscode from "vscode";
import type { ChangedFile } from "../model/changeset.js";
import { runGitRaw } from "../git/run-git.js";
import { containedPath, isUnder, realpathWithin } from "./safe-path.js";

/**
 * Where the tools read from.
 *
 * A pull request in a repository that is not cloned has no root; the tools then
 * serve what the change itself contains rather than pretending to search a repo.
 */
export interface ToolContext {
  repositoryRoot: string;
  files: ChangedFile[];
}

/** Enough for a class, short enough that one call cannot swallow the context window. */
const MAX_RESULT_CHARS = 12_000;
const MAX_SYMBOL_MATCHES = 5;
const SYMBOL_CONTEXT_LINES = 40;
const MAX_SEARCH_MATCHES = 40;

export interface ToolRun {
  /** Shown in the chat while the model works, so the reader sees what it consulted. */
  label: string;
  text: string;
  /** Repository files this call actually read, for the answer's provenance. */
  consulted?: string[];
}

export const REPO_TOOLS: vscode.LanguageModelChatTool[] = [
  {
    name: "find_symbol",
    description:
      "Find where a type, method, function, or constant is declared anywhere in the repository, " +
      "including files this change does not touch. Use this whenever the diff refers to a name " +
      "you cannot see the definition of. Backed by the language server, so it is exact.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The symbol name, for example CreateDeveloperEnvelopeVerifier",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "read_file",
    description:
      "Read a file from the repository at its current state. Use it to see a caller, a base " +
      "class, or a configuration file that the change depends on.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository-relative path" },
        startLine: { type: "number", description: "Optional 1-based first line" },
        endLine: { type: "number", description: "Optional 1-based last line" },
      },
      required: ["path"],
    },
  },
  {
    name: "search_text",
    description:
      "Search the repository for a literal string, for example every caller of a method or every " +
      "place a setting is read. Returns matching lines with their file and line number.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Literal text to find" },
        glob: {
          type: "string",
          description: "Optional path filter, for example *.cs",
        },
      },
      required: ["query"],
    },
  },
];

function clamp(text: string): string {
  return text.length <= MAX_RESULT_CHARS
    ? text
    : `${text.slice(0, MAX_RESULT_CHARS)}\n… truncated`;
}

async function readLines(context: ToolContext, requested: string): Promise<string[] | null> {
  const fromChange = context.files.find((file) => file.path === requested);
  if (fromChange?.after) return fromChange.after.split("\n");
  if (!context.repositoryRoot) return fromChange?.before?.split("\n") ?? null;

  // A model-supplied path is refused before any read if it leaves the repository,
  // whether by climbing out lexically or by resolving through a symlink.
  const full = containedPath(context.repositoryRoot, requested);
  if (!full) return null;
  const real = await realpathWithin(context.repositoryRoot, full);
  if (!real) return null;

  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(real));
    return Buffer.from(bytes).toString("utf8").split("\n");
  } catch {
    return null;
  }
}

function numbered(lines: string[], firstLine: number): string {
  return lines.map((line, index) => `${firstLine + index} | ${line}`).join("\n");
}

async function findSymbol(context: ToolContext, name: string): Promise<ToolRun> {
  if (!context.repositoryRoot) {
    return {
      label: `cannot look up ${name} without a checkout`,
      text: `Finding "${name}" needs the repository checked out. Only the changed files are available here.`,
    };
  }

  const symbols =
    (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      "vscode.executeWorkspaceSymbolProvider",
      name,
    )) ?? [];

  // A symbol from another open folder is out of bounds: keep only this repository's.
  const inRepo = symbols.filter((symbol) =>
    isUnder(context.repositoryRoot, symbol.location.uri.fsPath),
  );
  const exact = inRepo.filter((symbol) => symbol.name === name);
  const matches = (exact.length > 0 ? exact : inRepo).slice(0, MAX_SYMBOL_MATCHES);

  if (matches.length === 0) {
    return {
      label: `no declaration found for ${name}`,
      text: `No declaration of "${name}" was found. It may come from a package rather than this repository, or the language server may still be starting.`,
    };
  }

  const sections: string[] = [];
  const consulted: string[] = [];
  for (const match of matches) {
    const relative = vscode.workspace.asRelativePath(match.location.uri, false);
    const document = await vscode.workspace.openTextDocument(match.location.uri).then(
      (open) => open,
      () => null,
    );
    if (!document) continue;

    const start = match.location.range.start.line;
    const end = Math.min(document.lineCount - 1, start + SYMBOL_CONTEXT_LINES);
    const body = document.getText(
      new vscode.Range(start, 0, end, document.lineAt(end).text.length),
    );

    consulted.push(relative);
    sections.push(
      `${relative}:${start + 1}  (${vscode.SymbolKind[match.kind]})\n${numbered(body.split("\n"), start + 1)}`,
    );
  }

  return {
    label: `found ${name} in ${matches.length} place${matches.length === 1 ? "" : "s"}`,
    text: clamp(sections.join("\n\n---\n\n")),
    consulted,
  };
}

async function readFileTool(
  context: ToolContext,
  input: { path: string; startLine?: number; endLine?: number },
): Promise<ToolRun> {
  const lines = await readLines(context, input.path);
  if (!lines) {
    return { label: `could not read ${input.path}`, text: `${input.path} could not be read.` };
  }

  const start = Math.max(1, Math.floor(input.startLine ?? 1));
  const end = Math.min(lines.length, Math.floor(input.endLine ?? lines.length));
  const body = numbered(lines.slice(start - 1, end), start);

  return {
    label: `read ${input.path}${input.startLine ? `:${start}-${end}` : ""}`,
    text: clamp(`${input.path}\n${body}`),
    consulted: [input.path],
  };
}

async function searchText(
  context: ToolContext,
  input: { query: string; glob?: string },
): Promise<ToolRun> {
  if (!context.repositoryRoot) {
    // No checkout: search what the change contains rather than claim a repo-wide answer.
    const matches: string[] = [];
    const consulted: string[] = [];
    for (const file of context.files) {
      const lines = (file.after ?? file.before ?? "").split("\n");
      lines.forEach((line, index) => {
        if (matches.length < MAX_SEARCH_MATCHES && line.includes(input.query)) {
          matches.push(`${file.path}:${index + 1}:${line.trim()}`);
          if (!consulted.includes(file.path)) consulted.push(file.path);
        }
      });
    }
    return {
      label: `searched the change for "${input.query}" (${matches.length} match${matches.length === 1 ? "" : "es"})`,
      text: clamp(
        matches.length > 0
          ? `Only the changed files were searched; the repository is not checked out.\n${matches.join("\n")}`
          : `No match for "${input.query}" in the changed files. The rest of the repository is not available.`,
      ),
      consulted,
    };
  }

  const args = ["grep", "--no-color", "-n", "-F", "--max-count", "3", input.query];
  if (input.glob) args.push("--", input.glob);

  try {
    const stdout = await runGitRaw(context.repositoryRoot, args);
    const lines = stdout.split("\n").filter(Boolean).slice(0, MAX_SEARCH_MATCHES);
    const consulted = [...new Set(lines.map((line) => line.split(":")[0]).filter(Boolean))];
    return {
      label: `searched for "${input.query}" (${lines.length} match${lines.length === 1 ? "" : "es"})`,
      text: clamp(lines.join("\n") || `No match for "${input.query}".`),
      consulted,
    };
  } catch {
    // git grep exits non-zero when nothing matches, which is an answer, not a failure.
    return {
      label: `searched for "${input.query}" (no matches)`,
      text: `No match for "${input.query}".`,
    };
  }
}

export async function invokeRepoTool(
  context: ToolContext,
  name: string,
  input: unknown,
): Promise<ToolRun> {
  const args = (input ?? {}) as Record<string, never>;

  // An untrusted workspace withholds the filesystem and the symbol index; the tools
  // fall back to the changed files alone, which are only ever data.
  const scoped = vscode.workspace.isTrusted ? context : { ...context, repositoryRoot: "" };

  switch (name) {
    case "find_symbol":
      return findSymbol(scoped, String(args.name ?? ""));
    case "read_file":
      return readFileTool(scoped, args as never);
    case "search_text":
      return searchText(scoped, args as never);
    default:
      return { label: `unknown tool ${name}`, text: `There is no tool called ${name}.` };
  }
}
