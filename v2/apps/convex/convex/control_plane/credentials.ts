import {
  buildCredentialHeaders,
  selectOAuthAccessToken,
} from "@executor-v2/engine";
import { type UpsertCredentialBindingPayload } from "@executor-v2/management-api";
import {
  OAuthTokenSchema,
  SourceCredentialBindingSchema,
  type OAuthToken,
  type SourceCredentialBinding,
} from "@executor-v2/schema";
import { v } from "convex/values";
import * as Schema from "effect/Schema";

import { internal } from "../_generated/api";
import { decryptSecretValue, encryptSecretValue } from "../credential_crypto";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";

const runtimeInternal = internal as any;

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

const toSourceCredentialBinding = (
  document: Record<string, unknown>,
): SourceCredentialBinding =>
  decodeSourceCredentialBinding(stripConvexSystemFields(document));

const credentialProviderValidator = v.union(
  v.literal("api_key"),
  v.literal("bearer"),
  v.literal("oauth2"),
  v.literal("custom"),
);

const credentialSecretProviderValidator = v.literal("local");

const credentialScopeTypeValidator = v.union(
  v.literal("workspace"),
  v.literal("organization"),
  v.literal("account"),
);

const sourceCredentialBindingPayloadValidator = v.object({
  id: v.optional(v.string()),
  credentialId: v.string(),
  scopeType: credentialScopeTypeValidator,
  sourceKey: v.string(),
  provider: credentialProviderValidator,
  secretProvider: v.optional(credentialSecretProviderValidator),
  secretRef: v.string(),
  accountId: v.optional(v.union(v.string(), v.null())),
  additionalHeadersJson: v.optional(v.union(v.string(), v.null())),
  boundAuthFingerprint: v.optional(v.union(v.string(), v.null())),
});

const sortSourceCredentialBindings = (
  bindings: ReadonlyArray<SourceCredentialBinding>,
): Array<SourceCredentialBinding> =>
  [...bindings].sort((left, right) => {
    const leftKey = `${left.sourceKey}:${left.provider}`.toLowerCase();
    const rightKey = `${right.sourceKey}:${right.provider}`.toLowerCase();

    if (leftKey === rightKey) {
      return left.id.localeCompare(right.id);
    }

    return leftKey.localeCompare(rightKey);
  });

const resolveWorkspaceOrganizationId = async (
  ctx: QueryCtx | MutationCtx,
  workspaceId: string,
): Promise<string> => {
  const workspace = await ctx.db
    .query("workspaces")
    .withIndex("by_domainId", (q) => q.eq("id", workspaceId))
    .unique();

  if (!workspace) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  return workspace.organizationId;
};

const canAccessSourceCredentialBinding = (
  binding: SourceCredentialBinding,
  input: {
    workspaceId: string;
    organizationId: string;
  },
): boolean =>
  binding.workspaceId === input.workspaceId
  || (binding.workspaceId === null && binding.organizationId === input.organizationId);

const toOAuthToken = (document: Record<string, unknown>): OAuthToken =>
  decodeOAuthToken(stripConvexSystemFields(document));

const sourceSlug = (value: string): string =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");

const parseHostname = (endpoint: string): string | null => {
  try {
    const hostname = new URL(endpoint).hostname.trim().toLowerCase();
    return hostname.length > 0 ? hostname : null;
  } catch {
    return null;
  }
};

const sourceKeyCandidatesForIngest = (input: {
  sourceId: string;
  sourceName: string;
  sourceEndpoint: string;
}): Array<string> => {
  const values = new Set<string>();

  const addCandidate = (value: string | null): void => {
    if (!value) {
      return;
    }

    const trimmed = value.trim();
    if (trimmed.length > 0) {
      values.add(trimmed);
    }
  };

  addCandidate(`source:${input.sourceId}`);
  addCandidate(input.sourceId);
  addCandidate(input.sourceName.toLowerCase());
  addCandidate(sourceSlug(input.sourceName));

  const hostname = parseHostname(input.sourceEndpoint);
  addCandidate(hostname);
  if (hostname) {
    const hostnameWithoutApi = hostname.replace(/^api\./, "");
    addCandidate(hostnameWithoutApi);
    const firstLabel = hostnameWithoutApi.split(".")[0] ?? null;
    addCandidate(firstLabel);
  }

  return [...values];
};

const bindingScopeScore = (
  binding: SourceCredentialBinding,
  input: {
    workspaceId: string;
    organizationId: string;
  },
): number => {
  if (binding.scopeType === "workspace") {
    return binding.workspaceId === input.workspaceId ? 20 : -1;
  }

  if (binding.scopeType === "organization") {
    return binding.organizationId === input.organizationId ? 10 : -1;
  }

  return -1;
};

const selectBestIngestBinding = (
  candidates: ReadonlyArray<{
    binding: SourceCredentialBinding;
    sourceKeyRank: number;
  }>,
  input: {
    workspaceId: string;
    organizationId: string;
  },
): SourceCredentialBinding | null => {
  const ranked = candidates
    .map((candidate) => ({
      binding: candidate.binding,
      scopeScore: bindingScopeScore(candidate.binding, input),
      sourceKeyRank: candidate.sourceKeyRank,
    }))
    .filter((candidate) => candidate.scopeScore >= 0)
    .sort((left, right) => {
      if (left.scopeScore !== right.scopeScore) {
        return right.scopeScore - left.scopeScore;
      }

      if (left.sourceKeyRank !== right.sourceKeyRank) {
        return right.sourceKeyRank - left.sourceKeyRank;
      }

      if (left.binding.updatedAt !== right.binding.updatedAt) {
        return right.binding.updatedAt - left.binding.updatedAt;
      }

      return right.binding.createdAt - left.binding.createdAt;
    });

  return ranked[0]?.binding ?? null;
};

const requireLocalSecretProvider = (
  secretProvider: SourceCredentialBinding["secretProvider"],
): "local" => {
  if (secretProvider !== "local") {
    throw new Error("Convex credentials require secretProvider 'local'");
  }

  return "local";
};

const defaultSecretProvider = (): "local" => "local";

const resolveSecretRefForHeaders = async (
  binding: SourceCredentialBinding,
): Promise<string> => {
  requireLocalSecretProvider(binding.secretProvider);
  return await decryptSecretValue(binding.secretRef);
};

const resolveIngestSelection = async (
  ctx: QueryCtx,
  args: {
    workspaceId: string;
    sourceId: string;
    sourceName: string;
    sourceEndpoint: string;
  },
): Promise<{
  binding: SourceCredentialBinding | null;
  oauthAccessToken: string | null;
}> => {
  const organizationId = await resolveWorkspaceOrganizationId(ctx, args.workspaceId);
  const sourceKeys = sourceKeyCandidatesForIngest({
    sourceId: args.sourceId,
    sourceName: args.sourceName,
    sourceEndpoint: args.sourceEndpoint,
  });

  const candidateRows = await Promise.all(
    sourceKeys.map((sourceKey) =>
      ctx.db
        .query("sourceCredentialBindings")
        .withIndex("by_sourceKey", (q) => q.eq("sourceKey", sourceKey))
        .collect()
        .then((rows) =>
          rows.map((row) => ({
            binding: toSourceCredentialBinding(row as unknown as Record<string, unknown>),
            sourceKey,
          })),
        ),
    ),
  );

  const flattened = candidateRows.flat();
  const dedupedById = new Map<string, { binding: SourceCredentialBinding; sourceKey: string }>();
  for (const candidate of flattened) {
    if (!dedupedById.has(candidate.binding.id)) {
      dedupedById.set(candidate.binding.id, candidate);
    }
  }

  const sourceKeyRankByKey = new Map<string, number>();
  sourceKeys.forEach((sourceKey, index) => {
    sourceKeyRankByKey.set(sourceKey, sourceKeys.length - index);
  });

  const binding = selectBestIngestBinding(
    [...dedupedById.values()].map((candidate) => ({
      binding: candidate.binding,
      sourceKeyRank: sourceKeyRankByKey.get(candidate.sourceKey) ?? 0,
    })),
    {
      workspaceId: args.workspaceId,
      organizationId,
    },
  );

  if (!binding || !canAccessSourceCredentialBinding(binding, { workspaceId: args.workspaceId, organizationId })) {
    return {
      binding: null,
      oauthAccessToken: null,
    };
  }

  const oauthTokens = binding.provider === "oauth2"
    ? (await ctx.db
        .query("oauthTokens")
        .withIndex("by_sourceId", (q) => q.eq("sourceId", args.sourceId))
        .collect()).map((row) => toOAuthToken(row as unknown as Record<string, unknown>))
    : [];

  const oauthAccessToken = binding.provider === "oauth2"
    ? selectOAuthAccessToken(oauthTokens, {
        workspaceId: args.workspaceId,
        organizationId,
        accountId: null,
        sourceKey: binding.sourceKey,
      }, args.sourceId)
    : null;

  return {
    binding,
    oauthAccessToken,
  };
};

const withDecryptedSecret = async (
  binding: SourceCredentialBinding,
): Promise<SourceCredentialBinding> => {
  const secretRef = await resolveSecretRefForHeaders(binding);
  return {
    ...binding,
    secretProvider: "local",
    secretRef,
  };
};

export const resolveSourceCredentialSelectionForIngest = internalQuery({
  args: {
    workspaceId: v.string(),
    sourceId: v.string(),
    sourceName: v.string(),
    sourceEndpoint: v.string(),
  },
  handler: async (ctx, args) => resolveIngestSelection(ctx, args),
});

export const resolveSourceCredentialHeadersForIngest = internalAction({
  args: {
    workspaceId: v.string(),
    sourceId: v.string(),
    sourceName: v.string(),
    sourceEndpoint: v.string(),
  },
  handler: async (ctx, args): Promise<{
    headers: Record<string, string>;
  }> => {
    const selected = await ctx.runQuery(
      runtimeInternal.control_plane.credentials.resolveSourceCredentialSelectionForIngest,
      args,
    ) as {
      binding: SourceCredentialBinding | null;
      oauthAccessToken: string | null;
    };

    if (!selected.binding) {
      return {
        headers: {},
      };
    }

    const decrypted = await withDecryptedSecret(selected.binding);

    const headers = buildCredentialHeaders(decrypted, {
      oauthAccessToken: selected.oauthAccessToken,
    });

    return { headers };
  },
});

export const listCredentialBindings = query({
  args: {
    workspaceId: v.string(),
  },
  handler: async (ctx, args): Promise<Array<SourceCredentialBinding>> => {
    const organizationId = await resolveWorkspaceOrganizationId(ctx, args.workspaceId);

    const workspaceRows = await ctx.db
      .query("sourceCredentialBindings")
      .withIndex("by_workspaceId", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();

    const organizationRows = await ctx.db
      .query("sourceCredentialBindings")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
      .collect();

    const bindings = [...workspaceRows, ...organizationRows]
      .map((row) =>
        toSourceCredentialBinding(row as unknown as Record<string, unknown>),
      )
      .filter((binding) =>
        canAccessSourceCredentialBinding(binding, {
          workspaceId: args.workspaceId,
          organizationId,
        })
      );

    const uniqueBindings = Array.from(
      new Map(bindings.map((binding) => [binding.id, binding])).values(),
    );

    const decryptedBindings = await Promise.all(
      uniqueBindings.map((binding) => withDecryptedSecret(binding)),
    );

    return sortSourceCredentialBindings(decryptedBindings);
  },
});

export const upsertCredentialBindingRecord = internalMutation({
  args: {
    workspaceId: v.string(),
    payload: sourceCredentialBindingPayloadValidator,
  },
  handler: async (ctx, args): Promise<SourceCredentialBinding> => {
    const payload = args.payload as UpsertCredentialBindingPayload;

    if (payload.scopeType === "account" && payload.accountId === null) {
      throw new Error("Account scope credentials require accountId");
    }

    const organizationId = await resolveWorkspaceOrganizationId(ctx, args.workspaceId);
    const now = Date.now();
    const bindingId = payload.id ?? `credential_binding_${crypto.randomUUID()}`;

    const existing = await ctx.db
      .query("sourceCredentialBindings")
      .withIndex("by_domainId", (q) => q.eq("id", bindingId))
      .unique();

    const existingBinding = existing
      ? toSourceCredentialBinding(existing as unknown as Record<string, unknown>)
      : null;

    if (
      existingBinding !== null
      && !canAccessSourceCredentialBinding(existingBinding, {
        workspaceId: args.workspaceId,
        organizationId,
      })
    ) {
      throw new Error(`Credential binding not found: ${bindingId}`);
    }

    const secretProvider = requireLocalSecretProvider(
      payload.secretProvider
      ?? existingBinding?.secretProvider
      ?? defaultSecretProvider(),
    );

    const nextBinding = decodeSourceCredentialBinding({
      id: bindingId,
      credentialId: payload.credentialId,
      organizationId,
      workspaceId: payload.scopeType === "workspace" ? args.workspaceId : null,
      accountId: payload.scopeType === "account" ? (payload.accountId ?? null) : null,
      scopeType: payload.scopeType,
      sourceKey: payload.sourceKey,
      provider: payload.provider,
      secretProvider,
      secretRef: payload.secretRef,
      additionalHeadersJson: payload.additionalHeadersJson ?? null,
      boundAuthFingerprint: payload.boundAuthFingerprint ?? null,
      createdAt: existingBinding?.createdAt ?? now,
      updatedAt: now,
    });

    if (existing) {
      await ctx.db.patch(existing._id, nextBinding);
    } else {
      await ctx.db.insert("sourceCredentialBindings", nextBinding);
    }

    return nextBinding;
  },
});

export const upsertCredentialBinding = action({
  args: {
    workspaceId: v.string(),
    payload: sourceCredentialBindingPayloadValidator,
  },
  handler: async (ctx, args): Promise<SourceCredentialBinding> => {
    const payload = args.payload as UpsertCredentialBindingPayload;
    const requestedSecretRef = payload.secretRef.trim();
    if (requestedSecretRef.length === 0) {
      throw new Error("Credential secret is required");
    }

    const encryptedSecretRef = await encryptSecretValue(requestedSecretRef);

    const written = await ctx.runMutation(
      runtimeInternal.control_plane.credentials.upsertCredentialBindingRecord,
      {
        workspaceId: args.workspaceId,
        payload: {
          ...payload,
          secretProvider: "local",
          secretRef: encryptedSecretRef,
        },
      },
    ) as SourceCredentialBinding;

    return {
      ...written,
      secretProvider: "local",
      secretRef: requestedSecretRef,
    };
  },
});

export const removeCredentialBinding = mutation({
  args: {
    workspaceId: v.string(),
    credentialBindingId: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    removed: boolean;
  }> => {
    const organizationId = await resolveWorkspaceOrganizationId(ctx, args.workspaceId);

    const existing = await ctx.db
      .query("sourceCredentialBindings")
      .withIndex("by_domainId", (q) => q.eq("id", args.credentialBindingId))
      .unique();

    if (!existing) {
      return { removed: false };
    }

    const existingBinding = toSourceCredentialBinding(
      existing as unknown as Record<string, unknown>,
    );

    if (
      !canAccessSourceCredentialBinding(existingBinding, {
        workspaceId: args.workspaceId,
        organizationId,
      })
    ) {
      return { removed: false };
    }

    await ctx.db.delete(existing._id);

    return { removed: true };
  },
});
