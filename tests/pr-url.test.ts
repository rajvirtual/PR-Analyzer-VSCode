import { describe, expect, it } from "vitest";
import {
  parsePullRequestUrl,
  pullRequestWebUrl,
  PullRequestUrlError,
} from "../src/ado/pr-url.js";

describe("parsePullRequestUrl", () => {
  it("reads a dev.azure.com URL", () => {
    expect(
      parsePullRequestUrl("https://dev.azure.com/OpenEnergyPlatform/Garage/_git/OEP-RP/pullrequest/26577"),
    ).toEqual({
      organization: "OpenEnergyPlatform",
      project: "Garage",
      repository: "OEP-RP",
      pullRequestId: 26577,
    });
  });

  it("decodes a project name containing spaces", () => {
    expect(
      parsePullRequestUrl(
        "https://dev.azure.com/OpenEnergyPlatform/Open%20Energy%20Platform/_git/OEP-RP/pullrequest/26577",
      ).project,
    ).toBe("Open Energy Platform");
  });

  it("reads the older visualstudio.com host", () => {
    expect(
      parsePullRequestUrl("https://msazure.visualstudio.com/One/_git/repo/pullrequest/42"),
    ).toEqual({
      organization: "msazure",
      project: "One",
      repository: "repo",
      pullRequestId: 42,
    });
  });

  it("ignores a query string and fragment", () => {
    expect(
      parsePullRequestUrl(
        "https://dev.azure.com/org/proj/_git/repo/pullrequest/7?_a=files&path=/x.cs#comment",
      ).pullRequestId,
    ).toBe(7);
  });

  it("rejects a host that is not Azure DevOps", () => {
    expect(() => parsePullRequestUrl("https://github.com/o/r/pull/1")).toThrow(
      PullRequestUrlError,
    );
  });

  it("rejects a repository URL that is not a pull request", () => {
    expect(() => parsePullRequestUrl("https://dev.azure.com/org/proj/_git/repo")).toThrow(
      PullRequestUrlError,
    );
  });

  it("rejects a non-numeric pull request id", () => {
    expect(() =>
      parsePullRequestUrl("https://dev.azure.com/org/proj/_git/repo/pullrequest/abc"),
    ).toThrow(PullRequestUrlError);
  });

  it("rejects empty input with a usable message", () => {
    expect(() => parsePullRequestUrl("   ")).toThrow(/Paste a pull request URL/);
  });

  it("rejects text that is not a URL at all", () => {
    expect(() => parsePullRequestUrl("26577")).toThrow(PullRequestUrlError);
  });

  it("rejects an encoded path traversal in a segment", () => {
    expect(() =>
      parsePullRequestUrl(
        "https://dev.azure.com/org/proj/_git/foo%2F..%2F..%2Fbar/pullrequest/1",
      ),
    ).toThrow(PullRequestUrlError);
  });
});

describe("pullRequestWebUrl", () => {
  it("round-trips an identity back to a link", () => {
    const url = "https://dev.azure.com/org/Open%20Energy%20Platform/_git/repo/pullrequest/5";

    expect(pullRequestWebUrl(parsePullRequestUrl(url))).toBe(url);
  });
});
