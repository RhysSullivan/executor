"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { Mail, UserMinus, Users, X } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSession } from "@/lib/session-context";
import { convexApi } from "@/lib/convex-api";
import type { Id } from "@executor/database/convex/_generated/dataModel";

type Role = "owner" | "admin" | "member" | "billing_admin";
type MemberStatus = "active" | "pending" | "removed";
type InviteStatus = "pending" | "accepted" | "expired" | "revoked" | "failed";

interface OrganizationMemberListItem {
  id: Id<"organizationMembers">;
  organizationId: Id<"organizations">;
  accountId: Id<"accounts">;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
  role: Role;
  status: MemberStatus;
  billable: boolean;
  joinedAt: number | null;
}

interface OrganizationInviteListItem {
  id: Id<"invites">;
  organizationId: Id<"organizations">;
  email: string;
  role: Role;
  status: InviteStatus;
  expiresAt: number;
  createdAt: number;
}

const ROLE_OPTIONS: Role[] = ["owner", "admin", "member", "billing_admin"];

interface MembersViewProps {
  showHeader?: boolean;
}

export function MembersView({ showHeader = true }: MembersViewProps) {
  const {
    context,
    workspaces,
  } = useSession();

  const derivedOrganizationId = context
    ? workspaces.find((workspace) => workspace.id === context.workspaceId)?.organizationId ?? null
    : null;
  const typedOrganizationId = derivedOrganizationId;

  const members = useQuery(
    convexApi.organizationMembers.list,
    typedOrganizationId
      ? { organizationId: typedOrganizationId, sessionId: context?.sessionId ?? undefined }
      : "skip",
  );

  const memberItems: OrganizationMemberListItem[] = members?.items ?? [];
  const accountMembership = memberItems.find((member: { accountId?: string; role?: string }) =>
    context ? member.accountId === context.accountId : false,
  );
  const accountRole = accountMembership?.role ?? null;
  const canManageMembers = accountRole === "owner" || accountRole === "admin";
  const canManageBilling = accountRole === "owner" || accountRole === "admin" || accountRole === "billing_admin";

  const updateRole = useMutation(convexApi.organizationMembers.updateRole);
  const updateBillable = useMutation(convexApi.organizationMembers.updateBillable);
  const removeMember = useMutation(convexApi.organizationMembers.remove);
  const listInvites = useQuery(
    convexApi.invites.list,
    typedOrganizationId && canManageMembers
      ? { organizationId: typedOrganizationId, sessionId: context?.sessionId ?? undefined }
      : "skip",
  );
  const createInvite = useMutation(convexApi.invites.create);
  const revokeInvite = useMutation(convexApi.invites.revoke);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("member");
  const [inviteState, setInviteState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [inviteMessage, setInviteMessage] = useState<string | null>(null);
  const [busyMemberAccountId, setBusyMemberAccountId] = useState<Id<"accounts"> | null>(null);
  const [busyInviteId, setBusyInviteId] = useState<Id<"invites"> | null>(null);

  const inviteItems: OrganizationInviteListItem[] = listInvites?.items ?? [];
  const pendingInviteItems = inviteItems.filter((invite) => invite.status === "pending" || invite.status === "failed");

  const submitInvite = async () => {
    if (!typedOrganizationId) {
      return;
    }
    setInviteState("sending");
    setInviteMessage(null);
    try {
      const result = await createInvite({
        organizationId: typedOrganizationId,
        email: inviteEmail.trim(),
        role: inviteRole,
        sessionId: context?.sessionId ?? undefined,
      });
      setInviteState("sent");
      const deliveryProvider = result.delivery.provider ?? "email";
      const deliveryState = result.delivery.state ?? "queued";
      setInviteMessage(`Invite ${deliveryState} via ${deliveryProvider}.`);
      setInviteEmail("");
    } catch (error) {
      setInviteState("failed");
      setInviteMessage(error instanceof Error ? error.message : "Failed to send invite");
    }
  };

  const handleInviteSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await submitInvite();
  };

  if (!typedOrganizationId) {
    return (
      <div className="space-y-6">
        {showHeader ? <PageHeader title="Members" description="Manage organization membership and invites" /> : null}
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Select a workspace to manage members.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {showHeader ? (
        <PageHeader
          title="Members"
          description="Invite teammates, update roles, and manage billable seats"
        />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <Mail className="h-4 w-4" />
            Invite Member
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <form className="flex flex-col md:flex-row gap-2" onSubmit={handleInviteSubmit}>
            <Input
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder="teammate@company.com"
              type="email"
              disabled={!canManageMembers || inviteState === "sending"}
            />
            <Select
              value={inviteRole}
              onValueChange={(value) => setInviteRole(value as Role)}
              disabled={!canManageMembers || inviteState === "sending"}
            >
              <SelectTrigger className="h-9 min-w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((role) => (
                  <SelectItem key={role} value={role}>
                    {role}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="submit"
              disabled={!canManageMembers || inviteState === "sending" || inviteEmail.trim().length === 0}
            >
              {inviteState === "sending" ? "Sending..." : "Send invite"}
            </Button>
          </form>

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
            Workspace Members
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
                    <Select
                      value={member.role}
                      disabled={!canManageMembers || busyMemberAccountId === member.accountId}
                      onValueChange={async (value) => {
                        setBusyMemberAccountId(member.accountId);
                        try {
                          if (!typedOrganizationId) {
                            return;
                          }
                          await updateRole({
                            organizationId: typedOrganizationId,
                            accountId: member.accountId,
                            role: value as Role,
                            sessionId: context?.sessionId ?? undefined,
                          });
                        } finally {
                          setBusyMemberAccountId(null);
                        }
                      }}
                    >
                      <SelectTrigger className="h-8 min-w-36">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLE_OPTIONS.map((role) => (
                          <SelectItem key={role} value={role}>
                            {role}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      disabled={!canManageBilling || busyMemberAccountId === member.accountId}
                      onClick={async () => {
                        setBusyMemberAccountId(member.accountId);
                        try {
                          if (!typedOrganizationId) {
                            return;
                          }
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
                          if (!typedOrganizationId) {
                            return;
                          }
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
          {!canManageMembers ? (
            <p className="text-sm text-muted-foreground">Only organization admins can view pending invites.</p>
          ) : pendingInviteItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No pending invites.</p>
          ) : (
            pendingInviteItems.map((invite) => (
              <div key={invite.id} className="rounded-md border border-border p-3 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium">{invite.email}</p>
                    <p className="text-xs text-muted-foreground">Role: {invite.role}</p>
                    <p className="text-xs text-muted-foreground">Status: {invite.status}</p>
                  </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs"
                      disabled={!canManageMembers || busyInviteId === invite.id}
                      onClick={async () => {
                        if (!typedOrganizationId) {
                          return;
                        }

                        setBusyInviteId(invite.id);
                        try {
                          await revokeInvite({
                            organizationId: typedOrganizationId,
                            inviteId: invite.id,
                            sessionId: context?.sessionId ?? undefined,
                          });
                        } finally {
                          setBusyInviteId(null);
                        }
                      }}
                    >
                    <X className="mr-1 h-3.5 w-3.5" />
                    Revoke
                  </Button>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
