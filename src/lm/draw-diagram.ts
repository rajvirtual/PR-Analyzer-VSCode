import * as vscode from "vscode";
import type { ChangedFile, Step } from "../model/changeset.js";
import type { SymbolGraph } from "../analysis/flow-order.js";
import { renumberByFlow } from "../analysis/renumber.js";
import { parseFirstJson } from "./json.js";
import { runWithTools } from "./run-with-tools.js";
import { selectStructureModel } from "./select-model.js";
import {
  buildDiagramPrompt,
  DIAGRAM_SYSTEM_PROMPT,
  validateDiagram,
  type DrawnDiagram,
} from "./diagram-prompt.js";

export interface DrawOutcome {
  diagram: DrawnDiagram | null;
  /** Why nothing was drawn, so a fallback never looks like a quiet success. */
  reason?: string;
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
  onModel?: (name: string) => void;
  token: vscode.CancellationToken;
}): Promise<DrawOutcome> {
  const model = await selectStructureModel();
  if (!model) {
    return { diagram: null, reason: "No Copilot model is available." };
  }

  input.onModel?.(model.name);

  // A fast structure model sometimes returns nothing on the first call; one automatic retry
  // saves the reader a manual Redraw before we fall back.
  const attempt = async (phase: string): Promise<DrawOutcome> => {
    input.onProgress?.(`${phase} with ${model.name}…`);
    try {
      let writingChars = 0;
      let shownAt = 0;
      const result = await runWithTools({
        model,
        context: { repositoryRoot: input.repositoryRoot, files: input.files },
        prompt: `${DIAGRAM_SYSTEM_PROMPT}\n\n${buildDiagramPrompt(input.steps, input.files, input.graph)}`,
        onProgress: (label) => {
          writingChars = 0;
          shownAt = 0;
          input.onProgress?.(label);
        },
        onText: (delta) => {
          writingChars += delta.length;
          if (writingChars >= 40 && writingChars - shownAt >= 200) {
            shownAt = writingChars;
            input.onProgress?.(`Drawing the map… (${writingChars.toLocaleString()} characters)`);
          }
        },
        token: input.token,
      });

      const diagram = validateDiagram(parseFirstJson(result.text), input.files);
      if (diagram) {
        // The prompt asks for numbers that ascend along the arrows and does not always
        // get them; the arrows lay the diagram out, so they decide the numbering.
        const { mermaid, corrected } = renumberByFlow(diagram.mermaid);
        if (corrected > 0) input.onProgress?.(`Renumbered ${corrected} steps to follow the arrows`);
        return { diagram: { ...diagram, mermaid } };
      }

      return {
        diagram: null,
        reason: result.text.trim()
          ? `${model.name} did not return a usable diagram. It replied: ${result.text.trim().slice(0, 200)}`
          : `${model.name} returned nothing.`,
      };
    } catch (error) {
      return {
        diagram: null,
        reason: `${model.name} failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };

  const first = await attempt("Drawing");
  if (first.diagram || input.token.isCancellationRequested) return first;
  return attempt("Retrying");
}
