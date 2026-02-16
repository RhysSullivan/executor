import type { Id } from "@executor/database/convex/_generated/dataModel";
import type { AnonymousContext } from "@/lib/types";

export interface WorkosAccount {
  _id: Id<"accounts">;
  provider: "workos" | "anonymous";
  providerAccountId: string;
  email?: string;
  name: string;
  avatarUrl?: string | null;
}

export interface WorkspaceListItem {
  id: Id<"workspaces">;
  organizationId: Id<"organizations">;
  organizationName: string;
  organizationSlug: string;
  name: string;
  slug: string;
  iconUrl?: string | null;
  createdAt: number;
}

export interface SessionWorkspaceOption {
  id: Id<"workspaces">;
  docId: Id<"workspaces"> | null;
  name: string;
  organizationId: Id<"organizations"> | null;
  organizationName: string;
  organizationSlug: string;
  iconUrl?: string | null;
}

export function resolveActiveWorkspaceId(
  workspaces: WorkspaceListItem[] | undefined,
  activeWorkspaceId: Id<"workspaces"> | null,
  accountStoredWorkspace: Id<"workspaces"> | null,
) {
  if (!workspaces || workspaces.length === 0) {
    return activeWorkspaceId;
  }

  if (activeWorkspaceId && workspaces.some((workspace) => workspace.id === activeWorkspaceId)) {
    return activeWorkspaceId;
  }

  if (
    accountStoredWorkspace
    && workspaces.some((workspace) => workspace.id === accountStoredWorkspace)
  ) {
    return accountStoredWorkspace;
  }

  return workspaces[0]?.id ?? null;
}

export function buildAccountWorkspaceContext(
  account: WorkosAccount | null | undefined,
  workspaces: WorkspaceListItem[] | undefined,
  resolvedActiveWorkspaceId: Id<"workspaces"> | null,
  storedSessionId: string | null,
  guestSessionId: string | null,
) {
  if (!account || !workspaces || workspaces.length === 0) {
    return null;
  }

  const activeWorkspace =
    workspaces.find((workspace) => workspace.id === resolvedActiveWorkspaceId)
    ?? workspaces[0]
    ?? null;
  if (!activeWorkspace) {
    return null;
  }

  const sessionId = account.provider === "workos"
    ? `workos_${account._id}`
    : (storedSessionId ?? guestSessionId ?? null);
  if (!sessionId) {
    return null;
  }

  return {
    sessionId,
    workspaceId: activeWorkspace.id,
    clientId: "web",
    accountId: account._id,
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
  } satisfies AnonymousContext;
}

export function buildWorkspaceOptions(
  mode: "guest" | "workos" | "anonymous",
  workspaces: WorkspaceListItem[] | undefined,
  guestContext: AnonymousContext | null,
) {
  if (mode !== "guest" && workspaces) {
    return workspaces.map((workspace): SessionWorkspaceOption => {
      return {
        id: workspace.id,
        docId: workspace.id,
        name: workspace.name,
        organizationId: workspace.organizationId,
        organizationName: workspace.organizationName,
        organizationSlug: workspace.organizationSlug,
        iconUrl: workspace.iconUrl,
      };
    });
  }

  if (guestContext) {
    return [
      {
        id: guestContext.workspaceId,
        docId: null,
        name: "Anonymous Workspace",
        organizationId: null,
        organizationName: "Anonymous Organization",
        organizationSlug: "anonymous-organization",
      },
    ];
  }

  return [];
}

export function queryErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message;
  }

  return error ? fallback : null;
}
