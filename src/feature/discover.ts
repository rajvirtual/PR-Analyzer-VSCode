import type * as vscode from "vscode";
import { baseUrl, request } from "../ado/ado-change-source.js";
import type { PullRequestIdentity } from "../ado/pr-url.js";
import { mapWithConcurrency } from "../analysis/concurrency.js";
import {
  findRelated,
  workItemMentions,
  type PullRequestSummary,
  type RelatedPullRequest,
} from "./related.js";

/** Enough active pull requests per project for any real organisation, bounded for a huge one. */
const PAGE = 500;
const MAX_PER_PROJECT = 2000;

interface PullRequestJson {
  pullRequestId?: number;
  title?: string;
  description?: string;
  sourceRefName?: string;
  targetRefName?: string;
  isDraft?: boolean;
  repository?: { name?: string; project?: { name?: string } };
}

function summaryOf(organization: string, json: PullRequestJson): PullRequestSummary | null {
  const repository = json.repository?.name;
  const project = json.repository?.project?.name;
  if (!json.pullRequestId || !repository || !project) return null;
  return {
    organization,
    project,
    repository,
    pullRequestId: json.pullRequestId,
    title: json.title ?? "",
    description: json.description ?? "",
    sourceRefName: json.sourceRefName ?? "",
    targetRefName: json.targetRefName ?? "",
    isDraft: Boolean(json.isDraft),
  };
}

function orgUrl(organization: string): string {
  return `https://dev.azure.com/${encodeURIComponent(organization)}`;
}

/** One pull request, with the work items linked to it. */
export async function fetchSummary(
  identity: PullRequestIdentity,
  signal?: AbortSignal,
): Promise<PullRequestSummary> {
  const json = (await (
    await request(`${baseUrl(identity)}/pullRequests/${identity.pullRequestId}`, {}, "json", signal)
  ).json()) as PullRequestJson;
  const summary = summaryOf(identity.organization, json) ?? {
    ...identity,
    title: json.title ?? "",
    description: json.description ?? "",
    sourceRefName: json.sourceRefName ?? "",
    targetRefName: json.targetRefName ?? "",
    isDraft: Boolean(json.isDraft),
  };

  try {
    const refs = (await (
      await request(
        `${baseUrl(identity)}/pullRequests/${identity.pullRequestId}/workitems`,
        {},
        "json",
        signal,
      )
    ).json()) as { value?: { id?: string }[] };
    summary.workItemIds = (refs.value ?? [])
      .map((ref) => ref.id)
      .filter((id): id is string => Boolean(id));
  } catch {
    // Linked work items sharpen the search; their absence does not stop it.
  }
  return summary;
}

async function listProjects(organization: string, signal?: AbortSignal): Promise<string[]> {
  const json = (await (
    await request(`${orgUrl(organization)}/_apis/projects`, { $top: "200" }, "json", signal)
  ).json()) as { value?: { name?: string }[] };
  return (json.value ?? []).map((project) => project.name).filter((name): name is string => Boolean(name));
}

async function listActive(
  organization: string,
  project: string,
  signal?: AbortSignal,
): Promise<PullRequestSummary[]> {
  const found: PullRequestSummary[] = [];
  for (let skip = 0; skip < MAX_PER_PROJECT; skip += PAGE) {
    const json = (await (
      await request(
        `${orgUrl(organization)}/${encodeURIComponent(project)}/_apis/git/pullrequests`,
        { "searchCriteria.status": "active", $top: String(PAGE), $skip: String(skip) },
        "json",
        signal,
      )
    ).json()) as { value?: PullRequestJson[] };
    const page = json.value ?? [];
    for (const item of page) {
      const summary = summaryOf(organization, item);
      if (summary) found.push(summary);
    }
    if (page.length < PAGE) break;
  }
  return found;
}

/** Pull requests the given work items link to formally, mapped to the linking work item. */
async function linkedByWorkItems(
  organization: string,
  workItemIds: string[],
  signal?: AbortSignal,
): Promise<Map<number, string>> {
  const linked = new Map<number, string>();
  if (workItemIds.length === 0) return linked;
  const json = (await (
    await request(
      `${orgUrl(organization)}/_apis/wit/workitems`,
      { ids: workItemIds.slice(0, 200).join(","), $expand: "relations" },
      "json",
      signal,
    )
  ).json()) as { value?: { id?: number; relations?: { url?: string }[] }[] };

  for (const item of json.value ?? []) {
    for (const relation of item.relations ?? []) {
      // vstfs:///Git/PullRequestId/{project}%2F{repository}%2F{id}
      const match = /^vstfs:\/\/\/Git\/PullRequestId\/(.+)$/i.exec(relation.url ?? "");
      const id = Number(decodeURIComponent(match?.[1] ?? "").split("/").pop());
      if (id) linked.set(id, String(item.id ?? ""));
    }
  }
  return linked;
}

export interface Discovery {
  seeds: PullRequestSummary[];
  related: RelatedPullRequest[];
  /** Set when the search could not run in full, so the reader knows it is partial. */
  note?: string;
}

/**
 * The seeds, and every active pull request in the organisation that looks like part of
 * the same work. A feature routinely spans projects, so all of them are searched.
 */
export async function discoverRelated(
  seeds: PullRequestIdentity[],
  progress: (message: string) => void,
  token?: vscode.CancellationToken,
): Promise<Discovery> {
  const aborter = new AbortController();
  token?.onCancellationRequested(() => aborter.abort());
  const signal = aborter.signal;

  progress("Reading the pull requests you pasted…");
  const summaries = await mapWithConcurrency(seeds, 4, (seed) => fetchSummary(seed, signal));

  const organizations = [...new Set(summaries.map((seed) => seed.organization))];
  const candidates: PullRequestSummary[] = [];
  const linked = new Map<number, string>();
  const problems: string[] = [];

  for (const organization of organizations) {
    let projects: string[];
    try {
      projects = await listProjects(organization, signal);
    } catch {
      // Listing projects can be refused where reading them is not; search what is known.
      projects = [...new Set(summaries.map((seed) => seed.project))];
      problems.push(`could not list ${organization}'s projects, so only the pasted ones were searched`);
    }

    progress(`Searching ${projects.length} project${projects.length === 1 ? "" : "s"} for related pull requests…`);
    const pages = await mapWithConcurrency(projects, 4, async (project) => {
      try {
        return await listActive(organization, project, signal);
      } catch {
        problems.push(`could not search ${project}`);
        return [];
      }
    });
    candidates.push(...pages.flat());

    const workItems = [
      ...new Set(
        summaries
          .filter((seed) => seed.organization === organization)
          .flatMap((seed) => [
            ...(seed.workItemIds ?? []),
            ...workItemMentions(`${seed.title}\n${seed.description}`),
          ]),
      ),
    ];
    try {
      for (const [id, workItem] of await linkedByWorkItems(organization, workItems, signal)) {
        linked.set(id, workItem);
      }
    } catch {
      problems.push("could not read the linked work items");
    }
  }

  return {
    seeds: summaries,
    related: findRelated(summaries, candidates, linked),
    note: problems.length > 0 ? problems.join("; ") : undefined,
  };
}
