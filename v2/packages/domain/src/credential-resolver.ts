import type {
  OAuthToken,
  SourceCredentialBinding,
  WorkspaceId,
} from "@executor-v2/schema";
import type {
  RuntimeToolCallCredentialContext,
  RuntimeToolCallRequest,
} from "@executor-v2/sdk";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class CredentialResolverError extends Data.TaggedError(
  "CredentialResolverError",
)<{
  operation: string;
  message: string;
  details: string | null;
}> {}

export type ResolvedToolCredentials = {
  headers: Readonly<Record<string, string>>;
};

export type CredentialResolverShape = {
  resolveForToolCall: (
    input: RuntimeToolCallRequest,
  ) => Effect.Effect<ResolvedToolCredentials, CredentialResolverError>;
};

export class CredentialResolver extends Context.Tag(
  "@executor-v2/domain/CredentialResolver",
)<CredentialResolver, CredentialResolverShape>() {}

export const makeCredentialResolver = (
  resolveForToolCall: CredentialResolverShape["resolveForToolCall"],
): CredentialResolverShape => ({
  resolveForToolCall,
});

const emptyResolvedToolCredentials: ResolvedToolCredentials = {
  headers: {},
};

const RuntimeToolCallCredentialContextSchema = Schema.Struct({
  workspaceId: Schema.String,
  sourceKey: Schema.String,
  organizationId: Schema.optional(Schema.NullOr(Schema.String)),
  accountId: Schema.optional(Schema.NullOr(Schema.String)),
});

const decodeCredentialContext = Schema.decodeUnknownEither(
  RuntimeToolCallCredentialContextSchema,
);

const AdditionalHeadersFromJsonSchema = Schema.parseJson(
  Schema.Record({
    key: Schema.String,
    value: Schema.String,
  }),
);

const decodeAdditionalHeadersFromJson = Schema.decodeUnknownEither(
  AdditionalHeadersFromJsonSchema,
);

export const sourceIdFromSourceKey = (sourceKey: string): string | null => {
  if (!sourceKey.startsWith("source:")) {
    return null;
  }

  const sourceId = sourceKey.slice("source:".length).trim();
  return sourceId.length > 0 ? sourceId : null;
};

const normalizeContext = (
  context: RuntimeToolCallCredentialContext,
): RuntimeToolCallCredentialContext => ({
  workspaceId: context.workspaceId,
  sourceKey: context.sourceKey,
  organizationId: context.organizationId ?? null,
  accountId: context.accountId ?? null,
});

export const extractCredentialResolutionContext = (
  input: RuntimeToolCallRequest,
): RuntimeToolCallCredentialContext | null => {
  if (!input.credentialContext) {
    return null;
  }

  const decoded = decodeCredentialContext(input.credentialContext);
  if (Either.isLeft(decoded)) {
    return null;
  }

  const normalized = normalizeContext(decoded.right);
  const workspaceId = normalized.workspaceId.trim();
  const sourceKey = normalized.sourceKey.trim();

  if (workspaceId.length === 0 || sourceKey.length === 0) {
    return null;
  }

  return {
    ...normalized,
    workspaceId,
    sourceKey,
  };
};

const bindingScopeScore = (
  binding: SourceCredentialBinding,
  context: RuntimeToolCallCredentialContext,
): number => {
  if (binding.scopeType === "account") {
    return context.accountId && binding.accountId === context.accountId ? 30 : -1;
  }

  if (binding.scopeType === "workspace") {
    return binding.workspaceId === context.workspaceId ? 20 : -1;
  }

  return context.organizationId && binding.organizationId === context.organizationId
    ? 10
    : -1;
};

export const selectCredentialBinding = (
  bindings: ReadonlyArray<SourceCredentialBinding>,
  context: RuntimeToolCallCredentialContext,
): SourceCredentialBinding | null => {
  const ranked = bindings
    .filter((binding) => binding.sourceKey === context.sourceKey)
    .map((binding) => ({
      binding,
      score: bindingScopeScore(binding, context),
    }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }

      if (left.binding.updatedAt !== right.binding.updatedAt) {
        return right.binding.updatedAt - left.binding.updatedAt;
      }

      return right.binding.createdAt - left.binding.createdAt;
    });

  return ranked[0]?.binding ?? null;
};

const parseAdditionalHeaders = (
  additionalHeadersJson: string | null,
): Record<string, string> => {
  if (!additionalHeadersJson) {
    return {};
  }

  const decoded = decodeAdditionalHeadersFromJson(additionalHeadersJson);
  if (Either.isLeft(decoded)) {
    return {};
  }

  return decoded.right;
};

const tokenScopeScore = (
  token: OAuthToken,
  context: RuntimeToolCallCredentialContext,
): number => {
  if (token.workspaceId !== (context.workspaceId as WorkspaceId)) {
    return -1;
  }

  const now = Date.now();
  if (token.expiresAt !== null && token.expiresAt <= now) {
    return -1;
  }

  let score = 0;

  if (context.accountId) {
    if (token.accountId === context.accountId) {
      score += 10;
    } else if (token.accountId !== null) {
      return -1;
    }
  }

  if (context.organizationId) {
    if (token.organizationId === context.organizationId) {
      score += 5;
    } else if (token.organizationId !== null) {
      return -1;
    }
  }

  if (token.accountId === null && token.organizationId === null) {
    score += 1;
  }

  return score;
};

export const selectOAuthAccessToken = (
  tokens: ReadonlyArray<OAuthToken>,
  context: RuntimeToolCallCredentialContext,
  sourceId: string,
): string | null => {
  const ranked = tokens
    .filter((token) => token.sourceId === sourceId)
    .map((token) => ({
      token,
      score: tokenScopeScore(token, context),
    }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }

      if (left.token.updatedAt !== right.token.updatedAt) {
        return right.token.updatedAt - left.token.updatedAt;
      }

      return right.token.createdAt - left.token.createdAt;
    });

  return ranked[0]?.token.accessTokenRef ?? null;
};

export const buildCredentialHeaders = (
  binding: SourceCredentialBinding,
  options: {
    oauthAccessToken: string | null;
  },
): Record<string, string> => {
  const headers: Record<string, string> = {};

  if (binding.provider === "api_key") {
    if (binding.secretRef.trim().length > 0) {
      headers["x-api-key"] = binding.secretRef;
    }
  }

  if (binding.provider === "bearer") {
    if (binding.secretRef.trim().length > 0) {
      headers.Authorization = `Bearer ${binding.secretRef}`;
    }
  }

  if (binding.provider === "oauth2") {
    const oauthToken = options.oauthAccessToken ?? binding.secretRef;
    if (oauthToken.trim().length > 0) {
      headers.Authorization = `Bearer ${oauthToken}`;
    }
  }

  const additionalHeaders = parseAdditionalHeaders(binding.additionalHeadersJson);

  return {
    ...headers,
    ...additionalHeaders,
  };
};

export const CredentialResolverNoneLive = Layer.succeed(
  CredentialResolver,
  CredentialResolver.of(
    makeCredentialResolver(() => Effect.succeed(emptyResolvedToolCredentials)),
  ),
);
