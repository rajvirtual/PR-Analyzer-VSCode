import type { PullRequestIdentity } from "../ado/pr-url.js";

/** Compares two remote URLs by their meaningful parts, ignoring form and credentials. */
export function sameRepository(remoteUrl: string, identity: PullRequestIdentity): boolean {
  const normalised = remoteUrl
    .toLowerCase()
    .replace(/\.git(\s|$)/, "$1")
    .replace(/^origin\s+/, "")
    .replace(/git@ssh\.dev\.azure\.com:v3\//, "dev.azure.com/")
    .replace(/https?:\/\/[^@\s]*@/, "https://");

  const repository = identity.repository.toLowerCase();
  const organization = identity.organization.toLowerCase();
  if (!normalised.includes(organization)) return false;

  // The repository is the last meaningful path segment, so anchor on it rather than
  // matching anywhere: oep-rp and oep-rp-tools would otherwise look the same.
  return new RegExp(`/${escapeRegExp(repository)}(\\.git)?(\\s|$|/)`).test(normalised);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
