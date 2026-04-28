import * as Data from "effect/Data";

export class KernelCoreEffectError extends Data.TaggedError("KernelCoreEffectError")<{
  readonly module: string;
  readonly message: string;
}> {}

export const kernelCoreEffectError = (module: string, message: string) =>
  new KernelCoreEffectError({ module, message });

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
