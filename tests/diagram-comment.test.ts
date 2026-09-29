import { describe, expect, it } from "vitest";
import { buildDiagramComment, MARKETPLACE_URL } from "../src/ado/diagram-comment.js";

describe("buildDiagramComment", () => {
  it("embeds the uploaded image and names the change", () => {
    const comment = buildDiagramComment({
      imageUrl: "https://dev.azure.com/org/_apis/attachments/map.png",
      label: "PR 42: Fix the thing",
    });
    expect(comment).toContain("![Change map](https://dev.azure.com/org/_apis/attachments/map.png)");
    expect(comment).toContain("PR 42: Fix the thing");
  });

  it("links to the extension below the image, so readers can use it too", () => {
    const comment = buildDiagramComment({ imageUrl: "u" });
    const link = `[AI PR Analyzer](${MARKETPLACE_URL})`;
    expect(comment).toContain(link);
    expect(comment.indexOf(link)).toBeGreaterThan(comment.indexOf("![Change map](u)"));
    expect(MARKETPLACE_URL).toBe(
      "https://marketplace.visualstudio.com/items?itemName=rajeshvijay.pr-analyzer",
    );
  });

  it("carries no mermaid source", () => {
    const comment = buildDiagramComment({ imageUrl: "u" });
    expect(comment).not.toContain("```");
    expect(comment.toLowerCase()).not.toContain("mermaid");
  });
});
