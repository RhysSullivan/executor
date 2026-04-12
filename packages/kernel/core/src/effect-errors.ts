import * as Cause from "effect/Cause";
import * as Data from "effect/Data";

export class KernelCoreEffectError extends Data.TaggedError("KernelCoreEffectError")<{
  readonly module: string;
  readonly message: string;
}> {}

export const kernelCoreEffectError = (module: string, message: string) =>
  new KernelCoreEffectError({ module, message });

/**
 * Extract a human-readable message from an unknown error value.
 * Handles Error instances, strings, objects with `.message`, and
 * arbitrary values via JSON.stringify / String fallback.
 */
export const formatUnknownMessage = (cause: unknown): string => {
  if (cause instanceof Error) {
    const message = cause.message.trim();
    return message.length > 0 ? message : cause.name;
  }

  if (typeof cause === "string") {
    return cause;
  }

  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    const message = cause.message.trim();
    if (message.length > 0) return message;
  }

  if (typeof cause === "object" && cause !== null) {
    try {
      return JSON.stringify(cause);
    } catch {
      return String(cause);
    }
  }

  return String(cause);
};

/**
 * Squash an Effect `Cause` and extract a readable message.
 */
export const formatCauseMessage = (cause: Cause.Cause<unknown>): string =>
  formatUnknownMessage(Cause.squash(cause));
