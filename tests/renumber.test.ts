import { describe, expect, it } from "vitest";
import { renumberByFlow } from "../src/analysis/renumber.js";

function numbersOf(mermaid: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const match of mermaid.matchAll(/([A-Za-z]\w*)\s*[[({>]+"(\d+)\./g)) {
    found[match[1]!] = Number(match[2]);
  }
  return found;
}

describe("renumberByFlow", () => {
  it("renumbers a flow the model numbered backwards", () => {
    const { mermaid, corrected } = renumberByFlow(
      [
        "flowchart TD",
        '  a["3. Webhook validates the request"]',
        '  b["2. Spec gains node counts"]',
        '  c["1. CRD exposes the fields"]',
        "  a --> b",
        "  b --> c",
      ].join("\n"),
    );

    expect(numbersOf(mermaid)).toEqual({ a: 1, b: 2, c: 3 });
    expect(corrected).toBe(2);
  });

  it("puts a step back in its place when the model interleaves it", () => {
    const { mermaid } = renumberByFlow(
      [
        "flowchart TD",
        '  r["7. Reconciler computes target state"]',
        '  p["12. Publishes resulting status"]',
        '  d["8. Derives observed topology"]',
        "  r --> d",
        "  d --> p",
      ].join("\n"),
    );

    const numbers = numbersOf(mermaid);
    expect(numbers.r).toBeLessThan(numbers.d!);
    expect(numbers.d).toBeLessThan(numbers.p!);
  });

  it("leaves a diagram that was already right alone", () => {
    const definition = [
      "flowchart TD",
      '  a["1. First"]',
      '  b["2. Second"]',
      "  a --> b",
    ].join("\n");

    const { mermaid, corrected } = renumberByFlow(definition);
    expect(mermaid).toBe(definition);
    expect(corrected).toBe(0);
  });

  it("numbers across subgraphs by the arrows, not by the box", () => {
    const { mermaid } = renumberByFlow(
      [
        "flowchart TD",
        '  subgraph g0["Host"]',
        '    b["9. Second"]',
        "  end",
        '  subgraph g1["Admission"]',
        '    a["4. First"]',
        "  end",
        "  a --> b",
      ].join("\n"),
    );

    expect(numbersOf(mermaid)).toEqual({ a: 1, b: 2 });
  });

  it("survives a loop rather than refusing to number", () => {
    const { mermaid } = renumberByFlow(
      [
        "flowchart TD",
        '  a["1. Watch"]',
        '  b["2. Reconcile"]',
        '  c["3. Requeue"]',
        "  a --> b",
        "  b --> c",
        "  c --> a",
      ].join("\n"),
    );

    expect(numbersOf(mermaid)).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("handles labelled edges and dotted links", () => {
    const { mermaid } = renumberByFlow(
      [
        "flowchart TD",
        '  a["5. Enters"]',
        '  b["2. Then"]',
        "  a -->|when drifted| b",
      ].join("\n"),
    );

    expect(numbersOf(mermaid)).toEqual({ a: 1, b: 2 });
  });

  it("does not treat a subgraph title as a node", () => {
    const { mermaid } = renumberByFlow(
      [
        "flowchart TD",
        '  subgraph g0["Adme.Controller/Host"]',
        '    a["2. Only node"]',
        "  end",
      ].join("\n"),
    );

    expect(mermaid).toContain('subgraph g0["Adme.Controller/Host"]');
    expect(numbersOf(mermaid).a).toBe(1);
  });

  it("keeps classDef and class lines untouched", () => {
    const definition = [
      "flowchart TD",
      '  a["1. Step"]',
      "  classDef new fill:#0b6",
      "  class a new",
    ].join("\n");

    expect(renumberByFlow(definition).mermaid).toContain("classDef new fill:#0b6");
    expect(renumberByFlow(definition).mermaid).toContain("class a new");
  });

  it("adds a number to a label that has none", () => {
    const { mermaid } = renumberByFlow(
      ["flowchart TD", '  a["Enters here"]', '  b["Then here"]', "  a --> b"].join("\n"),
    );

    expect(numbersOf(mermaid)).toEqual({ a: 1, b: 2 });
  });

  it("returns an unnumbered diagram unchanged when it has no labels", () => {
    const definition = "flowchart TD\n  a --> b";
    expect(renumberByFlow(definition).mermaid).toBe(definition);
  });
});
