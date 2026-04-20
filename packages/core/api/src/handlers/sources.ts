import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { ToolId } from "@executor/sdk";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";
import { capture } from "@executor/api";

export const SourcesHandlers = HttpApiBuilder.group(ExecutorApi, "sources", (handlers) =>
  handlers
    .handle("list", () =>
      capture(Effect.gen(function* () {
        const executor = yield* ExecutorService;
        const sources = yield* executor.sources.list();
        return sources.map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.kind,
          scopeId: s.scopeId,
          url: s.url,
          runtime: s.runtime,
          canRemove: s.canRemove,
          canRefresh: s.canRefresh,
          canEdit: s.canEdit,
        }));
      })),
    )
    .handle("remove", ({ path }) =>
      capture(Effect.gen(function* () {
        const executor = yield* ExecutorService;
        yield* executor.sources.remove(path.sourceId);
        return { removed: true };
      })),
    )
    .handle("refresh", ({ path }) =>
      capture(Effect.gen(function* () {
        const executor = yield* ExecutorService;
        yield* executor.sources.refresh(path.sourceId);
        return { refreshed: true };
      })),
    )
    .handle("tools", ({ path }) =>
      capture(Effect.gen(function* () {
        const executor = yield* ExecutorService;
        const tools = yield* executor.tools.list({ sourceId: path.sourceId });
        return tools.map((t) => ({
          id: ToolId.make(t.id),
          pluginId: t.pluginId,
          sourceId: t.sourceId,
          name: t.name,
          description: t.description,
          mayElicit: t.annotations?.mayElicit,
        }));
      })),
    )
    .handle("detect", ({ payload }) =>
      capture(Effect.gen(function* () {
        const executor = yield* ExecutorService;
        const results = yield* executor.sources.detect(payload.url);
        return results.map((r) => ({
          kind: r.kind,
          confidence: r.confidence,
          endpoint: r.endpoint,
          name: r.name,
          namespace: r.namespace,
        }));
      })),
    ),
);
