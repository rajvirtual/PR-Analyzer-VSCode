import * as vscode from "vscode";
import { formatCall, onGitCall, type GitCall } from "../git/run-git.js";

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
    this.channel = vscode.window.createOutputChannel("PR Analyzer: Git", { log: true });
  }

  /** Records every git call from now on. */
  listen(): vscode.Disposable {
    const subscription = onGitCall((call) => this.write(call));
    return new vscode.Disposable(() => subscription.dispose());
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

  get failureCount(): number {
    return this.failures;
  }

  dispose(): void {
    this.channel.dispose();
  }
}
