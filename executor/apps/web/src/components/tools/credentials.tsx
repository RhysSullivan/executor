"use client";

import { useMemo, useState } from "react";
import { KeyRound, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  CredentialRecord,
  SourceAuthProfile,
  ToolSourceScopeType,
  ToolSourceRecord,
} from "@/lib/types";
import {
  connectionDisplayName,
} from "@/lib/credentials/source-helpers";
import {
  sourceForCredentialKey,
} from "@/lib/tools/source-helpers";
import { SourceFavicon } from "./source-favicon";
import { ConnectionFormPanel } from "./connection/form-panel";
import { cn } from "@/lib/utils";

type ConnectionScope = "account" | "workspace";

type PanelState =
  | { mode: "idle" }
  | { mode: "create"; sourceKey?: string }
  | { mode: "edit"; credential: CredentialRecord };

export function CredentialsPanel({
  sources,
  credentials,
  loading,
  sourceAuthProfiles,
  loadingSourceNames,
}: {
  sources: ToolSourceRecord[];
  credentials: CredentialRecord[];
  loading: boolean;
  sourceAuthProfiles: Record<string, SourceAuthProfile>;
  loadingSourceNames?: string[];
}) {
  const [panel, setPanel] = useState<PanelState>({ mode: "idle" });

  const connectionOptions = useMemo(() => {
      const grouped = new Map<string, {
      key: string;
      id: string;
      scopeType: ToolSourceScopeType;
      scope: ConnectionScope;
      accountId?: string;
      provider: "local-convex" | "workos-vault";
      sourceKeys: Set<string>;
      updatedAt: number;
    }>();

    for (const credential of credentials) {
      const scopeType: ToolSourceScopeType = credential.scopeType === "organization" ? "organization" : "workspace";
      const scope: ConnectionScope = credential.scopeType === "account" ? "account" : "workspace";
      const groupKey = `${scopeType}:${credential.id}`;
      const existing = grouped.get(groupKey);
      if (existing) {
        existing.sourceKeys.add(credential.sourceKey);
        existing.updatedAt = Math.max(existing.updatedAt, credential.updatedAt);
      } else {
        grouped.set(groupKey, {
          key: groupKey,
          id: credential.id,
          scopeType,
          scope,
          accountId: credential.accountId,
          provider: credential.provider,
          sourceKeys: new Set([credential.sourceKey]),
          updatedAt: credential.updatedAt,
        });
      }
    }

    return [...grouped.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [credentials]);

  const representativeCredentialByConnection = useMemo(() => {
    const map = new Map<string, CredentialRecord>();
    for (const credential of credentials) {
      const scopeType = credential.scopeType === "organization" ? "organization" : "workspace";
      const key = `${scopeType}:${credential.id}`;
      if (!map.has(key)) {
        map.set(key, credential);
      }
    }
    return map;
  }, [credentials]);

  const selectedConnectionKey = panel.mode === "edit"
    ? (() => {
        const scopeType = panel.credential.scopeType === "organization" ? "organization" : "workspace";
        return `${scopeType}:${panel.credential.id}`;
      })()
    : null;

  return (
    <section className="flex h-full min-h-0 w-full overflow-hidden bg-background">
      {/* ── Left sidebar ── */}
      <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border/40 bg-card/30 lg:w-72">
        {/* Sidebar header */}
        <div className="shrink-0 border-b border-border/30 px-3 py-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-medium leading-none">Connections</h3>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={() => setPanel({ mode: "create" })}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">
            {connectionOptions.length} {connectionOptions.length === 1 ? "connection" : "connections"}
          </p>
        </div>

        {/* Sidebar connection list */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 rounded-md" />
              ))}
            </div>
          ) : connectionOptions.length === 0 ? (
            <div className="flex flex-col items-center gap-2.5 px-4 py-10">
              <div className="flex h-10 w-10 items-center justify-center border border-border/60 bg-muted/40">
                <KeyRound className="h-5 w-5 text-muted-foreground/50" />
              </div>
              <div className="text-center">
                <p className="text-xs text-muted-foreground">No connections</p>
                <p className="text-[10px] text-muted-foreground/60 mt-0.5">
                  Add a source, then create or link a reusable connection.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11px] gap-1 mt-1"
                onClick={() => setPanel({ mode: "create" })}
              >
                <Plus className="h-3 w-3" />
                Add connection
              </Button>
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {connectionOptions.map((connection) => {
                const representative = representativeCredentialByConnection.get(connection.key);
                if (!representative) {
                  return null;
                }
                const firstSource = sourceForCredentialKey(sources, representative.sourceKey);
                const isSelected = selectedConnectionKey === connection.key;
                return (
                  <button
                    key={connection.key}
                    type="button"
                    onClick={() => setPanel({ mode: "edit", credential: representative })}
                    className={cn(
                      "group flex w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors",
                      isSelected
                        ? "border-primary/40 bg-primary/5"
                        : "border-border/40 bg-background/70 hover:border-border hover:bg-accent/20",
                    )}
                  >
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center border border-border/60 bg-muted/50 overflow-hidden rounded-sm">
                      {firstSource ? (
                        <SourceFavicon
                          source={firstSource}
                          iconClassName="h-3.5 w-3.5 text-muted-foreground"
                          imageClassName="w-4 h-4"
                        />
                      ) : (
                        <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="text-xs font-medium truncate block">{connectionDisplayName(sources, connection)}</span>
                      <div className="flex items-center gap-1 mt-0.5">
                        <Badge variant="outline" className="text-[8px] px-1 py-0 font-mono uppercase tracking-wider">
                          {connection.scope}
                        </Badge>
                        <span className="text-[9px] text-muted-foreground">
                          {connection.sourceKeys.size} API{connection.sourceKeys.size === 1 ? "" : "s"}
                        </span>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      {/* ── Right content panel ── */}
      <div className="flex-1 min-w-0 max-h-screen overflow-hidden bg-background/50">
        {panel.mode === "create" ? (
          <ConnectionFormPanel
            key="create"
            editing={null}
            initialSourceKey={panel.sourceKey}
            sources={sources}
            credentials={credentials}
            sourceAuthProfiles={sourceAuthProfiles}
            loadingSourceNames={loadingSourceNames}
            onClose={() => setPanel({ mode: "idle" })}
          />
        ) : panel.mode === "edit" ? (
          <ConnectionFormPanel
            key={`edit-${panel.credential.id}`}
            editing={panel.credential}
            sources={sources}
            credentials={credentials}
            sourceAuthProfiles={sourceAuthProfiles}
            loadingSourceNames={loadingSourceNames}
            onClose={() => setPanel({ mode: "idle" })}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <div className="text-center space-y-3 max-w-sm px-6">
              <div className="flex h-12 w-12 mx-auto items-center justify-center border border-border/60 bg-muted/40 rounded-sm">
                <KeyRound className="h-6 w-6 text-muted-foreground/40" />
              </div>
              {loading ? (
                <p className="text-xs text-muted-foreground">Loading connections...</p>
              ) : connectionOptions.length === 0 ? (
                <>
                  <p className="text-sm text-muted-foreground">No connections configured</p>
                  <p className="text-[11px] text-muted-foreground/60">
                    Add a source, then create or link a reusable connection to get started.
                  </p>
                  <Button
                    size="sm"
                    className="h-8 text-xs gap-1.5 mt-2"
                    onClick={() => setPanel({ mode: "create" })}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add Connection
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    {connectionOptions.length} {connectionOptions.length === 1 ? "connection" : "connections"} configured
                  </p>
                  <p className="text-[11px] text-muted-foreground/60">
                    Select a connection from the sidebar to edit it, or add a new one.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs gap-1.5 mt-2"
                    onClick={() => setPanel({ mode: "create" })}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add Connection
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
