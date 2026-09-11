import type { ChangedFile } from "../model/changeset.js";
import { diffLines } from "./unified-diff.js";

/**
 * What actually changed in a file, in the form a reader would grep for.
 *
 * A model handed a file list can only describe the shape of a change; handed the
 * declarations that appeared and the conditions that were rewritten, it can say
 * what the change does.
 */
export interface ChangeDigest {
  path: string;
  changeType: string;
  /** Types and members introduced by this change. */
  added: string[];
  /** Types and members it removed. */
  removed: string[];
  /** Conditions, calls and returns whose logic was rewritten, as `- old` / `+ new`. */
  rewritten: string[];
  addedLines: number;
  removedLines: number;
}

const DECLARATION =
  /\b(?:public|private|protected|internal)\b.*\b(?:class|record|struct|enum|interface|delegate)\s+([A-Za-z_][\w<>]*)/;
const MEMBER =
  /\b(?:public|private|protected|internal)\b(?:\s+\w+)*\s+[\w<>,\[\]?]+\s+([A-Za-z_]\w*)\s*[(={]/;
const LOGIC = /^\s*(?:if|else if|return|await|throw|switch|case|for|foreach|while)\b/;

function summarise(line: string): string {
  return line.trim().replace(/\s+/g, " ").slice(0, 160);
}

export function digestFile(file: ChangedFile, limits = { added: 12, rewritten: 10 }): ChangeDigest {
  const before = (file.before ?? "").split("\n");
  const after = (file.after ?? "").split("\n");
  const lines = diffLines(before, after);

  const added: string[] = [];
  const removed: string[] = [];
  const rewritten: string[] = [];
  let addedLines = 0;
  let removedLines = 0;

  for (const line of lines) {
    if (line.kind === "context") continue;
    if (line.kind === "add") addedLines += 1;
    else removedLines += 1;

    const declaration = DECLARATION.exec(line.text) ?? MEMBER.exec(line.text);
    if (declaration) {
      const target = line.kind === "add" ? added : removed;
      if (target.length < limits.added) target.push(summarise(line.text));
      continue;
    }

    if (LOGIC.test(line.text) && rewritten.length < limits.rewritten * 2) {
      rewritten.push(`${line.kind === "add" ? "+" : "-"} ${summarise(line.text)}`);
    }
  }

  return {
    path: file.path,
    changeType: file.changeType,
    added,
    removed,
    rewritten: rewritten.slice(0, limits.rewritten * 2),
    addedLines,
    removedLines,
  };
}

/** Renders digests, largest change first, within a character budget. */
export function renderDigests(files: ChangedFile[], budget = 40_000): string {
  const digests = files
    .map((file) => digestFile(file))
    .sort((a, b) => b.addedLines + b.removedLines - (a.addedLines + a.removedLines));

  const blocks: string[] = [];
  let used = 0;

  for (const digest of digests) {
    const parts = [`### ${digest.path}  (${digest.changeType}, +${digest.addedLines}/-${digest.removedLines})`];
    if (digest.added.length > 0) parts.push(`added:\n${digest.added.map((line) => `  ${line}`).join("\n")}`);
    if (digest.removed.length > 0) parts.push(`removed:\n${digest.removed.map((line) => `  ${line}`).join("\n")}`);
    if (digest.rewritten.length > 0) parts.push(`logic:\n${digest.rewritten.map((line) => `  ${line}`).join("\n")}`);

    const block = parts.join("\n");
    if (used + block.length > budget) {
      blocks.push(`### ${digest.path}  (${digest.changeType}, +${digest.addedLines}/-${digest.removedLines})`);
      used += 80;
      continue;
    }
    blocks.push(block);
    used += block.length;
  }

  return blocks.join("\n\n");
}
