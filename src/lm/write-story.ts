import * as vscode from "vscode";
import type { ChangedFile, Step } from "../model/changeset.js";
import { parseFirstJson } from "./json.js";
import { runWithTools } from "./run-with-tools.js";
import { selectModel } from "./select-model.js";
import { buildStoryPrompt, parseStory, STORY_SYSTEM_PROMPT, validateStory, type Story } from "./story-prompt.js";

export interface StoryOutcome {
  story: Story | null;
  /** Why there is no story, in words worth showing a reader. */
  reason?: string;
}

export async function writeStory(input: {
  steps: Step[];
  files: ChangedFile[];
  repositoryRoot: string;
  onProgress?: (message: string) => void;
  onText?: (delta: string) => void;
  onModel?: (name: string) => void;
  token: vscode.CancellationToken;
}): Promise<StoryOutcome> {
  const model = await selectModel();
  if (!model) return { story: null, reason: "No Copilot model is available." };
  input.onModel?.(model.name);

  try {
    const result = await runWithTools({
      model,
      context: { repositoryRoot: input.repositoryRoot, files: input.files },
      system: STORY_SYSTEM_PROMPT,
      prompt: buildStoryPrompt(input.steps, input.files),
      onProgress: input.onProgress,
      onText: input.onText,
      // The read-through spans every step, so it needs more headroom than a single explain.
      maxRounds: 12,
      maxCalls: 48,
      token: input.token,
    });

    // The section format degrades gracefully; JSON stays as a fallback for a model that
    // still answers in the old shape.
    const story =
      parseStory(result.text, input.files) ??
      validateStory(parseFirstJson(result.text), input.files);
    if (story) return { story };

    return {
      story: null,
      reason: result.text.trim()
        ? `${model.name} did not return a usable read-through.`
        : `${model.name} spent all its lookups without answering.`,
    };
  } catch (error) {
    return {
      story: null,
      reason: `${model.name} failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
