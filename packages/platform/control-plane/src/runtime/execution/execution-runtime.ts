import type { CodeExecutor } from "@executor/codemode-core";
import { makeDenoSubprocessExecutor } from "@executor/runtime-deno-subprocess";
import { makeQuickJsExecutor } from "@executor/runtime-quickjs";
import { makeSesExecutor } from "@executor/runtime-ses";
import type { LocalExecutorConfig, LocalExecutorRuntime } from "#schema";

const DEFAULT_EXECUTION_RUNTIME: LocalExecutorRuntime = "quickjs";

export const resolveConfiguredExecutionRuntime = (
  config: LocalExecutorConfig | null | undefined,
): LocalExecutorRuntime => config?.runtime ?? DEFAULT_EXECUTION_RUNTIME;

export const createCodeExecutorForRuntime = (
  runtime: LocalExecutorRuntime,
): CodeExecutor => {
  switch (runtime) {
    case "deno":
      return makeDenoSubprocessExecutor();
    case "ses":
      return makeSesExecutor();
    case "quickjs":
    default:
      return makeQuickJsExecutor();
  }
};
