import * as Data from "effect/Data";

export class KernelCoreEffectError extends Data.TaggedError("KernelCoreEffectError")<{
  readonly module: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Default failure type for any `CodeExecutor.execute` implementation —
 * surfaces sandbox-level defects (isolate crash, module load failure,
 * worker loader error) as a typed error so callers can handle them
 * structurally instead of untyped `unknown`. Runtimes that want a
 * narrower error shape can define their own `Data.TaggedError` subclass
 * and parameterize `CodeExecutor<MyError>`.
 */
export class CodeExecutionError extends Data.TaggedError("CodeExecutionError")<{
  readonly runtime: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Raised when user code fails to compile before it ever runs: a genuine
 * syntax/parse error (smart quotes from a copy-paste, an unbalanced
 * brace, `const = 5`) caught while stripping TypeScript ahead of the
 * JS-only sandbox. Unlike `CodeExecutionError` this is the user's
 * mistake, not a sandbox defect, so runtimes surface its `message`
 * through the descriptive `ExecuteResult.error` channel instead of
 * collapsing it to an opaque internal-error string. The original parser
 * message (e.g. "Unexpected token (1:54)") is carried verbatim so the
 * model can see and fix it.
 */
export class CodeCompilationError extends Data.TaggedError("CodeCompilationError")<{
  readonly runtime: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}
