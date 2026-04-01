import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";

import { ExecutorApi } from "@executor/api";
import { ExecutorService } from "../services/executor";

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
      ),
);
