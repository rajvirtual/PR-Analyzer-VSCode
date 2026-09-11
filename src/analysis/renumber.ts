/**
 * Numbering that agrees with the arrows.
 *
 * The model is asked to number its nodes so that a --> b means a is lower than b,
 * and it does not reliably comply: a step numbered 12 turns up between 7 and 8, or
 * the flow starts at the bottom because the arrows run the opposite way to the
 * numbers. A diagram is laid out by its arrows, so the arrows are the truth and the
 * numbers are renumbered to match them.
 */

const KEYWORDS = new Set([
  "flowchart",
  "graph",
  "subgraph",
  "end",
  "direction",
  "classDef",
  "class",
  "style",
  "linkStyle",
  "click",
  "TD",
  "TB",
  "LR",
  "RL",
  "BT",
]);

/** A node id followed by an optional shape, then a link, then another id. */
const EDGE = new RegExp(
  [
    "([A-Za-z][\\w]*)",
    "(?:\\[\\[?[^\\]]*\\]\\]?|\\(\\(?[^)]*\\)\\)?|\\{\\{?[^}]*\\}\\}?|>[^\\]]*\\])?",
    "\\s*(?:-{2,3}>|-{3}|-\\.-+>|-\\.-|={2,3}>|~{3})",
    "\\s*(?:\\|[^|]*\\|)?\\s*",
    "([A-Za-z][\\w]*)",
  ].join(""),
  "g",
);

/** A declaration carrying a quoted label, which is where the number lives. */
const LABELLED = /([A-Za-z][\w]*)\s*(\[\[?|\(\(?|\{\{?|>)\s*"([^"]*)"/g;

export interface Renumbering {
  mermaid: string;
  /** How many labels had the wrong number, which is worth knowing when it is many. */
  corrected: number;
}

export function renumberByFlow(mermaid: string): Renumbering {
  const labels = readLabels(mermaid);
  if (labels.size === 0) return { mermaid, corrected: 0 };

  const edges = readEdges(mermaid, new Set(labels.keys()));
  const order = topological([...labels.keys()], edges, labels);

  const numbers = new Map<string, number>();
  order.forEach((id, index) => numbers.set(id, index + 1));

  let corrected = 0;
  const rewritten = mermaid
    .split("\n")
    .map((line) => {
      if (isSubgraph(line)) return line;
      return line.replace(LABELLED, (whole, id: string, open: string, text: string) => {
        const next = numbers.get(id);
        if (next === undefined) return whole;

        const stripped = text.replace(/^\s*\d+\.\s*/, "");
        if (text !== `${next}. ${stripped}`) corrected += 1;
        return `${id}${open}"${next}. ${stripped}"`;
      });
    })
    .join("\n");

  return { mermaid: rewritten, corrected };
}

/** A subgraph title looks exactly like a labelled node, and must not be numbered. */
function isSubgraph(line: string): boolean {
  return /^\s*subgraph\b/.test(line);
}

function readLabels(mermaid: string): Map<string, number | null> {
  const labels = new Map<string, number | null>();
  for (const line of mermaid.split("\n")) {
    if (isSubgraph(line)) continue;
    for (const match of line.matchAll(LABELLED)) {
      const id = match[1]!;
      if (KEYWORDS.has(id)) continue;
      const stated = /^\s*(\d+)\./.exec(match[3]!);
      labels.set(id, stated ? Number(stated[1]) : null);
    }
  }
  return labels;
}

function readEdges(mermaid: string, known: Set<string>): [string, string][] {
  const edges: [string, string][] = [];
  for (const line of mermaid.split("\n")) {
    if (isSubgraph(line)) continue;

    for (const match of line.matchAll(EDGE)) {
      const [, from, to] = match;
      if (!from || !to || !known.has(from) || !known.has(to) || from === to) continue;
      edges.push([from, to]);
    }
  }
  return edges;
}

/**
 * Reading order: a node comes after everything that reaches it.
 *
 * Where the flow loops, some edge has to be ignored or nothing can be first; the
 * node the model already numbered lowest wins, which keeps its intent where the
 * arrows leave a genuine choice.
 */
function topological(
  ids: string[],
  edges: [string, string][],
  stated: Map<string, number | null>,
): string[] {
  const outgoing = new Map<string, string[]>(ids.map((id) => [id, []]));
  const remaining = new Map<string, number>(ids.map((id) => [id, 0]));

  for (const [from, to] of edges) {
    outgoing.get(from)!.push(to);
    remaining.set(to, remaining.get(to)! + 1);
  }

  const rank = (id: string): number => stated.get(id) ?? Number.MAX_SAFE_INTEGER;
  const order: string[] = [];
  const placed = new Set<string>();

  while (order.length < ids.length) {
    const ready = ids.filter((id) => !placed.has(id) && remaining.get(id) === 0);

    // Every remaining node sits on a cycle: break it at the one the model called first.
    const next = (ready.length > 0 ? ready : ids.filter((id) => !placed.has(id))).sort(
      (a, b) => rank(a) - rank(b) || ids.indexOf(a) - ids.indexOf(b),
    )[0]!;

    order.push(next);
    placed.add(next);
    for (const target of outgoing.get(next) ?? []) {
      if (!placed.has(target)) remaining.set(target, Math.max(0, remaining.get(target)! - 1));
    }
  }

  return order;
}
