import { WorkOS } from "@workos-inc/node";

const workosClient = process.env.WORKOS_API_KEY ? new WorkOS(process.env.WORKOS_API_KEY) : null;

export const workosEnabled = Boolean(process.env.WORKOS_CLIENT_ID && process.env.WORKOS_API_KEY);

type WorkosInvitationResponse = {
  id: string;
  state: string;
  expires_at?: string;
};

function requireWorkosClient(): WorkOS {
  if (!workosClient) {
    throw new Error("WORKOS_API_KEY is required for WorkOS invite operations");
  }
  return workosClient;
}

export async function sendWorkosInvitation(args: {
  email: string;
  workosOrgId: string;
  inviterWorkosUserId: string;
  expiresInDays?: number;
  roleSlug?: string;
}): Promise<WorkosInvitationResponse> {
  const workos = requireWorkosClient();
  const invitation = await workos.userManagement.sendInvitation({
    email: args.email,
    organizationId: args.workosOrgId,
    inviterUserId: args.inviterWorkosUserId,
    expiresInDays: args.expiresInDays,
    roleSlug: args.roleSlug,
  });

  return {
    id: invitation.id,
    state: invitation.state,
    expires_at: invitation.expiresAt ?? undefined,
  };
}

export async function createWorkosOrganization(name: string): Promise<{ id: string }> {
  const workos = requireWorkosClient();
  const organization = await workos.organizations.createOrganization({ name });
  return {
    id: organization.id,
  };
}

export async function updateWorkosOrganizationName(workosOrgId: string, name: string): Promise<void> {
  const workos = requireWorkosClient();
  await workos.organizations.updateOrganization({
    organization: workosOrgId,
    name,
  });
}

function isDuplicateWorkosMembershipError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("already") && (message.includes("membership") || message.includes("organization"));
}

export async function ensureWorkosOrganizationMembership(args: {
  workosOrgId: string;
  workosUserId: string;
}): Promise<void> {
  const workos = requireWorkosClient();

  try {
    await workos.userManagement.createOrganizationMembership({
      organizationId: args.workosOrgId,
      userId: args.workosUserId,
    });
  } catch (error) {
    if (isDuplicateWorkosMembershipError(error)) {
      return;
    }
    throw error;
  }
}

export async function revokeWorkosInvitation(invitationId: string): Promise<void> {
  const workos = requireWorkosClient();
  await workos.userManagement.revokeInvitation(invitationId);
}

export function mapRoleToWorkosRoleSlug(role: "owner" | "admin" | "member" | "billing_admin"): string | undefined {
  if (role === "admin" || role === "owner") {
    return "admin";
  }
  if (role === "member") {
    return "member";
  }
  return undefined;
}
