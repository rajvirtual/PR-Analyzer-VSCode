import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { sameRepository } from "../src/git/remote-match.js";
import { worktreePath } from "../src/git/worktree-path.js";

const run = promisify(execFile);

const identity = {
  organization: "OpenEnergyPlatform",
  project: "Open Energy Platform",
  repository: "OEP-RP",
  pullRequestId: 26577,
};

describe("sameRepository", () => {
  it("matches an https remote", () => {
    expect(
      sameRepository(
        "origin\thttps://dev.azure.com/OpenEnergyPlatform/Open%20Energy%20Platform/_git/OEP-RP (fetch)",
        identity,
      ),
    ).toBe(true);
  });

  it("matches an ssh remote", () => {
    expect(
      sameRepository(
        "origin\tgit@ssh.dev.azure.com:v3/OpenEnergyPlatform/Open Energy Platform/OEP-RP (fetch)",
        identity,
      ),
    ).toBe(true);
  });

  it("matches a remote carrying credentials", () => {
    expect(
      sameRepository(
        "origin\thttps://user@dev.azure.com/OpenEnergyPlatform/Proj/_git/OEP-RP",
        identity,
      ),
    ).toBe(true);
  });

  it("ignores a .git suffix", () => {
    expect(
      sameRepository("https://dev.azure.com/OpenEnergyPlatform/Proj/_git/OEP-RP.git", identity),
    ).toBe(true);
  });

  it("rejects a different repository in the same organisation", () => {
    expect(
      sameRepository("https://dev.azure.com/OpenEnergyPlatform/Proj/_git/oep-helm-charts", identity),
    ).toBe(false);
  });

  it("rejects the same repository name in another organisation", () => {
    expect(sameRepository("https://dev.azure.com/SomeoneElse/Proj/_git/OEP-RP", identity)).toBe(
      false,
    );
  });
});

describe("worktree lifecycle", () => {
  // Proves the git commands behave as assumed, without needing an extension host.
  it("adds and removes a detached worktree without disturbing the clone", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pr-analyzer-wt-"));
    const clone = path.join(root, "clone");
    const worktree = path.join(root, "worktrees", "pr-1");
    await mkdir(clone, { recursive: true });

    const git = (cwd: string, args: string[]) => run("git", args, { cwd });

    await git(clone, ["init", "-b", "main"]);
    await git(clone, ["config", "user.email", "t@example.com"]);
    await git(clone, ["config", "user.name", "T"]);
    await writeFile(path.join(clone, "a.txt"), "one\n");
    await git(clone, ["add", "."]);
    await git(clone, ["commit", "-m", "first"]);
    const commit = (await git(clone, ["rev-parse", "HEAD"])).stdout.trim();

    await mkdir(path.dirname(worktree), { recursive: true });
    await git(clone, ["worktree", "add", "--detach", "--quiet", worktree, commit]);

    const listed = (await git(clone, ["worktree", "list"])).stdout;
    expect(listed).toContain(worktree);

    await git(clone, ["worktree", "remove", "--force", worktree]);
    const after = (await git(clone, ["worktree", "list"])).stdout;
    expect(after).not.toContain(worktree);

    // The clone still has its own checkout and history.
    expect((await git(clone, ["rev-parse", "HEAD"])).stdout.trim()).toBe(commit);

    await rm(root, { recursive: true, force: true });
  }, 30_000);
});

describe("worktreePath", () => {
  it("names the same directory for the same pull request", () => {
    // Why the previous checkout must be disposed BEFORE the next is made: reviewing
    // one pull request twice produces two handles onto one directory, and disposing
    // the old one afterwards deletes the new one.
    expect(worktreePath("/storage", 26577)).toBe(worktreePath("/storage", 26577));
  });

  it("keeps different pull requests apart", () => {
    expect(worktreePath("/storage", 26577)).not.toBe(worktreePath("/storage", 26578));
  });

  it("puts checkouts under the extension's own storage", () => {
    expect(worktreePath("/storage", 42)).toBe(path.join("/storage", "worktrees", "pr-42"));
  });
});

describe("a worktree removed twice", () => {
  it("takes the second checkout with it, which is the bug this ordering avoids", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pr-analyzer-"));
    const clone = path.join(root, "clone");
    await mkdir(clone, { recursive: true });
    await run("git", ["init", "--quiet", "-b", "main"], { cwd: clone });
    await run("git", ["config", "user.email", "t@example.com"], { cwd: clone });
    await run("git", ["config", "user.name", "Test"], { cwd: clone });
    await writeFile(path.join(clone, "file.txt"), "one");
    await run("git", ["add", "."], { cwd: clone });
    await run("git", ["commit", "--quiet", "-m", "one"], { cwd: clone });
    const commit = (await run("git", ["rev-parse", "HEAD"], { cwd: clone })).stdout.trim();

    const target = worktreePath(root, 1);
    await run("git", ["worktree", "add", "--detach", "--quiet", target, commit], { cwd: clone });

    // The old handle removes the path the new checkout now occupies.
    await run("git", ["worktree", "remove", "--force", target], { cwd: clone });

    await expect(
      run("git", ["rev-parse", "HEAD"], { cwd: target }),
    ).rejects.toThrow();

    await rm(root, { recursive: true, force: true });
  });
});
