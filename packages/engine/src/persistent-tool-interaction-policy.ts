import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type {
  ToolInteractionDecision,
  ToolInteractionPolicy,
  ToolInteractionRequest,
} from "./tool-registry";

export type PersistentToolInteractionStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "cancelled"
  | "expired";

export type PersistentToolInteractionRecord = {
  interactionId: string;
  workspaceId: string;
  runId: string;
  callId: string;
  toolPath: string;
  status: PersistentToolInteractionStatus;
  reason: string | null;
};

export class PersistentToolInteractionPolicyStoreError extends Data.TaggedError(
  "PersistentToolInteractionPolicyStoreError",
)<{
  operation: string;
  message: string;
  details: string | null;
}> {}

export type PersistentToolInteractionStore = {
  findByRunAndCall: (input: {
    workspaceId: string;
    runId: string;
    callId: string;
  }) => Effect.Effect<
    PersistentToolInteractionRecord | null,
    PersistentToolInteractionPolicyStoreError
  >;
  createPending: (input: {
    workspaceId: string;
    runId: string;
    callId: string;
    toolPath: string;
    inputPreviewJson: string;
    interactionMode: ToolInteractionRequest["interactionMode"];
    interactionMessage: string | undefined;
    interactionRequestedSchemaJson: string | null | undefined;
    interactionUrl: string | null | undefined;
    interactionRequestJson: string | null;
  }) => Effect.Effect<PersistentToolInteractionRecord, PersistentToolInteractionPolicyStoreError>;
};

export type CreatePersistentToolInteractionPolicyOptions = {
  store: PersistentToolInteractionStore;
  requireInteractions?: boolean;
  retryAfterMs?: number;
  serializeInputPreview?: (input: Record<string, unknown> | undefined) => string;
  onStoreError?: (
    error: PersistentToolInteractionPolicyStoreError,
    request: ToolInteractionRequest,
  ) => ToolInteractionDecision;
};

const defaultPendingRetryAfterMs = 1_000;

const normalizePendingRetryAfterMs = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return defaultPendingRetryAfterMs;
  }

  return Math.round(value);
};

const defaultSerializeInputPreview = (input: Record<string, unknown> | undefined): string => {
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return "{}";
  }
};

const deniedMessageFromRecord = (record: PersistentToolInteractionRecord): string =>
  record.reason ?? `Tool call denied: ${record.toolPath}`;

const defaultStoreErrorDecision = (
  error: PersistentToolInteractionPolicyStoreError,
  request: ToolInteractionRequest,
): ToolInteractionDecision => ({
  kind: "denied",
  error:
    error.details && error.details.length > 0
      ? `${error.message}: ${error.details}`
      : `${error.message} [tool=${request.toolPath}]`,
});

export const createPersistentToolInteractionPolicy = (
  options: CreatePersistentToolInteractionPolicyOptions,
): ToolInteractionPolicy => {
  const requireInteractions = options.requireInteractions === true;
  const retryAfterMs = normalizePendingRetryAfterMs(options.retryAfterMs);
  const serializeInputPreview = options.serializeInputPreview ?? defaultSerializeInputPreview;
  const onStoreError = options.onStoreError ?? defaultStoreErrorDecision;

  return {
    evaluate: (input) =>
      Effect.gen(function* () {
        const shouldRequireInteraction = requireInteractions || input.defaultMode === "required";
        if (!shouldRequireInteraction) {
          return {
            kind: "approved",
          } satisfies ToolInteractionDecision;
        }

        if (!input.workspaceId) {
          return {
            kind: "denied",
            error: `Tool interaction requires workspaceId for ${input.toolPath}`,
          } satisfies ToolInteractionDecision;
        }

        const existing = yield* options.store.findByRunAndCall({
          workspaceId: input.workspaceId,
          runId: input.runId,
          callId: input.callId,
        });

        if (existing !== null) {
          if (existing.status === "accepted") {
            return {
              kind: "approved",
            } satisfies ToolInteractionDecision;
          }

          if (existing.status === "pending") {
            return {
              kind: "pending",
              interactionId: existing.interactionId,
              retryAfterMs,
              error: existing.reason ?? undefined,
            } satisfies ToolInteractionDecision;
          }

          return {
            kind: "denied",
            error: deniedMessageFromRecord(existing),
          } satisfies ToolInteractionDecision;
        }

        const pending = yield* options.store.createPending({
          workspaceId: input.workspaceId,
          runId: input.runId,
          callId: input.callId,
          toolPath: input.toolPath,
          inputPreviewJson: serializeInputPreview(input.input),
          interactionMode: input.interactionMode,
          interactionMessage: input.interactionMessage,
          interactionRequestedSchemaJson: input.interactionRequestedSchemaJson,
          interactionUrl: input.interactionUrl,
          interactionRequestJson: input.interactionRequestJson ?? null,
        });

        return {
          kind: "pending",
          interactionId: pending.interactionId,
          retryAfterMs,
        } satisfies ToolInteractionDecision;
      }).pipe(
        Effect.catchTag("PersistentToolInteractionPolicyStoreError", (error) =>
          Effect.succeed(onStoreError(error, input)),
        ),
        Effect.runPromise,
      ),
  };
};
