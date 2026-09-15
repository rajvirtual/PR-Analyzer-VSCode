import type { ChangeType, ChangedFile } from "../model/changeset.js";

/**
 * Deterministic ordering hints computed before the model is asked anything.
 *
 * These are evidence the model does not have to guess at, and they give the
 * ordering pass a stable starting point.
 */

export type FileRole =
  | "configuration"
  | "contract"
  | "implementation"
  | "test"
  | "documentation"
  | "other";

export interface FileSignal {
  path: string;
  role: FileRole;
  changeType: ChangeType;
  /** Symbols this file appears to declare. */
  declares: string[];
  /** Paths in the change that reference a symbol this file declares. */
  referencedBy: string[];
  /** Paths in the change whose symbols this file references. */
  references: string[];
  /** How often this file names each of them: a delegate is named more than a mention. */
  referenceStrength: Map<string, number>;
  /** How strongly this file looks like where the flow starts. */
  entryScore: number;
  firstCommitIndex: number;
}

const TEST_PATTERN = /(^|\/)(tests?|__tests__)\//i;
const TEST_FILE_PATTERN = /\.(test|spec)\.[a-z]+$|Tests?\.(cs|java|ts|js|py)$/i;
const CONFIG_PATTERN = /\.(json|ya?ml|toml|ini|props|config|csproj|tf)$/i;
const DOC_PATTERN = /\.(md|mdx|rst|txt)$/i;
const CONTRACT_PATTERN =
  /(contract|interface|dto|model|schema|types?)s?\//i;

const DECLARATION_PATTERNS = [
  /\b(?:class|interface|record|struct|enum)\s+([A-Z][A-Za-z0-9_]*)/g,
  /\btype\s+([A-Z][A-Za-z0-9_]*)\s+struct\b/g,
  /\bconst\s+([A-Z][A-Za-z0-9_]*)\s*=/g,
  /\bexport\s+(?:function|const|class|interface|type)\s+([A-Za-z_][A-Za-z0-9_]*)/g,
  /\bdef\s+([a-z_][A-Za-z0-9_]*)/g,
];

/** Names that usually sit at the top of a flow rather than being called into. */
const ENTRY_POINT_PATTERN =
  /(^|\/)(program|main|startup|entry[-_]?point)\.[a-z]+$|workflow|scheduler|controller|route|endpoint|dispatcher|orchestrat|pipeline|job/i;

/**
 * A file named for the thing that invokes it.
 *
 * The folder says where a file lives, and a whole feature usually lives in one folder;
 * the file name is what distinguishes the task a platform calls into from the handler,
 * contract and model it reaches afterwards.
 */
const ENTRY_FILE_PATTERN = /(task|controller|endpoint|job|worker|trigger|listener|command)\.[a-z]+$/i;

/** The teardown half of a lifecycle: the same shape as an entry point, at the other end. */
const TEARDOWN_FILE_PATTERN = /(delete|teardown|cleanup|dispose|remove)[a-z0-9]*\.[a-z]+$/i;

export function classifyRole(path: string): FileRole {
  if (TEST_PATTERN.test(path) || TEST_FILE_PATTERN.test(path)) return "test";
  if (DOC_PATTERN.test(path)) return "documentation";
  if (CONFIG_PATTERN.test(path)) return "configuration";
  if (CONTRACT_PATTERN.test(path)) return "contract";
  if (/\.(cs|java|go|py|ts|tsx|js|jsx|scala|kt|rb|rs)$/i.test(path)) return "implementation";
  return "other";
}

export function extractDeclarations(content: string): string[] {
  const names = new Set<string>();
  for (const pattern of DECLARATION_PATTERNS) {
    for (const match of content.matchAll(pattern)) {
      if (match[1] && match[1].length > 2) {
        names.add(match[1]);
      }
    }
  }
  return [...names];
}

/** Role ordering reflects how a reviewer builds understanding: contracts, then callers. */
const ROLE_WEIGHT: Record<FileRole, number> = {
  configuration: 0,
  contract: 1,
  implementation: 2,
  other: 3,
  test: 4,
  documentation: 5,
};

/** Declared names common enough that a bare match is not worth trusting. */
const COMMON_NAMES = new Set([
  "Result", "Error", "Options", "Context", "Handler", "Service", "Client",
  "Config", "Data", "Item", "Value", "Name", "Request", "Response", "Type",
  "Model", "State", "Event", "Message", "Node", "Entry", "Info", "Manager",
  "Provider", "Factory", "Base", "Status", "Record",
]);

/** Specific enough that a word-boundary match reads as a real cross-file reference. */
function trustworthyName(name: string): boolean {
  return name.length >= 4 && !COMMON_NAMES.has(name);
}

/** A file's module name: its basename without extension. */
function moduleName(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.[^.]+$/, "");
}

const IMPORT_PATTERN =
  /(?:import|export|require|from|using|include)\b[^;\n'"]*['"]([^'"\n]+)['"]|\b(?:import|from)\s+([\w.]+)/g;

/** The segments of every module this text imports, e.g. "./a/capacity" -> capacity. */
function extractImportedModules(text: string): Set<string> {
  const modules = new Set<string>();
  for (const match of text.matchAll(IMPORT_PATTERN)) {
    const spec = match[1] ?? match[2] ?? "";
    for (const segment of spec.split(/[/.]/)) {
      if (segment.length >= 3) modules.add(segment);
    }
  }
  return modules;
}

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;

const signalCache = new WeakMap<readonly ChangedFile[], FileSignal[]>();

/**
 * The signals for a change set, computed once.
 *
 * Both the reference graph and the step list want these, and the scan is the most
 * expensive pure work in a review; keying the result on the file list means the
 * second caller — and a re-ordering pass — pays nothing.
 */
export function signalsFor(files: ChangedFile[]): FileSignal[] {
  const cached = signalCache.get(files);
  if (cached) return cached;

  const contents = new Map<string, string>();
  for (const file of files) {
    contents.set(file.path, file.after ?? file.before ?? "");
  }

  const computed = computeSignals(files, contents);
  signalCache.set(files, computed);
  return computed;
}

/** Every identifier-shaped word in the text, once. */
/**
 * A name in a comment is prose about the flow, not a step in it.
 *
 * A doc comment saying "the teardown half of this lifecycle lives in DeleteTask" was
 * enough to make the setup task look like it calls the delete task, which sent the
 * whole walk sideways.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

/** Every identifier-shaped word in the text, with how often it appears. */
function tokenize(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of stripComments(text).matchAll(IDENTIFIER)) {
    counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  }
  return counts;
}

function addOwner(index: Map<string, string[]>, key: string, path: string): void {
  const owners = index.get(key);
  if (owners) owners.push(path);
  else index.set(key, [path]);
}

export function computeSignals(
  changedFiles: ChangedFile[],
  contents: Map<string, string>,
): FileSignal[] {
  const pullRequestFiles = changedFiles;

  const declarations = new Map<string, string[]>();
  for (const file of pullRequestFiles) {
    const content = contents.get(file.path);
    declarations.set(file.path, content ? extractDeclarations(content) : []);
  }

  const referencedBy = new Map<string, string[]>();
  const references = new Map<string, string[]>();
  for (const file of pullRequestFiles) {
    referencedBy.set(file.path, []);
    references.set(file.path, []);
  }

  const importsByPath = new Map<string, Set<string>>();
  for (const file of pullRequestFiles) {
    importsByPath.set(file.path, extractImportedModules(contents.get(file.path) ?? ""));
  }

  // One pass over each file's identifiers, against a map of who declares what. Testing
  // every file's declarations against every other file's whole content was quadratic in
  // bytes, and ran on the thread that paints the Files view.
  const ownersByName = new Map<string, string[]>();
  const ownersByModule = new Map<string, string[]>();
  for (const owner of pullRequestFiles) {
    for (const name of (declarations.get(owner.path) ?? []).filter(trustworthyName)) {
      addOwner(ownersByName, name, owner.path);
    }
    addOwner(ownersByModule, moduleName(owner.path), owner.path);
  }

  const reaches = new Map<string, Map<string, number>>();
  for (const other of pullRequestFiles) {
    const found = new Map<string, number>();
    const content = contents.get(other.path);
    if (content) {
      for (const [token, count] of tokenize(content)) {
        for (const owner of ownersByName.get(token) ?? []) {
          found.set(owner, (found.get(owner) ?? 0) + count);
        }
      }
      for (const module of importsByPath.get(other.path) ?? []) {
        for (const owner of ownersByModule.get(module) ?? []) {
          found.set(owner, (found.get(owner) ?? 0) + 1);
        }
      }
    }
    reaches.set(other.path, found);
  }

  // Emitted owner-major, so both sides of every edge read in file order.
  const strength = new Map<string, Map<string, number>>();
  for (const file of pullRequestFiles) strength.set(file.path, new Map());

  for (const owner of pullRequestFiles) {
    for (const other of pullRequestFiles) {
      if (other.path === owner.path) continue;
      const weight = reaches.get(other.path)?.get(owner.path);
      if (!weight) continue;
      referencedBy.get(owner.path)?.push(other.path);
      references.get(other.path)?.push(owner.path);
      strength.get(other.path)?.set(owner.path, weight);
    }
  }

  return pullRequestFiles.map((file) => {
    const inbound = referencedBy.get(file.path) ?? [];
    const outbound = references.get(file.path) ?? [];
    const role = classifyRole(file.path);

    // The start of a flow calls into other files without being called itself.
    let entryScore = 0;
    if (ENTRY_POINT_PATTERN.test(file.path)) entryScore += 3;
    if (ENTRY_FILE_PATTERN.test(file.path)) entryScore += 4;
    if (TEARDOWN_FILE_PATTERN.test(file.path)) entryScore -= 2;
    if (role === "configuration" && outbound.length > 0) entryScore += 3;
    if (inbound.length === 0 && outbound.length > 0) entryScore += 2;
    entryScore += Math.min(outbound.length, 3);
    entryScore -= Math.min(inbound.length, 3);
    if (role === "test") entryScore -= 4;
    // Documentation is the end of the story even more surely than a test is.
    if (role === "documentation") entryScore -= 6;

    return {
      path: file.path,
      role,
      changeType: file.changeType,
      declares: declarations.get(file.path) ?? [],
      referencedBy: inbound,
      references: outbound,
      referenceStrength: strength.get(file.path) ?? new Map(),
      entryScore,
      firstCommitIndex: 0,
    };
  });
}

/**
 * Orders files the way execution reaches them: begin where the flow enters this
 * change, then follow what each file calls into, and finish with anything the flow
 * never reaches.
 */
export function flowOrder(signals: FileSignal[]): string[] {
  const byPath = new Map(signals.map((signal) => [signal.path, signal]));

  // Whatever the scores say, no production file reads after the tests.
  const tail = (signal: FileSignal): number =>
    signal.role === "documentation" ? 2 : signal.role === "test" ? 1 : 0;

  const ranked = [...signals].sort(
    (a, b) =>
      tail(a) - tail(b) || b.entryScore - a.entryScore || a.path.localeCompare(b.path),
  );

  const ordered: string[] = [];
  const seen = new Set<string>();

  function walk(path: string): void {
    if (seen.has(path)) return;
    seen.add(path);
    ordered.push(path);

    const signal = byPath.get(path);
    if (!signal) return;

    // Follow what this file leans on hardest first. Sorting by entry score instead sent
    // the walk to whichever callee most looked like another entry point — a sibling task
    // or a base class — rather than to the handler the file actually delegates to.
    const callees = [...signal.references]
      .map((callee) => byPath.get(callee))
      .filter((callee): callee is FileSignal => callee !== undefined)
      .sort(
        (a, b) =>
          (signal.referenceStrength.get(b.path) ?? 0) -
            (signal.referenceStrength.get(a.path) ?? 0) ||
          b.entryScore - a.entryScore ||
          a.path.localeCompare(b.path),
      );

    for (const callee of callees) {
      walk(callee.path);
    }
  }

  for (const signal of ranked) {
    walk(signal.path);
  }

  return ordered;
}

/** Role ordering reflects dependency depth; kept for reporting, not for step order. */
export function deterministicOrder(signals: FileSignal[]): string[] {
  return [...signals]
    .sort((a, b) => {
      if (b.referencedBy.length !== a.referencedBy.length) {
        return b.referencedBy.length - a.referencedBy.length;
      }
      if (ROLE_WEIGHT[a.role] !== ROLE_WEIGHT[b.role]) {
        return ROLE_WEIGHT[a.role] - ROLE_WEIGHT[b.role];
      }
      return a.path.localeCompare(b.path);
    })
    .map((signal) => signal.path);
}
