import type { StandardSchemaV1 } from "@standard-schema/spec";
import * as Effect from "effect/Effect";

import { KernelCoreEffectError } from "./effect-errors";

const getSchemaValidator = (
  schema: unknown,
):
  | ((
      value: unknown,
    ) => StandardSchemaV1.Result<unknown> | Promise<StandardSchemaV1.Result<unknown>>)
  | null => {
  if (!schema || (typeof schema !== "object" && typeof schema !== "function")) {
    return null;
  }

  const standard = (schema as { "~standard"?: unknown })["~standard"];
  if (!standard || typeof standard !== "object") {
    return null;
  }

  const validate = (standard as { validate?: unknown }).validate;
  return typeof validate === "function"
    ? (validate as (
        value: unknown,
      ) => StandardSchemaV1.Result<unknown> | Promise<StandardSchemaV1.Result<unknown>>)
    : null;
};

const formatIssuePath = (
  path: ReadonlyArray<PropertyKey | StandardSchemaV1.PathSegment> | undefined,
): string => {
  if (!path || path.length === 0) {
    return "$";
  }

  return path
    .map((segment) =>
      typeof segment === "object" && segment !== null && "key" in segment
        ? String(segment.key)
        : String(segment),
    )
    .join(".");
};

const formatIssues = (issues: ReadonlyArray<StandardSchemaV1.Issue>): string =>
  issues.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`).join("; ");

/** Validate a value against a Standard Schema */
export const validateInput = (input: {
  schema: unknown;
  value: unknown;
  path: string;
}): Effect.Effect<unknown, Error> => {
  const validate = getSchemaValidator(input.schema);
  if (!validate) {
    return Effect.fail(
      new KernelCoreEffectError({
        module: "validation",
        message: `Tool ${input.path} has no Standard Schema validator on inputSchema`,
      }),
    );
  }

  return Effect.tryPromise({
    try: () => Promise.resolve(validate(input.value)),
    catch: (cause) =>
      new KernelCoreEffectError({
        module: "validation",
        message: `Validation error for ${input.path}`,
        cause,
      }),
  }).pipe(
    Effect.flatMap((result) => {
      if ("issues" in result && result.issues) {
        return Effect.fail(
          new KernelCoreEffectError({
            module: "validation",
            message: `Input validation failed for ${input.path}: ${formatIssues(result.issues)}`,
          }),
        );
      }
      return Effect.succeed(result.value);
    }),
  );
};
