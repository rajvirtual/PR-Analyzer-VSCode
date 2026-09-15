import { spawn } from "node:child_process";
import { NO_PROMPT, reportGitCall } from "./run-git.js";

/**
 * Every blob a review needs, out of one git process.
 *
 * `git show` costs a process per file side, and they were being awaited one at a
 * time: a fifty-file review spent seconds in process creation alone before anything
 * could be drawn. `cat-file --batch` answers the whole list down one pipe, and states
 * each blob's size before its content, so an oversized one is never decoded.
 */
export interface Blob {
  text?: string;
  unavailable?: "too-large" | "binary";
}

/** Only the head of a file needs checking: a binary one has a NUL byte early. */
const BINARY_SNIFF_BYTES = 8 * 1024;

const OID = /^[0-9a-f]{7,64}$/;

export function isBlobOid(value: string | undefined): value is string {
  return value !== undefined && OID.test(value) && !/^0+$/.test(value);
}

function decode(content: Buffer, size: number, maxBytes: number): Blob {
  if (size > maxBytes) return { unavailable: "too-large" };
  if (content.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { unavailable: "binary" };
  return { text: content.toString("utf8") };
}

export async function readBlobs(
  cwd: string,
  oids: readonly string[],
  maxBytes: number,
): Promise<Map<string, Blob>> {
  const wanted = [...new Set(oids.filter(isBlobOid))];
  const results = new Map<string, Blob>();
  if (wanted.length === 0) return results;

  const started = Date.now();
  const args = ["cat-file", "--batch"];

  await new Promise<void>((resolve) => {
    const child = spawn("git", args, { cwd, env: NO_PROMPT });
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let pending: { oid: string; size: number } | null = null;
    let done = false;

    const finish = (): void => {
      if (done) return;
      done = true;
      child.kill();
      resolve();
    };

    child.on("error", finish);
    child.on("close", finish);
    child.stdin.on("error", () => {
      // A batch that ends early closes the pipe under us; the results so far still stand.
    });

    child.stdout.on("data", (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

      for (;;) {
        if (!pending) {
          const newline = buffer.indexOf(0x0a);
          if (newline < 0) break;
          const [oid, type, size] = buffer.subarray(0, newline).toString("utf8").split(" ");
          buffer = buffer.subarray(newline + 1);
          // "<oid> missing" for anything this repository does not have.
          if (!oid || !type || size === undefined) continue;
          pending = { oid, size: Number(size) };
        }

        // The content is followed by a newline git adds, which is not part of the blob.
        if (buffer.length < pending.size + 1) break;
        results.set(pending.oid, decode(buffer.subarray(0, pending.size), pending.size, maxBytes));
        buffer = buffer.subarray(pending.size + 1);
        pending = null;
      }

      if (results.size >= wanted.length) finish();
    });

    child.stdin.write(`${wanted.join("\n")}\n`);
    child.stdin.end();
  });

  reportGitCall({
    cwd,
    args: [...args, `<${wanted.length} blobs>`],
    ms: Date.now() - started,
    ok: results.size > 0,
  });

  return results;
}
