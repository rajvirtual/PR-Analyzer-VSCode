import * as vscode from "vscode";
import type { Story, StorySection } from "../lm/story-prompt.js";

/**
 * The read-through, beside the code.
 *
 * The model returns structure and this builds the HTML, so nothing it writes is ever
 * parsed as markup. Every heading and path that names a file opens that diff: a
 * document you cannot click out of is one you read once and abandon.
 */
export class StoryPanel {
  private static current: StoryPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  private handlers: {
    open: (path: string) => void;
    regenerate: () => void;
    cancel: () => void;
  };

  private constructor(
    extensionUri: vscode.Uri,
    handlers: {
      open: (path: string) => void;
      regenerate: () => void;
      cancel: () => void;
    },
  ) {
    this.handlers = handlers;
    this.panel = vscode.window.createWebviewPanel(
      "prAnalyzer.story",
      "PR Analyzer: read-through",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [extensionUri] },
    );

    this.panel.webview.onDidReceiveMessage((message: { type: string; path?: string }) => {
      if (message.type === "open" && message.path) this.handlers.open(message.path);
      if (message.type === "regenerate") this.handlers.regenerate();
      if (message.type === "cancel") this.handlers.cancel();
    });

    this.panel.onDidDispose(() => {
      this.disposed = true;
      // A panel that is gone cannot be waited for, so nothing should keep running for it.
      this.handlers.cancel();
      StoryPanel.current = undefined;
    });

    // Written once. Everything after this is a message, so the reader's scroll survives.
    this.panel.webview.html = shell();
  }

  static show(handlers: {
    extensionUri: vscode.Uri;
    open: (path: string) => void;
    regenerate: () => void;
    cancel: () => void;
  }): StoryPanel {
    if (StoryPanel.current && !StoryPanel.current.disposed) {
      // Point the reused panel at this invocation's handlers, so Stop cancels this
      // read-through rather than the first one the panel was ever opened for.
      StoryPanel.current.handlers = handlers;
      StoryPanel.current.panel.reveal();
      return StoryPanel.current;
    }
    StoryPanel.current = new StoryPanel(handlers.extensionUri, handlers);
    return StoryPanel.current;
  }

  busy(message: string, model: string): void {
    this.post({ type: "busy", message, model });
  }

  failed(reason: string): void {
    this.post({ type: "failed", reason });
  }

  show(story: Story, model: string): void {
    this.post({ type: "story", html: body(story), model });
  }

  private post(message: Record<string, unknown>): void {
    if (!this.disposed) void this.panel.webview.postMessage(message);
  }

  dispose(): void {
    this.panel.dispose();
  }
}

function shell(): string {
  const nonce = Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 36).toString(36),
  ).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body {
    font-family: var(--vscode-font-family); color: var(--vscode-foreground);
    background: var(--vscode-editor-background); margin: 0; padding: 0 0 48px; line-height: 1.6;
  }
  #bar {
    position: sticky; top: 0; z-index: 2; display: flex; gap: 12px; align-items: center;
    padding: 8px 16px; background: var(--vscode-editor-background);
    border-bottom: 1px solid var(--vscode-panel-border); font-size: 12px;
  }
  #bar button {
    font: inherit; color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground); border: none; border-radius: 2px;
    padding: 3px 10px; cursor: pointer;
  }
  #bar button[disabled] { opacity: 0.4; cursor: default; }
  #bar .model { margin-left: auto; opacity: 0.7; }
  main { max-width: 760px; margin: 0 auto; padding: 24px 16px; }
  .summary { font-size: 15px; margin: 0 0 32px; padding-left: 12px;
    border-left: 3px solid var(--vscode-textLink-foreground); }
  section { margin: 0 0 28px; }
  h2 { font-size: 14px; margin: 0 0 2px; font-weight: 600; }
  h2 a { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
  h2 a:hover { text-decoration: underline; }
  .where { font-size: 11px; opacity: 0.65; margin: 0 0 8px; }
  .where a { color: inherit; text-decoration: none; cursor: pointer; }
  .where a:hover { color: var(--vscode-textLink-foreground); text-decoration: underline; }
  .tag { display: inline-block; font-size: 10px; text-transform: uppercase;
    letter-spacing: 0.4px; padding: 1px 6px; border-radius: 8px; margin-right: 6px; }
  .new { background: rgba(35,134,54,0.25); color: #7ee787; }
  .changed { background: rgba(187,128,9,0.25); color: #e3b341; }
  .context { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  p { margin: 0 0 10px; }
  pre { font-family: var(--vscode-editor-font-family); font-size: 12px;
    background: var(--vscode-textCodeBlock-background); padding: 10px 12px;
    border-radius: 4px; overflow-x: auto; margin: 0; }
  #state { margin-top: 40px; border-top: 1px solid var(--vscode-panel-border); padding-top: 24px; }
  #state h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;
    opacity: 0.6; margin: 0 0 12px; }
  .side { margin: 0 0 16px; padding-left: 12px; border-left: 2px solid var(--vscode-panel-border); }
  .side b { display: block; font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.4px; opacity: 0.6; margin-bottom: 4px; }
  .side.after { border-left-color: #7ee787; }
  .waiting, .failed { opacity: 0.8; }
  .failed { color: var(--vscode-errorForeground); opacity: 1; }
</style>
</head>
<body>
  <div id="bar">
    <button id="regenerate" disabled>Write it again</button>
    <button id="cancel" hidden>Stop</button>
    <span class="model" id="model"></span>
  </div>
  <main id="content" aria-live="polite"><p class="waiting">Reading the whole change…</p></main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const content = document.getElementById("content");
    const modelLabel = document.getElementById("model");
    const regenerate = document.getElementById("regenerate");
    const cancel = document.getElementById("cancel");

    let started = 0;
    let ticker;
    let label = "Reading the whole change…";

    // A line that never changes is indistinguishable from a hang, so it counts.
    function waiting() {
      const seconds = Math.round((Date.now() - started) / 1000);
      const paragraph = document.createElement("p");
      paragraph.className = "waiting";
      paragraph.textContent = label + " — " + seconds + "s";
      content.replaceChildren(paragraph);
    }

    function stopTicking() {
      if (ticker) window.clearInterval(ticker);
      ticker = undefined;
      cancel.hidden = true;
      regenerate.disabled = false;
    }

    regenerate.addEventListener("click", () => vscode.postMessage({ type: "regenerate" }));
    cancel.addEventListener("click", () => {
      stopTicking();
      vscode.postMessage({ type: "cancel" });
    });

    // Delegated, so links keep working after the content is replaced.
    document.addEventListener("click", (event) => {
      const link = event.target.closest && event.target.closest("a[data-path]");
      if (link) {
        event.preventDefault();
        vscode.postMessage({ type: "open", path: link.dataset.path });
      }
    });

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type === "busy") {
        label = message.message;
        modelLabel.textContent = message.model || "";
        cancel.hidden = false;
        regenerate.disabled = true;
        if (!ticker) {
          started = Date.now();
          ticker = window.setInterval(waiting, 1000);
        }
        waiting();
      }
      if (message.type === "story") {
        stopTicking();
        modelLabel.textContent = message.model || "";
        content.innerHTML = message.html;
      }
      if (message.type === "failed") {
        stopTicking();
        const reason = document.createElement("p");
        reason.className = "failed";
        reason.textContent = message.reason;
        const hint = document.createElement("p");
        hint.className = "waiting";
        hint.textContent = "Try again, or pick another model in chat.";
        content.replaceChildren(reason, hint);
      }
    });
  </script>
</body>
</html>`;
}

function body(story: Story): string {
  const summary = story.summary ? `<p class="summary">${escape(story.summary)}</p>` : "";
  return summary + story.sections.map(section).join("") + state(story);
}

/** What an operator would find, either side of the change. */
function state(story: Story): string {
  if (!story.before && !story.after) return "";

  const side = (label: string, value: string | undefined, kind: string): string =>
    value ? `<p class="side ${kind}"><b>${label}</b>${escape(value)}</p>` : "";

  return `<div id="state">
    <h3>What changes</h3>
    ${side("Before", story.before, "before")}
    ${side("After", story.after, "after")}
  </div>`;
}

function section(entry: StorySection): string {
  const heading = entry.path
    ? `<a href="#" data-path="${escape(entry.path)}">${escape(entry.title)}</a>`
    : escape(entry.title);

  // The path is what a reader reaches for when they want the code, so it opens it too.
  const where = entry.path
    ? `<a href="#" data-path="${escape(entry.path)}" title="Open this diff">${escape(entry.path)}</a>`
    : "several files";

  return `<section>
    <h2>${heading}</h2>
    <p class="where"><span class="tag ${entry.kind}">${entry.kind}</span> ${where}</p>
    <p>${escape(entry.prose)}</p>
    ${entry.example ? `<pre>${escape(entry.example)}</pre>` : ""}
  </section>`;
}

/** Model output is data, never markup. */
function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
