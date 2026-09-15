import * as vscode from "vscode";
import type { Hunk, ReviewSession } from "../session.js";
import { buildExplainPrompt } from "../lm/explain-prompt.js";
import { ModelTimer } from "../lm/lm-timing.js";
import { runWithTools } from "../lm/run-with-tools.js";
import { selectModel } from "../lm/select-model.js";
import { matchChangedFile } from "../analysis/match-file.js";
import type { ActivityStatus } from "./activity-status.js";

/**
 * The explanation, written where the change is.
 *
 * A comment thread rather than a decoration: it renders markdown, so a worked
 * example keeps its shape, and it folds away when it has been read. Chat remains
 * the place for a conversation; this answers one region and stops.
 */
export class InlineExplainer {
  private readonly controller: vscode.CommentController;
  private readonly threads = new Map<string, vscode.CommentThread>();
  private activity: ActivityStatus | undefined;

  /** Told about the status item rather than owning it, since every view shares one. */
  reportTo(activity: ActivityStatus): void {
    this.activity = activity;
  }

  constructor() {
    this.controller = vscode.comments.createCommentController(
      "prAnalyzer.explanations",
      "PR Analyzer",
    );
  }

  async explain(
    session: ReviewSession,
    uri: vscode.Uri,
    hunk: Hunk,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const file = matchChangedFile(
      session.changeSet.files,
      uri.scheme === "file" ? uri.fsPath : uri.path,
    );
    if (!file) return;

    const model = await selectModel();
    if (!model) {
      void vscode.window.showWarningMessage("No Copilot model is available to explain this.");
      return;
    }

    const thread = this.threadFor(uri, hunk);
    thread.comments = [comment(`Reading the change… _(${model.name})_`)];
    const timer = new ModelTimer("explain");
    timer.model(model.name);
    this.activity?.start("explain", "Explaining this change…");

    try {
      let draft = "";
      let shownAt = 0;
      const result = await runWithTools({
        model,
        context: {
          repositoryRoot: session.changeSet.repositoryRoot,
          files: session.changeSet.files,
        },
        // runWithTools supplies the explain rules; sending them again only pays twice.
        prompt: buildExplainPrompt({ changeSet: session.changeSet, file, hunk }),
        // Show the lookups, then the answer as it is written, so a slow explain is never blank.
        onProgress: (label) => {
          this.activity?.start("explain", label);
          if (!draft) thread.comments = [comment(`${label}… _(${model.name})_`)];
        },
        onText: (delta) => {
          draft += delta;
          if (draft.length - shownAt >= 80) {
            shownAt = draft.length;
            thread.comments = [comment(draft)];
          }
        },
        timer,
        token,
      });
      timer.lastToken(result.toolCalls);

      const text = result.text.trim();
      thread.comments = [
        comment(
          text ||
            (result.toolCalls > 0
              ? `${model.name} spent all ${result.toolCalls} of its lookups without answering. Ask about a smaller part of this change.`
              : `${model.name} returned nothing.`),
        ),
      ];
      timer.rendered();
      this.activity?.done("explain");
    } catch (error) {
      timer.cancelled();
      this.activity?.done("explain");
      thread.comments = [
        comment(`Could not explain this: ${error instanceof Error ? error.message : String(error)}`),
      ];
    }
  }

  /** One thread per region, reused so asking twice replaces rather than stacks. */
  private threadFor(uri: vscode.Uri, hunk: Hunk): vscode.CommentThread {
    const key = `${uri.toString()}#${hunk.startLine}`;
    const existing = this.threads.get(key);
    if (existing) {
      existing.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      return existing;
    }

    const line = Math.max(0, hunk.startLine - 1);
    const thread = this.controller.createCommentThread(
      uri,
      new vscode.Range(line, 0, Math.max(line, hunk.endLine - 1), 0),
      [],
    );
    thread.label = "PR Analyzer";
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.threads.set(key, thread);
    return thread;
  }

  /** Explanations belong to the review that produced them. */
  clear(): void {
    for (const thread of this.threads.values()) thread.dispose();
    this.threads.clear();
  }

  dispose(): void {
    this.clear();
    this.controller.dispose();
  }
}

function comment(markdown: string): vscode.Comment {
  return {
    body: new vscode.MarkdownString(markdown),
    mode: vscode.CommentMode.Preview,
    author: { name: "PR Analyzer" },
  };
}
