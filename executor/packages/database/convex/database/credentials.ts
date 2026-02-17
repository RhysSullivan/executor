import { v } from "convex/values";
import { z } from "zod";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { mapCredential } from "../../src/database/mappers";
import { computeBoundAuthFingerprint } from "../../src/database/readers";
import { safeRunAfter } from "../../src/lib/scheduler";
import {
  credentialProviderValidator,
  credentialScopeTypeValidator,
  jsonObjectValidator,
} from "../../src/database/validators";

const recordSchema = z.record(z.unknown());

function toRecordValue(value: unknown): Record<string, unknown> {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

function requireAccountId(
  scopeType: "account" | "organization" | "workspace",
  accountId?: Id<"accounts">,
): Id<"accounts"> | undefined {
  if (scopeType !== "account") {
    return undefined;
  }

  if (!accountId) {
    throw new Error("accountId is required for account-scoped credentials");
  }

  return accountId;
}

function sourceIdFromSourceKey(sourceKey: string): string | null {
  const prefix = "source:";
  if (!sourceKey.startsWith(prefix)) {
    return null;
  }

  const sourceId = sourceKey.slice(prefix.length).trim();
  return sourceId.length > 0 ? sourceId : null;
}

export const upsertCredential = internalMutation({
  args: {
    id: v.optional(v.string()),
    workspaceId: v.id("workspaces"),
    scopeType: v.optional(credentialScopeTypeValidator),
    sourceKey: v.string(),
    accountId: v.optional(v.id("accounts")),
    provider: v.optional(credentialProviderValidator),
    secretJson: jsonObjectValidator,
    overridesJson: v.optional(jsonObjectValidator),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const scopeType = args.scopeType ?? "workspace";
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${args.workspaceId}`);
    }

    const organizationId = workspace.organizationId;
    const scopedWorkspaceId = scopeType === "workspace" ? args.workspaceId : undefined;
    const scopedOrganizationId = scopeType === "workspace" || scopeType === "organization"
      ? organizationId
      : undefined;
    const scopedAccountId = requireAccountId(scopeType, args.accountId);
    const submittedSecret = toRecordValue(args.secretJson);
    const hasSubmittedSecret = Object.keys(submittedSecret).length > 0;

    const existing = scopeType === "workspace"
      ? await ctx.db
        .query("sourceCredentials")
        .withIndex("by_workspace_source_scope", (q) =>
          q
            .eq("workspaceId", args.workspaceId)
            .eq("sourceKey", args.sourceKey)
            .eq("scopeType", "workspace"),
        )
        .unique()
      : scopeType === "organization"
        ? await ctx.db
          .query("sourceCredentials")
          .withIndex("by_organization_source_scope", (q) =>
            q
              .eq("organizationId", organizationId)
              .eq("sourceKey", args.sourceKey)
              .eq("scopeType", "organization"),
          )
          .unique()
        : await ctx.db
          .query("sourceCredentials")
          .withIndex("by_account_source_scope", (q) =>
            q
              .eq("accountId", scopedAccountId)
              .eq("sourceKey", args.sourceKey)
              .eq("scopeType", "account"),
          )
          .unique();

    let requestedId = args.id?.trim() || "";
    if (requestedId.startsWith("bind_")) {
      const binding = await ctx.db
        .query("sourceCredentials")
        .withIndex("by_binding_id", (q) => q.eq("bindingId", requestedId))
        .unique();

      const sameScope = binding
        && binding.scopeType === scopeType
        && binding.workspaceId === scopedWorkspaceId
        && binding.organizationId === scopedOrganizationId
        && binding.accountId === scopedAccountId;
      if (sameScope) {
        requestedId = binding.credentialId;
      }
    }

    const connectionId = requestedId || existing?.credentialId || `conn_${crypto.randomUUID()}`;

    const linkedRows = scopeType === "workspace"
      ? await ctx.db
        .query("sourceCredentials")
        .withIndex("by_workspace_credential", (q) =>
          q.eq("workspaceId", args.workspaceId).eq("credentialId", connectionId),
        )
        .collect()
      : scopeType === "organization"
        ? await ctx.db
          .query("sourceCredentials")
          .withIndex("by_organization_credential", (q) =>
            q.eq("organizationId", organizationId).eq("credentialId", connectionId),
          )
          .collect()
        : await ctx.db
          .query("sourceCredentials")
          .withIndex("by_account_credential", (q) =>
            q.eq("accountId", scopedAccountId).eq("credentialId", connectionId),
          )
          .collect();

    const exemplar = linkedRows[0] ?? existing ?? null;
    const provider = args.provider ?? exemplar?.provider ?? "local-convex";
    const fallbackSecret = toRecordValue(exemplar?.secretJson);
    const finalSecret = hasSubmittedSecret ? submittedSecret : fallbackSecret;
    if (Object.keys(finalSecret).length === 0) {
      throw new Error("Credential values are required");
    }

    const overridesJson = args.overridesJson === undefined
      ? toRecordValue(existing?.overridesJson)
      : toRecordValue(args.overridesJson);

    const boundAuthFingerprint = await computeBoundAuthFingerprint(
      ctx,
      args.workspaceId,
      args.sourceKey,
    );

    if (linkedRows.length > 0 && (hasSubmittedSecret || args.provider)) {
      await Promise.all(linkedRows.map(async (row) => {
        await ctx.db.patch(row._id, {
          provider,
          secretJson: finalSecret,
          updatedAt: now,
        });
      }));
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        credentialId: connectionId,
        scopeType,
        accountId: scopedAccountId,
        organizationId: scopedOrganizationId,
        workspaceId: scopedWorkspaceId,
        provider,
        secretJson: finalSecret,
        overridesJson,
        boundAuthFingerprint,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("sourceCredentials", {
        bindingId: `bind_${crypto.randomUUID()}`,
        credentialId: connectionId,
        scopeType,
        accountId: scopedAccountId,
        organizationId: scopedOrganizationId,
        workspaceId: scopedWorkspaceId,
        sourceKey: args.sourceKey,
        provider,
        secretJson: finalSecret,
        overridesJson,
        boundAuthFingerprint,
        createdAt: now,
        updatedAt: now,
      });
    }

    const updated = scopeType === "workspace"
      ? await ctx.db
        .query("sourceCredentials")
        .withIndex("by_workspace_source_scope", (q) =>
          q.eq("workspaceId", args.workspaceId).eq("sourceKey", args.sourceKey).eq("scopeType", "workspace"),
        )
        .unique()
      : scopeType === "organization"
        ? await ctx.db
          .query("sourceCredentials")
          .withIndex("by_organization_source_scope", (q) =>
            q.eq("organizationId", organizationId).eq("sourceKey", args.sourceKey).eq("scopeType", "organization"),
          )
          .unique()
        : await ctx.db
          .query("sourceCredentials")
          .withIndex("by_account_source_scope", (q) =>
            q.eq("accountId", scopedAccountId).eq("sourceKey", args.sourceKey).eq("scopeType", "account"),
          )
          .unique();

    if (!updated) {
      throw new Error("Failed to read upserted credential");
    }

    const sourceId = sourceIdFromSourceKey(args.sourceKey);
    if (sourceId) {
      const linkedSource = await ctx.db
        .query("toolSources")
        .withIndex("by_source_id", (q) => q.eq("sourceId", sourceId))
        .unique();
      if (linkedSource && linkedSource.organizationId === organizationId) {
        await ctx.db.patch(linkedSource._id, {
          updatedAt: now,
        });
      }
    }

    await safeRunAfter(ctx.scheduler, 0, internal.executorNode.listToolsWithWarningsInternal, {
      workspaceId: args.workspaceId,
      ...(scopeType === "account" && scopedAccountId ? { accountId: scopedAccountId } : {}),
    });

    return mapCredential(updated);
  },
});

export const listCredentials = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    accountId: v.optional(v.id("accounts")),
  },
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace) {
      return [];
    }

    const organizationId = workspace.organizationId;
    const [workspaceDocs, organizationDocs, accountDocs] = await Promise.all([
      ctx.db
        .query("sourceCredentials")
        .withIndex("by_workspace_created", (q) => q.eq("workspaceId", args.workspaceId))
        .order("desc")
        .collect(),
      ctx.db
        .query("sourceCredentials")
        .withIndex("by_organization_created", (q) => q.eq("organizationId", organizationId))
        .order("desc")
        .collect(),
      args.accountId
        ? ctx.db
          .query("sourceCredentials")
          .withIndex("by_account_created", (q) => q.eq("accountId", args.accountId))
          .order("desc")
          .collect()
        : Promise.resolve([]),
    ]);

    const docs = [...workspaceDocs, ...organizationDocs.filter((doc) => doc.scopeType === "organization"), ...accountDocs]
      .filter((doc, index, entries) => entries.findIndex((candidate) => candidate.bindingId === doc.bindingId) === index)
      .sort((a, b) => b.createdAt - a.createdAt);

    return docs.map(mapCredential);
  },
});

export const listCredentialProviders = internalQuery({
  args: {},
  handler: async () => {
    const workosEnabled = Boolean(process.env.WORKOS_API_KEY?.trim());
    return [
      {
        id: workosEnabled ? "workos-vault" : "local-convex",
        label: workosEnabled ? "Encrypted" : "Local",
        description: workosEnabled
          ? "Secrets are stored in WorkOS Vault."
          : "Secrets are stored locally in Convex on this machine.",
      },
    ] as const;
  },
});

export const resolveCredential = internalQuery({
  args: {
    workspaceId: v.id("workspaces"),
    sourceKey: v.string(),
    scopeType: credentialScopeTypeValidator,
    accountId: v.optional(v.id("accounts")),
  },
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace) {
      return null;
    }

    const organizationId = workspace.organizationId;

    const tryWorkspace = async () => {
      return await ctx.db
        .query("sourceCredentials")
        .withIndex("by_workspace_source_scope", (q) =>
          q.eq("workspaceId", args.workspaceId).eq("sourceKey", args.sourceKey).eq("scopeType", "workspace"),
        )
        .unique();
    };

    const tryOrganization = async () => {
      return await ctx.db
        .query("sourceCredentials")
        .withIndex("by_organization_source_scope", (q) =>
          q.eq("organizationId", organizationId).eq("sourceKey", args.sourceKey).eq("scopeType", "organization"),
        )
        .unique();
    };

    const tryAccount = async () => {
      if (!args.accountId) {
        return null;
      }

      return await ctx.db
        .query("sourceCredentials")
        .withIndex("by_account_source_scope", (q) =>
          q.eq("accountId", args.accountId).eq("sourceKey", args.sourceKey).eq("scopeType", "account"),
        )
        .unique();
    };

    if (args.scopeType === "account") {
      const accountDoc = await tryAccount();
      if (accountDoc) return mapCredential(accountDoc);

      const workspaceDoc = await tryWorkspace();
      if (workspaceDoc) return mapCredential(workspaceDoc);

      const organizationDoc = await tryOrganization();
      if (organizationDoc) return mapCredential(organizationDoc);
      return null;
    }

    if (args.scopeType === "workspace") {
      const workspaceDoc = await tryWorkspace();
      if (workspaceDoc) return mapCredential(workspaceDoc);

      const organizationDoc = await tryOrganization();
      if (organizationDoc) return mapCredential(organizationDoc);
      return null;
    }

    const organizationDoc = await tryOrganization();
    return organizationDoc ? mapCredential(organizationDoc) : null;
  },
});
