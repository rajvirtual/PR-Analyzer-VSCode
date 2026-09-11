import { describe, expect, it } from "vitest";
import type { ChangedFile } from "../src/model/changeset.js";
import { orderFromGraph, type SymbolGraph } from "../src/analysis/flow-order.js";

function file(path: string): ChangedFile {
  return { path, changeType: "edit", before: "old", after: "new" };
}

/** `edges` reads as "caller -> callees", the direction the flow travels. */
function graph(edges: Record<string, string[]>): SymbolGraph {
  const references = new Map<string, Set<string>>();
  const referencedBy = new Map<string, Set<string>>();

  const paths = new Set([...Object.keys(edges), ...Object.values(edges).flat()]);
  for (const path of paths) {
    references.set(path, new Set());
    referencedBy.set(path, new Set());
  }

  for (const [caller, callees] of Object.entries(edges)) {
    for (const callee of callees) {
      references.get(caller)?.add(callee);
      referencedBy.get(callee)?.add(caller);
    }
  }

  return { references, referencedBy, resolved: true };
}

describe("orderFromGraph", () => {
  it("starts at the file nothing else in the change calls", () => {
    const files = ["Task.cs", "Handler.cs", "Ladder.cs"].map(file);
    const order = orderFromGraph(
      files,
      graph({ "Task.cs": ["Handler.cs"], "Handler.cs": ["Ladder.cs"] }),
    );

    expect(order[0]).toBe("Task.cs");
  });

  it("follows the flow outward from the entry point", () => {
    const files = ["Task.cs", "Handler.cs", "Ladder.cs"].map(file);
    const order = orderFromGraph(
      files,
      graph({ "Task.cs": ["Handler.cs"], "Handler.cs": ["Ladder.cs"] }),
    );

    expect(order).toEqual(["Task.cs", "Handler.cs", "Ladder.cs"]);
  });

  // The complaint about the old ordering: a leaf that everything depends on came first.
  it("does not lead with a widely referenced leaf", () => {
    const files = ["Contract.cs", "Task.cs", "Handler.cs"].map(file);
    const order = orderFromGraph(
      files,
      graph({ "Task.cs": ["Handler.cs", "Contract.cs"], "Handler.cs": ["Contract.cs"] }),
    );

    expect(order[0]).toBe("Task.cs");
    expect(order.indexOf("Contract.cs")).toBeGreaterThan(order.indexOf("Handler.cs"));
  });

  it("visits every file exactly once, including unconnected ones", () => {
    const files = ["Task.cs", "Handler.cs", "Orphan.cs"].map(file);
    const order = orderFromGraph(files, graph({ "Task.cs": ["Handler.cs"] }));

    expect(order).toHaveLength(3);
    expect(new Set(order).size).toBe(3);
    expect(order).toContain("Orphan.cs");
  });

  it("puts tests and documentation after the code they describe", () => {
    const files = ["README.md", "Thing.Tests.cs", "Thing.cs"].map(file);
    const order = orderFromGraph(files, graph({ "Thing.Tests.cs": ["Thing.cs"] }));

    expect(order[0]).toBe("Thing.cs");
    expect(order.indexOf("Thing.Tests.cs")).toBeGreaterThan(order.indexOf("Thing.cs"));
    expect(order.at(-1)).toBe("README.md");
  });

  it("handles a reference cycle without looping forever", () => {
    const files = ["A.cs", "B.cs"].map(file);
    const order = orderFromGraph(files, graph({ "A.cs": ["B.cs"], "B.cs": ["A.cs"] }));

    expect(order).toHaveLength(2);
  });

  it("is stable for two runs over the same input", () => {
    const files = ["A.cs", "B.cs", "C.cs"].map(file);
    const edges = { "A.cs": ["B.cs"], "C.cs": ["B.cs"] };

    expect(orderFromGraph(files, graph(edges))).toEqual(orderFromGraph(files, graph(edges)));
  });
});
