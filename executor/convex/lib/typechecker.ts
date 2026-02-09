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

import type { ToolDescriptor } from "./types";

// ---------------------------------------------------------------------------
// Tool declarations generation
// ---------------------------------------------------------------------------

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
export function generateToolDeclarations(tools: ToolDescriptor[]): string {

  // Legacy compat: collect schemaTypes from tools that use the old format
  const allSchemas = new Map<string, string>();
  for (const tool of tools) {
    if (tool.schemaTypes) {
      for (const [name, type] of Object.entries(tool.schemaTypes)) {
        if (!allSchemas.has(name)) {
          allSchemas.set(name, type);
        }
      }
    }
  }

  // Build a nested tree from flat tool paths
  interface TreeNode {
    children: Map<string, TreeNode>;
    tool?: ToolDescriptor;
  }

  const root: TreeNode = { children: new Map() };

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
        const args = tool.argsType || "Record<string, unknown>";
        const returns = tool.returnsType || "unknown";
        lines.push(`${pad}${key}(input: ${args}): Promise<${returns}>;`);
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

  // Legacy schema type aliases (from old cache format)
  if (allSchemas.size > 0) {
    for (const [name, type] of allSchemas) {
      parts.push(`type ${name} = ${type};`);
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

  const lines = tools.map((t) => {
    const args = t.argsType || "Record<string, unknown>";
    const returns = t.returnsType || "unknown";
    const approval = t.approval === "required" ? " [approval required]" : "";
    return `  tools.${t.path}(input: ${args}): Promise<${returns}>${approval}\n    ${t.description}`;
  });

  return `\nAvailable tools in the sandbox:\n${lines.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// TypeScript typechecking
// ---------------------------------------------------------------------------

export interface TypecheckResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

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
  try {
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
    if (diagnostics.length === 0) {
      return { ok: true, errors: [] };
    }
    return {
      ok: false,
      errors: diagnostics.map((d: import("typescript").Diagnostic) => formatError(d, headerLineCount)),
    };
  } catch {
    return { ok: true, errors: [] };
  }
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
  let ts: typeof import("typescript");
  try {
    ts = require("typescript");
  } catch {
    // TypeScript not available — skip typechecking
    return { ok: true, errors: [] };
  }

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
    headerLineCount: number,
  ): string => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    if (diagnostic.start !== undefined && diagnostic.file) {
      const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      const adjustedLine = line + 1 - headerLineCount;
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

  try {
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
      types: [], // prevent automatic @types/* (e.g. @types/node) from conflicting with our sandbox declarations
    };

    const host = ts.createCompilerHost(compilerOptions);
    const originalGetSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, languageVersion) => {
      if (fileName === "generated.ts") return sourceFile;
      return originalGetSourceFile(fileName, languageVersion);
    };

    const program = ts.createProgram(["generated.ts"], compilerOptions, host);
    const diagnostics = program.getSemanticDiagnostics(sourceFile);

    if (diagnostics.length === 0) {
      return { ok: true, errors: [] };
    }

    // Filter out errors from the .d.ts header (circular refs, etc.) — only report user code errors
    const userErrors = diagnostics.filter((d) => {
      if (d.start !== undefined && d.file) {
        const { line } = d.file.getLineAndCharacterOfPosition(d.start);
        return line + 1 > headerLineCount;
      }
      return false;
    });

    if (userErrors.length === 0) {
      return { ok: true, errors: [] };
    }

    return {
      ok: false,
      errors: userErrors.map((d) => formatError(d, headerLineCount)),
    };
  } catch (error) {
    // Some runtimes (e.g. Convex action isolates) can lack the full Node-backed
    // TypeScript host environment. If semantic typechecking cannot initialize,
    // fall back to syntax-only parsing instead of failing the MCP call.
    if (!warnedSemanticFallback) {
      warnedSemanticFallback = true;
      console.warn(
        `[executor] TypeScript semantic typecheck unavailable, falling back to syntax-only checks: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return runSyntaxOnlyTypecheck(ts, wrappedCode, headerLineCount, formatError);
  }
}
