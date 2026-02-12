/**
 * TypeScript typechecker for LLM-generated code.
 *
 * For OpenAPI tools with a raw .d.ts from openapi-typescript, the typechecker
 * uses the .d.ts directly with helper types (ToolInput/ToolOutput) that extract
 * per-operation arg/return types via indexed access. This avoids parsing the
 * .d.ts to extract per-operation type strings.
 *
 * For tools without a .d.ts (MCP, GraphQL, builtins), the typechecker falls
 * back to using the lightweight argsType/returnsType hint strings.
 *
 * This runs in the executor so all MCP clients benefit from typechecking
 * without needing their own TypeScript setup.
 */

import { Result } from "better-result";
import type { ToolDescriptor } from "./types";

// ---------------------------------------------------------------------------
// Tool declarations generation
// ---------------------------------------------------------------------------

function getTypeScriptModule(): typeof import("typescript") | null {
  const loaded = Result.try(() => require("typescript") as typeof import("typescript"));
  return loaded.isOk() ? loaded.value : null;
}

function isValidTypeExpression(typeExpression: string): boolean {
  const ts = getTypeScriptModule();
  if (!ts) {
    // Best-effort fallback when TS isn't available.
    return !/[\r\n`]/.test(typeExpression);
  }

  return Result.try(() => {
    const sourceFile = ts.createSourceFile(
      "_type_expr_check.ts",
      `type __T = ${typeExpression};`,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    const diagnostics = (
      sourceFile as unknown as { parseDiagnostics?: import("typescript").Diagnostic[] }
    ).parseDiagnostics ?? [];
    return diagnostics.length === 0;
  }).unwrapOr(false);
}

function safeTypeExpression(raw: string | undefined, fallback: string): string {
  const typeExpression = raw?.trim();
  if (!typeExpression) return fallback;
  return isValidTypeExpression(typeExpression) ? typeExpression : fallback;
}

export interface ToolReferenceAnalysis {
  callPaths: string[];
  hasDynamicToolAccess: boolean;
  hasNonCallToolAccess: boolean;
}

type StaticToolPathResult = {
  segments: string[] | null;
  dynamic: boolean;
};

function unwrapToolAccessExpression(
  expression: import("typescript").Expression,
  ts: typeof import("typescript"),
): import("typescript").Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isPartiallyEmittedExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function parseStaticToolPath(
  expression: import("typescript").Expression,
  ts: typeof import("typescript"),
): StaticToolPathResult {
  const unwrapped = unwrapToolAccessExpression(expression, ts);

  if (ts.isIdentifier(unwrapped)) {
    if (unwrapped.text === "tools") {
      return { segments: [], dynamic: false };
    }
    return { segments: null, dynamic: false };
  }

  if (ts.isPropertyAccessExpression(unwrapped)) {
    const base = parseStaticToolPath(unwrapped.expression, ts);
    if (!base.segments) return base;
    return {
      segments: [...base.segments, unwrapped.name.text],
      dynamic: base.dynamic,
    };
  }

  if (ts.isElementAccessExpression(unwrapped)) {
    const base = parseStaticToolPath(unwrapped.expression, ts);
    if (!base.segments) return base;

    const argument = unwrapped.argumentExpression
      ? unwrapToolAccessExpression(unwrapped.argumentExpression, ts)
      : null;

    if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
      return {
        segments: [...base.segments, argument.text],
        dynamic: base.dynamic,
      };
    }

    return {
      segments: base.segments,
      dynamic: true,
    };
  }

  return { segments: null, dynamic: false };
}

/**
 * Analyze user code and extract static tool call paths like
 * `tools.github.issues.list_for_repo(...)`.
 */
export function analyzeToolReferences(code: string): ToolReferenceAnalysis {
  const ts = getTypeScriptModule();
  if (!ts) {
    return {
      callPaths: [],
      hasDynamicToolAccess: true,
      hasNonCallToolAccess: true,
    };
  }

  const sourceFile = ts.createSourceFile(
    "generated_user_code.ts",
    code,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );

  const callPaths = new Set<string>();
  let hasDynamicToolAccess = false;
  let hasNonCallToolAccess = false;

  const isInCallTargetChain = (node: import("typescript").Node): boolean => {
    let current = node;
    while (
      (ts.isPropertyAccessExpression(current.parent) || ts.isElementAccessExpression(current.parent))
      && current.parent.expression === current
    ) {
      current = current.parent;
    }
    return ts.isCallExpression(current.parent) && current.parent.expression === current;
  };

  const visit = (node: import("typescript").Node): void => {
    if (ts.isCallExpression(node)) {
      const parsed = parseStaticToolPath(node.expression, ts);
      if (parsed.segments && parsed.segments.length > 0 && !parsed.dynamic) {
        callPaths.add(parsed.segments.join("."));
      }
      if (parsed.dynamic) {
        hasDynamicToolAccess = true;
      }
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const parsed = parseStaticToolPath(node, ts);
      if (parsed.segments) {
        if (!isInCallTargetChain(node)) {
          hasNonCallToolAccess = true;
        }
        if (parsed.dynamic) {
          hasDynamicToolAccess = true;
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  return {
    callPaths: [...callPaths].sort((a, b) => a.localeCompare(b)),
    hasDynamicToolAccess,
    hasNonCallToolAccess,
  };
}

function propertyNameText(
  name: import("typescript").PropertyName,
  ts: typeof import("typescript"),
): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrapToolAccessExpression(name.expression, ts);
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression) || ts.isNumericLiteral(expression)) {
      return expression.text;
    }
  }
  return null;
}

function indentBlock(text: string, indent = "  "): string {
  return text
    .split("\n")
    .map((line) => (line.trim().length === 0 ? "" : `${indent}${line}`))
    .join("\n");
}

/**
 * Build a minimal OpenAPI .d.ts containing only selected `operations` members.
 * Returns null when slicing is not possible and callers should use full .d.ts.
 */
export function sliceOpenApiOperationsDts(
  dts: string,
  operationIds: Iterable<string>,
): string | null {
  const ts = getTypeScriptModule();
  if (!ts) return null;

  const wanted = new Set([...operationIds].filter((value) => value.trim().length > 0));
  if (wanted.size === 0) return null;

  const sourceFile = ts.createSourceFile(
    "openapi-source.d.ts",
    dts,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );

  const operationsInterface = sourceFile.statements.find((statement) =>
    ts.isInterfaceDeclaration(statement)
    && statement.name.text === "operations",
  );

  if (!operationsInterface || !ts.isInterfaceDeclaration(operationsInterface)) {
    return null;
  }

  const selectedMembers: string[] = [];
  for (const member of operationsInterface.members) {
    if (!ts.isPropertySignature(member) || !member.name) continue;
    const key = propertyNameText(member.name, ts);
    if (!key || !wanted.has(key)) continue;

    const start = member.getFullStart();
    const raw = dts.slice(start, member.end).trim();
    if (raw.length > 0) {
      selectedMembers.push(raw);
    }
  }

  if (selectedMembers.length === 0) {
    return null;
  }

  const body = selectedMembers.map((member) => indentBlock(member)).join("\n");
  return `export interface operations {\n${body}\n}`;
}

const OPENAPI_HELPER_TYPES = `
type _Normalize<T> = Exclude<T, undefined | null>;
type _OrEmpty<T> = [_Normalize<T>] extends [never] ? {} : _Normalize<T>;
type _Simplify<T> = { [K in keyof T]: T[K] } & {};
type _ParamsOf<Op> =
  Op extends { parameters: infer P } ? P :
  Op extends { parameters?: infer P } ? P :
  never;
type _ParamAt<Op, K extends "query" | "path" | "header" | "cookie"> =
  _ParamsOf<Op> extends { [P in K]?: infer V } ? V : never;
type _BodyOf<Op> =
  Op extends { requestBody?: infer B } ? B :
  Op extends { requestBody: infer B } ? B :
  never;
type _BodyContent<B> =
  B extends { content: infer C }
    ? C extends Record<string, infer V> ? V : never
    : never;
type ToolInput<Op> = _Simplify<
  _OrEmpty<_ParamAt<Op, "query">> &
  _OrEmpty<_ParamAt<Op, "path">> &
  _OrEmpty<_ParamAt<Op, "header">> &
  _OrEmpty<_ParamAt<Op, "cookie">> &
  _OrEmpty<_BodyContent<_BodyOf<Op>>>
>;
type _ResponsesOf<Op> = Op extends { responses: infer R } ? R : never;
type _RespAt<Op, Code extends PropertyKey> =
  _ResponsesOf<Op> extends { [K in Code]?: infer R } ? R : never;
type _ResponsePayload<R> =
  [R] extends [never] ? never :
  R extends { content: infer C }
    ? C extends Record<string, infer V> ? V : unknown
    : R extends { schema: infer S } ? S : unknown;
type _HasStatus<Op, Code extends PropertyKey> =
  [_RespAt<Op, Code>] extends [never] ? false : true;
type _PayloadAt<Op, Code extends PropertyKey> =
  Code extends 204 | 205
    ? (_HasStatus<Op, Code> extends true ? void : never)
    : _ResponsePayload<_RespAt<Op, Code>>;
type _FirstKnown<T extends readonly unknown[]> =
  T extends readonly [infer H, ...infer Rest]
    ? [H] extends [never] ? _FirstKnown<Rest> : H
    : unknown;
type ToolOutput<Op> = _FirstKnown<[
  _PayloadAt<Op, 200>,
  _PayloadAt<Op, 201>,
  _PayloadAt<Op, 202>,
  _PayloadAt<Op, 203>,
  _PayloadAt<Op, 204>,
  _PayloadAt<Op, 205>,
  _PayloadAt<Op, 206>,
  _PayloadAt<Op, 207>,
  _PayloadAt<Op, 208>,
  _PayloadAt<Op, 226>,
  _PayloadAt<Op, "default">,
  unknown
]>;
`;

function stripExportKeywordsForTypechecker(dts: string): string {
  // openapi-typescript emits `export interface ...`; for our single-file checker
  // we want ambient-like declarations in script scope.
  return dts.replace(/\bexport\s+/g, "").trim();
}

export interface GenerateToolDeclarationOptions {
  sourceDtsBySource?: Record<string, string>;
}

/**
 * Build a `declare const tools: { ... }` block from flat tool descriptors.
 *
 * Uses the lightweight `argsType`/`returnsType` strings from each tool.
 * This is used by the server-side MCP typechecker, which doesn't need the
 * full OpenAPI .d.ts (that's handled by Monaco on the client side).
 *
 * Tool paths like "math.add" or "admin.send_announcement" are split on "."
 * and nested into a type tree.
 */
export function generateToolDeclarations(
  tools: ToolDescriptor[],
  options?: GenerateToolDeclarationOptions,
): string {

  // Build a nested tree from flat tool paths
  interface TreeNode {
    children: Map<string, TreeNode>;
    tool?: ToolDescriptor;
  }

  const root: TreeNode = { children: new Map() };
  const dtsSources = new Set(Object.keys(options?.sourceDtsBySource ?? {}));

  for (const tool of tools) {
    const segments = tool.path.split(".");
    let node = root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (!node.children.has(seg)) {
        node.children.set(seg, { children: new Map() });
      }
      node = node.children.get(seg)!;
      if (i === segments.length - 1) {
        node.tool = tool;
      }
    }
  }

  function renderNode(node: TreeNode, indent: number): string {
    const pad = "  ".repeat(indent);
    const lines: string[] = [];

    for (const [key, child] of node.children) {
      if (child.tool) {
        const tool = child.tool;
        if (tool.operationId && tool.source && dtsSources.has(tool.source)) {
          const opKey = JSON.stringify(tool.operationId);
          const openApiInputType = `ToolInput<operations[${opKey}]>`;
          const strictArgsType = safeTypeExpression(tool.strictArgsType, "{}");
          const inputType = strictArgsType !== "{}"
            ? `(${openApiInputType}) & (${strictArgsType})`
            : openApiInputType;
          const openApiOutputType = `ToolOutput<operations[${opKey}]>`;
          const strictReturnsType = safeTypeExpression(tool.strictReturnsType, "unknown");
          const outputType = strictReturnsType !== "unknown"
            ? `(${openApiOutputType}) & (${strictReturnsType})`
            : openApiOutputType;
          lines.push(`${pad}${key}(input: ${inputType}): Promise<${outputType}>;`);
        } else {
          const strictArgsType = tool.strictArgsType?.trim();
          const strictReturnsType = tool.strictReturnsType?.trim();
          const effectiveArgs = strictArgsType || tool.argsType;
          const effectiveReturns = strictReturnsType || tool.returnsType;
          const hasArgsType = Boolean(effectiveArgs?.trim());
          const args = safeTypeExpression(effectiveArgs, "Record<string, unknown>");
          const returns = safeTypeExpression(effectiveReturns, "unknown");
          const inputParam = !hasArgsType || args === "{}"
            ? `input?: ${args}`
            : `input: ${args}`;
          lines.push(`${pad}${key}(${inputParam}): Promise<${returns}>;`);
        }
      } else {
        lines.push(`${pad}${key}: {`);
        lines.push(renderNode(child, indent + 1));
        lines.push(`${pad}};`);
      }
    }

    return lines.join("\n");
  }

  // Assemble the full declarations block
  const parts: string[] = [];

  const sourceDtsBySource = options?.sourceDtsBySource ?? {};
  const dtsEntries = Object.entries(sourceDtsBySource)
    .filter(([, dts]) => typeof dts === "string" && dts.trim().length > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (dtsEntries.length > 0) {
    parts.push(OPENAPI_HELPER_TYPES);
    for (const [sourceKey, dts] of dtsEntries) {
      parts.push(`// OpenAPI types from ${sourceKey}\n${stripExportKeywordsForTypechecker(dts)}`);
    }
  }

  // The tools declaration
  parts.push(`declare const tools: {\n${renderNode(root, 1)}\n};`);

  return parts.join("\n");
}

/**
 * Generate the tool inventory text for the MCP run_code description.
 * Includes full type signatures so the LLM can write correct code.
 */
export function generateToolInventory(tools: ToolDescriptor[]): string {
  if (!tools || tools.length === 0) return "";

  const namespaceCounts = new Map<string, number>();
  for (const tool of tools) {
    const topLevel = tool.path.split(".")[0] || tool.path;
    namespaceCounts.set(topLevel, (namespaceCounts.get(topLevel) ?? 0) + 1);
  }

  const namespaces = [...namespaceCounts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => `${name} (${count})`);

  const examples = tools
    .filter((tool) => tool.path !== "discover")
    .slice(0, 8)
    .map((tool) => `  - tools.${tool.path}(...)`);

  const hasGraphqlTools = tools.some((tool) => tool.path.endsWith(".graphql"));

  return [
    "",
    "You have access to these tool namespaces:",
    `  ${namespaces.join(", ")}`,
    "",
    "Use `tools.discover({ query, depth?, limit?, compact? })` first. It returns `{ bestPath, results, total }` (not an array).",
    "Prefer `bestPath` when present, otherwise use a `results[i].path`; use `exampleCall` for invocation shape.",
    "For migration/ETL tasks: discover once, then execute in small batches and return compact summaries (counts, IDs, top-N samples).",
    "Never shadow the global `tools` object (do NOT write `const tools = ...`).",
    "Then call tools directly using the returned path.",
    ...(hasGraphqlTools
      ? ["GraphQL tools return `{ data, errors }`; prefer `source.query.*` / `source.mutation.*` helpers over raw `source.graphql` when available."]
      : []),
    ...(examples.length > 0
      ? ["", "Example callable paths:", ...examples]
      : []),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// TypeScript typechecking
// ---------------------------------------------------------------------------

export interface TypecheckResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

const TYPECHECK_OK: TypecheckResult = { ok: true, errors: [] };

let warnedMissingCompilerHostSupport = false;
let warnedSemanticFallback = false;
let warnedTsgoUnavailable = false;
let warnedTsgoFallback = false;
let resolvedTsgoExecutablePath: string | null | undefined;

function getNodeProcess(): { env?: Record<string, string | undefined>; platform?: string; arch?: string } | null {
  const candidate = (globalThis as { process?: unknown }).process;
  return candidate && typeof candidate === "object"
    ? (candidate as { env?: Record<string, string | undefined>; platform?: string; arch?: string })
    : null;
}

function getNodeRequire(): ((id: string) => any) | null {
  return Result.try(() => {
    const candidate = Function("return typeof require === 'function' ? require : null;")() as unknown;
    return typeof candidate === "function" ? (candidate as (id: string) => any) : null;
  }).unwrapOr(null);
}

function wantsTsgoTypecheckEngine(): boolean {
  const configured = getNodeProcess()?.env?.EXECUTOR_TYPECHECK_ENGINE?.trim().toLowerCase();
  if (!configured || configured === "auto") return true;
  if (configured === "typescript") return false;
  return configured === "tsgo";
}

function resolveTsgoExecutablePath(opts?: { silentIfMissing?: boolean }): string | null {
  if (resolvedTsgoExecutablePath !== undefined) {
    return resolvedTsgoExecutablePath;
  }

  const result = Result.try(() => {
    const processRef = getNodeProcess();
    const platform = processRef?.platform;
    const arch = processRef?.arch;
    if (!platform || !arch) {
      throw new Error("Node platform information unavailable");
    }

    const requireFn = getNodeRequire();
    if (!requireFn) {
      throw new Error("Node require() unavailable");
    }

    const fs = requireFn("fs");
    const path = requireFn("path");
    const platformPackageName = `@typescript/native-preview-${platform}-${arch}`;
    const packageJsonPath = (requireFn as { resolve?: (id: string) => string }).resolve?.(`${platformPackageName}/package.json`);
    if (!packageJsonPath) {
      throw new Error(`Unable to resolve ${platformPackageName}/package.json`);
    }
    const executableName = platform === "win32" ? "tsgo.exe" : "tsgo";
    const executablePath = path.join(path.dirname(packageJsonPath), "lib", executableName);
    if (!fs.existsSync(executablePath)) {
      throw new Error(`Executable not found at ${executablePath}`);
    }
    return executablePath;
  });

  if (result.isOk()) {
    resolvedTsgoExecutablePath = result.value;
    return result.value;
  }

  resolvedTsgoExecutablePath = null;
  if (!opts?.silentIfMissing && !warnedTsgoUnavailable) {
    warnedTsgoUnavailable = true;
    console.warn(
      `[executor] tsgo requested but unavailable, falling back to TypeScript compiler API: ${result.error.message}`,
    );
  }
  return null;
}

function parseTsgoDiagnosticsInternal(output: string, headerLineCount: number): {
  userErrors: string[];
  matchedDiagnostics: number;
} {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const errors: string[] = [];
  let matchedDiagnostics = 0;
  const pattern = /(?:^|[\\/])generated\.ts\((\d+),(\d+)\):\s*error\s+TS\d+:\s*(.+)$/;

  for (const line of lines) {
    const match = pattern.exec(line);
    if (!match) continue;
    matchedDiagnostics += 1;
    const absoluteLine = Number.parseInt(match[1] ?? "", 10);
    const message = (match[3] ?? "Type error").trim();
    if (!Number.isFinite(absoluteLine) || absoluteLine <= headerLineCount) {
      continue;
    }
    errors.push(`Line ${absoluteLine - headerLineCount}: ${message}`);
  }

  return {
    userErrors: errors,
    matchedDiagnostics,
  };
}

export function parseTsgoDiagnostics(output: string, headerLineCount: number): string[] {
  return parseTsgoDiagnosticsInternal(output, headerLineCount).userErrors;
}

function runTsgoTypecheck(
  wrappedCode: string,
  headerLineCount: number,
): TypecheckResult | null {
  const configured = getNodeProcess()?.env?.EXECUTOR_TYPECHECK_ENGINE?.trim().toLowerCase();
  const explicitTsgo = configured === "tsgo";
  const executablePath = resolveTsgoExecutablePath({ silentIfMissing: !explicitTsgo });
  if (!executablePath) {
    return null;
  }

  const result = Result.try(() => {
    const requireFn = getNodeRequire();
    if (!requireFn) {
      throw new Error("Node require() unavailable");
    }

    const fs = requireFn("fs");
    const os = requireFn("os");
    const path = requireFn("path");
    const childProcess = requireFn("child_process");
    const spawnSync = childProcess?.spawnSync;
    if (typeof spawnSync !== "function") {
      throw new Error("child_process.spawnSync unavailable");
    }

    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "executor-tsgo-"));
    const sourcePath = path.join(tempDirectory, "generated.ts");
    const tsconfigPath = path.join(tempDirectory, "tsconfig.json");

    try {
      fs.writeFileSync(sourcePath, wrappedCode, "utf8");
      fs.writeFileSync(
        tsconfigPath,
        JSON.stringify({
          compilerOptions: {
            target: "ESNext",
            module: "ESNext",
            strict: true,
            noEmit: true,
            lib: ["es2022"],
            types: [],
          },
          files: ["generated.ts"],
        }),
        "utf8",
      );

      const command = spawnSync(
        executablePath,
        ["--pretty", "false", "--project", tsconfigPath],
        {
          cwd: tempDirectory,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      if (command.error) {
        throw command.error;
      }

      if ((command.status ?? 1) === 0) {
        return TYPECHECK_OK;
      }

      const output = `${command.stdout ?? ""}\n${command.stderr ?? ""}`;
      const diagnostics = parseTsgoDiagnosticsInternal(output, headerLineCount);
      if (diagnostics.userErrors.length > 0) {
        return {
          ok: false as const,
          errors: diagnostics.userErrors,
        };
      }

      if (diagnostics.matchedDiagnostics > 0) {
        return TYPECHECK_OK;
      }

      const fallbackMessage = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, 3)
        .join(" | ");

      return {
        ok: false as const,
        errors: [fallbackMessage.length > 0 ? fallbackMessage : "tsgo typecheck failed"],
      };
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  if (result.isOk()) {
    return result.value;
  }

  if (!warnedTsgoFallback) {
    warnedTsgoFallback = true;
    console.warn(
      `[executor] tsgo typecheck failed, falling back to TypeScript compiler API: ${result.error.message}`,
    );
  }
  return null;
}

function runSyntaxOnlyTypecheck(
  ts: typeof import("typescript"),
  wrappedCode: string,
  headerLineCount: number,
  formatError: (
    diagnostic: import("typescript").Diagnostic,
    headerLineCount: number,
  ) => string,
): TypecheckResult {
  return Result.try(() => {
    const sourceFile = ts.createSourceFile(
      "generated.ts",
      wrappedCode,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    );
    const diagnostics = (
      sourceFile as unknown as { parseDiagnostics?: import("typescript").Diagnostic[] }
    ).parseDiagnostics ?? [];
    if (diagnostics.length === 0) return TYPECHECK_OK;
    return {
      ok: false as const,
      errors: diagnostics.map((d) => formatError(d, headerLineCount)),
    };
  }).unwrapOr(TYPECHECK_OK);
}

function runSemanticTypecheck(
  ts: typeof import("typescript"),
  wrappedCode: string,
  headerLineCount: number,
  formatError: (
    diagnostic: import("typescript").Diagnostic,
    headerLineCount: number,
  ) => string,
): Result<TypecheckResult, Error> {
  return Result.try({
    try: () => {
      const sourceFile = ts.createSourceFile(
        "generated.ts",
        wrappedCode,
        ts.ScriptTarget.ESNext,
        true,
        ts.ScriptKind.TS,
      );

      const compilerOptions: import("typescript").CompilerOptions = {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        strict: true,
        noEmit: true,
        lib: ["lib.es2022.d.ts"],
        types: [], // prevent automatic @types/* from conflicting with sandbox declarations
      };

      const host = ts.createCompilerHost(compilerOptions);
      const originalGetSourceFile = host.getSourceFile.bind(host);
      host.getSourceFile = (fileName, languageVersion) => {
        if (fileName === "generated.ts") return sourceFile;
        return originalGetSourceFile(fileName, languageVersion);
      };

      const program = ts.createProgram(["generated.ts"], compilerOptions, host);
      const diagnostics = program.getSemanticDiagnostics(sourceFile);

      if (diagnostics.length === 0) return TYPECHECK_OK;

      // Filter out errors from the .d.ts header — only report user code errors
      const userErrors = diagnostics.filter((d) => {
        if (d.start !== undefined && d.file) {
          const { line } = d.file.getLineAndCharacterOfPosition(d.start);
          return line + 1 > headerLineCount;
        }
        return false;
      });

      if (userErrors.length === 0) return TYPECHECK_OK;

      return {
        ok: false as const,
        errors: userErrors.map((d) => formatError(d, headerLineCount)),
      };
    },
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  });
}

/**
 * Typecheck LLM-generated code against tool declarations.
 *
 * Uses the TypeScript compiler API. Returns errors with line numbers
 * adjusted to match the original code (not the wrapper).
 */
export function typecheckCode(
  code: string,
  toolDeclarations: string,
): TypecheckResult {
  // Wrap the code in an async function with the tools declaration.
  // We declare sandbox globals (console, setTimeout, etc.) ourselves since
  // `types: []` prevents @types/node from loading.
  const wrappedCode = [
    toolDeclarations,
    "declare var console: { log(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void; };",
    "declare function setTimeout(fn: () => void, ms: number): number;",
    "declare function clearTimeout(id: number): void;",
    "async function __generated() {",
    code,
    "}",
  ].join("\n");

  // Count header lines so we can adjust line numbers
  const headerLineCount =
    toolDeclarations.split("\n").length + 4; // +4 for console, setTimeout, clearTimeout, function header

  if (wantsTsgoTypecheckEngine()) {
    const tsgoResult = runTsgoTypecheck(wrappedCode, headerLineCount);
    if (tsgoResult) {
      return tsgoResult;
    }
  }

  const ts = getTypeScriptModule();
  if (!ts) return TYPECHECK_OK;

  const formatError = (
    diagnostic: import("typescript").Diagnostic,
    hdrLineCount: number,
  ): string => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    if (diagnostic.start !== undefined && diagnostic.file) {
      const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      const adjustedLine = line + 1 - hdrLineCount;
      if (adjustedLine > 0) {
        return `Line ${adjustedLine}: ${message}`;
      }
    }
    return message;
  };

  if (!ts.sys || typeof ts.sys.useCaseSensitiveFileNames !== "boolean") {
    if (!warnedMissingCompilerHostSupport) {
      warnedMissingCompilerHostSupport = true;
      console.warn(
        "[executor] TypeScript semantic typecheck unavailable in this runtime, using syntax-only checks.",
      );
    }
    return runSyntaxOnlyTypecheck(ts, wrappedCode, headerLineCount, formatError);
  }

  const semantic = runSemanticTypecheck(ts, wrappedCode, headerLineCount, formatError);
  if (semantic.isOk()) return semantic.value;

  // Semantic typechecking failed to initialize — fall back to syntax-only.
  if (!warnedSemanticFallback) {
    warnedSemanticFallback = true;
    console.warn(
      `[executor] TypeScript semantic typecheck unavailable, falling back to syntax-only checks: ${semantic.error.message}`,
    );
  }

  return runSyntaxOnlyTypecheck(ts, wrappedCode, headerLineCount, formatError);
}
