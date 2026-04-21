import { HttpApiBuilder } from "@effect/platform";
import { Effect } from "effect";
import { ToolId, ToolNotFoundError } from "@executor/sdk";

import { capture } from "@executor/api";
import { ExecutorService } from "@executor/api/server";

import { assertScopeAccess } from "../../auth/scope-access";
import { ProtectedCloudApi } from "../api";

export const ToolsHandlers = HttpApiBuilder.group(ProtectedCloudApi, "tools", (handlers) =>
  handlers
    .handle("list", ({ path }) =>
      Effect.gen(function* () {
        yield* assertScopeAccess(path.scopeId);
        return yield* capture(
          Effect.gen(function* () {
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
          }),
        );
      }),
    )
    .handle("schema", ({ path }) =>
      Effect.gen(function* () {
        yield* assertScopeAccess(path.scopeId);
        return yield* capture(
          Effect.gen(function* () {
            const executor = yield* ExecutorService;
            const schema = yield* executor.tools.schema(path.toolId);
            if (schema === null) {
              return yield* Effect.fail(new ToolNotFoundError({ toolId: path.toolId }));
            }
            return schema;
          }),
        );
      }),
    ),
);
