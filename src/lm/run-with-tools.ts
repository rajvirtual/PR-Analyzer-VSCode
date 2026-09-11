import * as vscode from "vscode";
import { invokeRepoTool, REPO_TOOLS, type ToolContext } from "./repo-tools.js";
import { SYSTEM_PROMPT } from "./explain-prompt.js";
import { mergeConsulted } from "./provenance.js";

/** Bounded so a model that keeps asking for files cannot loop forever. */
const MAX_TOOL_ROUNDS = 8;

/** A hard ceiling on total lookups, so a wide fan-out cannot run away either. */
const MAX_TOOL_CALLS = 24;

export interface RunResult {
  text: string;
  toolCalls: number;
  /** Repository files the model read beyond the diff, for the answer's provenance. */
  consulted: string[];
}

/**
 * Sends a prompt and services the model's tool calls until it answers.
 *
 * Each round is streamed straight to the chat, and every tool call is announced,
 * so the reader can see which files the answer actually rests on.
 */
export async function runWithTools(input: {
  model: vscode.LanguageModelChat;
  context: ToolContext;
  prompt: string;
  /** The rules the answer must follow. Explaining a change is the common case. */
  system?: string;
  history?: vscode.LanguageModelChatMessage[];
  /** Omitted when the caller wants the answer rather than a conversation. */
  stream?: vscode.ChatResponseStream;
  onProgress?: (label: string) => void;
  token: vscode.CancellationToken;
}): Promise<RunResult> {
  const { model, context, prompt, stream, token } = input;
  const report = (label: string): void => {
    stream?.progress(label);
    input.onProgress?.(label);
  };

  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(input.system ?? SYSTEM_PROMPT),
    ...(input.history ?? []),
    vscode.LanguageModelChatMessage.User(prompt),
  ];

  let answer = "";
  let toolCalls = 0;
  let consulted: string[] = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    if (token.isCancellationRequested) break;

    // On the last round the tools are withheld, which leaves answering as the only
    // move. Offered them again it would keep looking things up and return nothing.
    const last = round === MAX_TOOL_ROUNDS - 1 || toolCalls >= MAX_TOOL_CALLS;
    const response = await model.sendRequest(
      messages,
      last ? {} : { tools: REPO_TOOLS },
      token,
    );
    const calls: vscode.LanguageModelToolCallPart[] = [];

    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        answer += part.value;
        stream?.markdown(part.value);
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        calls.push(part);
      }
    }

    if (calls.length === 0) return { text: answer, toolCalls, consulted };

    messages.push(vscode.LanguageModelChatMessage.Assistant(calls));

    const results: vscode.LanguageModelToolResultPart[] = [];
    for (const call of calls) {
      toolCalls += 1;
      const result = await invokeRepoTool(context, call.name, call.input);
      consulted = mergeConsulted(consulted, result.consulted);
      report(result.label);
      results.push(
        new vscode.LanguageModelToolResultPart(call.callId, [
          new vscode.LanguageModelTextPart(result.text),
        ]),
      );
    }

    messages.push(vscode.LanguageModelChatMessage.User(results));
  }

  if (toolCalls > 0 && !answer) {
    stream?.markdown(
      "\n\nI kept needing more files and ran out of lookups before answering. Ask about a smaller part of the change.",
    );
  }

  return { text: answer, toolCalls, consulted };
}
