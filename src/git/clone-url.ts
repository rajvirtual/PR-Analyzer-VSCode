import type { PullRequestIdentity } from "../ado/pr-url.js";

/** The https clone URL for a pull request's repository. */
export function cloneUrl(identity: PullRequestIdentity): string {
  const project = encodeURIComponent(identity.project);
  const repository = encodeURIComponent(identity.repository);
  return `https://dev.azure.com/${identity.organization}/${project}/_git/${repository}`;
}
