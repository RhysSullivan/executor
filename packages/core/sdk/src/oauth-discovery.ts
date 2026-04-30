// ---------------------------------------------------------------------------
// OAuth 2.0 metadata discovery + DCR.
//
// The token-endpoint helpers in `./oauth-helpers.ts` assume the caller
// already knows the authorization/token URLs and client_id — that's
// fine for static integrations (Google, a specific OpenAPI server).
// The zero-config case — user pastes an arbitrary endpoint URL and we
// figure out its OAuth configuration — needs three more building blocks:
//
//   - RFC 9728 Protected Resource Metadata (/.well-known/oauth-protected-resource)
//   - RFC 8414 Authorization Server Metadata (/.well-known/oauth-authorization-server,
//     with OIDC /.well-known/openid-configuration as fallback)
//   - RFC 7591 Dynamic Client Registration (POST `registration_endpoint`)
//
// `oauth4webapi` covers (2) and (3); (1) is MCP-spec-only and not yet in
// the library, so we keep a 30-line hand-rolled probe. A convenience
// `beginDynamicAuthorization` chains all three into the single call
// callers actually need.
// ---------------------------------------------------------------------------

import { Data, Effect, ParseResult, Schema } from "effect";
import * as oauth from "oauth4webapi";

import {
  OAUTH2_DEFAULT_TIMEOUT_MS,
  buildAuthorizationUrl,
  createPkceCodeChallenge,
  createPkceCodeVerifier,
} from "./oauth-helpers";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Separate tag from `OAuth2Error` so callers can distinguish discovery
 *  / DCR failures (happen once, before any token round-trips) from
 *  token-endpoint failures. A plugin's refresh path should never have
 *  to inspect error messages to tell "metadata drifted, re-discover"
 *  apart from "refresh token is no longer honoured". */
export class OAuthDiscoveryError extends Data.TaggedError(
  "OAuthDiscoveryError",
)<{
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

const discoveryError = (
  message: string,
  options: { status?: number; cause?: unknown } = {},
): OAuthDiscoveryError =>
  new OAuthDiscoveryError({
    message,
    status: options.status,
    cause: options.cause,
  });

// ---------------------------------------------------------------------------
// Schemas (narrow structural parsing — the RFCs leave many fields
// optional; we validate only the subset consumers read)
// ---------------------------------------------------------------------------

const StringArray = Schema.Array(Schema.String);

export const OAuthProtectedResourceMetadataSchema = Schema.Struct({
  resource: Schema.optional(Schema.String),
  authorization_servers: Schema.optional(StringArray),
  scopes_supported: Schema.optional(StringArray),
  bearer_methods_supported: Schema.optional(StringArray),
  resource_documentation: Schema.optional(Schema.String),
}).pipe(Schema.annotations({ identifier: "OAuthProtectedResourceMetadata" }));
export type OAuthProtectedResourceMetadata =
  typeof OAuthProtectedResourceMetadataSchema.Type;

export const OAuthAuthorizationServerMetadataSchema = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.optional(Schema.String),
  scopes_supported: Schema.optional(StringArray),
  response_types_supported: Schema.optional(StringArray),
  grant_types_supported: Schema.optional(StringArray),
  code_challenge_methods_supported: Schema.optional(StringArray),
  token_endpoint_auth_methods_supported: Schema.optional(StringArray),
  revocation_endpoint: Schema.optional(Schema.String),
  introspection_endpoint: Schema.optional(Schema.String),
  userinfo_endpoint: Schema.optional(Schema.String),
  id_token_signing_alg_values_supported: Schema.optional(StringArray),
}).pipe(Schema.annotations({ identifier: "OAuthAuthorizationServerMetadata" }));
export type OAuthAuthorizationServerMetadata =
  typeof OAuthAuthorizationServerMetadataSchema.Type;

export type DynamicClientMetadata = {
  readonly client_name?: string;
  readonly redirect_uris: readonly string[];
  readonly grant_types?: readonly string[];
  readonly response_types?: readonly string[];
  readonly token_endpoint_auth_method?:
    | "none"
    | "client_secret_basic"
    | "client_secret_post"
    | "private_key_jwt";
  readonly scope?: string;
  readonly application_type?: "web" | "native";
  readonly client_uri?: string;
  readonly logo_uri?: string;
  readonly contacts?: readonly string[];
  readonly software_id?: string;
  readonly software_version?: string;
  /** Escape hatch for provider-specific extensions; merged last. */
  readonly extra?: Readonly<Record<string, unknown>>;
};

export const OAuthClientInformationSchema = Schema.Struct({
  client_id: Schema.String,
  client_secret: Schema.optional(Schema.String),
  client_id_issued_at: Schema.optional(Schema.Number),
  client_secret_expires_at: Schema.optional(Schema.Number),
  registration_access_token: Schema.optional(Schema.String),
  registration_client_uri: Schema.optional(Schema.String),
  token_endpoint_auth_method: Schema.optional(Schema.String),
  grant_types: Schema.optional(StringArray),
  response_types: Schema.optional(StringArray),
  redirect_uris: Schema.optional(StringArray),
  client_name: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
}).pipe(Schema.annotations({ identifier: "OAuthClientInformation" }));
export type OAuthClientInformation = typeof OAuthClientInformationSchema.Type;

const decodeResourceMetadata = Schema.decodeUnknown(
  OAuthProtectedResourceMetadataSchema,
);
const decodeAuthServerMetadata = Schema.decodeUnknown(
  OAuthAuthorizationServerMetadataSchema,
);
const decodeClientInformation = Schema.decodeUnknown(
  OAuthClientInformationSchema,
);

export interface DiscoveryRequestOptions {
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Abort the request after this many ms. Default 20000. */
  readonly timeoutMs?: number;
  /** Send `MCP-Protocol-Version: <value>` on every request. Harmless
   *  for non-MCP servers; required by the MCP authorization spec. */
  readonly mcpProtocolVersion?: string;
  /** Credentials needed to reach the protected resource itself. These
   *  are intentionally used only for resource-side probes, never for
   *  authorization-server metadata, DCR, authorization, or token calls. */
  readonly resourceHeaders?: Readonly<Record<string, string>>;
  readonly resourceQueryParams?: Readonly<Record<string, string>>;
}

const MCP_PROTOCOL_VERSION_HEADER = "mcp-protocol-version";

const isLoopbackHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") return false;
    const hostname = url.hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "0.0.0.0" ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      hostname.startsWith("127.")
    );
  } catch {
    return false;
  }
};

const oauth4webapiOptions = (
  options: DiscoveryRequestOptions,
  targetUrl?: string,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (options.fetch) (out as { [customFetch]?: typeof fetch })[customFetch] = options.fetch;
  if (targetUrl && isLoopbackHttpUrl(targetUrl)) {
    (out as { [oauth.allowInsecureRequests]?: boolean })[
      oauth.allowInsecureRequests
    ] = true;
  }
  const signal = AbortSignal.timeout(options.timeoutMs ?? OAUTH2_DEFAULT_TIMEOUT_MS);
  out.signal = signal;
  if (options.mcpProtocolVersion) {
    out.headers = new Headers({
      [MCP_PROTOCOL_VERSION_HEADER]: options.mcpProtocolVersion,
    });
  }
  return out;
};

// oauth4webapi's custom-fetch symbol — imported lazily so dropping the
// library (unlikely but fine) doesn't leave a dangling symbol reference.
const customFetch = Symbol.for("oauth4webapi.customFetch");

// ---------------------------------------------------------------------------
// RFC 9728 — Protected Resource Metadata
//
// Not covered by `oauth4webapi`. Hand-rolled probe: try the path-scoped
// well-known first, then the origin-scoped fallback.
// ---------------------------------------------------------------------------

const buildResourceMetadataUrls = (resourceUrl: string): string[] => {
  const url = new URL(resourceUrl);
  const origin = `${url.protocol}//${url.host}`;
  const path = url.pathname.replace(/\/+$/, "");
  const urls: string[] = [];
  if (path && path !== "/") {
    urls.push(`${origin}/.well-known/oauth-protected-resource${path}`);
  }
  urls.push(`${origin}/.well-known/oauth-protected-resource`);
  return urls;
};

const withResourceQueryParams = (
  url: string,
  queryParams: Readonly<Record<string, string>> | undefined,
): string => {
  if (!queryParams || Object.keys(queryParams).length === 0) return url;
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(queryParams)) {
    parsed.searchParams.set(key, value);
  }
  return parsed.toString();
};

export const discoverProtectedResourceMetadata = (
  resourceUrl: string,
  options: DiscoveryRequestOptions = {},
): Effect.Effect<
  | { readonly metadataUrl: string; readonly metadata: OAuthProtectedResourceMetadata }
  | null,
  OAuthDiscoveryError
> =>
  Effect.gen(function* () {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const timeoutMs = options.timeoutMs ?? OAUTH2_DEFAULT_TIMEOUT_MS;
    for (const url of buildResourceMetadataUrls(resourceUrl)) {
      const result = yield* Effect.tryPromise({
        try: async () => {
          const requestUrl = withResourceQueryParams(url, options.resourceQueryParams);
          const headers: Record<string, string> = {
            ...options.resourceHeaders,
            accept: "application/json",
          };
          if (options.mcpProtocolVersion) {
            headers[MCP_PROTOCOL_VERSION_HEADER] = options.mcpProtocolVersion;
          }
          const response = await fetchImpl(requestUrl, {
            method: "GET",
            headers,
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (response.status === 404 || response.status === 405) return "skip" as const;
          if (response.status < 200 || response.status >= 300) {
            return { status: response.status } as const;
          }
          const text = await response.text();
          if (text.length === 0) return "skip" as const;
          return { status: response.status, body: JSON.parse(text) } as const;
        },
        catch: (cause) =>
          discoveryError(
            `Failed to fetch ${url}: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
          ),
      });
      if (result === "skip") continue;
      if (!("body" in result)) {
        return yield* Effect.fail(
          discoveryError(
            `Protected resource metadata returned status ${result.status}`,
            { status: result.status },
          ),
        );
      }
      const metadata = yield* decodeResourceMetadata(result.body).pipe(
        Effect.mapError(
          (err) =>
            new OAuthDiscoveryError({
              message: `Protected resource metadata is malformed: ${
                err instanceof ParseResult.ParseError ? err.message : String(err)
              }`,
              cause: err,
            }),
        ),
      );
      return { metadataUrl: url, metadata };
    }
    return null;
  });

// ---------------------------------------------------------------------------
// RFC 8414 + OIDC Discovery — Authorization Server Metadata
//
// Delegates to `oauth4webapi.discoveryRequest` + `processDiscoveryResponse`.
// The library only probes one `.well-known` variant per call; we try
// RFC 8414 (`oauth2`) first and fall back to OIDC Discovery.
// ---------------------------------------------------------------------------

const wellKnownUrlFor = (
  issuerOrigin: string,
  algorithm: "oauth2" | "oidc",
  issuerPath: string,
): string => {
  // Mirrors the library's own well-known composition so the URL we
  // surface matches what was actually fetched.
  const suffix = algorithm === "oauth2"
    ? "oauth-authorization-server"
    : "openid-configuration";
  return issuerPath && issuerPath !== "/"
    ? `${issuerOrigin}/.well-known/${suffix}${issuerPath}`
    : `${issuerOrigin}/.well-known/${suffix}`;
};

export const discoverAuthorizationServerMetadata = (
  issuer: string,
  options: DiscoveryRequestOptions = {},
): Effect.Effect<
  | {
      readonly metadataUrl: string;
      readonly metadata: OAuthAuthorizationServerMetadata;
    }
  | null,
  OAuthDiscoveryError
> =>
  Effect.gen(function* () {
    const issuerUrl = new URL(issuer);
    const issuerOrigin = `${issuerUrl.protocol}//${issuerUrl.host}`;
    const issuerPath = issuerUrl.pathname.replace(/\/+$/, "");

    for (const algorithm of ["oauth2", "oidc"] as const) {
      const result = yield* Effect.tryPromise({
        try: async () => {
          const response = await oauth.discoveryRequest(issuerUrl, {
            algorithm,
            ...oauth4webapiOptions(options, issuer),
          });
          if (response.status === 404 || response.status === 405) {
            return null;
          }
          const as = await oauth.processDiscoveryResponse(issuerUrl, response);
          return {
            metadataUrl: wellKnownUrlFor(issuerOrigin, algorithm, issuerPath),
            raw: as,
          };
        },
        catch: (cause) => {
          if (cause instanceof OAuthDiscoveryError) return cause;
          return discoveryError(
            `Discovery (${algorithm}) failed for ${issuer}: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
            { cause },
          );
        },
      }).pipe(
        // If one algorithm fails mid-roundtrip (network, parse, issuer
        // mismatch) we still want to try the other before giving up.
        Effect.either,
      );

      if (result._tag === "Left") continue;
      if (result.right === null) continue;

      const metadata = yield* decodeAuthServerMetadata(result.right.raw).pipe(
        Effect.mapError(
          (err) =>
            new OAuthDiscoveryError({
              message: `Authorization server metadata is malformed: ${
                err instanceof ParseResult.ParseError ? err.message : String(err)
              }`,
              cause: err,
            }),
        ),
      );
      return { metadataUrl: result.right.metadataUrl, metadata };
    }
    return null;
  });

// ---------------------------------------------------------------------------
// RFC 7591 — Dynamic Client Registration
//
// Delegates to `oauth4webapi.dynamicClientRegistrationRequest` +
// `processDynamicClientRegistrationResponse`.
// ---------------------------------------------------------------------------

export interface RegisterDynamicClientInput {
  readonly registrationEndpoint: string;
  readonly metadata: DynamicClientMetadata;
  readonly initialAccessToken?: string | null;
}

const asForDcr = (
  registrationEndpoint: string,
): oauth.AuthorizationServer => {
  const url = new URL(registrationEndpoint);
  return {
    issuer: `${url.protocol}//${url.host}`,
    registration_endpoint: registrationEndpoint,
  };
};

export const registerDynamicClient = (
  input: RegisterDynamicClientInput,
  options: DiscoveryRequestOptions = {},
): Effect.Effect<OAuthClientInformation, OAuthDiscoveryError> =>
  Effect.tryPromise({
    try: async () => {
      const as = asForDcr(input.registrationEndpoint);
      const m = input.metadata;
      const clientMetadata: Record<string, unknown> = {
        redirect_uris: [...m.redirect_uris],
      };
      if (m.client_name !== undefined) clientMetadata.client_name = m.client_name;
      if (m.grant_types !== undefined) clientMetadata.grant_types = [...m.grant_types];
      if (m.response_types !== undefined) clientMetadata.response_types = [...m.response_types];
      if (m.token_endpoint_auth_method !== undefined) {
        clientMetadata.token_endpoint_auth_method = m.token_endpoint_auth_method;
      }
      if (m.scope !== undefined) clientMetadata.scope = m.scope;
      if (m.application_type !== undefined) clientMetadata.application_type = m.application_type;
      if (m.client_uri !== undefined) clientMetadata.client_uri = m.client_uri;
      if (m.logo_uri !== undefined) clientMetadata.logo_uri = m.logo_uri;
      if (m.contacts !== undefined) clientMetadata.contacts = [...m.contacts];
      if (m.software_id !== undefined) clientMetadata.software_id = m.software_id;
      if (m.software_version !== undefined) clientMetadata.software_version = m.software_version;
      if (m.extra) for (const [k, v] of Object.entries(m.extra)) clientMetadata[k] = v;

      const reqOptions: Record<string, unknown> = oauth4webapiOptions(options);
      if (isLoopbackHttpUrl(input.registrationEndpoint)) {
        (reqOptions as { [oauth.allowInsecureRequests]?: boolean })[
          oauth.allowInsecureRequests
        ] = true;
      }
      if (input.initialAccessToken) {
        reqOptions.initialAccessToken = input.initialAccessToken;
      }

      const response = await oauth.dynamicClientRegistrationRequest(
        as,
        clientMetadata as Partial<oauth.Client>,
        reqOptions,
      );
      const client = await oauth.processDynamicClientRegistrationResponse(
        response,
      );
      return client as OAuthClientInformation;
    },
    catch: (cause) => {
      // `oauth4webapi` throws `ResponseBodyError` for RFC 6749 error
      // envelopes (carrying `.status`, `.error`, `.error_description`).
      // Preserve the HTTP status + error code so the plugin layer can
      // surface specific failures (`invalid_client_metadata` →
      // `client_metadata is wrong`) without regex-ing the message.
      if (cause instanceof oauth.ResponseBodyError) {
        return discoveryError(
          `Dynamic Client Registration failed: ${cause.error}${
            cause.error_description ? ` — ${cause.error_description}` : ""
          }`,
          { status: cause.status, cause },
        );
      }
      return discoveryError(
        `Dynamic Client Registration failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    },
  }).pipe(
    Effect.flatMap((raw) =>
      decodeClientInformation(raw).pipe(
        Effect.mapError(
          (err) =>
            new OAuthDiscoveryError({
              message: `Dynamic Client Registration response is malformed: ${
                err instanceof ParseResult.ParseError ? err.message : String(err)
              }`,
              cause: err,
            }),
        ),
      ),
    ),
  );

// ---------------------------------------------------------------------------
// Convenience: begin the full dynamic flow in one call
// ---------------------------------------------------------------------------

export interface DynamicAuthorizationState {
  readonly resourceMetadata: OAuthProtectedResourceMetadata | null;
  readonly resourceMetadataUrl: string | null;
  readonly authorizationServerUrl: string;
  readonly authorizationServerMetadataUrl: string;
  readonly authorizationServerMetadata: OAuthAuthorizationServerMetadata;
  readonly clientInformation: OAuthClientInformation;
}

export interface DynamicAuthorizationStartResult {
  readonly authorizationUrl: string;
  readonly codeVerifier: string;
  readonly state: DynamicAuthorizationState;
}

export interface BeginDynamicAuthorizationInput {
  readonly endpoint: string;
  readonly redirectUrl: string;
  /** RFC 6749 `state` — callers typically pass a per-session random id. */
  readonly state: string;
  /** Defaults: `redirect_uris=[redirectUrl]`, `token_endpoint_auth_method="none"`
   *  (public client + PKCE). */
  readonly clientMetadata?: Partial<DynamicClientMetadata>;
  /** Scopes to request. Defaults to `scopes_supported`; omitted if
   *  neither is set. */
  readonly scopes?: readonly string[];
  /** Pre-existing state from a previous flow. When provided, the
   *  matching discovery / DCR step is skipped so multi-user sign-ins
   *  against the same source don't re-pay those costs. */
  readonly previousState?: {
    readonly authorizationServerUrl?: string | null;
    readonly authorizationServerMetadata?: OAuthAuthorizationServerMetadata | null;
    readonly authorizationServerMetadataUrl?: string | null;
    readonly resourceMetadata?: OAuthProtectedResourceMetadata | null;
    readonly resourceMetadataUrl?: string | null;
    readonly clientInformation?: OAuthClientInformation | null;
  };
}

export const beginDynamicAuthorization = (
  input: BeginDynamicAuthorizationInput,
  options: DiscoveryRequestOptions = {},
): Effect.Effect<DynamicAuthorizationStartResult, OAuthDiscoveryError> =>
  Effect.gen(function* () {
    const prior = input.previousState ?? {};

    // Skip the resource-metadata probe when we already know (or can
    // derive) the authorization server URL. Saves two round-trips for
    // every second-and-later user signing into the same source.
    const canSkipResourceDiscovery =
      prior.resourceMetadata !== undefined ||
      !!prior.authorizationServerUrl ||
      !!prior.authorizationServerMetadata;

    const resource = canSkipResourceDiscovery
      ? prior.resourceMetadata
        ? {
            metadata: prior.resourceMetadata,
            metadataUrl: prior.resourceMetadataUrl ?? null,
          }
        : null
      : yield* discoverProtectedResourceMetadata(input.endpoint, options);

    const authorizationServerUrl = (() => {
      if (prior.authorizationServerUrl) return prior.authorizationServerUrl;
      const fromResource =
        resource && resource.metadata.authorization_servers?.[0];
      if (fromResource) return fromResource;
      const u = new URL(input.endpoint);
      return `${u.protocol}//${u.host}`;
    })();

    const authServer =
      prior.authorizationServerMetadata && prior.authorizationServerMetadataUrl
        ? {
            metadata: prior.authorizationServerMetadata,
            metadataUrl: prior.authorizationServerMetadataUrl,
          }
        : yield* discoverAuthorizationServerMetadata(
            authorizationServerUrl,
            options,
          );

    if (!authServer) {
      return yield* Effect.fail(
        discoveryError(
          `No OAuth authorization server metadata at ${authorizationServerUrl}`,
        ),
      );
    }

    const pkceMethods = authServer.metadata.code_challenge_methods_supported ?? [];
    if (pkceMethods.length > 0 && !pkceMethods.includes("S256")) {
      return yield* Effect.fail(
        discoveryError(
          `Authorization server does not support PKCE S256 (advertised: ${pkceMethods.join(", ")})`,
        ),
      );
    }

    const responseTypes = authServer.metadata.response_types_supported ?? [];
    if (responseTypes.length > 0 && !responseTypes.includes("code")) {
      return yield* Effect.fail(
        discoveryError(
          `Authorization server does not support response_type=code (advertised: ${responseTypes.join(", ")})`,
        ),
      );
    }

    const baseClientMetadata: DynamicClientMetadata = {
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_name: "Executor",
      ...(input.clientMetadata ?? {}),
      redirect_uris: input.clientMetadata?.redirect_uris ?? [input.redirectUrl],
    };

    const clientInformation =
      prior.clientInformation ??
      (yield* (() => {
        const reg = authServer.metadata.registration_endpoint;
        if (!reg) {
          return Effect.fail(
            discoveryError(
              "Authorization server does not advertise registration_endpoint — cannot auto-register a client",
            ),
          );
        }
        return registerDynamicClient(
          { registrationEndpoint: reg, metadata: baseClientMetadata },
          options,
        );
      })());

    const codeVerifier = createPkceCodeVerifier();
    const codeChallenge = yield* Effect.promise(() =>
      createPkceCodeChallenge(codeVerifier),
    );
    const scopes = input.scopes ?? authServer.metadata.scopes_supported ?? [];

    const authorizationUrl = buildAuthorizationUrl({
      authorizationUrl: authServer.metadata.authorization_endpoint,
      clientId: clientInformation.client_id,
      redirectUrl: input.redirectUrl,
      scopes,
      state: input.state,
      codeChallenge,
    });

    return {
      authorizationUrl,
      codeVerifier,
      state: {
        resourceMetadata: resource?.metadata ?? null,
        resourceMetadataUrl: resource?.metadataUrl ?? null,
        authorizationServerUrl,
        authorizationServerMetadataUrl: authServer.metadataUrl,
        authorizationServerMetadata: authServer.metadata,
        clientInformation,
      },
    };
  });

export { createPkceCodeChallenge };
