// ---------------------------------------------------------------------------
// @executor/plugin-oauth2/discovery — OAuth 2.0 metadata discovery + DCR.
//
// The helpers in `./index.ts` assume the caller already knows the
// authorization endpoint, token endpoint, and client_id — that's fine for
// static integrations (Google, a specific OpenAPI server). The zero-config
// case — user pastes an arbitrary endpoint URL and we figure out its
// OAuth configuration — needs three more building blocks from the OAuth
// 2.1 / MCP authorization spec:
//
//   - RFC 9728 Protected Resource Metadata  (`.well-known/oauth-protected-resource`)
//     Tells us which authorization servers guard a given resource URL.
//
//   - RFC 8414 Authorization Server Metadata (`.well-known/oauth-authorization-server`)
//     Exposes the AS's endpoints (authorize, token, registration), supported
//     grant types, PKCE methods, scopes, etc. OIDC discovery
//     (`.well-known/openid-configuration`) is probed as a fallback for
//     servers that only publish the OIDC variant.
//
//   - RFC 7591 Dynamic Client Registration (POST `registration_endpoint`)
//     Mints a `client_id` (+ optional `client_secret`) for a public or
//     confidential client — lets a zero-config client go from "just a URL"
//     to "has credentials ready for an authorization code request."
//
// Those three plus the existing PKCE + token-endpoint helpers are enough
// to run the full dynamic flow that the MCP spec requires and that
// OAuth-protected APIs like Railway's backboard advertise. A convenience
// `beginDynamicAuthorization` chains them into the single call callers
// actually need.
// ---------------------------------------------------------------------------

import { Data, Effect, ParseResult, Schema } from "effect";

import {
  OAUTH2_DEFAULT_TIMEOUT_MS,
  buildAuthorizationUrl,
  createPkceCodeChallenge,
  createPkceCodeVerifier,
} from "./oauth-helpers";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Separate tag from `OAuth2Error` so callers can distinguish discovery /
 * DCR failures (happen once, before any token round-trips) from
 * token-endpoint failures. Keeping them split means a plugin's refresh
 * path doesn't have to inspect error messages to tell "metadata drifted,
 * re-discover" apart from "refresh token is no longer honoured".
 */
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
// Schemas (narrow structural parsing — the standards leave many fields
// optional and we only validate the subset the plugins read)
// ---------------------------------------------------------------------------

const StringArray = Schema.Array(Schema.String);

/**
 * RFC 9728 §3.3 Protected Resource Metadata. `authorization_servers` is
 * the only field callers need to continue discovery; the rest surface
 * for logging / future use.
 */
export const OAuthProtectedResourceMetadataSchema = Schema.Struct({
  resource: Schema.optional(Schema.String),
  authorization_servers: Schema.optional(StringArray),
  scopes_supported: Schema.optional(StringArray),
  bearer_methods_supported: Schema.optional(StringArray),
  resource_documentation: Schema.optional(Schema.String),
}).pipe(Schema.annotations({ identifier: "OAuthProtectedResourceMetadata" }));
export type OAuthProtectedResourceMetadata =
  typeof OAuthProtectedResourceMetadataSchema.Type;

/**
 * RFC 8414 §2 Authorization Server Metadata. `issuer`, `authorization_endpoint`,
 * and `token_endpoint` are the only fields strictly required to run the
 * authorization code flow; DCR adds `registration_endpoint`.
 */
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
}).pipe(Schema.annotations({ identifier: "OAuthAuthorizationServerMetadata" }));
export type OAuthAuthorizationServerMetadata =
  typeof OAuthAuthorizationServerMetadataSchema.Type;

/** RFC 7591 client metadata request body (subset we send). */
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
  /**
   * Escape hatch for provider-specific extensions. Values are merged
   * into the request body last, so callers can override any standard
   * field if needed.
   */
  readonly extra?: Readonly<Record<string, unknown>>;
};

/**
 * RFC 7591 §3.2.1 client information response. `client_id` is the only
 * field we require at the schema level; the rest are echoed back for
 * persistence so the provider's refresh path can reuse them without a
 * second discovery round trip.
 */
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

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

const MCP_PROTOCOL_VERSION_HEADER = "mcp-protocol-version";

export interface DiscoveryRequestOptions {
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Abort the request after this many ms. Default 20000. */
  readonly timeoutMs?: number;
  /**
   * Send `MCP-Protocol-Version: <value>` on every request. Harmless for
   * non-MCP servers; required by the MCP authorization spec. Defaults to
   * undefined (header omitted).
   */
  readonly mcpProtocolVersion?: string;
}

const normaliseFetch = (options: DiscoveryRequestOptions): typeof fetch =>
  options.fetch ?? globalThis.fetch;

const fetchJson = (
  url: string,
  options: DiscoveryRequestOptions,
): Effect.Effect<
  { status: number; body: unknown | null },
  OAuthDiscoveryError
> =>
  Effect.tryPromise({
    try: async () => {
      const fetchImpl = normaliseFetch(options);
      const timeoutMs = options.timeoutMs ?? OAUTH2_DEFAULT_TIMEOUT_MS;
      const headers: Record<string, string> = { accept: "application/json" };
      if (options.mcpProtocolVersion) {
        headers[MCP_PROTOCOL_VERSION_HEADER] = options.mcpProtocolVersion;
      }
      const response = await fetchImpl(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      // The well-known paths can 404 on servers that don't publish them —
      // callers downgrade to a fallback or return `null`, so we surface
      // status + body rather than throwing for non-2xx. A truly
      // unreadable body (wire-level JSON parse fail) still fails the
      // Effect, so callers don't silently treat garbage as "no metadata".
      if (response.status === 404 || response.status === 405) {
        return { status: response.status, body: null };
      }
      const text = await response.text();
      if (text.length === 0) {
        return { status: response.status, body: null };
      }
      try {
        return { status: response.status, body: JSON.parse(text) };
      } catch (cause) {
        throw new OAuthDiscoveryError({
          message: `Non-JSON response from ${url} (status ${response.status})`,
          status: response.status,
          cause,
        });
      }
    },
    catch: (cause) =>
      cause instanceof OAuthDiscoveryError
        ? cause
        : discoveryError(
            `Failed to fetch ${url}: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
            { cause },
          ),
  });

// ---------------------------------------------------------------------------
// RFC 9728 — Protected Resource Metadata
// ---------------------------------------------------------------------------

/**
 * Build the well-known metadata URL for a protected resource. Per RFC
 * 9728 §3.1 the document lives at `/.well-known/oauth-protected-resource`
 * on the resource's origin. Path-scoped resources (e.g.
 * `https://api.example.com/v2/graphql`) get the path appended after the
 * well-known segment so they can publish per-resource metadata.
 */
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

/**
 * Fetch RFC 9728 Protected Resource Metadata for the given resource URL.
 * Returns `null` when no metadata is published (every probed well-known
 * URL 404s). Fails only on transport / JSON / schema errors.
 */
export const discoverProtectedResourceMetadata = (
  resourceUrl: string,
  options: DiscoveryRequestOptions = {},
): Effect.Effect<
  | { readonly metadataUrl: string; readonly metadata: OAuthProtectedResourceMetadata }
  | null,
  OAuthDiscoveryError
> =>
  Effect.gen(function* () {
    const urls = buildResourceMetadataUrls(resourceUrl);
    for (const url of urls) {
      const response = yield* fetchJson(url, options);
      if (response.status === 404 || response.body === null) continue;
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(
          discoveryError(
            `Protected resource metadata returned status ${response.status}`,
            { status: response.status },
          ),
        );
      }
      const metadata = yield* decodeResourceMetadata(response.body).pipe(
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
// RFC 8414 — Authorization Server Metadata
// ---------------------------------------------------------------------------

/**
 * Build the candidate metadata URLs for an authorization server. RFC
 * 8414 §3.1 mandates `/.well-known/oauth-authorization-server`; OIDC
 * Discovery publishes `/.well-known/openid-configuration` — some servers
 * publish only the latter, so we probe both.
 */
const buildAuthServerMetadataUrls = (issuer: string): string[] => {
  const url = new URL(issuer);
  const origin = `${url.protocol}//${url.host}`;
  const path = url.pathname.replace(/\/+$/, "");
  const urls = new Set<string>();
  if (path && path !== "/") {
    urls.add(`${origin}/.well-known/oauth-authorization-server${path}`);
    urls.add(`${origin}${path}/.well-known/oauth-authorization-server`);
    urls.add(`${origin}/.well-known/openid-configuration${path}`);
    urls.add(`${origin}${path}/.well-known/openid-configuration`);
  }
  urls.add(`${origin}/.well-known/oauth-authorization-server`);
  urls.add(`${origin}/.well-known/openid-configuration`);
  return [...urls];
};

/**
 * Fetch RFC 8414 Authorization Server Metadata for the given issuer URL.
 * Falls back to OIDC Discovery if the RFC 8414 well-known 404s. Returns
 * `null` when neither document is published.
 */
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
    const urls = buildAuthServerMetadataUrls(issuer);
    for (const url of urls) {
      const response = yield* fetchJson(url, options);
      if (response.status === 404 || response.body === null) continue;
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(
          discoveryError(
            `Authorization server metadata returned status ${response.status}`,
            { status: response.status },
          ),
        );
      }
      const metadata = yield* decodeAuthServerMetadata(response.body).pipe(
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
      return { metadataUrl: url, metadata };
    }
    return null;
  });

// ---------------------------------------------------------------------------
// RFC 7591 — Dynamic Client Registration
// ---------------------------------------------------------------------------

export interface RegisterDynamicClientInput {
  readonly registrationEndpoint: string;
  readonly metadata: DynamicClientMetadata;
  readonly initialAccessToken?: string | null;
}

/**
 * POST to the authorization server's `registration_endpoint` with RFC
 * 7591 client metadata, returning the freshly issued client information.
 * Plugins should persist the full response so the refresh path can reuse
 * `client_id` (and `client_secret`, if the AS issued one) without
 * re-registering.
 */
export const registerDynamicClient = (
  input: RegisterDynamicClientInput,
  options: DiscoveryRequestOptions = {},
): Effect.Effect<OAuthClientInformation, OAuthDiscoveryError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: async () => {
        const fetchImpl = normaliseFetch(options);
        const timeoutMs = options.timeoutMs ?? OAUTH2_DEFAULT_TIMEOUT_MS;
        const body: Record<string, unknown> = {
          redirect_uris: input.metadata.redirect_uris,
        };
        const m = input.metadata;
        if (m.client_name !== undefined) body.client_name = m.client_name;
        if (m.grant_types !== undefined) body.grant_types = m.grant_types;
        if (m.response_types !== undefined) body.response_types = m.response_types;
        if (m.token_endpoint_auth_method !== undefined) {
          body.token_endpoint_auth_method = m.token_endpoint_auth_method;
        }
        if (m.scope !== undefined) body.scope = m.scope;
        if (m.application_type !== undefined) body.application_type = m.application_type;
        if (m.client_uri !== undefined) body.client_uri = m.client_uri;
        if (m.logo_uri !== undefined) body.logo_uri = m.logo_uri;
        if (m.contacts !== undefined) body.contacts = m.contacts;
        if (m.software_id !== undefined) body.software_id = m.software_id;
        if (m.software_version !== undefined) body.software_version = m.software_version;
        if (m.extra) {
          for (const [k, v] of Object.entries(m.extra)) body[k] = v;
        }
        const headers: Record<string, string> = {
          "content-type": "application/json",
          accept: "application/json",
        };
        if (input.initialAccessToken) {
          headers.authorization = `Bearer ${input.initialAccessToken}`;
        }
        if (options.mcpProtocolVersion) {
          headers[MCP_PROTOCOL_VERSION_HEADER] = options.mcpProtocolVersion;
        }
        return fetchImpl(input.registrationEndpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      },
      catch: (cause) =>
        discoveryError(
          `Failed to POST registration: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          { cause },
        ),
    });

    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: (cause) =>
        discoveryError(
          `Failed to read registration response: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          { cause },
        ),
    });

    if (!response.ok) {
      return yield* Effect.fail(
        discoveryError(
          `Dynamic Client Registration failed (status ${response.status}): ${text || "<empty body>"}`,
          { status: response.status },
        ),
      );
    }

    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (cause) =>
        discoveryError("Dynamic Client Registration response is not JSON", {
          cause,
        }),
    });

    return yield* decodeClientInformation(parsed).pipe(
      Effect.mapError(
        (err) =>
          new OAuthDiscoveryError({
            message: `Dynamic Client Registration response is malformed: ${
              err instanceof ParseResult.ParseError ? err.message : String(err)
            }`,
            cause: err,
          }),
      ),
    );
  });

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
  /** The resource URL the caller wants to access (the one the user
   *  pasted into the onboarding UI). */
  readonly endpoint: string;
  /** OAuth redirect URL the authorization code will return to. */
  readonly redirectUrl: string;
  /** Value of the RFC 6749 `state` parameter. Callers typically pass a
   *  per-session random id. */
  readonly state: string;
  /** Client metadata to pass to DCR. `redirect_uris` defaults to
   *  `[redirectUrl]`; `token_endpoint_auth_method` defaults to `"none"`
   *  (public client + PKCE). */
  readonly clientMetadata?: Partial<DynamicClientMetadata>;
  /** Scopes to request. Defaults to whatever the AS advertises in
   *  `scopes_supported`; if that's also empty we omit the scope param. */
  readonly scopes?: readonly string[];
  /**
   * Pre-existing discovery + DCR state from a previous flow. When
   * provided, we skip both steps and reuse the stored endpoints + client
   * information. Plugins use this for multi-user flows: the first user
   * to sign in pays the discovery + DCR cost, subsequent users reuse the
   * persisted state.
   */
  readonly previousState?: {
    readonly authorizationServerUrl?: string | null;
    readonly authorizationServerMetadata?: OAuthAuthorizationServerMetadata | null;
    readonly authorizationServerMetadataUrl?: string | null;
    readonly resourceMetadata?: OAuthProtectedResourceMetadata | null;
    readonly resourceMetadataUrl?: string | null;
    readonly clientInformation?: OAuthClientInformation | null;
  };
}

/**
 * Walk the full RFC 9728 → RFC 8414 → RFC 7591 → PKCE chain for a
 * resource URL and produce an authorization URL ready to send to the
 * user's browser. Each step is skipped when the caller already has its
 * output (`previousState`), which keeps the second user's first sign-in
 * from redoing DCR or metadata fetches.
 *
 * Failures surface as `OAuthDiscoveryError`. The only shape-level guard
 * this helper enforces (beyond individual fetches succeeding) is "the
 * AS must support `response_types=code` and `code_challenge_methods=S256`" —
 * if the metadata advertises anything else we surface it loudly rather
 * than silently producing a URL the AS will reject.
 */
export const beginDynamicAuthorization = (
  input: BeginDynamicAuthorizationInput,
  options: DiscoveryRequestOptions = {},
): Effect.Effect<DynamicAuthorizationStartResult, OAuthDiscoveryError> =>
  Effect.gen(function* () {
    const prior = input.previousState ?? {};

    // The only output of Step 1 we actually consume downstream is the
    // authorization server URL. When the caller already has that (either
    // stored explicitly, or implicit via `authorizationServerMetadata`),
    // skip the well-known probe entirely — it's two round-trips per
    // sign-in that the second-and-later user would otherwise pay.
    const canSkipResourceDiscovery =
      prior.resourceMetadata !== undefined ||
      !!prior.authorizationServerUrl ||
      !!prior.authorizationServerMetadata;

    // Step 1 — protected resource metadata
    const resource = canSkipResourceDiscovery
      ? prior.resourceMetadata
        ? {
            metadata: prior.resourceMetadata,
            metadataUrl: prior.resourceMetadataUrl ?? null,
          }
        : null
      : yield* discoverProtectedResourceMetadata(input.endpoint, options);

    // Step 2 — authorization server metadata
    const authorizationServerUrl = (() => {
      if (prior.authorizationServerUrl) return prior.authorizationServerUrl;
      const fromResource =
        resource && resource.metadata.authorization_servers?.[0];
      if (fromResource) return fromResource;
      // Fallback: treat the resource URL's origin as the issuer. This
      // is the "self-issuing" deployment pattern — the resource host
      // also publishes the AS metadata document at its own root.
      const u = new URL(input.endpoint);
      return `${u.protocol}//${u.host}`;
    })();

    const authServer =
      prior.authorizationServerMetadata &&
      prior.authorizationServerMetadataUrl
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

    const pkceMethods =
      authServer.metadata.code_challenge_methods_supported ?? [];
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

    // Step 3 — Dynamic Client Registration (if needed)
    const baseClientMetadata: DynamicClientMetadata = {
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_name: "Executor",
      ...(input.clientMetadata ?? {}),
      redirect_uris: input.clientMetadata?.redirect_uris ?? [input.redirectUrl],
    };

    const clientInformation = prior.clientInformation ?? (yield* (() => {
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

    // Step 4 — PKCE + authorization URL
    const codeVerifier = createPkceCodeVerifier();
    const codeChallenge = yield* Effect.promise(() =>
      createPkceCodeChallenge(codeVerifier),
    );
    const scopes =
      input.scopes ?? authServer.metadata.scopes_supported ?? [];

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

// Re-export PKCE challenge so callers don't need to reach into ./index
// just to derive the challenge from the verifier this helper returned.
export { createPkceCodeChallenge };
