import { describe, expect, it } from "vitest";
import { matchChangedFile } from "../src/analysis/match-file.js";
import type { ChangedFile } from "../src/model/changeset.js";

function file(path: string): ChangedFile {
  return { path, changeType: "edit", before: "a", after: "b" };
}

const files = [
  file("src/Controller/Partition.cs"),
  file("src/Contracts/DataPartition.cs"),
  file("README.md"),
];

describe("matchChangedFile", () => {
  it("matches a real path inside a checkout", () => {
    expect(
      matchChangedFile(files, "/home/me/repo/src/Controller/Partition.cs")?.path,
    ).toBe("src/Controller/Partition.cs");
  });

  it("matches a worktree far from the repository it came from", () => {
    expect(
      matchChangedFile(files, "/tmp/storage/worktrees/pr-42/src/Contracts/DataPartition.cs")?.path,
    ).toBe("src/Contracts/DataPartition.cs");
  });

  it("matches one of our virtual documents, whose path has a leading slash", () => {
    expect(matchChangedFile(files, "/src/Controller/Partition.cs")?.path).toBe(
      "src/Controller/Partition.cs",
    );
  });

  it("matches a Windows path", () => {
    expect(matchChangedFile(files, "C:\\work\\repo\\src\\Controller\\Partition.cs")?.path).toBe(
      "src/Controller/Partition.cs",
    );
  });

  it("does not let a shorter name satisfy a longer one", () => {
    // Partition.cs ends DataPartition.cs; anchoring at the separator is what stops it.
    expect(matchChangedFile([file("src/Controller/Partition.cs")], "/repo/src/Contracts/DataPartition.cs")).toBeUndefined();
  });

  it("matches a file at the repository root", () => {
    expect(matchChangedFile(files, "/home/me/repo/README.md")?.path).toBe("README.md");
  });

  it("returns nothing for a file outside the change", () => {
    expect(matchChangedFile(files, "/home/me/repo/src/Other.cs")).toBeUndefined();
  });
});
