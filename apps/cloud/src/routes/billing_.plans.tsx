import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCustomer, useListPlans } from "autumn-js/react";
import { Button } from "@executor/react/components/button";
import { Badge } from "@executor/react/components/badge";

type Plan = NonNullable<ReturnType<typeof useListPlans>["data"]>[number];

export const Route = createFileRoute("/billing_/plans")({
  component: PlansPage,
});

const PLAN_META: Record<string, { tagline: string; features: string[] }> = {
  hobby: {
    tagline: "For individuals and small teams",
    features: [
      "50,000 executions / month",
      "Up to 5 seats",
      "60s execution timeout",
      "Unlimited sources",
      "$1 per 10,000 extra executions",
    ],
  },
  professional: {
    tagline: "For teams that need more",
    features: [
      "100,000 executions / month",
      "Unlimited seats",
      "5 minute execution timeout",
      "Unlimited sources",
      "$1 per 10,000 extra executions",
    ],
  },
};

const ACTION_LABELS: Record<string, string> = {
  activate: "Subscribe",
  upgrade: "Upgrade",
  downgrade: "Downgrade",
  none: "Current plan",
  purchase: "Purchase",
};

function PlansPage() {
  const { attach, openCustomerPortal, isLoading: customerLoading } = useCustomer();
  const { data: plans, isLoading: plansLoading, isFetching } = useListPlans();
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);

  const isLoading = customerLoading || plansLoading;

  const paidPlans = (plans ?? ([] as Plan[])).filter(
    (p) => p.id === "hobby" || p.id === "professional",
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-10 lg:px-10 lg:py-14">
        <div className="mb-8">
          <Link
            to="/billing"
            className="inline-flex items-center gap-1 text-[0.8125rem] text-muted-foreground hover:text-foreground transition-colors mb-4"
          >
            <svg viewBox="0 0 16 16" fill="none" className="size-3.5">
              <path
                d="M10 4L6 8l4 4"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Billing
          </Link>
          <h1 className="font-display text-3xl tracking-tight text-foreground lg:text-4xl">
            Choose a plan
          </h1>
          <p className="mt-1.5 text-[0.875rem] text-muted-foreground">
            Pick the plan that works for you. Upgrade or downgrade anytime.
          </p>
        </div>

        {isLoading ? (
          <div className="grid gap-4 grid-cols-2">
            <div className="h-64 animate-pulse rounded-xl bg-muted" />
            <div className="h-64 animate-pulse rounded-xl bg-muted" />
          </div>
        ) : (
          <div
            className={[
              "grid gap-4 grid-cols-2 transition-opacity",
              isFetching ? "opacity-50 pointer-events-none" : "",
            ].join(" ")}
          >
            {paidPlans.map((plan) => {
              const meta = PLAN_META[plan.id];
              if (!meta) return null;

              const eligibility = plan.customerEligibility;
              const action = eligibility?.attachAction ?? "activate";
              const status = eligibility?.status;
              const isCanceling = eligibility?.canceling ?? false;
              const isCurrent = status === "active" && !isCanceling;
              const isScheduled = status === "scheduled";
              const label = isCanceling ? "Resume" : (ACTION_LABELS[action] ?? "Select");
              const isUpgradeAction = action === "upgrade" || action === "activate";

              return (
                <div
                  key={plan.id}
                  className={[
                    "flex flex-col rounded-xl border p-5",
                    isCurrent
                      ? "border-amber-500/30 bg-amber-500/[0.03]"
                      : isScheduled
                        ? "border-emerald-500/30 bg-emerald-500/[0.03]"
                        : "border-border",
                  ].join(" ")}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-[0.9375rem] font-semibold text-foreground leading-none">
                      {plan.name}
                    </p>
                    {isCurrent && (
                      <Badge className="bg-amber-500/10 text-amber-600 dark:text-amber-400">
                        Your plan
                      </Badge>
                    )}
                    {isCanceling && (
                      <Badge className="bg-amber-500/10 text-amber-600 dark:text-amber-400">
                        Canceling
                      </Badge>
                    )}
                    {isScheduled && (
                      <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                        Scheduled
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-[0.75rem] text-muted-foreground/70">{meta.tagline}</p>

                  <div className="mt-4 flex items-baseline gap-1.5">
                    <span className="text-2xl font-semibold text-foreground tabular-nums">
                      ${plan.price?.amount ?? 0}
                    </span>
                    {plan.price?.interval && (
                      <span className="text-[0.75rem] text-muted-foreground/60">
                        USD / seat / {plan.price.interval}
                      </span>
                    )}
                  </div>

                  <div className="mt-4">
                    {(isCurrent && !isCanceling) || isScheduled ? (
                      <div className="flex h-9 items-center justify-center rounded-md border border-border bg-muted/30 text-[0.8125rem] font-medium text-muted-foreground">
                        {isCurrent ? "Current plan" : "Scheduled"}
                      </div>
                    ) : isCanceling ? (
                      <Button
                        type="button"
                        disabled={loadingPlan !== null}
                        onClick={() => openCustomerPortal()}
                        className="flex h-9 w-full items-center justify-center rounded-md bg-primary text-[0.8125rem] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
                      >
                        Resume
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        disabled={loadingPlan !== null}
                        onClick={async () => {
                          setLoadingPlan(plan.id);
                          await attach({ planId: plan.id, redirectMode: "always" });
                          setLoadingPlan(null);
                        }}
                        className={[
                          "flex h-9 w-full items-center justify-center rounded-md text-[0.8125rem] font-medium transition-colors disabled:opacity-60",
                          isUpgradeAction
                            ? "bg-primary text-primary-foreground hover:bg-primary/90"
                            : "border border-border bg-background text-foreground hover:bg-muted",
                        ].join(" ")}
                      >
                        {loadingPlan === plan.id ? "Loading…" : label}
                      </Button>
                    )}
                  </div>

                  <ul role="list" className="mt-5 space-y-2">
                    {meta.features.map((f) => (
                      <li
                        key={f}
                        className="flex items-start gap-2 text-[0.75rem] text-muted-foreground"
                      >
                        <svg
                          viewBox="0 0 16 16"
                          fill="none"
                          className="mt-px size-3.5 shrink-0 text-primary/60"
                        >
                          <path
                            d="M3.5 8.5L6.5 11.5L12.5 5"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
