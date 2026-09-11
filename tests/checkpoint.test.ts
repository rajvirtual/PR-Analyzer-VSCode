import { describe, expect, it } from "vitest";
import { checkpointKey } from "../src/review/checkpoint.js";
import type { ChangeSet } from "../src/model/changeset.js";

function changeSet(over: Partial<ChangeSet> = {}): ChangeSet {
  return {
    repositoryRoot: "/repo",
    label: "x",
    baseRef: "origin/main",
    mergeBase: "base123",
    files: [],
    skipped: [],
    ...over,
  };
}

describe("checkpointKey", () => {
  it("uses the pinned head commit when there is one", () => {
    expect(checkpointKey(changeSet({ headCommit: "head456" }))).toContain("/repo@head456");
  });

  it("falls back to the merge base for a branch review", () => {
    expect(checkpointKey(changeSet())).toContain("/repo@base123");
  });

  it("separates different repositories at the same commit", () => {
    expect(checkpointKey(changeSet({ repositoryRoot: "/a" }))).not.toBe(
      checkpointKey(changeSet({ repositoryRoot: "/b" })),
    );
  });
});
