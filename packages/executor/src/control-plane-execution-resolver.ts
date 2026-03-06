import {
  type Source,
  type SqlControlPlaneRuntime,
  type ResolveExecutionEnvironment,
} from "@executor-v3/control-plane";
import {
  createToolCatalogFromTools,
  createSystemToolMap,
  makeToolInvokerFromTools,
  mergeToolMaps,
} from "@executor-v3/codemode-core";
import { createSdkMcpConnector, discoverMcpToolsFromConnector } from "@executor-v3/codemode-mcp";
import { makeInProcessExecutor } from "@executor-v3/runtime-local-inproc";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const McpSourceConfigSchema = Schema.Struct({
  namespace: Schema.optional(Schema.String),
  transport: Schema.optional(Schema.Literal("auto", "streamable-http", "sse")),
  queryParams: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
}).pipe(Schema.partialWith({ exact: true }));

const decodeMcpSourceConfig = Schema.decodeUnknown(McpSourceConfigSchema);

const namespaceFromSourceName = (name: string): string => {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");

  return normalized.length > 0 ? normalized : "source";
};

const loadWorkspaceMcpTools = (input: {
  runtime: SqlControlPlaneRuntime;
  workspaceId: Parameters<SqlControlPlaneRuntime["persistence"]["rows"]["sources"]["listByWorkspaceId"]>[0];
}): Effect.Effect<
  {
    tools: ReturnType<typeof mergeToolMaps>;
    catalog: ReturnType<typeof createToolCatalogFromTools>;
  },
  Error,
  never
> =>
  Effect.gen(function* () {
    const sources: ReadonlyArray<Source> = yield* input.runtime.persistence.rows.sources
      .listByWorkspaceId(input.workspaceId)
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof Error ? cause : new Error(String(cause)),
        ),
      );

    const enabledMcpSources = sources.filter(
      (source) => source.enabled && source.kind === "mcp",
    );

    const discovered = yield* Effect.forEach(
      enabledMcpSources,
      (source: Source) =>
        Effect.gen(function* () {
          const rawConfig = yield* Effect.try({
            try: () => (source.configJson.length > 0 ? JSON.parse(source.configJson) : {}),
            catch: (cause) =>
              new Error(
                `Invalid JSON config for source ${source.id}: ${
                  cause instanceof Error ? cause.message : String(cause)
                }`,
              ),
          });

          const config = yield* decodeMcpSourceConfig(rawConfig).pipe(
            Effect.mapError(
              (cause) =>
                new Error(
                  `Invalid MCP source config for ${source.id}: ${
                    cause instanceof Error ? cause.message : String(cause)
                  }`,
                ),
            ),
          );

          const connector = yield* Effect.try({
            try: () =>
              createSdkMcpConnector({
                endpoint: source.endpoint,
                transport: config.transport,
                queryParams: config.queryParams,
                headers: config.headers,
              }),
            catch: (cause) =>
              new Error(
                `Failed creating MCP connector for ${source.id}: ${
                  cause instanceof Error ? cause.message : String(cause)
                }`,
              ),
          });

          return yield* discoverMcpToolsFromConnector({
            connect: connector,
            namespace: config.namespace ?? namespaceFromSourceName(source.name),
            sourceKey: source.id,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new Error(
                  `Failed discovering MCP tools for ${source.id}: ${
                    cause instanceof Error ? cause.message : String(cause)
                  }`,
                ),
            ),
          );
        }),
      { concurrency: "unbounded" },
    );

    const sourceTools = yield* Effect.try({
      try: () =>
        mergeToolMaps(discovered.map((item) => item.tools), {
          conflictMode: "throw",
        }),
      catch: (cause) =>
        new Error(
          `Failed merging discovered MCP tools: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        ),
    });
    const catalog = yield* Effect.try({
      try: () => createToolCatalogFromTools({ tools: sourceTools }),
      catch: (cause) =>
        new Error(
          `Failed creating tool catalog from MCP tools: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        ),
    });
    const allTools = yield* Effect.try({
      try: () =>
        mergeToolMaps([sourceTools, createSystemToolMap({ catalog })]),
      catch: (cause) =>
        new Error(
          `Failed creating MCP execution tool map: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        ),
    });

    return {
      tools: allTools,
      catalog,
    };
  });

export const makeControlPlaneExecutionResolver = (
  getRuntime: () => SqlControlPlaneRuntime | null,
): ResolveExecutionEnvironment =>
  (input) =>
    Effect.gen(function* () {
      const runtime = getRuntime();
      if (runtime === null) {
        return yield* Effect.fail(
          new Error("Control-plane runtime is not ready"),
        );
      }

      const loaded = yield* loadWorkspaceMcpTools({
        runtime,
        workspaceId: input.workspaceId,
      });

      return {
        executor: makeInProcessExecutor(),
        toolInvoker: makeToolInvokerFromTools({
          tools: loaded.tools,
          onElicitation: input.onElicitation,
        }),
        catalog: loaded.catalog,
      };
    });
