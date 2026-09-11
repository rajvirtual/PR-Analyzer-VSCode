export interface PullRequestIdentity {
  organization: string;
  project: string;
  repository: string;
  pullRequestId: number;
}

export class PullRequestUrlError extends Error {}

/**
 * Accepts the URLs Azure DevOps actually hands out, including the older
 * visualstudio.com host and links carrying query strings or fragments.
 */
export function parsePullRequestUrl(raw: string): PullRequestIdentity {
  const trimmed = raw.trim();
  if (!trimmed) throw new PullRequestUrlError("Paste a pull request URL.");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new PullRequestUrlError(`"${trimmed}" is not a URL.`);
  }

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  let organization: string | undefined;
  let rest = segments;

  if (host === "dev.azure.com") {
    organization = segments[0];
    rest = segments.slice(1);
  } else if (host.endsWith(".visualstudio.com")) {
    organization = host.split(".")[0];
  } else {
    throw new PullRequestUrlError(
      `${url.hostname} is not an Azure DevOps host. Expected dev.azure.com or *.visualstudio.com.`,
    );
  }

  const gitIndex = rest.indexOf("_git");
  if (!organization || gitIndex < 1) {
    throw new PullRequestUrlError(
      "That does not look like a pull request URL. Expected .../_git/<repo>/pullrequest/<id>.",
    );
  }

  const projectSegments = rest.slice(0, gitIndex);
  const project = projectSegments.join("/");
  const repository = rest[gitIndex + 1];
  const marker = rest[gitIndex + 2]?.toLowerCase();
  const id = Number(rest[gitIndex + 3]);

  if (!repository || marker !== "pullrequest" || !Number.isInteger(id) || id <= 0) {
    throw new PullRequestUrlError(
      "That does not look like a pull request URL. Expected .../_git/<repo>/pullrequest/<id>.",
    );
  }

  // A decoded segment carrying a slash or a dot-dot could climb out of the folders
  // these names are later joined into, so an odd one is refused rather than cleaned.
  if (![organization, repository, ...projectSegments].every(isCleanSegment)) {
    throw new PullRequestUrlError(
      "That pull request URL has an unexpected organization, project, or repository.",
    );
  }

  return { organization, project, repository, pullRequestId: id };
}

function isCleanSegment(value: string): boolean {
  return Boolean(value) && value !== "." && value !== ".." && !/[\\/\0]/.test(value);
}

export function pullRequestWebUrl(identity: PullRequestIdentity): string {
  const project = encodeURIComponent(identity.project);
  const repository = encodeURIComponent(identity.repository);
  return `https://dev.azure.com/${identity.organization}/${project}/_git/${repository}/pullrequest/${identity.pullRequestId}`;
}
