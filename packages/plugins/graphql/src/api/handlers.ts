import { HttpApiBuilder } from "@effect/platform";
import { Context, Effect } from "effect";

import { addGroup } from "@executor/api";
import type { GraphqlPluginExtension, HeaderValue, GraphqlUpdateSourceInput } from "../sdk/plugin";
import { GraphqlGroup } from "./group";

// ---------------------------------------------------------------------------
// Service tag — the server provides the GraphQL extension
// ---------------------------------------------------------------------------

export class GraphqlExtensionService extends Context.Tag("GraphqlExtensionService")<
  GraphqlExtensionService,
  GraphqlPluginExtension
>() {}

// ---------------------------------------------------------------------------
// Composed API — core + graphql group
// ---------------------------------------------------------------------------

const ExecutorApiWithGraphql = addGroup(GraphqlGroup);

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const GraphqlHandlers = HttpApiBuilder.group(ExecutorApiWithGraphql, "graphql", (handlers) =>
  handlers
    .handle("addSource", ({ payload }) =>
      Effect.gen(function* () {
        const ext = yield* GraphqlExtensionService;
        const result = yield* ext.addSource({
          endpoint: payload.endpoint,
          introspectionJson: payload.introspectionJson,
          namespace: payload.namespace,
          headers: payload.headers as Record<string, HeaderValue> | undefined,
        });
        return {
          toolCount: result.toolCount,
          namespace: payload.namespace ?? "graphql",
        };
      }).pipe(Effect.orDie),
    )
    .handle("getSource", ({ path }) =>
      Effect.gen(function* () {
        const ext = yield* GraphqlExtensionService;
        return yield* ext.getSource(path.namespace);
      }).pipe(Effect.orDie),
    )
    .handle("updateSource", ({ path, payload }) =>
      Effect.gen(function* () {
        const ext = yield* GraphqlExtensionService;
        yield* ext.updateSource(path.namespace, {
          endpoint: payload.endpoint,
          headers: payload.headers as Record<string, HeaderValue> | undefined,
        } as GraphqlUpdateSourceInput);
        return { updated: true };
      }).pipe(Effect.orDie),
    ),
);
