import type { ChangedFile, Effort } from "../model/changeset.js";
import type { SymbolGraph } from "../analysis/flow-order.js";
import { renderDigests } from "../analysis/change-digest.js";

export interface OrderedStep {
  path: string;
  /** What happens at this point in the flow, in the model's words. */
  title: string;
  /** How demanding the change is to review, in the model's judgement. */
  effort?: Effort;
}

export const ORDER_SYSTEM_PROMPT = `You put the files of a code change into the order a reviewer should read them.

Order them as EXECUTION FLOW, not as a file listing and not by dependency depth:
- The first file is where the flow ENTERS this change: the trigger, entry point, request,
  workflow definition, schedule, or caller. Ask "what runs first?".
- Each file after it is what happens NEXT along that path: what the previous one calls,
  dispatches to, or hands off to.
- What an entry point HANDS OFF TO comes immediately after it. A task whose body is only
  "Handler.PerformSetupAsync(...)" is followed by that handler, before any contract, model,
  or utility the handler itself reads later. Put the delegate second, not twelfth.
- Finish where the flow ENDS: the result, persistence, cleanup, or the response returned.
- Introduce a contract, model, or constant AT THE POINT the flow first reaches it, never up
  front. A type is not first just because many files depend on it.
- A helper reached deep in the flow is placed there, not near the top because its name is
  short or its file is small.
- If the change contains several independent flows, finish one completely before starting
  the next. A setup lifecycle and a teardown lifecycle are two flows: read setup from end
  to end, then teardown, with its task and its handler ADJACENT. Never put one lifecycle's
  task second and its handler last.
- Tests and documentation come last.

Before you answer, decide two things and let them anchor the rest:
  ENTRY: the one file where control first arrives at run time.
  END: the one file where the flow's result is written, published, or returned.
Everything else lies on the path between them, in the order it is reached.

A schema, contract, or type declaration is NOT the entry point. It is data the flow reads
when it gets there. If your first file declares a type rather than doing something, you
have ordered by dependency, which is wrong: find the file that RUNS first instead.

You are given two things about each file:
- A reference graph. "called by" is strong evidence a file is reached later; a file with
  no callers inside the change is a likely entry point. The list is already in the order
  that graph suggests, which is a starting point and not an answer: it knows what is wired
  to what, and nothing about what runs.
- What the change actually did to it: the declarations added and the lines rewritten.
  Prefer this. A method named Handle, Reconcile, Validate, or Execute tells you where the
  flow goes; the graph only tells you what is wired to what.
When the two disagree, believe the code.

A utility, helper, or naming module that many files call is never the entry point, however
early it appears in the list. The entry point is the file whose own code is invoked first
at run time: the task, handler, controller, or trigger the platform calls into.

For each file, also rate how much careful review its change needs, as "effort". Weigh both what
changed (the declarations and "logic:" lines in the digest) and how much (the +added/-removed
counts in each file's header). Default to "involved" and move off it only with evidence.
- "routine": mechanical or low-risk. A rename, a moved file, a data model or DTO, config,
  generated code, or a test that mirrors the change. A change of only a few lines is usually here.
- "involved": ordinary logic worth reading, but holding no traps. This is the default.
- "complex": dense or subtle logic where a mistake would hide — new control flow, concurrency,
  intricate conditionals, error handling, or anything touching security or money. It has to show
  in the rewritten logic, not merely in a file's size. Reserve it for the few files that earn it;
  a change of under about five lines is never complex.

Reply with a single JSON object and nothing else. No prose, no code fences:
{"steps":[{"path":"<exact path from the list>","title":"<what happens here, under 10 words>","effort":"routine|involved|complex"}]}

Every path must come from the supplied list. Include every file exactly once.`;

export function buildOrderPrompt(
  files: ChangedFile[],
  graph: SymbolGraph,
  suggestedOrder: string[] = [],
): string {
  // Listed in the order the graph suggests: a model anchors on the order it is shown, and
  // git's order carries no meaning at all.
  const byPath = new Map(files.map((file) => [file.path, file]));
  const ordered = [
    ...suggestedOrder.map((path) => byPath.get(path)).filter((file): file is ChangedFile => file !== undefined),
    ...files.filter((file) => !suggestedOrder.includes(file.path)),
  ];

  const lines = ordered.map((file) => {
    const calls = [...(graph.references.get(file.path) ?? [])];
    const calledBy = [...(graph.referencedBy.get(file.path) ?? [])];
    const declares = (graph.declares?.get(file.path) ?? []).slice(0, 8);

    const parts = [`${file.path} | ${file.changeType}`];
    if (declares.length > 0) parts.push(`declares: ${declares.join(", ")}`);
    if (calls.length > 0) parts.push(`calls: ${calls.join(", ")}`);
    if (calledBy.length > 0) parts.push(`called by: ${calledBy.join(", ")}`);
    else parts.push("called by: nothing in this change");
    return parts.join(" | ");
  });

  return `Files in this change, in the order the reference graph suggests:
<data name="files">
${lines.join("\n")}
</data>

What the change did to each of them:
<data name="changes">
${renderDigests(files, 30_000)}
</data>

Put every one of these ${files.length} files in the order a reviewer should read them.
Name the entry point first and the file where the flow ends last. Move a file off the
suggested position whenever the code says the flow reaches it somewhere else.`;
}

/**
 * Forces the model's answer to be a permutation of the real file list.
 *
 * A model can invent, drop, or repeat a path. Rather than trusting it, invented
 * paths are discarded and anything it missed is appended in the graph's order, so
 * the reader always sees every file exactly once.
 */
export function reconcileOrder(
  files: ChangedFile[],
  proposed: OrderedStep[],
  fallbackOrder: string[],
): OrderedStep[] {
  const known = new Set(files.map((file) => file.path));
  const titles = new Map<string, string>();
  const efforts = new Map<string, Effort>();
  const ordered: string[] = [];
  const seen = new Set<string>();

  for (const step of proposed) {
    const path = typeof step?.path === "string" ? step.path : "";
    if (!known.has(path) || seen.has(path)) continue;
    seen.add(path);
    ordered.push(path);
    if (typeof step.title === "string" && step.title.trim()) {
      titles.set(path, step.title.trim());
    }
    const effort = effortOf(step.effort);
    if (effort) efforts.set(path, effort);
  }

  for (const path of fallbackOrder) {
    if (known.has(path) && !seen.has(path)) {
      seen.add(path);
      ordered.push(path);
    }
  }

  for (const file of files) {
    if (!seen.has(file.path)) {
      seen.add(file.path);
      ordered.push(file.path);
    }
  }

  return ordered.map((path) => ({ path, title: titles.get(path) ?? "", effort: efforts.get(path) }));
}

/** Only the three known ratings survive; anything else is treated as unrated. */
function effortOf(value: unknown): Effort | undefined {
  return value === "routine" || value === "involved" || value === "complex" ? value : undefined;
}
