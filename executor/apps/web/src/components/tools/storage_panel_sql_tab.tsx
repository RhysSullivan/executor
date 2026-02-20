import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { sqlCellText, truncateText, type StorageSqlObject, type StorageSqlResult } from "./storage_panel_shared";
import { JsonPreview } from "./storage_panel_json_preview";

type StorageSqlTabContentProps = {
  canInspect: boolean;
  visibleSqlObjects: StorageSqlObject[];
  sqlShowInternalObjects: boolean;
  sqlObjectsLoading: boolean;
  sqlObjectsError: string | null;
  selectedSqlObjectName: string | null;
  sqlText: string;
  sqlMaxRows: string;
  sqlLoading: boolean;
  sqlError: string | null;
  sqlResult: StorageSqlResult | null;
  sqlRows: Array<Record<string, unknown>>;
  sqlColumns: string[];
  sqlViewMode: "table" | "json";
  onToggleShowInternalObjects: () => void;
  onRefreshSqlObjects: () => void;
  onOpenSqlObject: (name: string) => void;
  onSqlTextChange: (value: string) => void;
  onRunSql: () => void;
  onRunUserTables: () => void;
  onRunAllObjects: () => void;
  onRunKvSchema: () => void;
  onRunKvData: () => void;
  onRunFsEntries: () => void;
  onSqlMaxRowsChange: (value: string) => void;
  onSqlViewModeChange: (mode: "table" | "json") => void;
};

export function StorageSqlTabContent(props: StorageSqlTabContentProps) {
  const {
    canInspect,
    visibleSqlObjects,
    sqlShowInternalObjects,
    sqlObjectsLoading,
    sqlObjectsError,
    selectedSqlObjectName,
    sqlText,
    sqlMaxRows,
    sqlLoading,
    sqlError,
    sqlResult,
    sqlRows,
    sqlColumns,
    sqlViewMode,
    onToggleShowInternalObjects,
    onRefreshSqlObjects,
    onOpenSqlObject,
    onSqlTextChange,
    onRunSql,
    onRunUserTables,
    onRunAllObjects,
    onRunKvSchema,
    onRunKvData,
    onRunFsEntries,
    onSqlMaxRowsChange,
    onSqlViewModeChange,
  } = props;

  return (
    <TabsContent value="sql" className="flex-1 min-h-0 overflow-hidden">
        <div className="flex h-full min-h-0 flex-col">
          {visibleSqlObjects.length > 0 && (
            <div className="flex items-center gap-1.5 border-b border-border/30 bg-muted/15 px-4 py-1.5 overflow-x-auto shrink-0">
              <span className="mr-0.5 shrink-0 text-xs font-medium text-muted-foreground/70">Tables</span>
              {visibleSqlObjects.map((entry) => (
                <button
                  key={entry.name}
                  type="button"
                  className={cn(
                    "shrink-0 rounded-md px-2 py-0.5 text-xs font-medium transition-colors",
                    selectedSqlObjectName === entry.name
                      ? "bg-primary/15 text-primary ring-1 ring-primary/20"
                      : "text-foreground/60 hover:bg-accent/50 hover:text-foreground",
                  )}
                  onClick={() => onOpenSqlObject(entry.name)}
              >
                {entry.name}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-1 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                className="h-5 rounded px-1.5 text-xs text-muted-foreground/60"
                onClick={onToggleShowInternalObjects}
              >
                {sqlShowInternalObjects ? "Hide sys" : "Show sys"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 rounded px-1.5 text-xs text-muted-foreground/60"
                onClick={onRefreshSqlObjects}
                disabled={sqlObjectsLoading}
              >
                Refresh
              </Button>
            </div>
          </div>
        )}

        {sqlObjectsError && (
          <div className="border-b border-destructive/20 bg-destructive/5 px-4 py-1 text-[10px] text-destructive">
            {sqlObjectsError}
          </div>
        )}

        <div className="shrink-0 border-b border-border/30 bg-muted/20 p-3">
          <Textarea
            value={sqlText}
            onChange={(event) => {
              onSqlTextChange(event.target.value);
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                onRunSql();
              }
            }}
            className="min-h-[3.5rem] max-h-32 resize-y font-mono leading-relaxed placeholder:text-muted-foreground/40"
            placeholder="SELECT * FROM ..."
          />
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              className="h-6 rounded-md px-2.5 text-xs"
              disabled={sqlLoading || !canInspect}
              onClick={onRunSql}
            >
              <Play className="mr-1 h-2.5 w-2.5" /> Run
            </Button>
            <div className="h-4 w-px bg-border/40 mx-0.5" />
            <Button variant="ghost" size="sm" className="h-6 rounded-md px-2 text-xs text-muted-foreground" onClick={onRunUserTables}>
              User tables
            </Button>
            <Button variant="ghost" size="sm" className="h-6 rounded-md px-2 text-xs text-muted-foreground" onClick={onRunAllObjects}>
              All objects
            </Button>
            <Button variant="ghost" size="sm" className="h-6 rounded-md px-2 text-xs text-muted-foreground" onClick={onRunKvSchema}>
              KV schema
            </Button>
            <Button variant="ghost" size="sm" className="h-6 rounded-md px-2 text-xs text-muted-foreground" onClick={onRunKvData}>
              KV data
            </Button>
            <Button variant="ghost" size="sm" className="h-6 rounded-md px-2 text-xs text-muted-foreground" onClick={onRunFsEntries}>
              FS entries
            </Button>
            <div className="ml-auto flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground/60">Limit</span>
              <Input
                value={sqlMaxRows}
                onChange={(event) => onSqlMaxRowsChange(event.target.value)}
                className="h-6 w-14 rounded-md text-center"
              />
            </div>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground/50">
            Press <kbd className="rounded border border-border/40 bg-muted/50 px-1 py-0.5 text-[11px] font-mono">Cmd+Enter</kbd> to run
          </p>
        </div>

        {sqlError && (
          <div className="border-b border-destructive/20 bg-destructive/5 px-4 py-1.5 text-[11px] text-destructive">
            {sqlError}
          </div>
        )}

        <div className="min-h-0 flex-1 flex flex-col">
          {sqlLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-xs text-muted-foreground/60">Running query...</p>
            </div>
          ) : sqlResult ? (
            <>
              <div className="flex items-center justify-between border-b border-border/20 px-4 py-1.5 bg-muted/10">
                <span className="text-xs text-muted-foreground">
                  {sqlResult.rowCount} row{sqlResult.rowCount === 1 ? "" : "s"}
                  {typeof sqlResult.changes === "number" ? ` · ${sqlResult.changes} change${sqlResult.changes === 1 ? "" : "s"}` : ""}
                  {sqlColumns.length > 0 ? ` · ${sqlColumns.length} col${sqlColumns.length === 1 ? "" : "s"}` : ""}
                </span>
                <div className="flex items-center gap-0.5">
                  <Button
                    variant={sqlViewMode === "table" ? "default" : "ghost"}
                    size="sm"
                    className="h-5 rounded-md px-2 text-xs"
                    onClick={() => onSqlViewModeChange("table")}
                  >
                    Table
                  </Button>
                  <Button
                    variant={sqlViewMode === "json" ? "default" : "ghost"}
                    size="sm"
                    className="h-5 rounded-md px-2 text-xs"
                    onClick={() => onSqlViewModeChange("json")}
                  >
                    JSON
                  </Button>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-auto">
                {sqlViewMode === "json" ? (
                  <div className="p-4">
                    <JsonPreview data={sqlRows} />
                  </div>
                ) : sqlRows.length === 0 ? (
                  <div className="flex h-full items-center justify-center">
                    <p className="text-xs text-muted-foreground/60">Query returned no rows</p>
                  </div>
                ) : (
                  <table className="min-w-full border-collapse text-xs">
                    <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur-sm">
                      <tr>
                        <th className="w-10 border-b border-r border-border/30 px-3 py-1.5 text-left text-xs font-medium text-muted-foreground">#</th>
                        {sqlColumns.map((column) => (
                          <th
                            key={column}
                            className="border-b border-r border-border/30 px-3 py-1.5 text-left text-xs font-medium text-muted-foreground last:border-r-0"
                          >
                            {column}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sqlRows.map((row, rowIndex) => (
                        <tr key={`row-${rowIndex}`} className="hover:bg-accent/20 transition-colors">
                          <td className="border-b border-r border-border/15 px-3 py-1.5 align-top text-muted-foreground/50 tabular-nums">{rowIndex + 1}</td>
                          {sqlColumns.map((column) => (
                            <td
                              key={`row-${rowIndex}-${column}`}
                              className="max-w-[28rem] border-b border-r border-border/15 px-3 py-1.5 align-top last:border-r-0"
                            >
                              <div className="max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-foreground/80">
                                {row[column] === null ? (
                                  <span className="text-muted-foreground/40 italic">null</span>
                                ) : (
                                  truncateText(sqlCellText(row[column]), 2000)
                                )}
                              </div>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-xs text-muted-foreground/60">Select a table or run a query</p>
            </div>
          )}
        </div>
      </div>
    </TabsContent>
  );
}
