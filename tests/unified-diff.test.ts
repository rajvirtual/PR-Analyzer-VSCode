import { describe, expect, it } from "vitest";
import { diffLines, unifiedDiff } from "../src/analysis/unified-diff.js";

describe("diffLines", () => {
  it("marks added, removed, and unchanged lines", () => {
    const result = diffLines(["a", "b", "c"], ["a", "x", "c"]);

    expect(result.map((line) => `${line.kind}:${line.text}`)).toEqual([
      "context:a",
      "remove:b",
      "add:x",
      "context:c",
    ]);
  });

  it("numbers lines against the side they belong to", () => {
    const result = diffLines(["a", "b", "c"], ["a", "c"]);
    const removed = result.find((line) => line.kind === "remove");

    expect(removed).toMatchObject({ text: "b", beforeLine: 2 });
    expect(removed?.afterLine).toBeUndefined();
    expect(result.at(-1)).toMatchObject({ kind: "context", beforeLine: 3, afterLine: 2 });
  });

  it("reports no changes for identical input", () => {
    const result = diffLines(["a", "b"], ["a", "b"]);

    expect(result.every((line) => line.kind === "context")).toBe(true);
  });
});

describe("unifiedDiff", () => {
  it("returns nothing when the texts match", () => {
    expect(unifiedDiff("a\nb", "a\nb")).toBe("");
  });

  it("shows changed lines with surrounding context", () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const after = before.replace("line 10", "line ten");

    const result = unifiedDiff(before, after, { context: 2 });

    expect(result).toContain("-   10 line 10");
    expect(result).toContain("+   10 line ten");
    expect(result).toContain("line 8");
    // Far-away lines stay out, so the model is not handed the whole file twice.
    expect(result).not.toContain("line 1\n");
    expect(result).not.toContain("line 20");
  });

  it("keeps only the hunk covering the focused range", () => {
    const before = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n");
    const after = before.replace("line 5", "line five").replace("line 50", "line fifty");

    const result = unifiedDiff(before, after, {
      context: 2,
      focus: { startLine: 48, endLine: 52 },
    });

    expect(result).toContain("line fifty");
    expect(result).not.toContain("line five");
  });

  it("falls back to every hunk when the focus matches none", () => {
    const before = "a\nb\nc";
    const after = "a\nB\nc";

    const result = unifiedDiff(before, after, { focus: { startLine: 900, endLine: 901 } });

    expect(result).toContain("+    2 B");
  });
});
