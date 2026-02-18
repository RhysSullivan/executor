import type { Id } from "../../convex/_generated/dataModel.d.ts";

type WorkspaceAccessIdentity = {
  accountId: Id<"accounts">;
};

export function canonicalAccountIdForWorkspaceAccess(access: WorkspaceAccessIdentity): Id<"accounts"> {
  return access.accountId;
}

export function assertMatchesCanonicalAccountId(
  providedAccountId: string | undefined,
  canonicalAccountId: Id<"accounts">,
  fieldName = "accountId",
): void {
  if (providedAccountId && providedAccountId !== canonicalAccountId) {
    throw new Error(`${fieldName} must match the authenticated workspace account`);
  }
}

type WorkspaceProvider = "workos" | "anonymous";

export function canonicalClientIdForWorkspaceAccess(args: {
  provider: WorkspaceProvider;
  sessionId?: string;
}): "web" | "mcp" {
  const sessionId = args.sessionId?.trim() || "";
  if (sessionId.startsWith("mcp_")) {
    return "mcp";
  }

  if (args.provider === "anonymous" && sessionId.startsWith("anon_session_")) {
    return "web";
  }

  return "web";
}
