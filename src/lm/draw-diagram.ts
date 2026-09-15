import * as vscode from "vscode";
import type { ChangedFile, Step } from "../model/changeset.js";
import type { SymbolGraph } from "../analysis/flow-order.js";
import { renumberByFlow } from "../analysis/renumber.js";
import { mermaidSoFar, parseDiagramReply } from "./diagram-reply.js";
import { ModelTimer } from "./lm-timing.js";
import { runWithTools } from "./run-with-tools.js";
import { selectStructureModel } from "./select-model.js";
import {
  buildDiagramPrompt,
  DIAGRAM_SYSTEM_PROMPT,
  type DrawnDiagram,
} from "./diagram-prompt.js";

export interface DrawOutcome {
  diagram: DrawnDiagram | null;
  /** Why nothing was drawn, so a fallback never looks like a quiet success. */
  reason?: string;
  /** Still open, so the caller can mark when the diagram reached the screen. */
  timer?: ModelTimer;
}

/**
 * Asks a model to draw the change, letting it read the repository first.
 *
 * The digest describes the shape of a change; the tools are what let it find the one
 * rewritten condition that explains why the other twenty files moved.
 */
export async function drawDiagram(input: {
  steps: Step[];
  files: ChangedFile[];
  graph: SymbolGraph;
  repositoryRoot: string;
  onProgress?: (label: string) => void;
  /** The mermaid as it is written, so the reader watches it rather than a spinner. */
  onSource?: (mermaid: string) => void;
  onModel?: (name: string) => void;
  token: vscode.CancellationToken;
}): Promise<DrawOutcome> {
  const timer = new ModelTimer("diagram");
  const model = await selectStructureModel();
  if (!model) {
    timer.cancelled();
    return { diagram: null, reason: "No Copilot model is available." };
  }

  timer.model(model.name);
  input.onModel?.(model.name);

  // A fenced block streams, and a closed fence is the whole success condition: there is
  // no longer a malformed-JSON case worth paying a second round trip for.
  input.onProgress?.(`Drawing with ${model.name}…`);
  try {
    let reply = "";
    const result = await runWithTools({
      model,
      context: { repositoryRoot: input.repositoryRoot, files: input.files },
      prompt: `${DIAGRAM_SYSTEM_PROMPT}\n\n${buildDiagramPrompt(input.steps, input.files, input.graph)}`,
      onProgress: input.onProgress,
      onText: (delta) => {
        reply += delta;
        const drawn = mermaidSoFar(reply);
        if (drawn) input.onSource?.(drawn);
      },
      timer,
      token: input.token,
    });
    timer.lastToken(result.toolCalls);

    const diagram = parseDiagramReply(result.text, input.files);
    if (diagram) {
      // The prompt asks for numbers that ascend along the arrows and does not always
      // get them; the arrows lay the diagram out, so they decide the numbering.
      const { mermaid, corrected } = renumberByFlow(diagram.mermaid);
      if (corrected > 0) input.onProgress?.(`Renumbered ${corrected} steps to follow the arrows`);
      return { diagram: { ...diagram, mermaid }, timer };
    }

    timer.cancelled();
    return {
      diagram: null,
      reason: result.text.trim()
        ? `${model.name} did not finish the diagram. It replied: ${result.text.trim().slice(0, 200)}`
        : `${model.name} returned nothing.`,
    };
  } catch (error) {
    timer.cancelled();
    return {
      diagram: null,
      reason: `${model.name} failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
