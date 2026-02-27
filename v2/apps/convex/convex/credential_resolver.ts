import {
  buildCredentialHeaders,
  CredentialResolver,
  CredentialResolverError,
  extractCredentialResolutionContext,
  makeCredentialResolver,
  selectCredentialBinding,
  selectOAuthAccessToken,
  sourceIdFromSourceKey,
} from "@executor-v2/domain";
import {
  OAuthTokenSchema,
  SourceCredentialBindingSchema,
  type OAuthToken,
  type SourceCredentialBinding,
} from "@executor-v2/schema";
import { v } from "convex/values";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { api } from "./_generated/api";
import { query, type ActionCtx } from "./_generated/server";

const decodeSourceCredentialBinding = Schema.decodeUnknownSync(
  SourceCredentialBindingSchema,
);
const decodeOAuthToken = Schema.decodeUnknownSync(OAuthTokenSchema);

const stripConvexSystemFields = (
  value: Record<string, unknown>,
): Record<string, unknown> => {
  const { _id: _ignoredId, _creationTime: _ignoredCreationTime, ...rest } = value;
  return rest;
};

export const listCredentialBindingsForSource = query({
  args: {
    workspaceId: v.string(),
    sourceKey: v.string(),
    organizationId: v.optional(v.string()),
    accountId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Array<SourceCredentialBinding>> => {
    const rows = await ctx.db
      .query("sourceCredentialBindings")
      .withIndex("by_sourceKey", (q) => q.eq("sourceKey", args.sourceKey))
      .collect();

    return rows
      .map((row) =>
        decodeSourceCredentialBinding(
          stripConvexSystemFields(row as unknown as Record<string, unknown>),
        ),
      )
      .filter((binding) => {
        if (binding.scopeType === "workspace") {
          return binding.workspaceId === args.workspaceId;
        }

        if (binding.scopeType === "organization") {
          return args.organizationId
            ? binding.organizationId === args.organizationId
            : true;
        }

        return args.accountId ? binding.accountId === args.accountId : true;
      });
  },
});

export const listOAuthTokensForSource = query({
  args: {
    workspaceId: v.string(),
    sourceId: v.string(),
  },
  handler: async (ctx, args): Promise<Array<OAuthToken>> => {
    const rows = await ctx.db
      .query("oauthTokens")
      .withIndex("by_sourceId", (q) => q.eq("sourceId", args.sourceId))
      .collect();

    return rows
      .map((row) =>
        decodeOAuthToken(
          stripConvexSystemFields(row as unknown as Record<string, unknown>),
        ),
      )
      .filter((token) => token.workspaceId === args.workspaceId);
  },
});

const toCredentialResolverError = (
  operation: string,
  message: string,
  details: string | null,
): CredentialResolverError =>
  new CredentialResolverError({
    operation,
    message,
    details,
  });

const runQueryEffect = <T>(
  operation: string,
  run: () => Promise<T>,
): Effect.Effect<T, CredentialResolverError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      toCredentialResolverError(
        operation,
        "Convex credential query failed",
        String(cause),
      ),
  });

export const ConvexCredentialResolverLive = (
  ctx: ActionCtx,
): Layer.Layer<CredentialResolver> =>
  Layer.succeed(
    CredentialResolver,
    CredentialResolver.of(
      makeCredentialResolver((input) =>
        Effect.gen(function* () {
          const context = extractCredentialResolutionContext(input);
          if (context === null) {
            return {
              headers: {},
            };
          }

          const bindings = yield* runQueryEffect(
            "list_credential_bindings",
            () =>
              ctx.runQuery(api.credential_resolver.listCredentialBindingsForSource, {
                workspaceId: context.workspaceId,
                sourceKey: context.sourceKey,
                organizationId: context.organizationId ?? undefined,
                accountId: context.accountId ?? undefined,
              }),
          );

          const binding = selectCredentialBinding(bindings, context);
          if (binding === null) {
            return {
              headers: {},
            };
          }

          const sourceId = sourceIdFromSourceKey(context.sourceKey);

          const oauthAccessToken =
            binding.provider === "oauth2" && sourceId
              ? yield* runQueryEffect("list_oauth_tokens", () =>
                  ctx
                    .runQuery(api.credential_resolver.listOAuthTokensForSource, {
                      workspaceId: context.workspaceId,
                      sourceId,
                    })
                    .then((tokens) =>
                      selectOAuthAccessToken(tokens, context, sourceId),
                    ),
                )
              : null;

          return {
            headers: buildCredentialHeaders(binding, {
              oauthAccessToken,
            }),
          };
        }),
      ),
    ),
  );
