import { Result, useAtomValue } from "@effect-atom/atom-react";

import { connectionsAtom, sourceAtom } from "@executor/react/api/atoms";
import { Badge } from "@executor/react/components/badge";
import { Button } from "@executor/react/components/button";
import { useScope, useScopeStack, useUserScope } from "@executor/react/api/scope-context";
import { ScopeId } from "@executor/sdk";

import { openApiSourceAtom, openApiSourceBindingsAtom } from "./atoms";
import {
  effectiveBindingForScope,
  missingCredentialLabels,
} from "../sdk/credential-status";

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
  const userScope = useUserScope();
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
  const credentialTargetScope = userScope;
  const missing = missingCredentialLabels(
    source,
    bindings,
    credentialTargetScope,
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
  const connectionBinding = effectiveBindingForScope(
    bindings,
    oauth2.connectionSlot,
    credentialTargetScope,
    scopeRanks,
  );
  const connectionId =
    connectionBinding && connectionBinding.value.kind === "connection"
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
