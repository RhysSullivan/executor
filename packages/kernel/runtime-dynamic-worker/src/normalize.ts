/**
 * Code normalization for dynamic worker execution.
 *
 * Strips markdown fences and ensures the code is a callable async arrow
 * function suitable for embedding inside the WorkerEntrypoint template.
 */

const FENCED_CODE =
  /^```(?:js|javascript|typescript|ts|tsx|jsx)?\s*\n([\s\S]*?)```\s*$/;

const stripCodeFences = (code: string): string => {
  const match = code.match(FENCED_CODE);
  return match ? match[1]! : code;
};

/**
 * Detect whether `source` is already an async arrow function expression.
 *
 * We look for a leading `async` followed by `=>` (with optional parenthesised
 * params in between).  This is intentionally a simple heuristic — the code
 * will be executed inside `(normalised)()` so the only hard requirement is
 * that it evaluates to a callable.
 */
const looksLikeArrowFunction = (source: string): boolean =>
  (source.startsWith("async") || source.startsWith("(")) &&
  source.includes("=>");

/**
 * Detect a single named function declaration (sync or async).
 */
const looksLikeFunctionDeclaration = (source: string): boolean =>
  /^(async\s+)?function\s+[a-zA-Z_$]/.test(source);

/**
 * Normalize user code into an async arrow function body.
 *
 * The returned string is always suitable for `(NORMALIZED)()` invocation.
 */
export const normalizeCode = (code: string): string => {
  const trimmed = stripCodeFences(code.trim());
  if (!trimmed) return "async () => {}";

  const source = trimmed.trim();

  // Already an arrow function — pass through.
  if (looksLikeArrowFunction(source)) return source;

  // Single named function declaration — wrap and call.
  if (looksLikeFunctionDeclaration(source)) {
    const nameMatch = source.match(
      /^(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/,
    );
    const name = nameMatch?.[1] ?? "fn";
    return `async () => {\n${source}\nreturn ${name}();\n}`;
  }

  // Treat everything else as statement(s) — wrap in an async arrow.
  // If the last non-whitespace token looks like an expression, we could
  // try to splice a `return` but it's safer to just wrap.
  return `async () => {\n${source}\n}`;
};
