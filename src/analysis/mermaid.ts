import type { Step } from "../model/changeset.js";
import type { SymbolGraph } from "./flow-order.js";

/** Above this many nodes a flat graph stops being readable, so files are grouped. */
export const GROUPING_THRESHOLD = 25;

export type Direction = "LR" | "TD";

function nodeId(index: number): string {
  return `n${index}`;
}

/** Mermaid treats several characters as syntax, so labels are quoted and stripped. */
function label(text: string): string {
  return text.replace(/["`]/g, "'").replace(/[\r\n]+/g, " ").slice(0, 60);
}

function directoryOf(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.slice(-2).join("/") || ".";
}

/**
 * A map of the change: each file as a node, each reference as an edge.
 *
 * Grouping by directory once the graph is large is what keeps a 50-file change
 * legible; without it the diagram is one unreadable chain.
 */
export function buildMermaid(
  steps: Step[],
  graph: SymbolGraph,
  options: { direction?: Direction; group?: boolean } = {},
): string {
  const direction = options.direction ?? "TD";
  const group = options.group ?? steps.length > GROUPING_THRESHOLD;

  const indexByPath = new Map(steps.map((step, index) => [step.file.path, index]));
  const lines: string[] = [`flowchart ${direction}`];

  const declare = (step: Step, index: number): string => {
    const name = step.file.path.split("/").pop() ?? step.file.path;
    const text = step.title ? `${index + 1}. ${step.title}` : `${index + 1}. ${name}`;
    return `  ${nodeId(index)}["${label(text)}"]`;
  };

  if (group) {
    const byDirectory = new Map<string, { step: Step; index: number }[]>();
    steps.forEach((step, index) => {
      const directory = directoryOf(step.file.path);
      const bucket = byDirectory.get(directory) ?? [];
      bucket.push({ step, index });
      byDirectory.set(directory, bucket);
    });

    let subgraph = 0;
    for (const [directory, members] of byDirectory) {
      lines.push(`  subgraph g${subgraph}["${label(directory)}"]`);
      for (const member of members) lines.push(`  ${declare(member.step, member.index)}`);
      lines.push("  end");
      subgraph += 1;
    }
  } else {
    steps.forEach((step, index) => lines.push(declare(step, index)));
  }

  // Reference edges show how the files actually connect, not merely their order.
  const seen = new Set<string>();
  for (const [from, targets] of graph.references) {
    const fromIndex = indexByPath.get(from);
    if (fromIndex === undefined) continue;
    for (const to of targets) {
      const toIndex = indexByPath.get(to);
      if (toIndex === undefined || toIndex === fromIndex) continue;
      const key = `${fromIndex}->${toIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(`  ${nodeId(fromIndex)} --> ${nodeId(toIndex)}`);
    }
  }

  // A file nothing references would otherwise float unconnected; chain it to the walk.
  steps.forEach((_step, index) => {
    if (index === 0) return;
    const hasEdge = [...seen].some((key) => key.endsWith(`->${index}`));
    if (!hasEdge) lines.push(`  ${nodeId(index - 1)} -.-> ${nodeId(index)}`);
  });

  return lines.join("\n");
}

/** Maps a mermaid node id back to the step it stands for. */
export function stepIdForNode(steps: Step[], node: string): string | null {
  const match = /^n(\d+)$/.exec(node);
  if (!match) return null;
  return steps[Number(match[1])]?.id ?? null;
}
