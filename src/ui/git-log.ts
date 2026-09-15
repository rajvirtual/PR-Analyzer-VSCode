import * as vscode from "vscode";
import { formatCall, onGitCall, type GitCall } from "../git/run-git.js";
import { formatModelPhases, onModelCall } from "../lm/lm-timing.js";

/**
 * The git commands, where the reader can see them.
 *
 * An output channel rather than a terminal: the commands are run as child processes,
 * so there is no shell to show, and a channel can be reopened after the fact. Each
 * line is written the way it would be typed, so a failure can be reproduced by hand.
 */
export class GitLog {
  private readonly channel: vscode.LogOutputChannel;
  private failures = 0;

  constructor() {
    this.channel = vscode.window.createOutputChannel("AI PR Analyzer: Git", { log: true });
  }

  /** Records every git call from now on. */
  listen(): vscode.Disposable {
    const subscription = onGitCall((call) => this.write(call));
    // The model calls belong beside the git ones: together they are the whole wait.
    const models = onModelCall((phases) => this.channel.info(formatModelPhases(phases)));
    return new vscode.Disposable(() => {
      subscription.dispose();
      models.dispose();
    });
  }

  private write(call: GitCall): void {
    if (call.ok) {
      this.channel.debug(formatCall(call));
      return;
    }
    this.failures += 1;
    this.channel.error(formatCall(call));
  }

  show(): void {
    this.channel.show(true);
  }

  /** Marks where one review's commands end and the next begins. */
  startRun(label: string): void {
    this.failures = 0;
    this.channel.info(`─── ${label} ───`);
  }

  /** Anything worth reading beside the commands, such as the order a review settled on. */
  note(message: string): void {
    this.channel.info(message);
  }

  get failureCount(): number {
    return this.failures;
  }

  dispose(): void {
    this.channel.dispose();
  }
}
