import { describe, expect, it } from "vitest";
import type { ChangedFile } from "../src/model/changeset.js";
import { digestFile, renderDigests } from "../src/analysis/change-digest.js";

function file(before: string | null, after: string | null, path = "src/Thing.cs"): ChangedFile {
  return {
    path,
    changeType: before === null ? "add" : after === null ? "delete" : "edit",
    before,
    after,
  };
}

describe("digestFile", () => {
  it("finds types the change introduced", () => {
    const digest = digestFile(
      file("namespace N\n{\n}\n", "namespace N\n{\n    public static class EsPoolRoleRegistry\n    {\n    }\n}\n"),
    );

    expect(digest.added.join("\n")).toContain("class EsPoolRoleRegistry");
  });

  it("finds types the change removed", () => {
    const digest = digestFile(
      file("public sealed class DeveloperVerifier\n", "public sealed class Verifier\n"),
    );

    expect(digest.removed.join("\n")).toContain("DeveloperVerifier");
    expect(digest.added.join("\n")).toContain("class Verifier");
  });

  // The condition this whole change turns on, and what the file list could never show.
  it("captures a rewritten condition as before and after", () => {
    const digest = digestFile(
      file(
        '            if (!string.Equals(desired.CommercialSku, Contract.DeveloperCommercialSku, StringComparison.Ordinal))\n',
        '            if (!string.Equals(desired.ProfileRef?.Name, profile.Name, StringComparison.Ordinal))\n',
      ),
    );

    expect(digest.rewritten.some((line) => line.startsWith("-") && line.includes("CommercialSku"))).toBe(
      true,
    );
    expect(digest.rewritten.some((line) => line.startsWith("+") && line.includes("ProfileRef"))).toBe(
      true,
    );
  });

  it("counts what moved on each side", () => {
    const digest = digestFile(file("a\nb\nc\n", "a\nB\nc\nd\n"));

    expect(digest.addedLines).toBe(2);
    expect(digest.removedLines).toBe(1);
  });

  it("treats an added file as all additions", () => {
    const digest = digestFile(file(null, "public class New\n{\n}\n"));

    expect(digest.removedLines).toBe(0);
    expect(digest.added.join("\n")).toContain("class New");
  });

  it("ignores unchanged declarations", () => {
    const digest = digestFile(file("public class Same\n{\n}\n", "public class Same\n{\n    // note\n}\n"));

    expect(digest.added.join("\n")).not.toContain("class Same");
  });

  it("bounds how much a single noisy file can contribute", () => {
    const before = Array.from({ length: 200 }, (_, i) => `    if (x == ${i})`).join("\n");
    const digest = digestFile(file(before, ""), { added: 3, rewritten: 4 });

    expect(digest.rewritten.length).toBeLessThanOrEqual(8);
  });
});

describe("renderDigests", () => {
  it("puts the largest change first, because that is where the story is", () => {
    const small = file("a\n", "a\nb\n", "src/Small.cs");
    const large = file("a\n", `a\n${Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")}\n`, "src/Large.cs");

    const rendered = renderDigests([small, large]);

    expect(rendered.indexOf("src/Large.cs")).toBeLessThan(rendered.indexOf("src/Small.cs"));
  });

  it("keeps every file present even when the budget runs out", () => {
    const files = Array.from({ length: 30 }, (_, index) =>
      file("a\n", `a\n${"x\n".repeat(100)}`, `src/File${index}.cs`),
    );

    const rendered = renderDigests(files, 2_000);

    for (const entry of files) {
      expect(rendered).toContain(entry.path);
    }
  });

  it("reports the size of each change", () => {
    expect(renderDigests([file("a\n", "a\nb\n", "src/X.cs")])).toContain("+1/-0");
  });
});
