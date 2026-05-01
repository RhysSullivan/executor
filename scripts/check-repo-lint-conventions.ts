#!/usr/bin/env bun
// Repository lint conventions that need a little context beyond oxlint:
//
// 1. Tests and source files should import test helpers from @effect/vitest or
//    @effect/vitest/utils, not vitest. Vitest config/tooling files are allowed
//    to import vitest directly when necessary.
// 2. Test registration should not be conditional (`condition ? describe :
//    describe.skip`, `if (...) it(...)`, etc.). Use explicit skip helpers or
//    the Effect Vitest helpers instead.
// 3. Double casts through `unknown` or `any` are banned. A narrow migration
//    escape hatch is supported with an inline or preceding-line comment:
//    `// lint-allow-double-cast: <required reason>`.
// 4. Workspace packages must not import other workspace packages through
//    relative paths. Use the package name/export surface instead.
//
// Run: `bun run scripts/check-repo-lint-conventions.ts`
// Exits 1 with a punch list when violations exist.

import { Glob } from "bun";
import path from "node:path";
import ts from "typescript";

const ROOTS = ["packages", "apps", "tests"];
const TEST_REGISTRARS = new Set(["describe", "it", "test"]);
const ALLOW_DOUBLE_CAST = "lint-allow-double-cast:";
const REPO_ROOT = path.resolve(import.meta.dir, "..");
const packageRoots = await collectPackageRoots();

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly kind:
    | "vitest-import"
    | "conditional-test"
    | "double-cast"
    | "cross-package-relative-import";
  readonly message: string;
}

const violations: Violation[] = [];

for (const root of ROOTS) {
  const glob = new Glob(`${root}/**/*.{ts,tsx}`);
  for await (const path of glob.scan({ cwd: import.meta.dir + "/.." })) {
    if (path.includes("node_modules") || path.endsWith(".d.ts")) continue;

    const text = await Bun.file(`${import.meta.dir}/../${path}`).text();
    const sourceFile = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const isConfigOrTooling =
      /(^|\/)(vite|vitest|tsup|drizzle|autumn)\.config\.ts$/.test(path) ||
      path.startsWith("scripts/");
    const isTestLike =
      /(\.|\/)(test|spec|e2e|node\.test)\.tsx?$/.test(path) || path.startsWith("tests/");
    const isSourceOrTest = !isConfigOrTooling;

    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
        continue;
      const specifier = statement.moduleSpecifier.text;
      const crossPackageImport = getCrossPackageRelativeImport(path, specifier);
      if (crossPackageImport) {
        addViolation(
          sourceFile,
          path,
          statement.moduleSpecifier,
          "cross-package-relative-import",
          `import ${crossPackageImport.targetPackage} via its package export instead of a relative path`,
        );
      }

      if (specifier !== "vitest") continue;
      if (isConfigOrTooling) continue;

      addViolation(
        sourceFile,
        path,
        statement.moduleSpecifier,
        "vitest-import",
        "import test helpers from @effect/vitest or @effect/vitest/utils instead of vitest",
      );
    }

    visit(sourceFile, (node) => {
      if (isTestLike) {
        const conditionalTest = getConditionalTestRegistration(node);
        if (conditionalTest) {
          addViolation(
            sourceFile,
            path,
            conditionalTest,
            "conditional-test",
            "avoid conditional test registration; use explicit skip helpers or Effect Vitest helpers",
          );
        }
      }

      const doubleCast = isSourceOrTest ? getDoubleCast(node) : undefined;
      if (doubleCast && !hasDoubleCastAllowComment(sourceFile, text, doubleCast)) {
        addViolation(
          sourceFile,
          path,
          doubleCast,
          "double-cast",
          "avoid double casts through unknown/any; use a typed boundary, schema decode, or a narrow allow comment with a reason",
        );
      }
    });
  }
}

if (violations.length === 0) {
  console.log("✓ repository lint convention check passed");
  process.exit(0);
}

console.error(`✗ repository lint convention check failed — ${violations.length} violation(s):\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}:${v.column} — ${v.kind}: ${v.message}`);
}
console.error(
  `\nGuidance:\n` +
    `  - Import describe/it/test/expect/vi/lifecycle helpers from @effect/vitest, and assertion utilities from @effect/vitest/utils.\n` +
    `  - Keep test registration static; use explicit skip helpers instead of conditionals around describe/it/test.\n` +
    `  - For unavoidable migration double casts, add // ${ALLOW_DOUBLE_CAST} <reason> on the same or preceding line.\n` +
    `  - Import across workspace package boundaries by package name, never by ../../../ relative paths.`,
);
process.exit(1);

async function collectPackageRoots(): Promise<ReadonlyArray<{ root: string; name: string }>> {
  const roots: Array<{ root: string; name: string }> = [];
  for (const root of ["packages", "apps", "examples"]) {
    const glob = new Glob(`${root}/**/package.json`);
    for await (const packageJsonPath of glob.scan({ cwd: REPO_ROOT })) {
      const absolutePackageJsonPath = path.join(REPO_ROOT, packageJsonPath);
      const json = await Bun.file(absolutePackageJsonPath).json();
      if (typeof json.name !== "string") continue;
      roots.push({ root: path.dirname(absolutePackageJsonPath), name: json.name });
    }
  }
  return roots.sort((a, b) => b.root.length - a.root.length);
}

function getCrossPackageRelativeImport(
  file: string,
  specifier: string,
): { readonly targetPackage: string } | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const sourcePackage = findPackageRoot(path.join(REPO_ROOT, file));
  if (!sourcePackage) return undefined;

  const resolved = path.resolve(REPO_ROOT, path.dirname(file), specifier);
  const targetPackage = findPackageRoot(resolved);
  if (!targetPackage || targetPackage.root === sourcePackage.root) return undefined;

  return { targetPackage: targetPackage.name };
}

function findPackageRoot(
  absolutePath: string,
): { readonly root: string; readonly name: string } | undefined {
  const normalized = path.normalize(absolutePath);
  return packageRoots.find(
    (pkg) => normalized === pkg.root || normalized.startsWith(`${pkg.root}${path.sep}`),
  );
}

function getConditionalTestRegistration(node: ts.Node): ts.Node | undefined {
  if (ts.isConditionalExpression(node)) {
    if (isTestRegistrarReference(node.whenTrue) || isTestRegistrarReference(node.whenFalse))
      return node;
  }

  if (
    ts.isIfStatement(node) &&
    (containsTestRegistrarCall(node.thenStatement) ||
      (node.elseStatement && containsTestRegistrarCall(node.elseStatement)))
  ) {
    return node;
  }

  return undefined;
}

function containsTestRegistrarCall(node: ts.Node): boolean {
  let found = false;
  visit(node, (child) => {
    if (found || !ts.isCallExpression(child)) return;
    if (isTestRegistrarReference(child.expression)) found = true;
  });
  return found;
}

function isTestRegistrarReference(node: ts.Node): boolean {
  const expression = ts.skipParentheses(node);
  if (ts.isIdentifier(expression)) return TEST_REGISTRARS.has(expression.text);
  if (!ts.isPropertyAccessExpression(expression)) return false;

  const receiver = ts.skipParentheses(expression.expression);
  return ts.isIdentifier(receiver) && TEST_REGISTRARS.has(receiver.text);
}

function getDoubleCast(node: ts.Node): ts.AsExpression | undefined {
  if (!ts.isAsExpression(node)) return undefined;
  const inner = ts.skipParentheses(node.expression);
  if (!ts.isAsExpression(inner)) return undefined;

  const innerType = inner.type.getText();
  return innerType === "unknown" || innerType === "any" ? node : undefined;
}

function hasDoubleCastAllowComment(
  sourceFile: ts.SourceFile,
  text: string,
  node: ts.Node,
): boolean {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const lines = text.split("\n");
  const currentLine = lines[line] ?? "";
  const previousLine = line > 0 ? (lines[line - 1] ?? "") : "";
  return hasReason(currentLine) || hasReason(previousLine);
}

function hasReason(line: string): boolean {
  const index = line.indexOf(ALLOW_DOUBLE_CAST);
  return index >= 0 && line.slice(index + ALLOW_DOUBLE_CAST.length).trim().length > 0;
}

function addViolation(
  sourceFile: ts.SourceFile,
  file: string,
  node: ts.Node,
  kind: Violation["kind"],
  message: string,
): void {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  violations.push({ file, line: line + 1, column: character + 1, kind, message });
}

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}
