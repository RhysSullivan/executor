import { expect, test } from "bun:test";
import { APPROVAL_DENIED_PREFIX } from "../execution-constants";
import { InProcessExecutionAdapter } from "./in-process-execution-adapter";

test("returns run mismatch without invoking tool", async () => {
  let called = 0;
  const adapter = new InProcessExecutionAdapter({
    runId: "run_expected",
    invokeTool: async () => {
      called += 1;
      return { ok: true };
    },
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
  });

  const result = await adapter.invokeTool({
    runId: "run_1",
    callId: "call_1",
    toolPath: "admin.delete_data",
    input: { id: "abc" },
  });

  expect(result).toEqual({
    ok: false,
    kind: "denied",
    error: "approval required",
  });
});
