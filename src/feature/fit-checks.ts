import type { ChangeSet } from "../model/changeset.js";
import { extractDeclarations } from "../analysis/ordering-signals.js";
import {
  componentOrder,
  componentsOf,
  declaredAfter,
  specificName,
  literalsIn,
  normalisePackage,
  packagePins,
  publishedPackages,
  wordsIn,
  type Contract,
} from "./contracts.js";

/**
 * Whether the pull requests of a feature fit together.
 *
 * Each pull request can be right on its own and the feature still broken: one side
 * renames a function the other still calls, a consumer pins a version the library
 * never ships, or the two merge into different branches. These are the checks a
 * reviewer of one pull request cannot make, because they need the others open too.
 */

export type Severity = "problem" | "check" | "info";

export interface Finding {
  severity: Severity;
  title: string;
  detail?: string;
  files?: string[];
}

function branch(ref: string | undefined): string {
  return (ref ?? "").replace(/^refs\/heads\//, "") || "unknown";
}

function exactVersion(spec: string): string | undefined {
  return /^===?([^,<>=!~^]+)$/.exec(spec)?.[1];
}

export function checkFeature(changeSet: ChangeSet, contracts: Contract[]): Finding[] {
  const components = changeSet.components ?? [];
  const findings: Finding[] = [];
  if (components.length < 2) return findings;

  // Different target branches: they cannot all be the same release.
  const targets = new Map<string, string[]>();
  for (const component of components) {
    const target = branch(component.targetRef);
    targets.set(target, [...(targets.get(target) ?? []), component.name]);
  }
  if (targets.size > 1) {
    findings.push({
      severity: "check",
      title: "The pull requests merge into different branches",
      detail: [...targets.entries()].map(([target, names]) => `${target}: ${names.join(", ")}`).join("; "),
    });
  }

  const drafts = components.filter((component) => component.isDraft);
  if (drafts.length > 0) {
    findings.push({
      severity: "info",
      title: `${drafts.length} of ${components.length} are still drafts`,
      detail: drafts.map((component) => component.name).join(", "),
    });
  }

  // Versions: a consumer pinned to a version its provider does not publish.
  const published = publishedPackages(changeSet);
  for (const pin of packagePins(changeSet)) {
    for (const pkg of published) {
      if (pkg.component === pin.component) continue;
      if (normalisePackage(pkg.name) !== normalisePackage(pin.name)) continue;
      const pinned = exactVersion(pin.spec);
      if (pinned && pkg.versionAfter && pinned !== pkg.versionAfter) {
        findings.push({
          severity: "problem",
          title: `${pin.component} pins ${pin.name}==${pinned}, but ${pkg.component} publishes ${pkg.versionAfter}`,
          detail: "The consumer will not run against the version this feature changes.",
          files: [pin.file, pkg.file],
        });
      } else if (pkg.versionBefore && pkg.versionBefore === pkg.versionAfter) {
        findings.push({
          severity: "check",
          title: `${pkg.component} changes ${pkg.name} without bumping its version (${pkg.versionAfter})`,
          detail: `${pin.component} depends on it (${pin.spec}); a release with the same version cannot carry the change.`,
          files: [pkg.file, pin.file],
        });
      }
    }
  }

  // A name one side removes and another side still uses.
  const texts = componentsOf(changeSet);
  for (const provider of texts) {
    const removedNames = new Set(extractDeclarations([...provider.removed.values()].flat().join("\n")));
    const stillDeclared = new Set(extractDeclarations([...provider.added.values()].flat().join("\n")));
    for (const name of removedNames) {
      if (stillDeclared.has(name) || !specificName(name)) continue;
      for (const consumer of texts) {
        // A consumer declaring the name itself is using its own, not the one removed.
        if (consumer === provider || declaredAfter(consumer).has(name)) continue;
        const users = consumer.files.filter(
          (file) => file.after !== null && wordsIn(file.after.split("\n")).has(name),
        );
        if (users.length === 0) continue;
        findings.push({
          severity: "problem",
          title: `${provider.name} removes ${name}, but ${consumer.name} still uses it`,
          files: users.slice(0, 3).map((file) => file.path),
        });
      }
    }
  }

  // An identifier string one side stops using while another side starts or keeps using it.
  for (const side of texts) {
    const dropped = literalsIn([...side.removed.values()].flat());
    const kept = literalsIn([...side.added.values()].flat());
    for (const literal of dropped) {
      if (kept.has(literal)) continue;
      for (const other of texts) {
        if (other === side) continue;
        const users = other.files.filter((file) => file.after?.includes(`"${literal}"`) || file.after?.includes(`'${literal}'`));
        if (users.length === 0) continue;
        findings.push({
          severity: "check",
          title: `${side.name} stops using "${literal}", but ${other.name} still does`,
          detail: "If this is a rename, both sides have to change together.",
          files: users.slice(0, 3).map((file) => file.path),
        });
      }
    }
  }

  const withoutCheckout = components.filter((component) => !component.repositoryRoot);
  if (withoutCheckout.length > 0) {
    findings.push({
      severity: "info",
      title: "Read without a checkout",
      detail: `${withoutCheckout.map((component) => component.name).join(", ")}: only the changed files could be searched.`,
    });
  }

  if (contracts.length === 0) {
    findings.push({
      severity: "check",
      title: "No link between the pull requests was found in the code",
      detail: "They may connect through configuration outside the change; the map relies on the model's reading.",
    });
  }

  return findings;
}

/** Merge what is depended on first, with the links that say why. */
export function mergeOrder(changeSet: ChangeSet, contracts: Contract[]): { name: string; because: string[] }[] {
  return componentOrder(changeSet, contracts).map((name) => ({
    name,
    because: contracts
      .filter((contract) => contract.from === name && contract.kind !== "shared-literal")
      .map((contract) => `${contract.detail} from ${contract.to}`)
      .slice(0, 3),
  }));
}

const SEVERITY_LABEL: Record<Severity, string> = {
  problem: "Problems",
  check: "Worth checking",
  info: "Notes",
};

export function renderFeatureReport(
  changeSet: ChangeSet,
  contracts: Contract[],
  findings: Finding[],
): string {
  const components = changeSet.components ?? [];
  const lines = [`# ${changeSet.label}`, ""];

  lines.push("## Pull requests", "", "| Component | Pull request | Branch | |", "| --- | --- | --- | --- |");
  for (const component of components) {
    lines.push(
      `| ${component.name} | [!${component.identity.pullRequestId}](${component.url}) ${component.title ?? ""} | ` +
        `${branch(component.sourceRef)} → ${branch(component.targetRef)} | ${component.isDraft ? "draft" : ""} |`,
    );
  }

  lines.push("", "## Suggested merge order", "");
  mergeOrder(changeSet, contracts).forEach((entry, index) => {
    lines.push(
      `${index + 1}. **${entry.name}** — ${
        entry.because.length > 0 ? entry.because.join("; ") : "depends on none of the others in the code"
      }`,
    );
  });

  for (const severity of ["problem", "check", "info"] as Severity[]) {
    const matching = findings.filter((finding) => finding.severity === severity);
    if (matching.length === 0) continue;
    lines.push("", `## ${SEVERITY_LABEL[severity]}`, "");
    for (const finding of matching) {
      lines.push(`- **${finding.title}**${finding.detail ? `. ${finding.detail}` : ""}`);
      for (const file of finding.files ?? []) lines.push(`  - \`${file}\``);
    }
  }
  if (!findings.some((finding) => finding.severity !== "info")) {
    lines.push("", "No problems found between the pull requests.");
  }

  lines.push("", "## How the pull requests connect", "");
  if (contracts.length === 0) lines.push("No link was found in the code.");
  for (const contract of contracts) {
    const arrow = contract.kind === "shared-literal" ? "↔" : "→";
    lines.push(`- ${contract.from} ${arrow} ${contract.to}: ${contract.detail} (\`${contract.files[0]}\`)`);
  }

  return lines.join("\n");
}
