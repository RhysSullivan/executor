import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";

export const SourcesHandlers = HttpApiBuilder.group(
  ExecutorApi,
  "sources",
  (handlers) =>
    handlers
      .handle("list", ({ path }) =>
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const sources = yield* executor.sources.list();
          return sources.map((s) => ({
            id: s.id,
            name: s.name,
            kind: s.kind,
            runtime: s.runtime,
            canRemove: s.canRemove,
            canRefresh: s.canRefresh,
            canEdit: s.canEdit,
          }));
        }),
      )
      .handle("remove", ({ path }) =>
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          yield* executor.sources.remove(path.sourceId);
          return { removed: true };
        }),
      )
      .handle("refresh", ({ path }) =>
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          yield* executor.sources.refresh(path.sourceId);
          return { refreshed: true };
        }),
      )
      .handle("tools", ({ path }) =>
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const tools = yield* executor.tools.list({ sourceId: path.sourceId });
          return tools.map((t) => ({
            id: t.id,
            pluginKey: t.pluginKey,
            sourceId: t.sourceId,
            name: t.name,
            description: t.description,
            mayElicit: t.mayElicit,
          }));
        }),
      )
      .handle("detect", ({ path, payload }) =>
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          const results = yield* executor.sources.detect(payload.url);
          return results.map((r) => ({
            kind: r.kind,
            confidence: r.confidence,
            endpoint: r.endpoint,
            name: r.name,
            namespace: r.namespace,
          }));
        }),
      )
      .handle("getConfig", ({ path }) =>
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          return yield* executor.sources.getConfig(path.sourceId);
        }),
      )
      .handle("update", ({ path, payload }) =>
        Effect.gen(function* () {
          const executor = yield* ExecutorService;
          yield* executor.sources.update(path.sourceId, payload as Record<string, unknown>);
          return { updated: true };
        }),
      ),
);
