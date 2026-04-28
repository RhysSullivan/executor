import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { ToolId, ToolNotFoundError } from "@executor/sdk";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";
import { capture } from "@executor/api";

export const ToolsHandlers = HttpApiBuilder.group(ExecutorApi, "tools", (handlers) =>
  handlers
    .handle("list", () =>
      capture(Effect.gen(function* () {
        const executor = yield* ExecutorService;
        const tools = yield* executor.tools.list();
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
    .handle("schema", ({ path }) =>
      capture(Effect.gen(function* () {
        const executor = yield* ExecutorService;
        const schema = yield* executor.tools.schema(path.toolId);
        if (schema === null) {
          return yield* Effect.fail(new ToolNotFoundError({ toolId: path.toolId }));
        }
        return schema;
      })),
    ),
);
