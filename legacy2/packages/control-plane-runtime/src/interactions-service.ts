import {
  PersistentToolInteractionPolicyStoreError,
  createPersistentToolInteractionPolicy,
  type PersistentToolInteractionRecord,
  type PersistentToolInteractionStore,
  type ToolInteractionRequest,
  type ToolInteractionPolicy,
} from "@executor-v2/engine";
import { type SourceStore } from "@executor-v2/persistence-ports";
import { type SqlControlPlanePersistence } from "@executor-v2/persistence-sql";
import {
  type ControlPlaneCredentialsServiceShape,
  makeControlPlaneInteractionsService,
  type ControlPlaneInteractionsServiceShape,
} from "@executor-v2/management-api";
import {
  type InteractionAction,
  type InteractionMode,
  type Interaction,
  type InteractionStatus,
  type Source,
  type SourceCredentialBinding,
} from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { createSqlSourceStoreErrorMapper } from "./control-plane-row-helpers";

type InteractionRows = Pick<SqlControlPlanePersistence["rows"], "interactions">;

const sourceStoreError = createSqlSourceStoreErrorMapper("interactions");

const toPersistentInteractionStoreError = (
  operation: string,
  message: string,
  details: string | null,
): PersistentToolInteractionPolicyStoreError =>
  new PersistentToolInteractionPolicyStoreError({
    operation,
    message,
    details,
  });

const toPersistentInteractionStoreErrorFromRowStore = (
  operation: string,
  error: { message: string; details: string | null; reason: string | null },
): PersistentToolInteractionPolicyStoreError =>
  toPersistentInteractionStoreError(operation, error.message, error.details ?? error.reason ?? null);

const toPersistentInteractionRecord = (interaction: Interaction): PersistentToolInteractionRecord => ({
  interactionId: interaction.id,
  workspaceId: interaction.workspaceId,
  runId: interaction.taskRunId,
  callId: interaction.callId,
  toolPath: interaction.toolPath,
  status: interaction.status === "accepted"
    ? "accepted"
    : (interaction.status as PersistentToolInteractionRecord["status"]),
  reason: interaction.reason,
});

const parseJsonRecord = (raw: string | null): Record<string, unknown> | null => {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const interactionModeFromRequest = (
  interactionMode: ToolInteractionRequest["interactionMode"],
  request: Record<string, unknown> | null,
): InteractionMode => {
  if (interactionMode === "form" || interactionMode === "url") {
    return interactionMode;
  }

  const rawMode = readString(request?.mode);
  if (rawMode === "form" || rawMode === "url") {
    return rawMode;
  }

  return "form";
};

const interactionMessageFromRequest = (
  request: Record<string, unknown> | null,
  fallback: string,
): string => {
  const direct = readString(request?.message);
  if (direct) {
    return direct;
  }

  return fallback;
};

const interactionUrlFromRequest = (
  request: Record<string, unknown> | null,
): string | null => {
  const explicit = readString(request?.url);
  if (explicit) {
    return explicit;
  }

  const endpoint = readString(request?.endpoint);
  if (endpoint) {
    return endpoint;
  }

  return null;
};

const statusFromAction = (action: InteractionAction): InteractionStatus => {
  if (action === "accept") {
    return "accepted";
  }

  if (action === "decline") {
    return "declined";
  }

  return "cancelled";
};

export type RuntimeHostPersistentToolInteractionPolicyOptions = {
  requireInteractions?: boolean;
  retryAfterMs?: number;
};

export const createRuntimeHostPersistentToolInteractionPolicy = (
  rows: InteractionRows,
  options: RuntimeHostPersistentToolInteractionPolicyOptions = {},
): ToolInteractionPolicy => {
  const store: PersistentToolInteractionStore = {
    findByRunAndCall: (input) =>
      rows.interactions
        .findByRunAndCall(
          input.workspaceId as Interaction["workspaceId"],
          input.runId as Interaction["taskRunId"],
          input.callId,
        )
          .pipe(
          Effect.mapError((error) =>
            toPersistentInteractionStoreErrorFromRowStore("interactions.read", error),
          ),
          Effect.flatMap((interactionOption) => {
            const interaction = Option.getOrNull(interactionOption);
            return Effect.succeed(
              interaction !== null ? toPersistentInteractionRecord(interaction) : null,
            );
          }),
        ),

    createPending: (input) =>
      Effect.gen(function* () {
        const now = Date.now();
        const requestPayload = parseJsonRecord(input.interactionRequestJson ?? null);
        const mode = interactionModeFromRequest(input.interactionMode, requestPayload);
        const pendingInteraction: Interaction = {
          id: `int_${crypto.randomUUID()}` as Interaction["id"],
          workspaceId: input.workspaceId as Interaction["workspaceId"],
          taskRunId: input.runId as Interaction["taskRunId"],
          originServer: "runtime-mcp",
          originRequestId: `${input.runId}:${input.callId}`,
          callId: input.callId,
          toolPath: input.toolPath,
          mode,
          elicitationId: mode === "url" ? `eli_${crypto.randomUUID()}` : null,
          message: interactionMessageFromRequest(
            requestPayload,
            input.interactionMessage ?? `Interaction required for ${input.toolPath}`,
          ),
          requestedSchemaJson: mode === "form"
            ? (typeof input.interactionRequestedSchemaJson === "string"
              ? input.interactionRequestedSchemaJson
              : (typeof requestPayload?.requestedSchemaJson === "string"
                ? requestPayload.requestedSchemaJson
                : null))
            : null,
          url: mode === "url"
            ? (typeof input.interactionUrl === "string" && input.interactionUrl.trim().length > 0
              ? input.interactionUrl
              : interactionUrlFromRequest(requestPayload))
            : null,
          status: "pending",
          requestJson: input.interactionRequestJson ?? input.inputPreviewJson,
          responseAction: null,
          responseContentJson: null,
          reason: null,
          requestedAt: now,
          resolvedAt: null,
          completionNotifiedAt: null,
          expiresAt: null,
        };

        yield* rows.interactions.upsert(pendingInteraction).pipe(
          Effect.mapError((error) =>
            toPersistentInteractionStoreErrorFromRowStore("interactions.write", error),
          ),
        );

        return toPersistentInteractionRecord(pendingInteraction);
      }),
  };

  return createPersistentToolInteractionPolicy({
    store,
    requireInteractions: options.requireInteractions,
    retryAfterMs: options.retryAfterMs,
  });
};

const maybeUpdateSourceAfterResolution = (
  sourceStore: SourceStore,
  credentialsService: ControlPlaneCredentialsServiceShape,
  interaction: Interaction,
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    if (interaction.status !== "accepted" || interaction.responseAction !== "accept") {
      return;
    }

    const requestPayload = parseJsonRecord(interaction.requestJson);
    const resultPayload = parseJsonRecord(interaction.responseContentJson);

    const purpose = readString(requestPayload?.purpose);
    if (purpose !== "source_connect_oauth2" && purpose !== "source_connect_secret") {
      return;
    }

    const sourceIdRaw = requestPayload?.sourceId;
    if (typeof sourceIdRaw !== "string" || sourceIdRaw.trim().length === 0) {
      return;
    }

    const sourceId = sourceIdRaw as Source["id"];
    const sourceKey = `source:${sourceId}`;
    let shouldConnectSource = false;

    const existingBinding = yield* credentialsService
      .listCredentialBindings(interaction.workspaceId)
      .pipe(
        Effect.map((items) =>
          items.find((item) => item.sourceKey === sourceKey)
          ?? null,
        ),
        Effect.orElseSucceed(() => null),
      );

    if (purpose === "source_connect_oauth2") {
      const accessToken = readString(resultPayload?.accessToken ?? resultPayload?.secret);
      if (!accessToken) {
        return;
      }

      const refreshToken = readString(resultPayload?.refreshToken) ?? null;
      const scope = readString(resultPayload?.scope) ?? null;
      const clientId = readString(resultPayload?.clientId) ?? null;
      const sourceUrl = readString(resultPayload?.sourceUrl ?? requestPayload?.endpoint) ?? null;
      const clientInformationJson = readString(resultPayload?.clientInformationJson) ?? null;
      const expiresIn = typeof resultPayload?.expiresIn === "number"
        ? Math.max(0, Math.floor(resultPayload.expiresIn))
        : null;
      const oauthExpiresAt = expiresIn !== null ? Date.now() + expiresIn * 1000 : null;

      yield* credentialsService.upsertCredentialBinding({
        workspaceId: interaction.workspaceId,
        payload: {
          ...(existingBinding ? { id: existingBinding.id } : {}),
          credentialId: existingBinding?.credentialId
            ?? (`conn_${crypto.randomUUID()}` as unknown as SourceCredentialBinding["credentialId"]),
          scopeType: "workspace",
          sourceKey,
          provider: "oauth2",
          secret: accessToken,
          oauthRefreshToken: refreshToken,
          oauthExpiresAt,
          oauthScope: scope,
          oauthClientId: clientId,
          oauthSourceUrl: sourceUrl,
          oauthClientInformationJson: clientInformationJson,
        },
      }).pipe(Effect.orElseSucceed(() => existingBinding ?? null));

      shouldConnectSource = true;
    }

    if (purpose === "source_connect_secret") {
      const secret = readString(resultPayload?.secret ?? resultPayload?.apiKey ?? resultPayload?.token);
      if (!secret) {
        return;
      }

      const providerRaw = readString(resultPayload?.provider);
      const provider = providerRaw === "bearer" || providerRaw === "basic" || providerRaw === "custom"
        ? providerRaw
        : "api_key";

      yield* credentialsService.upsertCredentialBinding({
        workspaceId: interaction.workspaceId,
        payload: {
          ...(existingBinding ? { id: existingBinding.id } : {}),
          credentialId: existingBinding?.credentialId
            ?? (`conn_${crypto.randomUUID()}` as unknown as SourceCredentialBinding["credentialId"]),
          scopeType: "workspace",
          sourceKey,
          provider,
          secret,
        },
      }).pipe(Effect.orElseSucceed(() => existingBinding ?? null));

      shouldConnectSource = true;
    }

    if (!shouldConnectSource) {
      return;
    }

    const sourceOption = yield* sourceStore.getById(
      interaction.workspaceId,
      sourceId,
    ).pipe(Effect.orElseSucceed(() => Option.none<Source>()));
    const source = Option.getOrNull(sourceOption);
    if (!source) {
      return;
    }

    const updated: Source = {
      ...source,
      status: "connected",
      lastError: null,
      updatedAt: Date.now(),
    };

    yield* sourceStore.upsert(updated).pipe(Effect.ignore);
  }).pipe(Effect.ignore);

export const createRuntimeHostInteractionsService = (
  rows: InteractionRows,
  sourceStore: SourceStore,
  credentialsService: ControlPlaneCredentialsServiceShape,
): ControlPlaneInteractionsServiceShape =>
  makeControlPlaneInteractionsService({
    listInteractions: (workspaceId) =>
      Effect.gen(function* () {
        const interactions = yield* rows.interactions.listByWorkspaceId(workspaceId).pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("interactions.list", error),
          ),
        );

        return interactions;
      }),

    listRunInteractions: (input) =>
      Effect.gen(function* () {
        const interactions = yield* rows.interactions
          .listByRunId(input.workspaceId, input.runId)
          .pipe(
            Effect.mapError((error) =>
              sourceStoreError.fromRowStore("interactions.list_run", error),
            ),
          );

        return interactions;
      }),

    getInteraction: (input) =>
      Effect.gen(function* () {
        const interactionOption = yield* rows.interactions.getById(input.interactionId).pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("interactions.get_by_id", error),
          ),
        );

        const interaction = Option.getOrNull(interactionOption);
        if (interaction === null || interaction.workspaceId !== input.workspaceId) {
          return yield* sourceStoreError.fromMessage(
            "interactions.get",
            "Interaction not found",
            `workspace=${input.workspaceId} interaction=${input.interactionId}`,
          );
        }

        return interaction;
      }),

    resolveInteraction: (input) =>
      Effect.gen(function* () {
        const interactionOption = yield* rows.interactions.getById(input.interactionId).pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("interactions.get_by_id", error),
          ),
        );

        const interaction = Option.getOrNull(interactionOption);
        if (interaction === null || interaction.workspaceId !== input.workspaceId) {
          return yield* sourceStoreError.fromMessage(
            "interactions.resolve",
            "Interaction not found",
            `workspace=${input.workspaceId} interaction=${input.interactionId}`,
          );
        }

        if (interaction.status !== "pending") {
          return yield* sourceStoreError.fromMessage(
            "interactions.resolve",
            "Interaction is not pending",
            `interaction=${input.interactionId} status=${interaction.status}`,
          );
        }

        const resolved: Interaction = {
          ...interaction,
          status: statusFromAction(input.payload.action),
          responseAction: input.payload.action,
          reason: input.payload.reason ?? interaction.reason ?? null,
          responseContentJson: input.payload.contentJson ?? interaction.responseContentJson ?? null,
          resolvedAt: Date.now(),
        };

        yield* rows.interactions.upsert(resolved).pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("interactions.resolve_write", error),
          ),
        );

        yield* maybeUpdateSourceAfterResolution(sourceStore, credentialsService, resolved);

        return resolved;
      }),
  });
