import { describe, expect, it } from "vitest";
import type { ChangedFile } from "../src/model/changeset.js";
import type { SymbolGraph } from "../src/analysis/flow-order.js";
import { extractJsonCandidates, parseFirstJson } from "../src/lm/json.js";
import {
  buildOrderPrompt,
  ORDER_SYSTEM_PROMPT,
  reconcileOrder,
} from "../src/lm/order-prompt.js";

function file(path: string): ChangedFile {
  return { path, changeType: "edit", before: "old", after: "new" };
}

function graph(edges: Record<string, string[]>, declares: Record<string, string[]> = {}): SymbolGraph {
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
  return {
    references,
    referencedBy,
    declares: new Map(Object.entries(declares)),
    resolved: true,
  };
}

describe("parseFirstJson", () => {
  it("reads a bare object", () => {
    expect(parseFirstJson('{"steps":[]}')).toEqual({ steps: [] });
  });

  it("reads an object wrapped in prose", () => {
    const raw = 'Here you go:\n{"steps":[{"path":"a.ts","title":"Entry"}]}\nHope that helps.';
    expect(parseFirstJson<{ steps: unknown[] }>(raw)?.steps).toHaveLength(1);
  });

  it("reads an object inside a code fence", () => {
    const raw = '```json\n{"steps":[{"path":"a.ts"}]}\n```';
    expect(parseFirstJson<{ steps: unknown[] }>(raw)?.steps).toHaveLength(1);
  });

  it("is not confused by braces inside strings", () => {
    const raw = '{"steps":[{"path":"a.ts","title":"handles { and }"}]}';
    expect(parseFirstJson<{ steps: { title: string }[] }>(raw)?.steps[0].title).toBe(
      "handles { and }",
    );
  });

  it("returns null when there is no JSON at all", () => {
    expect(parseFirstJson("I cannot do that.")).toBeNull();
  });

  it("finds a candidate even when the reply opens with commentary", () => {
    expect(extractJsonCandidates('note\n{"a":1}').length).toBeGreaterThan(0);
  });
});

describe("ORDER_SYSTEM_PROMPT", () => {
  it("asks for execution flow rather than dependency order", () => {
    expect(ORDER_SYSTEM_PROMPT).toContain("EXECUTION FLOW");
    expect(ORDER_SYSTEM_PROMPT).toContain("what runs first");
  });

  // The exact mistake the earlier ordering made.
  it("forbids leading with a widely depended-on type", () => {
    expect(ORDER_SYSTEM_PROMPT).toContain("not first just because many files depend on it");
  });

  it("asks the model to rate each file's change complexity", () => {
    expect(ORDER_SYSTEM_PROMPT).toContain("effort");
    expect(ORDER_SYSTEM_PROMPT).toContain("complex");
  });
});

describe("buildOrderPrompt", () => {
  it("gives the model the reference graph as evidence", () => {
    const prompt = buildOrderPrompt(
      [file("Task.cs"), file("Handler.cs")],
      graph({ "Task.cs": ["Handler.cs"] }, { "Task.cs": ["ElasticsearchTask"] }),
    );

    expect(prompt).toContain("calls: Handler.cs");
    expect(prompt).toContain("called by: Task.cs");
    expect(prompt).toContain("declares: ElasticsearchTask");
  });

  it("states how many files must come back", () => {
    const prompt = buildOrderPrompt([file("a.ts"), file("b.ts")], graph({}));
    expect(prompt).toContain("2 files");
  });
});

describe("reconcileOrder", () => {
  const files = [file("a.ts"), file("b.ts"), file("c.ts")];

  it("keeps the model's order and titles", () => {
    const result = reconcileOrder(
      files,
      [
        { path: "c.ts", title: "Entry point" },
        { path: "a.ts", title: "Does the work" },
        { path: "b.ts", title: "Stores it" },
      ],
      ["a.ts", "b.ts", "c.ts"],
    );

    expect(result.map((step) => step.path)).toEqual(["c.ts", "a.ts", "b.ts"]);
    expect(result[0].title).toBe("Entry point");
  });

  it("carries the effort rating and drops an unknown one", () => {
    const result = reconcileOrder(
      files,
      [
        { path: "a.ts", title: "Entry", effort: "complex" },
        { path: "b.ts", title: "Data", effort: "routine" },
        { path: "c.ts", title: "Odd", effort: "banana" as never },
      ],
      ["a.ts", "b.ts", "c.ts"],
    );

    expect(result.find((step) => step.path === "a.ts")?.effort).toBe("complex");
    expect(result.find((step) => step.path === "b.ts")?.effort).toBe("routine");
    expect(result.find((step) => step.path === "c.ts")?.effort).toBeUndefined();
  });

  it("discards a path the model invented", () => {
    const result = reconcileOrder(
      files,
      [{ path: "imaginary.ts", title: "Nope" }, { path: "a.ts", title: "Real" }],
      ["a.ts", "b.ts", "c.ts"],
    );

    expect(result.map((step) => step.path)).not.toContain("imaginary.ts");
  });

  it("appends files the model forgot, so nothing is lost", () => {
    const result = reconcileOrder(files, [{ path: "b.ts", title: "Only one" }], [
      "a.ts",
      "b.ts",
      "c.ts",
    ]);

    expect(result.map((step) => step.path).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(result[0].path).toBe("b.ts");
  });

  it("ignores a repeated path", () => {
    const result = reconcileOrder(
      files,
      [
        { path: "a.ts", title: "First" },
        { path: "a.ts", title: "Again" },
      ],
      ["a.ts", "b.ts", "c.ts"],
    );

    expect(result.filter((step) => step.path === "a.ts")).toHaveLength(1);
  });

  it("falls back entirely when the model returned nothing usable", () => {
    const result = reconcileOrder(files, [], ["c.ts", "b.ts", "a.ts"]);

    expect(result.map((step) => step.path)).toEqual(["c.ts", "b.ts", "a.ts"]);
  });

  it("survives malformed entries without throwing", () => {
    const result = reconcileOrder(
      files,
      [{ path: 42 } as never, { title: "no path" } as never, { path: "a.ts", title: "ok" }],
      ["a.ts", "b.ts", "c.ts"],
    );

    expect(result).toHaveLength(3);
    expect(result[0].path).toBe("a.ts");
  });
});

describe("buildOrderPrompt shows the code, not just the graph", () => {
  const files: ChangedFile[] = [
    {
      path: "src/Contracts/PartitionSpec.cs",
      changeType: "edit",
      before: "class PartitionSpec { }",
      after: "class PartitionSpec { public string Sku { get; set; } }",
    },
    {
      path: "src/Host/ReconcileCoordinator.cs",
      changeType: "edit",
      before: "class ReconcileCoordinator { }",
      after: "class ReconcileCoordinator { public Task ReconcileAsync() => Task.CompletedTask; }",
    },
  ];

  const graph = { references: new Map(), referencedBy: new Map(), resolved: true };

  it("includes what each file changed, so the flow can be read from the code", () => {
    const prompt = buildOrderPrompt(files, graph);
    expect(prompt).toContain('<data name="changes">');
    expect(prompt).toContain("ReconcileAsync");
  });

  it("still lists every file with its reference graph", () => {
    const prompt = buildOrderPrompt(files, graph);
    expect(prompt).toContain("src/Contracts/PartitionSpec.cs");
    expect(prompt).toContain("src/Host/ReconcileCoordinator.cs");
    expect(prompt).toContain(`order a reviewer should read them`);
  });
});

describe("ORDER_SYSTEM_PROMPT anchors the flow at both ends", () => {
  it("asks for an entry point and an end", () => {
    expect(ORDER_SYSTEM_PROMPT).toContain("ENTRY:");
    expect(ORDER_SYSTEM_PROMPT).toContain("END:");
  });

  it("rules out a type declaration as the entry point", () => {
    expect(ORDER_SYSTEM_PROMPT).toMatch(/NOT the entry point/);
  });

  it("tells the model to believe the code over the graph", () => {
    expect(ORDER_SYSTEM_PROMPT).toMatch(/believe the code/);
  });
});
