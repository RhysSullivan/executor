import {
  Search,
  Filter,
  Plus,
  X,
} from "lucide-react";
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
  filterApproval: FilterApproval;
  activeSource: string | null;
  onSearchChange: (value: string) => void;
  onClearSearch: () => void;
  onFilterApprovalChange: (filter: FilterApproval) => void;
  onAddSource?: () => void;
}

export function ToolExplorerToolbar({
  search,
  filteredToolCount,
  loadingInventory = false,
  filterApproval,
  onSearchChange,
  onClearSearch,
  onFilterApprovalChange,
  onAddSource,
}: ToolExplorerToolbarProps) {
  return (
    <div className="shrink-0 space-y-1.5">
      {/* Search — own row */}
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/50" />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={loadingInventory ? "Loading..." : `Search ${filteredToolCount} tools...`}
          className="h-7 text-[11px] pl-7 bg-background/50 border-border/50 focus:border-primary/30"
        />
        {search && (
          <button
            onClick={onClearSearch}
            className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 rounded flex items-center justify-center text-muted-foreground hover:text-foreground"
          >
            <X className="h-2.5 w-2.5" />
          </button>
        )}
      </div>

      {/* Filter + actions row */}
      <div className="flex items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={cn(
                "h-6 text-[10px] border-border/50 px-2",
                filterApproval !== "all" && "border-primary/30 text-primary",
              )}
            >
              <Filter className="h-2.5 w-2.5 mr-1" />
              {filterApproval === "all"
                ? "All"
                : filterApproval === "required"
                  ? "Gated"
                  : "Auto"}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
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

        <div className="flex-1" />

        {onAddSource ? (
          <Button
            variant="default"
            size="sm"
            className="h-6 text-[10px] px-2"
            onClick={onAddSource}
          >
            <Plus className="h-2.5 w-2.5 mr-1" />
            Add Source
          </Button>
        ) : null}
      </div>
    </div>
  );
}
