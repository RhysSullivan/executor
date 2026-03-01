import { type UpsertWorkspacePayload } from "@executor-v2/management-api";
import { WorkspaceSchema, type Workspace } from "@executor-v2/schema";
import { v } from "convex/values";
import * as Schema from "effect/Schema";

import { mutation, query } from "../_generated/server";

const decodeWorkspace = Schema.decodeUnknownSync(WorkspaceSchema);

const stripConvexSystemFields = (
  value: Record<string, unknown>,
): Record<string, unknown> => {
  const { _id: _ignoredId, _creationTime: _ignoredCreationTime, ...rest } = value;
  return rest;
};

const toWorkspace = (document: Record<string, unknown>): Workspace =>
  decodeWorkspace(stripConvexSystemFields(document));

const sortWorkspaces = (workspaces: ReadonlyArray<Workspace>): Array<Workspace> =>
  [...workspaces].sort((left, right) => {
    const leftName = left.name.toLowerCase();
    const rightName = right.name.toLowerCase();

    if (leftName === rightName) {
      return left.id.localeCompare(right.id);
    }

    return leftName.localeCompare(rightName);
  });

export const listWorkspaces = query({
  args: {},
  handler: async (ctx): Promise<Array<Workspace>> => {
    const rows = await ctx.db.query("workspaces").collect();

    return sortWorkspaces(
      rows.map((row) => toWorkspace(row as unknown as Record<string, unknown>)),
    );
  },
});

export const upsertWorkspace = mutation({
  args: {
    payload: v.object({
      id: v.optional(v.string()),
      organizationId: v.string(),
      name: v.string(),
    }),
  },
  handler: async (ctx, args): Promise<Workspace> => {
    const payload = args.payload as UpsertWorkspacePayload;
    const now = Date.now();
    const workspaceId = payload.id ?? `ws_${crypto.randomUUID()}`;

    const existing = await ctx.db
      .query("workspaces")
      .withIndex("by_domainId", (q) => q.eq("id", workspaceId))
      .unique();

    const nextWorkspace = decodeWorkspace({
      id: workspaceId,
      organizationId: payload.organizationId,
      name: payload.name,
      createdByAccountId: existing?.createdByAccountId ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    if (existing) {
      await ctx.db.patch(existing._id, nextWorkspace);
    } else {
      await ctx.db.insert("workspaces", nextWorkspace);
    }

    return nextWorkspace;
  },
});
