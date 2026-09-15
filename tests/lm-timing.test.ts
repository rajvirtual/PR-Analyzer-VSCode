import { describe, expect, it } from "vitest";
import {
  formatModelPhases,
  ModelTimer,
  onModelCall,
  type ModelPhases,
} from "../src/lm/lm-timing.js";

/** A clock the test drives, so the phases are exact rather than approximately now. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let value = 1000;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

function capture(run: () => void): ModelPhases[] {
  const seen: ModelPhases[] = [];
  const subscription = onModelCall((phases) => seen.push(phases));
  try {
    run();
  } finally {
    subscription.dispose();
  }
  return seen;
}

describe("ModelTimer", () => {
  it("measures each phase from the start of the operation", () => {
    const time = clock();
    const seen = capture(() => {
      const timer = new ModelTimer("read-through", time.now);
      timer.model("test-model");
      time.advance(120);
      timer.sent();
      time.advance(2400);
      timer.firstToken();
      time.advance(45_000);
      timer.lastToken(6);
      time.advance(80);
      timer.rendered();
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      label: "read-through",
      model: "test-model",
      sent: 120,
      firstToken: 2520,
      lastToken: 47_520,
      rendered: 47_600,
      toolCalls: 6,
    });
  });

  it("keeps the first token, not the latest one", () => {
    const time = clock();
    const seen = capture(() => {
      const timer = new ModelTimer("diagram", time.now);
      time.advance(500);
      timer.firstToken();
      time.advance(9000);
      timer.firstToken();
      timer.rendered();
    });

    expect(seen[0]?.firstToken).toBe(500);
  });

  it("reports once, however many times an end is marked", () => {
    const time = clock();
    const seen = capture(() => {
      const timer = new ModelTimer("explain", time.now);
      timer.rendered();
      timer.rendered();
      timer.cancelled();
    });

    expect(seen).toHaveLength(1);
  });

  it("reports a cancelled view, so an abandoned one is not silently missing", () => {
    const time = clock();
    const seen = capture(() => {
      const timer = new ModelTimer("read-through", time.now);
      time.advance(300);
      timer.sent();
      timer.cancelled();
    });

    expect(seen[0]).toMatchObject({ cancelled: true, sent: 300 });
    expect(seen[0]?.rendered).toBeUndefined();
  });

  it("survives a listener that throws", () => {
    const subscription = onModelCall(() => {
      throw new Error("broken");
    });
    try {
      expect(() => new ModelTimer("read-through").rendered()).not.toThrow();
    } finally {
      subscription.dispose();
    }
  });
});

describe("formatModelPhases", () => {
  it("reads as one line in the order the phases happen", () => {
    expect(
      formatModelPhases({
        label: "read-through",
        model: "test-model",
        sent: 120,
        firstToken: 2520,
        lastToken: 47_520,
        rendered: 47_600,
        toolCalls: 6,
      }),
    ).toBe(
      "read-through · test-model · sent 120ms · first token 2.5s · last token 47.5s · rendered 47.6s · 6 lookups",
    );
  });

  it("says so when nothing ever arrived, rather than omitting the phase", () => {
    expect(formatModelPhases({ label: "diagram", model: "test-model" })).toContain("no tokens");
  });

  it("names a cancelled view", () => {
    expect(
      formatModelPhases({ label: "diagram", model: "m", firstToken: 900, cancelled: true }),
    ).toContain("cancelled");
  });
});
