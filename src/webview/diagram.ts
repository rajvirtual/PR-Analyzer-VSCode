import mermaid from "mermaid";
import elk from "@mermaid-js/layout-elk";

/**
 * The diagram surface.
 *
 * A tall graph fitted to the viewport shrinks its labels to nothing, so the default
 * view fits the WIDTH and leaves the height to scrolling. Everything after the first
 * render is a viewBox transform, which stays smooth at any size.
 */

interface HostApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): HostApi;

const vscode = acquireVsCodeApi();

const surface = document.getElementById("surface") as HTMLDivElement;
const status = document.getElementById("status") as HTMLSpanElement;
const findBox = document.getElementById("find") as HTMLInputElement;
const progress = document.getElementById("progress") as HTMLDivElement;
const overlay = document.getElementById("overlay") as HTMLDivElement;
const overlayText = document.getElementById("overlay-text") as HTMLSpanElement;
const overlayDetail = document.getElementById("overlay-detail") as HTMLElement;

const modelButton = document.getElementById("model") as HTMLButtonElement;

let startedAt = 0;
let ticker: number | undefined;

/** Drawing takes long enough with tool lookups that silence reads as a hang. */
function setBusy(text: string | undefined, detail: string | undefined): void {
  progress.classList.add("busy");
  overlay.classList.add("busy");
  if (text) overlayText.textContent = text;
  if (detail) overlayDetail.textContent = detail;

  if (ticker === undefined) {
    startedAt = Date.now();
    ticker = window.setInterval(() => {
      status.textContent = `${Math.floor((Date.now() - startedAt) / 1000)}s`;
    }, 1000);
  }
}

function setIdle(): void {
  progress.classList.remove("busy");
  overlay.classList.remove("busy");
  if (ticker !== undefined) {
    window.clearInterval(ticker);
    ticker = undefined;
  }
}

let svg: SVGSVGElement | null = null;
let viewBox = { x: 0, y: 0, width: 0, height: 0 };
let natural = { x: 0, y: 0, width: 0, height: 0 };
let currentNode: string | null = null;

mermaid.registerLayoutLoaders(elk);

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "dark",
  maxTextSize: 500_000,
  // Dagre sizes a subgraph to span every rank its members touch, so one node wired
  // to a distant one leaves an acre of empty grey. ELK packs the box to its contents.
  layout: "elk",
  // Declaration order is the model's, and it is not trustworthy: forcing the layout to
  // honour it stacked step 12 between 7 and 8. The arrows decide placement; the numbers
  // are corrected to match them before the diagram gets here.
  elk: { mergeEdges: true, nodePlacementStrategy: "BRANDES_KOEPF" },
  flowchart: { useMaxWidth: false, htmlLabels: false, nodeSpacing: 40, rankSpacing: 50 },
});

function applyViewBox(): void {
  svg?.setAttribute("viewBox", `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`);
  if (natural.width > 0) {
    status.textContent = `${Math.round((natural.width / viewBox.width) * 100)}%`;
  }
  updateBars();
}

/**
 * Scrollbars over a viewBox.
 *
 * The diagram is panned by moving the viewBox rather than by scrolling a document,
 * so there is nothing for the browser to put a scrollbar on. These show the same
 * thing a real one would: how much of the diagram is on screen, and where.
 */

const bars = {
  h: document.getElementById("hbar") as HTMLDivElement,
  v: document.getElementById("vbar") as HTMLDivElement,
};

/** Half a screen of slack past the edges, so a node at the margin can be centred. */
function travel(axis: "x" | "y"): { min: number; span: number; view: number } {
  const size = axis === "x" ? natural.width : natural.height;
  const view = axis === "x" ? viewBox.width : viewBox.height;
  const start = axis === "x" ? natural.x : natural.y;
  const slack = view / 2;
  const min = start - slack;
  return { min, span: Math.max(size + slack * 2, view), view };
}

function updateBars(): void {
  for (const [axis, bar] of [["x", bars.h], ["y", bars.v]] as const) {
    const thumb = bar.firstElementChild as HTMLDivElement | null;
    if (!thumb) continue;

    const { min, span, view } = travel(axis);
    const visible = natural.width > 0 && view < span - 1;
    bar.classList.toggle("hidden", !visible);
    if (!visible) continue;

    const fraction = Math.min(1, view / span);
    const offset = Math.max(0, Math.min(1 - fraction, ((axis === "x" ? viewBox.x : viewBox.y) - min) / span));

    if (axis === "x") {
      thumb.style.left = `${offset * 100}%`;
      thumb.style.width = `${fraction * 100}%`;
    } else {
      thumb.style.top = `${offset * 100}%`;
      thumb.style.height = `${fraction * 100}%`;
    }
  }
}

for (const [axis, bar] of [["x", bars.h], ["y", bars.v]] as const) {
  const thumb = bar.firstElementChild as HTMLDivElement | null;
  if (!thumb) continue;

  let grab: { pointer: number; start: number; origin: number } | null = null;

  const length = () => (axis === "x" ? bar.clientWidth : bar.clientHeight);

  thumb.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    grab = {
      pointer: event.pointerId,
      start: axis === "x" ? event.clientX : event.clientY,
      origin: axis === "x" ? viewBox.x : viewBox.y,
    };
    thumb.setPointerCapture(event.pointerId);
    thumb.classList.add("held");
    bar.classList.add("held");
  });

  thumb.addEventListener("pointermove", (event) => {
    if (!grab) return;
    const { span } = travel(axis);
    const moved = (axis === "x" ? event.clientX : event.clientY) - grab.start;
    const shift = (moved / Math.max(1, length())) * span;
    if (axis === "x") viewBox.x = grab.origin + shift;
    else viewBox.y = grab.origin + shift;
    applyViewBox();
  });

  const release = (event: PointerEvent) => {
    if (!grab) return;
    grab = null;
    thumb.releasePointerCapture(event.pointerId);
    thumb.classList.remove("held");
    bar.classList.remove("held");
  };
  thumb.addEventListener("pointerup", release);
  thumb.addEventListener("pointercancel", release);

  // A click on the track jumps a screen, the way a scrollbar does.
  bar.addEventListener("pointerdown", (event) => {
    if (event.target !== bar) return;
    const rect = bar.getBoundingClientRect();
    const at = axis === "x" ? event.clientX - rect.left : event.clientY - rect.top;
    const thumbStart = axis === "x" ? thumb.offsetLeft : thumb.offsetTop;
    const step = axis === "x" ? viewBox.width : viewBox.height;
    const forward = at > thumbStart;
    if (axis === "x") viewBox.x += forward ? step : -step;
    else viewBox.y += forward ? step : -step;
    applyViewBox();
  });
}

function aspect(): number {
  return surface.clientHeight / Math.max(1, surface.clientWidth);
}

/** Readable by default: match the width and let the reader scroll down the flow. */
function fitWidth(): void {
  viewBox = {
    x: natural.x,
    y: natural.y,
    width: natural.width,
    height: natural.width * aspect(),
  };
  applyViewBox();
}

function fitAll(): void {
  const height = Math.max(natural.height, natural.width * aspect());
  viewBox = {
    x: natural.x,
    y: natural.y,
    width: height / aspect(),
    height,
  };
  applyViewBox();
}

function zoomBy(factor: number, originX = 0.5, originY = 0.5): void {
  if (!svg) return;
  const width = Math.max(natural.width / 40, Math.min(natural.width * 8, viewBox.width / factor));
  const height = width * (viewBox.height / viewBox.width);
  viewBox = {
    x: viewBox.x + (viewBox.width - width) * originX,
    y: viewBox.y + (viewBox.height - height) * originY,
    width,
    height,
  };
  applyViewBox();
}

function nodeIdOf(element: Element): string | null {
  return /(?:^|-)([a-zA-Z][a-zA-Z0-9]*)(?:-\d+)?$/.exec(element.id)?.[1] ?? null;
}

function highlight(nodeId: string | null): void {
  if (!svg) return;
  for (const node of svg.querySelectorAll(".pr-current")) node.classList.remove("pr-current");
  currentNode = nodeId;
  if (!nodeId) return;

  for (const node of svg.querySelectorAll("g.node")) {
    if (nodeIdOf(node) === nodeId) {
      node.classList.add("pr-current");
      centreOn(node);
      return;
    }
  }
}

function centreOn(element: Element): void {
  const box = (element as SVGGraphicsElement).getBBox?.();
  if (!box) return;
  viewBox = {
    x: box.x + box.width / 2 - viewBox.width / 2,
    y: box.y + box.height / 2 - viewBox.height / 2,
    width: viewBox.width,
    height: viewBox.height,
  };
  applyViewBox();
}

let renderSeq = 0;

/** Mermaid's parse errors say so; retrying one only wastes a call and leaks a second graphic. */
function isSyntaxError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /syntax error|parse error|no diagram type/i.test(message);
}

/**
 * Renders the diagram, cleaning up after a failure.
 *
 * The ELK layout module loads on first use, so mermaid's first render can lose that race and
 * throw; one retry after a tick lets it settle. Mermaid also leaves an error graphic in the
 * DOM when it fails, so each failed attempt's node is removed before the caller falls back.
 */
async function draw(definition: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const id = `diagram-${(renderSeq += 1)}`;
    try {
      return (await mermaid.render(id, definition)).svg;
    } catch (error) {
      lastError = error;
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
      if (attempt === 1 || isSyntaxError(error)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

async function render(definition: string): Promise<void> {
  surface.innerHTML = "";
  try {
    surface.innerHTML = await draw(definition);
  } catch (error) {
    setIdle();
    status.textContent = "";
    vscode.postMessage({ type: "renderFailed" });
    // Built as text, never interpolated as HTML: the message can carry model output.
    const message = document.createElement("p");
    message.className = "error";
    message.textContent = `The diagram could not be drawn: ${
      error instanceof Error ? error.message : String(error)
    }`;
    surface.replaceChildren(message);
    return;
  }

  setIdle();
  svg = surface.querySelector("svg");
  if (!svg) return;

  svg.removeAttribute("width");
  svg.removeAttribute("height");
  const box = svg.getBBox();
  natural = { x: box.x - 20, y: box.y - 20, width: box.width + 40, height: box.height + 40 };

  // A flow taller than it is wide is the common case; fitting all of it makes the
  // labels unreadable, which is the one thing a map must not do.
  if (natural.height > natural.width * aspect()) fitWidth();
  else fitAll();

  for (const node of svg.querySelectorAll("g.node")) {
    node.setAttribute("tabindex", "0");
    node.setAttribute("role", "button");
    const activate = (): void => {
      const id = nodeIdOf(node);
      if (id) vscode.postMessage({ type: "selectNode", node: id });
    };
    node.addEventListener("click", activate);
    node.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      if (key === "Enter" || key === " ") {
        event.preventDefault();
        activate();
      }
    });
  }

  if (currentNode) highlight(currentNode);
}

let dragging: { x: number; y: number } | null = null;

surface.addEventListener("pointerdown", (event) => {
  dragging = { x: event.clientX, y: event.clientY };
  surface.setPointerCapture(event.pointerId);
});

surface.addEventListener("pointermove", (event) => {
  if (!dragging || !svg) return;
  const scale = viewBox.width / surface.clientWidth;
  viewBox.x -= (event.clientX - dragging.x) * scale;
  viewBox.y -= (event.clientY - dragging.y) * scale;
  dragging = { x: event.clientX, y: event.clientY };
  applyViewBox();
});

surface.addEventListener("pointerup", (event) => {
  dragging = null;
  surface.releasePointerCapture(event.pointerId);
});

surface.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();

    // With scrollbars on screen, a wheel that zooms is a surprise: it scrolls, and
    // zooms only when held with a modifier, the way an editor does.
    if (!event.ctrlKey && !event.metaKey) {
      const scale = viewBox.width / Math.max(1, surface.clientWidth);
      viewBox.x += event.deltaX * scale;
      viewBox.y += event.deltaY * scale;
      applyViewBox();
      return;
    }

    const rect = surface.getBoundingClientRect();
    zoomBy(
      event.deltaY < 0 ? 1.15 : 1 / 1.15,
      (event.clientX - rect.left) / rect.width,
      (event.clientY - rect.top) / rect.height,
    );
  },
  { passive: false },
);

document.getElementById("zoom-in")?.addEventListener("click", () => zoomBy(1.25));
document.getElementById("zoom-out")?.addEventListener("click", () => zoomBy(1 / 1.25));
document.getElementById("fit")?.addEventListener("click", fitAll);
document
  .getElementById("direction")
  ?.addEventListener("click", () => vscode.postMessage({ type: "toggleDirection" }));
document
  .getElementById("redraw")
  ?.addEventListener("click", () => {
    setBusy("Drawing the change…", "");
    vscode.postMessage({ type: "redraw" });
  });
document
  .getElementById("model")
  ?.addEventListener("click", () => vscode.postMessage({ type: "pickModel" }));

findBox?.addEventListener("input", () => {
  const query = findBox.value.trim().toLowerCase();
  if (!svg || !query) return;
  for (const node of svg.querySelectorAll("g.node")) {
    if ((node.textContent ?? "").toLowerCase().includes(query)) {
      centreOn(node);
      return;
    }
  }
});

window.addEventListener("resize", () => {
  if (natural.width > 0) fitWidth();
});

window.addEventListener("message", (event) => {
  const message = event.data as {
    type: string;
    definition?: string;
    view?: string;
    node?: string;
    text?: string;
    detail?: string;
  };
  if (message.type === "render" && message.definition) {
    void render(message.definition);
  }
  if (message.type === "busy") setBusy(message.text, message.detail);
  if (message.type === "model" && message.text) modelButton.textContent = message.text;
  if (message.type === "highlight") highlight(message.node ?? null);
  if (message.type === "status" && message.text) {
    setIdle();
    status.textContent = message.text;
  }
});

setBusy("Reading the change…", "");
vscode.postMessage({ type: "ready" });
