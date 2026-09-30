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

  it("lists every pull request of a feature, marking the one it is posted on", () => {
    const comment = buildDiagramComment({
      imageUrl: "u",
      label: "AB#80805: 2 pull requests",
      related: [
        { label: "OSDU-Airflow-Lib !27634 — Harden [MIR]", url: "https://a/27634", current: true },
        { label: "OSDU-Ingestion-Dags !27635", url: "https://a/27635" },
      ],
    });
    expect(comment).toContain("- [OSDU-Airflow-Lib !27634 — Harden MIR](https://a/27634) — this one");
    expect(comment).toContain("- [OSDU-Ingestion-Dags !27635](https://a/27635)\n");
    expect(comment.indexOf("Pull requests in this feature")).toBeLessThan(comment.indexOf("Drawn by"));
  });

  it("adds no list for a single pull request", () => {
    expect(buildDiagramComment({ imageUrl: "u" })).not.toContain("Pull requests in this feature");
  });

  it("links the image to itself and offers the full size, since a comment cannot zoom", () => {
    const comment = buildDiagramComment({ imageUrl: "https://a/map.png" });
    expect(comment).toContain("[![Change map](https://a/map.png)](https://a/map.png)");
    expect(comment).toContain("[Open the full-size map](https://a/map.png)");
    expect(comment.indexOf("Open the full-size map")).toBeLessThan(comment.indexOf("Drawn by"));
  });
});

