import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";

import { ExecutorApi } from "../api";
import { ExecutorService } from "../services";

export const ToolsHandlers = HttpApiBuilder.group(ExecutorApi, "tools", (handlers) =>
  handlers
    .handle("list", ({ path }) =>
      Effect.gen(function* () {
        const executor = yield* ExecutorService;
        const tools = yield* executor.tools.list();
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
    .handle("schema", ({ path }) =>
      Effect.gen(function* () {
        const executor = yield* ExecutorService;
        return yield* executor.tools.schema(path.toolId);
      }),
    ),
);
