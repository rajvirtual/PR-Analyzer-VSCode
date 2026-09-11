import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  containedPath,
  containedRelativePath,
  isUnder,
  realpathWithin,
} from "../src/lm/safe-path.js";

describe("containedRelativePath", () => {
  it("keeps an ordinary repository path", () => {
    expect(containedRelativePath("src/app/Thing.cs")).toBe("src/app/Thing.cs");
  });

  it("normalises an inner back-step that stays inside", () => {
    expect(containedRelativePath("src/app/../lib/Thing.cs")).toBe("src/lib/Thing.cs");
  });

  it("rejects a path that climbs out", () => {
    expect(containedRelativePath("../secret")).toBeNull();
    expect(containedRelativePath("src/../../secret")).toBeNull();
  });

  it("rejects an absolute path", () => {
    expect(containedRelativePath("/etc/passwd")).toBeNull();
  });

  it("rejects a Windows drive path on any platform", () => {
    expect(containedRelativePath("C:/Windows/system32")).toBeNull();
  });

  it("rejects a backslash path that climbs out", () => {
    expect(containedRelativePath("..\\secret")).toBeNull();
  });

  it("rejects the root itself and a lone dot", () => {
    expect(containedRelativePath(".")).toBeNull();
    expect(containedRelativePath("")).toBeNull();
  });

  it("rejects a NUL byte", () => {
    expect(containedRelativePath("src/a\0b")).toBeNull();
  });
});

describe("isUnder", () => {
  it("accepts the root and paths beneath it", () => {
    expect(isUnder("/repo", "/repo")).toBe(true);
    expect(isUnder("/repo", "/repo/src/a")).toBe(true);
  });

  it("rejects a sibling that shares a prefix", () => {
    expect(isUnder("/repo", "/repo-other/a")).toBe(false);
    expect(isUnder("/repo", "/elsewhere")).toBe(false);
  });
});

describe("containedPath", () => {
  it("resolves a safe path to an absolute one inside root", () => {
    expect(containedPath("/repo", "src/a.cs")).toBe(path.resolve("/repo/src/a.cs"));
  });

  it("refuses a traversal even when it resolves outside", () => {
    expect(containedPath("/repo", "../repo-other/a")).toBeNull();
  });
});

describe("realpathWithin", () => {
  it("resolves a real file inside root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "safe-"));
    try {
      await mkdir(path.join(root, "src"));
      await writeFile(path.join(root, "src", "a.txt"), "hi");
      const real = await realpathWithin(root, path.join(root, "src", "a.txt"));
      expect(real).not.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a symlink that points outside root", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "safe-"));
    try {
      const root = path.join(base, "repo");
      const outside = path.join(base, "outside");
      await mkdir(root);
      await mkdir(outside);
      await writeFile(path.join(outside, "secret.txt"), "secret");
      await symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));

      // The lexical check passes — the link name is inside the repo — but its target is not.
      const lexical = containedPath(root, "link.txt");
      expect(lexical).not.toBeNull();
      expect(await realpathWithin(root, lexical as string)).toBeNull();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("returns null for a missing file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "safe-"));
    try {
      expect(await realpathWithin(root, path.join(root, "nope.txt"))).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
