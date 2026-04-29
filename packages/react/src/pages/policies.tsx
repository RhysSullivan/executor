import { useState } from "react";
import { useAtomSet, useAtomValue, Result } from "@effect-atom/atom-react";
import { PolicyId, type ToolPolicyAction } from "@executor/sdk";

import {
  createPolicy,
  policiesAtom,
  removePolicy,
  updatePolicy,
} from "../api/atoms";
import { policyWriteKeys } from "../api/reactivity-keys";
import { useScope } from "../hooks/use-scope";
import { Badge } from "../components/badge";
import { Button } from "../components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryActions,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryTitle,
  CardStackHeader,
} from "../components/card-stack";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/dropdown-menu";
import { Input } from "../components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select";

// ---------------------------------------------------------------------------
// Action display
// ---------------------------------------------------------------------------

const actionLabels: Record<ToolPolicyAction, string> = {
  approve: "Auto-approve",
  require_approval: "Require approval",
  block: "Block",
};

const actionVariants: Record<
  ToolPolicyAction,
  "default" | "secondary" | "outline" | "destructive"
> = {
  approve: "secondary",
  require_approval: "outline",
  block: "destructive",
};

// ---------------------------------------------------------------------------
// Pattern matcher (mirrors `matchPattern` in @executor/sdk) — used for the
// live "this rule matches N tools" preview without a server round-trip.
// Kept inline so the React package doesn't take a runtime dep on the SDK
// for one tiny pure function. If they drift, only the preview is stale.
// ---------------------------------------------------------------------------

const matchesPattern = (pattern: string, toolId: string): boolean => {
  if (pattern === "*") return true;
  if (pattern === toolId) return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    if (prefix.length === 0) return false;
    return toolId === prefix || toolId.startsWith(`${prefix}.`);
  }
  return false;
};

const isValidPattern = (pattern: string): boolean => {
  if (pattern.length === 0) return false;
  if (pattern === "*") return true;
  if (pattern.startsWith(".") || pattern.endsWith(".")) return false;
  if (pattern.includes("..")) return false;
  if (pattern.startsWith("*")) return false;
  const segments = pattern.split(".");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg.length === 0) return false;
    if (seg.includes("*") && seg !== "*") return false;
    if (seg === "*" && i !== segments.length - 1) return false;
  }
  return true;
};

// ---------------------------------------------------------------------------
// Add-policy form
// ---------------------------------------------------------------------------

function AddPolicyForm(props: {
  onSubmit: (input: { pattern: string; action: ToolPolicyAction }) => void;
  busy: boolean;
}) {
  const [pattern, setPattern] = useState("");
  const [action, setAction] = useState<ToolPolicyAction>("require_approval");
  const valid = isValidPattern(pattern);

  return (
    <form
      className="flex flex-col gap-3 rounded-xl border border-border bg-card px-5 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        props.onSubmit({ pattern, action });
        setPattern("");
        setAction("require_approval");
      }}
    >
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-foreground/80">Pattern</label>
        <Input
          placeholder="vercel.dns.* or *"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          className="font-mono text-sm"
        />
        <p className="text-xs text-muted-foreground">
          Exact tool id, trailing wildcard, or{" "}
          <code className="font-mono">*</code> for every tool. Examples:{" "}
          <code className="font-mono">*</code>,{" "}
          <code className="font-mono">vercel.*</code>,{" "}
          <code className="font-mono">vercel.dns.*</code>,{" "}
          <code className="font-mono">vercel.dns.create</code>.
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-foreground/80">Action</label>
        <Select
          value={action}
          onValueChange={(v) => setAction(v as ToolPolicyAction)}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="approve">{actionLabels.approve}</SelectItem>
            <SelectItem value="require_approval">
              {actionLabels.require_approval}
            </SelectItem>
            <SelectItem value="block">{actionLabels.block}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center justify-end">
        <Button type="submit" disabled={!valid || props.busy} size="sm">
          Add policy
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Policy row
// ---------------------------------------------------------------------------

function PolicyRow(props: {
  policy: {
    id: string;
    pattern: string;
    action: ToolPolicyAction;
    position: number;
  };
  onRemove: () => void;
  onChangeAction: (action: ToolPolicyAction) => void;
}) {
  return (
    <CardStackEntry>
      <CardStackEntryContent>
        <CardStackEntryTitle className="flex items-center gap-2 font-mono text-sm">
          <span className="truncate">{props.policy.pattern}</span>
        </CardStackEntryTitle>
        <CardStackEntryDescription className="text-xs text-muted-foreground">
          Position {props.policy.position}
        </CardStackEntryDescription>
      </CardStackEntryContent>
      <CardStackEntryActions>
        <Badge variant={actionVariants[props.policy.action]}>
          {actionLabels[props.policy.action]}
        </Badge>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 opacity-0 transition-opacity group-hover/card-stack-entry:opacity-100 group-focus-within/card-stack-entry:opacity-100 data-[state=open]:opacity-100"
            >
              <svg viewBox="0 0 16 16" className="size-3">
                <circle cx="8" cy="3" r="1.2" fill="currentColor" />
                <circle cx="8" cy="8" r="1.2" fill="currentColor" />
                <circle cx="8" cy="13" r="1.2" fill="currentColor" />
              </svg>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={() => props.onChangeAction("approve")}>
              Set: Auto-approve
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => props.onChangeAction("require_approval")}
            >
              Set: Require approval
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => props.onChangeAction("block")}>
              Set: Block
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:text-destructive text-sm"
              onClick={props.onRemove}
            >
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardStackEntryActions>
    </CardStackEntry>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function PoliciesPage() {
  const scopeId = useScope();
  const policies = useAtomValue(policiesAtom(scopeId));
  const doCreate = useAtomSet(createPolicy, { mode: "promise" });
  const doUpdate = useAtomSet(updatePolicy, { mode: "promise" });
  const doRemove = useAtomSet(removePolicy, { mode: "promise" });
  const [busy, setBusy] = useState(false);

  const handleCreate = async (input: {
    pattern: string;
    action: ToolPolicyAction;
  }) => {
    setBusy(true);
    try {
      await doCreate({
        path: { scopeId },
        payload: { pattern: input.pattern, action: input.action },
        reactivityKeys: policyWriteKeys,
      });
    } finally {
      setBusy(false);
    }
  };

  const handleUpdate = async (id: string, action: ToolPolicyAction) => {
    await doUpdate({
      path: { scopeId, policyId: PolicyId.make(id) },
      payload: { action },
      reactivityKeys: policyWriteKeys,
    });
  };

  const handleRemove = async (id: string) => {
    await doRemove({
      path: { scopeId, policyId: PolicyId.make(id) },
      reactivityKeys: policyWriteKeys,
    });
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-10 lg:px-8 lg:py-14">
        <div className="flex items-end justify-between mb-10">
          <div>
            <h1 className="font-display text-[2rem] tracking-tight text-foreground leading-none">
              Policies
            </h1>
            <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
              Override default approval behavior for tools. Rules are
              evaluated top-to-bottom; the first match wins. Blocked tools
              are hidden from agent search and fail at invoke.
            </p>
          </div>
        </div>

        <div className="mb-8">
          <AddPolicyForm onSubmit={handleCreate} busy={busy} />
        </div>

        {Result.match(policies, {
          onInitial: () => (
            <div className="flex items-center gap-2 py-8">
              <div className="size-1.5 rounded-full bg-muted-foreground/30 animate-pulse" />
              <p className="text-sm text-muted-foreground">
                Loading policies…
              </p>
            </div>
          ),
          onFailure: () => (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
              <p className="text-sm text-destructive">Failed to load policies</p>
            </div>
          ),
          onSuccess: ({ value }) => (
            <CardStack>
              <CardStackHeader>Active policies</CardStackHeader>
              <CardStackContent>
                {value.length === 0 ? (
                  <CardStackEntry>
                    <CardStackEntryContent>
                      <CardStackEntryDescription>
                        No policies yet. Tools fall back to their plugin's
                        default approval behavior.
                      </CardStackEntryDescription>
                    </CardStackEntryContent>
                  </CardStackEntry>
                ) : (
                  value.map((p) => (
                    <PolicyRow
                      key={p.id}
                      policy={{
                        id: p.id,
                        pattern: p.pattern,
                        action: p.action,
                        position: p.position,
                      }}
                      onRemove={() => handleRemove(p.id)}
                      onChangeAction={(action) => handleUpdate(p.id, action)}
                    />
                  ))
                )}
              </CardStackContent>
            </CardStack>
          ),
        })}
      </div>
    </div>
  );
}

// Exported for tests / direct consumers that don't want the matcher
// duplicated in two places. Cloud's UI uses these for live preview.
export { matchesPattern, isValidPattern };
