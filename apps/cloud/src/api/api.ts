// Cloud-side `HttpApi` definition. Pulled out of `layers.ts` /
// `protected-layers.ts` so handler files can reference it without
// creating a cycle (handlers → layers → handlers).

import { CoreExecutorApi, InternalError } from "@executor/api";
import { OpenApiGroup } from "@executor/plugin-openapi/api";
import { McpGroup } from "@executor/plugin-mcp/api";
import { GraphqlGroup } from "@executor/plugin-graphql/api";

import { OrgAuth, ScopeForbidden } from "../auth/middleware";

export const ProtectedCloudApi = CoreExecutorApi.add(OpenApiGroup)
  .add(McpGroup)
  .add(GraphqlGroup)
  .addError(InternalError)
  .addError(ScopeForbidden)
  .middleware(OrgAuth);
