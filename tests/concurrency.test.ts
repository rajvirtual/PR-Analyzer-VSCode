import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../src/analysis/concurrency.js";

const tick = (ms = 2): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("mapWithConcurrency", () => {
  it("keeps the input order regardless of finish order", async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => {
      await tick(n === 1 ? 8 : 1); // the first finishes last
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8]);
  });

  it("never runs more than the limit at once", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("stops pulling new work once cancelled", async () => {
    let calls = 0;
    let cancelled = false;
    await mapWithConcurrency(
      Array.from({ length: 30 }, (_, i) => i),
      2,
      async () => {
        calls += 1;
        if (calls >= 4) cancelled = true;
        await tick();
      },
      () => cancelled,
    );
    expect(calls).toBeLessThan(30);
  });

  it("handles an empty list", async () => {
    expect(await mapWithConcurrency([], 4, async (n) => n)).toEqual([]);
  });
});
