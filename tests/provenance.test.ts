import { describe, expect, it } from "vitest";
import { consultedNote, mergeConsulted } from "../src/lm/provenance.js";

describe("mergeConsulted", () => {
  it("keeps first-seen order and drops duplicates", () => {
    const one = mergeConsulted([], ["a.ts", "b.ts"]);
    const two = mergeConsulted(one, ["b.ts", "c.ts"]);
    expect(two).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("ignores empty additions", () => {
    expect(mergeConsulted(["a.ts"], undefined)).toEqual(["a.ts"]);
    expect(mergeConsulted(["a.ts"], [])).toEqual(["a.ts"]);
  });

  it("skips blank paths", () => {
    expect(mergeConsulted([], ["", "a.ts"])).toEqual(["a.ts"]);
  });
});

describe("consultedNote", () => {
  it("says nothing was read when the list is empty", () => {
    expect(consultedNote([])).toMatch(/from the change alone/);
  });

  it("names the files that were read", () => {
    expect(consultedNote(["src/a.ts", "src/b.ts"])).toBe(
      "Read alongside the change: src/a.ts, src/b.ts.",
    );
  });

  it("summarises the tail when many files were read", () => {
    const files = ["a", "b", "c", "d", "e", "f", "g"];
    expect(consultedNote(files)).toBe("Read alongside the change: a, b, c, d, e, and 2 more.");
  });
});
