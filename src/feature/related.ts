import type { PullRequestIdentity } from "../ado/pr-url.js";

/**
 * Which pull requests belong to the same piece of work.
 *
 * Nothing in Azure DevOps ties a feature's pull requests together reliably: they are
 * often not linked to their work item, and their descriptions rarely link each other.
 * What they do share is a work item mentioned as AB#123, a source branch name, or a
 * link one way or the other — so each is a reason, and a candidate is offered with
 * every reason that applies to it.
 */

export interface PullRequestSummary extends PullRequestIdentity {
  title: string;
  description: string;
  sourceRefName: string;
  targetRefName: string;
  isDraft: boolean;
  /** Work items linked formally, when known. */
  workItemIds?: string[];
}

export interface RelatedPullRequest {
  pullRequest: PullRequestSummary;
  reasons: string[];
}

/** Work item mentions, as Azure Boards writes them: AB#80805. */
export function workItemMentions(text: string): string[] {
  return [...new Set([...text.matchAll(/\bAB#(\d+)\b/gi)].map((match) => match[1]!))];
}

/** Pull request ids this text links to, by URL. */
export function linkedPullRequestIds(text: string): number[] {
  return [
    ...new Set([...text.matchAll(/\/pullrequest\/(\d+)/gi)].map((match) => Number(match[1]))),
  ];
}

/** A source branch shared by accident rather than by design says nothing. */
const GENERIC_BRANCHES = /^refs\/heads\/(main|master|develop|dev|release(\/.*)?|m\d+-master)$/i;

function branchName(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

export function webUrl(pullRequest: PullRequestIdentity): string {
  return (
    `https://dev.azure.com/${encodeURIComponent(pullRequest.organization)}/` +
    `${encodeURIComponent(pullRequest.project)}/_git/` +
    `${encodeURIComponent(pullRequest.repository)}/pullrequest/${pullRequest.pullRequestId}`
  );
}

function workItemsOf(pullRequest: PullRequestSummary): Set<string> {
  return new Set([
    ...workItemMentions(`${pullRequest.title}\n${pullRequest.description}`),
    ...(pullRequest.workItemIds ?? []),
  ]);
}

/**
 * Candidates related to any of the seeds, strongest first.
 *
 * `linkedToWorkItems` maps a pull request id to the seed work item that links to it
 * formally, which is the strongest signal there is when it exists.
 */
export function findRelated(
  seeds: PullRequestSummary[],
  candidates: PullRequestSummary[],
  linkedToWorkItems: ReadonlyMap<number, string> = new Map(),
): RelatedPullRequest[] {
  const seedIds = new Set(seeds.map((seed) => seed.pullRequestId));
  const seedWorkItems = new Set(seeds.flatMap((seed) => [...workItemsOf(seed)]));
  const seedBranches = new Set(
    seeds.map((seed) => seed.sourceRefName).filter((ref) => ref && !GENERIC_BRANCHES.test(ref)),
  );
  const linkedFromSeeds = new Map<number, number>();
  for (const seed of seeds) {
    for (const id of linkedPullRequestIds(seed.description)) linkedFromSeeds.set(id, seed.pullRequestId);
  }

  const related: RelatedPullRequest[] = [];
  const seen = new Set<number>();
  for (const candidate of candidates) {
    if (seedIds.has(candidate.pullRequestId) || seen.has(candidate.pullRequestId)) continue;
    seen.add(candidate.pullRequestId);

    const reasons: string[] = [];
    const workItem = linkedToWorkItems.get(candidate.pullRequestId);
    if (workItem) reasons.push(`linked to work item ${workItem}`);

    const shared = [...workItemsOf(candidate)].filter((id) => seedWorkItems.has(id));
    if (shared.length > 0) reasons.push(`mentions ${shared.map((id) => `AB#${id}`).join(", ")}`);

    if (seedBranches.has(candidate.sourceRefName)) {
      reasons.push(`same branch ${branchName(candidate.sourceRefName)}`);
    }

    const linker = linkedFromSeeds.get(candidate.pullRequestId);
    if (linker !== undefined) reasons.push(`linked from !${linker}`);

    const linksBack = linkedPullRequestIds(candidate.description).filter((id) => seedIds.has(id));
    if (linksBack.length > 0) reasons.push(`links to ${linksBack.map((id) => `!${id}`).join(", ")}`);

    if (reasons.length > 0) related.push({ pullRequest: candidate, reasons });
  }

  return related.sort(
    (a, b) =>
      b.reasons.length - a.reasons.length || a.pullRequest.pullRequestId - b.pullRequest.pullRequestId,
  );
}
