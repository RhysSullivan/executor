import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Context, Effect } from "effect";

import { addGroup, capture } from "@executor-js/api";
import type { GraphqlPluginExtension } from "../sdk/plugin";
import { GraphqlGroup } from "./group";

// ---------------------------------------------------------------------------
// Service tag
//
// Holds the `Captured` shape — every method's `StorageFailure` channel has
// been swapped for `InternalError({ traceId })`. The host app provides an
// already-wrapped extension via
// `Layer.succeed(GraphqlExtensionService, withCapture(executor["graphql-greenfield"]))`.
// ---------------------------------------------------------------------------

export class GraphqlExtensionService extends Context.Service<
  GraphqlExtensionService,
  GraphqlPluginExtension
>()("GraphqlGreenfieldExtensionService") {}

// ---------------------------------------------------------------------------
// Composed API — core + graphql group
// ---------------------------------------------------------------------------

const ExecutorApiWithGraphql = addGroup(GraphqlGroup);

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const GraphqlHandlers = HttpApiBuilder.group(
  ExecutorApiWithGraphql,
  "graphql-greenfield",
  (handlers) =>
    handlers
      .handle("addIntegration", ({ payload }) =>
        capture(
          Effect.gen(function* () {
            const ext = yield* GraphqlExtensionService;
            const result = yield* ext.addIntegration({
              slug: payload.slug,
              endpoint: payload.endpoint,
              description: payload.description,
              introspectionJson: payload.introspectionJson,
              authentication: payload.authentication,
              introspectionHeaders: payload.introspectionHeaders,
            });
            return { slug: result.slug, toolCount: result.toolCount };
          }),
        ),
      )
      .handle("getIntegration", ({ params: path }) =>
        capture(
          Effect.gen(function* () {
            const ext = yield* GraphqlExtensionService;
            const integration = yield* ext.getIntegration(path.slug);
            if (integration === null) return null;
            return {
              slug: String(integration.slug),
              description: integration.description,
              kind: integration.kind,
              canRemove: integration.canRemove,
              canRefresh: integration.canRefresh,
              config: integration.config,
            };
          }),
        ),
      ),
);
