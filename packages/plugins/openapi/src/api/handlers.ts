import { HttpApiBuilder } from "@effect/platform";
import { Context, Effect } from "effect";

import { addGroup } from "@executor/api";
import type { OpenApiPluginExtension } from "../sdk/plugin";
import { OpenApiGroup } from "./group";

// ---------------------------------------------------------------------------
// Service tag — the server provides the OpenAPI extension
// ---------------------------------------------------------------------------

export class OpenApiExtensionService extends Context.Tag(
  "OpenApiExtensionService",
)<OpenApiExtensionService, OpenApiPluginExtension>() {}

// ---------------------------------------------------------------------------
// Composed API — core + openapi group
// ---------------------------------------------------------------------------

const ExecutorApiWithOpenApi = addGroup(OpenApiGroup);

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const OpenApiHandlers = HttpApiBuilder.group(
  ExecutorApiWithOpenApi,
  "openapi",
  (handlers) =>
    handlers
      .handle("previewSpec", ({ payload }) =>
        Effect.gen(function* () {
          const ext = yield* OpenApiExtensionService;
          return yield* ext.previewSpec(payload.spec);
        }).pipe(Effect.orDie),
      )
      .handle("addSpec", ({ payload }) =>
        Effect.gen(function* () {
          const ext = yield* OpenApiExtensionService;
          const result = yield* ext.addSpec({
            spec: payload.spec,
            baseUrl: payload.baseUrl,
            namespace: payload.namespace,
            headers: payload.headers as Record<string, string> | undefined,
          });
          return {
            toolCount: result.toolCount,
            namespace: payload.namespace ?? "api",
          };
        }).pipe(Effect.orDie),
      )
      ,
);
