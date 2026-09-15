import type { ChangedFile } from "../model/changeset.js";
import { validateDiagram, type DrawnDiagram } from "./diagram-prompt.js";

/**
 * The diagram as the model writes it, rather than wrapped in JSON.
 *
 * JSON cannot be shown until the last brace arrives, and a single unescaped quote
 * costs a whole second round trip. A fenced mermaid block streams as something the
 * reader can watch being written, and "the fence closed" is a far more robust success
 * condition than "the JSON parsed".
 */

const FENCE = /```(?:mermaid)?\s*\n([\s\S]*?)```/;
const OPEN_FENCE = /```(?:mermaid)?\s*\n([\s\S]*)$/;
const MAPPING = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*[=:]\s*(\S[^\n]*?)\s*$/;

/** The mermaid written so far, whether or not the model has closed the fence yet. */
export function mermaidSoFar(reply: string): string {
  return (FENCE.exec(reply) ?? OPEN_FENCE.exec(reply))?.[1]?.trimEnd() ?? "";
}

/** True once the block is complete, which is what makes it safe to render. */
export function fenceClosed(reply: string): boolean {
  return FENCE.test(reply);
}

/** Node-to-path lines, which the model writes after the fence. */
function fileMap(reply: string): Record<string, string> {
  const after = reply.slice(reply.search(FENCE) + (FENCE.exec(reply)?.[0]?.length ?? 0));
  const mapping: Record<string, string> = {};

  for (const line of after.split("\n")) {
    if (/^\s*```/.test(line)) break;
    const match = MAPPING.exec(line);
    // "files:" heads the list rather than naming a node.
    if (match?.[1] && match[2] && match[1].toLowerCase() !== "files") {
      mapping[match[1]] = match[2].replace(/^["'`]|["'`,]+$/g, "");
    }
  }

  return mapping;
}

export function parseDiagramReply(reply: string, files: ChangedFile[]): DrawnDiagram | null {
  if (!fenceClosed(reply)) return null;
  return validateDiagram({ mermaid: mermaidSoFar(reply), files: fileMap(reply) }, files);
}
