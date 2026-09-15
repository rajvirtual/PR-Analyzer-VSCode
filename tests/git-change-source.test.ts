import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildChangeSet, detectBaseRef, GitError } from "../src/git/git-change-source.js";
import { buildSteps } from "../src/session.js";

const run = promisify(execFile);

let repo: string;

async function git(...args: string[]): Promise<void> {
  await run("git", args, { cwd: repo });
}

async function write(relative: string, content: string): Promise<void> {
  const full = path.join(repo, relative);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
}

beforeAll(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "pr-analyzer-git-"));

  await git("init", "-b", "main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await git("config", "commit.gpgsign", "false");

  await write("src/thing.ts", "export class Thing {\n  run() {}\n}\n");
  await write("src/untouched.ts", "export const untouched = 1;\n");
  await write("src/removed.ts", "export const gone = true;\n");
  await git("add", ".");
  await git("commit", "-m", "base");

  await git("checkout", "-b", "feature");

  // Committed work.
  await write("src/thing.ts", "export class Thing {\n  run() {\n    this.extra();\n  }\n  extra() {}\n}\n");
  await write("src/caller.ts", "import { Thing } from './thing';\nnew Thing().run();\n");
  await git("rm", "-q", "src/removed.ts");
  await git("add", ".");
  await git("commit", "-m", "feature work");

  // Work that has not been committed at all.
  await write("src/uncommitted.ts", "export const draft = 1;\n");
  await git("add", "src/uncommitted.ts");

  // A file the working tree has but git is not tracking at all.
  await write("src/scratch.ts", "export const scratch = 1;\n");
}, 30_000);

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("buildChangeSet", () => {
  it("finds the branch to compare against when none is configured", async () => {
    expect(await detectBaseRef(repo, "")).toBe("main");
  });

  it("honours an explicitly configured base", async () => {
    expect(await detectBaseRef(repo, "main")).toBe("main");
  });

  it("reports a missing base rather than guessing", async () => {
    await expect(buildChangeSet({ cwd: repo, baseRef: "no-such-branch" })).rejects.toThrow(
      GitError,
    );
  });

  it("includes edits, additions and deletions from the branch", async () => {
    const set = await buildChangeSet({ cwd: repo, baseRef: "main" });
    const byPath = new Map(set.files.map((file) => [file.path, file]));

    expect(byPath.get("src/thing.ts")?.changeType).toBe("edit");
    expect(byPath.get("src/caller.ts")?.changeType).toBe("add");
    expect(byPath.get("src/removed.ts")?.changeType).toBe("delete");
    expect(byPath.has("src/untouched.ts")).toBe(false);
  });

  it("captures both sides pinned to the merge base", async () => {
    const set = await buildChangeSet({ cwd: repo, baseRef: "main" });
    const thing = set.files.find((file) => file.path === "src/thing.ts");

    expect(thing?.before).toContain("run() {}");
    expect(thing?.before).not.toContain("extra()");
    expect(thing?.after).toContain("extra()");
  });

  it("sets before to null for an addition and after to null for a deletion", async () => {
    const set = await buildChangeSet({ cwd: repo, baseRef: "main" });

    expect(set.files.find((file) => file.path === "src/caller.ts")?.before).toBeNull();
    expect(set.files.find((file) => file.path === "src/removed.ts")?.after).toBeNull();
  });

  // The whole point of diffing the working tree: review before pushing.
  it("includes uncommitted work by default", async () => {
    const set = await buildChangeSet({ cwd: repo, baseRef: "main" });

    expect(set.files.map((file) => file.path)).toContain("src/uncommitted.ts");
  });

  it("excludes uncommitted work when asked to", async () => {
    const set = await buildChangeSet({
      cwd: repo,
      baseRef: "main",
      includeUncommitted: false,
    });

    expect(set.files.map((file) => file.path)).not.toContain("src/uncommitted.ts");
  });

  it("includes an untracked file as an addition", async () => {
    const set = await buildChangeSet({ cwd: repo, baseRef: "main" });
    const scratch = set.files.find((file) => file.path === "src/scratch.ts");

    expect(scratch?.changeType).toBe("add");
    expect(scratch?.after).toContain("scratch");
  });

  it("leaves untracked files out when uncommitted work is excluded", async () => {
    const set = await buildChangeSet({ cwd: repo, baseRef: "main", includeUncommitted: false });

    expect(set.files.map((file) => file.path)).not.toContain("src/scratch.ts");
  });

  it("produces steps covering every changed file", async () => {
    const set = await buildChangeSet({ cwd: repo, baseRef: "main" });
    const steps = buildSteps(set);

    expect(steps.map((step) => step.file.path).sort()).toEqual(
      set.files.map((file) => file.path).sort(),
    );
  });
});

describe("renamed and binary files", () => {
  it("follows a rename to the name it has now, and remembers the one it had", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-analyzer-rename-"));
    try {
      const g = (...args: string[]): Promise<unknown> => run("git", args, { cwd: dir });
      await g("init", "-b", "main");
      await g("config", "user.email", "t@e.com");
      await g("config", "user.name", "T");
      await g("config", "commit.gpgsign", "false");
      await writeFile(path.join(dir, "old-name.ts"), "export class Moved {}\n".repeat(6), "utf8");
      await writeFile(path.join(dir, "pic.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));
      await g("add", ".");
      await g("commit", "-m", "base");

      await g("checkout", "-b", "feature");
      await g("mv", "old-name.ts", "new-name.ts");
      await writeFile(path.join(dir, "pic.bin"), Buffer.from([0x00, 0x09, 0x09, 0x09]));
      await g("add", "-A");
      await g("commit", "-m", "rename");

      const set = await buildChangeSet({ cwd: dir, baseRef: "main" });
      const renamed = set.files.find((file) => file.path === "new-name.ts");

      expect(renamed).toMatchObject({ changeType: "rename", previousPath: "old-name.ts" });
      // The before side is read from the old path's blob, not the new name.
      expect(renamed?.before).toContain("Moved");

      // A binary side is named as skipped rather than shown as an empty file.
      expect(set.files.map((file) => file.path)).not.toContain("pic.bin");
      expect(set.skipped).toContainEqual({ path: "pic.bin", reason: "binary" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("unavailable sides", () => {
  it("marks an oversize working-tree edit as unavailable, not a deletion", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pr-analyzer-big-"));
    try {
      const g = (...args: string[]): Promise<unknown> => run("git", args, { cwd: dir });
      await g("init", "-b", "main");
      await g("config", "user.email", "t@e.com");
      await g("config", "user.name", "T");
      await g("config", "commit.gpgsign", "false");
      await writeFile(path.join(dir, "big.ts"), "small\n", "utf8");
      await g("add", ".");
      await g("commit", "-m", "base");
      await g("checkout", "-b", "feature");
      // Past the 2 MiB cap: the old code returned null and it read as a deletion.
      await writeFile(path.join(dir, "big.ts"), "x".repeat(2 * 1024 * 1024 + 10), "utf8");

      const set = await buildChangeSet({ cwd: dir, baseRef: "main" });
      const big = set.files.find((file) => file.path === "big.ts");

      expect(big?.changeType).toBe("edit");
      expect(big?.after).toBeNull();
      expect(big?.afterUnavailable).toBe("too-large");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
