import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCustomer, useListPlans } from "autumn-js/react";
import { Button } from "@executor/react/components/button";
import { Badge } from "@executor/react/components/badge";

type Plan = NonNullable<ReturnType<typeof useListPlans>["data"]>[number];

export const Route = createFileRoute("/$org/billing_/plans")({
  component: PlansPage,
});

const PLAN_META: Record<
  string,
  { tagline: string; inherits?: string; features: string[] }
> = {
  hobby: {
    tagline: "For individuals and small teams",
    features: [
      "50,000 included executions per seat",
      "Up to 5 seats",
      "60s execution timeout",
      "Unlimited sources",
      "$0.30 per 1,000 extra executions",
    ],
  },
  professional: {
    tagline: "For teams that need more",
    inherits: "Hobby",
    features: [
      "100,000 included executions per seat",
      "Unlimited seats",
      "5 minute execution timeout",
      "Join by team domain",
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

const ENTERPRISE_FEATURES = [
  "Self-hosted or dedicated cloud deployment",
  "SSO / SAML & SCIM provisioning",
  "Audit logs for every tool call",
  "Dedicated support & onboarding",
  "Security reviews, DPA & SOC 2 on request",
];

const ENTERPRISE_MAILTO = `mailto:rhys@executor.sh?subject=${encodeURIComponent(
  "Executor Enterprise inquiry",
)}&body=${encodeURIComponent(
  [
    "Hi,",
    "",
    "We're interested in Executor Enterprise.",
    "",
    "Company:",
    "Team size:",
    "Use case:",
    "Requirements (SSO, self-hosted, compliance, etc.):",
  ].join("\n"),
)}`;

function PlansPage() {
  const { org } = Route.useParams();
  const { attach, openCustomerPortal, isLoading: customerLoading } = useCustomer();
  const { data: plans, isLoading: plansLoading, isFetching } = useListPlans();
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);

  const isLoading = customerLoading || plansLoading;

  const paidPlans = (plans ?? ([] as Plan[])).filter(
    (p: Plan) => p.id === "hobby" || p.id === "professional",
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-10 lg:px-10 lg:py-14">
        <div className="mb-8">
          <Link
            to="/$org/billing"
            params={{ org }}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
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
          <p className="mt-1.5 text-sm text-muted-foreground">
            Pick the plan that works for you. Upgrade or downgrade anytime.
          </p>
        </div>

        {isLoading ? (
          <div className="grid gap-4 grid-cols-1 md:grid-cols-3">
            <div className="h-64 animate-pulse rounded-xl bg-muted" />
            <div className="h-64 animate-pulse rounded-xl bg-muted" />
            <div className="h-64 animate-pulse rounded-xl bg-muted" />
          </div>
        ) : (
          <div
            className={[
              "grid gap-4 grid-cols-1 md:grid-cols-3 transition-opacity",
              isFetching ? "opacity-50 pointer-events-none" : "",
            ].join(" ")}
          >
            {paidPlans.map((plan: Plan) => {
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
                      ? "border-emerald-500/30 bg-emerald-500/[0.03]"
                      : isScheduled
                        ? "border-emerald-500/30 bg-emerald-500/[0.03]"
                        : "border-border",
                  ].join(" ")}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-base font-semibold text-foreground leading-none">
                      {plan.name}
                    </p>
                    {isCurrent && (
                      <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
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
                  <p className="mt-1 text-sm text-muted-foreground">{meta.tagline}</p>

                  <div className="mt-4 flex items-baseline gap-1.5">
                    <span className="text-2xl font-semibold text-foreground tabular-nums">
                      ${plan.price?.amount ?? 0}
                    </span>
                    {plan.price?.interval && (
                      <span className="text-sm text-muted-foreground">
                        USD / seat / {plan.price.interval}
                      </span>
                    )}
                  </div>

                  <div className="mt-4">
                    {(isCurrent && !isCanceling) || isScheduled ? (
                      <div className="flex h-9 items-center justify-center rounded-md border border-border bg-muted/30 text-sm font-medium text-muted-foreground">
                        {isCurrent ? "Current plan" : "Scheduled"}
                      </div>
                    ) : isCanceling ? (
                      <Button
                        type="button"
                        disabled={loadingPlan !== null}
                        onClick={() => openCustomerPortal()}
                        className="flex h-9 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
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
                          "flex h-9 w-full items-center justify-center rounded-md text-sm font-medium transition-colors disabled:opacity-60",
                          isUpgradeAction
                            ? "bg-primary text-primary-foreground hover:bg-primary/90"
                            : "border border-border bg-background text-foreground hover:bg-muted",
                        ].join(" ")}
                      >
                        {loadingPlan === plan.id ? "Loading…" : label}
                      </Button>
                    )}
                  </div>

                  {meta.inherits && (
                    <p className="mt-5 text-xs font-medium text-foreground">
                      Everything in {meta.inherits}, plus
                    </p>
                  )}
                  <ul
                    role="list"
                    className={[
                      "space-y-2",
                      meta.inherits ? "mt-2" : "mt-5",
                    ].join(" ")}
                  >
                    {meta.features.map((f) => (
                      <li
                        key={f}
                        className="flex items-start gap-2 text-xs text-muted-foreground"
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

            <div className="flex flex-col rounded-xl border border-border p-5">
              <div className="flex items-center justify-between">
                <p className="text-base font-semibold text-foreground leading-none">
                  Enterprise
                </p>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                For orgs with custom needs
              </p>

              <div className="mt-4 flex items-baseline gap-1.5">
                <span className="text-2xl font-semibold text-foreground tabular-nums">
                  Custom
                </span>
              </div>

              <div className="mt-4">
                <a
                  href={ENTERPRISE_MAILTO}
                  className="flex h-9 w-full items-center justify-center rounded-md border border-border bg-background text-sm font-medium text-foreground transition-colors hover:bg-muted"
                >
                  Contact us
                </a>
              </div>

              <p className="mt-5 text-xs font-medium text-foreground">
                Everything in Professional, plus
              </p>
              <ul role="list" className="mt-2 space-y-2">
                {ENTERPRISE_FEATURES.map((f) => (
                  <li
                    key={f}
                    className="flex items-start gap-2 text-xs text-muted-foreground"
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
          </div>
        )}
      </div>
    </div>
  );
}
