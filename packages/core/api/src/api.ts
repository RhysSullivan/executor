import { HttpApi, OpenApi } from "@effect/platform";
import type { HttpApiGroup } from "@effect/platform";

import { ToolsApi } from "./tools/api";
import { SourcesApi } from "./sources/api";
import { SecretsApi } from "./secrets/api";
import { ExecutionsApi } from "./executions/api";
import { ScopeApi } from "./scope/api";
import { PoliciesApi } from "./policies/api";

export const CoreExecutorApi = HttpApi.make("executor")
  .add(ToolsApi)
  .add(SourcesApi)
  .add(SecretsApi)
  .add(PoliciesApi)
  .add(ExecutionsApi)
  .add(ScopeApi)
  .annotateContext(
    OpenApi.annotations({
      title: "Executor API",
      description: "Tool execution platform API",
    }),
  );

/**
 * Compose the core API with a plugin group.
 */
export const addGroup = <G extends HttpApiGroup.HttpApiGroup.Any>(group: G) =>
  CoreExecutorApi.add(group);

/** Default API with no plugin groups */
export const ExecutorApi = CoreExecutorApi;
