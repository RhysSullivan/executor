"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import { AlertTriangle, BadgeCheck, CreditCard, RefreshCcw } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { convexApi } from "@/lib/convex-api";
import { useSession } from "@/lib/session-context";

interface BillingViewProps {
  showHeader?: boolean;
}

type BillingSummary = {
  customer: {
    stripeCustomerId: string;
  } | null;
  subscription: {
    stripeSubscriptionId: string;
    stripePriceId: string;
    status: string;
    currentPeriodEnd: number | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  seats: {
    billableMembers: number;
    desiredSeats: number;
    lastAppliedSeats: number | null;
  };
  sync: {
    status: "ok" | "error" | "pending";
    lastSyncAt: number | null;
    error: string | null;
  };
};

function formatTimestamp(value: number | null | undefined): string {
  if (!value || !Number.isFinite(value)) {
    return "-";
  }

  const millis = value > 1_000_000_000_000 ? value : value * 1_000;
  return new Date(millis).toLocaleString();
}

export function BillingView({ showHeader = true }: BillingViewProps) {
  const { context, organizations, organizationsLoading, workspaces } = useSession();
  const [searchParams] = useSearchParams();
  const [actionState, setActionState] = useState<"idle" | "running" | "success" | "error">("idle");
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [priceId, setPriceId] = useState(() => process.env.NEXT_PUBLIC_STRIPE_PRICE_ID ?? "");

  const derivedOrganizationId = context
    ? workspaces.find((workspace) => workspace.id === context.workspaceId)?.organizationId ?? null
    : null;
  const effectiveOrganizationId = derivedOrganizationId;

  const activeOrganization = useMemo(
    () => organizations.find((organization) => organization.id === effectiveOrganizationId) ?? null,
    [organizations, effectiveOrganizationId],
  );

  const canManageBilling = activeOrganization
    ? ["owner", "admin", "billing_admin"].includes(activeOrganization.role)
    : false;

  const summary = useQuery(
    convexApi.billing.getSummary,
    effectiveOrganizationId
      ? {
          organizationId: effectiveOrganizationId,
          sessionId: context?.sessionId ?? undefined,
        }
      : "skip",
  ) as BillingSummary | undefined;

  const createSubscriptionCheckout = useAction(convexApi.billing.createSubscriptionCheckout);
  const createCustomerPortal = useAction(convexApi.billing.createCustomerPortal);
  const retrySeatSync = useMutation(convexApi.billing.retrySeatSync);

  const checkoutSuccess = searchParams.get("success") === "true";
  const checkoutCanceled = searchParams.get("canceled") === "true";

  const handleStartCheckout = async () => {
    if (!effectiveOrganizationId || !canManageBilling) {
      return;
    }

    if (!priceId.trim()) {
      setActionState("error");
      setActionMessage("Set a Stripe price ID before starting checkout.");
      return;
    }

    setActionState("running");
    setActionMessage(null);
    try {
      const session = await createSubscriptionCheckout({
        organizationId: effectiveOrganizationId,
        priceId: priceId.trim(),
        sessionId: context?.sessionId ?? undefined,
      });

      if (session.url) {
        window.location.assign(session.url);
        return;
      }

      setActionState("success");
      setActionMessage("Checkout session created.");
    } catch (error) {
      setActionState("error");
      setActionMessage(error instanceof Error ? error.message : "Failed to start checkout");
    }
  };

  const handleOpenPortal = async () => {
    if (!effectiveOrganizationId || !canManageBilling) {
      return;
    }

    setActionState("running");
    setActionMessage(null);
    try {
      const result = await createCustomerPortal({
        organizationId: effectiveOrganizationId,
        sessionId: context?.sessionId ?? undefined,
      });
      window.location.assign(result.url);
    } catch (error) {
      setActionState("error");
      setActionMessage(error instanceof Error ? error.message : "Failed to open billing portal");
    }
  };

  const handleRetrySync = async () => {
    if (!effectiveOrganizationId || !canManageBilling) {
      return;
    }

    setActionState("running");
    setActionMessage(null);
    try {
      await retrySeatSync({
        organizationId: effectiveOrganizationId,
        sessionId: context?.sessionId ?? undefined,
      });
      setActionState("success");
      setActionMessage("Seat sync queued.");
    } catch (error) {
      setActionState("error");
      setActionMessage(error instanceof Error ? error.message : "Failed to queue seat sync");
    }
  };

  if (!effectiveOrganizationId) {
    return (
      <div className="space-y-6">
        {showHeader ? <PageHeader title="Billing" description="Plan, seats, and subscription management" /> : null}
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            Select a workspace to manage billing.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {showHeader ? <PageHeader title="Billing" description="Manage subscription, seats, and billing portal access" /> : null}

      {checkoutSuccess ? (
        <Card>
          <CardContent className="p-4 text-sm text-terminal-green">
            Checkout completed. Billing updates may take a few seconds while Stripe webhooks process.
          </CardContent>
        </Card>
      ) : null}

      {checkoutCanceled ? (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            Checkout canceled. You can restart checkout at any time.
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <RefreshCcw className="h-4 w-4" />
            {summary === undefined
              ? "Loading billing sync status..."
              : summary.sync.status === "error"
                ? "Seat sync needs attention."
                : summary.sync.status === "ok"
                  ? "Seat sync healthy."
                  : "Seat sync pending. Numbers may be briefly stale during webhook processing."}
          </span>
          <Badge variant="outline" className="text-[10px] font-mono uppercase tracking-wider">
            {summary?.sync.status ?? "pending"}
          </Badge>
        </CardContent>
      </Card>

      {summary?.sync.error ? (
        <Card>
          <CardContent className="p-4 text-sm text-destructive flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              {summary.sync.error}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRetrySync}
              disabled={!canManageBilling || actionState === "running"}
            >
              Retry sync
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {!canManageBilling && !organizationsLoading ? (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            You need owner, admin, or billing admin access to start checkout and open the billing portal.
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Subscription</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Status: {summary?.subscription?.status ?? "none"}</p>
            <p>Price: {summary?.subscription?.stripePriceId ?? "-"}</p>
            <p>Renewal: {formatTimestamp(summary?.subscription?.currentPeriodEnd ?? null)}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Seats</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Billable members: {summary?.seats.billableMembers ?? "-"}</p>
            <p>Desired seats: {summary?.seats.desiredSeats ?? "-"}</p>
            <p>Last applied: {summary?.seats.lastAppliedSeats ?? "-"}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Input
              value={priceId}
              onChange={(event) => setPriceId(event.target.value)}
              placeholder="price_..."
              disabled={!canManageBilling || actionState === "running"}
            />
            <Button
              className="w-full"
              onClick={handleStartCheckout}
              disabled={!canManageBilling || actionState === "running"}
            >
              <CreditCard className="mr-2 h-4 w-4" />
              Start checkout
            </Button>
            <Button
              variant="outline"
              className="w-full"
              onClick={handleOpenPortal}
              disabled={!canManageBilling || actionState === "running"}
            >
              <BadgeCheck className="mr-2 h-4 w-4" />
              Manage billing portal
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground flex items-center gap-2">
          <BadgeCheck className="h-4 w-4" />
          Customer: {summary?.customer?.stripeCustomerId ?? "No Stripe customer linked"}
        </CardContent>
      </Card>

      {actionMessage ? (
        <p
          className={
            actionState === "error"
              ? "text-sm text-destructive"
              : actionState === "success"
                ? "text-sm text-terminal-green"
                : "text-sm text-muted-foreground"
          }
        >
          {actionMessage}
        </p>
      ) : null}
    </div>
  );
}
