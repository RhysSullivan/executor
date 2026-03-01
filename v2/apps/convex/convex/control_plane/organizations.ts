import { type UpsertOrganizationPayload } from "@executor-v2/management-api";
import {
  OrganizationSchema,
  type Organization,
  type OrganizationMembership,
} from "@executor-v2/schema";
import { v } from "convex/values";
import * as Schema from "effect/Schema";

import { mutation, query } from "../_generated/server";

const decodeOrganization = Schema.decodeUnknownSync(OrganizationSchema);

const stripConvexSystemFields = (
  value: Record<string, unknown>,
): Record<string, unknown> => {
  const { _id: _ignoredId, _creationTime: _ignoredCreationTime, ...rest } = value;
  return rest;
};

const toOrganization = (document: Record<string, unknown>): Organization =>
  decodeOrganization(stripConvexSystemFields(document));

const organizationStatusValidator = v.union(
  v.literal("active"),
  v.literal("suspended"),
  v.literal("archived"),
);

const sortOrganizations = (
  organizations: ReadonlyArray<Organization>,
): Array<Organization> =>
  [...organizations].sort((left, right) => {
    const leftName = left.name.toLowerCase();
    const rightName = right.name.toLowerCase();

    if (leftName === rightName) {
      return left.id.localeCompare(right.id);
    }

    return leftName.localeCompare(rightName);
  });

export const listOrganizations = query({
  args: {},
  handler: async (ctx): Promise<Array<Organization>> => {
    const rows = await ctx.db.query("organizations").collect();

    return sortOrganizations(
      rows.map((row) => toOrganization(row as unknown as Record<string, unknown>)),
    );
  },
});

export const upsertOrganization = mutation({
  args: {
    payload: v.object({
      id: v.optional(v.string()),
      slug: v.string(),
      name: v.string(),
      status: v.optional(organizationStatusValidator),
      createdByAccountId: v.optional(v.union(v.string(), v.null())),
    }),
  },
  handler: async (ctx, args): Promise<Organization> => {
    const payload = args.payload as UpsertOrganizationPayload;
    const now = Date.now();
    const organizationId = payload.id ?? `org_${crypto.randomUUID()}`;

    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_domainId", (q) => q.eq("id", organizationId))
      .unique();

    const nextOrganization = decodeOrganization({
      id: organizationId,
      slug: payload.slug,
      name: payload.name,
      status: payload.status ?? existing?.status ?? "active",
      createdByAccountId:
        existing?.createdByAccountId
        ?? payload.createdByAccountId
        ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    if (existing) {
      await ctx.db.patch(existing._id, nextOrganization);
    } else {
      await ctx.db.insert("organizations", nextOrganization);

      if (nextOrganization.createdByAccountId !== null) {
        const existingMembership = await ctx.db
          .query("organizationMemberships")
          .withIndex("by_organizationId_accountId", (q) =>
            q
              .eq("organizationId", nextOrganization.id)
              .eq("accountId", nextOrganization.createdByAccountId as string)
          )
          .first();

        if (!existingMembership) {
          const membership: OrganizationMembership = {
            id: `org_member_${crypto.randomUUID()}` as OrganizationMembership["id"],
            organizationId: nextOrganization.id,
            accountId: nextOrganization.createdByAccountId,
            role: "owner",
            status: "active",
            billable: false,
            invitedByAccountId: null,
            joinedAt: now,
            createdAt: now,
            updatedAt: now,
          };

          await ctx.db.insert("organizationMemberships", membership);
        }
      }
    }

    return nextOrganization;
  },
});
