import {
  makeLocalInProcessRuntimeAdapter as makeEngineLocalInProcessRuntimeAdapter,
  type RuntimeAdapter as EngineRuntimeAdapter,
  type RuntimeExecuteError as EngineRuntimeExecuteError,
  type RuntimeExecuteInput as EngineRuntimeExecuteInput,
  type RuntimeRunnableTool as EngineRuntimeRunnableTool,
} from "@executor-v2/engine";

export type RuntimeRunnableTool = EngineRuntimeRunnableTool;
export type RuntimeExecuteInput = EngineRuntimeExecuteInput;
export type RuntimeExecuteError = EngineRuntimeExecuteError;
export type RuntimeAdapter = EngineRuntimeAdapter;

export const makeLocalInProcessRuntimeAdapter =
  makeEngineLocalInProcessRuntimeAdapter;
