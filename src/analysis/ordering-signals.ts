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

  for (const owner of pullRequestFiles) {
    const declared = declarations.get(owner.path) ?? [];
    if (declared.length === 0) continue;

    for (const other of pullRequestFiles) {
      if (other.path === owner.path) continue;
      const otherContent = contents.get(other.path);
      if (!otherContent) continue;

      if (declared.some((name) => otherContent.includes(name))) {
        referencedBy.get(owner.path)?.push(other.path);
        references.get(other.path)?.push(owner.path);
      }
    }
  }

  return pullRequestFiles.map((file) => {
    const inbound = referencedBy.get(file.path) ?? [];
    const outbound = references.get(file.path) ?? [];
    const role = classifyRole(file.path);

    // The start of a flow calls into other files without being called itself.
    let entryScore = 0;
    if (ENTRY_POINT_PATTERN.test(file.path)) entryScore += 3;
    if (role === "configuration" && outbound.length > 0) entryScore += 3;
    if (inbound.length === 0 && outbound.length > 0) entryScore += 2;
    entryScore += Math.min(outbound.length, 3);
    entryScore -= Math.min(inbound.length, 3);
    if (role === "test") entryScore -= 4;

    return {
      path: file.path,
      role,
      changeType: file.changeType,
      declares: declarations.get(file.path) ?? [],
      referencedBy: inbound,
      references: outbound,
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
  const ranked = [...signals].sort(
    (a, b) => b.entryScore - a.entryScore || a.path.localeCompare(b.path),
  );

  const ordered: string[] = [];
  const seen = new Set<string>();

  function walk(path: string): void {
    if (seen.has(path)) return;
    seen.add(path);
    ordered.push(path);

    const signal = byPath.get(path);
    if (!signal) return;

    // Follow the callees in a stable order so the same change always reads the same way.
    const callees = [...signal.references]
      .map((callee) => byPath.get(callee))
      .filter((callee): callee is FileSignal => callee !== undefined)
      .sort((a, b) => b.entryScore - a.entryScore || a.path.localeCompare(b.path));

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
