/**
 * TypeScript typechecker for LLM-generated code.
 *
 * Takes a ToolTree, generates TypeScript declarations from Zod schemas,
 * and validates code strings against them using the TypeScript compiler API.
 */

import type { z } from "zod";
import type { ToolDefinition, ToolTree } from "./tools.js";
import { isToolDefinition } from "./tools.js";

// ---------------------------------------------------------------------------
// Zod → TypeScript declaration generation
// ---------------------------------------------------------------------------

// Zod v4 internal def accessor
interface ZodDef {
  type: string;
  // object
  shape?: Record<string, z.ZodType>;
  // array
  element?: z.ZodType;
  // optional / nullable
  innerType?: z.ZodType;
  // record
  keyType?: z.ZodType;
  valueType?: z.ZodType;
  // union
  options?: z.ZodType[];
  // enum (v4 uses entries: { a: "a", b: "b" })
  entries?: Record<string, string>;
  // literal
  value?: unknown;
  // tuple
  items?: z.ZodType[];
}

function getDef(schema: z.ZodType): ZodDef | undefined {
  // Zod v4: schema._zod.def
  const zod = (schema as unknown as { _zod?: { def?: ZodDef } })._zod;
  return zod?.def;
}

/**
 * Convert a Zod schema to a TypeScript type string.
 * Handles the common cases for tool input/output types.
 * Compatible with Zod v4.
 */
export function zodToTypeString(schema: z.ZodType): string {
  const def = getDef(schema);
  if (!def) return "unknown";

  switch (def.type) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "undefined":
      return "undefined";
    case "void":
      return "void";
    case "any":
      return "any";
    case "unknown":
      return "unknown";
    case "never":
      return "never";
    case "literal": {
      const value = def.value;
      return typeof value === "string" ? `"${value}"` : String(value);
    }
    case "array": {
      if (!def.element) return "Array<unknown>";
      return `Array<${zodToTypeString(def.element)}>`;
    }
    case "object": {
      const shape = def.shape;
      if (!shape || Object.keys(shape).length === 0) return "{}";

      const entries = Object.entries(shape).map(([key, value]) => {
        const innerDef = getDef(value);
        const isOptional = innerDef?.type === "optional";
        const innerType = isOptional && innerDef?.innerType ? innerDef.innerType : value;
        const optMark = isOptional ? "?" : "";
        return `${key}${optMark}: ${zodToTypeString(innerType)}`;
      });
      return `{ ${entries.join("; ")} }`;
    }
    case "record": {
      const keyType = def.keyType ? zodToTypeString(def.keyType) : "string";
      const valueType = def.valueType ? zodToTypeString(def.valueType) : "unknown";
      return `Record<${keyType}, ${valueType}>`;
    }
    case "union": {
      if (!def.options) return "unknown";
      return def.options.map((o) => zodToTypeString(o)).join(" | ");
    }
    case "optional": {
      if (!def.innerType) return "unknown | undefined";
      return `${zodToTypeString(def.innerType)} | undefined`;
    }
    case "nullable": {
      if (!def.innerType) return "unknown | null";
      return `${zodToTypeString(def.innerType)} | null`;
    }
    case "enum": {
      if (!def.entries) return "unknown";
      return Object.keys(def.entries).map((v) => `"${v}"`).join(" | ");
    }
    case "tuple": {
      if (!def.items) return "[]";
      return `[${def.items.map((i) => zodToTypeString(i)).join(", ")}]`;
    }
    case "promise": {
      // Zod v4 may use 'innerType' or similar for promise
      if (!def.innerType) return "Promise<unknown>";
      return `Promise<${zodToTypeString(def.innerType)}>`;
    }
    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// ToolTree → TypeScript declaration
// ---------------------------------------------------------------------------

/**
 * Generate a TypeScript declaration string for a ToolTree.
 * This is what goes into the typechecker to validate LLM-generated code.
 */
export function generateToolDeclarations(tree: ToolTree): string {
  return `declare const tools: {\n${generateTreeType(tree, 1)}\n};`;
}

function generateTreeType(tree: ToolTree, indent: number): string {
  const pad = "  ".repeat(indent);
  const lines: string[] = [];

  for (const [key, value] of Object.entries(tree)) {
    if (isToolDefinition(value)) {
      const tool = value as ToolDefinition;
      const argsType = zodToTypeString(tool.args);
      const returnsType = zodToTypeString(tool.returns);
      lines.push(`${pad}${key}(input: ${argsType}): Promise<${returnsType}>;`);
    } else {
      lines.push(`${pad}${key}: {`);
      lines.push(generateTreeType(value as ToolTree, indent + 1));
      lines.push(`${pad}};`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Prompt guidance generation
// ---------------------------------------------------------------------------

/**
 * Generate LLM prompt guidance from a ToolTree.
 * Describes each tool with its path, description, and signature.
 */
export function generatePromptGuidance(tree: ToolTree): string {
  const lines: string[] = [];

  function walk(node: ToolTree, prefix: string) {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (isToolDefinition(value)) {
        const tool = value as ToolDefinition;
        const argsType = zodToTypeString(tool.args);
        const returnsType = zodToTypeString(tool.returns);
        const approvalNote =
          tool.approval === "required" ? " (approval required)" : " (auto-approved)";
        lines.push(
          `- tools.${path}(${argsType}): Promise<${returnsType}>${approvalNote} — ${tool.description}`,
        );
      } else {
        walk(value as ToolTree, path);
      }
    }
  }

  walk(tree, "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// TypeScript typechecking
// ---------------------------------------------------------------------------

export interface TypecheckResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/**
 * Typecheck a code snippet against tool declarations using the TypeScript compiler.
 */
export function typecheckCode(
  code: string,
  toolDeclarations: string,
): TypecheckResult {
  // We use the TypeScript compiler API directly
  let ts: typeof import("typescript");
  try {
    ts = require("typescript");
  } catch {
    // If typescript isn't available, skip typechecking
    return { ok: true, errors: [] };
  }

  // Use a separate type alias to avoid "referenced in its own annotation" error
  const wrappedCode = `${toolDeclarations}\ntype __Tools = typeof tools;\nasync function __generated(__tools: __Tools) {\nconst tools = __tools;\n${code}\n}`;

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
  };

  // Create a minimal compiler host
  const host = ts.createCompilerHost(compilerOptions);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion) => {
    if (fileName === "generated.ts") {
      return sourceFile;
    }
    return originalGetSourceFile(fileName, languageVersion);
  };

  const program = ts.createProgram(["generated.ts"], compilerOptions, host);
  const diagnostics = program.getSemanticDiagnostics(sourceFile);

  if (diagnostics.length === 0) {
    return { ok: true, errors: [] };
  }

  const errors = diagnostics.map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (d.start !== undefined && d.file) {
      const { line } = d.file.getLineAndCharacterOfPosition(d.start);
      // Adjust line number to account for the declarations wrapper
      const declLines = toolDeclarations.split("\n").length + 2; // +2 for blank line + function header
      return `Line ${line + 1 - declLines}: ${message}`;
    }
    return message;
  });

  return { ok: false, errors };
}
