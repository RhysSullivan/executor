import type { Id } from "@executor/database/convex/_generated/dataModel";
import { z } from "zod";

const SESSION_KEY = "executor_session_id";
const ACTIVE_WORKSPACE_KEY = "executor_active_workspace_id";
const ACTIVE_WORKSPACE_BY_ACCOUNT_KEY = "executor_active_workspace_by_account";

const workspaceByAccountSchema = z.record(z.string(), z.string());

function isWorkspaceId(value: string): value is Id<"workspaces"> {
  return value.trim().length > 0;
}

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

  const stored = localStorage.getItem(ACTIVE_WORKSPACE_KEY);
  if (!stored || !isWorkspaceId(stored)) {
    return null;
  }

  return stored;
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

export function readWorkspaceByAccount(): Record<string, Id<"workspaces">> {
  if (typeof window === "undefined") {
    return {};
  }

  const raw = localStorage.getItem(ACTIVE_WORKSPACE_BY_ACCOUNT_KEY);
  if (!raw) {
    return {};
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return {};
  }

  const parsedMap = workspaceByAccountSchema.safeParse(parsedJson);
  if (!parsedMap.success) {
    return {};
  }

  let changed = false;
  const cleaned: Record<string, Id<"workspaces">> = {};
  for (const [accountIdRaw, workspaceIdRaw] of Object.entries(parsedMap.data)) {
    const accountId = accountIdRaw.trim();
    const workspaceId = workspaceIdRaw.trim();
    if (!accountId || !isWorkspaceId(workspaceId)) {
      changed = true;
      continue;
    }

    if (accountId !== accountIdRaw || workspaceId !== workspaceIdRaw) {
      changed = true;
    }

    cleaned[accountId] = workspaceId;
  }

  if (changed) {
    writeWorkspaceByAccount(cleaned);
  }

  return cleaned;
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
