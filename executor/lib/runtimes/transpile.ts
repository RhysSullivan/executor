"use node";

/**
 * Transpile TypeScript code to JavaScript using the `typescript` module.
 *
 * If the `typescript` module is not available, the code is returned as-is
 * (graceful fallback for environments where TS isn't installed).
 *
 * Targets ES2022/ESNext so the output can run in modern runtimes (node:vm,
 * Cloudflare Workers isolates, etc.) without further downlevelling.
 */
export async function transpileForRuntime(code: string): Promise<string> {
  let ts: typeof import("typescript");
  try {
    ts = require("typescript");
  } catch {
    return code;
  }

  const target = ts.ScriptTarget?.ES2022 ?? ts.ScriptTarget?.ESNext;
  const moduleKind = ts.ModuleKind?.ESNext;

  const result = ts.transpileModule(code, {
    compilerOptions: {
      ...(target !== undefined ? { target } : {}),
      ...(moduleKind !== undefined ? { module: moduleKind } : {}),
    },
    reportDiagnostics: true,
  });

  if (result.diagnostics && result.diagnostics.length > 0) {
    const first = result.diagnostics[0];
    const message = ts.flattenDiagnosticMessageText(first.messageText, "\n");
    throw new Error(`TypeScript transpile error: ${message}`);
  }

  return result.outputText || code;
}
