/**
 * The Azure DevOps request body for a new pull request discussion thread.
 *
 * Kept apart from the network code so the shape a comment is posted in — including the
 * one-based line anchor and the leading-slash path Azure DevOps expects — can be checked
 * on its own.
 */
export interface ThreadAnchor {
  filePath: string;
  line: number;
}

export function buildThreadPayload(content: string, anchor?: ThreadAnchor): Record<string, unknown> {
  const body: Record<string, unknown> = {
    comments: [{ parentCommentId: 0, commentType: 1, content }],
    status: 1, // active
  };

  if (anchor) {
    const filePath = anchor.filePath.startsWith("/") ? anchor.filePath : `/${anchor.filePath}`;
    const line = Math.max(1, Math.floor(anchor.line));
    body.threadContext = {
      filePath,
      rightFileStart: { line, offset: 1 },
      rightFileEnd: { line, offset: 1 },
    };
  }

  return body;
}
