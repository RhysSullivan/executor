// Cloud-side handler layer. Replaces `CoreHandlers` from
// `@executor/api/server` with copies that call
// `assertScopeAccess(path.scopeId)` before touching the request-scoped
// executor. The check compares the decoded `ScopeId` from the URL
// against `AuthContext` — so a caller authenticated as orgB who hits
// `/scopes/orgA/...` gets a typed `ScopeForbidden` (403) before any
// business logic runs.
//
// Endpoints without a `scopeId` in their route (`/scope`, `/executions/...`)
// skip the check — the executor is already pinned to the session org.

import { Layer } from "effect";

import { ToolsHandlers } from "./tools";
import { SourcesHandlers } from "./sources";
import { SecretsHandlers } from "./secrets";
import { ConnectionsHandlers } from "./connections";
import { ScopeHandlers } from "./scope";
import { ExecutionsHandlers } from "./executions";

export const CloudCoreHandlers = Layer.mergeAll(
  ToolsHandlers,
  SourcesHandlers,
  SecretsHandlers,
  ConnectionsHandlers,
  ScopeHandlers,
  ExecutionsHandlers,
);
