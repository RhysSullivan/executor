import type { Id } from "@executor/database/convex/_generated/dataModel";

const SESSION_KEY = "executor_session_id";
const ACTIVE_WORKSPACE_KEY = "executor_active_workspace_id";
const ACTIVE_WORKSPACE_BY_ACCOUNT_KEY = "executor_active_workspace_by_account";

export function readStoredSessionId() {
  if (typeof window === "undefined") {
    return null;
  }

  return localStorage.getItem(SESSION_KEY);
}

export function readStoredActiveWorkspaceId() {
  if (typeof window === "undefined") {
    return null;
  }

  return localStorage.getItem(ACTIVE_WORKSPACE_KEY) as Id<"workspaces"> | null;
}

export function persistSessionId(sessionId: string) {
  localStorage.setItem(SESSION_KEY, sessionId);
}

export function persistActiveWorkspaceId(workspaceId: Id<"workspaces">) {
  localStorage.setItem(ACTIVE_WORKSPACE_KEY, workspaceId);
}

export function clearSessionStorage() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(ACTIVE_WORKSPACE_KEY);
}

export function readWorkspaceByAccount() {
  const raw = localStorage.getItem(ACTIVE_WORKSPACE_BY_ACCOUNT_KEY);
  if (!raw) {
    return {} as Record<string, Id<"workspaces">>;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, Id<"workspaces">>;
    return parsed ?? {};
  } catch {
    return {};
  }
}

function writeWorkspaceByAccount(value: Record<string, Id<"workspaces">>) {
  localStorage.setItem(ACTIVE_WORKSPACE_BY_ACCOUNT_KEY, JSON.stringify(value));
}

export function persistWorkspaceForAccount(accountId: string, workspaceId: Id<"workspaces">) {
  const byAccount = readWorkspaceByAccount();
  writeWorkspaceByAccount({
    ...byAccount,
    [accountId]: workspaceId,
  });
}
