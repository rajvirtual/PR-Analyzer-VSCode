import { describe, expect, it } from "vitest";
import { buildDiagramComment, MAX_SOURCE_CHARACTERS } from "../src/ado/diagram-comment.js";

describe("buildDiagramComment", () => {
  it("embeds the uploaded image and names the change", () => {
    const comment = buildDiagramComment({
      imageUrl: "https://dev.azure.com/org/_apis/attachments/map.png",
      mermaid: "flowchart TD\n  a --> b",
      label: "PR 42: Fix the thing",
    });
    expect(comment).toContain("![Change map](https://dev.azure.com/org/_apis/attachments/map.png)");
    expect(comment).toContain("PR 42: Fix the thing");
  });

  it("carries the source in a plain block so it is not rendered twice", () => {
    const comment = buildDiagramComment({ imageUrl: "u", mermaid: "flowchart TD\n  a --> b" });
    expect(comment).toContain("```text\nflowchart TD\n  a --> b\n```");
    expect(comment).not.toContain("```mermaid");
  });

  it("uses a fence longer than any backtick run in the source", () => {
    const comment = buildDiagramComment({ imageUrl: "u", mermaid: 'a["uses ``` inside"]' });
    expect(comment).toContain('````text\na["uses ``` inside"]\n````');
  });

  it("leaves out a source too long for one comment, keeping the image", () => {
    const comment = buildDiagramComment({
      imageUrl: "u",
      mermaid: "x".repeat(MAX_SOURCE_CHARACTERS + 1),
    });
    expect(comment).toContain("![Change map](u)");
    expect(comment).not.toContain("Mermaid source");
  });
});
