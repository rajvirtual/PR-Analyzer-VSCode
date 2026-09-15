import type { ChangedFile } from "../model/changeset.js";
import type { SymbolGraph } from "./flow-order.js";
import { signalsFor } from "./ordering-signals.js";

/**
 * A reference graph built from the text alone.
 *
 * A language server is more accurate, but it is not always running and can take a
 * minute to start on a large repository. Waiting for it made the tool feel broken
 * for the sake of an edge the model can mostly infer for itself, so this is the
 * baseline and the language server is an upgrade applied when it happens to be ready.
 */
export function textSymbolGraph(files: ChangedFile[]): SymbolGraph {
  const signals = signalsFor(files);
  const references = new Map<string, Set<string>>();
  const referencedBy = new Map<string, Set<string>>();
  const declares = new Map<string, string[]>();

  for (const signal of signals) {
    references.set(signal.path, new Set(signal.references));
    referencedBy.set(signal.path, new Set(signal.referencedBy));
    declares.set(signal.path, signal.declares.slice(0, 12));
  }

  return { references, referencedBy, declares, resolved: false };
}

/** True when a graph has enough edges to be worth ordering by. */
export function hasEdges(graph: SymbolGraph): boolean {
  for (const targets of graph.references.values()) {
    if (targets.size > 0) return true;
  }
  return false;
}
