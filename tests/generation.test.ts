import { describe, expect, it } from "vitest";
import { Generation } from "../src/review/generation.js";

describe("Generation", () => {
  it("treats the latest ticket as current", () => {
    const generation = new Generation();
    const first = generation.next();
    expect(generation.isCurrent(first)).toBe(true);
  });

  it("retires an older ticket once a newer run starts", () => {
    const generation = new Generation();
    const first = generation.next();
    const second = generation.next();

    expect(generation.isCurrent(first)).toBe(false);
    expect(generation.isCurrent(second)).toBe(true);
  });

  it("reports the current ticket", () => {
    const generation = new Generation();
    generation.next();
    const latest = generation.next();
    expect(generation.current).toBe(latest);
  });
});
