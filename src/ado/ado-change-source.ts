import type * as vscode from "vscode";
import type { ChangeSet, ChangedFile, ChangeType } from "../model/changeset.js";
import { parsePullRequestUrl, type PullRequestIdentity } from "./pr-url.js";
import { authorization } from "./ado-auth.js";
import { mapWithConcurrency } from "../analysis/concurrency.js";
import type { PullRequestIntent } from "../lm/intent-prompt.js";

const API_VERSION = "7.1";
const PAGE_SIZE = 500;
const MAX_FILES = 400;
/** Files fetched at once: enough to keep the network busy, not so many it swamps it. */
const FETCH_CONCURRENCY = 6;

export class AdoError extends Error {}

export function baseUrl(identity: PullRequestIdentity): string {
  const project = encodeURIComponent(identity.project);
  const repository = encodeURIComponent(identity.repository);
  return `https://dev.azure.com/${identity.organization}/${project}/_apis/git/repositories/${repository}`;
}

function orgUrl(identity: PullRequestIdentity): string {
  return `https://dev.azure.com/${identity.organization}`;
}

export async function request(
  url: string,
  query: Record<string, string>,
  accept: "json" | "text",
  signal?: AbortSignal,
  init?: { method?: string; body?: string },
): Promise<Response> {
  const target = new URL(url);
  for (const [name, value] of Object.entries(query)) target.searchParams.set(name, value);
  target.searchParams.set("api-version", API_VERSION);

  const response = await fetch(target, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: await authorization(true),
      Accept: accept === "json" ? "application/json" : "text/plain",
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init?.body,
    signal,
  });

  if (response.status === 401 || response.status === 403) {
    throw new AdoError(
      "Azure DevOps refused the request. Check you have access to this repository, or run " +
        "PR Analyzer: Sign in to Azure DevOps to use a different account or token.",
    );
  }
  if (!response.ok) {
    throw new AdoError(`Azure DevOps returned ${response.status} for ${target.pathname}`);
  }
  return response;
}

interface Iteration {
  id: number;
  sourceRefCommit?: { commitId?: string };
  commonRefCommit?: { commitId?: string };
}

interface ChangeEntry {
  changeType: string;
  item?: { path?: string; isFolder?: boolean; gitObjectType?: string };
  originalPath?: string;
}

function normalise(changeType: string): ChangeType {
  const value = changeType.toLowerCase();
  if (value.includes("rename")) return "rename";
  if (value.includes("add")) return "add";
  if (value.includes("delete")) return "delete";
  return "edit";
}

async function fileAtCommit(
  identity: PullRequestIdentity,
  path: string,
  commit: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const response = await request(
      `${baseUrl(identity)}/items`,
      {
        path,
        "versionDescriptor.version": commit,
        "versionDescriptor.versionType": "commit",
        includeContent: "true",
        $format: "text",
      },
      "text",
      signal,
    );
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * Builds the same change set shape as a local branch, from a pull request.
 *
 * Content is read at the pinned commits rather than checked out, so reviewing a
 * pull request never disturbs the working tree of a repository you have open.
 */
export async function buildPullRequestChangeSet(
  url: string,
  progress?: (message: string) => void,
  token?: vscode.CancellationToken,
): Promise<ChangeSet & { identity: PullRequestIdentity }> {
  const identity = parsePullRequestUrl(url);
  const aborter = new AbortController();
  token?.onCancellationRequested(() => aborter.abort());
  const signal = aborter.signal;
  const cancelled = (): boolean => token?.isCancellationRequested ?? false;

  progress?.("Signing in to Azure DevOps…");
  await authorization(true);

  progress?.(`Reading pull request ${identity.pullRequestId}…`);
  const iterations = (await (
    await request(
      `${baseUrl(identity)}/pullRequests/${identity.pullRequestId}/iterations`,
      {},
      "json",
      signal,
    )
  ).json()) as { value?: Iteration[] };

  const latest = iterations.value?.at(-1);
  const sourceCommit = latest?.sourceRefCommit?.commitId;
  const baseCommit = latest?.commonRefCommit?.commitId;
  if (!latest || !sourceCommit || !baseCommit) {
    throw new AdoError("That pull request has no readable iteration.");
  }

  const entries: ChangeEntry[] = [];
  for (let skip = 0; ; skip += PAGE_SIZE) {
    if (cancelled()) break;
    const page = (await (
      await request(
        `${baseUrl(identity)}/pullRequests/${identity.pullRequestId}/iterations/${latest.id}/changes`,
        { $top: String(PAGE_SIZE), $skip: String(skip) },
        "json",
        signal,
      )
    ).json()) as { changeEntries?: ChangeEntry[] };

    const batch = page.changeEntries ?? [];
    entries.push(...batch);
    if (batch.length < PAGE_SIZE || entries.length >= MAX_FILES) break;
  }

  // The final page can overshoot the cap; process only up to it, not the whole page.
  const capped = entries.slice(0, MAX_FILES);

  type Outcome = { file: ChangedFile } | { skip: { path: string; reason: string } } | null;
  let done = 0;

  // Fetched with a small pool rather than one file at a time, since a large pull
  // request is otherwise hundreds of round trips run back to back.
  const outcomes = await mapWithConcurrency<ChangeEntry, Outcome>(
    capped,
    FETCH_CONCURRENCY,
    async (entry) => {
      const raw = entry.item?.path;
      if (!raw || entry.item?.isFolder || entry.item?.gitObjectType === "tree") return null;

      const path = raw.replace(/^\//, "");
      const changeType = normalise(entry.changeType);
      const previousPath = entry.originalPath?.replace(/^\//, "");
      const before =
        changeType === "add"
          ? null
          : await fileAtCommit(identity, `/${previousPath ?? path}`, baseCommit, signal);
      const after =
        changeType === "delete"
          ? null
          : await fileAtCommit(identity, `/${path}`, sourceCommit, signal);

      done += 1;
      progress?.(`Fetching file ${done} of ${capped.length}…`);

      if (before === null && after === null) {
        return { skip: { path, reason: "no readable content" } };
      }
      if ((before && before.includes("\u0000")) || (after && after.includes("\u0000"))) {
        return { skip: { path, reason: "binary" } };
      }
      return { file: { path, changeType, previousPath, before, after } };
    },
    cancelled,
  );

  const files: ChangedFile[] = [];
  const skipped: { path: string; reason: string }[] = [];
  for (const outcome of outcomes) {
    if (!outcome) continue;
    if ("file" in outcome) files.push(outcome.file);
    else skipped.push(outcome.skip);
  }

  if (entries.length >= MAX_FILES) {
    skipped.push({ path: "…", reason: `only the first ${MAX_FILES} files were read` });
  }

  return {
    repositoryRoot: "",
    label: `${identity.repository} !${identity.pullRequestId}`,
    baseRef: baseCommit.slice(0, 12),
    mergeBase: baseCommit,
    headCommit: sourceCommit,
    identity,
    files,
    skipped,
  };
}

/** Reads a pull request's title, description, and linked work items — its stated intent. */
export async function fetchPullRequestIntent(
  identity: PullRequestIdentity,
  token?: vscode.CancellationToken,
): Promise<PullRequestIntent> {
  const aborter = new AbortController();
  token?.onCancellationRequested(() => aborter.abort());
  const signal = aborter.signal;

  const pr = (await (
    await request(`${baseUrl(identity)}/pullRequests/${identity.pullRequestId}`, {}, "json", signal)
  ).json()) as { title?: string; description?: string };

  let workItems: { id: string; title: string }[] = [];
  try {
    const refs = (await (
      await request(
        `${baseUrl(identity)}/pullRequests/${identity.pullRequestId}/workitems`,
        {},
        "json",
        signal,
      )
    ).json()) as { value?: { id?: string }[] };

    const ids = (refs.value ?? []).map((ref) => ref.id).filter((id): id is string => Boolean(id));
    if (ids.length > 0) {
      const batch = (await (
        await request(
          `${orgUrl(identity)}/_apis/wit/workitems`,
          { ids: ids.join(","), fields: "System.Title" },
          "json",
          signal,
        )
      ).json()) as { value?: { id?: number; fields?: Record<string, string> }[] };

      workItems = (batch.value ?? []).map((item) => ({
        id: String(item.id ?? ""),
        title: item.fields?.["System.Title"] ?? "",
      }));
    }
  } catch {
    // Work items are a bonus; the description alone is enough intent to map against.
  }

  return { title: pr.title ?? "", description: pr.description ?? "", workItems };
}
