import * as vscode from "vscode";
import type { ChangedFile } from "../model/changeset.js";
import type { SymbolGraph } from "../analysis/flow-order.js";
import { parseFirstJson } from "./json.js";
import { selectStructureModel } from "./select-model.js";
import {
  buildOrderPrompt,
  ORDER_SYSTEM_PROMPT,
  reconcileOrder,
  type OrderedStep,
} from "./order-prompt.js";

export interface OrderOutcome {
  steps: OrderedStep[];
  /** How the order was arrived at, so the reader is never misled about it. */
  source: "model" | "references" | "unavailable";
  note?: string;
}

async function collect(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  token: vscode.CancellationToken,
): Promise<string> {
  const response = await model.sendRequest(messages, {}, token);
  let text = "";
  for await (const part of response.text) text += part;
  return text;
}

/**
 * Asks a model for the reading order, using the reference graph as evidence.
 *
 * The reply is never trusted as-is: it is reconciled against the real file list,
 * so an invented or missing path cannot change what the reader ends up seeing.
 */
export async function orderStepsWithModel(input: {
  files: ChangedFile[];
  graph: SymbolGraph;
  fallbackOrder: string[];
  token: vscode.CancellationToken;
}): Promise<OrderOutcome> {
  const { files, graph, fallbackOrder, token } = input;

  const model = await selectStructureModel();
  if (!model) {
    return {
      steps: reconcileOrder(files, [], fallbackOrder),
      source: "unavailable",
      note: "No Copilot model is available, so the order comes from the reference graph.",
    };
  }

  const user = buildOrderPrompt(files, graph, fallbackOrder);
  const messages = [
    vscode.LanguageModelChatMessage.User(ORDER_SYSTEM_PROMPT),
    vscode.LanguageModelChatMessage.User(user),
  ];

  try {
    let raw = await collect(model, messages, token);
    let parsed = parseFirstJson<{ steps?: OrderedStep[] }>(raw);

    // One repair, carrying the original data. A complaint on its own leaves the
    // model with nothing to re-answer from, and it correctly reports as much.
    if (!parsed?.steps?.length) {
      raw = await collect(
        model,
        [
          ...messages,
          vscode.LanguageModelChatMessage.Assistant(raw.slice(0, 2000)),
          vscode.LanguageModelChatMessage.User(
            'That reply was not the required JSON. Answer the same request again as a single JSON object of the form {"steps":[{"path":"...","title":"...","effort":"routine|involved|complex"}]}, using the file list above. No prose.',
          ),
        ],
        token,
      );
      parsed = parseFirstJson<{ steps?: OrderedStep[] }>(raw);
    }

    if (!parsed?.steps?.length) {
      return {
        steps: reconcileOrder(files, [], fallbackOrder),
        source: "references",
        note: "The model did not return a usable order, so the reference graph was used.",
      };
    }

    const steps = reconcileOrder(files, parsed.steps, fallbackOrder);
    const named = steps.filter((step) => step.title).length;

    return {
      steps,
      source: "model",
      note: named < files.length ? `${files.length - named} file(s) were not named by the model.` : undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      steps: reconcileOrder(files, [], fallbackOrder),
      source: "references",
      note: `Ordering by model failed (${message}); the reference graph was used.`,
    };
  }
}
