import { describe, expect, it } from "vitest";
import type { ChangedFile } from "../src/model/changeset.js";
import {
  buildIntentPrompt,
  INTENT_SYSTEM_PROMPT,
  renderIntentMarkdown,
  validateIntentMap,
  assembleIntentText,
} from "../src/lm/intent-prompt.js";

function file(path: string): ChangedFile {
  return { path, changeType: "edit", before: "a", after: "b" };
}

const files = [file("src/Pricing.cs"), file("test/PricingTests.cs")];

describe("INTENT_SYSTEM_PROMPT", () => {
  it("asks for evidence, not a guess", () => {
    expect(INTENT_SYSTEM_PROMPT).toContain("read_file");
    expect(INTENT_SYSTEM_PROMPT).toMatch(/Never invent a path/);
  });

  it("treats the intent as untrusted data", () => {
    expect(INTENT_SYSTEM_PROMPT).toContain("untrusted data");
  });
});

describe("buildIntentPrompt", () => {
  it("carries the intent and the file list", () => {
    const prompt = buildIntentPrompt("Add flex pricing", files);
    expect(prompt).toContain("Add flex pricing");
    expect(prompt).toContain("src/Pricing.cs (edit)");
  });

  it("says so when there is no description", () => {
    expect(buildIntentPrompt("   ", files)).toContain("no description was given");
  });
});

describe("validateIntentMap", () => {
  it("keeps only paths that are part of the change", () => {
    const map = validateIntentMap(
      {
        summary: "ok",
        items: [
          {
            intent: "Add flex pricing",
            files: ["src/Pricing.cs", "src/Invented.cs"],
            tests: ["test/PricingTests.cs"],
          },
        ],
      },
      files,
    );
    expect(map?.items[0].files).toEqual(["src/Pricing.cs"]);
    expect(map?.items[0].tests).toEqual(["test/PricingTests.cs"]);
  });

  it("drops items with no intent and returns null when nothing is left", () => {
    expect(validateIntentMap({ items: [{ files: ["src/Pricing.cs"] }] }, files)).toBeNull();
  });

  it("rejects a non-object", () => {
    expect(validateIntentMap("nope", files)).toBeNull();
  });
});

describe("renderIntentMarkdown", () => {
  it("shows the gap and the no-test case", () => {
    const md = renderIntentMarkdown(
      {
        summary: "Mostly there.",
        items: [{ intent: "Add flex pricing", files: ["src/Pricing.cs"], tests: [], gap: "No test covers flex." }],
      },
      "feature vs main",
    );
    expect(md).toContain("# Intent vs. evidence — feature vs main");
    expect(md).toContain("`src/Pricing.cs`");
    expect(md).toContain("_no test change_");
    expect(md).toContain("> No test covers flex.");
  });
});

describe("assembleIntentText", () => {
  it("folds title, description, and work items into one string", () => {
    const text = assembleIntentText({
      title: "Flex pricing",
      description: "Add a flex SKU.",
      workItems: [{ id: "42", title: "Support flex" }],
    });
    expect(text).toContain("Flex pricing");
    expect(text).toContain("Add a flex SKU.");
    expect(text).toContain("- #42 Support flex");
  });

  it("omits empty parts", () => {
    expect(assembleIntentText({ title: "", description: "Only this.", workItems: [] })).toBe(
      "Only this.",
    );
  });
});

