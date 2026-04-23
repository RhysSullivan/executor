import { Result, useAtomValue } from "@effect-atom/atom-react";

import { connectionsAtom, sourceAtom } from "@executor/react/api/atoms";
import { Badge } from "@executor/react/components/badge";
import { Button } from "@executor/react/components/button";
import { useScope, useScopeStack } from "@executor/react/api/scope-context";
import { ScopeId } from "@executor/sdk";

import { openApiSourceAtom, openApiSourceBindingsAtom } from "./atoms";
import { oauth2ClientSecretSlot } from "../sdk/store";
import type { OpenApiSourceBindingValue } from "../sdk/types";

type BindingRow = {
  readonly slot: string;
  readonly scopeId: ScopeId;
  readonly value: OpenApiSourceBindingValue;
};

type SourceForStatus = {
  readonly config: {
    readonly headers?: Record<string, string | { readonly slot: string; readonly prefix?: string }>;
    readonly oauth2?: {
      readonly securitySchemeName: string;
      readonly flow: "authorizationCode" | "clientCredentials";
      readonly clientIdSlot: string;
      readonly clientSecretSlot: string | null;
      readonly connectionSlot: string;
    };
  };
};

const scopeRank = (ranks: ReadonlyMap<string, number>, scopeId: ScopeId): number =>
  ranks.get(scopeId as string) ?? Number.MAX_SAFE_INTEGER;

const effectiveBindingForScope = (
  rows: readonly BindingRow[],
  slot: string,
  targetScope: ScopeId,
  ranks: ReadonlyMap<string, number>,
) =>
  rows.find(
    (row) =>
      row.slot === slot &&
      scopeRank(ranks, row.scopeId) >= scopeRank(ranks, targetScope),
  ) ?? null;

const hasSecretBinding = (
  rows: readonly BindingRow[],
  slot: string,
  targetScope: ScopeId,
  ranks: ReadonlyMap<string, number>,
) => effectiveBindingForScope(rows, slot, targetScope, ranks)?.value.kind === "secret";

const hasConnectionBinding = (
  rows: readonly BindingRow[],
  slot: string,
  targetScope: ScopeId,
  ranks: ReadonlyMap<string, number>,
) => effectiveBindingForScope(rows, slot, targetScope, ranks)?.value.kind === "connection";

const effectiveClientSecretSlot = (oauth2: {
  readonly securitySchemeName: string;
  readonly clientSecretSlot: string | null;
}): string => oauth2.clientSecretSlot ?? oauth2ClientSecretSlot(oauth2.securitySchemeName);

function missingCredentialLabels(
  source: SourceForStatus,
  bindings: readonly BindingRow[],
  targetScope: ScopeId,
  ranks: ReadonlyMap<string, number>,
): string[] {
  const missing: string[] = [];

  for (const [headerName, value] of Object.entries(source.config.headers ?? {})) {
    if (typeof value === "string") continue;
    if (!hasSecretBinding(bindings, value.slot, targetScope, ranks)) {
      missing.push(headerName);
    }
  }

  const oauth2 = source.config.oauth2;
  if (!oauth2) return missing;

  if (!hasSecretBinding(bindings, oauth2.clientIdSlot, targetScope, ranks)) {
    missing.push("Client ID");
  }

  const clientSecretSlot = effectiveClientSecretSlot(oauth2);
  if (!hasSecretBinding(bindings, clientSecretSlot, targetScope, ranks)) {
    missing.push("Client Secret");
  }

  if (!hasConnectionBinding(bindings, oauth2.connectionSlot, targetScope, ranks)) {
    missing.push(
      oauth2.flow === "clientCredentials" ? "OAuth client connection" : "OAuth sign-in",
    );
  }

  return missing;
}

function ConnectedBadge() {
  return (
    <Badge
      variant="outline"
      className="border-green-500/30 bg-green-500/5 text-[10px] text-green-700 dark:text-green-400"
    >
      Connected
    </Badge>
  );
}

function OAuthBadge() {
  return <Badge variant="secondary">OAuth</Badge>;
}

function NeedsCredentialsBadge() {
  return (
    <Badge
      variant="outline"
      className="border-amber-500/40 bg-amber-500/10 text-[10px] text-amber-700 dark:text-amber-300"
    >
      Needs credentials
    </Badge>
  );
}

function CheckingCredentialsBadge() {
  return (
    <Badge
      variant="outline"
      className="border-border bg-muted/50 text-[10px] text-muted-foreground"
    >
      Checking credentials
    </Badge>
  );
}

// The entry row already renders name + id + kind, so this summary
// component only contributes extras — specifically, an OAuth status
// badge when the source has OAuth2 configured. Non-OAuth sources
// render nothing.
export default function OpenApiSourceSummary(props: {
  sourceId: string;
  variant?: "badge" | "panel";
  onAction?: () => void;
}) {
  const displayScope = useScope();
  const scopeStack = useScopeStack();
  const summaryResult = useAtomValue(sourceAtom(props.sourceId, displayScope));
  const sourceScopeId =
    Result.isSuccess(summaryResult) && summaryResult.value?.scopeId
      ? summaryResult.value.scopeId
      : displayScope;
  const sourceResult = useAtomValue(
    openApiSourceAtom(ScopeId.make(sourceScopeId), props.sourceId),
  );
  const bindingsResult = useAtomValue(
    openApiSourceBindingsAtom(displayScope, props.sourceId, ScopeId.make(sourceScopeId)),
  );
  const connectionsResult = useAtomValue(connectionsAtom(displayScope));

  const source =
    Result.isSuccess(sourceResult) && sourceResult.value
      ? sourceResult.value
      : null;

  if (!source) return null;
  const oauth2 = source.config.oauth2;
  const bindingsLoaded = Result.isSuccess(bindingsResult);
  const connectionsLoaded = Result.isSuccess(connectionsResult);
  if (!bindingsLoaded) {
    return props.variant === "panel" ? null : <CheckingCredentialsBadge />;
  }

  const bindings = Result.isSuccess(bindingsResult) ? bindingsResult.value : [];
  const scopeRanks = new Map(
    scopeStack.map((scope, index) => [scope.id as string, index] as const),
  );
  const missing = missingCredentialLabels(
    source,
    bindings,
    ScopeId.make(displayScope),
    scopeRanks,
  );

  if (props.variant === "panel") {
    if (missing.length === 0) return null;
    return (
      <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/[0.06] px-4 py-3">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">
              This source needs your credentials before tools can run.
            </div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              Missing: {missing.join(", ")}
            </div>
          </div>
          {props.onAction && (
            <Button size="sm" onClick={props.onAction}>
              Add credentials
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (missing.length > 0) return <NeedsCredentialsBadge />;

  if (!oauth2) return null;
  if (!connectionsLoaded) return <CheckingCredentialsBadge />;
  const connections = connectionsResult.value;
  const connectionBinding = bindings.find(
    (binding) =>
      binding.slot === oauth2.connectionSlot &&
      binding.value.kind === "connection",
  );
  const connectionId =
    connectionBinding?.value.kind === "connection"
      ? connectionBinding.value.connectionId
      : null;

  if (
    connectionId &&
    connections.some((connection) => connection.id === connectionId)
  ) {
    return <ConnectedBadge />;
  }

  return <OAuthBadge />;
}
