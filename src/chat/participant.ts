import * as vscode from "vscode";
import type { ReviewSession } from "../session.js";
import { buildExplainPrompt } from "../lm/explain-prompt.js";
import { runWithTools } from "../lm/run-with-tools.js";
import { consultedNote } from "../lm/provenance.js";
import { rememberChatModel } from "../lm/model-memory.js";

const MAX_HISTORY_TURNS = 8;

export type SessionAccessor = () => ReviewSession | null;

/**
 * `@pr` in the chat panel.
 *
 * Chat is the whole conversation surface: the explanation and any follow-up
 * live in one thread, with the model picker, streaming, and history provided by
 * VS Code rather than rebuilt here.
 */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  getSession: SessionAccessor,
): vscode.ChatParticipant {
  const participant = vscode.chat.createChatParticipant(
    "prAnalyzer.chat",
    async (request, chatContext, stream, token) => {
      const session = getSession();
      // The picker's choice is only visible here, so the panels can follow it.
      rememberChatModel(request.model);
      if (!session) {
        stream.markdown(
          "No change is open. Run **PR Analyzer: Review this branch** first, then ask again.",
        );
        return;
      }

      const step = session.currentStep;
      if (!step) {
        stream.markdown("That review has no steps to talk about.");
        return;
      }

      const hunk = session.currentHunk();
      const { step: position, steps, hunk: current, hunks } = session.position;
      stream.progress(
        `${step.file.path} · step ${position}/${steps}${hunks > 0 ? ` · change ${Math.max(current, 1)}/${hunks}` : ""}`,
      );

      const prompt = buildExplainPrompt({
        changeSet: session.changeSet,
        file: step.file,
        hunk,
        question: request.command === "explain" ? undefined : request.prompt || undefined,
      });

      try {
        const result = await runWithTools({
          model: request.model,
          context: {
            repositoryRoot: session.changeSet.repositoryRoot,
            files: session.changeSet.files,
          },
          prompt,
          history: priorTurns(chatContext),
          stream,
          token,
        });

        if (result.toolCalls === 0) {
          stream.markdown("\n\n_Answered from the change alone; no other files were read._");
        } else {
          stream.markdown(`\n\n_${consultedNote(result.consulted)}_`);
        }
      } catch (error) {
        if (error instanceof vscode.LanguageModelError) {
          stream.markdown(`\n\nThe model refused or failed: ${error.message}`);
          return;
        }
        throw error;
      }

      stream.button({
        command: "prAnalyzer.next",
        title: "Next change",
      });
    },
  );

  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.svg");
  context.subscriptions.push(participant);
  return participant;
}

/** Only this participant's own turns, so an unrelated conversation cannot leak in. */
function priorTurns(context: vscode.ChatContext): vscode.LanguageModelChatMessage[] {
  const messages: vscode.LanguageModelChatMessage[] = [];

  for (const turn of context.history.slice(-MAX_HISTORY_TURNS)) {
    if (turn instanceof vscode.ChatRequestTurn) {
      if (turn.prompt.trim()) {
        messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
      }
    } else if (turn instanceof vscode.ChatResponseTurn) {
      const text = turn.response
        .map((part) =>
          part instanceof vscode.ChatResponseMarkdownPart ? part.value.value : "",
        )
        .join("");
      if (text.trim()) {
        messages.push(vscode.LanguageModelChatMessage.Assistant(text));
      }
    }
  }

  return messages;
}
