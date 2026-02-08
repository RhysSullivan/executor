/**
 * TypeScript typechecker for LLM-generated code.
 *
 * Generates `declare const tools: { ... }` from ToolDescriptor metadata,
 * then validates code against those declarations using the TypeScript compiler API.
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
 * Tool paths like "math.add" or "admin.send_announcement" are split on "."
 * and nested into a type tree.
 */
export function generateToolDeclarations(tools: ToolDescriptor[]): string {
  // Collect all schema type aliases from all tools (deduplicated by name)
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
        const args = child.tool.argsType || "Record<string, unknown>";
        const returns = child.tool.returnsType || "unknown";
        lines.push(`${pad}${key}(input: ${args}): Promise<${returns}>;`);
      } else {
        lines.push(`${pad}${key}: {`);
        lines.push(renderNode(child, indent + 1));
        lines.push(`${pad}};`);
      }
    }

    return lines.join("\n");
  }

  // Emit schema type aliases before the tools declaration so they're in scope
  const schemaLines: string[] = [];
  for (const [name, type] of allSchemas) {
    schemaLines.push(`type ${name} = ${type};`);
  }

  const schemaBlock = schemaLines.length > 0 ? schemaLines.join("\n") + "\n" : "";
  return `${schemaBlock}declare const tools: {\n${renderNode(root, 1)}\n};`;
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
    "declare const console: { log(...args: any[]): void; info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void; };",
    "declare function setTimeout(fn: () => void, ms: number): number;",
    "declare function clearTimeout(id: number): void;",
    "async function __generated() {",
    code,
    "}",
  ].join("\n");

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

  // Count header lines so we can adjust line numbers
  const headerLineCount =
    toolDeclarations.split("\n").length + 4; // +4 for console, setTimeout, clearTimeout, function header

  const errors = diagnostics.map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (d.start !== undefined && d.file) {
      const { line } = d.file.getLineAndCharacterOfPosition(d.start);
      const adjustedLine = line + 1 - headerLineCount;
      if (adjustedLine > 0) {
        return `Line ${adjustedLine}: ${message}`;
      }
    }
    return message;
  });

  return { ok: false, errors };
}
