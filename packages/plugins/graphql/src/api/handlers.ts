import { HttpApiBuilder } from "@effect/platform";
import { Context, Effect } from "effect";

import { addGroup, capture } from "@executor/api";
import type {
  GraphqlPluginExtension,
  HeaderValue,
  GraphqlUpdateSourceInput,
} from "../sdk/plugin";
import { GraphqlGroup } from "./group";

// ---------------------------------------------------------------------------
// Service tag
//
// Holds the `Captured` shape — every method's `StorageError` channel has
// been swapped for `InternalError({ traceId })`. The host app provides an
// already-wrapped extension via
// `Layer.succeed(GraphqlExtensionService, withCapture(executor.graphql))`.
// Handlers see `InternalError` in the error union, which matches
// `.addError(InternalError)` on the group — no per-handler translation.
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
//
// Each handler is exactly: yield the extension service, call the method,
// return. Plugin SDK errors flow through the typed channel and are
// schema-encoded to 4xx by HttpApi (see group.ts `.addError(...)` calls).
// Defects bubble up and are captured + downgraded to `InternalError(traceId)`
// by the API-level observability middleware.
// ---------------------------------------------------------------------------

export const GraphqlHandlers = HttpApiBuilder.group(ExecutorApiWithGraphql, "graphql", (handlers) =>
  handlers
    .handle("addSource", ({ path, payload }) =>
      capture(Effect.gen(function* () {
        const ext = yield* GraphqlExtensionService;
        const result = yield* ext.addSource({
          endpoint: payload.endpoint,
          scope: path.scopeId,
          name: payload.name,
          introspectionJson: payload.introspectionJson,
          namespace: payload.namespace,
          headers: payload.headers as Record<string, HeaderValue> | undefined,
        });
        return {
          toolCount: result.toolCount,
          namespace: result.namespace,
        };
      })),
    )
    .handle("getSource", ({ path }) =>
      capture(Effect.gen(function* () {
        const ext = yield* GraphqlExtensionService;
        return yield* ext.getSource(path.namespace, path.scopeId);
      })),
    )
    .handle("updateSource", ({ path, payload }) =>
      capture(Effect.gen(function* () {
        const ext = yield* GraphqlExtensionService;
        yield* ext.updateSource(path.namespace, path.scopeId, {
          name: payload.name,
          endpoint: payload.endpoint,
          headers: payload.headers as Record<string, HeaderValue> | undefined,
        } as GraphqlUpdateSourceInput);
        return { updated: true };
      })),
    ),
);
