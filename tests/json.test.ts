import { describe, expect, it } from "vitest";
import { escapeControlCharsInStrings, parseFirstJson } from "../src/lm/json.js";

describe("parseFirstJson", () => {
  it("parses a plain JSON object", () => {
    expect(parseFirstJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("recovers JSON that a model wrapped in prose and a code fence", () => {
    const reply = 'Here you go:\n```json\n{"summary":"ok"}\n```\nHope that helps.';
    expect(parseFirstJson(reply)).toEqual({ summary: "ok" });
  });

  it("recovers an object whose string value contains real newlines", () => {
    // What a model emits for an "example" written one value per line.
    const reply = '{"example":"a -> 1\n b -> 2\n c -> 3"}';
    expect(parseFirstJson<{ example: string }>(reply)).toEqual({
      example: "a -> 1\n b -> 2\n c -> 3",
    });
  });

  it("recovers an object whose string value contains a real tab", () => {
    const reply = '{"prose":"before\tafter"}';
    expect(parseFirstJson<{ prose: string }>(reply)).toEqual({ prose: "before\tafter" });
  });

  it("returns null when there is no JSON to find", () => {
    expect(parseFirstJson("no json here")).toBeNull();
  });
});

describe("escapeControlCharsInStrings", () => {
  it("escapes control characters only inside strings", () => {
    const repaired = escapeControlCharsInStrings('{"a":"x\ny"}');
    expect(repaired).toBe('{"a":"x\\ny"}');
    expect(JSON.parse(repaired)).toEqual({ a: "x\ny" });
  });

  it("leaves already-escaped sequences untouched", () => {
    const input = '{"a":"x\\ny"}';
    expect(escapeControlCharsInStrings(input)).toBe(input);
  });

  it("does not touch newlines between tokens outside strings", () => {
    const input = '{\n  "a": 1\n}';
    expect(escapeControlCharsInStrings(input)).toBe(input);
  });
});
