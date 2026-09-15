/**
 * Who calls whom within the change.
 *
 * Deliberately free of any editor dependency: a language server fills this in when one
 * is running and the text graph when it is not, so everything that consumes it stays
 * pure and directly testable.
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
