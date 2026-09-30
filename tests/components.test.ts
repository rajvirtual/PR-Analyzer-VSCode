import { describe, expect, it } from "vitest";
import * as path from "node:path";
import type { ChangeSet, Component } from "../src/model/changeset.js";
import { diskPath, isFeature, locate, toChangePath, toolRoots } from "../src/model/components.js";

function single(root: string): ChangeSet {
  return {
    repositoryRoot: root,
    label: "main vs origin/main",
    baseRef: "origin/main",
    mergeBase: "abc",
    files: [{ path: "src/a.py", changeType: "edit", before: "x", after: "y" }],
    skipped: [],
  };
}

function component(name: string, root: string, id: number): Component {
  return {
    name,
    repositoryRoot: root,
    identity: { organization: "org", project: "p", repository: name, pullRequestId: id },
    url: `https://dev.azure.com/org/p/_git/${name}/pullrequest/${id}`,
  };
}

describe("a single-repository change is untouched by the seam", () => {
  const root = path.join(path.sep, "repos", "one");

  it("is not a feature", () => {
    expect(isFeature(single(root))).toBe(false);
  });

  it("locates a path in its own root, unprefixed", () => {
    expect(locate(single(root), "src/a.py")).toEqual({ root, localPath: "src/a.py" });
  });

  it("puts a path on disk exactly where it was before", () => {
    expect(diskPath(single(root), "src/a.py")).toBe(path.join(root, "src/a.py"));
  });

  it("has no disk path without a checkout, as a pull request without a clone", () => {
    expect(diskPath(single(""), "src/a.py")).toBeNull();
  });

  it("returns a document path unchanged", () => {
    const document = path.join(root, "src", "a.py");
    expect(toChangePath(single(root), document)).toBe(document);
  });

  it("offers the tools no components", () => {
    expect(toolRoots(single(root))).toBeUndefined();
  });
});

describe("a change spanning several repositories", () => {
  const lib = path.join(path.sep, "wt", "pr-2");
  const feature: ChangeSet = {
    ...single(""),
    components: [component("Workflow", "", 1), component("Airflow-Lib", lib, 2)],
  };

  it("is a feature", () => {
    expect(isFeature(feature)).toBe(true);
  });

  it("routes a prefixed path to its component", () => {
    const located = locate(feature, "Airflow-Lib/osdu_airflow/ops.py");
    expect(located.component?.name).toBe("Airflow-Lib");
    expect(located.localPath).toBe("osdu_airflow/ops.py");
    expect(diskPath(feature, "Airflow-Lib/osdu_airflow/ops.py")).toBe(
      path.join(lib, "osdu_airflow/ops.py"),
    );
  });

  it("has no disk path for a component without a checkout", () => {
    expect(diskPath(feature, "Workflow/app.py")).toBeNull();
  });

  it("names a file in a component's checkout the way the change does", () => {
    expect(toChangePath(feature, path.join(lib, "osdu_airflow", "ops.py"))).toBe(
      "Airflow-Lib/osdu_airflow/ops.py",
    );
  });

  it("leaves a path outside every checkout alone", () => {
    const elsewhere = path.join(path.sep, "elsewhere", "x.py");
    expect(toChangePath(feature, elsewhere)).toBe(elsewhere);
  });
});
