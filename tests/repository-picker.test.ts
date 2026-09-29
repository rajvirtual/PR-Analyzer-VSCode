import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { listRepositories } from "../src/git/repository-picker.js";

const state = vi.hoisted(() => ({
  folders: [] as { uri: { scheme: string; fsPath: string } }[],
  gitRepositories: [] as { rootUri: { fsPath: string }; state: { HEAD?: { name?: string } } }[],
}));

vi.mock("vscode", () => ({
  workspace: {
    get workspaceFolders() {
      return state.folders;
    },
  },
  extensions: {
    getExtension: () => ({
      isActive: true,
      exports: { getAPI: () => ({ repositories: state.gitRepositories }) },
    }),
  },
}));


function init(folder: string): void {
  execFileSync("git", ["init", "-q", "-b", "main", folder]);
}

describe("listRepositories", () => {
  let root: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "pr-analyzer-repos-")));
    for (const name of ["alpha", "beta"]) {
      await mkdir(path.join(root, name));
      init(path.join(root, name));
    }
    await mkdir(path.join(root, "not-a-repo"));
    await mkdir(path.join(root, ".hidden"));
    init(path.join(root, ".hidden"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("finds the repositories sitting side by side in a workspace folder", async () => {
    state.folders = [{ uri: { scheme: "file", fsPath: root } }];
    state.gitRepositories = [];
    const found = (await listRepositories()).map((choice) => path.basename(choice.root));
    expect(found).toEqual(["alpha", "beta"]);
  });

  it("names a repository once, keeping the branch git support reported", async () => {
    state.folders = [{ uri: { scheme: "file", fsPath: root } }];
    state.gitRepositories = [
      { rootUri: { fsPath: path.join(root, "beta") }, state: { HEAD: { name: "feature/x" } } },
    ];
    const found = await listRepositories();
    expect(found.map((choice) => path.basename(choice.root))).toEqual(["alpha", "beta"]);
    expect(found.find((choice) => choice.root.endsWith("beta"))?.branch).toBe("feature/x");
  });
});
