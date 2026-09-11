import { describe, expect, it } from "vitest";
import { chooseModel } from "../src/lm/model-preference.js";

function model(id: string, name = id, family = id) {
  return { id, name, family };
}

const available = [
  model("gpt-4o", "GPT-4o", "gpt-4o"),
  model("claude-sonnet-4", "Claude Sonnet 4", "claude-sonnet-4"),
  model("claude-opus-5", "Claude Opus 5", "claude-opus-5"),
];

describe("chooseModel", () => {
  // Reordering silently changed which model drew the diagram, so the default is
  // whatever the platform offers first, as it was when the output was accepted.
  it("takes the first model when no preference is set", () => {
    expect(chooseModel(available)?.id).toBe("gpt-4o");
  });

  it("honours an exact id", () => {
    expect(chooseModel(available, "claude-opus-5")?.id).toBe("claude-opus-5");
  });

  it("honours a partial name, case-insensitively", () => {
    expect(chooseModel(available, "sonnet")?.id).toBe("claude-sonnet-4");
  });

  it("falls back to the first model when the preference matches nothing", () => {
    expect(chooseModel(available, "llama-9")?.id).toBe("gpt-4o");
  });

  it("returns undefined when no model is available", () => {
    expect(chooseModel([])).toBeUndefined();
  });

  it("treats an empty preference as no preference", () => {
    expect(chooseModel(available, "   ")?.id).toBe("gpt-4o");
  });
});
