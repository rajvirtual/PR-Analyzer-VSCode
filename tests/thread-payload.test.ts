import { describe, expect, it } from "vitest";
import { buildThreadPayload } from "../src/ado/thread-payload.js";

describe("buildThreadPayload", () => {
  it("carries the comment content and marks the thread active", () => {
    const body = buildThreadPayload("Looks good") as {
      comments: { content: string }[];
      status: number;
    };
    expect(body.comments[0].content).toBe("Looks good");
    expect(body.status).toBe(1);
  });

  it("omits the thread context when there is no anchor", () => {
    expect(buildThreadPayload("A note").threadContext).toBeUndefined();
  });

  it("anchors to a one-based line and a slash-prefixed path", () => {
    const body = buildThreadPayload("Here", { filePath: "src/Thing.cs", line: 12 }) as {
      threadContext: { filePath: string; rightFileStart: { line: number } };
    };
    expect(body.threadContext.filePath).toBe("/src/Thing.cs");
    expect(body.threadContext.rightFileStart.line).toBe(12);
  });

  it("clamps a non-positive line to one", () => {
    const body = buildThreadPayload("Here", { filePath: "/a.cs", line: 0 }) as {
      threadContext: { rightFileStart: { line: number } };
    };
    expect(body.threadContext.rightFileStart.line).toBe(1);
  });

  it("keeps a path that already has a leading slash", () => {
    const body = buildThreadPayload("Here", { filePath: "/src/A.cs", line: 3 }) as {
      threadContext: { filePath: string };
    };
    expect(body.threadContext.filePath).toBe("/src/A.cs");
  });
});
