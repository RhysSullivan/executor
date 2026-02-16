import { components } from "../../convex/_generated/api";
import type { RunQueryCtx } from "./types";

type WorkosProfile = {
  email?: string;
  firstName?: string | null;
  lastName?: string | null;
  profilePictureUrl?: string | null;
};

function deriveFallbackUserLabel(workosUserId: string): string {
  return `User ${workosUserId.slice(-6)}`;
}

function getIdentityString(identity: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = identity[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export async function getAuthKitUserProfile(ctx: RunQueryCtx, workosUserId: string) {
  try {
    return await ctx.runQuery(components.workOSAuthKit.lib.getAuthUser, {
      id: workosUserId,
    });
  } catch {
    return null;
  }
}

export function resolveIdentityProfile(args: {
  identity: Record<string, unknown> & { subject: string };
  authKitProfile: WorkosProfile | null;
}) {
  const { identity, authKitProfile } = args;

  const email =
    authKitProfile?.email
    ?? getIdentityString(identity, ["email", "upn"]);

  const firstName = authKitProfile?.firstName
    ?? getIdentityString(identity, ["given_name", "first_name"]);

  const lastName = authKitProfile?.lastName
    ?? getIdentityString(identity, ["family_name", "last_name"]);

  const combinedName = [firstName, lastName].filter(Boolean).join(" ").trim();

  const fullName =
    getIdentityString(identity, ["name", "full_name"])
    ?? (combinedName.length > 0 ? combinedName : undefined)
    ?? deriveFallbackUserLabel(identity.subject);

  const avatarUrl =
    (authKitProfile?.profilePictureUrl ?? undefined)
    ?? getIdentityString(identity, ["picture", "avatar_url", "profile_picture_url"]);

  const hintedWorkosOrgId = getIdentityString(identity, ["org_id", "organization_id"]);

  return {
    email,
    firstName,
    lastName,
    fullName,
    avatarUrl,
    hintedWorkosOrgId,
  };
}
