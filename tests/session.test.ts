import { describe, expect, it } from "vitest";
import type { ChangeSet, ChangedFile } from "../src/model/changeset.js";
import { buildSteps, hunksOf, ReviewSession } from "../src/session.js";

function file(path: string, before: string | null, after: string | null): ChangedFile {
  return {
    path,
    changeType: before === null ? "add" : after === null ? "delete" : "edit",
    before,
    after,
  };
}

function changeSet(files: ChangedFile[]): ChangeSet {
  return {
    repositoryRoot: "/repo",
    label: "feature vs origin/main",
    baseRef: "origin/main",
    mergeBase: "abc123",
    files,
    skipped: [],
  };
}

describe("buildSteps effort", () => {
  it("demotes a complex rating on a tiny change to involved", () => {
    const steps = buildSteps(changeSet([file("x.ts", "a\nb\nc", "a\nB\nc")]), [
      { path: "x.ts", title: "t", effort: "complex" },
    ]);
    expect(steps[0]?.effort).toBe("involved");
  });

  it("keeps a complex rating when the change is substantial", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const after = Array.from({ length: 20 }, (_, i) => `LINE ${i} changed`).join("\n");
    const steps = buildSteps(changeSet([file("x.ts", before, after)]), [
      { path: "x.ts", title: "t", effort: "complex" },
    ]);
    expect(steps[0]?.effort).toBe("complex");
  });

  it("promotes a routine rating on a large change to involved", () => {
    const before = Array.from({ length: 200 }, (_, i) => `a ${i}`).join("\n");
    const after = Array.from({ length: 200 }, (_, i) => `b ${i}`).join("\n");
    const steps = buildSteps(changeSet([file("Models.cs", before, after)]), [
      { path: "Models.cs", title: "t", effort: "routine" },
    ]);
    expect(steps[0]?.effort).toBe("involved");
  });

  it("leaves a small routine change alone", () => {
    const steps = buildSteps(changeSet([file("Dto.cs", "a\nb", "a\nB")]), [
      { path: "Dto.cs", title: "t", effort: "routine" },
    ]);
    expect(steps[0]?.effort).toBe("routine");
  });
});

describe("hunksOf", () => {
  it("groups adjacent changed lines into one hunk", () => {
    const before = "a\nb\nc\nd\ne";
    const after = "a\nB\nC\nd\ne";

    expect(hunksOf(file("x.ts", before, after))).toEqual([{ startLine: 2, endLine: 3 }]);
  });

  it("separates changes that are far apart", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const after = before.replace("line 2", "two").replace("line 18", "eighteen");

    const hunks = hunksOf(file("x.ts", before, after));

    expect(hunks).toHaveLength(2);
    expect(hunks[0].startLine).toBe(2);
    expect(hunks[1].startLine).toBe(18);
  });

  it("reports no hunks for a deleted file", () => {
    expect(hunksOf(file("x.ts", "a\nb", null))).toEqual([]);
  });

  it("anchors a deletion-only region so it can still be reached", () => {
    // b and c are removed with nothing added; the old code produced no hunk at all.
    const hunks = hunksOf(file("x.ts", "a\nb\nc\nd", "a\nd"));
    expect(hunks).toHaveLength(1);
    expect(hunks[0].startLine).toBeGreaterThanOrEqual(1);
  });
});

describe("ReviewSession navigation", () => {
  const files = [
    file("src/a.ts", "a\nb\nc", "a\nB\nc"),
    file("src/b.ts", "x\ny\nz\nw\nv\nu\nt", "x\nY\nz\nw\nv\nU\nt"),
  ];
  const set = changeSet(files);

  function session(): ReviewSession {
    return new ReviewSession(set, buildSteps(set));
  }

  it("walks the changes inside a file before moving on", () => {
    const review = session();
    review.selectStep(review.steps[1].id);
    const stepId = review.currentStep?.id;

    expect(review.next()).toBe(true);
    expect(review.currentStep?.id).toBe(stepId);
    expect(review.position.hunk).toBe(1);

    expect(review.next()).toBe(true);
    expect(review.currentStep?.id).toBe(stepId);
    expect(review.position.hunk).toBe(2);
  });

  it("counts each file opened towards coverage", () => {
    const review = session();
    expect(review.coverage()).toEqual({ files: 2, visited: 0, omitted: 0 });

    review.selectStep(review.steps[0].id);
    expect(review.coverage().visited).toBe(1);

    review.selectStep(review.steps[1].id);
    expect(review.coverage().visited).toBe(2);
  });

  it("resumes a saved file and marks visited by path", () => {
    const review = session();
    review.restore({ currentPath: "src/b.ts", visited: ["src/a.ts", "src/b.ts"] });
    expect(review.currentPath()).toBe("src/b.ts");
    expect(review.coverage().visited).toBe(2);
  });

  it("ignores a saved file the change no longer has", () => {
    const review = session();
    review.restore({ currentPath: "src/gone.ts", visited: ["src/gone.ts"] });
    expect(review.coverage().visited).toBe(0);
  });

  // Re-ordering pins what the reader is looking at. A file remembered from a previous
  // sitting is not that, and pinning it rebuilt a stale order over a corrected one.
  it("separates what was opened now from what a checkpoint remembered", () => {
    const review = session();
    review.restore({ currentPath: "src/b.ts", visited: ["src/a.ts", "src/b.ts"] });

    expect(review.visitedPaths()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(review.openedPaths()).toEqual([]);

    review.selectStep(review.steps[0].id);
    expect(review.openedPaths()).toEqual(["src/a.ts"]);
    // The restored marks survive: they are what the reader has read, just not now.
    expect(review.visitedPaths()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("advances to the next step once a file's changes run out", () => {
    const review = session();
    review.selectStep(review.steps[0].id);
    const first = review.currentStep?.id;

    while (review.position.hunk < review.position.hunks) review.next();

    expect(review.next()).toBe(true);
    expect(review.currentStep?.id).not.toBe(first);
    expect(review.position.hunk).toBe(1);
  });

  it("stops at the very end rather than wrapping", () => {
    const review = session();
    review.selectStep(review.steps[review.steps.length - 1].id, "last");

    expect(review.next()).toBe(false);
  });

  it("stops at the very start rather than wrapping", () => {
    const review = session();
    review.selectStep(review.steps[0].id);

    expect(review.previous()).toBe(false);
  });

  it("enters the previous step at its last change when moving backwards", () => {
    const review = session();
    review.selectStep(review.steps[1].id);

    expect(review.previous()).toBe(true);
    expect(review.currentStep?.id).toBe(review.steps[0].id);
    expect(review.position.hunk).toBe(review.position.hunks);
  });
});

describe("buildSteps", () => {
  it("orders every changed file exactly once", () => {
    const set = changeSet([
      file("src/caller.ts", "old", "import { Thing } from './thing';\nnew Thing();"),
      file("src/thing.ts", "old", "export class Thing {}"),
      file("tests/thing.test.ts", "old", "import { Thing } from '../src/thing';"),
    ]);

    const steps = buildSteps(set);

    expect(steps).toHaveLength(3);
    expect(new Set(steps.map((step) => step.file.path)).size).toBe(3);
    expect(steps.map((step) => step.order)).toEqual([1, 2, 3]);
  });

  it("puts tests after the code they exercise", () => {
    const set = changeSet([
      file("tests/thing.test.ts", "old", "import { Thing } from '../src/thing';\nnew Thing();"),
      file("src/thing.ts", "old", "export class Thing {}"),
    ]);

    const steps = buildSteps(set);
    const testIndex = steps.findIndex((step) => step.file.path.startsWith("tests/"));
    const sourceIndex = steps.findIndex((step) => step.file.path === "src/thing.ts");

    expect(testIndex).toBeGreaterThan(sourceIndex);
  });
});
