import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeMemoryAdapter } from "@executor/storage-core/testing/memory";

import { collectSchemas, createExecutor } from "./executor";
import {
  EXECUTION_STATUS_KEYS,
  type ExecutionStatus,
} from "./executions";
import {
  ExecutionId,
  ExecutionInteractionId,
  ExecutionToolCallId,
  ScopeId,
} from "./ids";
import { Scope } from "./scope";
import { makeInMemoryBlobStore } from "./blob";

// ---------------------------------------------------------------------------
// Shared fixture. Every test builds a scoped executor backed by the
// in-memory adapter — zero persistence, zero migration dance.
// ---------------------------------------------------------------------------

const SCOPE = ScopeId.make("scope-test");

const makeExecutor = () =>
  Effect.gen(function* () {
    const schema = collectSchemas([]);
    const adapter = makeMemoryAdapter({ schema });
    const scope = new Scope({ id: SCOPE, name: "test", createdAt: new Date() });
    const executor = yield* createExecutor({
      scopes: [scope],
      adapter,
      blobs: makeInMemoryBlobStore(),
    });
    return executor;
  });

describe("ExecutionStore (DBAdapter-backed)", () => {
  it.effect("create → get round-trip preserves fields", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const id = ExecutionId.make("exec-1");

      yield* executor.executions.create({
        id,
        scopeId: SCOPE,
        status: "running",
        code: "const x = 1",
        triggerKind: "cli",
      });

      const detail = yield* executor.executions.get(id);
      expect(detail).not.toBeNull();
      expect(detail!.execution.id).toBe(id);
      expect(detail!.execution.status).toBe("running");
      expect(detail!.execution.code).toBe("const x = 1");
      expect(detail!.execution.triggerKind).toBe("cli");
      expect(detail!.execution.toolCallCount).toBe(0);
      expect(detail!.pendingInteraction).toBeNull();
    }),
  );

  it.effect("update patches status, result, and completion time", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const id = ExecutionId.make("exec-2");

      yield* executor.executions.create({
        id,
        scopeId: SCOPE,
        status: "running",
        code: "2 + 2",
      });

      yield* executor.executions.update(id, {
        status: "completed",
        resultJson: JSON.stringify({ value: 4 }),
        completedAt: 1_700_000_000_000,
        toolCallCount: 1,
      });

      const detail = yield* executor.executions.get(id);
      expect(detail!.execution.status).toBe("completed");
      expect(detail!.execution.resultJson).toBe('{"value":4}');
      expect(detail!.execution.completedAt).toBe(1_700_000_000_000);
      expect(detail!.execution.toolCallCount).toBe(1);
    }),
  );

  it.effect("tool-call recording + finish updates status + duration", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const executionId = ExecutionId.make("exec-3");
      const toolCallId = ExecutionToolCallId.make("tc-1");

      yield* executor.executions.create({
        id: executionId,
        scopeId: SCOPE,
        status: "running",
        code: "await tools.a()",
      });

      yield* executor.executions.recordToolCall({
        id: toolCallId,
        executionId,
        toolPath: "ns.doThing",
        startedAt: 1_700_000_000_000,
      });

      yield* executor.executions.finishToolCall(toolCallId, {
        status: "completed",
        resultJson: '{"ok":true}',
        completedAt: 1_700_000_000_250,
        durationMs: 250,
      });

      const calls = yield* executor.executions.listToolCalls(executionId);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.status).toBe("completed");
      expect(calls[0]!.toolPath).toBe("ns.doThing");
      expect(calls[0]!.namespace).toBe("ns");
      expect(calls[0]!.durationMs).toBe(250);
      expect(calls[0]!.resultJson).toBe('{"ok":true}');
    }),
  );

  it.effect("interaction lifecycle: record pending → resolve", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      const executionId = ExecutionId.make("exec-4");
      const interactionId = ExecutionInteractionId.make("int-1");

      yield* executor.executions.create({
        id: executionId,
        scopeId: SCOPE,
        status: "waiting_for_interaction",
        code: "await elicit(...)",
      });

      yield* executor.executions.recordInteraction({
        id: interactionId,
        executionId,
        status: "pending",
        kind: "FormElicitation",
        payloadJson: '{"message":"ok?"}',
      });

      // get() should surface the pending interaction alongside the row.
      const beforeResolve = yield* executor.executions.get(executionId);
      expect(beforeResolve!.pendingInteraction).not.toBeNull();
      expect(beforeResolve!.pendingInteraction!.id).toBe(interactionId);

      yield* executor.executions.resolveInteraction(interactionId, {
        status: "resolved",
        responseJson: '{"action":"accept"}',
      });

      const afterResolve = yield* executor.executions.get(executionId);
      expect(afterResolve!.pendingInteraction).toBeNull();
    }),
  );

  it.effect("list applies status + trigger filters", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();

      yield* executor.executions.create({
        id: ExecutionId.make("e-a"),
        scopeId: SCOPE,
        status: "completed",
        code: "a",
        triggerKind: "cli",
      });
      yield* executor.executions.create({
        id: ExecutionId.make("e-b"),
        scopeId: SCOPE,
        status: "failed",
        code: "b",
        triggerKind: "http",
      });
      yield* executor.executions.create({
        id: ExecutionId.make("e-c"),
        scopeId: SCOPE,
        status: "completed",
        code: "c",
        triggerKind: "mcp",
      });

      const completedOnly = yield* executor.executions.list(SCOPE, {
        statusFilter: ["completed"],
      });
      expect(completedOnly.executions).toHaveLength(2);

      const httpOnly = yield* executor.executions.list(SCOPE, {
        triggerFilter: ["http"],
      });
      expect(httpOnly.executions).toHaveLength(1);
      expect(httpOnly.executions[0]!.execution.id).toBe(ExecutionId.make("e-b"));
    }),
  );

  it.effect("list meta reports status + trigger counts", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor();
      yield* executor.executions.create({
        id: ExecutionId.make("m-1"),
        scopeId: SCOPE,
        status: "completed",
        code: "x",
        triggerKind: "cli",
      });
      yield* executor.executions.create({
        id: ExecutionId.make("m-2"),
        scopeId: SCOPE,
        status: "completed",
        code: "y",
        triggerKind: "cli",
      });
      yield* executor.executions.create({
        id: ExecutionId.make("m-3"),
        scopeId: SCOPE,
        status: "failed",
        code: "z",
        triggerKind: "mcp",
      });

      const res = yield* executor.executions.list(SCOPE, { includeMeta: true });
      expect(res.meta).toBeDefined();
      expect(res.meta!.totalRowCount).toBe(3);

      const completedCount = res.meta!.statusCounts.find(
        (c) => c.status === ("completed" as ExecutionStatus),
      );
      expect(completedCount!.count).toBe(2);
      expect(res.meta!.triggerCounts.find((t) => t.triggerKind === "cli")!.count).toBe(
        2,
      );
      expect(res.meta!.triggerCounts.find((t) => t.triggerKind === "mcp")!.count).toBe(
        1,
      );
    }),
  );

  it.effect("EXECUTION_STATUS_KEYS covers every status literal", () =>
    Effect.sync(() => {
      expect(new Set(EXECUTION_STATUS_KEYS)).toEqual(
        new Set([
          "pending",
          "running",
          "waiting_for_interaction",
          "completed",
          "failed",
          "cancelled",
        ]),
      );
    }),
  );
});
