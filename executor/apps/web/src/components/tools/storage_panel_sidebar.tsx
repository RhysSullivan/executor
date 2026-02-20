import { Database, Plus, Power, Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { StorageDurability, StorageInstanceRecord, StorageScopeType } from "@/lib/types";
import { prettyBytes, relativeTime, scopeColor } from "./storage_panel_shared";

type StoragePanelSidebarProps = {
  visibleInstances: StorageInstanceRecord[];
  selectedInstanceId?: string;
  loading: boolean;
  creating: boolean;
  busyInstanceId?: string;
  showCreateForm: boolean;
  scopeType: StorageScopeType;
  durability: StorageDurability;
  purpose: string;
  ttlHours: string;
  onToggleCreateForm: () => void;
  onScopeTypeChange: (value: StorageScopeType) => void;
  onDurabilityChange: (value: StorageDurability) => void;
  onPurposeChange: (value: string) => void;
  onTtlHoursChange: (value: string) => void;
  onCreate: () => void;
  onSelectInstance: (id: string) => void;
  onCloseInstance: (id: string) => void;
  onDeleteInstance: (id: string) => void;
};

export function StoragePanelSidebar(props: StoragePanelSidebarProps) {
  const {
    visibleInstances,
    selectedInstanceId,
    loading,
    creating,
    busyInstanceId,
    showCreateForm,
    scopeType,
    durability,
    purpose,
    ttlHours,
    onToggleCreateForm,
    onScopeTypeChange,
    onDurabilityChange,
    onPurposeChange,
    onTtlHoursChange,
    onCreate,
    onSelectInstance,
    onCloseInstance,
    onDeleteInstance,
  } = props;

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border/40 bg-card/30 lg:w-72">
      <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
        <div className="flex items-center gap-2">
          <Database className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-foreground">Instances</span>
          {visibleInstances.length > 0 && (
            <Badge variant="outline" className="h-4 px-1.5 text-xs text-muted-foreground">
              {visibleInstances.length}
            </Badge>
          )}
        </div>
        <Button
          variant={showCreateForm ? "default" : "outline"}
          size="sm"
          className="h-6 rounded-md px-2 text-[10px]"
          onClick={onToggleCreateForm}
        >
          {showCreateForm ? <X className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
        </Button>
      </div>

      {showCreateForm && (
        <div className="border-b border-border/40 bg-muted/30 px-3 py-3">
          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Scope
                <Select
                  value={scopeType}
                  onValueChange={(value) => onScopeTypeChange(value as StorageScopeType)}
                >
                  <SelectTrigger className="h-8 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="scratch">scratch</SelectItem>
                    <SelectItem value="account">account</SelectItem>
                    <SelectItem value="workspace">workspace</SelectItem>
                    <SelectItem value="organization">organization</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Durability
                <Select
                  value={durability}
                  onValueChange={(value) => onDurabilityChange(value as StorageDurability)}
                >
                  <SelectTrigger className="h-8 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ephemeral">ephemeral</SelectItem>
                    <SelectItem value="durable">durable</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            </div>
            <Input
              value={purpose}
              onChange={(event) => onPurposeChange(event.target.value)}
              placeholder="Purpose (optional)"
              className="h-8 rounded-md"
            />
            <div className="flex items-end gap-2">
              <Input
                value={ttlHours}
                onChange={(event) => onTtlHoursChange(event.target.value)}
                disabled={durability !== "ephemeral"}
                placeholder="TTL (hours)"
                className="h-8 flex-1 rounded-md"
              />
              <Button size="sm" className="h-8 rounded-md px-3 text-xs" disabled={creating} onClick={onCreate}>
                Create
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="space-y-1 p-1.5">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="flex items-start gap-2.5 rounded-md px-2.5 py-2">
                <Skeleton className="mt-0.5 h-6 w-6 shrink-0 rounded-md" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-24 rounded" />
                  <Skeleton className="h-2.5 w-36 rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : visibleInstances.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 py-8">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted/50">
              <Database className="h-5 w-5 text-muted-foreground/40" />
            </div>
            <div className="text-center">
              <p className="text-xs font-medium text-muted-foreground">No instances</p>
              <p className="mt-0.5 text-xs text-muted-foreground/60">Create one to get started</p>
            </div>
          </div>
        ) : (
          <div className="p-1.5 space-y-0.5">
            {visibleInstances.map((instance) => {
              const busy = busyInstanceId === instance.id;
              const active = selectedInstanceId === instance.id;
              return (
                <div
                  key={instance.id}
                  className={cn(
                    "group relative rounded-md transition-all duration-150",
                    active
                      ? "bg-primary/8 ring-1 ring-primary/20"
                      : "hover:bg-accent/50",
                    busy && "opacity-50 pointer-events-none",
                  )}
                >
                  <button
                    type="button"
                    className="flex w-full items-start gap-2.5 px-2.5 py-2 text-left"
                    onClick={() => onSelectInstance(instance.id)}
                  >
                    <div className={cn(
                      "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
                      active ? "bg-primary/15 text-primary" : "bg-muted/60 text-muted-foreground",
                    )}>
                      <Database className="h-3 w-3" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className={cn(
                        "truncate text-xs font-medium",
                        active ? "text-foreground" : "text-foreground/80",
                      )}>
                        {instance.purpose || instance.id.slice(0, 12)}
                      </p>
                      <div className="mt-0.5 flex items-center gap-1.5">
                        <span className={cn("text-xs font-medium", scopeColor(instance.scopeType))}>
                          {instance.scopeType}
                        </span>
                        <span className="text-xs text-muted-foreground/40">/</span>
                        <span className="text-xs text-muted-foreground">
                          {prettyBytes(instance.sizeBytes)}
                        </span>
                        <span className="text-xs text-muted-foreground/40">/</span>
                        <span className="text-xs text-muted-foreground">
                          {relativeTime(instance.lastSeenAt)}
                        </span>
                      </div>
                    </div>
                  </button>
                  <div className={cn(
                    "absolute right-1.5 top-1.5 flex items-center gap-0.5 transition-opacity",
                    active ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                  )}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 w-5 rounded p-0 text-muted-foreground hover:text-foreground"
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        onCloseInstance(instance.id);
                      }}
                      title="Close instance"
                    >
                      <Power className="h-2.5 w-2.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 w-5 rounded p-0 text-muted-foreground hover:text-destructive"
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        onDeleteInstance(instance.id);
                      }}
                      title="Delete instance"
                    >
                      <Trash2 className="h-2.5 w-2.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
