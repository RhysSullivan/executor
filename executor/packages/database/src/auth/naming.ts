import { slugify } from "../../../core/src/identity";
import { ensureUniqueSlug } from "../../../core/src/slug";
import type { DbCtx } from "./types";

function titleCaseWords(input: string): string {
  return input
    .split(" ")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase())
    .join(" ");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isGeneratedIdentityLabel(value: string, workosUserId: string): boolean {
  const normalizedValue = value.trim();
  const normalizedWorkosUserId = workosUserId.trim();
  if (!normalizedValue) {
    return false;
  }

  const fallbackSuffix = normalizedWorkosUserId.slice(-6);
  if (fallbackSuffix && new RegExp(`^user\\s+${escapeRegex(fallbackSuffix)}$`, "i").test(normalizedValue)) {
    return true;
  }

  if (/^user\s+[a-z0-9]{6,}$/i.test(normalizedValue)) {
    return true;
  }

  if (/^(?:workos\|)?user_[a-z0-9]+$/i.test(normalizedValue)) {
    return true;
  }

  if (/^(?:[a-z0-9]+[|:/._-])*user_[a-z0-9]+$/i.test(normalizedValue)) {
    return true;
  }

  return normalizedValue.toLowerCase() === normalizedWorkosUserId.toLowerCase();
}

export function isGeneratedPersonalOrganizationName(name: string, workosUserId: string): boolean {
  if (/workspace$/i.test(name)) {
    return true;
  }

  if (/^user(?:[\s_][a-z0-9]+)?'s organization$/i.test(name)) {
    return true;
  }

  return new RegExp(`^${escapeRegex(workosUserId)}'s organization$`, "i").test(name);
}

export function isGeneratedPersonalWorkspaceName(name: string, workosUserId: string): boolean {
  if (/^my'?s workspace$/i.test(name)) {
    return true;
  }

  if (/^user(?:[\s_][a-z0-9]+)?'s workspace$/i.test(name)) {
    return true;
  }

  return new RegExp(`^${escapeRegex(workosUserId)}'s workspace$`, "i").test(name);
}

function deriveOwnerLabel(args: { firstName?: string; fullName?: string; email?: string; workosUserId: string }): string {
  const firstName = args.firstName?.trim();
  if (firstName && !/^my$/i.test(firstName) && !/^user$/i.test(firstName)) {
    return firstName;
  }

  const fullName = args.fullName?.trim();
  if (fullName && !fullName.includes("@") && !isGeneratedIdentityLabel(fullName, args.workosUserId)) {
    return fullName;
  }

  const emailLocalPart = args.email?.split("@")[0]?.trim();
  if (emailLocalPart) {
    const normalized = emailLocalPart
      .replace(/[._-]+/g, " ")
      .replace(/[^a-zA-Z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (normalized.length > 0) {
      return titleCaseWords(normalized);
    }
  }

  return `User ${args.workosUserId.slice(-6)}`;
}

export function derivePersonalNames(args: { firstName?: string; fullName?: string; email?: string; workosUserId: string }) {
  const ownerLabel = deriveOwnerLabel(args);
  return {
    organizationName: `${ownerLabel}'s Organization`,
    workspaceName: `${ownerLabel}'s Workspace`,
  };
}

export function buildPersonalWorkspaceSlugSeed(email: string | undefined, workosUserId: string): string {
  const baseSlug = slugify(email?.split("@")[0] ?? workosUserId, "workspace");
  return `${baseSlug}-${workosUserId.slice(-6)}`;
}

export async function generateUniqueOrganizationSlug(ctx: DbCtx, baseName: string): Promise<string> {
  const baseSlug = slugify(baseName, "workspace");
  return await ensureUniqueSlug(baseSlug, async (candidate) => {
    const collision = await ctx.db
      .query("organizations")
      .withIndex("by_slug", (q) => q.eq("slug", candidate))
      .unique();
    return collision !== null;
  });
}
