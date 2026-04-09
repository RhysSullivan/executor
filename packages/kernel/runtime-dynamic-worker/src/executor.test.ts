import { describe, it, expect } from "vitest";
import { buildExecutorModule } from "./module-template";

describe("buildExecutorModule", () => {
  it("produces a valid ES module with WorkerEntrypoint import", () => {
    const module = buildExecutorModule("async () => 42", 5000);
    expect(module).toContain('import { WorkerEntrypoint } from "cloudflare:workers"');
    expect(module).toContain("class CodeExecutor extends WorkerEntrypoint");
  });

  it("embeds the normalized code in a Promise.race", () => {
    const module = buildExecutorModule("async () => 42", 5000);
    expect(module).toContain("(async () => 42)()");
    expect(module).toContain("Promise.race");
  });

  it("includes the timeout value", () => {
    const module = buildExecutorModule("async () => 42", 3000);
    expect(module).toContain("3000");
    expect(module).toContain("Execution timed out after 3000ms");
  });

  it("includes the tools proxy setup", () => {
    const module = buildExecutorModule("async () => 42", 5000);
    expect(module).toContain("__makeToolsProxy");
    expect(module).toContain("__dispatcher.call");
    expect(module).toContain("const tools = __makeToolsProxy()");
  });

  it("captures console output", () => {
    const module = buildExecutorModule("async () => 42", 5000);
    expect(module).toContain("const __logs = []");
    expect(module).toContain("console.log =");
    expect(module).toContain("console.warn =");
    expect(module).toContain("console.error =");
  });

  it("returns result and logs on success", () => {
    const module = buildExecutorModule("async () => 42", 5000);
    expect(module).toContain("return { result, logs: __logs }");
  });

  it("catches errors and returns them", () => {
    const module = buildExecutorModule("async () => 42", 5000);
    expect(module).toContain("catch (err)");
    expect(module).toContain("error: err.message");
  });
});
