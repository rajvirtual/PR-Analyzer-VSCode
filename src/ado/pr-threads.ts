import type * as vscode from "vscode";
import type { PullRequestIdentity } from "./pr-url.js";
import { baseUrl, request } from "./ado-change-source.js";
import { buildThreadPayload, type ThreadAnchor } from "./thread-payload.js";

function signalFrom(token?: vscode.CancellationToken): AbortSignal | undefined {
  if (!token) return undefined;
  const controller = new AbortController();
  token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}

/** Posts a note to the pull request as a discussion thread, optionally anchored to a line. */
export async function createThread(
  identity: PullRequestIdentity,
  content: string,
  anchor?: ThreadAnchor,
  token?: vscode.CancellationToken,
): Promise<void> {
  await request(
    `${baseUrl(identity)}/pullRequests/${identity.pullRequestId}/threads`,
    {},
    "json",
    signalFrom(token),
    { method: "POST", body: JSON.stringify(buildThreadPayload(content, anchor)) },
  );
}
