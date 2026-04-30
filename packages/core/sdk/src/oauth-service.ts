// ---------------------------------------------------------------------------
// OAuth service implementation — the runtime behind `ctx.oauth`.
//
// Owns three flows, all on one codepath:
//
//   - probe(endpoint)            RFC 9728 + 8414 metadata lookup without
//                                 starting a flow. Used by onboarding UI
//                                 to decide between dynamic-DCR and
//                                 paste-your-credentials strategies.
//
//   - start({strategy, ...})      Persists an `oauth2_session` row.
//                                 * `dynamic-dcr`    runs discovery +
//                                                    DCR + PKCE, emits
//                                                    an authorization URL.
//                                 * `authorization-code`
//                                                    uses pre-configured
//                                                    client_id (secret)
//                                                    + endpoints + PKCE.
//                                 * `client-credentials`
//                                                    no user step —
//                                                    mints the Connection
//                                                    inline, returns
//                                                    authorizationUrl=null.
//
//   - complete({state, code})     Looks up the session, exchanges code
//                                 for tokens, creates the Connection via
//                                 `ctx.connections.create`, deletes the
//                                 session. Idempotent-ish in the sense
//                                 that a retried code past TTL fails
//                                 clean rather than draining the AS.
//
// The service also exposes a canonical `"oauth2"` `ConnectionProvider`
// for refresh. The provider reads `providerState.kind` to pick which
// token endpoint + client credentials to present; one handler covers
// every strategy because refresh semantics are strategy-independent.
// ---------------------------------------------------------------------------

import { Effect, Schema } from "effect";

import type {
  DBAdapter,
  StorageFailure,
  TypedAdapter,
} from "@executor/storage-core";

import {
  ConnectionRefreshError,
  CreateConnectionInput,
  TokenMaterial,
  type ConnectionProvider,
  type ConnectionRefreshInput,
  type ConnectionRefreshResult,
  type ConnectionRef,
} from "./connections";
import type {
  ConnectionProviderNotRegisteredError,
} from "./errors";
import type { CoreSchema } from "./core-schema";
import { ConnectionId, ScopeId, SecretId } from "./ids";
import { SetSecretInput, type SecretRef } from "./secrets";
import {
  OAUTH2_PROVIDER_KEY,
  OAUTH2_SESSION_TTL_MS,
  OAuthCompleteError,
  OAuthProbeError,
  OAuthProviderState as OAuthProviderStateSchema,
  OAuthSessionNotFoundError,
  OAuthStartError,
  type OAuthAuthorizationCodeStrategy,
  type OAuthClientCredentialsStrategy,
  type OAuthCompleteInput,
  type OAuthCompleteResult,
  type OAuthDynamicDcrStrategy,
  type OAuthProbeInput,
  type OAuthProbeResult,
  type OAuthProviderState,
  type OAuthService,
  type OAuthStartInput,
  type OAuthStartResult,
} from "./oauth";
import {
  beginDynamicAuthorization,
  discoverAuthorizationServerMetadata,
  discoverProtectedResourceMetadata,
} from "./oauth-discovery";
import {
  buildAuthorizationUrl,
  createPkceCodeChallenge,
  createPkceCodeVerifier,
  exchangeAuthorizationCode,
  exchangeClientCredentials,
  refreshAccessToken,
} from "./oauth-helpers";

// ---------------------------------------------------------------------------
// Session payload — persisted under `oauth2_session.payload` as opaque
// JSON. Shape is strategy-specific; the discriminator matches
// `OAuthStrategy["kind"]` so completion picks the right exchange path.
// ---------------------------------------------------------------------------

const OAuthAuthorizationServerMetadataJson = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});
const OAuthClientInformationJson = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});

const DynamicDcrSessionPayload = Schema.Struct({
  kind: Schema.Literal("dynamic-dcr"),
  identityLabel: Schema.NullOr(Schema.String),
  codeVerifier: Schema.String,
  authorizationServerUrl: Schema.String,
  authorizationServerMetadataUrl: Schema.String,
  authorizationServerMetadata: OAuthAuthorizationServerMetadataJson,
  clientInformation: OAuthClientInformationJson,
  resourceMetadataUrl: Schema.NullOr(Schema.String),
  resourceMetadata: Schema.NullOr(
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
  scopes: Schema.Array(Schema.String),
});

const AuthorizationCodeSessionPayload = Schema.Struct({
  kind: Schema.Literal("authorization-code"),
  identityLabel: Schema.NullOr(Schema.String),
  codeVerifier: Schema.String,
  authorizationEndpoint: Schema.String,
  tokenEndpoint: Schema.String,
  issuerUrl: Schema.optionalWith(Schema.NullOr(Schema.String), {
    default: () => null,
  }),
  clientIdSecretId: Schema.String,
  clientSecretSecretId: Schema.NullOr(Schema.String),
  scopes: Schema.Array(Schema.String),
  scopeSeparator: Schema.optional(Schema.String),
  clientAuth: Schema.Literal("body", "basic"),
});

/** `client-credentials` doesn't produce a session row — it mints the
 *  Connection inline during `start`. The shape is included here for
 *  completeness / future device-code use. */
const OAuthSessionPayload = Schema.Union(
  DynamicDcrSessionPayload,
  AuthorizationCodeSessionPayload,
);
type OAuthSessionPayload = typeof OAuthSessionPayload.Type;

const decodeSessionPayload = Schema.decodeUnknownSync(OAuthSessionPayload);
const encodeSessionPayload = Schema.encodeSync(OAuthSessionPayload);

const coerceJson = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const stringArray = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.filter((scope): scope is string => typeof scope === "string")
    : [];

const originOrNull = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

const decodeProviderState = (value: unknown): OAuthProviderState => {
  const raw = coerceJson(value);
  const record =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;

  if (record && !("kind" in record) && "flow" in record && "tokenUrl" in record) {
    const flow = record.flow;
    if (flow === "authorizationCode") {
      return Schema.decodeUnknownSync(OAuthProviderStateSchema)({
        kind: "authorization-code",
        tokenEndpoint: record.tokenUrl,
        issuerUrl: originOrNull(record.authorizationEndpoint),
        clientIdSecretId: record.clientIdSecretId,
        clientSecretSecretId: record.clientSecretSecretId ?? null,
        clientAuth: "body",
        scope: stringArray(record.scopes).join(" ") || null,
      });
    }
    if (flow === "clientCredentials") {
      return Schema.decodeUnknownSync(OAuthProviderStateSchema)({
        kind: "client-credentials",
        tokenEndpoint: record.tokenUrl,
        clientIdSecretId: record.clientIdSecretId,
        clientSecretSecretId: record.clientSecretSecretId,
        scopes: stringArray(record.scopes),
        clientAuth: "body",
        scope: stringArray(record.scopes).join(" ") || null,
      });
    }
  }

  if (
    record &&
    !("kind" in record) &&
    "clientIdSecretId" in record &&
    "scopes" in record
  ) {
    const scopes = stringArray(record.scopes);
    return Schema.decodeUnknownSync(OAuthProviderStateSchema)({
      kind: "authorization-code",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      issuerUrl: "https://accounts.google.com",
      clientIdSecretId: record.clientIdSecretId,
      clientSecretSecretId: record.clientSecretSecretId ?? null,
      clientAuth: "body",
      scope: scopes.join(" ") || null,
    });
  }

  if (
    record &&
    !("kind" in record) &&
    "clientInformation" in record &&
    "endpoint" in record
  ) {
    const clientInformation =
      record.clientInformation && typeof record.clientInformation === "object"
        ? (record.clientInformation as Record<string, unknown>)
        : null;
    return Schema.decodeUnknownSync(OAuthProviderStateSchema)({
      kind: "dynamic-dcr",
      tokenEndpoint:
        typeof record.tokenEndpoint === "string"
          ? record.tokenEndpoint
          : record.authorizationServerMetadata &&
              typeof record.authorizationServerMetadata === "object" &&
              typeof (record.authorizationServerMetadata as Record<string, unknown>)
                .token_endpoint === "string"
            ? ((record.authorizationServerMetadata as Record<string, unknown>)
                .token_endpoint as string)
            : "",
      issuerUrl:
        record.authorizationServerMetadata &&
        typeof record.authorizationServerMetadata === "object" &&
        typeof (record.authorizationServerMetadata as Record<string, unknown>).issuer ===
          "string"
          ? ((record.authorizationServerMetadata as Record<string, unknown>)
              .issuer as string)
          : null,
      authorizationServerUrl:
        typeof record.authorizationServerUrl === "string"
          ? record.authorizationServerUrl
          : null,
      authorizationServerMetadataUrl:
        typeof record.authorizationServerMetadataUrl === "string"
          ? record.authorizationServerMetadataUrl
          : null,
      clientId:
        typeof clientInformation?.client_id === "string"
          ? clientInformation.client_id
          : "",
      clientSecretSecretId: null,
      clientAuth: "body",
      scope: null,
    });
  }

  return Schema.decodeUnknownSync(OAuthProviderStateSchema)(raw);
};

// ---------------------------------------------------------------------------
// Service dependencies — the executor wires these up when it constructs
// the service. Every dep is a narrow surface so the service stays
// testable: point to an in-memory adapter + a secrets stub and every
// code path is exercisable.
// ---------------------------------------------------------------------------

export interface OAuthServiceDeps {
  /** Typed core-schema adapter. Already scope-wrapped upstream so reads
   *  fall through the scope stack; writes stamp the scope the caller
   *  named (`tokenScope` on start input). */
  readonly adapter: TypedAdapter<CoreSchema>;
  /** Raw adapter for opening transactions — the typed one doesn't expose
   *  `.transaction` directly. */
  readonly rawAdapter: DBAdapter;
  /** Resolves client-id / client-secret refs at start + refresh time.
   *  A `null` return means "secret row is gone" and aborts the flow. */
  readonly secretsGet: (id: string) => Effect.Effect<string | null, StorageFailure>;
  readonly secretsSet: (input: SetSecretInput) => Effect.Effect<SecretRef, StorageFailure>;
  /** Mints the Connection row + backing secret rows. Called from
   *  `complete` (and from `start` for `client-credentials`). */
  readonly connectionsCreate: (
    input: CreateConnectionInput,
  ) => Effect.Effect<
    ConnectionRef,
    ConnectionProviderNotRegisteredError | StorageFailure
  >;
  /** Random session id generator. Tests override to make outputs
   *  deterministic. */
  readonly newSessionId?: () => string;
  /** `Date.now()` substitute — tests override to drive TTL behavior. */
  readonly now?: () => number;
}

const defaultSessionId = (): string => {
  const crypto = globalThis.crypto;
  if (crypto?.randomUUID) return `oauth2_session_${crypto.randomUUID()}`;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `oauth2_session_${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
};

const secretIdPart = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "oauth";

const oauthSecretId = (
  connectionId: string,
  suffix: "access-token" | "refresh-token" | "client-secret",
): string => {
  const base = secretIdPart(connectionId);
  const readable = base.length <= 48 ? base : base.slice(0, 40);
  return `oauth2-${readable}-${suffix}`;
};

const scopedSessionId = (scopeId: string, sessionId: string): string =>
  `${sessionId}_${secretIdPart(scopeId).slice(0, 24)}`;

const terminalRefreshErrors = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
]);

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

export const makeOAuth2Service = (
  deps: OAuthServiceDeps,
): { readonly service: OAuthService; readonly connectionProvider: ConnectionProvider } => {
  const now = deps.now ?? (() => Date.now());
  const newSessionId = deps.newSessionId ?? defaultSessionId;

  // -------------------------------------------------------------------
  // probe
  // -------------------------------------------------------------------
  const probe = (
    input: OAuthProbeInput,
  ): Effect.Effect<OAuthProbeResult, OAuthProbeError> =>
    Effect.gen(function* () {
      const resource = yield* discoverProtectedResourceMetadata(
        input.endpoint,
        { resourceHeaders: input.headers, resourceQueryParams: input.queryParams },
      ).pipe(
        Effect.catchTag("OAuthDiscoveryError", (err) =>
          Effect.fail(
            new OAuthProbeError({
              message: `Protected resource metadata probe failed: ${err.message}`,

            }),
          ),
        ),
      );

      const authorizationServerUrl = (() => {
        const fromResource = resource?.metadata.authorization_servers?.[0];
        if (fromResource) return fromResource;
        try {
          const u = new URL(input.endpoint);
          return `${u.protocol}//${u.host}`;
        } catch {
          return null;
        }
      })();

      const authServer = authorizationServerUrl
        ? yield* discoverAuthorizationServerMetadata(
            authorizationServerUrl,
          ).pipe(
            Effect.catchTag("OAuthDiscoveryError", () =>
              Effect.succeed(null),
            ),
          )
        : null;

      const supportsDynamicRegistration = !!(
        authServer?.metadata.registration_endpoint &&
        (authServer.metadata.token_endpoint_auth_methods_supported ?? []).includes(
          "none",
        )
      );

      // Bearer challenge probe — POST the endpoint unauth, look for
      // 401 + WWW-Authenticate: Bearer. Harmless against non-MCP
      // endpoints (Railway/GraphQL endpoints respond 200 or 400 with
      // protocol-specific bodies that we simply read as "not a bearer
      // challenge").
      const isBearerChallengeEndpoint = yield* Effect.tryPromise({
        try: async (): Promise<boolean> => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 6_000);
          try {
            const probeUrl = new URL(input.endpoint);
            for (const [key, value] of Object.entries(input.queryParams ?? {})) {
              probeUrl.searchParams.set(key, value);
            }
            const response = await fetch(probeUrl.toString(), {
              method: "POST",
              headers: {
                ...(input.headers ?? {}),
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                  protocolVersion: "2025-06-18",
                  capabilities: {},
                  clientInfo: { name: "executor-probe", version: "0" },
                },
              }),
              signal: controller.signal,
            });
            if (response.status !== 401) return false;
            const wwwAuth =
              response.headers.get("www-authenticate") ??
              response.headers.get("WWW-Authenticate");
            return !!wwwAuth && /^\s*bearer\b/i.test(wwwAuth);
          } finally {
            clearTimeout(timer);
          }
        },
        catch: () => null,
      }).pipe(Effect.catchAll(() => Effect.succeed(false)));

      return {
        resourceMetadata:
          (resource?.metadata as Record<string, unknown> | undefined) ?? null,
        resourceMetadataUrl: resource?.metadataUrl ?? null,
        authorizationServerMetadata:
          (authServer?.metadata as Record<string, unknown> | undefined) ?? null,
        authorizationServerMetadataUrl: authServer?.metadataUrl ?? null,
        authorizationServerUrl: authorizationServerUrl ?? null,
        supportsDynamicRegistration,
        isBearerChallengeEndpoint,
      };
    });

  // -------------------------------------------------------------------
  // start — branches on strategy.kind
  // -------------------------------------------------------------------
  const startDynamicDcr = (
    input: OAuthStartInput,
    strategy: OAuthDynamicDcrStrategy,
  ): Effect.Effect<OAuthStartResult, OAuthStartError | StorageFailure> =>
    Effect.gen(function* () {
      const started = yield* beginDynamicAuthorization({
        endpoint: input.endpoint,
        redirectUrl: input.redirectUrl,
        state: "",
        scopes: strategy.scopes,
      }, {
        resourceHeaders: input.headers,
        resourceQueryParams: input.queryParams,
      }).pipe(
        Effect.catchTag("OAuthDiscoveryError", (err) =>
          Effect.fail(
            new OAuthStartError({
              message: `Dynamic authorization setup failed: ${err.message}`,

            }),
          ),
        ),
      );

      const sessionId = scopedSessionId(input.tokenScope, newSessionId());

      // beginDynamicAuthorization returns an authorizationUrl already
      // signed with whatever `state` we passed. We need the session id
      // to be the state parameter so completion can look up the row.
      // Re-build the URL with the corrected state — cheap, one SHA-256
      // for the PKCE challenge, no network calls.
      const codeChallenge = yield* Effect.promise(() =>
        createPkceCodeChallenge(started.codeVerifier),
      );
      const authorizationUrl = buildAuthorizationUrl({
        authorizationUrl: started.state.authorizationServerMetadata.authorization_endpoint,
        clientId: started.state.clientInformation.client_id,
        redirectUrl: input.redirectUrl,
        scopes:
          strategy.scopes ??
          started.state.authorizationServerMetadata.scopes_supported ??
          [],
        state: sessionId,
        codeChallenge,
      });

      const payload: OAuthSessionPayload = {
        kind: "dynamic-dcr",
        identityLabel: input.identityLabel ?? null,
        codeVerifier: started.codeVerifier,
        authorizationServerUrl: started.state.authorizationServerUrl,
        authorizationServerMetadataUrl:
          started.state.authorizationServerMetadataUrl,
        authorizationServerMetadata:
          started.state.authorizationServerMetadata as Record<string, unknown>,
        clientInformation:
          started.state.clientInformation as unknown as Record<string, unknown>,
        resourceMetadataUrl: started.state.resourceMetadataUrl,
        resourceMetadata:
          (started.state.resourceMetadata as Record<string, unknown> | null) ??
          null,
        scopes: [
          ...(strategy.scopes ??
            started.state.authorizationServerMetadata.scopes_supported ??
            []),
        ],
      };

      yield* writeSession({
        sessionId,
        input,
        payload,
        strategyKind: "dynamic-dcr",
      });

      return {
        sessionId,
        authorizationUrl,
        completedConnection: null,
      };
    });

  const startAuthorizationCode = (
    input: OAuthStartInput,
    strategy: OAuthAuthorizationCodeStrategy,
  ): Effect.Effect<OAuthStartResult, OAuthStartError | StorageFailure> =>
    Effect.gen(function* () {
      const clientId = yield* deps.secretsGet(strategy.clientIdSecretId).pipe(
        Effect.mapError((err) =>
          // Storage failure propagates; null returns aren't errors — the
          // branch below handles them.
          err,
        ),
      );
      if (clientId === null) {
        return yield* Effect.fail(
          new OAuthStartError({
            message: `client_id secret "${strategy.clientIdSecretId}" not found`,
          }),
        );
      }

      const sessionId = scopedSessionId(input.tokenScope, newSessionId());
      const codeVerifier = createPkceCodeVerifier();
      const codeChallenge = yield* Effect.promise(() =>
        createPkceCodeChallenge(codeVerifier),
      );

      const authorizationUrl = buildAuthorizationUrl({
        authorizationUrl: strategy.authorizationEndpoint,
        clientId,
        redirectUrl: input.redirectUrl,
        scopes: strategy.scopes,
        state: sessionId,
        codeChallenge,
        scopeSeparator: strategy.scopeSeparator,
        extraParams: strategy.extraAuthorizationParams,
      });

      const payload: OAuthSessionPayload = {
        kind: "authorization-code",
        identityLabel: input.identityLabel ?? null,
        codeVerifier,
        authorizationEndpoint: strategy.authorizationEndpoint,
        tokenEndpoint: strategy.tokenEndpoint,
        issuerUrl: strategy.issuerUrl ?? new URL(strategy.authorizationEndpoint).origin,
        clientIdSecretId: strategy.clientIdSecretId,
        clientSecretSecretId: strategy.clientSecretSecretId,
        scopes: [...strategy.scopes],
        scopeSeparator: strategy.scopeSeparator,
        clientAuth: strategy.clientAuth ?? "body",
      };

      yield* writeSession({
        sessionId,
        input,
        payload,
        strategyKind: "authorization-code",
      });

      return {
        sessionId,
        authorizationUrl,
        completedConnection: null,
      };
    });

  const startClientCredentials = (
    input: OAuthStartInput,
    strategy: OAuthClientCredentialsStrategy,
  ): Effect.Effect<OAuthStartResult, OAuthStartError | StorageFailure> =>
    Effect.gen(function* () {
      const clientId = yield* deps.secretsGet(strategy.clientIdSecretId);
      const clientSecret = yield* deps.secretsGet(strategy.clientSecretSecretId);
      if (clientId === null || clientSecret === null) {
        return yield* Effect.fail(
          new OAuthStartError({
            message: "client_id / client_secret secret not found",
          }),
        );
      }

      const tokens = yield* exchangeClientCredentials({
        tokenUrl: strategy.tokenEndpoint,
        clientId,
        clientSecret,
        scopes: strategy.scopes,
        scopeSeparator: strategy.scopeSeparator,
        clientAuth: strategy.clientAuth ?? "body",
      }).pipe(
        Effect.mapError(
          (err) =>
            new OAuthStartError({
              message: `Client credentials exchange failed: ${err.message}`,

            }),
        ),
      );

      const expiresAt =
        typeof tokens.expires_in === "number"
          ? now() + tokens.expires_in * 1000
          : null;

      const providerState: OAuthProviderState = {
        kind: "client-credentials",
        tokenEndpoint: strategy.tokenEndpoint,
        clientIdSecretId: strategy.clientIdSecretId,
        clientSecretSecretId: strategy.clientSecretSecretId,
        scopes: [...(strategy.scopes ?? [])],
        scopeSeparator: strategy.scopeSeparator,
        clientAuth: strategy.clientAuth ?? "body",
        scope: tokens.scope ?? null,
      };

      yield* deps
        .connectionsCreate(
          new CreateConnectionInput({
            id: ConnectionId.make(input.connectionId),
            scope: ScopeId.make(input.tokenScope),
            provider: OAUTH2_PROVIDER_KEY,
            identityLabel: input.identityLabel ?? safeHostname(input.endpoint),
            accessToken: new TokenMaterial({
              secretId: SecretId.make(oauthSecretId(input.connectionId, "access-token")),
              name: "OAuth Access Token",
              value: tokens.access_token,
            }),
            refreshToken: null,
            expiresAt,
            oauthScope: tokens.scope ?? null,
            providerState: Schema.encodeSync(OAuthProviderStateSchema)(
              providerState,
            ) as Record<string, unknown>,
          }),
        )
        .pipe(
          Effect.mapError(
            (err) =>
              new OAuthStartError({
                message: `Failed to mint connection: ${
                  err instanceof Error ? err.message : String(err)
                }`,

              }),
          ),
        );

      return {
        sessionId: "",
        authorizationUrl: null,
        completedConnection: { connectionId: input.connectionId },
      };
    });

  const start = (
    input: OAuthStartInput,
  ): Effect.Effect<OAuthStartResult, OAuthStartError | StorageFailure> => {
    switch (input.strategy.kind) {
      case "dynamic-dcr":
        return startDynamicDcr(input, input.strategy);
      case "authorization-code":
        return startAuthorizationCode(input, input.strategy);
      case "client-credentials":
        return startClientCredentials(input, input.strategy);
    }
  };

  const writeSession = (args: {
    sessionId: string;
    input: OAuthStartInput;
    payload: OAuthSessionPayload;
    strategyKind: string;
  }): Effect.Effect<void, StorageFailure> =>
    deps.adapter.create({
      model: "oauth2_session",
      data: {
        id: args.sessionId,
        scope_id: args.input.tokenScope,
        plugin_id: args.input.pluginId,
        strategy: args.strategyKind,
        connection_id: args.input.connectionId,
        token_scope: args.input.tokenScope,
        redirect_url: args.input.redirectUrl,
        payload: encodeSessionPayload(args.payload) as Record<string, unknown>,
        expires_at: now() + OAUTH2_SESSION_TTL_MS,
        created_at: new Date(),
      },
      forceAllowId: true,
    }).pipe(Effect.asVoid);

  // -------------------------------------------------------------------
  // complete — exchange the code, mint the Connection, delete the session
  // -------------------------------------------------------------------
  const complete = (
    input: OAuthCompleteInput,
  ): Effect.Effect<
    OAuthCompleteResult,
    OAuthCompleteError | OAuthSessionNotFoundError | StorageFailure
  > =>
    Effect.gen(function* () {
      const row = yield* deps.adapter.findOne({
        model: "oauth2_session",
        where: [{ field: "id", value: input.state }],
      });
      if (!row) {
        return yield* Effect.fail(
          new OAuthSessionNotFoundError({ sessionId: input.state }),
        );
      }

      const deleteSession = deps.adapter.delete({
        model: "oauth2_session",
        where: [
          { field: "id", value: input.state },
          { field: "scope_id", value: row.scope_id as string },
        ],
      });

      if (input.error) {
        yield* deleteSession;
        return yield* Effect.fail(
          new OAuthCompleteError({
            message: `Authorization server returned error: ${input.error}`,
            code: input.error,
          }),
        );
      }
      if (!input.code) {
        yield* deleteSession;
        return yield* Effect.fail(
          new OAuthCompleteError({
            message: "Missing authorization code",
          }),
        );
      }
      const expiresAt = Number(row.expires_at as number | bigint);
      if (expiresAt <= now()) {
        yield* deleteSession;
        return yield* Effect.fail(
          new OAuthCompleteError({
            message: "OAuth session expired",
          }),
        );
      }

      const payload = decodeSessionPayload(coerceJson(row.payload));
      const endpoint = ""; // not stored on the row — the payload's own
                          // endpoint fields drive exchange; we just need
                          // a display string for the identity label.
      const connectionId = row.connection_id as string;
      const tokenScope = row.token_scope as string;
      const redirectUrl = row.redirect_url as string;

      // Dispatch to the strategy-specific exchange.
      const exchangeResult = yield* (() => {
        switch (payload.kind) {
          case "dynamic-dcr":
            return exchangeDynamicDcr(payload, input.code, redirectUrl);
          case "authorization-code":
            return exchangeAuthorizationCodeStrategy(
              payload,
              input.code,
              redirectUrl,
            );
        }
      })().pipe(Effect.tapError(() => deleteSession));

      const connectionExpiresAt =
        typeof exchangeResult.tokens.expires_in === "number"
          ? now() + exchangeResult.tokens.expires_in * 1000
          : null;

      const dynamicClientSecretSecretId = yield* (() => {
        if (payload.kind !== "dynamic-dcr") return Effect.succeed(null);
        const clientSecret = (payload.clientInformation as { client_secret?: unknown })
          .client_secret;
        if (typeof clientSecret !== "string" || clientSecret.length === 0) {
          return Effect.succeed(null);
        }
        const secretId = oauthSecretId(connectionId, "client-secret");
        return deps
          .secretsSet(
            new SetSecretInput({
              id: SecretId.make(secretId),
              scope: ScopeId.make(tokenScope),
              name: "OAuth Client Secret",
              value: clientSecret,
            }),
          )
          .pipe(
            Effect.as(secretId),
            Effect.mapError(
              (err) =>
                new OAuthCompleteError({
                  message: `Failed to persist DCR client_secret: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                }),
            ),
          );
      })();

      const providerState: OAuthProviderState =
        payload.kind === "dynamic-dcr"
          ? {
              kind: "dynamic-dcr",
              tokenEndpoint: (payload.authorizationServerMetadata as {
                token_endpoint: string;
              }).token_endpoint,
              issuerUrl:
                (payload.authorizationServerMetadata as { issuer?: string }).issuer ??
                null,
              authorizationServerUrl: payload.authorizationServerUrl,
              authorizationServerMetadataUrl:
                payload.authorizationServerMetadataUrl,
              idTokenSigningAlgValuesSupported:
                (payload.authorizationServerMetadata as {
                  id_token_signing_alg_values_supported?: string[];
                }).id_token_signing_alg_values_supported,
              clientId: (payload.clientInformation as { client_id: string })
                .client_id,
              clientSecretSecretId: dynamicClientSecretSecretId,
              clientAuth:
                (payload.clientInformation as { token_endpoint_auth_method?: string })
                  .token_endpoint_auth_method === "client_secret_basic"
                  ? "basic"
                  : "body",
              scopes: [...payload.scopes],
              scope: exchangeResult.tokens.scope ?? null,
            }
          : {
              kind: "authorization-code",
              tokenEndpoint: payload.tokenEndpoint,
              issuerUrl: payload.issuerUrl,
              clientIdSecretId: payload.clientIdSecretId,
              clientSecretSecretId: payload.clientSecretSecretId,
              clientAuth: payload.clientAuth,
              scopes: [...payload.scopes],
              scopeSeparator: payload.scopeSeparator,
              scope: exchangeResult.tokens.scope ?? null,
            };

      yield* deps
        .connectionsCreate(
          new CreateConnectionInput({
            id: ConnectionId.make(connectionId),
            scope: ScopeId.make(tokenScope),
            provider: OAUTH2_PROVIDER_KEY,
            identityLabel: safeHostname(
              payload.identityLabel ?? exchangeResult.endpointForDisplay ?? endpoint,
            ),
            accessToken: new TokenMaterial({
              secretId: SecretId.make(oauthSecretId(connectionId, "access-token")),
              name: "OAuth Access Token",
              value: exchangeResult.tokens.access_token,
            }),
            refreshToken: exchangeResult.tokens.refresh_token
              ? new TokenMaterial({
                  secretId: SecretId.make(oauthSecretId(connectionId, "refresh-token")),
                  name: "OAuth Refresh Token",
                  value: exchangeResult.tokens.refresh_token,
                })
              : null,
            expiresAt: connectionExpiresAt,
            oauthScope: exchangeResult.tokens.scope ?? null,
            providerState: Schema.encodeSync(OAuthProviderStateSchema)(
              providerState,
            ) as Record<string, unknown>,
          }),
        )
        .pipe(
          Effect.mapError(
            (err) =>
              new OAuthCompleteError({
                message: `Failed to mint connection: ${
                  err instanceof Error ? err.message : String(err)
                }`,

              }),
          ),
        );

      yield* deleteSession;

      return {
        connectionId,
        expiresAt: connectionExpiresAt,
        scope: exchangeResult.tokens.scope ?? null,
      };
    });

  interface ExchangeResult {
    readonly tokens: {
      readonly access_token: string;
      readonly refresh_token?: string;
      readonly expires_in?: number;
      readonly scope?: string;
      readonly token_type?: string;
    };
    readonly endpointForDisplay: string | null;
  }

  const exchangeDynamicDcr = (
    payload: Extract<OAuthSessionPayload, { kind: "dynamic-dcr" }>,
    code: string,
    redirectUrl: string,
  ): Effect.Effect<ExchangeResult, OAuthCompleteError> =>
    Effect.gen(function* () {
      const md = payload.authorizationServerMetadata as {
        token_endpoint: string;
        issuer?: string;
        id_token_signing_alg_values_supported?: string[];
      };
      const ci = payload.clientInformation as {
        client_id: string;
        client_secret?: string;
        token_endpoint_auth_method?: string;
      };
      const tokens = yield* exchangeAuthorizationCode({
        tokenUrl: md.token_endpoint,
        issuerUrl: md.issuer,
        clientId: ci.client_id,
        clientSecret: ci.client_secret ?? undefined,
        redirectUrl,
        codeVerifier: payload.codeVerifier,
        code,
        idTokenSigningAlgValuesSupported:
          md.id_token_signing_alg_values_supported,
        clientAuth:
          ci.token_endpoint_auth_method === "client_secret_basic"
            ? "basic"
            : "body",
      }).pipe(
        Effect.mapError(
          (err) =>
            new OAuthCompleteError({
              message: `Token exchange failed: ${err.message}`,
              code: err.error,

            }),
        ),
      );
      return {
        tokens,
        endpointForDisplay: payload.authorizationServerUrl,
      };
    });

  const exchangeAuthorizationCodeStrategy = (
    payload: Extract<OAuthSessionPayload, { kind: "authorization-code" }>,
    code: string,
    redirectUrl: string,
  ): Effect.Effect<
    ExchangeResult,
    OAuthCompleteError | StorageFailure
  > =>
    Effect.gen(function* () {
      const clientId = yield* deps.secretsGet(payload.clientIdSecretId);
      if (clientId === null) {
        return yield* Effect.fail(
          new OAuthCompleteError({
            message: `client_id secret "${payload.clientIdSecretId}" not found`,
          }),
        );
      }
      const clientSecret = payload.clientSecretSecretId
        ? yield* deps.secretsGet(payload.clientSecretSecretId)
        : null;
      if (payload.clientSecretSecretId && clientSecret === null) {
        return yield* Effect.fail(
          new OAuthCompleteError({
            message: `client_secret secret "${payload.clientSecretSecretId}" not found`,
          }),
        );
      }

      const tokens = yield* exchangeAuthorizationCode({
        tokenUrl: payload.tokenEndpoint,
        issuerUrl: payload.issuerUrl,
        clientId,
        clientSecret: clientSecret ?? undefined,
        redirectUrl,
        codeVerifier: payload.codeVerifier,
        code,
        clientAuth: payload.clientAuth,
      }).pipe(
        Effect.mapError(
          (err) =>
            new OAuthCompleteError({
              message: `Token exchange failed: ${err.message}`,
              code: err.error,

            }),
        ),
      );
      return {
        tokens,
        endpointForDisplay: null,
      };
    });

  const cancel = (sessionId: string): Effect.Effect<void, StorageFailure> =>
    Effect.gen(function* () {
      const row = yield* deps.adapter.findOne({
        model: "oauth2_session",
        where: [{ field: "id", value: sessionId }],
      });
      if (!row) return;
      yield* deps.adapter.delete({
        model: "oauth2_session",
        where: [
          { field: "id", value: sessionId },
          { field: "scope_id", value: row.scope_id as string },
        ],
      });
    });

  // -------------------------------------------------------------------
  // Canonical connection provider — refresh handler
  // -------------------------------------------------------------------
  const connectionProvider: ConnectionProvider = {
    key: OAUTH2_PROVIDER_KEY,
    refresh: (input: ConnectionRefreshInput) =>
      Effect.gen(function* () {
        if (!input.providerState) {
          return yield* new ConnectionRefreshError({
            connectionId: input.connectionId,
            message: "oauth2 connection missing providerState",
          });
        }
        const state = yield* Effect.try({
          try: () => decodeProviderState(input.providerState),
          catch: (cause) =>
            new ConnectionRefreshError({
              connectionId: input.connectionId,
              message: `oauth2 providerState is malformed: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
              cause,
            }),
        });

        if (state.kind !== "client-credentials" && !input.refreshToken) {
          return yield* new ConnectionRefreshError({
            connectionId: input.connectionId,
            message: "oauth2 connection has no refresh token",
            reauthRequired: true,
          });
        }

        // Resolve client credentials depending on strategy. Dynamic-DCR
        // embeds `client_id` inline (DCR-minted public client);
        // authorization-code reads it off a secret; client-credentials
        // reads both id + secret.
        const { clientId, clientSecret } = yield* (() => {
          switch (state.kind) {
            case "dynamic-dcr":
              return Effect.gen(function* () {
                const csec = state.clientSecretSecretId
                  ? yield* deps
                      .secretsGet(state.clientSecretSecretId)
                      .pipe(
                        Effect.mapError(
                          (cause) =>
                            new ConnectionRefreshError({
                              connectionId: input.connectionId,
                              message: `Failed to resolve DCR client_secret: ${
                                cause instanceof Error
                                  ? cause.message
                                  : String(cause)
                              }`,
                              cause,
                            }),
                        ),
                      )
                  : null;
                if (state.clientSecretSecretId && csec === null) {
                  return yield* new ConnectionRefreshError({
                    connectionId: input.connectionId,
                    message: `client_secret secret "${state.clientSecretSecretId}" not found`,
                    reauthRequired: true,
                  });
                }
                return { clientId: state.clientId, clientSecret: csec };
              });
            case "authorization-code":
            case "client-credentials":
              return Effect.gen(function* () {
                const cid = yield* deps
                  .secretsGet(state.clientIdSecretId)
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new ConnectionRefreshError({
                          connectionId: input.connectionId,
                          message: `Failed to resolve client_id secret: ${
                            cause instanceof Error
                              ? cause.message
                              : String(cause)
                          }`,
                          cause,
                        }),
                    ),
                  );
                if (cid === null) {
                  return yield* new ConnectionRefreshError({
                    connectionId: input.connectionId,
                    message: `client_id secret "${state.clientIdSecretId}" not found`,
                    reauthRequired: true,
                  });
                }
                const csec = state.clientSecretSecretId
                  ? yield* deps
                      .secretsGet(state.clientSecretSecretId)
                      .pipe(
                        Effect.mapError(
                          (cause) =>
                            new ConnectionRefreshError({
                              connectionId: input.connectionId,
                              message: `Failed to resolve client_secret: ${
                                cause instanceof Error
                                  ? cause.message
                                  : String(cause)
                              }`,
                              cause,
                            }),
                        ),
                      )
                  : null;
                if (state.clientSecretSecretId && csec === null) {
                  return yield* new ConnectionRefreshError({
                    connectionId: input.connectionId,
                    message: `client_secret secret "${state.clientSecretSecretId}" not found`,
                    reauthRequired: true,
                  });
                }
                return { clientId: cid, clientSecret: csec };
              });
          }
        })();

        const tokenEndpoint = yield* (() => {
          if (state.tokenEndpoint) return Effect.succeed(state.tokenEndpoint);
          if (
            state.kind === "dynamic-dcr" &&
            state.authorizationServerUrl
          ) {
            return discoverAuthorizationServerMetadata(
              state.authorizationServerUrl,
            ).pipe(
              Effect.flatMap((metadata) =>
                metadata?.metadata.token_endpoint
                  ? Effect.succeed(metadata.metadata.token_endpoint)
                  : Effect.fail(
                      new ConnectionRefreshError({
                        connectionId: input.connectionId,
                        message:
                          "oauth2 legacy MCP providerState is missing token endpoint",
                        reauthRequired: true,
                      }),
                    ),
              ),
              Effect.mapError((cause) =>
                cause instanceof ConnectionRefreshError
                  ? cause
                  : new ConnectionRefreshError({
                      connectionId: input.connectionId,
                      message:
                        "Failed to discover token endpoint for legacy MCP OAuth connection",
                      reauthRequired: true,
                      cause,
                    }),
              ),
            );
          }
          return Effect.fail(
            new ConnectionRefreshError({
              connectionId: input.connectionId,
              message: "oauth2 providerState is missing token endpoint",
              reauthRequired: true,
            }),
          );
        })();

        const tokens = yield* (state.kind === "client-credentials"
          ? exchangeClientCredentials({
              tokenUrl: tokenEndpoint,
              clientId,
              clientSecret: clientSecret ?? "",
              scopes: state.scopes,
              scopeSeparator: state.scopeSeparator,
              clientAuth: state.clientAuth,
            })
          : refreshAccessToken({
              tokenUrl: tokenEndpoint,
              issuerUrl:
                state.kind === "dynamic-dcr" || state.kind === "authorization-code"
                  ? (state.issuerUrl ?? undefined)
                  : undefined,
              clientId,
              clientSecret: clientSecret ?? undefined,
              refreshToken: input.refreshToken!,
              scopes:
                state.kind === "dynamic-dcr" || state.kind === "authorization-code"
                  ? state.scopes
                  : undefined,
              scopeSeparator:
                state.kind === "dynamic-dcr" || state.kind === "authorization-code"
                  ? state.scopeSeparator
                  : undefined,
              clientAuth: state.clientAuth,
              idTokenSigningAlgValuesSupported:
                state.kind === "dynamic-dcr"
                  ? state.idTokenSigningAlgValuesSupported
                  : undefined,
            })).pipe(
          Effect.mapError(
            (err) =>
              new ConnectionRefreshError({
                connectionId: input.connectionId,
                message: `OAuth refresh failed: ${err.message}`,
                // Terminal RFC 6749 §5.2 errors mean retrying won't heal it.
                reauthRequired: err.error
                  ? terminalRefreshErrors.has(err.error)
                  : false,

              }),
          ),
        );

        const expiresAt =
          typeof tokens.expires_in === "number"
            ? now() + tokens.expires_in * 1000
            : null;

        const result: ConnectionRefreshResult = {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt,
          oauthScope: tokens.scope ?? input.oauthScope,
          providerState: Schema.encodeSync(OAuthProviderStateSchema)({
            ...state,
            tokenEndpoint,
            scope: tokens.scope ?? state.scope,
          }) as Record<string, unknown>,
        };
        return result;
      }),
  };

  const service: OAuthService = { probe, start, complete, cancel };

  return { service, connectionProvider };
};

const safeHostname = (value: string | null): string | null => {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
};
