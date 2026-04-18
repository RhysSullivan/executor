import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";
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
import { Tabs, TabsList, TabsTrigger } from "../components/tabs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OperationPermission = "read" | "write" | "deny";

export interface OperationEntry {
  /** Stable row key (operationId, tool name, etc.) */
  id: string;
  /** HTTP method (GET, POST, PUT, PATCH, DELETE) or tool name */
  method?: string;
  /** URL path or tool identifier */
  path: string;
  /** Human-readable summary */
  summary?: string;
  /** Whether the operation is deprecated */
  deprecated?: boolean;
  /** Current permission level */
  permission?: OperationPermission;
  /** When provided, row is expandable and this renders the expanded detail. */
  renderDetail?: () => React.ReactNode;
}

export interface SourceOperationsProps {
  readonly operations: readonly OperationEntry[];
  readonly onPermissionChange?: (index: number, permission: OperationPermission) => void;
  /** Content displayed above the operations list (e.g. scopes) */
  readonly prepend?: React.ReactNode;
  /** Placeholder when there are no operations */
  readonly emptyLabel?: string;
}

// ---------------------------------------------------------------------------
// HTTP method badge colors
// ---------------------------------------------------------------------------

const METHOD_COLORS: Record<string, string> = {
  GET: "text-green-600 dark:text-green-500",
  POST: "text-blue-700 dark:text-blue-500",
  PUT: "text-yellow-700 dark:text-yellow-500",
  PATCH: "text-yellow-700 dark:text-yellow-500",
  DELETE: "text-red-600 dark:text-red-500",
};

function MethodBadge({ method }: { method: string }) {
  const upper = method.toUpperCase();
  const color = METHOD_COLORS[upper] ?? "text-muted-foreground";

  return (
    <span
      className={cn(
        "w-16 shrink-0 text-left font-mono text-xs font-medium uppercase",
        color,
      )}
    >
      {upper}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Permission tabs (read / write / deny)
// ---------------------------------------------------------------------------

function PermissionTabs({
  value = "read",
  onChange,
}: {
  value?: OperationPermission;
  onChange?: (value: OperationPermission) => void;
}) {
  return (
    <Tabs
      value={value}
      onValueChange={(v) => onChange?.(v as OperationPermission)}
    >
      <TabsList className="h-7">
        <TabsTrigger value="read" className="h-6 px-2 text-xs">
          read
        </TabsTrigger>
        <TabsTrigger value="write" className="h-6 px-2 text-xs">
          write
        </TabsTrigger>
        <TabsTrigger value="deny" className="h-6 px-2 text-xs">
          deny
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SourceOperations({
  operations,
  onPermissionChange,
  prepend,
  emptyLabel = "No operations",
}: SourceOperationsProps) {
  const [query, setQuery] = React.useState("");
  const [openId, setOpenId] = React.useState<string | null>(null);

  const filtered = React.useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return operations;
    return operations.filter((op) =>
      `${op.method ?? ""} ${op.path} ${op.summary ?? ""}`.toLowerCase().includes(trimmed),
    );
  }, [operations, query]);

  return (
    <CardStack searchable searchQuery={query} onSearchChange={setQuery}>
      <CardStackHeader>Operations</CardStackHeader>
      {prepend}
      <CardStackContent>
        {filtered.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            {emptyLabel}
          </div>
        ) : (
          filtered.map((op) => {
            const rowIndex = operations.indexOf(op);
            const expandable = Boolean(op.renderDetail);
            const open = expandable && openId === op.id;

            return (
              <div key={op.id} className="flex flex-col">
                <CardStackEntry
                  className={cn(expandable && "cursor-pointer hover:bg-accent/40")}
                  onClick={
                    expandable
                      ? () => setOpenId(open ? null : op.id)
                      : undefined
                  }
                  aria-expanded={expandable ? open : undefined}
                >
                  {expandable && (
                    <ChevronRight
                      className={cn(
                        "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
                        open && "rotate-90",
                      )}
                    />
                  )}
                  {op.method && <MethodBadge method={op.method} />}
                  <CardStackEntryContent>
                    <CardStackEntryTitle
                      className={cn(
                        "font-mono text-xs",
                        op.deprecated && "line-through text-muted-foreground",
                      )}
                    >
                      {op.path}
                    </CardStackEntryTitle>
                    {op.summary && (
                      <CardStackEntryDescription>{op.summary}</CardStackEntryDescription>
                    )}
                  </CardStackEntryContent>
                  {onPermissionChange && (
                    <CardStackEntryActions
                      onClick={(e) => e.stopPropagation()}
                    >
                      <PermissionTabs
                        value={op.permission ?? "read"}
                        onChange={(perm) => onPermissionChange(rowIndex, perm)}
                      />
                    </CardStackEntryActions>
                  )}
                </CardStackEntry>
                {open && (
                  <div className="border-t border-border/40 bg-muted/20 px-4 py-4">
                    {op.renderDetail!()}
                  </div>
                )}
              </div>
            );
          })
        )}
      </CardStackContent>
    </CardStack>
  );
}
