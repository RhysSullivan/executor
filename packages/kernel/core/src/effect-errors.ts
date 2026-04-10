import * as Data from "effect/Data";

export class KernelCoreEffectError extends Data.TaggedError("KernelCoreEffectError")<{
  readonly module: string;
  readonly message: string;
}> {}

export const kernelCoreEffectError = (module: string, message: string) =>
  new KernelCoreEffectError({ module, message });
