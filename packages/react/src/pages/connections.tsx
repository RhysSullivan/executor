import { useAtomSet, Result } from "@effect-atom/atom-react";
import { ConnectionId } from "@executor/sdk";

import { removeConnection } from "../api/atoms";
import {
  useConnectionsWithPendingRemovals,
  usePendingConnectionRemovals,
} from "../api/optimistic";
import { connectionWriteKeys } from "../api/reactivity-keys";
import { useScope, useScopeStack } from "../hooks/use-scope";
import { Badge } from "../components/badge";
import { Button } from "../components/button";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/dropdown-menu";

// ---------------------------------------------------------------------------
// Provider display
// ---------------------------------------------------------------------------

// Friendly labels for the internal provider keys minted by plugins.
// Falls through to the raw key so new providers still render something.
const providerDisplayNames: Record<string, string> = {
  "mcp:oauth2": "MCP",
  "openapi:oauth2": "OpenAPI",
  "google-discovery:oauth2": "Google",
};

const displayProvider = (provider: string): string =>
  providerDisplayNames[provider] ?? provider;

const connectionScopeLabel = (
  scopeId: string,
  stack: readonly { readonly id: string; readonly name: string }[],
) => {
  const index = stack.findIndex((entry) => entry.id === scopeId);
  if (index === 0) return "Personal";
  if (index > 0) return stack[index]?.name ?? "Shared";
  return "Scoped";
};

// ---------------------------------------------------------------------------
// Connection row
// ---------------------------------------------------------------------------

function ConnectionRow(props: {
  connection: {
    id: string;
    scopeId: string;
    provider: string;
    identityLabel: string | null;
  };
  scopeStack: readonly { readonly id: string; readonly name: string }[];
  onRemove: () => void;
}) {
  const { connection } = props;
  const scopeLabel = connectionScopeLabel(connection.scopeId, props.scopeStack);
  const displayLabel =
    connection.identityLabel && connection.identityLabel.length > 0
      ? connection.identityLabel
      : connection.id;

  return (
    <CardStackEntry>
      <CardStackEntryContent>
        <CardStackEntryTitle className="flex items-center gap-2">
          <span className="truncate">{displayLabel}</span>
        </CardStackEntryTitle>
        <CardStackEntryDescription className="text-xs text-muted-foreground">
          {displayProvider(connection.provider)}
        </CardStackEntryDescription>
      </CardStackEntryContent>
      <CardStackEntryActions>
        <Badge variant="outline">{scopeLabel}</Badge>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 opacity-0 transition-opacity group-hover/card-stack-entry:opacity-100 group-focus-within/card-stack-entry:opacity-100 data-[state=open]:opacity-100"
            >
              <svg viewBox="0 0 16 16" className="size-3">
                <circle cx="8" cy="3" r="1.2" fill="currentColor" />
                <circle cx="8" cy="8" r="1.2" fill="currentColor" />
                <circle cx="8" cy="13" r="1.2" fill="currentColor" />
              </svg>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem
              className="text-destructive focus:text-destructive text-sm"
              onClick={props.onRemove}
            >
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardStackEntryActions>
    </CardStackEntry>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ConnectionsPage() {
  const scopeId = useScope();
  const scopeStack = useScopeStack();
  const connections = useConnectionsWithPendingRemovals(scopeId);
  const { beginRemove } = usePendingConnectionRemovals();
  const doRemove = useAtomSet(removeConnection, { mode: "promise" });

  const handleRemove = async (connectionId: string) => {
    const pending = beginRemove(connectionId);
    try {
      await doRemove({
        path: { scopeId, connectionId: ConnectionId.make(connectionId) },
        reactivityKeys: connectionWriteKeys,
      });
    } catch {
      pending.undo();
      // TODO: toast
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-10 lg:px-8 lg:py-14">
        <div className="flex items-end justify-between mb-10">
          <div>
            <h1 className="font-display text-[2rem] tracking-tight text-foreground leading-none">
              Connections
            </h1>
            <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
              Signed-in accounts your sources use to call their APIs.
              Remove a connection to revoke access and drop its tokens.
            </p>
          </div>
        </div>

        {Result.match(connections, {
          onInitial: () => (
            <div className="flex items-center gap-2 py-8">
              <div className="size-1.5 rounded-full bg-muted-foreground/30 animate-pulse" />
              <p className="text-sm text-muted-foreground">
                Loading connections…
              </p>
            </div>
          ),
          onFailure: () => (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
              <p className="text-sm text-destructive">
                Failed to load connections
              </p>
            </div>
          ),
          onSuccess: ({ value }) => (
            <CardStack>
              <CardStackHeader>Connections</CardStackHeader>
              <CardStackContent>
                {value.length === 0 ? (
                  <CardStackEntry>
                    <CardStackEntryContent>
                      <CardStackEntryDescription>
                        No signed-in accounts yet. Add an OAuth source and
                        its sign-in will appear here.
                      </CardStackEntryDescription>
                    </CardStackEntryContent>
                  </CardStackEntry>
                ) : (
                  value.map((c) => (
                    <ConnectionRow
                      key={c.id}
                      connection={{
                        id: c.id,
                        scopeId: c.scopeId,
                        provider: c.provider,
                        identityLabel: c.identityLabel,
                      }}
                      scopeStack={scopeStack}
                      onRemove={() => handleRemove(c.id)}
                    />
                  ))
                )}
              </CardStackContent>
            </CardStack>
          ),
        })}
      </div>
    </div>
  );
}
