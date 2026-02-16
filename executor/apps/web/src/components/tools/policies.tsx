"use client";

import { useMemo, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Id } from "@executor/database/convex/_generated/dataModel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/session-context";
import { convexApi } from "@/lib/convex-api";
import type { AccessPolicyRecord } from "@/lib/types";
import { workspaceQueryArgs } from "@/lib/workspace/query-args";

type FormState = {
  scopeType: "workspace" | "organization";
  resourcePattern: string;
  matchType: "glob" | "exact";
  decision: "allow" | "require_approval" | "deny";
  accountId: string;
  clientId: string;
  priority: string;
};

function defaultFormState(): FormState {
  return {
    scopeType: "workspace",
    resourcePattern: "*",
    matchType: "glob",
    decision: "require_approval",
    accountId: "",
    clientId: "",
    priority: "100",
  };
}

function getDecisionLabel(policy: AccessPolicyRecord): "allow" | "require_approval" | "deny" {
  if (policy.effect === "deny") {
    return "deny";
  }

  return policy.approvalMode === "required" ? "require_approval" : "allow";
}

function getDecisionPayload(decision: "allow" | "require_approval" | "deny"): {
  effect: "allow" | "deny";
  approvalMode: "inherit" | "auto" | "required";
} {
  if (decision === "deny") {
    return { effect: "deny", approvalMode: "required" };
  }

  if (decision === "require_approval") {
    return { effect: "allow", approvalMode: "required" };
  }

  return { effect: "allow", approvalMode: "auto" };
}

function scopeLabel(policy: AccessPolicyRecord): string {
  const scopeType = policy.scopeType ?? (policy.workspaceId ? "workspace" : "organization");
  return scopeType === "organization" ? "organization" : "workspace";
}

export function PoliciesPanel() {
  const { context } = useSession();
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState<FormState>(defaultFormState());

  const listArgs = workspaceQueryArgs(context);
  const policiesQuery = useQuery(convexApi.workspace.listAccessPolicies, listArgs);
  const upsertAccessPolicy = useMutation(convexApi.workspace.upsertAccessPolicy);

  const loading = Boolean(context) && policiesQuery === undefined;
  const policies = useMemo(() => (policiesQuery ?? []) as AccessPolicyRecord[], [policiesQuery]);

  const handleSave = async () => {
    if (!context) {
      return;
    }

    const pattern = form.resourcePattern.trim();
    if (!pattern) {
      toast.error("Tool path pattern is required");
      return;
    }

    const priority = Number(form.priority.trim() || "100");
    if (!Number.isFinite(priority)) {
      toast.error("Priority must be a number");
      return;
    }

    const targetAccountIdInput = form.accountId.trim();
    const targetAccountId = targetAccountIdInput.length > 0
      ? (targetAccountIdInput as Id<"accounts">)
      : undefined;

    setSubmitting(true);
    try {
      const { effect, approvalMode } = getDecisionPayload(form.decision);

      await upsertAccessPolicy({
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        scopeType: form.scopeType,
        resourcePattern: pattern,
        effect,
        approvalMode,
        matchType: form.matchType,
        targetAccountId,
        clientId: form.clientId.trim() || undefined,
        priority,
      });

      toast.success("Policy saved");
      setForm((current) => ({
        ...defaultFormState(),
        scopeType: current.scopeType,
      }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save policy");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          Access Policies
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 space-y-4">
        <div className="rounded-md border border-border/70 bg-muted/25 p-3 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Apply To</Label>
              <Select
                value={form.scopeType}
                onValueChange={(value) => setForm((current) => ({ ...current, scopeType: value as "workspace" | "organization" }))}
              >
                <SelectTrigger className="h-8 text-xs bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="workspace" className="text-xs">This workspace</SelectItem>
                  <SelectItem value="organization" className="text-xs">Entire organization</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Match Type</Label>
              <Select
                value={form.matchType}
                onValueChange={(value) => setForm((current) => ({ ...current, matchType: value as "glob" | "exact" }))}
              >
                <SelectTrigger className="h-8 text-xs bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="glob" className="text-xs">Wildcard pattern</SelectItem>
                  <SelectItem value="exact" className="text-xs">Exact path</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Tool Path Pattern</Label>
              <Input
                value={form.resourcePattern}
                onChange={(event) => setForm((current) => ({ ...current, resourcePattern: event.target.value }))}
                placeholder="github.repos.*"
                className="h-8 text-xs font-mono bg-background"
              />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Decision</Label>
              <Select
                value={form.decision}
                onValueChange={(value) =>
                  setForm((current) => ({
                    ...current,
                    decision: value as "allow" | "require_approval" | "deny",
                  }))}
              >
                <SelectTrigger className="h-8 text-xs bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="allow" className="text-xs">Allow</SelectItem>
                  <SelectItem value="require_approval" className="text-xs">Require approval</SelectItem>
                  <SelectItem value="deny" className="text-xs">Deny</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Account (optional)</Label>
              <Input
                value={form.accountId}
                onChange={(event) => setForm((current) => ({ ...current, accountId: event.target.value }))}
                placeholder="account_123"
                className="h-8 text-xs font-mono bg-background"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Client (optional)</Label>
              <Input
                value={form.clientId}
                onChange={(event) => setForm((current) => ({ ...current, clientId: event.target.value }))}
                placeholder="web, mcp"
                className="h-8 text-xs font-mono bg-background"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Priority</Label>
              <Input
                value={form.priority}
                onChange={(event) => setForm((current) => ({ ...current, priority: event.target.value }))}
                placeholder="100"
                className="h-8 text-xs font-mono bg-background"
              />
            </div>

            <Button onClick={handleSave} disabled={submitting || !context} className="h-8 text-xs">
              {submitting ? "Saving..." : "Add Policy"}
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-12" />
            ))}
          </div>
        ) : policies.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">No access policies yet.</p>
        ) : (
          <div className="space-y-2">
            {policies.map((policy) => (
              <div key={policy.id} className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Badge variant="outline" className="text-[9px] font-mono uppercase tracking-wider">
                    {scopeLabel(policy)}
                  </Badge>
                  <Badge variant="outline" className="text-[9px] font-mono uppercase tracking-wider">
                    {policy.matchType ?? "glob"}
                  </Badge>
                    <Badge variant="outline" className="text-[9px] font-mono uppercase tracking-wider">
                    {getDecisionLabel(policy)}
                  </Badge>
                  <Badge variant="outline" className="text-[9px] font-mono uppercase tracking-wider">
                    p{policy.priority}
                  </Badge>
                </div>
                <p className="text-[11px] font-mono mt-1 break-all">{policy.resourcePattern}</p>
                {(policy.targetAccountId || policy.clientId) ? (
                  <p className="text-[10px] text-muted-foreground mt-1">
                    {policy.targetAccountId ? `account=${policy.targetAccountId}` : ""}
                    {policy.targetAccountId && policy.clientId ? " · " : ""}
                    {policy.clientId ? `client=${policy.clientId}` : ""}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
