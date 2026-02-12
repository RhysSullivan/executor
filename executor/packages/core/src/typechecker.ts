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
          lines.push(`${pad}${key}(input: ${inputType}): Promise<ToolOutput<operations[${opKey}]>>;`);
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
  const ts = getTypeScriptModule();
  if (!ts) return TYPECHECK_OK;

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

  // Count header lines so we can adjust line numbers
  const headerLineCount =
    toolDeclarations.split("\n").length + 4; // +4 for console, setTimeout, clearTimeout, function header

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
