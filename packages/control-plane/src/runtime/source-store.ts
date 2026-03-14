import type {
  AccountId,
  AuthArtifact,
  CredentialSlot,
  LocalConfigSecretInput,
  LocalConfigSource,
  Source,
  SourceId,
  WorkspaceId,
} from "#schema";
import { SourceIdSchema } from "#schema";
import { type SqlControlPlaneRows } from "#persistence";
import * as Effect from "effect/Effect";

import {
  stableSourceRecipeId,
  stableSourceRecipeRevisionId,
  splitSourceForStorage,
} from "./source-definitions";
import {
  sourceAuthFromAuthArtifact,
} from "./auth-artifacts";
import {
  loadLocalExecutorConfig,
  type LoadedLocalExecutorConfig,
  type ResolvedLocalWorkspaceContext,
  writeProjectLocalExecutorConfig,
} from "./local-config";
import {
  readLocalSourceArtifact,
  removeLocalSourceArtifact,
} from "./local-source-artifacts";
import {
  LocalConfiguredSourceNotFoundError,
  LocalExecutorConfigDecodeError,
  LocalFileSystemError,
  LocalUnsupportedSourceKindError,
  LocalWorkspaceStateDecodeError,
  RuntimeLocalWorkspaceMismatchError,
  RuntimeLocalWorkspaceUnavailableError,
} from "./local-errors";
import {
  requireRuntimeLocalWorkspace,
} from "./local-runtime-context";
import {
  loadLocalWorkspaceState,
  writeLocalWorkspaceState,
  type LocalWorkspaceState,
} from "./local-workspace-state";
import {
  fromConfigSecretProviderId,
  toConfigSecretProviderId,
} from "./local-config-secrets";
import { createDefaultSecretMaterialDeleter } from "./secret-material-providers";
import { authArtifactSecretMaterialRefs } from "./auth-artifacts";
import { removeAuthLeaseAndSecrets } from "./auth-leases";
import { getSourceAdapter } from "./source-adapters";
import { slugify } from "./slug";

const secretRefKey = (ref: { providerId: string; handle: string }): string =>
  `${ref.providerId}:${ref.handle}`;

const cleanupAuthArtifactSecretRefs = (rows: SqlControlPlaneRows, input: {
  previous: AuthArtifact | null;
  next: AuthArtifact | null;
}) =>
  Effect.gen(function* () {
    if (input.previous === null) {
      return;
    }

    const deleteSecretMaterial = createDefaultSecretMaterialDeleter({ rows });
    const nextRefKeys = new Set(
      (input.next === null ? [] : authArtifactSecretMaterialRefs(input.next)).map(secretRefKey),
    );
    const refsToDelete = authArtifactSecretMaterialRefs(input.previous).filter(
      (ref) => !nextRefKeys.has(secretRefKey(ref)),
    );

    yield* Effect.forEach(
      refsToDelete,
      (ref) => Effect.either(deleteSecretMaterial(ref)),
      { discard: true },
    );
  });

const selectPreferredAuthArtifact = (input: {
  authArtifacts: ReadonlyArray<AuthArtifact>;
  actorAccountId?: AccountId | null;
  slot: CredentialSlot;
}): AuthArtifact | null => {
  const matchingSlot = input.authArtifacts.filter((artifact) => artifact.slot === input.slot);

  if (input.actorAccountId !== undefined) {
    const exact = matchingSlot.find((artifact) => artifact.actorAccountId === input.actorAccountId);
    if (exact) {
      return exact;
    }
  }

  return matchingSlot.find((artifact) => artifact.actorAccountId === null) ?? null;
};

const selectExactAuthArtifact = (input: {
  authArtifacts: ReadonlyArray<AuthArtifact>;
  actorAccountId?: AccountId | null;
  slot: CredentialSlot;
}): AuthArtifact | null =>
  input.authArtifacts.find(
    (artifact) =>
      artifact.slot === input.slot
      && artifact.actorAccountId === (input.actorAccountId ?? null),
  ) ?? null;

const trimOrNull = (value: string | null | undefined): string | null => {
  if (value == null) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const cloneJson = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;

const deriveLocalSourceId = (
  source: Pick<Source, "namespace" | "name">,
  used: ReadonlySet<string>,
): SourceId => {
  const base =
    trimOrNull(source.namespace)
    ?? trimOrNull(source.name)
    ?? "source";
  const slugBase = slugify(base) || "source";
  let candidate = slugBase;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${slugBase}-${counter}`;
    counter += 1;
  }
  return SourceIdSchema.make(candidate);
};

const resolveLocalConfigSecretProviderAlias = (config: LoadedLocalExecutorConfig["config"]): string | null => {
  const defaultAlias = trimOrNull(config?.secrets?.defaults?.env);
  if (defaultAlias !== null && config?.secrets?.providers?.[defaultAlias]) {
    return defaultAlias;
  }

  return config?.secrets?.providers?.default ? "default" : null;
};

const sourceAuthFromConfigInput = (input: {
  auth: unknown;
  config: LoadedLocalExecutorConfig["config"];
  existing: Source["auth"] | null;
}): Source["auth"] => {
  if (input.auth === undefined) {
    return input.existing ?? { kind: "none" };
  }

  if (typeof input.auth === "string") {
    const providerAlias = resolveLocalConfigSecretProviderAlias(input.config);
    return {
      kind: "bearer",
      headerName: "Authorization",
      prefix: "Bearer ",
      token: {
        providerId: providerAlias ? toConfigSecretProviderId(providerAlias) : "env",
        handle: input.auth,
      },
    };
  }

  if (typeof input.auth === "object" && input.auth !== null) {
    const explicit = input.auth as {
      source?: string;
      provider?: string;
      id?: string;
    };
    const providerAlias = trimOrNull(explicit.provider);
    const providerId = providerAlias
      ? (providerAlias === "params" ? "params" : toConfigSecretProviderId(providerAlias))
      : explicit.source === "env"
        ? "env"
        : explicit.source === "params"
          ? "params"
        : null;
    const handle = trimOrNull(explicit.id);
    if (providerId && handle) {
      return {
        kind: "bearer",
        headerName: "Authorization",
        prefix: "Bearer ",
        token: {
          providerId,
          handle,
        },
      };
    }
  }

  return input.existing ?? { kind: "none" };
};

const configAuthFromSource = (input: {
  source: Source;
  existingConfigAuth: LocalConfigSecretInput | undefined;
  config: LoadedLocalExecutorConfig["config"];
}): LocalConfigSecretInput | undefined => {
  if (input.source.auth.kind !== "bearer") {
    return input.existingConfigAuth;
  }

  if (input.source.auth.token.providerId === "env") {
    return input.source.auth.token.handle;
  }

  if (input.source.auth.token.providerId === "params") {
    return {
      source: "params",
      provider: "params",
      id: input.source.auth.token.handle,
    };
  }

  const provider = fromConfigSecretProviderId(input.source.auth.token.providerId);
  if (provider !== null) {
    const configuredProvider = input.config?.secrets?.providers?.[provider];
    if (configuredProvider) {
      return {
        source: configuredProvider.source,
        provider,
        id: input.source.auth.token.handle,
      };
    }
  }

  return input.existingConfigAuth;
};

const resolveRuntimeLocalWorkspace = (workspaceId: WorkspaceId): Effect.Effect<{
  context: ResolvedLocalWorkspaceContext;
  installation: {
    workspaceId: WorkspaceId;
    accountId: AccountId;
  };
  loadedConfig: LoadedLocalExecutorConfig;
  workspaceState: LocalWorkspaceState;
},
  | RuntimeLocalWorkspaceUnavailableError
  | RuntimeLocalWorkspaceMismatchError
  | LocalFileSystemError
  | LocalExecutorConfigDecodeError
  | LocalWorkspaceStateDecodeError,
never> =>
  Effect.gen(function* () {
    const runtimeLocalWorkspace = yield* requireRuntimeLocalWorkspace(workspaceId);
    const loadedConfig = yield* loadLocalExecutorConfig(runtimeLocalWorkspace.context);
    const workspaceState = yield* loadLocalWorkspaceState(runtimeLocalWorkspace.context);

    return {
      context: runtimeLocalWorkspace.context,
      installation: runtimeLocalWorkspace.installation,
      loadedConfig,
      workspaceState,
    };
  });

const buildLocalSourceRecord = (input: {
  context: ResolvedLocalWorkspaceContext;
  workspaceId: WorkspaceId;
  loadedConfig: LoadedLocalExecutorConfig;
  workspaceState: LocalWorkspaceState;
  sourceId: SourceId;
  actorAccountId?: AccountId | null;
  authArtifacts: ReadonlyArray<AuthArtifact>;
}): Effect.Effect<{
  source: Source;
  sourceId: SourceId;
}, LocalConfiguredSourceNotFoundError | Error, never> =>
  Effect.gen(function* () {
    const sourceConfig = input.loadedConfig.config?.sources?.[input.sourceId];
    if (!sourceConfig) {
      return yield* Effect.fail(
        new LocalConfiguredSourceNotFoundError({
          message: `Configured source not found for id ${input.sourceId}`,
          sourceId: input.sourceId,
        }),
      );
    }

    const existingState = input.workspaceState.sources[input.sourceId];
    const adapter = getSourceAdapter(sourceConfig.kind);
    const baseSource = yield* adapter.validateSource({
      id: SourceIdSchema.make(input.sourceId),
      workspaceId: input.workspaceId,
      name: trimOrNull(sourceConfig.name) ?? input.sourceId,
      kind: sourceConfig.kind,
      endpoint: sourceConfig.connection.endpoint.trim(),
      status: existingState?.status ?? ((sourceConfig.enabled ?? true) ? "connected" : "draft"),
      enabled: sourceConfig.enabled ?? true,
      namespace: trimOrNull(sourceConfig.namespace) ?? input.sourceId,
      bindingVersion: adapter.bindingConfigVersion,
      binding: sourceConfig.binding,
      importAuthPolicy: adapter.defaultImportAuthPolicy,
      importAuth: { kind: "none" },
      auth: sourceAuthFromConfigInput({
        auth: sourceConfig.connection.auth,
        config: input.loadedConfig.config,
        existing: null,
      }),
      sourceHash: existingState?.sourceHash ?? null,
      lastError: existingState?.lastError ?? null,
      createdAt: existingState?.createdAt ?? Date.now(),
      updatedAt: existingState?.updatedAt ?? Date.now(),
    });

    const artifact = yield* readLocalSourceArtifact({
      context: input.context,
      sourceId: input.sourceId,
    }).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    );

    const runtimeAuthArtifact = selectPreferredAuthArtifact({
      authArtifacts: input.authArtifacts.filter((artifactItem) => artifactItem.sourceId === baseSource.id),
      actorAccountId: input.actorAccountId,
      slot: "runtime",
    });
    const importAuthArtifact = selectPreferredAuthArtifact({
      authArtifacts: input.authArtifacts.filter((artifactItem) => artifactItem.sourceId === baseSource.id),
      actorAccountId: input.actorAccountId,
      slot: "import",
    });

    const sourceRecord = {
      id: baseSource.id,
      workspaceId: baseSource.workspaceId,
      recipeId: artifact?.recipeId ?? stableSourceRecipeId(baseSource),
      recipeRevisionId: artifact?.revision.id ?? stableSourceRecipeRevisionId(baseSource),
      name: baseSource.name,
      kind: baseSource.kind,
      endpoint: baseSource.endpoint,
      status: baseSource.status,
      enabled: baseSource.enabled,
      namespace: baseSource.namespace,
      importAuthPolicy: baseSource.importAuthPolicy,
      bindingConfigJson: adapter.serializeBindingConfig(baseSource),
      sourceHash: baseSource.sourceHash,
      lastError: baseSource.lastError,
      createdAt: baseSource.createdAt,
      updatedAt: baseSource.updatedAt,
    };

    const source: Source = {
      ...baseSource,
      auth:
        runtimeAuthArtifact === null
          ? baseSource.auth
          : sourceAuthFromAuthArtifact(runtimeAuthArtifact),
      importAuth:
        baseSource.importAuthPolicy === "separate"
          ? importAuthArtifact === null
            ? baseSource.importAuth
            : sourceAuthFromAuthArtifact(importAuthArtifact)
          : { kind: "none" },
      sourceHash: sourceRecord.sourceHash,
      lastError: sourceRecord.lastError,
      createdAt: sourceRecord.createdAt,
      updatedAt: sourceRecord.updatedAt,
    };

    return {
      source,
      sourceId: input.sourceId,
    };
  });

export const loadSourcesInWorkspace = (
  rows: SqlControlPlaneRows,
  workspaceId: WorkspaceId,
  options: {
    actorAccountId?: AccountId | null;
  } = {},
): Effect.Effect<
  readonly Source[],
  | RuntimeLocalWorkspaceUnavailableError
  | RuntimeLocalWorkspaceMismatchError
  | LocalFileSystemError
  | LocalExecutorConfigDecodeError
  | LocalWorkspaceStateDecodeError
  | LocalConfiguredSourceNotFoundError
  | Error,
  never
> =>
  Effect.gen(function* () {
    const localWorkspace = yield* resolveRuntimeLocalWorkspace(workspaceId);
    const authArtifacts = yield* rows.authArtifacts.listByWorkspaceId(workspaceId);
    return yield* Effect.forEach(
      Object.keys(localWorkspace.loadedConfig.config?.sources ?? {}),
      (sourceId) =>
        Effect.map(
          buildLocalSourceRecord({
            context: localWorkspace.context,
            workspaceId,
            loadedConfig: localWorkspace.loadedConfig,
            workspaceState: localWorkspace.workspaceState,
            sourceId: SourceIdSchema.make(sourceId),
            actorAccountId: options.actorAccountId,
            authArtifacts,
          }),
          ({ source }) => source,
        ),
    );
  });

export const loadSourceById = (rows: SqlControlPlaneRows, input: {
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
  actorAccountId?: AccountId | null;
}): Effect.Effect<
  Source,
  | RuntimeLocalWorkspaceUnavailableError
  | RuntimeLocalWorkspaceMismatchError
  | LocalFileSystemError
  | LocalExecutorConfigDecodeError
  | LocalWorkspaceStateDecodeError
  | LocalConfiguredSourceNotFoundError
  | Error,
  never
> =>
  Effect.gen(function* () {
    const localWorkspace = yield* resolveRuntimeLocalWorkspace(input.workspaceId);
    const authArtifacts = yield* rows.authArtifacts.listByWorkspaceId(input.workspaceId);
    if (!localWorkspace.loadedConfig.config?.sources?.[input.sourceId]) {
      return yield* Effect.fail(
        new LocalConfiguredSourceNotFoundError({
          message: `Source not found: workspaceId=${input.workspaceId} sourceId=${input.sourceId}`,
          sourceId: input.sourceId,
        }),
      );
    }

    const localSource = yield* buildLocalSourceRecord({
      context: localWorkspace.context,
      workspaceId: input.workspaceId,
      loadedConfig: localWorkspace.loadedConfig,
      workspaceState: localWorkspace.workspaceState,
      sourceId: input.sourceId,
      actorAccountId: input.actorAccountId,
      authArtifacts,
    });

    return localSource.source;
  });

const configSourceFromLocalSource = (input: {
  source: Source;
  existingConfigAuth: LocalConfigSecretInput | undefined;
  config: LoadedLocalExecutorConfig["config"];
}): LocalConfigSource => {
  const auth = configAuthFromSource({
    source: input.source,
    existingConfigAuth: input.existingConfigAuth,
    config: input.config,
  });

  const common = {
    ...(trimOrNull(input.source.name) !== trimOrNull(input.source.id)
      ? { name: input.source.name }
      : {}),
    ...(trimOrNull(input.source.namespace) !== trimOrNull(input.source.id)
      ? { namespace: input.source.namespace ?? undefined }
      : {}),
    ...(input.source.enabled === false ? { enabled: false } : {}),
    connection: {
      endpoint: input.source.endpoint,
      ...(auth !== undefined ? { auth } : {}),
    },
  };

  switch (input.source.kind) {
    case "openapi":
      return {
        kind: "openapi",
        ...common,
        binding: cloneJson(input.source.binding) as Extract<LocalConfigSource, { kind: "openapi" }>["binding"],
      };
    case "graphql":
      return {
        kind: "graphql",
        ...common,
        binding: cloneJson(input.source.binding) as Extract<LocalConfigSource, { kind: "graphql" }>["binding"],
      };
    case "google_discovery":
      return {
        kind: "google_discovery",
        ...common,
        binding: cloneJson(input.source.binding) as Extract<LocalConfigSource, { kind: "google_discovery" }>["binding"],
      };
    case "mcp":
      return {
        kind: "mcp",
        ...common,
        binding: cloneJson(input.source.binding) as Extract<LocalConfigSource, { kind: "mcp" }>["binding"],
      };
    default:
      throw new LocalUnsupportedSourceKindError({
        message: `Unsupported source kind for local config: ${input.source.kind}`,
        kind: input.source.kind,
      });
  }
};

const removeAuthArtifactsForSource = (rows: SqlControlPlaneRows, input: {
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
}) =>
  Effect.gen(function* () {
    const existingAuthArtifacts = yield* rows.authArtifacts.listByWorkspaceAndSourceId({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
    });

    yield* rows.authArtifacts.removeByWorkspaceAndSourceId({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
    });

    yield* Effect.forEach(
      existingAuthArtifacts,
      (artifact) =>
        removeAuthLeaseAndSecrets(rows, {
          authArtifactId: artifact.id,
        }),
      { discard: true },
    );

    yield* Effect.forEach(
      existingAuthArtifacts,
      (artifact) =>
        cleanupAuthArtifactSecretRefs(rows, {
          previous: artifact,
          next: null,
        }),
      { discard: true },
    );

    return existingAuthArtifacts.length;
  });

export const removeSourceById = (rows: SqlControlPlaneRows, input: {
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
}) =>
  Effect.gen(function* () {
    const localWorkspace = yield* resolveRuntimeLocalWorkspace(input.workspaceId);
    if (!localWorkspace.loadedConfig.config?.sources?.[input.sourceId]) {
      return false;
    }

    const projectConfig = cloneJson(localWorkspace.loadedConfig.projectConfig ?? {});
    const sources = {
      ...(projectConfig.sources ?? {}),
    };
    delete sources[input.sourceId];
    yield* writeProjectLocalExecutorConfig({
      context: localWorkspace.context,
      config: {
        ...projectConfig,
        sources,
      },
    });

    const {
      [input.sourceId]: _removedSource,
      ...remainingSources
    } = localWorkspace.workspaceState.sources;
    const workspaceState: LocalWorkspaceState = {
      ...localWorkspace.workspaceState,
      sources: remainingSources,
    };
    yield* writeLocalWorkspaceState({
      context: localWorkspace.context,
      state: workspaceState,
    });
    yield* removeLocalSourceArtifact({
      context: localWorkspace.context,
      sourceId: input.sourceId,
    });

    yield* rows.sourceAuthSessions.removeByWorkspaceAndSourceId(
      input.workspaceId,
      input.sourceId,
    );
    yield* rows.sourceOauthClients.removeByWorkspaceAndSourceId({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
    });
    yield* removeAuthArtifactsForSource(rows, input);

    return true;
  });

export const persistSource = (
  rows: SqlControlPlaneRows,
  source: Source,
  options: {
    actorAccountId?: AccountId | null;
  } = {},
) =>
  Effect.gen(function* () {
    const localWorkspace = yield* resolveRuntimeLocalWorkspace(source.workspaceId);
    const nextSource = {
      ...source,
      id:
        localWorkspace.loadedConfig.config?.sources?.[source.id]
        || localWorkspace.workspaceState.sources[source.id]
          ? source.id
          : deriveLocalSourceId(
              source,
              new Set(Object.keys(localWorkspace.loadedConfig.config?.sources ?? {})),
            ),
    } satisfies Source;
    const existingAuthArtifacts = yield* rows.authArtifacts.listByWorkspaceAndSourceId({
      workspaceId: nextSource.workspaceId,
      sourceId: nextSource.id,
    });
    const existingRuntimeAuthArtifact = selectExactAuthArtifact({
      authArtifacts: existingAuthArtifacts,
      actorAccountId: options.actorAccountId,
      slot: "runtime",
    });
    const existingImportAuthArtifact = selectExactAuthArtifact({
      authArtifacts: existingAuthArtifacts,
      actorAccountId: options.actorAccountId,
      slot: "import",
    });
    const projectConfig = cloneJson(localWorkspace.loadedConfig.projectConfig ?? {});
    const sources = {
      ...(projectConfig.sources ?? {}),
    };
    const existingConfigSource = sources[nextSource.id];
    sources[nextSource.id] = configSourceFromLocalSource({
      source: nextSource,
      existingConfigAuth: existingConfigSource?.connection.auth,
      config: localWorkspace.loadedConfig.config,
    });
    yield* writeProjectLocalExecutorConfig({
      context: localWorkspace.context,
      config: {
        ...projectConfig,
        sources,
      },
    });

    const { runtimeAuthArtifact, importAuthArtifact } = splitSourceForStorage({
      source: nextSource,
      recipeId: stableSourceRecipeId(nextSource),
      recipeRevisionId: stableSourceRecipeRevisionId(nextSource),
      actorAccountId: options.actorAccountId,
      existingRuntimeAuthArtifactId: existingRuntimeAuthArtifact?.id ?? null,
      existingImportAuthArtifactId: existingImportAuthArtifact?.id ?? null,
    });

    if (runtimeAuthArtifact === null) {
      if (existingRuntimeAuthArtifact !== null) {
        yield* removeAuthLeaseAndSecrets(rows, {
          authArtifactId: existingRuntimeAuthArtifact.id,
        });
      }
      yield* rows.authArtifacts.removeByWorkspaceSourceAndActor({
        workspaceId: nextSource.workspaceId,
        sourceId: nextSource.id,
        actorAccountId: options.actorAccountId ?? null,
        slot: "runtime",
      });
    } else {
      yield* rows.authArtifacts.upsert(runtimeAuthArtifact);
      if (
        existingRuntimeAuthArtifact !== null
        && existingRuntimeAuthArtifact.id !== runtimeAuthArtifact.id
      ) {
        yield* removeAuthLeaseAndSecrets(rows, {
          authArtifactId: existingRuntimeAuthArtifact.id,
        });
      }
    }

    yield* cleanupAuthArtifactSecretRefs(rows, {
      previous: existingRuntimeAuthArtifact ?? null,
      next: runtimeAuthArtifact,
    });

    if (importAuthArtifact === null) {
      if (existingImportAuthArtifact !== null) {
        yield* removeAuthLeaseAndSecrets(rows, {
          authArtifactId: existingImportAuthArtifact.id,
        });
      }
      yield* rows.authArtifacts.removeByWorkspaceSourceAndActor({
        workspaceId: nextSource.workspaceId,
        sourceId: nextSource.id,
        actorAccountId: options.actorAccountId ?? null,
        slot: "import",
      });
    } else {
      yield* rows.authArtifacts.upsert(importAuthArtifact);
      if (
        existingImportAuthArtifact !== null
        && existingImportAuthArtifact.id !== importAuthArtifact.id
      ) {
        yield* removeAuthLeaseAndSecrets(rows, {
          authArtifactId: existingImportAuthArtifact.id,
        });
      }
    }

    yield* cleanupAuthArtifactSecretRefs(rows, {
      previous: existingImportAuthArtifact ?? null,
      next: importAuthArtifact,
    });

    const existingSourceState = localWorkspace.workspaceState.sources[nextSource.id];
    const workspaceState: LocalWorkspaceState = {
      ...localWorkspace.workspaceState,
      sources: {
        ...localWorkspace.workspaceState.sources,
        [nextSource.id]: {
          status: nextSource.status,
          lastError: nextSource.lastError,
          sourceHash: nextSource.sourceHash,
          createdAt: existingSourceState?.createdAt ?? nextSource.createdAt,
          updatedAt: nextSource.updatedAt,
        },
      },
    };
    yield* writeLocalWorkspaceState({
      context: localWorkspace.context,
      state: workspaceState,
    });

    return yield* loadSourceById(rows, {
      workspaceId: nextSource.workspaceId,
      sourceId: nextSource.id,
      actorAccountId: options.actorAccountId,
    });
  });
