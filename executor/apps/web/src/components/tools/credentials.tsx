"use client";

import { useMemo } from "react";
import { KeyRound, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/session-context";
import type {
  CredentialRecord,
  ToolSourceScopeType,
  ToolSourceRecord,
} from "@/lib/types";
import {
  connectionDisplayName,
  ownerScopeLabel,
  providerLabel,
} from "@/lib/credentials/source-helpers";
import {
  sourceForCredentialKey,
} from "@/lib/tools/source-helpers";
import { SourceFavicon } from "./source-favicon";

type ConnectionScope = "account" | "workspace";

export function CredentialsPanel({
  sources,
  credentials,
  loading,
  onCreateConnection,
  onEditConnection,
}: {
  sources: ToolSourceRecord[];
  credentials: CredentialRecord[];
  loading: boolean;
  onCreateConnection: (sourceKey?: string) => void;
  onEditConnection: (credential: CredentialRecord) => void;
}) {
  const { clientConfig } = useSession();

  const storageCopy = clientConfig?.authProviderMode === "workos"
    ? "Stored encrypted"
    : "Stored locally on this machine";

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

  return (
    <section className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-col rounded-none border border-border/50 bg-card/30">
      <div className="flex items-center justify-between border-b border-border/40 px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center border border-border/60 bg-background/80">
            <KeyRound className="h-4 w-4 text-muted-foreground" />
          </div>
          <h2 className="text-sm font-medium">Connections</h2>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="h-5 px-2 text-[10px] font-mono uppercase tracking-wide text-muted-foreground">
            {connectionOptions.length}
          </Badge>
          <Button size="sm" className="h-8 text-xs" onClick={() => onCreateConnection()}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add Connection
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : connectionOptions.length === 0 ? (
          <div className="flex h-full min-h-[280px] flex-col items-center justify-center gap-2 border border-dashed border-border/50 bg-background/50">
            <div className="flex h-10 w-10 items-center justify-center border border-border/60 bg-muted/40">
              <KeyRound className="h-5 w-5 text-muted-foreground/50" />
            </div>
            <p className="text-sm text-muted-foreground">No connections configured</p>
            <p className="text-[11px] text-muted-foreground/70 text-center max-w-md">
              Add a source, then create or link a reusable connection.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {connectionOptions.map((connection) => {
              const representative = representativeCredentialByConnection.get(connection.key);
              if (!representative) {
                return null;
              }
              const firstSource = sourceForCredentialKey(sources, representative.sourceKey);
              return (
                <div
                  key={connection.key}
                  className="group flex items-center gap-3 border border-border/50 bg-background/70 px-3 py-2.5 transition-colors hover:border-border hover:bg-accent/20"
                  style={{ boxShadow: "inset 2px 0 0 0 color-mix(in oklch, var(--border) 70%, transparent)" }}
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center border border-border/60 bg-muted/50 overflow-hidden">
                    {firstSource ? (
                      <SourceFavicon
                        source={firstSource}
                        iconClassName="h-4 w-4 text-muted-foreground"
                        imageClassName="w-5 h-5"
                      />
                    ) : (
                      <KeyRound className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="mb-1 flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-medium">{connectionDisplayName(sources, connection)}</span>
                      <Badge variant="outline" className="text-[9px] font-mono uppercase tracking-wider">
                        {connection.scope}
                      </Badge>
                      <Badge variant="outline" className="text-[9px] font-mono uppercase tracking-wider">
                        {ownerScopeLabel(connection.scopeType)}
                      </Badge>
                      <Badge variant="outline" className="text-[9px] font-mono uppercase tracking-wider">
                        {providerLabel(connection.provider)}
                      </Badge>
                      {connection.scope === "account" && connection.accountId ? (
                        <span className="text-[10px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded-sm">
                          {connection.accountId}
                        </span>
                      ) : null}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Linked to {connection.sourceKeys.size} API{connection.sourceKeys.size === 1 ? "" : "s"} - {storageCopy}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      Updated {new Date(connection.updatedAt).toLocaleString()}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-[11px] border-border/70 group-hover:border-border"
                    onClick={() => onEditConnection(representative)}
                  >
                    Edit
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
