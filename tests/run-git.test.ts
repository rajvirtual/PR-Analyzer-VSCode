import { describe, expect, it } from "vitest";
import { formatCall, onGitCall, runGit } from "../src/git/run-git.js";
import type { GitCall } from "../src/git/run-git.js";

describe("formatCall", () => {
  it("writes the command the way it would be typed", () => {
    const text = formatCall({ cwd: "/repo", args: ["rev-parse", "HEAD"], ms: 12, ok: true });
    expect(text).toContain("$ git rev-parse HEAD");
    expect(text).toContain("in /repo");
    expect(text).toContain("(12ms)");
  });

  it("quotes arguments holding spaces, so the line can be pasted", () => {
    const text = formatCall({ cwd: "/repo", args: ["grep", "two words"], ms: 1, ok: true });
    expect(text).toContain('$ git grep "two words"');
  });

  it("marks a failure and indents what git said", () => {
    const text = formatCall({
      cwd: "/repo",
      args: ["fetch"],
      ms: 5,
      ok: false,
      error: "fatal: could not read Username",
    });
    expect(text).toContain("← failed");
    expect(text).toContain("  ! fatal: could not read Username");
  });
});

describe("runGit", () => {
  it("reports the call, and the failure, to whoever is listening", async () => {
    const seen: GitCall[] = [];
    const subscription = onGitCall((call) => seen.push(call));

    await runGit(process.cwd(), ["--version"]);
    await expect(runGit(process.cwd(), ["not-a-git-command"])).rejects.toThrow();

    subscription.dispose();

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ ok: true, args: ["--version"] });
    expect(seen[1]!.ok).toBe(false);
    expect(seen[1]!.error).toBeTruthy();
  });

  it("stops reporting once the listener is disposed", async () => {
    const seen: GitCall[] = [];
    onGitCall((call) => seen.push(call)).dispose();
    await runGit(process.cwd(), ["--version"]);
    expect(seen).toHaveLength(0);
  });
});
