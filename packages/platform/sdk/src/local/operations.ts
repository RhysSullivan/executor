import type {
  Execution,
  ExecutionInteraction,
  Source,
  WorkspaceId,
} from "../schema";
import {
  SourceIdSchema,
  WorkspaceIdSchema,
} from "../schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { submitExecutionInteractionResponse } from "../runtime/execution/service";
import { LiveExecutionManagerService } from "../runtime/execution/live";
import { operationErrors } from "../runtime/policy/operation-errors";
import { InstallationStore } from "../runtime/workspace/storage";
import { RuntimeSourceAuthServiceTag } from "../runtime/sources/source-auth-service";
import {
  createSourceCredentialSelectionBearerContent,
  createSourceCredentialSelectionNoneContent,
} from "../runtime/sources/source-credential-interactions";
import { ExecutorStateStore } from "../runtime/executor-state-store";

const localOps = {
  installation: operationErrors("local.installation.get"),
  sourceCredentialComplete: operationErrors("sources.credentials.complete"),
  sourceCredentialPage: operationErrors("sources.credentials.page"),
  sourceCredentialSubmit: operationErrors("sources.credentials.submit"),
} as const;

type SourceCredentialInteraction = {
  interactionId: ExecutionInteraction["id"];
  executionId: Execution["id"];
  status: ExecutionInteraction["status"];
  message: string;
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
  sourceLabel: string;
  endpoint: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const trimOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const decodeSourceCredentialInteraction = (
  interaction: ExecutionInteraction,
): Omit<SourceCredentialInteraction, "sourceLabel" | "endpoint"> | null => {
  try {
    if (
      interaction.purpose !== "source_connect_oauth2" &&
      interaction.purpose !== "source_connect_secret" &&
      interaction.purpose !== "elicitation"
    ) {
      return null;
    }

    const payload = JSON.parse(interaction.payloadJson) as unknown;
    if (!isRecord(payload)) {
      return null;
    }

    const args = payload.args;
    const elicitation = payload.elicitation;
    if (!isRecord(args) || !isRecord(elicitation)) {
      return null;
    }

    if (payload.path !== "executor.sources.add") {
      return null;
    }
    const effectivePurpose =
      interaction.purpose === "elicitation"
        ? elicitation.mode === "url"
          ? "source_connect_oauth2"
          : "source_connect_secret"
        : interaction.purpose;
    if (
      effectivePurpose === "source_connect_oauth2" &&
      elicitation.mode !== "url"
    ) {
      return null;
    }
    if (
      effectivePurpose === "source_connect_secret" &&
      elicitation.mode !== "form"
    ) {
      return null;
    }

    const workspaceId = trimOrNull(asString(args.workspaceId));
    const sourceId = trimOrNull(asString(args.sourceId));
    const message = trimOrNull(asString(elicitation.message));
    if (workspaceId === null || sourceId === null || message === null) {
      return null;
    }

    return {
      interactionId: interaction.id,
      executionId: interaction.executionId,
      status: interaction.status,
      message,
      workspaceId: WorkspaceIdSchema.make(workspaceId),
      sourceId: SourceIdSchema.make(sourceId),
    };
  } catch {
    return null;
  }
};

const loadSourceCredentialInteraction = (input: {
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
  interactionId: ExecutionInteraction["id"];
  operation:
    | typeof localOps.sourceCredentialPage
    | typeof localOps.sourceCredentialSubmit;
}) =>
  Effect.gen(function* () {
    const store = yield* ExecutorStateStore;
    const sourceAuthService = yield* RuntimeSourceAuthServiceTag;

    const stored = yield* store.executionInteractions
      .getById(input.interactionId)
      .pipe(
        Effect.mapError((error) =>
          input.operation.unknownStorage(
            error,
            `Failed loading execution interaction ${input.interactionId}`,
          ),
        ),
      );

    if (Option.isNone(stored)) {
      return yield* input.operation.notFound(
        "Source credential request not found",
        `interactionId=${input.interactionId}`,
      );
    }

    const decoded = decodeSourceCredentialInteraction(stored.value);
    if (
      decoded === null ||
      decoded.workspaceId !== input.workspaceId ||
      decoded.sourceId !== input.sourceId
    ) {
      return yield* input.operation.notFound(
        "Source credential request not found",
        `workspaceId=${input.workspaceId} sourceId=${input.sourceId} interactionId=${input.interactionId}`,
      );
    }

    const source = yield* sourceAuthService
      .getSourceById({
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
      })
      .pipe(
        Effect.mapError((error) =>
          input.operation.unknownStorage(
            error,
            `Failed loading source ${input.sourceId}`,
          ),
        ),
      );

    return {
      ...decoded,
      sourceLabel: source.name,
      endpoint: source.endpoint,
    } satisfies SourceCredentialInteraction;
  });

export const getLocalInstallation = () =>
  Effect.gen(function* () {
    const installationStore = yield* InstallationStore;
    return yield* installationStore.load().pipe(
      Effect.mapError((error) =>
        localOps.installation.unknownStorage(
          error,
          "Failed loading local installation",
        ),
      ),
    );
  });

export const getSourceCredentialInteraction = (input: {
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
  interactionId: ExecutionInteraction["id"];
}) =>
  loadSourceCredentialInteraction({
    ...input,
    operation: localOps.sourceCredentialPage,
  });

export const submitSourceCredentialInteraction = (input: {
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
  interactionId: ExecutionInteraction["id"];
  action: "submit" | "continue" | "cancel";
  token?: string | null;
}) =>
  Effect.gen(function* () {
    const interaction = yield* loadSourceCredentialInteraction({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
      interactionId: input.interactionId,
      operation: localOps.sourceCredentialSubmit,
    });

    if (interaction.status !== "pending") {
      return yield* localOps.sourceCredentialSubmit.badRequest(
        "Source credential request is no longer active",
        `interactionId=${interaction.interactionId} status=${interaction.status}`,
      );
    }

    const liveExecutionManager = yield* LiveExecutionManagerService;

    if (input.action === "cancel") {
      const resumed = yield* liveExecutionManager.resolveInteraction({
        executionId: interaction.executionId,
        response: {
          action: "cancel",
        },
      });

      if (!resumed) {
        const persisted = yield* submitExecutionInteractionResponse({
          executionId: interaction.executionId,
          response: {
            action: "cancel",
          },
        }).pipe(
          Effect.mapError((error) =>
            localOps.sourceCredentialSubmit.unknownStorage(
              error,
              `Failed resuming execution for interaction ${interaction.interactionId}`,
            ),
          ),
        );

        if (!persisted) {
          return yield* localOps.sourceCredentialSubmit.badRequest(
            "Source credential request is no longer resumable",
            `interactionId=${interaction.interactionId}`,
          );
        }
      }

      return {
        kind: "cancelled" as const,
        sourceLabel: interaction.sourceLabel,
        endpoint: interaction.endpoint,
      };
    }

    if (input.action === "continue") {
      const resumed = yield* liveExecutionManager.resolveInteraction({
        executionId: interaction.executionId,
        response: {
          action: "accept",
          content: createSourceCredentialSelectionNoneContent(),
        },
      });

      if (!resumed) {
        const persisted = yield* submitExecutionInteractionResponse({
          executionId: interaction.executionId,
          response: {
            action: "accept",
            content: createSourceCredentialSelectionNoneContent(),
          },
        }).pipe(
          Effect.mapError((error) =>
            localOps.sourceCredentialSubmit.unknownStorage(
              error,
              `Failed resuming execution for interaction ${interaction.interactionId}`,
            ),
          ),
        );

        if (!persisted) {
          return yield* localOps.sourceCredentialSubmit.badRequest(
            "Source credential request is no longer resumable",
            `interactionId=${interaction.interactionId}`,
          );
        }
      }

      return {
        kind: "continued" as const,
        sourceLabel: interaction.sourceLabel,
        endpoint: interaction.endpoint,
      };
    }

    const token = trimOrNull(input.token);
    if (token === null) {
      return yield* localOps.sourceCredentialSubmit.badRequest(
        "Missing token",
        `interactionId=${interaction.interactionId}`,
      );
    }

    const sourceAuthService = yield* RuntimeSourceAuthServiceTag;
    const tokenRef = yield* sourceAuthService
      .storeSecretMaterial({
        purpose: "auth_material",
        value: token,
      })
      .pipe(
        Effect.mapError((error) =>
          localOps.sourceCredentialSubmit.unknownStorage(
            error,
            `Failed storing credential material for interaction ${interaction.interactionId}`,
          ),
        ),
      );
    const resumed = yield* liveExecutionManager.resolveInteraction({
      executionId: interaction.executionId,
      response: {
        action: "accept",
        content: createSourceCredentialSelectionBearerContent(tokenRef),
      },
    });

    if (!resumed) {
      const persisted = yield* submitExecutionInteractionResponse({
        executionId: interaction.executionId,
        response: {
          action: "accept",
          content: createSourceCredentialSelectionBearerContent(tokenRef),
        },
      }).pipe(
        Effect.mapError((error) =>
          localOps.sourceCredentialSubmit.unknownStorage(
            error,
            `Failed resuming execution for interaction ${interaction.interactionId}`,
          ),
        ),
      );

      if (!persisted) {
        return yield* localOps.sourceCredentialSubmit.badRequest(
          "Source credential request is no longer resumable",
          `interactionId=${interaction.interactionId}`,
        );
      }
    }

    return {
      kind: "stored" as const,
      sourceLabel: interaction.sourceLabel,
      endpoint: interaction.endpoint,
    };
  });

export const completeSourceCredentialSetup = (input: {
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
  state: string;
  code?: string | null;
  error?: string | null;
  errorDescription?: string | null;
}) =>
  Effect.gen(function* () {
    const sourceAuthService = yield* RuntimeSourceAuthServiceTag;

    return yield* sourceAuthService
      .completeSourceCredentialSetup(input)
      .pipe(
        Effect.mapError((error) =>
          localOps.sourceCredentialComplete.unknownStorage(
            error,
            "Failed completing source credential setup",
          ),
        ),
      );
  });
