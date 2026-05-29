import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Schema } from "effect";

import { createExecutor } from "./executor";
import { StorageError } from "./fuma-runtime";
import { ScopeId } from "./ids";
import { definePlugin } from "./plugin";
import {
  definePluginStorageCollection,
  type PluginStorageCollectionFacade,
  type PluginStorageCollectionQueryInput,
  type PluginStorageCollectionWhere,
} from "./plugin-storage";
import { Scope } from "./scope";
import { makeTestConfig, makeTestExecutor } from "./testing";

const ToolCall = Schema.Struct({
  runId: Schema.String,
  toolId: Schema.String,
  userId: Schema.NullOr(Schema.String),
  clientName: Schema.NullOr(Schema.String),
  status: Schema.Literals(["ok", "failed", "blocked"]),
  startedAt: Schema.String,
  durationMs: Schema.Number,
});

const toolCalls = definePluginStorageCollection("toolCalls", ToolCall, {
  indexes: ["runId", "toolId", "status", "clientName", "startedAt", ["toolId", "startedAt"]],
});

type ToolCall = typeof ToolCall.Type;

const assertPluginStorageTypes = (storage: PluginStorageCollectionFacade<typeof toolCalls>) => {
  const validQuery = storage.query({ where: { toolId: "shell" } });

  // @ts-expect-error durationMs is part of the data shape but is not declared as an index.
  const invalidWhereQuery = storage.query({ where: { durationMs: 100 } });

  // @ts-expect-error orderBy is also restricted to declared index fields.
  const invalidOrderQuery = storage.query({ orderBy: [{ field: "durationMs" }] });

  // @ts-expect-error indexes must point at fields in the collection schema.
  definePluginStorageCollection("bad", ToolCall, { indexes: ["missing"] });

  void validQuery;
  void invalidWhereQuery;
  void invalidOrderQuery;
};
void assertPluginStorageTypes;

const uncheckedToolCallWhere = (
  where: Readonly<Record<string, unknown>>,
): PluginStorageCollectionWhere<typeof toolCalls> =>
  where as PluginStorageCollectionWhere<typeof toolCalls>;

const executionHistoryPlugin = definePlugin(() => ({
  id: "executionHistory" as const,
  pluginStorage: { toolCalls },
  storage: ({ pluginStorage }) => ({
    toolCalls: pluginStorage.collection(toolCalls),
  }),
  extension: (ctx) => ({
    record: (scope: string, key: string, data: ToolCall) =>
      ctx.storage.toolCalls.put({ scope, key, data }),
    get: (key: string) => ctx.storage.toolCalls.get({ key }),
    query: (input?: PluginStorageCollectionQueryInput<typeof toolCalls>) =>
      ctx.storage.toolCalls.query(input),
    count: (
      input?: Omit<
        PluginStorageCollectionQueryInput<typeof toolCalls>,
        "orderBy" | "limit" | "offset"
      >,
    ) => ctx.storage.toolCalls.count(input),
    queryUnindexed: () =>
      ctx.storage.toolCalls.query({
        where: uncheckedToolCallWhere({ durationMs: 100 }),
      }),
  }),
}))();

const scope = (id: string, name: string) =>
  Scope.make({
    id: ScopeId.make(id),
    name,
    createdAt: new Date(),
  });

const call = (input: {
  readonly runId: string;
  readonly toolId: string;
  readonly status: ToolCall["status"];
  readonly startedAt: string;
  readonly clientName?: string | null;
  readonly userId?: string | null;
  readonly durationMs?: number;
}): ToolCall => ({
  runId: input.runId,
  toolId: input.toolId,
  userId: input.userId ?? null,
  clientName: input.clientName ?? null,
  status: input.status,
  startedAt: input.startedAt,
  durationMs: input.durationMs ?? 0,
});

describe("plugin storage collections", () => {
  it.effect("queries declared indexes through the executor's SQLite FumaDB target", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        backend: "sqlite",
        plugins: [executionHistoryPlugin] as const,
      });
      const targetScope = "test-scope";

      yield* executor.executionHistory.record(
        targetScope,
        "call-1",
        call({
          runId: "run-a",
          toolId: "browser",
          status: "failed",
          clientName: "codex",
          startedAt: "2026-05-29T10:00:00.000Z",
          durationMs: 320,
        }),
      );
      yield* executor.executionHistory.record(
        targetScope,
        "call-2",
        call({
          runId: "run-a",
          toolId: "shell",
          status: "ok",
          clientName: "codex",
          startedAt: "2026-05-29T10:01:00.000Z",
          durationMs: 42,
        }),
      );
      yield* executor.executionHistory.record(
        targetScope,
        "call-3",
        call({
          runId: "run-b",
          toolId: "shell",
          status: "failed",
          clientName: "codex",
          startedAt: "2026-05-29T10:02:00.000Z",
          durationMs: 77,
        }),
      );

      const failed = yield* executor.executionHistory.query({
        where: {
          clientName: "codex",
          status: "failed",
        },
        orderBy: [{ field: "startedAt", direction: "desc" }],
        limit: 10,
      });
      expect(failed.map((entry) => entry.key)).toEqual(["call-3", "call-1"]);
      expect(failed.map((entry) => entry.data.toolId)).toEqual(["shell", "browser"]);

      const shellCount = yield* executor.executionHistory.count({
        where: { toolId: "shell" },
      });
      expect(shellCount).toBe(2);
    }),
  );

  it.effect("uses the executor scope stack while sharing one plugin_storage table", () =>
    Effect.gen(function* () {
      const org = scope("org", "Org");
      const user = scope("user", "User");
      const plugins = [executionHistoryPlugin] as const;
      const config = makeTestConfig({ backend: "sqlite", plugins, scopes: [org] });

      const orgExecutor = yield* createExecutor({
        ...config,
        scopes: [org],
        plugins,
      });
      yield* orgExecutor.executionHistory.record(
        org.id,
        "shared",
        call({
          runId: "run-scope",
          toolId: "shell",
          status: "ok",
          startedAt: "2026-05-29T11:00:00.000Z",
        }),
      );

      const userOnlyExecutor = yield* createExecutor({
        ...config,
        scopes: [user],
        plugins,
      });
      const userOnlyRows = yield* userOnlyExecutor.executionHistory.query({
        where: { runId: "run-scope" },
      });
      expect(userOnlyRows).toEqual([]);

      const stackedExecutor = yield* createExecutor({
        ...config,
        scopes: [user, org],
        plugins,
      });
      yield* stackedExecutor.executionHistory.record(
        user.id,
        "shared",
        call({
          runId: "run-scope",
          toolId: "browser",
          status: "failed",
          startedAt: "2026-05-29T11:01:00.000Z",
        }),
      );

      const visibleShared = yield* stackedExecutor.executionHistory.get("shared");
      expect(visibleShared?.scopeId).toBe(user.id);
      expect(visibleShared?.data.toolId).toBe("browser");

      const scopedRows = yield* stackedExecutor.executionHistory.query({
        where: { runId: "run-scope" },
        orderBy: [{ field: "startedAt" }],
      });
      expect(
        scopedRows.map((entry) => [entry.key, String(entry.scopeId), entry.data.toolId]),
      ).toEqual([
        ["shared", org.id, "shell"],
        ["shared", user.id, "browser"],
      ]);
    }),
  );

  it.effect("rejects runtime queries against undeclared index fields", () =>
    Effect.gen(function* () {
      const executor = yield* makeTestExecutor({
        backend: "sqlite",
        plugins: [executionHistoryPlugin] as const,
      });

      const exit = yield* Effect.exit(executor.executionHistory.queryUnindexed());
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;

      const reason = exit.cause.reasons.find(Cause.isFailReason);
      expect(reason?.error).toBeInstanceOf(StorageError);
      expect(reason?.error).toMatchObject({
        message:
          'Plugin storage collection "toolCalls" cannot query field "durationMs" because it is not declared as an index',
      });
    }),
  );
});
