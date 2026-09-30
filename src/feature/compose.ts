import type { ChangeSet, Component } from "../model/changeset.js";
import type { PullRequestIdentity } from "../ado/pr-url.js";
import { workItemMentions } from "./related.js";

/** One pull request, read and (when possible) checked out, ready to join a feature. */
export interface FeaturePart {
  changeSet: ChangeSet;
  identity: PullRequestIdentity;
  url: string;
  title?: string;
  sourceRef?: string;
  targetRef?: string;
  isDraft?: boolean;
}

/**
 * Names each part by its repository, falling back to the pull request id only when two
 * parts come from the same repository — the one case where the name alone would merge
 * two different changes into one folder.
 */
function componentNames(parts: FeaturePart[]): string[] {
  const counts = new Map<string, number>();
  for (const part of parts) {
    counts.set(part.identity.repository, (counts.get(part.identity.repository) ?? 0) + 1);
  }
  return parts.map((part) =>
    (counts.get(part.identity.repository) ?? 0) > 1
      ? `${part.identity.repository}-pr${part.identity.pullRequestId}`
      : part.identity.repository,
  );
}

/** The work item the parts share, if they name one, for the review's heading. */
export function sharedWorkItem(parts: FeaturePart[]): string | undefined {
  const counts = new Map<string, number>();
  for (const part of parts) {
    for (const id of workItemMentions(part.title ?? "")) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return best && best[1] >= 2 ? best[0] : undefined;
}

/**
 * Several pull requests as one change.
 *
 * Every path is prefixed with its component's name, so the Files view, F7, the
 * read-through and the reading order all work on the whole feature unchanged. There is
 * no single repository root: each component carries its own.
 */
export function composeFeature(parts: FeaturePart[]): ChangeSet {
  const names = componentNames(parts);
  const components: Component[] = parts.map((part, index) => ({
    name: names[index]!,
    repositoryRoot: part.changeSet.repositoryRoot,
    identity: part.identity,
    url: part.url,
    title: part.title,
    sourceRef: part.sourceRef,
    targetRef: part.targetRef,
    isDraft: part.isDraft,
    headCommit: part.changeSet.headCommit,
  }));

  const files = parts.flatMap((part, index) =>
    part.changeSet.files.map((file) => ({
      ...file,
      path: `${names[index]}/${file.path}`,
      previousPath: file.previousPath ? `${names[index]}/${file.previousPath}` : undefined,
    })),
  );
  const skipped = parts.flatMap((part, index) =>
    part.changeSet.skipped.map((entry) => ({ ...entry, path: `${names[index]}/${entry.path}` })),
  );

  // Stable for the same pull requests at the same commits, whatever order they were given in,
  // so progress and the drawn map are remembered for exactly this state of the feature.
  const pinned = parts
    .map((part) => `${part.identity.organization}/${part.identity.pullRequestId}@${part.changeSet.headCommit ?? part.changeSet.mergeBase}`)
    .sort()
    .join(",");

  const workItem = sharedWorkItem(parts);
  return {
    repositoryRoot: "",
    label: `${workItem ? `AB#${workItem}` : "Feature"}: ${parts.length} pull requests`,
    baseRef: "",
    mergeBase: `feature:${pinned}`,
    headCommit: `feature:${pinned}`,
    files,
    skipped,
    components,
  };
}
