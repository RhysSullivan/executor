import { components } from "../../convex/_generated/api";
import { z } from "zod";
import type { RunQueryCtx } from "./types";

type WorkosProfile = {
  email?: string;
  emailAddress?: string | null;
  name?: string | null;
  fullName?: string | null;
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  picture?: string | null;
  pictureUrl?: string | null;
  avatarUrl?: string | null;
  profilePictureUrl?: string | null;
  metadata?: Record<string, unknown> | null;
  [key: string]: unknown;
};

const nonEmptyTrimmedStringSchema = z.string().transform((value) => value.trim()).refine((value) => value.length > 0);

function deriveFallbackUserLabel(workosUserId: string): string {
  return `User ${workosUserId.slice(-6)}`;
}

function normalizeClaimKey(key: string): string {
  return key.trim().toLowerCase();
}

function claimKeyMatches(actualKey: string, expectedKey: string): boolean {
  const normalizedActual = normalizeClaimKey(actualKey);
  const normalizedExpected = normalizeClaimKey(expectedKey);

  return normalizedActual === normalizedExpected
    || normalizedActual.endsWith(`/${normalizedExpected}`)
    || normalizedActual.endsWith(`:${normalizedExpected}`)
    || normalizedActual.endsWith(`.${normalizedExpected}`);
}

function getIdentityString(identity: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const parsedValue = nonEmptyTrimmedStringSchema.safeParse(identity[key]);
    if (parsedValue.success) {
      return parsedValue.data;
    }
  }

  for (const [actualKey, rawValue] of Object.entries(identity)) {
    if (!keys.some((expectedKey) => claimKeyMatches(actualKey, expectedKey))) {
      continue;
    }

    const parsedValue = nonEmptyTrimmedStringSchema.safeParse(rawValue);
    if (parsedValue.success) {
      return parsedValue.data;
    }
  }

  const nestedRecords = Object.values(identity)
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value));
  for (const nestedRecord of nestedRecords) {
    for (const key of keys) {
      const parsedValue = nonEmptyTrimmedStringSchema.safeParse(nestedRecord[key]);
      if (parsedValue.success) {
        return parsedValue.data;
      }
    }

    for (const [actualKey, rawValue] of Object.entries(nestedRecord)) {
      if (!keys.some((expectedKey) => claimKeyMatches(actualKey, expectedKey))) {
        continue;
      }

      const parsedValue = nonEmptyTrimmedStringSchema.safeParse(rawValue);
      if (parsedValue.success) {
        return parsedValue.data;
      }
    }
  }

  return undefined;
}

function getProfileString(profile: WorkosProfile | null, keys: string[]): string | undefined {
  if (!profile) {
    return undefined;
  }

  const profileRecord = profile as Record<string, unknown>;
  for (const key of keys) {
    const parsedValue = nonEmptyTrimmedStringSchema.safeParse(profileRecord[key]);
    if (parsedValue.success) {
      return parsedValue.data;
    }
  }

  const metadata = profileRecord.metadata;
  if (metadata && typeof metadata === "object") {
    const metadataRecord = metadata as Record<string, unknown>;
    for (const key of keys) {
      const parsedValue = nonEmptyTrimmedStringSchema.safeParse(metadataRecord[key]);
      if (parsedValue.success) {
        return parsedValue.data;
      }
    }
  }

  return undefined;
}

function deriveWorkosUserIdCandidates(subject: string): string[] {
  const normalizedSubject = subject.trim();
  if (!normalizedSubject) {
    return [];
  }

  const candidates: string[] = [normalizedSubject];

  const userIdMatch = normalizedSubject.match(/(user_[A-Za-z0-9]+)/);
  if (userIdMatch?.[1]) {
    candidates.push(userIdMatch[1]);
  }

  const pipeSegment = normalizedSubject.split("|").at(-1)?.trim();
  if (pipeSegment) {
    candidates.push(pipeSegment);
  }

  const colonSegment = normalizedSubject.split(":").at(-1)?.trim();
  if (colonSegment) {
    candidates.push(colonSegment);
  }

  return [...new Set(candidates.filter((candidate) => candidate.length > 0))];
}

export async function getAuthKitUserProfile(ctx: RunQueryCtx, workosUserId: string) {
  const candidateIds = deriveWorkosUserIdCandidates(workosUserId);

  for (const candidateId of candidateIds) {
    try {
      const user = await ctx.runQuery(components.workOSAuthKit.lib.getAuthUser, {
        id: candidateId,
      });

      if (user) {
        return user;
      }
    } catch {
      continue;
    }
  }

  return null;
}

export function resolveIdentityProfile(args: {
  identity: Record<string, unknown> & { subject: string };
  authKitProfile: WorkosProfile | null;
}) {
  const { identity, authKitProfile } = args;

  const email =
    getProfileString(authKitProfile, ["email", "emailAddress", "email_address"])
    ?? getIdentityString(identity, ["email", "upn", "emailAddress"]);

  const firstName = getProfileString(authKitProfile, ["firstName", "first_name", "givenName", "given_name"])
    ?? getIdentityString(identity, ["given_name", "first_name", "givenName", "firstName"]);

  const lastName = getProfileString(authKitProfile, ["lastName", "last_name", "familyName", "family_name"])
    ?? getIdentityString(identity, ["family_name", "last_name", "familyName", "lastName"]);

  const combinedName = [firstName, lastName].filter(Boolean).join(" ").trim();

  const fullName =
    getProfileString(authKitProfile, ["name", "fullName", "full_name", "displayName", "display_name"])
    ?? getIdentityString(identity, ["name", "full_name", "fullName", "display_name", "displayName"])
    ?? (combinedName.length > 0 ? combinedName : undefined)
    ?? deriveFallbackUserLabel(identity.subject);

  const avatarUrl =
    getProfileString(authKitProfile, [
      "profilePictureUrl",
      "profile_picture_url",
      "avatarUrl",
      "avatar_url",
      "pictureUrl",
      "picture_url",
      "picture",
    ])
    ?? getIdentityString(identity, [
      "picture",
      "avatar_url",
      "profile_picture_url",
      "pictureUrl",
      "avatarUrl",
      "profilePictureUrl",
    ]);

  const hintedWorkosOrgId = getIdentityString(identity, ["org_id", "organization_id", "orgId", "organizationId"]);

  return {
    email,
    firstName,
    lastName,
    fullName,
    avatarUrl,
    hintedWorkosOrgId,
  };
}
