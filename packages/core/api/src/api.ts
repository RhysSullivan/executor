import { HttpApi, OpenApi } from "effect/unstable/httpapi";
import type { HttpApiGroup } from "effect/unstable/httpapi";

import { ToolsApi } from "./tools/api";
import { SourcesApi } from "./sources/api";
import { SecretsApi } from "./secrets/api";
import { ConnectionsApi } from "./connections/api";
import { ExecutionsApi } from "./executions/api";
import { ScopeApi } from "./scope/api";
import { OAuthApi } from "./oauth/api";
import { PoliciesApi } from "./policies/api";

export const CoreExecutorApi = HttpApi.make("executor")
  .add(ToolsApi)
  .add(SourcesApi)
  .add(SecretsApi)
  .add(ConnectionsApi)
  .add(ExecutionsApi)
  .add(ScopeApi)
  .add(OAuthApi)
  .add(PoliciesApi)
  .annotateMerge(
    OpenApi.annotations({
      title: "Executor API",
      description: "Tool execution platform API",
    }),
  );

/**
 * Compose the core API with a plugin group.
 */
export const addGroup = <G extends HttpApiGroup.Any>(group: G) => CoreExecutorApi.add(group);

/** Default API with no plugin groups */
export const ExecutorApi = CoreExecutorApi;
