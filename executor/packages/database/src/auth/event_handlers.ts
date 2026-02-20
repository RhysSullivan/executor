import { type AuthKit } from "@convex-dev/workos-authkit";
import { z } from "zod";
import type { DataModel } from "../../convex/_generated/dataModel.d.ts";
import type { MutationCtx } from "../../convex/_generated/server";
import { upsertWorkosAccount } from "./accounts";
import { getAccountByWorkosId, getOrganizationByWorkosOrgId } from "./db_queries";
import { activateOrganizationMembershipFromInviteHint } from "./memberships";

const trimmedStringSchema = z.string().transform((value) => value.trim());

const workosMembershipEventDataSchema = z.object({
  user_id: trimmedStringSchema.optional(),
  userId: trimmedStringSchema.optional(),
  organization_id: trimmedStringSchema.optional(),
  organizationId: trimmedStringSchema.optional(),
});

type WorkosMembershipEventData = z.infer<typeof workosMembershipEventDataSchema>;

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }

  if (typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableSerialize(nested)}`).join(",")}}`;
}

function hashFNV1a(input: string): string {
  let hash = 0x811c9dc5;

  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

function workosEventFingerprint(eventType: string, data: unknown): string {
  return `${eventType}:${hashFNV1a(stableSerialize(data))}`;
}

async function claimWorkosWebhookReceipt(
  ctx: Pick<MutationCtx, "db">,
  args: { eventType: string; data: unknown; now: number },
): Promise<boolean> {
  const fingerprint = workosEventFingerprint(args.eventType, args.data);

  const existing = await ctx.db
    .query("authWebhookReceipts")
    .withIndex("by_provider_fingerprint", (q) => q.eq("provider", "workos").eq("fingerprint", fingerprint))
    .unique();

  if (existing) {
    return false;
  }

  await ctx.db.insert("authWebhookReceipts", {
    provider: "workos",
    eventType: args.eventType,
    fingerprint,
    receivedAt: args.now,
  });

  return true;
}

function parseMembershipEventData(value: unknown): WorkosMembershipEventData | null {
  const parsed = workosMembershipEventDataSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }

  return parsed.data;
}

async function applyInviteHintFromMembershipEvent(
  ctx: MutationCtx,
  args: { eventType: string; data: unknown; now: number },
): Promise<void> {
  const parsed = parseMembershipEventData(args.data);
  if (!parsed) {
    return;
  }

  const workosUserId = parsed.user_id ?? parsed.userId;
  const workosOrgId = parsed.organization_id ?? parsed.organizationId;
  if (!workosUserId || !workosOrgId) {
    return;
  }

  const [account, organization] = await Promise.all([
    getAccountByWorkosId(ctx, workosUserId),
    getOrganizationByWorkosOrgId(ctx, workosOrgId),
  ]);
  if (!account || !organization) {
    return;
  }

  if (args.eventType === "organization_membership.created" || args.eventType === "organization_membership.updated") {
    await activateOrganizationMembershipFromInviteHint(ctx, {
      organizationId: organization._id,
      accountId: account._id,
      email: account.email,
      now: args.now,
      fallbackRole: "member",
      billable: true,
    });
  }
}

async function applyMembershipDeletionFromEvent(
  ctx: MutationCtx,
  args: { data: unknown; now: number },
): Promise<void> {
  const parsed = parseMembershipEventData(args.data);
  if (!parsed) {
    return;
  }

  const workosUserId = parsed.user_id ?? parsed.userId;
  const workosOrgId = parsed.organization_id ?? parsed.organizationId;
  if (!workosUserId || !workosOrgId) {
    return;
  }

  const [account, organization] = await Promise.all([
    getAccountByWorkosId(ctx, workosUserId),
    getOrganizationByWorkosOrgId(ctx, workosOrgId),
  ]);
  if (!account || !organization) {
    return;
  }

  const membership = await ctx.db
    .query("organizationMembers")
    .withIndex("by_org_account", (q) => q.eq("organizationId", organization._id).eq("accountId", account._id))
    .unique();
  if (!membership) {
    return;
  }

  await ctx.db.patch(membership._id, {
    status: "removed",
    billable: false,
    updatedAt: args.now,
  });
}

async function recordAndHandleMembershipHint(
  ctx: MutationCtx,
  args: { eventType: string; data: unknown },
): Promise<void> {
  const now = Date.now();
  const claimed = await claimWorkosWebhookReceipt(ctx, {
    eventType: args.eventType,
    data: args.data,
    now,
  });
  if (!claimed) {
    return;
  }

  await applyInviteHintFromMembershipEvent(ctx, {
    eventType: args.eventType,
    data: args.data,
    now,
  });
}

async function recordNoopWorkosEvent(ctx: MutationCtx, args: { eventType: string; data: unknown }): Promise<void> {
  await claimWorkosWebhookReceipt(ctx, {
    eventType: args.eventType,
    data: args.data,
    now: Date.now(),
  });
}

export const workosEventHandlers = {
  "user.created": async (ctx, event) => {
    const now = Date.now();
    const claimed = await claimWorkosWebhookReceipt(ctx, {
      eventType: "user.created",
      data: event.data,
      now,
    });
    if (!claimed) {
      return;
    }

    const data = event.data;
    const fullName = [data.firstName, data.lastName].filter(Boolean).join(" ") || data.email;

    await upsertWorkosAccount(ctx, {
      workosUserId: data.id,
      email: data.email,
      fullName,
      firstName: data.firstName ?? undefined,
      lastName: data.lastName ?? undefined,
      avatarUrl: data.profilePictureUrl ?? undefined,
      now,
      includeLastLoginAt: true,
    });
  },

  "user.updated": async (ctx, event) => {
    const now = Date.now();
    const claimed = await claimWorkosWebhookReceipt(ctx, {
      eventType: "user.updated",
      data: event.data,
      now,
    });
    if (!claimed) {
      return;
    }

    const account = await getAccountByWorkosId(ctx, event.data.id);
    if (!account) {
      return;
    }

    const fullName = [event.data.firstName, event.data.lastName].filter(Boolean).join(" ") || event.data.email;
    await ctx.db.patch(account._id, {
      email: event.data.email,
      name: fullName,
      firstName: event.data.firstName ?? undefined,
      lastName: event.data.lastName ?? undefined,
      avatarUrl: event.data.profilePictureUrl ?? undefined,
      status: "active",
      updatedAt: now,
    });
  },

  "user.deleted": async (ctx, event) => {
    const now = Date.now();
    const claimed = await claimWorkosWebhookReceipt(ctx, {
      eventType: "user.deleted",
      data: event.data,
      now,
    });
    if (!claimed) {
      return;
    }

    const account = await getAccountByWorkosId(ctx, event.data.id);
    if (!account) {
      return;
    }

    await ctx.db.patch(account._id, {
      status: "deleted",
      updatedAt: now,
    });

    const memberships = await ctx.db
      .query("organizationMembers")
      .withIndex("by_account", (q) => q.eq("accountId", account._id))
      .collect();

    await Promise.all(memberships.map(async (membership) => {
      if (membership.status === "removed" && !membership.billable) {
        return;
      }

      await ctx.db.patch(membership._id, {
        status: "removed",
        billable: false,
        updatedAt: now,
      });
    }));
  },

  "organization.created": async (ctx, event) => {
    await recordNoopWorkosEvent(ctx, {
      eventType: "organization.created",
      data: event.data,
    });
  },

  "organization.updated": async (ctx, event) => {
    await recordNoopWorkosEvent(ctx, {
      eventType: "organization.updated",
      data: event.data,
    });
  },

  "organization.deleted": async (ctx, event) => {
    await recordNoopWorkosEvent(ctx, {
      eventType: "organization.deleted",
      data: event.data,
    });
  },

  "organization_membership.created": async (ctx, event) => {
    await recordAndHandleMembershipHint(ctx, {
      eventType: "organization_membership.created",
      data: event.data,
    });
  },

  "organization_membership.updated": async (ctx, event) => {
    await recordAndHandleMembershipHint(ctx, {
      eventType: "organization_membership.updated",
      data: event.data,
    });
  },

  "organization_membership.deleted": async (ctx, event) => {
    const now = Date.now();
    const claimed = await claimWorkosWebhookReceipt(ctx, {
      eventType: "organization_membership.deleted",
      data: event.data,
      now,
    });
    if (!claimed) {
      return;
    }

    await applyMembershipDeletionFromEvent(ctx, {
      data: event.data,
      now,
    });
  },
} satisfies Partial<Parameters<AuthKit<DataModel>["events"]>[0]>;
