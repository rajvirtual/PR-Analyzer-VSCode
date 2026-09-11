import { describe, expect, it } from "vitest";
import { bearerHeader, looksLikePat, patHeader } from "../src/ado/auth-header.js";

describe("Azure DevOps authorization headers", () => {
  it("sends a brokered token as a bearer token", () => {
    expect(bearerHeader("abc.def")).toBe("Bearer abc.def");
  });

  it("sends a personal access token as a password with no user name", () => {
    const header = patHeader("s3cret");
    expect(header.startsWith("Basic ")).toBe(true);

    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString();
    expect(decoded).toBe(":s3cret");
  });

  it("does not confuse the two schemes", () => {
    expect(patHeader("token")).not.toBe(bearerHeader("token"));
  });
});

describe("looksLikePat", () => {
  it("accepts a token of a plausible length", () => {
    expect(looksLikePat("a".repeat(52))).toBe(true);
  });

  it("rejects something too short to be a token", () => {
    expect(looksLikePat("password")).toBe(false);
  });

  it("rejects a pasted sentence, which is the usual mistake", () => {
    expect(looksLikePat("my personal access token is here")).toBe(false);
  });

  it("ignores surrounding whitespace from the clipboard", () => {
    expect(looksLikePat(`  ${"b".repeat(30)}\n`)).toBe(true);
  });
});
