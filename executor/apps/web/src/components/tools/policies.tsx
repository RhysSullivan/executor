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
import { cn } from "@/lib/utils";
import type {
  AccessPolicyRecord,
  ArgumentCondition,
  ArgumentConditionOperator,
  ToolDescriptor,
} from "@/lib/types";
import type { Id } from "@executor/database/convex/_generated/dataModel";
import { workspaceQueryArgs } from "@/lib/workspace/query-args";
import { sourceLabel } from "@/lib/tool/source-utils";

// ── Types ────────────────────────────────────────────────────────────────────

type PolicyDecisionType = "allow" | "require_approval" | "deny";

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
  selectedToolPaths: string[];
  resourcePattern: string;
  argumentConditions: ArgumentCondition[];
  clientId: string;
  priority: string;
}

function defaultFormState(): FormState {
  return {
    scope: "personal",
    decision: "require_approval",
    selectedToolPaths: [],
    resourcePattern: "",
    argumentConditions: [],
    clientId: "",
    priority: "100",
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getDecisionFromPolicy(policy: AccessPolicyRecord): PolicyDecisionType {
  if (policy.effect === "deny") return "deny";
  return policy.approvalMode === "required" ? "require_approval" : "allow";
}

function getDecisionPayload(decision: PolicyDecisionType) {
  if (decision === "deny") return { effect: "deny" as const, approvalMode: "required" as const };
  if (decision === "require_approval") return { effect: "allow" as const, approvalMode: "required" as const };
  return { effect: "allow" as const, approvalMode: "auto" as const };
}

function scopeLabel(policy: AccessPolicyRecord, currentAccountId?: string): string {
  if (policy.targetAccountId) {
    return policy.targetAccountId === currentAccountId ? "personal" : "user";
  }
  const scopeType = policy.scopeType ?? (policy.workspaceId ? "workspace" : "organization");
  return scopeType === "organization" ? "org" : "workspace";
}

const DECISION_CONFIG: Record<PolicyDecisionType, { label: string; color: string; icon: typeof ShieldCheck; description: string }> = {
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

function patternMatchesToolPath(pattern: string, toolPath: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === toolPath;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(toolPath);
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
  const flatRows = useMemo<VirtualRow[]>(() => {
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
          className="h-9 w-full justify-between text-xs font-mono bg-background hover:bg-muted/50 border-border/70"
        >
          <span className="truncate text-left">{selectionSummary}</span>
          <ChevronDown className="ml-2 h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[460px] p-0" align="start">
        {/* Search input — raw input, deferred for filtering so typing never lags */}
        <div className="flex h-9 items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 opacity-50" />
          <input
            ref={searchRef}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search tools..."
            className="flex h-10 w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
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
            <span className="text-[10px] text-muted-foreground">{selectedPaths.length} selected</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[10px] px-2"
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
  deleting,
}: {
  policy: AccessPolicyRecord;
  tools: ToolDescriptor[];
  currentAccountId?: string;
  onDelete: (id: string) => void;
  deleting: boolean;
}) {
  const decision = getDecisionFromPolicy(policy);
  const config = DECISION_CONFIG[decision];
  const Icon = config.icon;

  const matchingTools = useMemo(() => {
    if (policy.resourcePattern === "*") return tools;
    return tools.filter((t) => patternMatchesToolPath(policy.resourcePattern, t.path));
  }, [policy.resourcePattern, tools]);

  const [showTools, setShowTools] = useState(false);

  return (
    <div className="group relative rounded-lg border border-border/60 bg-card hover:border-border transition-colors">
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
                  onClick={() => onDelete(policy.id)}
                  disabled={deleting}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive shrink-0"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="left" className="text-xs">Delete policy</TooltipContent>
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
  const { context } = useSession();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(defaultFormState);

  const listArgs = workspaceQueryArgs(context);
  const policiesQuery = useQuery(convexApi.workspace.listAccessPolicies, listArgs);
  const upsertAccessPolicy = useMutation(convexApi.workspace.upsertAccessPolicy);
  const deleteAccessPolicy = useMutation(convexApi.workspace.deleteAccessPolicy);

  const loading = Boolean(context) && policiesQuery === undefined;
  const policies = useMemo(() => (policiesQuery ?? []) as AccessPolicyRecord[], [policiesQuery]);

  const namespaces = useMemo(() => buildNamespaces(tools), [tools]);

  // ── Handlers ──

  const handleSave = async () => {
    if (!context) return;

    const pattern = form.resourcePattern.trim() || (form.selectedToolPaths.length > 0
      ? derivePatternFromSelection(form.selectedToolPaths, namespaces)
      : "*");
    if (!pattern) {
      toast.error("Tool path pattern is required");
      return;
    }

    const priority = Number(form.priority.trim() || "100");
    if (!Number.isFinite(priority)) {
      toast.error("Priority must be a number");
      return;
    }

    setSubmitting(true);
    try {
      const { effect, approvalMode } = getDecisionPayload(form.decision);
      const argumentConditions = form.argumentConditions.filter((c) => c.key.trim().length > 0);

      // Map UI scope to backend scopeType + targetAccountId.
      const scopeType = form.scope === "personal" ? "account" as const
        : form.scope === "workspace" ? "workspace" as const
        : "organization" as const;
      const targetAccountId = form.scope === "personal" ? context.accountId : undefined;

      await upsertAccessPolicy({
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        scopeType,
        resourcePattern: pattern,
        effect,
        approvalMode,
        matchType: pattern.includes("*") ? "glob" : "exact",
        targetAccountId,
        clientId: form.clientId.trim() || undefined,
        argumentConditions: argumentConditions.length > 0 ? argumentConditions : undefined,
        priority,
      });

      toast.success("Policy created");
      setForm(defaultFormState());
      setDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save policy");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = useCallback(async (policyId: string) => {
    if (!context) return;
    setDeletingId(policyId);
    try {
      await deleteAccessPolicy({
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        policyId,
      });
      toast.success("Policy deleted");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete policy");
    } finally {
      setDeletingId(null);
    }
  }, [context, deleteAccessPolicy]);

  // ── Group policies by decision for display ──

  const groupedPolicies = useMemo(() => {
    const groups: Record<PolicyDecisionType, AccessPolicyRecord[]> = {
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
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Shield className="h-4 w-4 text-muted-foreground" />
          <div>
            <h3 className="text-sm font-medium leading-none">Access Policies</h3>
            <p className="text-[11px] text-muted-foreground mt-1">
              Control which tools require approval, auto-approve, or are blocked
            </p>
          </div>
        </div>
        <Button
          onClick={() => { setForm(defaultFormState()); setDialogOpen(true); }}
          size="sm"
          className="h-8 text-xs gap-1.5"
          disabled={!context}
        >
          <Plus className="h-3.5 w-3.5" />
          New Policy
        </Button>
      </div>

      <Separator className="bg-border/40" />

      {/* Policies list */}
      {loading || loadingTools ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-lg" />
          ))}
        </div>
      ) : policies.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border/50 py-10 flex flex-col items-center gap-2.5">
          <Shield className="h-8 w-8 text-muted-foreground/30" />
          <div className="text-center">
            <p className="text-xs text-muted-foreground">No policies configured</p>
            <p className="text-[11px] text-muted-foreground/60 mt-0.5">
              Tools use their default approval settings. Create a policy to customize behavior.
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
        <div className="space-y-4">
          {(["deny", "require_approval", "allow"] as const).map((decisionType) => {
            const group = groupedPolicies[decisionType];
            if (group.length === 0) return null;
            const config = DECISION_CONFIG[decisionType];
            return (
              <div key={decisionType}>
                <div className="flex items-center gap-2 mb-2">
                  <config.icon className={cn("h-3 w-3", config.color)} />
                  <span className={cn("text-[11px] font-medium uppercase tracking-wider", config.color)}>
                    {config.label}
                  </span>
                  <span className="text-[10px] text-muted-foreground/40">
                    ({group.length})
                  </span>
                </div>
                <div className="space-y-1.5">
                  {group.map((policy) => (
                    <PolicyCard
                      key={policy.id}
                      policy={policy}
                      tools={tools}
                      currentAccountId={context?.accountId}
                      onDelete={handleDelete}
                      deleting={deletingId === policy.id}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create Policy Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[540px]">
          <DialogHeader>
            <DialogTitle className="text-base">New Access Policy</DialogTitle>
            <DialogDescription className="text-xs">
              Define which tools are auto-approved, require manual approval, or blocked.
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

            {/* Tools selection */}
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Apply to tools</Label>
              {tools.length > 0 ? (
                <ToolPicker
                  tools={tools}
                  selectedPaths={form.selectedToolPaths}
                  onSelectionChange={(paths) => setForm((s) => ({ ...s, selectedToolPaths: paths }))}
                  onPatternChange={(pattern) => setForm((s) => ({ ...s, resourcePattern: pattern }))}
                />
              ) : (
                <Input
                  value={form.resourcePattern}
                  onChange={(e) => setForm((s) => ({ ...s, resourcePattern: e.target.value }))}
                  placeholder="github.repos.* or * for all tools"
                  className="h-9 text-xs font-mono bg-background"
                />
              )}
              {/* Editable pattern override */}
              {form.selectedToolPaths.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground shrink-0">Pattern:</span>
                  <Input
                    value={form.resourcePattern || derivePatternFromSelection(form.selectedToolPaths, namespaces)}
                    onChange={(e) => setForm((s) => ({ ...s, resourcePattern: e.target.value }))}
                    className="h-6 text-[10px] font-mono bg-muted/30 border-border/30"
                  />
                </div>
              )}
            </div>

            {/* Scope */}
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
  );
}
