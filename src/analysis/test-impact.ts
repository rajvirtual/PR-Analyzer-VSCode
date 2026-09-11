import type { ChangedFile } from "../model/changeset.js";

/**
 * Which changed behaviour arrived without a test to hold it.
 *
 * A reviewer of an AI-written change wants to know, fast, where the change altered
 * behaviour but no test moved with it. This is a heuristic — it reads paths, not
 * meaning — so it points a reviewer at a gap rather than proving one.
 */
export interface TestImpact {
  /** Production code files this change touched. */
  changedProduction: string[];
  /** Test files this change touched. */
  changedTests: string[];
  /** Production files whose behaviour changed with no matching test change. */
  uncovered: string[];
}

const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "java", "kt", "cs", "go", "py",
  "rb", "scala", "cpp", "cc", "c", "h", "hpp", "rs", "swift", "php",
]);

const TEST_DIRECTORIES = new Set(["test", "tests", "__tests__", "spec", "specs"]);

/** A path that a test framework would recognise as a test, by convention. */
export function isTestPath(path: string): boolean {
  const segments = path.split("/");
  const rawName = segments[segments.length - 1] ?? "";
  const name = rawName.toLowerCase();
  if (segments.slice(0, -1).some((segment) => TEST_DIRECTORIES.has(segment.toLowerCase()))) {
    return true;
  }

  return (
    /\.(test|spec|e2e|it)\.[a-z0-9]+$/.test(name) || // foo.test.ts, foo.spec.js
    /_test\.[a-z0-9]+$/.test(name) || // foo_test.go
    /^test_[^/]+\.[a-z0-9]+$/.test(name) || // test_foo.py
    // Camel-case suffix, case-sensitive so FooTest matches but "latest" does not.
    /[a-z0-9](Test|Tests|IT|Spec)\.[A-Za-z0-9]+$/.test(rawName) // FooTest.java, FooTests.cs
  );
}

/** A path that is source code rather than data, docs, or configuration. */
export function isCodePath(path: string): boolean {
  const extension = path.toLowerCase().split(".").pop() ?? "";
  return CODE_EXTENSIONS.has(extension);
}

/** The bare name a production file and its test would share, lower-cased. */
export function testKey(path: string): string {
  let name = (path.split("/").pop() ?? path).toLowerCase();
  name = name.replace(/\.[a-z0-9]+$/, ""); // extension
  name = name.replace(/\.(test|spec|e2e|it)$/, ""); // foo.test
  name = name.replace(/^test[_-]/, ""); // test_foo
  name = name.replace(/[_-]?(tests?|specs?|it)$/, ""); // fooTest, foo_test, fooIT
  return name.replace(/[_-]+$/, "");
}

export function analyzeTestImpact(files: ChangedFile[]): TestImpact {
  const changedTests: string[] = [];
  const changedProduction: string[] = [];

  for (const file of files) {
    if (!isCodePath(file.path)) continue;
    if (isTestPath(file.path)) changedTests.push(file.path);
    else changedProduction.push(file.path);
  }

  const testKeys = new Set(changedTests.map(testKey));
  const uncovered = changedProduction.filter((path) => {
    const file = files.find((candidate) => candidate.path === path);
    // A deletion needs no new test; only added or altered behaviour does.
    if (!file || file.changeType === "delete") return false;
    return !testKeys.has(testKey(path));
  });

  return { changedProduction, changedTests, uncovered };
}
