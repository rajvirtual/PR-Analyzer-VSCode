import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isBlobOid, readBlobs } from "../src/git/cat-file.js";

const exec = promisify(execFile);

/**
 * The batch protocol, against real git.
 *
 * Framing is the whole risk here — a header line, then exactly size bytes, then a
 * newline git adds. Mis-counting by one byte silently shifts every later blob, which
 * a hand-rolled fake would happily agree with.
 */
let repo = "";
const oids: Record<string, string> = {};

async function git(args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd: repo, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "pr-analyzer-cat-file-"));
  await git(["init", "--quiet"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);

  await writeFile(join(repo, "small.txt"), "hello\nworld\n");
  await writeFile(join(repo, "utf8.txt"), "caf\u00e9 \u2014 na\u00efve\n");
  await writeFile(join(repo, "big.txt"), "x".repeat(50_000));
  await writeFile(join(repo, "binary.bin"), Buffer.from([0x41, 0x00, 0x42, 0x43]));

  await git(["add", "."]);
  await git(["commit", "--quiet", "-m", "fixture"]);

  for (const name of ["small.txt", "utf8.txt", "big.txt", "binary.bin"]) {
    oids[name] = await git(["rev-parse", `HEAD:${name}`]);
  }
}, 30_000);

afterAll(async () => {
  if (repo) await rm(repo, { recursive: true, force: true });
});

describe("isBlobOid", () => {
  it("rejects the all-zero oid git uses for a side that is not a blob", () => {
    expect(isBlobOid("0".repeat(40))).toBe(false);
    expect(isBlobOid(undefined)).toBe(false);
    expect(isBlobOid("not-an-oid")).toBe(false);
    expect(isBlobOid("a".repeat(40))).toBe(true);
  });
});

describe("readBlobs", () => {
  it("reads every blob from one batch, framed correctly", async () => {
    const blobs = await readBlobs(
      repo,
      [oids["small.txt"]!, oids["utf8.txt"]!, oids["big.txt"]!],
      1024 * 1024,
    );

    expect(blobs.get(oids["small.txt"]!)?.text).toBe("hello\nworld\n");
    expect(blobs.get(oids["utf8.txt"]!)?.text).toBe("café — naïve\n");
    expect(blobs.get(oids["big.txt"]!)?.text).toHaveLength(50_000);
  });

  it("names a blob too large rather than handing back half a file", async () => {
    const blobs = await readBlobs(repo, [oids["big.txt"]!, oids["small.txt"]!], 1024);

    expect(blobs.get(oids["big.txt"]!)).toEqual({ unavailable: "too-large" });
    // The stream stays in step, so the blob after an oversized one still arrives.
    expect(blobs.get(oids["small.txt"]!)?.text).toBe("hello\nworld\n");
  });

  it("names a binary blob rather than decoding it as text", async () => {
    const blobs = await readBlobs(repo, [oids["binary.bin"]!], 1024 * 1024);
    expect(blobs.get(oids["binary.bin"]!)).toEqual({ unavailable: "binary" });
  });

  it("returns without the missing one rather than hanging on it", async () => {
    const blobs = await readBlobs(repo, ["b".repeat(40), oids["small.txt"]!], 1024 * 1024);

    expect(blobs.has("b".repeat(40))).toBe(false);
    expect(blobs.get(oids["small.txt"]!)?.text).toBe("hello\nworld\n");
  }, 15_000);

  it("spawns nothing when there is nothing to read", async () => {
    expect((await readBlobs(repo, [], 1024)).size).toBe(0);
    expect((await readBlobs(repo, ["0".repeat(40)], 1024)).size).toBe(0);
  });
});
