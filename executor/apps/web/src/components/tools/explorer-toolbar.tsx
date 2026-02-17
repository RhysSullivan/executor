import {
  Search,
  ShieldCheck,
  Server,
  Filter,
  X,
  FolderTree,
  List,
} from "lucide-react";
import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export type GroupBy = "source" | "namespace" | "approval";
export type ViewMode = "tree" | "flat";
type FilterApproval = "all" | "required" | "auto";

interface ToolExplorerToolbarProps {
  search: string;
  filteredToolCount: number;
  hasSearch: boolean;
  resultCount: number;
  loadingInventory?: boolean;
  viewMode: ViewMode;
  groupBy: GroupBy;
  filterApproval: FilterApproval;
  showSourceSidebar: boolean;
  activeSource: string | null;
  sourceOptions: string[];
  selectedToolCount: number;
  onSearchChange: (value: string) => void;
  onClearSearch: () => void;
  onViewModeChange: (mode: ViewMode) => void;
  onGroupByChange: (mode: GroupBy) => void;
  onFilterApprovalChange: (filter: FilterApproval) => void;
  onSourceSelect: (source: string | null) => void;
  addSourceAction?: ReactNode;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}

export function ToolExplorerToolbar({
  search,
  filteredToolCount,
  loadingInventory = false,
  viewMode,
  groupBy,
  filterApproval,
  showSourceSidebar,
  activeSource,
  sourceOptions,
  selectedToolCount,
  onSearchChange,
  onClearSearch,
  onViewModeChange,
  onGroupByChange,
  onFilterApprovalChange,
  onSourceSelect,
  addSourceAction,
  onSelectAll,
  onClearSelection,
}: ToolExplorerToolbarProps) {
  return (
    <div className="shrink-0">
      <div className="flex items-center gap-2 pb-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={loadingInventory ? "Loading tools..." : `Search ${filteredToolCount} tools...`}
            className="h-8 text-xs pl-8 bg-background/50 border-border/50 focus:border-primary/30"
          />
          {search && (
            <button
              onClick={onClearSearch}
              className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 rounded flex items-center justify-center text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        <div className="flex h-8 rounded-md border border-border/50 overflow-hidden">
          <button
            onClick={() => onViewModeChange("tree")}
            className={cn(
              "px-2 flex items-center gap-1 text-[11px] transition-colors",
              viewMode === "tree"
                ? "bg-accent/40 text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/20",
            )}
          >
            <FolderTree className="h-3 w-3" />
            <span className="hidden sm:inline">Tree</span>
          </button>
          <button
            onClick={() => onViewModeChange("flat")}
            className={cn(
              "px-2 flex items-center gap-1 text-[11px] transition-colors border-l border-border/50",
              viewMode === "flat"
                ? "bg-accent/40 text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/20",
            )}
          >
            <List className="h-3 w-3" />
            <span className="hidden sm:inline">Flat</span>
          </button>
        </div>

        {viewMode === "tree" && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-[11px] border-border/50"
              >
                <FolderTree className="h-3 w-3 mr-1" />
                {groupBy === "source"
                  ? "By source"
                  : groupBy === "namespace"
                    ? "By namespace"
                    : "By approval"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="text-[11px]">Group by</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={groupBy === "source"}
                onCheckedChange={() => onGroupByChange("source")}
                className="text-xs"
              >
                Source → Namespace
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={groupBy === "namespace"}
                onCheckedChange={() => onGroupByChange("namespace")}
                className="text-xs"
              >
                Namespace
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={groupBy === "approval"}
                onCheckedChange={() => onGroupByChange("approval")}
                className="text-xs"
              >
                Approval mode
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={cn(
                "h-8 text-[11px] border-border/50",
                filterApproval !== "all" && "border-primary/30 text-primary",
              )}
            >
              <Filter className="h-3 w-3 mr-1" />
              {filterApproval === "all"
                ? "Filter"
                : filterApproval === "required"
                  ? "Gated only"
                  : "Auto only"}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel className="text-[11px]">Approval filter</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={filterApproval === "all"}
              onCheckedChange={() => onFilterApprovalChange("all")}
              className="text-xs"
            >
              All tools
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={filterApproval === "required"}
              onCheckedChange={() => onFilterApprovalChange("required")}
              className="text-xs"
            >
              Approval required
            </DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem
              checked={filterApproval === "auto"}
              onCheckedChange={() => onFilterApprovalChange("auto")}
              className="text-xs"
            >
              Auto-approved
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={cn(
                "h-8 text-[11px] border-border/50",
                showSourceSidebar && "lg:hidden",
                activeSource && "border-primary/30 text-primary",
              )}
            >
              <Server className="h-3 w-3 mr-1" />
              {activeSource ?? "All"}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel className="text-[11px]">Source</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={activeSource === null}
              onCheckedChange={() => onSourceSelect(null)}
              className="text-xs"
            >
              All sources
            </DropdownMenuCheckboxItem>
            {sourceOptions.map((src) => (
              <DropdownMenuCheckboxItem
                key={src}
                checked={activeSource === src}
                onCheckedChange={() => onSourceSelect(activeSource === src ? null : src)}
                className="text-xs font-mono"
              >
                {src}
              </DropdownMenuCheckboxItem>
            ))}
            </DropdownMenuContent>
          </DropdownMenu>

        {addSourceAction ? <div className="ml-auto">{addSourceAction}</div> : null}
      </div>

      {selectedToolCount > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 mb-2 rounded-md bg-primary/5 border border-primary/10">
          <span className="text-[12px] font-mono text-primary">
            {selectedToolCount} tool{selectedToolCount !== 1 ? "s" : ""} selected
          </span>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[11px] text-muted-foreground"
            onClick={onSelectAll}
          >
            Select all ({filteredToolCount})
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[11px] text-muted-foreground"
            onClick={onClearSelection}
          >
            Clear
          </Button>
          <div className="h-4 w-px bg-border/50" />
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-[11px] border-terminal-amber/30 text-terminal-amber hover:bg-terminal-amber/10"
          >
            <ShieldCheck className="h-3 w-3 mr-1" />
            Set approval
          </Button>
        </div>
      )}
    </div>
  );
}
