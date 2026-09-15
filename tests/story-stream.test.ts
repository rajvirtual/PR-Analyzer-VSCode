import { describe, expect, it } from "vitest";
import type { ChangedFile } from "../src/model/changeset.js";
import { parseStory } from "../src/lm/story-prompt.js";
import { StoryStream, type StoryDelta } from "../src/lm/story-stream.js";

const files: ChangedFile[] = [
  { path: "src/submit-order.ts", changeType: "edit", before: "", after: "" },
  { path: "src/capacity.ts", changeType: "add", before: null, after: "" },
];

const REPLY = [
  "summary: Orders reserve capacity before they are confirmed.",
  "",
  "## Setup order entry",
  "path: src/submit-order.ts",
  "kind: changed",
  "submitOrder now resolves the profile before charging.",
  "",
  "## Reserve capacity",
  "path: src/capacity.ts",
  "kind: new",
  "Drops the slot from 5 to 3, or throws when it is sold out.",
  "",
  "before: A confirmed order could have no capacity behind it.",
  "after: A sold-out slot fails before payment.",
  "",
].join("\n");

/** Feeds the reply in fixed-size pieces, so boundaries land mid-word and mid-heading. */
function drain(reply: string, size: number): StoryDelta[] {
  const stream = new StoryStream(files);
  const deltas: StoryDelta[] = [];
  for (let at = 0; at < reply.length; at += size) {
    const delta = stream.push(reply.slice(at, at + size));
    if (delta.summary || delta.sections.length > 0) deltas.push(delta);
  }
  return deltas;
}

function titles(deltas: StoryDelta[]): string[] {
  return deltas.flatMap((delta) => delta.sections.map((entry) => entry.title));
}

describe("StoryStream", () => {
  it("emits a section as soon as the next one starts, not when the reply ends", () => {
    const stream = new StoryStream(files);

    expect(stream.push("summary: Orders reserve capacity.\n\n").sections).toEqual([]);
    expect(stream.push("## Setup order entry\npath: src/submit-order.ts\n").sections).toEqual([]);
    expect(stream.push("submitOrder resolves the profile first.\n\n").sections).toEqual([]);

    const delta = stream.push("## Reserve capacity\n");
    expect(delta.sections.map((entry) => entry.title)).toEqual(["Setup order entry"]);
    expect(delta.summary).toBe("Orders reserve capacity.");
  });

  it("emits the summary once, not with every later section", () => {
    const deltas = drain(REPLY, 24);
    expect(deltas.filter((delta) => delta.summary !== undefined)).toHaveLength(1);
  });

  it("never emits the same section twice, at any chunk size", () => {
    for (const size of [1, 3, 7, 16, 64, 512]) {
      expect(titles(drain(REPLY, size))).toEqual(["Setup order entry", "Reserve capacity"]);
    }
  });

  it("splits mid-heading without losing or duplicating the section", () => {
    const stream = new StoryStream(files);
    stream.push("summary: s\n\n## Setup order entry\npath: src/submit-order.ts\nprose here.\n\n#");
    const delta = stream.push("# Reserve capacity\n");

    expect(delta.sections.map((entry) => entry.title)).toEqual(["Setup order entry"]);
  });

  it("carries the parsed detail through, not just the title", () => {
    const stream = new StoryStream(files);
    stream.push(REPLY.slice(0, REPLY.indexOf("## Reserve capacity")));
    const [first] = stream.push("## Reserve capacity\n").sections;

    expect(first).toMatchObject({
      title: "Setup order entry",
      path: "src/submit-order.ts",
      kind: "changed",
    });
  });

  it("drops a path the change set does not contain, exactly as the final parse does", () => {
    const stream = new StoryStream(files);
    stream.push("summary: s\n\n## Invented\npath: src/nowhere.ts\nprose.\n\n");
    const [first] = stream.push("## Next\n").sections;

    expect(first?.path).toBeUndefined();
  });

  it("agrees with the parse of the whole reply", () => {
    const streamed = titles(drain(REPLY, 11));
    const whole = parseStory(REPLY, files);

    // The last section settles only when the reply ends, so the stream is one short.
    expect(whole?.sections.map((entry) => entry.title)).toEqual([...streamed]);
  });
});
