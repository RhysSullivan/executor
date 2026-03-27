import type {
  CodeExecutor,
} from "@executor/codemode-core";
import type {
  LocalExecutorConfig,
  LocalExecutorRuntime,
} from "#schema";

const DEFAULT_EXECUTION_RUNTIME: LocalExecutorRuntime = "quickjs";

export const resolveConfiguredExecutionRuntime = (
  config: LocalExecutorConfig | null | undefined,
): LocalExecutorRuntime => config?.runtime ?? DEFAULT_EXECUTION_RUNTIME;

export const createCodeExecutorForRuntime = async (
  runtime: LocalExecutorRuntime,
  customExecutor?: CodeExecutor,
): Promise<CodeExecutor> => {
  if (customExecutor) return customExecutor;
  switch (runtime) {
    case "deno": {
      const { makeDenoSubprocessExecutor } = await import(
        "@executor/runtime-deno-subprocess"
      );
      return makeDenoSubprocessExecutor();
    }
    case "ses": {
      const { makeSesExecutor } = await import("@executor/runtime-ses");
      return makeSesExecutor();
    }
    case "quickjs":
    default: {
      const { makeQuickJsExecutor } = await import(
        "@executor/runtime-quickjs"
      );
      return makeQuickJsExecutor();
    }
  }
};
