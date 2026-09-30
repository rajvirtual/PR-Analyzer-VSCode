/**
 * The markdown for a pull request comment carrying the change map.
 *
 * The rendered image is what reviewers read: pull request comments do not reliably render
 * mermaid, and a description has a length limit a detailed map can exceed. A link to the
 * extension follows, so whoever reads the comment can draw one for their own change.
 */

export const MARKETPLACE_URL =
  "https://marketplace.visualstudio.com/items?itemName=rajeshvijay.pr-analyzer";

export interface RelatedLink {
  label: string;
  url: string;
  /** The pull request this comment is posted on. */
  current?: boolean;
}

export function buildDiagramComment(options: {
  imageUrl: string;
  label?: string;
  /** Every pull request of a feature, so each comment leads to the others. */
  related?: RelatedLink[];
}): string {
  const heading = options.label ? `**Change map** — ${options.label}` : "**Change map**";
  // A comment shrinks the image to its column, which leaves a wide map unreadable and
  // cannot be zoomed. The image is uploaded at twice its drawn size, so it links to itself:
  // opened on its own, the browser shows it full size and zooms it.
  const lines = [
    heading,
    "",
    `[![Change map](${options.imageUrl})](${options.imageUrl})`,
    "",
    `[Open the full-size map](${options.imageUrl}) to read it and zoom in.`,
    "",
  ];

  if (options.related?.length) {
    lines.push("**Pull requests in this feature**", "");
    for (const link of options.related) {
      lines.push(`- [${link.label.replace(/[[\]]/g, "")}](${link.url})${link.current ? " — this one" : ""}`);
    }
    lines.push("");
  }

  lines.push(`_Drawn by [AI PR Analyzer](${MARKETPLACE_URL}) for VS Code._`);
  return lines.join("\n");
}
