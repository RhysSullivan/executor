import { describe, it, expect } from "@effect/vitest";
import { env } from "cloudflare:workers";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { SandboxToolInvoker } from "@executor-js/codemode-core";
import {
  ToolDispatcher,
  makeDynamicWorkerExecutor,
  renderWorkerError,
  serializeWorkerCause,
} from "./executor";

class TestToolError extends Data.TaggedError("TestToolError")<{
  readonly message: string;
}> {}

const makeInvoker = (
  fn: (input: { path: string; args: unknown }) => unknown,
): SandboxToolInvoker => ({
  invoke: (input) =>
    Effect.try({
      try: () => fn(input),
      catch: (error) => error,
    }),
});

const failingInvoker = (message: string): SandboxToolInvoker => ({
  invoke: () => Effect.fail(new TestToolError({ message })),
});

describe("ToolDispatcher", () => {
  it("returns a success envelope on successful tool call", async () => {
    const invoker = makeInvoker(({ args }) => args);
    const dispatcher = new ToolDispatcher(invoker, Effect.runPromise);

    const result = await dispatcher.call("test.tool", { key: "value" });
    expect(result).toEqual({ ok: true, result: { key: "value" } });
  });

  it("serializes tagged failures into a structured error envelope", async () => {
    const dispatcher = new ToolDispatcher(failingInvoker("tool broke"), Effect.runPromise);

    const result = await dispatcher.call("broken.tool", {});
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "fail",
        message: "tool broke",
        primary: { __type: "Error", name: "TestToolError", message: "tool broke" },
        failures: [{ __type: "Error", name: "TestToolError", message: "tool broke" }],
        defects: [],
        interrupted: false,
      },
    });
  });

  it("serializes object-shaped tool errors without collapsing them", async () => {
    const dispatcher = new ToolDispatcher(
      {
        invoke: () =>
          Effect.fail({
            code: "forbidden",
            detail: "missing team access",
          }),
      },
      Effect.runPromise,
    );

    const result = await dispatcher.call("broken.tool", {});
    expect(result).toEqual({
      ok: false,
      error: {
        kind: "fail",
        message: '{"code":"forbidden","detail":"missing team access"}',
        primary: {
          code: "forbidden",
          detail: "missing team access",
        },
        failures: [
          {
            code: "forbidden",
            detail: "missing team access",
          },
        ],
        defects: [],
        interrupted: false,
      },
    });
  });

  it("handles undefined args", async () => {
    const invoker = makeInvoker(({ args }) => args);
    const dispatcher = new ToolDispatcher(invoker, Effect.runPromise);

    const result = await dispatcher.call("test.tool", undefined);
    expect(result).toEqual({ ok: true, result: undefined });
  });

  it("passes the tool path correctly", async () => {
    let capturedPath = "";
    const invoker = makeInvoker(({ path }) => {
      capturedPath = path;
      return "ok";
    });
    const dispatcher = new ToolDispatcher(invoker, Effect.runPromise);

    await dispatcher.call("my.deep.tool.path", {});
    expect(capturedPath).toBe("my.deep.tool.path");
  });
});

describe("serializeWorkerCause", () => {
  it("captures defects", () => {
    const serialized = serializeWorkerCause(Cause.die({ defect: true }));
    expect(serialized.kind).toBe("die");
    expect(serialized.defects).toEqual([{ defect: true }]);
    expect(serialized.failures).toEqual([]);
  });

  it("captures interruptions", () => {
    const serialized = serializeWorkerCause(Cause.interrupt());
    expect(serialized.kind).toBe("interrupt");
    expect(serialized.interrupted).toBe(true);
    expect(renderWorkerError(serialized)).toBe("Interrupted");
  });
});

describe("makeDynamicWorkerExecutor", () => {
  const loader = (env as { LOADER: WorkerLoader }).LOADER;

  it("executes simple code and returns result", async () => {
    const executor = makeDynamicWorkerExecutor({ loader });
    const invoker = makeInvoker(() => null);

    const result = await Effect.runPromise(executor.execute("async () => 42", invoker));

    expect(result.error).toBeUndefined();
    expect(result.result).toBe(42);
  });

  it("recovers prose-wrapped fenced async arrow input", async () => {
    const executor = makeDynamicWorkerExecutor({ loader });
    const invoker = makeInvoker(() => null);

    const result = await Effect.runPromise(
      executor.execute(
        ["Use this snippet.", "", "```ts", "async () => 42", "```"].join("\n"),
        invoker,
      ),
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toBe(42);
  });

  it("executes code that returns an object", async () => {
    const executor = makeDynamicWorkerExecutor({ loader });
    const invoker = makeInvoker(() => null);

    const result = await Effect.runPromise(
      executor.execute('async () => ({ hello: "world" })', invoker),
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ hello: "world" });
  });

  it("captures console output in logs", async () => {
    const executor = makeDynamicWorkerExecutor({ loader });
    const invoker = makeInvoker(() => null);

    const result = await Effect.runPromise(
      executor.execute(
        'async () => { console.log("hello"); console.warn("careful"); return 1; }',
        invoker,
      ),
    );

    expect(result.error).toBeUndefined();
    expect(result.logs).toContain("hello");
    expect(result.logs).toContain("[warn] careful");
  });

  it("returns error for throwing code", async () => {
    const executor = makeDynamicWorkerExecutor({ loader });
    const invoker = makeInvoker(() => null);

    const result = await Effect.runPromise(
      executor.execute('async () => { throw new Error("boom"); }', invoker),
    );

    expect(result.error).toBe("boom");
    expect(result.result).toBeNull();
  });

  it("serializes thrown objects into the user-facing error text", async () => {
    const executor = makeDynamicWorkerExecutor({ loader });
    const invoker = makeInvoker(() => null);

    const result = await Effect.runPromise(
      executor.execute(
        'async () => { throw { code: "bad_request", detail: "team missing" }; }',
        invoker,
      ),
    );

    expect(result.error).toBe('{"code":"bad_request","detail":"team missing"}');
    expect(result.result).toBeNull();
  });

  it("invokes tools via the proxy and returns results", async () => {
    const executor = makeDynamicWorkerExecutor({ loader });
    const invoker = makeInvoker(({ path, args }) => {
      if (path === "math.add") {
        const { a, b } = args as { a: number; b: number };
        return a + b;
      }
      return null;
    });

    const result = await Effect.runPromise(
      executor.execute(
        "async () => { const sum = await tools.math.add({ a: 3, b: 4 }); return sum; }",
        invoker,
      ),
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toBe(7);
  });

  it("surfaces tool errors in execution result", async () => {
    const executor = makeDynamicWorkerExecutor({ loader });
    const invoker = failingInvoker("not authorized");

    const result = await Effect.runPromise(
      executor.execute("async () => { return await tools.secret.read({}); }", invoker),
    );

    expect(result.error).toBe("not authorized");
  });

  it("surfaces object-shaped tool errors in execution result", async () => {
    const executor = makeDynamicWorkerExecutor({ loader });
    const invoker = {
      invoke: () =>
        Effect.fail({
          code: "forbidden",
          detail: "missing team access",
        }),
    } satisfies SandboxToolInvoker;

    const result = await Effect.runPromise(
      executor.execute("async () => { return await tools.secret.read({}); }", invoker),
    );

    expect(result.error).toBe('{"code":"forbidden","detail":"missing team access"}');
    expect(result.result).toBeNull();
  });

  it("surfaces message-bearing object tool errors in execution result", async () => {
    const executor = makeDynamicWorkerExecutor({ loader });
    const invoker = {
      invoke: () =>
        Effect.fail({
          code: "invalid_query",
          message: 'Field with name "DisplayName" does not exist',
        }),
    } satisfies SandboxToolInvoker;

    const result = await Effect.runPromise(
      executor.execute("async () => { return await tools.records.query({}); }", invoker),
    );

    expect(result.error).toBe('Field with name "DisplayName" does not exist');
    expect(result.result).toBeNull();
  });

  it("handles multiple tool calls in sequence", async () => {
    const executor = makeDynamicWorkerExecutor({ loader });
    const invoker = makeInvoker(({ path }) => {
      if (path === "data.first") return 10;
      if (path === "data.second") return 20;
      return 0;
    });

    const result = await Effect.runPromise(
      executor.execute(
        `async () => {
          const a = await tools.data.first({});
          const b = await tools.data.second({});
          return a + b;
        }`,
        invoker,
      ),
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toBe(30);
  });

  it("respects timeout", async () => {
    const executor = makeDynamicWorkerExecutor({ loader, timeoutMs: 500 });
    const invoker = makeInvoker(() => null);

    const result = await Effect.runPromise(
      executor.execute("async () => { await new Promise(r => setTimeout(r, 5000)); }", invoker),
    );

    expect(result.error).toContain("timed out");
  });

  it("blocks fetch when globalOutbound is null", async () => {
    const executor = makeDynamicWorkerExecutor({ loader, globalOutbound: null });
    const invoker = makeInvoker(() => null);

    const result = await Effect.runPromise(
      executor.execute('async () => { await fetch("https://example.com"); }', invoker),
    );

    expect(result.error).toBeDefined();
  });

  // Multipart/form-data uploads (OpenAI Files API, any spec with a
  // `multipart/form-data` body) need Blob/File/Uint8Array values to
  // survive the sandbox→host RPC hop intact. JSON.stringify turns a Blob
  // into "{}" and a Uint8Array into a numeric-keyed object, so
  // `coerceFormDataRecord` produces a malformed multipart part and the
  // upstream server 400s.
  it.effect("preserves Uint8Array tool args across the dispatcher boundary", () =>
    Effect.gen(function* () {
      const executor = makeDynamicWorkerExecutor({ loader });
      let captured: { file?: unknown } = {};
      const invoker = makeInvoker(({ args }) => {
        captured = (args ?? {}) as { file?: unknown };
        return null;
      });

      yield* executor.execute(
        `async () => {
          const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
          await tools.uploads.send({ file: bytes });
        }`,
        invoker,
      );

      expect(captured.file).toBeInstanceOf(Uint8Array);
      expect(Array.from(captured.file as Uint8Array)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    }),
  );

  it.effect("preserves Blob tool args across the dispatcher boundary", () =>
    Effect.gen(function* () {
      const executor = makeDynamicWorkerExecutor({ loader });
      let captured: { file?: unknown } = {};
      const invoker = makeInvoker(({ args }) => {
        captured = (args ?? {}) as { file?: unknown };
        return null;
      });

      const result = yield* executor.execute(
        `async () => {
          const file = new Blob(["hello multipart"], { type: "text/plain" });
          await tools.uploads.send({ file });
        }`,
        invoker,
      );

      expect(result.error).toBeUndefined();
      expect(captured.file).toBeInstanceOf(Blob);
      const blob = captured.file as Blob;
      expect(blob.type).toBe("text/plain");
      const body = yield* Effect.promise(() => blob.text());
      expect(body).toBe("hello multipart");
    }),
  );

  // Symmetric direction: tool RESULT contains Blob/Uint8Array/File. Workers
  // RPC has the same "Could not serialize Blob" limit on the way back, so
  // tool implementations that return file-like data need the host→sandbox
  // codec too. This pins down which types survive both directions.
  it.effect("returns Uint8Array tool results to the sandbox intact", () =>
    Effect.gen(function* () {
      const executor = makeDynamicWorkerExecutor({ loader });
      const invoker = makeInvoker(() => new Uint8Array([0xca, 0xfe, 0xba, 0xbe]));

      const result = yield* executor.execute(
        `async () => {
          const bytes = await tools.download.fetch({});
          if (!(bytes instanceof Uint8Array)) return { kind: typeof bytes, ctor: bytes && bytes.constructor && bytes.constructor.name };
          return { kind: 'Uint8Array', length: bytes.length, bytes: Array.from(bytes) };
        }`,
        invoker,
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({
        kind: "Uint8Array",
        length: 4,
        bytes: [0xca, 0xfe, 0xba, 0xbe],
      });
    }),
  );

  it.effect("returns Blob tool results to the sandbox intact", () =>
    Effect.gen(function* () {
      const executor = makeDynamicWorkerExecutor({ loader });
      const invoker = makeInvoker(() => new Blob(["DOWNLOAD"], { type: "text/plain" }));

      const result = yield* executor.execute(
        `async () => {
          const blob = await tools.download.fetch({});
          if (!(blob instanceof Blob)) return { kind: typeof blob };
          return { kind: 'Blob', type: blob.type, text: await blob.text() };
        }`,
        invoker,
      );

      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({ kind: "Blob", type: "text/plain", text: "DOWNLOAD" });
    }),
  );
});
