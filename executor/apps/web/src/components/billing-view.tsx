"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, BadgeCheck, CreditCard, RefreshCcw } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useSession } from "@/lib/session-context";

export function BillingView() {
  const { context, organizations, workspaces } = useSession();
  const [actionState, setActionState] = useState<"idle" | "running" | "error">("idle");
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const derivedOrganizationId = context
    ? workspaces.find((workspace) => workspace.id === context.workspaceId)?.organizationId ?? null
    : null;
  const activeWorkspace = context
    ? workspaces.find((workspace) => workspace.id === context.workspaceId) ?? null
    : null;
  const effectiveOrganizationId = derivedOrganizationId;
  const hasLegacyOrganizationWorkspace = activeWorkspace?.kind === "organization" && !effectiveOrganizationId;

  const activeOrganization = useMemo(
    () => organizations.find((organization) => organization.id === effectiveOrganizationId) ?? null,
    [organizations, effectiveOrganizationId],
  );
  const canManageBilling = activeOrganization
    ? ["owner", "billing_admin"].includes(activeOrganization.role)
    : false;

  const notReady = () => {
    setActionState("error");
    setActionMessage("Billing actions are waiting on backend endpoints.");
  };

  if (!effectiveOrganizationId && !hasLegacyOrganizationWorkspace) {
    return (
      <div className="space-y-6">
        <PageHeader title="Billing" description="Plan, seats, and subscription management" />
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Select a workspace to manage billing.
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!effectiveOrganizationId && hasLegacyOrganizationWorkspace) {
    return (
      <div className="space-y-6">
        <PageHeader title="Billing" description="Plan, seats, and subscription management" />
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Billing is waiting for workspace provisioning to finish. This workspace is missing its
            internal organization link.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Billing" description="Manage subscription, seats, and billing portal access" />

      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          Billing backend wiring is still in progress. This screen is ready for `billing.getSummary`,
          `billing.createSubscriptionCheckout`, `billing.createCustomerPortal`, and `billing.retrySeatSync`.
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground flex items-center gap-2">
          <RefreshCcw className="h-4 w-4" />
          Billing sync pending. Numbers may be briefly stale during webhook processing.
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 text-sm text-destructive flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            If seat sync fails, use retry once the backend endpoint is available.
          </span>
          <Button variant="outline" size="sm" onClick={notReady} disabled={!canManageBilling || actionState === "running"}>
            Retry sync
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Subscription</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Status: pending</p>
            <p>Price: -</p>
            <p>Renewal: -</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Seats</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Billable members: -</p>
            <p>Desired seats: -</p>
            <p>Last applied: -</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button className="w-full" onClick={notReady} disabled={!canManageBilling || actionState === "running"}>
              <CreditCard className="mr-2 h-4 w-4" />
              Start checkout
            </Button>
            <Button variant="outline" className="w-full" onClick={notReady} disabled={!canManageBilling || actionState === "running"}>
              <BadgeCheck className="mr-2 h-4 w-4" />
              Manage billing portal
            </Button>
          </CardContent>
        </Card>
      </div>

      {actionMessage ? (
        <p className={actionState === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
          {actionMessage}
        </p>
      ) : null}
    </div>
  );
}
