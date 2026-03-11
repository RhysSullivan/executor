import { createHash } from "node:crypto";

import type {
  CreateSourcePayload,
  UpdateSourcePayload,
} from "#api";
import type {
  AccountId,
  Credential,
  CredentialSlot,
  Source,
  SourceAuth,
  SourceImportAuthPolicy,
  SourceRecipeAdapterKey,
  SourceRecipeId,
  SourceRecipeKind,
  SourceRecipeRevisionId,
  StoredSourceRecord,
  StoredSourceRecipeRecord,
  StoredSourceRecipeRevisionRecord,
  WorkspaceId,
} from "#schema";
import {
  CredentialIdSchema,
  SourceRecipeIdSchema,
  SourceRecipeRevisionIdSchema,
} from "#schema";
import * as Effect from "effect/Effect";
 
import { getSourceAdapter, getSourceAdapterForSource } from "./source-adapters";

const trimOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

type SourceRecipeSourceConfig = Record<string, unknown>;

const sourceConfigFromSource = (source: Source): SourceRecipeSourceConfig =>
  getSourceAdapterForSource(source).sourceConfigFromSource(source);

const sourceRecipeKindFromSource = (source: Source): SourceRecipeKind => {
  const adapter = getSourceAdapterForSource(source);
  return adapter.family;
};

const sourceRecipeAdapterKeyFromSource = (source: Source): SourceRecipeAdapterKey => {
  return getSourceAdapterForSource(source).key;
};

const sourceRecipeProviderKeyFromSource = (source: Source): string => {
  return getSourceAdapterForSource(source).providerKey;
};

const stableHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);

const sourceRecipeSignature = (source: Source): string =>
  JSON.stringify({
    recipeKind: sourceRecipeKindFromSource(source),
    adapterKey: sourceRecipeAdapterKeyFromSource(source),
    providerKey: sourceRecipeProviderKeyFromSource(source),
    sourceConfig: sourceConfigFromSource(source),
  });

export const sourceConfigSignature = (source: Source): string =>
  JSON.stringify(sourceConfigFromSource(source));

export const stableSourceRecipeId = (source: Source): SourceRecipeId =>
  SourceRecipeIdSchema.make(`src_recipe_${stableHash(sourceRecipeSignature(source))}`);

export const stableSourceRecipeRevisionId = (
  source: Source,
): SourceRecipeRevisionId =>
  SourceRecipeRevisionIdSchema.make(`src_recipe_rev_${stableHash(sourceConfigSignature(source))}`);

const normalizeAuth = (
  auth: SourceAuth | undefined,
): Effect.Effect<SourceAuth, Error, never> =>
  Effect.gen(function* () {
    if (auth === undefined || auth.kind === "none") {
      return { kind: "none" } satisfies SourceAuth;
    }

    const headerName = trimOrNull(auth.headerName) ?? "Authorization";
    const prefix = auth.prefix ?? "Bearer ";

    if (auth.kind === "bearer") {
      const providerId = trimOrNull(auth.token.providerId);
      const handle = trimOrNull(auth.token.handle);
      if (providerId === null || handle === null) {
        return yield* Effect.fail(new Error("Bearer auth requires a token secret ref"));
      }

      return {
        kind: "bearer",
        headerName,
        prefix,
        token: {
          providerId,
          handle,
        },
      } satisfies SourceAuth;
    }

    const accessProviderId = trimOrNull(auth.accessToken.providerId);
    const accessHandle = trimOrNull(auth.accessToken.handle);
    if (accessProviderId === null || accessHandle === null) {
      return yield* Effect.fail(new Error("OAuth2 auth requires an access token secret ref"));
    }

    let refreshToken: { providerId: string; handle: string } | null = null;
    if (auth.refreshToken !== null) {
      const refreshProviderId = trimOrNull(auth.refreshToken.providerId);
      const refreshHandle = trimOrNull(auth.refreshToken.handle);
      if (refreshProviderId === null || refreshHandle === null) {
        return yield* Effect.fail(
          new Error("OAuth2 refresh token ref must include providerId and handle"),
        );
      }

      refreshToken = {
        providerId: refreshProviderId,
        handle: refreshHandle,
      };
    }

    return {
      kind: "oauth2",
      headerName,
      prefix,
      accessToken: {
        providerId: accessProviderId,
        handle: accessHandle,
      },
      refreshToken,
    } satisfies SourceAuth;
  });

const normalizeImportAuthPolicy = (
  sourceKind: Source["kind"],
  policy: SourceImportAuthPolicy | undefined,
): SourceImportAuthPolicy => policy ?? getSourceAdapter(sourceKind).defaultImportAuthPolicy;

const credentialFromAuth = (input: {
  source: Source;
  auth: SourceAuth;
  slot: CredentialSlot;
  actorAccountId?: AccountId | null;
  existingCredentialId?: Credential["id"] | null;
}): Credential | null => {
  if (input.auth.kind === "none") {
    return null;
  }

  const credentialId = input.existingCredentialId
    ?? CredentialIdSchema.make(`cred_${crypto.randomUUID()}`);

  return {
    id: credentialId,
    workspaceId: input.source.workspaceId,
    sourceId: input.source.id,
    actorAccountId: input.actorAccountId ?? null,
    slot: input.slot,
    authKind: input.auth.kind,
    authHeaderName: input.auth.headerName,
    authPrefix: input.auth.prefix,
    tokenProviderId:
      input.auth.kind === "bearer"
        ? input.auth.token.providerId
        : input.auth.accessToken.providerId,
    tokenHandle:
      input.auth.kind === "bearer"
        ? input.auth.token.handle
        : input.auth.accessToken.handle,
    refreshTokenProviderId:
      input.auth.kind === "oauth2" && input.auth.refreshToken !== null
        ? input.auth.refreshToken.providerId
        : null,
    refreshTokenHandle:
      input.auth.kind === "oauth2" && input.auth.refreshToken !== null
        ? input.auth.refreshToken.handle
        : null,
    createdAt: input.source.createdAt,
    updatedAt: input.source.updatedAt,
  } satisfies Credential;
};

const authFromCredential = (credential: Credential | null): SourceAuth => {
  if (credential === null) {
    return { kind: "none" };
  }

  if (credential.authKind === "bearer") {
    return {
      kind: "bearer",
      headerName: credential.authHeaderName,
      prefix: credential.authPrefix,
      token: {
        providerId: credential.tokenProviderId,
        handle: credential.tokenHandle,
      },
    };
  }

  return {
    kind: "oauth2",
    headerName: credential.authHeaderName,
    prefix: credential.authPrefix,
    accessToken: {
      providerId: credential.tokenProviderId,
      handle: credential.tokenHandle,
    },
    refreshToken:
      credential.refreshTokenProviderId !== null
      && credential.refreshTokenHandle !== null
        ? {
            providerId: credential.refreshTokenProviderId,
            handle: credential.refreshTokenHandle,
          }
        : null,
  };
};

const validateSourceImportAuth = (source: Source): Effect.Effect<Source, Error, never> =>
  Effect.gen(function* () {
    if (source.importAuthPolicy !== "separate" && source.importAuth.kind !== "none") {
      return yield* Effect.fail(
        new Error("importAuth must be none unless importAuthPolicy is separate"),
      );
    }

    return source;
  });

const validateSourceByKind = (source: Source): Effect.Effect<Source, Error, never> =>
  Effect.flatMap(
    validateSourceImportAuth(source),
    (validated) => getSourceAdapterForSource(validated).validateSource(validated),
  );

export const createSourceFromPayload = (input: {
  workspaceId: WorkspaceId;
  sourceId: Source["id"];
  payload: CreateSourcePayload;
  now: number;
}): Effect.Effect<Source, Error, never> =>
  Effect.gen(function* () {
    const auth = yield* normalizeAuth(input.payload.auth);
    const importAuth = yield* normalizeAuth(input.payload.importAuth);
    const importAuthPolicy = normalizeImportAuthPolicy(
      input.payload.kind,
      input.payload.importAuthPolicy,
    );

    return yield* validateSourceByKind({
      id: input.sourceId,
      workspaceId: input.workspaceId,
      name: input.payload.name.trim(),
      kind: input.payload.kind,
      endpoint: input.payload.endpoint.trim(),
      status: input.payload.status ?? "draft",
      enabled: input.payload.enabled ?? true,
      namespace: trimOrNull(input.payload.namespace),
      bindingVersion: getSourceAdapter(input.payload.kind).bindingConfigVersion,
      binding: input.payload.binding ?? {},
      importAuthPolicy,
      importAuth,
      auth,
      sourceHash: trimOrNull(input.payload.sourceHash),
      lastError: trimOrNull(input.payload.lastError),
      createdAt: input.now,
      updatedAt: input.now,
    });
  });

export const updateSourceFromPayload = (input: {
  source: Source;
  payload: UpdateSourcePayload;
  now: number;
}): Effect.Effect<Source, Error, never> =>
  Effect.gen(function* () {
    const nextAuth = input.payload.auth === undefined
      ? input.source.auth
      : yield* normalizeAuth(input.payload.auth);
    const nextImportAuth = input.payload.importAuth === undefined
      ? input.source.importAuth
      : yield* normalizeAuth(input.payload.importAuth);
    const nextImportAuthPolicy = normalizeImportAuthPolicy(
      input.source.kind,
      input.payload.importAuthPolicy ?? input.source.importAuthPolicy,
    );

    return yield* validateSourceByKind({
      ...input.source,
      name: input.payload.name !== undefined ? input.payload.name.trim() : input.source.name,
      endpoint:
        input.payload.endpoint !== undefined
          ? input.payload.endpoint.trim()
          : input.source.endpoint,
      status: input.payload.status ?? input.source.status,
      enabled: input.payload.enabled ?? input.source.enabled,
      namespace: input.payload.namespace !== undefined
        ? trimOrNull(input.payload.namespace)
        : input.source.namespace,
      bindingVersion: input.payload.binding !== undefined
        ? getSourceAdapter(input.source.kind).bindingConfigVersion
        : input.source.bindingVersion,
      binding: input.payload.binding !== undefined
        ? input.payload.binding
        : input.source.binding,
      importAuthPolicy: nextImportAuthPolicy,
      importAuth: nextImportAuth,
      auth: nextAuth,
      sourceHash: input.payload.sourceHash !== undefined
        ? trimOrNull(input.payload.sourceHash)
        : input.source.sourceHash,
      lastError: input.payload.lastError !== undefined
        ? trimOrNull(input.payload.lastError)
        : input.source.lastError,
      updatedAt: input.now,
    });
  });

export const createSourceRecipeRecord = (input: {
  source: Source;
  recipeId?: SourceRecipeId | null;
  latestRevisionId: SourceRecipeRevisionId;
}): StoredSourceRecipeRecord => ({
  id: input.recipeId ?? stableSourceRecipeId(input.source),
  kind: sourceRecipeKindFromSource(input.source),
  adapterKey: sourceRecipeAdapterKeyFromSource(input.source),
  providerKey: sourceRecipeProviderKeyFromSource(input.source),
  name: input.source.name,
  summary: null,
  visibility: "workspace",
  latestRevisionId: input.latestRevisionId,
  createdAt: input.source.createdAt,
  updatedAt: input.source.updatedAt,
});

export const createSourceRecipeRevisionRecord = (input: {
  source: Source;
  recipeId: SourceRecipeId;
  recipeRevisionId?: SourceRecipeRevisionId | null;
  revisionNumber: number;
  manifestJson?: string | null;
  manifestHash?: string | null;
  materializationHash?: string | null;
}): StoredSourceRecipeRevisionRecord => ({
  id:
    input.recipeRevisionId
    ?? stableSourceRecipeRevisionId(input.source),
  recipeId: input.recipeId,
  revisionNumber: input.revisionNumber,
  sourceConfigJson: sourceConfigSignature(input.source),
  manifestJson: input.manifestJson ?? null,
  manifestHash: input.manifestHash ?? null,
  materializationHash: input.materializationHash ?? null,
  createdAt: input.source.createdAt,
  updatedAt: input.source.updatedAt,
});

export const splitSourceForStorage = (input: {
  source: Source;
  recipeId: SourceRecipeId;
  recipeRevisionId: SourceRecipeRevisionId;
  actorAccountId?: AccountId | null;
  existingRuntimeCredentialId?: Credential["id"] | null;
  existingImportCredentialId?: Credential["id"] | null;
}): {
  sourceRecord: StoredSourceRecord;
  runtimeCredential: Credential | null;
  importCredential: Credential | null;
} => {
  const sourceRecord: StoredSourceRecord = {
    id: input.source.id,
    workspaceId: input.source.workspaceId,
    recipeId: input.recipeId,
    recipeRevisionId: input.recipeRevisionId,
    name: input.source.name,
    kind: input.source.kind,
    endpoint: input.source.endpoint,
    status: input.source.status,
    enabled: input.source.enabled,
    namespace: input.source.namespace,
    importAuthPolicy: input.source.importAuthPolicy,
    bindingConfigJson: getSourceAdapterForSource(input.source).serializeBindingConfig(input.source),
    sourceHash: input.source.sourceHash,
    lastError: input.source.lastError,
    createdAt: input.source.createdAt,
    updatedAt: input.source.updatedAt,
  };

  return {
    sourceRecord,
    runtimeCredential: credentialFromAuth({
      source: input.source,
      auth: input.source.auth,
      slot: "runtime",
      actorAccountId: input.actorAccountId,
      existingCredentialId: input.existingRuntimeCredentialId,
    }),
    importCredential: input.source.importAuthPolicy === "separate"
      ? credentialFromAuth({
          source: input.source,
          auth: input.source.importAuth,
          slot: "import",
          actorAccountId: input.actorAccountId,
          existingCredentialId: input.existingImportCredentialId,
        })
      : null,
  };
};

export const projectSourceFromStorage = (input: {
  sourceRecord: StoredSourceRecord;
  runtimeCredential: Credential | null;
  importCredential: Credential | null;
}): Effect.Effect<Source, Error, never> =>
  Effect.gen(function* () {
    const adapter = getSourceAdapter(input.sourceRecord.kind);
    const bindingConfig = yield* adapter.deserializeBindingConfig({
      id: input.sourceRecord.id,
      bindingConfigJson: input.sourceRecord.bindingConfigJson,
    });

    return {
      id: input.sourceRecord.id,
      workspaceId: input.sourceRecord.workspaceId,
      name: input.sourceRecord.name,
      kind: input.sourceRecord.kind,
      endpoint: input.sourceRecord.endpoint,
      status: input.sourceRecord.status,
      enabled: input.sourceRecord.enabled,
      namespace: input.sourceRecord.namespace,
      bindingVersion: bindingConfig.version,
      binding: bindingConfig.payload,
      importAuthPolicy: input.sourceRecord.importAuthPolicy,
      importAuth:
        input.sourceRecord.importAuthPolicy === "separate"
          ? authFromCredential(input.importCredential)
          : { kind: "none" },
      auth: authFromCredential(input.runtimeCredential),
      sourceHash: input.sourceRecord.sourceHash,
      lastError: input.sourceRecord.lastError,
      createdAt: input.sourceRecord.createdAt,
      updatedAt: input.sourceRecord.updatedAt,
    } satisfies Source;
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
    ),
  );

export const projectSourcesFromStorage = (input: {
  sourceRecords: ReadonlyArray<StoredSourceRecord>;
  credentials: ReadonlyArray<Credential>;
}): Effect.Effect<ReadonlyArray<Source>, Error, never> => {
  const credentialsBySourceId = new Map<string, {
    runtime: Credential | null;
    import: Credential | null;
  }>();

  for (const credential of input.credentials) {
    const existing = credentialsBySourceId.get(credential.sourceId) ?? {
      runtime: null,
      import: null,
    };
    const current = credential.slot === "runtime" ? existing.runtime : existing.import;
    if (current === null || (current.actorAccountId === null && credential.actorAccountId !== null)) {
      credentialsBySourceId.set(credential.sourceId, {
        ...existing,
        [credential.slot]: credential,
      });
    }
  }

  return Effect.forEach(input.sourceRecords, (sourceRecord) =>
    projectSourceFromStorage({
      sourceRecord,
      runtimeCredential: credentialsBySourceId.get(sourceRecord.id)?.runtime ?? null,
      importCredential: credentialsBySourceId.get(sourceRecord.id)?.import ?? null,
    }));
};
