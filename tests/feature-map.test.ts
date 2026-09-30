import { describe, expect, it } from "vitest";
import type { ChangeSet } from "../src/model/changeset.js";
import { buildFeatureMapPrompt, FEATURE_MAP_SYSTEM_PROMPT } from "../src/feature/map-prompt.js";
import { DIAGRAM_SYSTEM_PROMPT } from "../src/lm/diagram-prompt.js";
import { parseDiagramReply } from "../src/lm/diagram-reply.js";
import { buildSteps } from "../src/session.js";
import type { Contract } from "../src/feature/contracts.js";

const feature: ChangeSet = {
  repositoryRoot: "",
  label: "AB#80805: 2 pull requests",
  baseRef: "",
  mergeBase: "feature:x",
  headCommit: "feature:x",
  files: [
    { path: "OSDU-Airflow-Lib/osdu_airflow/operators/mir.py", changeType: "edit", before: "a", after: "b" },
    { path: "OSDU-Ingestion-Dags/dags/fusion.py", changeType: "add", before: null, after: "c" },
  ],
  skipped: [],
  components: [
    {
      name: "OSDU-Airflow-Lib",
      repositoryRoot: "",
      identity: { organization: "o", project: "p", repository: "OSDU-Airflow-Lib", pullRequestId: 27634 },
      url: "u1",
      title: "Harden MIR",
    },
    {
      name: "OSDU-Ingestion-Dags",
      repositoryRoot: "",
      identity: { organization: "o", project: "p", repository: "OSDU-Ingestion-Dags", pullRequestId: 27635 },
      url: "u2",
      title: "Fuse MI and MIR",
    },
  ],
};

const contracts: Contract[] = [
  {
    from: "OSDU-Ingestion-Dags",
    to: "OSDU-Airflow-Lib",
    kind: "import",
    detail: "imports osdu_airflow.operators",
    files: ["OSDU-Ingestion-Dags/dags/fusion.py"],
  },
];

describe("the feature map prompt", () => {
  it("is separate from the locked single pull request prompt", () => {
    expect(FEATURE_MAP_SYSTEM_PROMPT).not.toBe(DIAGRAM_SYSTEM_PROMPT);
    expect(FEATURE_MAP_SYSTEM_PROMPT).toContain("ONE subgraph per component");
    expect(FEATURE_MAP_SYSTEM_PROMPT).toContain('It must begin with "flowchart TD"');
  });

  it("gives the model every component, the links found in the code, and the reading order", () => {
    const prompt = buildFeatureMapPrompt(feature, buildSteps(feature), contracts);
    expect(prompt).toContain('- OSDU-Airflow-Lib: pull request !27634 "Harden MIR", 1 file');
    expect(prompt).toContain(
      "OSDU-Ingestion-Dags -> OSDU-Airflow-Lib: imports osdu_airflow.operators (in OSDU-Ingestion-Dags/dags/fusion.py)",
    );
    expect(prompt).toContain("Draw how these 2 components fit together");
  });

  it("asks the model to search when the code showed no links", () => {
    expect(buildFeatureMapPrompt(feature, buildSteps(feature), [])).toContain(
      "None were found in the changed code",
    );
  });

  it("maps nodes to component-prefixed paths, so clicking a node opens its file", () => {
    const reply = [
      "```mermaid",
      "flowchart TD",
      '  subgraph s1["OSDU-Airflow-Lib"]',
      '    a["1. process_dataset_reference reads the reference"]',
      "  end",
      '  subgraph s2["OSDU-Ingestion-Dags"]',
      '    b["2. Fusion DAG calls it"]',
      "  end",
      '  b -->|"imports osdu_airflow.operators"| a',
      "```",
      "files:",
      "a = OSDU-Airflow-Lib/osdu_airflow/operators/mir.py",
      "b = OSDU-Ingestion-Dags/dags/fusion.py",
      "c = Not-A-Component/x.py",
    ].join("\n");
    const drawn = parseDiagramReply(reply, feature.files);
    expect(drawn?.files).toEqual({
      a: "OSDU-Airflow-Lib/osdu_airflow/operators/mir.py",
      b: "OSDU-Ingestion-Dags/dags/fusion.py",
    });
  });

  it("lists the components in the order the feature runs and asks for the flow to read downward", () => {
    // The Dags run first here: its step comes first in the reading order.
    const steps = buildSteps(feature, [
      { path: "OSDU-Ingestion-Dags/dags/fusion.py" },
      { path: "OSDU-Airflow-Lib/osdu_airflow/operators/mir.py" },
    ]);
    const prompt = buildFeatureMapPrompt(feature, steps, contracts);
    expect(prompt.indexOf("- OSDU-Ingestion-Dags")).toBeLessThan(prompt.indexOf("- OSDU-Airflow-Lib"));
    expect(FEATURE_MAP_SYSTEM_PROMPT).toContain("so the flow reads downward");
    expect(FEATURE_MAP_SYSTEM_PROMPT).toContain("never from\n  them into the code");
  });
});

