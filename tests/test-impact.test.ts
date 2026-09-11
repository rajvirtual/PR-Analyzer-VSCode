import { describe, expect, it } from "vitest";
import type { ChangedFile } from "../src/model/changeset.js";
import { analyzeTestImpact, isCodePath, isTestPath, testKey } from "../src/analysis/test-impact.js";

function file(path: string, changeType: ChangedFile["changeType"] = "edit"): ChangedFile {
  return { path, changeType, before: "a", after: "b" };
}

describe("isTestPath", () => {
  it("recognises a test directory", () => {
    expect(isTestPath("src/tests/thing.ts")).toBe(true);
    expect(isTestPath("app/__tests__/thing.ts")).toBe(true);
  });

  it("recognises test file conventions across languages", () => {
    expect(isTestPath("src/thing.test.ts")).toBe(true);
    expect(isTestPath("src/thing.spec.js")).toBe(true);
    expect(isTestPath("pkg/thing_test.go")).toBe(true);
    expect(isTestPath("app/test_thing.py")).toBe(true);
    expect(isTestPath("src/main/ThingTest.java")).toBe(true);
    expect(isTestPath("src/ThingTests.cs")).toBe(true);
  });

  it("does not mistake production code for a test", () => {
    expect(isTestPath("src/thing.ts")).toBe(false);
    expect(isTestPath("src/latest.ts")).toBe(false);
  });
});

describe("isCodePath", () => {
  it("accepts source and rejects data or docs", () => {
    expect(isCodePath("src/thing.ts")).toBe(true);
    expect(isCodePath("README.md")).toBe(false);
    expect(isCodePath("config.json")).toBe(false);
  });
});

describe("testKey", () => {
  it("gives a production file and its test the same key", () => {
    expect(testKey("src/Widget.cs")).toBe(testKey("test/WidgetTests.cs"));
    expect(testKey("src/widget.ts")).toBe(testKey("src/widget.test.ts"));
    expect(testKey("pkg/widget.go")).toBe(testKey("pkg/widget_test.go"));
    expect(testKey("app/widget.py")).toBe(testKey("app/test_widget.py"));
  });
});

describe("analyzeTestImpact", () => {
  it("flags a production change with no matching test change", () => {
    const impact = analyzeTestImpact([file("src/Pricing.cs"), file("src/Unrelated.cs")]);
    expect(impact.uncovered).toContain("src/Pricing.cs");
    expect(impact.changedTests).toEqual([]);
  });

  it("clears a production change when its test moved with it", () => {
    const impact = analyzeTestImpact([file("src/Pricing.cs"), file("test/PricingTests.cs")]);
    expect(impact.uncovered).not.toContain("src/Pricing.cs");
    expect(impact.changedProduction).toContain("src/Pricing.cs");
    expect(impact.changedTests).toContain("test/PricingTests.cs");
  });

  it("does not ask a deletion to carry a test", () => {
    const impact = analyzeTestImpact([file("src/Gone.cs", "delete")]);
    expect(impact.uncovered).toEqual([]);
  });

  it("ignores non-code files entirely", () => {
    const impact = analyzeTestImpact([file("README.md"), file("data.json")]);
    expect(impact.changedProduction).toEqual([]);
    expect(impact.uncovered).toEqual([]);
  });
});
