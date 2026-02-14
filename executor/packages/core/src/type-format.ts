"use node";

import { Result } from "better-result";

const MAX_CACHE_ENTRIES = 4000;

let cachedTypeScriptModule: typeof import("typescript") | null | undefined;
const formattedTypeCache = new Map<string, string>();

function getTypeScriptModule(): typeof import("typescript") | null {
  if (cachedTypeScriptModule !== undefined) {
    return cachedTypeScriptModule;
  }

  const loaded = Result.try(() => require("typescript") as typeof import("typescript"));
  cachedTypeScriptModule = loaded.isOk() ? loaded.value : null;
  return cachedTypeScriptModule;
}

function setCachedFormattedType(key: string, value: string): void {
  if (formattedTypeCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = formattedTypeCache.keys().next().value;
    if (oldest) {
      formattedTypeCache.delete(oldest);
    }
  }

  formattedTypeCache.set(key, value);
}

function formatTypeExpressionWithTs(typeExpression: string): string | null {
  const ts = getTypeScriptModule();
  if (!ts) {
    return null;
  }

  const sourceText = `type __ToolType = ${typeExpression};`;

  const parsed = Result.try(() => ts.createSourceFile(
    "tool-type.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  ));
  if (parsed.isErr()) {
    return null;
  }

  const sourceFile = parsed.value;
  const aliasNode = sourceFile.statements.find((statement) => ts.isTypeAliasDeclaration(statement));
  if (!aliasNode || !ts.isTypeAliasDeclaration(aliasNode)) {
    return null;
  }

  const printed = Result.try(() => {
    const printer = ts.createPrinter({
      newLine: ts.NewLineKind.LineFeed,
      removeComments: false,
    });
    return printer.printNode(ts.EmitHint.Unspecified, aliasNode.type, sourceFile).trim();
  });

  if (printed.isErr()) {
    return null;
  }

  return printed.value;
}

/**
 * Formats a TypeScript type expression to a stable, readable form.
 * Falls back to the original value if TypeScript is unavailable or parsing fails.
 */
export function formatTypeExpressionForClient(rawTypeExpression?: string): string | undefined {
  if (rawTypeExpression === undefined) {
    return undefined;
  }

  const trimmed = rawTypeExpression.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }

  const cached = formattedTypeCache.get(trimmed);
  if (cached) {
    return cached;
  }

  const formatted = formatTypeExpressionWithTs(trimmed) ?? trimmed;
  setCachedFormattedType(trimmed, formatted);
  return formatted;
}
