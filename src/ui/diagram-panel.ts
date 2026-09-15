import * as vscode from "vscode";
import type { ChangedFile, Step } from "../model/changeset.js";
import type { SymbolGraph } from "../analysis/flow-order.js";
import { buildMermaid, stepIdForNode, type Direction } from "../analysis/mermaid.js";
import { drawDiagram } from "../lm/draw-diagram.js";
import type { ModelTimer } from "../lm/lm-timing.js";
import { beginExclusiveModelWork, clearExclusiveModelWork } from "../lm/model-gate.js";
import type { ActivityStatus } from "./activity-status.js";
import { pickStructureModel } from "../lm/select-model.js";
import type { DrawnDiagram } from "../lm/diagram-prompt.js";

type View = "change" | "files";

/**
 * The map of the change, in its own editor tab.
 *
 * Two views: what the change does, drawn by a model, and the file-by-file map built
 * from the reference graph. The first is what a reader wants; the second is what can
 * always be produced without asking anything.
 */
export interface DiagramCache {
  load(): DrawnDiagram | undefined;
  save(diagram: DrawnDiagram): void;
}

export class DiagramPanel {
  private static current: DiagramPanel | undefined;
  private static activity: ActivityStatus | undefined;

  /** Told about the status item rather than owning it, since every view shares one. */
  static reportTo(activity: ActivityStatus): void {
    DiagramPanel.activity = activity;
  }

  private panel: vscode.WebviewPanel;
  private direction: Direction = "TD";
  private grouped: boolean | undefined;
  private view: View = "change";
  private drawn: DrawnDiagram | null = null;
  private drawing = false;
  private drawGeneration = 0;
  private drawTokens: vscode.CancellationTokenSource | null = null;
  private drawTimer: ModelTimer | null = null;
  private ready = false;
  private disposed = false;

  private constructor(
    private readonly extensionUri: vscode.Uri,
    private steps: Step[],
    private files: ChangedFile[],
    private graph: SymbolGraph,
    private repositoryRoot: string,
    private readonly onSelect: (stepId: string) => void,
    private readonly cache: DiagramCache,
  ) {
    this.drawn = this.cache.load() ?? null;
    this.panel = vscode.window.createWebviewPanel(
      "prAnalyzer.diagram",
      "PR Analyzer: map",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      {
        enableScripts: true,
        // Zoom and pan are lost on every tab switch without this.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      },
    );

    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((message: { type: string; node?: string }) =>
      this.onMessage(message),
    );
    this.panel.onDidDispose(() => {
      this.disposed = true;
      // A closed map has nothing to draw for; stop any model call still running.
      this.drawTokens?.cancel();
      DiagramPanel.current = undefined;
    });
    this.panel.onDidChangeViewState((event) => {
      // No point spending a model call on a map the reader has tabbed away from; say so
      // plainly rather than leaving a half-drawn map that looks like the finished one.
      if (event.webviewPanel.visible || !this.drawing || this.disposed) return;
      this.drawTokens?.cancel();
      void vscode.window
        .showWarningMessage(
          "PR Analyzer: drawing the map was cancelled when you switched away.",
          "Draw again",
        )
        .then((choice) => {
          if (choice !== "Draw again") return;
          this.panel.reveal();
          this.drawTokens?.cancel();
          this.drawn = null;
          this.drawGeneration += 1;
          this.view = "change";
          void this.push();
        });
    });
  }

  static show(
    extensionUri: vscode.Uri,
    steps: Step[],
    files: ChangedFile[],
    graph: SymbolGraph,
    repositoryRoot: string,
    onSelect: (stepId: string) => void,
    cache: DiagramCache,
  ): DiagramPanel {
    if (DiagramPanel.current) {
      DiagramPanel.current.update(steps, files, graph, repositoryRoot);
      DiagramPanel.current.panel.reveal();
      return DiagramPanel.current;
    }
    DiagramPanel.current = new DiagramPanel(
      extensionUri,
      steps,
      files,
      graph,
      repositoryRoot,
      onSelect,
      cache,
    );
    return DiagramPanel.current;
  }

  static highlight(stepId: string | null): void {
    const panel = DiagramPanel.current;
    if (!panel?.ready || !stepId) return;

    if (panel.view === "files") {
      const index = panel.steps.findIndex((step) => step.id === stepId);
      if (index >= 0) void panel.panel.webview.postMessage({ type: "highlight", node: `n${index}` });
      return;
    }

    const path = panel.steps.find((step) => step.id === stepId)?.file.path;
    const node = Object.entries(panel.drawn?.files ?? {}).find(([, value]) => value === path)?.[0];
    if (node) void panel.panel.webview.postMessage({ type: "highlight", node });
  }

  update(steps: Step[], files: ChangedFile[], graph: SymbolGraph, repositoryRoot: string): void {
    this.steps = steps;
    this.files = files;
    this.graph = graph;
    this.repositoryRoot = repositoryRoot;
    this.drawn = this.cache.load() ?? null;
    this.drawGeneration += 1;
    void this.push();
  }

  private onMessage(message: { type: string; node?: string }): void {
    switch (message.type) {
      case "ready":
        this.ready = true;
        void this.push();
        return;
      case "toggleDirection":
        this.direction = this.direction === "TD" ? "LR" : "TD";
        void this.push();
        return;
      case "redraw":
        // Stop a draw already in flight so the new one starts now, not after it finishes.
        this.drawTokens?.cancel();
        this.drawn = null;
        this.drawGeneration += 1;
        this.view = "change";
        void this.push();
        return;
      case "pickModel":
        void pickStructureModel().then((chosen) => {
          if (chosen === undefined) return;
          this.drawTokens?.cancel();
          this.drawn = null;
          this.drawGeneration += 1;
          this.view = "change";
          void this.push();
        });
        return;
      case "renderFailed":
        // A model can emit mermaid that will not parse; fall back rather than show an error.
        if (this.view === "change") {
          this.drawn = null;
          this.view = "files";
          void this.push();
        }
        return;
      case "selectNode":
        this.select(message.node);
        return;
    }
  }

  private select(node: string | undefined): void {
    if (!node) return;

    if (this.view === "files") {
      const stepId = stepIdForNode(this.steps, node);
      if (stepId) this.onSelect(stepId);
      return;
    }

    const path = this.drawn?.files[node];
    const step = this.steps.find((candidate) => candidate.file.path === path);
    if (step) this.onSelect(step.id);
  }

  private async push(): Promise<void> {
    if (!this.ready) return;

    if (this.view === "files") {
      void this.panel.webview.postMessage({
        type: "render",
        view: "files",
        definition: buildMermaid(this.steps, this.graph, {
          direction: this.direction,
          group: this.grouped,
        }),
      });
      return;
    }

    if (!this.drawn && !this.drawing) {
      this.drawing = true;
      this.drawTokens?.cancel();
      this.drawTokens?.dispose();
      const tokens = beginExclusiveModelWork();
      this.drawTokens = tokens;
      const generation = this.drawGeneration;
      void this.panel.webview.postMessage({
        type: "busy",
        text: "Drawing the change…",
        detail: `${this.files.length} files`,
      });
      DiagramPanel.activity?.start("diagram", "Drawing the map…");

      const outcome = await drawDiagram({
        steps: this.steps,
        files: this.files,
        graph: this.graph,
        repositoryRoot: this.repositoryRoot,
        onProgress: (label) => {
          DiagramPanel.activity?.start("diagram", label);
          void this.panel.webview.postMessage({ type: "busy", detail: label });
        },
        onSource: (mermaid) =>
          void this.panel.webview.postMessage({ type: "source", text: mermaid }),
        onModel: (name) => void this.panel.webview.postMessage({ type: "model", text: name }),
        token: tokens.token,
      });
      this.drawing = false;
      clearExclusiveModelWork(tokens);
      DiagramPanel.activity?.done("diagram");
      this.drawTimer = outcome.timer ?? null;

      // Inputs changed while drawing; draw the current review rather than publish a
      // diagram of the one it replaced.
      if (generation !== this.drawGeneration) {
        void this.push();
        return;
      }

      // Another model view took over; leave the plain map without a failure notice.
      if (tokens.token.isCancellationRequested) {
        this.drawTimer?.cancelled();
        this.drawTimer = null;
        this.view = "files";
        void this.push();
        return;
      }

      this.drawn = outcome.diagram;

      if (!this.drawn) {
        // A silent fallback reads as a worse diagram rather than as a failure.
        this.view = "files";
        const reason = outcome.reason ?? "No diagram came back.";
        void this.panel.webview.postMessage({
          type: "status",
          text: `Showing the file map. ${reason}`,
        });
        void vscode.window.showWarningMessage(`PR Analyzer: ${reason}`, "Try again").then(
          (choice) => {
            if (choice === "Try again") {
              this.drawn = null;
              this.view = "change";
              void this.push();
            }
          },
        );
        void this.push();
        return;
      }

      // A successful draw is cached per commit, so reopening the map is instant.
      this.cache.save(this.drawn);
    }

    if (this.drawn) {
      void this.panel.webview.postMessage({
        type: "render",
        view: "change",
        definition:
          this.direction === "LR"
            ? this.drawn.mermaid.replace(/^flowchart\s+TD/, "flowchart LR")
            : this.drawn.mermaid,
      });
      this.drawTimer?.rendered();
      this.drawTimer = null;
    }
  }

  private html(): string {
    const script = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "diagram.js"),
    );
    const nonce = Array.from({ length: 32 }, () =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".charAt(
        Math.floor(Math.random() * 62),
      ),
    ).join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${this.panel.webview.cspSource} data:; style-src ${this.panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  html, body { height: 100%; margin: 0; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
  body { display: flex; flex-direction: column; }
  #toolbar { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); flex: none; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 3px; padding: 3px 9px; cursor: pointer; font-size: 12px; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 3px 8px; font-size: 12px; }
  #legend { display: flex; align-items: center; gap: 12px; margin-left: 10px; font-size: 11px; opacity: 0.85; }
  #legend span { display: inline-flex; align-items: center; gap: 5px; }
  .swatch { width: 10px; height: 10px; border-radius: 2px; border: 1px solid; }
  .swatch.new { background: #14432a; border-color: #3fb950; }
  .swatch.changed { background: #4d2d00; border-color: #d29922; }
  .swatch.context { background: #21262d; border-color: #6e7681; }
  #status { margin-left: auto; font-size: 11px; opacity: 0.75; }
  #progress { flex: none; height: 2px; background: transparent; overflow: hidden; }
  #progress.busy { background: var(--vscode-progressBar-background, #0e70c0); opacity: 0.25; }
  #progress.busy::after {
    content: ""; display: block; height: 100%; width: 32%;
    background: var(--vscode-progressBar-background, #0e70c0); opacity: 1;
    animation: slide 1.6s ease-in-out infinite;
  }
  @keyframes slide {
    0% { margin-left: -32%; }
    100% { margin-left: 100%; }
  }
  #overlay {
    position: absolute; inset: 0; display: none; place-items: center;
    background: var(--vscode-editor-background); opacity: 0.92; z-index: 5;
  }
  #overlay.busy { display: grid; }
  #overlay div { text-align: center; font-size: 13px; line-height: 1.8; }
  #overlay small { display: block; opacity: 0.7; font-size: 11px; }
  #overlay pre {
    display: none; text-align: left; margin: 12px auto 0; max-width: 680px; max-height: 40vh;
    overflow: auto; padding: 10px 12px; border-radius: 4px; font-size: 11px; line-height: 1.5;
    background: var(--vscode-textCodeBlock-background); color: var(--vscode-foreground);
    font-family: var(--vscode-editor-font-family); opacity: 0.8;
  }
  #overlay pre.written { display: block; }
  #stage { position: relative; flex: 1; min-height: 0; display: flex; }
  #surface { flex: 1; overflow: hidden; cursor: grab; touch-action: none; }
  #surface:active { cursor: grabbing; }
  #surface svg { width: 100%; height: 100%; }
  .bar { position: absolute; z-index: 4; background: var(--vscode-scrollbarSlider-shadow); opacity: 0; transition: opacity 120ms; }
  #stage:hover .bar, .bar.held { opacity: 1; }
  .bar.hidden { display: none; }
  #hbar { left: 0; right: 12px; bottom: 0; height: 12px; }
  #vbar { top: 0; bottom: 12px; right: 0; width: 12px; }
  .thumb { position: absolute; background: var(--vscode-scrollbarSlider-background); border-radius: 6px; }
  .thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
  .thumb.held { background: var(--vscode-scrollbarSlider-activeBackground); }
  #hbar .thumb { top: 2px; bottom: 2px; }
  #vbar .thumb { left: 2px; right: 2px; }
  g.node { cursor: pointer; }
  g.node:focus { outline: none; }
  g.node:focus rect, g.node:focus polygon, g.node:focus circle, g.node:focus ellipse {
    stroke: var(--vscode-focusBorder) !important; stroke-width: 3px !important;
  }
  .pr-current rect, .pr-current polygon, .pr-current circle { stroke: var(--vscode-focusBorder) !important; stroke-width: 3px !important; }
  .error { padding: 16px; color: var(--vscode-errorForeground); }
</style>
</head>
<body>
  <div id="toolbar">
    <button id="fit" title="Fit the whole diagram">Fit all</button>
    <button id="zoom-out" title="Zoom out">&minus;</button>
    <button id="zoom-in" title="Zoom in">+</button>
    <button id="direction" title="Vertical or horizontal">Direction</button>
    <button id="redraw" title="Draw it again">Redraw</button>
    <button id="model" title="Choose the model that draws this">Model</button>
    <input id="find" type="search" placeholder="Find…" size="16">
    <div id="legend">
      <span><i class="swatch new"></i>new</span>
      <span><i class="swatch changed"></i>changed</span>
      <span><i class="swatch context"></i>existing</span>
    </div>
    <span id="status" role="status" aria-live="polite"></span>
  </div>
  <div id="progress"></div>
  <div id="stage">
    <div id="surface"></div>
    <div id="hbar" class="bar hidden"><div class="thumb"></div></div>
    <div id="vbar" class="bar hidden"><div class="thumb"></div></div>
    <div id="overlay" role="status" aria-live="polite">
      <div>
        <span id="overlay-text">Drawing the change…</span>
        <small id="overlay-detail"></small>
        <pre id="overlay-source"></pre>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
