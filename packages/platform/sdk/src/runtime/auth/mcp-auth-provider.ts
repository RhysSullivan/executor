import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
  OAuthClientMetadata,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  AuthArtifact,
  McpOAuthAuthArtifactConfig,
  SecretRef,
} from "#schema";
import {
  McpOAuthAuthArtifactConfigJsonSchema,
} from "#schema";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ExecutorStateStoreShape } from "../executor-state-store";
import {
  type DeleteSecretMaterial,
  type ResolveSecretMaterial,
  type SecretMaterialResolveContext,
  type StoreSecretMaterial,
} from "../workspace/secret-material-providers";

const encodeMcpOAuthAuthArtifactConfig = Schema.encodeSync(
  McpOAuthAuthArtifactConfigJsonSchema,
);

const parseJsonObject = <T>(value: string | null): T | undefined => {
  if (value === null) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as T
      : undefined;
  } catch {
    return undefined;
  }
};

const stringifyJsonObject = (value: unknown): string | null =>
  value === null || value === undefined ? null : JSON.stringify(value);

const createClientMetadata = (redirectUrl: string): OAuthClientMetadata => ({
  redirect_uris: [redirectUrl],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  client_name: "Executor Local",
});

const secretRefEquals = (left: SecretRef | null, right: SecretRef | null): boolean =>
  (left?.providerId ?? null) === (right?.providerId ?? null)
  && (left?.handle ?? null) === (right?.handle ?? null);

const cleanupReplacedSecretRefs = (input: {
  deleteSecretMaterial: DeleteSecretMaterial;
  previousAccessToken: SecretRef;
  nextAccessToken: SecretRef;
  previousRefreshToken: SecretRef | null;
  nextRefreshToken: SecretRef | null;
}) =>
  Effect.gen(function* () {
    if (!secretRefEquals(input.previousAccessToken, input.nextAccessToken)) {
      yield* Effect.either(input.deleteSecretMaterial(input.previousAccessToken));
    }

    if (
      input.previousRefreshToken !== null
      && !secretRefEquals(input.previousRefreshToken, input.nextRefreshToken)
    ) {
      yield* Effect.either(input.deleteSecretMaterial(input.previousRefreshToken));
    }
  });

export const createPersistedMcpOAuthSourceAuth = (input: {
  redirectUri: string;
  accessToken: SecretRef;
  refreshToken: SecretRef | null;
  tokenType: string;
  expiresIn: number | null;
  scope: string | null;
  resourceMetadataUrl: string | null;
  authorizationServerUrl: string | null;
  resourceMetadata: unknown;
  authorizationServerMetadata: unknown;
  clientInformation: unknown;
}) => ({
  kind: "mcp_oauth" as const,
  redirectUri: input.redirectUri,
  accessToken: input.accessToken,
  refreshToken: input.refreshToken,
  tokenType: input.tokenType,
  expiresIn: input.expiresIn,
  scope: input.scope,
  resourceMetadataUrl: input.resourceMetadataUrl,
  authorizationServerUrl: input.authorizationServerUrl,
  resourceMetadataJson: stringifyJsonObject(input.resourceMetadata),
  authorizationServerMetadataJson: stringifyJsonObject(input.authorizationServerMetadata),
  clientInformationJson: stringifyJsonObject(input.clientInformation),
});

export const createPersistedMcpAuthProvider = (input: {
  executorState: ExecutorStateStoreShape;
  artifact: AuthArtifact;
  config: McpOAuthAuthArtifactConfig;
  resolveSecretMaterial: ResolveSecretMaterial;
  storeSecretMaterial: StoreSecretMaterial;
  deleteSecretMaterial: DeleteSecretMaterial;
  context?: SecretMaterialResolveContext;
}): OAuthClientProvider => {
  let currentArtifact = input.artifact;
  let currentConfig = input.config;

  const persistConfig = (nextConfig: McpOAuthAuthArtifactConfig) =>
    Effect.gen(function* () {
      const nextArtifact: AuthArtifact = {
        ...currentArtifact,
        configJson: encodeMcpOAuthAuthArtifactConfig(nextConfig),
        updatedAt: Date.now(),
      };
      yield* input.executorState.authArtifacts.upsert(nextArtifact);
      currentArtifact = nextArtifact;
      currentConfig = nextConfig;
    });

  return {
    get redirectUrl() {
      return currentConfig.redirectUri;
    },

    get clientMetadata() {
      return createClientMetadata(currentConfig.redirectUri);
    },

    clientInformation: () =>
      parseJsonObject<OAuthClientInformationMixed>(currentConfig.clientInformationJson),

    saveClientInformation: (clientInformation) =>
      Effect.runPromise(
        persistConfig({
          ...currentConfig,
          clientInformationJson: stringifyJsonObject(clientInformation),
        }),
      ).then(() => undefined),

    tokens: async () => {
      const accessToken = await Effect.runPromise(
        input.resolveSecretMaterial({
          ref: currentConfig.accessToken,
          context: input.context,
        }),
      );
      const refreshToken = currentConfig.refreshToken
        ? await Effect.runPromise(
            input.resolveSecretMaterial({
              ref: currentConfig.refreshToken,
              context: input.context,
            }),
          )
        : undefined;

      return {
        access_token: accessToken,
        token_type: currentConfig.tokenType,
        ...(typeof currentConfig.expiresIn === "number"
          ? { expires_in: currentConfig.expiresIn }
          : {}),
        ...(currentConfig.scope ? { scope: currentConfig.scope } : {}),
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
      } satisfies OAuthTokens;
    },

    saveTokens: (tokens) =>
      Effect.runPromise(Effect.gen(function* () {
        const previousConfig = currentConfig;
        const accessTokenRef = yield* input.storeSecretMaterial({
          purpose: "oauth_access_token",
          value: tokens.access_token,
          name: `${currentArtifact.sourceId} MCP Access Token`,
        });
        const refreshTokenRef = tokens.refresh_token
          ? yield* input.storeSecretMaterial({
              purpose: "oauth_refresh_token",
              value: tokens.refresh_token,
              name: `${currentArtifact.sourceId} MCP Refresh Token`,
            })
          : currentConfig.refreshToken;

        const nextConfig: McpOAuthAuthArtifactConfig = {
          ...currentConfig,
          accessToken: accessTokenRef,
          refreshToken: refreshTokenRef,
          tokenType: tokens.token_type ?? currentConfig.tokenType,
          expiresIn:
            typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)
              ? tokens.expires_in
              : currentConfig.expiresIn,
          scope: tokens.scope ?? currentConfig.scope,
        };

        yield* persistConfig(nextConfig);
        yield* cleanupReplacedSecretRefs({
          deleteSecretMaterial: input.deleteSecretMaterial,
          previousAccessToken: previousConfig.accessToken,
          nextAccessToken: accessTokenRef,
          previousRefreshToken: previousConfig.refreshToken,
          nextRefreshToken: refreshTokenRef,
        });
      })).then(() => undefined),

    redirectToAuthorization: async (authorizationUrl) => {
      throw new Error(
        `MCP OAuth re-authorization is required for ${currentArtifact.sourceId}: ${authorizationUrl.toString()}`,
      );
    },

    saveCodeVerifier: () => undefined,

    codeVerifier: () => {
      throw new Error("Persisted MCP OAuth sessions do not retain an active PKCE verifier");
    },

    saveDiscoveryState: (state) =>
      Effect.runPromise(
        persistConfig({
          ...currentConfig,
          resourceMetadataUrl: state.resourceMetadataUrl ?? null,
          authorizationServerUrl: state.authorizationServerUrl ?? null,
          resourceMetadataJson: stringifyJsonObject(state.resourceMetadata),
          authorizationServerMetadataJson: stringifyJsonObject(
            state.authorizationServerMetadata,
          ),
        }),
      ).then(() => undefined),

    discoveryState: () =>
      currentConfig.authorizationServerUrl === null
        ? undefined
        : {
            resourceMetadataUrl: currentConfig.resourceMetadataUrl ?? undefined,
            authorizationServerUrl: currentConfig.authorizationServerUrl,
            resourceMetadata: parseJsonObject<OAuthDiscoveryState["resourceMetadata"]>(
              currentConfig.resourceMetadataJson,
            ),
            authorizationServerMetadata: parseJsonObject<
              OAuthDiscoveryState["authorizationServerMetadata"]
            >(currentConfig.authorizationServerMetadataJson),
          },
  };
};
