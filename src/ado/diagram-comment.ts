/**
 * The markdown for a pull request comment carrying the change map.
 *
 * The rendered image is what reviewers read: pull request comments do not reliably render
 * mermaid, and a description has a length limit a detailed map can exceed. The source follows
 * in a plain code block so the map can still be copied, edited, or redrawn.
 */

/** Well inside what Azure DevOps accepts for one comment, with room for the rest of it. */
export const MAX_SOURCE_CHARACTERS = 100_000;

export function buildDiagramComment(options: {
  imageUrl: string;
  mermaid: string;
  label?: string;
}): string {
  const heading = options.label ? `**Change map** — ${options.label}` : "**Change map**";
  const lines = [
    heading,
    "",
    `![Change map](${options.imageUrl})`,
    "",
  ];

  const source = options.mermaid.trim();
  if (source && source.length <= MAX_SOURCE_CHARACTERS) {
    // A fence longer than any backtick run inside it, so the source cannot close it early.
    const longestRun = Math.max(0, ...(source.match(/`+/g) ?? []).map((run) => run.length));
    const fence = "`".repeat(Math.max(3, longestRun + 1));
    lines.push("Mermaid source, to edit or redraw it:", "", `${fence}text`, source, fence, "");
  }

  lines.push("_Drawn by AI PR Analyzer._");
  return lines.join("\n");
}
