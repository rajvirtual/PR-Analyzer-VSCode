import type { ChangedFile } from "../model/changeset.js";

/**
 * Who calls whom within the change.
 *
 * Deliberately free of any editor dependency: the language server fills this in,
 * but the ordering that consumes it is pure and directly testable.
 */
export interface SymbolGraph {
  /** Paths in the change whose code references a symbol this file declares. */
  referencedBy: Map<string, Set<string>>;
  /** Paths in the change declaring a symbol this file references. */
  references: Map<string, Set<string>>;
  /** Top-level symbol names per file, used to describe the file to a model. */
  declares?: Map<string, string[]>;
  /** False when the language server was unavailable, so the caller can fall back. */
  resolved: boolean;
}

const TEST_PATTERN = /(^|\/)(tests?|__tests__)\//i;
const TEST_FILE_PATTERN = /\.(test|spec)\.[a-z]+$|Tests?\.[a-z]+$/i;
const DOC_PATTERN = /\.(md|mdx|rst|txt)$/i;

/**
 * Orders files as the flow reaches them: entry points first, then what they call.
 *
 * An entry point is a file nothing else in the change calls into. Ordering by that
 * — rather than by name or by dependency depth — is what makes the walk read as a
 * story rather than a file listing.
 */
export function orderFromGraph(files: ChangedFile[], graph: SymbolGraph): string[] {
  const paths = files.map((file) => file.path);
  const inbound = (path: string): number => graph.referencedBy.get(path)?.size ?? 0;
  const outbound = (path: string): number => graph.references.get(path)?.size ?? 0;

  // A lower rank is met earlier. Tests and docs are the end of the story, not the start.
  const rank = (path: string): number =>
    DOC_PATTERN.test(path) ? 2 : TEST_PATTERN.test(path) || TEST_FILE_PATTERN.test(path) ? 1 : 0;

  const roots = [...paths].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (inbound(a) !== inbound(b)) return inbound(a) - inbound(b);
    if (outbound(a) !== outbound(b)) return outbound(b) - outbound(a);
    return a.localeCompare(b);
  });

  const ordered: string[] = [];
  const seen = new Set<string>();

  const visit = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    ordered.push(path);

    const callees = [...(graph.references.get(path) ?? [])].sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      if (outbound(a) !== outbound(b)) return outbound(b) - outbound(a);
      return a.localeCompare(b);
    });

    for (const callee of callees) visit(callee);
  };

  for (const root of roots) visit(root);
  return ordered;
}
