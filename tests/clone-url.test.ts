import { describe, expect, it } from "vitest";
import { cloneUrl } from "../src/git/clone-url.js";

const identity = {
  organization: "OpenEnergyPlatform",
  project: "Open Energy Platform",
  repository: "OSDU-Search",
  pullRequestId: 42,
};

describe("cloneUrl", () => {
  it("encodes a project name containing spaces", () => {
    expect(cloneUrl(identity)).toBe(
      "https://dev.azure.com/OpenEnergyPlatform/Open%20Energy%20Platform/_git/OSDU-Search",
    );
  });

  it("leaves a simple project name alone", () => {
    expect(cloneUrl({ ...identity, project: "Garage", repository: "ai-workspace" })).toBe(
      "https://dev.azure.com/OpenEnergyPlatform/Garage/_git/ai-workspace",
    );
  });

  it("encodes a repository name containing a space", () => {
    expect(cloneUrl({ ...identity, repository: "odd name" })).toContain("_git/odd%20name");
  });
});
