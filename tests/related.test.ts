import { describe, expect, it } from "vitest";
import {
  findRelated,
  linkedPullRequestIds,
  webUrl,
  workItemMentions,
  type PullRequestSummary,
} from "../src/feature/related.js";
import { parsePullRequestUrl } from "../src/ado/pr-url.js";

function pr(
  id: number,
  repository: string,
  overrides: Partial<PullRequestSummary> = {},
): PullRequestSummary {
  return {
    organization: "OpenEnergyPlatform",
    project: "Open Energy Platform",
    repository,
    pullRequestId: id,
    title: "",
    description: "",
    sourceRefName: "refs/heads/feature/x",
    targetRefName: "refs/heads/main",
    isDraft: false,
    ...overrides,
  };
}

// Shaped like the four AB#80805 pull requests: three share a branch, one lives in
// another project on a branch of its own, and none is linked to its work item.
const workflow = pr(27633, "OSDU-Ingestion-Workflow", {
  title: "AB#80805: Offload MI manifests to Dataset Service",
  sourceRefName: "refs/heads/feature/manifest-dataset-reference",
  targetRefName: "refs/heads/m26-master",
});
const library = pr(27634, "OSDU-Airflow-Lib", {
  title: "AB#80805: Harden MIR dataset processing for MI fusion",
  sourceRefName: "refs/heads/feature/manifest-dataset-reference",
});
const dags = pr(27635, "OSDU-Ingestion-Dags", {
  title: "AB#80805: Fuse MI and MIR execution paths",
  sourceRefName: "refs/heads/feature/manifest-dataset-reference",
});
const packaging = pr(27637, "osdu-adme-dev-workspaces", {
  project: "Garage",
  title: "AB#80805: Add Airflow 3 MI and MIR fusion project package",
  sourceRefName: "refs/heads/feature/AB-80805-mi-mir-fusion",
});
const unrelated = pr(30000, "OSDU-Search", {
  title: "AB#11111: Something else",
  sourceRefName: "refs/heads/feature/other",
});

describe("findRelated", () => {
  const everything = [workflow, library, dags, packaging, unrelated];

  it("finds all four pull requests of a feature from one of them, across projects", () => {
    const related = findRelated([workflow], everything);
    expect(related.map((entry) => entry.pullRequest.pullRequestId).sort()).toEqual([
      27634, 27635, 27637,
    ]);
  });

  it("gives every reason that applies, and ranks by how many", () => {
    const related = findRelated([workflow], everything);
    expect(related[0]!.reasons).toEqual([
      "mentions AB#80805",
      "same branch feature/manifest-dataset-reference",
    ]);
    const garage = related.find((entry) => entry.pullRequest.pullRequestId === 27637);
    expect(garage?.reasons).toEqual(["mentions AB#80805"]);
  });

  it("never offers a seed back as related", () => {
    const related = findRelated([workflow, library], everything);
    expect(related.map((entry) => entry.pullRequest.pullRequestId)).not.toContain(27634);
  });

  it("ignores a shared branch that everyone uses", () => {
    const onMain = pr(1, "a", { sourceRefName: "refs/heads/main" });
    const alsoMain = pr(2, "b", { sourceRefName: "refs/heads/main" });
    expect(findRelated([onMain], [alsoMain])).toEqual([]);
  });

  it("uses formally linked work items and links in either direction", () => {
    const seed = pr(1, "a", {
      description: "See https://dev.azure.com/o/p/_git/b/pullrequest/2",
      workItemIds: ["500"],
    });
    const linkedFrom = pr(2, "b", { sourceRefName: "refs/heads/b" });
    const linksBack = pr(3, "c", {
      sourceRefName: "refs/heads/c",
      description: "Pairs with /_git/a/pullrequest/1",
    });
    const viaWorkItem = pr(4, "d", { sourceRefName: "refs/heads/d" });
    const related = findRelated([seed], [linkedFrom, linksBack, viaWorkItem], new Map([[4, "500"]]));
    const reasons = Object.fromEntries(
      related.map((entry) => [entry.pullRequest.pullRequestId, entry.reasons]),
    );
    expect(reasons[2]).toEqual(["linked from !1"]);
    expect(reasons[3]).toEqual(["links to !1"]);
    expect(reasons[4]).toEqual(["linked to work item 500"]);
  });
});

describe("text signals", () => {
  it("reads work item mentions once each", () => {
    expect(workItemMentions("AB#80805: x, see ab#80805 and AB#12")).toEqual(["80805", "12"]);
  });

  it("reads pull request links", () => {
    expect(linkedPullRequestIds("a/pullrequest/27633 b/pullRequest/27634")).toEqual([27633, 27634]);
  });

  it("builds a web URL the URL parser reads back, spaces in the project included", () => {
    expect(parsePullRequestUrl(webUrl(workflow))).toEqual({
      organization: "OpenEnergyPlatform",
      project: "Open Energy Platform",
      repository: "OSDU-Ingestion-Workflow",
      pullRequestId: 27633,
    });
  });
});
