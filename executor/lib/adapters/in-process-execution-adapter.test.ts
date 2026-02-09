import { expect, test } from "bun:test";
import { APPROVAL_DENIED_PREFIX } from "../execution_constants";
import { InProcessExecutionAdapter } from "./in_process_execution_adapter";

test("returns run mismatch without invoking tool", async () => {
  let called = 0;
  const adapter = new InProcessExecutionAdapter({
    runId: "run_expected",
    invokeTool: async () => {
      called += 1;
      return { ok: true };
    },
    emitOutput: () => {},
  });

  const result = await adapter.invokeTool({
    runId: "run_other",
    callId: "call_1",
    toolPath: "utils.echo",
    input: {},
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toContain("Run mismatch");
  }
  expect(called).toBe(0);
});

test("maps approval denied errors to denied result", async () => {
  const adapter = new InProcessExecutionAdapter({
    runId: "run_1",
    invokeTool: async () => {
      throw new Error(`${APPROVAL_DENIED_PREFIX}approval required`);
    },
    emitOutput: () => {},
  });

  const result = await adapter.invokeTool({
    runId: "run_1",
    callId: "call_1",
    toolPath: "admin.delete_data",
    input: { id: "abc" },
  });

  expect(result).toEqual({
    ok: false,
    denied: true,
    error: "approval required",
  });
});

test("emits output only for matching run id", () => {
  const lines: string[] = [];
  const adapter = new InProcessExecutionAdapter({
    runId: "run_1",
    invokeTool: async () => null,
    emitOutput: (event) => {
      lines.push(`${event.stream}:${event.line}`);
    },
  });

  adapter.emitOutput({
    runId: "run_other",
    stream: "stdout",
    line: "ignored",
    timestamp: Date.now(),
  });

  adapter.emitOutput({
    runId: "run_1",
    stream: "stdout",
    line: "accepted",
    timestamp: Date.now(),
  });

  expect(lines).toEqual(["stdout:accepted"]);
});
