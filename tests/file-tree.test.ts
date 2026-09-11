import { describe, expect, it } from "vitest";
import { buildFileTree, flatten, type FolderNode } from "../src/analysis/file-tree.js";
import type { ChangedFile, Step } from "../src/model/changeset.js";

function step(order: number, path: string, title?: string): Step {
  const file: ChangedFile = { path, changeType: "edit", before: "", after: "" };
  return { id: `s${order}`, order, file, role: "logic", title };
}

describe("buildFileTree", () => {
  it("sorts alphabetically, the way a pull request page does", () => {
    const tree = buildFileTree([step(1, "zoo/first.cs"), step(2, "alpha/second.cs")]);

    expect(tree.map((node) => (node as FolderNode).label)).toEqual(["alpha", "zoo"]);
  });

  it("puts folders before files", () => {
    const tree = buildFileTree([step(1, "README.md"), step(2, "src/a.cs")]);
    expect(tree.map((node) => node.kind)).toEqual(["folder", "file"]);
  });

  it("sorts files within a folder by name, not by step", () => {
    const root = buildFileTree([
      step(1, "src/zebra.cs"),
      step(2, "src/apple.cs"),
    ])[0] as FolderNode;

    expect(root.children.map((child) => (child as { step: Step }).step.file.path)).toEqual([
      "src/apple.cs",
      "src/zebra.cs",
    ]);
  });

  it("does not claim to preserve the reading order", () => {
    const steps = [
      step(1, "src/Host/coordinator.cs"),
      step(2, "src/Eck/sizing.cs"),
      step(3, "src/Host/publisher.cs"),
    ];

    // Grouping reorders: this is why the numbers do not lead the label in this view.
    expect(flatten(buildFileTree(steps)).map((s) => s.order)).toEqual([2, 1, 3]);
  });

  it("collapses a chain of folders holding one child each", () => {
    const tree = buildFileTree([step(1, "deploy/charts/es/templates/crd.yaml")]);

    expect(tree).toHaveLength(1);
    expect((tree[0] as FolderNode).label).toBe("deploy/charts/es/templates");
    expect((tree[0] as FolderNode).children).toHaveLength(1);
  });

  it("stops collapsing where the tree actually branches", () => {
    const tree = buildFileTree([step(1, "src/api/one.cs"), step(2, "src/core/two.cs")]);

    const root = tree[0] as FolderNode;
    expect(root.label).toBe("src");
    expect(root.children.map((child) => (child as FolderNode).label)).toEqual(["api", "core"]);
  });

  it("counts the files below a folder and the span they cover", () => {
    const root = buildFileTree([
      step(1, "src/a.cs"),
      step(5, "src/b.cs"),
      step(9, "src/nested/c.cs"),
    ])[0] as FolderNode;

    expect(root.fileCount).toBe(3);
    expect(root.order).toBe(1);
    expect(root.lastOrder).toBe(9);
  });

  it("keeps files at the repository root", () => {
    const tree = buildFileTree([step(1, "README.md"), step(2, "src/a.cs")]);
    expect(tree.some((node) => node.kind === "file")).toBe(true);
  });

  it("sorts case-insensitively, so casing does not split a folder listing", () => {
    const root = buildFileTree([
      step(1, "src/Zebra.cs"),
      step(2, "src/apple.cs"),
    ])[0] as FolderNode;

    expect(
      root.children.map((child) => (child as { step: Step }).step.file.path.split("/").pop()),
    ).toEqual(["apple.cs", "Zebra.cs"]);
  });
});
