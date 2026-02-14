"use node";

import { Result, TaggedError } from "better-result";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class TranspileError extends TaggedError("TranspileError")<{
  message: string;
}>() {}

// ---------------------------------------------------------------------------
// TypeScript module loader
// ---------------------------------------------------------------------------

function getTypeScriptModule(): typeof import("typescript") | null {
  const loaded = Result.try(() => require("typescript") as typeof import("typescript"));
  return loaded.isOk() ? loaded.value : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Transpile TypeScript code to JavaScript using the `typescript` module.
 *
 * Returns a Result — either the transpiled JS string or a TranspileError.
 * If the TypeScript module is not available, the code is returned as-is
 * (graceful fallback for environments where TS isn't installed).
 *
 * Targets ES2022/ESNext so the output can run in modern runtimes (node:vm,
 * Cloudflare Workers isolates, etc.) without further downlevelling.
 */
export function transpileForRuntime(
  code: string,
): Result<string, TranspileError> {
  const ts = getTypeScriptModule();
  if (!ts) return Result.ok(code);

  const target = ts.ScriptTarget?.ES2022 ?? ts.ScriptTarget?.ESNext;
  const moduleKind = ts.ModuleKind?.ESNext;

  return Result.try({
    try: () => {
      const result = ts.transpileModule(code, {
        compilerOptions: {
          ...(target !== undefined ? { target } : {}),
          ...(moduleKind !== undefined ? { module: moduleKind } : {}),
        },
        reportDiagnostics: true,
      });

      if (result.diagnostics && result.diagnostics.length > 0) {
        const first = result.diagnostics[0];
        const message = ts.flattenDiagnosticMessageText(
          first.messageText,
          "\n",
        );
        throw new TranspileError({ message: `TypeScript transpile error: ${message}` });
      }

      return result.outputText || code;
    },
    catch: (e) =>
      e instanceof TranspileError
        ? e
        : new TranspileError({
            message: e instanceof Error ? e.message : String(e),
          }),
  });
}
