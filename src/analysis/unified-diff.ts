/**
 * Line diff and unified-diff rendering.
 *
 * The model cannot say what a change does when it is shown only the file after
 * the change, so the before/after pair is turned into a real diff here.
 */

export type DiffLineKind = "context" | "add" | "remove";

export interface DiffLine {
  kind: DiffLineKind;
  /** 1-based line number in the before text, when the line exists there. */
  beforeLine?: number;
  /** 1-based line number in the after text, when the line exists there. */
  afterLine?: number;
  text: string;
}

/** Above this many LCS cells the exact diff is abandoned for a whole-block replacement. */
const MAX_CELLS = 4_000_000;

export function diffLines(before: string[], after: string[]): DiffLine[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start += 1;
  }

  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end += 1;
  }

  const beforeMiddle = before.slice(start, before.length - end);
  const afterMiddle = after.slice(start, after.length - end);

  const result: DiffLine[] = [];
  for (let index = 0; index < start; index += 1) {
    result.push({
      kind: "context",
      beforeLine: index + 1,
      afterLine: index + 1,
      text: before[index],
    });
  }

  const middle =
    beforeMiddle.length * afterMiddle.length > MAX_CELLS
      ? wholeBlock(beforeMiddle, afterMiddle, start)
      : lcsDiff(beforeMiddle, afterMiddle, start);
  result.push(...middle);

  for (let index = 0; index < end; index += 1) {
    result.push({
      kind: "context",
      beforeLine: before.length - end + index + 1,
      afterLine: after.length - end + index + 1,
      text: before[before.length - end + index],
    });
  }

  return result;
}

function wholeBlock(before: string[], after: string[], offset: number): DiffLine[] {
  return [
    ...before.map((text, index) => ({
      kind: "remove" as const,
      beforeLine: offset + index + 1,
      text,
    })),
    ...after.map((text, index) => ({
      kind: "add" as const,
      afterLine: offset + index + 1,
      text,
    })),
  ];
}

function lcsDiff(before: string[], after: string[], offset: number): DiffLine[] {
  const rows = before.length;
  const columns = after.length;

  // lengths[i][j] is the LCS length of before[i:] and after[j:].
  const lengths: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(columns + 1).fill(0),
  );
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      lengths[i][j] =
        before[i] === after[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (before[i] === after[j]) {
      result.push({
        kind: "context",
        beforeLine: offset + i + 1,
        afterLine: offset + j + 1,
        text: before[i],
      });
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      result.push({ kind: "remove", beforeLine: offset + i + 1, text: before[i] });
      i += 1;
    } else {
      result.push({ kind: "add", afterLine: offset + j + 1, text: after[j] });
      j += 1;
    }
  }
  while (i < rows) {
    result.push({ kind: "remove", beforeLine: offset + i + 1, text: before[i] });
    i += 1;
  }
  while (j < columns) {
    result.push({ kind: "add", afterLine: offset + j + 1, text: after[j] });
    j += 1;
  }

  return result;
}

/**
 * Renders changed regions with surrounding context, in unified-diff form.
 *
 * When `focus` is given only hunks touching that after-file range are kept, so a
 * question about one change is not buried under every other change in the file.
 */
export function unifiedDiff(
  before: string,
  after: string,
  options: { context?: number; focus?: { startLine: number; endLine: number } } = {},
): string {
  const context = options.context ?? 4;
  const lines = diffLines(before.split("\n"), after.split("\n"));

  const changed = lines
    .map((line, index) => (line.kind === "context" ? -1 : index))
    .filter((index) => index >= 0);
  if (changed.length === 0) return "";

  const groups: { start: number; end: number }[] = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(lines.length - 1, index + context);
    const last = groups[groups.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else groups.push({ start, end });
  }

  const kept = options.focus
    ? groups.filter((group) =>
        lines
          .slice(group.start, group.end + 1)
          .some(
            (line) =>
              line.afterLine !== undefined &&
              line.afterLine >= (options.focus as { startLine: number }).startLine &&
              line.afterLine <= (options.focus as { endLine: number }).endLine,
          ),
      )
    : groups;

  return (kept.length > 0 ? kept : groups)
    .map((group) => {
      const body = lines.slice(group.start, group.end + 1);
      const firstBefore = body.find((line) => line.beforeLine !== undefined)?.beforeLine ?? 0;
      const firstAfter = body.find((line) => line.afterLine !== undefined)?.afterLine ?? 0;
      const header = `@@ before ${firstBefore} · after ${firstAfter} @@`;
      const rendered = body
        .map((line) => {
          const marker = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
          const number = line.afterLine ?? line.beforeLine ?? 0;
          return `${marker}${String(number).padStart(5)} ${line.text}`;
        })
        .join("\n");
      return `${header}\n${rendered}`;
    })
    .join("\n\n");
}
