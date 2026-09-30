import { describe, expect, it } from "vitest";
import type { ChangeSet, ChangedFile } from "../src/model/changeset.js";
import { composeFeature, type FeaturePart } from "../src/feature/compose.js";
import {
  componentOrder,
  findContracts,
  readingOrder,
  groupByComponent,
  packagePins,
  publishedPackages,
} from "../src/feature/contracts.js";
import { checkFeature, mergeOrder, renderFeatureReport } from "../src/feature/fit-checks.js";

function part(
  repository: string,
  id: number,
  files: ChangedFile[],
  extra: Partial<FeaturePart> = {},
): FeaturePart {
  const changeSet: ChangeSet = {
    repositoryRoot: "",
    label: `${repository} !${id}`,
    baseRef: "base",
    mergeBase: `base${id}`,
    headCommit: `head${id}`,
    files,
    skipped: [],
  };
  return {
    changeSet,
    identity: { organization: "org", project: "p", repository, pullRequestId: id },
    url: `https://dev.azure.com/org/p/_git/${repository}/pullrequest/${id}`,
    title: `AB#80805: ${repository}`,
    sourceRef: "refs/heads/feature/manifest-dataset-reference",
    targetRef: "refs/heads/main",
    ...extra,
  };
}

const library = part("OSDU-Airflow-Lib", 27634, [
  {
    path: "osdu_airflow/operators/mir.py",
    changeType: "edit",
    before: "def old_process(ctx):\n    return ctx\n",
    after:
      'KEY = "manifest_dataset_reference"\n\ndef process_dataset_reference(ctx):\n    return ctx[KEY]\n',
  },
  {
    path: "setup.py",
    changeType: "edit",
    before: 'setup(name="osdu-airflow", version="0.28.0")\n',
    after: 'setup(name="osdu-airflow", version="0.29.0")\n',
  },
]);

const dags = part("OSDU-Ingestion-Dags", 27635, [
  {
    path: "dags/mi_fusion.py",
    changeType: "add",
    before: null,
    after:
      "from osdu_airflow.operators.mir import process_dataset_reference\n" +
      'DAG_ID = "osdu_mi_fusion"\n' +
      'ref = "manifest_dataset_reference"\n' +
      "process_dataset_reference(ctx)\n",
  },
  {
    path: "requirements.txt",
    changeType: "edit",
    before: "osdu-airflow==0.27.0\n",
    after: "osdu-airflow==0.28.0\n",
  },
]);

const workflow = part(
  "OSDU-Ingestion-Workflow",
  27633,
  [
    {
      path: "app/trigger.py",
      changeType: "edit",
      before: 'trigger("old_dag")\n',
      after: 'trigger("osdu_mi_fusion")\nold_process(ctx)\n',
    },
  ],
  { targetRef: "refs/heads/m26-master", isDraft: true },
);

const feature = composeFeature([workflow, library, dags]);

describe("composeFeature", () => {
  it("prefixes every path with its repository and keeps each component's details", () => {
    expect(feature.files.map((file) => file.path)).toContain("OSDU-Airflow-Lib/setup.py");
    expect(feature.components?.map((component) => component.name)).toEqual([
      "OSDU-Ingestion-Workflow",
      "OSDU-Airflow-Lib",
      "OSDU-Ingestion-Dags",
    ]);
    expect(feature.repositoryRoot).toBe("");
    expect(feature.label).toBe("AB#80805: 3 pull requests");
  });

  it("is keyed by its pull requests and commits, whatever order they came in", () => {
    expect(composeFeature([dags, library, workflow]).headCommit).toBe(feature.headCommit);
    expect(feature.headCommit).toContain("org/27634@head27634");
  });

  it("tells two pull requests in the same repository apart", () => {
    const again = part("OSDU-Airflow-Lib", 99, library.changeSet.files);
    const names = composeFeature([library, again]).components?.map((component) => component.name);
    expect(names).toEqual(["OSDU-Airflow-Lib-pr27634", "OSDU-Airflow-Lib-pr99"]);
  });
});

describe("findContracts", () => {
  const contracts = findContracts(feature);
  const details = contracts.map((contract) => `${contract.from}->${contract.to}: ${contract.detail}`);

  it("sees an import of a module another component provides", () => {
    expect(details).toContain("OSDU-Ingestion-Dags->OSDU-Airflow-Lib: imports osdu_airflow.operators");
  });

  it("sees a pin on a package another component publishes", () => {
    expect(details).toContain("OSDU-Ingestion-Dags->OSDU-Airflow-Lib: pins osdu-airflow==0.28.0");
  });

  it("sees a name one side declares and the other calls", () => {
    expect(details).toContain(
      "OSDU-Ingestion-Dags->OSDU-Airflow-Lib: uses process_dataset_reference",
    );
  });

  it("sees an identifier string one side adds and the other uses", () => {
    expect(details).toContain('OSDU-Ingestion-Workflow->OSDU-Ingestion-Dags: both use "osdu_mi_fusion"');
  });

  it("finds nothing to connect in a single repository", () => {
    expect(findContracts(library.changeSet)).toEqual([]);
  });

  it("reads published packages and pins from manifests", () => {
    expect(publishedPackages(feature)).toEqual([
      expect.objectContaining({ name: "osdu-airflow", versionBefore: "0.28.0", versionAfter: "0.29.0" }),
    ]);
    expect(packagePins(feature)).toContainEqual(
      expect.objectContaining({ component: "OSDU-Ingestion-Dags", name: "osdu-airflow", spec: "==0.28.0" }),
    );
  });
});

describe("reading and merge order", () => {
  const contracts = findContracts(feature);

  it("puts what is depended on before what depends on it", () => {
    const order = componentOrder(feature, contracts);
    expect(order.indexOf("OSDU-Airflow-Lib")).toBeLessThan(order.indexOf("OSDU-Ingestion-Dags"));
  });

  it("reads component by component, keeping the order within each", () => {
    const grouped = groupByComponent(
      [{ path: "B/2" }, { path: "A/1" }, { path: "B/1" }, { path: "A/2" }],
      ["A", "B"],
    );
    expect(grouped.map((entry) => entry.path)).toEqual(["A/1", "A/2", "B/2", "B/1"]);
  });

  it("explains the merge order with the links behind it", () => {
    const dagsEntry = mergeOrder(feature, contracts).find((entry) => entry.name === "OSDU-Ingestion-Dags");
    expect(dagsEntry?.because).toContain("imports osdu_airflow.operators from OSDU-Airflow-Lib");
  });
});

describe("checkFeature", () => {
  const contracts = findContracts(feature);
  const findings = checkFeature(feature, contracts);
  const titles = findings.map((finding) => finding.title);

  it("flags a pin on a version the provider does not publish", () => {
    expect(titles).toContain(
      "OSDU-Ingestion-Dags pins osdu-airflow==0.28.0, but OSDU-Airflow-Lib publishes 0.29.0",
    );
  });

  it("flags a name one side removes that another still uses", () => {
    expect(titles).toContain("OSDU-Airflow-Lib removes old_process, but OSDU-Ingestion-Workflow still uses it");
  });

  it("flags pull requests merging into different branches", () => {
    const branches = findings.find((finding) => finding.title.includes("different branches"));
    expect(branches?.detail).toContain("m26-master: OSDU-Ingestion-Workflow");
  });

  it("notes drafts and components read without a checkout", () => {
    expect(titles).toContain("1 of 3 are still drafts");
    expect(titles).toContain("Read without a checkout");
  });

  it("renders a report with the pull requests, merge order, findings and links", () => {
    const report = renderFeatureReport(feature, contracts, findings);
    expect(report).toContain("# AB#80805: 3 pull requests");
    expect(report).toContain("[!27634](https://dev.azure.com/org/p/_git/OSDU-Airflow-Lib/pullrequest/27634)");
    expect(report).toContain("## Suggested merge order");
    expect(report).toContain("## Problems");
    expect(report).toContain("## How the pull requests connect");
  });
});

describe("what counts as a link, from the AB#80805 pull requests", () => {
  const service = part("OSDU-Ingestion-Workflow", 1, [
    {
      path: "src/main/java/ManifestDatasetReferenceService.java",
      changeType: "add",
      before: null,
      after: 'String DAG = "Osdu_ingest";\nmap.put("dag_run", x);\nmap.put("execution_context", y);\n',
    },
    {
      path: "src/test/java/ManifestDatasetReferenceServiceTest.java",
      changeType: "add",
      before: null,
      after: 'assert("otherRelevantDataCountries");\n',
    },
  ]);
  const dag = part("OSDU-Ingestion-Dags", 2, [
    {
      path: "src/osdu_dags/osdu-ingest-r3.py",
      changeType: "edit",
      // The DAG id sits on a line this change does not touch.
      before: 'DAG_ID = "Osdu_ingest"\nctx = kwargs["dag_run"]\n',
      after: 'DAG_ID = "Osdu_ingest"\nctx = kwargs["dag_run"]\nctx["execution_context"]\nx = "otherRelevantDataCountries"\n',
    },
  ]);
  const details = findContracts(composeFeature([service, dag])).map((contract) => contract.detail);

  it("links a DAG id one side triggers to the unchanged line the other defines it on", () => {
    expect(details).toContain('both use "Osdu_ingest"');
  });

  it("ignores a framework's own short names and anything only a test mentions", () => {
    expect(details.join(" ")).not.toMatch(/dag_run|execution_context|otherRelevantDataCountries/);
  });

  it("collapses many shared strings between two components into one link", () => {
    const many = part("A", 3, [
      { path: "a.py", changeType: "add", before: null, after: '"key-one" "key-two" "key-three" "key-four" "key-five" "key-six"' },
    ]);
    const other = part("B", 4, [
      { path: "b.py", changeType: "add", before: null, after: '"key-one" "key-two" "key-three" "key-four" "key-five" "key-six"' },
    ]);
    const links = findContracts(composeFeature([many, other]));
    expect(links).toHaveLength(1);
    expect(links[0]!.detail).toBe(
      'both use "key-one", "key-two", "key-three", "key-four" and 2 more',
    );
  });

  it("reads documentation and packaging after the code", () => {
    const docs = part("dev-workspaces", 5, [
      { path: "projects/README.md", changeType: "add", before: null, after: "# x" },
    ]);
    const feature = composeFeature([docs, service, dag]);
    expect(componentOrder(feature, findContracts(feature)).at(-1)).toBe("dev-workspaces");
  });
});

describe("framework method names are not links", () => {
  // Two Airflow operators: one deleted in the library, one added in the DAGs.
  const lib = part("Lib", 10, [
    {
      path: "ops/old_op.py",
      changeType: "delete",
      before: "class OldOperator(BaseOperator):\n    def __init__(self):\n        pass\n    def execute(self, context):\n        pass\n",
      after: null,
    },
    {
      path: "ops/new_op.py",
      changeType: "add",
      before: null,
      after: "class NewOperator(BaseOperator):\n    def __init__(self):\n        super().__init__()\n    def execute(self, context):\n        pass\n",
    },
  ]);
  const dagsSide = part("Dags", 11, [
    {
      path: "dags/fusion_op.py",
      changeType: "add",
      before: null,
      after: "class FusionOperator(BaseOperator):\n    def __init__(self):\n        super().__init__()\n    def execute(self, context):\n        pass\n",
    },
  ]);
  const feature = composeFeature([lib, dagsSide]);
  const contracts = findContracts(feature);

  it("reports no problem for a constructor or execute that both sides happen to have", () => {
    const titles = checkFeature(feature, contracts).map((finding) => finding.title);
    expect(titles.join(" ")).not.toMatch(/__init__|execute/);
  });

  it("draws no link for them, so the no-link check still speaks", () => {
    expect(contracts.map((contract) => contract.detail).join(" ")).not.toMatch(/__init__|execute/);
    expect(checkFeature(feature, contracts).map((finding) => finding.title)).toContain(
      "No link between the pull requests was found in the code",
    );
  });

  it("still reports a specific name removed on one side and called on the other", () => {
    const provider = part("P", 12, [
      { path: "p/api.py", changeType: "edit", before: "def fetch_manifest_reference(x):\n    pass\n", after: "\n" },
    ]);
    const consumer = part("C", 13, [
      { path: "c/use.py", changeType: "edit", before: "\n", after: "fetch_manifest_reference(1)\n" },
    ]);
    const both = composeFeature([provider, consumer]);
    expect(checkFeature(both, findContracts(both)).map((finding) => finding.title)).toContain(
      "P removes fetch_manifest_reference, but C still uses it",
    );
  });
});

describe("reading order follows execution", () => {
  // The AB#80805 shape: a workflow service triggers a DAG, which imports a library;
  // a documentation package describes them all.
  const service = part("OSDU-Ingestion-Workflow", 21, [
    {
      path: "workflow-core/src/main/java/WorkflowRunServiceImpl.java",
      changeType: "edit",
      before: "class A {}",
      after: 'class A { String dag = "Osdu_ingest_fusion"; }',
    },
  ]);
  const dag = part("OSDU-Ingestion-Dags", 22, [
    {
      path: "src/osdu_dags/ingest.py",
      changeType: "edit",
      before: 'DAG_ID = "Osdu_ingest_fusion"\n',
      after: 'from osdu_airflow.operators.mir import Mir\nDAG_ID = "Osdu_ingest_fusion"\nMir()\n',
    },
  ]);
  const library = part("OSDU-Airflow-Lib", 23, [
    { path: "osdu_airflow/operators/mir.py", changeType: "edit", before: "x = 1\n", after: "class Mir:\n    pass\n" },
  ]);
  const docs = part("osdu-adme-dev-workspaces", 24, [
    { path: "projects/README.md", changeType: "add", before: null, after: "# Fusion" },
  ]);

  it("reads the service, then the DAG it triggers, then the library the DAG calls, then docs", () => {
    const feature = composeFeature([library, docs, dag, service]);
    expect(readingOrder(feature, findContracts(feature))).toEqual([
      "OSDU-Ingestion-Workflow",
      "OSDU-Ingestion-Dags",
      "OSDU-Airflow-Lib",
      "osdu-adme-dev-workspaces",
    ]);
  });

  it("does not depend on which pull request was pasted first", () => {
    const orders = [
      [service, dag, library, docs],
      [dag, library, docs, service],
      [docs, library, service, dag],
    ].map((parts) => {
      const feature = composeFeature(parts);
      return readingOrder(feature, findContracts(feature)).join(" > ");
    });
    expect(new Set(orders).size).toBe(1);
  });

  it("keeps the merge order the other way round: what is depended on first", () => {
    const feature = composeFeature([service, dag, library, docs]);
    const merge = componentOrder(feature, findContracts(feature));
    expect(merge.indexOf("OSDU-Airflow-Lib")).toBeLessThan(merge.indexOf("OSDU-Ingestion-Dags"));
  });
});

