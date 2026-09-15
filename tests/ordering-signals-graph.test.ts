import { describe, expect, it } from "vitest";
import type { ChangedFile } from "../src/model/changeset.js";
import { computeSignals } from "../src/analysis/ordering-signals.js";

/**
 * The whole edge set, in one assertion.
 *
 * computeSignals was rewritten from a regex scan of every file against every other
 * file into a single tokenizing pass. The rewrite is only correct if the graph it
 * produces is identical, so this snapshots the graph rather than spot-checking it.
 */

function file(path: string, after: string): ChangedFile {
  return { path, changeType: "edit", before: "", after };
}

function graphOf(files: ChangedFile[]): Record<string, { referencedBy: string[]; references: string[] }> {
  const contents = new Map(files.map((entry) => [entry.path, entry.after ?? ""]));
  const signals = computeSignals(files, contents);
  return Object.fromEntries(
    signals.map((signal) => [
      signal.path,
      { referencedBy: signal.referencedBy, references: signal.references },
    ]),
  );
}

describe("computeSignals builds the same graph however it matches", () => {
  const files = [
    file(
      "src/capacity-profile.ts",
      "export class CapacityProfile { reserve() {} }\nexport const DefaultSlots = 5;\n",
    ),
    file(
      "src/submit-order.ts",
      "import { CapacityProfile } from './capacity-profile.js';\nclass SubmitOrder { run(p: CapacityProfile) { return p.reserve(); } }\n",
    ),
    file(
      "src/audit.ts",
      "// Emits an event. Mentions DefaultSlots in prose only.\nexport class AuditTrail {}\n",
    ),
    file("docs/notes.md", "SubmitOrder is described here for the reader.\n"),
  ];

  it("matches whole words, not incidental substrings, and ignores prose", () => {
    expect(graphOf(files)).toEqual({
      "src/capacity-profile.ts": {
        referencedBy: ["src/submit-order.ts"],
        references: [],
      },
      "src/submit-order.ts": {
        referencedBy: ["docs/notes.md"],
        references: ["src/capacity-profile.ts"],
      },
      // audit.ts names DefaultSlots in a comment only, which is not a call.
      "src/audit.ts": { referencedBy: [], references: [] },
      "docs/notes.md": { referencedBy: [], references: ["src/submit-order.ts"] },
    });
  });

  it("does not link a name that only appears inside a longer identifier", () => {
    const shadowed = [
      file("src/thing.ts", "export class Capacity {}\n"),
      file("src/other.ts", "const CapacityProfileBuilder = 1;\n"),
    ];

    expect(graphOf(shadowed)["src/thing.ts"]?.referencedBy).toEqual([]);
  });

  it("links two files that declare the same name, not just the first", () => {
    const twins = [
      file("src/a.ts", "export class Shared {}\n"),
      file("src/b.ts", "export class Shared {}\n"),
      file("src/c.ts", "new Shared();\n"),
    ];

    // Each twin also names the other's declaration, so they link to each other too.
    const graph = graphOf(twins);
    expect(graph["src/a.ts"]?.referencedBy).toEqual(["src/b.ts", "src/c.ts"]);
    expect(graph["src/b.ts"]?.referencedBy).toEqual(["src/a.ts", "src/c.ts"]);
    expect(graph["src/c.ts"]?.references).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("stays quiet about a file with nothing readable on either side", () => {
    const empty = [file("src/a.ts", "export class Alpha {}\n"), file("src/blank.ts", "")];
    const graph = graphOf(empty);
    expect(graph["src/a.ts"]?.referencedBy).toEqual([]);
    expect(graph["src/blank.ts"]?.references).toEqual([]);
  });

  it("orders both sides of every edge by the file list", () => {
    const many = [
      file("src/owner.ts", "export class Owner {}\n"),
      file("src/one.ts", "new Owner();\n"),
      file("src/two.ts", "new Owner();\n"),
      file("src/three.ts", "new Owner();\n"),
    ];

    expect(graphOf(many)["src/owner.ts"]?.referencedBy).toEqual([
      "src/one.ts",
      "src/two.ts",
      "src/three.ts",
    ]);
  });

  // This runs on the thread that paints the Files view, so it is a UI freeze when slow.
  // The old shape scanned every file's content once per other file; the bound here is
  // loose enough to survive a loaded CI worker and still catch a return to that.
  it("scans a 200-file change without a quadratic blow-up", () => {
    const body = "const filler = 1;\n".repeat(200);
    const many = Array.from({ length: 200 }, (_, index) =>
      file(
        `src/module-${index}.ts`,
        `export class Widget${index} {}\nnew Widget${(index + 1) % 200}();\n${body}`,
      ),
    );

    const started = performance.now();
    graphOf(many);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
