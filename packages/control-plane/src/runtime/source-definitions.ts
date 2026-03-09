import type {
  CreateSourcePayload,
  UpdateSourcePayload,
} from "#api";
import type {
  Credential,
  Source,
  SourceAuth,
  SourceCredentialBinding,
  SourceId,
  StoredSourceRecord,
  StringMap,
  WorkspaceId,
} from "#schema";
import { CredentialIdSchema } from "#schema";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const decodeStringMap = Schema.decodeUnknown(
  Schema.NullOr(
    Schema.Record({
      key: Schema.String,
      value: Schema.String,
    }),
  ),
);

const trimOrNull = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const serializeStringMap = (value: StringMap | null): string | null =>
  value === null ? null : JSON.stringify(value);

const parseStringMapJson = (
  fieldName: string,
  value: string | null,
): Effect.Effect<StringMap | null, Error, never> =>
  value === null
    ? Effect.succeed(null)
    : Effect.try({
        try: () => JSON.parse(value),
        catch: (cause) =>
          cause instanceof Error
            ? new Error(`Invalid ${fieldName}: ${cause.message}`)
            : new Error(`Invalid ${fieldName}: ${String(cause)}`),
      }).pipe(
        Effect.flatMap((parsed) => decodeStringMap(parsed)),
        Effect.mapError((cause) =>
          cause instanceof Error
            ? new Error(`Invalid ${fieldName}: ${cause.message}`)
            : new Error(`Invalid ${fieldName}: ${String(cause)}`),
        ),
      );

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

const validateSourceByKind = (source: Source): Effect.Effect<Source, Error, never> =>
  Effect.gen(function* () {
    if (source.kind === "mcp") {
      if (source.specUrl !== null) {
        return yield* Effect.fail(new Error("MCP sources cannot define specUrl"));
      }
      return source;
    }

    if (source.kind === "openapi") {
      if (trimOrNull(source.specUrl) === null) {
        return yield* Effect.fail(new Error("OpenAPI sources require specUrl"));
      }

      if (source.transport !== null || source.queryParams !== null || source.headers !== null) {
        return yield* Effect.fail(
          new Error("OpenAPI sources cannot define MCP transport settings"),
        );
      }

      return source;
    }

    if (source.kind === "graphql") {
      if (source.transport !== null || source.queryParams !== null || source.headers !== null) {
        return yield* Effect.fail(
          new Error("GraphQL sources cannot define MCP transport settings"),
        );
      }

      if (source.specUrl !== null) {
        return yield* Effect.fail(new Error("GraphQL sources cannot define specUrl"));
      }

      return source;
    }

    if (source.transport !== null || source.queryParams !== null || source.headers !== null) {
      return yield* Effect.fail(
        new Error(`${source.kind} sources cannot define MCP transport settings`),
      );
    }

    if (source.specUrl !== null || source.defaultHeaders !== null) {
      return yield* Effect.fail(
        new Error(`${source.kind} sources cannot define OpenAPI settings`),
      );
    }

    return source;
  });

export const createSourceFromPayload = (input: {
  workspaceId: WorkspaceId;
  sourceId: SourceId;
  payload: CreateSourcePayload;
  now: number;
}): Effect.Effect<Source, Error, never> =>
  Effect.gen(function* () {
    const auth = yield* normalizeAuth(input.payload.auth);

    return yield* validateSourceByKind({
      id: input.sourceId,
      workspaceId: input.workspaceId,
      name: input.payload.name.trim(),
      kind: input.payload.kind,
      endpoint: input.payload.endpoint.trim(),
      status: input.payload.status ?? "draft",
      enabled: input.payload.enabled ?? true,
      namespace: trimOrNull(input.payload.namespace),
      transport: input.payload.transport ?? null,
      queryParams: input.payload.queryParams ?? null,
      headers: input.payload.headers ?? null,
      specUrl: trimOrNull(input.payload.specUrl),
      defaultHeaders: input.payload.defaultHeaders ?? null,
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

    return yield* validateSourceByKind({
      ...input.source,
      name: input.payload.name !== undefined ? input.payload.name.trim() : input.source.name,
      kind: input.payload.kind ?? input.source.kind,
      endpoint:
        input.payload.endpoint !== undefined
          ? input.payload.endpoint.trim()
          : input.source.endpoint,
      status: input.payload.status ?? input.source.status,
      enabled: input.payload.enabled ?? input.source.enabled,
      namespace: input.payload.namespace !== undefined
        ? trimOrNull(input.payload.namespace)
        : input.source.namespace,
      transport: input.payload.transport !== undefined
        ? input.payload.transport
        : input.source.transport,
      queryParams: input.payload.queryParams !== undefined
        ? input.payload.queryParams
        : input.source.queryParams,
      headers: input.payload.headers !== undefined
        ? input.payload.headers
        : input.source.headers,
      specUrl: input.payload.specUrl !== undefined
        ? trimOrNull(input.payload.specUrl)
        : input.source.specUrl,
      defaultHeaders: input.payload.defaultHeaders !== undefined
        ? input.payload.defaultHeaders
        : input.source.defaultHeaders,
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

export const splitSourceForStorage = (input: {
  source: Source;
  existingCredentialId?: Credential["id"] | null;
  existingBindingId?: SourceCredentialBinding["id"] | null;
}): {
  sourceRecord: StoredSourceRecord;
  credential: Credential | null;
  credentialBinding: SourceCredentialBinding | null;
} => {
  const sourceRecord: StoredSourceRecord = {
    id: input.source.id,
    workspaceId: input.source.workspaceId,
    name: input.source.name,
    kind: input.source.kind,
    endpoint: input.source.endpoint,
    status: input.source.status,
    enabled: input.source.enabled,
    namespace: input.source.namespace,
    transport: input.source.transport,
    queryParamsJson: serializeStringMap(input.source.queryParams),
    headersJson: serializeStringMap(input.source.headers),
    specUrl: input.source.specUrl,
    defaultHeadersJson: serializeStringMap(input.source.defaultHeaders),
    sourceHash: input.source.sourceHash,
    sourceDocumentText: null,
    lastError: input.source.lastError,
    createdAt: input.source.createdAt,
    updatedAt: input.source.updatedAt,
  };

  if (input.source.auth.kind === "none") {
    return {
      sourceRecord,
      credential: null,
      credentialBinding: null,
    };
  }

  const credentialId = input.existingCredentialId
    ?? CredentialIdSchema.make(`cred_${crypto.randomUUID()}`);
  const bindingId = input.existingBindingId ?? `src_cred_bind_${crypto.randomUUID()}`;

  const credential: Credential = {
    id: credentialId,
    workspaceId: input.source.workspaceId,
    authKind: input.source.auth.kind,
    authHeaderName: input.source.auth.headerName,
    authPrefix: input.source.auth.prefix,
    tokenProviderId:
      input.source.auth.kind === "bearer"
        ? input.source.auth.token.providerId
        : input.source.auth.accessToken.providerId,
    tokenHandle:
      input.source.auth.kind === "bearer"
        ? input.source.auth.token.handle
        : input.source.auth.accessToken.handle,
    refreshTokenProviderId:
      input.source.auth.kind === "oauth2" && input.source.auth.refreshToken !== null
        ? input.source.auth.refreshToken.providerId
        : null,
    refreshTokenHandle:
      input.source.auth.kind === "oauth2" && input.source.auth.refreshToken !== null
        ? input.source.auth.refreshToken.handle
        : null,
    createdAt: input.source.createdAt,
    updatedAt: input.source.updatedAt,
  };

  return {
    sourceRecord,
    credential,
    credentialBinding: {
      id: bindingId,
      workspaceId: input.source.workspaceId,
      sourceId: input.source.id,
      credentialId,
      createdAt: input.source.createdAt,
      updatedAt: input.source.updatedAt,
    },
  };
};

export const projectSourceFromStorage = (input: {
  sourceRecord: StoredSourceRecord;
  credentialBinding: SourceCredentialBinding | null;
  credential: Credential | null;
}): Effect.Effect<Source, Error, never> =>
  Effect.gen(function* () {
    const queryParams = yield* parseStringMapJson(
      `queryParamsJson for ${input.sourceRecord.id}`,
      input.sourceRecord.queryParamsJson,
    );
    const headers = yield* parseStringMapJson(
      `headersJson for ${input.sourceRecord.id}`,
      input.sourceRecord.headersJson,
    );
    const defaultHeaders = yield* parseStringMapJson(
      `defaultHeadersJson for ${input.sourceRecord.id}`,
      input.sourceRecord.defaultHeadersJson,
    );

    let auth: SourceAuth = { kind: "none" };
    if (input.credentialBinding !== null) {
      const credential = input.credential;
      if (credential === null) {
        return yield* Effect.fail(
          new Error(`Missing credential ${input.credentialBinding.credentialId} for source ${input.sourceRecord.id}`),
        );
      }

      if (credential.authKind === "bearer") {
        auth = {
          kind: "bearer",
          headerName: credential.authHeaderName,
          prefix: credential.authPrefix,
          token: {
            providerId: credential.tokenProviderId,
            handle: credential.tokenHandle,
          },
        };
      } else {
        auth = {
          kind: "oauth2",
          headerName: credential.authHeaderName,
          prefix: credential.authPrefix,
          accessToken: {
            providerId: credential.tokenProviderId,
            handle: credential.tokenHandle,
          },
          refreshToken:
            credential.refreshTokenProviderId !== null && credential.refreshTokenHandle !== null
              ? {
                  providerId: credential.refreshTokenProviderId,
                  handle: credential.refreshTokenHandle,
                }
              : null,
        };
      }
    }

    return {
      id: input.sourceRecord.id,
      workspaceId: input.sourceRecord.workspaceId,
      name: input.sourceRecord.name,
      kind: input.sourceRecord.kind,
      endpoint: input.sourceRecord.endpoint,
      status: input.sourceRecord.status,
      enabled: input.sourceRecord.enabled,
      namespace: input.sourceRecord.namespace,
      transport: input.sourceRecord.transport,
      queryParams,
      headers,
      specUrl: input.sourceRecord.specUrl,
      defaultHeaders,
      auth,
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
  credentialBindings: ReadonlyArray<SourceCredentialBinding>;
  credentials: ReadonlyArray<Credential>;
}): Effect.Effect<ReadonlyArray<Source>, Error, never> => {
  const bindingsBySourceId = new Map(
    input.credentialBindings.map((binding) => [binding.sourceId, binding]),
  );
  const credentialsById = new Map(
    input.credentials.map((credential) => [credential.id, credential]),
  );

  return Effect.forEach(input.sourceRecords, (sourceRecord) => {
    const credentialBinding = bindingsBySourceId.get(sourceRecord.id) ?? null;
    return projectSourceFromStorage({
      sourceRecord,
      credentialBinding,
      credential:
        credentialBinding === null
          ? null
          : credentialsById.get(credentialBinding.credentialId) ?? null,
    });
  });
};
