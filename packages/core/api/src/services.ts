import { Context } from "effect";
import type { Executor } from "@executor/core";
import type { ExecutionEngine } from "@executor/execution";

export class ExecutorService extends Context.Tag("ExecutorService")<
  ExecutorService,
  Executor
>() {}

export class ExecutionEngineService extends Context.Tag("ExecutionEngineService")<
  ExecutionEngineService,
  ExecutionEngine
>() {}
