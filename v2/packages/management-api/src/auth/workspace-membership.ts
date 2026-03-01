import {
  type AccountId,
  type OrganizationMembership,
  type OrganizationMemberStatus,
  type Role,
  type Workspace,
  type WorkspaceMembership,
} from "@executor-v2/schema";

type WorkspaceMembershipCandidate = Pick<
  WorkspaceMembership,
  "role" | "status" | "grantedAt" | "updatedAt"
>;

const roleRank: Readonly<Record<Role, number>> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};

const toWorkspaceMembershipStatus = (
  status: OrganizationMemberStatus,
): WorkspaceMembership["status"] => {
  switch (status) {
    case "active":
      return "active";
    case "suspended":
      return "suspended";
    default:
      return "revoked";
  }
};

const compareMembershipPriority = (
  left: WorkspaceMembershipCandidate,
  right: WorkspaceMembershipCandidate,
): number => {
  const rankDelta = roleRank[left.role] - roleRank[right.role];
  if (rankDelta !== 0) {
    return rankDelta;
  }

  return left.updatedAt - right.updatedAt;
};

export const deriveWorkspaceMembershipsForPrincipal = (input: {
  principalAccountId: AccountId;
  workspaceId: Workspace["id"];
  workspace: Workspace | null;
  organizationMemberships: ReadonlyArray<OrganizationMembership>;
}): ReadonlyArray<WorkspaceMembership> => {
  if (input.workspace === null) {
    return [];
  }

  const candidates: Array<WorkspaceMembershipCandidate> = [];

  if (input.workspace.createdByAccountId === input.principalAccountId) {
    candidates.push({
      role: "owner",
      status: "active",
      grantedAt: input.workspace.createdAt,
      updatedAt: input.workspace.updatedAt,
    });
  }

  for (const membership of input.organizationMemberships) {
    if (membership.accountId !== input.principalAccountId) {
      continue;
    }

    if (membership.organizationId !== input.workspace.organizationId) {
      continue;
    }

    candidates.push({
      role: membership.role,
      status: toWorkspaceMembershipStatus(membership.status),
      grantedAt: membership.joinedAt ?? membership.createdAt,
      updatedAt: membership.updatedAt,
    });
  }

  const activeCandidates = candidates.filter(
    (candidate) => candidate.status === "active",
  );

  if (activeCandidates.length === 0) {
    return [];
  }

  const selected = activeCandidates.reduce((best, candidate) =>
    compareMembershipPriority(candidate, best) > 0 ? candidate : best,
  );

  return [
    {
      accountId: input.principalAccountId,
      workspaceId: input.workspaceId,
      role: selected.role,
      status: selected.status,
      grantedAt: selected.grantedAt,
      updatedAt: selected.updatedAt,
    },
  ];
};
