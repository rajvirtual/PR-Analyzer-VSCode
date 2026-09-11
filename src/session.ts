import type { ChangeSet, ChangedFile, Step } from "./model/changeset.js";
import { computeSignals, flowOrder } from "./analysis/ordering-signals.js";
import { diffLines } from "./analysis/unified-diff.js";

export interface Hunk {
  startLine: number;
  endLine: number;
}

/** Modified-side ranges of each changed region, used to walk within a file. */
export function hunksOf(file: ChangedFile): Hunk[] {
  const before = file.before ?? "";
  const after = file.after ?? "";
  // A deleted or unavailable modified side has nothing to walk.
  if (file.after === null) return [];

  const lines = diffLines(before.split("\n"), after.split("\n"));
  const hunks: Hunk[] = [];
  let afterCursor = 0;

  for (const line of lines) {
    if (line.afterLine !== undefined) afterCursor = line.afterLine;
    if (line.kind === "context") continue;

    // A removed line has no after-line of its own; anchor it just past the last one,
    // so a deletion is still somewhere the reader can stop.
    const anchor = line.afterLine ?? Math.max(1, afterCursor + 1);
    const last = hunks[hunks.length - 1];
    if (last && anchor <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, anchor);
    } else {
      hunks.push({ startLine: anchor, endLine: anchor });
    }
  }

  return hunks;
}

export function buildSteps(
  changeSet: ChangeSet,
  order?: { path: string; title?: string }[],
): Step[] {
  const contents = new Map<string, string>();
  for (const file of changeSet.files) {
    contents.set(file.path, file.after ?? file.before ?? "");
  }

  const signals = computeSignals(changeSet.files, contents);
  const roleByPath = new Map(signals.map((signal) => [signal.path, signal.role]));
  const byPath = new Map(changeSet.files.map((file) => [file.path, file]));

  // A supplied order comes from the model or the language server; otherwise fall
  // back to text signals.
  const entries = order ?? flowOrder(signals).map((path) => ({ path, title: undefined }));

  return entries
    .map((entry) => ({ entry, file: byPath.get(entry.path) }))
    .filter((pair): pair is { entry: { path: string; title?: string }; file: ChangedFile } =>
      pair.file !== undefined,
    )
    .map((pair, index) => ({
      id: `s${index + 1}`,
      order: index + 1,
      file: pair.file,
      role: roleByPath.get(pair.file.path) ?? "other",
      title: pair.entry.title || undefined,
    }));
}

/**
 * Where the reader is: which step, and which change within it.
 *
 * Next and Previous walk the changes inside a file first and only then move to
 * another file, because a step is a file but the unit a reviewer reads is a change.
 */
export class ReviewSession {
  private stepIndex = 0;
  private hunkIndex = 0;
  private hunkCache = new Map<string, Hunk[]>();
  private readonly visited = new Set<string>();

  constructor(
    readonly changeSet: ChangeSet,
    readonly steps: Step[],
  ) {}

  get currentStep(): Step | null {
    return this.steps[this.stepIndex] ?? null;
  }

  get position(): { step: number; steps: number; hunk: number; hunks: number } {
    return {
      step: this.steps.length === 0 ? 0 : this.stepIndex + 1,
      steps: this.steps.length,
      hunk: this.hunkIndex,
      hunks: this.hunksForCurrent().length,
    };
  }

  hunksForCurrent(): Hunk[] {
    const step = this.currentStep;
    if (!step) return [];
    const cached = this.hunkCache.get(step.id);
    if (cached) return cached;
    const hunks = hunksOf(step.file);
    this.hunkCache.set(step.id, hunks);
    return hunks;
  }

  currentHunk(): Hunk | null {
    const hunks = this.hunksForCurrent();
    return hunks[this.hunkIndex - 1] ?? hunks[0] ?? null;
  }

  selectStep(stepId: string, at: "first" | "last" = "first"): boolean {
    const index = this.steps.findIndex((step) => step.id === stepId);
    if (index < 0) return false;
    this.stepIndex = index;
    this.hunkIndex = at === "last" ? this.hunksForCurrent().length : 0;
    this.markVisited();
    return true;
  }

  /** True when the position moved; false when there is nothing after this. */
  next(): boolean {
    const hunks = this.hunksForCurrent();
    if (this.hunkIndex < hunks.length) {
      this.hunkIndex += 1;
      this.markVisited();
      return true;
    }
    if (this.stepIndex >= this.steps.length - 1) return false;
    this.stepIndex += 1;
    this.hunkIndex = Math.min(1, this.hunksForCurrent().length);
    this.markVisited();
    return true;
  }

  previous(): boolean {
    if (this.hunkIndex > 1) {
      this.hunkIndex -= 1;
      this.markVisited();
      return true;
    }
    if (this.stepIndex <= 0) return false;
    this.stepIndex -= 1;
    this.hunkIndex = this.hunksForCurrent().length;
    this.markVisited();
    return true;
  }

  private markVisited(): void {
    const step = this.steps[this.stepIndex];
    if (step) this.visited.add(step.id);
  }

  /** How much of the change the reader has opened, and how much was left out. */
  coverage(): { files: number; visited: number; omitted: number } {
    return {
      files: this.steps.length,
      visited: this.visited.size,
      omitted: this.changeSet.skipped.length,
    };
  }

  /** The file paths already opened, for a checkpoint that outlives step numbering. */
  visitedPaths(): string[] {
    return this.steps.filter((step) => this.visited.has(step.id)).map((step) => step.file.path);
  }

  /** The file being read, by path. */
  currentPath(): string | null {
    return this.currentStep?.file.path ?? null;
  }

  /** Restores a saved position by path, ignoring files this change no longer has. */
  restore(checkpoint: { currentPath: string | null; visited: string[] }): void {
    const indexByPath = new Map(this.steps.map((step, index) => [step.file.path, index]));
    for (const path of checkpoint.visited) {
      const index = indexByPath.get(path);
      if (index !== undefined) this.visited.add(this.steps[index].id);
    }
    if (checkpoint.currentPath) {
      const index = indexByPath.get(checkpoint.currentPath);
      if (index !== undefined) {
        this.stepIndex = index;
        this.hunkIndex = 0;
      }
    }
  }
}
