import type * as vscode from "vscode";
import type { PullRequestIdentity } from "./pr-url.js";
import { AdoError, baseUrl, request } from "./ado-change-source.js";
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

/**
 * Uploads a file to the pull request, the way pasting an image into a comment does, and
 * returns the URL a comment can embed it by.
 */
export async function uploadAttachment(
  identity: PullRequestIdentity,
  fileName: string,
  bytes: Uint8Array,
  token?: vscode.CancellationToken,
): Promise<string> {
  const response = await request(
    `${baseUrl(identity)}/pullRequests/${identity.pullRequestId}/attachments/${encodeURIComponent(fileName)}`,
    {},
    "json",
    signalFrom(token),
    { method: "POST", body: bytes, contentType: "application/octet-stream" },
  );
  const attachment = (await response.json()) as { url?: string };
  if (!attachment.url) throw new AdoError("Azure DevOps accepted the image but returned no link to it.");
  return attachment.url;
}
