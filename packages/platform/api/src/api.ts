import { HttpApi, OpenApi } from "@effect/platform";

import { ExecutionsApi } from "./executions/api";
import { LocalApi } from "./local/api";
import { OAuthApi } from "./oauth/api";
import { PoliciesApi } from "./policies/api";
import { SourcesApi } from "./sources/api";

export class ExecutorApi extends HttpApi.make("executor")
  .add(LocalApi)
  .add(OAuthApi)
  .add(SourcesApi)
  .add(PoliciesApi)
  .add(ExecutionsApi)
  .annotateContext(
    OpenApi.annotations({
      title: "Executor API",
      description: "Local-first API for workspace sources, policies, auth, and execution",
    }),
  ) {}

export const executorOpenApiSpec = OpenApi.fromApi(ExecutorApi);
