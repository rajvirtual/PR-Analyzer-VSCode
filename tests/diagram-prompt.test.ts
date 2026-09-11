import { describe, expect, it } from "vitest";
import type { ChangedFile, Step } from "../src/model/changeset.js";
import type { SymbolGraph } from "../src/analysis/flow-order.js";
import {
  buildDiagramPrompt,
  DIAGRAM_SYSTEM_PROMPT,
  validateDiagram,
} from "../src/lm/diagram-prompt.js";

function file(path: string): ChangedFile {
  return { path, changeType: "edit", before: "a", after: "b" };
}

function step(order: number, path: string, title?: string): Step {
  return { id: `s${order}`, order, file: file(path), role: "implementation", title };
}

const emptyGraph: SymbolGraph = {
  references: new Map(),
  referencedBy: new Map(),
  resolved: false,
};

describe("DIAGRAM_SYSTEM_PROMPT", () => {
  // The point of the diagram: the flow, with this pull request marked on it.
  it("asks for the flow with the change marked on it", () => {
    expect(DIAGRAM_SYSTEM_PROMPT).toContain("Draw the flow, and mark the change on it");
  });

  it("requires every node to be classified new, changed, or context", () => {
    expect(DIAGRAM_SYSTEM_PROMPT).toContain("Classify EVERY node");
    expect(DIAGRAM_SYSTEM_PROMPT).toContain("classDef new");
    expect(DIAGRAM_SYSTEM_PROMPT).toContain("classDef changed");
    expect(DIAGRAM_SYSTEM_PROMPT).toContain("classDef context");
  });

  it("asks for real symbol names rather than generic phrases", () => {
    expect(DIAGRAM_SYSTEM_PROMPT).toContain("named with the real symbols");
  });

  it("asks for detail rather than collapsing", () => {
    expect(DIAGRAM_SYSTEM_PROMPT).toContain("12 to 25 nodes");
    expect(DIAGRAM_SYSTEM_PROMPT).toContain("Be detailed");
  });

  it("asks for decisions as diamonds with labelled edges", () => {
    expect(DIAGRAM_SYSTEM_PROMPT).toContain("diamonds with labelled edges");
  });

  it("asks for a before and after label where something was replaced", () => {
    expect(DIAGRAM_SYSTEM_PROMPT).toContain("was CommercialSku");
  });

  it("tells the model to look things up before drawing", () => {
    expect(DIAGRAM_SYSTEM_PROMPT).toContain("read_file and find_symbol");
  });

  it("asks for subgraphs by purpose rather than by folder", () => {
    expect(DIAGRAM_SYSTEM_PROMPT).toContain("by PURPOSE");
  });

  it("asks for as many nodes as possible to map to files", () => {
    expect(DIAGRAM_SYSTEM_PROMPT).toContain("Map as many as you can");
  });
});

describe("buildDiagramPrompt", () => {
  // The whole point: the model sees the changed lines, not a summary of them.
  it("includes the added declarations from the diff", () => {
    const changed: ChangedFile = {
      path: "src/Registry.cs",
      changeType: "edit",
      before: "namespace N\n{\n}\n",
      after: "namespace N\n{\n    public static class EsPoolRoleRegistry\n    {\n    }\n}\n",
    };

    const prompt = buildDiagramPrompt([step(1, changed.path)], [changed], emptyGraph);

    expect(prompt).toContain("EsPoolRoleRegistry");
    expect(prompt).toContain("added:");
  });

  it("includes a rewritten condition on both sides", () => {
    const changed: ChangedFile = {
      path: "src/Setup.cs",
      changeType: "edit",
      before: "            if (desired.CommercialSku == Developer)\n",
      after: "            if (desired.ProfileRef?.Name == profile.Name)\n",
    };

    const prompt = buildDiagramPrompt([step(1, changed.path)], [changed], emptyGraph);

    expect(prompt).toContain("CommercialSku");
    expect(prompt).toContain("ProfileRef");
  });

  it("passes the call graph when the language server supplied one", () => {
    const graph: SymbolGraph = {
      references: new Map([["src/Task.cs", new Set(["src/Handler.cs"])]]),
      referencedBy: new Map(),
      resolved: true,
    };

    const prompt = buildDiagramPrompt(
      [step(1, "src/Task.cs")],
      [file("src/Task.cs")],
      graph,
    );

    expect(prompt).toContain("Task.cs -> Handler.cs");
  });

  it("asks for every file to be covered and every node classified", () => {
    const files = Array.from({ length: 20 }, (_, index) => file(`f${index}.ts`));
    const steps = files.map((entry, index) => step(index + 1, entry.path));

    const prompt = buildDiagramPrompt(steps, files, emptyGraph);

    expect(prompt).toContain("across all 20 files");
    expect(prompt).toContain("new, changed, or context");
  });
});

describe("validateDiagram", () => {
  const files = [file("src/Task.cs"), file("src/Handler.cs")];

  it("accepts a well-formed diagram", () => {
    const result = validateDiagram(
      {
        mermaid: 'flowchart TD\n  a["Entry"] --> b["Work"]',
        files: { a: "src/Task.cs" },
      },
      files,
    );

    expect(result?.files).toEqual({ a: "src/Task.cs" });
  });

  it("rejects anything that is not a flowchart", () => {
    expect(validateDiagram({ mermaid: 'sequenceDiagram\n  a->>b: hi' }, files)).toBeNull();
  });

  it("rejects a flowchart with no edges, which is just a list", () => {
    expect(validateDiagram({ mermaid: 'flowchart TD\n  a["Only node"]' }, files)).toBeNull();
  });

  it("drops a file mapping that points outside the change", () => {
    const result = validateDiagram(
      {
        mermaid: 'flowchart TD\n  a["Entry"] --> b["Work"]',
        files: { a: "src/Task.cs", b: "src/Imaginary.cs" },
      },
      files,
    );

    expect(result?.files).toEqual({ a: "src/Task.cs" });
  });

  it("accepts a diagram with no file mapping at all", () => {
    const result = validateDiagram({ mermaid: 'flowchart TD\n  a["x"] --> b["y"]' }, files);

    expect(result?.files).toEqual({});
  });

  it("rejects junk without throwing", () => {
    expect(validateDiagram(null, files)).toBeNull();
    expect(validateDiagram("flowchart TD", files)).toBeNull();
    expect(validateDiagram({ mermaid: 42 }, files)).toBeNull();
  });
});
