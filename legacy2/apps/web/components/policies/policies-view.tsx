"use client";

import { useAtomSet, useAtomValue } from "@effect-atom/atom-react";
import type { Policy, PolicyDecision, PolicyId } from "@executor-v2/schema";
import { useMemo, useState } from "react";
import type { FormEvent } from "react";

import { useWorkspace } from "../../lib/hooks/use-workspace";
import {
  optimisticRemovePolicy,
  optimisticUpsertPolicy,
  policiesByWorkspace,
  removePolicy,
  toPolicyRemoveRequest,
  toPolicyRemoveResult,
  toPolicyUpsertRequest,
  upsertPolicy,
} from "../../lib/control-plane/atoms";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { cn, createLocalId, formatTimestamp } from "../../lib/utils";
import { matchState } from "../shared/match-state";
import { PageHeader } from "../shared/page-header";
import { StatusMessage } from "../shared/status-message";

const policyDecisionOptions: ReadonlyArray<PolicyDecision> = ["allow", "require_approval", "deny"];

const decisionBadgeVariant = (decision: PolicyDecision): "secondary" | "pending" | "denied" => {
  if (decision === "allow") return "secondary";
  if (decision === "require_approval") return "pending";
  return "denied";
};

export function PoliciesView() {
  const { workspaceId } = useWorkspace();

  const [policyEditingId, setPolicyEditingId] = useState<PolicyId | null>(null);
  const [policyPattern, setPolicyPattern] = useState("");
  const [policyDecision, setPolicyDecision] = useState<PolicyDecision>("require_approval");
  const [policySearchQuery, setPolicySearchQuery] = useState("");
  const [policyBusyId, setPolicyBusyId] = useState<PolicyId | null>(null);
  const [policyStatusText, setPolicyStatusText] = useState<string | null>(null);
  const [policyStatusVariant, setPolicyStatusVariant] = useState<"info" | "error">("info");
  const [optimisticPolicies, setOptimisticPolicies] = useState<ReadonlyArray<Policy> | null>(null);

  const policiesState = useAtomValue(policiesByWorkspace(workspaceId));
  const runUpsertPolicy = useAtomSet(upsertPolicy, { mode: "promise" });
  const runRemovePolicy = useAtomSet(removePolicy, { mode: "promise" });

  const policyItems = optimisticPolicies ?? policiesState.items;
  const filteredPolicies = useMemo(() => {
    const query = policySearchQuery.trim().toLowerCase();
    if (query.length === 0) return policyItems;
    return policyItems.filter((policy) =>
      policy.toolPathPattern.toLowerCase().includes(query) ||
      policy.decision.toLowerCase().includes(query),
    );
  }, [policyItems, policySearchQuery]);

  const setStatus = (message: string | null, variant: "info" | "error" = "info") => {
    setPolicyStatusText(message);
    setPolicyStatusVariant(variant);
  };

  const clearPolicyForm = () => {
    setPolicyEditingId(null);
    setPolicyPattern("");
    setPolicyDecision("require_approval");
  };

  const handleEditPolicy = (policyId: PolicyId) => {
    if (policyBusyId !== null) return;
    const target = policyItems.find((policy) => policy.id === policyId);
    if (!target) return;
    setPolicyEditingId(policyId);
    setPolicyPattern(target.toolPathPattern);
    setPolicyDecision(target.decision);
    setStatus(`Editing policy ${target.toolPathPattern}.`);
  };

  const handleCancelPolicyEdit = () => {
    if (policyBusyId !== null) return;
    clearPolicyForm();
    setStatus("Policy edit cancelled.");
  };

  const handleUpsertPolicy = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (policyBusyId !== null) return;

    const toolPathPattern = policyPattern.trim();
    if (toolPathPattern.length === 0) {
      setStatus("Tool path pattern is required.", "error");
      return;
    }

    const policyId = policyEditingId ?? (createLocalId("pol_") as PolicyId);
    const nextPolicies = optimisticUpsertPolicy(policyItems, {
      workspaceId,
      policyId,
      toolPathPattern,
      decision: policyDecision,
    });

    setPolicyBusyId(policyId);
    setOptimisticPolicies(nextPolicies);

    void runUpsertPolicy(toPolicyUpsertRequest({
      workspaceId,
      id: policyEditingId ?? undefined,
      toolPathPattern,
      decision: policyDecision,
    }))
      .then(() => {
        setStatus(policyEditingId ? `Updated policy ${toolPathPattern}.` : `Added policy ${toolPathPattern}.`);
        clearPolicyForm();
        setOptimisticPolicies(null);
      })
      .catch(() => {
        setStatus("Policy save failed.", "error");
        setOptimisticPolicies(null);
      })
      .finally(() => {
        setPolicyBusyId(null);
      });
  };

  const handleRemovePolicy = (policyId: PolicyId) => {
    if (policyBusyId !== null) return;

    const nextPolicies = optimisticRemovePolicy(policyItems, policyId);
    setPolicyBusyId(policyId);
    setOptimisticPolicies(nextPolicies);

    void runRemovePolicy(toPolicyRemoveRequest({ workspaceId, policyId }))
      .then((result) => {
        const removed = toPolicyRemoveResult(result);
        setStatus(removed ? "Policy removed." : "Policy not found.");
        if (policyEditingId === policyId) clearPolicyForm();
        setOptimisticPolicies(null);
      })
      .catch(() => {
        setStatus("Policy removal failed.", "error");
        setOptimisticPolicies(null);
      })
      .finally(() => {
        setPolicyBusyId(null);
      });
  };

  const emptyMessage =
    policySearchQuery.trim().length > 0
      ? "No policies match your search."
      : policyItems.length === 0
      ? "No policies configured for this workspace."
      : null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <PageHeader title="Policies" description="Define and manage tool path policy behavior." />
      <Card className={cn("border-border/70")}>
        <CardHeader className="pb-3">
          <CardTitle>Policies</CardTitle>
          <CardDescription>Use these rules to control default policy decisions.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <form className="space-y-3" onSubmit={handleUpsertPolicy}>
            <div className="grid gap-1.5">
              <label className="text-xs text-muted-foreground" htmlFor="policy-pattern">
                Tool path pattern
              </label>
              <Input
                id="policy-pattern"
                value={policyPattern}
                onChange={(event) => {
                  setPolicyPattern(event.target.value);
                }}
                placeholder="source:* or source:github/*"
                required
              />
            </div>
            <div className="grid gap-1.5">
              <label className="text-xs text-muted-foreground" htmlFor="policy-decision">
                Decision
              </label>
              <Select
                id="policy-decision"
                value={policyDecision}
                onChange={(event) => {
                  setPolicyDecision(event.target.value as PolicyDecision);
                }}
              >
                {policyDecisionOptions.map((decision) => (
                  <option key={decision} value={decision}>
                    {decision}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Button type="submit" disabled={policyBusyId !== null}>
                {policyBusyId !== null
                  ? "Saving..."
                  : policyEditingId
                    ? "Save Policy"
                    : "Add Policy"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handleCancelPolicyEdit}
                disabled={policyBusyId !== null || policyEditingId === null}
              >
                Cancel
              </Button>
            </div>
          </form>

          <StatusMessage message={policyStatusText} variant={policyStatusVariant} />

          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground" htmlFor="policy-search">
              Search policies
            </label>
            <Input
              id="policy-search"
              value={policySearchQuery}
              onChange={(event) => {
                setPolicySearchQuery(event.target.value);
              }}
              placeholder="pattern or decision"
            />
          </div>

          {matchState(policiesState, {
            loading: "Loading policies...",
            empty: emptyMessage,
            filteredCount: filteredPolicies.length,
            ready: () => (
              <div className="space-y-2">
                {filteredPolicies.map((policy) => (
                  <div key={policy.id} className="rounded-lg border border-border bg-background/70 p-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 space-y-1">
                        <p className="break-all text-sm font-medium">{policy.toolPathPattern}</p>
                        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <Badge variant={decisionBadgeVariant(policy.decision)}>{policy.decision}</Badge>
                          <span>updated {formatTimestamp(policy.updatedAt)}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => handleEditPolicy(policy.id)}
                          disabled={policyBusyId !== null}
                        >
                          Edit
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          onClick={() => handleRemovePolicy(policy.id)}
                          disabled={policyBusyId !== null}
                        >
                          {policyBusyId === policy.id ? "Working..." : "Remove"}
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ),
          })}
        </CardContent>
      </Card>
    </div>
  );
}
