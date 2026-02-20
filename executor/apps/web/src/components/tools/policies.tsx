"use client";

import { useCallback, useDeferredValue, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Plus,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Trash2,
  User,
  X,
} from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import { useSession } from "@/lib/session-context";
import { convexApi } from "@/lib/convex-api";
import type { Id } from "@/lib/convex-id";
import { cn } from "@/lib/utils";
import type {
  ToolPolicyRecord,
  ArgumentCondition,
  ArgumentConditionOperator,
  ToolDescriptor,
  ToolPolicyAssignmentRecord,
  ToolPolicyRuleRecord,
  ToolPolicySetRecord,
} from "@/lib/types";
import { workspaceQueryArgs } from "@/lib/workspace/query-args";
import { sourceLabel } from "@/lib/tool/source-utils";

// ── Types ────────────────────────────────────────────────────────────────────

type PolicyDecisionType = "allow" | "require_approval" | "deny";
type PolicyResourceType = ToolPolicyRecord["resourceType"];

interface ToolNamespace {
  prefix: string;
  label: string;
  source: string;
  tools: ToolDescriptor[];
}

type PolicyScope = "personal" | "workspace" | "organization";

interface FormState {
  scope: PolicyScope;
  decision: PolicyDecisionType;
  resourceType: PolicyResourceType;
  selectedToolPaths: string[];
  resourcePattern: string;
  sourcePattern: string;
  namespacePattern: string;
  argumentConditions: ArgumentCondition[];
  clientId: string;
  priority: string;
}

interface RoleFormState {
  name: string;
  description: string;
}

interface RoleRuleFormState {
  selectorType: ToolPolicyRuleRecord["selectorType"];
  sourceKey: string;
  resourcePattern: string;
  matchType: ToolPolicyRuleRecord["matchType"];
  effect: ToolPolicyRuleRecord["effect"];
  approvalMode: ToolPolicyRuleRecord["approvalMode"];
  priority: string;
}

interface RoleBindingFormState {
  scopeType: ToolPolicyAssignmentRecord["scopeType"];
  targetAccountId: string;
  clientId: string;
  status: ToolPolicyAssignmentRecord["status"];
}

interface OrganizationMemberListItem {
  accountId: string;
  displayName: string;
  email: string | null;
  role: "owner" | "admin" | "member" | "billing_admin";
  status: "active" | "pending" | "removed";
}

function defaultFormState(): FormState {
  return {
    scope: "personal",
    decision: "require_approval",
    resourceType: "tool_path",
    selectedToolPaths: [],
    resourcePattern: "",
    sourcePattern: "",
    namespacePattern: "",
    argumentConditions: [],
    clientId: "",
    priority: "100",
  };
}

function defaultRoleFormState(): RoleFormState {
  return {
    name: "",
    description: "",
  };
}

function defaultRoleRuleFormState(): RoleRuleFormState {
  return {
    selectorType: "tool_path",
    sourceKey: "",
    resourcePattern: "",
    matchType: "glob",
    effect: "allow",
    approvalMode: "required",
    priority: "100",
  };
}

function defaultRoleBindingFormState(): RoleBindingFormState {
  return {
    scopeType: "workspace",
    targetAccountId: "",
    clientId: "",
    status: "active",
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getDecisionFromPolicy(policy: ToolPolicyRecord): PolicyDecisionType {
  if (policy.effect === "deny") return "deny";
  return policy.approvalMode === "required" ? "require_approval" : "allow";
}

function getDecisionPayload(decision: PolicyDecisionType) {
  if (decision === "deny") return { effect: "deny" as const, approvalMode: "required" as const };
  if (decision === "require_approval") return { effect: "allow" as const, approvalMode: "required" as const };
  return { effect: "allow" as const, approvalMode: "auto" as const };
}

function scopeLabel(policy: ToolPolicyRecord, currentAccountId?: string): string {
  if (policy.targetAccountId) {
    return policy.targetAccountId === currentAccountId ? "personal" : "user";
  }
  const scopeType = policy.scopeType ?? (policy.workspaceId ? "workspace" : "organization");
  return scopeType === "organization" ? "org" : "workspace";
}

const DECISION_CONFIG = {
  allow: {
    label: "Auto-approve",
    color: "text-emerald-400",
    icon: ShieldCheck,
    description: "Tool calls are automatically approved without manual review",
  },
  require_approval: {
    label: "Require approval",
    color: "text-amber-400",
    icon: ShieldAlert,
    description: "Tool calls require manual approval before execution",
  },
  deny: {
    label: "Block",
    color: "text-red-400",
    icon: ShieldOff,
    description: "Tool calls are blocked entirely",
  },
} satisfies Record<PolicyDecisionType, { label: string; color: string; icon: typeof ShieldCheck; description: string }>;

const RESOURCE_TYPE_CONFIG: Record<
  PolicyResourceType,
  { label: string; description: string }
> = {
  all_tools: {
    label: "All tools",
    description: "Apply to every tool in this workspace",
  },
  source: {
    label: "Source",
    description: "Apply to all tools from one source",
  },
  namespace: {
    label: "Namespace",
    description: "Apply to a namespace prefix pattern",
  },
  tool_path: {
    label: "Tool path",
    description: "Apply to specific tools or path patterns",
  },
};

const OPERATOR_LABELS: Record<ArgumentConditionOperator, string> = {
  equals: "equals",
  not_equals: "not equals",
  contains: "contains",
  starts_with: "starts with",
};

/** Group tools by dotted-prefix namespace, e.g. "github.repos" or "stripe.customers". */
function buildNamespaces(tools: ToolDescriptor[]): ToolNamespace[] {
  const nsMap = new Map<string, ToolNamespace>();
  for (const tool of tools) {
    const parts = tool.path.split(".");
    const prefix = parts.length >= 2 ? parts.slice(0, -1).join(".") : tool.path;
    const source = tool.source ? sourceLabel(tool.source) : "unknown";
    let ns = nsMap.get(prefix);
    if (!ns) {
      ns = { prefix, label: prefix, source, tools: [] };
      nsMap.set(prefix, ns);
    }
    ns.tools.push(tool);
  }
  return Array.from(nsMap.values()).sort((a, b) => a.prefix.localeCompare(b.prefix));
}

function derivePatternFromSelection(paths: string[], namespaces: ToolNamespace[]): string {
  if (paths.length === 0) return "*";
  if (paths.length === 1) return paths[0]!;

  // Check if all paths share a namespace prefix.
  for (const ns of namespaces) {
    const nsPaths = new Set(ns.tools.map((t) => t.path));
    if (paths.every((p) => nsPaths.has(p)) && paths.length === nsPaths.size) {
      return `${ns.prefix}.*`;
    }
  }

  // Check for a common prefix ending with a dot.
  const sorted = [...paths].sort();
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  let common = "";
  for (let i = 0; i < Math.min(first.length, last.length); i++) {
    if (first[i] === last[i]) common += first[i];
    else break;
  }
  const dotIndex = common.lastIndexOf(".");
  if (dotIndex > 0) {
    const prefix = common.slice(0, dotIndex + 1);
    return `${prefix}*`;
  }

  return paths.join(", ");
}

function matchesResourcePattern(pattern: string, candidate: string, matchType: "glob" | "exact"): boolean {
  if (matchType === "exact") {
    return pattern === candidate;
  }
  if (pattern === "*") {
    return true;
  }
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(candidate);
}

function policyMatchesTool(policy: ToolPolicyRecord, tool: ToolDescriptor): boolean {
  if (policy.resourceType === "all_tools") {
    return true;
  }
  if (policy.resourceType === "source") {
    if (!tool.source) {
      return false;
    }
    return matchesResourcePattern(policy.resourcePattern, tool.source, policy.matchType);
  }

  return matchesResourcePattern(policy.resourcePattern, tool.path, policy.matchType);
}

function resourceTypeLabel(resourceType: ToolPolicyRecord["resourceType"]): string {
  if (resourceType === "all_tools") return "all tools";
  if (resourceType === "source") return "source";
  if (resourceType === "namespace") return "namespace";
  return "tool path";
}

function createToolPolicyId(): string {
  return `tool_policy_${crypto.randomUUID()}`;
}

function toolPolicyRoleId(policyId: string): string {
  return `tool_policy_role_${policyId}`;
}

function toolPolicyRuleId(policyId: string): string {
  return `tool_policy_rule_${policyId}`;
}

function toolPolicyBindingId(policyId: string): string {
  return `tool_policy_binding_${policyId}`;
}

function isDirectToolPolicy(policy: ToolPolicyRecord): boolean {
  if (!policy.id.startsWith("tool_policy_")) {
    return false;
  }

  if (!policy.roleId || !policy.ruleId || !policy.bindingId) {
    return false;
  }

  return (
    policy.roleId === toolPolicyRoleId(policy.id)
    && policy.ruleId === toolPolicyRuleId(policy.id)
    && policy.bindingId === toolPolicyBindingId(policy.id)
  );
}

function roleRulePattern(rule: ToolPolicyRuleRecord): string {
  if (rule.selectorType === "all") return "*";
  if (rule.selectorType === "source") return rule.sourceKey ?? "";
  if (rule.selectorType === "namespace") return rule.namespacePattern ?? "";
  return rule.toolPathPattern ?? "";
}

// ── Tool Picker (virtualized) ────────────────────────────────────────────────

type VirtualRow =
  | { kind: "namespace"; ns: ToolNamespace; allSelected: boolean; someSelected: boolean; expanded: boolean }
  | { kind: "tool"; tool: ToolDescriptor; selected: boolean };

const NS_ROW_HEIGHT = 32;
const TOOL_ROW_HEIGHT = 40;

/**
 * Inner virtualized list — mounted only when the popover is open so the scroll
 * container ref is guaranteed to exist when `useVirtualizer` initialises.
 */
function ToolPickerList({
  flatRows,
  toggleTool,
  toggleNamespace,
  toggleExpanded,
}: {
  flatRows: VirtualRow[];
  toggleTool: (path: string) => void;
  toggleNamespace: (ns: ToolNamespace) => void;
  toggleExpanded: (prefix: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => flatRows[index]?.kind === "namespace" ? NS_ROW_HEIGHT : TOOL_ROW_HEIGHT,
    overscan: 15,
  });

  return (
    <div ref={scrollRef} className="max-h-[360px] overflow-y-auto">
      {flatRows.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground">No tools found.</div>
      ) : (
        <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = flatRows[virtualRow.index]!;
            return (
              <div
                key={virtualRow.index}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {row.kind === "namespace" ? (
                  <div className="flex items-center px-1">
                    <button
                      type="button"
                      onClick={() => toggleNamespace(row.ns)}
                      className="flex flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground cursor-default select-none"
                    >
                      <div
                        className={cn(
                          "flex h-3.5 w-3.5 items-center justify-center rounded-sm border border-border shrink-0",
                          row.allSelected ? "bg-primary border-primary" : row.someSelected ? "bg-primary/30 border-primary/50" : "bg-transparent",
                        )}
                      >
                        {row.allSelected && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                        {row.someSelected && !row.allSelected && <div className="h-1.5 w-1.5 rounded-xs bg-primary-foreground" />}
                      </div>
                      <span className="font-mono text-xs font-medium">{row.ns.prefix}.*</span>
                      <Badge variant="outline" className="text-[9px] px-1 py-0 font-normal">
                        {row.ns.source}
                      </Badge>
                      <span className="ml-auto text-[10px] text-muted-foreground">
                        {row.ns.tools.length}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleExpanded(row.ns.prefix)}
                      className="p-1 mr-1 rounded hover:bg-muted/80 text-muted-foreground shrink-0"
                    >
                      {row.expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => toggleTool(row.tool.path)}
                    className="flex w-full items-center gap-2 rounded-sm pl-8 pr-2 py-1 text-sm hover:bg-accent hover:text-accent-foreground cursor-default select-none"
                  >
                    <div
                      className={cn(
                        "flex h-3.5 w-3.5 items-center justify-center rounded-sm border border-border shrink-0",
                        row.selected ? "bg-primary border-primary" : "bg-transparent",
                      )}
                    >
                      {row.selected && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                    </div>
                    <div className="flex flex-col gap-0 min-w-0 flex-1 text-left">
                      <span className="font-mono text-[11px] truncate">{row.tool.path}</span>
                      {row.tool.description && (
                        <span className="text-[10px] text-muted-foreground truncate leading-tight">
                          {row.tool.description.slice(0, 80)}
                        </span>
                      )}
                    </div>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ToolPicker({
  tools,
  selectedPaths,
  onSelectionChange,
  onPatternChange,
}: {
  tools: ToolDescriptor[];
  selectedPaths: string[];
  onSelectionChange: (paths: string[]) => void;
  onPatternChange: (pattern: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const deferredSearch = useDeferredValue(searchInput);
  const namespaces = useMemo(() => buildNamespaces(tools), [tools]);
  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const [expandedNamespaces, setExpandedNamespaces] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  // Filtering uses the deferred value so typing stays snappy.
  const filteredNamespaces = useMemo(() => {
    if (!deferredSearch.trim()) return namespaces;
    const lower = deferredSearch.toLowerCase();
    return namespaces
      .map((ns) => ({
        ...ns,
        tools: ns.tools.filter(
          (t) =>
            t.path.toLowerCase().includes(lower)
            || t.description?.toLowerCase().includes(lower),
        ),
      }))
      .filter((ns) => ns.tools.length > 0);
  }, [namespaces, deferredSearch]);

  // Flatten namespaces + visible tools into a single row array for the virtualizer.
  const flatRows = useMemo(() => {
    const rows: VirtualRow[] = [];
    const isSearching = deferredSearch.trim().length > 0;
    for (const ns of filteredNamespaces) {
      const allSelected = ns.tools.every((t) => selectedSet.has(t.path));
      const someSelected = ns.tools.some((t) => selectedSet.has(t.path));
      const expanded = expandedNamespaces.has(ns.prefix) || isSearching;
      rows.push({ kind: "namespace", ns, allSelected, someSelected, expanded });
      if (expanded) {
        for (const tool of ns.tools) {
          rows.push({ kind: "tool", tool, selected: selectedSet.has(tool.path) });
        }
      }
    }
    return rows;
  }, [filteredNamespaces, selectedSet, expandedNamespaces, deferredSearch]);

  const toggleTool = useCallback((path: string) => {
    const next = new Set(selectedPaths);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    const nextPaths = Array.from(next);
    onSelectionChange(nextPaths);
    onPatternChange(derivePatternFromSelection(nextPaths, namespaces));
  }, [selectedPaths, namespaces, onSelectionChange, onPatternChange]);

  const toggleNamespace = useCallback((ns: ToolNamespace) => {
    const nsPaths = ns.tools.map((t) => t.path);
    const allSelected = nsPaths.every((p) => selectedSet.has(p));
    const next = new Set(selectedPaths);
    for (const p of nsPaths) {
      if (allSelected) next.delete(p);
      else next.add(p);
    }
    const nextPaths = Array.from(next);
    onSelectionChange(nextPaths);
    onPatternChange(derivePatternFromSelection(nextPaths, namespaces));
  }, [selectedPaths, selectedSet, namespaces, onSelectionChange, onPatternChange]);

  const toggleExpanded = useCallback((prefix: string) => {
    setExpandedNamespaces((prev) => {
      const next = new Set(prev);
      if (next.has(prefix)) next.delete(prefix);
      else next.add(prefix);
      return next;
    });
  }, []);

  const selectionSummary = useMemo(() => {
    if (selectedPaths.length === 0) return "All tools (no filter)";
    if (selectedPaths.length === 1) return selectedPaths[0];
    for (const ns of namespaces) {
      const nsPaths = new Set(ns.tools.map((t) => t.path));
      if (selectedPaths.length === nsPaths.size && selectedPaths.every((p) => nsPaths.has(p))) {
        return `${ns.prefix}.* (${nsPaths.size} tools)`;
      }
    }
    return `${selectedPaths.length} tools selected`;
  }, [selectedPaths, namespaces]);

  return (
    <Popover open={open} onOpenChange={(next) => {
      setOpen(next);
      if (next) {
        requestAnimationFrame(() => searchRef.current?.focus());
      }
    }}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-9 w-full justify-between bg-background text-sm hover:bg-muted/50 border-border/70"
        >
          <span className="truncate text-left">{selectionSummary}</span>
          <ChevronDown className="ml-2 h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[460px] p-0" align="start">
        {/* Search input — deferred for filtering so typing never lags */}
        <div className="flex h-9 items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 opacity-50" />
          <Input
            ref={searchRef}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search tools..."
            className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => setSearchInput("")}
              className="p-0.5 rounded hover:bg-muted/80 text-muted-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* Virtualized list — own component so scroll ref exists at mount time */}
        <ToolPickerList
          flatRows={flatRows}
          toggleTool={toggleTool}
          toggleNamespace={toggleNamespace}
          toggleExpanded={toggleExpanded}
        />

        {/* Footer */}
        {selectedPaths.length > 0 && (
          <div className="border-t border-border/50 p-2 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{selectedPaths.length} selected</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => { onSelectionChange([]); onPatternChange("*"); }}
            >
              Clear
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── Argument Conditions Editor ───────────────────────────────────────────────

function ArgumentConditionsEditor({
  conditions,
  onChange,
}: {
  conditions: ArgumentCondition[];
  onChange: (conditions: ArgumentCondition[]) => void;
}) {
  const addCondition = () => {
    onChange([...conditions, { key: "", operator: "equals", value: "" }]);
  };

  const updateCondition = (index: number, field: keyof ArgumentCondition, value: string) => {
    const next = [...conditions];
    next[index] = { ...next[index]!, [field]: value };
    onChange(next);
  };

  const removeCondition = (index: number) => {
    onChange(conditions.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">
          Argument conditions
          <span className="text-[10px] ml-1 opacity-60">(optional)</span>
        </Label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 text-[10px] px-2 gap-1"
          onClick={addCondition}
        >
          <Plus className="h-2.5 w-2.5" />
          Add condition
        </Button>
      </div>
      {conditions.length > 0 && (
        <div className="space-y-1.5">
          {conditions.map((condition, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <Input
                value={condition.key}
                onChange={(e) => updateCondition(index, "key", e.target.value)}
                placeholder="arg name"
                className="h-7 text-[11px] font-mono flex-1 min-w-0 bg-background"
              />
              <Select
                value={condition.operator}
                onValueChange={(v) => updateCondition(index, "operator", v)}
              >
                <SelectTrigger className="h-7 text-[10px] w-[100px] bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.entries(OPERATOR_LABELS) as [ArgumentConditionOperator, string][]).map(([op, label]) => (
                    <SelectItem key={op} value={op} className="text-[11px]">{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={condition.value}
                onChange={(e) => updateCondition(index, "value", e.target.value)}
                placeholder="value"
                className="h-7 text-[11px] font-mono flex-1 min-w-0 bg-background"
              />
              <button
                type="button"
                onClick={() => removeCondition(index)}
                className="p-1 rounded hover:bg-muted/80 text-muted-foreground hover:text-foreground shrink-0"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          <p className="text-[10px] text-muted-foreground/60 leading-tight">
            All conditions must match for this policy to apply at invocation time.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Policy Card ──────────────────────────────────────────────────────────────

function PolicyCard({
  policy,
  tools,
  currentAccountId,
  onDelete,
  canDelete,
  deleting,
}: {
  policy: ToolPolicyRecord;
  tools: ToolDescriptor[];
  currentAccountId?: string;
  onDelete: (policy: ToolPolicyRecord) => void;
  canDelete: boolean;
  deleting: boolean;
}) {
  const decision = getDecisionFromPolicy(policy);
  const config = DECISION_CONFIG[decision];
  const Icon = config.icon;

  const matchingTools = useMemo(() => {
    return tools.filter((tool) => policyMatchesTool(policy, tool));
  }, [policy, tools]);

  const [showTools, setShowTools] = useState(false);

  return (
    <div className="group relative rounded-none border border-border/60 bg-card/60 hover:border-border transition-colors">
      <div className="px-3.5 py-2.5">
        {/* Header row */}
        <div className="flex items-start gap-2.5">
          <div className={cn("mt-0.5 shrink-0", config.color)}>
            <Icon className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className={cn("text-xs font-medium", config.color)}>{config.label}</span>
              <span className="text-[10px] text-muted-foreground/50">|</span>
              <Badge
                variant="outline"
                className="text-[9px] px-1.5 py-0 font-mono uppercase tracking-wider border-border/50"
              >
                {scopeLabel(policy, currentAccountId)}
              </Badge>
              <Badge
                variant="outline"
                className="text-[9px] px-1.5 py-0 font-mono uppercase tracking-wider border-border/50"
              >
                p{policy.priority}
              </Badge>
              <Badge
                variant="outline"
                className="text-[9px] px-1.5 py-0 font-mono uppercase tracking-wider border-border/50"
              >
                {resourceTypeLabel(policy.resourceType)}
              </Badge>
            </div>
            {/* Pattern display */}
            <div className="mt-1">
              <button
                type="button"
                onClick={() => matchingTools.length > 0 && setShowTools(!showTools)}
                className={cn(
                  "font-mono text-[11px] px-1.5 py-0.5 rounded bg-muted/50 border border-border/30 inline-flex items-center gap-1",
                  matchingTools.length > 0 && "hover:bg-muted/80 cursor-pointer",
                )}
              >
                <span>{policy.resourcePattern}</span>
                {policy.resourcePattern !== "*" && matchingTools.length > 0 && (
                  <span className="text-[9px] text-muted-foreground">
                    ({matchingTools.length} tool{matchingTools.length !== 1 ? "s" : ""})
                  </span>
                )}
              </button>
            </div>
            {/* Metadata */}
            {policy.targetAccountId && policy.targetAccountId !== currentAccountId && (
              <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <User className="h-2.5 w-2.5" />
                  {policy.targetAccountId}
                </span>
              </div>
            )}
            {/* Expanded tools list */}
            {showTools && matchingTools.length > 0 && (
              <div className="mt-2 pt-2 border-t border-border/30">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-0.5 max-h-[120px] overflow-y-auto">
                  {matchingTools.map((tool) => (
                    <div key={tool.path} className="text-[10px] font-mono text-muted-foreground truncate px-1 py-0.5 rounded hover:bg-muted/30">
                      {tool.path}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          {/* Delete */}
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onDelete(policy)}
                  disabled={deleting || !canDelete}
                  className={cn(
                    "opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded shrink-0",
                    canDelete
                      ? "hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                      : "text-muted-foreground/40 cursor-not-allowed",
                  )}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="text-xs">
                {canDelete ? "Delete policy" : "Policy-set-managed policy (delete from policy sets)"}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
    </div>
  );
}

// ── Main Panel ───────────────────────────────────────────────────────────────

export function PoliciesPanel({
  tools = [],
  loadingTools = false,
}: {
  tools?: ToolDescriptor[];
  loadingTools?: boolean;
}) {
  const { context, workspaces } = useSession();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(defaultFormState);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [roleForm, setRoleForm] = useState<RoleFormState>(defaultRoleFormState);
  const [roleRuleForm, setRoleRuleForm] = useState<RoleRuleFormState>(defaultRoleRuleFormState);
  const [roleBindingForm, setRoleBindingForm] = useState<RoleBindingFormState>(defaultRoleBindingFormState);
  const [busyRoleAction, setBusyRoleAction] = useState<string | null>(null);

  const listArgs = workspaceQueryArgs(context);
  const policiesQuery = useQuery(convexApi.workspace.listToolPolicies, listArgs);
  const upsertToolPolicySet = useMutation(convexApi.workspace.upsertToolPolicySet);
  const upsertToolPolicyRule = useMutation(convexApi.workspace.upsertToolPolicyRule);
  const upsertToolPolicyAssignment = useMutation(convexApi.workspace.upsertToolPolicyAssignment);
  const deleteToolPolicySet = useMutation(convexApi.workspace.deleteToolPolicySet);
  const deleteToolPolicyRule = useMutation(convexApi.workspace.deleteToolPolicyRule);
  const deleteToolPolicyAssignment = useMutation(convexApi.workspace.deleteToolPolicyAssignment);

  const loading = Boolean(context) && policiesQuery === undefined;
  const policies = useMemo(() => (policiesQuery ?? []) as ToolPolicyRecord[], [policiesQuery]);

  const currentWorkspace = useMemo(() => {
    if (!context) return null;
    return workspaces.find((workspace) => workspace.id === context.workspaceId) ?? null;
  }, [context, workspaces]);
  const currentOrganizationId = currentWorkspace?.organizationId ?? null;

  const membersQuery = useQuery(
    convexApi.organizationMembers.list,
    context && currentOrganizationId
      ? { organizationId: currentOrganizationId, sessionId: context.sessionId }
      : "skip",
  );
  const memberItems = useMemo(
    () => ((membersQuery?.items ?? []) as OrganizationMemberListItem[]),
    [membersQuery],
  );
  const selfMembership = useMemo(() => {
    if (!context) return null;
    return memberItems.find((member) => member.accountId === context.accountId) ?? null;
  }, [context, memberItems]);
  const canManageRoles = selfMembership?.role === "owner" || selfMembership?.role === "admin";

  const rolesQuery = useQuery(
    convexApi.workspace.listToolPolicySets,
    context && canManageRoles ? listArgs : "skip",
  );
  const roleItems = useMemo(() => ((rolesQuery ?? []) as ToolPolicySetRecord[]), [rolesQuery]);
  const activeRoleId = useMemo(() => {
    if (!canManageRoles) {
      return null;
    }

    if (selectedRoleId && roleItems.some((role) => role.id === selectedRoleId)) {
      return selectedRoleId;
    }

    return roleItems[0]?.id ?? null;
  }, [canManageRoles, roleItems, selectedRoleId]);

  const bindingsQuery = useQuery(
    convexApi.workspace.listToolPolicyAssignments,
    context && canManageRoles ? listArgs : "skip",
  );
  const bindingItems = useMemo(() => ((bindingsQuery ?? []) as ToolPolicyAssignmentRecord[]), [bindingsQuery]);

  const roleRulesQuery = useQuery(
    convexApi.workspace.listToolPolicyRules,
    context && canManageRoles && activeRoleId
      ? {
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          roleId: activeRoleId,
        }
      : "skip",
  );
  const selectedRoleRules = useMemo(
    () => ((roleRulesQuery ?? []) as ToolPolicyRuleRecord[]),
    [roleRulesQuery],
  );

  const namespaces = useMemo(() => buildNamespaces(tools), [tools]);
  const sourceOptions = useMemo(() => {
    return [...new Set(tools
      .map((tool) => tool.source)
      .filter((source): source is string => typeof source === "string" && source.trim().length > 0))]
      .sort((a, b) => a.localeCompare(b));
  }, [tools]);
  const namespaceOptions = useMemo(() => {
    return [...new Set(namespaces.map((namespace) => namespace.prefix))]
      .sort((a, b) => a.localeCompare(b));
  }, [namespaces]);

  const selectedRole = useMemo(
    () => roleItems.find((role) => role.id === activeRoleId) ?? null,
    [activeRoleId, roleItems],
  );
  const selectedRoleBindings = useMemo(
    () => bindingItems.filter((binding) => binding.roleId === activeRoleId),
    [activeRoleId, bindingItems],
  );
  const activeMemberOptions = useMemo(
    () => memberItems.filter((member) => member.status === "active"),
    [memberItems],
  );

  // ── Handlers ──

  const handleSave = async () => {
    if (!context) return;

    let resourceType: PolicyResourceType = form.resourceType;
    let pattern = "";
    if (resourceType === "all_tools") {
      pattern = "*";
    } else if (resourceType === "source") {
      pattern = form.sourcePattern.trim();
      if (!pattern) {
        toast.error("Select a source for source-scoped policies");
        return;
      }
    } else if (resourceType === "namespace") {
      pattern = form.namespacePattern.trim();
      if (!pattern) {
        toast.error("Namespace pattern is required");
        return;
      }
    } else {
      pattern = form.resourcePattern.trim() || (form.selectedToolPaths.length > 0
        ? derivePatternFromSelection(form.selectedToolPaths, namespaces)
        : "*");
      if (!pattern) {
        toast.error("Tool path pattern is required");
        return;
      }
      resourceType = pattern === "*" ? "all_tools" : "tool_path";
    }

    const priority = Number(form.priority.trim() || "100");
    if (!Number.isFinite(priority)) {
      toast.error("Priority must be a number");
      return;
    }

    setSubmitting(true);
    try {
      const policyId = createToolPolicyId();
      const roleId = toolPolicyRoleId(policyId);
      const ruleId = toolPolicyRuleId(policyId);
      const bindingId = toolPolicyBindingId(policyId);
      const { effect, approvalMode } = getDecisionPayload(form.decision);
      const argumentConditions = form.argumentConditions.filter((c) => c.key.trim().length > 0);
      const selectorType = resourceType === "all_tools"
        ? "all" as const
        : resourceType === "source"
          ? "source" as const
          : resourceType === "namespace"
            ? "namespace" as const
            : "tool_path" as const;

      // Map UI scope to backend scopeType + targetAccountId.
      const scopeType = form.scope === "personal" ? "account" as const
        : form.scope === "workspace" ? "workspace" as const
        : "organization" as const;
      const targetAccountId = form.scope === "personal" ? context.accountId : undefined;

      await upsertToolPolicySet({
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        id: roleId,
        name: `tool-policy:${policyId}`,
        description: "Tool policy",
      });

      try {
        await upsertToolPolicyRule({
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          id: ruleId,
          roleId,
          selectorType,
          sourceKey: resourceType === "source" ? pattern : undefined,
          resourcePattern: resourceType === "source" || resourceType === "all_tools" ? undefined : pattern,
          matchType: pattern.includes("*") ? "glob" : "exact",
          effect,
          approvalMode,
          argumentConditions: argumentConditions.length > 0 ? argumentConditions : undefined,
          priority,
        });

        await upsertToolPolicyAssignment({
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          id: bindingId,
          roleId,
          scopeType,
          targetAccountId,
          clientId: form.clientId.trim() || undefined,
          status: "active",
        });
      } catch (error) {
        try {
          await deleteToolPolicySet({
            workspaceId: context.workspaceId,
            sessionId: context.sessionId,
            roleId,
          });
        } catch {
          // Best effort cleanup.
        }
        throw error;
      }

      toast.success("Policy created");
      setForm(defaultFormState());
      setDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save policy");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = useCallback(async (policy: ToolPolicyRecord) => {
    if (!context) return;
    if (!isDirectToolPolicy(policy)) {
      toast.error("This policy is managed by a policy set assignment. Use the Policy Set Manager to remove it.");
      return;
    }

    if (!policy.roleId) {
      toast.error("Cannot delete policy without role metadata");
      return;
    }

    setDeletingId(policy.id);
    try {
      await deleteToolPolicySet({
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        roleId: policy.roleId,
      });
      toast.success("Policy deleted");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete policy");
    } finally {
      setDeletingId(null);
    }
  }, [context, deleteToolPolicySet]);

  const handleCreateRole = useCallback(async () => {
    if (!context) return;
    const name = roleForm.name.trim();
    if (!name) {
      toast.error("Role name is required");
      return;
    }

    setBusyRoleAction("create-role");
    try {
      const role = await upsertToolPolicySet({
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        name,
        description: roleForm.description.trim() || undefined,
      });
      setRoleForm(defaultRoleFormState());
      setSelectedRoleId(role.id);
      toast.success("Role created");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create role");
    } finally {
      setBusyRoleAction(null);
    }
  }, [context, roleForm, upsertToolPolicySet]);

  const handleCreateRoleRule = useCallback(async () => {
    if (!context || !activeRoleId) return;

    const priority = Number(roleRuleForm.priority.trim() || "100");
    if (!Number.isFinite(priority)) {
      toast.error("Rule priority must be a number");
      return;
    }

    const selectorType = roleRuleForm.selectorType;
    const sourceKey = roleRuleForm.sourceKey.trim();
    const resourcePattern = roleRuleForm.resourcePattern.trim();
    if (selectorType === "source" && !sourceKey) {
      toast.error("Source is required for source-scoped rules");
      return;
    }
    if ((selectorType === "namespace" || selectorType === "tool_path") && !resourcePattern) {
      toast.error("Pattern is required for this selector");
      return;
    }

    setBusyRoleAction("create-rule");
    try {
      await upsertToolPolicyRule({
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        roleId: activeRoleId,
        selectorType,
        sourceKey: selectorType === "source" ? sourceKey : undefined,
        resourcePattern: selectorType === "source" || selectorType === "all" ? undefined : resourcePattern,
        matchType: roleRuleForm.matchType,
        effect: roleRuleForm.effect,
        approvalMode: roleRuleForm.approvalMode,
        priority,
      });
      setRoleRuleForm(defaultRoleRuleFormState());
      toast.success("Rule added");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to add rule");
    } finally {
      setBusyRoleAction(null);
    }
  }, [activeRoleId, context, roleRuleForm, upsertToolPolicyRule]);

  const handleCreateRoleBinding = useCallback(async () => {
    if (!context || !activeRoleId) return;

    const scopeType = roleBindingForm.scopeType;
    const targetAccountId = roleBindingForm.targetAccountId.trim();
    if (scopeType === "account" && !targetAccountId) {
      toast.error("Select an account for account-scoped bindings");
      return;
    }

    setBusyRoleAction("create-binding");
    try {
      await upsertToolPolicyAssignment({
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        roleId: activeRoleId,
        scopeType,
        targetAccountId: scopeType === "account"
          ? (targetAccountId as Id<"accounts">)
          : undefined,
        clientId: roleBindingForm.clientId.trim() || undefined,
        status: roleBindingForm.status,
      });
      setRoleBindingForm(defaultRoleBindingFormState());
      toast.success("Binding added");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to add binding");
    } finally {
      setBusyRoleAction(null);
    }
  }, [activeRoleId, context, roleBindingForm, upsertToolPolicyAssignment]);

  const handleDeleteRole = useCallback(async (roleId: string) => {
    if (!context) return;

    setBusyRoleAction(`delete-role:${roleId}`);
    try {
      await deleteToolPolicySet({
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        roleId,
      });
      if (activeRoleId === roleId) {
        setSelectedRoleId(null);
      }
      toast.success("Role deleted");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete role");
    } finally {
      setBusyRoleAction(null);
    }
  }, [activeRoleId, context, deleteToolPolicySet]);

  const handleDeleteRule = useCallback(async (ruleId: string) => {
    if (!context || !activeRoleId) return;

    setBusyRoleAction(`delete-rule:${ruleId}`);
    try {
      await deleteToolPolicyRule({
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        roleId: activeRoleId,
        ruleId,
      });
      toast.success("Rule deleted");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete rule");
    } finally {
      setBusyRoleAction(null);
    }
  }, [activeRoleId, context, deleteToolPolicyRule]);

  const handleDeleteBinding = useCallback(async (bindingId: string) => {
    if (!context) return;

    setBusyRoleAction(`delete-binding:${bindingId}`);
    try {
      await deleteToolPolicyAssignment({
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        bindingId,
      });
      toast.success("Binding deleted");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete binding");
    } finally {
      setBusyRoleAction(null);
    }
  }, [context, deleteToolPolicyAssignment]);

  // ── Group policies by decision for display ──

  const groupedPolicies = useMemo(() => {
    const groups: Record<PolicyDecisionType, ToolPolicyRecord[]> = {
      allow: [],
      require_approval: [],
      deny: [],
    };
    for (const policy of policies) {
      const decision = getDecisionFromPolicy(policy);
      groups[decision].push(policy);
    }
    return groups;
  }, [policies]);

  // ── Render ──

  return (
    <section className="flex h-full min-h-0 w-full overflow-hidden bg-background">
      {/* ── Left sidebar ── */}
      <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border/40 bg-card/30 lg:w-72">
        {/* Sidebar header */}
        <div className="shrink-0 border-b border-border/30 px-3 py-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-medium leading-none">Policies</h3>
            </div>
            <Button
              onClick={() => { setForm(defaultFormState()); setDialogOpen(true); }}
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              disabled={!context}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">
            {policies.length} {policies.length === 1 ? "policy" : "policies"}
          </p>
        </div>

        {/* Sidebar policy list */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading || loadingTools ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 rounded-md" />
              ))}
            </div>
          ) : policies.length === 0 ? (
            <div className="flex flex-col items-center gap-2.5 px-4 py-10">
              <Shield className="h-7 w-7 text-muted-foreground/30" />
              <div className="text-center">
                <p className="text-xs text-muted-foreground">No policies</p>
                <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                  Create a policy to customize tool approval behavior.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11px] gap-1 mt-1"
                onClick={() => { setForm(defaultFormState()); setDialogOpen(true); }}
              >
                <Plus className="h-3 w-3" />
                Create first policy
              </Button>
            </div>
          ) : (
            <div className="p-2 space-y-3">
              {(["deny", "require_approval", "allow"] as const).map((decisionType) => {
                const group = groupedPolicies[decisionType];
                if (group.length === 0) return null;
                const config = DECISION_CONFIG[decisionType];
                return (
                  <div key={decisionType}>
                    <div className="flex items-center gap-2 mb-1.5 px-1">
                      <config.icon className={cn("h-3 w-3", config.color)} />
                      <span className={cn("text-[10px] font-medium uppercase tracking-wider", config.color)}>
                        {config.label}
                      </span>
                      <span className="text-[9px] text-muted-foreground/40">
                        ({group.length})
                      </span>
                    </div>
                    <div className="space-y-1">
                      {group.map((policy) => (
                        <PolicyCard
                          key={policy.id}
                          policy={policy}
                          tools={tools}
                          currentAccountId={context?.accountId}
                          onDelete={handleDelete}
                          canDelete={isDirectToolPolicy(policy)}
                          deleting={deletingId === policy.id}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      {/* ── Right content panel ── */}
      <div className="flex-1 min-w-0 max-h-screen overflow-y-auto bg-background/50">
        <div className="p-4 sm:p-5 space-y-4">
      <details className="group rounded-none border border-border/60 bg-card/30">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5">
          <div>
            <h4 className="text-sm font-medium">Policy Set Manager</h4>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Advanced: reusable policy sets with rules and assignments.
            </p>
          </div>
          <span className="text-[10px] text-muted-foreground group-open:hidden">Expand</span>
          <span className="text-[10px] text-muted-foreground hidden group-open:inline">Collapse</span>
        </summary>

        <div className="px-3 pb-3">
          {!canManageRoles ? (
            <div className="rounded-none border border-dashed border-border/50 p-4 text-xs text-muted-foreground">
              Organization owner/admin role required to manage tool policy sets.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
            <div className="space-y-3 rounded-none border border-border/60 bg-card/50 p-3">
              <Label className="text-xs text-muted-foreground">Create policy set</Label>
              <Input
                value={roleForm.name}
                onChange={(event) => setRoleForm((state) => ({ ...state, name: event.target.value }))}
                placeholder="Policy set name"
                className="h-8 text-xs"
              />
              <Input
                value={roleForm.description}
                onChange={(event) => setRoleForm((state) => ({ ...state, description: event.target.value }))}
                placeholder="Description (optional)"
                className="h-8 text-xs"
              />
              <Button
                size="sm"
                className="h-8 text-xs"
                onClick={handleCreateRole}
                disabled={busyRoleAction === "create-role"}
              >
                {busyRoleAction === "create-role" ? "Creating..." : "Create policy set"}
              </Button>

              <Separator className="bg-border/40" />

              <div className="space-y-1.5 max-h-[320px] overflow-y-auto">
                {roleItems.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">No policy sets yet.</p>
                ) : (
                  roleItems.map((role) => {
                    const bindingCount = bindingItems.filter((binding) => binding.roleId === role.id).length;
                    return (
                      <button
                        key={role.id}
                        type="button"
                        onClick={() => setSelectedRoleId(role.id)}
                        className={cn(
                          "w-full rounded-md border px-2 py-1.5 text-left",
                          activeRoleId === role.id
                            ? "border-primary/40 bg-primary/5"
                            : "border-border/40 hover:bg-muted/30",
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-xs font-medium">{role.name}</span>
                          <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                            {bindingCount} assign
                          </Badge>
                        </div>
                        {role.description ? (
                          <p className="mt-1 truncate text-[10px] text-muted-foreground">{role.description}</p>
                        ) : null}
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            <div className="space-y-4 rounded-none border border-border/60 bg-card/50 p-4">
              {!selectedRole ? (
                <p className="text-xs text-muted-foreground">Select a policy set to manage its rules and assignments.</p>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h5 className="text-sm font-medium">{selectedRole.name}</h5>
                      {selectedRole.description ? (
                        <p className="text-[11px] text-muted-foreground mt-1">{selectedRole.description}</p>
                      ) : null}
                      <p className="text-[10px] text-muted-foreground mt-1 font-mono">{selectedRole.id}</p>
                    </div>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="h-8 text-xs"
                      onClick={() => handleDeleteRole(selectedRole.id)}
                      disabled={busyRoleAction === `delete-role:${selectedRole.id}`}
                    >
                      {busyRoleAction === `delete-role:${selectedRole.id}` ? "Deleting..." : "Delete set"}
                    </Button>
                  </div>

                  <Separator className="bg-border/40" />

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs text-muted-foreground">Rules</Label>
                      <span className="text-[10px] text-muted-foreground">{selectedRoleRules.length}</span>
                    </div>
                    <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
                      {selectedRoleRules.length === 0 ? (
                        <p className="text-[11px] text-muted-foreground">No rules.</p>
                      ) : (
                        selectedRoleRules.map((rule) => (
                          <div key={rule.id} className="rounded border border-border/40 px-2 py-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <Badge variant="outline" className="text-[9px] px-1.5 py-0 uppercase">
                                  {rule.selectorType}
                                </Badge>
                                <span className="text-[10px] font-mono truncate">{roleRulePattern(rule) || "*"}</span>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleDeleteRule(rule.id)}
                                disabled={busyRoleAction === `delete-rule:${rule.id}`}
                                className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </div>
                            <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                              <span>{rule.effect}</span>
                              <span>|</span>
                              <span>{rule.approvalMode}</span>
                              <span>|</span>
                              <span>p{rule.priority}</span>
                            </div>
                          </div>
                        ))
                      )}
                    </div>

                    <div className="grid grid-cols-1 gap-2 rounded-md border border-border/40 bg-muted/10 p-2 md:grid-cols-2">
                      <Select
                        value={roleRuleForm.selectorType}
                        onValueChange={(value) => setRoleRuleForm((state) => ({
                          ...state,
                           selectorType: value as ToolPolicyRuleRecord["selectorType"],
                        }))}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all" className="text-xs">All tools</SelectItem>
                          <SelectItem value="source" className="text-xs">Source</SelectItem>
                          <SelectItem value="namespace" className="text-xs">Namespace</SelectItem>
                          <SelectItem value="tool_path" className="text-xs">Tool path</SelectItem>
                        </SelectContent>
                      </Select>

                      {roleRuleForm.selectorType === "source" ? (
                        <Select
                          value={roleRuleForm.sourceKey}
                          onValueChange={(value) => setRoleRuleForm((state) => ({ ...state, sourceKey: value }))}
                        >
                          <SelectTrigger className="h-8 text-xs font-mono">
                            <SelectValue placeholder="Source" />
                          </SelectTrigger>
                          <SelectContent>
                            {sourceOptions.map((source) => (
                              <SelectItem key={source} value={source} className="text-xs font-mono">
                                {source}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input
                          value={roleRuleForm.resourcePattern}
                          onChange={(event) => setRoleRuleForm((state) => ({ ...state, resourcePattern: event.target.value }))}
                          placeholder={roleRuleForm.selectorType === "namespace" ? "github.repos.*" : "github.repos.delete"}
                          className="h-8 text-xs font-mono"
                          disabled={roleRuleForm.selectorType === "all"}
                        />
                      )}

                      <Select
                        value={roleRuleForm.effect}
                        onValueChange={(value) => setRoleRuleForm((state) => ({
                          ...state,
                           effect: value as ToolPolicyRuleRecord["effect"],
                        }))}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="allow" className="text-xs">Allow</SelectItem>
                          <SelectItem value="deny" className="text-xs">Deny</SelectItem>
                        </SelectContent>
                      </Select>

                      <Select
                        value={roleRuleForm.approvalMode}
                        onValueChange={(value) => setRoleRuleForm((state) => ({
                          ...state,
                           approvalMode: value as ToolPolicyRuleRecord["approvalMode"],
                        }))}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="inherit" className="text-xs">Inherit</SelectItem>
                          <SelectItem value="required" className="text-xs">Require approval</SelectItem>
                          <SelectItem value="auto" className="text-xs">Auto approve</SelectItem>
                        </SelectContent>
                      </Select>

                      <Input
                        value={roleRuleForm.priority}
                        onChange={(event) => setRoleRuleForm((state) => ({ ...state, priority: event.target.value }))}
                        placeholder="priority"
                        className="h-8 text-xs font-mono"
                      />

                      <Button
                        size="sm"
                        className="h-8 text-xs md:col-span-2"
                        onClick={handleCreateRoleRule}
                        disabled={busyRoleAction === "create-rule"}
                      >
                        {busyRoleAction === "create-rule" ? "Adding rule..." : "Add rule"}
                      </Button>
                    </div>
                  </div>

                  <Separator className="bg-border/40" />

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs text-muted-foreground">Assignments</Label>
                      <span className="text-[10px] text-muted-foreground">{selectedRoleBindings.length}</span>
                    </div>
                    <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
                      {selectedRoleBindings.length === 0 ? (
                        <p className="text-[11px] text-muted-foreground">No bindings.</p>
                      ) : (
                        selectedRoleBindings.map((binding) => (
                          <div key={binding.id} className="rounded border border-border/40 px-2 py-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1.5">
                                <Badge variant="outline" className="text-[9px] px-1.5 py-0 uppercase">
                                  {binding.scopeType}
                                </Badge>
                                <Badge variant="outline" className="text-[9px] px-1.5 py-0 uppercase">
                                  {binding.status}
                                </Badge>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleDeleteBinding(binding.id)}
                                disabled={busyRoleAction === `delete-binding:${binding.id}`}
                                className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </div>
                            {binding.targetAccountId || binding.clientId ? (
                              <div className="mt-1 text-[10px] text-muted-foreground font-mono truncate">
                                {[binding.targetAccountId, binding.clientId].filter(Boolean).join(" | ")}
                              </div>
                            ) : null}
                          </div>
                        ))
                      )}
                    </div>

                    <div className="grid grid-cols-1 gap-2 rounded-md border border-border/40 bg-muted/10 p-2 md:grid-cols-2">
                      <Select
                        value={roleBindingForm.scopeType}
                        onValueChange={(value) => setRoleBindingForm((state) => ({
                          ...state,
                           scopeType: value as ToolPolicyAssignmentRecord["scopeType"],
                        }))}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="workspace" className="text-xs">Workspace</SelectItem>
                          <SelectItem value="organization" className="text-xs">Organization</SelectItem>
                          <SelectItem value="account" className="text-xs">Account</SelectItem>
                        </SelectContent>
                      </Select>

                      {roleBindingForm.scopeType === "account" ? (
                        <Select
                          value={roleBindingForm.targetAccountId}
                          onValueChange={(value) => setRoleBindingForm((state) => ({ ...state, targetAccountId: value }))}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue placeholder="Select account" />
                          </SelectTrigger>
                          <SelectContent>
                            {activeMemberOptions.map((member) => (
                              <SelectItem key={member.accountId} value={member.accountId} className="text-xs">
                                {member.displayName}{member.email ? ` (${member.email})` : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input
                          value={roleBindingForm.clientId}
                          onChange={(event) => setRoleBindingForm((state) => ({ ...state, clientId: event.target.value }))}
                          placeholder="client id (optional)"
                          className="h-8 text-xs font-mono"
                        />
                      )}

                      <Select
                        value={roleBindingForm.status}
                        onValueChange={(value) => setRoleBindingForm((state) => ({
                          ...state,
                           status: value as ToolPolicyAssignmentRecord["status"],
                        }))}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="active" className="text-xs">Active</SelectItem>
                          <SelectItem value="disabled" className="text-xs">Disabled</SelectItem>
                        </SelectContent>
                      </Select>

                      <Button
                        size="sm"
                        className="h-8 text-xs"
                        onClick={handleCreateRoleBinding}
                        disabled={busyRoleAction === "create-binding"}
                      >
                        {busyRoleAction === "create-binding" ? "Adding assignment..." : "Add assignment"}
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
          )}
        </div>
      </details>

      {/* Create Policy Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[540px]">
          <DialogHeader>
            <DialogTitle className="text-base">New Tool Policy</DialogTitle>
            <DialogDescription className="text-xs">
              Define which tools, namespaces, or sources are auto-approved, gated, or blocked.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Decision (most important, shown first) */}
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Action</Label>
              <div className="grid grid-cols-3 gap-2">
                {(["allow", "require_approval", "deny"] as const).map((d) => {
                  const cfg = DECISION_CONFIG[d];
                  const Icon = cfg.icon;
                  const isSelected = form.decision === d;
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setForm((s) => ({ ...s, decision: d }))}
                      className={cn(
                        "rounded-lg border p-2.5 text-left transition-all",
                        isSelected
                          ? "border-primary/50 bg-primary/5 ring-1 ring-primary/20"
                          : "border-border/50 hover:border-border bg-card hover:bg-muted/30",
                      )}
                    >
                      <Icon className={cn("h-4 w-4 mb-1.5", cfg.color)} />
                      <p className="text-[11px] font-medium leading-none">{cfg.label}</p>
                      <p className="text-[9px] text-muted-foreground mt-1 leading-snug">{cfg.description}</p>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Resource target */}
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Apply to</Label>
              <Select
                value={form.resourceType}
                onValueChange={(value) => {
                  const nextType = value as PolicyResourceType;
                  setForm((state) => ({
                    ...state,
                    resourceType: nextType,
                    resourcePattern: nextType === "all_tools" ? "*" : state.resourcePattern,
                    selectedToolPaths: nextType === "tool_path" ? state.selectedToolPaths : [],
                  }));
                }}
              >
                <SelectTrigger className="h-9 text-xs bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(RESOURCE_TYPE_CONFIG) as PolicyResourceType[]).map((resourceType) => (
                    <SelectItem key={resourceType} value={resourceType} className="text-xs">
                      {RESOURCE_TYPE_CONFIG[resourceType].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[10px] text-muted-foreground/70 leading-tight">
                {RESOURCE_TYPE_CONFIG[form.resourceType].description}
              </p>

              {form.resourceType === "all_tools" && (
                <div className="h-9 rounded-md border border-border/40 bg-muted/20 px-3 flex items-center text-[11px] font-mono text-muted-foreground">
                  *
                </div>
              )}

              {form.resourceType === "source" && (
                <>
                  {sourceOptions.length > 0 ? (
                    <Select
                      value={form.sourcePattern}
                      onValueChange={(sourcePattern) => setForm((state) => ({ ...state, sourcePattern }))}
                    >
                      <SelectTrigger className="h-9 text-xs font-mono bg-background">
                        <SelectValue placeholder="Select source" />
                      </SelectTrigger>
                      <SelectContent>
                        {sourceOptions.map((source) => (
                          <SelectItem key={source} value={source} className="text-xs font-mono">
                            {source}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      value={form.sourcePattern}
                      onChange={(event) => setForm((state) => ({ ...state, sourcePattern: event.target.value }))}
                      placeholder="source:github"
                      className="h-9 text-xs font-mono bg-background"
                    />
                  )}
                </>
              )}

              {form.resourceType === "namespace" && (
                <>
                  {namespaceOptions.length > 0 ? (
                    <Select
                      value={form.namespacePattern}
                      onValueChange={(namespace) => setForm((state) => ({ ...state, namespacePattern: `${namespace}.*` }))}
                    >
                      <SelectTrigger className="h-9 text-xs font-mono bg-background">
                        <SelectValue placeholder="Select namespace" />
                      </SelectTrigger>
                      <SelectContent>
                        {namespaceOptions.map((namespace) => (
                          <SelectItem key={namespace} value={namespace} className="text-xs font-mono">
                            {namespace}.*
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                  <Input
                    value={form.namespacePattern}
                    onChange={(event) => setForm((state) => ({ ...state, namespacePattern: event.target.value }))}
                    placeholder="github.repos.*"
                    className="h-9 text-xs font-mono bg-background"
                  />
                </>
              )}

              {form.resourceType === "tool_path" && (
                <>
                  {tools.length > 0 ? (
                    <ToolPicker
                      tools={tools}
                      selectedPaths={form.selectedToolPaths}
                      onSelectionChange={(paths) => setForm((state) => ({ ...state, selectedToolPaths: paths }))}
                      onPatternChange={(pattern) => setForm((state) => ({ ...state, resourcePattern: pattern }))}
                    />
                  ) : (
                    <Input
                      value={form.resourcePattern}
                      onChange={(event) => setForm((state) => ({ ...state, resourcePattern: event.target.value }))}
                      placeholder="github.repos.* or github.repos.list"
                      className="h-9 text-xs font-mono bg-background"
                    />
                  )}
                  {form.selectedToolPaths.length > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-muted-foreground shrink-0">Pattern:</span>
                      <Input
                        value={form.resourcePattern || derivePatternFromSelection(form.selectedToolPaths, namespaces)}
                        onChange={(event) => setForm((state) => ({ ...state, resourcePattern: event.target.value }))}
                        className="h-6 text-[10px] font-mono bg-muted/30 border-border/30"
                      />
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Scope */}
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Scope</Label>
              <Select
                value={form.scope}
                onValueChange={(v) => setForm((s) => ({ ...s, scope: v as PolicyScope }))}
              >
                <SelectTrigger className="h-9 text-xs bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="personal" className="text-xs">Personal</SelectItem>
                  <SelectItem value="workspace" className="text-xs">This workspace</SelectItem>
                  <SelectItem value="organization" className="text-xs">Entire organization</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Priority */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">Priority</Label>
                <span className="text-[10px] text-muted-foreground/60">Higher number = higher precedence</span>
              </div>
              <Input
                value={form.priority}
                onChange={(e) => setForm((s) => ({ ...s, priority: e.target.value }))}
                placeholder="100"
                className="h-9 text-xs font-mono bg-background w-24"
              />
            </div>

            <details className="rounded-md border border-border/40 bg-muted/10 p-3">
              <summary className="cursor-pointer text-xs text-muted-foreground">Optional filters</summary>
              <div className="mt-3 space-y-3">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Client ID</Label>
                  <Input
                    value={form.clientId}
                    onChange={(event) => setForm((state) => ({ ...state, clientId: event.target.value }))}
                    placeholder="optional client identifier"
                    className="h-8 text-xs font-mono bg-background"
                  />
                  <p className="text-[10px] text-muted-foreground/60 leading-tight">
                    When set, this policy only applies to tool calls from this client ID.
                  </p>
                </div>

                <ArgumentConditionsEditor
                  conditions={form.argumentConditions}
                  onChange={(argumentConditions) => setForm((state) => ({ ...state, argumentConditions }))}
                />
              </div>
            </details>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} className="text-xs">
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={submitting || !context} className="text-xs gap-1.5">
              {submitting ? "Creating..." : "Create Policy"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
        </div>
      </div>
    </section>
  );
}
