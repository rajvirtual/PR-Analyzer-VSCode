import * as vscode from "vscode";
import type { ChangedFile } from "../model/changeset.js";
import { parseFirstJson } from "./json.js";
import { runWithTools } from "./run-with-tools.js";
import { selectModel } from "./select-model.js";
import {
  buildIntentPrompt,
  INTENT_SYSTEM_PROMPT,
  validateIntentMap,
  type IntentMap,
} from "./intent-prompt.js";

export interface IntentOutcome {
  map: IntentMap | null;
  /** Why there is no map, in words worth showing a reader. */
  reason?: string;
}

export async function writeIntent(input: {
  intent: string;
  files: ChangedFile[];
  repositoryRoot: string;
  onProgress?: (message: string) => void;
  onModel?: (name: string) => void;
  token: vscode.CancellationToken;
}): Promise<IntentOutcome> {
  const model = await selectModel();
  if (!model) return { map: null, reason: "No Copilot model is available." };
  input.onModel?.(model.name);

  try {
    const result = await runWithTools({
      model,
      context: { repositoryRoot: input.repositoryRoot, files: input.files },
      system: INTENT_SYSTEM_PROMPT,
      prompt: buildIntentPrompt(input.intent, input.files),
      onProgress: input.onProgress,
      token: input.token,
    });

    const map = validateIntentMap(parseFirstJson(result.text), input.files);
    if (map) return { map };

    return {
      map: null,
      reason: result.text.trim()
        ? `${model.name} did not return a usable map.`
        : `${model.name} spent all its lookups without answering.`,
    };
  } catch (error) {
    return {
      map: null,
      reason: `${model.name} failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
