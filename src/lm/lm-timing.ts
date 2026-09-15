/**
 * Where the time goes in a model-backed view.
 *
 * Time to first token decides whether a view feels fast; time to last token only
 * decides whether it feels finished. Recording both, beside the git calls, is what
 * turns "the diagram is slow" into a number that says which half to fix.
 */

export interface ModelPhases {
  label: string;
  model: string;
  /** Milliseconds from the start of the operation to each mark. */
  sent?: number;
  firstToken?: number;
  lastToken?: number;
  rendered?: number;
  toolCalls?: number;
  cancelled?: boolean;
}

type Listener = (phases: ModelPhases) => void;

const listeners = new Set<Listener>();

export function onModelCall(listener: Listener): { dispose(): void } {
  listeners.add(listener);
  return { dispose: () => listeners.delete(listener) };
}

/** Marks the phases of one model-backed view, and reports them when it ends. */
export class ModelTimer {
  private readonly started: number;
  private readonly phases: ModelPhases;
  private reported = false;

  constructor(
    label: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.started = now();
    this.phases = { label, model: "" };
  }

  model(name: string): void {
    this.phases.model = name;
  }

  sent(): void {
    this.phases.sent ??= this.now() - this.started;
  }

  /** Only the first token counts; later rounds are the same answer still arriving. */
  firstToken(): void {
    this.phases.firstToken ??= this.now() - this.started;
  }

  lastToken(toolCalls?: number): void {
    this.phases.lastToken = this.now() - this.started;
    if (toolCalls !== undefined) this.phases.toolCalls = toolCalls;
  }

  /** The mark that matters to the reader: when there was something on screen. */
  rendered(): void {
    this.phases.rendered ??= this.now() - this.started;
    this.report();
  }

  cancelled(): void {
    this.phases.cancelled = true;
    this.report();
  }

  private report(): void {
    if (this.reported) return;
    this.reported = true;
    const snapshot = { ...this.phases };
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // A broken listener must not take the view down with it.
      }
    }
  }
}

function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** One line, in the order the phases happen, so a gap is visible at a glance. */
export function formatModelPhases(phases: ModelPhases): string {
  const parts = [phases.label];
  if (phases.model) parts.push(phases.model);
  if (phases.sent !== undefined) parts.push(`sent ${duration(phases.sent)}`);
  parts.push(
    phases.firstToken !== undefined
      ? `first token ${duration(phases.firstToken)}`
      : "no tokens",
  );
  if (phases.lastToken !== undefined) parts.push(`last token ${duration(phases.lastToken)}`);
  if (phases.rendered !== undefined) parts.push(`rendered ${duration(phases.rendered)}`);
  if (phases.toolCalls) parts.push(`${phases.toolCalls} lookups`);
  if (phases.cancelled) parts.push("cancelled");
  return parts.join(" · ");
}
