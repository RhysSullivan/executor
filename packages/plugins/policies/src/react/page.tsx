import { useState } from "react";
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@effect-atom/atom-react";

import { useScope } from "@executor/react/api/scope-context";
import { Badge } from "@executor/react/components/badge";
import { Button } from "@executor/react/components/button";
import {
  CardStack,
  CardStackContent,
  CardStackEmpty,
  CardStackEntry,
  CardStackEntryActions,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryTitle,
  CardStackHeader,
  CardStackHeaderAction,
} from "@executor/react/components/card-stack";
import { Input } from "@executor/react/components/input";
import { Label } from "@executor/react/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@executor/react/components/select";
import { Switch } from "@executor/react/components/switch";

import { policiesAtom, createPolicy, updatePolicy, removePolicy } from "./atoms";

type PermissionValue = "allow-auto" | "allow-required" | "deny";

const permissionValueFromPolicy = (policy: {
  effect: "allow" | "deny";
  approvalMode: "auto" | "required";
}): PermissionValue => {
  if (policy.effect === "deny") return "deny";
  return policy.approvalMode === "required" ? "allow-required" : "allow-auto";
};

const permissionLabel = (value: PermissionValue): string => {
  switch (value) {
    case "allow-auto":
      return "Auto-run";
    case "allow-required":
      return "Require approval";
    case "deny":
      return "Denied";
  }
};

const permissionTone = (value: PermissionValue): "default" | "secondary" | "destructive" => {
  switch (value) {
    case "allow-auto":
      return "default";
    case "allow-required":
      return "secondary";
    case "deny":
      return "destructive";
  }
};

const permissionToPolicy = (
  value: PermissionValue,
): { effect: "allow" | "deny"; approvalMode: "auto" | "required" } => {
  switch (value) {
    case "allow-auto":
      return { effect: "allow", approvalMode: "auto" };
    case "allow-required":
      return { effect: "allow", approvalMode: "required" };
    case "deny":
      return { effect: "deny", approvalMode: "auto" };
  }
};

type PolicyFormState = {
  toolPattern: string;
  permission: PermissionValue;
  priority: string;
  enabled: boolean;
};

const buildInitialState = (policy?: {
  toolPattern: string;
  effect: "allow" | "deny";
  approvalMode: "auto" | "required";
  priority: number;
  enabled: boolean;
}): PolicyFormState => ({
  toolPattern: policy?.toolPattern ?? "*",
  permission: policy ? permissionValueFromPolicy(policy) : "allow-required",
  priority: String(policy?.priority ?? 0),
  enabled: policy?.enabled ?? true,
});

function PolicyForm(props: {
  initial?: {
    toolPattern: string;
    effect: "allow" | "deny";
    approvalMode: "auto" | "required";
    priority: number;
    enabled: boolean;
  };
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (state: PolicyFormState) => Promise<void>;
}) {
  const [state, setState] = useState<PolicyFormState>(() => buildInitialState(props.initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    const trimmedPattern = state.toolPattern.trim();
    if (trimmedPattern.length === 0) {
      setError("Tool pattern is required.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await props.onSubmit({ ...state, toolPattern: trimmedPattern });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to save policy");
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-border/60 bg-card/60 p-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid gap-1.5 md:col-span-2">
          <Label htmlFor="policy-tool-pattern">Tool pattern</Label>
          <Input
            id="policy-tool-pattern"
            value={state.toolPattern}
            onChange={(event) =>
              setState((current) => ({
                ...current,
                toolPattern: event.target.value,
              }))
            }
            placeholder="openapi.stripe.*"
            className="font-mono text-[13px]"
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="policy-permission">Behavior</Label>
          <Select
            value={state.permission}
            onValueChange={(permission) =>
              setState((current) => ({
                ...current,
                permission: permission as PermissionValue,
              }))
            }
          >
            <SelectTrigger id="policy-permission" className="h-9 text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="allow-auto">Auto-run</SelectItem>
              <SelectItem value="allow-required">Require approval</SelectItem>
              <SelectItem value="deny">Denied</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="policy-priority">Priority</Label>
          <Input
            id="policy-priority"
            type="number"
            value={state.priority}
            onChange={(event) =>
              setState((current) => ({
                ...current,
                priority: event.target.value,
              }))
            }
            className="h-9 text-[13px]"
          />
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between rounded-md border border-border/60 px-3 py-2">
        <div>
          <p className="text-sm font-medium text-foreground">Policy enabled</p>
          <p className="text-xs text-muted-foreground">
            Disabled policies stay saved but are ignored during invocation.
          </p>
        </div>
        <Switch
          checked={state.enabled}
          onCheckedChange={(enabled) =>
            setState((current) => ({
              ...current,
              enabled,
            }))
          }
        />
      </div>

      {error ? (
        <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSubmit} disabled={saving}>
          {saving ? "Saving\u2026" : props.submitLabel}
        </Button>
      </div>
    </div>
  );
}

function PolicyRow(props: {
  policy: {
    id: string;
    toolPattern: string;
    effect: "allow" | "deny";
    approvalMode: "auto" | "required";
    priority: number;
    enabled: boolean;
    updatedAt: Date;
  };
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (patch: {
    toolPattern?: string;
    effect?: "allow" | "deny";
    approvalMode?: "auto" | "required";
    priority?: number;
    enabled?: boolean;
  }) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [removing, setRemoving] = useState(false);

  if (props.editing) {
    return (
      <CardStackEntry>
        <div className="w-full">
          <PolicyForm
            initial={props.policy}
            submitLabel="Save policy"
            onCancel={props.onCancelEdit}
            onSubmit={async (state) => {
              const next = permissionToPolicy(state.permission);
              const patch: {
                toolPattern?: string;
                effect?: "allow" | "deny";
                approvalMode?: "auto" | "required";
                priority?: number;
                enabled?: boolean;
              } = {};

              if (state.toolPattern !== props.policy.toolPattern) {
                patch.toolPattern = state.toolPattern;
              }
              if (next.effect !== props.policy.effect) {
                patch.effect = next.effect;
              }
              if (next.approvalMode !== props.policy.approvalMode) {
                patch.approvalMode = next.approvalMode;
              }
              if (Number(state.priority) !== props.policy.priority) {
                patch.priority = Number(state.priority);
              }
              if (state.enabled !== props.policy.enabled) {
                patch.enabled = state.enabled;
              }

              await props.onSave(patch);
            }}
          />
        </div>
      </CardStackEntry>
    );
  }

  const permission = permissionValueFromPolicy(props.policy);

  return (
    <CardStackEntry searchText={`${props.policy.toolPattern} ${permissionLabel(permission)}`}>
      <CardStackEntryContent>
        <CardStackEntryTitle className="font-mono text-[13px]">
          {props.policy.toolPattern}
        </CardStackEntryTitle>
        <CardStackEntryDescription>
          Priority {props.policy.priority} · Updated {props.policy.updatedAt.toLocaleString()}
        </CardStackEntryDescription>
      </CardStackEntryContent>
      <Badge variant={permissionTone(permission)}>{permissionLabel(permission)}</Badge>
      {!props.policy.enabled ? <Badge variant="outline">Disabled</Badge> : null}
      <CardStackEntryActions>
        <Button variant="ghost" size="sm" onClick={props.onEdit}>
          Edit
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            setRemoving(true);
            try {
              await props.onRemove();
            } finally {
              setRemoving(false);
            }
          }}
          disabled={removing}
        >
          {removing ? "Deleting\u2026" : "Delete"}
        </Button>
      </CardStackEntryActions>
    </CardStackEntry>
  );
}

export function PoliciesPage() {
  const scopeId = useScope();
  const policies = useAtomValue(policiesAtom(scopeId));
  const refresh = useAtomRefresh(policiesAtom(scopeId));
  const doCreate = useAtomSet(createPolicy, { mode: "promise" });
  const doUpdate = useAtomSet(updatePolicy, { mode: "promise" });
  const doRemove = useAtomSet(removePolicy, { mode: "promise" });

  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-10 lg:px-10 lg:py-14">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-3xl tracking-tight text-foreground lg:text-4xl">
              Policies
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Override tool approval defaults per scope with explicit allow, approval, and deny
              rules.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => {
              setCreating((current) => !current);
              setEditingId(null);
            }}
          >
            {creating ? "Close" : "Add policy"}
          </Button>
        </div>

        {creating ? (
          <PolicyForm
            submitLabel="Create policy"
            onCancel={() => setCreating(false)}
            onSubmit={async (state) => {
              const permission = permissionToPolicy(state.permission);
              await doCreate({
                path: { scopeId },
                payload: {
                  toolPattern: state.toolPattern,
                  effect: permission.effect,
                  approvalMode: permission.approvalMode,
                  priority: Number(state.priority),
                  enabled: state.enabled,
                },
              });
              setCreating(false);
              refresh();
            }}
          />
        ) : null}

        <CardStack searchable>
          <CardStackHeader
            rightSlot={
              <CardStackHeaderAction>
                <span className="text-xs text-muted-foreground">
                  Specific rules win over wildcards
                </span>
              </CardStackHeaderAction>
            }
          >
            Active policies
          </CardStackHeader>
          <CardStackContent>
            {Result.match(policies, {
              onInitial: () => <CardStackEmpty>Loading policies\u2026</CardStackEmpty>,
              onFailure: () => (
                <CardStackEmpty className="text-destructive">
                  Failed to load policies
                </CardStackEmpty>
              ),
              onSuccess: ({ value }) =>
                value.length === 0 ? (
                  <CardStackEmpty>No policies configured for this scope.</CardStackEmpty>
                ) : (
                  <>
                    {value.map((policy) => (
                      <PolicyRow
                        key={policy.id}
                        policy={policy}
                        editing={editingId === policy.id}
                        onEdit={() => {
                          setCreating(false);
                          setEditingId(policy.id);
                        }}
                        onCancelEdit={() => setEditingId(null)}
                        onSave={async (patch) => {
                          await doUpdate({
                            path: { scopeId, policyId: policy.id },
                            payload: patch,
                          });
                          setEditingId(null);
                          refresh();
                        }}
                        onRemove={async () => {
                          await doRemove({
                            path: { scopeId, policyId: policy.id },
                          });
                          if (editingId === policy.id) {
                            setEditingId(null);
                          }
                          refresh();
                        }}
                      />
                    ))}
                  </>
                ),
            })}
          </CardStackContent>
        </CardStack>

        <div className="rounded-lg border border-border/60 bg-card/50 px-4 py-3">
          <p className="text-sm font-medium text-foreground">Policy matching</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Patterns use glob syntax against full tool ids. Examples:{" "}
            <code>openapi.stripe.*</code> matches all Stripe OpenAPI tools,{" "}
            <code>*.delete</code> matches delete-style tools, and a concrete tool id beats a
            wildcard when priorities tie.
          </p>
        </div>
      </div>
    </div>
  );
}
