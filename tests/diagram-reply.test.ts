import { describe, expect, it } from "vitest";
import type { ChangedFile } from "../src/model/changeset.js";
import { fenceClosed, mermaidSoFar, parseDiagramReply } from "../src/lm/diagram-reply.js";

const files: ChangedFile[] = [
  { path: "src/task.ts", changeType: "edit", before: "", after: "" },
  { path: "src/profile.ts", changeType: "add", before: null, after: "" },
];

const MERMAID = 'flowchart TD\n  a["1. Task entry"] --> b["2. Resolve profile"]\n  class a,b new';

const REPLY = ["```mermaid", MERMAID, "```", "", "files:", "a = src/task.ts", "b = src/profile.ts", ""].join(
  "\n",
);

describe("mermaidSoFar", () => {
  it("returns what has been written before the fence closes", () => {
    const partial = '```mermaid\nflowchart TD\n  a["1. Task entry"] --> b["2. Res';
    expect(mermaidSoFar(partial)).toBe('flowchart TD\n  a["1. Task entry"] --> b["2. Res');
  });

  it("returns the finished block once it closes", () => {
    expect(mermaidSoFar(REPLY)).toBe(MERMAID);
  });

  it("is empty before the fence opens", () => {
    expect(mermaidSoFar("Looking up the profile first")).toBe("");
  });

  it("accepts a fence that omits the language", () => {
    expect(mermaidSoFar("```\nflowchart TD\n  a --> b\n```")).toBe("flowchart TD\n  a --> b");
  });
});

describe("fenceClosed", () => {
  it("is the success condition, rather than a parse", () => {
    expect(fenceClosed("```mermaid\nflowchart TD\n  a --> b")).toBe(false);
    expect(fenceClosed(REPLY)).toBe(true);
  });
});

describe("parseDiagramReply", () => {
  it("refuses a diagram that is still being written", () => {
    expect(parseDiagramReply("```mermaid\nflowchart TD\n  a --> b", files)).toBeNull();
  });

  it("reads the diagram and the node paths", () => {
    expect(parseDiagramReply(REPLY, files)).toEqual({
      mermaid: MERMAID,
      files: { a: "src/task.ts", b: "src/profile.ts" },
    });
  });

  it("accepts the colon form, and ignores the heading", () => {
    const colons = ["```mermaid", MERMAID, "```", "files:", "a: src/task.ts"].join("\n");
    expect(parseDiagramReply(colons, files)?.files).toEqual({ a: "src/task.ts" });
  });

  it("drops a path the change does not contain", () => {
    const invented = [REPLY, "c = src/invented.ts"].join("\n");
    expect(parseDiagramReply(invented, files)?.files).toEqual({
      a: "src/task.ts",
      b: "src/profile.ts",
    });
  });

  it("rejects a block that is not a flowchart", () => {
    expect(parseDiagramReply("```mermaid\nsequenceDiagram\n  a ->> b: hi\n```", files)).toBeNull();
  });

  it("rejects a flowchart with no arrows, which renders as nothing", () => {
    expect(parseDiagramReply('```mermaid\nflowchart TD\n  a["only"]\n```', files)).toBeNull();
  });

  it("survives prose around the block, since a model adds it", () => {
    const chatty = ["Here is the flow:", "```mermaid", MERMAID, "```", "a = src/task.ts"].join("\n");
    expect(parseDiagramReply(chatty, files)?.mermaid).toBe(MERMAID);
  });
});
