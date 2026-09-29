/**
 * The markdown for a pull request comment carrying the change map.
 *
 * The rendered image is what reviewers read: pull request comments do not reliably render
 * mermaid, and a description has a length limit a detailed map can exceed. A link to the
 * extension follows, so whoever reads the comment can draw one for their own change.
 */

export const MARKETPLACE_URL =
  "https://marketplace.visualstudio.com/items?itemName=rajeshvijay.pr-analyzer";

export function buildDiagramComment(options: { imageUrl: string; label?: string }): string {
  const heading = options.label ? `**Change map** — ${options.label}` : "**Change map**";
  return [
    heading,
    "",
    `![Change map](${options.imageUrl})`,
    "",
    `_Drawn by [AI PR Analyzer](${MARKETPLACE_URL}) for VS Code._`,
  ].join("\n");
}
