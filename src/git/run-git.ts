import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Every git command this extension runs, and what came back.
 *
 * Git is where the work silently goes wrong: a missing clone, a ref that was never
 * fetched, an auth prompt that cannot be answered. Recording each call turns "it
 * failed" into a line the reader can read, and hand to someone else.
 */

export interface GitCall {
  cwd: string;
  args: string[];
  ms: number;
  ok: boolean;
  /** Present when the command failed, trimmed to what is worth reading. */
  error?: string;
}

type Listener = (call: GitCall) => void;

const listeners = new Set<Listener>();

export function onGitCall(listener: Listener): { dispose(): void } {
  listeners.add(listener);
  return { dispose: () => listeners.delete(listener) };
}

/** Never wait on a credential prompt: no terminal is attached, so it would hang. */
export const NO_PROMPT = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

const MAX_BUFFER = 64 * 1024 * 1024;

export async function runGitRaw(cwd: string, args: string[]): Promise<string> {
  const started = Date.now();
  try {
    const { stdout } = await exec("git", args, { cwd, env: NO_PROMPT, maxBuffer: MAX_BUFFER });
    report({ cwd, args, ms: Date.now() - started, ok: true });
    return stdout;
  } catch (error) {
    report({
      cwd,
      args,
      ms: Date.now() - started,
      ok: false,
      error: describe(error),
    });
    throw error;
  }
}

/** Trimmed, which is what every caller wants except the ones reading a diff. */
export async function runGit(cwd: string, args: string[]): Promise<string> {
  return (await runGitRaw(cwd, args)).trim();
}

function report(call: GitCall): void {
  for (const listener of listeners) {
    try {
      listener(call);
    } catch {
      // A broken listener must not take the git call down with it.
    }
  }
}

/** For git run outside this module, which should still show up in the log. */
export function reportGitCall(call: GitCall): void {
  report(call);
}

function describe(error: unknown): string {
  const parts = error as { stderr?: string; message?: string };
  const stderr = parts.stderr?.trim();
  return (stderr && stderr.length > 0 ? stderr : parts.message ?? String(error))
    .split("\n")
    .slice(0, 4)
    .join("\n");
}

/** Rendered the way it would be typed, so it can be pasted into a terminal. */
export function formatCall(call: GitCall): string {
  const status = call.ok ? "" : "  ← failed";
  return `$ git ${call.args.map(quote).join(" ")}\n  in ${call.cwd}  (${call.ms}ms)${status}${
    call.error ? `\n${call.error.replace(/^/gm, "  ! ")}` : ""
  }`;
}

function quote(argument: string): string {
  return /[\s"']/.test(argument) ? JSON.stringify(argument) : argument;
}
