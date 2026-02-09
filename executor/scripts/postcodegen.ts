/**
 * Post-codegen script for Convex.
 *
 * Rewrites `convex/_generated/api.d.ts` to replace the deeply-recursive
 * `ApiFromModules` / `FilterApi` types with explicit per-module declarations.
 *
 * Why: With 18+ modules and 100+ exported functions, the recursive type chain
 * `ApiFromModules → ExpandModulesAndDirs → UnionToIntersection → FilterApi`
 * exceeds TypeScript's instantiation depth limit of 100, causing TS2589.
 *
 * Usage:
 *   bun scripts/postcodegen.ts
 *
 * Run this after `bunx convex codegen` or `bunx convex dev` (via postinstall).
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import * as ts from "typescript";

const EXECUTOR_DIR = resolve(import.meta.dirname, "..");
const CONVEX_DIR = join(EXECUTOR_DIR, "convex");
const API_DTS_PATH = join(CONVEX_DIR, "_generated", "api.d.ts");

/** Read the generated api.d.ts and extract the module list + components block. */
function parseGeneratedApi(content: string) {
  const moduleImportRegex = /^import type \* as (\w+) from "\.\.\/(\w+)\.js";$/gm;
  const modules: { name: string; file: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = moduleImportRegex.exec(content)) !== null) {
    modules.push({ name: match[1], file: match[2] });
  }

  // Extract the components block (everything from `export declare const components:` to the end)
  const componentsMatch = content.match(
    /export declare const components:\s*\{[\s\S]*$/,
  );
  const componentsBlock = componentsMatch ? componentsMatch[0] : "export declare const components: {};";

  return { modules, componentsBlock };
}

type FunctionKind = "query" | "mutation" | "action";
type FunctionVisibility = "public" | "internal";

interface ParsedExport {
  name: string;
  kind: FunctionKind;
  visibility: FunctionVisibility;
}

/** Determine the function kind and visibility from a call expression. */
function resolveRegistration(callName: string): { kind: FunctionKind; visibility: FunctionVisibility } | null {
  switch (callName) {
    case "query": return { kind: "query", visibility: "public" };
    case "internalQuery": return { kind: "query", visibility: "internal" };
    case "mutation": return { kind: "mutation", visibility: "public" };
    case "internalMutation": return { kind: "mutation", visibility: "internal" };
    case "action": return { kind: "action", visibility: "public" };
    case "internalAction": return { kind: "action", visibility: "internal" };
    default: return null;
  }
}

/** Parse a Convex module file to extract exported function registrations. */
function parseModuleExports(filePath: string): ParsedExport[] {
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, "utf-8");
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
  );

  const exports: ParsedExport[] = [];

  function visit(node: ts.Node) {
    // Match: export const foo = query({...}) / mutation({...}) / etc.
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const exportName = decl.name.text;

        let callExpr: ts.CallExpression | undefined;

        // Direct call: export const foo = query({...})
        if (ts.isCallExpression(decl.initializer)) {
          callExpr = decl.initializer;
        }

        // Nullish coalescing fallback: export const foo = bar?.baz ?? internalMutation({...})
        // The RHS of ?? determines the Convex registration type.
        if (
          !callExpr &&
          ts.isBinaryExpression(decl.initializer) &&
          decl.initializer.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        ) {
          const rhs = decl.initializer.right;
          if (ts.isCallExpression(rhs)) {
            callExpr = rhs;
          }
        }

        // Ternary fallback: export const foo = cond ? bar : internalMutation({...})
        if (
          !callExpr &&
          ts.isConditionalExpression(decl.initializer)
        ) {
          const whenFalse = decl.initializer.whenFalse;
          if (ts.isCallExpression(whenFalse)) {
            callExpr = whenFalse;
          }
        }

        if (!callExpr) continue;

        // Get the function name being called
        let calledName: string | undefined;
        if (ts.isIdentifier(callExpr.expression)) {
          calledName = callExpr.expression.text;
        }

        if (!calledName) continue;

        const reg = resolveRegistration(calledName);
        if (reg) {
          exports.push({ name: exportName, ...reg });
          continue;
        }

        // Custom builders (workspaceQuery, authedMutation, organizationQuery, etc.)
        // These wrap standard query/mutation/action builders. We need to determine
        // which base type they correspond to.
        const customBuilderMap: Record<string, { kind: FunctionKind; visibility: FunctionVisibility }> = {
          workspaceQuery: { kind: "query", visibility: "public" },
          workspaceMutation: { kind: "mutation", visibility: "public" },
          authedQuery: { kind: "query", visibility: "public" },
          authedMutation: { kind: "mutation", visibility: "public" },
          organizationQuery: { kind: "query", visibility: "public" },
          organizationMutation: { kind: "mutation", visibility: "public" },
          optionalAccountQuery: { kind: "query", visibility: "public" },
          internalOrganizationQuery: { kind: "query", visibility: "internal" },
        };

        const customReg = customBuilderMap[calledName];
        if (customReg) {
          exports.push({ name: exportName, ...customReg });
        }
      }
    }

    // Match: export default httpRouter() — skip (http module has no function refs)
    // Match: export { authKitEvent } from ... — already handled above as variable declarations

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return exports;
}

/** Group exports by visibility for a module. */
function groupByVisibility(exports: ParsedExport[]) {
  return {
    public: exports.filter((e) => e.visibility === "public"),
    internal: exports.filter((e) => e.visibility === "internal"),
  };
}

/** Generate a FunctionReference type string (using `any` for args/returns to avoid deep instantiation). */
function funcRef(kind: FunctionKind, visibility: FunctionVisibility): string {
  return `FunctionReference<"${kind}", "${visibility}", any, any>`;
}

/** Generate the type block for one namespace (module). */
function generateModuleType(exports: ParsedExport[]): string {
  if (exports.length === 0) return "Record<string, never>";
  const lines = exports.map(
    (e) => `    ${e.name}: ${funcRef(e.kind, e.visibility)};`,
  );
  return `{\n${lines.join("\n")}\n  }`;
}

function main() {
  // 1. Read the generated api.d.ts
  if (!existsSync(API_DTS_PATH)) {
    console.error(`[postcodegen] ${API_DTS_PATH} not found — run 'bunx convex codegen' first`);
    process.exit(1);
  }

  const generatedContent = readFileSync(API_DTS_PATH, "utf-8");
  const { modules, componentsBlock } = parseGeneratedApi(generatedContent);

  if (modules.length === 0) {
    console.log("[postcodegen] No modules found in api.d.ts — skipping");
    return;
  }

  // 2. Parse each module's exports
  const moduleExports = new Map<string, ParsedExport[]>();
  for (const mod of modules) {
    const filePath = join(CONVEX_DIR, `${mod.file}.ts`);
    const exports = parseModuleExports(filePath);
    moduleExports.set(mod.name, exports);
  }

  // 3. Build public and internal API types
  const publicModules: string[] = [];
  const internalModules: string[] = [];

  for (const mod of modules) {
    const exports = moduleExports.get(mod.name) ?? [];
    const grouped = groupByVisibility(exports);

    if (grouped.public.length > 0) {
      publicModules.push(`  ${mod.name}: ${generateModuleType(grouped.public)};`);
    }
    if (grouped.internal.length > 0) {
      internalModules.push(`  ${mod.name}: ${generateModuleType(grouped.internal)};`);
    }
  }

  // 4. Generate the new api.d.ts
  const output = `/* eslint-disable */
/**
 * Generated \`api\` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run \`npx convex dev\`.
 *
 * NOTE: This file has been post-processed by scripts/postcodegen.ts
 * to replace recursive ApiFromModules/FilterApi types with explicit
 * declarations, avoiding TS2589 depth errors.
 *
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * \`\`\`js
 * const myFunctionReference = api.myModule.myFunction;
 * \`\`\`
 */
export declare const api: {
${publicModules.join("\n")}
};

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * \`\`\`js
 * const myFunctionReference = internal.myModule.myFunction;
 * \`\`\`
 */
export declare const internal: {
${internalModules.join("\n")}
};

${componentsBlock}
`;

  writeFileSync(API_DTS_PATH, output);

  const totalPublic = modules.reduce(
    (sum, m) => sum + (moduleExports.get(m.name) ?? []).filter((e) => e.visibility === "public").length,
    0,
  );
  const totalInternal = modules.reduce(
    (sum, m) => sum + (moduleExports.get(m.name) ?? []).filter((e) => e.visibility === "internal").length,
    0,
  );

  console.log(
    `[postcodegen] Rewrote api.d.ts: ${modules.length} modules, ${totalPublic} public + ${totalInternal} internal function refs`,
  );
}

main();
