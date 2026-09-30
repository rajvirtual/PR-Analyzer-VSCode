import type { ChangeSet, ChangedFile } from "../model/changeset.js";
import { diffLines } from "../analysis/unified-diff.js";
import { classifyRole, extractDeclarations } from "../analysis/ordering-signals.js";

/**
 * How the pull requests of a feature connect, read from the code rather than guessed.
 *
 * A model asked to draw several repositories at once invents the links between them.
 * These are the links that can be shown: one component importing a module another
 * provides, pinning a package another versions, calling a name another declares, or
 * both using the same identifier string — a DAG id, a config key, a route.
 */

export type ContractKind = "import" | "pin" | "shared-name" | "shared-literal";

export interface Contract {
  /** The component that depends. */
  from: string;
  /** The component depended on. Unordered for a shared literal. */
  to: string;
  kind: ContractKind;
  /** What the link is, in the words of the code: `imports osdu_airflow.operators`. */
  detail: string;
  /** Change paths in `from` where it shows. */
  files: string[];
}

/** A package a component publishes, with its version on each side of the change. */
export interface PublishedPackage {
  component: string;
  name: string;
  file: string;
  versionBefore?: string;
  versionAfter?: string;
}

/** A dependency one component declares on a package, with its version constraint. */
export interface PackagePin {
  component: string;
  name: string;
  spec: string;
  file: string;
}

export interface ComponentText {
  name: string;
  files: ChangedFile[];
  /**
   * Each file's added lines, or all of it when the file is new. Code and configuration
   * only: a test or a document mentions everything, which is not the same as using it.
   */
  added: Map<string, string[]>;
  /** Each file's removed lines, with the same exclusions. */
  removed: Map<string, string[]>;
  /** True when the component changes something that runs, not only tests and documents. */
  hasCode: boolean;
  /** Identifier strings anywhere in its changed code after the change, added or not. */
  present: Set<string>;
}

/**
 * Names every class or module of a kind declares — a constructor, a framework's hook —
 * which say nothing about one repository depending on another.
 */
const FRAMEWORK_NAMES = new Set([
  "execute", "validate", "process", "handle", "handler", "run", "main", "setup", "setUp",
  "tearDown", "teardown", "create", "update", "delete", "remove", "get", "post", "put",
  "to_dict", "from_dict", "to_json", "from_json", "serialize", "deserialize", "build",
  "configure", "initialize", "init", "start", "stop", "close", "dispose", "apply", "render",
  "toString", "equals", "hashCode", "compareTo", "invoke", "call", "on_kill", "pre_execute",
  "post_execute", "get_hook", "template_fields",
]);

/** A declared name specific enough that another repository using it means something. */
export function specificName(name: string): boolean {
  if (name.length < 6) return false;
  if (/^__\w+__$/.test(name)) return false;
  return !FRAMEWORK_NAMES.has(name);
}

/** Every name a component's changed code declares, after the change. */
export function declaredAfter(component: ComponentText): Set<string> {
  return new Set(
    component.files.flatMap((file) => (file.after ? extractDeclarations(file.after) : [])),
  );
}

const MAX_CONTRACTS = 60;
const MAX_FILES_PER_CONTRACT = 3;
const NOT_A_MODULE = new Set(["src", "lib", "tests", "test", "docs", "scripts", "tools", "build"]);
const MANIFEST = /(^|\/)(requirements[^/]*\.txt|constraints[^/]*\.txt|setup\.py|setup\.cfg|pyproject\.toml|Pipfile|package\.json|[^/]+\.csproj|Directory\.Packages\.props|environment[^/]*\.ya?ml|Chart\.yaml)$/i;
const BORING_LITERALS = new Set(["application/json", "utf-8", "content-type", "authorization"]);

/** Package names compare loosely, as pip does: case, `-`, `_` and `.` are one. */
export function normalisePackage(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

export function componentsOf(changeSet: ChangeSet): ComponentText[] {
  return (changeSet.components ?? []).map((component) => {
    const prefix = `${component.name}/`;
    const files = changeSet.files.filter((file) => file.path.startsWith(prefix));
    const added = new Map<string, string[]>();
    const removed = new Map<string, string[]>();
    let hasCode = false;
    const present = new Set<string>();
    for (const file of files) {
      const role = classifyRole(file.path.slice(prefix.length));
      if (role === "test" || role === "documentation") continue;
      if (role === "implementation") hasCode = true;
      for (const literal of literalsIn((file.after ?? "").split("\n"))) present.add(literal);
      const lines = diffLines((file.before ?? "").split("\n"), (file.after ?? "").split("\n"));
      added.set(file.path, lines.filter((line) => line.kind === "add").map((line) => line.text));
      removed.set(file.path, lines.filter((line) => line.kind === "remove").map((line) => line.text));
    }
    return { name: component.name, files, added, removed, hasCode, present };
  });
}

function localPath(component: ComponentText, changePath: string): string {
  return changePath.slice(component.name.length + 1);
}

/** Top-level Python packages a component's changed files live in. */
function pythonModules(component: ComponentText): Set<string> {
  const modules = new Set<string>();
  for (const file of component.files) {
    if (!file.path.endsWith(".py")) continue;
    const segments = localPath(component, file.path).split("/");
    if (segments[0] === "src" && segments.length > 2) segments.shift();
    const top = segments.length > 1 ? segments[0]! : "";
    if (/^[A-Za-z_]\w*$/.test(top) && !NOT_A_MODULE.has(top.toLowerCase())) modules.add(top);
  }
  return modules;
}

function versionIn(text: string | null): string | undefined {
  if (!text) return undefined;
  return (
    /^\s*version\s*=\s*["']([^"']+)["']/m.exec(text)?.[1] ??
    /\bversion\s*=\s*["']([^"']+)["']/.exec(text)?.[1] ??
    /"version"\s*:\s*"([^"]+)"/.exec(text)?.[1] ??
    /__version__\s*=\s*["']([^"']+)["']/.exec(text)?.[1] ??
    /<Version>([^<]+)<\/Version>/.exec(text)?.[1]
  );
}

function packageNameIn(text: string | null): string | undefined {
  if (!text) return undefined;
  return (
    /^\s*name\s*=\s*["']([^"']+)["']/m.exec(text)?.[1] ??
    /\bname\s*=\s*["']([^"']+)["']/.exec(text)?.[1] ??
    /"name"\s*:\s*"([^"]+)"/.exec(text)?.[1] ??
    /<PackageId>([^<]+)<\/PackageId>/.exec(text)?.[1]
  );
}

/** Packages each component publishes, read from the manifests it changed. */
export function publishedPackages(changeSet: ChangeSet): PublishedPackage[] {
  const found: PublishedPackage[] = [];
  for (const component of componentsOf(changeSet)) {
    for (const file of component.files) {
      const local = localPath(component, file.path);
      if (!/(^|\/)(setup\.py|setup\.cfg|pyproject\.toml|package\.json|[^/]+\.csproj)$/i.test(local)) continue;
      const name = packageNameIn(file.after) ?? packageNameIn(file.before);
      if (!name) continue;
      found.push({
        component: component.name,
        name,
        file: file.path,
        versionBefore: versionIn(file.before),
        versionAfter: versionIn(file.after),
      });
    }
  }
  return found;
}

const PIN_PATTERNS: RegExp[] = [
  // requirements.txt, setup.py install_requires, pyproject dependency arrays
  /["']?([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*((?:==|>=|<=|~=|!=|>|<|===)\s*[^\s,;"'\]]+(?:\s*,\s*(?:==|>=|<=|~=|!=|>|<)\s*[^\s,;"'\]]+)*)/g,
  // package.json and pyproject/poetry tables: "name": "^1.2.3" or name = "1.2.3"
  /["']?([A-Za-z0-9@][A-Za-z0-9@/._-]*)["']?\s*[:=]\s*["']([~^<>=!]*\d[^"']*)["']/g,
  // <PackageReference Include="Name" Version="1.2.3" />
  /Include="([^"]+)"\s+Version="([^"]+)"/g,
];

/** Dependencies each component declares in the manifests it changed. */
export function packagePins(changeSet: ChangeSet): PackagePin[] {
  const pins: PackagePin[] = [];
  for (const component of componentsOf(changeSet)) {
    for (const file of component.files) {
      if (!MANIFEST.test(localPath(component, file.path)) || !file.after) continue;
      for (const pattern of PIN_PATTERNS) {
        for (const match of file.after.matchAll(pattern)) {
          const name = match[1]!;
          if (/^(version|python|name|python_requires)$/i.test(name)) continue;
          const raw = match[2]!.replace(/\s+/g, "");
          // A bare version is an exact pin wherever it appears.
          const spec = /^\d/.test(raw) ? `==${raw}` : raw;
          pins.push({ component: component.name, name, spec, file: file.path });
        }
      }
    }
  }
  return pins;
}

/**
 * An identifier-shaped string specific enough to mean the same thing on both sides: a
 * route, a dotted key, a camelCase field, or a snake_case name longer than a framework's
 * own `dag_run` or `execution_context`.
 */
function identifierShaped(literal: string): boolean {
  if (/[.:/-]/.test(literal)) return true;
  if (/[a-z][A-Z]/.test(literal)) return true;
  const underscores = literal.split("_").length - 1;
  return underscores >= 2 || (underscores === 1 && /[A-Z]/.test(literal));
}

export function literalsIn(lines: string[]): Set<string> {
  const found = new Set<string>();
  for (const line of lines) {
    for (const match of line.matchAll(/["']([A-Za-z][\w.:/-]{5,80})["']/g)) {
      const literal = match[1]!;
      if (BORING_LITERALS.has(literal.toLowerCase()) || /^https?:/i.test(literal)) continue;
      if (!identifierShaped(literal)) continue;
      found.add(literal);
    }
  }
  return found;
}

export function wordsIn(lines: string[]): Set<string> {
  const words = new Set<string>();
  for (const line of lines) for (const match of line.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) words.add(match[0]);
  return words;
}

/** Every link between two components of the feature that the code itself shows. */
export function findContracts(changeSet: ChangeSet): Contract[] {
  const components = componentsOf(changeSet);
  if (components.length < 2) return [];

  const contracts = new Map<string, Contract>();
  const add = (contract: Omit<Contract, "files">, file: string): void => {
    const key = `${contract.from}|${contract.to}|${contract.kind}|${contract.detail}`;
    const existing = contracts.get(key);
    if (existing) {
      if (existing.files.length < MAX_FILES_PER_CONTRACT && !existing.files.includes(file)) {
        existing.files.push(file);
      }
      return;
    }
    if (contracts.size < MAX_CONTRACTS) contracts.set(key, { ...contract, files: [file] });
  };

  const modules = new Map(components.map((component) => [component.name, pythonModules(component)]));
  const published = publishedPackages(changeSet);
  const pins = packagePins(changeSet);

  for (const consumer of components) {
    // Imports of a module another component provides, read from the whole file after
    // the change: an unchanged import still ties the change to its provider.
    for (const file of consumer.files) {
      if (!file.after || !file.path.endsWith(".py")) continue;
      for (const match of file.after.matchAll(/^\s*(?:from|import)\s+([A-Za-z_][\w.]*)/gm)) {
        const imported = match[1]!;
        const top = imported.split(".")[0]!;
        for (const provider of components) {
          if (provider === consumer || !modules.get(provider.name)?.has(top)) continue;
          // Two segments name the part of the provider in use without one link per module.
          const shown = imported.split(".").slice(0, 2).join(".");
          add({ from: consumer.name, to: provider.name, kind: "import", detail: `imports ${shown}` }, file.path);
        }
      }
    }

    // A pinned version of a package another component publishes.
    for (const pin of pins.filter((candidate) => candidate.component === consumer.name)) {
      for (const pkg of published) {
        if (pkg.component === consumer.name) continue;
        if (normalisePackage(pkg.name) !== normalisePackage(pin.name)) continue;
        add({ from: consumer.name, to: pkg.component, kind: "pin", detail: `pins ${pin.name}${pin.spec}` }, pin.file);
      }
    }
  }

  // Names one component's change declares and another's change uses.
  const declared = new Map<string, { component: string; name: string }[]>();
  for (const provider of components) {
    for (const lines of provider.added.values()) {
      for (const name of extractDeclarations(lines.join("\n"))) {
        if (!specificName(name)) continue;
        const list = declared.get(name) ?? [];
        if (!list.some((entry) => entry.component === provider.name)) list.push({ component: provider.name, name });
        declared.set(name, list);
      }
    }
  }
  for (const consumer of components) {
    // A name the consumer declares itself is its own, not a use of another repository's.
    const own = declaredAfter(consumer);
    for (const [file, lines] of consumer.added) {
      const words = wordsIn(lines);
      for (const [name, providers] of declared) {
        if (!words.has(name) || own.has(name)) continue;
        for (const provider of providers) {
          if (provider.component === consumer.name) continue;
          add({ from: consumer.name, to: provider.component, kind: "shared-name", detail: `uses ${name}` }, file);
        }
      }
    }
  }

  // The same identifier string on both sides — a DAG id, a config key, a route — where
  // at least one side's change adds it. The other side may define it on a line this
  // feature did not touch, which is exactly the contract a reviewer cannot see.
  const pairs = new Set<string>();
  for (const component of components) {
    for (const [file, lines] of component.added) {
      for (const literal of literalsIn(lines)) {
        for (const other of components) {
          if (other === component || !other.present.has(literal)) continue;
          const [a, b] = [component.name, other.name].sort();
          const key = `${a}|${b}|${literal}`;
          if (pairs.has(key)) continue;
          pairs.add(key);
          add({ from: component.name, to: other.name, kind: "shared-literal", detail: `both use "${literal}"` }, file);
        }
      }
    }
  }

  return collapseLiterals([...contracts.values()]);
}

const LITERALS_SHOWN = 4;

/** One link per pair of components for their shared strings, naming the first few. */
function collapseLiterals(contracts: Contract[]): Contract[] {
  const kept: Contract[] = [];
  const byPair = new Map<string, { contract: Contract; literals: string[] }>();
  for (const contract of contracts) {
    if (contract.kind !== "shared-literal") {
      kept.push(contract);
      continue;
    }
    const literal = /^both use "(.*)"$/.exec(contract.detail)?.[1] ?? contract.detail;
    const key = [contract.from, contract.to].sort().join("|");
    const group = byPair.get(key);
    if (!group) {
      byPair.set(key, { contract: { ...contract, files: [...contract.files] }, literals: [literal] });
      continue;
    }
    group.literals.push(literal);
    for (const file of contract.files) {
      if (group.contract.files.length < MAX_FILES_PER_CONTRACT && !group.contract.files.includes(file)) {
        group.contract.files.push(file);
      }
    }
  }
  for (const { contract, literals } of byPair.values()) {
    const shown = literals.slice(0, LITERALS_SHOWN).map((literal) => `"${literal}"`).join(", ");
    const more = literals.length > LITERALS_SHOWN ? ` and ${literals.length - LITERALS_SHOWN} more` : "";
    kept.push({ ...contract, detail: `both use ${shown}${more}` });
  }
  return kept;
}

/**
 * The components in the order a reviewer should meet them: what is depended on before
 * what depends on it. Shared literals say two sides agree, not which comes first, so
 * only directed links decide the order; ties keep the order the components were given.
 */
export function componentOrder(changeSet: ChangeSet, contracts: Contract[]): string[] {
  // Documentation and packaging are read last: they describe the code rather than run it.
  const code = new Map(componentsOf(changeSet).map((component) => [component.name, component.hasCode]));
  const given = (changeSet.components ?? []).map((component) => component.name);
  const names = [
    ...given.filter((name) => code.get(name) !== false),
    ...given.filter((name) => code.get(name) === false),
  ];
  const dependsOn = new Map(names.map((name) => [name, new Set<string>()]));
  for (const contract of contracts) {
    if (contract.kind === "shared-literal" || contract.from === contract.to) continue;
    dependsOn.get(contract.from)?.add(contract.to);
  }

  const ordered: string[] = [];
  const placed = new Set<string>();
  while (ordered.length < names.length) {
    const ready = names.find(
      (name) => !placed.has(name) && [...(dependsOn.get(name) ?? [])].every((dep) => placed.has(dep)),
    );
    // A cycle: place the next unplaced component rather than stall.
    const next = ready ?? names.find((name) => !placed.has(name))!;
    ordered.push(next);
    placed.add(next);
  }
  return ordered;
}

/**
 * The components in the order the feature runs: a caller before what it calls, so the
 * reader follows the flow from where it starts. This is the reverse of the merge order,
 * which needs what is depended on first.
 *
 * A shared identifier says two components agree, not which calls which; among components
 * the code does not order, the one that looks most like where the flow starts — a
 * service, a controller, a workflow — goes first. Documentation and packaging go last.
 */
export function readingOrder(changeSet: ChangeSet, contracts: Contract[]): string[] {
  const texts = componentsOf(changeSet);
  const code = new Map(texts.map((component) => [component.name, component.hasCode]));
  const given = (changeSet.components ?? []).map((component) => component.name);
  // Judged per repository, not per file: a file's own score rises with everything it
  // calls, which would put a DAG that calls a library ahead of the service that starts it.
  const entry = new Map(texts.map((component) => [component.name, entryScore(component)]));

  const callers = new Map(given.map((name) => [name, new Set<string>()]));
  for (const contract of contracts) {
    if (contract.kind === "shared-literal" || contract.from === contract.to) continue;
    // `from` depends on `to`, so at run time `from` is the caller and reads first.
    callers.get(contract.to)?.add(contract.from);
  }

  const rank = (name: string): [number, number, number] => [
    code.get(name) === false ? 1 : 0,
    -(entry.get(name) ?? 0),
    given.indexOf(name),
  ];
  const before = (a: string, b: string): number => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  };

  const ordered: string[] = [];
  const placed = new Set<string>();
  while (ordered.length < given.length) {
    const unplaced = given.filter((name) => !placed.has(name));
    const ready = unplaced.filter((name) =>
      [...(callers.get(name) ?? [])].every((caller) => placed.has(caller)),
    );
    // A cycle: place the most likely starting point rather than stall.
    const next = (ready.length > 0 ? ready : unplaced).sort(before)[0]!;
    ordered.push(next);
    placed.add(next);
  }
  return ordered;
}

/** Names that belong to where a flow starts: something a request or a schedule reaches first. */
const ENTRY_NAME = /service|controller|api|endpoint|gateway|workflow|scheduler|orchestrat|trigger|server/i;

/** How much a component looks like where the flow begins, from its name and its code files. */
function entryScore(component: ComponentText): number {
  const score = ENTRY_NAME.test(component.name) ? 3 : 0;
  let files = 0;
  for (const file of component.files) {
    const local = file.path.slice(component.name.length + 1);
    if (classifyRole(local) !== "implementation") continue;
    if (ENTRY_NAME.test(local.split("/").pop() ?? "")) files += 1;
  }
  return score + Math.min(files, 3);
}

/** Keeps a reading order within each component, and reads the components in turn. */
export function groupByComponent<T extends { path: string }>(order: T[], components: string[]): T[] {
  const rank = (path: string): number => {
    const index = components.findIndex((name) => path.startsWith(`${name}/`));
    return index < 0 ? components.length : index;
  };
  return order
    .map((entry, index) => ({ entry, index, rank: rank(entry.path) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((item) => item.entry);
}
