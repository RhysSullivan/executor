import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import type { McpConnection, McpConnector } from "./tools";

export class McpConnectionPoolError extends Data.TaggedError("McpConnectionPoolError")<{
  readonly operation: "connect" | "close";
  readonly message: string;
  readonly cause: unknown;
}> {}

type PoolEntry = {
  scope: Scope.CloseableScope;
  connection: McpConnector;
};

const pooledRuns = new Map<string, Map<string, PoolEntry>>();

const mcpConnectionPoolError = (input: {
  operation: "connect" | "close";
  message: string;
  cause: unknown;
}): McpConnectionPoolError => new McpConnectionPoolError(input);

const deletePoolEntry = (runId: string, sourceKey: string, entry: PoolEntry) => {
  const runEntries = pooledRuns.get(runId);
  if (!runEntries || runEntries.get(sourceKey) !== entry) {
    return;
  }

  runEntries.delete(sourceKey);
  if (runEntries.size === 0) {
    pooledRuns.delete(runId);
  }
};

const closePooledConnection = (
  connection: McpConnection,
): Effect.Effect<void, never, never> =>
  Effect.tryPromise({
    try: () => Promise.resolve(connection.close?.()),
    catch: (cause) =>
      mcpConnectionPoolError({
        operation: "close",
        message: "Failed closing pooled MCP connection",
        cause,
      }),
  }).pipe(Effect.ignore);

const createPoolEntry = (connect: McpConnector): PoolEntry => {
  const scope = Effect.runSync(Scope.make());
  const connection = Effect.runSync(
    Effect.cached(
      Effect.acquireRelease(
        connect.pipe(
          Effect.mapError((cause) =>
            mcpConnectionPoolError({
              operation: "connect",
              message: "Failed creating pooled MCP connection",
              cause,
            })),
        ),
        closePooledConnection,
      ).pipe(Scope.extend(scope)),
    ),
  );

  return {
    scope,
    connection,
  };
};

const getOrCreatePoolEntry = (input: {
  runId: string;
  sourceKey: string;
  connect: McpConnector;
}): PoolEntry => {
  const existing = pooledRuns.get(input.runId)?.get(input.sourceKey);
  if (existing) {
    return existing;
  }

  let runEntries = pooledRuns.get(input.runId);
  if (!runEntries) {
    runEntries = new Map<string, PoolEntry>();
    pooledRuns.set(input.runId, runEntries);
  }

  const entry = createPoolEntry(input.connect);
  entry.connection = entry.connection.pipe(
    Effect.tapError(() =>
      Effect.sync(() => {
        deletePoolEntry(input.runId, input.sourceKey, entry);
      }).pipe(
        Effect.zipRight(closePoolEntry(entry)),
      )),
  );
  runEntries.set(input.sourceKey, entry);
  return entry;
};

const closePoolEntry = (entry: PoolEntry): Effect.Effect<void, never, never> =>
  Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);

export const createPooledMcpConnector = (input: {
  connect: McpConnector;
  runId?: string;
  sourceKey?: string;
}): McpConnector => {
  if (!input.runId || !input.sourceKey) {
    return input.connect;
  }

  return Effect.gen(function* () {
    const entry = getOrCreatePoolEntry({
      runId: input.runId!,
      sourceKey: input.sourceKey!,
      connect: input.connect,
    });
    const connection = yield* entry.connection;
    return {
      client: connection.client,
      close: async () => undefined,
    };
  });
};

export const clearMcpConnectionPoolRun = (
  runId: string,
): Effect.Effect<void, never, never> => {
  const runEntries = pooledRuns.get(runId);
  if (!runEntries) {
    return Effect.void;
  }

  pooledRuns.delete(runId);
  return Effect.forEach([...runEntries.values()], closePoolEntry, {
    discard: true,
  });
};

export const clearAllMcpConnectionPools = (): Effect.Effect<void, never, never> => {
  const runEntries = [...pooledRuns.values()].flatMap((entries) => [...entries.values()]);
  pooledRuns.clear();
  return Effect.forEach(runEntries, closePoolEntry, {
    discard: true,
  });
};
