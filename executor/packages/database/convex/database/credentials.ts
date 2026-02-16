import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { mapCredential } from "../../src/database/mappers";
import { computeBoundAuthFingerprint } from "../../src/database/readers";
import {
  credentialProviderValidator,
  credentialScopeValidator,
} from "../../src/database/validators";
import { asRecord } from "../../src/lib/object";

export const upsertCredential = internalMutation({
  args: {
    id: v.optional(v.string()),
    workspaceId: v.id("workspaces"),
    sourceKey: v.string(),
    scope: credentialScopeValidator,
    actorId: v.optional(v.string()),
    provider: v.optional(credentialProviderValidator),
    secretJson: v.any(),
    overridesJson: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const actorId = args.scope === "actor" ? (args.actorId?.trim() || "") : "";
    const submittedSecret = asRecord(args.secretJson);
    const hasSubmittedSecret = Object.keys(submittedSecret).length > 0;

    const existing = await ctx.db
      .query("sourceCredentials")
      .withIndex("by_workspace_source_scope_actor", (q) =>
        q
          .eq("workspaceId", args.workspaceId)
          .eq("sourceKey", args.sourceKey)
          .eq("scope", args.scope)
          .eq("actorId", actorId),
      )
      .unique();

    let requestedId = args.id?.trim() || "";
    if (requestedId.startsWith("bind_")) {
      const binding = await ctx.db
        .query("sourceCredentials")
        .withIndex("by_binding_id", (q) => q.eq("bindingId", requestedId))
        .unique();
      if (binding && binding.workspaceId === args.workspaceId) {
        requestedId = binding.credentialId;
      }
    }

    const connectionId = requestedId || existing?.credentialId || `conn_${crypto.randomUUID()}`;

    const linkedRows = await ctx.db
      .query("sourceCredentials")
      .withIndex("by_workspace_credential", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("credentialId", connectionId),
      )
      .collect();
    const exemplar = linkedRows[0] ?? existing ?? null;

    const provider = args.provider ?? exemplar?.provider ?? "local-convex";
    const fallbackSecret = asRecord(exemplar?.secretJson);
    const finalSecret = hasSubmittedSecret ? submittedSecret : fallbackSecret;
    if (Object.keys(finalSecret).length === 0) {
      throw new Error("Credential values are required");
    }

    const overridesJson = args.overridesJson === undefined
      ? asRecord(existing?.overridesJson)
      : asRecord(args.overridesJson);

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
        workspaceId: args.workspaceId,
        sourceKey: args.sourceKey,
        scope: args.scope,
        actorId,
        provider,
        secretJson: finalSecret,
        overridesJson,
        boundAuthFingerprint,
        createdAt: now,
        updatedAt: now,
      });
    }

    const updated = await ctx.db
      .query("sourceCredentials")
      .withIndex("by_workspace_source_scope_actor", (q) =>
        q
          .eq("workspaceId", args.workspaceId)
          .eq("sourceKey", args.sourceKey)
          .eq("scope", args.scope)
          .eq("actorId", actorId),
      )
      .unique();

    if (!updated) {
      throw new Error("Failed to read upserted credential");
    }

    return mapCredential(updated);
  },
});

export const listCredentials = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("sourceCredentials")
      .withIndex("by_workspace_created", (q) => q.eq("workspaceId", args.workspaceId))
      .order("desc")
      .collect();
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
    scope: credentialScopeValidator,
    actorId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.scope === "actor") {
      const actorId = args.actorId?.trim() || "";
      if (!actorId) {
        return null;
      }

      const actorDoc = await ctx.db
        .query("sourceCredentials")
        .withIndex("by_workspace_source_scope_actor", (q) =>
          q
            .eq("workspaceId", args.workspaceId)
            .eq("sourceKey", args.sourceKey)
            .eq("scope", "actor")
            .eq("actorId", actorId),
        )
        .unique();

      return actorDoc ? mapCredential(actorDoc) : null;
    }

    const workspaceDoc = await ctx.db
      .query("sourceCredentials")
      .withIndex("by_workspace_source_scope_actor", (q) =>
        q
          .eq("workspaceId", args.workspaceId)
          .eq("sourceKey", args.sourceKey)
          .eq("scope", "workspace")
          .eq("actorId", ""),
      )
      .unique();

    return workspaceDoc ? mapCredential(workspaceDoc) : null;
  },
});
