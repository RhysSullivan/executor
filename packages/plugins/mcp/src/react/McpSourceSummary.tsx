import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { IntegrationSlug, type Connection } from "@executor-js/sdk/shared";
import { connectionsAllAtom } from "@executor-js/react/api/atoms";
import { Button } from "@executor-js/react/components/button";
import { IntegrationCredentialNotice } from "@executor-js/react/plugins/integration-credential-status";

import { mcpServerAtom } from "./atoms";
import McpSignInButton from "./McpSignInButton";

// ---------------------------------------------------------------------------
// McpSourceSummary (v2) — surfaces whether ANY owner has a connection for this
// MCP integration. A connection IS the credential, so "missing" means no
// connection exists under either owner (the global owner toggle is retired, so
// the OAuth-needed notice shows only when NEITHER owner is connected). Servers
// whose auth template is `none` need no credential and render nothing.
//
// The "badge" variant only contributed a status badge (credentials ready /
// needed), which is retired; only the actionable panel Notice remains.
// ---------------------------------------------------------------------------

export default function McpSourceSummary(props: {
  readonly sourceId: string;
  readonly variant?: "badge" | "panel";
  readonly onAction?: () => void;
}) {
  const slug = IntegrationSlug.make(props.sourceId);
  const serverResult = useAtomValue(mcpServerAtom(slug));
  const connectionsResult = useAtomValue(connectionsAllAtom);

  const server = AsyncResult.isSuccess(serverResult) ? serverResult.value : null;
  if (server === null) return null;

  const remote = server.config.transport === "remote" ? server.config : null;
  // Open servers (or stdio) need no credential.
  if (remote === null || remote.auth.kind === "none") return null;

  if (props.variant !== "panel") return null;
  if (!AsyncResult.isSuccess(connectionsResult)) return null;

  const hasConnection = connectionsResult.value.some(
    (connection: Connection) => connection.integration === slug,
  );
  const missing = hasConnection
    ? []
    : [remote.auth.kind === "oauth2" ? "OAuth sign-in" : "API key"];

  const needsOAuth = remote.auth.kind === "oauth2" && !hasConnection;
  const needsConfiguration = remote.auth.kind === "header" && !hasConnection;
  return (
    <IntegrationCredentialNotice
      missing={missing}
      action={
        <div className="flex shrink-0 items-center gap-2">
          {needsOAuth && <McpSignInButton sourceId={props.sourceId} />}
          {needsConfiguration && props.onAction && (
            <Button type="button" size="sm" variant="outline" onClick={props.onAction}>
              Configure
            </Button>
          )}
        </div>
      }
    />
  );
}
