import { describe, expect, it } from "vitest";
import type { Step } from "../src/model/changeset.js";
import type { SymbolGraph } from "../src/analysis/flow-order.js";
import { buildMermaid, GROUPING_THRESHOLD, stepIdForNode } from "../src/analysis/mermaid.js";

function step(order: number, path: string, title?: string): Step {
  return {
    id: `s${order}`,
    order,
    file: { path, changeType: "edit", before: "a", after: "b" },
    role: "implementation",
    title,
  };
}

function graph(edges: Record<string, string[]> = {}): SymbolGraph {
  const references = new Map<string, Set<string>>();
  const referencedBy = new Map<string, Set<string>>();
  for (const [caller, callees] of Object.entries(edges)) {
    references.set(caller, new Set(callees));
    for (const callee of callees) {
      referencedBy.set(callee, (referencedBy.get(callee) ?? new Set()).add(caller));
    }
  }
  return { references, referencedBy, resolved: true };
}

describe("buildMermaid", () => {
  // Vertical reads like a flow and keeps labels wide enough to be legible.
  it("defaults to top-down", () => {
    expect(buildMermaid([step(1, "a.ts")], graph())).toContain("flowchart TD");
  });

  it("honours a requested direction", () => {
    expect(buildMermaid([step(1, "a.ts")], graph(), { direction: "LR" })).toContain("flowchart LR");
  });

  it("labels nodes with the model's title when there is one", () => {
    const definition = buildMermaid([step(1, "src/Task.cs", "Setup task entry")], graph());

    expect(definition).toContain("1. Setup task entry");
  });

  it("falls back to the file name when no title was given", () => {
    expect(buildMermaid([step(1, "src/Task.cs")], graph())).toContain("1. Task.cs");
  });

  it("draws an edge for each reference between changed files", () => {
    const definition = buildMermaid(
      [step(1, "Task.cs"), step(2, "Handler.cs")],
      graph({ "Task.cs": ["Handler.cs"] }),
    );

    expect(definition).toContain("n0 --> n1");
  });

  it("ignores references to files outside the change", () => {
    const definition = buildMermaid([step(1, "Task.cs")], graph({ "Task.cs": ["Elsewhere.cs"] }));

    expect(definition).not.toContain("-->");
  });

  // Without this an unreferenced file floats alone and the map looks broken.
  it("chains an unconnected file to the previous step", () => {
    const definition = buildMermaid([step(1, "a.ts"), step(2, "b.ts")], graph());

    expect(definition).toContain("n0 -.-> n1");
  });

  it("groups by folder once the graph is large", () => {
    const steps = Array.from({ length: GROUPING_THRESHOLD + 2 }, (_, index) =>
      step(index + 1, `src/area${index % 3}/File${index}.cs`),
    );

    const definition = buildMermaid(steps, graph());

    expect(definition).toContain("subgraph");
    expect(definition).toContain("src/area0");
  });

  it("stays flat for a small change", () => {
    expect(buildMermaid([step(1, "a.ts"), step(2, "b.ts")], graph())).not.toContain("subgraph");
  });

  it("escapes quotes that would break mermaid syntax", () => {
    const definition = buildMermaid([step(1, 'a.ts', 'Handles "quoted" input')], graph());

    expect(definition).not.toContain('"Handles "quoted"');
    expect(definition).toContain("'quoted'");
  });
});

describe("stepIdForNode", () => {
  const steps = [step(1, "a.ts"), step(2, "b.ts")];

  it("maps a node id back to its step", () => {
    expect(stepIdForNode(steps, "n1")).toBe("s2");
  });

  it("returns null for a node that is not a step", () => {
    expect(stepIdForNode(steps, "g0")).toBeNull();
    expect(stepIdForNode(steps, "n99")).toBeNull();
  });
});
