import { describe, expect, it } from "vitest";
import type { ChangedFile } from "../src/model/changeset.js";
import { flowOrder, signalsFor } from "../src/analysis/ordering-signals.js";

/**
 * The entry point, on a real change.
 *
 * These are the paths of a pull request whose reading order came out wrong: a shared
 * placement utility was named as the entry point and the workflow task that the
 * platform actually invokes landed ninth. The deterministic order is what anchors the
 * model, so getting this wrong pulls the model wrong with it.
 */
function file(path: string, after = "// code\n"): ChangedFile {
  return { path, changeType: "edit", before: "", after };
}

const PR_26577 = [
  "src/ResourceProvider/TeeCommon/Utilities/EsNodePool/EsPlacementCoordinator.cs",
  "src/ResourceProvider/SharedLibrary/Scaling/EsPoolNaming.cs",
  "src/ResourceProvider/SharedLibrary/Scaling/EsPoolRoleRegistry.cs",
  "src/ResourceProvider/TeeCommon/Utilities/EsPoolRoutingValues.cs",
  "src/ResourceProvider/TeeCommon/Workflows/Tasks/Common/ElasticsearchController/ElasticsearchCapacityProfiles.cs",
  "src/ResourceProvider/TeeCommon/Workflows/Tasks/Common/ElasticsearchController/ElasticsearchDataPartitionContract.cs",
  "src/ResourceProvider/TeeCommon/Workflows/Tasks/Common/ElasticsearchController/ElasticsearchDataPartitionHandlerBase.cs",
  "src/ResourceProvider/TeeCommon/Workflows/Tasks/Common/ElasticsearchController/ElasticsearchDataPartitionModels.cs",
  "src/ResourceProvider/TeeCommon/Workflows/Tasks/Common/ElasticsearchController/ElasticsearchDataPartitionSetupHandler.cs",
  "src/ResourceProvider/TeeCommon/Workflows/Tasks/Common/ElasticsearchController/ElasticsearchDataPartitionTeardownHandler.cs",
  "src/ResourceProvider/TeeCommon/Workflows/Tasks/Common/ElasticsearchController/ElasticsearchEnvelopeVerifier.cs",
  "src/ResourceProvider/TeeCommon/Workflows/Tasks/Common/ElasticsearchController/ElasticsearchOwnership.cs",
  "src/ResourceProvider/TeeCommon/Workflows/Tasks/Common/ElasticsearchDataPartitionDeleteTask.cs",
  "src/ResourceProvider/TeeCommon/Workflows/Tasks/Common/ElasticsearchDataPartitionTask.cs",
  "src/ResourceProvider/TeeCommon/Workflows/Tasks/Common/ElasticsearchDataPartitionTaskBase.cs",
  "src/ResourceProvider/Tests/TeeUnitTest/TaskTests/ElasticsearchControllerTests.cs",
  "src/ResourceProvider/Tests/TeeUnitTest/Utilities/EsPlacementCoordinatorTests.cs",
  "docs/ElasticsearchStandardProfiles.md",
].map((path) => file(path));

function positionOf(order: string[], name: string): number {
  return order.findIndex((path) => path.endsWith(`/${name}`));
}

describe("the deterministic order names the right entry point", () => {
  const order = flowOrder(signalsFor(PR_26577));

  it("starts at the task the platform invokes", () => {
    expect(order[0]).toMatch(/ElasticsearchDataPartitionTask\.cs$/);
  });

  it("does not start at a shared utility everything calls", () => {
    expect(positionOf(order, "EsPlacementCoordinator.cs")).toBeGreaterThan(0);
  });

  it("puts the task ahead of the handler, contract and models it reaches", () => {
    const task = positionOf(order, "ElasticsearchDataPartitionTask.cs");
    for (const later of [
      "ElasticsearchDataPartitionSetupHandler.cs",
      "ElasticsearchDataPartitionContract.cs",
      "ElasticsearchDataPartitionModels.cs",
      "EsPoolNaming.cs",
    ]) {
      expect(positionOf(order, later)).toBeGreaterThan(task);
    }
  });

  it("treats the teardown half as the end of the lifecycle, not the start", () => {
    const setup = positionOf(order, "ElasticsearchDataPartitionTask.cs");
    expect(positionOf(order, "ElasticsearchDataPartitionDeleteTask.cs")).toBeGreaterThan(setup);
    expect(positionOf(order, "ElasticsearchDataPartitionTeardownHandler.cs")).toBeGreaterThan(setup);
  });

  it("leaves tests and documentation to the end", () => {
    const last = order.length - 1;
    expect(positionOf(order, "ElasticsearchStandardProfiles.md")).toBe(last);
    expect(positionOf(order, "ElasticsearchControllerTests.cs")).toBeGreaterThan(
      positionOf(order, "ElasticsearchEnvelopeVerifier.cs"),
    );
  });
});

/**
 * The same change, with the declarations and references the real files carry.
 *
 * With edges to walk this order is good enough to be authoritative: the model was
 * taking it and burying the handler the entry point delegates to, so the walk decides
 * position now and the model only names the steps.
 */
describe("the flow walk follows the delegation, not the file names", () => {
  const W = "src/ResourceProvider/TeeCommon/Workflows/Tasks/Common/";
  const C = `${W}ElasticsearchController/`;

  const order = flowOrder(
    signalsFor([
      file(
        `${W}ElasticsearchDataPartitionTask.cs`,
        "public class ElasticsearchDataPartitionTask : ElasticsearchDataPartitionTaskBase {\n private ElasticsearchDataPartitionSetupHandler setupHandler;\n}",
      ),
      file(
        `${W}ElasticsearchDataPartitionDeleteTask.cs`,
        "public class ElasticsearchDataPartitionDeleteTask : ElasticsearchDataPartitionTaskBase {\n private ElasticsearchDataPartitionTeardownHandler teardownHandler;\n}",
      ),
      file(
        `${W}ElasticsearchDataPartitionTaskBase.cs`,
        "public abstract class ElasticsearchDataPartitionTaskBase {\n ElasticsearchEnvelopeVerifier CreateEnvelopeVerifier();\n}",
      ),
      file(
        `${C}ElasticsearchDataPartitionSetupHandler.cs`,
        "public sealed class ElasticsearchDataPartitionSetupHandler : ElasticsearchDataPartitionHandlerBase {\n ElasticsearchDataPartitionContract.ResolveProfile();\n}",
      ),
      file(
        `${C}ElasticsearchDataPartitionTeardownHandler.cs`,
        "public sealed class ElasticsearchDataPartitionTeardownHandler : ElasticsearchDataPartitionHandlerBase {\n ElasticsearchDataPartitionContract.Compose();\n}",
      ),
      file(
        `${C}ElasticsearchDataPartitionHandlerBase.cs`,
        "public abstract class ElasticsearchDataPartitionHandlerBase {\n ElasticsearchEnvelopeVerifier EnvelopeVerifier;\n}",
      ),
      file(
        `${C}ElasticsearchDataPartitionContract.cs`,
        "public static class ElasticsearchDataPartitionContract {\n EsPoolNaming.For();\n}",
      ),
      file(`${C}ElasticsearchEnvelopeVerifier.cs`, "public class ElasticsearchEnvelopeVerifier {}"),
      file(
        "src/ResourceProvider/SharedLibrary/Scaling/EsPoolNaming.cs",
        "public static class EsPoolNaming {}",
      ),
    ]),
  );

  it("puts the handler the entry point delegates to second", () => {
    expect(order[0]).toMatch(/ElasticsearchDataPartitionTask\.cs$/);
    expect(order[1]).toMatch(/ElasticsearchDataPartitionSetupHandler\.cs$/);
  });

  it("keeps the teardown task and its handler next to each other", () => {
    const task = positionOf(order, "ElasticsearchDataPartitionDeleteTask.cs");
    const handler = positionOf(order, "ElasticsearchDataPartitionTeardownHandler.cs");
    expect(handler - task).toBe(1);
  });

  it("reaches a pool-naming helper through the contract that calls it", () => {
    expect(positionOf(order, "EsPoolNaming.cs")).toBeGreaterThan(
      positionOf(order, "ElasticsearchDataPartitionContract.cs"),
    );
  });
});
