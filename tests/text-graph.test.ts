import { describe, expect, it } from "vitest";
import type { ChangedFile } from "../src/model/changeset.js";
import { hasEdges, textSymbolGraph } from "../src/analysis/text-graph.js";
import { orderFromGraph } from "../src/analysis/flow-order.js";

function file(path: string, after: string): ChangedFile {
  return { path, changeType: "edit", before: "", after };
}

describe("textSymbolGraph", () => {
  // The point: a usable graph without waiting for a language server to start.
  it("links a caller to the file declaring what it calls", () => {
    const graph = textSymbolGraph([
      file("src/Registry.cs", "public static class EsPoolRoleRegistry { }"),
      file("src/Naming.cs", "var x = EsPoolRoleRegistry.Lookup();"),
    ]);

    expect([...(graph.references.get("src/Naming.cs") ?? [])]).toContain("src/Registry.cs");
    expect([...(graph.referencedBy.get("src/Registry.cs") ?? [])]).toContain("src/Naming.cs");
  });

  it("records what each file declares", () => {
    const graph = textSymbolGraph([
      file("src/Registry.cs", "public static class EsPoolRoleRegistry { }"),
    ]);

    expect(graph.declares?.get("src/Registry.cs")).toContain("EsPoolRoleRegistry");
  });

  it("reports itself as unresolved, since it is an approximation", () => {
    expect(textSymbolGraph([file("a.cs", "class A { }")]).resolved).toBe(false);
  });

  it("produces an order that starts at the caller", () => {
    const files = [
      file("src/Registry.cs", "public static class EsPoolRoleRegistry { }"),
      file("src/Naming.cs", "var x = EsPoolRoleRegistry.Lookup();"),
    ];

    expect(orderFromGraph(files, textSymbolGraph(files))[0]).toBe("src/Naming.cs");
  });
});

describe("hasEdges", () => {
  it("is false for a graph nothing connected", () => {
    const graph = textSymbolGraph([file("a.cs", "// nothing"), file("b.cs", "// nothing")]);

    expect(hasEdges(graph)).toBe(false);
  });

  it("is true once one file references another", () => {
    const graph = textSymbolGraph([
      file("src/Registry.cs", "public static class EsPoolRoleRegistry { }"),
      file("src/Naming.cs", "EsPoolRoleRegistry.Lookup();"),
    ]);

    expect(hasEdges(graph)).toBe(true);
  });

  it("is false for an empty graph", () => {
    expect(hasEdges({ references: new Map(), referencedBy: new Map(), resolved: true })).toBe(
      false,
    );
  });
});
