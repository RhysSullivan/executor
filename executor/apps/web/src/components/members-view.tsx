"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Mail, UserMinus, Users } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useSession } from "@/lib/session-context";
import { convexApi } from "@/lib/convex-api";

type Role = "owner" | "admin" | "member" | "billing_admin";

const ROLE_OPTIONS: Role[] = ["owner", "admin", "member", "billing_admin"];

export function MembersView() {
  const {
    context,
    clientConfig,
    organizations,
    selectedOrganizationId,
    workspaces,
  } = useSession();

  const derivedOrganizationId = context
    ? workspaces.find((workspace) => workspace.id === context.workspaceId)?.organizationId ?? null
    : null;
  const activeWorkspace = context
    ? workspaces.find((workspace) => workspace.id === context.workspaceId) ?? null
    : null;
  const typedOrganizationId = derivedOrganizationId;
  const effectiveOrganizationId = typedOrganizationId ?? selectedOrganizationId;
  const hasLegacyOrganizationWorkspace = Boolean(activeWorkspace) && !typedOrganizationId;

  const members = useQuery(
    convexApi.organizationMembers.list,
    typedOrganizationId
      ? { organizationId: typedOrganizationId, sessionId: context?.sessionId ?? undefined }
      : "skip",
  );

  const updateRole = useMutation(convexApi.organizationMembers.updateRole);
  const updateBillable = useMutation(convexApi.organizationMembers.updateBillable);
  const removeMember = useMutation(convexApi.organizationMembers.remove);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("member");
  const [inviteState, setInviteState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [inviteMessage, setInviteMessage] = useState<string | null>(null);
  const [busyMemberAccountId, setBusyMemberAccountId] = useState<string | null>(null);

  const activeOrganization = useMemo(
    () => organizations.find((organization) => organization.id === effectiveOrganizationId) ?? null,
    [organizations, effectiveOrganizationId],
  );

  const canManageMembers = activeOrganization
    ? activeOrganization.role === "owner" || activeOrganization.role === "admin"
    : false;
  const canManageBilling = activeOrganization
    ? activeOrganization.role === "owner" || activeOrganization.role === "admin" || activeOrganization.role === "billing_admin"
    : false;

  const memberItems = members?.items ?? [];
  const inviteItems: Array<{ id: string; email: string; role: string; status: string }> = [];

  const submitInvite = async () => {
    if (!typedOrganizationId) {
      return;
    }
    setInviteState("sending");
    setInviteMessage(null);
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const deliveryProvider = clientConfig?.invitesProvider ?? "local";
      setInviteState("failed");
      setInviteMessage(`Invite creation via ${deliveryProvider} is not wired yet on backend.`);
    } catch (error) {
      setInviteState("failed");
      setInviteMessage(error instanceof Error ? error.message : "Failed to send invite");
    }
  };

  if (!typedOrganizationId && !hasLegacyOrganizationWorkspace) {
    return (
      <div className="space-y-6">
        <PageHeader title="Members" description="Manage organization membership and invites" />
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Select an organization from the switcher to manage members.
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!typedOrganizationId && hasLegacyOrganizationWorkspace) {
    return (
      <div className="space-y-6">
        <PageHeader title="Members" description="Manage organization membership and invites" />
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Member management is waiting for an organization record for this workspace. The active
            workspace does not have a linked `organizationId` yet.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Members"
        description="Invite teammates, update roles, and manage billable seats"
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Mail className="h-4 w-4" />
            Invite Member
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col md:flex-row gap-2">
            <Input
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder="teammate@company.com"
              type="email"
              disabled={!canManageMembers || inviteState === "sending"}
            />
            <select
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={inviteRole}
              onChange={(event) => setInviteRole(event.target.value as Role)}
              disabled={!canManageMembers || inviteState === "sending"}
            >
              {ROLE_OPTIONS.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
            <Button
              onClick={submitInvite}
              disabled={!canManageMembers || inviteState === "sending" || inviteEmail.trim().length === 0}
            >
              {inviteState === "sending" ? "Sending..." : "Send invite"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Provider: {clientConfig?.invitesProvider === "workos" ? "WorkOS" : "Local invite flow"}
          </p>
          {inviteMessage ? (
            <p className={inviteState === "failed" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
              {inviteMessage}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Users className="h-4 w-4" />
            Organization Members
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {memberItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No members found.</p>
          ) : (
            memberItems.map((member) => (
              <div key={member.id} className="rounded-md border border-border p-3">
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="text-sm font-medium">{member.displayName}</p>
                    <p className="text-xs text-muted-foreground">{member.email ?? "No email"}</p>
                    <p className="text-xs text-muted-foreground">Status: {member.status}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                      value={member.role}
                      disabled={!canManageMembers || busyMemberAccountId === member.accountId}
                      onChange={async (event) => {
                        setBusyMemberAccountId(member.accountId);
                        try {
                          await updateRole({
                            organizationId: typedOrganizationId,
                            accountId: member.accountId,
                            role: event.target.value,
                            sessionId: context?.sessionId ?? undefined,
                          });
                        } finally {
                          setBusyMemberAccountId(null);
                        }
                      }}
                    >
                      {ROLE_OPTIONS.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>

                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      disabled={!canManageBilling || busyMemberAccountId === member.accountId}
                      onClick={async () => {
                        setBusyMemberAccountId(member.accountId);
                        try {
                          await updateBillable({
                            organizationId: typedOrganizationId,
                            accountId: member.accountId,
                            billable: !member.billable,
                            sessionId: context?.sessionId ?? undefined,
                          });
                        } finally {
                          setBusyMemberAccountId(null);
                        }
                      }}
                    >
                      Billable: {member.billable ? "Yes" : "No"}
                    </Button>

                    <Button
                      variant="destructive"
                      size="sm"
                      className="h-8 text-xs"
                      disabled={!canManageMembers || busyMemberAccountId === member.accountId}
                      onClick={async () => {
                        setBusyMemberAccountId(member.accountId);
                        try {
                          await removeMember({
                            organizationId: typedOrganizationId,
                            accountId: member.accountId,
                            sessionId: context?.sessionId ?? undefined,
                          });
                        } finally {
                          setBusyMemberAccountId(null);
                        }
                      }}
                    >
                      <UserMinus className="mr-1 h-3.5 w-3.5" />
                      Remove
                    </Button>
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Pending Invites</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {inviteItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No invites yet.</p>
          ) : (
            inviteItems.map((invite) => (
              <div key={invite.id} className="rounded-md border border-border p-3 text-sm">
                <p className="font-medium">{invite.email}</p>
                <p className="text-xs text-muted-foreground">Role: {invite.role}</p>
                <p className="text-xs text-muted-foreground">Status: {invite.status}</p>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
